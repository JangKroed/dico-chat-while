import test from 'node:test';
import assert from 'node:assert/strict';
import {createCentralManager} from '../central/core/index.js';
import {createCentralExecutor} from '../central/extension/executor.js';

const receipt=()=>({status:'confirmed',confirmationBasis:'composer_cleared',deliveryEvidence:{phase:'commit',stage:'observe',submitMethod:'keyboard',enterAttempted:true,expectedDraftSubmitted:true,composerCleared:true,sameEditor:true,targetMatched:true,accountMatched:true,composerRetained:false}});

// 저장·상태 전이는 실제 코어/실행기를 사용하고 외부 Chrome 전송만 대체합니다.
async function fixture(t,{deliver,inspect}={}){
 let clock=1_800_000_000_000,stored,executor;
 const manager=createCentralManager({now:()=>clock,monotonicNow:()=>clock});t.after(()=>manager.close());
 const session=manager.bridge({type:'HELLO',protocolVersion:1});
 const target={accountId:'11111111111111111',guildId:'22222222222222222',channelId:'33333333333333333',tabId:7,verified:true};
 const bridge=message=>manager.bridge({sessionId:session.sessionId,...message},session.instanceId);
 const observe=()=>bridge({type:'OBSERVATION',legacyFrozen:true,legacyPending:false,channels:[target]});observe();
 const channel=manager.snapshot().channels[0];
 const messages=['첫 문구','다음 문구'].map(body=>manager.execute('message.create',{name:body,body}));
 manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:messages.map(m=>({messageId:m.id}))});
 const calls=[];
 const chrome={storage:{local:{get:async()=>({dicoCentral:structuredClone(stored)}),set:async value=>{stored=structuredClone(value.dicoCentral);}}},tabs:{get:async()=>({id:7,url:`https://discord.com/channels/${target.guildId}/${target.channelId}`}),sendMessage:async(tabId,message)=>{
  calls.push(message.type);
  if(message.type==='DICO_DRAFT_INSPECT')return inspect?inspect():{ok:true,draftText:'',draftMatches:false,unsupported:false,attachmentOrReply:false};
  if(message.type==='DICO_PREPARE')return{status:'prepared'};
  if(message.type==='DICO_INSPECT')return{ok:true,draftMatches:true,cooldownKnown:true,cooldownMs:0};
  if(message.type==='DICO_DELIVER')return deliver?deliver(f,message):receipt();
  if(message.type==='DICO_DELIVERY_RECEIPT'||message.type==='DICO_RECONCILE')return{status:'uncertain'};
  if(message.type==='DICO_CANCEL_DELIVERY')return{ok:true};
  throw Error(`예상하지 않은 탭 요청: ${message.type}`);
 }}};
 executor=createCentralExecutor({chrome,transport:{connected:true,request:async message=>bridge(message)},now:()=>clock,monotonicNow:()=>clock});
 await executor.load();await executor.setSession(session);
 for(const c of manager.commands(session.instanceId))await executor.handleCommand(c);
 const group=manager.execute('group.create',{name:'복구 검증',members:[channel.id],intervalMs:20000});
 manager.execute('group.start',{id:group.id});manager.tick();
 const handle=async type=>{const c=manager.commands(session.instanceId).find(c=>c.type===type);assert.ok(c,`${type} 명령 필요`);await executor.handleCommand(c);return c;};
 const advance=ms=>{for(let n=0;n<ms;n+=1000){clock+=Math.min(1000,ms-n);observe();manager.tick();}};
 const f={manager,executor,session,channel,group,bridge,observe,advance,handle,calls};return f;
}

for(const intent of [null,'stop','pause'])test(`31초 늦은 완료 영수증은 재발송 없이 복구하고 ${intent||'실행'} 의도를 유지한다`,async t=>{
 const f=await fixture(t,{deliver:async(f,message)=>{
  assert.equal(await f.executor.canSend({id:message.delivery.id,phase:'commit',retryCount:0},7),true);
  f.advance(31000);
  assert.equal(f.manager.snapshot().attempts[0].status,'unknown');
  if(intent)f.manager.execute(`group.${intent}`,{id:f.group.id});
  return receipt();
 }});
 await f.handle('PREPARE');await f.handle('COMMIT_PERMIT');
 if(intent)await f.handle('CONTROL');
 // 최초 보고의 거절/재전송은 입력을 다시 실행하지 않습니다. 현재 조회만 처리합니다.
 f.manager.tick();await f.handle('RECONCILE');
 const s=f.manager.snapshot();
 assert.equal(s.attempts[0].status,'confirmed');assert.equal(s.attempts[0].executionBlocked,true);
 assert.equal(s.groups[0].status,intent==='stop'?'stopped':intent==='pause'?'paused':'running');
 assert.equal(s.channels[0].playlistIndex,1);assert.equal(f.calls.filter(x=>x==='DICO_DELIVER').length,1);
 assert.equal(s.attempts.length,1);assert.equal(f.manager.events({type:'delivery.confirmed'}).length,1);
 if(!intent){f.advance(19000);assert.equal(f.manager.snapshot().attempts.length,1);f.advance(1000);assert.equal(f.manager.snapshot().attempts.length,2);}
});

