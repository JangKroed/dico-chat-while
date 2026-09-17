import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticRequest} from '../diagnostic-request.js';
test('실제 transport 예외의 이름·내용·stack을 기록한다',async()=>{
 const records=[];
 await assert.rejects(diagnosticRequest(()=>{throw new TypeError('port closed')},{timeoutMs:100,operation:'prepare',record:e=>records.push(e)}),/port closed/);
 assert.deepEqual(records.map(e=>e.stage),['request','rejected']);
 assert.equal(records[1].exception.name,'TypeError');assert.match(records[1].exception.stack,/port closed/);
});
test('시간 초과 이후 늦은 응답도 보존하고 로깅 실패는 전송 결과에 영향을 주지 않는다',async()=>{
 const records=[];let release;
 await assert.rejects(diagnosticRequest(()=>new Promise(r=>release=r),{timeoutMs:5,operation:'prepare',record:e=>records.push(e)}),/응답 시간 초과/);
 release({status:'prepared'});await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(records.map(e=>e.stage),['request','timeout','late-response']);
 assert.equal((await diagnosticRequest(()=>({status:'confirmed'}),{timeoutMs:100,operation:'send',record:()=>{throw Error('disk')}})).status,'confirmed');
});
