import test from 'node:test';
import assert from 'node:assert/strict';
import {managedPageDelay} from '../central/extension/managed-delay.js';
const sender={id:'extension',url:'https://discord.com/channels/g/c',tab:{id:7,url:'https://discord.com/channels/g/c'}};
const state={bindings:{binding:{tabId:7,guildId:'g',channelId:'c'}}};
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

test('reopened channel timers use the current attempt tab when unchanged configuration still has the old tab',async()=>{
 const binding={bindingId:'binding',tabId:7,accountId:'account',guildId:'g',channelId:'c',configVersion:2};
 const current={sessionId:'session',bindings:{binding},attempts:{attempt:{attemptId:'attempt',bindingId:'binding',tabId:8,accountId:'account',guildId:'g',channelId:'c',configVersion:2,sessionId:'session',phase:'preparing'}}};
 const reopened={...sender,tab:{...sender.tab,id:8}};let waits=0;
 for(const phase of ['preparing','prepared','executing','confirmed']){
  current.attempts.attempt.phase=phase;
  assert.deepEqual(await managedPageDelay({durationMs:100},reopened,current,{extensionId:'extension',wait:async()=>{waits++;}}),{ok:true});
 }
 assert.equal(waits,4);assert.equal(current.bindings.binding.tabId,7);
});

test('an old session, mismatched configuration, foreign route or drained attempt cannot authorize a reopened tab timer',async()=>{
 const binding={bindingId:'binding',tabId:7,accountId:'account',guildId:'g',channelId:'c',configVersion:2};
 const attempt={attemptId:'attempt',bindingId:'binding',tabId:8,accountId:'account',guildId:'g',channelId:'c',configVersion:2,sessionId:'session',phase:'preparing'};
 const reopened={...sender,tab:{...sender.tab,id:8}};
 for(const override of [{sessionId:'old'},{configVersion:1},{accountId:'other'},{channelId:'other'},{guildId:'other'},{phase:'unknown'},{phase:'not_sent'},{phase:'cancelled'}]){
  const current={sessionId:'session',bindings:{binding},attempts:{attempt:{...attempt,...override}}};
  assert.deepEqual(await managedPageDelay({durationMs:100},reopened,current,{extensionId:'extension',wait:()=>{throw Error('unexpected timer');}}),{ok:false});
 }
 const current={sessionId:'session',bindings:{binding},attempts:{attempt}};
 assert.deepEqual(await managedPageDelay({durationMs:100},{...reopened,url:'https://discord.com/channels/g/other'},current,{extensionId:'extension',wait:()=>{throw Error('unexpected timer');}}),{ok:false});
});

test('worker delay rechecks current session after waking without granting input permission',async()=>{
 const binding={bindingId:'binding',tabId:7,accountId:'account',guildId:'g',channelId:'c',configVersion:2};
 const current={sessionId:'session',bindings:{binding},attempts:{attempt:{attemptId:'attempt',bindingId:'binding',tabId:8,accountId:'account',guildId:'g',channelId:'c',configVersion:2,sessionId:'session',phase:'preparing'}}};
 assert.deepEqual(await managedPageDelay({durationMs:100},{...sender,tab:{...sender.tab,id:8}},current,{extensionId:'extension',wait:async()=>{current.sessionId='new-session';}}),{ok:false});
});

test('a real executor accepts a reopened PREPARE while its message configuration still references the closed tab',async()=>{
 const {createCentralExecutor}=await import('../central/extension/executor.js');
 let stored,executor,delayResult;const requests=[],events=[];
 const payload={bindingId:'binding',attemptId:'attempt',groupId:'group',runId:'run',accountId:'account',guildId:'g',channelId:'c',tabId:8,configVersion:2,body:'Notice',revisionId:'revision'};
 const chrome={storage:{local:{get:async()=>({dicoCentral:stored}),set:async value=>{stored=structuredClone(value.dicoCentral);}}},tabs:{get:async id=>({id,url:'https://discord.com/channels/g/c'}),sendMessage:async(tabId,message)=>{
  events.push(message.type);
  if(message.type==='DICO_DRAFT_INSPECT')return{ok:true,draftText:'',draftMatches:false,unsupported:false,attachmentOrReply:false};
  if(message.type==='DICO_PREPARE'){
   assert.equal(await executor.canSend({id:'attempt',phase:'prepare'},tabId),true);
   assert.equal(await executor.canSend({id:'attempt',phase:'commit'},tabId),false);
   delayResult=await managedPageDelay({durationMs:100},{...sender,tab:{...sender.tab,id:tabId}},executor.state,{extensionId:'extension',wait:async()=>{}});
   return delayResult.ok?{status:'prepared'}:{status:'blocked',code:'MANAGED_DELAY_UNAVAILABLE'};
  }
  if(message.type==='DICO_INSPECT')return{ok:true,draftMatches:true,cooldownKnown:true,cooldownMs:0};
  throw Error('unexpected send');
 }}};
 const transport={connected:true,request:async message=>{requests.push(message);return{ok:true};}};
 executor=createCentralExecutor({chrome,transport});await executor.load();await executor.setSession({instanceId:'instance',sessionId:'session'});
 await executor.handleCommand({id:'config',type:'CONFIG_SYNC',instanceId:'instance',sessionId:'session',payload:{...payload,tabId:7,items:[{messageId:'message',revisionId:'revision',body:'Notice'}]}});
 await executor.handleCommand({id:'prepare',type:'PREPARE',instanceId:'instance',sessionId:'session',payload});
 assert.deepEqual(delayResult,{ok:true});assert.equal(stored.bindings.binding.tabId,7);assert.equal(stored.attempts.attempt.tabId,8);assert.equal(stored.attempts.attempt.phase,'prepared');
 assert.equal(requests.filter(message=>message.type==='PREPARED').length,1);assert.equal(events.includes('DICO_DELIVER'),false);
});
