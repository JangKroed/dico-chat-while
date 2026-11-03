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
  // 최초 연결 9회 실패로 재시도 한도를 소진시킨 뒤 online 이벤트만으로 복구합니다.
  // 실제 장애 대기 시간을 줄이는 주입은 이 격리 프로필에만 적용하며 복구 전에 복원합니다.
  await cmd('Page.addScriptToEvaluateOnNewDocument',{source:`if(!sessionStorage.getItem('dico-reconnect-smoke')){sessionStorage.setItem('dico-reconnect-smoke','1');window.__offline=true;window.__failures=0;window.__nativeTimeout=window.setTimeout.bind(window);window.setTimeout=(fn,ms,...args)=>window.__nativeTimeout(fn,ms>=1000&&ms<=10000?1:ms,...args);const original=window.fetch.bind(window);window.fetch=(url,...args)=>{if(window.__offline&&String(url).includes('/api/access-mode')){window.__failures++;return Promise.reject(new TypeError('simulated offline'))}return original(url,...args)}}`});
  const url=`${runtime.url}/#bootstrap=${runtime.app.issueBootstrap()}`;
  await cmd('Page.navigate',{url});
  await visible('연결을 기다리고 있습니다.');
  assert.equal(await evalJS('window.__failures'),9);
  await evalJS("window.setTimeout=window.__nativeTimeout;window.__offline=false;window.dispatchEvent(new Event('online'))");
  await visible('발송 작업을 준비하세요');
  console.log('PASS exhausted reconnect recovers on online event without a user click');
  assert.equal(await evalJS('location.hash'),'','Bootstrap fragment must be removed');
  await screenshot('desktop-empty.png');
  console.log('PASS bootstrap and empty dashboard');
  // 일반 사용자는 진단 메뉴 없이 시작합니다. 직접 URL도 같은 화면 정책을 적용합니다.
  assert.equal(await evalJS("Boolean([...document.querySelectorAll('.nav-item')].find(x=>x.textContent.includes('실행 기록')||x.textContent.includes('로그 · 분석')))"),false);
  await cmd('Page.navigate',{url:runtime.url+'/logs'});
  await visible('발송 작업을 준비하세요');
  assert.equal(await evalJS('location.pathname'),'/');
  await clickText('.nav-item','설정 · 도움말');
  await visible('개발자 진단 모드');
  assert.equal(await evalJS(`Boolean(document.querySelector('[aria-label="관리자 제보 수신 주소"]'))`),false);
  assert.equal(await evalJS(`Boolean(document.querySelector('[aria-label="문제 발생 시 자동 제보"]'))`),true);
  await evalJS(`document.querySelector('[aria-label="개발자 진단 모드"]').click()`);
  await until(async()=>await evalJS("Boolean([...document.querySelectorAll('.nav-item')].find(x=>x.textContent.includes('실행 기록')))"));
  await cmd('Page.reload');
  await visible('개발자 진단 모드');
  assert.equal(await evalJS(`document.querySelector('[aria-label="개발자 진단 모드"]').checked`),true);
  console.log('PASS default user mode, direct route guard, simple consent and persistent diagnostic opt-in');

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
  await clickText('.nav-item','설정 · 도움말');await visible('개발자 진단 모드');
  await evalJS(`document.querySelector('[aria-label="개발자 진단 모드"]').click()`);
  await cmd('Page.navigate',{url:runtime.url+'/history'});
  await visible('최근 확인된 발송');
  assert.equal(await evalJS('location.pathname'),'/');
  console.log('PASS disabling diagnostic mode protects history route after reload');
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
  // 실제 Discord·브라우저 확장 연결 없이 API 응답만 교체합니다. UI의 실제 렌더링,
  // 카운트다운과 반응형 배치를 검증하며 발송 명령은 이 단계에서 호출하지 않습니다.
  const populatedSource=`(() => {
    const original=window.fetch.bind(window);
    window.fetch=async(url,...args)=>{
      const path=new URL(String(url),location.href).pathname;
      if(sessionStorage.getItem('dico-rollback-smoke')&&path==='/api/updates/rollback'){
        window.__rollbackPosts=(window.__rollbackPosts||0)+1;window.__rollbackRequested=true;
        return new Response(JSON.stringify({phase:'preparing',mode:'rollback',message:'이전 버전 복원을 준비합니다.',rollback:{available:true,version:'0.4.34'}}),{status:200,headers:{'content-type':'application/json'}});
      }
      if(sessionStorage.getItem('dico-rollback-smoke')&&path==='/api/updates')return new Response(JSON.stringify({phase:window.__rollbackRequested?'preparing':'idle',mode:window.__rollbackRequested?'rollback':'update',message:'검사용 업데이트 상태',rollback:{available:true,version:'0.4.34'}}),{status:200,headers:{'content-type':'application/json'}});
      if(path!=='/api/snapshot')return original(url,...args);
      const now=Date.now(),channels=[],accounts=[],instances=[],groups=[],attempts=[],messages=[];
      for(let n=0;n<3;n++){
        const instanceId='fixture-browser-'+n,groupId='fixture-group-'+n;
        instances.push({id:instanceId,name:['공지 운영 Chrome 프로필','채용 운영 Brave 프로필','커뮤니티 Chrome 프로필'][n],browser:n===1?'Brave':'Chrome',connected:true,lastSeenAt:now,version:1,extensionVersion:n===1?'0.4.20':'0.4.34',legacyFrozen:true,legacyPending:false,capabilities:['early-prepare-v1']});
        const members=[];
        for(let a=0;a<2;a++){
          const accountId='100000000000'+n+a,id='fixture-channel-'+n+a,messageId='fixture-message-'+n+a;
          accounts.push({id:'fixture-account-'+n+a,instanceId,accountId,name:['운영 담당','공지 담당'][a]+' '+(n+1),verified:true,connected:true,version:1,lastVerifiedAt:now});
          channels.push({id,instanceId,accountId,guildId:'200000000000'+n,channelId:'300000000000'+n,name:['프로젝트 공지','개발자 채용 정보','커뮤니티 소식'][n],verified:true,version:1,configVersion:1,appliedVersion:1,playlist:[{messageId,revisionId:'revision-'+messageId}],playlistIndex:0,intervalMs:60000,slowmodeMs:30000,slowmodeObservedAt:now});
          messages.push({id:messageId,name:['이번 주 프로젝트 안내','백엔드 개발자 모집','정기 모임 안내'][n],body:'브라우저 배치 검사용. 실제 발송하지 않습니다.',version:1,revisionId:'revision-'+messageId,revisions:[{id:'revision-'+messageId}],tags:[]});members.push(id);
          attempts.push({id:'fixture-result-'+n+a,groupId,instanceId,accountId,bindingId:id,status:'confirmed',confirmationBasis:a?'composer_cleared':'message_observed',messageName:messages.at(-1).name,finalizedAt:now-(n*2+a+1)*60000});
        }
        groups.push({id:groupId,name:['프로젝트 공지 순환','채용 정보 순환','커뮤니티 소식 순환'][n],guildId:'200000000000'+n,channelId:'300000000000'+n,members,cursor:n%2,status:sessionStorage.getItem('dico-rollback-smoke')?'stopped':'running',version:1,intervalMs:60000,nextEligibleAt:now+(n+1)*45000,nextPreparationAt:now+(n+1)*45000-5000,waitReason:'group_interval'});
      }
      return new Response(JSON.stringify({schemaVersion:1,stateVersion:999,serverNow:now,service:{status:'ready'},settings:{retentionDays:90,notificationsEnabled:false,hideNotificationNames:false,maxSendRetries:3},messages,channels,accounts,instances,groups,attempts,incidents:[],events:[],commands:[]}),{status:200,headers:{'content-type':'application/json'}});
    };
  })()`;
  const fixtureScript=await cmd('Page.addScriptToEvaluateOnNewDocument',{source:populatedSource});
  for(const width of [1440,1000,390]){
    await cmd('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
    await cmd('Page.navigate',{url:runtime.url+'/'});
    await visible('프로젝트 공지 순환');
    await until(async()=>await evalJS('document.querySelectorAll(".op-group").length===3'));
    const dashboardLayout=await evalJS(`(() => ({overflow:document.documentElement.scrollWidth-innerWidth,rows:[...document.querySelectorAll('.op-group')].map(el=>({height:el.getBoundingClientRect().height,right:el.getBoundingClientRect().right})),stats:document.querySelectorAll('.op-stats>div').length,results:document.querySelectorAll('.op-result').length,browsers:document.querySelectorAll('.op-browser').length,bottomTop:document.querySelector('.op-bottom').getBoundingClientRect().top}))()`);
    assert.ok(dashboardLayout.overflow<=2,JSON.stringify({width,dashboardLayout}));assert.equal(dashboardLayout.stats,4);assert.equal(dashboardLayout.results,6);assert.equal(dashboardLayout.browsers,3);
    console.log('LAYOUT '+width+' '+JSON.stringify(dashboardLayout));await screenshot(`populated-dashboard-${width}.png`);
    if(width===1440){assert.ok(dashboardLayout.rows.every(row=>row.height<115),'Desktop group rows must remain compact');assert.ok(dashboardLayout.bottomTop<700,'Recent results and connections should start within the first screen');}
    await screenshot(`populated-dashboard-${width}.png`);
    await cmd('Page.navigate',{url:runtime.url+'/settings'});await visible('개발자 진단 모드');
    await until(async()=>await evalJS('document.querySelectorAll(".update-browser").length===3'));
    const settingsLayout=await evalJS(`(() => ({overflow:document.documentElement.scrollWidth-innerWidth,rows:[...document.querySelectorAll('.update-browser')].map(el=>({height:el.getBoundingClientRect().height,overflow:el.scrollWidth-el.clientWidth}))}))()`);
    assert.ok(settingsLayout.overflow<=2,JSON.stringify({width,settingsLayout}));assert.ok(settingsLayout.rows.every(row=>row.overflow<=2),JSON.stringify({width,settingsLayout}));
    await screenshot(`populated-settings-${width}.png`);
    await evalJS("document.querySelector('.update-browsers').scrollIntoView({block:'start'})");
    await screenshot(`populated-settings-browsers-${width}.png`);
    console.log('PASS populated dashboard/settings '+width+'px '+JSON.stringify({dashboardLayout,settingsLayout}));
  }
  // 롤백 버튼의 HTTP 선택과 중복 방지만 검사하며 설치 파일을 복원하지 않습니다.
  await evalJS("sessionStorage.setItem('dico-rollback-smoke','1')");
  await cmd('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await cmd('Page.navigate',{url:runtime.url+'/settings'});
  await visible('보관된 이전 버전');
  await until(async()=>await evalJS("!document.querySelector('[aria-label=\"이전 버전 복원\"] button')?.disabled"));
  await evalJS("(() => {const button=document.querySelector('[aria-label=\"이전 버전 복원\"] button');button.click();button.click()})()");
  await visible('이전 버전 복원 준비 중');
  assert.equal(await evalJS('window.__rollbackPosts'),1,'Rollback duplicate clicks must share one request');
  assert.equal(await evalJS("Boolean(sessionStorage.getItem('dico.updateReconnect'))"),true,'Rollback keeps same-tab reconnect intent');
  await screenshot('rollback-request-fixture.png');
  await evalJS("sessionStorage.removeItem('dico-rollback-smoke')");
  console.log('PASS rollback request stays in current tab and rejects duplicate click without touching installation');
  await cmd('Page.removeScriptToEvaluateOnNewDocument',{identifier:fixtureScript.identifier});
  assert.deepEqual(errors,[],'Browser console/runtime errors');
  console.log(`PASS no console errors; screenshots in ${screenshots}`);
} finally {
  try {if(socket){await cmd('Page.close');socket.close()}}catch{}
  if(child&&child.exitCode===null){await new Promise(resolve=>{const timer=setTimeout(resolve,3000);child.once('exit',()=>{clearTimeout(timer);resolve()});child.kill('SIGTERM');});}
  await runtime?.close();
  await rm(base,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
