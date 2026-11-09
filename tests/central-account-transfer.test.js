import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CentralStore} from '../central/core/store.js';
import {createCentralManager} from '../central/core/index.js';
function fixture(options={}){
 let time=1_800_000_000_000;
 const manager=createCentralManager({now:()=>time,monotonicNow:()=>1000,...options});
 const hello=()=>manager.bridge({type:'HELLO',protocolVersion:1,capabilities:['open-channel-v1','close-channel-v1','skip-unknown-v1']});
 const first=hello(),second=hello();
 const account=(owner,accountId,explicitRegistration=false)=>manager.bridge({type:'ACCOUNT_OBSERVATION',sessionId:owner.sessionId,accountId,verified:true,explicitRegistration,legacyFrozen:true,legacyPending:false},owner.instanceId);
 const observe=(owner,accountId,tabId)=>manager.bridge({type:'OBSERVATION',sessionId:owner.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId,guildId:'222',channelId:'333',tabId,verified:true}]},owner.instanceId);
 observe(first,'111',1);observe(second,'444',2);
 const channels=manager.snapshot().channels;
 const message=manager.execute('message.create',{name:'보관 문구',body:'기존 문구 유지'});
 for(const c of channels){manager.execute('channel.applyPlaylist',{id:c.id,expectedVersion:c.version,items:[{messageId:message.id}]});const cmd=manager.commands(c.instanceId).findLast(c=>c.type==='CONFIG_SYNC');const owner=c.instanceId===first.instanceId?first:second;manager.bridge({type:'ACK',sessionId:owner.sessionId,commandId:cmd.id,status:'applied'},owner.instanceId);}
 const group=manager.execute('group.create',{name:'순서 보존',members:channels.map(c=>c.id),intervalMs:20000});
 return{manager,first,second,account,observe,channels,group,advance:ms=>{time+=ms;}};
}
test('브라우저 계정을 서로 바꿔 명시 저장하면 계정·그룹·메시지 ID를 유지하며 연결만 이동한다',()=>{
 const f=fixture();try{
  const before=f.manager.snapshot();
  f.account(f.second,'111',true);f.account(f.first,'444',true);
  const s=f.manager.snapshot();assert.equal(s.accounts.length,2);assert.equal(s.channels.length,2);
  assert.deepEqual(s.accounts.map(a=>a.id).sort(),before.accounts.map(a=>a.id).sort());
  assert.deepEqual(s.groups[0].members,before.groups[0].members);assert.equal(s.groups[0].status,'stopped');
  for(const c of s.channels){const old=before.channels.find(a=>a.id===c.id);assert.deepEqual(c.playlist,old.playlist);assert.notEqual(c.instanceId,old.instanceId);assert.equal(c.verified,false);assert.equal(c.appliedVersion,0);}
  assert.equal(s.commands.filter(c=>c.type==='OPEN_CHANNEL'&&c.status==='queued').length,2);
  f.observe(f.first,'111',1);f.account(f.first,'111');
  assert.equal(f.manager.snapshot().accounts.length,2);assert.equal(f.manager.snapshot().channels.length,2);
  f.observe(f.second,'111',9);f.observe(f.first,'444',10);
  assert.ok(f.manager.snapshot().channels.every(c=>c.verified));
 }finally{f.manager.close();}
});
test('자동 관측만으로 계정 소유 브라우저를 빼앗거나 기존 설정을 이동하지 않는다',()=>{
 const f=fixture();try{f.account(f.second,'111');assert.equal(f.manager.snapshot().channels[0].instanceId,f.first.instanceId);}finally{f.manager.close();}
});
test('이미 생긴 중복 계정은 명시 저장으로 합치고 설정된 기존 연결을 보존한다',()=>{
 const f=fixture();try{
  f.account(f.second,'111');f.observe(f.second,'111',9);
  f.account(f.second,'111',true);
  const s=f.manager.snapshot();assert.equal(s.accounts.filter(a=>a.accountId==='111').length,1);assert.equal(s.channels.filter(c=>c.accountId==='111').length,1);
  assert.equal(s.channels.find(c=>c.accountId==='111').id,f.channels[0].id);
  assert.deepEqual(s.groups[0].members,f.channels.map(c=>c.id));assert.equal(s.channels.find(c=>c.accountId==='111').playlist.length,1);
 }finally{f.manager.close();}
});

