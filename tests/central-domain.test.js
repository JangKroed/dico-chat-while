import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCentralManager } from '../central/core/index.js';
import { CentralStore } from '../central/core/store.js';

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
  cs.forEach(c => { f.manager.execute('channel.update', { id:c.channel.id, expectedVersion:1, intervalMs:3000 }); f.apply(c, c === cs[0] ? [one, two] : [one]); }); const g = f.group(cs); f.start(g);
  for (let i = 0; i < 300; i++) {
    const a = f.manager.snapshot().attempts.find(a => a.status === 'preparing'); const c = cs[i % 3];
    assert.equal(a.accountId, ['A','B','C'][i % 3]);
    assert.equal(f.manager.commands(c.instanceId).find(cmd=>cmd.type==='PREPARE').payload.body, i % 3 === 0 && Math.floor(i / 3) % 2 ? 'Two' : 'One');
    f.prepared(c, a); f.prepared(c, a); f.result(c, a); f.result(c, a); if(i%3===2){f.advance(3000);for(const peer of cs)f.manager.bridge({type:'HEARTBEAT',sessionId:peer.sessionId},peer.instanceId);} f.manager.tick();
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

test('restart automatically readies the service while blocking automatic group resume and preserving active permits', () => {
  const dir=mkdtempSync(join(tmpdir(),'dico-core-')),databasePath=join(dir,'state.sqlite');
  try {const f=fixture({databasePath}),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);const a=f.manager.snapshot().attempts[0];f.prepared(c,a);f.manager.close();
    const reopened=createCentralManager({databasePath});reopened.tick();assert.equal(reopened.snapshot().attempts.length,1);assert.equal(reopened.snapshot().attempts[0].status,'unknown');
    assert.equal(reopened.snapshot().service.status,'ready');assert.equal(reopened.snapshot().channels[0].verified,false);reopened.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('referenced revisions cannot be deleted and saved library edits sync before the next send', () => {
  const f=fixture(),c=f.connect(),m=f.message('Fixed');f.apply(c,[m]);f.manager.execute('message.update',{id:m.id,expectedVersion:1,body:'New'});
  assert.throws(()=>f.manager.execute('message.delete',{id:m.id,expectedVersion:2}),{code:'MESSAGE_IN_USE'});
  const g=f.group([c]);assert.throws(()=>f.start(g),{code:'CONFIG_PENDING'});
  const config=f.manager.commands(c.instanceId).findLast(cmd=>cmd.type==='CONFIG_SYNC');
  f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:config.id,status:'applied'},c.instanceId);
  f.start(g);assert.equal(f.manager.commands(c.instanceId).find(cmd=>cmd.type==='PREPARE').payload.body,'New');f.manager.close();
});

test('wall-clock jump and loop stall require group resume only, never catch-up permits', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c],60000);f.start(g);let a=f.manager.snapshot().attempts[0];f.prepared(c,a);f.result(c,a);
  f.jumpWall(3600000);f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);assert.equal(f.manager.snapshot().service.status,'ready');f.manager.close();
  const z=fixture(),d=z.connect();z.apply(d,[z.message()]);z.start(z.group([d]));z.advance(20000);z.manager.tick();assert.equal(z.manager.snapshot().service.status,'ready');z.manager.close();
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
  const f=fixture(),cs=['A','B'].map(a=>f.connect(a));cs.forEach(c=>{f.manager.execute('channel.update',{id:c.channel.id,expectedVersion:1,intervalMs:60000});f.apply(c,[f.message(c.channel.accountId)]);});const g=f.group(cs,5000);f.start(g);let a=f.manager.snapshot().attempts[0];f.prepared(cs[0],a);f.result(cs[0],a);
  f.advance(4000);f.jumpWall(1000);f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);
  f.advance(1000);f.manager.tick();a=f.manager.snapshot().attempts.find(a=>a.status==='preparing');assert.equal(a.accountId,'B');f.prepared(cs[1],a);f.result(cs[1],a);
  f.advance(5000);f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,2);assert.equal(f.manager.snapshot().groups[0].waitReason,'account_interval');f.manager.close();
});

test('commit permission fails closed after event-loop stall even before periodic tick runs', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];f.advance(16000);
  assert.throws(()=>f.prepared(c,a),{code:'CLOCK_UNSAFE'});assert.equal(f.manager.commands(c.instanceId).some(c=>c.type==='COMMIT_PERMIT'),false);f.manager.close();
});

test('increased observed slowmode extends account wait after a confirmed post', () => {
  const f=fixture(),c=f.connect();f.manager.execute('channel.update',{id:c.channel.id,expectedVersion:1,intervalMs:3000});f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);const a=f.manager.snapshot().attempts[0];f.prepared(c,a);f.result(c,a);
  f.manager.bridge({type:'OBSERVATION',sessionId:c.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:c.channel.accountId,guildId:'guild',channelId:'channel',name:'Channel',tabId:1,verified:true,slowmodeMs:60000}]},c.instanceId);
  const synced=f.manager.commands(c.instanceId).findLast(cmd=>cmd.type==='CONFIG_SYNC');f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:synced.id,status:'applied'},c.instanceId);
  f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);assert.equal(f.manager.snapshot().groups[0].waitReason,'account_interval');f.manager.close();
});

test('reconciled uncertain result leaves no permit or lock owned by the paused group', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);const a=f.manager.snapshot().attempts[0];f.prepared(c,a);f.result(c,a,'unknown');f.result(c,a);
  const second=f.group([c]);assert.doesNotThrow(()=>f.manager.execute('group.start',{id:second.id}));f.manager.close();
});

test('retention removes completed detail but preserves unknown attempts, pending commands and replay tombstones', () => {
  const f=fixture(),c=f.connect();f.manager.execute('channel.update',{id:c.channel.id,expectedVersion:1,intervalMs:3000});f.apply(c,[f.message()]);f.start(f.group([c]));const done=f.manager.snapshot().attempts[0];f.prepared(c,done);f.result(c,done);f.advance(3000);f.manager.tick();const pending=f.manager.snapshot().attempts.find(a=>a.status==='preparing');f.prepared(c,pending);f.result(c,pending,'unknown');
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
  const oldAccount=f.manager.snapshot().accounts[0];f.manager.execute('account.update',{id:oldAccount.id,expectedVersion:1,name:'Imported identity'});
  const connection=f.manager.bridge({type:'HELLO',protocolVersion:1});f.manager.bridge({type:'OBSERVATION',sessionId:connection.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'111',guildId:'222',channelId:'333',name:'Current',tabId:10,verified:true}]},connection.instanceId);
  const snap=f.manager.snapshot();assert.equal(snap.accounts.length,1);assert.equal(snap.accounts[0].instanceId,connection.instanceId);assert.equal(snap.accounts[0].name,'Imported identity');assert.equal(snap.channels.length,1);assert.equal(snap.channels[0].instanceId,connection.instanceId);assert.equal(snap.channels[0].playlistIndex,1);assert.equal(snap.channels[0].appliedVersion,0);f.manager.close();
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
  const response=f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId,knownAttemptIds:[a.id]},c.instanceId);assert.deepEqual(response.terminalAttempts,[{attemptId:a.id,status:'confirmed',messageId:'observed-post',confirmationBasis:'message_observed'}]);assert.equal(JSON.stringify(response.terminalAttempts).includes(c.sessionId),false);
  const stranger=f.manager.bridge({type:'HEARTBEAT',sessionId:other.sessionId,knownAttemptIds:[a.id]},other.instanceId);assert.deepEqual(stranger.terminalAttempts,[]);f.manager.close();
});

test('preparation duration is not mislabeled as eligible-only central permit latency', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];f.advance(2000);f.prepared(c,a);const permitted=f.manager.snapshot().attempts[0];
  assert.equal(permitted.prepareDurationMs,2000);assert.equal(permitted.permitDelayMs,undefined);f.manager.close();
});

test('disconnect and reconnection require current control ACK before automatic resume', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.manager.execute('group.start',{id:g.id});
  f.manager.bridge({type:'DISCONNECT',sessionId:c.sessionId},c.instanceId);assert.equal(f.manager.snapshot().groups[0].status,'pause_pending');
  const fresh=f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:c.instanceId});f.manager.bridge({type:'OBSERVATION',sessionId:fresh.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:c.channel.accountId,guildId:'guild',channelId:'channel',tabId:1,verified:true}]},c.instanceId);
  const cfg=f.manager.commands(c.instanceId).find(c=>c.type==='CONFIG_SYNC');f.manager.bridge({type:'ACK',sessionId:fresh.sessionId,commandId:cfg.id,status:'applied'},c.instanceId);f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,0);
  const control=f.manager.commands(c.instanceId).find(c=>c.type==='CONTROL');f.manager.bridge({type:'ACK',sessionId:fresh.sessionId,commandId:control.id,status:'applied'},c.instanceId);
  f.advance(3000);f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);f.manager.close();
});

test('unexpected HELLO session replacement fences idle execution even without prior disconnect report', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.manager.execute('group.start',{id:g.id});f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:c.instanceId});
  assert.equal(f.manager.snapshot().groups[0].status,'pause_pending');assert.ok(f.manager.snapshot().groups[0].autoResume);f.manager.close();
});

test('each explicit run has a stable command identity and resuming creates a different identity', () => {
  const f=fixture(),c=f.connect();f.manager.execute('channel.update',{id:c.channel.id,expectedVersion:1,intervalMs:3000});f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);const a=f.manager.snapshot().attempts[0];
  const prepare=f.manager.commands(c.instanceId).find(c=>c.type==='PREPARE');assert.ok(prepare.payload.runId);assert.equal(prepare.payload.runId,f.manager.snapshot().groups[0].runId);f.prepared(c,a);
  const permit=f.manager.commands(c.instanceId).find(c=>c.type==='COMMIT_PERMIT');assert.equal(permit.payload.runId,prepare.payload.runId);f.manager.execute('group.pause',{id:g.id});const control=f.manager.commands(c.instanceId).find(c=>c.type==='CONTROL');assert.equal(control.payload.runId,prepare.payload.runId);
  f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:control.id,status:'applied'},c.instanceId);f.result(c,a);f.advance(3000);f.manager.execute('group.resume',{id:g.id});f.manager.tick();const second=f.manager.commands(c.instanceId).find(c=>c.type==='PREPARE');assert.notEqual(second.payload.runId,prepare.payload.runId);f.manager.close();
});

test('last-moment Enter authorization is exact and a clock gap revokes pending permit delivery', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];
  const authorize=overrides=>f.manager.bridge({type:'AUTHORIZE_ENTER',sessionId:c.sessionId,attemptId:a.id,runId:a.runId,configVersion:a.configVersion,...overrides},c.instanceId);
  assert.equal(authorize().allowed,false);f.prepared(c,a);assert.equal(authorize().allowed,true);assert.equal(authorize({runId:'old-run'}).allowed,false);assert.equal(authorize({configVersion:a.configVersion+1}).allowed,false);
  f.advance(16000);assert.equal(authorize().allowed,false);const snap=f.manager.snapshot();assert.equal(snap.service.status,'ready');assert.equal(snap.attempts[0].status,'unknown');
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
 assert.equal(s.settings.notificationsEnabled,false);assert.equal(s.settings.retentionDays,90);assert.equal(s.service.status,'ready');
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
 const c=f.connect();f.manager.execute('channel.update',{id:c.channel.id,expectedVersion:1,intervalMs:3000});f.apply(c,[f.message()]);const g=f.group([c]);
 const observed={accountId:c.channel.accountId,guildId:'guild',channelId:'channel',name:'Channel',tabId:1,verified:true};
 const report=extra=>f.manager.bridge({type:'OBSERVATION',sessionId:c.sessionId,legacyFrozen:true,legacyPending:false,channels:[{...observed,...extra}]},c.instanceId);
 report({slowmodeMs:60000});assert.equal(f.manager.snapshot().channels[0].effectiveIntervalMs,63000);
 report({});assert.equal(f.manager.snapshot().channels[0].slowmodeMs,60000);
 const synced=f.manager.commands(c.instanceId).findLast(cmd=>cmd.type==='CONFIG_SYNC');f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:synced.id,status:'applied'},c.instanceId);
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
 assert.equal(f.manager.snapshot().groups[0].status,'stopped');assert.equal(f.manager.snapshot().groups[0].activeAttemptId,a.id);f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);
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
   assert.equal(s.attempts[0].reasonCode,valid?'DRAFT_MISMATCH':'PREPARE_REJECTED');
   assert.equal(s.commands.find(x=>x.id===cmd.id).rejectionCode,valid?'DRAFT_MISMATCH':undefined);
   assert.equal(f.manager.events().findLast(x=>x.type==='command.ack').rejectionCode,valid?'DRAFT_MISMATCH':undefined);
   assert.equal(JSON.stringify(s).includes('private raw failure'),false);assert.equal(JSON.stringify(s).includes('private body'),false);
  }finally{f.manager.close();}
 }
});

function independentAccount(f, accountId = '111', capabilities = ['open-channel-v1']) {
  const hello=f.manager.bridge({type:'HELLO',protocolVersion:1,capabilities});
  f.manager.bridge({type:'OBSERVATION',sessionId:hello.sessionId,legacyFrozen:true,legacyPending:false,channels:[]},hello.instanceId);
  const result=f.manager.bridge({type:'ACCOUNT_OBSERVATION',sessionId:hello.sessionId,accountId,verified:true},hello.instanceId);
  return {...hello,account:result.account};
}

