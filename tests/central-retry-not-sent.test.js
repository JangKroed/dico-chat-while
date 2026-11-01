import test from 'node:test';
import assert from 'node:assert/strict';
import {createCentralManager} from '../central/core/index.js';

function fixture(t,{blocked=true}={}){
  const manager=createCentralManager({now:()=>1_800_000_000_000,monotonicNow:()=>1000});
  t.after(()=>manager.close());
  const message=manager.execute('message.create',{name:'Notice',body:'Notice'});
  const connections=['A','B'].map((accountId,index)=>{
    const hello=manager.bridge({type:'HELLO',protocolVersion:1,name:accountId});
    const bridge=message=>manager.bridge({...message,sessionId:hello.sessionId},hello.instanceId);
    bridge({type:'OBSERVATION',legacyFrozen:true,legacyPending:false,channels:[{accountId,guildId:'guild',channelId:'channel',tabId:index+1,verified:true}]});
    const channel=manager.snapshot().channels.find(c=>c.instanceId===hello.instanceId);
    manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:[{messageId:message.id}]});
    const command=manager.commands(hello.instanceId).find(c=>c.type==='CONFIG_SYNC');
    bridge({type:'ACK',commandId:command.id,status:'applied'});
    return{...hello,channel,bridge};
  });
  const group=manager.execute('group.create',{name:'Rotation',members:connections.map(c=>c.channel.id),intervalMs:0});
  manager.execute('group.start',{id:group.id});manager.tick();
  const attempt=manager.snapshot().attempts[0],owner=connections[0];
  owner.bridge({type:'PREPARED',attemptId:attempt.id,accountId:'A',channelId:'channel',configVersion:attempt.configVersion,draftClear:true});
  owner.bridge({type:'DELIVERY_RESULT',attemptId:attempt.id,outcome:'unknown',executionBlocked:blocked});
  const retry=(extra={})=>manager.execute('attempt.retryNotSent',{id:attempt.id,confirmation:'CONFIRM_NOT_SENT',...extra});
  const acknowledge=connection=>{
    const command=manager.commands(connection.instanceId).findLast(c=>c.type==='CONTROL');
    connection.bridge({type:'ACK',commandId:command.id,status:'applied',executionBlocked:true,...(command.payload.attemptId?{attemptId:command.payload.attemptId}:{})});
  };
  return{manager,connections,group,attempt,retry,acknowledge};
}

test('explicit unsent retry starts the same account without advancing either cursor',t=>{
  const f=fixture(t),oldRun=f.manager.snapshot().groups[0].runId;
  const result=f.retry();
  assert.equal(result.status,'started');
  let snapshot=f.manager.snapshot();
  assert.equal(snapshot.attempts[0].status,'not_sent');assert.equal(snapshot.attempts[0].manual,true);
  assert.equal(snapshot.groups[0].status,'running');assert.equal(snapshot.groups[0].cursor,0);
  assert.notEqual(snapshot.groups[0].runId,oldRun);assert.equal(snapshot.channels[0].playlistIndex,0);
  f.manager.tick();snapshot=f.manager.snapshot();
  assert.equal(snapshot.attempts.length,2);assert.equal(snapshot.attempts[1].accountId,'A');
  assert.notEqual(snapshot.attempts[1].id,f.attempt.id);
});

test('unsent retry requires explicit user confirmation and executor blocking proof',t=>{
  const f=fixture(t,{blocked:false});
  assert.throws(()=>f.retry({confirmation:undefined}),{code:'VALIDATION'});
  assert.throws(()=>f.retry(),{code:'EXECUTION_UNCERTAIN'});
  assert.equal(f.manager.snapshot().attempts[0].status,'unknown');
});

test('pending controls resolve the old attempt but require another explicit continue after every ACK',t=>{
  const f=fixture(t);f.manager.execute('group.stop',{id:f.group.id});
  let result=f.retry();assert.equal(result.status,'waiting');assert.equal(result.reasonCode,'CONTROL_PENDING');
  assert.equal(f.manager.snapshot().attempts[0].status,'not_sent');
  f.acknowledge(f.connections[0]);result=f.retry();assert.equal(result.status,'waiting');
  f.acknowledge(f.connections[1]);
  assert.equal(f.manager.snapshot().groups[0].status,'stopped');
  f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);
  assert.equal(f.retry().status,'started');
});

test('duplicate retry never creates a second run and cannot operate on a newer active attempt',t=>{
  const f=fixture(t);f.retry();const run=f.manager.snapshot().groups[0].runId;
  assert.equal(f.retry().status,'already_started');assert.equal(f.manager.snapshot().groups[0].runId,run);
  f.manager.tick();assert.throws(()=>f.retry(),{code:'STALE_ATTEMPT'});
  assert.equal(f.manager.snapshot().groups[0].runId,run);assert.equal(f.manager.snapshot().attempts.length,2);
});

test('an old retry click cannot restart a group explicitly stopped after retry',t=>{
  const f=fixture(t);f.retry();f.manager.execute('group.stop',{id:f.group.id});
  for(const c of f.connections)f.acknowledge(c);
  assert.throws(()=>f.retry(),{code:'STALE_ATTEMPT'});
  assert.equal(f.manager.snapshot().groups[0].status,'stopped');
});

test('retry rejects a confirmed outcome and a group edited since the attempt',t=>{
  const confirmed=fixture(t);
  confirmed.connections[0].bridge({type:'DELIVERY_RESULT',attemptId:confirmed.attempt.id,outcome:'confirmed',messageId:'observed-post'});
  assert.throws(()=>confirmed.retry(),{code:'ATTEMPT_STATE'});
  const edited=fixture(t);edited.manager.execute('attempt.resolve',{id:edited.attempt.id,outcome:'not_sent'});
  edited.manager.execute('group.update',{id:edited.group.id,expectedVersion:1,members:edited.connections.map(c=>c.channel.id).reverse()});
  assert.throws(()=>edited.retry(),{code:'STALE_ATTEMPT'});
});

test('unavailable group member rolls back outcome, run, and locks atomically',t=>{
  const f=fixture(t);f.connections[1].bridge({type:'DISCONNECT'});
  const before=f.manager.snapshot();
  assert.throws(()=>f.retry(),{code:'CONNECTION_LOST'});
  const after=f.manager.snapshot();
  assert.equal(after.attempts[0].status,'unknown');assert.equal(after.groups[0].runId,before.groups[0].runId);
  assert.equal(after.stateVersion,before.stateVersion);
  const other=f.manager.execute('group.create',{name:'Other',members:[f.connections[0].channel.id],intervalMs:0});
  assert.throws(()=>f.manager.execute('group.start',{id:other.id}),{code:'RESOURCE_BUSY'});
});

test('retry after a global stop enables only the explicitly selected group',t=>{
  const f=fixture(t);
  const other=f.manager.execute('group.create',{name:'Other',members:[f.connections[0].channel.id],intervalMs:0});
  f.manager.execute('service.stopAll');for(const c of f.connections)f.acknowledge(c);
  assert.equal(f.retry().status,'started');
  const snapshot=f.manager.snapshot();assert.equal(snapshot.service.status,'ready');
  assert.equal(snapshot.groups.find(g=>g.id===f.group.id).status,'running');
  assert.equal(snapshot.groups.find(g=>g.id===other.id).status,'stopped');
});
