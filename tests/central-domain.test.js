import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCentralManager } from '../central/core/index.js';

function fixture(options = {}) {
  let time = 1_800_000_000_000, mono = 1_000;
  const manager = createCentralManager({ now: () => time, monotonicNow: () => mono, ...options });
  const sessions = [];
  const advance = (ms) => { time += ms; mono += ms; };
  const connect = (accountId = 'a', channelId = 'channel') => {
    const hello = manager.bridge({ type: 'HELLO', protocolVersion: 1, name: accountId, capabilities: ['central-v1'] });
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

test('message revisions stay immutable, validate content and reject stale editors', () => {
  const f = fixture(); const m = f.message('Original');
  const updated = f.manager.execute('message.update', { id: m.id, expectedVersion: 1, body: 'Updated' });
  assert.equal(updated.version, 2); assert.equal(updated.revisions[0].body, 'Original');
  assert.throws(() => f.manager.execute('message.update', { id: m.id, expectedVersion: 1, body: 'Clobber' }), { code: 'VERSION_CONFLICT' });
  for (const body of ['', 'x'.repeat(2001), '@everyone hello', '<@&123>']) assert.throws(() => f.message(body), { code: 'VALIDATION' });
  const copy = f.manager.execute('message.duplicate', { id: m.id }); assert.notEqual(copy.id, m.id); assert.equal(copy.body, 'Updated');
  f.manager.close();
});

test('applied configuration requires applied ACK, with no send from received ACK', () => {
  const f = fixture(), c = f.connect(), m = f.message();
  f.manager.execute('channel.applyPlaylist', { id: c.channel.id, expectedVersion: 1, items: [{ messageId: m.id }] });
  const config = f.manager.commands(c.instanceId)[0];
  f.manager.bridge({ type: 'ACK', sessionId: c.sessionId, commandId: config.id, status: 'received' }, c.instanceId);
  const g = f.group([c]); assert.throws(() => f.start(g), { code: 'CONFIG_PENDING' });
  f.manager.bridge({ type: 'ACK', sessionId: c.sessionId, commandId: config.id, status: 'applied' }, c.instanceId);
  f.start(g); assert.equal(f.manager.snapshot().attempts.length, 1);
  f.manager.close();
});

test('A B C 100 rotations preserve order and per-account playlist through duplicate reports', () => {
  const f = fixture(), cs = ['A','B','C'].map(a => f.connect(a)); const one = f.message('One'), two = f.message('Two');
  cs.forEach(c => { f.manager.execute('channel.update', { id:c.channel.id, expectedVersion:1, intervalMs:0 }); f.apply(c, c === cs[0] ? [one, two] : [one]); }); const g = f.group(cs); f.start(g);
  for (let i = 0; i < 300; i++) {
    const a = f.manager.snapshot().attempts.find(a => a.status === 'preparing'); const c = cs[i % 3];
    assert.equal(a.accountId, ['A','B','C'][i % 3]);
    assert.equal(f.manager.commands(c.instanceId).find(cmd=>cmd.type==='PREPARE').payload.body, i % 3 === 0 && Math.floor(i / 3) % 2 ? 'Two' : 'One');
    f.prepared(c, a); f.prepared(c, a); f.result(c, a); f.result(c, a); f.manager.tick();
  }
  assert.equal(f.manager.analytics().outcomes.confirmed, 300);
  assert.equal(f.manager.snapshot().groups[0].cursor, 0); f.manager.close();
});

test('unknown outcomes retain locks, freeze order, reject manual unsent without executor evidence', () => {
  const f = fixture(), c = f.connect(); f.apply(c,[f.message()]); const g = f.group([c]); f.start(g);
  const a = f.manager.snapshot().attempts[0]; f.prepared(c,a); f.result(c,a,'unknown');
  for(let i=0;i<5;i++){f.advance(1000);f.manager.tick();}
  assert.equal(f.manager.snapshot().attempts.length,1);
  assert.throws(()=>f.manager.execute('attempt.resolve',{id:a.id,outcome:'not_sent',executionBlocked:true}),{code:'EXECUTION_UNCERTAIN'});
  const other = f.group([c]); assert.throws(()=>f.start(other),{code:'RESOURCE_BUSY'});
  f.result(c,a,'confirmed'); assert.equal(f.manager.analytics().outcomes.confirmed,1);
  assert.equal(f.manager.snapshot().incidents[0].status,'resolved'); f.manager.close();
});

test('stopping cannot release a possible permit from receipt ACK or control applied alone', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
  f.manager.execute('group.stop',{id:g.id});const stop=f.manager.commands(c.instanceId).findLast(c=>c.type==='CONTROL');
  f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:stop.id,status:'received'},c.instanceId);
  assert.equal(f.manager.snapshot().groups[0].status,'stop_pending');
  f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:stop.id,status:'applied'},c.instanceId);
  assert.equal(f.manager.snapshot().groups[0].status,'stop_pending');
  f.result(c,a,'confirmed');assert.equal(f.manager.snapshot().groups[0].status,'stopped');f.manager.close();
});

