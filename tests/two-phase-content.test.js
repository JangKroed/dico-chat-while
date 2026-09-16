import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../content.js',import.meta.url),'utf8');
function rig({lag=0}={}) {
 let clock=1800000000000,listener,check,allowed=true,pasteDue=null,pasteText='',cooldown='',composition;
 const nodes=[],events=[],traces=[];
 const form={querySelector:()=>null,querySelectorAll:()=>cooldown?[{textContent:cooldown,getClientRects:()=>[1]}]:[]};
 const selection={anchorNode:null,focusNode:null,isCollapsed:true,rangeCount:1,removeAllRanges(){},addRange(range){this.anchorNode=editor;this.focusNode=editor;this.isCollapsed=range.collapsed}};
 const editor={innerText:'',isConnected:true,getClientRects:()=>[1],getAttribute:()=>null,querySelector:()=>null,closest:()=>form,contains:n=>n===editor,focus(){document.activeElement=editor},dispatchEvent(event){
  events.push({type:event.type,at:clock});
  if(event.type==='paste'){pasteText=event.clipboardData.text;pasteDue=clock+lag;event.defaultPrevented=true;}
  if(event.type==='keydown'){
   assert.equal(editor.innerText,'A');event.defaultPrevented=true;editor.innerText='';
   nodes.push({id:'message-content-'+((BigInt(clock)-1420070400000n)<<22n),innerText:'A',closest:()=>({querySelector:()=>null,matches:()=>false,querySelectorAll:()=>[{getAttribute:()=>'/avatars/123456789012345678/a.png'}]})});check();
  }
 }};
 const document={hidden:true,activeElement:null,hasFocus:()=>false,querySelectorAll:sel=>sel.includes('message-content-')?nodes:[editor],querySelector:()=>({}),createRange:()=>({collapsed:false,selectNodeContents(){},collapse(){this.collapsed=true}}),addEventListener(name,fn){if(name==='compositionstart')composition=fn}};
 const tick=ms=>{clock+=ms;if(pasteDue!==null&&clock>=pasteDue){editor.innerText=pasteText;pasteDue=null;selection.isCollapsed=true;}};
 const target={guildId:'123',channelId:'456',ownUserId:'123456789012345678',messages:['A','B']};
 const delivery={id:'attempt',index:0,text:'A',startedAt:clock,scheduledAt:clock+3000};
 const DateMock=class extends Date {static now(){return clock}};
 runInNewContext(source,{document,window:{getSelection:()=>selection},location:{origin:'https://discord.com',pathname:'/channels/123/456'},Date:DateMock,
 chrome:{runtime:{id:'ext',onMessage:{addListener:fn=>listener=fn},sendMessage:async m=>{if(m.type==='DICO_TRACE'){traces.push(m);return {ok:true}}return {allowed:allowed&&(m.phase==='prepare'||clock>=delivery.scheduledAt)}}}},
 ClipboardEvent:class{constructor(type,data){Object.assign(this,{type,defaultPrevented:false},data)}},KeyboardEvent:class{constructor(type,data){Object.assign(this,{type,defaultPrevented:false},data)}},DataTransfer:class{setData(_,text){this.text=text}},
 MutationObserver:class{constructor(fn){check=fn}observe(){}disconnect(){}},setTimeout:(fn,ms)=>setImmediate(()=>{tick(ms);fn()}),clearTimeout:clearImmediate,setInterval:()=>1,clearInterval(){},
 });
 return {editor,events,traces,delivery,tick,compose:()=>composition(),stop:()=>{allowed=false},cooldown:value=>{cooldown=value},now:()=>clock,
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