test('실행 중 이동은 이전 실행을 차단하고 양쪽 제어 ACK로 대기를 완료한다',()=>{
 const f=fixture();try{
  // 새 소유자가 원래 그룹에 없었던 경우도 완료될 수 있어야 합니다.
  f.manager.execute('group.update',{id:f.group.id,expectedVersion:f.group.version,members:[f.channels[0].id]});
  f.manager.execute('group.start',{id:f.group.id});f.manager.tick();
  const attempt=f.manager.snapshot().attempts[0];assert.ok(attempt);
  f.manager.bridge({type:'PREPARED',sessionId:f.first.sessionId,attemptId:attempt.id,accountId:attempt.accountId,channelId:attempt.channelId,configVersion:attempt.configVersion,draftClear:true},f.first.instanceId);
  f.account(f.second,'111',true);
  const controls=f.manager.snapshot().commands.filter(c=>c.type==='CONTROL'&&c.payload.groupId===f.group.id);
  assert.equal(controls.length,2);
  for(const cmd of controls){const owner=cmd.instanceId===f.first.instanceId?f.first:f.second;f.manager.bridge({type:'ACK',sessionId:owner.sessionId,commandId:cmd.id,status:'applied',...(cmd.payload.attemptId?{attemptId:attempt.id,executionBlocked:true}:{})},owner.instanceId);}
  const s=f.manager.snapshot();assert.equal(s.groups[0].controlIntent,null);assert.equal(s.groups[0].status,'paused');assert.equal(s.attempts[0].status,'unknown');
  const authorization=f.manager.bridge({type:'AUTHORIZE_ENTER',sessionId:f.first.sessionId,attemptId:attempt.id,runId:attempt.runId,configVersion:attempt.configVersion},f.first.instanceId);assert.equal(authorization.allowed,false);
 }finally{f.manager.close();}
});

test('이동 직후 이전 실행기가 재연결해도 제어를 재발급해 입력 차단을 완료한다',()=>{
 const f=fixture();try{
  f.manager.execute('group.update',{id:f.group.id,expectedVersion:f.group.version,members:[f.channels[0].id]});
  f.manager.execute('group.start',{id:f.group.id});f.manager.tick();
  const attempt=f.manager.snapshot().attempts[0];
  f.manager.bridge({type:'PREPARED',sessionId:f.first.sessionId,attemptId:attempt.id,accountId:attempt.accountId,channelId:attempt.channelId,configVersion:attempt.configVersion,draftClear:true},f.first.instanceId);
  f.account(f.second,'111',true);
  const session=f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:f.first.instanceId,capabilities:['open-channel-v1','close-channel-v1','skip-unknown-v1']});
  const control=session.commands.find(c=>c.type==='CONTROL');assert.ok(control);assert.equal(control.payload.attemptId,attempt.id);
  assert.equal(session.commands.some(c=>c.type==='RECONCILE'),false);
  f.manager.bridge({type:'ACK',sessionId:session.sessionId,commandId:control.id,status:'applied',attemptId:attempt.id,executionBlocked:true},session.instanceId);
  const currentControl=f.manager.commands(f.second.instanceId).find(c=>c.type==='CONTROL');assert.ok(currentControl);
  f.manager.bridge({type:'ACK',sessionId:f.second.sessionId,commandId:currentControl.id,status:'applied'},f.second.instanceId);
  const close=session.commands.find(c=>c.type==='CLOSE_CHANNEL');assert.ok(close);
  f.manager.bridge({type:'ACK',sessionId:session.sessionId,commandId:close.id,status:'applied'},session.instanceId);
  const s=f.manager.snapshot();assert.equal(s.groups[0].controlIntent,null);assert.equal(s.groups[0].status,'paused');
  assert.equal(s.attempts[0].status,'unknown');assert.equal(s.attempts[0].executionBlocked,true);assert.equal(s.pendingTabCloses.length,0);
 }finally{f.manager.close();}
});