test('reconnect fences old session but preserves previous unresolved permit', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
  const fresh=f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:c.instanceId});
  assert.notEqual(fresh.sessionId,c.sessionId);
  assert.throws(()=>f.prepared(c,a),{code:'STALE_SESSION'});
  assert.equal(f.manager.snapshot().attempts[0].status,'unknown');
  assert.ok(f.manager.commands(c.instanceId).some(c=>c.type==='RECONCILE'));
  assert.equal(f.manager.commands(c.instanceId).filter(c=>c.type==='COMMIT_PERMIT').length,0);f.manager.close();
});

test('restart persists all state, blocks automatic resume and preserves active permits', () => {
  const dir=mkdtempSync(join(tmpdir(),'dico-core-')),databasePath=join(dir,'state.sqlite');
  try {const f=fixture({databasePath}),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);const a=f.manager.snapshot().attempts[0];f.prepared(c,a);f.manager.close();
    const reopened=createCentralManager({databasePath});reopened.tick();assert.equal(reopened.snapshot().attempts.length,1);assert.equal(reopened.snapshot().attempts[0].status,'unknown');
    assert.equal(reopened.snapshot().service.status,'resume_required');assert.equal(reopened.snapshot().channels[0].verified,false);reopened.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('referenced revisions cannot be deleted and editing library does not change applied body', () => {
  const f=fixture(),c=f.connect(),m=f.message('Fixed');f.apply(c,[m]);f.manager.execute('message.update',{id:m.id,expectedVersion:1,body:'New'});
  assert.throws(()=>f.manager.execute('message.delete',{id:m.id,expectedVersion:2}),{code:'MESSAGE_IN_USE'});
  const g=f.group([c]);f.start(g);assert.equal(f.manager.commands(c.instanceId).find(cmd=>cmd.type==='PREPARE').payload.body,'Fixed');f.manager.close();
});

test('wall-clock jump and loop stall require manual resume, never catch-up permits', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c],60000);f.start(g);let a=f.manager.snapshot().attempts[0];f.prepared(c,a);f.result(c,a);
  f.jumpWall(3600000);f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);assert.equal(f.manager.snapshot().service.status,'resume_required');f.manager.close();
  const z=fixture(),d=z.connect();z.apply(d,[z.message()]);z.start(z.group([d]));z.advance(20000);z.manager.tick();assert.equal(z.manager.snapshot().service.status,'resume_required');z.manager.close();
});

test('events are durable ordered and exclude raw bridge credentials or body diagnostics', () => {
  const f=fixture(),events=[];f.manager.subscribe(e=>events.push(e));const c=f.connect();f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId,token:'do-not-store',body:'secret-body'},c.instanceId);
  f.message('Private text');const logs=f.manager.events();assert.ok(logs.length>0);assert.ok(events.length>0);
  assert.equal(JSON.stringify(logs).includes('Private text'),false);assert.equal(JSON.stringify(f.manager.snapshot()).includes('do-not-store'),false);
  assert.ok(logs.every((e,i)=>!i||e.eventId>logs[i-1].eventId));f.manager.close();
});

test('bad group membership fails atomically and does not mutate version or publish event', () => {
  const f=fixture(),a=f.connect('A','one'),b=f.connect('B','two');const before=f.manager.snapshot();
  assert.throws(()=>f.group([a,b]),{code:'CHANNEL_MISMATCH'});assert.equal(f.manager.snapshot().stateVersion,before.stateVersion);assert.equal(f.manager.snapshot().groups.length,0);f.manager.close();
});

test('unsupported protocols and corrupt existing databases are never silently replaced', () => {
  const f=fixture();assert.throws(()=>f.manager.bridge({type:'HELLO',protocolVersion:9}),{code:'PROTOCOL_MISMATCH'});f.manager.close();
  const dir=mkdtempSync(join(tmpdir(),'dico-corrupt-')),databasePath=join(dir,'state.sqlite');writeFileSync(databasePath,'broken');
  try {assert.throws(()=>createCentralManager({databasePath}));}finally{rmSync(dir,{recursive:true,force:true});}
});

test('backup restores configuration stopped without session or permit credentials', () => {
  const f=fixture(),c=f.connect(),m=f.message('Private backup body');f.apply(c,[m]);const g=f.group([c]);
  const backup=f.manager.exportBackup();assert.equal(JSON.stringify(backup).includes(c.sessionId),false);assert.equal(backup.attempts,undefined);
  f.manager.execute('message.update',{id:m.id,expectedVersion:1,body:'Changed'});
  f.manager.importBackup(backup);const restored=f.manager.snapshot();assert.equal(restored.messages[0].body,'Private backup body');assert.equal(restored.groups[0].status,'stopped');assert.equal(restored.channels[0].verified,false);assert.equal(restored.channels[0].appliedVersion,0);
  assert.throws(()=>f.manager.execute('group.start',{id:g.id}),{code:'CONNECTION_LOST'});f.manager.close();
});

test('backup restore cannot erase an unresolved attempt or accept a dangling playlist revision', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]),backup=f.manager.exportBackup();f.start(g);
  assert.throws(()=>f.manager.importBackup(backup),{code:'ATTEMPT_UNRESOLVED'});assert.equal(f.manager.snapshot().attempts.length,1);f.manager.close();
  const safe=fixture();const corrupt=structuredClone(backup);corrupt.channels[0].playlist[0].revisionId='missing';
  assert.throws(()=>safe.manager.importBackup(corrupt),{code:'VALIDATION'});assert.equal(safe.manager.snapshot().messages.length,0);safe.manager.close();
});

