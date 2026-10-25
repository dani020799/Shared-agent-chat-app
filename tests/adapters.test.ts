import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { startClaudeBridge } from '../shared/claude-bridge.ts';
import { registerAgy } from '../shared/agy-native.ts';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHub } from '../apps/service/server.ts';
import { Store } from '../shared/store.ts';

for(const mode of ['claude-channel','codex-queue','claude-bridge','agy-native']) {
  test(`${mode} dispatch boundary: one explicit wake, correct session identity (host simulated)`,async()=>{
    const dir=mkdtempSync(join(tmpdir(),'relay-adapter-'));
    const thread=randomUUID();
    const capture=join(dir,'capture.json'),fake=join(dir,'codex-probe');
    writeFileSync(fake,`#!/usr/bin/env node\nif(process.argv[2]==='agentapi' && process.argv[3]==='get-conversation-metadata')process.exit(0);require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n`,{mode:0o700});
    const bindings=join(dir,'bindings');
    if(mode==='agy-native'){
      process.env.HUB_AGY_BINDINGS_DIR=bindings;
      try{await registerAgy({ANTIGRAVITY_CONVERSATION_ID:thread,ANTIGRAVITY_LS_ADDRESS:'localhost:1',ANTIGRAVITY_CSRF_TOKEN:'private-test-token',ANTIGRAVITY_AGENTAPI_EXE:fake});}finally{delete process.env.HUB_AGY_BINDINGS_DIR;}
    }
    const store=new Store(':memory:');const room=store.createRoom('Probe');const hub=createHub(store,{adminToken:'admin',agentToken:'enroll'});
    hub.server.listen(0,'127.0.0.1');await once(hub.server,'listening');
    const outputStream=new PassThrough();
    const bridge=mode==='claude-bridge'?await startClaudeBridge(process.execPath,['-e','process.stdin.pipe(process.stdout)'],new PassThrough(),outputStream,new PassThrough()):undefined;
    const transport=new StdioClientTransport({command:process.execPath,args:[resolve('apps/mcp/main.ts')],env:{...Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>typeof entry[1]==='string')),HUB_URL:`http://127.0.0.1:${(hub.server.address() as any).port}`,HUB_AGENT_TOKEN:'enroll',HUB_STATE_DIR:join(dir,'state'),HUB_ADAPTER:mode,HUB_AGY_BINDINGS_DIR:bindings,HUB_CODEX_BINARY:fake,...(bridge?{HUB_CLAUDE_SOCKET:bridge.socket,HUB_CLAUDE_SECRET:bridge.secret}:{})},stderr:'pipe'});
    const client=new Client({name:'simulated-host',version:'1.0.0'});
    let notify:(value:any)=>void=()=>{};
    const received=new Promise<any>(resolveValue=>{notify=resolveValue;});
    let watcher:ReturnType<typeof watch>|undefined;
    if(mode==='claude-channel')client.setNotificationHandler(z.object({method:z.literal('notifications/claude/channel'),params:z.any()}),event=>{notify(event.params);});
    else if(bridge){let buffer='';outputStream.on('data',chunk=>{buffer+=String(chunk);let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);notify(JSON.parse(line));}});}
    else {let previous='';watcher=watch(dir,(_event,name)=>{if(name==='capture.json'){try{const text=readFileSync(capture,'utf8');const value=JSON.parse(text);if(text!==previous){previous=text;notify(value);}}catch{}}});}
    try {
      await client.connect(transport);
      const result:any=await client.callTool({name:'join_conversation',arguments:{conversation:'Probe',name:'Probe agent',role:'',host_session_id:thread}});
      assert.ok(!result.isError);const participant=JSON.parse(result.content[0].text);
      store.send(room.id,{id:'human',name:'You'},'Context only',[],false,randomUUID());
      assert.equal(store.nextInvocation(participant.id),undefined);
      // Send via HTTP so the service publishes the wake after durable insertion.
      const base=`http://127.0.0.1:${(hub.server.address() as any).port}`;
      await fetch(base+'/admin/messages',{method:'POST',headers:{Authorization:'Bearer admin','Content-Type':'application/json'},body:JSON.stringify({room_id:room.id,text:'Addressed request',recipients:[participant.id],request_key:randomUUID()})});
      let timer:ReturnType<typeof setTimeout>;
      const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Adapter did not dispatch')),4000);});
      const output=await Promise.race([received,deadline]).finally(()=>clearTimeout(timer));
      if(mode==='claude-channel') {
        assert.equal(output.meta.participant_id,participant.id);assert.match(output.content,/sequence 2/);
      } else if(bridge){assert.match(output.message.content,new RegExp(participant.id));assert.match(output.message.content,/sequence 2/);}
      else if(mode==='agy-native'){
        assert.deepEqual(output.slice(0,3),['agentapi','send-message',thread]);
        assert.match(output[3],new RegExp(participant.id));assert.doesNotMatch(output[3],/Addressed request|private-test-token/);
      } else {
        assert.deepEqual(output.slice(0,4),['queue','--thread',thread,'--message']);assert.match(output[4],new RegExp(participant.id));
      }
      assert.equal(store.jobs(room.id)[0].status,'notified');
      assert.equal(store.nextInvocation(participant.id),undefined);
      // Dispatch is not delivery acknowledgment: unread messages remain unread.
      assert.equal(store.unread(participant.id,1).messages.length,2);
      if(mode==='agy-native'){
        const unread:any=await client.callTool({name:'read_unread',arguments:{participant_id:participant.id,epoch:participant.epoch,through:2}});
        const page=JSON.parse(unread.content[0].text);
        const ack:any=await client.callTool({name:'acknowledge',arguments:{participant_id:participant.id,epoch:participant.epoch,receipt:page.receipt}});assert.ok(!ack.isError);
        const reply:any=await client.callTool({name:'send_message',arguments:{participant_id:participant.id,epoch:participant.epoch,text:'Handled',reply_to:[page.messages[1].id],request_key:randomUUID()}});assert.ok(!reply.isError);
        const finish:any=await client.callTool({name:'complete_invocation',arguments:{participant_id:participant.id,epoch:participant.epoch,invocation_id:store.jobs(room.id)[0].id}});assert.ok(!finish.isError);
      }
      // Deletion must wake the host even with an outstanding normal invocation.
      const deletionReceived=new Promise<any>(resolveValue=>{notify=resolveValue;});
      await fetch(base+'/admin/delete-room',{method:'POST',headers:{Authorization:'Bearer admin','Content-Type':'application/json'},body:JSON.stringify({room_id:room.id})});
      const deletion=await Promise.race([deletionReceived,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('No host deletion notice')),4000).unref())]);
      const deletionPrompt=mode==='claude-channel'?deletion.content:bridge?deletion.message.content:deletion[mode==='agy-native'?3:4];
      assert.match(deletionPrompt,/was deleted/);
      assert.equal(store.participant(participant.id).room_id,null);
      store.createRoom('Next room');
      const rejoin:any=await client.callTool({name:'join_conversation',arguments:{conversation:'Next room',participant_id:participant.id,name:'Probe agent',role:''}});
      assert.ok(!rejoin.isError);assert.equal(JSON.parse(rejoin.content[0].text).id,participant.id);
    }finally{bridge?.close();watcher?.close();await client.close();hub.closeStreams();await new Promise<void>(r=>hub.server.close(()=>r()));store.close();rmSync(dir,{recursive:true});}
  });
}
