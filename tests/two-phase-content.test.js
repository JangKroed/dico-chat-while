import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {deliveryTraceEvent,appendDiagnostics} from '../diagnostics.js';
const source=readFileSync(new URL('../emoji-data.js',import.meta.url),'utf8')+'\n'+readFileSync(new URL('../content.js',import.meta.url),'utf8');
function rig({lag=0,fault=null,managed=false,structured=false,message='A',emojiName=null,emojiValue=null,convertAliases=false}={}) {
 let nextDelay=0,onDelayed=null,repeatDelay=false;
 let clock=1800000000000,listener,check,allowed=true,pasteDue=null,pasteText='',cooldown='',composition;
 const nodes=[],events=[],traces=[];
 const form={querySelector:()=>null,querySelectorAll:()=>cooldown?[{textContent:cooldown,getClientRects:()=>[1]}]:[]};
 const selection={anchorNode:null,focusNode:null,isCollapsed:true,rangeCount:1,removeAllRanges(){},addRange(range){this.anchorNode=editor;this.focusNode=editor;this.isCollapsed=range.collapsed}};
 const editor={innerText:'',isConnected:true,getClientRects:()=>[1],getAttribute:()=>null,querySelector:()=>null,closest:()=>form,contains:n=>n===editor,focus(){document.activeElement=editor},dispatchEvent(event){
  events.push({type:event.type,at:clock});
  if(event.type==='paste'){pasteText=event.clipboardData.text;pasteDue=clock+lag;event.defaultPrevented=true;}
  if(event.type==='keydown'){
   assert.equal(editor.innerText.trim(),convertAliases?delivery.text.replaceAll(emojiName,emojiValue):delivery.text);event.defaultPrevented=true;editor.innerText='';
   nodes.push({id:'message-content-'+((BigInt(clock)-1420070400000n)<<22n),innerText:'A',closest:()=>({querySelector:()=>null,matches:()=>false,querySelectorAll:()=>[{getAttribute:()=>'/avatars/123456789012345678/a.png'}]})});check?.();
  }
 }};
 const document={hidden:true,activeElement:null,hasFocus:()=>false,querySelectorAll:sel=>sel.includes('message-content-')?nodes:[editor],querySelector:()=>({}),createRange:()=>({collapsed:false,selectNodeContents(){},collapse(){this.collapsed=true}}),addEventListener(name,fn){if(name==='compositionstart')composition=fn}};
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
 const target={managed,guildId:'123',channelId:'456',ownUserId:'123456789012345678',messages:[message,'B'],expectedText:message,skipConfirmation:Boolean(emojiName)};
 const delivery={id:'attempt',index:0,text:message,startedAt:clock,scheduledAt:clock+3000};
 const DateMock=class extends Date {static now(){return clock}};
 runInNewContext(source,{document,window:{getSelection:()=>selection},location:{origin:'https://discord.com',pathname:'/channels/123/456'},Date:DateMock,
 chrome:{runtime:{id:'ext',onMessage:{addListener:fn=>listener=fn},sendMessage:async m=>{if(m.type==='DICO_TRACE'){traces.push(m);return {ok:true}}return {allowed:allowed&&(m.phase==='prepare'||clock>=delivery.scheduledAt)}}}},
 ClipboardEvent:class{constructor(type,data){Object.assign(this,{type,defaultPrevented:false},data)}},KeyboardEvent:class{constructor(type,data){Object.assign(this,{type,defaultPrevented:false},data)}},DataTransfer:class{setData(_,text){this.text=text}},
 MutationObserver:class{constructor(fn){check=fn}observe(){}disconnect(){}},setTimeout:(fn,ms)=>setImmediate(()=>{const delay=nextDelay;if(!repeatDelay)nextDelay=0;tick(ms+delay);if(delay)onDelayed?.();fn()}),clearTimeout:clearImmediate,setInterval:()=>1,clearInterval(){},
 });
 return {delayNext:(ms,callback=null,repeat=false)=>{nextDelay=ms;onDelayed=callback;repeatDelay=repeat},editor,events,traces,delivery,target,tick,compose:()=>composition(),stop:()=>{allowed=false},cooldown:value=>{cooldown=value},now:()=>clock,
 request:type=>new Promise(resolve=>listener({type,target,delivery:{...delivery,...(type==='DICO_DELIVER'?{phase:'commit'}:{})}},{id:'ext'},resolve))};
}
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
 const r=rig();await r.request('DICO_PREPARE');r.tick(3000);r.cooldown('00:08');
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
