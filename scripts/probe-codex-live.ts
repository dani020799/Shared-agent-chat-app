// Dedicated live runtime test: never targets an existing user chat.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { once } from 'node:events';
const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
const port=(reservation.address() as {port:number}).port;await new Promise<void>(r=>reservation.close(()=>r()));
const endpoint=`ws://127.0.0.1:${port}`;
const runtime=spawn('codex',['app-server','--listen',endpoint],{stdio:['ignore','pipe','pipe']});
let stderr='';runtime.stderr.on('data',chunk=>{stderr+=String(chunk);});
let socket:WebSocket|undefined,threadId:string|undefined,answer='',next=0,resolveFinished:()=>void=()=>{};
const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
const finished=new Promise<void>(r=>resolveFinished=r);
const timeout=setTimeout(()=>{console.error('Live probe timed out');socket?.close();runtime.kill();resolveFinished();for(const p of pending.values())p.reject(new Error('Timeout'));},60_000);
try {
  await new Promise<void>((ready,reject)=>{
    const check=(chunk:Buffer)=>{if(/listening|Listening/.test(String(chunk)))ready();};
    runtime.stderr.on('data',check);runtime.stdout.on('data',check);
    runtime.on('exit',()=>reject(new Error(stderr.slice(-1500))));
  });
  socket=new WebSocket(endpoint);await new Promise<void>((r,j)=>{socket!.onopen=()=>r();socket!.onerror=()=>j(new Error('Cannot connect to test app server'));});
  socket.onmessage=event=>{
    const message=JSON.parse(String(event.data));
    if(message.id!==undefined){const p=pending.get(message.id);pending.delete(message.id);if(message.error)p?.reject(new Error(JSON.stringify(message.error)));else p?.resolve(message.result);return;}
    if(message.params?.threadId!==threadId)return;
    if(message.method==='turn/started')console.log('Existing test thread started processing the queued message.');
    if(message.method==='item/agentMessage/delta')answer+=message.params.delta;
    if(message.method==='item/completed'&&message.params.item?.type==='agentMessage')answer=message.params.item.text;
    if(message.method==='turn/completed')resolveFinished();
  };
  const request=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket!.send(JSON.stringify({id,method,params}));});
  await request('initialize',{clientInfo:{name:'relay-invocation-probe',version:'0.1.0'},capabilities:{experimentalApi:true}});
  socket.send(JSON.stringify({method:'initialized'}));
  const result=await request('thread/start',{cwd:process.cwd(),sandbox:'read-only',approvalPolicy:'never',config:{model_reasoning_effort:'low'},developerInstructions:'This dedicated session is only a messaging connectivity test. Do not use tools or access files.'});
  threadId=result.thread.id;console.log('Dedicated real Codex test thread created.');
  await promisify(execFile)('codex',['queue','--remote',endpoint,'--thread',threadId!,'--message','Connectivity test: reply exactly RELAY_WAKE_OK. Do not use tools.'],{timeout:15_000});
  await finished;
  if(!answer.includes('RELAY_WAKE_OK'))throw new Error('No expected response from queued prompt');
  console.log('PASS: real Codex runtime processed a pushed message in the same thread.');
  await request('thread/archive',{threadId});
} finally {clearTimeout(timeout);socket?.close();runtime.kill();}
