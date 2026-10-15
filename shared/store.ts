import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

export type Row = Record<string, any>;
export class HubError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export function requireText(value: unknown, label: string, max = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HubError(`${label} must contain 1–${max} characters`);
  return value.trim();
}
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        head INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0,
        created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT NOT NULL,
        room_id TEXT REFERENCES rooms(id), epoch INTEGER NOT NULL DEFAULT 0,
        adapter TEXT NOT NULL DEFAULT 'manual'
      );
      CREATE TABLE IF NOT EXISTS cursors (
        participant_id TEXT REFERENCES participants(id), room_id TEXT REFERENCES rooms(id),
        seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(participant_id,room_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), seq INTEGER NOT NULL,
        sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, body TEXT NOT NULL,
        request_key TEXT NOT NULL, routing TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(room_id,seq), UNIQUE(sender_id,request_key)
      );
      CREATE INDEX IF NOT EXISTS messages_room_seq ON messages(room_id,seq);
      CREATE TABLE IF NOT EXISTS invocations (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id),
        participant_id TEXT NOT NULL REFERENCES participants(id), epoch INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', error TEXT, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(message_id,participant_id)
      );
      CREATE INDEX IF NOT EXISTS invocations_recipient_status ON invocations(participant_id,status);
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES participants(id),
        room_id TEXT NOT NULL REFERENCES rooms(id), epoch INTEGER NOT NULL,
        from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES participants(id),
        kind TEXT NOT NULL, room_id TEXT NOT NULL, room_name TEXT NOT NULL, epoch INTEGER NOT NULL,
        acknowledged INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS notifications_pending ON notifications(participant_id,acknowledged);
    `);
  }
  all(sql: string, ...args: any[]): Row[] { return this.db.prepare(sql).all(...args) as Row[]; }
  one(sql: string, ...args: any[]): Row | undefined { return this.db.prepare(sql).get(...args) as Row | undefined; }
  run(sql: string, ...args: any[]) { return this.db.prepare(sql).run(...args); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  rooms() { return this.all('SELECT * FROM rooms ORDER BY created,id'); }
  room(id: string) { const r = this.one('SELECT * FROM rooms WHERE id=?', id); if (!r) throw new HubError('Conversation not found', 404); return r; }
  createRoom(name: unknown) {
    const clean = requireText(name, 'Conversation name');
    if (this.one('SELECT id FROM rooms WHERE name=?', clean)) throw new HubError('Conversation name already exists', 409);
    const id = randomUUID(); this.run('INSERT INTO rooms(id,name) VALUES(?,?)', id, clean); return this.room(id);
  }
  register(name: unknown, role: unknown, adapter = 'manual') {
    if (!['manual','claude-channel','claude-bridge','codex-queue','wait'].includes(adapter)) throw new HubError('Unknown adapter');
    if (typeof role !== 'string' || role.length > 240) throw new HubError('Role must be plain text, at most 240 characters');
    const id = randomUUID(), token = randomBytes(32).toString('hex');
    this.run('INSERT INTO participants(id,name,role,token_hash,adapter) VALUES(?,?,?,?,?)', id, requireText(name, 'Name'), role, digest(token), adapter);
    return { participant: this.participant(id), token };
  }
  deleteRoom(id:string) {
    return this.transaction(()=>{
      const room=this.room(id),members=this.members(id);
      for(const member of members){
        this.run('UPDATE participants SET room_id=NULL,epoch=epoch+1 WHERE id=?',member.id);
        this.run('INSERT INTO notifications(id,participant_id,kind,room_id,room_name,epoch) VALUES(?,?,?,?,?,?)',randomUUID(),member.id,'conversation_deleted',id,room.name,member.epoch+1);
      }
      this.run('DELETE FROM deliveries WHERE room_id=?',id);
      this.run('DELETE FROM cursors WHERE room_id=?',id);
      this.run('DELETE FROM invocations WHERE message_id IN (SELECT id FROM messages WHERE room_id=?)',id);
      this.run('DELETE FROM messages WHERE room_id=?',id);
      this.run('DELETE FROM rooms WHERE id=?',id);
      return {deleted:id,detached_agents:members.length};
    });
  }
  notifications(id:string) {return this.all('SELECT * FROM notifications WHERE participant_id=? AND acknowledged=0 ORDER BY created,id',id);}
  acknowledgeNotification(id:string,notificationId:string) {
    const event=this.one('SELECT id FROM notifications WHERE id=? AND participant_id=?',notificationId,id);
    if(!event)throw new HubError('Notification not found',404);
    this.run('UPDATE notifications SET acknowledged=1 WHERE id=?',notificationId);
    return {acknowledged:notificationId};
  }
  participant(id: string): Row {
    const p = this.one('SELECT id,name,role,room_id,epoch,adapter FROM participants WHERE id=?', id);
    if (!p) throw new HubError('Participant not found', 404); return p;
  }
  authenticate(token: string): Row {
    const p = this.one('SELECT id FROM participants WHERE token_hash=?', digest(token));
    if (!p) throw new HubError('Invalid agent credential', 401); return this.participant(p.id);
  }
  active(id: string, epoch: number): Row {
    const p = this.participant(id);
    if (!Number.isSafeInteger(epoch) || p.epoch !== epoch || !p.room_id) throw new HubError('Assignment changed or disconnected; refresh status', 409);
    return p;
  }
  assign(id: string, name: string | null, switchRoom = false, expectedEpoch?: number) {
    return this.transaction(() => {
      const p = this.participant(id);
      if (expectedEpoch !== undefined && p.epoch !== expectedEpoch) throw new HubError('Stale assignment', 409);
      const room = name === null ? null : this.one('SELECT * FROM rooms WHERE name=? OR id=?', name, name);
      if (name !== null && !room) throw new HubError('Create this conversation in the web app first', 404);
      const roomId = room?.id ?? null;
      if (p.room_id === roomId) return p;
      if (p.room_id && roomId && !switchRoom) throw new HubError('Already assigned. Use switch_conversation explicitly.', 409);
      this.run("UPDATE invocations SET status='canceled' WHERE participant_id=? AND status IN ('pending','notified','failed','uncertain')", id);
      this.run('DELETE FROM deliveries WHERE participant_id=?', id);
      this.run('UPDATE participants SET room_id=?,epoch=epoch+1 WHERE id=?', roomId, id);
      if (roomId) this.run('INSERT OR IGNORE INTO cursors(participant_id,room_id) VALUES(?,?)', id, roomId);
      return this.participant(id);
    });
  }
  members(roomId: string) { return this.all('SELECT id,name,role,epoch,adapter FROM participants WHERE room_id=? ORDER BY name,id', roomId); }
  send(roomId: string, sender: { id: string; name: string }, body: unknown, recipients: unknown, all: boolean, requestKey: unknown, epoch?: number) {
    const text = requireText(body, 'Message', 16_000), key = requireText(requestKey, 'Request key', 100);
    if (!Array.isArray(recipients) || recipients.some(id => typeof id !== 'string')) throw new HubError('Recipients must be participant IDs');
    const routing = JSON.stringify({all,recipients:all?[]:[...new Set(recipients)].sort()});
    return this.transaction(() => {
      this.room(roomId);
      if (sender.id !== 'human') {
        const p = this.active(sender.id, epoch!);
        if (p.room_id !== roomId) throw new HubError('Not assigned to this conversation', 403);
      }
      const existing = this.one('SELECT * FROM messages WHERE sender_id=? AND request_key=?', sender.id, key);
      if (existing) {
        if (existing.room_id !== roomId || existing.body !== text || existing.routing !== routing) throw new HubError('Request key reused for another message', 409);
        return existing;
      }
      const members = this.members(roomId);
      const ids = [...new Set<string>(all ? members.map(p => p.id).filter(id => id !== sender.id) : recipients)];
      if (ids.some(id => !members.some(p => p.id === id))) throw new HubError('A recipient is no longer assigned to this room', 409);
      if (ids.includes(sender.id)) throw new HubError('Self-invocation is not supported');
      this.run('UPDATE rooms SET head=head+1 WHERE id=?', roomId);
      const seq = this.room(roomId).head, id = randomUUID();
      this.run('INSERT INTO messages(id,room_id,seq,sender_id,sender_name,body,request_key,routing) VALUES(?,?,?,?,?,?,?,?)', id, roomId, seq, sender.id, sender.name, text, key,routing);
      for (const recipient of ids) {
        const p = members.find(p => p.id === recipient)!;
        this.run('INSERT INTO invocations(id,message_id,participant_id,epoch) VALUES(?,?,?,?)', randomUUID(), id, p.id, p.epoch);
      }
      return this.one('SELECT * FROM messages WHERE id=?', id)!;
    });
  }
  history(roomId: string, after = 0, through?: number, limit = 50) {
    const room = this.room(roomId);
    if (!Number.isSafeInteger(after) || after < 0 || (through !== undefined && (!Number.isSafeInteger(through) || through < 0))) throw new HubError('Invalid history position');
    const end = Math.min(through ?? room.head, room.head);
    const rows = this.all('SELECT * FROM messages WHERE room_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?', roomId, after, end, Math.max(1,Math.min(100,limit)));
    const messages: Row[] = []; let bytes = 0;
    for (const row of rows) {
      const size = Buffer.byteLength(row.body, 'utf8');
      if (messages.length && bytes + size > 32_000) break;
      messages.push(row); bytes += size;
    }
    const next = messages.at(-1)?.seq ?? after;
    const mentions = this.all(`SELECT i.message_id,p.id,p.name FROM invocations i
      JOIN participants p ON p.id=i.participant_id JOIN messages m ON m.id=i.message_id
      WHERE m.room_id=? AND m.seq>? AND m.seq<=? ORDER BY p.name,p.id`,roomId,after,next);
    for (const message of messages) message.mentions=mentions.filter(p=>p.message_id===message.id).map(({id,name})=>({id,name}));
    return { messages, next, through: end, has_more: next < end };
  }
  unread(id: string, epoch: number, through?: number) {
    const p = this.active(id, epoch);
    const cursor = this.one('SELECT seq FROM cursors WHERE participant_id=? AND room_id=?', id, p.room_id)!.seq;
    const page = this.history(p.room_id, cursor, through);
    const receipt = randomUUID();
    this.run('INSERT INTO deliveries VALUES(?,?,?,?,?,?)', receipt, id, p.room_id, epoch, cursor, page.next);
    return { ...page, receipt, epoch, room_id: p.room_id };
  }
  acknowledge(id: string, epoch: number, receipt: string) {
    return this.transaction(() => {
      const p = this.active(id, epoch);
      const d = this.one('SELECT * FROM deliveries WHERE id=? AND participant_id=? AND epoch=? AND room_id=?', receipt, id, epoch, p.room_id);
      if (!d) throw new HubError('Unknown or stale receipt', 409);
      this.run('UPDATE cursors SET seq=MAX(seq,?) WHERE participant_id=? AND room_id=?', d.to_seq, id, p.room_id);
      this.run('DELETE FROM deliveries WHERE participant_id=? AND room_id=? AND to_seq<=?', id, p.room_id, d.to_seq);
      return { acknowledged_through: d.to_seq };
    });
  }
  nextInvocation(id: string) {
    const p = this.participant(id);
    if (!p.room_id || this.room(p.room_id).paused) return undefined;
    if (this.one("SELECT id FROM invocations WHERE participant_id=? AND epoch=? AND status IN ('notified','uncertain')", id,p.epoch)) return undefined;
    return this.one(`SELECT i.*,m.seq,m.room_id FROM invocations i JOIN messages m ON m.id=i.message_id
      WHERE i.participant_id=? AND i.epoch=? AND i.status='pending' AND m.room_id=? ORDER BY m.seq LIMIT 1`, id,p.epoch,p.room_id);
  }
  claim(id: string, epoch: number): Row | null {
    return this.transaction(() => {
      this.active(id,epoch); const job = this.nextInvocation(id);
      if (!job) return null;
      this.run("UPDATE invocations SET status='notified' WHERE id=?", job.id);
      return { ...job, status: 'notified' };
    });
  }
  finish(id: string, epoch: number, invocationId: string) {
    const p = this.active(id,epoch);
    const job = this.one('SELECT i.*,m.seq FROM invocations i JOIN messages m ON m.id=i.message_id WHERE i.id=? AND i.participant_id=? AND i.epoch=? AND m.room_id=?', invocationId,id,epoch,p.room_id);
    if (!job || job.status !== 'notified') throw new HubError('Invocation is not active',409);
    const cursor = this.one('SELECT seq FROM cursors WHERE participant_id=? AND room_id=?',id,p.room_id)!.seq;
    if (cursor < job.seq) throw new HubError('Read and acknowledge context through the triggering message first',409);
    this.run("UPDATE invocations SET status='completed' WHERE id=?", invocationId);
    return { completed: invocationId };
  }
  jobs(roomId: string) { return this.all(`SELECT i.id,i.participant_id,i.status,i.error,m.seq,p.name FROM invocations i JOIN messages m ON m.id=i.message_id JOIN participants p ON p.id=i.participant_id WHERE m.room_id=? ORDER BY m.seq DESC LIMIT 100`,roomId); }
  retry(id: string) {
    const job = this.one('SELECT i.*,m.room_id FROM invocations i JOIN messages m ON m.id=i.message_id WHERE i.id=?',id);
    if (!job) throw new HubError('Invocation not found',404);
    const p = this.active(job.participant_id,job.epoch);
    if (p.room_id !== job.room_id || !['failed','uncertain'].includes(job.status)) throw new HubError('Only failed or uncertain active-room invocations can be retried',409);
    this.run("UPDATE invocations SET status='pending',error=NULL WHERE id=?",id);
  }
  recover() { this.run("UPDATE invocations SET status='uncertain',error='Service restarted after notification; inspect the agent before retrying.' WHERE status='notified'"); }
  close() { this.db.close(); }
}
