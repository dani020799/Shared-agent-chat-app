// Config-only installer. Preserves other MCP servers/settings and backs up each changed file.
import { readFileSync,writeFileSync,copyFileSync,existsSync,mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve,join } from 'node:path';
import ts from 'typescript';
const root=resolve(import.meta.dirname,'..'),home=homedir();
const stamp=new Date().toISOString().replace(/[^0-9]/g,'');
function save(path:string,text:string){const old=readFileSync(path,'utf8');if(old===text)return;copyFileSync(path,`${path}.relay-backup-${stamp}`);writeFileSync(path,text);console.log(`Updated ${path} (backup saved)`);}
function mcp(path:string,mode:string){const value=JSON.parse(readFileSync(path,'utf8'));const connector=value.mcpServers?.['conversation-hub'];if(!connector)throw new Error(`Missing Relay connector in ${path}`);connector.env={...connector.env,HUB_ADAPTER:mode};save(path,JSON.stringify(value,null,2)+'\n');}
const settingsPath=join(home,'.config/Code/User/settings.json');
const source=readFileSync(settingsPath,'utf8');
const parsed=ts.parseConfigFileTextToJson(settingsPath,source);
if(parsed.error)throw new Error('VS Code settings are invalid JSONC');
const launcher=join(root,'data/claude-process-wrapper');
const previous=parsed.config['claudeCode.claudeProcessWrapper'];
if(previous&&previous!==launcher)throw new Error('A different Claude wrapper is already configured; refusing to replace it');
const codexPath=join(home,'.codex/config.toml');
let toml=readFileSync(codexPath,'utf8');
const section=/\[mcp_servers\.conversation-hub\.env\]([^]*?)(?=\n\[|$)/;
if(!section.test(toml))throw new Error('Missing Relay Codex configuration');
const binary=join(process.execPath,'../codex');
if(!existsSync(binary))throw new Error('Codex executable not found alongside Node');
toml=toml.replace(section,(_whole,body:string)=>{
  let next=body.replace(/^HUB_ADAPTER\s*=.*$/m,'HUB_ADAPTER = "codex-queue"');
  if(!/^HUB_ADAPTER\s*=/m.test(next))next+='\nHUB_ADAPTER = "codex-queue"\n';
  const line=`HUB_CODEX_BINARY = ${JSON.stringify(binary)}`;
  next=/^HUB_CODEX_BINARY\s*=/m.test(next)?next.replace(/^HUB_CODEX_BINARY\s*=.*$/m,line):next.trimEnd()+'\n'+line+'\n';
  return '[mcp_servers.conversation-hub.env]'+next;
});
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
mkdirSync(join(root,'data'),{recursive:true});
writeFileSync(launcher,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(root,'scripts/claude-wrapper.ts'))} "$@"\n`,{mode:0o700});
if(!previous){const at=source.indexOf('{');if(at<0)throw new Error('Missing settings object');const property=`\n  "claudeCode.claudeProcessWrapper": ${JSON.stringify(launcher)}${Object.keys(parsed.config).length?',':''}`;const updated=source.slice(0,at+1)+property+source.slice(at+1);if(ts.parseConfigFileTextToJson(settingsPath,updated).error)throw new Error('Settings edit failed validation');save(settingsPath,updated);}
save(codexPath,toml);
mcp(join(home,'.claude.json'),'auto');
mcp(join(home,'.gemini/config/mcp_config.json'),'agy-native');
console.log('Restart host chats to load the automatic adapters. For native Antigravity CLI, register each intended session with scripts/register-agy.ts before joining. The IDE remains unverified.');
