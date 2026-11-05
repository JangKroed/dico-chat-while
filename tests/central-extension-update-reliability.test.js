import test from 'node:test';
import assert from 'node:assert/strict';
import {createExtensionUpdater,extensionReloadDecision} from '../central/extension/update.js';

const old='a'.repeat(64),next='b'.repeat(64);
function fixture(){
 let time=1000,reloads=0,idle=true,repairedCopies=0,maintenance=false,fail=true;
 const settings={account:'keep',channels:['1/2'],messages:['본문'],groups:['group']};
 const chrome={storage:{local:{get:async()=>({...settings}),set:async value=>{Object.assign(settings,value);}}},runtime:{reload(){reloads++;if(fail)throw Error('transient browser failure');}}};
 const options={chrome,now:()=>time,loadedBuildId:old,executor:{get isIdle(){return idle;},beginMaintenance(){maintenance=true;return true;},endMaintenance(){maintenance=false;}},transport:{request:async()=>({buildId:next,reloadSafe:true,repairedCopies})}};
 return {options,settings,get saved(){return settings.dicoUpdateReload;},get reloads(){return reloads;},get maintenance(){return maintenance;},advance(ms){time+=ms;},setIdle(value){idle=value;},repair(){repairedCopies=1;},repaired(){repairedCopies=0;},succeed(){fail=false;}};
}
test('일시 reload 실패는 3회를 넘어 자동 복구하며 워커 재생성·강제 확인도 저장한 대기를 지킨다',async()=>{
 const f=fixture();
 for(let attempt=1;attempt<=6;attempt++){
  await createExtensionUpdater(f.options).check({force:true});
  assert.equal(f.reloads,attempt);assert.equal(f.maintenance,false);
  assert.equal(f.saved.failed,true);
  await createExtensionUpdater(f.options).check({force:true});assert.equal(f.reloads,attempt,'워커 재생성도 즉시 재시도하지 않는다');
  f.advance(300000);
 }
 f.succeed();await createExtensionUpdater(f.options).check({force:true});assert.equal(f.reloads,7);
 const {dicoUpdateReload,...preserved}=f.settings;assert.deepEqual(preserved,{account:'keep',channels:['1/2'],messages:['본문'],groups:['group']});
});
test('폴더 복구 때 로컬이 바빠도 복구 신호를 저장해 다음 heartbeat에서 reload한다',async()=>{
 const f=fixture();f.succeed();await createExtensionUpdater(f.options).check({force:true});assert.equal(f.reloads,1);
 f.setIdle(false);f.repair();await createExtensionUpdater(f.options).check({force:true});assert.equal(f.reloads,1);
 f.setIdle(true);f.repaired();f.advance(5000);
 await createExtensionUpdater(f.options).check({force:true});assert.equal(f.reloads,2);
});
test('새 빌드의 실제 로드 확인은 이전 reload 표식을 정리한다',async()=>{
 const f=fixture();f.succeed();await createExtensionUpdater(f.options).check({force:true});
 await createExtensionUpdater({...f.options,loadedBuildId:next}).check({force:true});assert.equal(f.saved,null);
});
test('복구 근거 없이 다른 로드 폴더에서 같은 빌드를 반복 reload하지 않는다',()=>{
 assert.equal(extensionReloadDecision({loadedBuildId:old,status:{buildId:next,reloadSafe:true,repairedCopies:1},idle:true,lastRequested:next}).action,'reload');
 assert.equal(extensionReloadDecision({loadedBuildId:old,status:{buildId:next,reloadSafe:true,repairedCopies:0},idle:true,lastRequested:next}).action,'manual');
});

test('같은 빌드의 새 폴더 복구 신호는 실패 대기를 초기화하지 않는다',async()=>{
 const f=fixture();await createExtensionUpdater(f.options).check({force:true});
 f.advance(1000);f.repair();await createExtensionUpdater(f.options).check({force:true});
 assert.equal(f.reloads,1);assert.equal(f.saved.nextAttemptAt,31000);assert.equal(f.saved.failures,1);
});
test('콘텐츠 상태 조회가 먼저 복구한 신호도 다음 updater 검사까지 보존한다',async()=>{
 const {rememberExtensionRepair}=await import('../central/extension/update.js');
 const f=fixture();f.succeed();await createExtensionUpdater(f.options).check({force:true});
 const {readFile}=await import('node:fs/promises'),{runInNewContext}=await import('node:vm');
 const source=await readFile(new URL('../central/extension/background.js',import.meta.url),'utf8');
 const scope={chrome:f.options.chrome,BUILD_ID:old,rememberExtensionRepair,executor:{...f.options.executor,isMaintenanceIdle:true},transport:{request:async()=>({buildId:next,repairedCopies:1,reloadSafe:true})}};
 // 실제 콘텐츠 갱신 진입점을 실행한다. 다른 빌드라 주입은 하지 않지만 복구 신호는 남아야 한다.
 runInNewContext(source.slice(source.indexOf('async function refreshManagedContent()'),source.indexOf('transport.onCommand('))+'\nglobalThis.refresh=refreshManagedContent;',scope);
 await scope.refresh();
 await createExtensionUpdater(f.options).check({force:true});assert.equal(f.reloads,2);
});
