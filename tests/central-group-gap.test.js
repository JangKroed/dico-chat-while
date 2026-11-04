import test from 'node:test';import assert from 'node:assert/strict';
import{createCentralManager}from'../central/core/index.js';
function fixture({earlyPrepare=true}={}){let time=1_800_000_000_000;const manager=createCentralManager({now:()=>time,monotonicNow:()=>time});const peers=[];for(const accountId of ['A','B']){const peer=manager.bridge({type:'HELLO',protocolVersion:1,capabilities:earlyPrepare?['early-prepare-v1']:[]});manager.bridge({type:'OBSERVATION',sessionId:peer.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId,guildId:'g',channelId:'c',tabId:peers.length+1,verified:true,slowmodeMs:0}]},peer.instanceId);const channel=manager.snapshot().channels.find(c=>c.instanceId===peer.instanceId);const m=manager.execute('message.create',{name:accountId,body:accountId});manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:[{messageId:m.id}]});manager.bridge({type:'ACK',sessionId:peer.sessionId,commandId:manager.commands(peer.instanceId).find(c=>c.type==='CONFIG_SYNC').id,status:'applied'},peer.instanceId);peers.push({...peer,accountId,bindingId:channel.id});}const advance=ms=>{while(ms>0){const step=Math.min(ms,1000);time+=step;ms-=step;for(const p of peers)manager.bridge({type:'HEARTBEAT',sessionId:p.sessionId},p.instanceId);manager.tick();}};const prepared=a=>{const p=peers.find(p=>p.instanceId===a.instanceId);return manager.bridge({type:'PREPARED',sessionId:p.sessionId,attemptId:a.id,configVersion:a.configVersion,accountId:p.accountId,channelId:'c',draftClear:true,cooldownMs:0},p.instanceId);};const confirm=a=>{const p=peers.find(p=>p.instanceId===a.instanceId);manager.bridge({type:'DELIVERY_RESULT',sessionId:p.sessionId,attemptId:a.id,outcome:'confirmed',messageId:'post-'+a.id},p.instanceId);};return{manager,peers,advance,prepared,confirm,now:()=>time};}

test('new groups default to a twenty second minimum',()=>{const f=fixture();try{const g=f.manager.execute('group.create',{name:'Default',members:f.peers.map(p=>p.bindingId)});assert.equal(g.intervalMs,20000);}finally{f.manager.close();}});

test('18초 간격의 다음 입력은 5초 미리 준비하고 원래 시각까지 허가하지 않는다',()=>{
 const f=fixture();try{
  const g=f.manager.execute('group.create',{name:'정시 발송',members:f.peers.map(p=>p.bindingId),intervalMs:18000});
  f.manager.execute('group.start',{id:g.id});f.manager.tick();const first=f.manager.snapshot().attempts[0];f.prepared(first);f.confirm(first);const confirmedAt=f.now();
  const scheduled=f.manager.snapshot().groups[0];assert.equal(scheduled.nextEligibleAt,confirmedAt+18000);assert.equal(scheduled.nextPreparationAt,confirmedAt+13000);
  f.advance(12999);assert.equal(f.manager.snapshot().attempts.length,1);
  f.advance(1);const next=f.manager.snapshot().attempts[1];assert.equal(next.createdAt,confirmedAt+13000);
  f.advance(2000);assert.equal(f.prepared(next).permitIssued,false);assert.equal(f.manager.snapshot().attempts[1].status,'preparing');
  const peer=f.peers.find(p=>p.instanceId===next.instanceId);
  assert.equal(f.manager.bridge({type:'AUTHORIZE_ENTER',sessionId:peer.sessionId,attemptId:next.id,runId:next.runId,configVersion:next.configVersion,retryCount:0},peer.instanceId).allowed,false);
  f.advance(2999);assert.equal(f.prepared(next).permitIssued,false);
  f.advance(1);assert.ok(f.prepared(next).permitId);f.confirm(next);
  assert.equal(f.manager.snapshot().attempts[1].finalizedAt-confirmedAt,18000);
 }finally{f.manager.close();}
});