test('accounts can register without channels and retain a custom name across verification', () => {
  const f=fixture(),c=independentAccount(f);const initial=f.manager.snapshot();
  assert.equal(initial.accounts.length,1);assert.equal(initial.channels.length,0);assert.equal(initial.targets.length,0);
  assert.equal(c.account.verified,true);assert.equal(c.account.connected,true);assert.equal(c.account.sessionId,undefined);
  const updated=f.manager.execute('account.update',{id:c.account.id,expectedVersion:1,name:'Work account'});
  const again=f.manager.bridge({type:'ACCOUNT_OBSERVATION',sessionId:c.sessionId,accountId:'111',verified:true},c.instanceId).account;
  assert.equal(again.id,c.account.id);assert.equal(again.name,'Work account');assert.equal(again.version,updated.version);
  assert.throws(()=>f.manager.execute('account.update',{id:c.account.id,expectedVersion:1,name:'Stale'}),{code:'VERSION_CONFLICT'});
  assert.equal(f.manager.snapshot().commands.length,0);assert.equal(f.manager.snapshot().attempts.length,0);f.manager.close();
});

test('target catalog validates Discord server channel URLs and deduplicates them', () => {
  const f=fixture(),target=f.manager.execute('target.create',{url:'https://discord.com/channels/222/333',name:'Announcements'});
  assert.equal(target.channelId,'333');assert.equal(target.guildId,'222');
  assert.equal(f.manager.execute('target.create',{url:target.url}).id,target.id);
  for(const url of ['http://discord.com/channels/222/333','https://evil.com/channels/222/333','https://discord.com/channels/@me/333','https://discord.com/channels/222/333/444','https://discord.com/channels/222/333?x=1','https://discord.com/channels/222/333#x','https://user@discord.com/channels/222/333','https://discord.com:444/channels/222/333'])assert.throws(()=>f.manager.execute('target.create',{url}),{code:'VALIDATION'});
  assert.equal(f.manager.snapshot().targets.length,1);assert.equal(f.manager.snapshot().channels.length,0);f.manager.close();
});

test('connecting an account to a target only queues one OPEN_CHANNEL until verified binding arrives', () => {
  const f=fixture(),c=independentAccount(f),target=f.manager.execute('target.create',{url:'https://discord.com/channels/222/333'}),input={accountId:c.account.id,targetId:target.id};
  const pending=f.manager.execute('channel.connect',input);assert.equal(pending.status,'pending');
  assert.deepEqual(pending.command.payload,{accountId:'111',guildId:'222',channelId:'333',accountEntityId:c.account.id,targetId:target.id});
  assert.equal(pending.command.type,'OPEN_CHANNEL');assert.equal(f.manager.execute('channel.connect',input).command.id,pending.command.id);
  f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:pending.command.id,status:'received'},c.instanceId);
  assert.equal(f.manager.execute('channel.connect',input).command.id,pending.command.id);
  assert.equal(f.manager.snapshot().channels.length,0);assert.equal(f.manager.snapshot().attempts.length,0);
  f.manager.bridge({type:'OBSERVATION',sessionId:c.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'111',guildId:'222',channelId:'333',tabId:42,verified:true}]},c.instanceId);
  const ready=f.manager.execute('channel.connect',input);assert.equal(ready.status,'connected');assert.equal(ready.channel.channelId,'333');
  assert.equal(f.manager.snapshot().commands.length,1);assert.equal(f.manager.commands(c.instanceId).length,0);assert.equal(f.manager.snapshot().attempts.length,0);f.manager.close();
});

test('account connection rejects stale sessions, unverified accounts, stale transport and unresolved legacy execution', () => {
  const f=fixture(),c=independentAccount(f),target=f.manager.execute('target.create',{url:'https://discord.com/channels/222/333'}),input={accountId:c.account.id,targetId:target.id};
  assert.throws(()=>f.manager.bridge({type:'ACCOUNT_OBSERVATION',sessionId:'old',accountId:'111',verified:true},c.instanceId),{code:'STALE_SESSION'});
  assert.throws(()=>f.manager.bridge({type:'ACCOUNT_OBSERVATION',sessionId:c.sessionId,accountId:'111'},c.instanceId),{code:'VALIDATION'});
  f.advance(16000);assert.equal(f.manager.snapshot().accounts[0].connected,false);assert.throws(()=>f.manager.execute('channel.connect',input),{code:'CONNECTION_LOST'});
  const fresh=f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:c.instanceId});
  assert.equal(f.manager.snapshot().accounts[0].verified,false);
  assert.throws(()=>f.manager.execute('channel.connect',input),{code:'LEGACY_UNRESOLVED'});
  f.manager.bridge({type:'OBSERVATION',sessionId:fresh.sessionId,legacyFrozen:true,legacyPending:false,channels:[]},fresh.instanceId);
  assert.throws(()=>f.manager.execute('channel.connect',input),{code:'ACCOUNT_UNVERIFIED'});f.manager.close();
});

test('an account switch fences old bindings and prevents a running group from continuing', () => {
  const f=fixture(),c=f.connect('111');f.apply(c,[f.message()]);f.start(f.group([c]));
  const registered=f.manager.bridge({type:'ACCOUNT_OBSERVATION',sessionId:c.sessionId,accountId:'222',verified:true},c.instanceId);
  const s=f.manager.snapshot();assert.equal(registered.account.accountId,'222');assert.equal(s.accounts.find(a=>a.accountId==='111').verified,false);
  assert.equal(s.channels[0].verified,false);assert.equal(s.groups[0].status,'pause_pending');assert.equal(s.attempts[0].status,'unknown');
  assert.throws(()=>f.prepared(c,s.attempts[0]));f.manager.close();
});

test('existing verified observations expose independent account and target catalog entries', () => {
  const f=fixture(),c=f.connect('111','333'),s=f.manager.snapshot();
  assert.equal(s.accounts[0].accountId,'111');assert.equal(s.accounts[0].instanceId,c.instanceId);assert.equal(s.accounts[0].verified,true);
  assert.equal(s.targets[0].channelId,'333');assert.equal(s.channels[0].id,c.channel.id);f.manager.close();
});

test('reset token includes independent accounts and targets and reset clears their configuration', () => {
  const f=fixture(),before=f.manager.snapshot().configurationToken;independentAccount(f);
  const afterAccount=f.manager.snapshot().configurationToken;assert.notEqual(before,afterAccount);
  f.manager.execute('target.create',{url:'https://discord.com/channels/222/333'});const token=f.manager.snapshot().configurationToken;assert.notEqual(afterAccount,token);
  f.manager.execute('settings.reset',{confirmation:'RESET_ALL_SETTINGS',expectedConfiguration:token});const s=f.manager.snapshot();
  assert.deepEqual(s.accounts,[]);assert.deepEqual(s.targets,[]);assert.deepEqual(s.instances,[]);f.manager.close();
});


test('missing account verification revokes identity and fences affected execution immediately', () => {
  const f=fixture(),c=f.connect('111');f.apply(c,[f.message()]);f.start(f.group([c]));
  f.manager.bridge({type:'ACCOUNT_OBSERVATION',sessionId:c.sessionId,accountId:'111',verified:false},c.instanceId);
  const s=f.manager.snapshot();assert.equal(s.accounts[0].verified,false);assert.equal(s.channels[0].verified,false);assert.equal(s.groups[0].status,'pause_pending');assert.equal(s.attempts[0].status,'unknown');f.manager.close();
});

test('account verification can declare the legacy freeze without a channel observation', () => {
  const f=fixture(),hello=f.manager.bridge({type:'HELLO',protocolVersion:1,capabilities:['open-channel-v1']});
  const result=f.manager.bridge({type:'ACCOUNT_OBSERVATION',sessionId:hello.sessionId,accountId:'111',verified:true,legacyFrozen:true,legacyPending:false},hello.instanceId);
  const target=f.manager.execute('target.create',{url:'https://discord.com/channels/222/333'});
  assert.equal(f.manager.execute('channel.connect',{accountId:result.account.id,targetId:target.id}).status,'pending');f.manager.close();
});

test('older stored bindings migrate to the catalog without changing playlists or groups', () => {
  const dir=mkdtempSync(join(tmpdir(),'dico-catalog-')),databasePath=join(dir,'state.sqlite');
  try {
    const f=fixture({databasePath}),c=f.connect('111','333');f.apply(c,[f.message()]);f.group([c]);const before=f.manager.snapshot();f.manager.close();
    const store=new CentralStore(databasePath),old=store.read();delete old.accounts;delete old.targets;old.stateVersion++;store.commit(old,[]);store.close();
    const restored=createCentralManager({databasePath}),s=restored.snapshot();
    assert.equal(s.accounts.length,1);assert.equal(s.accounts[0].accountId,'111');assert.equal(s.accounts[0].verified,false);assert.equal(s.targets.length,1);
    assert.equal(s.channels[0].id,before.channels[0].id);assert.deepEqual(s.channels[0].playlist,before.channels[0].playlist);assert.deepEqual(s.groups[0].members,before.groups[0].members);restored.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('connecting a target cannot reopen a binding with an unresolved local attempt', () => {
  const f=fixture(),c=independentAccount(f),target=f.manager.execute('target.create',{url:'https://discord.com/channels/222/333'});
  f.manager.bridge({type:'OBSERVATION',sessionId:c.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'111',guildId:'222',channelId:'333',tabId:42,verified:true}]},c.instanceId);
  c.channel=f.manager.snapshot().channels[0];f.apply(c,[f.message()]);f.start(f.group([c]));
  assert.throws(()=>f.manager.execute('channel.connect',{accountId:c.account.id,targetId:target.id}),{code:'ATTEMPT_UNRESOLVED'});assert.equal(f.manager.snapshot().commands.some(cmd=>cmd.type==='OPEN_CHANNEL'),false);f.manager.close();
});

test('configuration backup roundtrips independent account aliases and unattached targets without verification', () => {
  const f=fixture(),c=independentAccount(f),named=f.manager.execute('account.update',{id:c.account.id,expectedVersion:1,name:'My work identity'}),target=f.manager.execute('target.create',{url:'https://discord.com/channels/222/333',name:'Future channel'});
  const backup=f.manager.exportBackup();assert.equal(backup.accounts[0].name,named.name);assert.equal(backup.targets[0].name,target.name);assert.equal(backup.accounts[0].verified,undefined);assert.equal(JSON.stringify(backup).includes(c.sessionId),false);
  f.manager.execute('target.create',{url:'https://discord.com/channels/222/444'});f.manager.importBackup(backup);
  let s=f.manager.snapshot();assert.equal(s.channels.length,0);assert.equal(s.targets.length,1);assert.equal(s.targets[0].id,target.id);assert.equal(s.accounts[0].name,named.name);assert.equal(s.accounts[0].verified,false);
  assert.throws(()=>f.manager.execute('channel.connect',{accountId:named.id,targetId:target.id}),{code:'CONNECTION_LOST'});
  const fresh=f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:c.instanceId,capabilities:['open-channel-v1']});
  f.manager.bridge({type:'OBSERVATION',sessionId:fresh.sessionId,legacyFrozen:true,legacyPending:false,channels:[]},c.instanceId);
  assert.throws(()=>f.manager.execute('channel.connect',{accountId:named.id,targetId:target.id}),{code:'ACCOUNT_UNVERIFIED'});
  f.manager.bridge({type:'ACCOUNT_OBSERVATION',sessionId:fresh.sessionId,accountId:'111',verified:true},c.instanceId);
  assert.equal(f.manager.execute('channel.connect',{accountId:named.id,targetId:target.id}).status,'pending');f.manager.close();
});

test('older v1 backups derive account and target catalog while optional catalogs reject invalid references atomically', () => {
  const f=fixture(),c=f.connect('111','333');const backup=f.manager.exportBackup();delete backup.accounts;delete backup.targets;
  f.manager.importBackup(backup);assert.equal(f.manager.snapshot().accounts.length,1);assert.equal(f.manager.snapshot().targets.length,1);
  const bad=f.manager.exportBackup();bad.accounts[0].instanceId='missing';const token=f.manager.snapshot().configurationToken;
  assert.throws(()=>f.manager.importBackup(bad),{code:'VALIDATION'});assert.equal(f.manager.snapshot().configurationToken,token);
  for(const target of [{id:'t',guildId:'222',channelId:'333',url:'https://discord.com/channels/222/333?x=1',name:'Bad'},{id:'t',guildId:'222',channelId:'444',url:'https://discord.com/channels/222/333',name:'Bad'}]){
    const invalid={...backup,targets:[target]};assert.throws(()=>f.manager.importBackup(invalid),{code:'VALIDATION'});
  }
  f.manager.close();
});

test('transport heartbeats cannot keep an unobserved account identity fresh', () => {
  const f=fixture(),c=independentAccount(f),target=f.manager.execute('target.create',{url:'https://discord.com/channels/222/333'});f.advance(16000);
  f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId},c.instanceId);
  assert.equal(f.manager.snapshot().accounts[0].verified,false);
  assert.throws(()=>f.manager.execute('channel.connect',{accountId:c.account.id,targetId:target.id}),{code:'ACCOUNT_UNVERIFIED'});
  f.manager.bridge({type:'ACCOUNT_OBSERVATION',sessionId:c.sessionId,accountId:'111',verified:true},c.instanceId);
  assert.equal(f.manager.execute('channel.connect',{accountId:c.account.id,targetId:target.id}).status,'pending');f.manager.close();
});


test('applied channel opens remain idempotent until verification and are fenced by a new session', () => {
  const f=fixture(),c=independentAccount(f),target=f.manager.execute('target.create',{url:'https://discord.com/channels/222/333'}),input={accountId:c.account.id,targetId:target.id};
  const first=f.manager.execute('channel.connect',input).command;
  f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:first.id,status:'applied'},c.instanceId);
  assert.equal(f.manager.execute('channel.connect',input).command.id,first.id);assert.equal(f.manager.snapshot().commands.length,1);
  const next=f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:c.instanceId,capabilities:['open-channel-v1']});
  assert.equal(f.manager.snapshot().commands.find(cmd=>cmd.id===first.id).status,'superseded');
  f.manager.bridge({type:'ACCOUNT_OBSERVATION',sessionId:next.sessionId,accountId:'111',verified:true,legacyFrozen:true,legacyPending:false},c.instanceId);
  const retry=f.manager.execute('channel.connect',input).command;assert.notEqual(retry.id,first.id);
  f.manager.bridge({type:'ACK',sessionId:next.sessionId,commandId:retry.id,status:'rejected'},c.instanceId);
  assert.notEqual(f.manager.execute('channel.connect',input).command.id,retry.id);f.manager.close();
});

