import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCentralManager} from '../central/core/index.js';
import {CentralStore} from '../central/core/store.js';

test('읽기 전용 보고서는 구형 저장 설정의 버전·간격·적용 상태를 바꾸지 않는다',t=>{
 const dir=mkdtempSync(join(tmpdir(),'dico-readonly-legacy-')),databasePath=join(dir,'central.sqlite');
 const initial=createCentralManager({databasePath});initial.close();
 const store=new CentralStore(databasePath),state=store.read();state.stateVersion++;
 state.channels=[{id:'legacy',version:7,configVersion:3,appliedVersion:3,intervalMs:1000,slowmodeMs:10000,playlist:[]}];store.commit(state,[]);store.close();
 const reader=createCentralManager({databasePath,readOnly:true});t.after(()=>{reader.close();rmSync(dir,{recursive:true,force:true});});
 const c=reader.supportData().channels[0];
 assert.equal(c.version,7);assert.equal(c.configVersion,3);assert.equal(c.appliedVersion,3);assert.equal(c.intervalMs,1000);assert.equal(c.intervalMode,undefined);
});

test('제보용 읽기 전용 코어는 실행 상태·이력·세션을 갱신하지 않는다',t=>{
 const dir=mkdtempSync(join(tmpdir(),'dico-readonly-')),databasePath=join(dir,'central.sqlite');
 const writer=createCentralManager({databasePath});t.after(()=>{writer.close();rmSync(dir,{recursive:true,force:true});});
 const before=writer.snapshot(),reader=createCentralManager({databasePath,readOnly:true});
 try{
  assert.equal(reader.snapshot().stateVersion,before.stateVersion);
  assert.deepEqual(reader.events({}),writer.events({}));
  assert.throws(()=>reader.execute('message.create',{name:'forbidden',body:'fixture'}),{code:'READ_ONLY'});
 }finally{reader.close();}
 assert.equal(writer.snapshot().stateVersion,before.stateVersion);
 writer.execute('message.create',{name:'still writable',body:'fixture'});
});

test('제보용 읽기 트랜잭션은 수집 중 쓰기를 막지 않고 동일 버전의 상태·이력을 읽는다',t=>{
 const dir=mkdtempSync(join(tmpdir(),'dico-readonly-snapshot-')),databasePath=join(dir,'central.sqlite');
 const writer=createCentralManager({databasePath});t.after(()=>{writer.close();rmSync(dir,{recursive:true,force:true});});
 const reader=new CentralStore(databasePath,{readOnly:true}),before=reader.read();
 try{
  writer.execute('message.create',{name:'later',body:'fixture'});
  assert.equal(reader.read().stateVersion,before.stateVersion);
  assert.equal(reader.recent(100).some(e=>e.type==='message.created'),false);
  assert.throws(()=>reader.commit(before,[]));
 }finally{reader.close();}
 assert.equal(writer.snapshot().messages.length,1);
});
