import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../shared/store.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture() {
  const s=new Store(':memory:'); const room=s.createRoom('Project X'),other=s.createRoom('Project Y');
  const a=s.register('Same name','Backend'),b=s.register('Same name','Reviewer');
  s.assign(a.participant.id,room.name);s.assign(b.participant.id,room.name);
  const send=(text:string,recipients:string[]=[],all=false)=>s.send(room.id,{id:'human',name:'You'},text,recipients,all,randomUUID());
  return {s,room,other,a:a.participant.id,b:b.participant.id,send};
}
test('store once, buffer context without waking, mention only the intended duplicate-name participant',()=>{
  const {s,room,a,b,send}=fixture();try{
    send('Context');send('Please review',[b]);
    assert.equal(s.nextInvocation(a),undefined);
    assert.equal(s.nextInvocation(b)!.seq,2);
    const page=s.unread(b,1,2);assert.deepEqual(page.messages.map(m=>m.body),['Context','Please review']);
    assert.equal(s.one('SELECT COUNT(*) AS n FROM messages')!.n,2);
    s.acknowledge(b,1,page.receipt);send('Next context');
    assert.deepEqual(s.unread(b,1).messages.map(m=>m.seq),[3]);
    assert.equal(s.unread(a,1).messages.length,3);
    assert.equal(s.history(room.id).messages.length,3);
  }finally{s.close();}
});
test('exclusive assignment cancels old triggers and rejects stale acknowledgments and replies',()=>{
  const {s,room,other,a,b,send}=fixture();try{
    send('Old request',[a]);const receipt=s.unread(a,1).receipt;
    assert.throws(()=>s.assign(a,other.name),/switch_conversation/);
    const p=s.assign(a,other.name,true,1);assert.equal(p.epoch,2);
    assert.equal(s.nextInvocation(a),undefined);
    assert.throws(()=>s.acknowledge(a,1,receipt),/Assignment/);
    assert.throws(()=>s.claim(a,1),/Assignment/);
    assert.throws(()=>s.send(room.id,{id:a,name:'A'},'Old reply',[],false,randomUUID(),1),/Assignment/);
    assert.throws(()=>send('Wrong-room recipient',[a]),/recipient/);
    assert.equal(s.jobs(room.id)[0].status,'canceled');
    s.assign(a,room.name,true,2);assert.equal(s.unread(a,3).messages.length,1);
    assert.equal(s.nextInvocation(a),undefined);
    assert.equal(s.participant(b).room_id,room.id);
  }finally{s.close();}
});
test('agent multi-mentions and @all snapshot assigned members and exclude sender',()=>{
  const {s,room,a,b}=fixture();try{
    const c=s.register('Third','').participant.id;s.assign(c,room.name);
    s.send(room.id,{id:a,name:'A'},'Discuss',[b,c],false,randomUUID(),1);
    assert.equal(s.jobs(room.id).length,2);assert.equal(s.nextInvocation(a),undefined);
    s.send(room.id,{id:b,name:'B'},'Everyone',[],true,randomUUID(),1);
    assert.equal(s.jobs(room.id).length,4);
    const late=s.register('Late','').participant.id;s.assign(late,room.name);
    assert.equal(s.nextInvocation(late),undefined);
    assert.equal(s.unread(late,1).messages.length,2);
  }finally{s.close();}
});
test('durable recovery and acknowledgments do not falsely complete tasks',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-store-')); const path=join(dir,'hub.sqlite');
  let s=new Store(path);
  try {
    const room=s.createRoom('Durable'),id=s.register('A','').participant.id;s.assign(id,room.name);
    const message=s.send(room.id,{id:'human',name:'You'},'Work',[id],false,'stable-key');
    assert.equal(s.send(room.id,{id:'human',name:'You'},'Work',[id],false,'stable-key').id,message.id);
    assert.throws(()=>s.send(room.id,{id:'human',name:'You'},'Changed',[id],false,'stable-key'),/Request key/);
    const job=s.claim(id,1)!;assert.equal(s.claim(id,1),null);
    assert.throws(()=>s.finish(id,1,job.id),/acknowledge/);
    const page=s.unread(id,1);s.acknowledge(id,1,page.receipt);
    assert.equal(s.jobs(room.id)[0].status,'notified');
    s.close();s=new Store(path);s.recover();
    assert.equal(s.jobs(room.id)[0].status,'uncertain');assert.equal(s.nextInvocation(id),undefined);
    s.retry(job.id);assert.equal(s.claim(id,1)!.id,job.id);s.finish(id,1,job.id);
    assert.equal(s.jobs(room.id)[0].status,'completed');assert.equal(s.unread(id,1).messages.length,0);
  }finally{s.close();rmSync(dir,{recursive:true});}
});
test('pagination is bounded and full history never advances unread state',()=>{
  const {s,room,a,send}=fixture();try{
    for(let i=0;i<80;i++)send(`${i}:`+'x'.repeat(2000));
    let after=0,total=0;do{const page=s.history(room.id,after);assert.ok(Buffer.byteLength(page.messages.map(m=>m.body).join(''))<=32000);total+=page.messages.length;after=page.next;if(!page.has_more)break;}while(true);
    assert.equal(total,80);assert.equal(s.unread(a,1).messages[0].seq,1);
    let count=0;do{const page=s.unread(a,1,80);count+=page.messages.length;s.acknowledge(a,1,page.receipt);if(!page.has_more)break;}while(true);
    assert.equal(count,80);assert.equal(s.unread(a,1).messages.length,0);
  }finally{s.close();}
});
test('pause, explicit departure, cursor retention, authentication and no implicit room creation',()=>{
  const {s,room,a,send}=fixture();try{
    assert.throws(()=>s.authenticate('bogus'),/credential/);
    assert.throws(()=>s.assign(a,'Does not exist',true),/Create/);
    send('First',[a]);const page=s.unread(a,1);s.acknowledge(a,1,page.receipt);
    s.run('UPDATE rooms SET paused=1 WHERE id=?',room.id);assert.equal(s.nextInvocation(a),undefined);
    s.run('UPDATE rooms SET paused=0 WHERE id=?',room.id);assert.ok(s.nextInvocation(a));
    s.assign(a,null,true,1);send('While departed',[],true);
    assert.equal(s.participant(a).room_id,null);
    s.assign(a,room.name,false,2);assert.deepEqual(s.unread(a,3).messages.map(m=>m.seq),[2]);assert.equal(s.nextInvocation(a),undefined);
  }finally{s.close();}
});
