import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCentralManager} from '../central/core/index.js';
import {CentralStore} from '../central/core/store.js';

function legacyDatabase(t,count){
 const dir=mkdtempSync(join(tmpdir(),'dico-retry-migration-')),databasePath=join(dir,'state.sqlite');
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const manager=createCentralManager({databasePath});manager.close();
 const store=new CentralStore(databasePath),state=store.read();
 delete state.retryPolicyVersion;state.settings.maxSendRetries=count;state.stateVersion++;store.commit(state,[]);store.close();
 return databasePath;
}
test('upgrade removes the old retry preference once and ignores later legacy writes',t=>{
 const databasePath=legacyDatabase(t,3);
 let manager=createCentralManager({databasePath});
 try{
  assert.equal(Object.hasOwn(manager.snapshot().settings,'maxSendRetries'),false);
  assert.equal(manager.events({type:'settings.retry_policy_migrated'}).length,1);
  manager.execute('settings.update',{maxSendRetries:0});
 }finally{manager.close();}
 manager=createCentralManager({databasePath});
 try{assert.equal(Object.hasOwn(manager.snapshot().settings,'maxSendRetries'),false);assert.equal(manager.events({type:'settings.retry_policy_migrated'}).length,1);}finally{manager.close();}
});
test('all legacy retry preferences disappear from snapshots and exported preferences',t=>{
 for(const count of [null,0,3,5,10,27,-1,1.5,'3',undefined]){
  const manager=createCentralManager({databasePath:legacyDatabase(t,count)});
  try{
   assert.equal(Object.hasOwn(manager.snapshot().settings,'maxSendRetries'),false);
   assert.equal(Object.hasOwn(manager.exportBackup().settings,'maxSendRetries'),false);
  }finally{manager.close();}
 }
});
test('legacy backup and API retry preferences never recreate the removed option',()=>{
 const manager=createCentralManager();
 try{
  for(const value of [null,0,3,10,27]){
   manager.execute('settings.update',{maxSendRetries:value});
   assert.equal(Object.hasOwn(manager.snapshot().settings,'maxSendRetries'),false);
   const backup=manager.exportBackup();backup.settings.maxSendRetries=value;manager.importBackup(backup);
   assert.equal(Object.hasOwn(manager.snapshot().settings,'maxSendRetries'),false);
  }
 }finally{manager.close();}
});

test('legacy active capped attempt adopts continuation without erasing uncertainty, retry count or locks',t=>{
 const databasePath=legacyDatabase(t,null);let manager=createCentralManager({databasePath});
 const session=manager.bridge({type:'HELLO',protocolVersion:1});
 manager.bridge({type:'OBSERVATION',sessionId:session.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'111',guildId:'222',channelId:'333',tabId:1,verified:true}]},session.instanceId);
 const channel=manager.snapshot().channels[0],message=manager.execute('message.create',{name:'fixture',body:'fixture only'});
 manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:[{messageId:message.id}]});
 manager.bridge({type:'ACK',sessionId:session.sessionId,commandId:manager.commands(session.instanceId).find(c=>c.type==='CONFIG_SYNC').id,status:'applied'},session.instanceId);
 const group=manager.execute('group.create',{name:'fixture',members:[channel.id],intervalMs:0});manager.execute('group.start',{id:group.id});manager.tick();
 const attempt=manager.snapshot().attempts[0];manager.bridge({type:'PREPARED',sessionId:session.sessionId,attemptId:attempt.id,accountId:'111',channelId:'333',configVersion:attempt.configVersion,draftClear:true},session.instanceId);manager.close();
 const store=new CentralStore(databasePath),state=store.read();
 const legacy=state.attempts.find(a=>a.id===attempt.id);legacy.maxSendRetries=0;legacy.sendRetryCount=8;legacy.authorizedRetryCount=8;
 state.settings.maxSendRetries=null;state.retryPolicyVersion=1;state.stateVersion++;store.commit(state,[]);store.close();
 manager=createCentralManager({databasePath});
 try{
  const snapshot=manager.snapshot(),migrated=snapshot.attempts[0];
  assert.equal(Object.hasOwn(snapshot.settings,'maxSendRetries'),false);assert.equal(migrated.maxSendRetries,null);
  assert.equal(migrated.status,'unknown');assert.equal(migrated.sendRetryCount,8);assert.equal(snapshot.groups[0].activeAttemptId,attempt.id);
  assert.equal(snapshot.attempts.length,1);assert.throws(()=>manager.execute('group.resume',{id:group.id}),{code:'ATTEMPT_UNRESOLVED'});
  assert.ok(manager.supportData().locks.some(lock=>lock.groupId===group.id));
  assert.equal(manager.commands(session.instanceId).filter(c=>c.type==='COMMIT_PERMIT'||c.type==='PREPARE').length,0);
  assert.ok(snapshot.incidents.some(i=>i.code==='delivery_unknown'&&i.status==='open'));
  assert.ok(manager.events({type:'settings.retry_policy_migrated'}).some(e=>e.normalizedAttempts===1));
 }finally{manager.close();}
});
