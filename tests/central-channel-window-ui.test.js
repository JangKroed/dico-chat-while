import test from 'node:test';
import assert from 'node:assert/strict';
import {channelVerification,exactRecordedBinding,managedWindowAvailable,managedWindowSeparationAvailable} from '../central/ui/src/channel-window.ts';
import {incidentAdvice} from '../central/ui/src/incident-advice.ts';

const snapshot=()=>({
  instances:[{id:'browser-a',connected:true,lastSeenAt:Date.now(),capabilities:['managed-window-v1']}],
  channels:[{id:'binding-a',instanceId:'browser-a',accountId:'account-a',guildId:'guild',channelId:'channel',tabId:7,verified:false,verificationReason:'tab_missing'}],
  groups:[],
  attempts:[{id:'attempt-a',bindingId:'binding-a'}]
});

test('verification copy identifies the observed cause and never marks an unverified binding ready',()=>{
  const channel=snapshot().channels[0];
  assert.match(channelVerification(channel).title,/탭/);
  assert.match(channelVerification(channel).action,/다시 연결/);
  channel.verificationReason='account_mismatch';
  assert.match(channelVerification(channel).title,/계정 다름/);
  channel.verificationReason='unexpected_reason';
  assert.match(channelVerification(channel).title,/연결 상태 확인 필요/);
  channel.verified=true;
  assert.match(channelVerification(channel).title,/검증됨/);
});

test('window controls require current browser heartbeat and explicit capability',()=>{
  const s=snapshot(),channel=s.channels[0];
  assert.equal(managedWindowAvailable(s,channel),true);
  s.instances[0].lastSeenAt=Date.now()-20000;
  assert.equal(managedWindowAvailable(s,channel),false);
  s.instances[0].lastSeenAt=Date.now();s.instances[0].capabilities=[];
  assert.equal(managedWindowAvailable(s,channel),false);
  s.instances[0].capabilities=['managed-window-v1'];delete channel.tabId;
  assert.equal(managedWindowAvailable(s,channel),false);
});

test('log and incident actions require an exact recorded binding, never an account or channel guess',()=>{
  const s=snapshot();
  assert.equal(exactRecordedBinding(s,{attemptId:'attempt-a'}),s.channels[0]);
  assert.equal(exactRecordedBinding(s,{bindingId:'binding-a'}),s.channels[0]);
  assert.equal(exactRecordedBinding(s,{accountId:'account-a',channelId:'channel'}),undefined);
  assert.equal(exactRecordedBinding(s,{bindingId:'old-binding',attemptId:'attempt-a'}),undefined);
});

test('channel verification incidents explain their recorded cause even if the binding later changes',()=>{
  const s=snapshot();s.channels[0].verified=true;s.channels[0].verificationReason=undefined;
  const advice=incidentAdvice({id:'incident',code:'channel_unverified',bindingId:'binding-a',verificationReason:'script_unavailable'},s);
  assert.equal(advice.page,'channels');
  assert.match(advice.title,/확장 응답 없음/);
  assert.match(advice.cause,/새로고침/);
  assert.equal(advice.knownReason,true);
  const loading=incidentAdvice({id:'loading',code:'channel_unverified',bindingId:'binding-a',verificationReason:'tab_loading'},s);
  assert.match(loading.title,/로딩 중/);
});

test('separation is offered only by connected extensions with the separation capability',()=>{
 const s=snapshot(),channel=s.channels[0];assert.equal(managedWindowSeparationAvailable(s,channel),false);
 s.instances[0].capabilities.push('managed-window-separation-v1');assert.equal(managedWindowSeparationAvailable(s,channel),true);
 s.instances[0].connected=false;assert.equal(managedWindowSeparationAvailable(s,channel),false);
});

test('전송 창 표시 가능 여부도 중앙의 응답 시각으로 판정한다',()=>{
 const s=snapshot();s.serverNow=1700000000000;s.instances[0].lastSeenAt=s.serverNow;
 assert.equal(managedWindowAvailable(s,s.channels[0]),true);
 s.instances[0].lastSeenAt-=16000;
 assert.equal(managedWindowAvailable(s,s.channels[0]),false);
});