test('차단 증명이 없는 unknown도 조회하되 근거가 없으면 차례와 입력 잠금을 유지한다',async t=>{
 const f=await fixture(t,{deliver:async()=>{throw Error('응답 포트 유실');}});
 await f.handle('PREPARE');await f.handle('COMMIT_PERMIT');
 f.manager.tick();await f.handle('RECONCILE');
 const s=f.manager.snapshot();assert.equal(s.attempts[0].status,'unknown');assert.equal(s.attempts[0].executionBlocked,false);
 assert.equal(s.channels[0].playlistIndex,0);assert.equal(s.groups[0].activeAttemptId,s.attempts[0].id);
 assert.equal(await f.executor.canSend({id:s.attempts[0].id,phase:'commit'},7),false);
 f.advance(6000);assert.ok(f.manager.commands(f.session.instanceId).some(c=>c.type==='RECONCILE'));
 assert.equal(f.manager.snapshot().attempts.length,1);assert.equal(f.calls.filter(x=>x==='DICO_DELIVER').length,1);
});

for(const intent of [null,'stop','pause'])test(`조회 발급 전에 확정 게시 결과가 도착해도 ${intent||'실행'} 의도가 결과를 결정한다`,async t=>{
 const f=await fixture(t);await f.handle('PREPARE');const a=f.manager.snapshot().attempts[0];
 f.bridge({type:'DELIVERY_RESULT',attemptId:a.id,outcome:'unknown',executionBlocked:true});
 if(intent){f.manager.execute(`group.${intent}`,{id:f.group.id});await f.handle('CONTROL');}
 assert.equal(f.manager.commands(f.session.instanceId).some(c=>c.type==='RECONCILE'),false);
 const result={type:'DELIVERY_RESULT',attemptId:a.id,outcome:'confirmed',messageId:'44444444444444444'};
 f.bridge(result);f.bridge(result);
 const s=f.manager.snapshot();assert.equal(s.groups[0].status,intent==='stop'?'stopped':intent==='pause'?'paused':'running');
 assert.equal(s.channels[0].playlistIndex,1);assert.equal(f.manager.events({type:'delivery.confirmed'}).length,1);
});

test('초안 조회 통신 실패는 같은 차례에서 자동 복구하고 조회 전에는 입력하지 않는다',async t=>{
 let broken=true;
 const f=await fixture(t,{inspect:()=>{if(broken)throw Error('콘텐츠 포트가 준비되지 않음');return{ok:true,draftText:'',draftMatches:false,unsupported:false,attachmentOrReply:false};}});
 for(let n=0;n<4;n++){
  await f.handle('PREPARE');const s=f.manager.snapshot();
  assert.equal(s.groups[0].status,'running');assert.equal(s.attempts.at(-1).status,'not_sent');
  assert.equal(s.groups[0].cursor,0);assert.equal(s.channels[0].playlistIndex,0);
  assert.equal(f.calls.includes('DICO_PREPARE'),false);assert.equal(f.calls.includes('DICO_DELIVER'),false);
  f.advance(5000);
 }
 broken=false;await f.handle('PREPARE');await f.handle('COMMIT_PERMIT');
 assert.equal(f.manager.snapshot().attempts.at(-1).status,'confirmed');
 assert.equal(f.manager.snapshot().channels[0].playlistIndex,1);assert.equal(f.calls.filter(x=>x==='DICO_DELIVER').length,1);
});

test('기존 발송 뒤에서 대기하는 조회는 하나만 유지하고 수신 시점부터 응답 만료를 센다',async t=>{
 const started=Promise.withResolvers(),completion=Promise.withResolvers();
 const f=await fixture(t,{deliver:()=>{started.resolve();return completion.promise;}});
 await f.handle('PREPARE');const sending=f.handle('COMMIT_PERMIT');await started.promise;
 let querying;
 try{
  f.advance(31000);
  const query=f.manager.commands(f.session.instanceId).find(c=>c.type==='RECONCILE');assert.ok(query);
  querying=f.executor.handleCommand(query);
  f.advance(90000);
  const commands=f.manager.commands(f.session.instanceId).filter(c=>c.type==='RECONCILE');
  assert.deepEqual(commands.map(c=>c.id),[query.id]);
  assert.equal(f.manager.events({type:'delivery.recovery_requested'}).length,1);
  assert.equal(f.calls.includes('DICO_RECONCILE'),false,'앞선 발송이 반환하기 전에는 조회를 실행하지 않습니다.');
  // 수신은 됐지만 응답을 잃은 경우에는 이후 30초부터 새 조회로 복구합니다.
  f.bridge({type:'ACK',commandId:query.id,status:'received'});
  f.advance(29000);assert.equal(f.manager.commands(f.session.instanceId).find(c=>c.type==='RECONCILE').id,query.id);
  f.advance(1000);assert.notEqual(f.manager.commands(f.session.instanceId).find(c=>c.type==='RECONCILE').id,query.id);
 }finally{
  completion.resolve(receipt());await sending;await querying;
 }
});
