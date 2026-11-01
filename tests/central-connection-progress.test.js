import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionProgress} from '../central/ui/src/connection-progress.ts';
const instance={id:'i',name:'Brave',connected:true,lastSeenAt:Date.now(),legacyFrozen:true,legacyPending:false};
const s={channels:[{id:'c',instanceId:'i',verified:false,playlist:[{}],configVersion:1,appliedVersion:1}],accounts:[{instanceId:'i',verified:true}]};
test('progress never reports completion for unverified channels or unapplied configuration',()=>{assert.equal(connectionProgress(s,instance).label,'채널 확인 중 · 0/1');s.channels[0].verified=true;assert.equal(connectionProgress(s,instance).label,'연결·설정 완료');s.channels[0].appliedVersion=0;assert.equal(connectionProgress(s,instance).label,'메시지 선택·설정 적용 확인 중');});
test('a stopped browser and unresolved previous delivery remain visibly incomplete',()=>{assert.equal(connectionProgress(s,{...instance,connected:false}).label,'브라우저 연결 대기');assert.equal(connectionProgress(s,{...instance,connectionProgress:{stage:'blocked',reasonCode:'ATTEMPT_UNRESOLVED'}}).label,'이전 발송 결과 확인 필요');});
