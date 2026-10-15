// Live runtime probe. Creates only its own dedicated test thread; never targets user work.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
const proxy = spawn('codex',['app-server','proxy'],{stdio:['pipe','pipe','pipe']});
const requests = new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
let next=0,threadId:string|undefined,turnId:string|undefined,answer='',resolveFinished:()=>void=()=>{};
const finished=new Promise<void>(resolve=>resolveFinished=resolve);
const lines=createInterface({input:proxy.stdout});
lines.on('line',line=>{
  const message=JSON.parse(line);
  if(message.id!==undefined){const pending=requests.get(message.id);requests.delete(message.id);if(message.error)pending?.reject(new Error(JSON.stringify(message.error)));else pending?.resolve(message.result);return;}
  if(message.params?.threadId!==threadId)return;
  if(message.method==='turn/started'){turnId=message.params.turn?.id;console.log('Existing test thread began a turn after queue dispatch.');}
  if(message.method==='item/agentMessage/delta')answer+=message.params.delta;
  if(message.method==='item/completed' && message.params.item?.type==='agentMessage')answer=message.params.item.text;
  if(message.method==='turn/completed')resolveFinished();
});
function request(method:string,params:any){const id=++next;return new Promise<any>((resolve,reject)=>{requests.set(id,{resolve,reject});proxy.stdin.write(JSON.stringify({id,method,params})+'\n');});}
const timer=setTimeout(()=>{console.error('Live probe timed out');proxy.kill();},60_000);
proxy.on('exit',()=>{for(const pending of requests.values())pending.reject(new Error('Proxy exited'));resolveFinished();});
try{
  await request('initialize',{clientInfo:{name:'relay-invocation-probe',version:'0.1.0'},capabilities:{experimentalApi:true}});
  proxy.stdin.write(JSON.stringify({method:'initialized'})+'\n');
  const result=await request('thread/start',{cwd:process.cwd(),sandbox:'read-only',approvalPolicy:'never',config:{model_reasoning_effort:'low'},developerInstructions:'This dedicated session is only a messaging connectivity test. Do not use tools or access files.'});
  threadId=result.thread.id;console.log('Dedicated test thread created.');
  await promisify(execFile)('codex',['queue','--thread',threadId!,'--message','Connectivity test: reply exactly RELAY_WAKE_OK. Do not use tools.'],{timeout:15_000});
  await finished;
  if(!answer.includes('RELAY_WAKE_OK'))throw new Error('Queued prompt did not produce the expected response');
  console.log('PASS: real Codex runtime received queue dispatch and responded in the same thread.');
}finally{
  if(threadId && proxy.exitCode===null){if(turnId)await request('turn/interrupt',{threadId,turnId}).catch(()=>{});await request('thread/archive',{threadId}).catch(()=>{});}
  clearTimeout(timer);lines.close();proxy.kill();
}