test('account revocation clears applied channel opens that have not been verified', () => {
  const f=fixture(),c=independentAccount(f),target=f.manager.execute('target.create',{url:'https://discord.com/channels/222/333'});
  const cmd=f.manager.execute('channel.connect',{accountId:c.account.id,targetId:target.id}).command;
  f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:cmd.id,status:'applied'},c.instanceId);
  f.manager.bridge({type:'ACCOUNT_OBSERVATION',sessionId:c.sessionId,accountId:'111',verified:false},c.instanceId);
  assert.equal(f.manager.snapshot().commands.find(x=>x.id===cmd.id).status,'superseded');f.manager.close();
});

test('older extensions receive an explicit update error while an existing verified connection remains usable', () => {
  const f=fixture(),c=independentAccount(f,'111',['central-v1']),target=f.manager.execute('target.create',{url:'https://discord.com/channels/222/333'}),input={accountId:c.account.id,targetId:target.id};
  assert.throws(()=>f.manager.execute('channel.connect',input),{code:'EXTENSION_UPDATE_REQUIRED'});assert.equal(f.manager.snapshot().commands.length,0);
  f.manager.bridge({type:'OBSERVATION',sessionId:c.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'111',guildId:'222',channelId:'333',tabId:4,verified:true}]},c.instanceId);
  assert.equal(f.manager.execute('channel.connect',input).status,'connected');f.manager.close();
});

test('HELLO validates bounded capability names and replaces previous session capabilities', () => {
  const f=fixture();for(const capabilities of ['open-channel-v1',Array(33).fill('open-channel-v1'),['x'.repeat(65)],[42],['open channel']])assert.throws(()=>f.manager.bridge({type:'HELLO',protocolVersion:1,capabilities}),{code:'VALIDATION'});
  const c=f.manager.bridge({type:'HELLO',protocolVersion:1,capabilities:['central-v1','open-channel-v1','open-channel-v1']});
  assert.deepEqual(f.manager.snapshot().instances[0].capabilities,['central-v1','open-channel-v1']);
  f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:c.instanceId});assert.deepEqual(f.manager.snapshot().instances[0].capabilities,[]);f.manager.close();
});

test('command rejection incidents preserve the first bounded cause across duplicate acknowledgments', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));
  const attempt=f.manager.snapshot().attempts[0],command=f.manager.commands(c.instanceId).find(cmd=>cmd.type==='PREPARE');
  const reject=rejectionCode=>f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:command.id,status:'rejected',rejectionCode,error:'private body must not leak'},c.instanceId);
  reject('DRAFT_MISMATCH');let problem=f.manager.snapshot().incidents.find(i=>i.code==='command_rejected');
  assert.equal(problem.commandType,'PREPARE');assert.equal(problem.commandId,command.id);assert.equal(problem.attemptId,attempt.id);assert.equal(problem.rejectionCode,'DRAFT_MISMATCH');
  reject('TAB_MISSING');problem=f.manager.snapshot().incidents.find(i=>i.id===problem.id);assert.equal(problem.count,1);assert.equal(problem.rejectionCode,'DRAFT_MISMATCH');
  reject('private raw diagnostic');problem=f.manager.snapshot().incidents.find(i=>i.id===problem.id);assert.equal(problem.rejectionCode,'DRAFT_MISMATCH');assert.equal(JSON.stringify(f.manager.snapshot().incidents).includes('private'),false);f.manager.close();
});

test('legacy command rejection alerts resolve when their referenced attempt reaches a terminal result', () => {
  const dir=mkdtempSync(join(tmpdir(),'dico-incident-')),databasePath=join(dir,'state.sqlite');
  try {
    const f=fixture({databasePath}),c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const attempt=f.manager.snapshot().attempts[0];f.prepared(c,attempt);
    const command=f.manager.commands(c.instanceId).find(cmd=>cmd.type==='COMMIT_PERMIT');f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:command.id,status:'rejected',rejectionCode:'DRAFT_MISMATCH'},c.instanceId);f.manager.close();
    const store=new CentralStore(databasePath),state=store.read(),problem=state.incidents.find(i=>i.code==='command_rejected');delete problem.attemptId;delete problem.commandType;state.stateVersion++;store.commit(state,[]);store.close();
    const reopened=fixture({databasePath});const hello=reopened.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:c.instanceId});
    reopened.manager.bridge({type:'DELIVERY_RESULT',sessionId:hello.sessionId,attemptId:attempt.id,outcome:'confirmed',messageId:'known-post'},c.instanceId);
    assert.equal(reopened.manager.snapshot().incidents.find(i=>i.id===problem.id).status,'resolved');assert.equal(reopened.manager.snapshot().attempts[0].status,'confirmed');reopened.manager.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('legacy CONTROL rejection remains until every browser applies a new control generation without resolving unrelated PREPARE alerts', () => {
  const dir=mkdtempSync(join(tmpdir(),'dico-control-alert-')),databasePath=join(dir,'state.sqlite');
  try {
    const f=fixture({databasePath}),cs=[f.connect('A'),f.connect('B')],g=f.group(cs);f.manager.execute('group.stop',{id:g.id});
    const command=f.manager.commands(cs[0].instanceId).find(cmd=>cmd.type==='CONTROL');f.manager.bridge({type:'ACK',sessionId:cs[0].sessionId,commandId:command.id,status:'rejected',rejectionCode:'CONTROL_FAILED'},cs[0].instanceId);f.manager.close();
    const store=new CentralStore(databasePath),state=store.read(),problem=state.incidents.find(i=>i.code==='command_rejected');delete problem.commandType;
    state.commands.push({id:'unrelated-prepare',type:'PREPARE',instanceId:cs[0].instanceId,sessionId:cs[0].sessionId,status:'rejected',createdAt:0,payload:{groupId:g.id,attemptId:'older-unrelated-attempt'}});
    state.incidents.push({id:'unrelated-problem',key:'command_rejected:unrelated',code:'command_rejected',commandId:'unrelated-prepare',groupId:g.id,status:'open',count:1,createdAt:0,lastSeenAt:0});
    state.stateVersion++;store.commit(state,[]);store.close();
    const reopened=fixture({databasePath}),sessions=cs.map(c=>reopened.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:c.instanceId}));
    reopened.manager.execute('group.stop',{id:g.id});assert.equal(reopened.manager.snapshot().incidents.find(i=>i.id===problem.id).status,'open');
    const controls=sessions.map(c=>reopened.manager.commands(c.instanceId).findLast(cmd=>cmd.type==='CONTROL'));
    reopened.manager.bridge({type:'ACK',sessionId:sessions[0].sessionId,commandId:controls[0].id,status:'applied'},sessions[0].instanceId);
    assert.equal(reopened.manager.snapshot().groups[0].status,'stop_pending');assert.equal(reopened.manager.snapshot().incidents.find(i=>i.id===problem.id).status,'open');
    reopened.manager.bridge({type:'ACK',sessionId:sessions[1].sessionId,commandId:controls[1].id,status:'applied'},sessions[1].instanceId);
    const s=reopened.manager.snapshot();assert.equal(s.groups[0].status,'stopped');assert.equal(s.incidents.find(i=>i.id===problem.id).status,'resolved');assert.equal(s.incidents.find(i=>i.id==='unrelated-problem').status,'open');reopened.manager.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('command rejection alerts remain separate across groups sharing one browser', () => {
  const f=fixture(),c=f.connect('A','one');
  f.manager.bridge({type:'OBSERVATION',sessionId:c.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'A',guildId:'guild',channelId:'one',tabId:1,verified:true},{accountId:'A',guildId:'guild',channelId:'two',tabId:2,verified:true}]},c.instanceId);
  const other=f.manager.snapshot().channels.find(channel=>channel.channelId==='two'),a=f.group([c]),b=f.group([{...c,channel:other}]);
  for(const g of [a,b]){
    f.manager.execute('group.stop',{id:g.id});const command=f.manager.commands(c.instanceId).findLast(cmd=>cmd.type==='CONTROL'&&cmd.payload.groupId===g.id);
    f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:command.id,status:'rejected',rejectionCode:'CONTROL_FAILED'},c.instanceId);
  }
  const alerts=f.manager.snapshot().incidents.filter(i=>i.code==='command_rejected');assert.equal(alerts.length,2);assert.notEqual(alerts[0].commandId,alerts[1].commandId);
  f.manager.execute('group.stop',{id:b.id});const retry=f.manager.commands(c.instanceId).findLast(cmd=>cmd.type==='CONTROL'&&cmd.payload.groupId===b.id);
  f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:retry.id,status:'applied'},c.instanceId);
  const current=f.manager.snapshot().incidents.filter(i=>i.code==='command_rejected');assert.equal(current.find(i=>i.groupId===a.id).status,'open');assert.equal(current.find(i=>i.groupId===b.id).status,'resolved');f.manager.close();
});

test('incident recheck repairs historical terminal PREPARE and deleted-group CONTROL alerts without changing execution', () => {
  const dir=mkdtempSync(join(tmpdir(),'dico-recheck-')),databasePath=join(dir,'state.sqlite');
  try {
    const f=fixture({databasePath}),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);
    const prepare=f.manager.commands(c.instanceId).find(cmd=>cmd.type==='PREPARE');
    f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:prepare.id,status:'rejected'},c.instanceId);
    f.manager.execute('group.stop',{id:g.id});const oldControl=f.manager.commands(c.instanceId).findLast(cmd=>cmd.type==='CONTROL');
    f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:oldControl.id,status:'rejected'},c.instanceId);
    f.manager.execute('group.stop',{id:g.id});const retry=f.manager.commands(c.instanceId).findLast(cmd=>cmd.type==='CONTROL');
    f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:retry.id,status:'applied',executionBlocked:true,attemptId:retry.payload.attemptId},c.instanceId);
    assert.equal(f.manager.snapshot().attempts[0].status,'not_sent');
    f.manager.execute('group.delete',{id:g.id,expectedVersion:1});f.manager.close();
    const store=new CentralStore(databasePath),state=store.read(),problems=state.incidents.filter(i=>i.code==='command_rejected');
    assert.equal(problems.length,2);
    for(const problem of problems){problem.status='open';delete problem.resolvedAt;delete problem.attemptId;delete problem.commandType;}
    state.stateVersion++;store.commit(state,[]);store.close();
    const reopened=fixture({databasePath}),before=reopened.manager.snapshot();
    const prepareProblem=problems.find(i=>i.commandId===prepare.id),controlProblem=problems.find(i=>i.commandId===oldControl.id);
    assert.deepEqual(reopened.manager.execute('incident.recheck',{id:prepareProblem.id}),{resolved:1,remaining:0,blocked:[]});
    assert.equal(reopened.manager.snapshot().incidents.find(i=>i.id===controlProblem.id).status,'open');
    assert.deepEqual(reopened.manager.execute('incident.recheck',{}),{resolved:1,remaining:0,blocked:[]});
    assert.deepEqual(reopened.manager.execute('incident.recheck',{}),{resolved:0,remaining:0,blocked:[]});
    const after=reopened.manager.snapshot();assert.deepEqual(after.groups,before.groups);assert.deepEqual(after.attempts,before.attempts);assert.deepEqual(after.commands,before.commands);
    assert.equal(after.incidents.find(i=>i.id===prepareProblem.id).resolutionReason,'terminal_attempt');
    assert.equal(after.incidents.find(i=>i.id===controlProblem.id).resolutionReason,'obsolete_group');
    assert.ok(after.events.some(e=>e.type==='incident.resolved'&&e.incidentId===controlProblem.id&&e.reasonCode==='obsolete_group'));
    reopened.manager.close();const persisted=fixture({databasePath});assert.equal(persisted.manager.snapshot().incidents.some(i=>i.status==='open'),false);persisted.manager.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('incident recheck leaves unknown permits and rejected pending controls blocked', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
  const permit=f.manager.commands(c.instanceId).find(cmd=>cmd.type==='COMMIT_PERMIT');
  f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:permit.id,status:'rejected'},c.instanceId);
  f.manager.execute('group.stop',{id:g.id});const stop=f.manager.commands(c.instanceId).findLast(cmd=>cmd.type==='CONTROL');
  f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:stop.id,status:'rejected'},c.instanceId);
  const before=f.manager.snapshot(),result=f.manager.execute('incident.recheck',{});
  assert.equal(result.resolved,0);assert.equal(result.remaining,3);assert.ok(result.blocked.every(i=>i.reasonCode==='ATTEMPT_UNRESOLVED'&&i.page==='history'));
  assert.deepEqual(f.manager.snapshot().attempts,before.attempts);assert.deepEqual(f.manager.snapshot().commands,before.commands);assert.deepEqual(f.manager.snapshot().groups,before.groups);
  f.result(c,a,'confirmed');const pending=f.manager.execute('incident.recheck',{});
  assert.equal(pending.resolved,0);assert.equal(pending.remaining,1);assert.equal(pending.blocked[0].reasonCode,'CONTROL_PENDING');assert.equal(f.manager.snapshot().groups[0].status,'stop_pending');
  assert.throws(()=>f.manager.execute('incident.recheck',{id:'missing'}),{code:'NOT_FOUND'});f.manager.close();
});

