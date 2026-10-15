import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { startClaudeBridge, pushClaudeWake } from '../shared/claude-bridge.ts';

test('Claude bridge preserves partial host frames, rejects unauthenticated wakes, and deduplicates delivery',async()=>{
  const input=new PassThrough(),output=new PassThrough(),error=new PassThrough();
  let received='';output.on('data',chunk=>received+=chunk);
  const bridge=await startClaudeBridge(process.execPath,['-e','process.stdin.pipe(process.stdout)'],input,output,error);
  try {
    input.write('{"type":"control_');
    await assert.rejects(pushClaudeWake(bridge.socket,'wrong','bad','Do not deliver'));
    await pushClaudeWake(bridge.socket,bridge.secret,'one','Wake one');
    await pushClaudeWake(bridge.socket,bridge.secret,'one','Duplicate');
    input.write('response","ok":true}\n');
    await pushClaudeWake(bridge.socket,bridge.secret,'two','Wake two');
    input.end();await once(bridge.child,'exit');
    const frames=received.trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(frames.map(f=>f.message?.content??f.type),['Wake one','control_response','Wake two']);
    assert.equal(existsSync(bridge.socket),false);
  }finally{bridge.close();}
});

test('Claude bridges isolate independent sessions',async()=>{
  const make=()=>startClaudeBridge(process.execPath,['-e','process.stdin.pipe(process.stdout)'],new PassThrough(),new PassThrough(),new PassThrough());
  const a=await make(),b=await make();
  try{assert.notEqual(a.socket,b.socket);await assert.rejects(pushClaudeWake(b.socket,a.secret,'cross','Wrong session'));}
  finally{a.close();b.close();}
});
