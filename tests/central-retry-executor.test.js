import test from 'node:test';
import assert from 'node:assert/strict';
import {createCentralManager} from '../central/core/index.js';
import {createCentralExecutor} from '../central/extension/executor.js';

test('실제 코어의 미발송 확인 재시도는 정기 heartbeat 전에 같은 초안을 재사용하고 확인 후에만 차례를 넘긴다',async t=>{
 const time=1_800_000_000_000,manager=createCentralManager({now:()=>time,monotonicNow:()=>time});
 t.after(()=>manager.close());
 const guildId='11111111111111111',channelId='22222222222222222',clients=[];
 const first=manager.execute('message.create',{name:'첫 공지',body:'첫 공지'});
 const second=manager.execute('message.create',{name:'다음 공지',body:'다음 공지'});
 for(let index=0;index<2;index++){
  const accountId=String(33333333333333333n+BigInt(index)),tabId=index+1;
  const hello=manager.bridge({type:'HELLO',protocolVersion:1,name:`가상 브라우저 ${index}`});
  manager.bridge({type:'OBSERVATION',sessionId:hello.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId,guildId,channelId,tabId,verified:true}]},hello.instanceId);
  const channel=manager.snapshot().channels.find(c=>c.instanceId===hello.instanceId);
  manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:[{messageId:first.id},{messageId:second.id}]});
  let stored,executor,draft='',deliveries=0;
  const events=[];
  const transport={connected:true,request:async message=>{events.push({type:message.type,knownAttemptIds:message.knownAttemptIds});return manager.bridge(message,hello.instanceId);}};
  const chrome={storage:{local:{get:async()=>({dicoCentral:structuredClone(stored)}),set:async value=>{stored=structuredClone(value.dicoCentral);}}},tabs:{get:async()=>({id:tabId,url:`https://discord.com/channels/${guildId}/${channelId}`}),sendMessage:async(id,message)=>{
   events.push({type:message.type});
   if(message.type==='DICO_DRAFT_INSPECT')return{ok:true,draftText:draft,draftMatches:draft===message.delivery.text,unsupported:false,attachmentOrReply:false};
   if(message.type==='DICO_INSPECT')return{ok:true,draftMatches:draft===message.target.expectedText,cooldownKnown:true,cooldownMs:0};
   const phase=message.type==='DICO_PREPARE'?'prepare':'commit';
   if(!await executor.canSend({id:message.delivery.id,phase},id))throw Error('test content authorization denied');
   if(message.type==='DICO_PREPARE'){
    if(deliveries){
     // The retry has already durably reconciled the first attempt before
     // allowing the content script to reuse its retained matching draft.
     const previous=Object.values(stored.attempts).find(a=>a.attemptId!==message.delivery.id);
     assert.equal(previous.phase,'not_sent');assert.equal(draft,message.delivery.text);
     assert.equal(message.delivery.replaceExpectedDraft,undefined);
    }
    draft=message.delivery.text;return{status:'prepared'};
   }
   deliveries++;
   if(deliveries===1)return{status:'draft-retained',code:'DELIVERY_DRAFT_RETAINED',deliveryEvidence:{phase:'commit',stage:'observe',enterAttempted:true,composerRetained:true}};
   draft='';return{status:'confirmed',messageId:'44444444444444444'};
  }}};
  executor=createCentralExecutor({chrome,transport,now:()=>time,monotonicNow:()=>time});await executor.load();await executor.setSession(hello);
  for(const command of manager.commands(hello.instanceId))await executor.handleCommand(command);
  clients.push({executor,hello,channel,events,get deliveries(){return deliveries;}});
 }
 const group=manager.execute('group.create',{name:'가상 계정 순환',members:clients.map(c=>c.channel.id),intervalMs:0});
 manager.execute('group.start',{id:group.id});manager.tick();
 const owner=clients[0];
 async function handle(type){
  const command=manager.commands(owner.hello.instanceId).find(c=>c.type===type);
  assert.ok(command,`${type} command must exist`);await owner.executor.handleCommand(command);
 }
 await handle('PREPARE');await handle('COMMIT_PERMIT');
 let snapshot=manager.snapshot();const previous=snapshot.attempts[0];
 assert.equal(previous.status,'unknown');assert.equal(previous.executionBlocked,true);
 assert.equal(snapshot.groups[0].cursor,0);assert.equal(snapshot.channels.find(c=>c.id===owner.channel.id).playlistIndex,0);
 assert.equal(manager.execute('attempt.retryNotSent',{id:previous.id,confirmation:'CONFIRM_NOT_SENT'}).status,'started');
 manager.tick();snapshot=manager.snapshot();
 assert.equal(snapshot.attempts[1].accountId,previous.accountId);assert.equal(snapshot.groups[0].cursor,0);
 assert.equal(owner.executor.state.attempts[previous.id].phase,'unknown');
 const retryEventStart=owner.events.length;
 // Deliver the freshly pushed PREPARE directly, before a periodic heartbeat.
 await handle('PREPARE');
 const retryEvents=owner.events.slice(retryEventStart);
 const sync=retryEvents.findIndex(e=>e.type==='HEARTBEAT'),inspection=retryEvents.findIndex(e=>e.type==='DICO_DRAFT_INSPECT');
 assert.ok(sync>=0&&sync<inspection);assert.deepEqual(retryEvents[sync].knownAttemptIds,[previous.id]);
 assert.equal(owner.executor.state.attempts[previous.id].phase,'not_sent');assert.equal(owner.executor.state.draftBackups.length,0);
 assert.equal(manager.snapshot().groups[0].cursor,0);assert.equal(owner.deliveries,1);
 await handle('COMMIT_PERMIT');snapshot=manager.snapshot();
 assert.equal(snapshot.attempts[0].status,'not_sent');assert.equal(snapshot.attempts[1].status,'confirmed');
 assert.equal(snapshot.groups[0].cursor,1);assert.equal(snapshot.channels.find(c=>c.id===owner.channel.id).playlistIndex,1);
 assert.equal(owner.deliveries,2);assert.equal(clients[1].deliveries,0);
});

