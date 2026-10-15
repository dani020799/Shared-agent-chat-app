import { DatabaseSync, backup } from 'node:sqlite';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { dataDir } from '../shared/config.ts';
process.umask(0o077);
mkdirSync(resolve(dataDir,'backups'),{recursive:true,mode:0o700});
const target = resolve(dataDir,'backups',`hub-${Date.now()}.sqlite`);
const db = new DatabaseSync(resolve(dataDir,'hub.sqlite'));
await backup(db,target); db.close(); console.log(`Consistent backup saved to ${target}`);
