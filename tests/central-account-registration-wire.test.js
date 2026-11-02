import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {accountIdentityMetadata,identityFailureMessage} from '../central/extension/identity-observation.js';
import {observeRegisteredAccount,observeManagedChannel} from '../central/extension/observation-queue.js';
const source=readFileSync(new URL('../central/extension/background.js',import.meta.url),'utf8');
const accountFunctions=source.slice(source.indexOf('async function observe(tabId)'),source.indexOf('async function restoreSavedConnections()'));
function rig(){
 let seen={verified:true,accountId:'123456789012345678',accountName:'호야',username:'hoya',name:'채널 이름'};
 const saved={},requests=[];
 const chrome={storage:{local:{get:async()=>saved,set:async values=>Object.assign(saved,values)}},tabs:{get:async()=>({status:'complete'}),query:async()=>[{id:7}]}};
 const executor={state:{sessionId:'session',legacyDeclaration:true},load:async()=>{},request:async message=>{requests.push(message);return{account:{id:message.accountId}};}};
 const scope={chrome,executor,transport:{connected:true},readAccountIdentity:async()=>seen,accountIdentityMetadata,identityFailureMessage,observeRegisteredAccount,observeManagedChannel,observeChannelLimit:async()=>({}),activeSourceTab:async()=>({id:7}),observation:async()=>{}};
 runInNewContext(accountFunctions+'\nglobalThis.actions={registerActiveAccount,collectObservation,publishObservation};',scope);
 return{...scope.actions,saved,requests,setSeen:value=>{seen=value;}};
}
test('계정 등록은 검증된 실제 닉네임·사용자명을 저장하고 ACCOUNT_OBSERVATION에 전달한다',async()=>{
 const r=rig();await r.registerActiveAccount();
 assert.equal(r.saved.dicoCentralAccount.accountName,'호야');assert.equal(r.saved.dicoCentralAccount.username,'hoya');
 assert.equal(r.requests[0].accountName,'호야');assert.equal(r.requests[0].username,'hoya');assert.equal(r.requests[0].name,undefined);
 const snapshot=await r.collectObservation();assert.equal(snapshot.account.accountName,'호야');assert.equal(snapshot.account.username,'hoya');
 await r.publishObservation(snapshot);assert.equal(r.requests[1].accountName,'호야');assert.equal(r.requests[1].username,'hoya');
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