test('이동 후 사용자 중지도 이전 활성 실행기와 현재 소유자 모두 차단한다',()=>{
 const f=fixture();try{
  f.manager.execute('group.update',{id:f.group.id,expectedVersion:f.group.version,members:[f.channels[0].id]});
  f.manager.execute('group.start',{id:f.group.id});f.manager.tick();
  const attempt=f.manager.snapshot().attempts[0];
  f.manager.bridge({type:'PREPARED',sessionId:f.first.sessionId,attemptId:attempt.id,accountId:attempt.accountId,channelId:attempt.channelId,configVersion:attempt.configVersion,draftClear:true},f.first.instanceId);
  f.account(f.second,'111',true);
  f.manager.execute('group.stop',{id:f.group.id});
  const group=f.manager.snapshot().groups[0];
  const controls=f.manager.snapshot().commands.filter(c=>c.type==='CONTROL'&&c.payload.controlGeneration===group.controlGeneration);
  assert.equal(controls.length,2);assert.ok(controls.every(c=>c.payload.action==='stop'));
  for(const cmd of controls){
   const owner=cmd.instanceId===f.first.instanceId?f.first:f.second;
   assert.equal(cmd.payload.attemptId,owner===f.first?attempt.id:null);
   f.manager.bridge({type:'ACK',sessionId:owner.sessionId,commandId:cmd.id,status:'applied',...(cmd.payload.attemptId?{attemptId:attempt.id,executionBlocked:true}:{})},owner.instanceId);
  }
  const s=f.manager.snapshot();assert.equal(s.groups[0].status,'stopped');assert.equal(s.groups[0].controlIntent,null);assert.equal(s.groups[0].autoResume,undefined);
  assert.equal(s.attempts[0].status,'unknown');assert.equal(s.attempts[0].executionBlocked,true);
  const authorization=f.manager.bridge({type:'AUTHORIZE_ENTER',sessionId:f.first.sessionId,attemptId:attempt.id,runId:attempt.runId,configVersion:attempt.configVersion},f.first.instanceId);assert.equal(authorization.allowed,false);
 }finally{f.manager.close();}
});

test('이전 브라우저로 돌아오면 남아 있는 닫기 완료 뒤에만 다시 연다',()=>{
 const f=fixture();try{
  f.account(f.second,'111',true);
  const close=f.manager.commands(f.first.instanceId).find(c=>c.type==='CLOSE_CHANNEL');assert.ok(close);
  f.manager.bridge({type:'ACK',sessionId:f.first.sessionId,commandId:close.id,status:'received'},f.first.instanceId);
  f.account(f.first,'111',true);
  assert.ok(f.manager.snapshot().pendingTabCloses.some(r=>r.removalId===close.payload.removalId));
  assert.equal(f.manager.commands(f.first.instanceId).some(c=>c.type==='OPEN_CHANNEL'),false);
  f.observe(f.first,'111',1);assert.equal(f.manager.snapshot().channels.find(c=>c.accountId==='111').verified,false);
  f.account(f.first,'111',true);
  assert.equal(f.manager.commands(f.first.instanceId).some(c=>c.type==='OPEN_CHANNEL'),false);
  f.manager.bridge({type:'ACK',sessionId:f.first.sessionId,commandId:close.id,status:'applied'},f.first.instanceId);
  assert.equal(f.manager.commands(f.first.instanceId).filter(c=>c.type==='OPEN_CHANNEL').length,1);
  f.observe(f.first,'111',12);assert.equal(f.manager.snapshot().channels.find(c=>c.accountId==='111').verified,true);
 }finally{f.manager.close();}
});

