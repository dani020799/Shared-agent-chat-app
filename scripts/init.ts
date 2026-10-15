import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { dataDir } from '../shared/config.ts';
process.umask(0o077);
mkdirSync(dataDir,{recursive:true,mode:0o700});
const file = resolve(dataDir,'config.json');
if (existsSync(file)) console.log('Existing configuration preserved.');
else { writeFileSync(file,JSON.stringify({adminToken:randomBytes(32).toString('hex'),agentToken:randomBytes(32).toString('hex')},null,2),{mode:0o600,flag:'wx'}); console.log(`Created private configuration at ${file}. Tokens are not printed.`); }
