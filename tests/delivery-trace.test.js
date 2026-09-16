import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {deliveryTraceEvent,diagnosticEvents} from '../diagnostics.js';
const source=readFileSync(new URL('../content.js',import.meta.url),'utf8');
const target={guildId:'123',channelId:'456',ownUserId:'123456789012345678'};
async function deliver(ignoreEnter=false, draft='', cooldownText='', cooldownAfterPaste=false) {
 const traces=[], nodes=[];let listener, check;
 let pasted=false;
 const countdown={textContent:cooldownText,getClientRects:()=>[1]};
 const form={querySelector:()=>null,querySelectorAll:()=>cooldownText && (!cooldownAfterPaste || pasted)?[countdown]:[]};
 const editor={innerText:draft,isConnected:true,getClientRects:()=>[1],getAttribute:()=>null,querySelector:()=>null,closest:()=>form,contains:n=>n===editor,
  focus:()=>{document.activeElement=editor;},dispatchEvent:event=>{
   if(event.type==='paste'){pasted=true;editor.innerText=event.clipboardData.text;event.defaultPrevented=true;}
   if(event.type==='keydown'&&!ignoreEnter){
    event.defaultPrevented=true;editor.innerText='';
    nodes.push({id:'message-content-'+((BigInt(Date.now())-1420070400000n)<<22n),innerText:'PRIVATE MESSAGE',closest:()=>({querySelector:()=>null,matches:()=>false,querySelectorAll:()=>[{getAttribute:()=>'/avatars/123456789012345678/a.png'}]})});check();
   }
  }};
 const selection={anchorNode:editor,focusNode:editor,rangeCount:1,isCollapsed:true,removeAllRanges(){},addRange(){}};
 const document={hidden:true,activeElement:null,hasFocus:()=>false,querySelectorAll:sel=>sel.includes('message-content-')?nodes:[editor],querySelector:()=>({}),createRange:()=>({selectNodeContents(){},collapse(){}}),addEventListener(){}};
 const ctx={document,window:{getSelection:()=>selection},location:{origin:'https://discord.com',pathname:'/channels/123/456'},
  chrome:{runtime:{id:'ext',onMessage:{addListener:fn=>listener=fn},sendMessage:async m=>{if(m.type==='DICO_TRACE'){traces.push(m);return {ok:true};}return {allowed:true};}}},
  ClipboardEvent:class{constructor(type,data){Object.assign(this,{type,defaultPrevented:false},data);}},KeyboardEvent:class{constructor(type,data){Object.assign(this,{type,defaultPrevented:false},data);}},DataTransfer:class{setData(_,text){this.text=text;}},
  MutationObserver:class{constructor(fn){check=fn;}observe(){}disconnect(){}},setTimeout:fn=>setImmediate(fn),clearTimeout:clearImmediate,setInterval:()=>1,clearInterval(){},Date};
 runInNewContext(source,ctx);
 const result=await new Promise(resolve=>listener({type:'DICO_DELIVER',target:{...target,messages:['PRIVATE MESSAGE','OTHER ANNOUNCEMENT']},delivery:{id:'attempt',text:'PRIVATE MESSAGE',startedAt:Date.now(),scheduledAt:Date.now()-500}},{id:'ext'},resolve));
 return {result,traces};
}
test('실제 content 전달 경로: 붙여넣기와 Enter 처리 여부를 문구 없이 기록한다',async()=>{
 const {result,traces}=await deliver();assert.equal(result.status,'confirmed');
 assert.deepEqual(traces.map(t=>t.stage),['received','draft-replaced','before-paste','after-paste','before-enter','observation','enter-dispatched','finished']);
 assert.equal(traces.find(t=>t.stage==='after-paste').data.textMatches,true);
 assert.equal(traces.find(t=>t.stage==='enter-dispatched').data.enterPrevented,true);
 assert.equal(JSON.stringify(traces).includes('PRIVATE MESSAGE'),false);
});
test('Enter가 무시되는 입력창을 재현하면 잔류·이벤트 미처리·새 메시지 없음이 기록된다',async()=>{
 const {result,traces}=await deliver(true);assert.equal(result.status,'draft-retained');assert.match(result.error,/문구가 남아/);
 const enter=traces.find(t=>t.stage==='enter-dispatched');assert.equal(enter.data.enterPrevented,false);assert.equal(enter.data.draftEmpty,false);
 assert.equal(traces.find(t=>t.stage==='observation').data.newMessage,false);
 assert.equal(traces.filter(t=>t.stage==='enter-dispatched').length,1,'Enter 재시도 없음');
});
test('진단 수신은 전송 ID와 탭을 검증하고 비공개 필드를 제거한다',()=>{
 const state={channels:[{target:{tabId:9},pending:{id:'attempt'}}]};
 const m={id:'attempt',stage:'before-enter',version:'0.2.12',data:{editorFocused:true,draftLength:14,text:'SECRET',token:'SECRET',url:'SECRET'}};
 assert.equal(deliveryTraceEvent(m,state,8),null);
 assert.equal(deliveryTraceEvent({...m,id:'other'},state,9),null);
 assert.equal(deliveryTraceEvent({...m,stage:'injected'},state,9),null);
 const e=deliveryTraceEvent(m,state,9);assert.equal(e.editorFocused,true);assert.equal(JSON.stringify(e).includes('SECRET'),false);
});
test('사용자 발송 확인과 자동 확인을 구분한다',()=>{
 const before={channels:[{id:'1',enabled:false,pending:{id:'attempt'},lastSentAt:null}]};
 const after={channels:[{id:'1',enabled:false,pending:null,lastSentAt:100}]};
 assert.equal(diagnosticEvents(before,after)[0].kind,'manual-confirmed');
 after.channels[0].lastSentAt=null;
 assert.equal(diagnosticEvents(before,after)[0].kind,'manual-not-sent');
});
test('전송 처리 중에는 다음 타이머 대신 입력·전송 확인 중을 표시한다',()=>{
 const ui=readFileSync(new URL('../ui.js',import.meta.url),'utf8');
 const fn=ui.slice(ui.indexOf('function renderSchedule()'),ui.indexOf('\nconst historyLabels'));
 const elements={scheduleLabel:{},scheduleDetail:{}};
 const channel={enabled:true,pending:{index:1},nextIndex:1,nextRunAt:100};
 runInNewContext(fn+'\nrenderSchedule();',{selectedChannel:()=>channel,elements,formatRemaining:()=>{throw Error('pending must not render a timer');}});
 assert.match(elements.scheduleLabel.textContent,/B 입력·전송 확인 중/);
 assert.match(elements.scheduleDetail.textContent,/전송 확인 후/);
});