test('미리 준비를 지원하지 않는 실행기는 전체 그룹 간격 이후 준비한다',()=>{
 const f=fixture({earlyPrepare:false});try{
  const g=f.manager.execute('group.create',{name:'기존 실행기',members:f.peers.map(p=>p.bindingId),intervalMs:18000});f.manager.execute('group.start',{id:g.id});f.manager.tick();const first=f.manager.snapshot().attempts[0];f.prepared(first);f.confirm(first);
  assert.equal(f.manager.snapshot().groups[0].nextPreparationAt,f.now()+18000);
  f.advance(17999);assert.equal(f.manager.snapshot().attempts.length,1);f.advance(1);assert.equal(f.manager.snapshot().attempts.length,2);
 }finally{f.manager.close();}
});

test('미리 준비한 다음 시도도 중지하면 발송 허가를 발급하지 않는다',()=>{
 const f=fixture();try{
  const g=f.manager.execute('group.create',{name:'중지 보호',members:f.peers.map(p=>p.bindingId),intervalMs:18000});f.manager.execute('group.start',{id:g.id});f.manager.tick();const first=f.manager.snapshot().attempts[0];f.prepared(first);f.confirm(first);
  f.advance(13000);const next=f.manager.snapshot().attempts[1];assert.ok(next);f.manager.execute('group.stop',{id:g.id});f.advance(5000);
  assert.throws(()=>f.prepared(next),error=>['EXECUTION_STOPPED','ATTEMPT_STATE'].includes(error.code));
  assert.equal(f.manager.snapshot().commands.some(c=>c.type==='COMMIT_PERMIT'&&c.payload.attemptId===next.id),false);
 }finally{f.manager.close();}
});

test('계정 대기 시간이 그룹 간격보다 길어도 그 시각 5초 전에만 준비한다',()=>{
 const f=fixture();try{
  const peer=f.peers[0],channel=f.manager.snapshot().channels.find(c=>c.id===peer.bindingId);
  f.manager.execute('channel.update',{id:channel.id,expectedVersion:channel.version,intervalMode:'custom',intervalMs:70000});
  for(const command of f.manager.commands(peer.instanceId).filter(c=>c.type==='CONFIG_SYNC'))f.manager.bridge({type:'ACK',sessionId:peer.sessionId,commandId:command.id,status:'applied'},peer.instanceId);
  const g=f.manager.execute('group.create',{name:'계정 쿨다운',members:[peer.bindingId],intervalMs:18000});f.manager.execute('group.start',{id:g.id});f.manager.tick();const first=f.manager.snapshot().attempts[0];f.prepared(first);f.confirm(first);const confirmedAt=f.now();
  assert.equal(f.manager.snapshot().groups[0].nextPreparationAt,confirmedAt+65000);
  f.advance(64999);assert.equal(f.manager.snapshot().attempts.length,1);f.advance(1);const next=f.manager.snapshot().attempts[1];assert.ok(next);assert.equal(f.prepared(next).permitIssued,false);
  f.advance(5000);assert.ok(f.prepared(next).permitId);
 }finally{f.manager.close();}
});

test('이전 발송이 미확인이면 준비 선행 시각이 지나도 다음 시도를 만들지 않는다',()=>{
 const f=fixture();try{
  const peer=f.peers[0],g=f.manager.execute('group.create',{name:'미확인 보호',members:f.peers.map(p=>p.bindingId),intervalMs:18000});f.manager.execute('group.start',{id:g.id});f.manager.tick();const first=f.manager.snapshot().attempts[0];f.prepared(first);
  f.manager.bridge({type:'DELIVERY_RESULT',sessionId:peer.sessionId,attemptId:first.id,outcome:'unknown'},peer.instanceId);
  f.advance(30000);assert.equal(f.manager.snapshot().attempts.length,1);assert.equal(f.manager.snapshot().groups[0].nextPreparationAt,null);
 }finally{f.manager.close();}
});
