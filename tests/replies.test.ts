import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../shared/store.ts';

test('existing databases gain reply support without changing old messages or unread positions',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-reply-upgrade-')),path=join(dir,'db');let s=new Store(path);
  try{
    const room=s.createRoom('Existing'),agent=s.register('Existing agent','').participant;
    s.assign(agent.id,room.name);
    const original=s.send(room.id,{id:'human',name:'You'},'Existing question',[],false,'old');
    const page=s.unread(agent.id,1);s.acknowledge(agent.id,1,page.receipt);
    // The previous schema had messages and cursors, but no reply-edge table.
    s.db.exec('DROP TABLE message_replies');s.close();s=new Store(path);
    assert.equal(s.history(room.id).messages[0].id,original.id);
    assert.deepEqual(s.history(room.id).messages[0].reply_to,[]);
    assert.equal(s.unread(agent.id,1).messages.length,0);
    const reply=s.send(room.id,{id:agent.id,name:agent.name},'Existing answer',[],false,'new',1,[original.id]);
    assert.equal(reply.reply_to[0].excerpt,'Existing question');
  }finally{s.close();rmSync(dir,{recursive:true});}
});

test('multi-message replies notify each author once, preserve context beyond the unread cursor, and survive restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-replies-'));let s=new Store(join(dir,'db'));
  try{
    const room=s.createRoom('Replies'),a=s.register('A','').participant as {id:string;name:string},b=s.register('B','').participant as {id:string;name:string};
    s.assign(a.id,room.name);s.assign(b.id,room.name);
    const first=s.send(room.id,a,'First request',[],false,'a',1);
    const second=s.send(room.id,a,'Second request',[],false,'b',1);
    const page=s.unread(a.id,1);s.acknowledge(a.id,1,page.receipt);
    const reply=s.send(room.id,b,'Both completed',[a.id],false,'reply',1,[second.id,first.id,first.id]);
    assert.deepEqual(reply.reply_to.map(p=>p.id),[first.id,second.id]);
    assert.equal(s.jobs(room.id).length,1);assert.equal(s.nextInvocation(a.id)?.seq,3);
    assert.equal(s.unread(a.id,1).messages[0].reply_to[0].excerpt,'First request');
    assert.equal(s.send(room.id,b,'Both completed',[a.id],false,'reply',1,[first.id,second.id]).id,reply.id);
    assert.throws(()=>s.send(room.id,b,'Both completed',[a.id],false,'reply',1,[first.id]),/Request key reused/);
    s.close();s=new Store(join(dir,'db'));
    assert.equal(s.history(room.id,2).messages[0].reply_to.length,2);
    s.deleteRoom(room.id);assert.equal(s.all('SELECT * FROM message_replies').length,0);
  }finally{s.close();rmSync(dir,{recursive:true});}
});

test('reply routing respects current room, human and self authors, and rejects invalid targets atomically',()=>{
  const s=new Store(':memory:');
  try{
    const room=s.createRoom('Room'),other=s.createRoom('Other'),a=s.register('A','').participant as {id:string;name:string},b=s.register('B','').participant as {id:string;name:string};
    s.assign(a.id,room.name);s.assign(b.id,room.name);
    const original=s.send(room.id,a,'Question',[],false,'a',1);
    const human=s.send(room.id,{id:'human',name:'You'},'Human question',[],false,'h');
    s.send(room.id,a,'Self followup',[],false,'self',1,[original.id]);
    s.send(room.id,b,'Human answer',[],false,'answer',1,[human.id]);
    assert.equal(s.jobs(room.id).length,0);
    s.assign(a.id,other.name,true,1);
    s.send(room.id,b,'Late answer',[],false,'late',1,[original.id]);
    assert.equal(s.jobs(room.id).length,0);assert.equal(s.nextInvocation(a.id),undefined);
    const foreign=s.send(other.id,a,'Other-room question',[],false,'foreign',2),head=s.room(room.id).head;
    for(const targets of [[foreign.id],[randomUUID()],[''],[1],null,'bad',Array(21).fill(original.id)]){
      assert.throws(()=>s.send(room.id,b,'Bad reply',[],false,randomUUID(),1,targets));
      assert.equal(s.room(room.id).head,head);
    }
    s.assign(a.id,room.name,true,2);
    s.send(room.id,b,'Welcome back',[],false,'back',1,[original.id]);
    assert.equal(s.nextInvocation(a.id)?.epoch,3);
  }finally{s.close();}
});

test('reply previews are bounded and included in history pagination size',()=>{
  const s=new Store(':memory:');
  try{
    const room=s.createRoom('Bounded'),human={id:'human',name:'You'};
    const parents=Array.from({length:20},()=>s.send(room.id,human,'x'.repeat(1000),[],false,randomUUID()).id);
    for(let i=0;i<10;i++)s.send(room.id,human,'Reply',[],false,randomUUID(),undefined,parents);
    const page=s.history(room.id,20);
    assert.equal(page.has_more,true);assert.ok(Buffer.byteLength(JSON.stringify(page.messages))<32_100);
    assert.equal(page.messages[0].reply_to[0].excerpt.length,240);
    assert.equal(s.history(room.id,page.next).messages[0].seq,page.next+1);
  }finally{s.close();}
});
