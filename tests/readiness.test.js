import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForReady, tabReadiness } from '../readiness.js';
test('페이지 로딩 뒤 늦게 나타난 입력창을 기다린다', async()=>{
 let calls=0;
 const result=await waitForReady(async()=>++calls<3?{ok:false,code:'EDITOR_LOADING',retryable:true,error:'아직 없음'}:{ok:true}, {sleep:async()=>{}});
 assert.equal(result.ok,true);assert.equal(calls,3);
});
test('초안·권한·복수 입력창 오류는 반복하지 않는다',async()=>{
 let calls=0; const result=await waitForReady(async()=>{calls++;return {ok:false,error:'초안 있음'};},{sleep:async()=>{}});
 assert.equal(calls,1);assert.equal(result.error,'초안 있음');
});
test('준비 대기 중 취소하면 더 진행하지 않는다',async()=>{
 let calls=0;const result=await waitForReady(async()=>{calls++;return {ok:false,retryable:true};},{sleep:async()=>{},cancelled:()=>calls===1});
 assert.equal(calls,1);assert.equal(result.code,'CANCELLED');
});
test('입력창이 끝내 없으면 진단 정보를 보존하고 끝낸다',async()=>{
 let calls=0;const result=await waitForReady(async()=>{calls++;return {ok:false,retryable:true,code:'EDITOR_LOADING',error:'입력창 0개'};},{attempts:3,sleep:async()=>{}});
 assert.equal(calls,3);assert.match(result.error,/입력창 0개/);assert.equal(result.retryable,false);
});

const target = {guildId:'123',channelId:'456'};
const url = 'https://discord.com/channels/123/456';
test('새 전용 창은 주소가 확정될 때까지 입력하지 않고 기다린다',()=>{
 for (const tab of [{url:'',pendingUrl:url,status:'loading'}, {url:'about:blank',pendingUrl:url,status:'loading'}, {url:'',status:'loading'}, {url,status:'loading'}, {url:'https://discord.com/login',pendingUrl:url,status:'loading'}]) {
  assert.equal(tabReadiness(tab,target).code,'PAGE_LOADING');
  assert.equal(tabReadiness(tab,target).retryable,true);
 }
 assert.deepEqual(tabReadiness({url,status:'complete'},target),{ok:true});
});
test('다른 채널로 이동 중이거나 로그인 화면에 도착하면 전송을 차단한다',()=>{
 for (const tab of [{url,pendingUrl:'https://discord.com/channels/123/999',status:'loading'}, {url:'https://discord.com/login',status:'complete'}, {url:'about:blank',status:'complete'}, {url:'https://discord.com/channels/123/999',status:'loading'}]) {
  assert.equal(tabReadiness(tab,target).code,'WRONG_CHANNEL');
  assert.equal(tabReadiness(tab,target).retryable,undefined);
 }
 assert.equal(tabReadiness(undefined,target).code,'TAB_MISSING');
 assert.equal(tabReadiness({url,frozen:true},target).code,'TAB_SUSPENDED');
});
