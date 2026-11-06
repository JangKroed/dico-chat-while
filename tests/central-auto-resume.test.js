import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCentralManager} from '../central/core/index.js';

function fixture(t,{persistent=false}={}){
 let wall=1_800_000_000_000,mono=1000;
 const dir=persistent?mkdtempSync(join(tmpdir(),'dico-resume-')):null;
 const options={now:()=>wall,monotonicNow:()=>mono,...(dir?{databasePath:join(dir,'state.sqlite')}:{})};
 let manager=createCentralManager(options),session=manager.bridge({type:'HELLO',protocolVersion:1});
 const observe=()=>manager.bridge({type:'OBSERVATION',sessionId:session.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'111',guildId:'222',channelId:'333',tabId:1,verified:true}]},session.instanceId);
 observe();const channel=manager.snapshot().channels[0],message=manager.execute('message.create',{name:'fixture',body:'fixture'});
 manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:[{messageId:message.id}]});
 const ack=type=>{for(const c of manager.commands(session.instanceId).filter(c=>c.type===type))manager.bridge({type:'ACK',sessionId:session.sessionId,commandId:c.id,status:'applied'},session.instanceId);};
 ack('CONFIG_SYNC');const group=manager.execute('group.create',{name:'자동 복구',members:[channel.id],intervalMs:60000});manager.execute('group.start',{id:group.id});
 t.after(()=>{manager.close();if(dir)rmSync(dir,{recursive:true,force:true});});
 return{get manager(){return manager;},group,observe,ack,advance(ms){wall+=ms;mono+=ms;},reconnect(){session=manager.bridge({type:'HELLO',protocolVersion:1,instanceId:session.instanceId});},disconnect(){manager.bridge({type:'DISCONNECT',sessionId:session.sessionId},session.instanceId);},reopen(){manager.close();manager=createCentralManager(options);},get session(){return session;}};
}

test('loop delay 이후 현재 CONTROL ACK와 새 관찰 및 안정 시계가 모두 확인되어야 자동 재개한다',t=>{
 const f=fixture(t),oldRun=f.manager.snapshot().groups[0].runId;
 f.advance(16000);f.manager.tick();assert.ok(f.manager.snapshot().groups[0].autoResume);
 f.observe();f.advance(3000);f.manager.tick();assert.equal(f.manager.snapshot().groups[0].status,'pause_pending');
 f.ack('CONTROL');f.manager.tick();const s=f.manager.snapshot();
 assert.equal(s.groups[0].status,'running');assert.notEqual(s.groups[0].runId,oldRun);assert.equal(s.groups[0].autoResume,undefined);
 assert.equal(f.manager.events({type:'group.auto_resumed'}).length,1);
 f.manager.tick();assert.equal(f.manager.events({type:'group.auto_resumed'}).length,1);
});

for(const when of ['pending','applied'])test(`사용자 pause는 시스템 복구 의도를 취소한다 (${when})`,t=>{
 const f=fixture(t);f.advance(16000);f.manager.tick();if(when==='applied')f.ack('CONTROL');
 f.manager.execute('group.pause',{id:f.group.id});f.ack('CONTROL');f.advance(3000);f.observe();f.manager.tick();
 assert.equal(f.manager.snapshot().groups[0].status,'paused');assert.equal(f.manager.snapshot().groups[0].autoResume,undefined);assert.equal(f.manager.snapshot().attempts.length,0);
});

test('재연결은 새 세션의 CONTROL 적용과 설정 적용을 확인한 후 자동 재개한다',t=>{
 const f=fixture(t);f.disconnect();assert.ok(f.manager.snapshot().groups[0].autoResume);f.reconnect();f.advance(3000);f.observe();
 f.manager.tick();assert.notEqual(f.manager.snapshot().groups[0].status,'running');f.ack('CONTROL');f.manager.tick();assert.notEqual(f.manager.snapshot().groups[0].status,'running');
 f.ack('CONFIG_SYNC');f.manager.tick();assert.equal(f.manager.snapshot().groups[0].status,'running');
});