test('playlist changes during prepare wait for blocked executor ACK and apply before future resume', () => {
  const f=fixture(),c=f.connect(),one=f.message('One'),two=f.message('Two');f.apply(c,[one]);const g=f.group([c]);f.start(g);const a=f.manager.snapshot().attempts[0];
  const channel=f.manager.snapshot().channels[0];f.manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:[{messageId:two.id}]});
  assert.throws(()=>f.prepared(c,a),{code:'EXECUTION_STOPPED'});const stop=f.manager.commands(c.instanceId).findLast(cmd=>cmd.type==='CONTROL');
  f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:stop.id,status:'applied',executionBlocked:true,attemptId:a.id},c.instanceId);
  const snap=f.manager.snapshot();assert.equal(snap.attempts[0].status,'cancelled');assert.equal(snap.channels[0].playlist[0].messageId,two.id);assert.equal(snap.groups[0].status,'paused');
  assert.throws(()=>f.manager.execute('group.resume',{id:g.id}),{code:'CONFIG_PENDING'});f.manager.close();
});

test('a confirmed result cannot arrive before a commit permit exists', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];
  assert.throws(()=>f.result(c,a),{code:'PERMIT_REQUIRED'});assert.equal(f.manager.snapshot().groups[0].cursor,0);f.manager.close();
});

test('two channel connections cannot reuse a tab while an unresolved attempt owns it', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
  assert.throws(()=>f.manager.bridge({type:'OBSERVATION',sessionId:c.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'other',guildId:'guild',channelId:'different',tabId:1,verified:true}]},c.instanceId),{code:'TAB_BUSY'});
  assert.equal(f.manager.snapshot().channels.length,1);f.manager.close();
});

test('late received ACK cannot regress a command applied state and wrong instance cannot spoof outcome', () => {
  const f=fixture(),c=f.connect(),other=f.connect('other','different');f.apply(c,[f.message()]);const cfg=f.manager.commands(c.instanceId,{pendingOnly:false}).find(cmd=>cmd.type==='CONFIG_SYNC');
  f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:cfg.id,status:'received'},c.instanceId);assert.equal(f.manager.commands(c.instanceId,{pendingOnly:false}).find(cmd=>cmd.id===cfg.id).status,'applied');
  f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];assert.throws(()=>f.result(other,a),{code:'INSTANCE_MISMATCH'});f.manager.close();
});

test('notification settings validate typed values and stable recovery closes one incident after 30 seconds', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.manager.execute('group.start',{id:g.id});
  f.manager.execute('settings.update',{notificationsEnabled:true,notificationTypes:['connection_lost'],cooldownMs:300000,notifyRecovery:true,quietHours:{enabled:true,start:'22:00',end:'08:00'}});
  assert.equal(f.manager.snapshot().settings.quietHours.end,'08:00');assert.throws(()=>f.manager.execute('settings.update',{quietHours:{enabled:true,start:'24:00',end:'bad'}}),{code:'VALIDATION'});
  f.manager.bridge({type:'DISCONNECT',sessionId:c.sessionId},c.instanceId);assert.equal(f.manager.snapshot().incidents[0].status,'open');
  f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId},c.instanceId);
  for(let n=0;n<2;n++){f.advance(10000);f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId},c.instanceId);f.manager.tick();}
  assert.equal(f.manager.snapshot().incidents[0].status,'open');
  f.advance(10000);f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId},c.instanceId);f.manager.tick();assert.equal(f.manager.snapshot().incidents[0].status,'resolved');f.manager.close();
});

test('stop can complete after reconnect replaces superseded control commands', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.manager.execute('group.start',{id:g.id});f.manager.execute('group.stop',{id:g.id});
  const fresh=f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:c.instanceId});const cmd=f.manager.commands(c.instanceId).find(cmd=>cmd.type==='CONTROL');
  f.manager.bridge({type:'ACK',sessionId:fresh.sessionId,commandId:cmd.id,status:'applied'},c.instanceId);assert.equal(f.manager.snapshot().groups[0].status,'stopped');f.manager.close();
});

test('minimum group interval and account interval both hold even when wall clock moves within tolerance', () => {
  const f=fixture(),cs=['A','B'].map(a=>f.connect(a));cs.forEach(c=>f.apply(c,[f.message(c.channel.accountId)]));const g=f.group(cs,5000);f.start(g);let a=f.manager.snapshot().attempts[0];f.prepared(cs[0],a);f.result(cs[0],a);
  f.advance(4000);f.jumpWall(1000);f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);
  f.advance(1000);f.manager.tick();a=f.manager.snapshot().attempts.find(a=>a.status==='preparing');assert.equal(a.accountId,'B');f.prepared(cs[1],a);f.result(cs[1],a);
  f.advance(5000);f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,2);assert.equal(f.manager.snapshot().groups[0].waitReason,'account_interval');f.manager.close();
});

test('commit permission fails closed after event-loop stall even before periodic tick runs', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];f.advance(16000);
  assert.throws(()=>f.prepared(c,a),{code:'CLOCK_UNSAFE'});assert.equal(f.manager.commands(c.instanceId).some(c=>c.type==='COMMIT_PERMIT'),false);f.manager.close();
});

