import test from 'node:test';
import assert from 'node:assert/strict';
import {submitAndRefresh,createPendingActions} from '../central/ui/src/action-feedback.ts';

test('접수 성공 뒤 갱신만 실패하면 명령 실패로 바꾸거나 재전송하지 않는다',async()=>{
 let sends=0;const result=await submitAndRefresh(async()=>{sends++;return{id:'accepted'};},async()=>{throw Error('snapshot unavailable');});
 assert.equal(sends,1);assert.equal(result.refreshed,false);assert.equal(result.response.id,'accepted');
});
test('명령 실패는 숨기지 않고 화면 갱신을 성공 근거로 사용하지 않는다',async()=>{
 let refreshed=false;await assert.rejects(submitAndRefresh(async()=>{throw Error('rejected');},async()=>{refreshed=true;}),/rejected/);assert.equal(refreshed,false);
});
test('저장 중에도 중단을 접수하며 중복 클릭과 작업 진행 상태를 분리한다',()=>{
 const pending=createPendingActions();assert.equal(pending.begin('save'),true);assert.equal(pending.begin('stop'),true);assert.equal(pending.begin('stop'),false);
 pending.end('stop');assert.equal(pending.size,1);assert.equal(pending.has('save'),true);pending.end('save');assert.equal(pending.size,0);
});
