import test from 'node:test';
import assert from 'node:assert/strict';
import {secondsUntil,accountTimingState,groupTimingState,waitReasonText} from '../central/ui/src/countdown.ts';

test('countdown follows server time plus elapsed receipt time rather than local wall clock',()=>{
  assert.equal(secondsUntil(163000,100000,0,true),63);
  assert.equal(secondsUntil(163000,100000,1000,true),62);
  assert.equal(secondsUntil(163000,100000,1001,true),62);
  assert.equal(secondsUntil(100000,100000,1000,true),0);
});
test('unknown, offline and stale snapshots cannot display a guessed countdown',()=>{
  assert.equal(secondsUntil(null,100000,0,true),null);
  assert.equal(secondsUntil(163000,undefined,0,true),null);
  assert.equal(secondsUntil(163000,100000,0,false),null);
  assert.equal(secondsUntil(163000,100000,20001,true),null);
});
test('account ready is distinct from whole-group readiness and stopped groups remain stopped',()=>{
  const channel={id:'binding',nextEligibleAt:100000};
  const group={status:'running',members:['other','binding'],cursor:0};
  assert.equal(accountTimingState(channel,group,undefined,0),'계정 간격 충족 · 차례 대기');
  assert.equal(accountTimingState(channel,{...group,status:'stopped'},undefined,0),'계정 간격 충족 · 그룹 중지');
  assert.equal(groupTimingState({...group,status:'stopped'},0),'그룹 중지됨');
});
test('active and unknown attempts never promise another send countdown',()=>{
  const channel={id:'binding',nextEligibleAt:null},group={status:'running',members:['binding'],cursor:0};
  assert.equal(accountTimingState(channel,group,{status:'unknown'},null),'실제 게시 여부 확인 필요');
  assert.equal(accountTimingState(channel,group,{status:'permitted'},null),'게시 결과 확인 중');
  assert.equal(groupTimingState({...group,activeAttemptId:'attempt'},null),'진행 중 시도 결과 확인 중');
});
test('only a running current-member group ETA produces a next-permit estimate',()=>{
  assert.equal(groupTimingState({status:'running'},63),'다음 계정 허가까지 약 63초');
  assert.equal(groupTimingState({status:'running'},0),'다음 계정 허가 조건 확인 중');
  assert.equal(groupTimingState({status:'running'},null),'연결·설정 조건 확인 중');
  assert.equal(groupTimingState({status:'needs_review'},null),'실제 게시 여부 확인 필요');
});
test('early preparation explains scheduled and actual Discord cooldown waits',()=>{
  const group={status:'running',activeAttemptId:'attempt',waitReason:'scheduled_input_ready'};
  assert.equal(groupTimingState(group,null),'입력 준비 완료 · 예정 시각 대기');
  assert.equal(accountTimingState({id:'binding'},group,{status:'preparing'},null),'입력 준비 완료 · 예정 시각 대기');
  assert.equal(groupTimingState({...group,waitReason:'discord_cooldown'},null),'Discord 실제 제한 해제 대기');
  assert.equal(waitReasonText('discord_cooldown'),'Discord 실제 제한 해제 대기');
});
