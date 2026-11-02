import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCentralManager} from '../central/core/index.js';
import {CentralStore} from '../central/core/store.js';

const clock={now:()=>1_800_000_000_000,monotonicNow:()=>1000};
function fixture(options={}){
  const manager=createCentralManager({...clock,...options});
  const message=manager.execute('message.create',{name:'fixture',body:'fixture only'});
  const owners=['111','112'].map(accountId=>{
    const session=manager.bridge({type:'HELLO',protocolVersion:1});
    manager.bridge({type:'OBSERVATION',sessionId:session.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId,guildId:'222',channelId:'333',tabId:Number(accountId),verified:true}]},session.instanceId);
    const channel=manager.snapshot().channels.find(c=>c.instanceId===session.instanceId);
    manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:[{messageId:message.id}]});
    const config=manager.commands(session.instanceId).find(c=>c.type==='CONFIG_SYNC');
    manager.bridge({type:'ACK',sessionId:session.sessionId,commandId:config.id,status:'applied'},session.instanceId);
    return{...session,channel};
  });
  const group=manager.execute('group.create',{name:'fixture',members:owners.map(o=>o.channel.id),intervalMs:0});
  manager.execute('group.start',{id:group.id});manager.tick();const attempt=manager.snapshot().attempts[0],owner=owners[0];
  manager.bridge({type:'PREPARED',sessionId:owner.sessionId,attemptId:attempt.id,configVersion:attempt.configVersion,accountId:owner.channel.accountId,channelId:'333',draftClear:true},owner.instanceId);
  const unknown=()=>manager.bridge({type:'DELIVERY_RESULT',sessionId:owner.sessionId,attemptId:attempt.id,outcome:'unknown'},owner.instanceId);
  const ack=(index,blocked=true)=>{const o=owners[index],c=manager.commands(o.instanceId).findLast(c=>c.type==='CONTROL');manager.bridge({type:'ACK',sessionId:o.sessionId,commandId:c.id,status:'applied',...(blocked&&c.payload.attemptId?{attemptId:c.payload.attemptId,executionBlocked:true}:{})},o.instanceId);};
  return{manager,group,attempt,owners,unknown,ack};
}

for(const intent of ['stop','pause'])test(`${intent} completes execution control while preserving the blocked unknown delivery and locks`,()=>{
  const f=fixture();try{
    f.unknown();f.manager.execute(`group.${intent}`,{id:f.group.id});f.ack(0);
    assert.equal(f.manager.snapshot().groups[0].status,`${intent}_pending`,'every browser must apply control');
    f.ack(1);let s=f.manager.snapshot();
    assert.equal(s.groups[0].status,intent==='stop'?'stopped':'paused');assert.equal(s.groups[0].controlIntent,null);
    assert.equal(s.groups[0].activeAttemptId,f.attempt.id);assert.equal(s.groups[0].waitReason,'delivery_unknown');
    assert.equal(s.attempts[0].status,'unknown');assert.equal(s.attempts[0].executionBlocked,true);
    assert.ok(s.incidents.some(i=>i.code==='delivery_unknown'&&i.status==='open'));
    assert.throws(()=>f.manager.execute('group.start',{id:f.group.id}),{code:'ATTEMPT_UNRESOLVED'});
    const rival=f.manager.execute('group.create',{name:'rival',members:[f.owners[0].channel.id],intervalMs:0});
    assert.throws(()=>f.manager.execute('group.start',{id:rival.id}),{code:'RESOURCE_BUSY'});
    f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);
    f.manager.execute('attempt.resolve',{id:f.attempt.id,outcome:'not_sent'});s=f.manager.snapshot();
    assert.equal(s.groups[0].activeAttemptId,null);assert.equal(s.groups[0].waitReason,null);
    assert.doesNotThrow(()=>f.manager.execute('group.start',{id:rival.id}),'final result releases retained locks');
  }finally{f.manager.close();}
});

test('control application without execution-blocking proof cannot finish a permitted or unknown attempt',()=>{
  for(const outcome of ['permitted','unknown']){const f=fixture();try{
    if(outcome==='unknown')f.unknown();f.manager.execute('group.stop',{id:f.group.id});f.ack(0,false);f.ack(1);f.manager.tick();
    const s=f.manager.snapshot();assert.equal(s.groups[0].status,'stop_pending');assert.equal(s.attempts[0].status,outcome);assert.equal(s.groups[0].activeAttemptId,f.attempt.id);
  }finally{f.manager.close();}}
});

test('tick reconciles persisted all-applied controls but never accepts missing owner acknowledgments',()=>{
  for(const missing of [false,true]){const dir=mkdtempSync(join(tmpdir(),'dico-control-proof-')),databasePath=join(dir,'state.sqlite');let reopened;try{
    const f=fixture({databasePath});f.unknown();f.manager.execute('group.stop',{id:f.group.id});f.ack(0);f.ack(1);f.manager.close();
    const store=new CentralStore(databasePath),state=store.read(),g=state.groups.find(g=>g.id===f.group.id);
    g.status='stop_pending';g.controlIntent='stop';g.waitReason='delivery_unknown';
    if(missing)state.commands=state.commands.filter(c=>!(c.type==='CONTROL'&&c.instanceId===f.owners[1].instanceId));
    state.stateVersion++;store.commit(state,[]);store.close();
    reopened=createCentralManager({databasePath,...clock});reopened.tick();const s=reopened.snapshot();
    assert.equal(s.groups[0].status,missing?'stop_pending':'stopped');assert.equal(s.attempts[0].status,'unknown');assert.equal(s.groups[0].activeAttemptId,f.attempt.id);
    assert.equal(s.attempts[0].executionBlocked,true);assert.equal(s.attempts.length,1);
  }finally{reopened?.close();rmSync(dir,{recursive:true,force:true});}}
});
