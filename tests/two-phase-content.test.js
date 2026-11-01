import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {deliveryTraceEvent,appendDiagnostics} from '../diagnostics.js';
const source=readFileSync(new URL('../emoji-data.js',import.meta.url),'utf8')+'\n'+readFileSync(new URL('../content.js',import.meta.url),'utf8');
function rig({lag=0,fault=null,managed=false,structured=false,message='A',emojiName=null,emojiValue=null,convertAliases=false,loggedUser=null,authorizationLag=0,confirmation=false,renderMessage=text=>text,ignoreEnter=false,throwAfterEnter=false,prepareDelay=0,lateCooldown=null,attachment=false,unsupported=false}={}) {
 let commitAuthorizations=0;
 let nextDelay=0,onDelayed=null,repeatDelay=false;
 let clock=1800000000000,listener,check,allowed=true,pasteDue=null,pasteText='',cooldown='',composition;
 const nodes=[],events=[],traces=[],requests=[];let waitHook=null,authorizationHook=null;
 const form={querySelector:()=>attachment?{}:null,querySelectorAll:()=>{const current=typeof cooldown==='function'?cooldown(clock):cooldown;return current?(Array.isArray(current)?current:[current]).map(textContent=>({textContent,getClientRects:()=>[1]})):[];}};
 const selection={anchorNode:null,focusNode:null,isCollapsed:true,rangeCount:1,removeAllRanges(){},addRange(range){this.anchorNode=editor;this.focusNode=editor;this.isCollapsed=range.collapsed}};
 const editor={innerText:'',isConnected:true,getClientRects:()=>[1],getAttribute:()=>null,querySelector:()=>unsupported?{}:null,closest:()=>form,contains:n=>n===editor,focus(){document.activeElement=editor},dispatchEvent(event){
  events.push({type:event.type,at:clock,selectionCollapsed:selection.isCollapsed});
  if(event.type==='paste'){pasteText=event.clipboardData.text;pasteDue=clock+lag;event.defaultPrevented=true;if(prepareDelay)nextDelay=prepareDelay;}
  if(event.type==='keydown'){
   if(ignoreEnter)return true;
   assert.equal(editor.innerText.trim(),convertAliases?delivery.text.replaceAll(emojiName,emojiValue):delivery.text);event.defaultPrevented=true;editor.innerText='';
   nodes.push({id:'message-content-'+((BigInt(clock)-1420070400000n)<<22n),innerText:renderMessage(delivery.text),closest:()=>({querySelector:()=>null,matches:()=>false,querySelectorAll:()=>[{getAttribute:()=>'/avatars/123456789012345678/a.png'}]})});check?.();
  }
  if(event.type==='keyup'&&throwAfterEnter)throw Error('Synthetic post-Enter DOM failure');
 }};
 const document={hidden:true,activeElement:null,hasFocus:()=>false,querySelectorAll:sel=>sel.includes('message-content-')?nodes:[editor],querySelector:sel=>sel.includes('panels')?{querySelectorAll:()=>loggedUser?[{getAttribute:()=>`/avatars/${loggedUser}/a.png`}]:[]}:({}),createRange:()=>({collapsed:false,selectNodeContents(){},collapse(){this.collapsed=true}}),addEventListener(name,fn){if(name==='compositionstart')composition=fn}};
 const tick=ms=>{clock+=ms;if(pasteDue!==null&&clock>=pasteDue){editor.innerText=convertAliases?pasteText.replaceAll(emojiName,emojiValue):pasteText;pasteDue=null;selection.isCollapsed=true;
 if(fault==='text_mismatch')editor.innerText='WRONG';
 if(fault==='focus_lost')document.activeElement=null;
 if(fault==='foreign_focus')document.activeElement={};
 if(fault==='selection_not_collapsed')selection.isCollapsed=false;
 if(fault==='selection_outside')selection.anchorNode=null;
 if(fault==='composing')composition();
 if(fault==='editor_detached')editor.isConnected=false;}};
 if(structured){
  let actualText='';Object.defineProperty(editor,'innerText',{get:()=>actualText?'\n'+actualText+'\n':'',set:value=>{actualText=value;}});
  editor.querySelector=selector=>selector.includes('data-slate-void')?{}:null;
  const node=(attrs,children=[])=>({nodeType:1,tagName:'SPAN',childNodes:children,getAttribute:key=>attrs[key]??null,get textContent(){return children.map(c=>c.textContent).join('');}});
  Object.defineProperty(editor,'childNodes',{configurable:true,get(){return [node({'data-slate-node':'element'},[node({'data-slate-string':'true'},[{nodeType:3,textContent:actualText}]),node({'data-slate-void':'true'},[node({'data-slate-spacer':'true'},[node({'data-slate-zero-width':'z'},[{nodeType:3,textContent:'\ufeff'}])])])])];}});
  if(emojiName)Object.defineProperty(editor,'childNodes',{get(){
   const leaf=value=>node({'data-slate-string':'true'},[{nodeType:3,textContent:value}]);
   const image=()=>{const img=node({class:'emoji','data-type':'emoji','data-name':emojiName,alt:emojiName,src:'/assets/abc123.svg','aria-describedby':'emoji-label'});img.tagName='IMG';return node({'data-slate-void':'true','data-slate-inline':'true'},[img,node({id:'emoji-label',class:'hiddenVisually_test'},[{nodeType:3,textContent:emojiName}]),node({'data-slate-spacer':'true'},[node({'data-slate-zero-width':'z'},[{nodeType:3,textContent:'\ufeff'}])])]);};
   return actualText.split('\n').map(value=>node({'data-slate-node':'element'},value.split(emojiValue).flatMap((part,i)=>i?[image(),leaf(part)]:[leaf(part)])));
  }});
  editor.nodeType=1;editor.tagName='DIV';
 }
 const target={managed,guildId:'123',channelId:'456',ownUserId:'123456789012345678',messages:[message,'B'],expectedText:message,skipConfirmation:Boolean(emojiName)&&!confirmation};
 const delivery={id:'attempt',index:0,text:message,startedAt:clock,scheduledAt:clock+3000};
 const DateMock=class extends Date {static now(){return clock}};
 runInNewContext(source,{document,window:{getSelection:()=>selection},location:{origin:'https://discord.com',pathname:'/channels/123/456'},Date:DateMock,
 chrome:{runtime:{id:'ext',onMessage:{addListener:fn=>listener=fn},sendMessage:async m=>{if(m.type==='DICO_TRACE'){traces.push(m);return {ok:true}}requests.push({...m,at:clock});if(m.type==='DICO_CAN_SEND')authorizationHook?.(m);if(m.type==='DICO_PRE_ENTER_WAIT'){waitHook?.(m);return{allowed};}const authorizedAt=clock;if(m.phase==='commit'&&++commitAuthorizations===2){clock+=authorizationLag;if(lateCooldown!==null)cooldown=lateCooldown;}return {allowed:allowed&&(m.phase==='prepare'||clock>=delivery.scheduledAt),authorizedAt,maxAgeMs:2000}}}},
 ClipboardEvent:class{constructor(type,data){Object.assign(this,{type,defaultPrevented:false},data)}},KeyboardEvent:class{constructor(type,data){Object.assign(this,{type,defaultPrevented:false},data)}},DataTransfer:class{setData(_,text){this.text=text}},
 MutationObserver:class{constructor(fn){check=fn}observe(){}disconnect(){}},setTimeout:(fn,ms)=>setImmediate(()=>{const delay=nextDelay;if(!repeatDelay)nextDelay=0;tick(ms+delay);if(delay)onDelayed?.();fn()}),clearTimeout:clearImmediate,setInterval:()=>1,clearInterval(){},
 });
 return {delayNext:(ms,callback=null,repeat=false)=>{nextDelay=ms;onDelayed=callback;repeatDelay=repeat},editor,selection,events,traces,requests,onWait:fn=>{waitHook=fn},onAuthorization:fn=>{authorizationHook=fn},account:value=>{loggedUser=value},delivery,target,tick,compose:()=>composition(),stop:()=>{allowed=false},cooldown:value=>{cooldown=value},now:()=>clock,
 request:type=>new Promise(resolve=>{const pending=listener({type,target,delivery:{...delivery,...(type==='DICO_DELIVER'?{phase:'commit'}:{})}},{id:'ext'},resolve);if(pending===false)resolve(undefined);})};
}
test('순환 발송은 로그인 계정이 다르거나 확인할 수 없으면 입력 전 차단한다',async()=>{
 for (const loggedUser of [null,'999999999999999999']) {
  const r=rig({loggedUser});r.target.coordinated=true;
  assert.equal((await r.request('DICO_PREPARE')).status,'blocked');
  assert.equal(r.events.length,0);
 }
 const r=rig({loggedUser:'123456789012345678'});r.target.coordinated=true;
 assert.equal((await r.request('DICO_PREPARE')).status,'prepared');
});
test('새 중앙 실행기는 content에 늦게 도착한 승인으로 Enter를 실행하지 않는다',async()=>{
 const r=rig({authorizationLag:60000});r.delivery.strictAuthorization=true;
 await r.request('DICO_PREPARE');r.tick(3000);
 const result=await r.request('DICO_DELIVER');assert.equal(result.status,'blocked');assert.equal(r.events.some(e=>e.type==='keydown'),false);
});
test('늦은 문구 반영 뒤 1초 안정 확인하고 예약 시각 이후 Enter만 보낸다',async()=>{
 const r=rig({lag:700});const prepared=await r.request('DICO_PREPARE');
 assert.equal(prepared.status,'prepared');assert.equal(r.events.filter(e=>e.type==='paste').length,1);
 assert.equal(r.events.some(e=>e.type==='keydown'),false);assert.ok(r.now()>=r.delivery.startedAt+1700);
 r.tick(Math.max(0,r.delivery.scheduledAt-r.now()));const result=await r.request('DICO_DELIVER');
 assert.equal(result.status,'confirmed');assert.equal(r.events.filter(e=>e.type==='paste').length,1);
 assert.equal(r.events.filter(e=>e.type==='keydown').length,1);assert.ok(r.events.find(e=>e.type==='keydown').at>=r.delivery.scheduledAt);
});
test('예약 시각 전 Enter 요청·준비 후 변경된 초안·중지·조합 입력은 Enter를 차단한다',async()=>{
 for(const mode of ['early','changed','stopped','composing']){
  const r=rig();await r.request('DICO_PREPARE');
  if(mode!=='early')r.tick(Math.max(0,r.delivery.scheduledAt-r.now()));
  if(mode==='changed')r.editor.innerText='개인 초안';if(mode==='stopped')r.stop();if(mode==='composing')r.compose();
  assert.notEqual((await r.request('DICO_DELIVER')).status,'confirmed');
  assert.equal(r.events.some(e=>e.type==='keydown'),false);
  assert.equal(r.events.filter(e=>e.type==='paste').length,1);
 }
});
test('전송 시각에 제한이 남으면 준비된 문구를 보존하고 Enter를 미룬다',async()=>{
 const r=rig();await r.request('DICO_PREPARE');r.tick(3000);r.cooldown('00:08');r.delayNext(21630000);
 assert.equal((await r.request('DICO_DELIVER')).status,'deferred');assert.equal(r.editor.innerText,'A');
 assert.equal(r.events.some(e=>e.type==='keydown'),false);
});

 test('입력 준비 실패의 조건을 각각 재현하고 실패 로그까지 수신한다',async()=>{
  for(const fault of ['text_mismatch','focus_lost','selection_not_collapsed','selection_outside','composing','editor_detached']){
   const r=rig({fault});const result=await r.request('DICO_PREPARE');
   assert.equal(result.status,'blocked');assert.equal(r.events.some(e=>e.type==='keydown'),false);
   const failure=r.traces.find(t=>t.stage==='stability-failed');assert.ok(failure,fault);
   assert.ok(failure.data.failedChecks.includes(fault),fault);assert.ok(failure.data.failureCounts[fault]>0);
   const event=deliveryTraceEvent(failure,{channels:[{id:'channel-a',target:{tabId:7},prepared:{id:r.delivery.id}}]},7);
   let saved;const api={storage:{local:{get:async()=>({}),set:async value=>{saved=value;}}}};
   await appendDiagnostics(api,[event]);assert.ok(saved.diagnosticTimeline[0].failedChecks.includes(fault));assert.ok(saved.diagnosticTimeline[0].failureCounts[fault]>0);
   assert.ok(r.traces.some(t=>t.stage==='paste-dispatched'));if(fault==='text_mismatch')assert.equal(failure.data.textContext.actual,'WRONG');
  }
 });