test('unknown 전송은 실행 차단 ACK 뒤에도 재전송하거나 새 시도를 만들지 않는다',t=>{
 const f=fixture(t);f.manager.tick();const attempt=f.manager.snapshot().attempts[0];
 f.manager.bridge({type:'PREPARED',sessionId:f.session.sessionId,attemptId:attempt.id,accountId:'111',channelId:'333',configVersion:attempt.configVersion,draftClear:true},f.session.instanceId);
 f.advance(16000);f.manager.tick();for(const c of f.manager.commands(f.session.instanceId).filter(c=>c.type==='CONTROL'))f.manager.bridge({type:'ACK',sessionId:f.session.sessionId,commandId:c.id,status:'applied',executionBlocked:true,attemptId:attempt.id},f.session.instanceId);
 f.advance(3000);f.observe();f.manager.tick();const s=f.manager.snapshot();assert.equal(s.attempts.length,1);assert.equal(s.attempts[0].status,'unknown');assert.notEqual(s.groups[0].status,'running');assert.throws(()=>f.manager.execute('group.resume',{id:f.group.id}),{code:'ATTEMPT_UNRESOLVED'});
});

for(const intent of ['pause','stop','service.stopAll'])test(`재시작은 저장된 ${intent} 의도를 되살리지 않는다`,t=>{
 const f=fixture(t,{persistent:true});f.advance(16000);f.manager.tick();f.manager.execute(intent==='service.stopAll'?intent:`group.${intent}`,{id:f.group.id});f.ack('CONTROL');f.reopen();f.reconnect();f.advance(3000);f.observe();f.ack('CONFIG_SYNC');f.manager.tick();
 assert.equal(f.manager.snapshot().groups[0].autoResume,undefined);assert.notEqual(f.manager.snapshot().groups[0].status,'running');assert.equal(f.manager.snapshot().attempts.length,0);
});

test('CONTROL 적용 뒤에도 중단 전 관찰이나 heartbeat만으로는 자동 재개하지 않는다',t=>{
 const f=fixture(t);f.advance(16000);f.manager.tick();f.ack('CONTROL');f.advance(3000);
 f.manager.bridge({type:'HEARTBEAT',sessionId:f.session.sessionId},f.session.instanceId);f.manager.tick();
 assert.equal(f.manager.snapshot().groups[0].status,'paused');assert.equal(f.manager.snapshot().attempts.length,0);
 f.observe();f.manager.tick();assert.equal(f.manager.snapshot().groups[0].status,'running');
});

test('자동 재개 뒤에도 마지막 성공부터의 그룹 간격을 지키며 밀린 발송을 만들지 않는다',t=>{
 const f=fixture(t);f.manager.tick();const a=f.manager.snapshot().attempts[0];
 f.manager.bridge({type:'PREPARED',sessionId:f.session.sessionId,attemptId:a.id,accountId:'111',channelId:'333',configVersion:a.configVersion,draftClear:true},f.session.instanceId);
 f.manager.bridge({type:'DELIVERY_RESULT',sessionId:f.session.sessionId,attemptId:a.id,outcome:'confirmed',messageId:'confirmed-fixture'},f.session.instanceId);
 f.advance(16000);f.manager.tick();f.ack('CONTROL');f.observe();f.advance(3000);f.manager.tick();
 assert.equal(f.manager.snapshot().groups[0].status,'running');assert.equal(f.manager.snapshot().attempts.length,1);assert.equal(f.manager.snapshot().groups[0].waitReason,'group_interval');
});

test('시스템 pause 적용 뒤 재연결되어도 새 세션의 CONTROL을 다시 확인한다',t=>{
 const f=fixture(t);f.advance(16000);f.manager.tick();f.ack('CONTROL');f.reconnect();f.advance(3000);f.observe();f.ack('CONFIG_SYNC');f.manager.tick();
 assert.equal(f.manager.snapshot().groups[0].status,'pause_pending');f.ack('CONTROL');f.manager.tick();assert.equal(f.manager.snapshot().groups[0].status,'running');
});

