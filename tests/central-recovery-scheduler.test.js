import test from 'node:test';import assert from 'node:assert/strict';
import {createRecoveryScheduler} from '../central/extension/recovery-scheduler.js';
const missing={account:{verified:true},channels:[{accountId:'a',guildId:'g',channelId:'c',tabId:1,verified:false,verificationReason:'tab_missing'}]};
test('연결 중 사라진 관리 탭은 사용자 재연결 없이 복구를 예약한다',async()=>{
 const scheduler=createRecoveryScheduler();let calls=0;scheduler.observe(missing);
 assert.equal(await scheduler.run({safe:()=>true,repair:async()=>calls++}),true);assert.equal(calls,1);
});
test('발송 미확인/실행 중에는 복구 횟수를 소비하거나 탭을 교체하지 않는다',async()=>{
 const scheduler=createRecoveryScheduler();scheduler.observe(missing);let calls=0;
 assert.equal(await scheduler.run({safe:()=>false,repair:async()=>calls++}),false);assert.equal(calls,0);assert.equal(scheduler.state.attempts,0);
});
test('동일 장애는 간격과 횟수를 제한하고 정상 복구 이후 새 장애만 다시 시도한다',async()=>{
 let time=0,calls=0;const scheduler=createRecoveryScheduler({now:()=>time});const run=()=>scheduler.run({safe:()=>true,repair:async()=>calls++});
 scheduler.observe(missing);await run();await run();assert.equal(calls,1);
 for(let i=0;i<4;i++){time+=10000;scheduler.observe(missing);await run();}assert.equal(calls,3);
 scheduler.observe({channels:[]});scheduler.observe(missing);await run();assert.equal(calls,4);
});
test('사용자가 다른 채널로 이동했거나 계정이 미확인일 때 탭을 복원하지 않는다',async()=>{
 for(const snapshot of [{...missing,account:{verified:false}},{channels:[{...missing.channels[0],verificationReason:'target_mismatch'}]}]){
 const scheduler=createRecoveryScheduler();scheduler.observe(snapshot);assert.equal(await scheduler.run({safe:()=>true,repair:async()=>{throw Error('should not run');}}),false);
 }
});
test('복구 자체의 일시 실패가 하트비트 연결 종료로 전파되지 않는다',async()=>{
 const scheduler=createRecoveryScheduler();scheduler.observe(missing);assert.equal(await scheduler.run({safe:()=>true,repair:async()=>{throw Error('temporary');}}),false);assert.equal(scheduler.state.running,false);assert.equal(scheduler.state.attempts,1);
});

test('관찰 예약이 실제 저장 연결 복구 함수를 호출해 누락 탭을 복원한다',async()=>{
 const {recoverConnections}=await import('../central/extension/connection-recovery.js');const opened=[];
 const record=missing.channels[0],state={legacyDeclaration:'fresh',emergencyStopped:false,attempts:{}};
 const chrome={storage:{local:{get:async()=>({dicoCentralAccount:{accountId:'a'},dicoCentralTabs:[record]})}},tabs:{get:async()=>{throw Error('missing');}}};
 const scheduler=createRecoveryScheduler();scheduler.observe(missing);
 await scheduler.run({safe:()=>true,repair:()=>recoverConnections({chrome,state,findAccount:async()=>({verified:true,accountId:'a'}),openChannel:async record=>opened.push(record),report:async()=>{}})});
 assert.equal(opened.length,1);assert.equal(opened[0].channelId,'c');
});
test('다른 페이지로 이동한 탭은 보존하면서 두 목적지를 다시 연결한다',async()=>{
 const {recoverConnections}=await import('../central/extension/connection-recovery.js');const opened=[],moved=[];
 const first={accountId:'a',guildId:'g',channelId:'first',tabId:1},second={accountId:'a',guildId:'g',channelId:'second',tabId:2};
 await recoverConnections({onlyMissing:true,chrome:{storage:{local:{get:async()=>({dicoCentralAccount:{accountId:'a'},dicoCentralTabs:[first,second]})}},tabs:{get:async id=>{if(id===1)return{url:'https://example.com'};throw Error('missing');}}},state:{legacyDeclaration:'fresh',attempts:{}},findAccount:async()=>({verified:true,accountId:'a'}),openChannel:async record=>opened.push(record),ensureManagedWindow:async record=>moved.push(record),report:async()=>{}});
 assert.deepEqual(opened,[first,second]);assert.deepEqual(moved,[]);
});
test('계정이 확인된 주소 불일치는 기존 탭을 보존하는 재탐색을 예약한다',async()=>{
 const scheduler=createRecoveryScheduler();let calls=0;
 scheduler.observe({...missing,channels:[{...missing.channels[0],verificationReason:'target_mismatch'}]});
 assert.equal(await scheduler.run({safe:()=>true,repair:async()=>calls++}),true);assert.equal(calls,1);
});
