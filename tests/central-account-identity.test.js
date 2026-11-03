import test from 'node:test';
import assert from 'node:assert/strict';
import {readAccountIdentity,authorizeAccountInput} from '../central/extension/account-identity.js';
import {createCentralExecutor} from '../central/extension/executor.js';
import {pageIdentityObservation} from '../central/extension/identity-observation.js';

const accountId='123456789012345678',otherId='987654321098765432';
const seen=()=>({verified:true,accountId,guildId:'111',channelId:'222',username:'hoya',displayName:'호야'});
function rig(){
 let observation=seen(),clock=1800000000000,authorize=async()=>true;
 const reads=[];
 const chrome={scripting:{executeScript:async options=>{reads.push(options);return[{result:structuredClone(observation)}];}}};
 const executor={state:{sessionId:'session',attempts:{attempt:{attemptId:'attempt',bindingId:'binding',accountId,guildId:'111',channelId:'222',tabId:7,sessionId:'session',phase:'executing'}},bindings:{binding:{tabId:7}}},inputAllowed:()=>true,canSend:async(message,tabId)=>{assert.equal(message.id,'attempt');assert.equal(tabId,7);return authorize();}};
 return{chrome,executor,reads,now:()=>clock,setObservation:value=>{observation=value;},setAuthorize:fn=>{authorize=fn;},advance:ms=>{clock+=ms;},run(message={id:'attempt',phase:'commit'},tabId=7){return authorizeAccountInput({chrome,executor,message,tabId,now:()=>clock});}};
}
test('own panel observation explicitly executes in MAIN so page React props are visible',async()=>{
 const r=rig();assert.equal((await readAccountIdentity(r.chrome,7)).accountId,accountId);
 assert.equal(r.reads.length,1);assert.equal(r.reads[0].world,'MAIN');assert.deepEqual(r.reads[0].target,{tabId:7});assert.equal(r.reads[0].func,pageIdentityObservation);
});
test('missing and failed MAIN observation remain unverified',async()=>{
 for(const executeScript of [async()=>[],async()=>{throw Error('injection unavailable');}]){
  const result=await readAccountIdentity({scripting:{executeScript}},7);assert.equal(result.verified,false);
 }
});
test('fresh verified default-avatar identity can authorize its exact managed account and channel',async()=>{
 const r=rig();const result=await r.run();assert.equal(result.allowed,true);assert.equal(result.identity.accountId,accountId);assert.ok(r.reads.length>0);assert.equal(result.maxAgeMs,2000);
});
test('unverified, wrong-account or wrong-channel identity never permits input',async()=>{
 for(const observation of [{...seen(),verified:false},{...seen(),accountId:otherId},{...seen(),guildId:'999'},{...seen(),channelId:'999'}]){
  const r=rig();r.setObservation(observation);assert.equal((await r.run()).allowed,false);
 }
});
test('unknown attempt and another tab cannot request account input permission',async()=>{
 for(const [message,tabId] of [[{id:'missing',phase:'commit'},7],[{id:'attempt',phase:'commit'},99]]){
  const r=rig();assert.equal((await r.run(message,tabId)).allowed,false);
 }
});
test('an account switch during final service authorization is caught by a fresh MAIN observation',async()=>{
 const r=rig();r.setAuthorize(async()=>{r.setObservation({...seen(),accountId:otherId});return true;});
 assert.equal((await r.run()).allowed,false);
});
test('stale identity reads cannot extend a two-second Enter authorization',async()=>{
 const r=rig();r.chrome.scripting.executeScript=async()=>{r.advance(2001);return[{result:seen()}];};
 assert.equal((await r.run()).allowed,false);
});
test('service denial or changed session never becomes account authorization',async()=>{
 const denied=rig();denied.setAuthorize(async()=>false);assert.equal((await denied.run()).allowed,false);
 const changed=rig();changed.setAuthorize(async()=>{changed.executor.state.sessionId='new-session';return true;});assert.equal((await changed.run()).allowed,false);
});

test('local stop during MAIN observation closes the input gate before the reply',async()=>{
 const r=rig();r.chrome.scripting.executeScript=async()=>{r.executor.inputAllowed=()=>false;return[{result:seen()}];};
 assert.equal((await r.run()).allowed,false);
});
test('real executor volatile disconnect and configuration changes during MAIN read deny Enter',async()=>{
 for(const change of ['disconnect','configuration','emergency']){
  let executor;
  const attempt={attemptId:'attempt',bindingId:'binding',accountId,guildId:'111',channelId:'222',tabId:7,sessionId:'session',phase:'executing',groupId:'group',runId:'run',configVersion:1,permitId:'permit',enterRequested:true};
  const chrome={storage:{local:{get:async()=>({dicoCentral:{instanceId:'instance',sessionId:'session',attempts:{attempt},bindings:{binding:{configVersion:1}}}}),set:async()=>{}}},scripting:{executeScript:async()=>{
   if(change==='disconnect')executor.disconnect();
   else if(change==='configuration')executor.state.bindings.binding.configVersion=2;
   else executor.state.emergencyStopped=true;
   return[{result:seen()}];
  }}};
  const transport={connected:true,request:async message=>{assert.equal(message.type,'AUTHORIZE_ENTER');return{allowed:true};}};
  executor=createCentralExecutor({chrome,transport});await executor.load();
  const result=await authorizeAccountInput({chrome,executor,message:{id:'attempt',phase:'commit'},tabId:7});
  assert.equal(result.allowed,false,change);
 }
});

test('successful MAIN observation retains the original authorization timestamp instead of extending it',async()=>{
 const r=rig(),began=r.now();r.chrome.scripting.executeScript=async()=>{r.advance(500);return[{result:seen()}];};
 const result=await r.run();assert.equal(result.allowed,true);assert.equal(result.authorizedAt,began);assert.equal(result.maxAgeMs,2000);assert.equal(r.now()-result.authorizedAt,500);
});

test('structured transient authorization denial preserves its cause without reading identity',async()=>{
 const r=rig();r.executor.authorizeInput=async()=>({allowed:false,retryable:true,code:'NATIVE_REQUEST_TIMEOUT',retryAfterMs:500});
 const result=await r.run();assert.equal(result.allowed,false);assert.equal(result.retryable,true);assert.equal(result.code,'NATIVE_REQUEST_TIMEOUT');assert.equal(r.reads.length,0);
});
test('an expired account read requests fresh authorization while an identity mismatch never retries',async()=>{
 const stale=rig();stale.chrome.scripting.executeScript=async()=>{stale.advance(2001);return[{result:seen()}];};
 assert.equal((await stale.run()).code,'AUTHORIZATION_EXPIRED');assert.equal((await stale.run()).retryable,true);
 const mismatch=rig();mismatch.setObservation({...seen(),accountId:otherId});const result=await mismatch.run();assert.equal(result.code,'ACCOUNT_MISMATCH');assert.equal(result.retryable,false);
});

test('loss of transport during identity read preserves the retryable local gate reason',async()=>{
 const r=rig();r.chrome.scripting.executeScript=async()=>{r.executor.inputAllowed=()=>false;return[{result:seen()}];};
 r.executor.inputDenial=()=>({allowed:false,code:'NATIVE_DISCONNECTED',retryable:true,retryAfterMs:500});
 const result=await r.run();assert.equal(result.allowed,false);assert.equal(result.code,'NATIVE_DISCONNECTED');assert.equal(result.retryable,true);
});
