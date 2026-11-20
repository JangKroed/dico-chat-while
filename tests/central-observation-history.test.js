import assert from 'node:assert/strict';
import test from 'node:test';
import {createCentralManager} from '../central/core/index.js';

test('반복 관찰은 최근 확인 시각을 갱신하고, 상태가 달라졌을 때만 관찰 로그를 남긴다', t => {
  let time = 1_800_000_000_000;
  let monotonic = 1_000;
  const manager = createCentralManager({now: () => time, monotonicNow: () => monotonic});
  t.after(() => manager.close());

  const instanceId = 'test-browser';
  let sessionId;
  const connect = () => {
    ({sessionId} = manager.bridge({type: 'HELLO', instanceId, protocolVersion: 1}));
  };
  const reportAccount = (accountName = 'Test account') =>
    manager.bridge({type: 'ACCOUNT_OBSERVATION', sessionId, accountId: '123', accountName, verified: true}, instanceId);
  const reportChannel = (verified = true, tabId = 1) =>
    manager.bridge({type: 'OBSERVATION', sessionId, legacyFrozen: true, legacyPending: false,
      channels: [{accountId: '123', guildId: '456', channelId: '789', tabId, verified,
        ...(verified ? {} : {verificationReason: 'tab_loading'})}]}, instanceId);
  const count = type => manager.events({type, limit: 1000}).length;
  const advance = () => { time += 2500; monotonic += 2500; };

  connect();
  reportAccount();
  reportChannel();
  for (let i = 0; i < 30; i++) {
    advance();
    reportAccount();
    reportChannel();
  }
  assert.equal(count('account.observed'), 1);
  assert.equal(count('instance.observed'), 1);
  assert.equal(manager.snapshot().instances[0].lastSeenAt, time);
  assert.equal(manager.snapshot().accounts[0].lastVerifiedAt, time);
  assert.equal(manager.snapshot().channels[0].observedAt, time);

  reportAccount('New name');
  reportChannel(false);
  reportChannel(false);
  reportChannel(true, 2);
  assert.equal(count('account.observed'), 2);
  assert.equal(count('instance.observed'), 3);

  connect();
  reportAccount('New name');
  reportChannel(true, 2);
  assert.equal(count('account.observed'), 3);
  assert.equal(count('instance.observed'), 4);
  assert.equal(manager.snapshot().channels[0].verified, true);
});
