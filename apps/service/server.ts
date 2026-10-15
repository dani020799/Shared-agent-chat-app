import { createServer, type ServerResponse } from 'node:http';
import { Store, HubError } from '../../shared/store.ts';
import { bearer, body, failure, json, sameSecret } from '../../shared/http.ts';

export function createHub(store: Store, secrets: {adminToken:string; agentToken:string}) {
  const listeners = new Map<string,ServerResponse>();
  const observers = new Set<ServerResponse>();
  function emit(res: ServerResponse, type: string, data: unknown) {
    if (res.destroyed) return;
    if (res.writableLength > 256_000) { res.destroy(); return; }
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function notify() {
    for (const res of observers) emit(res,'change',{});
    for (const [id,res] of listeners) {
      const p = store.participant(id); emit(res,'assignment',p);
      for(const event of store.notifications(id))emit(res,'notification',event);
      const job = store.nextInvocation(id);
      if (job) emit(res,'wake',{invocation_id:job.id,epoch:job.epoch,through:job.seq,room_id:job.room_id});
    }
  }
  const server = createServer(async(req,res) => {
    try {
      const url = new URL(req.url!,'http://localhost'); const path = url.pathname;
      const token = bearer(req), admin = sameSecret(token,secrets.adminToken);
      // Browser traffic goes through the web app, which applies same-origin checks.
      if (req.headers.origin) throw new HubError('Direct browser access to the agent API is disabled',403);
      if (path === '/health') { json(res,{ok:true}); return; }
      if (path === '/register' && req.method === 'POST') {
        if (!sameSecret(token,secrets.agentToken)) throw new HubError('Invalid enrollment credential',401);
        const b = await body(req); json(res,store.register(b.name,b.role ?? '',b.adapter)); notify(); return;
      }
      if (path.startsWith('/admin/')) {
        if (!admin) throw new HubError('Authentication required',401);
        if (path === '/admin/events') { stream(); observers.add(res); req.on('close',()=>observers.delete(res)); return; }
        if (path === '/admin/rooms' && req.method === 'GET') { json(res,store.rooms()); return; }
        if (path === '/admin/rooms' && req.method === 'POST') { const b = await body(req); json(res,store.createRoom(b.name),201); notify(); return; }
        if(path==='/admin/delete-room' && req.method==='POST'){const b=await body(req);json(res,store.deleteRoom(b.room_id));notify();return;}
        if (path === '/admin/room' && req.method === 'GET') {
          const id = url.searchParams.get('id')!; const room = store.room(id);
          json(res,{room,members:store.members(id).map(p=>({...p,online:listeners.has(p.id),activity:store.one("SELECT id FROM invocations WHERE participant_id=? AND status='notified'",p.id) ? 'awaiting agent completion' : 'unknown'})),...store.history(id,Number(url.searchParams.get('after') ?? 0)),invocations:store.jobs(id)}); return;
        }
        if (path === '/admin/messages' && req.method === 'POST') {
          const b = await body(req); json(res,store.send(b.room_id,{id:'human',name:'You'},b.text,b.recipients ?? [],b.all === true,b.request_key)); notify(); return;
        }
        if (path === '/admin/pause' && req.method === 'POST') {
          const b = await body(req); store.room(b.room_id); store.run('UPDATE rooms SET paused=? WHERE id=?',b.paused ? 1 : 0,b.room_id); json(res,{ok:true}); notify(); return;
        }
        if (path === '/admin/retry' && req.method === 'POST') { const b = await body(req); store.retry(b.id); json(res,{ok:true}); notify(); return; }
        throw new HubError('Not found',404);
      }
      const p = store.authenticate(token);
      if (path === '/events' && req.method === 'GET') {
        if (listeners.has(p.id)) throw new HubError('Participant already has a listener; disconnect it before reconnecting',409);
        stream(); listeners.set(p.id,res); notify();
        req.on('close',()=>{ if(listeners.get(p.id)===res) { listeners.delete(p.id); notify(); } }); return;
      }
      if (path === '/status' && req.method === 'GET') { json(res,{...p,notifications:store.notifications(p.id)}); return; }
      if (req.method !== 'POST') throw new HubError('Not found',404);
      const b = await body(req);
      if (!Number.isSafeInteger(b.epoch) || b.epoch < 0) throw new HubError('A valid assignment epoch is required');
      let result: unknown;
      switch(path) {
        case '/notification-ack': result=store.acknowledgeNotification(p.id,b.notification_id);break;
        case '/join': result = store.assign(p.id,b.conversation,false,b.epoch); break;
        case '/adapter': {
          if(p.epoch!==b.epoch)throw new HubError('Assignment changed',409);
          if(!['manual','wait','codex-queue','claude-channel','claude-bridge'].includes(b.adapter))throw new HubError('Unknown adapter');
          store.run('UPDATE participants SET adapter=? WHERE id=?',b.adapter,p.id);
          result=store.participant(p.id);break;
        }
        case '/switch': result = store.assign(p.id,b.conversation,true,b.epoch); break;
        case '/disconnect': result = store.assign(p.id,null,true,b.epoch); break;
        case '/members': result = store.members(store.active(p.id,b.epoch).room_id); break;
        case '/send': {
          const active = store.active(p.id,b.epoch);
          result = store.send(active.room_id,active as {id:string;name:string},b.text,b.recipients ?? [],b.all === true,b.request_key,b.epoch); break;
        }
        case '/unread': result = store.unread(p.id,b.epoch,b.through); break;
        case '/history': result = store.history(store.active(p.id,b.epoch).room_id,b.after ?? 0,b.through); break;
        case '/ack': result = store.acknowledge(p.id,b.epoch,b.receipt); break;
        case '/claim': result = store.claim(p.id,b.epoch); break;
        case '/finish': result = store.finish(p.id,b.epoch,b.invocation_id); break;
        case '/fail': {
          store.active(p.id,b.epoch);
          if (!['failed','uncertain'].includes(b.status)) throw new HubError('Invalid failure status');
          store.run("UPDATE invocations SET status=?,error=? WHERE id=? AND participant_id=? AND epoch=? AND status='notified'",b.status,String(b.error).slice(0,500),b.invocation_id,p.id,b.epoch);
          result = {ok:true}; break;
        }
        default: throw new HubError('Not found',404);
      }
      json(res,result);
      if (!['/members','/history','/unread','/ack'].includes(path)) notify();
      function stream() {
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','X-Accel-Buffering':'no'});
        res.write(': connected\n\n');
        const heartbeat = setInterval(()=>res.write(': heartbeat\n\n'),20_000);
        res.on('close',()=>clearInterval(heartbeat));
      }
    } catch(error) { failure(res,error); }
  });
  function closeStreams() { for(const res of [...listeners.values(),...observers]) res.end(); }
  return {server,closeStreams};
}
