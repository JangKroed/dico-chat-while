import test from 'node:test';
import assert from 'node:assert/strict';
import {createCentralManager} from '../central/core/index.js';
function fixture(){
 const m=createCentralManager({now:()=>1800000000000,monotonicNow:()=>1000});
 const msg=m.execute('message.create',{name:'test',body:'synthetic'});
 for(let i=0;i<3;i++){
  const h=m.bridge({type:'HELLO',protocolVersion:1});
  m.bridge({type:'OBSERVATION',sessionId:h.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:String(111+i),guildId:'222',channelId:String(333+i),tabId:i+1,verified:true}]},h.instanceId);
  const c=m.snapshot().channels.find(c=>c.instanceId===h.instanceId);
  m.execute('channel.applyPlaylist',{id:c.id,expectedVersion:c.version,items:[{messageId:msg.id}]});
  const cmd=m.commands(h.instanceId).find(c=>c.type==='CONFIG_SYNC');
  m.bridge({type:'ACK',sessionId:h.sessionId,commandId:cmd.id,status:'applied'},h.instanceId);
  m.execute('group.create',{name:'group'+i,members:[c.id]});
 }
 return m;
}
test('모두 실행은 비활성 그룹을 제외하고 선택 실행은 명시한 그룹만 시작한다',()=>{
 for(const selected of [false,true]){const m=fixture(),gs=m.snapshot().groups;
 m.execute('group.setEnabled',{id:gs[1].id,expectedVersion:gs[1].version,enabled:false});
 m.execute('service.startAll',selected?{groupIds:[gs[2].id]}:{});
 assert.deepEqual(m.snapshot().groups.map(g=>g.status),selected?['stopped','stopped','running']:['running','stopped','running']);
 }
});
test('빈 선택·없는 그룹·비활성 선택은 원자적으로 거절하고 직접 시작도 막는다',()=>{
 const m=fixture(),gs=m.snapshot().groups;
 m.execute('group.setEnabled',{id:gs[1].id,expectedVersion:gs[1].version,enabled:false});
 for(const groupIds of [[],['missing'],[gs[0].id,gs[1].id]])assert.throws(()=>m.execute('service.startAll',{groupIds}));
 assert.throws(()=>m.execute('group.start',{id:gs[1].id}),{code:'GROUP_DISABLED'});
 assert.ok(m.snapshot().groups.every(g=>g.status==='stopped'));
});
test('실행 중 비활성화는 중지 절차를 요청하고 활성화만으로 재시작하지 않는다',()=>{
 const m=fixture(),g=m.snapshot().groups[0];m.execute('group.start',{id:g.id});
 m.execute('group.setEnabled',{id:g.id,expectedVersion:g.version,enabled:false});
 let saved=m.snapshot().groups[0];assert.equal(saved.enabled,false);assert.notEqual(saved.status,'running');assert.equal(saved.autoResume,undefined);
 m.execute('group.setEnabled',{id:g.id,expectedVersion:saved.version,enabled:true});
 assert.notEqual(m.snapshot().groups[0].status,'running');
});

test('비활성 설정은 백업 복원 후에도 보존되며 기존 설정은 활성으로 취급한다',()=>{
 const m=fixture(),g=m.snapshot().groups[0];
 m.execute('group.setEnabled',{id:g.id,expectedVersion:g.version,enabled:false});
 const backup=m.exportBackup();assert.equal(backup.groups[0].enabled,false);
 m.importBackup(backup);assert.equal(m.snapshot().groups[0].enabled,false);
 delete backup.groups[0].enabled;m.importBackup(backup);assert.equal(m.snapshot().groups[0].enabled,true);m.close();
});
