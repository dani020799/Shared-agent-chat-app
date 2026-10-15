// Optional live acceptance test using an isolated room, database, and Claude process.
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../shared/store.ts';
import { createHub } from '../apps/service/server.ts';
import { startClaudeBridge } from '../shared/claude-bridge.ts';
const store=new Store(':memory:'),adminToken=randomUUID(),agentToken=randomUUID();
const hub=createHub(store,{adminToken,agentToken}),room=store.createRoom('Relay live test');
const directory=mkdtempSync(join(tmpdir(),'relay-live-'));
hub.server.listen(0,'127.0.0.1');await once(hub.server,'listening');
const base=`http://127.0.0.1:${(hub.server.address() as any).port}`;
const input=new PassThrough(),output=new PassThrough(),errors=new PassThrough();
let buffer='',resolveResult:(v:any)=>void=()=>{};
output.on('data',chunk=>{buffer+=String(chunk);let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const event=JSON.parse(line);if(event.type==='result')resolveResult(event);}catch{}}});
const allowed=['join_conversation','read_unread','acknowledge','send_message','complete_invocation','connection_status'].map(name=>'mcp__conversation-hub__'+name).join(',');
const mcp={mcpServers:{'conversation-hub':{command:process.execPath,args:[resolve('apps/mcp/main.ts')],env:{HUB_URL:base,HUB_AGENT_TOKEN:agentToken,HUB_STATE_DIR:directory,HUB_ADAPTER:'auto'}}}};
const bridge=await startClaudeBridge(process.env.HUB_CLAUDE_BINARY??'claude',['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--tools','','--allowedTools',allowed,'--strict-mcp-config','--mcp-config',JSON.stringify(mcp)],input,output,errors);
const timer=setTimeout(()=>{console.error('Live hub test timed out');bridge.close();},90_000);
function result(){return new Promise<any>((resolve,reject)=>{resolveResult=resolve;bridge.child.once('exit',()=>reject(new Error('Claude exited before completing the test')));});}
try{
  let waiting=result();
  input.write(JSON.stringify({type:'user',message:{role:'user',content:'This is an isolated messaging test. Use conversation-hub to join "Relay live test" with name "Live Claude" and plain role "Tester". Keep the returned participant ID and epoch. Then finish this turn. On a subsequent wake, read and acknowledge the unread page, post exactly RELAY_HUB_OK with no recipients, then complete the invocation. Use only conversation-hub tools.'}})+'\n');
  const initial=await waiting;
  if(initial.is_error)throw new Error('Initial Claude turn failed');
  const members=store.members(room.id);if(members.length!==1)throw new Error('Claude did not join the test room');
  if(members[0].adapter!=='claude-bridge')throw new Error('MCP did not inherit the bridge connection');
  console.log('Real Claude joined through MCP with its own background bridge.');
  waiting=result();
  const response=await fetch(base+'/admin/messages',{method:'POST',headers:{Authorization:`Bearer ${adminToken}`,'Content-Type':'application/json'},body:JSON.stringify({room_id:room.id,text:'Please perform the agreed messaging test.',recipients:[members[0].id],request_key:randomUUID()})});
  if(!response.ok)throw new Error('Could not send test mention');
  const handled=await waiting;
  if(handled.is_error||handled.session_id!==initial.session_id)throw new Error('Wake failed or changed sessions');
  if(!store.history(room.id,0).messages.some((m:any)=>m.sender_id===members[0].id&&m.body==='RELAY_HUB_OK'))throw new Error('No expected hub reply');
  if(store.jobs(room.id)[0].status!=='completed')throw new Error('Invocation was not completed');
  console.log('PASS: hub mention → SSE → MCP → same Claude session → unread acknowledgment → reply → completion.');
}finally{clearTimeout(timer);bridge.close();hub.closeStreams();await new Promise<void>(r=>hub.server.close(()=>r()));store.close();rmSync(directory,{recursive:true,force:true});}