function persistedDuplicates(run){
 const dir=mkdtempSync(join(tmpdir(),'dico-transfer-')),databasePath=join(dir,'state.sqlite');let manager;
 try{
  const f=fixture({databasePath});f.account(f.second,'111');f.observe(f.second,'111',9);
  const extra=['B','C','D'].map(name=>f.manager.execute('message.create',{name,body:name}));
  f.manager.close();const store=new CentralStore(databasePath),state=store.read();
  const kept=state.channels.find(c=>c.id===f.channels[0].id),other=state.channels.find(c=>c.accountId==='111'&&c.id!==kept.id);
  const items=extra.map(m=>({messageId:m.id,revisionId:m.revisionId}));
  other.playlist=items.slice(0,2);other.playlistIndex=0;
  run.seed?.({state,kept,other,items});state.stateVersion++;store.commit(state,[]);store.close();
  manager=createCentralManager({databasePath,now:()=>1_800_000_000_000,monotonicNow:()=>1000});
  const session=manager.bridge({type:'HELLO',protocolVersion:1,instanceId:f.second.instanceId,capabilities:['open-channel-v1','close-channel-v1']});
  manager.bridge({type:'ACCOUNT_OBSERVATION',sessionId:session.sessionId,accountId:'111',verified:true,explicitRegistration:true},session.instanceId);
  run.check({manager,kept,other,items,databasePath,session});
 }finally{manager?.close();rmSync(dir,{recursive:true,force:true});}
}

test('중복 연결의 예약 문구와 기존 문구를 합쳐 결과 확정 후에도 보존한다',()=>{
 persistedDuplicates({seed:({state,kept,other,items})=>{
  kept.pendingPlaylist=[items[2]];other.pendingPlaylist=items.slice(1,2);
  const g=state.groups[0];g.activeAttemptId='pending-attempt';g.status='paused';
  state.attempts.push({id:'pending-attempt',groupId:g.id,bindingId:kept.id,instanceId:kept.instanceId,accountId:kept.accountId,status:'unknown',executionBlocked:true,playlistIndex:0,messageIdRef:kept.playlist[0].messageId,revisionId:kept.playlist[0].revisionId,createdAt:1_800_000_000_000});
 },check:({manager,items})=>{
  const merged=manager.snapshot().channels.find(c=>c.accountId==='111');
  assert.deepEqual(merged.pendingPlaylist,[items[2],items[1]]);
  manager.execute('attempt.resolve',{id:'pending-attempt',outcome:'not_sent'});
  assert.deepEqual(manager.snapshot().channels.find(c=>c.accountId==='111').playlist,[items[2],items[1]]);
 }});
});

test('중복 연결에서 진행하던 문구 다음 위치를 병합 목록으로 변환한다',()=>{
 persistedDuplicates({seed:({state,other,items})=>{
  const g={...state.groups[0],id:'other-group',members:[other.id],activeAttemptId:'other-attempt',status:'paused'};state.groups.push(g);
  state.attempts.push({id:'other-attempt',groupId:g.id,bindingId:other.id,instanceId:other.instanceId,accountId:other.accountId,status:'unknown',executionBlocked:true,permitId:'permit',playlistIndex:0,messageIdRef:items[0].messageId,revisionId:items[0].revisionId,createdAt:1_800_000_000_000});
 },check:({manager,items})=>{
  manager.execute('attempt.resolve',{id:'other-attempt',outcome:'confirmed',messageId:'evidence'});
  const merged=manager.snapshot().channels.find(c=>c.accountId==='111');assert.equal(merged.playlist[merged.playlistIndex].messageId,items[1].messageId);
 }});
});