test('incident recheck requires every current-generation CONTROL owner ACK before closing an old rejection', () => {
  for(const applied of [false,true]){
    const dir=mkdtempSync(join(tmpdir(),'dico-recheck-control-')),databasePath=join(dir,'state.sqlite');
    try {
      const f=fixture({databasePath}),cs=[f.connect('A'),f.connect('B')],g=f.group(cs);f.manager.execute('group.stop',{id:g.id});
      const old=f.manager.commands(cs[0].instanceId).findLast(cmd=>cmd.type==='CONTROL');
      f.manager.bridge({type:'ACK',sessionId:cs[0].sessionId,commandId:old.id,status:'rejected'},cs[0].instanceId);
      f.manager.execute('group.stop',{id:g.id});
      for(const c of cs){const cmd=f.manager.commands(c.instanceId).findLast(cmd=>cmd.type==='CONTROL');f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:cmd.id,status:'applied'},c.instanceId);}
      f.manager.close();const store=new CentralStore(databasePath),state=store.read(),problem=state.incidents.find(i=>i.commandId===old.id);
      problem.status='open';delete problem.resolvedAt;
      if(!applied)state.commands.findLast(cmd=>cmd.type==='CONTROL'&&cmd.instanceId===cs[1].instanceId).status='rejected';
      state.stateVersion++;store.commit(state,[]);store.close();
      const reopened=fixture({databasePath}),result=reopened.manager.execute('incident.recheck',{});
      assert.equal(result.resolved,applied?1:0);assert.equal(result.remaining,applied?0:1);
      if(applied)assert.equal(reopened.manager.snapshot().incidents.find(i=>i.id===problem.id).resolutionReason,'control_applied');
      else assert.equal(result.blocked[0].reasonCode,'CONTROL_PENDING');
      reopened.manager.close();
    } finally {rmSync(dir,{recursive:true,force:true});}
  }
});

test('incident recheck uses retained terminal tombstones but never invents results for missing evidence', () => {
  const dir=mkdtempSync(join(tmpdir(),'dico-recheck-evidence-')),databasePath=join(dir,'state.sqlite');
  try {
    const f=fixture({databasePath});f.manager.close();const store=new CentralStore(databasePath),state=store.read();
    state.attempts.push({id:'terminal',status:'not_sent',pruned:true,createdAt:1,finalizedAt:2});
    for(const [id,commandType,attemptId] of [['retained','PREPARE','terminal'],['missing','CONTROL','missing-attempt'],['untyped',undefined,'terminal']])state.incidents.push({id,code:'command_rejected',status:'open',commandType,attemptId,groupId:'deleted',createdAt:1,lastSeenAt:1});
    state.incidents.push({id:'unrelated',code:'connection_lost',status:'open',createdAt:1,lastSeenAt:1});
    state.stateVersion++;store.commit(state,[]);store.close();
    const reopened=fixture({databasePath}),result=reopened.manager.execute('incident.recheck',{});
    assert.equal(result.resolved,1);assert.equal(result.remaining,3);assert.deepEqual(result.blocked.map(i=>i.id),['missing','untyped','unrelated']);assert.ok(result.blocked.every(i=>i.reasonCode==='EVIDENCE_REQUIRED'));
    assert.equal(reopened.manager.snapshot().incidents.find(i=>i.id==='retained').resolutionReason,'terminal_attempt');reopened.manager.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

function rejectedChannelOpen(f) {
  const connection=independentAccount(f),target=f.manager.execute('target.create',{url:'https://discord.com/channels/222/333'});
  const command=f.manager.execute('channel.connect',{accountId:connection.account.id,targetId:target.id}).command;
  const reject=()=>f.manager.bridge({type:'ACK',sessionId:connection.sessionId,commandId:command.id,status:'rejected',rejectionCode:'TARGET_MISMATCH'},connection.instanceId);
  reject();const problem=f.manager.snapshot().incidents.find(i=>i.commandId===command.id);
  const observe=(fields={},owner=connection)=>f.manager.bridge({type:'OBSERVATION',sessionId:owner.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'111',guildId:'222',channelId:'333',tabId:42,verified:true,...fields}]},owner.instanceId);
  return{connection,target,command,problem,reject,observe};
}

test('incident recheck resolves rejected OPEN_CHANNEL only after the exact execution binding is reverified', () => {
  const f=fixture(),opened=rejectedChannelOpen(f);f.advance(1);
  f.manager.bridge({type:'ACCOUNT_OBSERVATION',sessionId:opened.connection.sessionId,accountId:'111',verified:true},opened.connection.instanceId);
  const registeredOnly=f.manager.execute('incident.recheck',{id:opened.problem.id});assert.equal(registeredOnly.resolved,0);assert.equal(registeredOnly.blocked[0].reasonCode,'CONNECTION_UNVERIFIED');assert.equal(registeredOnly.blocked[0].page,'channels');
  opened.observe();const before=f.manager.snapshot(),result=f.manager.execute('incident.recheck',{id:opened.problem.id}),after=f.manager.snapshot();
  assert.deepEqual(result,{resolved:1,remaining:0,blocked:[]});assert.equal(after.incidents.find(i=>i.id===opened.problem.id).resolutionReason,'connection_reverified');
  for(const list of ['attempts','commands','groups','channels'])assert.deepEqual(after[list],before[list]);
  assert.equal(f.manager.events().findLast(e=>e.type==='incident.resolved').reasonCode,'connection_reverified');f.manager.close();
});

test('OPEN_CHANNEL recheck does not accept another account, guild, channel or browser as connection proof', () => {
  for(const mismatch of [{accountId:'222'},{guildId:'999'},{channelId:'444'},{otherBrowser:true}]){
    const f=fixture(),opened=rejectedChannelOpen(f);f.advance(1);
    if(mismatch.otherBrowser){const other=independentAccount(f);opened.observe({},other);}else opened.observe(mismatch);
    const result=f.manager.execute('incident.recheck',{id:opened.problem.id});assert.equal(result.resolved,0);assert.equal(result.blocked[0].reasonCode,'CONNECTION_UNVERIFIED');assert.equal(result.blocked[0].page,'channels');f.manager.close();
  }
});

test('OPEN_CHANNEL duplicate rejection preserves fresh verification but stale heartbeat still blocks recovery', () => {
  const f=fixture(),opened=rejectedChannelOpen(f);opened.observe();f.advance(1);opened.reject();
  assert.equal(f.manager.snapshot().incidents.find(i=>i.id===opened.problem.id).count,1);
  f.advance(16000);let result=f.manager.execute('incident.recheck',{id:opened.problem.id});assert.equal(result.resolved,0);assert.equal(result.blocked[0].reasonCode,'CONNECTION_STALE');
  f.manager.bridge({type:'HEARTBEAT',sessionId:opened.connection.sessionId},opened.connection.instanceId);
  assert.equal(f.manager.execute('incident.recheck',{id:opened.problem.id}).resolved,1);f.manager.close();
});

test('OPEN_CHANNEL recheck rejects a replaced browser session and a false channel verification', () => {
  for(const scenario of ['session','unverified']){
    const f=fixture(),opened=rejectedChannelOpen(f);opened.observe();
    if(scenario==='session'){
      const fresh=f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:opened.connection.instanceId,capabilities:['open-channel-v1']});
      f.manager.bridge({type:'ACCOUNT_OBSERVATION',sessionId:fresh.sessionId,accountId:'111',verified:true},fresh.instanceId);
    }else opened.observe({verified:false});
    const result=f.manager.execute('incident.recheck',{id:opened.problem.id});assert.equal(result.resolved,0);assert.equal(result.blocked[0].page,'channels');f.manager.close();
  }
});

test('OPEN_CHANNEL recheck does not guess missing command routing from a healthy channel', () => {
  const dir=mkdtempSync(join(tmpdir(),'dico-open-alert-')),databasePath=join(dir,'state.sqlite');
  try{
    const f=fixture({databasePath}),opened=rejectedChannelOpen(f);opened.observe();f.manager.close();
    const store=new CentralStore(databasePath),state=store.read();delete state.commands.find(c=>c.id===opened.command.id).payload;state.stateVersion++;store.commit(state,[]);store.close();
    const reopened=fixture({databasePath}),fresh=reopened.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:opened.connection.instanceId,capabilities:['open-channel-v1']});
    reopened.manager.bridge({type:'OBSERVATION',sessionId:fresh.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'111',guildId:'222',channelId:'333',tabId:42,verified:true}]},fresh.instanceId);
    const result=reopened.manager.execute('incident.recheck',{id:opened.problem.id});assert.equal(result.resolved,0);assert.equal(result.blocked[0].reasonCode,'CONNECTION_UNVERIFIED');assert.equal(result.blocked[0].page,'channels');reopened.manager.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('new account-channel bindings default to detected slowmode plus three seconds in automatic mode', () => {
  const f=fixture(),c=f.connect();let channel=f.manager.snapshot().channels[0];
  assert.equal(channel.intervalMode,'auto');assert.equal(channel.intervalMs,3000);assert.equal(channel.minimumIntervalMs,3000);assert.equal(channel.slowmodeObservedAt,undefined);
  const observe=value=>f.manager.bridge({type:'OBSERVATION',sessionId:c.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:c.channel.accountId,guildId:'guild',channelId:'channel',tabId:1,verified:true,...(value===undefined?{}:{slowmodeMs:value})}]},c.instanceId);
  observe(60000);channel=f.manager.snapshot().channels[0];assert.equal(channel.intervalMs,63000);assert.equal(channel.minimumIntervalMs,63000);assert.equal(channel.effectiveIntervalMs,63000);assert.ok(channel.slowmodeObservedAt);
  observe(undefined);assert.equal(f.manager.snapshot().channels[0].intervalMs,63000);
  observe(120000);assert.equal(f.manager.snapshot().channels[0].intervalMs,123000);
  observe(0);assert.equal(f.manager.snapshot().channels[0].intervalMs,3000);f.manager.close();
});

test('custom account-channel intervals enforce the detected floor and preserve intent as slowmode changes', () => {
  const f=fixture(),c=f.connect();
  const observe=slowmodeMs=>f.manager.bridge({type:'OBSERVATION',sessionId:c.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:c.channel.accountId,guildId:'guild',channelId:'channel',tabId:1,verified:true,slowmodeMs}]},c.instanceId);
  observe(60000);const update=payload=>f.manager.execute('channel.update',{id:c.channel.id,expectedVersion:f.manager.snapshot().channels[0].version,...payload});
  assert.throws(()=>update({intervalMs:60000}),{code:'INTERVAL_BELOW_SLOWMODE'});
  let channel=update({intervalMode:'custom',intervalMs:90000});assert.equal(channel.intervalMode,'custom');assert.equal(channel.customIntervalMs,90000);assert.equal(channel.intervalMs,90000);
  observe(120000);channel=f.manager.snapshot().channels[0];assert.equal(channel.intervalMs,123000);assert.equal(channel.customIntervalMs,90000);
  observe(60000);assert.equal(f.manager.snapshot().channels[0].intervalMs,90000);
  channel=update({intervalMode:'auto'});assert.equal(channel.intervalMs,63000);assert.equal(channel.customIntervalMs,undefined);
  assert.throws(()=>update({intervalMode:'anything'}),{code:'VALIDATION'});f.manager.close();
});

test('actual interval changes synchronize configuration without resetting playlist position', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message('First'),f.message('Second')]);
  const before=f.manager.snapshot().channels[0],changed=f.manager.execute('channel.update',{id:c.channel.id,expectedVersion:before.version,intervalMode:'custom',intervalMs:90000});
  assert.equal(changed.configVersion,before.configVersion+1);assert.equal(changed.appliedVersion,0);assert.equal(changed.playlistIndex,before.playlistIndex);
  const config=f.manager.commands(c.instanceId).findLast(cmd=>cmd.type==='CONFIG_SYNC');assert.equal(config.payload.intervalMs,90000);assert.deepEqual(config.payload.items.map(item=>item.messageId),before.playlist.map(item=>item.messageId));
  const count=f.manager.snapshot().commands.length;const same=f.manager.execute('channel.update',{id:c.channel.id,expectedVersion:changed.version,intervalMode:'custom',intervalMs:90000});assert.equal(same.configVersion,changed.configVersion);assert.equal(f.manager.snapshot().commands.length,count);f.manager.close();
});

test('slowmode changes defer configuration until the current attempt finishes without invalidating its permit', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message('First'),f.message('Second')]);const g=f.group([c]);f.start(g);const a=f.manager.snapshot().attempts[0],version=f.manager.snapshot().channels[0].configVersion;
  f.manager.bridge({type:'OBSERVATION',sessionId:c.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:c.channel.accountId,guildId:'guild',channelId:'channel',tabId:1,verified:true,slowmodeMs:60000}]},c.instanceId);
  let channel=f.manager.snapshot().channels[0];assert.equal(channel.intervalMs,63000);assert.equal(channel.pendingIntervalSync,true);assert.equal(channel.configVersion,version);assert.equal(f.manager.commands(c.instanceId).some(cmd=>cmd.type==='CONFIG_SYNC'),false);
  f.prepared(c,a);f.result(c,a);channel=f.manager.snapshot().channels[0];assert.equal(channel.pendingIntervalSync,undefined);assert.equal(channel.configVersion,version+1);assert.equal(channel.playlistIndex,1);
  assert.equal(f.manager.commands(c.instanceId).findLast(cmd=>cmd.type==='CONFIG_SYNC').payload.intervalMs,63000);
  f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);assert.equal(f.manager.snapshot().groups[0].waitReason,'config_pending');f.manager.close();
});

test('an unknown attempt keeps interval synchronization pending until a terminal result is proven', () => {
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];f.prepared(c,a);f.result(c,a,'unknown');
  f.manager.bridge({type:'OBSERVATION',sessionId:c.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:c.channel.accountId,guildId:'guild',channelId:'channel',tabId:1,verified:true,slowmodeMs:120000}]},c.instanceId);
  assert.equal(f.manager.snapshot().attempts[0].status,'unknown');assert.equal(f.manager.snapshot().channels[0].pendingIntervalSync,true);assert.equal(f.manager.commands(c.instanceId).some(cmd=>cmd.type==='CONFIG_SYNC'),false);
  f.result(c,a,'confirmed');assert.equal(f.manager.commands(c.instanceId).findLast(cmd=>cmd.type==='CONFIG_SYNC').payload.intervalMs,123000);f.manager.close();
});

