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
const screenshots=resolve('dist/central-ui-check');
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
  const url=`${runtime.url}/#bootstrap=${runtime.app.issueBootstrap()}`;
  await cmd('Page.navigate',{url});
  await visible('첫 발송을 준비해 볼까요?');
  assert.equal(await evalJS('location.hash'),'','Bootstrap fragment must be removed');
  await screenshot('desktop-empty.png');
  console.log('PASS bootstrap and empty dashboard');

  await clickText('.nav-item','메시지 보관함');await visible('메시지 보관함');
  await clickText('button','새 메시지');
  await fill('input[placeholder="예: 주말 모집 공지"]','UI 검사 메시지');
  await fill('textarea[placeholder="Discord에 보낼 내용을 입력하세요"]','실제 전송하지 않는 검사 문구');
  // 저장 응답을 지연시켜도 사용자가 전체 중지를 즉시 요청할 수 있어야 합니다.
  // 실제 Discord 연결 없이 이 런타임의 저장/중단 HTTP 흐름만 검증합니다.
  await evalJS(`(() => {const original=window.fetch.bind(window);window.__originalFetch=original;window.fetch=async(...args)=>{const response=await original(...args);let body;try{body=JSON.parse(args[1]?.body||'{}')}catch{}if(body?.action==='message.create')await new Promise(resolve=>window.__releaseSave=resolve);return response;};window.__originalConfirm=window.confirm;window.confirm=()=>{throw Error('중단 확인창이 열리면 안 됩니다.')}})()`);
  await clickText('button','보관함에 저장');
  await until(()=>runtime.manager.snapshot().messages.length===1);
  assert.equal(await evalJS(`document.querySelector('[aria-label="전체 중지"]').disabled`),false);
  await clickText('[aria-label="전체 중지"]','전체 중지');
  await until(()=>runtime.manager.snapshot().events.some(event=>event.type==='service.stopped'));
  await until(async()=>await evalJS('Boolean(window.__releaseSave)'));
  await evalJS('window.__releaseSave();window.fetch=window.__originalFetch;window.confirm=window.__originalConfirm');
  await visible('전체 중지를 요청했습니다.');
  console.log('PASS stop remains available during pending save without confirmation dialog');
  assert.equal(runtime.manager.snapshot().messages[0].body,'실제 전송하지 않는 검사 문구');
  console.log('PASS message create through browser UI');
  await clickText('.message-item','UI 검사 메시지');
  await evalJS(`document.querySelector('textarea').focus()`);
  await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:4});
  await cmd('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA'});
  await cmd('Input.insertText',{text:'수정한 검사 문구'});
  await clickText('button','수정본 저장');
  await until(()=>runtime.manager.snapshot().messages[0].revisions.length===2);
  console.log('PASS message revision save through browser UI');
  await screenshot('desktop-messages.png');

  for(const [nav,heading] of [['계정 · 브라우저','계정 · 브라우저'],['채널 설정','채널 설정'],['발송 그룹','발송 그룹'],['실행 기록','실행 기록'],['로그 · 분석','로그 · 분석'],['설정 · 도움말','설정 · 도움말'],['대시보드','대시보드']]) {
    await clickText('.nav-item',nav);await until(async()=>await evalJS(`document.querySelector('main h1')?.textContent===${JSON.stringify(heading)}`));
    console.log(`PASS route ${heading}`);
  }
  await checkLongAttemptModal();console.log('PASS desktop long attempt modal scroll');
  await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await until(async()=>await evalJS('innerWidth===390'));
  await checkLongAttemptModal();console.log('PASS narrow long attempt modal scroll');
  const overflow=await evalJS('document.documentElement.scrollWidth-innerWidth');
  assert.ok(overflow<=2,`Narrow dashboard horizontal overflow: ${overflow}px`);
  await screenshot('narrow-dashboard.png');
  await clickText('.mobile-menu','☰');
  await until(async()=>await evalJS('document.querySelector(".sidebar")?.classList.contains("open")'));
  await screenshot('narrow-menu.png');
  console.log('PASS narrow layout and menu');
  assert.deepEqual(errors,[],'Browser console/runtime errors');
  console.log(`PASS no console errors; screenshots in ${screenshots}`);
} finally {
  try {if(socket){await cmd('Page.close');socket.close()}}catch{}
  if(child&&child.exitCode===null){await new Promise(resolve=>{const timer=setTimeout(resolve,3000);child.once('exit',()=>{clearTimeout(timer);resolve()});child.kill('SIGTERM');});}
  await runtime?.close();
  await rm(base,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