test('재시작 검사에서 개인 초안을 차단한 이유를 문구와 함께 반환한다',async()=>{
 const r=rig();r.editor.innerText='A extra';
 const result=await r.request('DICO_INSPECT');assert.equal(result.code,'DRAFT_MISMATCH');
 assert.equal(result.diagnostics.draftLength,7);assert.equal(result.diagnostics.expectedLength,1);
 assert.equal(result.diagnostics.draftMatchesA,false);assert.equal(result.diagnostics.draftMatchesB,false);
 assert.equal(result.diagnostics.textContext.actual,'A extra');
});

test('전용 창에서 정확한 문구 입력 후 커서·포커스가 남아도 재입력 없이 복구한다',async()=>{
 for(const fault of ['selection_not_collapsed','selection_outside','focus_lost']){
  const r=rig({fault,managed:true});const result=await r.request('DICO_PREPARE');
  assert.equal(result.status,'prepared',fault);assert.equal(r.events.filter(e=>e.type==='paste').length,1);
  assert.equal(r.events.some(e=>e.type==='keydown'),false);assert.ok(r.traces.some(e=>e.stage==='editor-recovered'));
  r.tick(3000);assert.equal((await r.request('DICO_DELIVER')).status,'confirmed');assert.equal(r.events.filter(e=>e.type==='keydown').length,1);
 }
});
test('복구는 다른 입력칸·변경된 문구·조합 중인 입력을 건드리지 않는다',async()=>{
 for(const fault of ['foreign_focus','text_mismatch','composing']){
  const r=rig({fault,managed:true});assert.equal((await r.request('DICO_PREPARE')).status,'blocked');
  assert.equal(r.traces.some(e=>e.stage==='editor-recovered'),false);assert.equal(r.events.some(e=>e.type==='keydown'),false);
 }
});