test('same-attempt retry crosses the real executor and core without advancing the turn twice',async t=>{
 const time=1_800_000_000_000,manager=createCentralManager({now:()=>time,monotonicNow:()=>time});t.after(()=>manager.close());
 const guildId='11111111111111111',channelId='22222222222222222',accountId='33333333333333333',tabId=7;
 const hello=manager.bridge({type:'HELLO',protocolVersion:1,name:'retry integration'});
 manager.bridge({type:'OBSERVATION',sessionId:hello.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId,guildId,channelId,tabId,verified:true}]},hello.instanceId);
 const channel=manager.snapshot().channels[0],first=manager.execute('message.create',{name:'First',body:'First'}),second=manager.execute('message.create',{name:'Second',body:'Second'});
 manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:[{messageId:first.id},{messageId:second.id}]});
 let stored,executor;
 const transport={connected:true,request:async message=>manager.bridge(message,hello.instanceId)};
 const chrome={storage:{local:{get:async()=>({dicoCentral:structuredClone(stored)}),set:async value=>{stored=structuredClone(value.dicoCentral);}}},tabs:{get:async()=>({id:tabId,url:`https://discord.com/channels/${guildId}/${channelId}`}),sendMessage:async(id,message)=>{
  if(message.type==='DICO_DRAFT_INSPECT')return{ok:true,draftText:'',draftMatches:false,unsupported:false,attachmentOrReply:false};
  if(message.type==='DICO_INSPECT')return{ok:true,draftMatches:true,cooldownMs:0,cooldownKnown:true};
  if(message.type==='DICO_PREPARE')return{status:'prepared'};
  assert.equal(message.delivery.maxSendRetries,null);
  assert.equal(await executor.canSend({id:message.delivery.id,phase:'commit',retryCount:0},id),true);
  for(let count=1;count<=12;count++){
   assert.equal(await executor.retryWait({id:message.delivery.id,phase:'commit',retryCount:count,cooldownMs:0,elapsedMs:count*100},id),true);
   assert.equal(manager.snapshot().groups[0].cursor,0);
   assert.equal(await executor.canSend({id:message.delivery.id,phase:'commit',retryCount:count},id),true);
  }
  return{status:'confirmed',messageId:'44444444444444444',deliveryEvidence:{phase:'commit',stage:'observe',enterAttempted:true,retryCount:12,maxSendRetries:null}};
 }}};
 executor=createCentralExecutor({chrome,transport,now:()=>time,monotonicNow:()=>time});await executor.load();await executor.setSession(hello);
 for(const command of manager.commands(hello.instanceId))await executor.handleCommand(command);
 const group=manager.execute('group.create',{name:'Retry',members:[channel.id],intervalMs:0});manager.execute('group.start',{id:group.id});manager.tick();
 for(const type of ['PREPARE','COMMIT_PERMIT']){
  const command=manager.commands(hello.instanceId).find(x=>x.type===type);assert.ok(command);await executor.handleCommand(command);
 }
 const snapshot=manager.snapshot();assert.equal(snapshot.attempts.length,1);assert.equal(snapshot.attempts[0].status,'confirmed');assert.equal(snapshot.attempts[0].sendRetryCount,12);assert.equal(snapshot.attempts[0].deliveryEvidence.retryCount,12);assert.equal(snapshot.groups[0].cursor,0);assert.equal(snapshot.channels[0].playlistIndex,1);
});