test('older stored intervals migrate to automatic floor or retain a higher custom preference', () => {
  const dir=mkdtempSync(join(tmpdir(),'dico-interval-migration-')),databasePath=join(dir,'state.sqlite');
  try{
    const f=fixture({databasePath});f.connect('A');f.connect('B');f.manager.close();
    const store=new CentralStore(databasePath),state=store.read();state.channels.forEach((c,index)=>{delete c.intervalMode;delete c.customIntervalMs;c.slowmodeMs=60000;c.slowmodeObservedAt=1;c.intervalMs=index?90000:60000;});state.stateVersion++;store.commit(state,[]);store.close();
    const reopened=fixture({databasePath}),channels=reopened.manager.snapshot().channels;
    assert.equal(channels[0].intervalMode,'auto');assert.equal(channels[0].intervalMs,63000);assert.equal(channels[1].intervalMode,'custom');assert.equal(channels[1].intervalMs,90000);assert.equal(channels[1].customIntervalMs,90000);reopened.manager.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('custom and detected interval changes preserve nonzero playlist and group cursors', () => {
  const f=fixture(),cs=[f.connect('A'),f.connect('B')],messages=[f.message('First'),f.message('Second')];cs.forEach(c=>f.apply(c,messages));const g=f.group(cs);f.start(g);const a=f.manager.snapshot().attempts[0];f.prepared(cs[0],a);f.result(cs[0],a);
  f.manager.execute('group.pause',{id:g.id});for(const c of cs){const control=f.manager.commands(c.instanceId).findLast(cmd=>cmd.type==='CONTROL');f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:control.id,status:'applied'},c.instanceId);}
  const initial=f.manager.snapshot(),c=initial.channels.find(c=>c.id===cs[0].channel.id);assert.equal(c.playlistIndex,1);assert.equal(initial.groups[0].cursor,1);
  f.manager.execute('channel.update',{id:c.id,expectedVersion:c.version,intervalMode:'custom',intervalMs:90000});
  f.manager.bridge({type:'OBSERVATION',sessionId:cs[0].sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'A',guildId:'guild',channelId:'channel',tabId:1,verified:true,slowmodeMs:120000}]},cs[0].instanceId);
  const after=f.manager.snapshot(),channel=after.channels.find(x=>x.id===c.id);assert.equal(channel.intervalMs,123000);assert.equal(channel.playlistIndex,1);assert.deepEqual(channel.playlist,c.playlist);assert.equal(after.groups[0].cursor,1);f.manager.close();
});

test('backup preserves automatic mode and a custom preference raised by the safety floor', () => {
  const f=fixture(),cs=[f.connect('A'),f.connect('B')];
  f.manager.execute('channel.update',{id:cs[1].channel.id,expectedVersion:1,intervalMode:'custom',intervalMs:90000});
  for(const c of cs)f.manager.bridge({type:'OBSERVATION',sessionId:c.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:c.channel.accountId,guildId:'guild',channelId:'channel',tabId:c.channel.tabId,verified:true,slowmodeMs:120000}]},c.instanceId);
  const backup=f.manager.exportBackup();f.manager.importBackup(backup);const channels=f.manager.snapshot().channels;
  assert.equal(channels[0].intervalMode,'auto');assert.equal(channels[0].intervalMs,123000);assert.equal(channels[1].intervalMode,'custom');assert.equal(channels[1].customIntervalMs,90000);assert.equal(channels[1].intervalMs,123000);assert.equal(channels[1].minimumIntervalMs,123000);assert.ok(channels[1].slowmodeObservedAt);f.manager.close();
});

function secondIntervalAttempt(f) {
  const c=f.connect();f.apply(c,[f.message('First'),f.message('Second')]);const g=f.group([c],1000);f.start(g);const first=f.manager.snapshot().attempts[0];f.prepared(c,first);f.result(c,first);f.advance(3000);f.manager.tick();
  const second=f.manager.snapshot().attempts.find(a=>a.status==='preparing');
  const increase=()=>f.manager.bridge({type:'OBSERVATION',sessionId:c.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:c.channel.accountId,guildId:'guild',channelId:'channel',tabId:1,verified:true,slowmodeMs:60000}]},c.instanceId);
  return{c,g,second,increase};
}

test('increased slowmode before PREPARED withholds the permit and cancels only after executor blocking proof', () => {
  const f=fixture(),{c,g,second,increase}=secondIntervalAttempt(f);increase();const reply=f.prepared(c,second);
  assert.equal(reply.permitIssued,false);assert.equal(reply.reasonCode,'INTERVAL_NOT_ELAPSED');let s=f.manager.snapshot();assert.equal(s.attempts.find(a=>a.id===second.id).status,'preparing');assert.equal(s.groups[0].status,'pause_pending');assert.equal(s.channels[0].playlistIndex,1);
  assert.equal(f.manager.commands(c.instanceId).some(cmd=>cmd.type==='COMMIT_PERMIT'&&cmd.payload.attemptId===second.id),false);
  const control=f.manager.commands(c.instanceId).findLast(cmd=>cmd.type==='CONTROL'&&cmd.payload.groupId===g.id);
  f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:control.id,status:'received'},c.instanceId);assert.equal(f.manager.snapshot().attempts.find(a=>a.id===second.id).status,'preparing');
  f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:control.id,status:'applied',executionBlocked:true,attemptId:second.id},c.instanceId);
  s=f.manager.snapshot();assert.equal(s.attempts.find(a=>a.id===second.id).status,'cancelled');assert.equal(s.groups[0].status,'paused');assert.equal(s.groups[0].cursor,0);assert.equal(s.channels[0].playlistIndex,1);assert.equal(f.manager.commands(c.instanceId).findLast(cmd=>cmd.type==='CONFIG_SYNC').payload.intervalMs,63000);f.manager.close();
});

test('increased slowmode after permit is rechecked immediately before Enter without inventing an unsent result', () => {
  const f=fixture(),{c,second,increase}=secondIntervalAttempt(f);f.prepared(c,second);increase();
  const authorization=f.manager.bridge({type:'AUTHORIZE_ENTER',sessionId:c.sessionId,attemptId:second.id,runId:second.runId,configVersion:second.configVersion},c.instanceId);
  assert.equal(authorization.allowed,false);assert.equal(f.manager.snapshot().attempts.find(a=>a.id===second.id).status,'permitted');
  f.result(c,second,'not_sent',{executionBlocked:true});let s=f.manager.snapshot();assert.equal(s.channels[0].playlistIndex,1);assert.equal(s.groups[0].cursor,0);assert.equal(s.attempts.length,2);
  const config=f.manager.commands(c.instanceId).findLast(cmd=>cmd.type==='CONFIG_SYNC');f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:config.id,status:'applied'},c.instanceId);f.manager.tick();s=f.manager.snapshot();assert.equal(s.groups[0].waitReason,'account_interval');assert.equal(s.attempts.length,2);f.manager.close();
});

test('unknown result keeps bounded executor reason and ignores inconclusive rereports',()=>{
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);
  const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
  f.result(c,a,'unknown',{reasonCode:'draft-retained'});
  assert.equal(f.manager.snapshot().attempts[0].reasonCode,'draft-retained');
  f.result(c,a,'unknown',{reasonCode:'reconcile_inconclusive'});
  assert.equal(f.manager.snapshot().attempts[0].reasonCode,'draft-retained');
  assert.equal(f.manager.snapshot().groups[0].status,'needs_review');
  f.manager.close();
});

test('unknown executor reason never stores arbitrary content',()=>{
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);
  const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
  f.result(c,a,'unknown',{reasonCode:'private-message-text'});
  assert.equal(f.manager.snapshot().attempts[0].reasonCode,'result_unknown');
  assert.equal(JSON.stringify(f.manager.snapshot()).includes('private-message-text'),false);
  f.manager.close();
});

test('delivery evidence stores only fixed stage and booleans without changing uncertain outcome',()=>{
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);
  const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
  f.result(c,a,'unknown',{reasonCode:'draft-retained',deliveryEvidence:{phase:'commit',stage:'observe',enterAttempted:true,composerRetained:true,newMessage:false,body:'private evidence body',error:'private error'}});
  const saved=f.manager.snapshot().attempts[0];
  assert.deepEqual(saved.deliveryEvidence,{phase:'commit',stage:'observe',enterAttempted:true,composerRetained:true,newMessage:false});
  assert.equal(saved.status,'unknown');
  f.result(c,a,'unknown',{reasonCode:'reconcile_inconclusive',deliveryEvidence:{phase:'commit',stage:'inspect',enterAttempted:false}});
  assert.deepEqual(f.manager.snapshot().attempts[0].deliveryEvidence,saved.deliveryEvidence);
  assert.equal(JSON.stringify(f.manager.snapshot()).includes('private evidence body'),false);
  f.manager.close();
});

test('delivery result persists bounded event and focus observations without changing outcome',()=>{
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);
  const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
  f.result(c,a,'unknown',{reasonCode:'draft-retained',deliveryEvidence:{phase:'commit',stage:'observe',enterAttempted:true,enterDefaultPrevented:false,keyupDefaultPrevented:true,documentHidden:false,documentFocused:true,submitMethod:'button',retryCount:2,maxSendRetries:5,nativeInputObserved:'private',body:'private body'}});
  const saved=f.manager.snapshot().attempts[0];
  assert.deepEqual(saved.deliveryEvidence,{phase:'commit',stage:'observe',enterAttempted:true,enterDefaultPrevented:false,keyupDefaultPrevented:true,documentHidden:false,documentFocused:true,submitMethod:'button',retryCount:2,maxSendRetries:5});
  assert.equal(saved.status,'unknown');
  assert.equal(JSON.stringify(f.manager.snapshot()).includes('private'),false);
  f.manager.close();
});

test('delivery result discards malformed event diagnostics and arbitrary submit method',()=>{
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);
  const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
  f.result(c,a,'unknown',{reasonCode:'draft-retained',deliveryEvidence:{phase:'commit',stage:'observe',enterAttempted:true,enterDefaultPrevented:'false',keyupDefaultPrevented:0,documentHidden:'no',documentFocused:{private:'secret'},submitMethod:'private',retryCount:-1,maxSendRetries:Number.MAX_SAFE_INTEGER+1}});
  assert.deepEqual(f.manager.snapshot().attempts[0].deliveryEvidence,{phase:'commit',stage:'observe',enterAttempted:true});
  assert.equal(JSON.stringify(f.manager.snapshot()).includes('private'),false);
  f.manager.close();
});

test('new executors prepare five seconds early but permit only after due and live cooldown clears',()=>{
  const f=fixture(),c=f.connect('A','channel',['central-v1','early-prepare-v1']);f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);
  const first=f.manager.snapshot().attempts[0];f.manager.bridge({type:'PREPARED',sessionId:c.sessionId,attemptId:first.id,accountId:'A',channelId:'channel',configVersion:first.configVersion,draftClear:true,cooldownMs:0},c.instanceId);f.result(c,first);
  f.advance(1000);f.manager.tick();
  const second=f.manager.snapshot().attempts.find(a=>a.status==='preparing');assert.ok(second);
  const ready=cooldownMs=>f.manager.bridge({type:'PREPARED',sessionId:c.sessionId,attemptId:second.id,accountId:'A',channelId:'channel',configVersion:second.configVersion,draftClear:true,cooldownMs},c.instanceId);
  assert.equal(ready(0).permitIssued,false);assert.equal(f.manager.snapshot().groups[0].status,'running');
  f.advance(2000);assert.equal(ready(2000).permitIssued,false);
  assert.equal(f.manager.commands(c.instanceId).some(cmd=>cmd.type==='COMMIT_PERMIT'&&cmd.payload.attemptId===second.id),false);
  const permitted=ready(0);assert.ok(permitted.permitId);assert.equal(f.manager.snapshot().groups[0].cursor,0);
  f.manager.close();
});

test('early preparation rejects missing cooldown evidence and stop fences waiting permit',()=>{
  const f=fixture(),c=f.connect('A','channel',['early-prepare-v1']);f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);
  const a=f.manager.snapshot().attempts[0];
  assert.throws(()=>f.prepared(c,a),{code:'VALIDATION'});
  const p={type:'PREPARED',sessionId:c.sessionId,attemptId:a.id,accountId:'A',channelId:'channel',configVersion:a.configVersion,draftClear:true,cooldownMs:7000};
  assert.equal(f.manager.bridge(p,c.instanceId).permitIssued,false);
  f.advance(1000);f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);
  f.manager.execute('group.stop',{id:g.id});
  assert.throws(()=>f.manager.bridge({...p,cooldownMs:0},c.instanceId),{code:'EXECUTION_STOPPED'});
  assert.equal(f.manager.commands(c.instanceId).some(cmd=>cmd.type==='COMMIT_PERMIT'),false);
  f.manager.close();
});

test('late live cooldown blocks without consuming account turn or playlist',()=>{
  for(const reasonCode of ['deferred','COOLDOWN_UNVERIFIED','COOLDOWN_WAIT_TIMEOUT']){
    const f=fixture(),c=f.connect();f.apply(c,[f.message('One'),f.message('Two')]);const g=f.group([c]);f.start(g);
    const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
    f.result(c,a,'not_sent',{executionBlocked:true,reasonCode});
    const snapshot=f.manager.snapshot();assert.equal(snapshot.groups[0].status,'paused');assert.equal(snapshot.groups[0].cursor,0);assert.equal(snapshot.channels[0].playlistIndex,0);
    f.advance(1000);f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);f.manager.close();
  }
});

