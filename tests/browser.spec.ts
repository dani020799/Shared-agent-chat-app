import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { Store } from '../shared/store.ts';
import { createHub } from '../apps/service/server.ts';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { call } from '../shared/client.ts';

test('browser: authentication, conversation creation, mentions, pause, mobile layout and safe message rendering',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-web-'));writeFileSync(join(dir,'config.json'),JSON.stringify({adminToken:'ui-test-admin',agentToken:'ui-test-enroll'}));
  const store=new Store(':memory:'),hub=createHub(store,{adminToken:'ui-test-admin',agentToken:'ui-test-enroll'});
  hub.server.listen(0,'127.0.0.1');await once(hub.server,'listening');
  const base=`http://127.0.0.1:${(hub.server.address() as any).port}`;
  const child=spawn(process.execPath,['apps/web/main.ts'],{env:{...process.env,HUB_URL:base,HUB_DATA_DIR:dir,HUB_WEB_PORT:'0'},stdio:['ignore','pipe','pipe']});
  let browser;
  try {
    const url=await new Promise<string>((resolveUrl,reject)=>{const timer=setTimeout(()=>reject(new Error('Web app failed to start')),5000);child.once('error',reject);child.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolveUrl(match[0]);}});child.stderr.on('data',chunk=>console.error(String(chunk)));});
    browser=await chromium.launch({executablePath:process.env.HUB_TEST_CHROMIUM ?? '/snap/bin/chromium',headless:true});
    const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();const errors:string[]=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);await page.locator('#token').fill('ui-test-admin');await page.locator('#login-form button').click();
    await page.locator('#first-room').click();await page.locator('#room-name').fill('Website redesign');await page.locator('#create-form button[type=submit], #create-form button:not([type])').click();
    await page.getByRole('heading',{name:'Website redesign',exact:true}).waitFor();
    const room=store.rooms()[0];
    const backend=await call(base,'ui-test-enroll','/register',{name:'Backend',role:'Implementation',adapter:'manual'});
    const reviewer=await call(base,'ui-test-enroll','/register',{name:'Reviewer',role:'Code review',adapter:'manual'});
    await call(base,backend.token,'/join',{conversation:room.name,epoch:0});await call(base,reviewer.token,'/join',{conversation:room.name,epoch:0});
    await page.locator('#members').getByText('Reviewer',{exact:true}).waitFor();
    await page.locator('#message').fill('A note for the room.');await page.locator('#send').click();await page.locator('#thread').getByText('A note for the room.',{exact:true}).waitFor();
    assert.equal(store.jobs(room.id).length,0);
    await page.locator('#message').fill('@Rev');await page.locator('#mentions button').click();await page.locator('#message').press('End');await page.locator('#message').pressSequentially('please review this.');await page.locator('#send').click();
    await page.locator('#jobs').getByText('pending',{exact:true}).first().waitFor();assert.equal(store.jobs(room.id)[0].participant_id,reviewer.participant.id);
    await page.locator('#message').fill('@all Please share your progress.');await page.locator('#send').click();
    await page.locator('#thread').getByText('@all Please share your progress.',{exact:true}).waitFor();assert.equal(store.jobs(room.id).length,3);
    // MCP-style bot routing need not include literal @names in the body.
    await call(base,backend.token,'/send',{epoch:1,text:'Please review the implementation.',recipients:[reviewer.participant.id],request_key:'bot-mention'});
    const botMessage=page.locator('#thread .message').filter({hasText:'Please review the implementation.'});
    await botMessage.locator('.message-mention').getByText('@Reviewer',{exact:true}).waitFor();
    await call(base,backend.token,'/send',{epoch:1,text:'Team update requested.',all:true,request_key:'bot-all'});
    await page.locator('#thread .message').filter({hasText:'Team update requested.'}).locator('.message-mention').getByText('@all',{exact:true}).waitFor();
    // Historical mentions keep their names when recipients leave and after reload.
    await call(base,reviewer.token,'/disconnect',{epoch:1});
    await page.reload();await page.getByRole('button',{name:'# Website redesign'}).click();
    await botMessage.locator('.message-mention').getByText('@Reviewer',{exact:true}).waitFor();
    assert.equal(await page.locator('#thread .message').filter({hasText:'A note for the room.'}).locator('.message-mention').count(),0);
    await page.locator('#pause').click();await page.getByRole('button',{name:'Resume invocations'}).waitFor();assert.equal(store.room(room.id).paused,1);
    await page.locator('#message').fill('<img src=x onerror="window.hacked=true">');await page.locator('#send').click();await page.locator('#thread').getByText('<img src=x onerror="window.hacked=true">',{exact:true}).waitFor();assert.equal(await page.locator('#thread img').count(),0);
    mkdirSync('test-results',{recursive:true});await page.screenshot({path:resolve('test-results/desktop.png'),fullPage:true,animations:'disabled'});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve('test-results/mobile.png'),fullPage:true,animations:'disabled'});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));assert.deepEqual(errors,[]);
    const wrongOrigin=await fetch(url+'/api/rooms',{method:'POST',headers:{Origin:'https://untrusted.example','Content-Type':'application/json'},body:JSON.stringify({name:'blocked'})});assert.equal(wrongOrigin.status,403);
    const otherTab=await page.context().newPage();await otherTab.goto(url);await otherTab.getByRole('button',{name:'# Website redesign'}).click();
    page.once('dialog',dialog=>dialog.dismiss());await page.locator('#delete-room').click();assert.equal(store.rooms().length,1);
    page.once('dialog',dialog=>dialog.accept());await page.locator('#delete-room').click();
    await page.locator('#empty').waitFor();await otherTab.locator('#empty').waitFor();await otherTab.close();assert.equal(store.rooms().length,0);
    assert.equal(store.participant(backend.participant.id).room_id,null);
    assert.equal(store.notifications(backend.participant.id)[0].kind,'conversation_deleted');
    await page.locator('#first-room').click();await page.locator('#room-name').fill('Next conversation');await page.locator('#create-form button:not([type])').click();
    await page.getByRole('heading',{name:'Next conversation',exact:true}).waitFor();
    await page.locator('#logout').click();await page.locator('#login').waitFor();
  }finally{await browser?.close();child.kill('SIGTERM');if(child.exitCode===null)await once(child,'exit');hub.closeStreams();await new Promise<void>(r=>hub.server.close(()=>r()));store.close();rmSync(dir,{recursive:true});}
});
