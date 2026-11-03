import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createCentralManager} from '../central/core/index.js';import {CentralStore} from '../central/core/store.js';
function fixture(t,options={}){
 let time=1_800_000_000_000;const manager=createCentralManager({...options,now:()=>time,monotonicNow:()=>time-1_799_999_999_000});t.after(()=>manager.close());
 const a=manager.execute('message.create',{name:'A',body:'A1'}),b=manager.execute('message.create',{name:'B',body:'B1'});
 const sessions=['111','112'].map((accountId,index)=>{
  const hello=manager.bridge({type:'HELLO',protocolVersion:1});const send=p=>manager.bridge({...p,sessionId:hello.sessionId},hello.instanceId);
  send({type:'OBSERVATION',legacyFrozen:true,legacyPending:false,channels:[{accountId,guildId:'222',channelId:'333',tabId:index+1,verified:true}]});
  let channel=manager.snapshot().channels.find(c=>c.instanceId===hello.instanceId);
  manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:[{messageId:a.id},{messageId:b.id}]});
  const ackConfig=()=>{const cmd=manager.commands(hello.instanceId).findLast(c=>c.type==='CONFIG_SYNC');assert.ok(cmd);send({type:'ACK',commandId:cmd.id,status:'applied'});return cmd;};ackConfig();
  channel=manager.snapshot().channels.find(c=>c.id===channel.id);return{...hello,send,channel,ackConfig};
 });
 const group=manager.execute('group.create',{name:'순서 보존',members:[sessions[0].channel.id],intervalMs:0});
 const update=(message,body)=>manager.execute('message.update',{id:message.id,expectedVersion:manager.snapshot().messages.find(m=>m.id===message.id).version,body});
 const start=()=>{manager.execute('group.start',{id:group.id});manager.tick();const attempt=manager.snapshot().attempts.at(-1);sessions[0].send({type:'PREPARED',attemptId:attempt.id,accountId:'111',channelId:'333',configVersion:attempt.configVersion,draftClear:true});return attempt;};
 return{manager,a,b,sessions,group,update,start,advance:()=>{time+=4000;for(const s of sessions)s.send({type:'HEARTBEAT'});manager.tick();}};
}
test('보관함 저장은 연결된 모든 채널을 최신 문구로 자동 동기화한다',t=>{
 const f=fixture(t),updated=f.update(f.a,'A2');
 for(const s of f.sessions){const c=f.manager.snapshot().channels.find(c=>c.id===s.channel.id);assert.equal(c.playlist[0].revisionId,updated.revisionId);assert.equal(c.playlistIndex,0);assert.equal(s.ackConfig().payload.items[0].body,'A2');}
});
test('실행 중 연속 수정은 현재 시도를 보존하고 다음 순서에 최신본만 적용한다',t=>{
 const f=fixture(t),attempt=f.start(),oldConfig=attempt.configVersion;
 f.update(f.a,'A2');const latest=f.update(f.a,'A3');const next=f.update(f.b,'B2');
 let snapshot=f.manager.snapshot(),c=snapshot.channels[0];assert.equal(c.configVersion,oldConfig);assert.equal(c.playlist[0].revisionId,f.a.revisionId);
 assert.equal(c.pendingPlaylist[0].revisionId,latest.revisionId);assert.equal(c.pendingPlaylist[1].revisionId,next.revisionId);assert.equal(snapshot.groups[0].status,'running');assert.equal(snapshot.attempts[0].revisionId,f.a.revisionId);
 assert.equal(f.manager.commands(f.sessions[0].instanceId).some(c=>c.type==='CONTROL'),false);
 f.sessions[0].send({type:'DELIVERY_RESULT',attemptId:attempt.id,outcome:'confirmed',messageId:'observed-1'});
 c=f.manager.snapshot().channels[0];assert.equal(c.playlistIndex,1);assert.equal(c.playlist[0].revisionId,latest.revisionId);assert.equal(c.pendingPlaylist,undefined);
 f.sessions[0].ackConfig();f.advance();const prepare=f.manager.commands(f.sessions[0].instanceId).findLast(c=>c.type==='PREPARE');assert.equal(prepare.payload.body,'B2');assert.equal(f.manager.snapshot().attempts.length,2);
});
test('미확인 발송의 설정과 잠금은 그대로 두고 변경 문구만 예약한다',t=>{
 const f=fixture(t),attempt=f.start();f.sessions[0].send({type:'DELIVERY_RESULT',attemptId:attempt.id,outcome:'unknown',executionBlocked:true});
 const before=f.manager.supportData().locks,latest=f.update(f.a,'A2'),snapshot=f.manager.snapshot();
 assert.equal(snapshot.channels[0].configVersion,attempt.configVersion);assert.equal(snapshot.channels[0].pendingPlaylist[0].revisionId,latest.revisionId);assert.equal(snapshot.attempts[0].status,'unknown');assert.deepEqual(f.manager.supportData().locks,before);
 f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);assert.throws(()=>f.manager.execute('group.resume',{id:f.group.id}),{code:'ATTEMPT_UNRESOLVED'});
});
test('수동 변경 대기목록에서 빠진 문구는 되살리지 않고 남은 문구만 최신화한다',t=>{
 const f=fixture(t);f.start();const c=f.manager.snapshot().channels[0];
 f.manager.execute('channel.applyPlaylist',{id:c.id,expectedVersion:c.version,items:[{messageId:f.b.id}]});
 f.update(f.a,'A2');const latest=f.update(f.b,'B2'),pending=f.manager.snapshot().channels[0].pendingPlaylist;
 assert.deepEqual(pending,[{messageId:f.b.id,revisionId:latest.revisionId}]);
});
test('구버전 화면의 revisionId 입력은 최신본으로 정규화한다',t=>{
 const f=fixture(t),latest=f.update(f.a,'A2'),c=f.manager.snapshot().channels[0];
 f.manager.execute('channel.applyPlaylist',{id:c.id,expectedVersion:c.version,items:[{messageId:f.a.id,revisionId:f.a.revisionId}]});
 assert.equal(f.manager.snapshot().channels[0].playlist[0].revisionId,latest.revisionId);
});
test('오프라인 수정도 재연결 때 최신본을 적용하고 자동 갱신은 사용자 편집 버전을 바꾸지 않는다',t=>{
 const f=fixture(t),s=f.sessions[1],before=f.manager.snapshot().channels[1];s.send({type:'DISCONNECT'});
 const latest=f.update(f.a,'offline A2'),c=f.manager.snapshot().channels[1];
 assert.equal(c.version,before.version);assert.equal(c.playlist[0].revisionId,latest.revisionId);assert.ok(c.configVersion>before.configVersion);
 s.send({type:'OBSERVATION',legacyFrozen:true,legacyPending:false,channels:[{accountId:'112',guildId:'222',channelId:'333',tabId:2,verified:true}]});
 assert.equal(s.ackConfig().payload.items[0].body,'offline A2');
});
test('과거 백업의 버전 고정은 최신본으로 복원하되 순서 위치는 유지한다',t=>{
 const f=fixture(t),latest=f.update(f.a,'A2'),backup=f.manager.exportBackup();
 backup.channels[0].playlist[0].revisionId=f.a.revisionId;backup.channels[0].playlistIndex=1;
 f.manager.importBackup(backup);const c=f.manager.snapshot().channels[0];assert.equal(c.playlist[0].revisionId,latest.revisionId);assert.equal(c.playlistIndex,1);assert.equal(f.manager.snapshot().groups[0].status,'stopped');
});
for(const active of [false,true])test(`저장된 구버전 연결 이행은 순서와 ${active?'미확인 실행':'대기 상태'}를 보존한다`,t=>{
 const directory=mkdtempSync(join(tmpdir(),'dico-message-migration-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const databasePath=join(directory,'state.sqlite');
 const f=fixture(t,{databasePath});const attempt=active?f.start():null;const latest=f.update(f.a,'A2');f.manager.close();
 const store=new CentralStore(databasePath),state=store.read(),c=state.channels[0];c.playlist[0].revisionId=f.a.revisionId;c.playlistIndex=active?0:1;delete c.pendingPlaylist;delete c.pendingPlaylistPreserveIndex;const configVersion=c.configVersion;state.stateVersion++;store.commit(state,[]);store.close();
 const reopened=createCentralManager({databasePath});try{
  const snapshot=reopened.snapshot(),channel=snapshot.channels[0];assert.equal(channel.playlistIndex,active?0:1);assert.equal(snapshot.attempts.length,active?1:0);
  if(active){assert.equal(channel.configVersion,configVersion);assert.equal(channel.playlist[0].revisionId,f.a.revisionId);assert.equal(channel.pendingPlaylist[0].revisionId,latest.revisionId);assert.equal(snapshot.attempts[0].revisionId,attempt.revisionId);assert.equal(snapshot.attempts[0].status,'unknown');assert.throws(()=>reopened.execute('group.start',{id:f.group.id}),{code:'ATTEMPT_UNRESOLVED'});}
  else assert.equal(channel.playlist[0].revisionId,latest.revisionId);
 }finally{reopened.close();}
});