test('sixty-three-second interval begins preparation exactly five seconds ahead and never Enter early',()=>{
  const f=fixture(),c=f.connect('A','channel',['early-prepare-v1']);
  f.manager.execute('channel.update',{id:c.channel.id,expectedVersion:c.channel.version,intervalMs:63000});f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);
  const report=a=>f.manager.bridge({type:'PREPARED',sessionId:c.sessionId,attemptId:a.id,accountId:'A',channelId:'channel',configVersion:a.configVersion,draftClear:true,cooldownMs:0},c.instanceId);
  const first=f.manager.snapshot().attempts[0];report(first);f.result(c,first);
  const step=ms=>{f.advance(ms);f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId},c.instanceId);f.manager.tick();};
  for(let n=0;n<5;n++)step(10000);step(7999);
  assert.equal(f.manager.snapshot().attempts.length,1);step(1);
  const second=f.manager.snapshot().attempts.find(a=>a.status==='preparing');assert.ok(second);
  for(let n=0;n<5;n++){assert.equal(report(second).permitIssued,false);step(1000);}
  assert.ok(report(second).permitId);assert.equal(f.manager.snapshot().attempts.length,2);f.manager.close();
});

test('temporary channel read failure has explicit reason and recovery closes its warning',()=>{
 const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.manager.execute('group.start',{id:g.id});
 const observation=channels=>f.manager.bridge({type:'OBSERVATION',sessionId:c.sessionId,legacyFrozen:true,legacyPending:false,channels},c.instanceId);
 observation([{accountId:'a',guildId:'guild',channelId:'channel',tabId:1,verified:false,verificationReason:'script_unavailable'}]);
 let s=f.manager.snapshot();assert.equal(s.channels[0].verificationReason,'script_unavailable');assert.equal(s.incidents.some(i=>i.code==='account_mismatch'),false);assert.equal(s.incidents.some(i=>i.code==='channel_unverified'&&i.status==='open'),true);
 observation([{accountId:'a',guildId:'guild',channelId:'channel',tabId:1,verified:true}]);
 s=f.manager.snapshot();assert.equal(s.channels[0].verificationReason,undefined);assert.equal(s.incidents.some(i=>i.code==='channel_unverified'&&i.status==='open'),false);assert.notEqual(s.groups[0].waitReason,'account_unverified');f.manager.close();
});

test('window commands reveal exact binding without requiring successful channel verification',()=>{
 const f=fixture(),c=f.connect('a','channel',['managed-window-v1']);
 const result=f.manager.execute('channel.reveal',{id:c.channel.id});assert.equal(result.status,'queued');
 const command=f.manager.commands(c.instanceId).find(c=>c.type==='MANAGE_WINDOW');assert.equal(command.payload.tabId,1);assert.equal(command.payload.action,'reveal');assert.equal(f.manager.snapshot().attempts.length,0);f.manager.close();
});

test('explicit temporary account read failure blocks verification without inventing account switch',()=>{
 const f=fixture(),c=f.connect('11111111111111111');f.apply(c,[f.message()]);const g=f.group([c]);f.manager.execute('group.start',{id:g.id});
 f.manager.bridge({type:'ACCOUNT_OBSERVATION',sessionId:c.sessionId,accountId:'11111111111111111',verified:false,verificationReason:'script_unavailable'},c.instanceId);
 let s=f.manager.snapshot();assert.equal(s.channels[0].verified,false);assert.equal(s.channels[0].verificationReason,'script_unavailable');assert.equal(s.groups[0].status,'running');assert.equal(s.incidents.some(i=>i.code==='account_mismatch'||i.code==='connection_lost'),false);
 f.manager.bridge({type:'OBSERVATION',sessionId:c.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'11111111111111111',guildId:'guild',channelId:'channel',tabId:1,verified:true}]},c.instanceId);
 assert.equal(f.manager.snapshot().channels[0].verified,true);f.manager.close();
});

test('consolidation requires stopped groups and supported current-session bindings',()=>{
 const f=fixture(),c=f.connect('a','channel',['managed-window-v1']);f.apply(c,[f.message()]);const g=f.group([c]);f.manager.execute('group.start',{id:g.id});
 assert.throws(()=>f.manager.execute('channel.consolidate',{id:c.channel.id}),{code:'GROUP_RUNNING'});
 f.manager.execute('group.stop',{id:g.id});const stop=f.manager.commands(c.instanceId).find(c=>c.type==='CONTROL');f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:stop.id,status:'applied',executionBlocked:true},c.instanceId);
 const result=f.manager.execute('channel.consolidate',{id:c.channel.id});assert.equal(result.status,'queued');assert.equal(f.manager.snapshot().attempts.length,0);f.manager.close();
});

test('queued window consolidation fences starts until its actual applied acknowledgment',()=>{
 const f=fixture(),c=f.connect('a','channel',['managed-window-v1']);f.apply(c,[f.message()]);const g=f.group([c]);
 const result=f.manager.execute('channel.consolidate',{id:c.channel.id});assert.throws(()=>f.manager.execute('group.start',{id:g.id}),{code:'WINDOW_MANAGEMENT_PENDING'});
 f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:result.commandId,status:'received'},c.instanceId);assert.throws(()=>f.manager.execute('group.start',{id:g.id}),{code:'WINDOW_MANAGEMENT_PENDING'});
 f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:result.commandId,status:'applied'},c.instanceId);f.manager.execute('group.start',{id:g.id});assert.equal(f.manager.snapshot().groups[0].status,'running');f.manager.close();
});

test('live pre-Enter cooldown holds the same attempt and turn beyond thirty seconds',()=>{
 const f=fixture(),c=f.connect();f.apply(c,[f.message('One'),f.message('Two')]);const g=f.group([c]);f.start(g);const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
 const progress=cooldownMs=>f.manager.bridge({type:'DELIVERY_WAIT',sessionId:c.sessionId,attemptId:a.id,runId:a.runId,configVersion:a.configVersion,cooldownMs},c.instanceId);
 for(let n=0;n<14;n++){assert.equal(progress(70000-n*5000).allowed,true);f.advance(5000);f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId},c.instanceId);f.manager.tick();}
 let s=f.manager.snapshot();assert.equal(s.attempts.length,1);assert.equal(s.attempts[0].status,'permitted');assert.equal(s.groups[0].cursor,0);assert.equal(s.channels[0].playlistIndex,0);
 assert.equal(f.manager.bridge({type:'AUTHORIZE_ENTER',sessionId:c.sessionId,attemptId:a.id,runId:a.runId,configVersion:a.configVersion},c.instanceId).allowed,false);
 assert.equal(progress(0).allowed,true);
 for(let n=0;n<4;n++){f.advance(5000);f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId},c.instanceId);f.manager.tick();}
 assert.equal(f.manager.snapshot().attempts[0].status,'permitted');
 assert.equal(f.manager.bridge({type:'AUTHORIZE_ENTER',sessionId:c.sessionId,attemptId:a.id,runId:a.runId,configVersion:a.configVersion},c.instanceId).allowed,true);
 f.result(c,a);assert.equal(f.manager.snapshot().channels[0].playlistIndex,1);f.manager.close();
});

test('legacy retry preferences are ignored and every new command continues without a count option',()=>{
 const f=fixture();assert.equal(Object.hasOwn(f.manager.snapshot().settings,'maxSendRetries'),false);
 for(const value of [null,0,3,10,27]){
  f.manager.execute('settings.update',{maxSendRetries:value});
  assert.equal(Object.hasOwn(f.manager.snapshot().settings,'maxSendRetries'),false);
 }
 const c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);
 const a=f.manager.snapshot().attempts[0];assert.equal(a.maxSendRetries,null);
 assert.equal(f.manager.commands(c.instanceId).find(x=>x.type==='PREPARE').payload.maxSendRetries,null);
 f.manager.execute('settings.update',{maxSendRetries:0});f.prepared(c,a);
 assert.equal(f.manager.commands(c.instanceId).find(x=>x.type==='COMMIT_PERMIT').payload.maxSendRetries,null);
 f.manager.close();
});

test('older backups do not restore a retry preference',()=>{
 const f=fixture(),backup=f.manager.exportBackup();backup.settings.maxSendRetries=0;
 f.manager.importBackup(backup);
 assert.equal(Object.hasOwn(f.manager.snapshot().settings,'maxSendRetries'),false);
 assert.equal(Object.hasOwn(f.manager.exportBackup().settings,'maxSendRetries'),false);f.manager.close();
});

test('authorized retries refresh the same permitted attempt without advancing its cursor',()=>{
 const f=fixture(),c=f.connect();f.apply(c,[f.message('One'),f.message('Two')]);const g=f.group([c]);f.start(g);
 const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
 const authorize=retryCount=>f.manager.bridge({type:'AUTHORIZE_ENTER',sessionId:c.sessionId,attemptId:a.id,runId:a.runId,configVersion:a.configVersion,retryCount},c.instanceId);
 const wait=(retryCount,cooldownMs=0)=>f.manager.bridge({type:'DELIVERY_WAIT',sessionId:c.sessionId,attemptId:a.id,runId:a.runId,configVersion:a.configVersion,retryPhase:true,retryCount,cooldownMs,elapsedMs:0},c.instanceId);
 assert.equal(wait(1).allowed,false,'first Enter must be authorized before retry');
 assert.equal(authorize(0).allowed,true);assert.equal(authorize(0).allowed,true,'the final pre-Enter recheck uses the same count');
 for(let n=0;n<5;n++){f.advance(5000);f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId},c.instanceId);f.manager.tick();}
 assert.equal(wait(1,20000).allowed,true);assert.equal(authorize(1).allowed,false);
 for(let n=0;n<3;n++){f.advance(5000);f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId},c.instanceId);f.manager.tick();}
 assert.equal(wait(1,5000).allowed,true);assert.equal(wait(3,0).allowed,false,'cannot skip retry');
 assert.equal(wait(1,0).allowed,true);assert.equal(authorize(1).allowed,true);assert.equal(authorize(1).allowed,true);
 assert.equal(wait(1,5000).allowed,true,'a newly observed cooldown may pause the same authorized retry');
 assert.equal(authorize(1).allowed,false);
 assert.equal(wait(1,0).allowed,true);assert.equal(authorize(1).allowed,true);
 assert.equal(f.manager.bridge({type:'DELIVERY_WAIT',sessionId:c.sessionId,attemptId:a.id,runId:a.runId,configVersion:a.configVersion,cooldownMs:0},c.instanceId).allowed,false,'a delayed pre-Enter wait cannot alter retry state');
 const snapshot=f.manager.snapshot();assert.equal(snapshot.attempts.length,1);assert.equal(snapshot.attempts[0].status,'permitted');assert.equal(snapshot.attempts[0].sendRetryCount,1);assert.equal(snapshot.groups[0].cursor,0);assert.equal(snapshot.channels[0].playlistIndex,0);
 f.result(c,a);assert.equal(f.manager.snapshot().channels[0].playlistIndex,1);f.manager.close();
});

test('retry sequence and active run gates deny stale or unauthorized waits',()=>{
 const f=fixture();f.manager.execute('settings.update',{maxSendRetries:1});const c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);
 const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
 const wait=(retryCount,extra={})=>f.manager.bridge({type:'DELIVERY_WAIT',sessionId:c.sessionId,attemptId:a.id,runId:a.runId,configVersion:a.configVersion,retryPhase:true,retryCount,cooldownMs:0,elapsedMs:0,...extra},c.instanceId);
 assert.equal(f.manager.bridge({type:'AUTHORIZE_ENTER',sessionId:c.sessionId,attemptId:a.id,runId:a.runId,configVersion:a.configVersion,retryCount:0},c.instanceId).allowed,true);
 for(const count of [0,2,1.2,'1',100])assert.equal(wait(count).allowed,false);
 assert.equal(wait(1,{runId:'wrong'}).allowed,false);assert.equal(wait(1,{configVersion:100}).allowed,false);
 assert.equal(wait(1).allowed,true);assert.equal(wait(2).allowed,false);
 f.manager.execute('group.pause',{id:g.id});assert.equal(wait(1).allowed,false);
 f.manager.close();
});

test('automatic recovery respects durable central attempts even if the executor lost local history',()=>{
 const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);const a=f.manager.snapshot().attempts[0];
 assert.equal(f.manager.bridge({type:'RECOVERY_STATUS',sessionId:c.sessionId},c.instanceId).allowed,false);
 f.result(c,a,'not_sent',{executionBlocked:true});assert.equal(f.manager.bridge({type:'RECOVERY_STATUS',sessionId:c.sessionId},c.instanceId).allowed,true);f.manager.close();
});


test('separate windows requires new capability and fences starts until applied ACK',()=>{
 const old=fixture(),legacy=old.connect('a','channel',['managed-window-v1']);
 assert.throws(()=>old.manager.execute('channel.separate',{id:legacy.channel.id}),{code:'EXTENSION_UPDATE_REQUIRED'});old.manager.close();
 const f=fixture(),c=f.connect('a','channel',['managed-window-v1','managed-window-separation-v1']);f.apply(c,[f.message()]);const g=f.group([c]);
 const result=f.manager.execute('channel.separate',{id:c.channel.id});
 assert.equal(f.manager.commands(c.instanceId).find(cmd=>cmd.id===result.commandId).payload.action,'separate');
 assert.throws(()=>f.manager.execute('group.start',{id:g.id}),{code:'WINDOW_MANAGEMENT_PENDING'});
 f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:result.commandId,status:'received'},c.instanceId);
 assert.throws(()=>f.manager.execute('group.start',{id:g.id}),{code:'WINDOW_MANAGEMENT_PENDING'});
 f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:result.commandId,status:'applied'},c.instanceId);
 f.manager.execute('group.start',{id:g.id});
 assert.throws(()=>f.manager.execute('channel.separate',{id:c.channel.id}),{code:'GROUP_RUNNING'});f.manager.close();
});

