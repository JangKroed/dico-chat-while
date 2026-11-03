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
test('upgrade replaces the legacy five-retry default once, preserving subsequent explicit choices',t=>{
 const databasePath=legacyDatabase(t,5);
 let manager=createCentralManager({databasePath});
 try{
  assert.equal(manager.snapshot().settings.maxSendRetries,null);
  assert.equal(manager.events({type:'settings.retry_policy_migrated'}).length,1);
  manager.execute('settings.update',{maxSendRetries:5});
 }finally{manager.close();}
 manager=createCentralManager({databasePath});
 try{assert.equal(manager.snapshot().settings.maxSendRetries,5);assert.equal(manager.events({type:'settings.retry_policy_migrated'}).length,1);}finally{manager.close();}
});
test('upgrade preserves unlimited, zero, and other custom retry counts',t=>{
 for(const count of [null,0,3,27]){
  const manager=createCentralManager({databasePath:legacyDatabase(t,count)});
  try{assert.equal(manager.snapshot().settings.maxSendRetries,count);}finally{manager.close();}
 }
});
