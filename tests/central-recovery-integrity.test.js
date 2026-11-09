import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecoveryScheduler} from '../central/extension/recovery-scheduler.js';
import {recoverConnections} from '../central/extension/connection-recovery.js';
const missing={sessionId:'s',account:{accountId:'a',verified:true},channels:[{accountId:'a',guildId:'g',channelId:'c',tabId:1,verificationReason:'tab_missing'}]};
test('blocked recovery preserves repair budget and reports no successful repair',async()=>{
 const scheduler=createRecoveryScheduler();scheduler.observe(missing);
 assert.equal(await scheduler.run({safe:()=>true,repair:async()=>({status:'blocked',attempted:false,reasonCode:'ATTEMPT_UNRESOLVED'})}),false);
 assert.equal(scheduler.state.attempts,0);
});
test('recovery uses exponential bounded backoff',async()=>{
 let time=0,calls=0;const scheduler=createRecoveryScheduler({now:()=>time});scheduler.observe(missing);
 const run=()=>scheduler.run({safe:()=>true,repair:async()=>{calls++;throw Error('temporary');}});
 await run();time=10000;await run();time=20000;await run();assert.equal(calls,2);
 time=30000;await run();assert.equal(calls,3);time=900000;await run();assert.equal(calls,4);
});
test('account observation flapping does not refill exhausted budget',async()=>{
 let time=0;const scheduler=createRecoveryScheduler({now:()=>time,maxAttempts:1});scheduler.observe(missing);
 await scheduler.run({safe:()=>true,repair:async()=>{throw Error('temporary');}});
 scheduler.observe({...missing,account:{accountId:'a',verified:false}});scheduler.observe(missing);time=100000;
 assert.equal(await scheduler.run({safe:()=>true,repair:async()=>{}}),false);
});
test('session change while account lookup waits prevents stale recovery effects',async()=>{
 const state={sessionId:'old',resetEpoch:0,legacyDeclaration:'fresh',attempts:{}};let writes=0,opens=0;
 const result=await recoverConnections({state,chrome:{storage:{local:{get:async()=>({dicoCentralTabs:[{accountId:'a',guildId:'g',channelId:'c',tabId:1}]}),set:async()=>writes++}},tabs:{get:async()=>{throw Error('missing');}}},findAccount:async()=>{state.sessionId='new';return{verified:true,accountId:'a'};},openChannel:async()=>opens++,report:async()=>{}});
 assert.equal(writes,0);assert.equal(opens,0);assert.equal(result.status,'cancelled');
});
test('stop during progress suppresses remaining account work',async()=>{
 const state={sessionId:'s',legacyDeclaration:'fresh',attempts:{}};let lookups=0;
 const result=await recoverConnections({state,chrome:{storage:{local:{get:async()=>({dicoCentralAccount:{accountId:'a'},dicoCentralTabs:[]})}}},findAccount:async()=>{lookups++;return{verified:true,accountId:'a'};},report:async()=>{state.emergencyStopped=true;}});
 assert.equal(lookups,0);assert.equal(result.status,'cancelled');
});

