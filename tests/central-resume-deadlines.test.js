import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCentralManager} from '../central/core/index.js';

function fixture(t,{slowmodeMs=60000,customIntervalMs,groupIntervalMs=1000,confirmed=true}={}){
  const directory=mkdtempSync(join(tmpdir(),'dico-resume-deadlines-'));
  let wall=1_800_000_000_000,mono=1000,manager,connection;
  const open=()=>createCentralManager({databasePath:join(directory,'state.sqlite'),now:()=>wall,monotonicNow:()=>mono});
  manager=open();
  t.after(()=>{manager.close();rmSync(directory,{recursive:true,force:true});});
  const bridge=message=>manager.bridge({...message,sessionId:connection.sessionId},connection.instanceId);
  const observe=()=>bridge({type:'OBSERVATION',legacyFrozen:true,legacyPending:false,channels:[{accountId:'A',guildId:'guild',channelId:'channel',tabId:1,verified:true,slowmodeMs}]});
  const reconnect=()=>{
    connection=manager.bridge({type:'HELLO',protocolVersion:1,...(connection?{instanceId:connection.instanceId}:{}),capabilities:['central-v1','early-prepare-v1']});
    observe();
    for(const command of manager.commands(connection.instanceId).filter(c=>c.type==='CONFIG_SYNC'))bridge({type:'ACK',commandId:command.id,status:'applied'});
  };
  reconnect();const channelId=manager.snapshot().channels[0].id;
  if(customIntervalMs!==undefined)manager.execute('channel.update',{id:channelId,expectedVersion:manager.snapshot().channels[0].version,intervalMode:'custom',intervalMs:customIntervalMs});
  const message=manager.execute('message.create',{name:'Notice',body:'Notice'});
  manager.execute('channel.applyPlaylist',{id:channelId,expectedVersion:manager.snapshot().channels[0].version,items:[{messageId:message.id}]});
  bridge({type:'ACK',commandId:manager.commands(connection.instanceId).findLast(c=>c.type==='CONFIG_SYNC').id,status:'applied'});
  const group=manager.execute('group.create',{name:'Rotation',members:[channelId],intervalMs:groupIntervalMs});
  const prepare=(attempt,cooldownMs=0)=>bridge({type:'PREPARED',attemptId:attempt.id,accountId:'A',channelId:'channel',configVersion:attempt.configVersion,draftClear:true,cooldownMs});
  const stop=()=>{
    manager.execute('group.stop',{id:group.id});
    const control=manager.commands(connection.instanceId).findLast(c=>c.type==='CONTROL');
    bridge({type:'ACK',commandId:control.id,status:'applied',executionBlocked:true,...(control.payload.attemptId?{attemptId:control.payload.attemptId}:{})});
  };
  if(confirmed){
    manager.execute('group.start',{id:group.id});manager.tick();const attempt=manager.snapshot().attempts[0];prepare(attempt);
    bridge({type:'DELIVERY_RESULT',attemptId:attempt.id,outcome:'confirmed',messageId:'33333333333333333'});stop();
  }
  return{
    get manager(){return manager;},group,channelId,bridge,prepare,stop,
    advance(ms){wall+=ms;mono+=ms;manager.tick();observe();},
    restart(elapsed){manager.close();wall+=elapsed;mono=100;manager=open();reconnect();},
    channelRemaining(){const s=manager.snapshot();return s.channels[0].nextEligibleAt-s.serverNow;},
    groupRemaining(){const s=manager.snapshot();return s.groups[0].nextEligibleAt-s.serverNow;},
  };
}

test('restart preserves the remaining slowmode interval instead of starting a new full interval',t=>{
  const f=fixture(t);f.restart(20000);f.manager.execute('group.start',{id:f.group.id});
  assert.equal(f.channelRemaining(),43000);assert.equal(f.groupRemaining(),43000);
});

