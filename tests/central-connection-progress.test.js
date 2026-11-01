import test from 'node:test';
import assert from 'node:assert/strict';
import {browserDisplayName,connectionProgress} from '../central/ui/src/connection-progress.ts';
const instance={id:'i',name:'Brave',connected:true,lastSeenAt:Date.now(),legacyFrozen:true,legacyPending:false};
const s={channels:[{id:'c',instanceId:'i',verified:false,playlist:[{}],configVersion:1,appliedVersion:1}],accounts:[{instanceId:'i',verified:true}]};
test('progress never reports completion for unverified channels or unapplied configuration',()=>{assert.equal(connectionProgress(s,instance).label,'채널 확인 중 · 0/1');s.channels[0].verified=true;assert.equal(connectionProgress(s,instance).label,'연결·설정 완료');s.channels[0].appliedVersion=0;assert.equal(connectionProgress(s,instance).label,'메시지 선택·설정 적용 확인 중');});
test('a stopped browser and unresolved previous delivery remain visibly incomplete',()=>{assert.equal(connectionProgress(s,{...instance,connected:false}).label,'브라우저 연결 대기');assert.equal(connectionProgress(s,{...instance,connectionProgress:{stage:'blocked',reasonCode:'ATTEMPT_UNRESOLVED'}}).label,'이전 발송 결과 확인 필요');});
test('a blocked legacy executor cannot be declared ready even with all channel evidence',()=>{
  const readySnapshot={...s,channels:[{...s.channels[0],verified:true,appliedVersion:1}]};
  const ready=connectionProgress(readySnapshot,instance);
  assert.equal(ready.ready,true);assert.equal(ready.completed,4);
  const blocked=connectionProgress(readySnapshot,{...instance,legacyFrozen:false});
  assert.equal(blocked.ready,false);assert.equal(blocked.steps.at(-1),true);
  assert.equal(blocked.completed,4);
  const unresolved=connectionProgress(readySnapshot,{...instance,connectionProgress:{stage:'blocked',reasonCode:'ATTEMPT_UNRESOLVED'}});
  assert.equal(unresolved.ready,false);assert.equal(unresolved.completed,4);
  assert.equal(connectionProgress(readySnapshot,{...instance,connectionProgress:{stage:'blocked',reasonCode:'OTHER'}}).label,'연결 차단 원인 확인 필요');
});
test('browser names remove only known automatic linked prefixes and preserve custom aliases',()=>{
  assert.equal(browserDisplayName({name:'연결된 Brave',browser:'Brave'}),'Brave');
  assert.equal(browserDisplayName({name:'연결된 Chrome',browser:'Chrome',nameCustomized:true}),'연결된 Chrome');
  assert.equal(browserDisplayName({name:'Chrome 업무 프로필',browser:'Chrome'}),'Chrome 업무 프로필');
  assert.equal(browserDisplayName({name:'Connected browser',browser:'Chrome'}),'Chrome');
});
test('browser status uses snapshot observation time when the service provides it',()=>{
  const capturedAt=Date.UTC(2025,0,1);
  const captured={...s,serverNow:capturedAt,channels:[{...s.channels[0],verified:true,appliedVersion:1}]};
  const state=connectionProgress(captured,{...instance,lastSeenAt:capturedAt-1000});
  assert.equal(state.steps[0],true);
  assert.equal(state.ready,true);
});