import {readFile} from 'node:fs/promises';
const background=await readFile(new URL('../central/extension/background.js',import.meta.url),'utf8');
function backgroundFunction(name,next,deps){
 const source=background.slice(background.indexOf(`async function ${name}(`),background.indexOf(`async function ${next}(`));
 if(name==='runHeartbeat'&&!deps.maintenance)deps.maintenance=async()=>{await deps.refreshManagedContent?.();try{await deps.observation?.();}catch{}};
 return new Function(...Object.keys(deps),`${source};return ${name};`)(...Object.values(deps));
}
test('real background opener cleans up creation completed after emergency stop without persisting tabs',async()=>{
 const state={sessionId:'s',resetEpoch:0,legacyDeclaration:'fresh',attempts:{}};let writes=0;const removed=[];
 const p={accountId:'12345678901234567',guildId:'2',channelId:'3'};
 const chrome={storage:{local:{get:async()=>({dicoCentralAccount:{accountId:p.accountId},dicoCentralTabs:[]}),set:async()=>writes++}},tabs:{query:async()=>[],remove:async id=>removed.push(id)}};
 const open=backgroundFunction('openManagedChannelNow','bindActive',{executor:{state},transport:{connected:true},chrome,currentRegistration:s=>s,currentAccount:async()=>true,createManagedWindow:async()=>{state.emergencyStopped=true;return{id:8,tabs:[{id:9}]};}});
 await assert.rejects(open(p),{code:'STALE_SESSION'});assert.equal(writes,0);assert.deepEqual(removed,[9]);
});
test('real background heartbeat discards a response from the previous session',async()=>{
 const state={sessionId:'old',attempts:{a:{attemptId:'a',phase:'unknown'}}};let saves=0,commands=0;
 const executor={state,request:async()=>{state.sessionId='new';return{terminalAttempts:[{attemptId:'a',status:'confirmed'}],commands:[{type:'SEND'}]};},save:async()=>saves++,handleCommand:()=>commands++};
 const run=backgroundFunction('runHeartbeat','connect',{executor,transport:{connected:true},updater:{check:async()=>{}}});
 await run();assert.equal(state.attempts.a.phase,'unknown');assert.equal(saves,0);assert.equal(commands,0);
});
test('late repair completion cannot consume a new missing-target budget',async()=>{
 let finish;const scheduler=createRecoveryScheduler();scheduler.observe(missing);
 const run=scheduler.run({safe:()=>true,repair:()=>new Promise(resolve=>{finish=resolve;})});
 scheduler.observe({...missing,sessionId:'new'});finish({status:'completed',attempted:true});
 assert.equal(await run,false);assert.equal(scheduler.state.attempts,0);assert.equal(scheduler.state.nextAt,0);
});
test('resolved safety blocker resumes automatically after throttle without a reconnect',async()=>{
 let time=0,allowed=false,opened=0;const scheduler=createRecoveryScheduler({now:()=>time});scheduler.observe(missing);
 const run=()=>scheduler.run({safe:()=>true,repair:async()=>allowed?(opened++,{status:'completed',attempted:true}):{status:'blocked',attempted:false}});
 await run();time=5000;allowed=true;assert.equal(await run(),false);time=10000;assert.equal(await run(),true);assert.equal(opened,1);
});
import {createManagedWindow,ensureConsolidatedManagedWindow} from '../central/extension/managed-windows.js';
test('managed window helper cancels before creation if stop happens during storage read',async()=>{
 let stopped=false,created=0;const chrome={storage:{local:{get:async()=>{stopped=true;return{};}}},windows:{create:async()=>created++}};
 await assert.rejects(createManagedWindow(chrome,{guildId:'g',channelId:'c'},()=>{if(stopped)throw Error('stop');}),/stop/);assert.equal(created,0);
});
test('managed window helper cleans up only newly created tab and does not save after stop',async()=>{
 let stopped=false,writes=0;const removed=[];const chrome={storage:{local:{get:async()=>({}),set:async()=>writes++}},windows:{create:async()=>{stopped=true;return{id:7,tabs:[{id:8}]};}},tabs:{remove:async id=>removed.push(id)}};
 await assert.rejects(createManagedWindow(chrome,{guildId:'g',channelId:'c'},()=>{if(stopped)throw Error('stop');}),/stop/);assert.equal(writes,0);assert.deepEqual(removed,[8]);
});
test('managed consolidation cancels moves after stop during tab lookup',async()=>{
 let stopped=false,created=0,moved=0;const record={tabId:1,accountId:'a',guildId:'g',channelId:'c'};
 const chrome={storage:{local:{get:async()=>({dicoCentralTabs:[record]})}},tabs:{get:async()=>{stopped=true;return{id:1,windowId:2,url:'https://discord.com/channels/g/c'};},move:async()=>moved++},windows:{create:async()=>created++}};
 await assert.rejects(ensureConsolidatedManagedWindow(chrome,record,()=>{if(stopped)throw Error('stop');}),/stop/);assert.equal(created,0);assert.equal(moved,0);
});
test('stopped heartbeat still reconciles control-plane resume command without recovery',async()=>{
 const state={sessionId:'s',emergencyStopped:true,attempts:{}};let requests=0,commands=0;
 const executor={state,request:async()=>{requests++;return{commands:[{type:'CONTROL',action:'resume'}]};},save:async()=>{},handleCommand:()=>{commands++;}};
 const run=backgroundFunction('runHeartbeat','connect',{executor,transport:{connected:true},updater:{check:async()=>{}}});
 await run();assert.equal(requests,1);assert.equal(commands,1);
});
test('heartbeat checks update while stopped and before failing observation',async()=>{
 for(const stopped of [true,false]){
  const events=[];const state={sessionId:'s',emergencyStopped:stopped,attempts:{}};
  const executor={state,request:async()=>({commands:[]}),save:async()=>{}};
  const run=backgroundFunction('runHeartbeat','connect',{executor,transport:{connected:true,disconnect:()=>events.push('disconnect')},updater:{check:async()=>events.push('update')},refreshManagedContent:async()=>{},observation:async()=>{events.push('observe');throw Error('failed');}});
  await run();assert.equal(events[0],'update');if(!stopped)assert.ok(events.includes('observe'));
 }
});

