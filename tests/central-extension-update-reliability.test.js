import test from 'node:test';
import assert from 'node:assert/strict';
import {createExtensionUpdater,extensionReloadDecision} from '../central/extension/update.js';

const old='a'.repeat(64),next='b'.repeat(64);
test('a failed runtime reload is retried automatically with a persisted bounded budget',async()=>{
 let saved,reloads=0,maintenance=false;
 const issues=[];
 const chrome={storage:{local:{get:async()=>({dicoUpdateReload:saved}),set:async value=>{saved=value.dicoUpdateReload;}}},runtime:{reload(){reloads++;throw Error('transient browser failure');}}};
 const options={chrome,loadedBuildId:old,onIssue:issue=>issues.push(issue),executor:{isIdle:true,beginMaintenance(){maintenance=true;return true;},endMaintenance(){maintenance=false;}},transport:{request:async()=>({buildId:next,reloadSafe:true})}};
 // 서비스 워커가 다시 시작되어도 재시도 예산이 초기화되지 않아야 한다.
 await createExtensionUpdater(options).check({force:true});
 await createExtensionUpdater(options).check({force:true});
 assert.equal(reloads,2);assert.equal(maintenance,false);
 await createExtensionUpdater(options).check({force:true});
 await createExtensionUpdater(options).check({force:true});
 assert.equal(reloads,3);assert.ok(issues.length>0);
});

test('a verified repaired package permits a new reload after an earlier wrong-folder reload marker',()=>{
 assert.equal(extensionReloadDecision({loadedBuildId:old,status:{buildId:next,reloadSafe:true,repairedCopies:1},idle:true,lastRequested:next}).action,'reload');
 assert.equal(extensionReloadDecision({loadedBuildId:old,status:{buildId:next,reloadSafe:true,repairedCopies:0},idle:true,lastRequested:next}).action,'manual');
});