test('중복 연결의 실제 발송·건너뛰기 대기 근거는 서비스 재개와 재시작에도 보존된다',()=>{
 persistedDuplicates({seed:({kept,other})=>{
  kept.intervalMode='custom';kept.customIntervalMs=90000;kept.intervalMs=90000;kept.lastConfirmedAt=1_799_999_990_000;kept.lastConfirmationMs=0;
  other.lastConfirmedAt=1_799_999_999_000;other.lastConfirmationMs=2000;other.lastConfirmedAttemptId='actual-confirmation';other.lastSkippedAt=1_799_999_998_000;
 },check:({manager,databasePath})=>{
  manager.execute('service.resume',{});
  let c=manager.snapshot().channels.find(c=>c.accountId==='111');assert.equal(c.lastConfirmedAt,1_799_999_999_000);assert.equal(c.lastConfirmedAttemptId,'actual-confirmation');assert.equal(c.lastSkippedAt,1_799_999_998_000);assert.equal(c.customIntervalMs,90000);
  manager.close();const restarted=createCentralManager({databasePath,now:()=>1_800_000_000_000,monotonicNow:()=>5000});
  try{const session=restarted.bridge({type:'HELLO',protocolVersion:1,instanceId:c.instanceId});restarted.bridge({type:'OBSERVATION',sessionId:session.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'111',guildId:'222',channelId:'333',tabId:22,verified:true}]},session.instanceId);const config=restarted.commands(session.instanceId).find(c=>c.type==='CONFIG_SYNC');assert.ok(config);restarted.bridge({type:'ACK',sessionId:session.sessionId,commandId:config.id,status:'applied'},session.instanceId);c=restarted.snapshot().channels.find(c=>c.accountId==='111');assert.equal(c.nextEligibleAt,1_800_000_088_000);}finally{restarted.close();}
 }});
});

test('복귀 후 세션이 바뀌어도 이전 닫기 ACK를 받은 다음 자동 열기를 복구한다',()=>{
 const f=fixture();try{
  f.account(f.second,'111',true);f.account(f.first,'111',true);
  const session=f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:f.first.instanceId,capabilities:['open-channel-v1','close-channel-v1']});
  assert.equal(session.commands.some(c=>c.type==='OPEN_CHANNEL'),false);
  const close=session.commands.find(c=>c.type==='CLOSE_CHANNEL');assert.ok(close);
  f.manager.bridge({type:'ACK',sessionId:session.sessionId,commandId:close.id,status:'applied'},session.instanceId);
  assert.equal(f.manager.commands(session.instanceId).filter(c=>c.type==='OPEN_CHANNEL').length,1);
 }finally{f.manager.close();}
});

test('중복 연결에 남은 예약 문구는 활성 시도가 없으면 즉시 최종 목록으로 적용한다',()=>{
 persistedDuplicates({seed:({other,items})=>{other.pendingPlaylist=[items[2]];other.pendingPlaylistPreserveIndex=true;},check:({manager,kept,items})=>{
  const merged=manager.snapshot().channels.find(c=>c.accountId==='111');assert.deepEqual(merged.playlist,[...kept.playlist,items[2]]);assert.equal(merged.pendingPlaylist,undefined);
 }});
});


test('이동한 채널 열기의 일시 실패는 30초 뒤 heartbeat로 자동 재시도한다',()=>{
 const f=fixture();try{
  f.account(f.second,'111',true);
  const first=f.manager.commands(f.second.instanceId).find(c=>c.type==='OPEN_CHANNEL');assert.ok(first);
  f.manager.bridge({type:'ACK',sessionId:f.second.sessionId,commandId:first.id,status:'rejected',rejectionCode:'ATTEMPT_UNRESOLVED'},f.second.instanceId);
  const beat=()=>f.manager.bridge({type:'HEARTBEAT',sessionId:f.second.sessionId},f.second.instanceId);
  beat();assert.equal(f.manager.commands(f.second.instanceId).filter(c=>c.type==='OPEN_CHANNEL').length,0);
  f.advance(30000);beat();const retry=f.manager.commands(f.second.instanceId).find(c=>c.type==='OPEN_CHANNEL');assert.ok(retry);assert.notEqual(retry.id,first.id);
  beat();assert.equal(f.manager.commands(f.second.instanceId).filter(c=>c.type==='OPEN_CHANNEL').length,1);
 }finally{f.manager.close();}
});