test('increased observed slowmode extends account wait after a confirmed post', () => {
  const f=fixture(),c=f.connect();f.manager.execute('channel.update',{id:c.channel.id,expectedVersion:1,intervalMs:0});f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);const a=f.manager.snapshot().attempts[0];f.prepared(c,a);f.result(c,a);
  f.manager.bridge({type:'OBSERVATION',sessionId:c.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:c.channel.accountId,guildId:'guild',channelId:'channel',name:'Channel',tabId:1,verified:true,slowmodeMs:60000}]},c.instanceId);
  f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);f.manager.close();
});

test('reconciled uncertain result leaves no permit or lock owned by the paused group', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);const a=f.manager.snapshot().attempts[0];f.prepared(c,a);f.result(c,a,'unknown');f.result(c,a);
  const second=f.group([c]);assert.doesNotThrow(()=>f.manager.execute('group.start',{id:second.id}));f.manager.close();
});

test('retention removes completed detail but preserves unknown attempts, pending commands and replay tombstones', () => {
  const f=fixture(),c=f.connect();f.manager.execute('channel.update',{id:c.channel.id,expectedVersion:1,intervalMs:0});f.apply(c,[f.message()]);f.start(f.group([c]));const done=f.manager.snapshot().attempts[0];f.prepared(c,done);f.result(c,done);f.manager.tick();const pending=f.manager.snapshot().attempts.find(a=>a.status==='preparing');f.prepared(c,pending);f.result(c,pending,'unknown');
  f.advance(91*86400000);f.manager.execute('maintenance.prune');
  assert.equal(f.manager.snapshot().attempts.length,1);assert.equal(f.manager.snapshot().attempts[0].id,pending.id);assert.ok(f.manager.commands(c.instanceId).some(cmd=>cmd.type==='COMMIT_PERMIT'));
  assert.doesNotThrow(()=>f.result(c,done));assert.equal(f.manager.analytics().partialRecords,true);assert.ok(f.manager.events({attemptId:pending.id}).length>0);f.manager.close();
});

test('analytics waiting intervals clip to the requested period with one primary reason per group', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c],60000));const a=f.manager.snapshot().attempts[0];f.prepared(c,a);f.result(c,a);f.manager.tick();const from=1_800_000_000_000;
  f.advance(10000);f.manager.tick();const stats=f.manager.analytics({from:from+2000,to:from+8000});
  assert.equal(stats.waitReasons.find(r=>r.reason==='group_interval').durationMs,6000);assert.equal(stats.connectionTimeline[0].status,'connected');f.manager.close();
});

test('legacy imports are idempotent, preserve B position, and bind only a matching observed account and channel', () => {
  const f=fixture(),backup={format:'dico-settings',version:1,createdAt:'2026-10-30T00:00:00Z',channels:[{name:'Previous',messages:['First','Second'],intervalSeconds:300,ownUserId:'111',nextIndex:1,url:'https://discord.com/channels/222/333',coordinationRequired:true,coordination:{token:'never-copy'}}]};
  const first=f.manager.execute('legacy.import',{backup});f.manager.execute('legacy.import',{backup});assert.equal(first.importedChannels,1);assert.equal(f.manager.snapshot().messages.length,2);assert.equal(f.manager.snapshot().channels[0].playlistIndex,1);assert.equal(f.manager.snapshot().groups[0].status,'stopped');assert.equal(JSON.stringify(f.manager.snapshot()).includes('never-copy'),false);
  const connection=f.manager.bridge({type:'HELLO',protocolVersion:1});f.manager.bridge({type:'OBSERVATION',sessionId:connection.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'111',guildId:'222',channelId:'333',name:'Current',tabId:10,verified:true}]},connection.instanceId);
  const snap=f.manager.snapshot();assert.equal(snap.channels.length,1);assert.equal(snap.channels[0].instanceId,connection.instanceId);assert.equal(snap.channels[0].playlistIndex,1);assert.equal(snap.channels[0].appliedVersion,0);f.manager.close();
});

test('legacy import is atomic and forbidden during execution; empty legacy drafts are not invented', () => {
  const f=fixture();const backup={format:'dico-settings',version:1,channels:[{name:'Empty',messages:['',''],intervalSeconds:300,ownUserId:'',nextIndex:0,url:null}]};
  f.manager.execute('legacy.import',{backup});assert.equal(f.manager.snapshot().messages.length,0);assert.equal(f.manager.snapshot().channels.length,0);
  const invalid=structuredClone(backup);invalid.channels.push({name:'Unsafe',messages:['@everyone','B'],intervalSeconds:300,ownUserId:'',nextIndex:0,url:null});assert.throws(()=>f.manager.execute('legacy.import',{backup:invalid}),{code:'VALIDATION'});
  const c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));assert.throws(()=>f.manager.execute('legacy.import',{backup}),{code:'ATTEMPT_UNRESOLVED'});f.manager.close();
});

