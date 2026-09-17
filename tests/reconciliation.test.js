import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../content.js',import.meta.url),'utf8');
function rig() {
 const user='123456789012345678', now=Date.now();
 const editor={innerText:'',getClientRects:()=>[1],getAttribute:()=>null,querySelector:()=>null};
 let nodes=[];
 const row={failed:false,sending:false,user,querySelector(selector){return selector.includes('isSending')?(this.failed||this.sending):null},matches:()=>false,querySelectorAll(){return [{getAttribute:()=>`/avatars/${this.user}/a.png`}];}};
 const node={id:'message-content-'+((BigInt(now)-1420070400000n)<<22n),innerText:'공지',closest:()=>row};
 const location={origin:'https://discord.com',pathname:'/channels/123/456'};
 const document={querySelectorAll:sel=>sel.includes('message-content-')?nodes:[editor],querySelector:()=>null};
 const api=runInNewContext(source.slice(0,source.indexOf('  async function deliver('))+'return {reconcile};\n})();',{document,location,Date});
 const target={guildId:'123',channelId:'456',ownUserId:user,messages:['공지','다음 공지']};
 const delivery={id:'attempt',index:0,text:'공지',startedAt:now};
 return {api,row,node,editor,location,target,delivery,setNodes:v=>nodes=v};
}
test('게시 재확인은 본인의 이번 전송 하나와 빈 입력창을 확인한다',()=>{
 const r=rig();r.setNodes([r.node]);assert.equal(r.api.reconcile(r.target,r.delivery).status,'confirmed');
});
test('다른 채널·이전 글·다른 작성자·작성자 불명·남은 초안·실패·전송 중·여러 후보는 확정하지 않는다',()=>{
 const mutations=[
 r=>{r.location.pathname='/channels/123/999'},
 r=>{r.delivery.startedAt+=1},
 r=>{r.row.user='999999999999999999'},
 r=>{r.target.ownUserId=''},
 r=>{r.editor.innerText='개인 초안'},
 r=>{r.editor.innerText='공지\n다음 공지'},
 r=>{r.editor.querySelector=()=>({})},
 r=>{r.row.failed=true},
 r=>{r.row.sending=true},
 r=>{r.setNodes([r.node,{...r.node,id:'message-content-'+(BigInt(r.node.id.slice(16))+1n)}])},
 ];
 for(const mutate of mutations){const r=rig();r.setNodes([r.node]);mutate(r);assert.equal(r.api.reconcile(r.target,r.delivery).status,'uncertain');}
});
test('빈 기록은 미발송으로 단정하지 않으며 늦게 나타난 본인 게시만 확정한다',()=>{
 const r=rig();assert.equal(r.api.reconcile(r.target,r.delivery).status,'uncertain');
 r.setNodes([r.node]);assert.equal(r.api.reconcile(r.target,r.delivery).status,'confirmed');
});

test('이미 게시된 현재 공지가 초안으로 남아 있어도 차례를 넘기고 다음 발송 때 교체하도록 표시한다',()=>{
 const r=rig();r.setNodes([r.node]);r.editor.innerText='공지';
 const result=r.api.reconcile(r.target,r.delivery);
 assert.equal(result.status,'confirmed');assert.equal(result.draftAction,'replace-next');
 assert.equal(r.editor.innerText,'공지','재확인에서 초안을 임의 삭제하지 않는다');
});
test('다음 차례 초안은 보존하고 재입력 없이 재사용하도록 표시한다',()=>{
 const r=rig();r.setNodes([r.node]);r.editor.innerText='다음 공지';
 const result=r.api.reconcile(r.target,r.delivery);
 assert.equal(result.status,'confirmed');assert.equal(result.draftAction,'reuse-next');
 assert.equal(r.editor.innerText,'다음 공지');
});
test('현재 문구가 이미 두 번 게시되었거나 다음 공지까지 게시되었으면 추가 자동 진행하지 않는다',()=>{
 const r=rig();r.setNodes([r.node,{...r.node,id:'message-content-'+(BigInt(r.node.id.slice(16))+1n),innerText:'다음 공지'}]);
 assert.equal(r.api.reconcile(r.target,r.delivery).status,'uncertain');
});

test('A/B가 같거나 Markdown 표시가 같아도 동일 게시를 두 건으로 세지 않는다',()=>{
 const r=rig();r.target.messages=['# 공지','공지'];r.delivery.text='# 공지';r.editor.innerText='공지';r.setNodes([r.node]);
 const result=r.api.reconcile(r.target,r.delivery);assert.equal(result.status,'confirmed');assert.equal(result.draftAction,'reuse-next');
});

test('수동 확인 전 A 게시를 B의 순서 충돌로 다시 판단하지 않는다',()=>{
 const r=rig(),now=Date.now();
 r.node.id='message-content-'+((BigInt(now-3000)-1420070400000n)<<22n);r.setNodes([r.node]);
 const next={...r.delivery,index:1,text:'다음 공지',startedAt:now-8000};
 assert.equal(r.api.reconcile(r.target,next).reason,'next-already-posted');
 assert.equal(r.api.reconcile(r.target,{...next,startedAt:now+1}).reason,'no-proof');
});

test('서버 시각이 로컬 확인보다 앞서도 이미 확인한 게시 ID는 다음 순서 충돌이 아니다',()=>{
 const r=rig();r.setNodes([r.node]);
 r.target.lastConfirmedMessageId=r.node.id.slice(16);
 const next={...r.delivery,index:1,text:'다음 공지',startedAt:r.delivery.startedAt-1000};
 assert.equal(r.api.reconcile(r.target,next).reason,'no-proof');
 // A genuinely newer opposite-turn message must still stop the sequence.
 r.setNodes([{...r.node,id:'message-content-'+(BigInt(r.target.lastConfirmedMessageId)+1n)}]);
 assert.equal(r.api.reconcile(r.target,next).reason,'next-already-posted');
});
test('재확인 결과는 확인된 게시 ID를 반환한다',()=>{
 const r=rig();r.setNodes([r.node]);
 assert.equal(r.api.reconcile(r.target,r.delivery).messageId,r.node.id.slice(16));
});

test('구버전 성공 기록은 2초 이내의 유일한 이전 차례 게시와 빈 초안일 때만 복구한다',()=>{
 for(const offset of [1717,1815,2001]){
  const r=rig();r.setNodes([r.node]);
  r.target.lastOutcome='confirmed';r.target.lastSentAt=r.delivery.startedAt-offset;
  const next={...r.delivery,index:1,text:'다음 공지',startedAt:r.target.lastSentAt+1};
  assert.equal(r.api.reconcile(r.target,next).reason,offset<=2000?'acknowledged-legacy-post':'next-already-posted');
  r.target.lastOutcome='unverified';
  assert.equal(r.api.reconcile(r.target,next).reason,'next-already-posted');
  r.target.lastOutcome='confirmed';r.editor.innerText='개인 초안';
  assert.equal(r.api.reconcile(r.target,next).reason,'next-already-posted');
  r.editor.innerText='';r.setNodes([r.node,{...r.node,id:'message-content-'+(BigInt(r.node.id.slice(16))+1n)}]);
  assert.equal(r.api.reconcile(r.target,next).reason,'next-already-posted');
 }
});