test('elapsed persisted interval permits immediate preparation but still waits for live Discord cooldown',t=>{
  const f=fixture(t);f.restart(70000);f.manager.execute('group.start',{id:f.group.id});
  assert.equal(f.channelRemaining(),0);assert.equal(f.groupRemaining(),0);
  f.manager.tick();const attempt=f.manager.snapshot().attempts.at(-1);
  assert.equal(attempt.status,'preparing');assert.equal(f.manager.snapshot().attempts.length,2);
  const response=f.prepare(attempt,26000);assert.equal(response.permitIssued,false);
  assert.equal(f.manager.snapshot().attempts.at(-1).status,'preparing');
  assert.equal(f.manager.commands(f.manager.snapshot().instances[0].id).some(c=>c.type==='COMMIT_PERMIT'),false);
});

test('explicit service resume does not renew the last confirmed account deadline',t=>{
  const f=fixture(t);f.manager.execute('service.stopAll');f.advance(10000);
  f.manager.execute('service.resume');f.manager.execute('group.start',{id:f.group.id});
  assert.equal(f.channelRemaining(),53000);assert.equal(f.groupRemaining(),53000);
});

test('start all preserves remaining user custom intervals',t=>{
  const f=fixture(t,{customIntervalMs:120000});f.manager.execute('service.stopAll');f.advance(10000);
  f.manager.execute('service.startAll');assert.equal(f.channelRemaining(),110000);assert.equal(f.groupRemaining(),110000);
});

test('restart reconstructs the group interval independently from the account interval',t=>{
  const f=fixture(t,{slowmodeMs:0,groupIntervalMs:90000});f.restart(20000);
  f.manager.execute('group.start',{id:f.group.id});
  assert.equal(f.channelRemaining(),0);assert.equal(f.groupRemaining(),70000);
});

test('an account with no confirmed history has no synthetic restart delay',t=>{
  const f=fixture(t,{confirmed:false});f.restart(20000);f.manager.execute('service.startAll');
  assert.equal(f.channelRemaining(),0);assert.equal(f.groupRemaining(),0);
});

test('unsent retry after restart does not recreate an already elapsed prior successful interval',t=>{
  const f=fixture(t);for(let i=0;i<7;i++)f.advance(10000);f.manager.execute('group.start',{id:f.group.id});f.manager.tick();
  const attempt=f.manager.snapshot().attempts.at(-1);f.prepare(attempt);
  f.bridge({type:'DELIVERY_RESULT',attemptId:attempt.id,outcome:'unknown',executionBlocked:true});
  f.manager.execute('attempt.resolve',{id:attempt.id,outcome:'not_sent'});
  f.restart(1000);
  assert.equal(f.manager.execute('attempt.retryNotSent',{id:attempt.id,confirmation:'CONFIRM_NOT_SENT'}).status,'started');
  assert.equal(f.channelRemaining(),0);assert.equal(f.groupRemaining(),0);
  f.manager.tick();assert.equal(f.manager.snapshot().attempts.at(-1).status,'preparing');
});

test('future-dated confirmation after backward clock movement uses a bounded full interval',t=>{
  const f=fixture(t);f.restart(-3600000);f.manager.execute('service.resume');f.manager.execute('group.start',{id:f.group.id});
  assert.equal(f.channelRemaining(),63000);assert.equal(f.groupRemaining(),63000);
});

test('interval edits after restart extend from the original confirmation rather than the restart',t=>{
  const f=fixture(t);f.restart(20000);f.manager.execute('service.resume');
  const channel=f.manager.snapshot().channels[0];
  f.manager.execute('channel.update',{id:channel.id,expectedVersion:channel.version,intervalMode:'custom',intervalMs:120000});
  const command=f.manager.commands(f.manager.snapshot().instances[0].id).findLast(c=>c.type==='CONFIG_SYNC');
  f.bridge({type:'ACK',commandId:command.id,status:'applied'});
  assert.equal(f.channelRemaining(),100000);
});
