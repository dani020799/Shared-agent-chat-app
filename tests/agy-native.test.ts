import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerAgy, validateAgy, pushAgyWake } from '../shared/agy-native.ts';

test('native bindings isolate sessions, protect credentials and reject stale/insecure registrations',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-agy-'));
  const previous=process.env.HUB_AGY_BINDINGS_DIR;process.env.HUB_AGY_BINDINGS_DIR=join(dir,'bindings');
  const capture=join(dir,'capture'),fake=join(dir,'agy');
  writeFileSync(fake,`#!/usr/bin/env node\nconst fs=require('node:fs');if(process.argv[3]==='send-message')fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({session:process.env.ANTIGRAVITY_CONVERSATION_ID,args:process.argv.slice(2)})+'\\n');`,{mode:0o700});
  const a=randomUUID(),b=randomUUID();
  const env=(session:string)=>({ANTIGRAVITY_CONVERSATION_ID:session,ANTIGRAVITY_LS_ADDRESS:'localhost:1',ANTIGRAVITY_CSRF_TOKEN:'secret-marker',ANTIGRAVITY_AGENTAPI_EXE:fake});
  try{
    await assert.rejects(registerAgy({}),/conversation UUID/);
    await assert.rejects(registerAgy({ANTIGRAVITY_CONVERSATION_ID:a}),/native shell/);
    const registration=await registerAgy(env(a));await registerAgy(env(b));
    assert.doesNotMatch(JSON.stringify(registration),/secret-marker|localhost/);
    const path=join(process.env.HUB_AGY_BINDINGS_DIR!,`${a}.json`);
    assert.equal(statSync(path).mode&0o777,0o600);
    assert.equal(statSync(process.env.HUB_AGY_BINDINGS_DIR!).mode&0o777,0o700);
    await pushAgyWake(a,'Identifier-only wake');
    const sent=JSON.parse(readFileSync(capture,'utf8').trim());
    assert.equal(sent.session,a);assert.equal(sent.args[2],a);assert.notEqual(sent.args[2],b);
    chmodSync(path,0o644);await assert.rejects(validateAgy(a),/No private Antigravity binding/);chmodSync(path,0o600);
    await assert.rejects(validateAgy(randomUUID()),/No private Antigravity binding/);
    writeFileSync(fake,"#!/bin/sh\necho secret-marker >&2\nexit 1\n",{mode:0o700});
    await assert.rejects(pushAgyWake(a,'wake'),error=>error instanceof Error&&!error.message.includes('secret-marker')&&/re-register/.test(error.message));
  }finally{
    if(previous===undefined)delete process.env.HUB_AGY_BINDINGS_DIR;else process.env.HUB_AGY_BINDINGS_DIR=previous;
    rmSync(dir,{recursive:true,force:true});
  }
});
