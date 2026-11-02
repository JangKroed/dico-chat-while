import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {accountIdentityMetadata,identityFailureMessage} from '../central/extension/identity-observation.js';
import {currentRegistration} from '../central/extension/registration-state.js';
import {observeRegisteredAccount,observeManagedChannel} from '../central/extension/observation-queue.js';
const source=readFileSync(new URL('../central/extension/background.js',import.meta.url),'utf8');
const accountFunctions=source.slice(source.indexOf('async function observe(tabId)'),source.indexOf('async function restoreSavedConnections()'));
function rig(){
 let seen={verified:true,accountId:'123456789012345678',accountName:'호야',username:'hoya',name:'채널 이름'};
 const saved={},requests=[];
 const chrome={storage:{local:{get:async()=>saved,set:async values=>Object.assign(saved,values)}},tabs:{get:async()=>({status:'complete'}),query:async()=>[{id:7}]}};
 const executor={state:{sessionId:'session',legacyDeclaration:true},load:async()=>{},request:async message=>{requests.push(message);return{account:{id:message.accountId}};}};
 const scope={chrome,executor,currentRegistration,transport:{connected:true},readAccountIdentity:async()=>seen,accountIdentityMetadata,identityFailureMessage,observeRegisteredAccount,observeManagedChannel,observeChannelLimit:async()=>({}),activeSourceTab:async()=>({id:7}),observation:async()=>{}};
 runInNewContext(accountFunctions+'\nglobalThis.actions={registerActiveAccount,collectObservation,publishObservation};',scope);
 return{...scope.actions,saved,requests,chrome,executor,scope,setSeen:value=>{seen=value;}};
}
test('계정 등록은 검증된 실제 닉네임·사용자명을 저장하고 ACCOUNT_OBSERVATION에 전달한다',async()=>{
 const r=rig();await r.registerActiveAccount();
 assert.equal(r.saved.dicoCentralAccount.accountName,'호야');assert.equal(r.saved.dicoCentralAccount.username,'hoya');
 assert.equal(r.requests[0].accountName,'호야');assert.equal(r.requests[0].username,'hoya');assert.equal(r.requests[0].name,undefined);assert.equal(r.requests[0].explicitRegistration,true);
 const snapshot=await r.collectObservation();assert.equal(snapshot.account.accountName,'호야');assert.equal(snapshot.account.username,'hoya');
 await r.publishObservation(snapshot);assert.equal(r.requests[1].accountName,'호야');assert.equal(r.requests[1].username,'hoya');assert.equal(r.requests[1].explicitRegistration,undefined);
});
test('재관측은 저장된 별칭이나 채널 제목 대신 현재 검증된 계정 이름만 전달한다',async()=>{
 const r=rig();await r.registerActiveAccount();r.setSeen({verified:true,accountId:'123456789012345678',accountName:'새 이름',username:'new_name',name:'서버 채널'});
 const fresh=await r.collectObservation();assert.equal(fresh.account.accountName,'새 이름');assert.equal(fresh.account.username,'new_name');assert.equal(fresh.account.name,undefined);
 r.setSeen({verified:false,accountName:'오래된 이름',username:'stale'});
 const failed=await r.collectObservation();assert.equal(failed.account.verified,false);assert.equal(failed.account.accountName,undefined);assert.equal(failed.account.username,undefined);
});
test('기본 아바타 검증 실패는 계정 등록과 저장을 실행하지 않는다',async()=>{
 const r=rig();r.setSeen({verified:false,reason:'DEFAULT_AVATAR'});await assert.rejects(r.registerActiveAccount());assert.equal(r.requests.length,0);assert.equal(r.saved.dicoCentralAccount,undefined);
});
test('초기화 전에 수집된 관측은 새 세션에 다시 게시하지 않는다',async()=>{
 const r=rig();await r.registerActiveAccount();const old=await r.collectObservation();r.executor.state.sessionId='reset-session';const before=r.requests.length;
 assert.equal((await r.publishObservation(old)).ignored,true);assert.equal(r.requests.length,before);
});
test('스토리지 읽기를 기다리는 동안 초기화해도 이전 채널 관측에 새 세션을 붙이지 않는다',async()=>{
 const r=rig();await r.registerActiveAccount();const read=r.chrome.storage.local.get;
 r.chrome.storage.local.get=async()=>{const old=await read();r.executor.state.sessionId='reset-session';return old;};
 const snapshot=await r.collectObservation();assert.equal(snapshot.sessionId,'session');const before=r.requests.length;
 assert.equal((await r.publishObservation(snapshot)).ignored,true);assert.equal(r.requests.length,before);
});
test('계정 관측 전송을 기다리는 동안 초기화하면 뒤따르는 이전 채널 관측은 전송하지 않는다',async()=>{
 const r=rig();await r.registerActiveAccount();const snapshot=await r.collectObservation();let sent=0;
 r.executor.request=async()=>{sent++;r.executor.state.sessionId='reset-session';return{};};
 assert.equal((await r.publishObservation(snapshot)).ignored,true);assert.equal(sent,1);
});
test('계정 등록 응답을 기다리는 동안 초기화하면 이전 등록을 다시 저장하지 않는다',async()=>{
 const r=rig();r.executor.request=async()=>{r.executor.state.sessionId='reset-session';return{account:{}};};
 await assert.rejects(r.registerActiveAccount());assert.equal(r.saved.dicoCentralAccount,undefined);
});
test('초기화 이후 늦게 저장된 이전 세대의 계정·채널은 관측에서 제외한다',async()=>{
 const r=rig();await r.registerActiveAccount();r.saved.dicoCentralTabs=[{accountId:'123456789012345678',guildId:'111',channelId:'222',tabId:7}];r.executor.state.resetEpoch=1;
 const snapshot=await r.collectObservation();assert.equal(snapshot.account,null);assert.equal(snapshot.channels.length,0);
});
