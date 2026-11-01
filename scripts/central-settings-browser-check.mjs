// Real local HTTP UI smoke in an isolated, disposable headless Chrome profile.
// It never connects a Discord account or sends a Discord message.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startCentralRuntime} from '../central/runtime/main.mjs';

const chrome=process.env.DICO_BROWSER_BINARY||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const base=await mkdtemp(resolve(tmpdir(),'dico-ui-browser-'));
const profile=resolve(base,'chrome'),data=resolve(base,'data');
let runtime,child,socket;
let nextId=0;
const pending=new Map(),errors=[];
async function until(get,timeout=12000) {
  const started=Date.now();
  while(Date.now()-started<timeout){try{const value=await get();if(value)return value;}catch{}await delay(100)}
  throw Error('Timed out waiting for browser state');
}
function cmd(method,params={}) {
  return new Promise((resolve,reject)=>{
    const id=++nextId;pending.set(id,{resolve,reject});
    socket.send(JSON.stringify({id,method,params}));
  });
}
async function evalJS(expression) {
  const result=await cmd('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw Error(result.exceptionDetails.text);
  return result.result.value;
}
async function visible(phrase) {return until(async()=>await evalJS(`document.body.innerText.includes(${JSON.stringify(phrase)})`))}
async function clickText(selector,text) {
  const found=await evalJS(`(() => {const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(!el)return false;el.click();return true})()`);
  assert.ok(found,`Control not found: ${text}`);
}
async function checkLongAttemptModal() {
  const dimensions=await evalJS(`(() => {
    const backdrop=document.createElement('div');backdrop.className='modal-backdrop';backdrop.dataset.layoutCheck='';
    const dialog=document.createElement('div');dialog.className='modal';dialog.setAttribute('role','dialog');dialog.tabIndex=0;
    dialog.innerHTML='<div class="panel-head"><h2>발송 시도 상세</h2></div><dl class="detail-list"><dt>결과</dt><dd>게시 여부 확인 필요</dd></dl>';
    const diagnostics=document.createElement('div');diagnostics.className='attempt-diagnostics';
    for(let i=0;i<70;i++){const row=document.createElement('p');row.textContent='진단 기록 '+i+' · 발송 시도 상세 증거 확인';diagnostics.append(row)}
    dialog.append(diagnostics);const close=document.createElement('button');close.textContent='닫기';dialog.append(close);
    backdrop.append(dialog);document.body.append(backdrop);dialog.focus();
    return {height:dialog.getBoundingClientRect().height,viewport:innerHeight,scrollHeight:dialog.scrollHeight,clientHeight:dialog.clientHeight,top:dialog.getBoundingClientRect().top};
  })()`);
  assert.ok(dimensions.height<=dimensions.viewport-15,`Dialog exceeds viewport: ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.top>=0,`Dialog top clipped: ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.scrollHeight>dimensions.clientHeight,`Long diagnostics should scroll: ${JSON.stringify(dimensions)}`);
  await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End'});
  await until(async()=>await evalJS('document.querySelector("[data-layout-check] .modal")?.scrollTop>0'));
  assert.ok(await evalJS('document.querySelector("[data-layout-check] .modal button")?.getBoundingClientRect().bottom<=innerHeight'), 'Close button must be reachable after keyboard scrolling');
  await evalJS('document.querySelector("[data-layout-check]")?.remove()');
}
try {
  runtime=await startCentralRuntime({directory:data,port:0});
  runtime.manager.execute('settings.update',{retentionDays:180,notificationsEnabled:true,hideNotificationNames:false});
  child=spawn(chrome,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-extensions','--disable-gpu','--window-size=1440,900','about:blank'],{stdio:['ignore','pipe','pipe']});
  let browserStderr='';
  child.stderr.on('data',chunk=>{browserStderr+=String(chunk).slice(0,1500)});
  const exited=new Promise((_,reject)=>child.once('exit',(code,signal)=>reject(Error(`Browser launch failed (exit ${code}, signal ${signal}): ${browserStderr||'no stderr'}`))));
  const port=await Promise.race([until(async()=>Number((await readFile(resolve(profile,'DevToolsActivePort'),'utf8')).split('\n')[0])),exited]);
  const response=await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'});
  assert.equal(response.status,200);
  const tab=await response.json();
  socket=new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})});
  socket.addEventListener('message',message=>{
    const packet=JSON.parse(message.data);
    if(packet.id){const waiting=pending.get(packet.id);pending.delete(packet.id);if(packet.error)waiting?.reject(Error(packet.error.message));else waiting?.resolve(packet.result)}
    if(packet.method==='Runtime.exceptionThrown')errors.push(packet.params.exceptionDetails.text);
    if(packet.method==='Log.entryAdded' && packet.params.entry.level==='error')errors.push(packet.params.entry.text);
  });
  await cmd('Page.enable');await cmd('Runtime.enable');await cmd('Log.enable');
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});
  const url=`${runtime.url}/settings#bootstrap=${runtime.app.issueBootstrap()}`;
  await cmd('Page.navigate',{url});await visible('기록 보존');
  const select=async(label,value)=>{
    await evalJS(`(() => {const el=document.querySelector('select[aria-label="${label}"]');el.value='${value}';el.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  };
  const field=label=>evalJS(`document.querySelector('select[aria-label="${label}"]')?.value`);
  assert.equal(await field('기록 보존 기간'),'180');
  assert.deepEqual(await evalJS('[...document.querySelectorAll(".switch-label input")].map(x=>x.checked)'),[true,false]);
  assert.equal(await evalJS('document.documentElement.dataset.theme'),'dark');
  await select('기록 보존 기간','30');
  await evalJS('document.querySelector(".switch-label input").click()');
  await clickText('button','알림 설정 저장');
  await until(()=>runtime.manager.snapshot().settings.notificationsEnabled===false);
  await until(async()=>await evalJS('[...document.querySelectorAll("button")].find(x=>x.textContent==="알림 설정 저장")?.disabled'));
  assert.equal(await field('기록 보존 기간'),'30','Notification save preserves unsaved retention');
  await evalJS('[...document.querySelectorAll("button")].find(x=>x.textContent==="설정 저장").click()');
  await until(()=>runtime.manager.snapshot().settings.retentionDays===30);
  await evalJS('document.querySelector(".switch-label input").click()');
  runtime.manager.execute('settings.update',{retentionDays:180});
  await until(async()=>await field('기록 보존 기간')==='180');
  assert.equal(await evalJS('document.querySelector(".switch-label input").checked'),true,'Retention snapshot preserves unsaved notification');
  const runtimePort=new URL(runtime.url).port;
  await runtime.close();
  await until(async()=>await evalJS('document.querySelector(".connection")?.textContent!=="로컬 서비스 연결됨"'));
  runtime=await startCentralRuntime({directory:data,port:Number(runtimePort)});
  await until(async()=>await evalJS('document.querySelector(".connection")?.textContent==="로컬 서비스 연결됨"'));
  assert.equal(await evalJS('document.querySelector(".switch-label input").checked'),true,'Reconnect preserves unsaved notification');
  assert.equal(runtime.manager.snapshot().settings.notificationsEnabled,false,'Unsaved preferences were never sent on reconnect');
  assert.equal(runtime.manager.snapshot().settings.retentionDays,180);
  await select('화면 모드','light');
  assert.equal(await evalJS('document.documentElement.dataset.theme'),'light');
  await cmd('Page.reload');await visible('기록 보존');
  assert.equal(await field('화면 모드'),'light');
  assert.equal(await evalJS('document.documentElement.dataset.theme'),'light');
  await select('화면 모드','system');assert.equal(await evalJS('document.documentElement.dataset.theme'),'dark');
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
  await until(async()=>await evalJS('document.documentElement.dataset.theme')==='light');
  await select('화면 모드','dark');
  assert.equal(await evalJS('getComputedStyle(document.querySelector(".panel")).backgroundColor'),'rgb(24, 34, 53)');
  assert.equal(await evalJS('getComputedStyle(document.querySelector("select")).color'),'rgb(224, 232, 245)');
  await checkLongAttemptModal();
  await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await checkLongAttemptModal();
  assert.ok(await evalJS('document.documentElement.scrollWidth-innerWidth')<=2,'Dark settings fit narrow viewport');
  assert.deepEqual(errors,[],'Browser console/runtime errors');
  console.log('PASS persisted settings, independent edits, reconnect, theme persistence, live system changes, dark controls and modal scrolling');

} finally {
  try {if(socket){await cmd('Page.close');socket.close()}}catch{}
  child?.kill('SIGTERM');
  await runtime?.close();
  await rm(base,{recursive:true,force:true});
}