test('실제 전송 경로에서 Slate 보조 void가 있어도 정확한 문구를 준비·전송한다',async()=>{
 const r=rig({managed:true,structured:true});assert.equal((await r.request('DICO_PREPARE')).status,'prepared');
 r.tick(3000);assert.equal((await r.request('DICO_DELIVER')).status,'confirmed');
 assert.equal(r.events.filter(e=>e.type==='paste').length,1);assert.equal(r.events.filter(e=>e.type==='keydown').length,1);
 assert.ok(r.traces.some(t=>t.data.editorReadMode==='slate'));
});

test('서식·이모지 초안을 준비/재사용한 뒤 재입력 없이 예약 시각에 Enter 한 번',async()=>{
 for(const [emojiName,emojiValue] of [[':moneybag:','💰'],[':flag_kr:','🇰🇷'],[':thumbsup::skin-tone-4:','👍🏽'],[':one:','1️⃣']]){
  for(const reuse of [false,true]){
   const message='### 제목 '+emojiValue+'\n- __한글 ABC__ **123** '+emojiValue+'\nhttps://example.com/?q=a_b';
   const r=rig({structured:true,message,emojiName,emojiValue});if(reuse)r.editor.innerText=message;
   assert.equal((await r.request('DICO_PREPARE')).status,'prepared',emojiName);
   r.tick(Math.max(0,r.delivery.scheduledAt-r.now()));assert.equal((await r.request('DICO_DELIVER')).status,'unverified',emojiName);
   assert.equal(r.events.filter(e=>e.type==='paste').length,reuse?0:1);
   assert.equal(r.events.filter(e=>e.type==='keydown').length,1);
  }
 }
});

