import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {createCentralManager} from '../central/core/index.js';
import {verifyRollbackCompatibility,safeToUpdate} from '../central/runtime/updater.mjs';

async function fixture(t,mutation='',seed){
 const directory=await mkdtemp(join(tmpdir(),'dico-rollback-review-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const target=join(directory,'target'),workDirectory=join(directory,'work');
 await mkdir(join(target,'central/core'),{recursive:true});await mkdir(workDirectory);
 await writeFile(join(target,'central/package.json'),JSON.stringify({type:'module'}));
 // 실제 네트워크·설치 코드를 실행하지 않고 과거 core의 시작 마이그레이션만 모사합니다.
 // schemaVersion=1을 반환하더라도 사용자 데이터/이력을 삭제한다면 호환되지 않습니다.
 await writeFile(join(target,'central/core/index.js'),`import {DatabaseSync} from 'node:sqlite';
 export function createCentralManager({databasePath}){const db=new DatabaseSync(databasePath);const row=db.prepare('SELECT data FROM central_state WHERE singleton=1').get();const state=JSON.parse(row.data);${mutation};return {snapshot:()=>({...state,service:{status:'ready'}}),close:()=>db.close()};}`);
 const manager=createCentralManager({databasePath:join(directory,'central.sqlite')});
 manager.execute('message.create',{name:'현재 메시지',body:'보존할 현재 본문'});
 manager.execute('settings.update',{retentionDays:180});manager.close();
 if(seed){const db=new DatabaseSync(join(directory,'central.sqlite'));try{const state=JSON.parse(db.prepare('SELECT data FROM central_state WHERE singleton=1').get().data);Object.assign(state,seed);db.prepare('UPDATE central_state SET data=? WHERE singleton=1').run(JSON.stringify(state));}finally{db.close();}}
 return{directory,target,workDirectory};
}

test('rollback compatibility inspects only a cloned database and removes its temporary files',async t=>{
 const f=await fixture(t),before=await readFile(join(f.directory,'central.sqlite'));
 await verifyRollbackCompatibility(f);
 assert.deepEqual(await readFile(join(f.directory,'central.sqlite')),before);
 assert.deepEqual(await readdir(f.workDirectory),[]);
});

for(const [name,mutation,seed] of [
 ['메시지 삭제',"state.messages=[];db.prepare('UPDATE central_state SET data=? WHERE singleton=1').run(JSON.stringify(state))"],
 ['현재 설정 변경',"state.settings.retentionDays=30;db.prepare('UPDATE central_state SET data=? WHERE singleton=1').run(JSON.stringify(state))"],
 ['과거 이벤트 삭제',"db.exec('DELETE FROM events')"],
 ['확정 결과 변경',"state.attempts[0].status='not_sent';db.prepare('UPDATE central_state SET data=? WHERE singleton=1').run(JSON.stringify(state))",{attempts:[{id:'a',status:'confirmed',messageId:'observed-post',finalizedAt:123}]}],
 ['자원 잠금 삭제',"state.locks=[];db.prepare('UPDATE central_state SET data=? WHERE singleton=1').run(JSON.stringify(state))",{locks:[{key:'account:111',groupId:'g'}]}],
 ['종료된 대기 이력 삭제',"state.intervals=[];db.prepare('UPDATE central_state SET data=? WHERE singleton=1').run(JSON.stringify(state))",{intervals:[{id:'closed',from:10,to:20,scope:'group',targetId:'g',reason:'paused'}]}],
])test(`schemaVersion이 같아도 ${name}하는 구버전은 호환 검사에서 거절한다`,async t=>{
 const f=await fixture(t,mutation,seed),before=await readFile(join(f.directory,'central.sqlite'));
 await assert.rejects(verifyRollbackCompatibility(f),{code:'ROLLBACK_INCOMPATIBLE'});
 assert.deepEqual(await readFile(join(f.directory,'central.sqlite')),before,'실제 DB는 호환 검사에서 수정하지 않습니다.');
 assert.deepEqual(await readdir(f.workDirectory),[],'실패한 복제 DB와 sidecar도 정리합니다.');
});

test('code rollback rejects active and blocked-unknown delivery even when extension reload could be allowed',()=>{
 const idle={service:{status:'ready'},groups:[{id:'g',status:'stopped'}],attempts:[]};
 assert.equal(safeToUpdate(idle),true);
 for(const status of ['preparing','permitted','unknown']){
  const snapshot={...idle,groups:[{id:'g',status:'stopped',activeAttemptId:'a'}],attempts:[{id:'a',groupId:'g',status,executionBlocked:true}]};
  assert.equal(safeToUpdate(snapshot),false);
 }
 assert.equal(safeToUpdate({...idle,groups:[{id:'g',status:'stopped',controlIntent:'stop'}]}),false);
});

test('real current core startup metadata and queued-command fencing remain compatible without changing live data',async t=>{
 const f=await fixture(t);
 await writeFile(join(f.target,'central/core/index.js'),`export {createCentralManager} from ${JSON.stringify(new URL('../central/core/index.js',import.meta.url).href)};`);
 const manager=createCentralManager({databasePath:join(f.directory,'central.sqlite')});
 const session=manager.bridge({type:'HELLO',protocolVersion:1});
 manager.bridge({type:'OBSERVATION',sessionId:session.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'111',guildId:'222',channelId:'333',tabId:1,verified:true}]},session.instanceId);
 const channel=manager.snapshot().channels[0],message=manager.snapshot().messages[0];
 manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:[{messageId:message.id}]});
 manager.execute('group.create',{name:'보존할 중지 그룹',members:[channel.id],intervalMs:3000});manager.close();
 const before=await readFile(join(f.directory,'central.sqlite'));
 await verifyRollbackCompatibility(f);
 assert.deepEqual(await readFile(join(f.directory,'central.sqlite')),before);
 assert.deepEqual(await readdir(f.workDirectory),[]);
});
