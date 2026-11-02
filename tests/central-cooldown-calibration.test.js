import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCentralManager} from '../central/core/index.js';

function setup({customIntervalMs,databasePath}={}){
 let wall=1_800_000_000_000,mono=100_000;
 const clock={now:()=>wall,monotonicNow:()=>mono};let manager=createCentralManager({...clock,databasePath});
 const session=manager.bridge({type:'HELLO',protocolVersion:1,name:'Calibration'});
 const ids={accountId:'33333333333333333',guildId:'11111111111111111',channelId:'22222222222222222',tabId:7};
 const observe=()=>manager.bridge({type:'OBSERVATION',sessionId:session.sessionId,legacyFrozen:true,legacyPending:false,channels:[{...ids,verified:true,slowmodeMs:60000}]},session.instanceId);
 observe();let channel=manager.snapshot().channels[0];
 const messages=['One','Two'].map(body=>manager.execute('message.create',{name:body,body}));
 manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:messages.map(m=>({messageId:m.id}))});
 if(customIntervalMs!==undefined){channel=manager.snapshot().channels[0];manager.execute('channel.update',{id:channel.id,expectedVersion:channel.version,intervalMode:'custom',intervalMs:customIntervalMs});}
 for(const cmd of manager.commands(session.instanceId).filter(x=>x.type==='CONFIG_SYNC'))manager.bridge({type:'ACK',sessionId:session.sessionId,commandId:cmd.id,status:'applied'},session.instanceId);
 channel=manager.snapshot().channels[0];const group=manager.execute('group.create',{name:'Calibration',members:[channel.id],intervalMs:0});
 manager.execute('group.start',{id:group.id});manager.tick();
 const attempt=manager.snapshot().attempts[0];manager.bridge({type:'PREPARED',sessionId:session.sessionId,attemptId:attempt.id,accountId:ids.accountId,channelId:ids.channelId,configVersion:attempt.configVersion,draftClear:true},session.instanceId);
 const advance=ms=>{wall+=ms;mono+=ms};
 const confirm=(confirmationMs=4000)=>{advance(confirmationMs);manager.bridge({type:'DELIVERY_RESULT',sessionId:session.sessionId,attemptId:attempt.id,outcome:'confirmed',messageId:'44444444444444444',confirmationMs},session.instanceId)};
 const sample=(data={},message={})=>manager.bridge({type:'COOLDOWN_SAMPLE',sessionId:session.sessionId,attemptId:attempt.id,runId:attempt.runId,configVersion:attempt.configVersion,sample:{status:'remaining',elapsedMs:5000,remainingMs:59000,maxGapMs:500,slowmodeMs:60000,...data},...message},session.instanceId);
 return {get manager(){return manager},session,channel,group,attempt,clock,advance,confirm,sample,observe,reopen(){manager.close();manager=createCentralManager({...clock,databasePath});return manager},close(){manager.close()}};
}

test('measured 67-second cycle is anchored to Enter and never charges confirmation twice',()=>{
 const f=setup();try{
  f.confirm();f.advance(1000);assert.equal(f.sample().ok,true);
  const c=f.manager.snapshot().channels[0];
  assert.equal(c.minimumIntervalMs,63000);assert.equal(c.correctedBaseIntervalMs,67000);assert.equal(c.cooldownCorrectionMs,4000);assert.equal(c.customExtraMs,0);assert.equal(c.effectiveIntervalMs,67000);
  assert.equal(c.nextEligibleAt,1_800_000_000_000+67000);
  assert.equal(c.configVersion,f.attempt.configVersion);assert.equal(c.appliedVersion,c.configVersion);
  assert.equal(f.manager.snapshot().groups[0].cursor,0);
 }finally{f.close()}
});

test('a faster measured unlock never falls below nominal Enter-to-Enter floor',()=>{
 const f=setup();try{
  f.confirm();f.advance(1000);assert.equal(f.sample({remainingMs:55000}).ok,true);
  const c=f.manager.snapshot().channels[0];assert.equal(c.correctedBaseIntervalMs,63000);assert.equal(c.cooldownCorrectionMs,0);
  assert.equal(c.nextEligibleAt,1_800_000_000_000+63000,'confirmation took four seconds within the full interval');
 }finally{f.close()}
});

test('custom interval adds only its nominal excess after adaptive correction',()=>{
 const f=setup({customIntervalMs:70000});try{
  f.confirm();f.advance(1000);assert.equal(f.sample().ok,true);
  const c=f.manager.snapshot().channels[0];assert.equal(c.intervalMs,70000);assert.equal(c.customExtraMs,7000);assert.equal(c.correctedBaseIntervalMs,67000);assert.equal(c.effectiveIntervalMs,74000);
  assert.equal(c.nextEligibleAt,1_800_000_000_000+74000);
 }finally{f.close()}
});

test('automatic mode ignores a stale custom interval preserved in an old backup',()=>{
 const manager=createCentralManager();try{
  const session=manager.bridge({type:'HELLO',protocolVersion:1,name:'Old backup'});
  manager.bridge({type:'OBSERVATION',sessionId:session.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'33333333333333333',guildId:'11111111111111111',channelId:'22222222222222222',tabId:7,verified:true,slowmodeMs:60000}]},session.instanceId);
  const backup=manager.exportBackup();backup.channels[0].intervalMode='auto';backup.channels[0].customIntervalMs=70000;
  manager.importBackup(backup);const channel=manager.snapshot().channels[0];
  assert.equal(channel.minimumIntervalMs,63000);assert.equal(channel.customExtraMs,0);assert.equal(channel.effectiveIntervalMs,63000);
 }finally{manager.close()}
});

