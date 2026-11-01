import test from 'node:test';
import assert from 'node:assert/strict';
import {createCentralManager} from '../central/core/index.js';

function fixture(t){
  let wall=1_800_000_000_000,mono=1000;
  const manager=createCentralManager({now:()=>wall,monotonicNow:()=>mono});t.after(()=>manager.close());
  const bridge=(c,message)=>manager.bridge({...message,sessionId:c.sessionId},c.instanceId);
  const connect=(accountId='A',slowmodeMs=60000)=>{
    const c=manager.bridge({type:'HELLO',protocolVersion:1,name:accountId});
    bridge(c,{type:'OBSERVATION',legacyFrozen:true,legacyPending:false,channels:[{accountId,guildId:'guild',channelId:'channel',tabId:1,verified:true,slowmodeMs}]});
    c.channelId=manager.snapshot().channels.find(channel=>channel.instanceId===c.instanceId).id;c.accountId=accountId;
    const message=manager.execute('message.create',{name:accountId,body:'Test message'}),channel=manager.snapshot().channels.find(channel=>channel.id===c.channelId);
    manager.execute('channel.applyPlaylist',{id:c.channelId,expectedVersion:channel.version,items:[{messageId:message.id}]});
    bridge(c,{type:'ACK',commandId:manager.commands(c.instanceId).findLast(cmd=>cmd.type==='CONFIG_SYNC').id,status:'applied'});return c;
  };
  const group=(connections,intervalMs=1000)=>manager.execute('group.create',{name:'Countdown',members:connections.map(c=>c.channelId),intervalMs});
  const prepare=(c,a)=>bridge(c,{type:'PREPARED',attemptId:a.id,accountId:c.accountId,channelId:'channel',configVersion:a.configVersion,draftClear:true});
  const result=(c,a,outcome='confirmed')=>bridge(c,{type:'DELIVERY_RESULT',attemptId:a.id,outcome,...(outcome==='confirmed'?{messageId:'post-'+a.id}:{})});
  return{manager,bridge,connect,group,prepare,result,now:()=>wall,advance:ms=>{wall+=ms;mono+=ms;},jumpWall:ms=>{wall+=ms;}};
}

test('countdown DTO uses server time and the 63-second account deadline without mutating state',t=>{
  const f=fixture(t),c=f.connect(),g=f.group([c]);let s=f.manager.snapshot();
  assert.equal(s.serverNow,f.now());assert.equal(s.channels[0].nextEligibleAt,s.serverNow);assert.equal(s.groups[0].nextEligibleAt,null);
  f.manager.execute('group.start',{id:g.id});assert.equal(f.manager.snapshot().groups[0].nextEligibleAt,f.now());f.manager.tick();
  let a=f.manager.snapshot().attempts[0];assert.equal(f.manager.snapshot().channels[0].nextEligibleAt,null);assert.equal(f.manager.snapshot().groups[0].nextEligibleAt,null);
  f.prepare(c,a);assert.equal(f.manager.snapshot().groups[0].nextEligibleAt,null);f.result(c,a);
  s=f.manager.snapshot();const before={version:s.stateVersion,token:s.configurationToken,event:s.lastEventId,commands:s.commands};
  assert.equal(s.channels[0].nextEligibleAt,s.serverNow+63000);assert.equal(s.groups[0].nextEligibleAt,s.serverNow+63000);
  f.advance(1000);const later=f.manager.snapshot();assert.equal(later.serverNow,s.serverNow+1000);assert.equal(later.channels[0].nextEligibleAt,s.channels[0].nextEligibleAt);
  assert.equal(later.groups[0].nextEligibleAt-later.serverNow,62000);
  assert.deepEqual({version:later.stateVersion,token:later.configurationToken,event:later.lastEventId,commands:later.commands},before);
  for(const entity of [...later.channels,...later.groups])for(const key of ['nextMono','lastConfirmedMono','sessionId'])assert.equal(key in entity,false);
});

test('group countdown follows only its current member and retains each other account cooldown',t=>{
  const f=fixture(t),a=f.connect('A'),b=f.connect('B',0),g=f.group([a,b],10000);
  f.manager.execute('group.start',{id:g.id});f.manager.tick();const attempt=f.manager.snapshot().attempts[0];f.prepare(a,attempt);f.result(a,attempt);
  let s=f.manager.snapshot();assert.equal(s.groups[0].cursor,1);assert.equal(s.channels.find(c=>c.id===a.channelId).nextEligibleAt,s.serverNow+63000);
  assert.equal(s.channels.find(c=>c.id===b.channelId).nextEligibleAt,s.serverNow);assert.equal(s.groups[0].nextEligibleAt,s.serverNow+10000);
  f.advance(10000);f.manager.tick();s=f.manager.snapshot();assert.equal(s.groups[0].nextEligibleAt,null);assert.equal(s.channels.find(c=>c.id===b.channelId).nextEligibleAt,null);
  assert.equal(s.channels.find(c=>c.id===a.channelId).nextEligibleAt-s.serverNow,53000);
});

test('unknown attempts and pending stop acknowledgments never expose a send countdown',t=>{
  const f=fixture(t),c=f.connect(),g=f.group([c]);f.manager.execute('group.start',{id:g.id});f.manager.tick();const a=f.manager.snapshot().attempts[0];f.prepare(c,a);f.result(c,a,'unknown');
  let s=f.manager.snapshot();assert.equal(s.groups[0].status,'needs_review');assert.equal(s.groups[0].nextEligibleAt,null);assert.equal(s.channels[0].nextEligibleAt,null);
  f.manager.execute('group.stop',{id:g.id});s=f.manager.snapshot();assert.equal(s.groups[0].status,'stop_pending');assert.equal(s.groups[0].nextEligibleAt,null);assert.equal(s.channels[0].nextEligibleAt,null);
});

test('stale transport, unsafe clock, unapplied config and stopped service suppress countdowns',t=>{
  for(const scenario of ['stale','clock','config','service']){
    const f=fixture(t),c=f.connect(),g=f.group([c]);
    if(scenario==='config'){
      const channel=f.manager.snapshot().channels[0];f.manager.execute('channel.update',{id:channel.id,expectedVersion:channel.version,intervalMode:'custom',intervalMs:90000});
    }else{
      f.manager.execute('group.start',{id:g.id});
      if(scenario==='stale'){f.advance(16000);f.manager.tick();}
      if(scenario==='clock')f.jumpWall(3000);
      if(scenario==='service')f.manager.execute('service.stopAll',{});
    }
    const before=f.manager.snapshot(),after=f.manager.snapshot();assert.equal(after.channels[0].nextEligibleAt,null,scenario);assert.equal(after.groups[0].nextEligibleAt,null,scenario);
    assert.equal(after.stateVersion,before.stateVersion);assert.equal(after.configurationToken,before.configurationToken);
  }
});