test('프로세스 재시작은 시스템 복구 의도를 보존하고 현재 세션 차단·설정·관찰 뒤 재개한다',t=>{
 const f=fixture(t,{persistent:true});f.advance(16000);f.manager.tick();f.ack('CONTROL');assert.ok(f.manager.snapshot().groups[0].autoResume);
 f.reopen();f.reconnect();f.advance(3000);f.observe();f.ack('CONFIG_SYNC');f.manager.tick();
 assert.ok(f.manager.snapshot().groups[0].autoResume);assert.notEqual(f.manager.snapshot().groups[0].status,'running');
 f.ack('CONTROL');f.manager.tick();
 assert.equal(f.manager.snapshot().groups[0].autoResume,undefined);assert.equal(f.manager.snapshot().groups[0].status,'running');assert.equal(f.manager.events({type:'group.auto_resumed'}).length,1);
});

test('실행 중 중앙 재시작도 새 CONTROL ACK 전에는 실행하지 않고 그 뒤 자동 복구한다',t=>{
 const f=fixture(t,{persistent:true});f.reopen();f.reconnect();f.advance(3000);f.observe();f.ack('CONFIG_SYNC');f.manager.tick();
 assert.notEqual(f.manager.snapshot().groups[0].status,'running');assert.equal(f.manager.snapshot().attempts.length,0);
 f.ack('CONTROL');f.manager.tick();assert.equal(f.manager.snapshot().groups[0].status,'running');
});

test('자원 경합은 오류 예산을 소모하지 않고 긴 대기 후 잠금이 해제되면 재개한다',t=>{
 const f=fixture(t);f.advance(16000);f.manager.tick();f.ack('CONTROL');f.observe();
 const rival=f.manager.execute('group.create',{name:'자원 점유',members:f.group.members,intervalMs:60000});f.manager.execute('group.start',{id:rival.id});
 for(const ms of [3000,6000,12000,12000]){f.advance(ms);f.observe();f.manager.tick();}
 let g=f.manager.snapshot().groups.find(g=>g.id===f.group.id);
 assert.equal(g.status,'paused');assert.equal(g.autoResume.retryCount,0);assert.equal(f.manager.events({type:'group.auto_resume_waiting'}).length,1);
 f.manager.execute('group.pause',{id:rival.id});
 for(const c of f.manager.commands(f.session.instanceId).filter(c=>c.type==='CONTROL'))f.manager.bridge({type:'ACK',sessionId:f.session.sessionId,commandId:c.id,status:'applied',executionBlocked:true,...(c.payload.attemptId?{attemptId:c.payload.attemptId}:{})},f.session.instanceId);
 f.advance(3000);f.observe();f.manager.tick();g=f.manager.snapshot().groups.find(g=>g.id===f.group.id);
 assert.equal(g.status,'running');assert.equal(g.autoResume,undefined);assert.equal(f.manager.events({type:'group.auto_resumed'}).length,1);
});

