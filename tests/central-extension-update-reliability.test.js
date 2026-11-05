import test from 'node:test';
import assert from 'node:assert/strict';
import {createExtensionUpdater,extensionReloadDecision} from '../central/extension/update.js';

const old='a'.repeat(64),next='b'.repeat(64);
test('벽시계 후퇴는 reload 실패 횟수를 보존하고 재시도 시각만 다시 잡는다',async()=>{
 let time=1000,reloads=0,saved={buildId:next,failed:true,failures:9,requestedAt:500000,retryAfterAt:800000};
 const options={now:()=>time,loadedBuildId:old,executor:{isIdle:true,beginMaintenance:()=>true,endMaintenance(){}},chrome:{storage:{local:{get:async()=>({dicoUpdateReload:saved}),set:async v=>{saved=v.dicoUpdateReload;}}},runtime:{reload:()=>reloads++}},transport:{request:async()=>({buildId:next,reloadSafe:true})}};
 const updater=createExtensionUpdater(options);await updater.check();assert.equal(reloads,0);assert.equal(saved.failures,9);assert.equal(saved.retryAfterAt,time+30000);
 time+=30000;await updater.check();assert.equal(reloads,1);
});
test('자동 reload 3회 초과 실패 뒤에도 영속 백오프를 지키고 조건 회복 시 전환한다',async()=>{
 let time=1000,saved,reloads=0,fail=true;const executor={isIdle:true,beginMaintenance:()=>true,endMaintenance(){}};
 const options={now:()=>time,loadedBuildId:old,executor,chrome:{storage:{local:{get:async()=>({dicoUpdateReload:saved}),set:async v=>{saved=v.dicoUpdateReload;}}},runtime:{reload(){reloads++;if(fail)throw Error('temporary');}}},transport:{request:async()=>({buildId:next,reloadSafe:true})}};
 for(let n=0;n<7;n++){
  await createExtensionUpdater(options).check({force:true});assert.equal(reloads,n+1);
  assert.ok(saved.retryAfterAt>time);assert.ok(saved.retryAfterAt-time<=300000);
  await createExtensionUpdater(options).check({force:true});assert.equal(reloads,n+1,'워커 재시작/강제 점검도 백오프를 건너뛰지 않습니다.');
  time=saved.retryAfterAt;
 }
 fail=false;await createExtensionUpdater(options).check({force:true});assert.equal(reloads,8);assert.equal(saved.failed,undefined);
});
test('실패한 runtime reload는 워커 재시작 뒤에도 횟수·대기 시각을 보존한다',async()=>{
 let time=1000,saved,reloads=0,maintenance=false;const issues=[];
 const chrome={storage:{local:{get:async()=>({dicoUpdateReload:saved}),set:async v=>{saved=v.dicoUpdateReload;}}},runtime:{reload(){reloads++;throw Error('transient browser failure');}}};
 const options={now:()=>time,chrome,loadedBuildId:old,onIssue:i=>issues.push(i),executor:{isIdle:true,beginMaintenance(){maintenance=true;return true;},endMaintenance(){maintenance=false;}},transport:{request:async()=>({buildId:next,reloadSafe:true})}};
 for(let n=0;n<4;n++){
  await createExtensionUpdater(options).check({force:true});assert.equal(reloads,n+1);assert.equal(maintenance,false);assert.equal(saved.failures,n+1);
  const due=saved.retryAfterAt;time=due-1;await createExtensionUpdater(options).check({force:true});assert.equal(reloads,n+1);time=due;
 }
 assert.equal(issues.length,4);
});

test('a verified repaired package permits a new reload after an earlier wrong-folder reload marker',()=>{
 assert.equal(extensionReloadDecision({loadedBuildId:old,status:{buildId:next,reloadSafe:true,repairedCopies:1},idle:true,lastRequested:next}).action,'reload');
 assert.equal(extensionReloadDecision({loadedBuildId:old,status:{buildId:next,reloadSafe:true,repairedCopies:0},idle:true,lastRequested:next}).action,'manual');
});
