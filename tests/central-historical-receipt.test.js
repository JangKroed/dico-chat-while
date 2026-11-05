import test from 'node:test';
import assert from 'node:assert/strict';
import {createCentralManager} from '../central/core/index.js';
import {createCentralExecutor} from '../central/extension/executor.js';

const evidence=()=>({phase:'commit',stage:'observe',enterAttempted:true,expectedDraftSubmitted:true,composerCleared:true,sameEditor:true,targetMatched:true,accountMatched:true,composerRetained:false,submitMethod:'keyboard'});
for(const userStop of [false,true])for(const mode of ['saved','cached','missing'])test(`완료 보고 유실 뒤 새 세션에서 원본 영수증을 조회한다 (${mode}, 사용자 중지 ${userStop})`,async t=>{
 let time=1800000000000,mono=1000,stored,drop=true,enters=0;
 const manager=createCentralManager({now:()=>time,monotonicNow:()=>mono});t.after(()=>manager.close());
 let session=manager.bridge({type:'HELLO',protocolVersion:1}),executor;const submittedSession=session.sessionId;
 const bridge=m=>manager.bridge({sessionId:session.sessionId,...m},session.instanceId);
 const observe=()=>bridge({type:'OBSERVATION',legacyFrozen:true,legacyPending:false,channels:[{accountId:'a',guildId:'g',channelId:'c',tabId:7,verified:true}]});observe();
 const channel=manager.snapshot().channels[0],messages=['one','two'].map(body=>manager.execute('message.create',{name:body,body}));
 manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:messages.map(m=>({messageId:m.id}))});
 const chrome={storage:{local:{get:async()=>({dicoCentral:structuredClone(stored)}),set:async v=>{stored=structuredClone(v.dicoCentral);}}},tabs:{get:async()=>({url:'https://discord.com/channels/g/c'}),sendMessage:async(tab,m)=>{
  if(m.type==='DICO_DRAFT_INSPECT')return{ok:true,draftText:'',draftMatches:false,unsupported:false,attachmentOrReply:false};
  if(m.type==='DICO_PREPARE')return{status:'prepared'};
  if(m.type==='DICO_INSPECT')return{ok:true,draftMatches:true,cooldownKnown:true,cooldownMs:0};
  if(m.type==='DICO_DELIVER'){enters++;if(mode!=='saved')throw Error('response lost');return{status:'confirmed',confirmationBasis:'composer_cleared',deliveryEvidence:evidence()};}
  if(m.type==='DICO_DELIVERY_RECEIPT'&&!drop&&mode==='cached'){
   assert.equal(m.delivery.sessionId,submittedSession);assert.equal(m.delivery.text,messages[0].body);assert.equal(tab,7);
   return{status:'confirmed',confirmationBasis:'composer_cleared',deliveryEvidence:evidence()};
  }
  return{status:'uncertain'};
 }}};
 const transport={connected:true,request:async(m,id)=>{if(m.type==='DELIVERY_RESULT'&&drop)throw Error('lost report');return manager.bridge(m,id);}};
 executor=createCentralExecutor({chrome,transport,now:()=>time,monotonicNow:()=>mono});await executor.load();await executor.setSession(session);
 for(const c of manager.commands(session.instanceId).filter(c=>c.type==='CONFIG_SYNC'))await executor.handleCommand(c);
 const g=manager.execute('group.create',{name:'fixture',members:[channel.id],intervalMs:20000});manager.execute('group.start',{id:g.id});manager.tick();
 for(const type of ['PREPARE','COMMIT_PERMIT'])await executor.handleCommand(manager.commands(session.instanceId).find(c=>c.type===type));
 const a=manager.snapshot().attempts[0];assert.equal(executor.state.attempts[a.id].phase,mode==='saved'?'confirmed':'unknown');assert.equal(a.status,'permitted');
 if(userStop)manager.execute('group.stop',{id:g.id});
 session=manager.bridge({type:'HELLO',protocolVersion:1,instanceId:session.instanceId});await executor.setSession(session);drop=false;
 for(const c of manager.commands(session.instanceId).filter(c=>c.type==='CONTROL'))await executor.handleCommand(c);
 const recovery=manager.commands(session.instanceId).find(c=>c.type==='RECONCILE');assert.ok(recovery);
 assert.throws(()=>bridge({type:'DELIVERY_RESULT',attemptId:a.id,outcome:'confirmed',confirmationBasis:'composer_cleared',deliveryEvidence:evidence(),recoveryCommandId:recovery.id,receiptOriginSessionId:'unrelated-session'}),{code:'EVIDENCE_REQUIRED'});
 assert.throws(()=>manager.bridge({type:'DELIVERY_RESULT',sessionId:submittedSession,attemptId:a.id,outcome:'confirmed',confirmationBasis:'composer_cleared',deliveryEvidence:evidence()},session.instanceId),{code:'STALE_SESSION'});
 assert.equal(manager.snapshot().attempts[0].status,'unknown');
 await executor.handleCommand(recovery);
 if(mode==='missing'){
  time+=3000;mono+=3000;observe();manager.tick();
  assert.equal(manager.snapshot().attempts[0].status,'unknown');assert.equal(manager.snapshot().channels[0].playlistIndex,0);assert.equal(enters,1);assert.equal(manager.snapshot().attempts.length,1);
  assert.equal(manager.snapshot().groups[0].status,userStop?'stopped':'paused');return;
 }
 assert.equal(manager.snapshot().attempts[0].status,'confirmed');assert.equal(manager.snapshot().attempts[0].confirmationBasis,'composer_cleared');assert.equal(manager.snapshot().attempts[0].messageId,undefined);
 observe();for(const c of manager.commands(session.instanceId).filter(c=>c.type==='CONFIG_SYNC'))await executor.handleCommand(c);
 time+=3000;mono+=3000;observe();manager.tick();
 assert.equal(manager.snapshot().groups[0].status,userStop?'stopped':'running');assert.equal(manager.snapshot().channels[0].playlistIndex,1);assert.equal(enters,1);
 await executor.handleCommand(recovery);assert.equal(enters,1);assert.equal(manager.events({type:'delivery.confirmed'}).length,1);
 assert.equal(manager.snapshot().attempts.length,1,'다음 간격을 줄여 따라잡지 않습니다.');
});
