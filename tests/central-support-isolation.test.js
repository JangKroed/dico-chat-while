import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCentralManager} from '../central/core/index.js';
import {CentralStore} from '../central/core/store.js';
import {createSupportCollector} from '../central/runtime/support-collector.mjs';

test('누적 120000건 제보 수집이 중앙 명령·이벤트 루프를 점유하지 않는다',{timeout:20000},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'dico-support-worker-')),databasePath=join(dir,'central.sqlite');
 let manager=createCentralManager({databasePath});manager.close();
 const store=new CentralStore(databasePath),state=store.read(),at=Date.now();state.stateVersion++;
 store.commit(state,Array.from({length:120000},(_,n)=>({type:'delivery.trace',at:at+n,attemptId:'old-'+n,data:{stage:'observe',retryCount:n%90}})));store.close();
 manager=createCentralManager({databasePath});
 // 빈 서비스의 no-op 중지가 아니라 실제 두 브라우저의 준비 중 그룹을 중지합니다.
 const peers=['a','b'].map((accountId,n)=>{
  const peer=manager.bridge({type:'HELLO',protocolVersion:1});
  manager.bridge({type:'OBSERVATION',sessionId:peer.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId,guildId:'g',channelId:'c',tabId:n+1,verified:true}]},peer.instanceId);
  return peer;
 });
 const message=manager.execute('message.create',{name:'fixture',body:'synthetic'});
 for(const c of manager.snapshot().channels){
  manager.execute('channel.applyPlaylist',{id:c.id,expectedVersion:c.version,items:[{messageId:message.id}]});
  const peer=peers.find(p=>p.instanceId===c.instanceId);
  for(const cmd of manager.commands(peer.instanceId).filter(c=>c.type==='CONFIG_SYNC'))manager.bridge({type:'ACK',sessionId:peer.sessionId,commandId:cmd.id,status:'applied'},peer.instanceId);
 }
 const group=manager.execute('group.create',{name:'active fixture',members:manager.snapshot().channels.map(c=>c.id),intervalMs:20000});manager.execute('group.start',{id:group.id});manager.tick();
 const attempt=manager.snapshot().attempts[0],owner=peers.find(p=>p.instanceId===attempt.instanceId);
 const collector=createSupportCollector({databasePath,appVersion:'test'});
 t.after(async()=>{await collector.close();manager.close();rmSync(dir,{recursive:true,force:true});});
 let pulses=0;const timer=setInterval(()=>pulses++,5);t.after(()=>clearInterval(timer));
 const started=performance.now(),reporting=collector.collect({from:0,to:at+120000,includeBodies:false,includeNames:false});
 const launchMs=performance.now()-started;
 const commandStarted=performance.now();manager.execute('service.stopAll',{});const stopMs=performance.now()-commandStarted;
 assert.equal(manager.snapshot().groups[0].status,'stop_pending');
 assert.throws(()=>manager.bridge({type:'PREPARED',sessionId:owner.sessionId,attemptId:attempt.id,accountId:attempt.accountId,channelId:attempt.channelId,configVersion:attempt.configVersion,draftClear:true},owner.instanceId),{code:'EXECUTION_STOPPED'});
 for(const peer of peers)for(const cmd of manager.commands(peer.instanceId).filter(c=>c.type==='CONTROL'))manager.bridge({type:'ACK',sessionId:peer.sessionId,commandId:cmd.id,status:'applied',executionBlocked:true,...(cmd.payload.attemptId?{attemptId:cmd.payload.attemptId}:{})},peer.instanceId);
 const stopAppliedMs=performance.now()-commandStarted;
 assert.equal(manager.snapshot().groups[0].status,'stopped');assert.equal(manager.snapshot().attempts[0].status,'cancelled');
 assert.equal(manager.snapshot().commands.some(c=>c.type==='COMMIT_PERMIT'),false);
 const report=await reporting;
 assert.ok(launchMs<100,`수집 시작이 이벤트 루프를 ${launchMs.toFixed(1)}ms 점유했습니다.`);
 assert.ok(pulses>=2,`수집 중 이벤트 루프 실행 횟수: ${pulses}`);
 assert.ok(stopMs<100,`중지 접수: ${stopMs.toFixed(1)}ms`);
 assert.ok(report.events.length>0);assert.ok(report.selection.omittedCounts.events>0);
 assert.equal(manager.events({type:'service.started'}).length,2,'읽기 worker가 새 실행 이력을 만들지 않습니다.');
 t.diagnostic(JSON.stringify({records:120000,launchMs,stopMs,stopAppliedMs,pulses,totalMs:performance.now()-started}));
});