test('여러 멤버는 모든 브라우저의 현재 ACK와 새 관찰이 필요하다',t=>{
 const f=fixture(t);f.manager.execute('group.stop',{id:f.group.id});f.ack('CONTROL');
 const second=f.manager.bridge({type:'HELLO',protocolVersion:1});
 const observeSecond=()=>f.manager.bridge({type:'OBSERVATION',sessionId:second.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'444',guildId:'222',channelId:'333',tabId:2,verified:true}]},second.instanceId);
 observeSecond();let channel=f.manager.snapshot().channels.find(c=>c.instanceId===second.instanceId);
 f.manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:[{messageId:f.manager.snapshot().messages[0].id}]});
 const ackSecond=type=>{for(const c of f.manager.commands(second.instanceId).filter(c=>c.type===type))f.manager.bridge({type:'ACK',sessionId:second.sessionId,commandId:c.id,status:'applied'},second.instanceId);};
 ackSecond('CONFIG_SYNC');const group=f.manager.execute('group.create',{name:'모든 멤버',members:[...f.group.members,channel.id],intervalMs:60000});f.manager.execute('group.start',{id:group.id});
 f.advance(16000);f.manager.tick();f.ack('CONTROL');f.observe();observeSecond();f.advance(3000);f.manager.tick();
 assert.equal(f.manager.snapshot().groups.find(g=>g.id===group.id).status,'pause_pending');ackSecond('CONTROL');f.manager.tick();assert.equal(f.manager.snapshot().groups.find(g=>g.id===group.id).status,'running');
 assert.equal(f.manager.snapshot().groups.find(g=>g.id===f.group.id).status,'stopped');
});

for(const stopAgain of [false,true])test(`모두 실행 예약은 결과가 확인되면 재개하고 후속 중지가 우선한다 (${stopAgain})`,t=>{
 const f=fixture(t);f.manager.tick();const attempt=f.manager.snapshot().attempts[0];
 const bridge=m=>f.manager.bridge({...m,sessionId:f.session.sessionId},f.session.instanceId);
 bridge({type:'PREPARED',attemptId:attempt.id,accountId:'111',channelId:'333',configVersion:attempt.configVersion,draftClear:true});
 f.manager.execute('service.stopAll');
 for(const c of f.manager.commands(f.session.instanceId).filter(c=>c.type==='CONTROL'))bridge({type:'ACK',commandId:c.id,status:'applied',executionBlocked:true,attemptId:attempt.id});
 assert.equal(f.manager.snapshot().groups[0].status,'stopped');
 assert.equal(f.manager.execute('service.startAll').queuedForRecovery,1);
 const controls=f.manager.commands(f.session.instanceId).filter(c=>c.type==='CONTROL');
 assert.equal(f.manager.execute('service.startAll').queuedForRecovery,1);
 assert.deepEqual(f.manager.commands(f.session.instanceId).filter(c=>c.type==='CONTROL').map(c=>c.id),controls.map(c=>c.id));
 for(const c of controls)bridge({type:'ACK',commandId:c.id,status:'applied',executionBlocked:true,attemptId:attempt.id});
 f.advance(3000);f.observe();f.manager.tick();
 assert.equal(f.manager.snapshot().attempts.length,1);
 assert.equal(f.manager.snapshot().attempts[0].status,'unknown');
 assert.notEqual(f.manager.snapshot().groups[0].status,'running');
 assert.ok(f.manager.commands(f.session.instanceId).some(c=>c.type==='RECONCILE'));
 if(stopAgain){
  f.manager.execute('service.stopAll');
  for(const c of f.manager.commands(f.session.instanceId).filter(c=>c.type==='CONTROL'))bridge({type:'ACK',commandId:c.id,status:'applied',executionBlocked:true,attemptId:attempt.id});
 }
 const recovery=f.manager.commands(f.session.instanceId).find(c=>c.type==='RECONCILE');
 const window=recovery.payload.recoveryWindow;
 assert.ok(window);
 const snowflake=ms=>String(BigInt(ms-1420070400000)<<22n);
 assert.throws(()=>bridge({type:'DELIVERY_RESULT',attemptId:attempt.id,outcome:'confirmed',messageId:snowflake(window.until+1)}),{code:'EVIDENCE_REQUIRED'});
 bridge({type:'DELIVERY_RESULT',attemptId:attempt.id,outcome:'confirmed',messageId:snowflake(window.from)});
 f.manager.tick();
 assert.equal(f.manager.snapshot().groups[0].status,stopAgain?'stopped':'running');
 assert.equal(f.manager.snapshot().groups[0].autoResume,undefined);
 assert.equal(f.manager.snapshot().attempts.length,1);
});
