import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../shared/store.ts';
import { createHub } from '../apps/service/server.ts';
import { call,subscribe } from '../shared/client.ts';

test('deletion removes history, invalidates work, detaches only assigned agents and persists notices',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-delete-')),path=join(dir,'hub.sqlite');let s=new Store(path);
  try{
    const room=s.createRoom('Delete me'),other=s.createRoom('Keep me');
    const a=s.register('A',''),b=s.register('B',''),c=s.register('C','');
    for(const p of [a,b,c])s.assign(p.participant.id,room.name);
    s.assign(c.participant.id,other.name,true,1);
    s.send(room.id,{id:'human',name:'You'},'Pending work',[a.participant.id,b.participant.id],false,'one');
    const job=s.claim(a.participant.id,1)!,page=s.unread(a.participant.id,1);
    assert.equal(s.deleteRoom(room.id).detached_agents,2);
    for(const p of [a,b]){assert.equal(s.participant(p.participant.id).room_id,null);assert.equal(s.participant(p.participant.id).epoch,2);}
    assert.equal(s.participant(c.participant.id).room_id,other.id);assert.equal(s.notifications(c.participant.id).length,0);
    for(const table of ['messages','invocations','deliveries'])assert.equal(s.all(`SELECT * FROM ${table}`).length,0);
    assert.equal(s.all('SELECT * FROM cursors WHERE room_id=?',room.id).length,0);
    assert.throws(()=>s.finish(a.participant.id,1,job.id),/Assignment/);
    assert.throws(()=>s.acknowledge(a.participant.id,1,page.receipt),/Assignment/);
    assert.throws(()=>s.history(room.id),/not found/);
    assert.throws(()=>s.deleteRoom(room.id),/not found/);
    s.close();s=new Store(path);
    const notice=s.notifications(a.participant.id)[0];assert.equal(notice.kind,'conversation_deleted');assert.equal(notice.room_name,'Delete me');
    assert.throws(()=>s.acknowledgeNotification(b.participant.id,notice.id),/not found/);
    s.assign(a.participant.id,other.name,false,2);assert.equal(s.participant(a.participant.id).epoch,3);
    s.acknowledgeNotification(a.participant.id,notice.id);assert.equal(s.notifications(a.participant.id).length,0);
    assert.equal(s.notifications(b.participant.id).length,1);
    assert.notEqual(s.createRoom('Delete me').id,room.id);
  }finally{s.close();rmSync(dir,{recursive:true});}
});

test('only humans can delete; connected and reconnecting agents receive deletion through SSE',async()=>{
  const s=new Store(':memory:'),hub=createHub(s,{adminToken:'admin',agentToken:'enroll'});
  hub.server.listen(0,'127.0.0.1');await once(hub.server,'listening');
  const base=`http://127.0.0.1:${(hub.server.address() as any).port}`,abort=new AbortController();const streams:Promise<void>[]=[];
  const deadline=<T>(promise:Promise<T>)=>Promise.race([promise,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('No pushed deletion event')),3000).unref())]);
  try{
    const room=s.createRoom('Delete'),a=s.register('Online',''),b=s.register('Offline','');
    s.assign(a.participant.id,room.name);s.assign(b.participant.id,room.name);
    let ready:()=>void=()=>{},receive:(e:any)=>void=()=>{};const connected=new Promise<void>(r=>ready=r),event=new Promise<any>(r=>receive=r);
    streams.push(subscribe(base,a.token,abort.signal,(type,data)=>{if(type==='assignment')ready();if(type==='notification')receive(data);}).catch(()=>{}));
    await deadline(connected);
    await assert.rejects(call(base,a.token,'/admin/delete-room',{room_id:room.id}),/Authentication/);
    await call(base,'admin','/admin/delete-room',{room_id:room.id});
    const notice=await deadline(event);assert.equal(notice.room_id,room.id);
    let receiveOffline:(e:any)=>void=()=>{};const offlineEvent=new Promise<any>(r=>receiveOffline=r);
    streams.push(subscribe(base,b.token,abort.signal,(type,data)=>{if(type==='notification')receiveOffline(data);}).catch(()=>{}));
    assert.equal((await deadline(offlineEvent)).kind,'conversation_deleted');
    await call(base,a.token,'/notification-ack',{epoch:2,notification_id:notice.id});
    assert.equal((await call(base,a.token,'/status')).room_id,null);
    assert.equal((await call(base,a.token,'/status')).notifications.length,0);
  }finally{abort.abort();await Promise.all(streams);hub.closeStreams();await new Promise<void>(r=>hub.server.close(()=>r()));s.close();}
});
