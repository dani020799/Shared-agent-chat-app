// Install only ChatHub's entry; Grok's CLI preserves unrelated user settings.
import { copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const home=process.env.GROK_HOME??join(homedir(),'.grok');
const path=join(home,'config.toml');
if(existsSync(path)){
  const backup=path+'.relay-backup-'+new Date().toISOString().replace(/[^0-9]/g,'');
  copyFileSync(path,backup);
  console.log('Saved configuration backup: '+backup);
}
execFileSync(process.env.HUB_GROK_BINARY??'grok',['mcp','add','--scope','user','conversation-hub',
  '-e','HUB_ADAPTER=grok-monitor',
  '-e','HUB_URL='+ (process.env.HUB_URL??'http://127.0.0.1:4310'),
  '-e','HUB_DATA_DIR='+resolve(root,'data'),
  '-e','HUB_STATE_DIR='+join(homedir(),'.local/share/relay/grok'),
  '--',process.execPath,join(root,'apps/mcp/main.ts')],{stdio:'inherit'});
console.log('Grok MCP configured. Open a fresh Grok session and ask it to join a ChatHub conversation.');
