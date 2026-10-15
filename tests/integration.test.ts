import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve,join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../shared/store.ts';
import { createHub } from '../apps/service/server.ts';
import { call,subscribe } from '../shared/client.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('HTTP authentication, push notification, offline backlog and stale assignment rejection',async()=>{
  const s=new Store(':memory:'),hub=createHub(s,{adminToken:'admin',agentToken:'enroll'});
  hub.server.listen(0,'127.0.0.1');await once(hub.server,'listening');
  const base=`http://127.0.0.1:${(hub.server.address() as any).port}`;
  const abort=new AbortController();let stream:Promise<void>|undefined;
  try {
    await assert.rejects(()=>call(base,'wrong','/admin/rooms'),/Authentication/);
    const room=await call(base,'admin','/admin/rooms',{name:'Room'});
    const r=await call(base,'enroll','/register',{name:'Agent',role:''});
    await call(base,r.token,'/join',{conversation:'Room',epoch:0});
    await call(base,'admin','/admin/messages',{room_id:room.id,text:'Offline mention',recipients:[r.participant.id],request_key:'one'});
    let wakeResolve:(value:any)=>void=()=>{};const wake=new Promise<any>(resolve=>wakeResolve=resolve);
    stream=subscribe(base,r.token,abort.signal,(type,data)=>{if(type==='wake')wakeResolve(data);}).catch(()=>{});
    const event=await Promise.race([wake,new Promise((_,reject)=>setTimeout(()=>reject(new Error('No pushed event')),3000).unref())]);
    assert.equal(event.through,1);
    const job=await call(base,r.token,'/claim',{epoch:1});assert.equal(job.id,event.invocation_id);
    const page=await call(base,r.token,'/unread',{epoch:1,through:1});assert.equal(page.messages[0].body,'Offline mention');
    await call(base,'admin','/admin/rooms',{name:'Other'});
    await call(base,r.token,'/switch',{epoch:1,conversation:'Other'});
    await assert.rejects(()=>call(base,r.token,'/ack',{epoch:1,receipt:page.receipt}),/Assignment/);
    await assert.rejects(()=>call(base,r.token,'/finish',{epoch:1,invocation_id:job.id}),/Assignment/);
  }finally{abort.abort();await stream;hub.closeStreams();await new Promise<void>(resolve=>hub.server.close(()=>resolve()));s.close();}
});

test('real MCP SDK handshake, separate session identities, explicit mentions, switch and reconnect',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-mcp-'));const s=new Store(':memory:'),hub=createHub(s,{adminToken:'admin',agentToken:'enroll'});
  s.createRoom('X');s.createRoom('Y');hub.server.listen(0,'127.0.0.1');await once(hub.server,'listening');
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('apps/mcp/main.ts')],env:{...Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>typeof entry[1]==='string')),HUB_URL:`http://127.0.0.1:${(hub.server.address() as any).port}`,HUB_AGENT_TOKEN:'enroll',HUB_STATE_DIR:dir,HUB_ADAPTER:'manual'},stderr:'pipe'});
  const client=new Client({name:'integration-test',version:'1.0.0'});
  const invoke=async(name:string,args:any)=>{const result:any=await client.callTool({name,arguments:args});if(result.isError)throw new Error(result.content[0].text);return JSON.parse(result.content[0].text);};
  try {
    await client.connect(transport);assert.ok((await client.listTools()).tools.some(t=>t.name==='switch_conversation'));
    const a=await invoke('join_conversation',{conversation:'X',name:'A',role:'Plain text only'});
    const b=await invoke('join_conversation',{conversation:'X',name:'B',role:''});assert.notEqual(a.id,b.id);
    await invoke('send_message',{participant_id:a.id,epoch:a.epoch,text:'@B hello',recipients:[b.id],request_key:randomUUID()});
    const wake=await invoke('wait_for_message',{participant_id:b.id,timeout_seconds:2});assert.ok(wake.invocation);
    const page=await invoke('read_unread',{participant_id:b.id,epoch:b.epoch,through:wake.invocation.seq});assert.equal(page.messages.length,1);
    await invoke('acknowledge',{participant_id:b.id,epoch:b.epoch,receipt:page.receipt});
    await invoke('complete_invocation',{participant_id:b.id,epoch:b.epoch,invocation_id:wake.invocation.id});
    await assert.rejects(()=>invoke('join_conversation',{participant_id:b.id,conversation:'Y',name:'B',role:''}),/switch_conversation/);
    const switched=await invoke('switch_conversation',{participant_id:b.id,epoch:b.epoch,conversation:'Y'});assert.equal(switched.epoch,2);
    await assert.rejects(()=>invoke('send_message',{participant_id:b.id,epoch:1,text:'stale',request_key:randomUUID()}),/Assignment/);
    const reconnect=await invoke('join_conversation',{participant_id:b.id,conversation:'Y',name:'B',role:''});assert.equal(reconnect.id,b.id);
  }finally{await client.close();hub.closeStreams();await new Promise<void>(resolve=>hub.server.close(()=>resolve()));s.close();rmSync(dir,{recursive:true});}
});