test('SQLite write failure rolls back in-memory state, emits no false event and blocks future mutations', async () => {
  const { DatabaseSync }=await import('node:sqlite');const dir=mkdtempSync(join(tmpdir(),'dico-storage-fail-')),databasePath=join(dir,'state.sqlite');
  try {const f=fixture({databasePath}),events=[];f.manager.subscribe(e=>events.push(e));const outside=new DatabaseSync(databasePath);outside.exec('DROP TABLE central_state');outside.close();
    assert.throws(()=>f.message('Must not appear'),{code:'STORAGE_FAILURE'});assert.equal(f.manager.snapshot().messages.length,0);assert.equal(f.manager.snapshot().service.status,'storage_failure');assert.equal(events.length,0);assert.throws(()=>f.message('Still blocked'),{code:'STORAGE_FAILURE'});f.manager.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('heartbeat reconciles only requested final attempt IDs owned by the same instance', () => {
  const f=fixture(),c=f.connect(),other=f.connect('Other','different');f.apply(c,[f.message()]);f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];f.prepared(c,a);f.result(c,a,'unknown');f.manager.execute('attempt.resolve',{id:a.id,outcome:'confirmed',messageId:'observed-post'});
  const response=f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId,knownAttemptIds:[a.id]},c.instanceId);assert.deepEqual(response.terminalAttempts,[{attemptId:a.id,status:'confirmed',messageId:'observed-post'}]);assert.equal(JSON.stringify(response.terminalAttempts).includes(c.sessionId),false);
  const stranger=f.manager.bridge({type:'HEARTBEAT',sessionId:other.sessionId,knownAttemptIds:[a.id]},other.instanceId);assert.deepEqual(stranger.terminalAttempts,[]);f.manager.close();
});

test('preparation duration is not mislabeled as eligible-only central permit latency', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];f.advance(2000);f.prepared(c,a);const permitted=f.manager.snapshot().attempts[0];
  assert.equal(permitted.prepareDurationMs,2000);assert.equal(permitted.permitDelayMs,undefined);f.manager.close();
});

test('disconnect and reconnection never restart an idle running group without explicit resume', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.manager.execute('group.start',{id:g.id});
  f.manager.bridge({type:'DISCONNECT',sessionId:c.sessionId},c.instanceId);assert.equal(f.manager.snapshot().groups[0].status,'resume_required');
  const fresh=f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:c.instanceId});f.manager.bridge({type:'OBSERVATION',sessionId:fresh.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:c.channel.accountId,guildId:'guild',channelId:'channel',tabId:1,verified:true}]},c.instanceId);
  const cfg=f.manager.commands(c.instanceId).find(c=>c.type==='CONFIG_SYNC');f.manager.bridge({type:'ACK',sessionId:fresh.sessionId,commandId:cfg.id,status:'applied'},c.instanceId);f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,0);
  f.manager.execute('group.resume',{id:g.id});f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);f.manager.close();
});

test('unexpected HELLO session replacement fences idle execution even without prior disconnect report', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.manager.execute('group.start',{id:g.id});f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:c.instanceId});
  assert.equal(f.manager.snapshot().groups[0].status,'resume_required');f.manager.close();
});

test('each explicit run has a stable command identity and resuming creates a different identity', () => {
  const f=fixture(),c=f.connect();f.manager.execute('channel.update',{id:c.channel.id,expectedVersion:1,intervalMs:0});f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);const a=f.manager.snapshot().attempts[0];
  const prepare=f.manager.commands(c.instanceId).find(c=>c.type==='PREPARE');assert.ok(prepare.payload.runId);assert.equal(prepare.payload.runId,f.manager.snapshot().groups[0].runId);f.prepared(c,a);
  const permit=f.manager.commands(c.instanceId).find(c=>c.type==='COMMIT_PERMIT');assert.equal(permit.payload.runId,prepare.payload.runId);f.manager.execute('group.pause',{id:g.id});const control=f.manager.commands(c.instanceId).find(c=>c.type==='CONTROL');assert.equal(control.payload.runId,prepare.payload.runId);
  f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:control.id,status:'applied'},c.instanceId);f.result(c,a);f.manager.execute('group.resume',{id:g.id});f.manager.tick();const second=f.manager.commands(c.instanceId).find(c=>c.type==='PREPARE');assert.notEqual(second.payload.runId,prepare.payload.runId);f.manager.close();
});

test('last-moment Enter authorization is exact and a clock gap revokes pending permit delivery', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];
  const authorize=overrides=>f.manager.bridge({type:'AUTHORIZE_ENTER',sessionId:c.sessionId,attemptId:a.id,runId:a.runId,configVersion:a.configVersion,...overrides},c.instanceId);
  assert.equal(authorize().allowed,false);f.prepared(c,a);assert.equal(authorize().allowed,true);assert.equal(authorize({runId:'old-run'}).allowed,false);assert.equal(authorize({configVersion:a.configVersion+1}).allowed,false);
  f.advance(16000);assert.equal(authorize().allowed,false);const snap=f.manager.snapshot();assert.equal(snap.service.status,'resume_required');assert.equal(snap.attempts[0].status,'unknown');
  assert.equal(f.manager.commands(c.instanceId).some(c=>c.type==='COMMIT_PERMIT'),false);const stop=f.manager.commands(c.instanceId).find(c=>c.type==='CONTROL');assert.equal(stop.payload.runId,a.runId);
  f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:stop.id,status:'applied',executionBlocked:true,attemptId:a.id},c.instanceId);assert.equal(f.manager.snapshot().attempts[0].status,'unknown');assert.equal(authorize().allowed,false);f.manager.close();
});

test('periodic sleep detection sends a run-bound control before any later Enter authorization', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];f.prepared(c,a);f.advance(16000);f.manager.tick();
  assert.ok(f.manager.commands(c.instanceId).some(cmd=>cmd.type==='CONTROL'&&cmd.payload.runId===a.runId));
  assert.equal(f.manager.bridge({type:'AUTHORIZE_ENTER',sessionId:c.sessionId,attemptId:a.id,runId:a.runId,configVersion:a.configVersion},c.instanceId).allowed,false);f.manager.close();
});

