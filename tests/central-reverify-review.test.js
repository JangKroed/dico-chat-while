import test from 'node:test';
import assert from 'node:assert/strict';
import {createCentralManager} from '../central/core/index.js';

function fixture(){
  let time=1_800_000_000_000;
  const manager=createCentralManager({now:()=>time,monotonicNow:()=>time-1_799_999_999_000});
  const session=manager.bridge({type:'HELLO',protocolVersion:1,capabilities:['managed-window-v1']});
  const records=[1,2].map(n=>({accountId:'111',guildId:'222',channelId:String(330+n),tabId:n,verified:true}));
  const observe=channels=>manager.bridge({type:'OBSERVATION',sessionId:session.sessionId,legacyFrozen:true,legacyPending:false,channels},session.instanceId);
  observe(records);
  const message=manager.execute('message.create',{name:'Test',body:'Test fixture only'});
  const groups=manager.snapshot().channels.map(channel=>{
    manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:[{messageId:message.id}]});
    const command=manager.commands(session.instanceId).findLast(c=>c.type==='CONFIG_SYNC');
    manager.bridge({type:'ACK',sessionId:session.sessionId,commandId:command.id,status:'applied'},session.instanceId);
    return manager.execute('group.create',{name:channel.channelId,members:[channel.id],intervalMs:60000});
  });
  return{manager,session,records,groups,observe,advance:()=>time+=1000};
}

test('one recovered tab does not clear another tab warning in the same browser',()=>{
  const f=fixture();
  try{
    for(const group of f.groups)f.manager.execute('group.start',{id:group.id});
    f.observe([{...f.records[0],verified:false,verificationReason:'script_unavailable'},f.records[1]]);
    f.advance();
    f.observe([f.records[0],{...f.records[1],verified:false,verificationReason:'tab_loading'}]);
    const snapshot=f.manager.snapshot(),failed=snapshot.channels.find(c=>c.tabId===2);
    assert.equal(failed.verified,false);
    assert.ok(snapshot.incidents.some(i=>i.code==='channel_unverified'&&i.status==='open'&&i.bindingId===failed.id),'The still-unverified tab needs its own open warning.');
  }finally{f.manager.close();}
});

test('restored channel identity does not resume a group fenced by a confirmed account switch',()=>{
  const f=fixture();
  try{
    f.manager.execute('group.start',{id:f.groups[0].id});
    f.manager.bridge({type:'ACCOUNT_OBSERVATION',sessionId:f.session.sessionId,accountId:'999',verified:true},f.session.instanceId);
    f.advance();f.observe(f.records);
    const group=f.manager.snapshot().groups[0];
    assert.equal(group.status,'resume_required');assert.equal(group.waitReason,'account_mismatch');
    assert.equal(f.manager.snapshot().attempts.length,0);
  }finally{f.manager.close();}
});

test('queued window consolidation blocks starting a group until the move is acknowledged',()=>{
  const f=fixture();
  try{
    const channel=f.manager.snapshot().channels[0];
    const pending=f.manager.execute('channel.consolidate',{id:channel.id});
    assert.throws(()=>f.manager.execute('group.start',{id:f.groups[0].id}));
    assert.equal(f.manager.snapshot().attempts.length,0);
    f.manager.bridge({type:'ACK',sessionId:f.session.sessionId,commandId:pending.commandId,status:'applied'},f.session.instanceId);
    assert.doesNotThrow(()=>f.manager.execute('group.start',{id:f.groups[0].id}));
  }finally{f.manager.close();}
});