test('느린 업데이트 조회 중에도 heartbeat와 중지 명령 수신을 진행한다',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});let heartbeats=0,commands=0;
 const state={sessionId:'s',emergencyStopped:true,attempts:{}};
 const executor={state,request:async()=>{heartbeats++;return{commands:[{type:'CONTROL'}]};},save:async()=>{},handleCommand:()=>commands++};
 const run=backgroundFunction('runHeartbeat','connect',{executor,transport:{connected:true},updater:{check:()=>gate}});
 const running=run();await new Promise(resolve=>setImmediate(resolve));
 const observed={heartbeats,commands};release();await running;
 assert.deepEqual(observed,{heartbeats:1,commands:1});
});


test('느린 탭 관찰 중에도 다음 heartbeat와 중지 명령을 처리한다',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});let requests=0,commands=0,observations=0;
 const executor={state:{sessionId:'s',attempts:{}},request:async()=>{requests++;return{commands:[{type:'CONTROL'}]};},save:async()=>{},handleCommand:()=>commands++};
 const deps={executor,transport:{connected:true,disconnect:()=>{}},updater:{check:async()=>{}},refreshManagedContent:async()=>{},observation:async()=>{observations++;await gate;},automaticRecovery:{run:async()=>{}},lastError:null,connecting:null};
 // 실제 background 함수로 느린 관찰이 연결 유지 요청을 붙잡는지 확인합니다.
 const source=background.slice(background.indexOf('async function runHeartbeat()'),background.indexOf('async function connect('));
 const maintenanceSource=background.includes('async function runMaintenance()')?background.slice(background.indexOf('async function runMaintenance()'),background.indexOf('async function runHeartbeat()')):'';
 const {createSingleFlight}=await import('../central/extension/observation-queue.js');
 const run=new Function(...Object.keys(deps),'createSingleFlight',`${maintenanceSource};const maintenance=typeof runMaintenance==='function'?createSingleFlight(runMaintenance):undefined;${source};return createSingleFlight(runHeartbeat);`)(...Object.values(deps),createSingleFlight);
 const first=run();await new Promise(resolve=>setImmediate(resolve));const second=run();await new Promise(resolve=>setImmediate(resolve));
 const observed={requests,commands,observations};release();await Promise.all([first,second]);
 assert.deepEqual(observed,{requests:2,commands:2,observations:1});
});

test('탭 검사 오류는 정상 Native 연결을 해제하지 않고 다음 관찰을 허용한다',async()=>{
 let disconnected=0,observed=0;
 const deps={executor:{state:{sessionId:'s'},isMaintenanceIdle:true},transport:{connected:true,disconnect:()=>disconnected++},connecting:null,lastError:null,refreshManagedContent:async()=>{},observation:async()=>{observed++;throw Error('tab temporarily unavailable');}};
 const run=backgroundFunction('runMaintenance','runHeartbeat',deps);
 await run();await run();assert.equal(observed,2);assert.equal(disconnected,0);
});
test('탭 확인 도중 세션이 바뀌면 이전 세션의 복구를 실행하지 않는다',async()=>{
 let repaired=0;const executor={state:{sessionId:'old'},isMaintenanceIdle:true};
 const run=backgroundFunction('runMaintenance','runHeartbeat',{executor,transport:{connected:true},connecting:null,lastError:null,refreshManagedContent:async()=>{},observation:async()=>{executor.state.sessionId='new';},automaticRecovery:{run:async()=>repaired++}});
 await run();assert.equal(repaired,0);
});