test('SQLite database and live WAL/SHM files are private even under a permissive umask', async t => {
  if(process.platform==='win32'){t.skip('POSIX permissions are not Windows ACLs');return;}
  const {statSync,chmodSync}=await import('node:fs'),dir=mkdtempSync(join(tmpdir(),'dico-private-')),databasePath=join(dir,'state.sqlite');let manager;const previous=process.umask(0o022);
  try {chmodSync(dir,0o755);manager=createCentralManager({databasePath});manager.execute('message.create',{name:'Private',body:'Private message'});
    assert.equal(statSync(dir).mode&0o777,0o700);for(const path of [databasePath,databasePath+'-wal',databasePath+'-shm'])assert.equal(statSync(path).mode&0o777,0o600,path);
  }finally{process.umask(previous);manager?.close();rmSync(dir,{recursive:true,force:true});}
});

test('모두 실행은 준비된 그룹을 함께 시작하고 실행 중 그룹의 runId를 유지한다',()=>{
 const f=fixture();try{
 const a=f.connect('a','one'),b=f.connect('b','two'),m=f.message();f.apply(a,[m]);f.apply(b,[m]);
 const ga=f.group([a]),gb=f.group([b]);f.manager.execute('group.start',{id:ga.id});
 const runId=f.manager.snapshot().groups.find(g=>g.id===ga.id).runId;
 const result=f.manager.execute('service.startAll');assert.equal(result.started,1);assert.equal(result.alreadyRunning,1);
 assert.ok(f.manager.snapshot().groups.every(g=>g.status==='running'));
 assert.equal(f.manager.snapshot().groups.find(g=>g.id===ga.id).runId,runId);
 }finally{f.manager.close();}
});
test('모두 실행은 준비 안 된 그룹이 있으면 전체 변경을 되돌린다',()=>{
 const f=fixture();try{
 const a=f.connect('a','one'),b=f.connect('b','two'),m=f.message();f.apply(a,[m]);f.group([a]);f.group([b]);
 f.manager.execute('service.stopAll'); // groups already stopped; no control ACK needed
 const before=f.manager.snapshot();assert.throws(()=>f.manager.execute('service.startAll'),{code:'PLAYLIST_EMPTY'});
 assert.deepEqual(f.manager.snapshot(),before);
 }finally{f.manager.close();}
});
test('설정 초기화는 명시 확인과 최신 버전이 필요하고 실행 중에는 거부한다',()=>{
 const f=fixture();try{
 const c=f.connect(),m=f.message();f.apply(c,[m]);const g=f.group([c]);
 assert.throws(()=>f.manager.execute('settings.reset',{}),{code:'RESET_CONFIRMATION_REQUIRED'});
 const version=f.manager.snapshot().configurationToken;
 assert.throws(()=>f.manager.execute('settings.reset',{confirmation:'RESET_ALL_SETTINGS',expectedConfiguration:'stale'}),{code:'VERSION_CONFLICT'});
 f.manager.execute('group.start',{id:g.id});
 assert.throws(()=>f.manager.execute('settings.reset',{confirmation:'RESET_ALL_SETTINGS',expectedConfiguration:f.manager.snapshot().configurationToken}),{code:'GROUP_RUNNING'});
 }finally{f.manager.close();}
});
test('초기화는 구성을 비우고 기본값으로 복원하며 이전 확장 세션을 차단한다',()=>{
 const f=fixture();try{
 const c=f.connect(),m=f.message();f.apply(c,[m]);f.group([c]);f.manager.execute('settings.update',{notificationsEnabled:true,retentionDays:30});
 f.manager.execute('settings.reset',{confirmation:'RESET_ALL_SETTINGS',expectedConfiguration:f.manager.snapshot().configurationToken});
 const s=f.manager.snapshot();for(const list of ['messages','channels','groups','instances'])assert.equal(s[list].length,0);
 assert.equal(s.settings.notificationsEnabled,false);assert.equal(s.settings.retentionDays,90);assert.equal(s.service.status,'stopped');
 assert.throws(()=>f.manager.bridge({type:'OBSERVATION',sessionId:c.sessionId,channels:[]},c.instanceId),{code:'NOT_FOUND'});
 assert.ok(f.manager.events().some(e=>e.type==='settings.reset'));assert.doesNotThrow(()=>f.manager.analytics());
 }finally{f.manager.close();}
});

test('초기화 확인은 유휴 tick에 만료되지 않지만 구성 변경 시 거부한다',()=>{
 const f=fixture();try{
 f.message();const token=f.manager.snapshot().configurationToken;f.advance(1000);f.manager.tick();
 assert.equal(f.manager.snapshot().configurationToken,token);
 f.message('New message');assert.throws(()=>f.manager.execute('settings.reset',{confirmation:'RESET_ALL_SETTINGS',expectedConfiguration:token}),{code:'VERSION_CONFLICT'});
 const current=f.manager.snapshot().configurationToken;f.advance(1000);f.manager.tick();
 assert.equal(f.manager.execute('settings.reset',{confirmation:'RESET_ALL_SETTINGS',expectedConfiguration:current}).reset,true);
 }finally{f.manager.close();}
});

