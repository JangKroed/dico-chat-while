import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticEvents,recordDiagnostics} from '../diagnostics.js';
const before={channels:[{id:'1',enabled:true,messages:['SECRET','SECRET'],name:'PRIVATE',ownUserId:'USER',target:{url:'PRIVATE_URL'}}]};
test('자동 중지와 사용자 중지를 구분하고 비공개 필드를 제외한다',()=>{
 const after=structuredClone(before);after.channels[0].enabled=false;after.channels[0].error='연결 끊김';
 const events=diagnosticEvents(before,after,0);
 assert.deepEqual(events.map(e=>e.kind),['error','automatic-stop']);
 assert.equal(/SECRET|PRIVATE|USER/.test(JSON.stringify(events)),false);
 assert.equal(diagnosticEvents(after,after).length,0);
 after.channels[0].error=null;
 assert.equal(diagnosticEvents(before,after)[0].kind,'stopped');
});
test('진단 로그는 최근 500개로 제한된다',async()=>{
 let saved;
 const api={storage:{local:{get:async()=>({diagnosticLog:Array(500).fill({kind:'old'})}),set:async value=>{saved=value;}}}};
 const after=structuredClone(before);after.channels[0].error='오류';
 await recordDiagnostics(api,before,after);
 assert.equal(saved.diagnosticLog.length,500);
 assert.equal(saved.diagnosticLog.at(-1).kind,'error');
});

test('미검증 시도를 전송 성공으로 기록하지 않는다',()=>{
 const before={channels:[{id:'a',enabled:true,pending:{id:'delivery'},lastSentAt:null}]};
 const after={channels:[{id:'a',enabled:true,pending:null,lastSentAt:100,lastOutcome:'unverified'}]};
 const events=diagnosticEvents(before,after);assert.ok(events.some(e=>e.kind==='delivery-unverified'));
 assert.equal(events.some(e=>e.kind==='delivery-confirmed'),false);
});
