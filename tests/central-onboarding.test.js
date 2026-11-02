import test from 'node:test';
import assert from 'node:assert/strict';
import {registeredAccounts,logicalTargets,setupSteps,groupBlockers,allRunBlockers,browserOnline,pendingConnection} from '../central/ui/src/onboarding.ts';

const now=1700000000000;
const snapshot=()=>({messages:[{id:'m',revisions:[{id:'r'}]}],instances:[{id:'i',connected:true,lastSeenAt:now,legacyFrozen:true,legacyPending:false}],accounts:[{id:'a',instanceId:'i',accountId:'discord',name:'업무 계정',verified:true}],targets:[{id:'t',guildId:'g',channelId:'c',name:'업무 채널'}],channels:[{id:'b',instanceId:'i',accountId:'discord',guildId:'g',channelId:'c',name:'업무 채널',verified:true,playlist:[{messageId:'m',revisionId:'r'}],configVersion:1,appliedVersion:1}],groups:[{id:'group',members:['b'],status:'stopped'}],commands:[]});
test('registered accounts and logical targets are independent of bindings',()=>{
  const s=snapshot();s.channels=[];
  assert.equal(registeredAccounts(s).length,1);assert.equal(logicalTargets(s).length,1);
  assert.deepEqual(setupSteps(s,now).map(x=>x.done),[true,true,false,false,false]);
});
test('empty playlist with equal zero versions never counts as applied or group ready',()=>{
  const s=snapshot();Object.assign(s.channels[0],{playlist:[],configVersion:0,appliedVersion:0});
  assert.equal(setupSteps(s,now)[3].done,false);assert.equal(setupSteps(s,now)[4].done,false);
  assert.ok(groupBlockers(s,s.groups[0],now).includes('메시지 적용 필요'));
});
test('all group members must be verified, online and applied',()=>{
  const s=snapshot();assert.equal(setupSteps(s,now)[4].done,true);
  s.channels.push({...s.channels[0],id:'b2',verified:false});s.groups[0].members.push('b2');
  assert.equal(setupSteps(s,now)[4].done,false);
  s.channels[1].verified=true;s.instances[0].lastSeenAt=now-16000;
  assert.ok(groupBlockers(s,s.groups[0],now).includes('브라우저 연결 필요'));
});
test('pending open-channel request is not a verified connection',()=>{
  const s=snapshot();s.channels=[];s.commands=[{type:'OPEN_CHANNEL',status:'queued',instanceId:'i',payload:{accountId:'discord',guildId:'g',channelId:'c'}}];
  assert.ok(pendingConnection(s,s.accounts[0],s.targets[0]));assert.equal(setupSteps(s,now)[2].done,false);
  s.commands[0].status='applied';assert.ok(pendingConnection(s,s.accounts[0],s.targets[0]),'opening a tab still needs an actual channel observation');
  s.commands[0].status='completed';assert.equal(pendingConnection(s,s.accounts[0],s.targets[0]),undefined);
});
test('fallback deduplicates legacy entities, but explicit empty collections stay empty',()=>{
  const s=snapshot();s.channels.push({...s.channels[0],id:'b2'});delete s.accounts;delete s.targets;
  assert.equal(registeredAccounts(s).length,1);assert.equal(logicalTargets(s).length,1);
  s.accounts=[];s.targets=[];assert.equal(registeredAccounts(s).length,0);assert.equal(logicalTargets(s).length,0);
});
test('unapplied and missing revisions block group readiness',()=>{
  const s=snapshot();s.channels[0].appliedVersion=0;
  assert.ok(groupBlockers(s,s.groups[0],now).includes('확장 적용 확인 대기'));
  s.channels[0].appliedVersion=1;s.messages=[];
  assert.ok(groupBlockers(s,s.groups[0],now).includes('메시지 수정본 확인 필요'));
});
test('a browser without a heartbeat cannot be shown as fresh or ready',()=>{
  const s=snapshot();delete s.instances[0].lastSeenAt;
  assert.equal(browserOnline(s.instances[0],now),false);
  assert.equal(setupSteps(s,now)[0].done,false);
  assert.ok(groupBlockers(s,s.groups[0],now).includes('브라우저 연결 필요'));
});
test('all-run detects independent groups competing for the same logical channel',()=>{
  const s=snapshot();Object.assign(s.groups[0],{guildId:'g',channelId:'c'});
  assert.deepEqual(allRunBlockers(s,now),[]);
  s.groups.push({...s.groups[0],id:'second-group'});
  assert.ok(allRunBlockers(s,now).some(r=>r.includes('같은 채널')));
  s.groups[1].status='running';assert.ok(allRunBlockers(s,now).some(r=>r.includes('같은 채널')));
  s.groups[1].channelId='other-channel';assert.deepEqual(allRunBlockers(s,now),[]);
});

test('account bulk selection includes only eligible connections and excludes verified, pending and legacy rows',async()=>{
 const {selectableConnectionAccountIds}=await import('../central/ui/src/onboarding.ts');
 const now=1800000000000,target={id:'target',guildId:'guild',channelId:'channel'};
 const accounts=['ready','verified','pending','offline','unverified','legacy:old'].map(id=>({id,instanceId:id,accountId:`discord-${id}`,verified:id!=='unverified'}));
 const s={accounts,instances:accounts.map(a=>({id:a.id,connected:a.id!=='offline',lastSeenAt:now})),channels:[{id:'binding',instanceId:'verified',accountId:'discord-verified',guildId:'guild',channelId:'channel',verified:true}],commands:[{type:'OPEN_CHANNEL',status:'queued',instanceId:'pending',payload:{accountEntityId:'pending',targetId:'target'}}]};
 assert.deepEqual(selectableConnectionAccountIds(s,target,now),['ready']);
 assert.deepEqual(selectableConnectionAccountIds(s,{...target,id:'legacy:target'},now),[]);
 assert.deepEqual(selectableConnectionAccountIds(s,undefined,now),[]);
 s.channels[0].verified=false;s.commands=[];
 assert.deepEqual(selectableConnectionAccountIds(s,target,now),['ready','verified','pending']);
});