test('로그의 shortcode 190/191자 → 실제 이모지 174/175자 불일치를 재현한다',async()=>{
 const original='### 166풀이속숍 집뿌쩔 머쉬킹 끝나고 바로 시작하세요\n- __궁수,해적,전사 공용 35~43제 명중 방어구, 무기 대여로 2탐 후 3차까지__\n- 템대여 무보증금, 스초 X , 한타임 💰**1600** | 반타임 💰**800**\n- 메용20 · 리저렉션 · 깔끔한 심파컨\n### 직업/렙 상담 DM주세요';
 for(const ending of ['', '.'])for(const reuse of [false,true]){
  const message=(original+ending).replaceAll('💰',':moneybag:');
  const r=rig({structured:true,message,emojiName:':moneybag:',emojiValue:'💰',convertAliases:true});
  assert.equal(message.length,190+ending.length);
  if(reuse)r.editor.innerText=original+ending;
  const prepared=await r.request('DICO_PREPARE');assert.equal(prepared.status,'prepared',JSON.stringify(prepared));
  r.tick(Math.max(0,r.delivery.scheduledAt-r.now()));assert.equal((await r.request('DICO_DELIVER')).status,'unverified');
  assert.equal(r.events.filter(e=>e.type==='paste').length,reuse?0:1);assert.equal(r.events.filter(e=>e.type==='keydown').length,1);
 }
});

test('A/B/A/B 각 차례에 이전 초안은 교체하고 현재 초안은 재사용한다',async()=>{
 const r=rig({structured:true,message:'A :moneybag:',emojiName:':moneybag:',emojiValue:'💰',convertAliases:true});
 r.target.messages=['A :moneybag:','B :moneybag:'];
 for(const [turn,index] of [0,1,0,1].entries()){
  Object.assign(r.delivery,{id:'cycle-'+turn,index,text:r.target.messages[index],startedAt:r.now(),scheduledAt:r.now()+3000});
  r.editor.innerText=(turn%2===0?r.target.messages[1-index]:r.target.messages[index]).replaceAll(':moneybag:','💰');
  const before=r.events.filter(e=>e.type==='paste').length;
  assert.equal((await r.request('DICO_PREPARE')).status,'prepared');
  assert.equal(r.events.filter(e=>e.type==='paste').length-before,turn%2===0?1:0);
  r.tick(Math.max(0,r.delivery.scheduledAt-r.now()));assert.equal((await r.request('DICO_DELIVER')).status,'unverified');
  assert.equal(r.events.filter(e=>e.type==='keydown').length,turn+1);
 }
});
test('shortcode 준비 후 가격이 바뀌면 Enter 없이 중단하고 변환 진단도 보존한다',async()=>{
 const r=rig({structured:true,message:'가격 :moneybag: 1600',emojiName:':moneybag:',emojiValue:'💰',convertAliases:true});
 assert.equal((await r.request('DICO_PREPARE')).status,'prepared');
 const trace=r.traces.find(t=>t.data?.emojiEquivalent===true);assert.ok(trace);assert.equal(trace.data.rawTextMatches,false);
 const event=deliveryTraceEvent(trace,{channels:[{id:'channel-a',target:{tabId:7},prepared:{id:r.delivery.id}}]},7);
 let saved;await appendDiagnostics({storage:{local:{get:async()=>({}),set:async value=>{saved=value;}}}},[event]);
 assert.equal(saved.diagnosticLog[0].emojiEquivalent,true);assert.equal(saved.diagnosticLog[0].rawTextMatches,false);
 r.editor.innerText='가격 💰 1601';r.tick(3000);
 assert.equal((await r.request('DICO_DELIVER')).status,'blocked');assert.equal(r.events.filter(e=>e.type==='keydown').length,0);
});

