import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverLoading} from '../loading-recovery.js';
const loading={ok:false,code:'EDITOR_LOADING',error:'입력창 없음'};
test('초기 점검 뒤 최대 10번 새로고침하고 최종 오류',async()=>{
 let reloads=0,probes=0,count=0;
 const result=await recoverLoading({probe:async()=>{probes++;return loading;},reload:async()=>reloads++,saveCount:async n=>count=n});
 assert.equal(reloads,10);assert.equal(probes,11);assert.equal(count,10);assert.equal(result.code,'RECOVERY_EXHAUSTED');
});
test('복구 성공 시 종료하고 횟수 초기화',async()=>{
 let reloads=0,count=4;
 const result=await recoverLoading({probe:async()=>reloads===2?{ok:true}:loading,reload:async()=>reloads++,readCount:async()=>count,saveCount:async n=>count=n});
 assert.equal(result.ok,true);assert.equal(reloads,2);assert.equal(count,0);
});
test('worker 재시작 이후 저장된 횟수를 이어 사용한다',async()=>{
 let reloads=0;
 await recoverLoading({probe:async()=>loading,reload:async()=>reloads++,readCount:async()=>9});
 assert.equal(reloads,1);
});
test('초안·잘못된 채널·불확실 전송은 새로고침하지 않는다',async()=>{
 for(const code of ['DRAFT','WRONG_CHANNEL','UNCERTAIN','EDITOR_AMBIGUOUS']){
  const result=await recoverLoading({probe:async()=>({ok:false,code}),reload:async()=>assert.fail('must not reload')});
  assert.equal(result.code,code);
 }
});
test('중지 요청과 탭 닫힘은 복구를 종료한다',async()=>{
 let stopped=false;
 const result=await recoverLoading({probe:async()=>loading,onAttempt:async()=>{stopped=true;},cancelled:()=>stopped,reload:async()=>assert.fail()});
 assert.equal(result.code,'CANCELLED');
 assert.equal((await recoverLoading({probe:async()=>loading,reload:async()=>{throw Error();}})).code,'RECOVERY_RELOAD_FAILED');
});
