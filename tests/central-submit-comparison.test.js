import test from 'node:test';
import assert from 'node:assert/strict';
import {compareSubmitTraces} from '../central/runtime/diagnose-discord-submit.mjs';

function sample({sameAccount=true,braveAge=65000,mixedBuild=false}={}) {
 const state={instances:[{id:'chrome',browser:'Chrome'},{id:'brave',browser:'Brave'}],attempts:[]},events=[];
 const last=new Map();
 for(let i=0;i<8;i++){
  const instanceId=i%2?'brave':'chrome',accountId=sameAccount?'private-account':instanceId;
  const delay=instanceId==='brave'?55000:10;
  const first=(last.get(accountId)||100000)+(instanceId==='brave'?braveAge:65000);
  const id='attempt-'+i,finalizedAt=first+delay+100;
  last.set(accountId,finalizedAt);
  state.attempts.push({id,instanceId,accountId,guildId:'private-guild',channelId:'private-channel',revisionId:'private-revision',status:'confirmed',finalizedAt});
  for(const [stage,observedAt,data] of [
   ['before-enter',first,{retryCount:0,networkObserverReady:true,contentBuildId:(mixedBuild&&instanceId==='brave'?'b':'a').repeat(64),pageHidden:true,documentFocused:false,cooldownKnown:true,cooldownMs:0}],
   ['network-start',first+delay,{networkOrdinal:1}],
   ['network-result',first+delay+50,{httpStatus:200,networkOrdinal:1}],
  ])events.push({attemptId:id,stage,observedAt,data});
 }
 return compareSubmitTraces(state,events);
}

test('동일 계정의 비교 조건이 맞아야 브라우저별 지연 패턴을 표시한다',()=>{
 const result=sample();
 assert.equal(result.comparison,'matched_samples_available');
 assert.deepEqual(result.sameAccountChannelComparisons,[{
  Chrome:{samples:3,medianMs:10,delayed:0},Brave:{samples:4,medianMs:55000,delayed:4},pattern:'brave_only',
 }]);
 assert.doesNotMatch(JSON.stringify(result),/private-|attempt-/);
});

test('계정 또는 직전 발송 간격이 다르면 브라우저 원인을 판정하지 않는다',()=>{
 for(const input of [{sameAccount:false},{braveAge:120000},{mixedBuild:true}]){
  const result=sample(input);
  assert.equal(result.observations.Brave.delayed,4);
  assert.equal(result.comparison,'needs_same_account_channel_samples');
  assert.deepEqual(result.sameAccountChannelComparisons,[]);
 }
});