test('초기화는 미확인 시도를 지우지 않고 완료 기록은 유지한다',()=>{
 const f=fixture();try{
 const c=f.connect(),m=f.message();f.apply(c,[m]);const g=f.group([c]);f.start(g);
 const a=f.manager.snapshot().attempts[0];
 assert.throws(()=>f.manager.execute('settings.reset',{confirmation:'RESET_ALL_SETTINGS',expectedConfiguration:f.manager.snapshot().configurationToken}),{code:'ATTEMPT_UNRESOLVED'});
 assert.equal(f.manager.snapshot().attempts[0].id,a.id);
 f.prepared(c,a);f.result(c,a);f.manager.execute('group.stop',{id:g.id});
 for(const command of f.manager.commands(c.instanceId).filter(x=>x.type==='CONTROL'))f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:command.id,status:'applied'},c.instanceId);
 f.manager.execute('settings.reset',{confirmation:'RESET_ALL_SETTINGS',expectedConfiguration:f.manager.snapshot().configurationToken});
 assert.equal(f.manager.snapshot().attempts[0].status,'confirmed');assert.equal(f.manager.snapshot().attempts[0].id,a.id);
 f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);
 assert.ok(f.manager.events().some(x=>x.type==='delivery.confirmed'));
 }finally{f.manager.close();}
});

test('읽은 슬로우 모드에 여유 3초를 자동 적용하고 읽기 누락 시 이전 제한을 유지한다',()=>{
 const f=fixture();try{
 const c=f.connect();f.manager.execute('channel.update',{id:c.channel.id,expectedVersion:1,intervalMs:0});f.apply(c,[f.message()]);const g=f.group([c]);
 const observed={accountId:c.channel.accountId,guildId:'guild',channelId:'channel',name:'Channel',tabId:1,verified:true};
 const report=extra=>f.manager.bridge({type:'OBSERVATION',sessionId:c.sessionId,legacyFrozen:true,legacyPending:false,channels:[{...observed,...extra}]},c.instanceId);
 report({slowmodeMs:60000});assert.equal(f.manager.snapshot().channels[0].effectiveIntervalMs,63000);
 report({});assert.equal(f.manager.snapshot().channels[0].slowmodeMs,60000);
 f.start(g);const a=f.manager.snapshot().attempts[0];f.prepared(c,a);f.result(c,a);
 for(let n=0;n<6;n++){f.advance(10000);f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId},c.instanceId);f.manager.tick();}
 assert.equal(f.manager.snapshot().attempts.length,1);
 f.advance(3000);f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId},c.instanceId);f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,2);
 }finally{f.manager.close();}
});

test('재연결 시 실제 브라우저·확장 버전을 갱신하고 사용자 별칭은 유지한다',()=>{
 const f=fixture();try{
 const first=f.manager.bridge({type:'HELLO',protocolVersion:1,name:'연결된 Chromium',browser:'Chromium',extensionVersion:'0.4.0'});
 f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:first.instanceId,name:'연결된 Brave',browser:'Brave',extensionVersion:'0.4.1'});
 let i=f.manager.snapshot().instances.find(i=>i.id===first.instanceId);assert.equal(i.browser,'Brave');assert.equal(i.name,'연결된 Brave');assert.equal(i.extensionVersion,'0.4.1');
 f.manager.execute('instance.update',{id:i.id,expectedVersion:i.version,name:'업무 계정'});
 f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:i.id,name:'연결된 Chrome',browser:'Chrome',extensionVersion:'0.4.2'});
 i=f.manager.snapshot().instances.find(x=>x.id===i.id);assert.equal(i.browser,'Chrome');assert.equal(i.name,'업무 계정');
 }finally{f.manager.close();}
});

test('multi-browser stop sends an attempt only to its owner and every member can acknowledge',()=>{
 const f=fixture();try{
 const cs=['A','B','C'].map(account=>f.connect(account));cs.forEach(c=>f.apply(c,[f.message(c.channel.accountId)]));
 const g=f.group(cs);f.start(g);const a=f.manager.snapshot().attempts[0];
 f.manager.execute('group.stop',{id:g.id});
 for(const c of [cs[1],cs[2],cs[0]]){
  const cmd=f.manager.commands(c.instanceId).findLast(x=>x.type==='CONTROL');
  assert.equal(cmd.payload.attemptId,c.instanceId===a.instanceId?a.id:null);
  f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:cmd.id,status:'applied',executionBlocked:true,...(cmd.payload.attemptId?{attemptId:cmd.payload.attemptId}:{})},c.instanceId);
 }
 assert.equal(f.manager.snapshot().groups[0].status,'stopped');assert.equal(f.manager.snapshot().attempts[0].status,'cancelled');
 f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);
 }finally{f.manager.close();}
});

