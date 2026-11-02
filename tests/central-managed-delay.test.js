import test from 'node:test';
import assert from 'node:assert/strict';
import {managedPageDelay} from '../central/extension/managed-delay.js';
const sender={id:'extension',url:'https://discord.com/channels/g/c',tab:{id:7,url:'https://discord.com/channels/g/c'}};
const state={bindings:{binding:{tabId:7}}};
test('managed page delay responds only after the background timer completes',async()=>{
 let release,finished=false;
 const promise=managedPageDelay({durationMs:100},sender,state,{extensionId:'extension',wait:ms=>{assert.equal(ms,100);return new Promise(resolve=>{release=resolve;});}}).then(result=>{finished=true;return result;});
 await Promise.resolve();assert.equal(finished,false);release();assert.deepEqual(await promise,{ok:true});
});
test('delay rejects unknown tabs, other extensions, other sites and unbounded waits without timers',async()=>{
 for(const [message,source] of [[{durationMs:1001},sender],[{durationMs:-1},sender],[{durationMs:NaN},sender],[{durationMs:1.2},sender],[{durationMs:100},{...sender,id:'other'}],[{durationMs:100},{...sender,tab:{id:99}}],[{durationMs:100},{...sender,url:'https://example.com'}],[{durationMs:100},{...sender,frameId:1}]]){
  assert.deepEqual(await managedPageDelay(message,source,state,{extensionId:'extension',wait:()=>{throw Error('unexpected timer');}}),{ok:false});
 }
});
