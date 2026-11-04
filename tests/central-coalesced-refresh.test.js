import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoalescedRefresh} from '../central/runtime/coalesced-refresh.mjs';
test('종료는 진행 중 알림 저장이 끝난 뒤 완료되어 새 프로세스와 겹치지 않는다',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let finish,closed=false,calls=0;
 const refresh=createCoalescedRefresh(async()=>{calls++;await new Promise(resolve=>{finish=resolve;});});
 refresh.request();t.mock.timers.tick(50);
 const closing=Promise.resolve(refresh.close()).then(()=>{closed=true;});
 await Promise.resolve();assert.equal(closed,false);
 refresh.request();finish();await closing;t.mock.timers.tick(100);
 assert.equal(closed,true);assert.equal(calls,1);
});

test('알림 저장이 진행 중이면 최신 상태 갱신 하나만 예약하고 종료 후 읽지 않는다',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let value=0,finish;const reads=[];
 const refresh=createCoalescedRefresh(async()=>{reads.push(value);if(reads.length===1)await new Promise(resolve=>{finish=resolve;});});
 refresh.request();t.mock.timers.tick(50);assert.deepEqual(reads,[0]);
 for(let i=1;i<=100;i++){value=i;refresh.request();}
 t.mock.timers.tick(500);assert.deepEqual(reads,[0]);
 finish();await Promise.resolve();await Promise.resolve();t.mock.timers.tick(50);assert.deepEqual(reads,[0,100]);
 refresh.request();refresh.close();t.mock.timers.tick(500);assert.deepEqual(reads,[0,100]);
});

test('읽기 실패를 전달한 뒤 후속 요청은 다시 실행하고 닫힌 작업은 재시작하지 않는다',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0,errors=0;
 const refresh=createCoalescedRefresh(()=>{if(++calls===1)throw Error('read failed');},{onError:()=>errors++});
 refresh.request();t.mock.timers.tick(50);await Promise.resolve();assert.equal(errors,1);
 refresh.request();t.mock.timers.tick(50);await Promise.resolve();assert.equal(calls,2);
 refresh.close();refresh.request();t.mock.timers.tick(100);assert.equal(calls,2);
});
