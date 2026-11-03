import test from 'node:test';
import assert from 'node:assert/strict';
import {createCentralManager} from '../central/core/index.js';
function rig(t){
 let at=1_800_000_000_000,mono=1000;
 const manager=createCentralManager({now:()=>at,monotonicNow:()=>mono});t.after(()=>manager.close());
 const hello=manager.bridge({type:'HELLO',protocolVersion:1,name:'Browser'});
 const bridge=m=>manager.bridge({sessionId:hello.sessionId,...m},hello.instanceId);
 bridge({type:'OBSERVATION',legacyFrozen:true,legacyPending:false,channels:[{accountId:'123',guildId:'guild',channelId:'channel',tabId:1,verified:true}]});
 const channel=manager.snapshot().channels[0],message=manager.execute('message.create',{name:'Original',body:'Original'});
 manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:[{messageId:message.id}]});
 bridge({type:'ACK',commandId:manager.commands(hello.instanceId).find(c=>c.type==='CONFIG_SYNC').id,status:'applied'});
 const group=manager.execute('group.create',{name:'Group',members:[channel.id],intervalMs:0});manager.execute('group.start',{id:group.id});manager.tick();
 const attempt=manager.snapshot().attempts[0];bridge({type:'PREPARED',attemptId:attempt.id,accountId:attempt.accountId,channelId:attempt.channelId,configVersion:attempt.configVersion,draftClear:true});
 const scoped={attemptId:attempt.id,runId:attempt.runId,configVersion:attempt.configVersion};
 return{manager,bridge,attempt,group,scoped,advance(ms){at+=ms;mono+=ms;bridge({type:'HEARTBEAT'});manager.tick();}};
}
test('observation keepalive holds one attempt beyond thirty seconds without reserving retry or advancing order',t=>{
 const r=rig(t);assert.equal(r.bridge({type:'AUTHORIZE_ENTER',...r.scoped,retryCount:0}).allowed,true);
 for(let n=0;n<20;n++){
  const reply=r.bridge({type:'DELIVERY_WAIT',...r.scoped,observationPhase:true,retryCount:0,cooldownMs:0,elapsedMs:n*5000});assert.equal(reply.allowed,true);
  r.advance(5000);
 }
 const s=r.manager.snapshot();assert.equal(s.attempts.length,1);assert.equal(s.attempts[0].status,'permitted');assert.equal(s.attempts[0].sendRetryCount||0,0);assert.equal(s.groups[0].cursor,0);assert.equal(s.groups[0].waitReason,'delivery_observation');assert.equal(s.incidents.length,0);
 assert.equal(r.bridge({type:'DELIVERY_WAIT',...r.scoped,observationPhase:true,retryCount:1,cooldownMs:0,elapsedMs:0}).allowed,false);
 assert.equal(r.bridge({type:'AUTHORIZE_ENTER',...r.scoped,retryCount:0}).allowed,true);
 r.manager.execute('group.stop',{id:r.group.id});assert.equal(r.bridge({type:'DELIVERY_WAIT',...r.scoped,observationPhase:true,retryCount:0,cooldownMs:0,elapsedMs:0}).allowed,false);
});
test('authorization exposes recoverable cooldown reason and preserves hard stop reason',t=>{
 const r=rig(t);r.bridge({type:'DELIVERY_WAIT',...r.scoped,cooldownMs:5000});
 let denied=r.bridge({type:'AUTHORIZE_ENTER',...r.scoped});assert.equal(denied.allowed,false);assert.equal(denied.code,'DISCORD_COOLDOWN');assert.equal(denied.retryable,true);
 r.manager.execute('group.stop',{id:r.group.id});denied=r.bridge({type:'AUTHORIZE_ENTER',...r.scoped});assert.equal(denied.code,'EXECUTION_STOPPED');assert.equal(denied.retryable,false);
});

test('temporary identity observation failure permits read-only keepalive until fresh channel verification',t=>{
 const r=rig(t);r.bridge({type:'ACCOUNT_OBSERVATION',accountId:'123',verified:false,verificationReason:'script_unavailable'});
 const denied=r.bridge({type:'AUTHORIZE_ENTER',...r.scoped,retryCount:0});assert.equal(denied.retryable,true);assert.equal(denied.code,'CHANNEL_NOT_READY');
 for(let n=0;n<10;n++){assert.equal(r.bridge({type:'DELIVERY_WAIT',...r.scoped,observationPhase:true,retryCount:0,cooldownMs:0,elapsedMs:n*5000}).allowed,true);r.advance(5000);}
 assert.equal(r.manager.snapshot().attempts[0].status,'permitted');
 assert.equal(r.bridge({type:'AUTHORIZE_ENTER',...r.scoped,retryCount:0}).allowed,false);
 r.bridge({type:'OBSERVATION',legacyFrozen:true,legacyPending:false,channels:[{accountId:'123',guildId:'guild',channelId:'channel',tabId:1,verified:true}]});
 assert.equal(r.bridge({type:'AUTHORIZE_ENTER',...r.scoped,retryCount:0}).allowed,true);
});

test('pre-Enter and next-retry waits retain liveness during temporary channel unavailability without spending a retry',t=>{
 for(const retry of [false,true]){
  const r=rig(t);assert.equal(r.bridge({type:'AUTHORIZE_ENTER',...r.scoped,retryCount:0}).allowed,true);
  r.bridge({type:'ACCOUNT_OBSERVATION',accountId:'123',verified:false,verificationReason:'script_unavailable'});
  const fields=retry?{retryPhase:true,retryCount:1}:{enterAttempted:false};
  for(let n=0;n<10;n++){
   const reply=r.bridge({type:'DELIVERY_WAIT',...r.scoped,...fields,cooldownMs:1000,elapsedMs:n*5000});assert.equal(reply.retryable,true);r.advance(5000);
  }
  assert.equal(r.manager.snapshot().attempts[0].status,'permitted');assert.equal(r.manager.snapshot().attempts[0].sendRetryCount||0,0);
  r.bridge({type:'OBSERVATION',legacyFrozen:true,legacyPending:false,channels:[{accountId:'123',guildId:'guild',channelId:'channel',tabId:1,verified:true}]});
  assert.equal(r.bridge({type:'DELIVERY_WAIT',...r.scoped,...fields,cooldownMs:0,elapsedMs:0}).allowed,true);
  assert.equal(r.bridge({type:'AUTHORIZE_ENTER',...r.scoped,retryCount:retry?1:0}).allowed,true);
 }
});
