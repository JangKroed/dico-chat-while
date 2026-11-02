import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, win32 } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { browserCandidates, checkInstallation, formatInstallationCheck } from '../central/host/check-installation.mjs';
import { extensionIdFromKey } from '../central/host/install.mjs';
const bundleManifest = JSON.parse(await readFile(new URL('../central/extension/manifest.json', import.meta.url), 'utf8'));
const allowed_origins = [`chrome-extension://${extensionIdFromKey(bundleManifest.key)}/`];

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dico-readonly-check-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, 'Library/Application Support/DICO');
  return { home, directory, app: join(directory, 'app'), options: { platform: 'darwin', arch: 'arm64', home, env: {}, candidates: [] } };
}
async function put(file, content = '') { await mkdir(dirname(file), { recursive: true }); await writeFile(file, content); }
async function snapshot(directory) {
  const result = {};
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, item.name);
    result[item.name] = item.isDirectory() ? await snapshot(file) : await readFile(file, 'utf8');
  }
  return result;
}

test('check leaves a blank home empty and never launches the runtime', async t => {
  const f = await fixture(t);
  const result = await checkInstallation({ ...f.options, request: () => { throw new Error('must not request without a descriptor'); } });
  assert.equal(result.installation, 'missing');
  assert.equal(result.runtime, 'no-record');
  assert.deepEqual(await readdir(f.home), []);
  assert.equal(result.extension, join(f.app, 'extension'));
});

