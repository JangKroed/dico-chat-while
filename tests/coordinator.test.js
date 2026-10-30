import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoordinator } from '../coordinator/core.js';

const ids = ['11111111111111111','22222222222222222','33333333333333333'];
const config = {groups:{demo:{members:ids,channelId:'44444444444444444',gapSeconds:20}}};
const request = (i, attemptId=`attempt-${i}`) => ({group:'demo',member:ids[i],clientId:`browser-${i}`,channelId:config.groups.demo.channelId,attemptId});
function rig(saved) {
  let stored=saved, now=100000;
  const io={load:async()=>structuredClone(stored),save:async s=>{stored=structuredClone(s);},now:()=>now};
  return {core:createCoordinator(config,io),io,advance:ms=>now+=ms,get stored(){return structuredClone(stored);}};
}
test('현재 멤버만 허가하고 확인 후 간격을 지키며 A B C A로 순환한다',async()=>{
  const r=rig();
  assert.equal((await r.core.acquire(request(1))).allowed,false);
  assert.equal((await r.core.acquire(request(0))).allowed,true);
  assert.equal((await r.core.acquire(request(1))).allowed,false);
  await r.core.finish({...request(0),outcome:'confirmed'});
  assert.equal((await r.core.acquire(request(1))).allowed,false);
  r.advance(20000);
  assert.equal((await r.core.acquire(request(1))).allowed,true);
  await r.core.finish({...request(1),outcome:'confirmed'});
  r.advance(20000);
  assert.equal((await r.core.acquire(request(2))).allowed,true);
  await r.core.finish({...request(2),outcome:'confirmed'});
  r.advance(20000);
  assert.equal((await r.core.acquire(request(0,'second-a'))).allowed,true);
});
test('동일 멤버의 다른 브라우저, 다른 채팅방, 허가 재사용을 차단한다',async()=>{
  const r=rig();await r.core.acquire(request(0));
  await assert.rejects(()=>r.core.acquire({...request(0),clientId:'imposter'}));
  await assert.rejects(()=>r.core.acquire({...request(1),channelId:'55555555555555555'}));
  await assert.rejects(()=>r.core.acquire(request(0)),/이미|재사용/);
});
test('동시 허가는 하나뿐이며 오래 기다리거나 재시작해도 허가를 자동 해제하지 않는다',async()=>{
  const r=rig();
  const results=await Promise.allSettled([r.core.acquire(request(0)),r.core.acquire(request(0,'competing'))]);
  assert.equal(results.filter(x=>x.status==='fulfilled' && x.value.allowed).length,1);
  r.advance(86400000);
  const restarted=rig(r.stored);
  assert.equal((await restarted.core.acquire(request(1))).allowed,false);
});
test('완료 보고 재시도는 멱등이며 미발송 확인은 같은 멤버 차례를 유지한다',async()=>{
  const r=rig();await r.core.acquire(request(0));
  const done={...request(0),outcome:'not-sent'};
  await r.core.finish(done);await r.core.finish(done);
  await assert.rejects(()=>r.core.finish({...done,outcome:'confirmed'}));
  await assert.rejects(()=>r.core.acquire(request(0)));
  assert.equal((await r.core.acquire(request(0,'new-a'))).allowed,true);
});
test('저장 실패 이후에는 재시작 전 모든 허가를 막고 손상 상태와 설정 변경은 거부한다',async()=>{
  const r=rig();r.io.save=async()=>{throw Error('disk full');};
  await assert.rejects(()=>r.core.acquire(request(0)),/disk full/);
  r.io.save=async()=>{};
  await assert.rejects(()=>r.core.acquire(request(0)),/재시작/);
  const s=rig({version:1,config:'bad',groups:{}});
  await assert.rejects(()=>s.core.acquire(request(0)));
});

test('다른 차례의 반복 조회와 상태 조회는 디스크에 같은 상태를 다시 쓰지 않는다',async()=>{
  const r=rig();let writes=0;r.io.save=async()=>{writes++;};
  await r.core.acquire(request(1));
  const initial=writes;
  await r.core.acquire(request(1,'waiting-again'));await r.core.status();
  assert.equal(writes,initial);
});
