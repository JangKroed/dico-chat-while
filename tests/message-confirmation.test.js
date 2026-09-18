import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../emoji-data.js',import.meta.url),'utf8')+'\n'+readFileSync(new URL('../content.js',import.meta.url),'utf8');
function rig(){
 let nodes=[],check,timeout,poll;
 const editor={isConnected:true,innerText:'공지',getClientRects:()=>[1],getAttribute:()=>null};
 const document={querySelectorAll:selector=>selector.includes('message-content-')?nodes:[editor],querySelector:()=>({}),body:{}};
 const api=runInNewContext(source.slice(0,source.indexOf('  async function deliver('))+'return {watchMessage,authorId};\n})();',{
 document,MutationObserver:class{constructor(fn){check=fn;}observe(){}disconnect(){}},
 setTimeout:fn=>{timeout=fn;return 1;},clearTimeout:()=>{},setInterval:fn=>{poll=fn;return 2;},clearInterval:()=>{},Date,console,
 });
 const row={sending:false,failed:false,previousElementSibling:null,querySelector:sel=>sel.includes('isSending')?row.sending:sel.includes('isFailed')?row.failed:null,querySelectorAll:()=>[],matches:()=>false};
 const node={id:'message-content-local',innerText:'공지',closest:()=>row};
 return {api,editor,row,node,setNodes:v=>nodes=v,check:()=>check(),timeout:()=>timeout(),poll:()=>poll()};
}
const snowflake=()=> 'message-content-'+((BigInt(Date.now())-1420070400000n)<<22n).toString();
test('입력창이 비워지기 전 전송 중 상태와 최종 ID 변경을 연결한다',async()=>{
 const r=rig();const watcher=r.api.watchMessage(r.editor,'공지',null,Date.now());
 r.setNodes([r.node]);r.row.sending=true;r.check();
 r.node.id=snowflake();r.row.sending=false;r.editor.innerText='';r.check();
 const receipt=await watcher.promise;assert.equal(receipt.status,'confirmed');assert.equal(receipt.messageId,r.node.id.slice(16));
});
test('본문 제목을 작성자 헤더로 오인하지 않고 이전 작성자를 찾는다',()=>{
 const r=rig();
 const header={querySelectorAll:()=>[{getAttribute:()=>'/avatars/123456789012345678/a.png'}]};
 const body={querySelectorAll:()=>[],querySelector:sel=>sel==='h3'?{}:null,previousElementSibling:header};
 assert.equal(r.api.authorId(body),'123456789012345678');
});
test('명시적으로 다른 작성자는 전송 중 관찰이 있어도 성공 처리하지 않는다',async()=>{
 const r=rig();const watcher=r.api.watchMessage(r.editor,'공지','123456789012345678',Date.now());
 r.setNodes([r.node]);r.row.sending=true;r.check();
 r.node.id=snowflake();r.row.sending=false;r.editor.innerText='';
 r.row.querySelectorAll=()=>[{getAttribute:()=>'/avatars/999999999999999999/a.png'}];
 r.timeout();assert.equal((await watcher.promise).status,'uncertain');
});
test('관찰 이벤트가 없어도 주기적 확인으로 늦은 전송 완료를 찾는다',async()=>{
 const r=rig();const watcher=r.api.watchMessage(r.editor,'공지','123456789012345678',Date.now());
 r.node.id=snowflake();r.editor.innerText='';r.setNodes([r.node]);
 r.row.querySelectorAll=()=>[{getAttribute:()=>'/avatars/123456789012345678/a.png'}];
 r.poll();assert.equal((await watcher.promise).status,'confirmed');
});
test('입력창이 교체되거나 작성자 불명일 때 임의로 성공 처리하지 않는다',async()=>{
 const r=rig();const watcher=r.api.watchMessage(r.editor,'공지',null,Date.now());
 r.node.id=snowflake();r.editor.innerText='';r.setNodes([r.node]);r.timeout();
 const result=await watcher.promise;assert.equal(result.status,'uncertain');assert.match(result.error,/작성자/);
});

test('전송 이전에 이미 있던 메시지와 Discord 실패 상태는 성공으로 인정하지 않는다',async()=>{
 for(const existing of [true,false]){
  const r=rig();r.node.id=snowflake();if(existing)r.setNodes([r.node]);
  const watcher=r.api.watchMessage(r.editor,'공지','123456789012345678',Date.now());
  r.setNodes([r.node]);r.row.failed=!existing;r.editor.innerText='';
  r.row.querySelectorAll=()=>[{getAttribute:()=>'/avatars/123456789012345678/a.png'}];
  r.timeout();assert.equal((await watcher.promise).status,'uncertain');
 }
});

test('제목·밑줄·굵게·이모지 게시 DOM을 본인 새 메시지로 확인한다',async()=>{
 const text=value=>({nodeType:3,textContent:value});
 const element=(tag,children=[],attrs={})=>({nodeType:1,tagName:tag,childNodes:children,getAttribute:key=>attrs[key]??null});
 const emoji=()=>element('IMG',[],{class:'emoji','data-type':'emoji',alt:':moneybag:'});
 const input='### 공지\n- __궁수,해적 35~43제__\n- 한타임 💰**1600** | 반타임 💰**800**';
 for(const fault of [null,'price','author','old','failed']){
  const r=rig();const watcher=r.api.watchMessage(r.editor,input,'123456789012345678',Date.now());
  r.node.childNodes=[element('H3',[text('공지')]),element('UL',[
   element('LI',[element('U',[text('궁수,해적 35~43제')])]),
   element('LI',[text('한타임 '),emoji(),element('STRONG',[text(fault==='price'?'1601':'1600')]),text(' | 반타임 '),emoji(),element('STRONG',[text('800')])])])];
  r.node.id=fault==='old'?'message-content-100000000000000000':snowflake();r.editor.innerText='';
  r.row.failed=fault==='failed';r.row.querySelectorAll=()=>[{getAttribute:()=>'/avatars/'+(fault==='author'?'999999999999999999':'123456789012345678')+'/a.png'}];
  r.setNodes([r.node]);r.check();if(fault)r.timeout();
  assert.equal((await watcher.promise).status,fault?'uncertain':'confirmed',fault || 'success');
 }
});

test('게시 확인 생략도 초안이 남으면 제출 완료로 처리하지 않는다',async()=>{
 const r=rig();const watcher=r.api.watchMessage(r.editor,'공지',null,Date.now(),()=>{},true);
 r.timeout();assert.equal((await watcher.promise).status,'draft-retained');
});
test('게시 확인 생략은 입력창이 비워지면 게시 증명 없이 제출로 기록한다',async()=>{
 const r=rig();const watcher=r.api.watchMessage(r.editor,'공지',null,Date.now(),()=>{},true);
 r.editor.innerText='';r.poll();assert.equal((await watcher.promise).status,'unverified');
});
