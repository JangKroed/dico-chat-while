import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCentralManager} from '../central/core/index.js';
import {CentralStore} from '../central/core/store.js';
import {createCentralExecutor} from '../central/extension/executor.js';
import {recoverConnections} from '../central/extension/connection-recovery.js';
const seen={accountId:'123456789012345678',guildId:'111111111111111111',channelId:'222222222222222222',tabId:7,verified:true,name:'공지'};
const hello=(manager,extra={})=>manager.bridge({type:'HELLO',protocolVersion:1,instanceId:'browser',...extra});
const reset=manager=>manager.execute('settings.reset',{confirmation:'RESET_ALL_SETTINGS',expectedConfiguration:manager.snapshot().configurationToken});
function client(manager){
 const saved={dicoCentralTabs:[{...seen}],dicoCentralAccount:{accountId:seen.accountId,sourceTabId:7}},writes=[],inputs=[];
 const chrome={storage:{local:{get:async()=>structuredClone(saved),set:async values=>{writes.push(structuredClone(values));Object.assign(saved,structuredClone(values));}}},tabs:{create:async()=>{inputs.push('create');},remove:async()=>{inputs.push('remove');},sendMessage:async()=>{inputs.push('message');}}};
 const transport={connected:true,request:async(message,instanceId)=>manager.bridge(message,instanceId)};
 return{saved,writes,inputs,chrome,transport,executor:createCentralExecutor({chrome,transport})};
}
test('오프라인 확장은 초기화 후 첫 연결에서 이전 등록을 원자적으로 지우며 열린 탭·초안을 조작하지 않는다',async()=>{
 const manager=createCentralManager();try{
  const r=client(manager),old=hello(manager);await r.executor.setSession(old);
  r.executor.state.bindings.old={configVersion:1};r.executor.state.attempts.old={phase:'confirmed'};r.executor.state.draftBackups=[{text:'보존할 초안 기록'}];await r.executor.save();
  await r.executor.request({type:'OBSERVATION',channels:[seen],legacyFrozen:true,legacyPending:false});assert.equal(manager.snapshot().channels.length,1);
  reset(manager);
  assert.throws(()=>manager.bridge({type:'OBSERVATION',sessionId:old.sessionId,channels:[seen]},old.instanceId),{code:'NOT_FOUND'});
  const reply=hello(manager,{resetEpoch:r.executor.state.resetEpoch});assert.equal(reply.resetRequired,true);assert.equal(reply.resetEpoch,1);
  const applied=await r.executor.setSession(reply);assert.equal(applied.reset,true);
  assert.deepEqual(r.saved.dicoCentralTabs,[]);assert.equal(r.saved.dicoCentralAccount,null);assert.deepEqual(r.executor.state.bindings,{});assert.deepEqual(r.executor.state.attempts,{});assert.equal(r.executor.state.draftBackups[0].text,'보존할 초안 기록');
  const atomic=r.writes.at(-1);assert.equal(atomic.dicoCentral.resetEpoch,1);assert.deepEqual(atomic.dicoCentralTabs,[]);assert.equal(atomic.dicoCentralAccount,null);
  const result=await recoverConnections({chrome:r.chrome,state:r.executor.state,findAccount:async()=>{throw Error('empty registration must not scan open tabs');},openChannel:async()=>{throw Error('must not reopen');},report:async()=>{throw Error('no implicit registration');}});assert.equal(result.skipped,true);
  await r.executor.request({type:'OBSERVATION',channels:[],legacyFrozen:true,legacyPending:false});assert.equal(manager.snapshot().channels.length,0);assert.equal(manager.snapshot().accounts.length,0);assert.deepEqual(r.inputs,[]);
 }finally{manager.close();}
});
test('초기화 세대가 없는 구버전과 오래된 세대는 새 HELLO 후에도 계정·채널을 복구할 수 없다',()=>{
 const manager=createCentralManager();try{
  hello(manager);reset(manager);
  for(const epoch of [undefined,0]){
   const h=hello(manager,{resetEpoch:epoch});assert.equal(h.resetRequired,true);
   for(const request of [{type:'OBSERVATION',channels:[seen],legacyFrozen:true,legacyPending:false},{type:'ACCOUNT_OBSERVATION',accountId:seen.accountId,verified:true}])assert.throws(()=>manager.bridge({...request,sessionId:h.sessionId,resetEpoch:epoch},h.instanceId),{code:'RESET_REQUIRED'});
  }
  assert.equal(manager.snapshot().channels.length,0);assert.equal(manager.snapshot().accounts.length,0);
 }finally{manager.close();}
});
test('같은 세대의 재연결은 새로 등록한 설정을 보존하고 두 번째 초기화는 다시 제거한다',async()=>{
 const manager=createCentralManager();try{
  reset(manager);const r=client(manager);await r.executor.setSession(hello(manager));
  r.saved.dicoCentralTabs=[{...seen}];r.saved.dicoCentralAccount={accountId:seen.accountId};r.executor.state.bindings.new={configVersion:2};await r.executor.save();
  assert.equal((await r.executor.setSession(hello(manager,{resetEpoch:1}))).reset,false);assert.equal(r.saved.dicoCentralTabs.length,1);assert.equal(r.executor.state.bindings.new.configVersion,2);
  reset(manager);await r.executor.setSession(hello(manager,{resetEpoch:1}));assert.equal(r.executor.state.resetEpoch,2);assert.deepEqual(r.saved.dicoCentralTabs,[]);
 }finally{manager.close();}
});
test('초기화 없는 기존 설치는 세대 0으로 이관하며 저장된 연결을 삭제하지 않는다',async()=>{
 const manager=createCentralManager();try{
  const r=client(manager);r.saved.dicoCentral={instanceId:'browser',sessionId:'old',bindings:{old:{configVersion:1}},attempts:{}};
  const h=hello(manager);assert.equal(h.resetEpoch,0);assert.equal(h.resetRequired,false);assert.equal((await r.executor.setSession(h)).reset,false);assert.equal(r.saved.dicoCentralTabs.length,1);assert.equal(r.executor.state.bindings.old.configVersion,1);
 }finally{manager.close();}
});
test('구버전 초기화 이력은 첫 업그레이드에서 영속 세대로 이관되고 백업 복원·재시작에도 되돌아가지 않는다',()=>{
 const directory=mkdtempSync(join(tmpdir(),'dico-reset-epoch-')),databasePath=join(directory,'central.sqlite');let manager;
 try{
  manager=createCentralManager({databasePath});const backup=manager.exportBackup();reset(manager);manager.close();manager=null;
  const store=new CentralStore(databasePath),old=store.read();delete old.resetEpoch;old.stateVersion++;store.commit(old,[]);store.close();
  manager=createCentralManager({databasePath});let h=hello(manager);assert.equal(h.resetEpoch,1);assert.equal(h.resetRequired,true);
  manager.importBackup(backup);h=hello(manager);assert.equal(h.resetEpoch,1);assert.equal(h.resetRequired,true);
  manager.close();manager=createCentralManager({databasePath});h=hello(manager);assert.equal(h.resetEpoch,1);assert.equal(h.resetRequired,true);
 }finally{manager?.close();rmSync(directory,{recursive:true,force:true});}
});
test('초기화 로컬 저장 실패 뒤 재연결은 이전 탭 목록을 남긴 채 새 세대를 승인하지 않는다',async()=>{
 const manager=createCentralManager();try{
  const r=client(manager);await r.executor.setSession(hello(manager));reset(manager);
  const set=r.chrome.storage.local.set;let fail=true;r.chrome.storage.local.set=async values=>{if(fail&&values.dicoCentralTabs)throw Error('storage temporarily unavailable');return set(values);};
  await assert.rejects(r.executor.setSession(hello(manager,{resetEpoch:0})));assert.equal(r.executor.state.resetPending,true);assert.equal(r.saved.dicoCentralTabs.length,1);
  await assert.rejects(r.executor.request({type:'OBSERVATION',channels:[seen],legacyFrozen:true,legacyPending:false}));assert.equal(manager.snapshot().channels.length,0);
  fail=false;const next=hello(manager,{resetEpoch:r.executor.state.resetEpoch});assert.equal(next.resetRequired,false);assert.equal((await r.executor.setSession(next)).reset,true);assert.deepEqual(r.saved.dicoCentralTabs,[]);assert.equal(r.executor.state.resetPending,false);
 }finally{manager.close();}
});
test('연결 중인 확장은 다음 하트비트에서 즉시 HELLO하고 연결·계정 설정을 지운다',async()=>{
 const manager=createCentralManager();try{
  const r=client(manager);await r.executor.setSession(hello(manager));reset(manager);let reconnects=0;
  const source=readFileSync(new URL('../central/extension/background.js',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('async function runHeartbeat()'),source.indexOf('async function connect('));
  const scope={executor:r.executor,connect:async()=>{reconnects++;await r.executor.setSession(hello(manager,{resetEpoch:r.executor.state.resetEpoch}));}};
  runInNewContext(fn+'\nglobalThis.run=runHeartbeat;',scope);await scope.run();
  assert.equal(reconnects,1);assert.equal(r.executor.state.resetEpoch,1);assert.deepEqual(r.saved.dicoCentralTabs,[]);assert.equal(r.saved.dicoCentralAccount,null);
  assert.equal((await r.executor.request({type:'HEARTBEAT'})).ok,true);
 }finally{manager.close();}
});
test('초기화 전에 시작한 CONFIG_SYNC의 늦은 ACK는 새 실행기에 설정을 다시 넣지 않는다',async()=>{
 const manager=createCentralManager();try{
  const r=client(manager);const session=hello(manager);await r.executor.setSession(session);
  let release,received;const started=new Promise(resolve=>{received=resolve;});const pending=new Promise(resolve=>{release=resolve;});
  r.transport.request=async message=>{if(message.type==='ACK'&&message.status==='received'){received();await pending;}return{ok:true};};
  const job=r.executor.handleCommand({id:'old-config',type:'CONFIG_SYNC',instanceId:session.instanceId,sessionId:session.sessionId,payload:{bindingId:'old',configVersion:1,items:[]}});await started;
  reset(manager);await r.executor.setSession(hello(manager,{resetEpoch:0}));release();await job;
  assert.deepEqual(r.executor.state.bindings,{});assert.deepEqual(r.saved.dicoCentralTabs,[]);
 }finally{manager.close();}
});
test('초기화 뒤 늦게 완료된 이전 세대의 스토리지 쓰기도 복구 대상으로 인정하지 않는다',async()=>{
 const manager=createCentralManager();try{
  const r=client(manager),late=structuredClone(r.saved);reset(manager);await r.executor.setSession(hello(manager));
  await r.chrome.storage.local.set(late);
  const result=await recoverConnections({chrome:r.chrome,state:r.executor.state,findAccount:async()=>{throw Error('stale registration must not be observed');},openChannel:async()=>{throw Error('stale channel must not reopen');},report:async()=>{}});
  assert.equal(result.skipped,true);assert.deepEqual(r.inputs,[]);
 }finally{manager.close();}
});
