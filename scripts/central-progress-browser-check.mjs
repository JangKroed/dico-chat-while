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
const screenshots=resolve('dist/central-progress-check');
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

  await cmd('Page.navigate',{url:`${runtime.url}/#bootstrap=${runtime.app.issueBootstrap()}`});
  await visible('발송 작업을 준비하세요');
  await clickText('.nav-item','메시지 보관함');await clickText('button','새 메시지');
  await fill('input[placeholder="예: 주말 모집 공지"]','진행 표시 검사');
  await fill('textarea[placeholder="Discord에 보낼 내용을 입력하세요"]','실제로 발송하지 않는 검사');
  await evalJS(`(() => {const original=window.fetch.bind(window);window.__originalFetch=original;window.__savePosts=0;window.fetch=async(...args)=>{let body;try{body=JSON.parse(args[1]?.body||'{}')}catch{}if(body?.action==='message.create'){window.__savePosts++;const response=await original(...args);await new Promise(resolve=>window.__releaseSave=resolve);return response;}if(window.__holdSnapshot&&String(args[0]).includes('/api/snapshot'))await new Promise(resolve=>window.__releaseSnapshot=resolve);return original(...args);}})()`);
  await clickText('button','보관함에 저장');
  await visible('메시지 추가 · 요청 처리 중');
  await clickText('button','보관함에 저장');
  assert.equal(await evalJS('window.__savePosts'),1);
  assert.equal(await evalJS(`document.querySelector('[aria-label="전체 중지"]').disabled`),false);
  await evalJS('window.scrollTo(0,document.body.scrollHeight)');
  assert.ok(await evalJS("document.querySelector('.work-feedback').getBoundingClientRect().top>=document.querySelector('.topbar').getBoundingClientRect().bottom"),'Progress remains visible below sticky header');
  await screenshot('pending-save-desktop.png');
  await clickText('[aria-label="전체 중지"]','전체 중지');
  await until(()=>runtime.manager.snapshot().events.some(event=>event.type==='service.stopped'));
  await visible('메시지 추가 · 요청 처리 중');
  await evalJS('window.__holdSnapshot=true;window.__releaseSave()');
  await visible('접수 완료 · 화면 갱신 중');
  await until(async()=>await evalJS('Boolean(window.__releaseSnapshot)'));
  await evalJS('window.__holdSnapshot=false;window.__releaseSnapshot();window.fetch=window.__originalFetch');
  await until(async()=>await evalJS("!document.querySelector('.work-feedback')"));
  assert.equal(runtime.manager.snapshot().messages.length,1);
  console.log('PASS pending spinner, duplicate prevention, concurrent stop, accepted/refreshing and cleanup');
  // 운영 계정에 연결하지 않고 영상과 같은 채널 상태만 주입합니다.
  const source=`(() => {const original=window.fetch.bind(window);window.fetch=async(url,...args)=>{if(!String(url).includes('/api/snapshot'))return original(url,...args);const now=Date.now();const accounts=['완료 계정','확인 중 계정','오류 계정','응답 대기 계정'].map((name,n)=>({id:'a'+n,instanceId:'i'+n,accountId:'123'+n,name,verified:n===0||n===3,version:1}));const instances=accounts.map((a,n)=>({id:a.instanceId,name:'브라우저 '+n,connected:n!==3,lastSeenAt:now,capabilities:['managed-window-v1'],legacyFrozen:true,legacyPending:false}));const channels=accounts.map((a,n)=>({id:'c'+n,instanceId:a.instanceId,accountId:a.accountId,guildId:'1',channelId:'2',name:'테스트 채널',verified:n===0,verificationReason:[null,'tab_loading','account_mismatch','connection_lost'][n],tabId:n+1,version:1,configVersion:0,appliedVersion:0,playlist:[],intervalMs:3000,slowmodeMs:0}));return new Response(JSON.stringify({schemaVersion:1,stateVersion:1,serverNow:now,instances,accounts,channels,targets:[{id:'t',guildId:'1',channelId:'2',name:'테스트 채널',version:1}],messages:[],groups:[],attempts:[],incidents:[],events:[],commands:[],settings:{}}),{headers:{'content-type':'application/json'}})}})()`;
  await cmd('Page.addScriptToEvaluateOnNewDocument',{source});
  for(const width of [1440,390]){
    await cmd('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
    await cmd('Page.navigate',{url:runtime.url+'/channels'});
    await visible('추가 연결 가능 0개');await visible('연결 완료');await visible('로그인 계정 다름');await visible('브라우저 응답 대기');
    assert.ok(await evalJS('document.documentElement.scrollWidth-innerWidth<=2'));
    await evalJS(`document.querySelector('.target-account-picker').scrollIntoView({block:'start'})`);
    await screenshot('channel-states-'+width+'.png');
    const states=await evalJS(`Array.from(document.querySelectorAll('.account-connection-state'),el=>({text:el.innerText,spinner:!!el.querySelector('.work-spinner')}))`);
    assert.equal(states[0].spinner,false);assert.equal(states[1].spinner,true);assert.equal(states[2].spinner,false);assert.equal(states[3].spinner,true);
    console.log('PASS distinct channel wait/success/error states and layout '+width);
  }
  assert.deepEqual(errors,[]);
  console.log('PASS no browser runtime errors; no Discord messages sent');
} finally {
  try {if(socket){await cmd('Page.close');socket.close()}}catch{}
  if(child&&child.exitCode===null){await new Promise(resolve=>{const timer=setTimeout(resolve,3000);child.once('exit',()=>{clearTimeout(timer);resolve()});child.kill('SIGTERM');});}
  await runtime?.close();
  await rm(base,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
