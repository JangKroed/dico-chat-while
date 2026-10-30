import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPlan, install, uninstall, extensionIdFromKey } from '../central/host/install.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';

test('macOS dry run targets per-user Chrome and Brave registrations without writing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dico-install-plan-'));
  try {
    const plan = installPlan({ platform: 'darwin', home: dir, env: {}, source: '/download/DICO', extensionIds: ['abcdefghijklmnopabcdefghijklmnop'] });
    assert.equal(plan.app, join(dir, 'Library/Application Support/DICO/app'));
    assert.deepEqual(plan.manifests, [
      join(dir, 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.dico.manager.json'),
      join(dir, 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.dico.manager.json')
    ]);
    assert.equal(plan.manifest.allowed_origins[0], 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/');
    assert.equal(plan.manifest.path, join(dir, 'Library/Application Support/DICO/app/launcher'));
    assert.equal(plan.autostart.path, join(dir, 'Library/LaunchAgents/com.dico.manager.plist'));
    assert.equal(plan.autostart.enabled, false);
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true }); }
});

test('Windows plan registers only HKCU Chrome and Brave host keys', () => {
  const plan = installPlan({ platform: 'win32', home: 'C:\\Users\\Ada', env: { LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local' }, source: 'C:\\Downloads\\DICO', extensionIds: ['abcdefghijklmnopabcdefghijklmnop'] });
  assert.equal(plan.app, 'C:\\Users\\Ada\\AppData\\Local\\DICO\\app');
  assert.deepEqual(plan.registry, [
    'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.dico.manager',
    'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.dico.manager'
  ]);
  assert.equal(plan.manifest.path, 'C:\\Users\\Ada\\AppData\\Local\\DICO\\app\\launcher.exe');
  assert.equal(plan.autostart.key, 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
  assert.equal(plan.autostart.enabled, false);
  const optedIn = installPlan({ platform: 'win32', home: 'C:\\Users\\Ada', env: { LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local' }, source: 'C:\\Downloads\\DICO', extensionIds: ['abcdefghijklmnopabcdefghijklmnop'], autostart: true });
  assert.equal(optedIn.autostart.enabled, true);
});

test('extension key deterministically pins browser ID and rejects invalid key', () => {
  assert.equal(extensionIdFromKey(Buffer.from('public-key-example').toString('base64')), 'kihebkbhjhlehhpdkmhpdmacccnmbkop');
  assert.throws(() => extensionIdFromKey(''), /key/);
});

test('installer refuses a live service before changing installed files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dico-install-live-'));
  try {
    const source = join(home, 'download');
    await mkdir(source); await writeFile(join(source, 'launcher'), '#!/bin/sh\n');
    const plan = installPlan({ platform: 'darwin', home, source, extensionIds: ['abcdefghijklmnopabcdefghijklmnop'] });
    await mkdir(join(home, 'Library/Application Support/DICO'), { recursive: true });
    await writeFile(join(home, 'Library/Application Support/DICO/runtime.json'), JSON.stringify({ protocolVersion: 1, url: 'http://127.0.0.1:54321', pid: process.pid, bridgeToken: 'private-test-token' }), { mode: 0o600 });
    await assert.rejects(install(plan), /service.*running/i);
    await assert.rejects(uninstall(plan), /service.*running/i);
    assert.deepEqual(await readdir(join(home, 'Library/Application Support/DICO')), ['runtime.json']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('authenticated live status blocks an update even if descriptor PID is stale', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dico-install-status-'));
  const server = createServer((req, res) => {
    assert.equal(req.url, '/api/bridge/status');
    assert.equal(req.headers.authorization, 'Bearer private-test-token');
    res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true,"protocolVersion":1,"busy":false}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const source = join(home, 'download'); await mkdir(source); await writeFile(join(source, 'launcher'), '#!/bin/sh\n');
    const plan = installPlan({ platform: 'darwin', home, source, extensionIds: ['abcdefghijklmnopabcdefghijklmnop'] });
    const data = join(home, 'Library/Application Support/DICO'); await mkdir(data, { recursive: true });
    await writeFile(join(data, 'runtime.json'), JSON.stringify({ protocolVersion: 1, url: `http://127.0.0.1:${server.address().port}`, pid: 999999999, bridgeToken: 'private-test-token' }), { mode: 0o600 });
    await assert.rejects(install(plan), /service.*running/i);
    assert.deepEqual(await readdir(data), ['runtime.json']);
  } finally { server.close(); await rm(home, { recursive: true, force: true }); }
});

test('installer refuses an unreadable descriptor and keeps installation state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dico-install-corrupt-'));
  try {
    const source = join(home, 'download');
    await mkdir(source); await writeFile(join(source, 'launcher'), '#!/bin/sh\n');
    const plan = installPlan({ platform: 'darwin', home, source, extensionIds: ['abcdefghijklmnopabcdefghijklmnop'] });
    const data = join(home, 'Library/Application Support/DICO');
    await mkdir(data, { recursive: true }); await writeFile(join(data, 'runtime.json'), '{corrupt', { mode: 0o600 });
    await assert.rejects(install(plan), /descriptor/i);
    await assert.rejects(uninstall(plan), /descriptor/i);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('install creates a private data directory and tightens existing mode', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dico-install-private-'));
  try {
    const source = join(home, 'download');
    await mkdir(source); await writeFile(join(source, 'launcher'), '#!/bin/sh\n');
    await writeFile(join(source, 'allowed_extensions.json'), JSON.stringify({ extensionIds: ['abcdefghijklmnopabcdefghijklmnop'] }));
    const plan = installPlan({ platform: 'darwin', home, source, extensionIds: ['abcdefghijklmnopabcdefghijklmnop'] });
    const data = join(home, 'Library/Application Support/DICO');
    await mkdir(data, { recursive: true, mode: 0o755 });
    await install(plan);
    assert.equal((await stat(data)).mode & 0o077, 0);
    assert.equal((await stat(join(data, 'app/launcher'))).isFile(), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});