test('reconnected non-owner receives a stop without another browser attempt',()=>{
 const f=fixture();try{
 const cs=['A','B'].map(account=>f.connect(account));cs.forEach(c=>f.apply(c,[f.message(c.channel.accountId)]));
 const g=f.group(cs);f.start(g);f.manager.execute('group.stop',{id:g.id});
 const hello=f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:cs[1].instanceId});
 const cmd=f.manager.commands(cs[1].instanceId).findLast(x=>x.type==='CONTROL');assert.equal(cmd.payload.attemptId,null);
 f.manager.bridge({type:'ACK',sessionId:hello.sessionId,commandId:cmd.id,status:'applied',executionBlocked:true},cs[1].instanceId);
 const owner=f.manager.commands(cs[0].instanceId).findLast(x=>x.type==='CONTROL');
 f.manager.bridge({type:'ACK',sessionId:cs[0].sessionId,commandId:owner.id,status:'applied',executionBlocked:true,attemptId:owner.payload.attemptId},cs[0].instanceId);
 assert.equal(f.manager.snapshot().groups[0].status,'stopped');
 }finally{f.manager.close();}
});

test('unknown without any permit becomes not_sent only after owner confirms execution blocked',()=>{
 const f=fixture();try{
 const c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);const a=f.manager.snapshot().attempts[0];
 f.result(c,a,'unknown');f.manager.execute('group.stop',{id:g.id});const cmd=f.manager.commands(c.instanceId).findLast(x=>x.type==='CONTROL');
 f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:cmd.id,status:'applied'},c.instanceId);
 assert.equal(f.manager.snapshot().attempts[0].status,'unknown');
 f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:cmd.id,status:'applied',executionBlocked:true,attemptId:a.id},c.instanceId);
 assert.equal(f.manager.snapshot().attempts[0].status,'not_sent');assert.equal(f.manager.snapshot().attempts[0].manual,false);
 assert.equal(f.manager.snapshot().groups[0].status,'stopped');f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);
 }finally{f.manager.close();}
});

test('unknown with an issued permit remains unknown despite a blocking control acknowledgment',()=>{
 const f=fixture();try{
 const c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);const a=f.manager.snapshot().attempts[0];
 f.prepared(c,a);f.result(c,a,'unknown');f.manager.execute('group.stop',{id:g.id});const cmd=f.manager.commands(c.instanceId).findLast(x=>x.type==='CONTROL');
 f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:cmd.id,status:'applied',executionBlocked:true,attemptId:a.id},c.instanceId);
 assert.equal(f.manager.snapshot().attempts[0].status,'unknown');assert.equal(f.manager.snapshot().attempts[0].executionBlocked,true);
 assert.equal(f.manager.snapshot().groups[0].status,'stop_pending');f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);
 }finally{f.manager.close();}
});

test('bulk manual not_sent validates every selected unknown before committing and never restarts groups',()=>{
 const f=fixture();try{
 const pending=['A','B'].map(account=>{
  const c=f.connect(account,account);f.apply(c,[f.message(account)]);const g=f.group([c]);f.start(g);
  const a=f.manager.snapshot().attempts.find(x=>x.groupId===g.id);f.prepared(c,a);f.result(c,a,'unknown');f.manager.execute('group.stop',{id:g.id});
  return{c,g,a,cmd:f.manager.commands(c.instanceId).findLast(x=>x.type==='CONTROL')};
 });
 const block=({c,a,cmd})=>f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:cmd.id,status:'applied',executionBlocked:true,attemptId:a.id},c.instanceId);
 block(pending[0]);const ids=pending.map(x=>x.a.id),payload={ids,outcome:'not_sent',confirmation:'CONFIRM_NOT_SENT'};
 const before=f.manager.snapshot();assert.throws(()=>f.manager.execute('attempt.resolveMany',payload),{code:'EXECUTION_UNCERTAIN'});assert.deepEqual(f.manager.snapshot(),before);
 assert.throws(()=>f.manager.execute('attempt.resolveMany',{...payload,ids:[ids[0],ids[0]]}),{code:'VALIDATION'});
 assert.throws(()=>f.manager.execute('attempt.resolveMany',{...payload,confirmation:undefined}),{code:'VALIDATION'});
 block(pending[1]);assert.deepEqual(f.manager.execute('attempt.resolveMany',payload),{resolved:2,ids});
 assert.ok(f.manager.snapshot().attempts.every(x=>x.status==='not_sent'&&x.manual));assert.ok(f.manager.snapshot().groups.every(x=>x.status==='stopped'));
 f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,2);
 assert.throws(()=>f.manager.execute('attempt.resolveMany',payload),{code:'ATTEMPT_STATE'});
 }finally{f.manager.close();}
});

test('rejected PREPARE keeps a bounded diagnostic code without recording raw errors',()=>{
 for(const rejectionCode of ['DRAFT_MISMATCH','private body: hello', 'A'.repeat(65)]){
  const f=fixture();try{
   const c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const cmd=f.manager.commands(c.instanceId).find(x=>x.type==='PREPARE');
   f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:cmd.id,status:'rejected',rejectionCode,error:'private raw failure'},c.instanceId);
   const valid=rejectionCode==='DRAFT_MISMATCH',s=f.manager.snapshot();
   assert.equal(s.attempts[0].reasonCode,valid?'DRAFT_MISMATCH':'command_rejected');
   assert.equal(s.commands.find(x=>x.id===cmd.id).rejectionCode,valid?'DRAFT_MISMATCH':undefined);
   assert.equal(f.manager.events().findLast(x=>x.type==='command.ack').rejectionCode,valid?'DRAFT_MISMATCH':undefined);
   assert.equal(JSON.stringify(s).includes('private raw failure'),false);assert.equal(JSON.stringify(s).includes('private body'),false);
  }finally{f.manager.close();}
 }
});