test('old data and registrations do not imply an installed application', async t => {
  const f = await fixture(t);
  await put(join(f.directory, 'central.sqlite'), 'opaque preserved database');
  await put(join(f.home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.dico.manager.json'), JSON.stringify({ name: 'com.dico.manager', type: 'stdio', allowed_origins, path: join(f.app, 'launcher') }));
  const before = await snapshot(f.home);
  const result = await checkInstallation(f.options);
  assert.equal(result.installation, 'data-only');
  assert.equal(result.registrations[0].state, 'target-missing');
  assert.match(formatInstallationCheck(result), /설치 완료 상태가 아님/);
  assert.deepEqual(await snapshot(f.home), before);
});

test('installed version, browser and stale registration are reported from files without modifications', async t => {
  const f = await fixture(t);
  for (const file of ['runtime/node', 'central/runtime/main.mjs', 'launcher', 'extension/manifest.json', 'central/ui/dist/index.html']) await put(join(f.app, file), file);
  await put(join(f.app, 'central/package.json'), JSON.stringify({ version: '0.4.13' }));
  const chrome = join(f.home, 'Applications/Google Chrome.app'); await mkdir(chrome, { recursive: true });
  await put(join(f.home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.dico.manager.json'), JSON.stringify({ name: 'com.dico.manager', type: 'stdio', allowed_origins, path: join(f.app, 'launcher') }));
  await put(join(f.home, 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.dico.manager.json'), JSON.stringify({ name: 'com.dico.manager', type: 'stdio', allowed_origins, path: '/old/download/launcher' }));
  const before = await snapshot(f.home);
  const result = await checkInstallation({ ...f.options, candidates: [{ name: 'Chrome', paths: [chrome] }, { name: 'Brave', paths: [join(f.home, 'missing-browser')] }] });
  assert.equal(result.installation, 'installed'); assert.equal(result.version, '0.4.13');
  assert.deepEqual(result.browsers.map(item => item.state), ['found', 'not-found']);
  assert.deepEqual(result.registrations.map(item => item.state), ['registered', 'mismatch']);
  assert.match(formatInstallationCheck(result), /확장 프로그램은 자동 판정하지 않습니다/);
  assert.deepEqual(await snapshot(f.home), before);
});

test('live status uses only authenticated GET and never exposes the descriptor or response secrets', async t => {
  const f = await fixture(t);
  const token = 'private-do-not-print';
  const requests = [];
  const server = createServer((req, res) => {
    requests.push([req.method, req.url]);
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, privateDetails: token }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  await mkdir(f.directory, { recursive: true });
  await writeFile(join(f.directory, 'runtime.json'), JSON.stringify({ protocolVersion: 1, pid: process.pid, url: `http://127.0.0.1:${server.address().port}`, bridgeToken: token }), { mode: 0o600 });
  const before = await snapshot(f.home);
  const result = await checkInstallation(f.options);
  assert.equal(result.runtime, 'running');
  assert.deepEqual(requests, [['GET', '/api/bridge/status']]);
  assert.ok(!JSON.stringify(result).includes(token)); assert.ok(!formatInstallationCheck(result).includes(token));
  assert.deepEqual(await snapshot(f.home), before);
});

test('corrupt descriptor and partial application are preserved and reported as uncertain', async t => {
  const f = await fixture(t);
  await put(join(f.app, 'central/runtime/main.mjs'), 'partial');
  await put(join(f.directory, 'runtime.json'), '{broken');
  const before = await snapshot(f.home);
  const result = await checkInstallation(f.options);
  assert.equal(result.installation, 'partial'); assert.equal(result.runtime, 'unreadable');
  assert.deepEqual(await snapshot(f.home), before);
});

test('Windows checks only HKCU query targets, installed manifest and configured browser paths', async () => {
  const home = 'C:\\Users\\Ada', env = { LOCALAPPDATA: 'D:\\User Data', PROGRAMFILES: 'E:\\Apps', 'PROGRAMFILES(X86)': 'F:\\Apps32' };
  const directory = 'D:\\User Data\\DICO', app = win32.join(directory, 'app');
  const files = new Map([
    ...['runtime/node.exe', 'central/runtime/main.mjs', 'launcher.exe', 'extension/manifest.json', 'central/ui/dist/index.html'].map(file => [win32.join(app, file), '']),
    [win32.join(app, 'central/package.json'), '{"version":"0.4.13"}'],
    [win32.join(app, 'com.dico.manager.json'), JSON.stringify({ name: 'com.dico.manager', type: 'stdio', allowed_origins, path: win32.join(app, 'launcher.exe') })]
  ]);
  const queried = [];
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const result = await checkInstallation({ platform: 'win32', arch: 'x64', home, env,
    fileStat: async file => { if (!files.has(file)) throw missing(); return { isFile: () => true, isDirectory: () => false }; },
    fileRead: async file => { if (!files.has(file)) throw missing(); return files.get(file); },
    descriptorRead: async dir => { assert.equal(dir, directory); throw missing(); },
    registryQuery: async key => { queried.push(key); return { state: 'found', path: win32.join(app, 'com.dico.manager.json').toUpperCase() }; }
  });
  assert.equal(result.installation, 'installed');
  assert.deepEqual(result.registrations.map(item => item.state), ['registered', 'registered']);
  assert.deepEqual(queried, ['HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.dico.manager', 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.dico.manager']);
  const browsers = browserCandidates('win32', home, env);
  assert.equal(browsers[0].paths[0], 'E:\\Apps\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(browsers[1].paths[2], 'D:\\User Data\\BraveSoftware\\Brave-Browser\\Application\\brave.exe');
});


test('registration with the correct launcher but wrong or absent fixed extension origin is not valid', async t => {
  const f = await fixture(t);
  await put(join(f.app, 'launcher'), 'launcher');
  const manifest = { name: 'com.dico.manager', type: 'stdio', path: join(f.app, 'launcher') };
  await put(join(f.home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.dico.manager.json'), JSON.stringify({ ...manifest, allowed_origins: ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'] }));
  await put(join(f.home, 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.dico.manager.json'), JSON.stringify(manifest));
  const result = await checkInstallation(f.options);
  assert.deepEqual(result.registrations.map(item => item.state), ['mismatch', 'mismatch']);
});

test('application without its central package metadata is incomplete', async t => {
  const f = await fixture(t);
  for (const file of ['runtime/node', 'central/runtime/main.mjs', 'launcher', 'extension/manifest.json', 'central/ui/dist/index.html']) await put(join(f.app, file), file);
  const result = await checkInstallation(f.options);
  assert.equal(result.installation, 'partial');
  assert.equal(result.version, null);
});
