import test from 'node:test';
import assert from 'node:assert/strict';
import {createCentralManager} from '../central/core/index.js';

function fixture(t){
  let time=1_800_000_000_000;
  const manager=createCentralManager({now:()=>time,monotonicNow:()=>time-1_799_999_999_000});
  t.after(()=>manager.close());
  const session=manager.bridge({type:'HELLO',protocolVersion:1});
  manager.bridge({type:'OBSERVATION',sessionId:session.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'111',guildId:'222',channelId:'333',tabId:1,verified:true}]},session.instanceId);
  const channel=manager.snapshot().channels[0];
  const group=manager.execute('group.create',{name:'중지 검증',members:[channel.id],intervalMs:0});
  const ack=(command,status,owner=session)=>manager.bridge({type:'ACK',sessionId:owner.sessionId,commandId:command.id,status,...(status==='rejected'?{rejectionCode:'NATIVE_REQUEST_TIMEOUT'}:{})},owner.instanceId);
  return{manager,session,group,ack,advance:()=>time+=3000};
}

for(const intent of ['stop','pause'])test(`거절 복구를 계속하다 재접속한 ${intent}는 현재 세션 적용 근거로 완료한다`,t=>{
  const f=fixture(t);f.manager.execute(`group.${intent}`,{id:f.group.id});
  // 최초 요청과 자동 복구 3회를 모두 거절한 실제 프로토콜 흐름을 재현합니다.
  // 저장 상태를 조작하지 않으므로 재접속이 남긴 과거 명령의 영향을 검증합니다.
  for(let n=0;n<4;n++){
    const command=f.manager.commands(f.session.instanceId).findLast(c=>c.type==='CONTROL');
    assert.ok(command);f.ack(command,'rejected');f.advance();f.manager.tick();
  }
  let snapshot=f.manager.snapshot();
  assert.equal(snapshot.groups[0].status,`${intent}_pending`);
  assert.equal(snapshot.groups[0].controlRecoveryCount,4);
  const failed=snapshot.commands.filter(c=>c.type==='CONTROL'&&c.status==='superseded');
  assert.equal(failed.length,4);
  assert.ok(snapshot.commands.some(c=>c.type==='CONTROL'&&c.status==='queued'));
  const reconnect=f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:f.session.instanceId});
  const current=f.manager.commands(reconnect.instanceId).findLast(c=>c.type==='CONTROL');
  assert.equal(current.sessionId,reconnect.sessionId);
  assert.equal(f.manager.snapshot().groups[0].status,`${intent}_pending`,'재접속 자체는 적용 근거가 아닙니다.');
  f.ack(current,'applied',reconnect);snapshot=f.manager.snapshot();
  assert.equal(snapshot.groups[0].status,intent==='stop'?'stopped':'paused');
  assert.equal(snapshot.groups[0].controlIntent,null);
  assert.equal(snapshot.commands.find(c=>c.id===failed[0].id).status,'superseded');
  assert.ok(snapshot.incidents.filter(i=>i.commandType==='CONTROL').every(i=>i.status==='resolved'));
  assert.equal(snapshot.attempts.length,0,'중지 복구는 새 발송을 생성하지 않습니다.');
});

test('같은 중지 실패의 재발은 이전 사건과 연결하고 다른 원인·그룹은 섞지 않는다',t=>{
  const f=fixture(t);f.manager.execute('group.stop',{id:f.group.id});
  const reject=code=>{
    const command=f.manager.commands(f.session.instanceId).findLast(c=>c.type==='CONTROL');
    f.manager.bridge({type:'ACK',sessionId:f.session.sessionId,commandId:command.id,status:'rejected',rejectionCode:code},f.session.instanceId);
    return f.manager.snapshot().incidents.find(i=>i.commandId===command.id);
  };
  const first=reject('NATIVE_REQUEST_TIMEOUT');f.advance();f.manager.tick();
  const second=reject('NATIVE_REQUEST_TIMEOUT');
  assert.equal(second.previousIncidentId,first.id);
  assert.equal(second.occurrenceNumber,2);
  assert.equal(second.recurrenceKey,first.recurrenceKey);
  assert.equal(second.firstOccurredAt,first.createdAt);
  assert.equal(first.status,'open','재발 연결은 과거 사건을 임의 해결하지 않습니다.');
  f.advance();f.manager.tick();const different=reject('CONTROL_FAILED');
  assert.equal(different.occurrenceNumber,1);assert.equal(different.previousIncidentId,undefined);
  const other=f.manager.execute('group.create',{name:'다른 그룹',members:f.manager.snapshot().groups[0].members,intervalMs:0});
  f.manager.execute('group.stop',{id:other.id});const unrelated=reject('NATIVE_REQUEST_TIMEOUT');
  assert.equal(unrelated.occurrenceNumber,1);assert.notEqual(unrelated.recurrenceKey,first.recurrenceKey);
  const event=f.manager.snapshot().events.find(e=>e.type==='incident.opened'&&e.incidentId===second.id);
  assert.equal(event.previousIncidentId,first.id);assert.equal(event.occurrenceNumber,2);
});

