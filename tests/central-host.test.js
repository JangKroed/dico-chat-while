import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { mkdtemp, writeFile, chmod, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePacket, readPackets, validateOrigin, validatePacket } from '../central/host/protocol.mjs';
import { readDescriptor, dataDirectory } from '../central/host/paths.mjs';
import { createServer } from 'node:http';
import { bridgeRequest, connectService } from '../central/host/service.mjs';
import { runNativeHost } from '../central/host/main.mjs';
import { startCentralRuntime } from '../central/runtime/main.mjs';

test('native frames survive split writes and reject oversized input', async () => {
  const stream = new PassThrough();
  const packets = readPackets(stream);
  const frame = encodePacket({ requestId: 'r1', message: { type: 'HELLO', protocolVersion: 1 } });
  stream.write(frame.subarray(0, 3));
  stream.write(frame.subarray(3, 9));
  stream.end(frame.subarray(9));
  assert.deepEqual((await packets.next()).value, { requestId: 'r1', message: { type: 'HELLO', protocolVersion: 1 } });
  assert.equal((await packets.next()).done, true);
  const bad = new PassThrough();
  const malformed = readPackets(bad);
  const header = Buffer.alloc(4); header.writeUInt32LE(1024 * 1024 + 1);
  bad.end(header);
  await assert.rejects(malformed.next(), /size/);
});

test('only configured extension origin and shaped messages are accepted', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  assert.equal(validateOrigin(`chrome-extension://${id}/`, [id]), id);
  assert.throws(() => validateOrigin('https://evil.example/', [id]), /origin/);
  assert.throws(() => validateOrigin('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/', [id]), /origin/);
  assert.deepEqual(validatePacket({ requestId: 'x', message: { type: 'HEARTBEAT' } }), { requestId: 'x', message: { type: 'HEARTBEAT' } });
  assert.equal(validatePacket({requestId:'identity',message:{type:'ACCOUNT_OBSERVATION',accountId:'123456789012345678',verified:true}}).message.type,'ACCOUNT_OBSERVATION');
  assert.equal(validatePacket({ requestId: 'a', message: { type: 'AUTHORIZE_ENTER', attemptId: 'attempt-1' } }).message.type, 'AUTHORIZE_ENTER');
  assert.throws(() => validatePacket({ requestId: 'x', message: { type: 'SHELL' } }), /message/);
  assert.throws(() => validatePacket({ requestId: 'x', message: { type: 'HELLO', bridgeToken: 'secret' } }), /secret/);
});

test('descriptor is private and restricted to loopback with complete fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dico-host-test-'));
  try {
    const file = join(dir, 'runtime.json');
    await writeFile(file, JSON.stringify({ protocolVersion: 1, url: 'http://127.0.0.1:43210', pid: 42, bridgeToken: 'secure-token' }), { mode: 0o600 });
    assert.equal((await readDescriptor(dir)).url, 'http://127.0.0.1:43210');
    await chmod(file, 0o644);
    if (process.platform !== 'win32') await assert.rejects(readDescriptor(dir), /private/);
    await chmod(file, 0o600);
    await writeFile(file, JSON.stringify({ protocolVersion: 1, url: 'http://example.com:43210', pid: 42, bridgeToken: 'secure-token' }));
    await assert.rejects(readDescriptor(dir), /descriptor/);
    await writeFile(file, JSON.stringify({ protocolVersion: 1, url: 'http://user:password@127.0.0.1:43210', pid: 42, bridgeToken: 'secure-token' }));
    await assert.rejects(readDescriptor(dir), /descriptor/);
  } finally { await rm(dir, { recursive: true, force: true }); }
  assert.equal(dataDirectory('darwin', '/Users/someone', {}), '/Users/someone/Library/Application Support/DICO');
  assert.equal(dataDirectory('win32', 'C:\\Users\\someone', { LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local' }), 'C:\\Users\\someone\\AppData\\Local\\DICO');
});

test('authenticated bridge request never includes token in message body', async () => {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ path: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ accepted: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const descriptor = { url: `http://127.0.0.1:${server.address().port}`, bridgeToken: 'test-private-token' };
    assert.deepEqual(await bridgeRequest(descriptor, '/api/bridge', 'POST', { message: { type: 'HEARTBEAT' } }), { accepted: true });
    assert.deepEqual(seen, [{ path: '/api/bridge', authorization: 'Bearer test-private-token', body: '{"message":{"type":"HEARTBEAT"}}' }]);
  } finally { server.close(); }
});

test('native host returns correlated result and delivers HELLO commands', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const received = readPackets(output);
  const requests = [];
  const service = {
    async request(path, method, body) {
      requests.push({ path, body });
      if (path === '/api/bridge') return { instanceId: 'instance-1', sessionId: 'session-1', commands: [{ type: 'CONFIG_SYNC', commandId: 'c1' }] };
      if (path === '/api/bridge/open') return { url: 'http://127.0.0.1:12345/#bootstrap=one-use' };
      return { commands: [] };
    }
  };
  const running = runNativeHost({ input, output, origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/', ids: ['abcdefghijklmnopabcdefghijklmnop'], service });
  input.write(encodePacket({ requestId: 'one', message: { type: 'HELLO', protocolVersion: 1 } }));
  assert.deepEqual((await received.next()).value, { type: 'RESPONSE', requestId: 'one', ok: true, result: { instanceId: 'instance-1', sessionId: 'session-1', commands: [{ type: 'CONFIG_SYNC', commandId: 'c1' }] } });
  assert.deepEqual((await received.next()).value, { type: 'COMMAND', command: { type: 'CONFIG_SYNC', commandId: 'c1' } });
  input.end(encodePacket({ requestId: 'two', message: { type: 'OPEN_DASHBOARD' } }));
  assert.deepEqual((await received.next()).value, { type: 'RESPONSE', requestId: 'two', ok: true, result: { url: 'http://127.0.0.1:12345/#bootstrap=one-use' } });
  await running;
  assert.deepEqual(requests.at(-1), { path: '/api/bridge', body: { instanceId: 'instance-1', message: { type: 'DISCONNECT', sessionId: 'session-1' } } });
});

test('native stdio reaches the real loopback service and closes its session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dico-host-live-'));
  const runtime = await startCentralRuntime({ directory: dir, port:0 });
  try {
    const input = new PassThrough(), output = new PassThrough();
    const packets = readPackets(output);
    const service = await connectService({ dir });
    const running = runNativeHost({ input, output, origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/', ids: ['abcdefghijklmnopabcdefghijklmnop'], service });
    input.end(encodePacket({ requestId: 'live', message: { type: 'HELLO', protocolVersion: 1, name: 'Test browser' } }));
    const response = (await packets.next()).value;
    assert.equal(response.type, 'RESPONSE');
    assert.equal(response.ok, true);
    assert.equal(response.result.protocolVersion, 1);
    await running;
    assert.equal(runtime.manager.snapshot().instances.find(i => i.id === response.result.instanceId).connected, false);
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test('user and update shutdown markers prevent native reconnection from starting service', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dico-host-quit-'));
  try {
    for(const intent of ['user','update']) {
      await writeFile(join(dir, 'shutdown.json'), JSON.stringify({ intent, at: Date.now() }), { mode: 0o600 });
      await assert.rejects(connectService({ dir, node: join(dir, 'missing-node'), timeoutMs: 100 }), /Open DICO manager manually/);
    }
    assert.deepEqual((await readdir(dir)).sort(), ['shutdown.json']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
