import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dataDir } from './config.ts';

const execute=promisify(execFile);
type Binding={session:string;address:string;token:string;executable:string};
function directory(){return resolve(process.env.HUB_AGY_BINDINGS_DIR ?? resolve(dataDir,'agy-bindings'));}
function filename(session:unknown){
  if(typeof session!=='string'||!/^[0-9a-f-]{36}$/i.test(session))throw new Error('Supply this Antigravity conversation UUID as host_session_id. Run scripts/register-agy.ts inside that same native session first.');
  return resolve(directory(),`${session}.json`);
}
async function invoke(binding:Binding,args:string[]){
  try {
    return await execute(binding.executable,['agentapi',...args],{timeout:15_000,maxBuffer:128_000,env:{...process.env,ANTIGRAVITY_CONVERSATION_ID:binding.session,ANTIGRAVITY_LS_ADDRESS:binding.address,ANTIGRAVITY_CSRF_TOKEN:binding.token,ANTIGRAVITY_AGENTAPI_EXE:binding.executable}});
  }catch{throw new Error('Antigravity native dispatch or validation failed. Inspect the native session before retrying; re-register after a host restart.');}
}
export async function registerAgy(env:NodeJS.ProcessEnv=process.env){
  const session=env.ANTIGRAVITY_CONVERSATION_ID;
  const path=filename(session);
  const address=env.ANTIGRAVITY_LS_ADDRESS,token=env.ANTIGRAVITY_CSRF_TOKEN,executable=env.ANTIGRAVITY_AGENTAPI_EXE;
  if(!address||!token||!executable||!executable.startsWith('/'))throw new Error('Run this helper through the native shell tool of the Antigravity session you want to connect. Required native environment is missing.');
  const binding:Binding={session:session!,address,token,executable};
  await invoke(binding,['get-conversation-metadata',binding.session]);
  mkdirSync(directory(),{recursive:true,mode:0o700});chmodSync(directory(),0o700);
  const temporary=path+`.${process.pid}.tmp`;
  writeFileSync(temporary,JSON.stringify(binding),{mode:0o600,flag:'wx'});renameSync(temporary,path);
  return {host_session_id:binding.session,instructions:'Join conversation-hub with this host_session_id. Credentials were saved privately and are not returned.'};
}
export async function validateAgy(session:unknown){
  const path=filename(session);
  let binding:Binding;
  try {
    const stat=lstatSync(path);
    if(!stat.isFile()||(stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid()))throw new Error();
    binding=JSON.parse(readFileSync(path,'utf8'));
    if(binding.session!==session||!binding.address||!binding.token||!binding.executable?.startsWith('/'))throw new Error();
  }catch{throw new Error('No private Antigravity binding for this conversation. Run scripts/register-agy.ts through this session’s native shell tool, then join with the returned host_session_id.');}
  await invoke(binding,['get-conversation-metadata',binding.session]);
  return binding;
}
export async function pushAgyWake(session:unknown,prompt:string){
  const binding=await validateAgy(session);
  await invoke(binding,['send-message',binding.session,prompt]);
}
