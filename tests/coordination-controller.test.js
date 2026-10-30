import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../controller.js';
import { createCoordinator } from '../coordinator/core.js';

const member='11111111111111111', channelId='44444444444444444';
const coordination={url:'http://127.0.0.1:43127',token:'a'.repeat(32),group:'notice',clientId:'browser-a'};
async function rig() {
  let stored,clock=100000;const sent=[];
  const core=createCoordinator({groups:{notice:{members:[member,'22222222222222222'],channelId,gapSeconds:20}}},{load:async()=>undefined,save:async()=>{},now:()=>clock});
  const io={load:async()=>structuredClone(stored),save:async s=>{stored=structuredClone(s);},now:()=>clock,id:()=>crypto.randomUUID(),schedule:async()=>{},cancel:async()=>{},inspect:async()=>({ok:true}),
    acquire:async(s,d)=>{assert.equal(stored.pending.id,d.id,'intent is durable before permit');return core.acquire({group:s.coordination.group,member:s.ownUserId,clientId:s.coordination.clientId,channelId:s.target.channelId,attemptId:d.id});},
    finish:async(s,d,outcome)=>core.finish({group:d.coordination.group,member:s.ownUserId,clientId:d.coordination.clientId,channelId:s.target.channelId,attemptId:d.id,outcome}),
    send:async(t,d)=>{sent.push(d.id);return {status:'confirmed'};}};
  const controller=createController(io);
  await controller.updateSettings({messages:['A','B'],intervalSeconds:30,ownUserId:member,coordination});
  await controller.bind({tabId:7,url:`https://discord.com/channels/123/${channelId}`});
  return {controller,io,core,sent,get state(){return structuredClone(stored);},advance:ms=>clock+=ms};
}
test('중앙 허가 거절 시 발송하지 않으며 다음 알람에서 다시 확인한다',async()=>{
  const r=await rig();r.io.acquire=async()=>({allowed:false,waitMs:20000});
  await r.controller.start();assert.equal(r.sent.length,0);assert.equal(r.state.pending,null);assert.equal(r.state.enabled,true);assert.equal(r.state.nextRunAt,130000);
});
test('허가 응답 유실은 pending을 보존하고 자동 재발송하지 않는다',async()=>{
  const r=await rig();r.io.acquire=async()=>{throw Error('lost');};
  await r.controller.start();assert.equal(r.sent.length,0);assert.ok(r.state.pending);assert.equal(r.state.enabled,false);
});
test('완료 응답 유실 후 수동 확인 재시도는 발송 없이 차례를 복구한다',async()=>{
  const r=await rig(), finish=r.io.finish;
  r.io.finish=async(...args)=>{await finish(...args);throw Error('response lost');};
  await r.controller.start();assert.equal(r.sent.length,1);assert.equal(r.state.enabled,false);assert.equal(r.state.pending.coordinationOutcome,'confirmed');
  await assert.rejects(()=>r.controller.resolvePending('not-sent'));
  r.io.finish=finish;await r.controller.resolvePending('sent');
  assert.equal(r.state.pending,null);assert.equal(r.state.nextIndex,1);assert.equal(r.sent.length,1);
});
test('중앙 허가 후 미확인·초안 잔류·차단은 pending을 보존한다',async()=>{
  for(const status of ['uncertain','draft-retained','blocked','deferred']) {
    const r=await rig();r.io.send=async()=>({status,retryAfterMs:5000});
    await r.controller.start();assert.ok(r.state.pending,status);assert.equal(r.state.enabled,false,status);
    await r.controller.resolvePending('not-sent');assert.equal(r.state.nextIndex,0);assert.equal((await r.core.status()).notice.turn,member);
  }
});
test('연동 채널은 확인 생략과 사용자 ID 누락을 거부한다',async()=>{
  const r=await rig();await assert.rejects(()=>r.controller.updateSettings({...r.state,skipConfirmation:true}));
  await assert.rejects(()=>r.controller.updateSettings({...r.state,ownUserId:''}));
});

test('서로 다른 지연과 실행 순서로 3개 브라우저를 반복해도 계정 순서는 A B C를 유지한다',async()=>{
  let clock=100000;const order=[],members=[member,'22222222222222222','33333333333333333'];
  const core=createCoordinator({groups:{notice:{members,channelId,gapSeconds:20}}},{load:async()=>undefined,save:async()=>{},now:()=>clock});
  const clients=[];
  for (let i=0;i<3;i++) {
    let stored;
    const request=(s,d)=>({group:d.coordination.group,member:s.ownUserId,clientId:d.coordination.clientId,channelId,attemptId:d.id});
    const controller=createController({
      load:async()=>structuredClone(stored),save:async s=>{stored=structuredClone(s);},now:()=>clock,id:()=>crypto.randomUUID(),schedule:async()=>{},cancel:async()=>{},inspect:async()=>({ok:true}),
      acquire:(s,d)=>core.acquire(request(s,d)),finish:(s,d,outcome)=>core.finish({...request(s,d),outcome}),
      send:async()=>{clock+=[1700,6700,900][i];order.push(i);return {status:'confirmed'};},
    });
    await controller.updateSettings({messages:['문구A','문구B'],intervalSeconds:30,ownUserId:members[i],coordination});
    await controller.bind({tabId:i+1,url:`https://discord.com/channels/123/${channelId}`});clients.push(controller);
  }
  for (const i of [2,1,0]) await clients[i].start();
  for (let n=0;n<80;n++) {
    clock+=31000;
    for (const i of (n%2?[2,0,1]:[1,0,2])) await clients[i].tick();
  }
  assert.ok(order.length>30);
  assert.ok(order.every((member,index)=>member===index%3),JSON.stringify(order));
});