// Reproduce the supplied log: first checks pass, then a 100 ms callback wakes ~8 s later.
test('정상 입력 검사 사이 8초 지연 후 새 안정 구간을 확인하고 Enter는 한 번만 보낸다',async()=>{
 const r=rig();await r.request('DICO_PREPARE');r.tick(3000);r.delayNext(7900);
 const result=await r.request('DICO_DELIVER');
 assert.equal(result.status,'confirmed');
 assert.equal(r.events.filter(e=>e.type==='keydown').length,1);
 assert.ok(r.traces.some(t=>t.stage==='stability-timer-delayed'));
});
test('지연 복구 중 중지 요청이면 Enter를 보내지 않는다',async()=>{
 const r=rig();await r.request('DICO_PREPARE');r.tick(3000);r.delayNext(7900);
 const result=r.request('DICO_DELIVER');setImmediate(()=>r.stop());await result;
 assert.equal(r.events.some(e=>e.type==='keydown'),false);
});

test('지연 중 초안 변경·계속되는 검사 지연은 자동 전송으로 우회하지 않는다',async()=>{
 for(const mode of ['changed','repeated']){
  const r=rig();await r.request('DICO_PREPARE');r.tick(3000);
  r.delayNext(7900,mode==='changed'?()=>{r.editor.innerText='개인 초안'}:null,mode==='repeated');
  assert.equal((await r.request('DICO_DELIVER')).status,'blocked');
  assert.equal(r.events.some(e=>e.type==='keydown'),false);
 }
});

test('중앙 전용 창 준비 중 한 번 지연되면 새 안정 구간만 확인하고 Enter 없이 준비한다',async()=>{
 const r=rig({managed:true,prepareDelay:7900});
 const result=await r.request('DICO_PREPARE');assert.equal(result.status,'prepared');
 assert.equal(r.events.filter(e=>e.type==='paste').length,1);assert.equal(r.events.filter(e=>e.type==='keydown').length,0);
 assert.ok(r.traces.some(t=>t.stage==='stability-timer-delayed'));
 assert.equal(result.deliveryEvidence.phase,'prepare');assert.equal(result.deliveryEvidence.enterAttempted,false);
});

