import { createServer, createConnection, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Writable } from 'node:stream';

// One private endpoint per MCP process. Grok's native persistent monitor forwards
// only explicit wake envelopes; shared message bodies are fetched through MCP.
export async function startGrokMonitorBridge() {
  const directory=mkdtempSync(join(tmpdir(),'relay-grok-'));
  const socket=join(directory,'wake.sock');
  let listener:Socket|undefined,closed=false;
  const pending=new Map<string,{resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  function failPending(){for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('Grok monitor disconnected; inspect the session before retrying'));}pending.clear();}
  const server=createServer(connection=>{
    if(listener||closed){connection.destroy();return;}
    let buffer='',ready=false;
    const handshake=setTimeout(()=>connection.destroy(),5000);
    connection.on('error',()=>{});
    connection.on('data',chunk=>{
      buffer+=String(chunk);
      if(buffer.length>32_000){connection.destroy();return;}
      let at;
      while((at=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
        try{
          const event=JSON.parse(line);
          if(!ready){
            if(event.type!=='ready'||listener)throw new Error('Invalid listener handshake');
            ready=true;clearTimeout(handshake);listener=connection;
          }else if(event.type==='accepted'&&typeof event.id==='string'){
            const item=pending.get(event.id);
            if(item){clearTimeout(item.timer);pending.delete(event.id);item.resolve();}
          }else throw new Error('Invalid listener acknowledgment');
        }catch{connection.destroy();return;}
      }
    });
    connection.on('close',()=>{clearTimeout(handshake);if(listener===connection){listener=undefined;failPending();}});
  });
  server.listen(socket);
  try{await once(server,'listening');}catch(error){rmSync(directory,{recursive:true,force:true});throw error;}
  return {
    socket,
    get connected(){return !!listener&&!listener.destroyed;},
    push(id:string,prompt:string):Promise<void>{
      if(!listener||listener.destroyed)return Promise.reject(new Error('Start the native Grok monitor before joining'));
      if(pending.has(id))return Promise.reject(new Error('Wake is already being dispatched'));
      const target=listener;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Grok monitor acknowledgment timed out; inspect the session before retrying'));},5000);
        pending.set(id,{resolve,reject,timer});
        target.write(JSON.stringify({id,prompt})+'\n',error=>{if(error)target.destroy();});
      });
    },
    close(){if(closed)return;closed=true;listener?.destroy();failPending();server.close();rmSync(directory,{recursive:true,force:true});},
  };
}

// Invoked by Grok's native monitor tool, never as a foreground wait or poll loop.
// stdout/stderr both become model events, so remain silent until a real wake.
export async function runGrokListener(socket:string,output:Writable=process.stdout):Promise<void>{
  const connection=createConnection(socket);
  let buffer='';
  const accepted=new Set<string>();
  connection.on('connect',()=>connection.write('{"type":"ready"}\n'));
  connection.on('data',chunk=>{
    buffer+=String(chunk);
    if(buffer.length>32_000){connection.destroy(new Error('Invalid wake frame'));return;}
    let at;
    while((at=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
      try{
        const event=JSON.parse(line);
        if(typeof event.id!=='string'||typeof event.prompt!=='string'||event.prompt.length>16_000)throw new Error('Invalid wake');
        const acknowledge=()=>{if(!connection.destroyed)connection.write(JSON.stringify({type:'accepted',id:event.id})+'\n');};
        if(accepted.has(event.id)){acknowledge();continue;}
        accepted.add(event.id);if(accepted.size>4096)accepted.delete(accepted.values().next().value!);
        output.write(event.prompt.replace(/[\r\n]+/g,' ')+'\n',error=>{if(error)connection.destroy(error);else acknowledge();});
      }catch{connection.destroy(new Error('Invalid wake frame'));return;}
    }
  });
  await once(connection,'close');
}
