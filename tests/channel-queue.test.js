import test from 'node:test';
import assert from 'node:assert/strict';
import {createChannelQueue} from '../channel-queue.js';

test('다른 채널은 독립 실행하고 같은 채널은 실패 후에도 순서를 지킨다', async () => {
  const queue = createChannelQueue();
  const order = [];
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const first = queue.run('a', async () => {order.push('a1'); await gate; throw new Error('failed');});
  const rejected = assert.rejects(first, /failed/);
  const second = queue.run('a', () => order.push('a2'));
  try {
    await queue.run('b', () => order.push('b'));
    assert.deepEqual(order, ['a1','b']);
  } finally {release();}
  await Promise.all([rejected, second]);
  assert.deepEqual(order, ['a1','b','a2']);
});

test('전체 설정 복원은 기존 실행을 기다리고 새 실행은 복원 뒤에 진행한다', async () => {
  const queue = createChannelQueue();
  const order = [];
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const before = queue.run('a', async () => {await gate; order.push('before');});
  const restore = queue.exclusive(() => order.push('restore'));
  const after = queue.run('b', () => order.push('after'));
  await Promise.resolve();
  assert.deepEqual(order, []);
  release();
  await Promise.all([before, restore, after]);
  assert.deepEqual(order, ['before','restore','after']);
});
