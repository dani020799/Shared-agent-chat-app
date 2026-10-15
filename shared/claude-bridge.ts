import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

// One private socket per Claude process, inherited only by its child MCP servers.
// The extension's control/permission messages pass through unchanged.
export async function startClaudeBridge(binary:string,args:string[],input:Readable,output:Writable,error:Writable) {
  const directory=mkdtempSync(join(tmpdir(),'relay-claude-'));
  const socket=join(directory,'wake.sock'),secret=randomBytes(32).toString('hex');
  const accepted=new Set<string>();
  let child:ReturnType<typeof spawn>|undefined;
  const server=createServer(connection=>{
    let buffer='';
    connection.setTimeout(5000,()=>connection.destroy());
    connection.on('error',()=>{});
    connection.on('data',chunk=>{
      buffer+=chunk.toString();
      if(buffer.length>32_000){connection.destroy();return;}
      const at=buffer.indexOf('\n');if(at<0)return;
      connection.pause();
      try {
        const request=JSON.parse(buffer.slice(0,at));
        if(request.secret!==secret || typeof request.id!=='string' || typeof request.prompt!=='string') throw new Error('Invalid request');
        if(!child?.stdin?.writable || child.exitCode!==null) throw new Error('Claude process is unavailable');
        if(accepted.has(request.id)){connection.end('{"ok":true}\n');return;}
        accepted.add(request.id);
        if(accepted.size>4096)accepted.delete(accepted.values().next().value!);
        child.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:request.prompt},parent_tool_use_id:null})+'\n',err=>{
          connection.end(JSON.stringify(err?{error:'Claude input failed'}:{ok:true})+'\n');
        });
      }catch{connection.end('{"error":"Wake rejected"}\n');}
    });
  });
  server.listen(socket);await once(server,'listening');
  child=spawn(binary,args,{stdio:['pipe','pipe','pipe'],env:{...process.env,HUB_CLAUDE_SOCKET:socket,HUB_CLAUDE_SECRET:secret}});
  // Forward whole JSON lines so a wake can never split an extension message.
  const lines=createInterface({input,crlfDelay:Infinity});
  lines.on('line',line=>child!.stdin!.write(line+'\n'));
  lines.on('close',()=>child!.stdin!.end());
  child.stdout!.pipe(output,{end:false});child.stderr!.pipe(error,{end:false});
  child.stdin!.on('error',()=>{});
  let cleaned=false;
  function cleanup(){if(cleaned)return;cleaned=true;lines.close();server.close();rmSync(directory,{recursive:true,force:true});}
  child.once('exit',cleanup);child.once('error',cleanup);
  return {child,socket,secret,close(){child!.kill('SIGTERM');cleanup();}};
}

export function pushClaudeWake(socket:string,secret:string,id:string,prompt:string):Promise<void> {
  return new Promise((resolve,reject)=>{
    const connection=createConnection(socket);let buffer='';
    const timer=setTimeout(()=>connection.destroy(new Error('Claude bridge timed out')),5000);
    connection.on('connect',()=>connection.write(JSON.stringify({secret,id,prompt})+'\n'));
    connection.on('data',chunk=>{
      buffer+=chunk.toString();
      if(buffer.length>32_000){connection.destroy(new Error('Invalid bridge response'));return;}
      if(!buffer.includes('\n'))return;
      try{const result=JSON.parse(buffer.split('\n')[0]);if(!result.ok)throw new Error('Claude bridge rejected wake');resolve();connection.end();}catch(e){reject(e);connection.destroy();}
    });
    connection.on('error',reject);
    connection.on('close',()=>{clearTimeout(timer);reject(new Error('Claude bridge closed without acknowledgment'));});
  });
}
