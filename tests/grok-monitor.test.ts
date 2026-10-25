import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startGrokMonitorBridge, runGrokListener } from '../shared/grok-monitor.ts';
import { createHub } from '../apps/service/server.ts';
import { Store } from '../shared/store.ts';

async function until(check:()=>boolean){
  for(let n=0;n<200;n++){if(check())return;await delay(20);}
  throw new Error('Timed out waiting for test event');
}

test('Grok listener isolates MCP processes, stays silent idle, suppresses duplicates and fails after disconnection',async()=>{
  const a=await startGrokMonitorBridge(),b=await startGrokMonitorBridge();
  const output=new PassThrough();let received='';output.on('data',chunk=>{received+=String(chunk);});
  const listening=runGrokListener(a.socket,output);
  let listeningB:Promise<void>|undefined;
  try{
    await until(()=>a.connected);
    assert.equal(b.connected,false);assert.equal(received,'');
    await assert.rejects(b.push('unbound','Never deliver to another session'),/monitor/);
    const outputB=new PassThrough();let receivedB='';outputB.on('data',chunk=>{receivedB+=String(chunk);});
    listeningB=runGrokListener(b.socket,outputB);await until(()=>b.connected);
    await a.push('first','Only session A');
    await a.push('first','Only session A');
    assert.equal(received,'Only session A\n');
    await a.push('second','Another event');
    assert.equal(received,'Only session A\nAnother event\n');
    assert.equal(receivedB,'');
    await b.push('first','Only session B');assert.equal(receivedB,'Only session B\n');
    assert.equal(received,'Only session A\nAnother event\n');
    a.close();await listening;
    await assert.rejects(a.push('third','No live listener'),/monitor/);
  }finally{a.close();b.close();await listening;await listeningB;}
});

test('Grok MCP requires a native listener and routes addressed events, replies and deletion through it',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'relay-grok-test-'));
  const store=new Store(':memory:'),hub=createHub(store,{adminToken:'admin',agentToken:'enroll'});
  const room=store.createRoom('Grok test');
  hub.server.listen(0,'127.0.0.1');await once(hub.server,'listening');
  const base=`http://127.0.0.1:${(hub.server.address() as any).port}`;
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('apps/mcp/main.ts')],env:{...process.env as Record<string,string>,HUB_URL:base,HUB_AGENT_TOKEN:'enroll',HUB_STATE_DIR:directory,HUB_ADAPTER:'grok-monitor'},stderr:'pipe'});
  const client=new Client({name:'grok-test',version:'1'});
  let monitor:ReturnType<typeof spawn>|undefined;
  const events:string[]=[];
  async function tool(name:string,args:any={}){
    const result:any=await client.callTool({name,arguments:args});
    if(result.isError)throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  }
  async function admin(path:string,body:any){
    const result=await fetch(base+path,{method:'POST',headers:{Authorization:'Bearer admin','Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.ok(result.ok);return result.json();
  }
  try{
    await client.connect(transport);
    await assert.rejects(tool('join_conversation',{conversation:'Grok test',name:'Grok',role:''}),/prepare_listener/);
    assert.equal(store.members(room.id).length,0);
    const prepared=await tool('prepare_listener');
    monitor=spawn('/bin/sh',['-c','exec '+prepared.command],{stdio:['ignore','pipe','pipe']});
    let buffer='';monitor.stdout!.on('data',chunk=>{buffer+=String(chunk);let at;while((at=buffer.indexOf('\n'))>=0){events.push(buffer.slice(0,at));buffer=buffer.slice(at+1);}});
    for(let n=0;n<100;n++){if((await tool('prepare_listener')).connected)break;await delay(20);}
    const p=await tool('join_conversation',{conversation:'Grok test',name:'Grok',role:'Tester'});
    assert.equal(p.adapter,'grok-monitor');
    await admin('/admin/messages',{room_id:room.id,text:'Context only',request_key:randomUUID()});
    assert.equal(events.length,0);assert.equal(store.jobs(room.id).length,0);
    const message:any=await admin('/admin/messages',{room_id:room.id,text:'Peer content must stay outside the wake envelope',recipients:[p.id],request_key:randomUUID()});
    await until(()=>events.length===1);
    assert.match(events[0],new RegExp(p.id));assert.match(events[0],/sequence 2/);
    assert.doesNotMatch(events[0],/Peer content/);
    const scope={participant_id:p.id,epoch:p.epoch};
    const page=await tool('read_unread',{...scope,through:2});
    await tool('acknowledge',{...scope,receipt:page.receipt});
    await tool('send_message',{...scope,text:'Handled',reply_to:[message.id],request_key:randomUUID()});
    await tool('complete_invocation',{...scope,invocation_id:store.jobs(room.id)[0].id});
    assert.equal(store.jobs(room.id)[0].status,'completed');
    await admin('/admin/delete-room',{room_id:room.id});
    await until(()=>events.length===2);assert.match(events[1],/was deleted/);
    assert.equal(store.participant(p.id).room_id,null);
    monitor.kill();await once(monitor,'exit');monitor=undefined;
    await delay(40);
    store.createRoom('Next');
    await assert.rejects(tool('join_conversation',{conversation:'Next',participant_id:p.id,name:'Grok',role:''}),/native Grok monitor/);
  }finally{
    monitor?.kill();await client.close();hub.closeStreams();await new Promise<void>(r=>hub.server.close(()=>r()));store.close();rmSync(directory,{recursive:true,force:true});
  }
});
