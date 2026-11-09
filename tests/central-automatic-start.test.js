import test from 'node:test';import assert from 'node:assert/strict';import {createCentralManager} from '../central/core/index.js';
function fixture(options = {}) {
  let time = 1_800_000_000_000, mono = 1_000;
  const manager = createCentralManager({ now: () => time, monotonicNow: () => mono, ...options });
  const sessions = [];
  const advance = (ms) => { time += ms; mono += ms; };
  const connect = (accountId = 'a', channelId = 'channel', capabilities = ['central-v1']) => {
    const hello = manager.bridge({ type: 'HELLO', protocolVersion: 1, name: accountId, capabilities });
    sessions.push(hello);
    manager.bridge({ type: 'OBSERVATION', sessionId: hello.sessionId, legacyFrozen: true, legacyPending: false,
      channels: [{ accountId, guildId: 'guild', channelId, name: 'Channel', tabId: sessions.length, verified: true }] }, hello.instanceId);
    return { ...hello, channel: manager.snapshot().channels.find(c => c.instanceId === hello.instanceId) };
  };
  const message = (body = 'Hello') => manager.execute('message.create', { name: body, body });
  const apply = (connection, messages) => {
    const channel = manager.snapshot().channels.find(c => c.id === connection.channel.id);
    manager.execute('channel.applyPlaylist', { id: channel.id, expectedVersion: channel.version, items: messages.map(m => ({ messageId: m.id })) });
    const command = manager.commands(connection.instanceId).findLast(c => c.type === 'CONFIG_SYNC');
    manager.bridge({ type: 'ACK', sessionId: connection.sessionId, commandId: command.id, status: 'applied' }, connection.instanceId);
  };
  const group = (connections, intervalMs = 0) => manager.execute('group.create', { name: 'Rotation', members: connections.map(c => c.channel.id), intervalMs });
  const start = (g) => { manager.execute('group.start', { id: g.id }); manager.tick(); };
  const prepared = (connection, attempt) => manager.bridge({ type: 'PREPARED', sessionId: connection.sessionId, attemptId: attempt.id,
    accountId: connection.channel.accountId, channelId: connection.channel.channelId, configVersion: attempt.configVersion, draftClear: true }, connection.instanceId);
  const result = (connection, attempt, outcome = 'confirmed', extra = {}) => manager.bridge({ type: 'DELIVERY_RESULT', sessionId: connection.sessionId, attemptId: attempt.id, outcome, messageId: 'post-' + attempt.id, ...extra }, connection.instanceId);
  return { manager, connect, message, apply, group, start, prepared, result, advance, jumpWall: ms => { time += ms; } };
}


function configured(t){const f=fixture();t.after(()=>f.manager.close());
 const h=f.manager.bridge({type:'HELLO',protocolVersion:1,browser:'Chrome',name:'Chrome',capabilities:['central-v1']});
 f.manager.bridge({type:'OBSERVATION',sessionId:h.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'a',guildId:'guild',channelId:'channel',tabId:1,verified:true}]},h.instanceId);
 const c={...h,channel:f.manager.snapshot().channels[0]};f.apply(c,[f.message()]);const g=f.group([c]);
 const i=f.manager.snapshot().instances[0];f.manager.execute('instance.setLaunchProfile',{id:i.id,expectedVersion:i.version,profileId:'Chrome:Default'});
 return{...f,c,g};}
test('오프라인 실행 요청은 준비 상태에 머물며 발송 허가를 만들지 않는다',t=>{const f=configured(t);f.manager.bridge({type:'DISCONNECT',sessionId:f.c.sessionId},f.c.instanceId);f.manager.execute('group.start',{id:f.g.id});f.manager.tick();const s=f.manager.snapshot();assert.ok(s.groups[0].pendingStart);assert.equal(s.attempts.length,0);});
test('모두 중지는 아직 stopped인 연결 준비 요청도 취소한다',t=>{const f=configured(t);f.manager.bridge({type:'DISCONNECT',sessionId:f.c.sessionId},f.c.instanceId);f.manager.execute('group.start',{id:f.g.id});f.manager.execute('service.stopAll');assert.equal(f.manager.snapshot().groups[0].pendingStart,undefined);});
test('프로필은 브라우저 종류와 일치해야 한다',t=>{const f=configured(t),i=f.manager.snapshot().instances[0];assert.throws(()=>f.manager.execute('instance.setLaunchProfile',{id:i.id,expectedVersion:i.version,profileId:'Brave:Default'}),{code:'VALIDATION'});});
test('준비 중 프로필을 바꾸거나 셸 경로를 저장할 수 없다',t=>{const f=configured(t);f.manager.bridge({type:'DISCONNECT',sessionId:f.c.sessionId},f.c.instanceId);f.manager.execute('group.start',{id:f.g.id});const i=f.manager.snapshot().instances[0];assert.throws(()=>f.manager.execute('instance.setLaunchProfile',{id:i.id,expectedVersion:i.version,profileId:null}),{code:'GROUP_RUNNING'});});
test('재연결 계정·채널 관찰과 설정 ACK 후에만 예약 실행을 시작한다',t=>{
 const f=configured(t);f.manager.bridge({type:'DISCONNECT',sessionId:f.c.sessionId},f.c.instanceId);f.manager.execute('group.start',{id:f.g.id});
 const h=f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:f.c.instanceId,browser:'Chrome',name:'Chrome',capabilities:['central-v1']});
 f.manager.tick();assert.ok(f.manager.snapshot().groups[0].pendingStart);assert.equal(f.manager.snapshot().attempts.length,0);
 f.manager.bridge({type:'OBSERVATION',sessionId:h.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'a',guildId:'guild',channelId:'channel',tabId:2,verified:true}]},h.instanceId);
 f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,0);
 const sync=f.manager.commands(h.instanceId).findLast(c=>c.type==='CONFIG_SYNC');assert.ok(sync);
 f.manager.bridge({type:'ACK',sessionId:h.sessionId,commandId:sync.id,status:'applied'},h.instanceId);f.manager.tick();
 assert.equal(f.manager.snapshot().groups[0].pendingStart,undefined);assert.equal(f.manager.snapshot().groups[0].status,'running');
});
test('계정 브라우저 배정은 그룹·메시지 연결을 유지하고 현재 검증을 무효화한다',t=>{
 const f=configured(t),before=f.manager.snapshot(),a=before.accounts[0];assert.ok(a);
 const target=f.manager.bridge({type:'HELLO',protocolVersion:1,browser:'Brave',name:'Brave',capabilities:['open-channel-v1']});
 f.manager.execute('account.assignBrowser',{id:a.id,expectedVersion:a.version,instanceId:target.instanceId});const s=f.manager.snapshot();
 assert.equal(s.accounts[0].instanceId,target.instanceId);assert.equal(s.accounts[0].verified,false);assert.equal(s.channels[0].id,before.channels[0].id);assert.equal(s.channels[0].instanceId,target.instanceId);assert.deepEqual(s.channels[0].playlist,before.channels[0].playlist);assert.deepEqual(s.groups[0].members,before.groups[0].members);
});