test('pre-permit preparation timeout safely retries the same turn with bounded backoff and never reports delivery unknown',()=>{
 const f=fixture(),c=f.connect('A','channel',['central-v1','early-prepare-v1']);f.apply(c,[f.message('A'),f.message('B')]);
 f.manager.execute('settings.update',{maxSendRetries:1});const g=f.group([c]);f.start(g);
 const heartbeat=()=>f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId},c.instanceId);
 const advance=ms=>{for(let remaining=ms;remaining>0;){const step=Math.min(1000,remaining);f.advance(step);heartbeat();f.manager.tick();remaining-=step;}};
 const first=f.manager.snapshot().attempts[0];advance(31000);
 let s=f.manager.snapshot();assert.equal(s.attempts[0].status,'not_sent');assert.equal(s.attempts[0].reasonCode,'PREPARE_TIMEOUT');assert.equal(s.groups[0].status,'running');assert.equal(s.groups[0].cursor,0);assert.equal(s.channels[0].playlistIndex,0);assert.equal(s.attempts.length,1);
 assert.throws(()=>f.prepared(c,first),{code:'ATTEMPT_STATE'});
 advance(5000);s=f.manager.snapshot();assert.equal(s.attempts.length,2);assert.equal(s.attempts[1].playlistIndex,0);
 advance(31000);s=f.manager.snapshot();assert.equal(s.attempts[1].status,'not_sent');assert.equal(s.groups[0].status,'running');
 advance(5000);advance(31000);advance(5000);advance(31000);s=f.manager.snapshot();assert.equal(s.attempts[3].status,'not_sent');assert.equal(s.groups[0].status,'running');assert.equal(s.groups[0].activeAttemptId,null);
 assert.equal(s.incidents.some(i=>i.code==='delivery_unknown'),false);assert.equal(s.incidents.filter(i=>i.status==='open').length,0);
 advance(30000);assert.equal(f.manager.snapshot().attempts.length,5);f.manager.close();
});

test('preparation rejection before permit retries only transient errors and repeated ACK is idempotent',()=>{
 for(const [reason,retry]of [['PREPARE_EDITOR_UNSTABLE',true],['CONTENT_INSPECTION_TIMEOUT',true],['DRAFT_MISMATCH',false]]){
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));
  const command=f.manager.commands(c.instanceId).find(x=>x.type==='PREPARE');const ack={type:'ACK',sessionId:c.sessionId,commandId:command.id,status:'rejected',rejectionCode:reason};
  f.manager.bridge(ack,c.instanceId);const before=f.manager.snapshot();f.manager.bridge(ack,c.instanceId);const s=f.manager.snapshot();
  assert.equal(s.attempts[0].status,'not_sent');assert.equal(s.groups[0].status,retry?'running':'paused');assert.deepEqual(s.incidents,before.incidents);assert.equal(s.incidents.some(i=>i.code==='delivery_unknown'),false);f.manager.close();
 }
});

test('preparation rejection after a permit stays unknown and is never automatically retried',()=>{
 const f=fixture(),c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
 const command=f.manager.commands(c.instanceId).find(x=>x.type==='COMMIT_PERMIT');f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:command.id,status:'rejected',rejectionCode:'PREPARE_TIMEOUT'},c.instanceId);
 assert.equal(f.manager.snapshot().attempts[0].status,'unknown');assert.equal(f.manager.snapshot().groups[0].status,'needs_review');f.manager.close();
});

test('retry cancellation reasons survive the executor-to-service boundary',()=>{
 for(const reason of ['RETRY_CANCELLED','RETRY_DELIVERY_AMBIGUOUS']){
  const f=fixture(),c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
  f.result(c,a,'unknown',{reasonCode:reason,executionBlocked:true});
  assert.equal(f.manager.snapshot().attempts[0].reasonCode,reason);f.manager.close();
 }
});

test('stopAll stops group execution while the service stays ready for a later group start',()=>{
 const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.manager.execute('group.start',{id:g.id});
 assert.equal(f.manager.execute('service.stopAll').status,'ready');
 let s=f.manager.snapshot();assert.equal(s.service.status,'ready');assert.equal(s.groups[0].status,'stop_pending');
 f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,0);
 assert.throws(()=>f.manager.execute('group.start',{id:g.id}),{code:'CONTROL_PENDING'});
 const control=f.manager.commands(c.instanceId).findLast(cmd=>cmd.type==='CONTROL');
 f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:control.id,status:'applied',executionBlocked:true},c.instanceId);
 for(let i=0;i<3;i++){f.advance(1000);f.manager.tick();}
 s=f.manager.snapshot();assert.equal(s.groups[0].status,'stopped');assert.equal(s.attempts.length,0);
 assert.doesNotThrow(()=>f.manager.execute('group.start',{id:g.id}));f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);f.manager.close();
});

test('legacy stopped service migrates to ready on startup without automatically starting any group',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dico-service-ready-')),databasePath=join(dir,'state.sqlite');
 try{
  const f=fixture({databasePath}),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.manager.close();
  const store=new CentralStore(databasePath),state=store.read();state.service.status='stopped';state.stateVersion++;store.commit(state,[]);store.close();
  const reopened=fixture({databasePath});let s=reopened.manager.snapshot();assert.equal(s.service.status,'ready');assert.equal(s.groups[0].status,'stopped');
  reopened.manager.tick();s=reopened.manager.snapshot();assert.equal(s.attempts.length,0);assert.equal(s.commands.some(cmd=>['PREPARE','COMMIT_PERMIT'].includes(cmd.type)&&['queued','received'].includes(cmd.status)),false);
  assert.throws(()=>reopened.manager.execute('group.start',{id:g.id}),{code:'CONNECTION_LOST'});reopened.manager.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('clock gap keeps the service ready but revokes old permits and never restarts affected groups',()=>{
 const f=fixture(),c=f.connect();f.apply(c,[f.message()]);const g=f.group([c]);f.start(g);const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
 f.advance(16000);f.manager.tick();const s=f.manager.snapshot();assert.equal(s.service.status,'ready');assert.equal(s.attempts[0].status,'unknown');assert.equal(s.groups[0].status,'pause_pending');
 assert.equal(f.manager.bridge({type:'AUTHORIZE_ENTER',sessionId:c.sessionId,attemptId:a.id,runId:a.runId,configVersion:a.configVersion},c.instanceId).allowed,false);
 f.advance(1000);f.manager.tick();assert.equal(f.manager.snapshot().attempts.length,1);assert.equal(f.manager.snapshot().groups[0].status,'pause_pending');f.manager.close();
});

test('HELLO persists the exact validated extension build in the public instance record and clears stale missing evidence',()=>{
 const f=fixture(),first='a'.repeat(64),second='b'.repeat(64);
 const connection=f.manager.bridge({type:'HELLO',protocolVersion:1,extensionVersion:'0.4.16',extensionBuildId:first});
 assert.equal(f.manager.snapshot().instances[0].extensionBuildId,first);
 f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:connection.instanceId,extensionBuildId:second});
 assert.equal(f.manager.snapshot().instances[0].extensionBuildId,second);
 for(const extensionBuildId of ['bad','a'.repeat(65),42,null])assert.throws(()=>f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:connection.instanceId,extensionBuildId}),{code:'VALIDATION'});
 assert.equal(f.manager.snapshot().instances[0].extensionBuildId,second);
 f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:connection.instanceId});
 assert.equal(f.manager.snapshot().instances[0].extensionBuildId,undefined);f.manager.close();
});

const clearedComposerEvidence=()=>({phase:'commit',stage:'observe',submitMethod:'keyboard',enterAttempted:true,expectedDraftSubmitted:true,composerCleared:true,sameEditor:true,targetMatched:true,accountMatched:true,failedSeen:false,composerRetained:false});
for(const reasonCode of ['ACCOUNT_UNVERIFIED','COOLDOWN_UNVERIFIED','DRAFT_INSPECTION_UNAVAILABLE'])test(`허가 전 일시 ${reasonCode}는 같은 차례로 상한 없이 준비를 복구한다`,()=>{
 const f=fixture();try{
  const c=f.connect();f.apply(c,[f.message('one'),f.message('two')]);const g=f.group([c]);f.start(g);
  for(let n=0;n<6;n++){
   const a=f.manager.snapshot().attempts.at(-1),cmd=f.manager.commands(c.instanceId).find(cmd=>cmd.type==='PREPARE'&&cmd.payload.attemptId===a.id);assert.ok(cmd);
   f.manager.bridge({type:'ACK',sessionId:c.sessionId,commandId:cmd.id,status:'rejected',rejectionCode:reasonCode},c.instanceId);
   assert.equal(f.manager.snapshot().groups[0].status,'running');assert.equal(f.manager.snapshot().channels[0].playlistIndex,0);
   f.advance(5000);f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId},c.instanceId);f.manager.tick();
  }
  const a=f.manager.snapshot().attempts.at(-1);f.prepared(c,a);f.result(c,a);assert.equal(f.manager.snapshot().channels[0].playlistIndex,1);
 }finally{f.manager.close();}
});

for(const userStop of [false,true])test(`Enter 전임이 입증된 일시 쿨다운 오류는 차례를 유지하고 복구한다 (중지 ${userStop})`,()=>{
 const f=fixture();try{
  const c=f.connect();f.apply(c,[f.message('one'),f.message('two')]);const g=f.group([c]);f.start(g);const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
  if(userStop)f.manager.execute('group.stop',{id:g.id});
  f.result(c,a,'not_sent',{executionBlocked:true,reasonCode:'COOLDOWN_UNVERIFIED',deliveryEvidence:{phase:'commit',stage:'stable',enterAttempted:false}});
  assert.equal(f.manager.snapshot().groups[0].status,userStop?'stop_pending':'running');assert.equal(f.manager.snapshot().channels[0].playlistIndex,0);
  f.advance(5000);f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId},c.instanceId);f.manager.tick();
  assert.equal(f.manager.snapshot().attempts.length,userStop?1:2);
  if(!userStop){const next=f.manager.snapshot().attempts.at(-1);assert.equal(next.messageIdRef,a.messageIdRef);f.prepared(c,next);f.result(c,next);assert.equal(f.manager.snapshot().channels[0].playlistIndex,1);}
 }finally{f.manager.close();}
});

test('Enter를 시도한 결과는 실행 차단 응답만으로 미발송 처리하지 않는다',()=>{
 const f=fixture();try{
  const c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
  assert.throws(()=>f.result(c,a,'not_sent',{executionBlocked:true,deliveryEvidence:{phase:'commit',stage:'observe',enterAttempted:true}}),{code:'EXECUTION_UNCERTAIN'});
  assert.equal(f.manager.snapshot().attempts[0].status,'permitted');assert.equal(f.manager.snapshot().channels[0].playlistIndex,0);
 }finally{f.manager.close();}
});

for(const patch of [{stage:'invalid'},{stage:'observe'},{expectedDraftSubmitted:true},{retryCount:1}])test(`모순되거나 불완전한 Enter 전 근거는 자동 재준비하지 않는다 ${JSON.stringify(patch)}`,()=>{
 const f=fixture();try{
  const c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
  f.result(c,a,'not_sent',{executionBlocked:true,reasonCode:'COOLDOWN_UNVERIFIED',deliveryEvidence:{phase:'commit',stage:'stable',enterAttempted:false,...patch}});
  f.advance(5000);f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId},c.instanceId);f.manager.tick();
  assert.equal(f.manager.snapshot().attempts.length,1);assert.notEqual(f.manager.snapshot().groups[0].status,'running');
 }finally{f.manager.close();}
});
test('탭 실행 코드 관측은 설치 버전과 분리하고 오래된 관측·새 세션을 미확인으로 표시한다',()=>{
 const f=fixture();try{
  const c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];
  const observedAt=f.manager.snapshot().serverNow;
  f.manager.bridge({type:'DELIVERY_TRACE',sessionId:c.sessionId,attemptId:a.id,sequence:1,observedAt,stage:'received',data:{contentVersion:'0.4.12',contentBuildId:'a'.repeat(64)}},c.instanceId);
  let code=f.manager.snapshot().channels[0].pageCode;
  assert.deepEqual(code,{state:'observed',version:'0.4.12',buildId:'a'.repeat(64),observedAt});
  f.advance(30001);code=f.manager.snapshot().channels[0].pageCode;assert.equal(code.state,'stale');assert.equal(code.version,'0.4.12');
  f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:c.instanceId});
  assert.deepEqual(f.manager.snapshot().channels[0].pageCode,{state:'unknown'});
 }finally{f.manager.close();}
});
test('입력창 비움 증명은 메시지 ID 없이 한 번만 다음 문구로 진행하고 근거를 보존한다',()=>{
 const f=fixture();try{
  const c=f.connect();f.apply(c,[f.message('A'),f.message('B')]);f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
  const receipt={messageId:undefined,confirmationBasis:'composer_cleared',deliveryEvidence:clearedComposerEvidence(),confirmationMs:500};f.result(c,a,'confirmed',receipt);f.result(c,a,'confirmed',receipt);
  const state=f.manager.snapshot(),saved=state.attempts[0];assert.equal(saved.status,'confirmed');assert.equal(saved.confirmationBasis,'composer_cleared');assert.equal(saved.messageId,undefined);assert.equal(state.channels[0].playlistIndex,1);assert.equal(saved.deliveryEvidence.emptyStableMs,undefined);
  assert.equal(f.manager.events({type:'delivery.confirmed'}).length,1);assert.equal(f.manager.events({type:'delivery.confirmed'})[0].confirmationBasis,'composer_cleared');
  const terminal=f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId,knownAttemptIds:[a.id]},c.instanceId).terminalAttempts[0];assert.equal(terminal.messageId,undefined);assert.equal(terminal.confirmationBasis,'composer_cleared');assert.equal(terminal.deliveryEvidence.composerCleared,true);
 }finally{f.manager.close();}
});
test('미제출·다른 입력창·계정·대상·실패은 입력창 비움 성공으로 인정하지 않는다',()=>{
 const f=fixture();try{
  const c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
  const invalid=[{enterAttempted:false},{expectedDraftSubmitted:false},{composerCleared:false},{sameEditor:false},{targetMatched:false},{accountMatched:false},{composerRetained:true},{phase:'prepare'},{stage:'inspect'},{submitMethod:undefined}];
  for(const patch of invalid)assert.throws(()=>f.result(c,a,'confirmed',{messageId:undefined,confirmationBasis:'composer_cleared',deliveryEvidence:{...clearedComposerEvidence(),...patch}}),{code:'EVIDENCE_REQUIRED'});
  assert.equal(f.manager.snapshot().attempts[0].status,'permitted');assert.equal(f.manager.snapshot().channels[0].playlistIndex,0);
 }finally{f.manager.close();}
});
test('새 입력창 비움 기준을 과거 unknown 시도나 허가 전 준비 상태에 소급 적용하지 않는다',()=>{
 for(const unknown of [false,true]){const f=fixture();try{
  const c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];if(unknown){f.prepared(c,a);f.result(c,a,'unknown');}
  assert.throws(()=>f.result(c,a,'confirmed',{messageId:undefined,confirmationBasis:'composer_cleared',deliveryEvidence:clearedComposerEvidence()}),{code:'EVIDENCE_REQUIRED'});assert.equal(f.manager.snapshot().attempts[0].status,unknown?'unknown':'preparing');
 }finally{f.manager.close();}}
});