test('fractional elapsed readings round a measured cycle upward by less than one second',()=>{
 const f=setup();try{
  f.confirm();f.advance(1000);assert.equal(f.sample({elapsedMs:5400.4,remainingMs:59000,maxGapMs:400.25}).ok,true);
  const c=f.manager.snapshot().channels[0];assert.equal(c.correctedBaseIntervalMs,68000);assert.equal(c.cooldownCorrectionMs,5000);
 }finally{f.close()}
});

test('stale, malformed, and mismatched samples cannot change an active deadline',()=>{
 const f=setup();try{
  f.confirm();f.advance(1000);const before=f.manager.snapshot().channels[0];
  for(const change of [
   [{status:'inconclusive',remainingMs:180000}],
   [{status:'remaining',elapsedMs:16000}],
   [{status:'remaining',maxGapMs:2001}],
   [{status:'remaining',remainingMs:-1}],
   [{status:'remaining',slowmodeMs:120000}],
   [{status:'remaining',remainingMs:'private'}],
   [{}, {runId:'wrong'}],
   [{}, {configVersion:f.attempt.configVersion+1}],
   [{}, {attemptId:'wrong'}],
  ])assert.equal(f.sample(...change).ok,false);
  const after=f.manager.snapshot().channels[0];assert.equal(after.nextEligibleAt,before.nextEligibleAt);assert.equal(after.cooldownCorrectionMs,0);assert.equal(after.cooldownCalibratedAt,undefined);
 }finally{f.close()}
});

test('positive countdown observations arriving over 17 seconds after confirmation are rejected',()=>{
 const f=setup();try{
  f.confirm();f.advance(17001);
  const before=f.manager.snapshot().channels[0];assert.equal(f.sample().ok,false);
  const after=f.manager.snapshot().channels[0];assert.equal(after.nextEligibleAt,before.nextEligibleAt);assert.equal(after.cooldownCorrectionMs,0);
 }finally{f.close()}
});

test('calibration survives restart and reconstructs the same Enter-based deadline',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dico-calibration-')),databasePath=join(dir,'state.sqlite'),f=setup({databasePath});
 try{
  f.confirm();f.advance(1000);assert.equal(f.sample().ok,true);const before=f.manager.snapshot().channels[0];
  f.advance(10000);const restarted=f.reopen();const restored=restarted.snapshot().channels[0];
  assert.equal(restored.cooldownCorrectionMs,4000);assert.equal(restored.correctedBaseIntervalMs,67000);assert.equal(restored.effectiveIntervalMs,67000);
  assert.equal(restored.lastConfirmedAttemptId,f.attempt.id);assert.equal(restored.nextEligibleAt,null);
  assert.ok(before.nextEligibleAt>f.clock.now());
  const next=restarted.bridge({type:'HELLO',protocolVersion:1,instanceId:f.session.instanceId,name:'Calibration'});
  restarted.bridge({type:'OBSERVATION',sessionId:next.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'33333333333333333',guildId:'11111111111111111',channelId:'22222222222222222',tabId:7,verified:true,slowmodeMs:60000}]},next.instanceId);
  for(const cmd of restarted.commands(next.instanceId).filter(x=>x.type==='CONFIG_SYNC'))restarted.bridge({type:'ACK',sessionId:next.sessionId,commandId:cmd.id,status:'applied'},next.instanceId);
  restarted.execute('group.resume',{id:f.group.id});
  assert.equal(restarted.snapshot().channels[0].nextEligibleAt,1_800_000_000_000+67000);
 }finally{f.close();rmSync(dir,{recursive:true,force:true})}
});

test('the previous confirmation cannot recalibrate after the next attempt begins',()=>{
 const f=setup();try{
  f.confirm();f.advance(1000);assert.equal(f.sample().ok,true);
  for(let n=0;n<13;n++){f.advance(5000);f.manager.bridge({type:'HEARTBEAT',sessionId:f.session.sessionId},f.session.instanceId);f.manager.tick();}
  const snapshot=f.manager.snapshot();assert.equal(snapshot.attempts.length,2);assert.equal(snapshot.attempts[1].status,'preparing');
  assert.equal(f.sample({remainingMs:180000}).ok,false);
  assert.equal(f.manager.snapshot().channels[0].cooldownCorrectionMs,4000);
 }finally{f.close()}
});


test('a newer confirmed cycle can reduce the preceding correction before any new preparation',()=>{
 const f=setup();try{
  f.confirm();f.advance(1000);f.sample();
  while(f.manager.snapshot().attempts.length<2){f.advance(10000);f.observe();f.manager.tick();}
  const a=f.manager.snapshot().attempts.at(-1);
  f.manager.bridge({type:'PREPARED',sessionId:f.session.sessionId,attemptId:a.id,accountId:a.accountId,channelId:a.channelId,configVersion:a.configVersion,draftClear:true},f.session.instanceId);
  f.manager.bridge({type:'DELIVERY_RESULT',sessionId:f.session.sessionId,attemptId:a.id,outcome:'confirmed',messageId:'44444444444444445',confirmationMs:0},f.session.instanceId);
  const at=f.clock.now();f.advance(1000);
  assert.equal(f.manager.bridge({type:'COOLDOWN_SAMPLE',sessionId:f.session.sessionId,attemptId:a.id,runId:a.runId,configVersion:a.configVersion,sample:{status:'remaining',elapsedMs:1000,remainingMs:59000,maxGapMs:500,slowmodeMs:60000}},f.session.instanceId).ok,true);
  const channel=f.manager.snapshot().channels[0];assert.equal(channel.cooldownCorrectionMs,0);
  assert.equal(channel.nextEligibleAt,at+63000);
 }finally{f.close()}
});