test('재접속 중지 완료는 실행 차단만 확정하고 미확인 발송·자원 잠금을 보존한다',t=>{
  const f=fixture(t),channel=f.manager.snapshot().channels[0];
  const message=f.manager.execute('message.create',{name:'검증',body:'외부로 보내지 않는 회귀 검증'});
  f.manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:[{messageId:message.id}]});
  f.ack(f.manager.commands(f.session.instanceId).findLast(c=>c.type==='CONFIG_SYNC'),'applied');
  f.manager.execute('group.start',{id:f.group.id});f.manager.tick();
  const attempt=f.manager.snapshot().attempts[0];
  f.manager.bridge({type:'PREPARED',sessionId:f.session.sessionId,attemptId:attempt.id,accountId:'111',channelId:'333',configVersion:attempt.configVersion,draftClear:true},f.session.instanceId);
  f.manager.execute('group.stop',{id:f.group.id});
  for(let n=0;n<4;n++){
    f.ack(f.manager.commands(f.session.instanceId).findLast(c=>c.type==='CONTROL'),'rejected');f.advance();f.manager.tick();
  }
  const reconnect=f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:f.session.instanceId});
  const control=f.manager.commands(reconnect.instanceId).findLast(c=>c.type==='CONTROL');
  f.manager.bridge({type:'ACK',sessionId:reconnect.sessionId,commandId:control.id,status:'applied',executionBlocked:true,attemptId:attempt.id},reconnect.instanceId);
  f.manager.tick();const snapshot=f.manager.snapshot();
  assert.equal(snapshot.groups[0].status,'stopped');assert.equal(snapshot.groups[0].activeAttemptId,attempt.id);
  assert.equal(snapshot.attempts.length,1);assert.equal(snapshot.attempts[0].status,'unknown');
  assert.equal(snapshot.attempts[0].executionBlocked,true);
  assert.ok(snapshot.incidents.some(i=>i.code==='delivery_unknown'&&i.status==='open'));
  assert.ok(snapshot.incidents.filter(i=>i.commandType==='CONTROL').every(i=>i.status==='resolved'));
  assert.throws(()=>f.manager.execute('group.resume',{id:f.group.id}),{code:'ATTEMPT_UNRESOLVED'});
  const rival=f.manager.execute('group.create',{name:'같은 자원',members:[channel.id],intervalMs:0});
  assert.throws(()=>f.manager.execute('group.start',{id:rival.id}),{code:'RESOURCE_BUSY'});
});

test('해결 뒤 같은 장애가 재발하면 읽지 않은 새 사건으로 연결하고 해결 근거를 보존한다',t=>{
  const f=fixture(t);f.manager.execute('group.stop',{id:f.group.id});
  const firstCommand=f.manager.commands(f.session.instanceId).findLast(c=>c.type==='CONTROL');f.ack(firstCommand,'rejected');
  const first=f.manager.snapshot().incidents.find(i=>i.commandId===firstCommand.id);
  f.manager.execute('incident.read',{id:first.id});f.advance();f.manager.tick();
  f.ack(f.manager.commands(f.session.instanceId).findLast(c=>c.type==='CONTROL'),'applied');
  assert.equal(f.manager.snapshot().incidents.find(i=>i.id===first.id).resolutionReason,'control_applied');
  f.manager.execute('group.stop',{id:f.group.id});
  const secondCommand=f.manager.commands(f.session.instanceId).findLast(c=>c.type==='CONTROL');f.ack(secondCommand,'rejected');
  const second=f.manager.snapshot().incidents.find(i=>i.commandId===secondCommand.id);
  assert.equal(second.previousIncidentId,first.id);assert.equal(second.occurrenceNumber,2);
  assert.equal(second.status,'open');assert.equal(second.read,false);
});

test('일시적인 입력 준비 오류는 3회 이후에도 같은 차례에서 복구하고 Enter 허가는 발급하지 않는다',t=>{
  const f=fixture(t),channel=f.manager.snapshot().channels[0];
  const message=f.manager.execute('message.create',{name:'준비 실패',body:'fixture only'});
  f.manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:[{messageId:message.id}]});
  f.ack(f.manager.commands(f.session.instanceId).findLast(c=>c.type==='CONFIG_SYNC'),'applied');
  f.manager.execute('group.start',{id:f.group.id});f.manager.tick();
  for(let count=0;count<4;count++){
    const command=f.manager.commands(f.session.instanceId).findLast(c=>c.type==='PREPARE');assert.ok(command);
    f.manager.bridge({type:'ACK',sessionId:f.session.sessionId,commandId:command.id,status:'rejected',rejectionCode:'CONTENT_UNAVAILABLE'},f.session.instanceId);
    f.advance();f.advance();f.manager.bridge({type:'HEARTBEAT',sessionId:f.session.sessionId},f.session.instanceId);f.manager.tick();
  }
  const snapshot=f.manager.snapshot();assert.equal(snapshot.groups[0].status,'running');assert.equal(snapshot.attempts.length,5);
  assert.ok(snapshot.attempts.slice(0,4).every(a=>a.status==='not_sent'&&a.maxSendRetries===null));assert.equal(snapshot.attempts[4].status,'preparing');
  assert.equal(snapshot.groups[0].cursor,0);assert.equal(snapshot.channels[0].playlistIndex,0);
  assert.equal(f.manager.events({type:'delivery.prepare_retry'}).length,4);assert.ok(!snapshot.commands.some(c=>c.type==='COMMIT_PERMIT'));
});
