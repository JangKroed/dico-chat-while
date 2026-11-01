import test from 'node:test';
import assert from 'node:assert/strict';
import {createObservationQueue,createSingleFlight,observeManagedChannel} from '../central/extension/observation-queue.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
test('slow obsolete empty observation is discarded and concurrent triggers share one fresh pass',async()=>{
 const gate=deferred(),started=deferred(),published=[];let passes=0,active=0,maxActive=0;
 const run=createObservationQueue(async()=>{active++;maxActive=Math.max(active,maxActive);const n=++passes;if(n===1){started.resolve();await gate.promise;}active--;return n===1?[]:[{verified:true}];},async snapshot=>{published.push(snapshot);return snapshot;});
 const first=run();await started.promise;const second=run(),third=run();gate.resolve();await Promise.all([first,second,third]);
 assert.equal(passes,2);assert.equal(maxActive,1);assert.deepEqual(published,[[{verified:true}]]);
});
test('a real mismatch following verification is published and never retains a stale verified result',async()=>{
 const published=[];let verified=true;const run=createObservationQueue(async()=>[{verified}],async result=>published.push(result));
 await run();verified=false;await run();assert.deepEqual(published,[[{verified:true}],[{verified:false}]]);
});
test('heartbeat ticks share in-flight work and later ticks can run again after a failure',async()=>{
 const gate=deferred();let calls=0;const run=createSingleFlight(async()=>{calls++;await gate.promise;if(calls===1)throw Error('offline');return calls;});
 const one=run(),two=run();gate.resolve();await Promise.all([assert.rejects(one,/offline/),assert.rejects(two,/offline/)]);assert.equal(calls,1);assert.equal(await run(),2);
});
const record={accountId:'123456789012345678',guildId:'111',channelId:'222',tabId:7};
function observeWith({tab={id:7,status:'complete',url:'https://discord.com/channels/111/222'},seen={...record,verified:true},limit={slowmodeMs:5000}}={}){
 return observeManagedChannel({tabs:{get:async()=>{if(!tab)throw Error('missing');return tab;}}},record,{observe:async()=>seen,observeLimit:async()=>limit});
}
test('failed observations retain expected ownership and report the actual verification reason',async()=>{
 for(const [options,reason] of [[{tab:null},'tab_missing'],[{tab:{status:'loading'}},'tab_loading'],[{seen:{verified:false,reason:'SCRIPT_UNAVAILABLE'}},'script_unavailable'],[{seen:{...record,verified:true,accountId:'987654321098765432'}},'account_mismatch'],[{seen:{...record,verified:true,channelId:'999'}},'target_mismatch'],[{seen:{verified:false,reason:'ACCOUNT_PANEL_MISSING'}},'identity_unverified']]){
  assert.deepEqual(await observeWith(options),{...record,verified:false,verificationReason:reason});
 }
});
test('verified observations include current limits and clear the failure reason',async()=>{
 assert.deepEqual(await observeWith(),{...record,verified:true,verificationReason:null,slowmodeMs:5000});
});
test('confirmed account mismatch is not downgraded by later missing or loading tabs',async()=>{
 const {observeRegisteredAccount}=await import('../central/extension/observation-queue.js');
 for(const lastTab of [null,{id:8,status:'loading'}]){
  const chrome={tabs:{query:async()=>[{id:7},{id:8}],get:async id=>{if(id===7)return{id,status:'complete'};if(!lastTab)throw Error('gone');return lastTab;}}};
  const result=await observeRegisteredAccount(chrome,async()=>({verified:true,accountId:'987654321098765432'}),record.accountId,7);
  assert.equal(result.seen,null);assert.equal(result.verificationReason,'account_mismatch');
 }
});
