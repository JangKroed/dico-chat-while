import test from 'node:test';
import assert from 'node:assert/strict';
import {reconnectDelay,versionReloadDecision,readUpdateIntent,UPDATE_RECONNECT_KEY} from '../central/ui/src/reconnect.ts';
import {ApiError,establishSession,command,subscribe} from '../central/ui/src/api.ts';

test('reconnect retries back off and stop after a bounded number of failures',()=>{
  assert.deepEqual([1,2,3,4,5,6,7,8].map(reconnectDelay),[1000,2000,3000,5000,8000,10000,10000,10000]);
  assert.equal(reconnectDelay(9),null);
});
test('version changes reload only an update initiator still on Settings',()=>{
  assert.equal(versionReloadDecision(undefined,'0.4.4',true,'/settings'),'none');
  assert.equal(versionReloadDecision('0.4.4','0.4.4',true,'/settings'),'none');
  assert.equal(versionReloadDecision('0.4.3','0.4.4',true,'/settings'),'reload');
  assert.equal(versionReloadDecision('0.4.3','0.4.4',true,'/messages'),'banner');
  assert.equal(versionReloadDecision('0.4.3','0.4.4',false,'/settings'),'banner');
  assert.equal(versionReloadDecision('0.4.3',undefined,true,'/settings'),'none');
});
test('an old or malformed update intent cannot authorize a later automatic reload',()=>{
  const storage={getItem:key=>key===UPDATE_RECONNECT_KEY?JSON.stringify({startedAt:1000,fromVersion:'0.4.3'}):null};
  assert.equal(readUpdateIntent(storage,2000)?.fromVersion,'0.4.3');
  assert.equal(readUpdateIntent(storage,1000+31*60*1000),null);
  assert.equal(readUpdateIntent({getItem:()=>'{broken'},2000),null);
});

async function mockBrowser(hash,fetcher,run){
  const previous={location:globalThis.location,history:globalThis.history,fetch:globalThis.fetch};
  const location={hash,pathname:'/channels',search:''},replacements=[];
  globalThis.location=location;globalThis.history={replaceState:(_a,_b,path)=>{replacements.push(path);location.hash=''}};globalThis.fetch=fetcher;
  try{await run({location,replacements})}finally{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value}}
}
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
test('bootstrap survives a network failure and is removed only after successful session exchange',async()=>{
  let online=false;
  await mockBrowser('#bootstrap=bootstrap-test-token',async()=>{if(!online)throw new TypeError('network down');return json({csrfToken:'csrf-test-token',appVersion:'0.4.4'})},async({location,replacements})=>{
    await assert.rejects(establishSession(),/network down/);assert.equal(location.hash,'#bootstrap=bootstrap-test-token');assert.equal(replacements.length,0);
    online=true;assert.deepEqual(await establishSession(),{appVersion:'0.4.4'});assert.equal(location.hash,'');assert.deepEqual(replacements,['/channels']);
  });
});
test('a consumed bootstrap recovers through its valid cookie and refreshes command CSRF',async()=>{
  const calls=[];
  await mockBrowser('#bootstrap=consumed-test-token',async(path,init)=>{
    calls.push({path,init});
    if(path==='/api/session'&&init.method==='POST')return json({error:'consumed'},401);
    if(path==='/api/session')return json({csrfToken:'restored-test-csrf',appVersion:'0.4.4'});
    return json({ok:true});
  },async({location})=>{
    assert.deepEqual(await establishSession(),{appVersion:'0.4.4'});assert.equal(location.hash,'');
    await command('test.read',{});assert.equal(calls.at(-1).init.headers.get('X-Dico-CSRF'),'restored-test-csrf');
  });
});
test('an expired cookie and invalid bootstrap surface 401 for reauthentication',async()=>{
  await mockBrowser('#bootstrap=invalid-test-token',async()=>json({error:'expired'},401),async()=>{await assert.rejects(establishSession(),error=>error instanceof ApiError&&error.status===401)});
});
test('a failed event stream closes before recovery and ignores stale callbacks',()=>{
  const previous=globalThis.EventSource,instances=[];
  globalThis.EventSource=class{listeners=new Map();closed=0;constructor(){instances.push(this)}addEventListener(name,callback){this.listeners.set(name,callback)}close(){this.closed++}};
  try{
    let reconnects=0,messages=0;const close=subscribe(()=>messages++,()=>{assert.equal(instances[0].closed,1);reconnects++});
    const source=instances[0];source.onerror();source.onerror();source.listeners.get('event')({data:'{}'});close();
    assert.equal(source.closed,1);assert.equal(reconnects,1);assert.equal(messages,0);
    const manual=subscribe(()=>{},()=>reconnects++);manual();instances[1].onerror();assert.equal(reconnects,1);
  }finally{if(previous===undefined)delete globalThis.EventSource;else globalThis.EventSource=previous}
});

test('an update reconnect preserves unsaved settings instead of reloading them away',()=>{
  assert.equal(versionReloadDecision('0.4.6','0.4.7',true,'/settings',true),'banner');
  assert.equal(versionReloadDecision('0.4.6','0.4.7',true,'/settings',false),'reload');
});

test('network recovery rearms an exhausted burst without clicks but not an expired session',async()=>{
 const {createReconnectWake}=await import('../central/ui/src/reconnect.ts');
 let time=0,phase='offline',calls=0;const target=new EventTarget();
 const dispose=createReconnectWake({target,phase:()=>phase,visible:()=>true,now:()=>time,restart:()=>calls++});
 target.dispatchEvent(new Event('online'));assert.equal(calls,1);
 target.dispatchEvent(new Event('online'));assert.equal(calls,1);
 time=30000;phase='expired';target.dispatchEvent(new Event('online'));assert.equal(calls,1);
 phase='offline';target.dispatchEvent(new Event('visibilitychange'));assert.equal(calls,2);
 dispose();time=60000;target.dispatchEvent(new Event('online'));assert.equal(calls,2);
});
test('hidden or already connecting views do not create parallel reconnect bursts',async()=>{
 const {createReconnectWake}=await import('../central/ui/src/reconnect.ts');
 let phase='reconnecting',visible=false,calls=0;const target=new EventTarget();
 const dispose=createReconnectWake({target,phase:()=>phase,visible:()=>visible,restart:()=>calls++});
 target.dispatchEvent(new Event('online'));phase='offline';target.dispatchEvent(new Event('visibilitychange'));assert.equal(calls,0);
 visible=true;target.dispatchEvent(new Event('visibilitychange'));assert.equal(calls,1);dispose();
});
