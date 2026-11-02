import test from 'node:test';
import assert from 'node:assert/strict';
import {createCentralManager} from '../central/core/index.js';
import {accountLabel} from '../central/ui/src/account-label.ts';

function fixture(){
  const manager=createCentralManager({now:()=>1_800_000_000_000,monotonicNow:()=>1000});
  let session=manager.bridge({type:'HELLO',protocolVersion:1});
  const observe=(fields={},owner=session)=>manager.bridge({type:'ACCOUNT_OBSERVATION',sessionId:owner.sessionId,accountId:'111',verified:true,...fields},owner.instanceId).account;
  return{manager,observe,get session(){return session;},reconnect:()=>{session=manager.bridge({type:'HELLO',protocolVersion:1,instanceId:session.instanceId});return session;}};
}

test('verified registration stores the real nickname and username for every account label consumer',()=>{
  const f=fixture();try{
    const a=f.observe({accountName:'  호야  ',username:'hoya.dev'});assert.equal(a.name,'호야');assert.equal(a.observedName,'호야');assert.equal(a.username,'hoya.dev');assert.equal(a.nameCustomized,false);
    assert.equal(accountLabel(f.manager.snapshot(),{accountId:'111',instanceId:f.session.instanceId}),'호야');
    const updated=f.observe({accountName:'호야 새이름',username:'hoya.updated'});assert.equal(updated.name,'호야 새이름');assert.ok(updated.version>a.version);
    const same=f.observe({accountName:'호야 새이름',username:'hoya.updated'});assert.equal(same.version,updated.version);
    assert.equal(f.manager.snapshot().attempts.length,0);assert.equal(f.manager.snapshot().commands.length,0);
  }finally{f.manager.close();}
});

test('user-customized aliases survive nickname updates including an explicit numeric alias',()=>{
  const f=fixture();try{
    for(const alias of ['직접 지정한 업무 계정','111']){const a=f.observe({accountName:'Discord 닉네임',username:'hoya'});f.manager.execute('account.update',{id:a.id,expectedVersion:a.version,name:alias});const updated=f.observe({accountName:'바뀐 Discord 이름'});
      assert.equal(updated.name,alias);assert.equal(updated.observedName,'바뀐 Discord 이름');assert.equal(updated.nameCustomized,true);assert.equal(accountLabel(f.manager.snapshot(),updated),alias);
    }
  }finally{f.manager.close();}
});

test('unverified observations, stale sessions and malformed names cannot rename an account',()=>{
  const f=fixture();try{
    const a=f.observe({accountName:'검증한 이름',username:'verified'});f.observe({verified:false,accountName:'확인되지 않은 이름',username:'wrong',verificationReason:'identity_unverified'});
    for(const accountName of ['x'.repeat(101),'bad\nname',{name:'bad'},'   '])f.observe({accountName});
    assert.throws(()=>f.observe({sessionId:'old-session',accountName:'다른 이름'}),{code:'STALE_SESSION'});
    const current=f.manager.snapshot().accounts.find(x=>x.id===a.id);assert.equal(current.name,'검증한 이름');assert.equal(current.username,'verified');
  }finally{f.manager.close();}
});

test('verified channel observations accept only explicit account metadata, never a channel name',()=>{
  const f=fixture();try{
    const send=fields=>f.manager.bridge({type:'OBSERVATION',sessionId:f.session.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'111',guildId:'222',channelId:'333',tabId:1,verified:true,name:'서버 채널 이름',...fields}]},f.session.instanceId);
    send({});assert.equal(f.manager.snapshot().accounts[0].name,'111');
    send({accountName:'실제 계정 이름',username:'actual'});assert.equal(f.manager.snapshot().accounts[0].name,'실제 계정 이름');
    send({verified:false,accountName:'미검증 이름'});assert.equal(f.manager.snapshot().accounts[0].name,'실제 계정 이름');
  }finally{f.manager.close();}
});

test('observed names remain scoped to the verified browser and account identity',()=>{
  const f=fixture();try{
    f.observe({username:'first.user'});const other=f.manager.bridge({type:'HELLO',protocolVersion:1});f.observe({accountName:'두 번째 브라우저'},other);
    const s=f.manager.snapshot();assert.equal(accountLabel(s,{accountId:'111',instanceId:f.session.instanceId}),'first.user');assert.equal(accountLabel(s,{accountId:'111',instanceId:other.instanceId}),'두 번째 브라우저');
    f.observe({accountId:'222',accountName:'다른 로그인 계정'});assert.equal(f.manager.snapshot().accounts.find(a=>a.instanceId===f.session.instanceId&&a.accountId==='111').name,'first.user');
  }finally{f.manager.close();}
});

test('backup round-trip preserves automatic naming and legacy aliases remain customized',()=>{
  const f=fixture();try{
    f.observe({accountName:'자동 이름',username:'automatic'});let backup=f.manager.exportBackup();assert.equal(backup.accounts[0].nameCustomized,false);assert.equal(backup.accounts[0].observedName,'자동 이름');
    f.manager.importBackup(backup);f.reconnect();assert.equal(f.observe({accountName:'새 자동 이름'}).name,'새 자동 이름');
    backup=f.manager.exportBackup();backup.accounts[0].name='예전 버전 사용자 별칭';delete backup.accounts[0].nameCustomized;delete backup.accounts[0].observedName;delete backup.accounts[0].username;
    f.manager.importBackup(backup);f.reconnect();const old=f.observe({accountName:'새 Discord 이름'});assert.equal(old.name,'예전 버전 사용자 별칭');assert.equal(old.nameCustomized,true);
  }finally{f.manager.close();}
});
