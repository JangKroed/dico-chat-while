// Real local HTTP UI smoke in an isolated, disposable headless Chrome profile.
// It never connects a Discord account or sends a Discord message.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startCentralRuntime} from '../central/runtime/main.mjs';

const chrome=process.env.DICO_BROWSER_BINARY||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const base=await mkdtemp(resolve(tmpdir(),'dico-ui-browser-'));
const profile=resolve(base,'chrome'),data=resolve(base,'data');
const screenshots=resolve('dist/central-update-notice-check');
await mkdir(screenshots,{recursive:true});
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
async function fill(selector,value) {
  assert.ok(await evalJS(`(() => {const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.focus();return true})()`),`Field not found: ${selector}`);
  await cmd('Input.insertText',{text:value});
}
async function screenshot(name) {
  const {data}=await cmd('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  await writeFile(resolve(screenshots,name),Buffer.from(data,'base64'));
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
  await until(async()=>await evalJS(`document.activeElement?.closest("[data-layout-check]")!==null`));
  await evalJS(`document.querySelector("[data-layout-check] .modal").focus()`);
  await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End',windowsVirtualKeyCode:35});
  await cmd('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End',windowsVirtualKeyCode:35});
  // End 키의 스크롤 애니메이션이 끝나 닫기 버튼이 실제로 보일 때까지 기다립니다.
  await until(async()=>await evalJS('document.querySelector("[data-layout-check] .modal button")?.getBoundingClientRect().bottom<=innerHeight'));
  assert.ok(await evalJS('document.querySelector("[data-layout-check] .modal button")?.getBoundingClientRect().bottom<=innerHeight'), 'Close button must be reachable after keyboard scrolling');
  await evalJS('document.querySelector("[data-layout-check]")?.remove()');
}
try {
  runtime=await startCentralRuntime({directory:data,port:0});
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
    if(packet.method==='Log.entryAdded' && packet.params.entry.level==='error')errors.push(packet.params.entry.text+' '+(packet.params.entry.url||''));
  });
  await cmd('Page.enable');await cmd('Runtime.enable');await cmd('Log.enable');


  await cmd('Page.addScriptToEvaluateOnNewDocument',{source:`(() => {const fetch=window.fetch.bind(window),timeout=window.setTimeout.bind(window);window.setTimeout=(fn,ms,...args)=>timeout(fn,ms===300000?100:ms,...args);window.__latest={state:'available',currentVersion:'0.4.61',latestVersion:'0.4.62',checkedAt:Date.now()};window.fetch=(url,...args)=>String(url).includes('/api/updates/latest')?Promise.resolve(new Response(JSON.stringify(window.__latest),{headers:{'content-type':'application/json'}})):fetch(url,...args)})()`});
  await cmd('Page.navigate',{url:`${runtime.url}/#bootstrap=${runtime.app.issueBootstrap()}`});
  await visible('DICO 0.4.62 업데이트가 준비됐습니다.');
  await screenshot('update-available.png');
  await clickText('button','업데이트 확인');await visible('프로그램 · 확장 업데이트');
  assert.equal(await evalJS('location.pathname'),'/settings');
  await clickText('[aria-label="이 버전 업데이트 알림 닫기"]','나중에');
  await cmd('Page.reload');await visible('프로그램 · 확장 업데이트');
  assert.equal(await evalJS(`Boolean(document.querySelector('[aria-label="새 업데이트 안내"]'))`),false);
  await evalJS("window.__latest.latestVersion='0.4.63'");await visible('DICO 0.4.63 업데이트가 준비됐습니다.');
  await clickText('button','업데이트 확인');await visible('공식 배포 0.4.63');
  await evalJS("window.__latest={state:'unavailable',checkedAt:Date.now()}");
  await delay(250);assert.equal(await evalJS(`Boolean(document.querySelector('[aria-label="새 업데이트 안내"]'))`),true);
  await evalJS("window.__latest={state:'current',currentVersion:'0.4.63',latestVersion:'0.4.63',checkedAt:Date.now()}");
  await until(async()=>await evalJS(`!document.querySelector('[aria-label="새 업데이트 안내"]')`));
  await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evalJS("window.__latest={state:'available',currentVersion:'0.4.63',latestVersion:'0.4.64',checkedAt:Date.now()}");await visible('DICO 0.4.64 업데이트가 준비됐습니다.');
  assert.ok(await evalJS('document.documentElement.scrollWidth-innerWidth<=2'));
  await evalJS('window.scrollTo(0,0)');await screenshot('update-available-mobile.png');
  assert.deepEqual(errors,[]);
  console.log('PASS global update notice, settings link, persistent per-version dismissal, new version re-notification, temporary failure preservation, installed version removal, mobile layout');
} finally {
  try {if(socket){await cmd('Page.close');socket.close()}}catch{}
  if(child&&child.exitCode===null){await new Promise(resolve=>{const timer=setTimeout(resolve,3000);child.once('exit',()=>{clearTimeout(timer);resolve()});child.kill('SIGTERM');});}
  await runtime?.close();
  await rm(base,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
