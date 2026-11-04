import test from 'node:test';
import assert from 'node:assert/strict';
import {secondsUntil,accountTimingState,groupTimingState,waitReasonText,preparationDeadline} from '../central/ui/src/countdown.ts';

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
  assert.equal(accountTimingState(channel,group,undefined,0),'차례 대기');
  assert.equal(accountTimingState(channel,{...group,status:'stopped'},undefined,0),'중지됨');
  assert.equal(groupTimingState({...group,status:'stopped'},0),'중지됨');
});
test('active and unknown attempts never promise another send countdown',()=>{
  const channel={id:'binding',nextEligibleAt:null},group={status:'running',members:['binding'],cursor:0};
  assert.equal(accountTimingState(channel,group,{status:'unknown'},null),'발송 복구 대기');
  assert.equal(accountTimingState(channel,group,{status:'permitted'},null),'발송 확인 중');
  assert.equal(groupTimingState({...group,activeAttemptId:'attempt'},null),'입력 준비 중');
});
test('only a running current-member group ETA produces a next-permit estimate',()=>{
  assert.equal(groupTimingState({status:'running'},63),'입력 준비까지 약 63초');
  assert.equal(groupTimingState({status:'running'},0),'입력 준비 대기');
  assert.equal(groupTimingState({status:'running'},null),'연결·설정 확인 필요');
  assert.equal(groupTimingState({status:'needs_review'},null),'발송 복구 대기');
});
test('early preparation explains scheduled and actual Discord cooldown waits',()=>{
  const group={status:'running',activeAttemptId:'attempt',waitReason:'scheduled_input_ready'};
  assert.equal(groupTimingState(group,null),'입력 준비 완료 · 발송 대기');
  assert.equal(accountTimingState({id:'binding'},group,{status:'preparing'},null),'입력 준비 완료 · 발송 대기');
  assert.equal(groupTimingState({...group,waitReason:'discord_cooldown'},null),'Discord 제한 해제 대기');
  assert.equal(waitReasonText('discord_cooldown'),'Discord 실제 제한 해제 대기');
});

test('stopped accounts suppress residual cooldowns and missing server deadlines',()=>{
 for(const seconds of [0,56,236,null])assert.equal(accountTimingState({id:'a'},{status:'stopped'},undefined,seconds),'중지됨');
 assert.equal(accountTimingState({id:'a'},{status:'paused'},undefined,236),'일시정지됨');
});
test('only the current account shows an input preparation countdown',()=>{
 const group={status:'running',members:['a','b'],cursor:0};
 assert.equal(accountTimingState({id:'a'},group,undefined,58),'입력 준비까지 약 58초');
 assert.equal(accountTimingState({id:'b'},group,undefined,58),'차례 대기');
 assert.equal(accountTimingState({id:'b'},group,undefined,null),'차례 대기');
});
test('input countdown uses group deadline minus supported five-second preparation lead',()=>{
 assert.equal(preparationDeadline(163000,5),158000);
 assert.equal(preparationDeadline(163000,0),163000);
 assert.equal(preparationDeadline(null,5),null);
 assert.equal(secondsUntil(preparationDeadline(163000,5),100000,0,true),58);
});

test('same-attempt retry shows progress instead of a following-turn countdown',()=>{
 const group={status:'running',waitReason:'send_retry',activeAttemptId:'attempt',members:['current','next'],cursor:0};
 assert.equal(groupTimingState(group,60),'현재 계정 전송 재시도 중');
 assert.equal(accountTimingState({id:'current'},group,{status:'permitted'},60),'전송 재시도 중');
 assert.equal(accountTimingState({id:'next'},group,undefined,60),'차례 대기');
});


test('preparation recovery holds the current account and explains its automatic retry',()=>{
 const group={status:'running',waitReason:'preparation_retry',members:['current','next'],cursor:0};
 assert.equal(groupTimingState(group,5),'현재 계정 입력 준비 자동 재시도 중');
 assert.equal(accountTimingState({id:'current'},group,undefined,5),'현재 계정 입력 준비 자동 재시도 중');
 assert.equal(accountTimingState({id:'next'},group,undefined,5),'차례 대기');
 assert.equal(waitReasonText('preparation_failed'),'입력 준비 실패 · 전송 창 확인 필요');
});

test('group and account waits use readable Korean state labels',()=>{
 for(const [reason,expected] of [['group_interval','그룹 최소 간격 대기'],['account_interval','계정 주기 대기'],['preparing','입력 준비 중'],['delivery_unknown','발송 복구 대기'],['manual_resume','실행 조건 다시 확인 필요']])assert.equal(waitReasonText(reason),expected);
});


test('authorization recovery waits describe automatic progress for the current attempt',()=>{
 const group={status:'running',waitReason:'authorization_retry',activeAttemptId:'attempt',members:['current','next'],cursor:0};
 assert.equal(waitReasonText('authorization_retry'),'전송 허가 연결 자동 복구 중');
 assert.equal(groupTimingState(group,null),'전송 허가 연결 자동 복구 중');
 assert.equal(accountTimingState({id:'current'},group,{status:'permitted'},null),'전송 허가 연결 자동 복구 중');
 assert.equal(accountTimingState({id:'next'},group,undefined,null),'차례 대기');
});

test('system-paused groups explain automatic recovery without a send countdown',()=>{
 const autoResume={reasonCode:'connection_lost',requestedAt:1000,retryCount:0};
 for(const status of ['paused','pause_pending','resume_required','needs_review']){
  const group={status,autoResume,members:['a'],cursor:0};
  assert.equal(groupTimingState(group,12),'자동 복구 중 · 정상 확인 후 재개');
  assert.equal(accountTimingState({id:'a'},group,undefined,12),'자동 복구 중 · 정상 확인 후 재개');
  assert.equal(groupTimingState({...group,activeAttemptId:'unknown-attempt'},12),'발송 결과 확인 중 · 자동 복구 대기');
  assert.equal(accountTimingState({id:'a'},{...group,activeAttemptId:'unknown-attempt'},{status:'unknown'},12),'발송 결과 확인 중 · 자동 복구 대기');
 }
 assert.equal(groupTimingState({status:'paused'},12),'일시정지됨');
 assert.equal(groupTimingState({status:'stopped'},12),'중지됨');
});
