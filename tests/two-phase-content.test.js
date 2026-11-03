import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {deliveryTraceEvent,appendDiagnostics} from '../diagnostics.js';
import {createCentralManager} from '../central/core/index.js';
import {createCentralExecutor} from '../central/extension/executor.js';
const source=readFileSync(new URL('../emoji-data.js',import.meta.url),'utf8')+'\n'+readFileSync(new URL('../content.js',import.meta.url),'utf8');
function rig({guildId='123',channelId='456',lag=0,fault=null,managed=false,structured=false,message='A',maxSendRetries=5,emojiName=null,emojiValue=null,convertAliases=false,loggedUser=null,defaultAvatar=false,authorizationLag=0,confirmation=false,noPostedMessage=false,renderMessage=text=>text,ignoreEnter=false,ignoreFirstEnters=0,throwAfterEnter=false,prepareDelay=0,pageTimerDelay=0,workerDelayFails=false,lateCooldown=null,attachment=false,unsupported=false}={}) {
 let commitAuthorizations=0;
 let nextDelay=0,onDelayed=null,repeatDelay=false;
 let clock=1800000000000,listener,check,allowed=true,pasteDue=null,pasteText='',cooldown='',composition;
 const nodes=[],events=[],traces=[],requests=[];let waitHook=null,authorizationHook=null,retryHook=null,runtimeHook=null,tickHook=null,submitHook=null;let editorPresent=true,replacementEditor=null;
 const form={isConnected:true,querySelector:()=>attachment?{}:null,querySelectorAll:()=>{const current=typeof cooldown==='function'?cooldown(clock):cooldown;return current?(Array.isArray(current)?current:[current]).map(textContent=>({textContent,getClientRects:()=>[1]})):[];}};
 const selection={anchorNode:null,focusNode:null,isCollapsed:true,rangeCount:1,removeAllRanges(){},addRange(range){this.anchorNode=range.editor||editor;this.focusNode=range.editor||editor;this.isCollapsed=range.collapsed}};
 const editor={innerText:'',isConnected:true,getClientRects:()=>[1],getAttribute:()=>null,querySelector:()=>unsupported?{}:null,closest:()=>form,contains(n){return n===this;},focus(){document.activeElement=this},dispatchEvent(event){
  events.push({type:event.type,at:clock,selectionCollapsed:selection.isCollapsed});
  if(event.type==='paste'){pasteText=event.clipboardData.text;pasteDue=clock+lag;event.defaultPrevented=true;if(prepareDelay)nextDelay=prepareDelay;}
  if(event.type==='keydown'){
   if(ignoreEnter||events.filter(e=>e.type==='keydown').length<=ignoreFirstEnters)return true;
   assert.equal(this.innerText.trim(),convertAliases?delivery.text.replaceAll(emojiName,emojiValue):delivery.text);event.defaultPrevented=true;this.innerText='';
   submitHook?.();if(!noPostedMessage)nodes.push({id:'message-content-'+((BigInt(clock)-1420070400000n)<<22n),innerText:renderMessage(delivery.text),closest:()=>({querySelector:()=>null,matches:()=>false,querySelectorAll:()=>[{getAttribute:()=>'/avatars/123456789012345678/a.png'}]})});check?.();
  }
  if(event.type==='keyup'&&throwAfterEnter)throw Error('Synthetic post-Enter DOM failure');
 }};
 let panelUsername='hoya',panelDisplayName='호야';
 const nameNode={get textContent(){return panelUsername;},childElementCount:0,getAttribute:()=>null};
 const ownRoot={getAttribute:()=>null,querySelector:selector=>selector.includes('panelTitleContainer')?{get textContent(){return panelDisplayName;}}:selector.includes('panelSubtextContainer')?{querySelectorAll:()=>panelUsername?[nameNode]:[]}:null,querySelectorAll:selector=>selector==='img'?[{getAttribute:()=>'/embed/avatars/0.png'}]:selector.includes('username')&&panelUsername?[nameNode]:[]};
 const ownPanel={querySelector:()=>ownRoot};
 const identity=()=>({verified:Boolean(loggedUser),accountId:loggedUser,guildId,channelId,username:'hoya',accountName:'호야',identitySource:'own-panel-current-user'});
 const document={hidden:true,activeElement:null,hasFocus:()=>false,querySelectorAll:sel=>sel.includes('message-content-')?nodes:editorPresent?[replacementEditor||editor]:[],querySelector:sel=>sel.includes('panels')?defaultAvatar?ownPanel:{querySelectorAll:()=>loggedUser?[{getAttribute:()=>`/avatars/${loggedUser}/a.png`}]:[]}:({}),createRange:()=>({collapsed:false,selectNodeContents(editor){this.editor=editor;},collapse(){this.collapsed=true}}),addEventListener(name,fn){if(name==='compositionstart')composition=fn}};
 const tick=ms=>{if(tickHook){let remaining=ms;while(remaining>0){const step=Math.min(500,remaining);clock+=step;remaining-=step;tickHook();}}else clock+=ms;if(pasteDue!==null&&clock>=pasteDue){editor.innerText=convertAliases?pasteText.replaceAll(emojiName,emojiValue):pasteText;pasteDue=null;selection.isCollapsed=true;
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
 const target={managed,guildId,channelId,ownUserId:'123456789012345678',messages:[message,'B'],expectedText:message,skipConfirmation:Boolean(emojiName)&&!confirmation};
 const delivery={id:'attempt',index:0,text:message,maxSendRetries,startedAt:clock,scheduledAt:clock+3000};
 const DateMock=class extends Date {static now(){return clock}};
 const pageLocation={origin:'https://discord.com',pathname:`/channels/${guildId}/${channelId}`};
 runInNewContext(source,{document,window:{getSelection:()=>selection},location:pageLocation,Date:DateMock,
 chrome:{runtime:{id:'ext',onMessage:{addListener:fn=>listener=fn},sendMessage:async m=>{if(m.type==='DICO_TRACE'){traces.push(m);return {ok:true}}requests.push({...m,at:clock});if(m.type==='DICO_DELAY'&&workerDelayFails)return{ok:false};if(m.type==='DICO_DELAY')return new Promise(resolve=>setImmediate(()=>{const delay=nextDelay;if(!repeatDelay)nextDelay=0;tick(m.durationMs+delay);if(delay)onDelayed?.();resolve({ok:true});}));if(m.type==='DICO_CAN_SEND')authorizationHook?.(m);if(m.type==='DICO_PRE_ENTER_WAIT')waitHook?.(m);if(m.type==='DICO_RETRY_WAIT')retryHook?.(m);if(runtimeHook)return runtimeHook(m);if(m.type==='DICO_ACCOUNT_IDENTITY')return identity();if(['DICO_PRE_ENTER_WAIT','DICO_RETRY_WAIT'].includes(m.type))return{allowed};const authorizedAt=clock;if(m.phase==='commit'&&++commitAuthorizations===2){clock+=authorizationLag;if(lateCooldown!==null)cooldown=lateCooldown;}return {allowed:allowed&&(m.phase==='prepare'||clock>=delivery.scheduledAt),authorizedAt,maxAgeMs:2000,...(defaultAvatar?{identity:identity()}:{})}}}},
 ClipboardEvent:class{constructor(type,data){Object.assign(this,{type,defaultPrevented:false},data)}},KeyboardEvent:class{constructor(type,data){Object.assign(this,{type,defaultPrevented:false},data)}},DataTransfer:class{setData(_,text){this.text=text}},
 MutationObserver:class{constructor(fn){check=fn}observe(){}disconnect(){}},setTimeout:(fn,ms)=>setImmediate(()=>{const delay=nextDelay;if(!repeatDelay)nextDelay=0;tick(ms+delay+pageTimerDelay);if(delay)onDelayed?.();fn()}),clearTimeout:clearImmediate,setInterval:()=>1,clearInterval(){},
 });
 return {onSubmit:fn=>{submitHook=fn},navigate:path=>{pageLocation.pathname=path},removeEditor:()=>{editorPresent=false;editor.isConnected=false;},replaceEditor:({text='',sameForm=true}={})=>{if(replacementEditor)replacementEditor.isConnected=false;replacementEditor={...editor,innerText:text,isConnected:true,closest:()=>sameForm?form:{...form}};editor.isConnected=false;return replacementEditor;},profile:({username=panelUsername,displayName=panelDisplayName}={})=>{panelUsername=username;panelDisplayName=displayName;},onRuntime:fn=>{runtimeHook=fn},onTick:fn=>{tickHook=fn},requestMessage:message=>new Promise(resolve=>{if(listener(message,{id:'ext'},resolve)===false)resolve(undefined);}),delayNext:(ms,callback=null,repeat=false)=>{nextDelay=ms;onDelayed=callback;repeatDelay=repeat},editor,selection,events,traces,requests,onRetry:fn=>{retryHook=fn},post:({text=message,author='123456789012345678',sending=false,failed=false,clear=false}={})=>{if(clear)editor.innerText='';nodes.push({id:'message-content-'+((BigInt(clock)-1420070400000n)<<22n),innerText:text,closest:()=>({querySelector:sel=>(sending&&sel.includes('isSending')||failed&&sel.includes('isFailed'))?{}:null,matches:()=>false,querySelectorAll:()=>author?[{getAttribute:()=>`/avatars/${author}/a.png`}]:[]})});check?.();},onWait:fn=>{waitHook=fn},onAuthorization:fn=>{authorizationHook=fn},account:value=>{loggedUser=value},delivery,target,tick,compose:()=>composition(),stop:()=>{allowed=false},cooldown:value=>{cooldown=value},now:()=>clock,
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

test('재시도 0회 설정이면 남은 초안의 증거만 반환하고 중복 요청을 차단한다',async()=>{
 const message='### 제목 💰\n- __설명__ **1600** '.repeat(8).trim();
 const r=rig({managed:true,message,ignoreEnter:true});r.delivery.maxSendRetries=0;await r.request('DICO_PREPARE');r.tick(3000);
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


test('무시된 첫 Enter만 재시도하고 실제 성공 뒤에는 Enter를 추가하지 않는다',async()=>{
 for(const ignored of [0,1,3]){
  const r=rig({ignoreFirstEnters:ignored});r.delivery.maxSendRetries=5;r.delivery.strictAuthorization=true;
  await r.request('DICO_PREPARE');r.tick(3000);
  const result=await r.request('DICO_DELIVER');assert.equal(result.status,'confirmed');
  assert.equal(r.events.filter(e=>e.type==='keydown').length,ignored+1);
  assert.equal(result.deliveryEvidence.retryCount,ignored);assert.equal(result.deliveryEvidence.maxSendRetries,5);
  assert.equal(r.events.filter(e=>e.type==='paste').length,1);
  assert.equal(r.requests.filter(m=>m.type==='DICO_RETRY_WAIT').length,ignored);
  assert.equal((await r.request('DICO_DELIVER')).status,'uncertain');
  assert.equal(r.events.filter(e=>e.type==='keydown').length,ignored+1);
 }
});
test('명시한 재시도 횟수를 지키며 5회보다 큰 설정도 자르지 않는다',async()=>{
 for(const maximum of [0,2,5,8]){
  const r=rig({ignoreEnter:true});if(maximum!==undefined)r.delivery.maxSendRetries=maximum;
  await r.request('DICO_PREPARE');r.tick(3000);const result=await r.request('DICO_DELIVER');
  const expected=maximum;
  assert.equal(result.status,'draft-retained');assert.equal(r.events.filter(e=>e.type==='keydown').length,expected+1);
  assert.equal(result.deliveryEvidence.retryCount,expected);assert.equal(result.deliveryEvidence.maxSendRetries,expected);
 }
});
test('재시도 중지와 초안·계정 변경은 이전 Enter를 미발송으로 단정하지 않는다',async()=>{
 for(const change of ['stop','draft','account','composition','detach']){
  const r=rig({ignoreEnter:true,loggedUser:'123456789012345678'});r.target.coordinated=true;
  await r.request('DICO_PREPARE');r.tick(3000);
  r.onRetry(()=>{if(change==='stop')r.stop();if(change==='draft')r.editor.innerText='다른 초안';if(change==='account')r.account('999999999999999999');if(change==='composition')r.compose();if(change==='detach')r.editor.isConnected=false;});
  const result=await r.request('DICO_DELIVER');assert.equal(result.status,'uncertain',change);
  assert.equal(result.deliveryEvidence.enterAttempted,true);assert.equal(r.events.filter(e=>e.type==='keydown').length,1,change);
 }
});
test('재시도 전에 새 게시·전송 중·실패·작성자 불명 증거가 생기면 추가 Enter를 막는다',async()=>{
 for(const post of [{text:'other'},{sending:true},{failed:true},{author:null},{author:'999999999999999999'},{}]){
  const r=rig({ignoreEnter:true});await r.request('DICO_PREPARE');r.tick(3000);
  r.onRetry(()=>r.post(post));const result=await r.request('DICO_DELIVER');
  assert.equal(result.status,'uncertain');assert.equal(r.events.filter(e=>e.type==='keydown').length,1);
 }
});
test('재시도 승인 응답 사이에 늦은 성공이 도착하면 원래 관찰 기준으로 성공 처리한다',async()=>{
 const r=rig({ignoreEnter:true});await r.request('DICO_PREPARE');r.tick(3000);
 r.onAuthorization(m=>{if(m.retryCount===1)r.post({clear:true});});
 const result=await r.request('DICO_DELIVER');assert.equal(result.status,'confirmed');assert.equal(r.events.filter(e=>e.type==='keydown').length,1);
});
test('재시도마다 실제 쿨다운을 새로 기다리고 재시도 하트비트만 보낸다',async()=>{
 const r=rig({ignoreFirstEnters:1});await r.request('DICO_PREPARE');r.tick(3000);let until;
 r.onRetry(m=>{if(until===undefined){until=r.now()+4000;r.cooldown(now=>now<until?'00:01':'');}});
 const result=await r.request('DICO_DELIVER');assert.equal(result.status,'confirmed');
 const enters=r.events.filter(e=>e.type==='keydown');assert.equal(enters.length,2);assert.ok(enters[1].at>=until);
 assert.ok(r.requests.some(m=>m.type==='DICO_RETRY_WAIT'&&m.cooldownMs>0));
 assert.equal(r.requests.some(m=>m.type==='DICO_PRE_ENTER_WAIT'),false);
});

test('재시도 최종 승인 뒤 새 쿨다운이 생기면 해제 후 다시 승인받는다',async()=>{
 const r=rig({ignoreFirstEnters:1});r.delivery.strictAuthorization=true;
 await r.request('DICO_PREPARE');r.tick(3000);let until,authorizations=0;
 r.onAuthorization(m=>{if(m.retryCount===1){authorizations++;if(until===undefined){until=r.now()+4000;r.cooldown(now=>now<until?'00:01':'');}}});
 const result=await r.request('DICO_DELIVER');assert.equal(result.status,'confirmed');
 assert.equal(r.events.filter(e=>e.type==='keydown').length,2);assert.ok(r.events.filter(e=>e.type==='keydown')[1].at>=until);assert.equal(authorizations,2);
});
test('재시도 승인 지연·중지·불명 쿨다운이면 이미 시도한 Enter를 반복하지 않는다',async()=>{
 for(const mode of ['late','stop','unreadable']){
  const r=rig({ignoreFirstEnters:1});r.delivery.strictAuthorization=true;
  await r.request('DICO_PREPARE');r.tick(3000);
  r.onAuthorization(m=>{if(m.retryCount===1){if(mode==='late')r.tick(3001);if(mode==='stop')r.stop();if(mode==='unreadable')r.cooldown('알 수 없음');}});
  const result=await r.request('DICO_DELIVER');assert.equal(result.status,'uncertain',mode);assert.equal(r.events.filter(e=>e.type==='keydown').length,1,mode);
 }
});
test('재시도 쿨다운 중 늦은 성공·모호한 게시·중지는 추가 Enter 없이 종료한다',async()=>{
 for(const mode of ['success','ambiguous','stop']){
  const r=rig({ignoreFirstEnters:1});await r.request('DICO_PREPARE');r.tick(3000);let initialized=false;
  r.onRetry(m=>{if(!initialized){initialized=true;r.cooldown('00:01');return;}if(m.cooldownMs>0){if(mode==='stop')r.stop();else r.post({clear:mode==='success',text:mode==='success'?'A':'other'});}});
  const result=await r.request('DICO_DELIVER');assert.equal(result.status,mode==='success'?'confirmed':'uncertain',mode);assert.equal(r.events.filter(e=>e.type==='keydown').length,1,mode);
 }
});

test('실제 content·실행기·코어가 같은 시도에서 입력창 재획득·응답 유실을 복구하고 한 번만 차례를 넘긴다',async t=>{
 const guildId='11111111111111111',channelId='22222222222222222',accountId='123456789012345678',tabId=7;
 const r=rig({guildId,channelId,ignoreFirstEnters:1,loggedUser:accountId,noPostedMessage:true});
 const manager=createCentralManager({now:r.now,monotonicNow:r.now});t.after(async()=>{r.onTick(null);await r.requestMessage({type:'DICO_CONTENT_DISPOSE'});manager.close();});
 manager.execute('settings.update',{maxSendRetries:1});
 const hello=manager.bridge({type:'HELLO',protocolVersion:1,name:'real content integration'});
 manager.bridge({type:'OBSERVATION',sessionId:hello.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId,guildId,channelId,tabId,verified:true}]},hello.instanceId);
 const channel=manager.snapshot().channels[0];
 const first=manager.execute('message.create',{name:'A',body:'A'}),second=manager.execute('message.create',{name:'B',body:'B'});
 manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:[{messageId:first.id},{messageId:second.id}]});
 let stored,executor,until;const transport={connected:true,request:async message=>manager.bridge(message,hello.instanceId)};
 const chrome={storage:{local:{get:async()=>({dicoCentral:structuredClone(stored)}),set:async value=>{stored=structuredClone(value.dicoCentral);}}},tabs:{get:async()=>({id:tabId,url:`https://discord.com/channels/${guildId}/${channelId}`}),sendMessage:async(_id,message)=>{if(message.delivery)Object.assign(r.delivery,message.delivery);const result=await r.requestMessage(message);if(message.type==='DICO_DELIVER')throw Error('completed response port lost');return result;}}};
 executor=createCentralExecutor({chrome,transport,now:r.now,monotonicNow:r.now});await executor.load();await executor.setSession(hello);
 r.onRuntime(async m=>({allowed:m.type==='DICO_CAN_SEND'?await executor.canSend(m,tabId):m.type==='DICO_RETRY_WAIT'?await executor.retryWait(m,tabId):await executor.preEnterWait(m,tabId),authorizedAt:r.now(),maxAgeMs:2000}));
 r.onRetry(()=>{assert.equal(manager.snapshot().channels[0].playlistIndex,0);if(until===undefined){until=r.now()+4000;r.cooldown(now=>now<until?'00:01':'');}});
 r.onSubmit(()=>r.replaceEditor());
 r.onTick(()=>{manager.bridge({type:'HEARTBEAT',sessionId:hello.sessionId},hello.instanceId);manager.tick();});
 for(const command of manager.commands(hello.instanceId))await executor.handleCommand(command);
 const group=manager.execute('group.create',{name:'Actual content',members:[channel.id],intervalMs:0});manager.execute('group.start',{id:group.id});manager.tick();
 for(const type of ['PREPARE','COMMIT_PERMIT']){const command=manager.commands(hello.instanceId).find(x=>x.type===type);assert.ok(command);await executor.handleCommand(command);}
 const state=manager.snapshot();assert.equal(state.attempts[0].deliveryEvidence.editorReacquired,true);assert.equal(state.attempts[0].deliveryEvidence.sameComposer,true);assert.equal(state.attempts[0].deliveryEvidence.sameEditor,false);assert.equal(state.attempts.length,1);assert.equal(state.attempts[0].status,'confirmed');assert.equal(state.attempts[0].confirmationBasis,'composer_cleared');assert.equal(state.attempts[0].messageId,undefined);assert.equal(state.attempts[0].sendRetryCount,1);assert.equal(state.channels[0].playlistIndex,1);
 assert.equal(r.events.filter(e=>e.type==='paste').length,1);assert.equal(r.events.filter(e=>e.type==='keydown').length,2);assert.ok(r.events.filter(e=>e.type==='keydown')[1].at>=until);
});

test('재시도 시작 응답 중 쿨다운이 사라져도 대기 해제를 알리고 최종 승인받는다',async()=>{
 const r=rig({ignoreFirstEnters:1});await r.request('DICO_PREPARE');r.tick(3000);let injected=false,started=false;
 r.onTick(()=>{if(!injected&&r.events.some(e=>e.type==='keydown')){injected=true;r.cooldown('00:01');}});
 r.onRetry(m=>{if(!started){started=true;assert.equal(m.cooldownMs,1000);r.cooldown('');}});
 const result=await r.request('DICO_DELIVER');assert.equal(result.status,'confirmed');
 assert.deepEqual(r.requests.filter(m=>m.type==='DICO_RETRY_WAIT').map(m=>m.cooldownMs),[1000,0]);assert.equal(r.events.filter(e=>e.type==='keydown').length,2);
});


test('managed preparation and confirmation use worker wakeups when page timers are throttled to one minute',async()=>{
 const r=rig({managed:true,loggedUser:'123456789012345678',pageTimerDelay:60000});r.target.coordinated=true;
 const began=r.now();assert.equal((await r.request('DICO_PREPARE')).status,'prepared');
 assert.ok(r.now()-began<5000);assert.ok(r.requests.filter(m=>m.type==='DICO_DELAY').length>=10);
 r.tick(Math.max(0,r.delivery.scheduledAt-r.now()));assert.equal((await r.request('DICO_DELIVER')).status,'confirmed');
 assert.equal(r.events.filter(e=>e.type==='keydown').length,1);
});

test('managed retained draft retries on worker deadlines despite one-minute page timer throttling',async()=>{
 const r=rig({managed:true,loggedUser:'123456789012345678',pageTimerDelay:60000,ignoreFirstEnters:1});r.target.coordinated=true;r.delivery.maxSendRetries=1;
 assert.equal((await r.request('DICO_PREPARE')).status,'prepared');r.tick(3000);const began=r.now();
 const result=await r.request('DICO_DELIVER');assert.equal(result.status,'confirmed');assert.equal(result.deliveryEvidence.retryCount,1);
 assert.ok(r.now()-began<30000);assert.equal(r.events.filter(e=>e.type==='keydown').length,2);
});


test('managed delay rejection preserves the draft and never presses Enter',async()=>{
 const r=rig({managed:true,loggedUser:'123456789012345678',workerDelayFails:true});r.target.coordinated=true;r.editor.innerText='A';
 const result=await r.request('DICO_PREPARE');assert.equal(result.status,'blocked');assert.equal(result.code,'MANAGED_DELAY_UNAVAILABLE');
 assert.equal(r.editor.innerText,'A');assert.equal(r.events.filter(e=>e.type==='keydown').length,0);
});

test('disposing managed content stops calibration worker wakeups after the pending response drains',async()=>{
 const r=rig({managed:true,loggedUser:'123456789012345678'});r.target.coordinated=true;
 await r.request('DICO_PREPARE');r.tick(3000);assert.equal((await r.request('DICO_DELIVER')).status,'confirmed');
 assert.equal((await r.requestMessage({type:'DICO_CONTENT_DISPOSE'})).disposed,true);
 await new Promise(resolve=>setImmediate(resolve));const count=r.requests.filter(m=>m.type==='DICO_DELAY').length;
 await new Promise(resolve=>setImmediate(resolve));assert.equal(r.requests.filter(m=>m.type==='DICO_DELAY').length,count);
});

test('stopping a retained-draft retry preserves the observed composer and posting evidence',async()=>{
 const r=rig({ignoreFirstEnters:1});await r.request('DICO_PREPARE');r.tick(3000);
 r.onRetry(()=>r.stop());const result=await r.request('DICO_DELIVER');
 assert.equal(result.status,'uncertain');assert.equal(result.code,'RETRY_CANCELLED');
 assert.equal(result.deliveryEvidence.composerRetained,true);
 for(const key of ['newMessage','matchingMessage','sendingSeen','failedSeen'])assert.equal(result.deliveryEvidence[key],false,key);
 assert.equal(r.events.filter(e=>e.type==='keydown').length,1);
});

test('기본 아바타는 MAIN 계정 증명으로 검사·준비·발송하며 닉네임만으로 입력하지 않는다',async()=>{
 const r=rig({loggedUser:'123456789012345678',defaultAvatar:true,managed:true});r.target.coordinated=true;
 assert.equal((await r.request('DICO_INSPECT')).ok,true);
 assert.equal((await r.request('DICO_PREPARE')).status,'prepared');r.tick(3000);
 assert.equal((await r.request('DICO_DELIVER')).status,'confirmed');
 assert.equal(r.events.filter(e=>e.type==='keydown').length,1);assert.ok(r.requests.filter(m=>m.type==='DICO_ACCOUNT_IDENTITY').length>=2);
 for(const loggedUser of [null,'987654321098765432']){
  const blocked=rig({loggedUser,defaultAvatar:true,managed:true});blocked.target.coordinated=true;
  assert.equal((await blocked.request('DICO_PREPARE')).status,'blocked');assert.equal(blocked.events.length,0);
 }
});
test('기본 아바타의 같은 표시명·다른 사용자명은 오래된 MAIN 증명으로 준비하지 않는다',async()=>{
 const r=rig({loggedUser:'123456789012345678',defaultAvatar:true,managed:true});r.target.coordinated=true;
 assert.equal((await r.request('DICO_INSPECT')).ok,true);r.profile({username:'switched_account'});
 assert.equal((await r.request('DICO_PREPARE')).status,'blocked');assert.equal(r.events.length,0);
});
test('기본 아바타의 사용자명 DOM이 없으면 명시적 currentUser의 표시명 증명을 사용한다',async()=>{
 const r=rig({loggedUser:'123456789012345678',defaultAvatar:true,managed:true});r.target.coordinated=true;r.profile({username:''});
 assert.equal((await r.request('DICO_PREPARE')).status,'prepared');
});
test('기본 아바타 계정 전환은 준비 후 새 증명으로 감지하여 Enter를 막는다',async()=>{
 const r=rig({loggedUser:'123456789012345678',defaultAvatar:true,managed:true});r.target.coordinated=true;
 assert.equal((await r.request('DICO_PREPARE')).status,'prepared');r.tick(3000);r.account('987654321098765432');
 assert.equal((await r.request('DICO_DELIVER')).status,'blocked');assert.equal(r.events.filter(e=>e.type==='keydown').length,0);assert.equal(r.editor.innerText,'A');
});
test('기본 아바타 검사 요청이 실패해도 모든 비동기 검사 응답은 입력 없이 완료된다',async()=>{
 for(const type of ['DICO_INSPECT','DICO_DRAFT_INSPECT','DICO_RECONCILE']){
  const r=rig({defaultAvatar:true,managed:true});r.target.coordinated=true;r.onRuntime(async m=>{if(m.type==='DICO_ACCOUNT_IDENTITY')throw Error('MAIN unavailable');return{};});
  const result=await r.request(type);assert.ok(result);assert.equal(r.events.length,0);assert.notEqual(result.ok,true);
 }
});

async function preparedComposerRig(options={}){
 const r=rig({managed:true,loggedUser:'123456789012345678',noPostedMessage:true,...options});r.target.coordinated=true;r.delivery.maxSendRetries=0;
 assert.equal((await r.request('DICO_PREPARE')).status,'prepared');r.tick(3000);return r;
}
test('중앙 발송은 실제 제출 뒤 같은 입력창이 비면 게시 메시지 DOM과 추가 대기 없이 즉시 처리한다',async()=>{
 const r=await preparedComposerRig({defaultAvatar:true});const result=await r.request('DICO_DELIVER');
 assert.equal(result.status,'confirmed');assert.equal(result.confirmationBasis,'composer_cleared');assert.equal(result.messageId,undefined);assert.equal(r.events.filter(e=>e.type==='keydown').length,1);
 for(const field of ['enterAttempted','composerCleared','expectedDraftSubmitted','sameEditor','targetMatched','accountMatched'])assert.equal(result.deliveryEvidence[field],true,field);
 assert.equal(result.deliveryEvidence.failedSeen,false);assert.equal(result.deliveryEvidence.emptyStableMs,undefined);assert.equal(result.timing.confirmationMs,0);
});
test('관리 발송의 원래 입력창 비움이 기준이고 메시지 ID는 실제 관측한 경우에만 함께 기록한다',async()=>{
 const r=await preparedComposerRig({noPostedMessage:false});const result=await r.request('DICO_DELIVER');assert.equal(result.confirmationBasis,'composer_cleared');assert.match(result.messageId,/^\d{17,20}$/);assert.equal(result.timing.confirmationMs,0);
});
test('처음부터 비어 있는 입력창과 Enter 전 취소는 전송 처리 근거가 아니다',async()=>{
 for(const mode of ['empty','cancel']){const r=await preparedComposerRig();if(mode==='empty')r.editor.innerText='';else r.stop();const result=await r.request('DICO_DELIVER');assert.notEqual(result.status,'confirmed');assert.equal(r.events.filter(e=>e.type==='keydown').length,0);}
});
test('Enter 뒤 입력창이 없어지거나 교체되거나 채널·계정이 바뀌면 빈 상태로 성공 처리하지 않는다',async()=>{
 for(const mode of ['missing','replacement','channel','account']){
  const r=await preparedComposerRig();r.onSubmit(()=>{if(mode==='missing')r.removeEditor();if(mode==='replacement')r.replaceEditor({sameForm:false});if(mode==='channel')r.navigate('/channels/123/999');if(mode==='account')r.account('987654321098765432');});
  const result=await r.request('DICO_DELIVER');assert.notEqual(result.status,'confirmed',mode);assert.equal(result.code,({missing:'COMPOSER_EDITOR_MISSING',replacement:'COMPOSER_EDITOR_CHANGED',channel:'TARGET_MISMATCH',account:'ACCOUNT_UNVERIFIED'})[mode]);assert.equal(result.deliveryEvidence.enterAttempted,true);assert.equal(result.deliveryEvidence.sameEditor,!['missing','replacement'].includes(mode));assert.equal(r.events.filter(e=>e.type==='keydown').length,1);
 }
});
test('명시적 전송 실패 또는 남은 초안은 입력창 비움 성공 기준을 충족하지 않는다',async()=>{
 const failed=await preparedComposerRig();failed.onSubmit(()=>failed.post({failed:true,text:'다르게 렌더링된 실패 문구'}));const result=await failed.request('DICO_DELIVER');assert.notEqual(result.status,'confirmed');assert.equal(result.code,'DISCORD_SEND_FAILED');assert.equal(result.deliveryEvidence.failedSeen,true);
 const retained=await preparedComposerRig({ignoreEnter:true});const remaining=await retained.request('DICO_DELIVER');assert.notEqual(remaining.status,'confirmed');assert.equal(retained.editor.innerText,'A');assert.equal(remaining.deliveryEvidence.composerRetained,true);
});
test('제출 뒤 빈 입력창은 500ms 샘플이나 타이머 응답을 기다리지 않는다',async()=>{
 const r=await preparedComposerRig();let afterSubmissionTick=false,submitted=false;r.onSubmit(()=>{submitted=true;});r.onTick(()=>{if(submitted)afterSubmissionTick=true;});
 const result=await r.request('DICO_DELIVER');assert.equal(result.confirmationBasis,'composer_cleared');assert.equal(result.timing.confirmationMs,0);assert.equal(afterSubmissionTick,false);
});
test('중앙 입력 관찰 종료는 변경된 초안·읽기 불가·불안정한 빈 상태를 게시 확인 시간초과로 뭉뚱그리지 않는다',async()=>{
 for(const mode of ['changed','unreadable']){
  const r=await preparedComposerRig();let began;r.onSubmit(()=>{began=r.now();if(mode==='changed')r.editor.innerText='사용자가 바꾼 문구';if(mode==='unreadable')r.compose();});
  const result=await r.request('DICO_DELIVER');assert.equal(result.status,'uncertain');assert.equal(result.code,({changed:'COMPOSER_DRAFT_CHANGED',unreadable:'COMPOSER_STATE_UNREADABLE'})[mode]);
  assert.equal(result.deliveryEvidence.expectedDraftSubmitted,true);assert.equal(result.deliveryEvidence.sameEditor,true);assert.equal(result.deliveryEvidence.editorPresent,true);assert.equal(result.deliveryEvidence.composerEmpty,mode!=='changed');assert.equal(result.deliveryEvidence.emptyStableMs,undefined);
  assert.equal(r.events.filter(e=>e.type==='keydown').length,1);assert.doesNotMatch(result.error,/25초|게시.{0,4}확인.{0,4}시간/);
 }
});
test('명시적 무제한은 5회를 넘겨 같은 초안만 재시도하고 입력창이 비는 즉시 끝난다',async()=>{
 const r=rig({managed:true,loggedUser:'123456789012345678',noPostedMessage:true,ignoreFirstEnters:8,maxSendRetries:null});r.target.coordinated=true;
 await r.request('DICO_PREPARE');r.tick(3000);const began=r.now();const result=await r.request('DICO_DELIVER');
 assert.equal(result.status,'confirmed');assert.equal(result.confirmationBasis,'composer_cleared');assert.equal(result.timing.confirmationMs,0);assert.equal(result.deliveryEvidence.retryCount,8);assert.equal(result.deliveryEvidence.maxSendRetries,null);
 assert.equal(r.events.filter(e=>e.type==='keydown').length,9);assert.equal(r.events.filter(e=>e.type==='paste').length,1);assert.ok(r.now()-began<20000,'retained drafts do not wait 25 seconds for each retry');
});
test('무제한도 중지 즉시 끝나고 구형 요청의 미지정 재시도는 자동 무제한이 되지 않는다',async()=>{
 const r=rig({managed:true,loggedUser:'123456789012345678',ignoreEnter:true,maxSendRetries:null});r.target.coordinated=true;
 await r.request('DICO_PREPARE');r.tick(3000);r.onRetry(m=>{if(m.retryCount===8)r.stop();});
 const result=await r.request('DICO_DELIVER');assert.equal(result.status,'uncertain');assert.equal(r.events.filter(e=>e.type==='keydown').length,8);assert.equal(r.editor.innerText,'A');
 const old=await preparedComposerRig({ignoreEnter:true});delete old.delivery.maxSendRetries;const stopped=await old.request('DICO_DELIVER');assert.equal(stopped.status,'draft-retained');assert.equal(old.events.filter(e=>e.type==='keydown').length,1);
});
test('다른 사람의 새 메시지는 남은 동일 초안의 재시도를 막지 않는다',async()=>{
 const r=rig({managed:true,loggedUser:'123456789012345678',noPostedMessage:true,ignoreFirstEnters:6,maxSendRetries:null});r.target.coordinated=true;
 await r.request('DICO_PREPARE');r.tick(3000);r.onRetry(m=>{if(m.retryCount===1)r.post({text:'다른 사람의 대화',author:'987654321098765432'});});
 const result=await r.request('DICO_DELIVER');assert.equal(result.status,'confirmed');assert.equal(result.deliveryEvidence.retryCount,6);assert.equal(r.events.filter(e=>e.type==='keydown').length,7);
});


test('같은 연결된 form의 유일 입력창이 제출 중 React로 교체되면 빈 초안을 즉시 완료한다',async()=>{
 const r=await preparedComposerRig();r.onSubmit(()=>r.replaceEditor());
 const result=await r.request('DICO_DELIVER');
 assert.equal(result.status,'confirmed');assert.equal(result.confirmationBasis,'composer_cleared');assert.equal(result.messageId,undefined);
 assert.equal(result.deliveryEvidence.sameEditor,false);assert.equal(result.deliveryEvidence.sameComposer,true);assert.equal(result.deliveryEvidence.editorReacquired,true);
 assert.equal(result.timing.confirmationMs,0);assert.equal(r.events.filter(e=>e.type==='keydown').length,1);
});
test('동일 form 재획득도 바뀐 초안·읽을 수 없는 입력·다른 계정·다른 채널은 완료하지 않는다',async()=>{
 for(const mode of ['draft','composing','account','channel']){
  const r=await preparedComposerRig();r.onSubmit(()=>{r.replaceEditor({text:mode==='draft'?'사용자 초안':''});if(mode==='composing')r.compose();if(mode==='account')r.account('987654321098765432');if(mode==='channel')r.navigate('/channels/123/999');});
  const result=await r.request('DICO_DELIVER');assert.equal(result.status,'uncertain',mode);assert.equal(r.events.filter(e=>e.type==='keydown').length,1);
 }
});
test('재시도 중 같은 form의 유일 입력창이 같은 초안으로 교체되어도 한 번만 재시도한다',async()=>{
 const r=rig({managed:true,loggedUser:'123456789012345678',noPostedMessage:true,ignoreFirstEnters:1,maxSendRetries:1});r.target.coordinated=true;
 await r.request('DICO_PREPARE');r.tick(3000);r.onRetry(()=>r.replaceEditor({text:'A'}));
 const result=await r.request('DICO_DELIVER');assert.equal(result.status,'confirmed');assert.equal(result.deliveryEvidence.retryCount,1);assert.equal(result.deliveryEvidence.editorReacquired,true);
 assert.equal(r.events.filter(e=>e.type==='keydown').length,2);assert.equal(r.events.filter(e=>e.type==='paste').length,1);
});

test('완료된 현재 content 영수증은 같은 시도만 읽어서 반환하고 Enter를 다시 실행하지 않는다',async()=>{
 const r=await preparedComposerRig();const completed=await r.request('DICO_DELIVER');assert.equal(completed.status,'confirmed');
 const receipt=()=>r.requestMessage({type:'DICO_DELIVERY_RECEIPT',target:r.target,delivery:{...r.delivery,phase:'commit'}});
 assert.equal((await receipt())?.status,'confirmed');assert.equal(r.events.filter(e=>e.type==='keydown').length,1);
 for(const patch of [{id:'other'},{text:'다른 본문'},{startedAt:r.delivery.startedAt+1},{sessionId:'other'}]){
  assert.notEqual((await r.requestMessage({type:'DICO_DELIVERY_RECEIPT',target:r.target,delivery:{...r.delivery,phase:'commit',...patch}}))?.status,'confirmed');
 }
 assert.notEqual((await r.request('DICO_DELIVER')).status,'confirmed');assert.equal((await receipt())?.status,'confirmed');
 r.tick(600001);assert.notEqual((await receipt())?.status,'confirmed');assert.equal(r.events.filter(e=>e.type==='keydown').length,1);
});
test('content 영수증은 전송 전·다른 채널·다른 계정·입력창 누락으로 성공을 만들지 않는다',async()=>{
 for(const mode of ['before','channel','account','missing']){
  const r=await preparedComposerRig();if(mode!=='before')await r.request('DICO_DELIVER');
  if(mode==='channel')r.navigate('/channels/123/999');if(mode==='account')r.account('987654321098765432');if(mode==='missing')r.removeEditor();
  const result=await r.requestMessage({type:'DICO_DELIVERY_RECEIPT',target:r.target,delivery:{...r.delivery,phase:'commit'}});
  assert.notEqual(result?.status,'confirmed',mode);assert.equal(r.events.filter(e=>e.type==='keydown').length,mode==='before'?0:1);
 }
});

test('실제 쿨다운을 기다리는 도중 같은 초안 입력창이 교체되면 남은 제한을 기다린 뒤 재시도한다',async()=>{
 const r=rig({managed:true,loggedUser:'123456789012345678',noPostedMessage:true,ignoreFirstEnters:1,maxSendRetries:1});r.target.coordinated=true;
 await r.request('DICO_PREPARE');r.tick(3000);let until,replaced=false;
 r.onRetry(m=>{if(until===undefined){until=r.now()+3000;r.cooldown(now=>now<until?'00:01':'');}else if(m.cooldownMs>0&&!replaced){replaced=true;r.replaceEditor({text:'A'});}});
 const result=await r.request('DICO_DELIVER');assert.equal(replaced,true);assert.equal(result.status,'confirmed');assert.equal(r.events.filter(e=>e.type==='keydown').length,2);assert.ok(r.events.filter(e=>e.type==='keydown')[1].at>=until);
});


test('재시도 직전 안정 확인 중 같은 초안 입력창이 교체되면 새 입력창을 다시 안정 확인한다',async()=>{
 const r=rig({managed:true,loggedUser:'123456789012345678',noPostedMessage:true,ignoreFirstEnters:1,maxSendRetries:1});r.target.coordinated=true;
 await r.request('DICO_PREPARE');r.tick(3000);let replaced=false;
 r.onRetry(()=>r.onTick(()=>{if(!replaced){replaced=true;r.replaceEditor({text:'A'});}}));
 const result=await r.request('DICO_DELIVER');assert.equal(replaced,true);assert.equal(result.status,'confirmed');assert.equal(r.events.filter(e=>e.type==='keydown').length,2);assert.equal(r.events.filter(e=>e.type==='paste').length,1);
});
