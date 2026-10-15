// Optional live test: two tiny turns in a dedicated process; never resumes a user chat.
import { PassThrough } from 'node:stream';
import { startClaudeBridge,pushClaudeWake } from '../shared/claude-bridge.ts';
const input=new PassThrough(),output=new PassThrough(),error=new PassThrough();
let buffer='',session='',turns=0;
let nextResult:(v:any)=>void=()=>{};
output.on('data',chunk=>{
  buffer+=String(chunk);let at;
  while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
    try{const event=JSON.parse(line);if(event.type==='result')nextResult(event);}catch{}}
});
const bridge=await startClaudeBridge(process.env.HUB_CLAUDE_BINARY??'claude',['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}'],input,output,error);
const timer=setTimeout(()=>{console.error('Claude live test timed out');bridge.close();process.exitCode=1;},60_000);
bridge.child.on('error',e=>{console.error(e.message);process.exitCode=1;});
try{
  for(const marker of ['RELAY_FIRST_OK','RELAY_WAKE_OK']){
    const result=new Promise<any>((resolve,reject)=>{nextResult=resolve;bridge.child.once('exit',()=>reject(new Error('Claude exited before reply')));});
    await pushClaudeWake(bridge.socket,bridge.secret,marker,`Connectivity test. Reply exactly ${marker}. Do not use tools.`);
    const event=await result;
    if(event.is_error||!String(event.result).includes(marker))throw new Error('Claude did not return expected test response');
    if(session&&session!==event.session_id)throw new Error('Session identity changed');
    session=event.session_id;turns++;
  }
  console.log(`PASS: ${turns} pushed messages processed in the same real Claude session.`);
}finally{clearTimeout(timer);bridge.close();}