test('실제 로그인 계정을 관측하면 기존 중복을 정리하고 그룹과 문구를 자동으로 이동한다',()=>{
 const f=fixture();try{
  f.account(f.second,'111');f.observe(f.second,'111',9);
  const target=f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:f.second.instanceId,capabilities:['open-channel-v1','automatic-account-routing-v1']});
  f.manager.bridge({type:'ACCOUNT_OBSERVATION',sessionId:f.first.sessionId,accountId:'111',verified:false,verificationReason:'account_mismatch'},f.first.instanceId);
  f.account(target,'111');
  let s=f.manager.snapshot();
  assert.equal(s.accounts.filter(a=>a.accountId==='111').length,1);
  assert.equal(s.channels.filter(c=>c.accountId==='111').length,1);
  assert.deepEqual(s.groups[0].members,f.channels.map(c=>c.id));
  assert.equal(s.channels.find(c=>c.id===f.channels[0].id).instanceId,target.instanceId);
  assert.equal(s.channels.find(c=>c.id===f.channels[0].id).playlist.length,1);
  f.observe(f.first,'111',1);
  s=f.manager.snapshot();
  assert.equal(s.channels.filter(c=>c.accountId==='111').length,1);
 }finally{f.manager.close();}
});

test('같은 계정의 기존 검증된 연결을 재사용하고 다른 브라우저 관측만으로 복제하지 않는다',()=>{
 const f=fixture();try{
  const target=f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:f.second.instanceId,capabilities:['open-channel-v1','automatic-account-routing-v1']});
  f.account(target,'111');f.observe(target,'111',9);
  const s=f.manager.snapshot();
  assert.equal(s.accounts.filter(a=>a.accountId==='111').length,1);
  assert.equal(s.channels.filter(c=>c.accountId==='111').length,1);
  assert.equal(s.channels.find(c=>c.accountId==='111').instanceId,f.first.instanceId);
 }finally{f.manager.close();}
});

test('두 브라우저의 계정이 바뀌어도 모두 실행은 새 연결의 설정 ACK까지 기다린다',()=>{
 const f=fixture();try{
  const reload=owner=>f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:owner.instanceId,browser:'Chrome',capabilities:['open-channel-v1','close-channel-v1','automatic-account-routing-v1']});
  const first=reload(f.first),second=reload(f.second);
  f.account(first,'444');f.account(second,'111');
  let s=f.manager.snapshot();
  assert.deepEqual(s.groups[0].members,f.channels.map(c=>c.id));
  assert.equal(s.accounts.length,2);
  assert.equal(s.channels.find(c=>c.accountId==='111').instanceId,second.instanceId);
  assert.equal(s.channels.find(c=>c.accountId==='444').instanceId,first.instanceId);
  assert.equal(s.commands.filter(c=>c.type==='CLOSE_CHANNEL'&&c.payload.detachOnly===true).length,2);
  const result=f.manager.execute('service.startAll',{});
  assert.equal(result.queuedForRecovery,1);
  f.manager.tick();
  assert.equal(f.manager.snapshot().attempts.length,0);
  f.observe(first,'444',10);f.observe(second,'111',20);
  for(const owner of [first,second]){
   const config=f.manager.commands(owner.instanceId).findLast(cmd=>cmd.type==='CONFIG_SYNC');
   assert.ok(config);
   f.manager.bridge({type:'ACK',sessionId:owner.sessionId,commandId:config.id,status:'applied'},owner.instanceId);
  }
  f.manager.tick();s=f.manager.snapshot();
  assert.equal(s.groups[0].status,'running');
  assert.equal(s.attempts[0].instanceId,second.instanceId);
  assert.equal(s.attempts[0].accountId,'111');
 }finally{f.manager.close();}
});