test('현재 차례 공지는 재입력 없이 보내고 다른 차례 공지는 교체한다',async()=>{
 for (const draft of ['PRIVATE MESSAGE','OTHER ANNOUNCEMENT']) {
  const {result,traces}=await deliver(false,draft);
  assert.equal(result.status,'confirmed');
  assert.ok(traces.some(t=>t.stage===(draft==='PRIVATE MESSAGE'?'draft-reused':'draft-replaced')));
  assert.equal(traces.find(t=>t.stage==='after-paste').data.pastePrevented,draft!=='PRIVATE MESSAGE');
 }
});
test('공지 A/B가 아닌 개인 초안은 입력과 Enter 없이 보존한다',async()=>{
 const {result,traces}=await deliver(false,'MY PRIVATE DRAFT');
 assert.equal(result.status,'blocked');
 assert.equal(traces.some(t=>t.stage==='before-paste'||t.stage==='enter-dispatched'),false);
});

test('슬로우 모드 01:05 중에는 붙여넣기와 Enter 없이 대기로 반환한다',async()=>{
 const {result,traces}=await deliver(false,'','01:05');
 assert.equal(result.status,'deferred');assert.equal(result.retryAfterMs,65000);
 assert.equal(traces.some(t=>t.stage==='before-paste'||t.stage==='enter-dispatched'),false);
});
test('붙여넣기 후 슬로우 모드가 나타나면 Enter 없이 초안 보호 정보를 반환한다',async()=>{
 const {result,traces}=await deliver(false,'','00:08',true);
 assert.equal(result.status,'deferred');assert.equal(result.draftPrepared,true);
 assert.equal(traces.some(t=>t.stage==='enter-dispatched'),false);
 assert.equal(traces.find(t=>t.stage==='slowmode-wait').data.cooldownMs,8000);
});
test('슬로우 모드 00:00은 정상 전송하며 설정 안내 문구를 남은 시간으로 오인하지 않는다',async()=>{
 assert.equal((await deliver(false,'','00:00')).result.status,'confirmed');
 assert.equal((await deliver(false,'','Slowmode is enabled. 2 minutes')).result.status,'confirmed');
});