test('두 번째 순환의 긴 Markdown·이모지는 실제 작성자와 새 메시지 증거로 확인한다',async()=>{
 const message='### 한글 공지 :moneybag:\n- __상담 문구__ **1600** | 반타임 :moneybag:**800**\n- 추가 설명 '.repeat(5).trim();
 const render=text=>text.replaceAll(':moneybag:','💰').replace(/^### /gm,'').replace(/^- /gm,'').replaceAll('__','').replaceAll('**','');
 const r=rig({managed:true,structured:true,message,emojiName:':moneybag:',emojiValue:'💰',convertAliases:true,confirmation:true,renderMessage:render,loggedUser:'123456789012345678'});r.target.coordinated=true;
 for(let turn=0;turn<2;turn++){
  Object.assign(r.delivery,{id:'long-cycle-'+turn,startedAt:r.now(),scheduledAt:r.now()+3000});
  assert.equal((await r.request('DICO_PREPARE')).status,'prepared');r.tick(Math.max(0,r.delivery.scheduledAt-r.now()));
  const result=await r.request('DICO_DELIVER');assert.equal(result.status,'confirmed');
  assert.equal(result.deliveryEvidence.enterAttempted,true);assert.equal(result.deliveryEvidence.matchingMessage,true);
 }
 assert.equal(r.events.filter(e=>e.type==='keydown').length,2);assert.equal(r.events.filter(e=>e.type==='paste').length,2);
});

test('Enter가 무시되어 긴 초안이 남으면 증거만 반환하고 Enter를 다시 누르지 않는다',async()=>{
 const message='### 제목 💰\n- __설명__ **1600** '.repeat(8).trim();
 const r=rig({managed:true,message,ignoreEnter:true});await r.request('DICO_PREPARE');r.tick(3000);
 const result=await r.request('DICO_DELIVER');assert.equal(result.status,'draft-retained');assert.equal(result.code,'DELIVERY_DRAFT_RETAINED');
 assert.equal(result.deliveryEvidence.enterAttempted,true);assert.equal(result.deliveryEvidence.composerRetained,true);assert.equal(result.deliveryEvidence.newMessage,false);
 assert.equal(r.editor.innerText,message);assert.equal(r.events.filter(e=>e.type==='keydown').length,1);
 assert.equal((await r.request('DICO_DELIVER')).status,'uncertain');assert.equal(r.events.filter(e=>e.type==='keydown').length,1);
 assert.equal(JSON.stringify(result.deliveryEvidence).includes('1600'),false);
});

test('Enter 시도 이후 DOM 예외는 미발송으로 단정하지 않고 중복 요청도 차단한다',async()=>{
 const r=rig({managed:true,throwAfterEnter:true});await r.request('DICO_PREPARE');r.tick(3000);
 const result=await r.request('DICO_DELIVER');assert.equal(result.status,'uncertain');assert.equal(result.code,'CONTENT_EXCEPTION_AFTER_ENTER');assert.equal(result.deliveryEvidence.enterAttempted,true);
 assert.equal(r.events.filter(e=>e.type==='keydown').length,1);assert.equal((await r.request('DICO_DELIVER')).status,'uncertain');assert.equal(r.events.filter(e=>e.type==='keydown').length,1);
});

test('미리 준비된 초안 검사는 빈 입력창과 다른 문구를 준비 완료로 인정하지 않는다',async()=>{
 const r=rig({managed:true,structured:true,message:'공지 :moneybag: 1600',emojiName:':moneybag:',emojiValue:'💰',convertAliases:true});
 const empty=await r.request('DICO_INSPECT');assert.equal(empty.ok,true);assert.equal(empty.draftMatches,false);
 await r.request('DICO_PREPARE');let result=await r.request('DICO_INSPECT');assert.equal(result.ok,true);assert.equal(result.draftMatches,true);assert.equal(result.cooldownMs,0);
 r.cooldown('00:05');result=await r.request('DICO_INSPECT');assert.equal(result.draftMatches,true);assert.equal(result.cooldownMs,5000);
 r.editor.innerText='공지 💰 1601';result=await r.request('DICO_INSPECT');assert.equal(result.draftMatches,false);
 assert.equal(r.events.filter(e=>e.type==='keydown').length,0);
});

test('중앙 준비의 지연 복구도 변경된 초안이나 지나친 지연을 건너뛰지 않는다',async()=>{
 for(const fault of ['text_mismatch','composing']){
  const r=rig({managed:true,prepareDelay:7900,fault});const result=await r.request('DICO_PREPARE');
  assert.equal(result.status,'blocked');assert.equal(result.code,'PREPARE_EDITOR_UNSTABLE');assert.equal(result.deliveryEvidence.enterAttempted,false);assert.equal(r.events.filter(e=>e.type==='paste').length,1);assert.equal(r.events.filter(e=>e.type==='keydown').length,0);
 }
 const r=rig({managed:true,prepareDelay:20000});const result=await r.request('DICO_PREPARE');assert.equal(result.status,'blocked');assert.equal(r.events.filter(e=>e.type==='keydown').length,0);
});

test('보이는 실제 쿨다운을 읽지 못하면 0초로 오인하지 않고 입력과 차례를 보존한다',async()=>{
 for(const value of ['잠시 기다려 주세요','00:99',[''],['00:01','해석 불가']]){
  const r=rig({managed:true});await r.request('DICO_PREPARE');r.cooldown(value);r.tick(3000);
  const seen=await r.request('DICO_INSPECT');assert.equal(seen.ok,true);assert.equal(seen.draftMatches,true);assert.equal(seen.cooldownKnown,false);
  const result=await r.request('DICO_DELIVER');assert.equal(result.status,'deferred');assert.equal(result.code,'COOLDOWN_UNVERIFIED');assert.equal(result.deliveryEvidence.enterAttempted,false);
  assert.equal(r.editor.innerText,'A');assert.equal(r.events.filter(e=>e.type==='keydown').length,0);
 }
});

test('최종 승인 후 생긴 해석 불가 쿨다운도 Enter 직전에 차단한다',async()=>{
 const r=rig({managed:true,lateCooldown:'대기 중'});await r.request('DICO_PREPARE');r.tick(3000);
 assert.equal((await r.request('DICO_INSPECT')).cooldownKnown,true);
 const result=await r.request('DICO_DELIVER');assert.equal(result.status,'deferred');assert.equal(result.code,'COOLDOWN_UNVERIFIED');assert.equal(r.events.filter(e=>e.type==='keydown').length,0);
});

test('known live cooldown keeps the same commit pending and sends once only after a fresh authorization',async()=>{
 const r=rig({managed:true});r.delivery.strictAuthorization=true;await r.request('DICO_PREPARE');r.tick(3000);
 const unlock=r.now()+8000;r.cooldown(now=>now<unlock?'00:'+String(Math.ceil((unlock-now)/1000)).padStart(2,'0'):'');
 const result=await r.request('DICO_DELIVER');assert.equal(result.status,'confirmed');
 assert.equal(r.events.filter(e=>e.type==='paste').length,1);assert.equal(r.events.filter(e=>e.type==='keydown').length,1);assert.ok(r.events.find(e=>e.type==='keydown').at>=unlock);
 const waits=r.requests.filter(m=>m.type==='DICO_PRE_ENTER_WAIT');assert.ok(waits.length>0);assert.ok(waits.every(m=>m.id===r.delivery.id&&m.cooldownMs>=0&&m.maxWaitMs===21630000));
 const finalAuth=r.requests.filter(m=>m.type==='DICO_CAN_SEND'&&m.phase==='commit').at(-1);assert.ok(finalAuth.at>=unlock);assert.equal(waits.at(-1).cooldownMs,0);assert.ok(waits.at(-1).at<=finalAuth.at);
});
test('cooldown appearing during final authorization is waited out without replacing the attempt or repeating Enter',async()=>{
 let unlock;const r=rig({managed:true,lateCooldown:now=>{unlock??=now+3000;return now<unlock?'00:03':'';}});
 await r.request('DICO_PREPARE');r.tick(3000);assert.equal((await r.request('DICO_DELIVER')).status,'confirmed');
 assert.ok(r.requests.filter(m=>m.type==='DICO_CAN_SEND'&&m.phase==='commit').length>=3);assert.equal(r.events.filter(e=>e.type==='keydown').length,1);assert.ok(r.events.find(e=>e.type==='keydown').at>=unlock);
});
test('stop, edited draft, changed account, and unreadable countdown interrupt a pending pre-Enter wait',async()=>{
 for(const mode of ['stop','draft','account','unknown']){
  const r=rig({managed:true,loggedUser:'123456789012345678'});r.target.coordinated=true;await r.request('DICO_PREPARE');r.tick(3000);r.cooldown('00:10');
  let polls=0;r.onWait(()=>{if(++polls===2){if(mode==='stop')r.stop();if(mode==='draft')r.editor.innerText='personal draft';if(mode==='account')r.account('999999999999999999');if(mode==='unknown')r.cooldown('대기 중');}});
  const result=await r.request('DICO_DELIVER');assert.notEqual(result.status,'confirmed',mode);assert.equal(result.deliveryEvidence.enterAttempted,false,mode);assert.equal(r.events.filter(e=>e.type==='keydown').length,0,mode);assert.equal(r.events.filter(e=>e.type==='paste').length,1,mode);
  if(mode==='unknown')assert.equal(result.code,'COOLDOWN_UNVERIFIED');if(mode==='stop')assert.equal(result.code,'PRE_ENTER_WAIT_CANCELLED');
 }
});
test('a stuck countdown times out without Enter and never consumes the content duplicate-send latch',async()=>{
 const r=rig({managed:true});await r.request('DICO_PREPARE');r.tick(3000);r.cooldown('00:10');r.delayNext(21630000);const began=r.now();
 const result=await r.request('DICO_DELIVER');assert.equal(result.status,'deferred');assert.equal(result.code,'COOLDOWN_WAIT_TIMEOUT');assert.equal(result.deliveryEvidence.enterAttempted,false);assert.ok(r.now()-began>=21630000);assert.equal(r.events.filter(e=>e.type==='keydown').length,0);assert.equal(r.editor.innerText,'A');
 r.cooldown('');assert.equal((await r.request('DICO_DELIVER')).status,'confirmed');assert.equal(r.events.filter(e=>e.type==='keydown').length,1);
});
test('stale authorization after countdown waiting still blocks the only Enter',async()=>{
 const r=rig({managed:true,authorizationLag:60000});r.delivery.strictAuthorization=true;await r.request('DICO_PREPARE');r.tick(3000);const unlock=r.now()+2000;r.cooldown(now=>now<unlock?'00:02':'');
 const result=await r.request('DICO_DELIVER');assert.equal(result.status,'blocked');assert.equal(r.events.filter(e=>e.type==='keydown').length,0);
});

test('a valid long cooldown stays in the same attempt beyond two minutes',async()=>{
 const r=rig({managed:true});await r.request('DICO_PREPARE');r.tick(3000);const unlock=r.now()+600000;
 r.cooldown(now=>now<unlock?'10:00':'');let polls=0;r.onWait(()=>{if(++polls===2)r.tick(590000);});
 const result=await r.request('DICO_DELIVER');assert.equal(result.status,'confirmed');assert.equal(r.events.filter(e=>e.type==='keydown').length,1);
 assert.ok(r.requests.some(m=>m.type==='DICO_PRE_ENTER_WAIT'&&m.elapsedMs>120000&&m.cooldownMs>0));assert.ok(r.events.find(e=>e.type==='keydown').at>=unlock);
});
test('cancellation when the countdown clears prevents final authorization and Enter',async()=>{
 const r=rig({managed:true});await r.request('DICO_PREPARE');r.tick(3000);const unlock=r.now()+1000;r.cooldown(now=>now<unlock?'00:01':'');r.onWait(m=>{if(m.cooldownMs===0)r.stop();});
 const result=await r.request('DICO_DELIVER');assert.equal(result.status,'blocked');assert.equal(result.code,'PRE_ENTER_WAIT_CANCELLED');assert.equal(r.events.filter(e=>e.type==='keydown').length,0);
});
test('sleep beyond the wait bound cannot turn an expired attempt into a fresh Enter when the countdown disappears',async()=>{
 const r=rig({managed:true});await r.request('DICO_PREPARE');r.tick(3000);const unlock=r.now()+1000;r.cooldown(now=>now<unlock?'00:01':'');r.delayNext(21630000);
 const result=await r.request('DICO_DELIVER');assert.equal(result.status,'deferred');assert.equal(result.code,'COOLDOWN_WAIT_TIMEOUT');assert.equal(result.deliveryEvidence.enterAttempted,false);assert.equal(r.events.filter(e=>e.type==='keydown').length,0);
});

test('managed draft inspection reads foreign text without mutating it and verifies the actual account',async()=>{
 const r=rig({managed:true,loggedUser:'123456789012345678'});r.target.coordinated=true;r.editor.innerText='personal draft';
 const seen=await r.request('DICO_DRAFT_INSPECT');assert.equal(seen.ok,true);assert.equal(seen.draftText,'personal draft');assert.equal(seen.draftMatches,false);assert.equal(seen.unsupported,false);assert.equal(seen.attachmentOrReply,false);assert.equal(r.events.length,0);
 r.account('999999999999999999');assert.equal((await r.request('DICO_DRAFT_INSPECT')).code,'ACCOUNT_UNVERIFIED');assert.equal(r.editor.innerText,'personal draft');
});
test('an exact backed-up managed draft can be replaced once while the planned draft is reused without paste',async()=>{
 for(const prior of ['personal draft','A']){
  const r=rig({managed:true,loggedUser:'123456789012345678'});r.target.coordinated=true;r.editor.innerText=prior;
  if(prior!=='A')r.delivery.replaceExpectedDraft=prior;
  assert.equal((await r.request('DICO_PREPARE')).status,'prepared');assert.equal(r.editor.innerText,'A');assert.equal(r.events.filter(e=>e.type==='paste').length,prior==='A'?0:1);assert.equal(r.events.filter(e=>e.type==='keydown').length,0);
 }
});
test('draft replacement compare-and-swap is rechecked after every authorization and focus wait',async()=>{
 for(const boundary of ['initial','first authorization','focus wait','last authorization']){
  const r=rig({managed:true,loggedUser:'123456789012345678'});r.target.coordinated=true;r.editor.innerText='backed-up draft';r.delivery.replaceExpectedDraft='backed-up draft';
  let calls=0;r.onAuthorization(()=>{calls++;if(boundary==='first authorization'&&calls===1||boundary==='last authorization'&&calls===2)r.editor.innerText='new personal draft';});
  if(boundary==='initial')r.editor.innerText='new personal draft';
  if(boundary==='focus wait')r.delayNext(1,()=>{r.editor.innerText='new personal draft';});
  const result=await r.request('DICO_PREPARE');assert.equal(result.status,'blocked',boundary);assert.equal(result.code,'DRAFT_MISMATCH',boundary);assert.equal(r.editor.innerText,'new personal draft');assert.equal(r.events.filter(e=>e.type==='paste').length,0,boundary);
 }
});
test('replacement never overrides attachments, unsupported content, or a personal unmanaged target',async()=>{
 for(const options of [{attachment:true},{unsupported:true},{managed:false},{coordinated:false}]){
  const r=rig({managed:true,loggedUser:'123456789012345678',...options});r.target.coordinated=options.coordinated!==false;r.editor.innerText='personal draft';r.delivery.replaceExpectedDraft='personal draft';
  if(options.attachment||options.unsupported){const seen=await r.request('DICO_DRAFT_INSPECT');assert.equal(seen.ok,true);assert.equal(seen.attachmentOrReply,Boolean(options.attachment));assert.equal(seen.unsupported,Boolean(options.unsupported));}
  const result=await r.request('DICO_PREPARE');assert.equal(result.status,'blocked');assert.equal(r.editor.innerText,'personal draft');assert.equal(r.events.filter(e=>e.type==='paste').length,0);
 }
});

test('an unchanged backed-up draft is fully selected again if the cursor moved during authorization',async()=>{
 const r=rig({managed:true,loggedUser:'123456789012345678'});r.target.coordinated=true;r.editor.innerText='backed-up draft';r.delivery.replaceExpectedDraft='backed-up draft';
 let calls=0;r.onAuthorization(()=>{if(++calls===2)r.selection.isCollapsed=true;});
 assert.equal((await r.request('DICO_PREPARE')).status,'prepared');assert.equal(r.events.find(e=>e.type==='paste').selectionCollapsed,false);assert.equal(r.editor.innerText,'A');
});