test('보존기간 정리와 재시작 이후에도 입력창 비움 근거를 유지하며 게시 메시지 ID를 만들지 않는다',()=>{
 const directory=mkdtempSync(join(tmpdir(),'dico-receipt-retention-')),databasePath=join(directory,'central.sqlite');let manager;
 try{
  const f=fixture({databasePath});manager=f.manager;const c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const attempt=manager.snapshot().attempts[0];f.prepared(c,attempt);
  f.result(c,attempt,'confirmed',{messageId:undefined,confirmationBasis:'composer_cleared',deliveryEvidence:clearedComposerEvidence()});
  assert.equal(JSON.parse(JSON.stringify(manager.analytics())).timeline[0].confirmationBasis,'composer_cleared');
  const retainedRecord=()=>{const store=new CentralStore(databasePath);try{return store.read().attempts.find(item=>item.id===attempt.id);}finally{store.close();}};
  f.advance(91*86400000);manager.execute('maintenance.prune');
  const record=retainedRecord();assert.equal(record.pruned,true);assert.equal(record.confirmationBasis,'composer_cleared');assert.equal(record.messageId,undefined);assert.equal(record.deliveryEvidence,undefined);
  const receipt=manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId,knownAttemptIds:[attempt.id]},c.instanceId).terminalAttempts[0];assert.equal(receipt.confirmationBasis,'composer_cleared');assert.equal(receipt.messageId,undefined);
  manager.close();manager=createCentralManager({databasePath,now:()=>1_800_000_000_000+91*86400000,monotonicNow:()=>1000});
  const restored=retainedRecord();assert.equal(restored.confirmationBasis,'composer_cleared');assert.equal(restored.messageId,undefined);assert.equal(restored.pruned,true);
 }finally{manager?.close();rmSync(directory,{recursive:true,force:true});}
});

test('정상 미발송 진행은 기존 상한 10회를 넘어 계속하되 사용자 중지는 즉시 차단한다',()=>{
 const f=fixture();try{
  const c=f.connect();f.apply(c,[f.message('A'),f.message('B')]);const group=f.group([c]);f.start(group);const a=f.manager.snapshot().attempts[0];assert.equal(a.maxSendRetries,null);f.prepared(c,a);
  const authorize=retryCount=>f.manager.bridge({type:'AUTHORIZE_ENTER',sessionId:c.sessionId,attemptId:a.id,runId:a.runId,configVersion:a.configVersion,retryCount},c.instanceId);
  const progress=(retryCount,cooldownMs=0,elapsedMs=0)=>f.manager.bridge({type:'DELIVERY_WAIT',sessionId:c.sessionId,attemptId:a.id,runId:a.runId,configVersion:a.configVersion,retryPhase:true,retryCount,cooldownMs,elapsedMs},c.instanceId);
  assert.equal(authorize(0).allowed,true);assert.equal(progress(1,60000).allowed,true);
  for(let elapsed=10000;elapsed<=23_410_000;elapsed+=10000){f.advance(10000);f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId},c.instanceId);f.manager.tick();assert.equal(progress(1,60000,elapsed).allowed,true);}
  assert.equal(progress(1,0,23_410_000).allowed,true);assert.equal(authorize(1).allowed,true);
  for(let retry=2;retry<=12;retry++){assert.equal(progress(retry).allowed,true);assert.equal(authorize(retry).allowed,true);}
  const state=f.manager.snapshot();assert.equal(state.attempts[0].status,'permitted');assert.equal(state.attempts[0].sendRetryCount,12);assert.equal(state.channels[0].playlistIndex,0);
  f.manager.execute('group.stop',{id:group.id});assert.equal(progress(13).allowed,false);assert.equal(authorize(12).allowed,false);
 }finally{f.manager.close();}
});
test('입력 상태별 종료 사유와 과거 무제한 재시도 진단은 원문 없이 그대로 보존한다',()=>{
 for(const reasonCode of ['DISCORD_SEND_FAILED','COMPOSER_EDITOR_MISSING','COMPOSER_EDITOR_CHANGED','COMPOSER_DRAFT_CHANGED','COMPOSER_STATE_UNREADABLE']){
  const f=fixture();try{const c=f.connect();f.apply(c,[f.message()]);f.start(f.group([c]));const a=f.manager.snapshot().attempts[0];f.prepared(c,a);
   f.result(c,a,'unknown',{reasonCode,deliveryEvidence:{phase:'commit',stage:'observe',enterAttempted:true,editorPresent:true,sameEditor:false,composerEmpty:false,expectedDraftSubmitted:true,targetMatched:true,accountMatched:true,retryCount:8,maxSendRetries:null,privateText:'must not retain'}});
   const result=f.manager.snapshot().attempts[0];assert.equal(result.reasonCode,reasonCode);assert.equal(result.deliveryEvidence.maxSendRetries,null);assert.equal(result.deliveryEvidence.retryCount,8);assert.equal(result.deliveryEvidence.sameEditor,false);assert.equal(result.deliveryEvidence.privateText,undefined);
  }finally{f.manager.close();}
 }
});
test('delivery stage telemetry is scoped, deduplicated, redacted and never advances a sending turn',()=>{
 const f=fixture();try{const c=f.connect('111','222');f.apply(c,[f.message('Actual immutable text')]);const g=f.group([c]);f.start(g);const a=f.manager.snapshot().attempts[0];const trace={type:'DELIVERY_TRACE',sessionId:c.sessionId,attemptId:a.id,sequence:1,stage:'before-enter',observedAt:a.createdAt,data:{draftLength:21,draftEmpty:false,textContext:{actual:'private draft'},body:'never trace this',token:'secret',sameComposer:true,editorReacquired:true}};
 assert.equal(f.manager.bridge(trace,c.instanceId).recorded,true);assert.equal(f.manager.bridge(trace,c.instanceId).recorded,false);
 const events=f.manager.events({type:'delivery.trace'});assert.equal(events.length,1);assert.equal(events[0].data.draftLength,21);assert.equal(events[0].data.sameComposer,true);assert.equal(events[0].data.editorReacquired,true);assert.equal(events[0].data.body,undefined);assert.equal(events[0].data.textContext,undefined);assert.equal(events[0].data.token,undefined);assert.equal(f.manager.snapshot().groups[0].cursor,0);assert.equal(f.manager.snapshot().attempts[0].status,'preparing');
 const other=f.connect('333','444');assert.throws(()=>f.manager.bridge({...trace,sessionId:other.sessionId,sequence:2},other.instanceId),{code:'STALE_ATTEMPT'});
 }finally{f.manager.close();}
});

test('반복 초안 판독 실패는 초안과 문구 순서를 보존하고 다음 계정으로 넘어간다',()=>{
 const f=fixture();try{
  const a=f.connect('A'),b=f.connect('B');f.apply(a,[f.message('A1'),f.message('A2')]);f.apply(b,[f.message('B1')]);
  f.start(f.group([a,b],20000));
  const tick=ms=>{f.advance(ms);for(const c of [a,b])f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId},c.instanceId);f.manager.tick();};
  for(let n=0;n<3;n++){
   const attempt=f.manager.snapshot().attempts.at(-1);
   assert.equal(attempt.accountId,'A');
   const cmd=f.manager.commands(a.instanceId).find(c=>c.type==='PREPARE'&&c.payload.attemptId===attempt.id);
   f.manager.bridge({type:'ACK',sessionId:a.sessionId,commandId:cmd.id,status:'rejected',rejectionCode:'DRAFT_INSPECTION_UNAVAILABLE',draftInspectionCode:n===0?'UNAPPROVED_CODE':'EDITOR_LOADING'},a.instanceId);
   const ack=f.manager.events({type:'command.ack'}).find(e=>e.commandId===cmd.id);
   assert.equal(ack?.draftInspectionCode,n===0?undefined:'EDITOR_LOADING');
   if(n<2)tick(5000);
  }
  assert.equal(f.manager.snapshot().groups[0].cursor,1);
  assert.equal(f.manager.snapshot().channels.find(c=>c.id===a.channel.id).playlistIndex,0);
  tick(10000);tick(9999);assert.equal(f.manager.snapshot().attempts.length,3);
  tick(1);assert.equal(f.manager.snapshot().attempts.at(-1).accountId,'B');
 }finally{f.manager.close();}
});

test('서로 다른 Enter 전 실패가 반복되어도 다음 계정이 진행하고 이전 차례를 다시 승인하지 않는다', t=>{
 const f=fixture();t.after(()=>f.manager.close());
 const a=f.connect('A'),b=f.connect('B');
 const [a1,a2,b1,b2]=['A1','A2','B1','B2'].map(name=>f.message(name));
 f.apply(a,[a1,a2]);f.apply(b,[b1,b2]);f.start(f.group([a,b],20000));
 const tick=ms=>{
  while(ms>0){
   const step=Math.min(ms,5000);ms-=step;f.advance(step);
   for(const c of [a,b])f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId},c.instanceId);
   f.manager.tick();
  }
 };
 const rejected=[];
 for(const reasonCode of ['DRAFT_INSPECTION_UNAVAILABLE','CONTENT_INSPECTION_TIMEOUT','COOLDOWN_UNVERIFIED']){
  const attempt=f.manager.snapshot().attempts.at(-1);
  assert.equal(attempt.messageIdRef,a1.id);rejected.push(attempt);
  if(reasonCode==='COOLDOWN_UNVERIFIED'){
   assert.ok(f.prepared(a,attempt).permitId);
   f.result(a,attempt,'not_sent',{executionBlocked:true,reasonCode,deliveryEvidence:{phase:'commit',stage:'stable',enterAttempted:false}});
  }else{
   const cmd=f.manager.commands(a.instanceId).find(c=>c.type==='PREPARE'&&c.payload.attemptId===attempt.id);
   f.manager.bridge({type:'ACK',sessionId:a.sessionId,commandId:cmd.id,status:'rejected',rejectionCode:reasonCode},a.instanceId);
   tick(5000);
  }
 }
 assert.equal(f.manager.snapshot().groups[0].cursor,1);
 tick(19999);assert.equal(f.manager.snapshot().attempts.length,3);
 tick(1);
 for(const [peer,message] of [[b,b1],[a,a1],[b,b2],[a,a2]]){
  const next=f.manager.snapshot().attempts.at(-1);
  assert.equal(next.accountId,peer.channel.accountId);
  assert.equal(next.messageIdRef,message.id);
  for(const previous of rejected){
   assert.equal(f.manager.bridge({type:'AUTHORIZE_ENTER',sessionId:a.sessionId,attemptId:previous.id,runId:previous.runId,configVersion:previous.configVersion,retryCount:0},a.instanceId).allowed,false);
   f.result(a,previous,'not_sent',{executionBlocked:true});
  }
  assert.equal(f.manager.snapshot().groups[0].activeAttemptId,next.id);
  f.prepared(peer,next);f.result(peer,next);tick(20000);
 }
});

test('중앙 타임아웃만 반복되면 로컬 종료 근거 없이 계정 차례를 넘기지 않는다', t=>{
 const f=fixture();t.after(()=>f.manager.close());
 const a=f.connect('A'),b=f.connect('B');
 f.apply(a,[f.message('A1')]);f.apply(b,[f.message('B1')]);f.start(f.group([a,b],20000));
 for(let n=0;n<24;n++){
  f.advance(5000);
  for(const c of [a,b])f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId},c.instanceId);
  f.manager.tick();
 }
 const state=f.manager.snapshot();
 assert.ok(state.attempts.filter(a=>a.reasonCode==='PREPARE_TIMEOUT').length>=3);
 assert.equal(state.groups[0].cursor,0);
 assert.ok(state.attempts.every(a=>a.accountId==='A'));
});

test('구버전 준비 거절만으로는 계정 차례를 넘기지 않고 차단 확인을 받은 뒤 진행한다', t=>{
 const f=fixture();t.after(()=>f.manager.close());
 const a=f.connect('A'),b=f.connect('B');
 f.apply(a,[f.message('A1')]);f.apply(b,[f.message('B1')]);f.start(f.group([a,b],20000));
 for(let n=0;n<4;n++){
  const attempt=f.manager.snapshot().attempts.at(-1);
  assert.equal(attempt.accountId,'A');
  const cmd=f.manager.commands(a.instanceId).find(c=>c.type==='PREPARE'&&c.payload.attemptId===attempt.id);
  f.manager.bridge({type:'ACK',sessionId:a.sessionId,commandId:cmd.id,status:'rejected',rejectionCode:'PREPARE_EDITOR_UNSTABLE',...(n===3?{executionBlocked:true}:{})},a.instanceId);
  assert.equal(f.manager.snapshot().groups[0].cursor,n===3?1:0);
  if(n<3){
   f.advance(5000);
   for(const c of [a,b])f.manager.bridge({type:'HEARTBEAT',sessionId:c.sessionId},c.instanceId);
   f.manager.tick();
  }
 }
});
