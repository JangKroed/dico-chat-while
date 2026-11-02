import { stat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, win32, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { dataDirectory, readDescriptor } from './paths.mjs';
import { bridgeRequest } from './service.mjs';
import { extensionIdFromKey } from './install.mjs';

const HOST = 'com.dico.manager';

export function browserCandidates(platform, home, env = {}) {
  if (platform === 'darwin') return [
    { name: 'Chrome', paths: ['/Applications/Google Chrome.app', join(home, 'Applications/Google Chrome.app')] },
    { name: 'Brave', paths: ['/Applications/Brave Browser.app', join(home, 'Applications/Brave Browser.app')] }
  ];
  if (platform === 'win32') {
    const roots = [...new Set([env.PROGRAMFILES || env.ProgramFiles || 'C:\\Program Files', env['PROGRAMFILES(X86)'] || env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local')])];
    return [
      { name: 'Chrome', paths: roots.map(root => win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')) },
      { name: 'Brave', paths: roots.map(root => win32.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')) }
    ];
  }
  return [];
}

function queryRegistry(key) {
  const result = spawnSync('reg.exe', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true });
  if (result.error) return { state: 'unreadable' };
  if (result.status !== 0) return { state: 'not-found' };
  const match = result.stdout.match(/REG_SZ\s+([^\r\n]+)/);
  return match ? { state: 'found', path: match[1].trim() } : { state: 'unreadable' };
}

// Read-only: never starts the service, opens its database, or changes installation files.
export async function checkInstallation({ platform = process.platform, arch = process.arch, home = homedir(), env = process.env,
  fileStat = stat, fileRead = readFile, registryQuery = queryRegistry,
  descriptorRead = readDescriptor, request = bridgeRequest, candidates = browserCandidates(platform, home, env) } = {}) {
  const path = platform === 'win32' ? win32 : { join };
  const bundledManifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const expectedOrigin = `chrome-extension://${extensionIdFromKey(bundledManifest.key)}/`;
  const directory = dataDirectory(platform, home, env), app = path.join(directory, 'app');
  async function kind(file) {
    try { const value = await fileStat(file); return value.isFile() ? 'file' : value.isDirectory() ? 'directory' : 'other'; }
    catch (error) { return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing' : 'unreadable'; }
  }
  const required = [path.join(app, 'runtime', platform === 'win32' ? 'node.exe' : 'node'), path.join(app, 'central', 'runtime', 'main.mjs'),
    path.join(app, platform === 'win32' ? 'launcher.exe' : 'launcher'), path.join(app, 'extension', 'manifest.json'), path.join(app, 'central', 'ui', 'dist', 'index.html'), path.join(app, 'central', 'package.json')];
  const files = await Promise.all(required.map(async file => ({ path: file, state: await kind(file) })));
  const directoryState = await kind(directory), appState = await kind(app);
  const installation = files.every(file => file.state === 'file') ? 'installed'
    : files.some(file => file.state === 'unreadable') || appState === 'unreadable' || directoryState === 'unreadable' ? 'unreadable'
    : files.some(file => file.state === 'file') || appState === 'directory' ? 'partial'
    : directoryState === 'directory' ? 'data-only' : 'missing';
  let version = null;
  try { const pkg = JSON.parse(await fileRead(path.join(app, 'central', 'package.json'), 'utf8')); if (typeof pkg.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(pkg.version)) version = pkg.version; } catch { /* Report unknown without exposing file contents. */ }
  const browsers = await Promise.all(candidates.map(async browser => {
    const found = [];
    let unreadable = false;
    for (const location of browser.paths) {
      const state = await kind(location);
      if (state === (platform === 'darwin' ? 'directory' : 'file')) found.push(location);
      if (state === 'unreadable') unreadable = true;
    }
    return { name: browser.name, paths: found, state: found.length ? 'found' : unreadable ? 'unreadable' : 'not-found' };
  }));
  const launcher = required[2], manifestPath = path.join(app, `${HOST}.json`);
  const samePath = (a, b) => typeof a === 'string' && (platform === 'win32' ? win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase() : a === b);
  async function inspectManifest(file) {
    try {
      const value = JSON.parse(await fileRead(file, 'utf8'));
      return value.name === HOST && value.type === 'stdio' && samePath(value.path, launcher)
        && Array.isArray(value.allowed_origins) && value.allowed_origins.length === 1 && value.allowed_origins[0] === expectedOrigin
        ? (await kind(launcher) === 'file' ? 'registered' : 'target-missing') : 'mismatch';
    } catch (error) { return error.code === 'ENOENT' ? 'missing' : 'unreadable'; }
  }
  const registrations = [];
  for (const [name, vendor] of [['Chrome', 'Google/Chrome'], ['Brave', 'BraveSoftware/Brave-Browser']]) {
    if (platform === 'darwin') {
      const location = join(home, 'Library', 'Application Support', vendor, 'NativeMessagingHosts', `${HOST}.json`);
      registrations.push({ name, location, state: await inspectManifest(location) });
    } else if (platform === 'win32') {
      const location = `HKCU\\Software\\${vendor.replaceAll('/', '\\')}\\NativeMessagingHosts\\${HOST}`;
      const value = await registryQuery(location);
      registrations.push({ name, location, state: value.state === 'not-found' ? 'missing' : value.state !== 'found' ? 'unreadable'
        : !samePath(value.path, manifestPath) ? 'mismatch' : await inspectManifest(manifestPath) });
    }
  }
  let runtime = 'no-record';
  try {
    const descriptor = await descriptorRead(directory);
    try { await request(descriptor, '/api/bridge/status', 'GET'); runtime = 'running'; }
    catch { runtime = 'not-responding'; }
  } catch (error) { runtime = error.code === 'ENOENT' ? 'no-record' : 'unreadable'; }
  return { platform, arch, directory, app, extension: path.join(app, 'extension'), installation, version, files, browsers, registrations, runtime };
}

export function formatInstallationCheck(result) {
  const installations = { installed: '설치 파일 있음', partial: '설치 파일이 일부만 있음 — 설치 상태 확인 필요', 'data-only': '이전 데이터 폴더만 있음 — 설치 완료 상태가 아님', missing: '기존 설치 파일 없음', unreadable: '파일 접근 권한 때문에 확인할 수 없음' };
  const states = { registered: '정상 등록 (현재 설치 경로)', missing: '등록 없음', mismatch: '다른 경로 또는 잘못된 등록', 'target-missing': '등록은 있지만 실행 파일 없음', unreadable: '확인 불가' };
  const runtimes = { running: '실행 중 (읽기 전용 상태 요청 응답)', 'no-record': '실행 기록 없음', 'not-responding': '실행 기록은 있지만 응답 없음 — 중지되었거나 이전 기록일 수 있음', unreadable: '실행 기록 확인 불가' };
  return [
    'DICO 설치 상태 확인', '이 확인은 설치·삭제·설정 변경이나 관리 프로그램 실행을 하지 않습니다.', '',
    `이 컴퓨터: ${result.platform === 'darwin' ? 'macOS' : result.platform === 'win32' ? 'Windows' : result.platform} / ${result.arch === 'arm64' ? 'ARM64 (Mac은 Apple Silicon)' : result.arch === 'x64' ? 'x64 (Intel / AMD)' : result.arch}`,
    `DICO: ${installations[result.installation]}`, `설치된 프로그램 버전: ${result.version || '확인 안 됨'}`,
    `설치 폴더: ${result.app}`, `데이터 폴더: ${result.directory}`, '',
    '브라우저 (일반적인 설치 경로 기준):',
    ...result.browsers.map(browser => `  ${browser.name}: ${browser.state === 'found' ? `발견 — ${browser.paths.join(', ')}` : browser.state === 'unreadable' ? '확인 불가' : '발견 안 됨 (다른 위치에 설치했는지 직접 확인)'}`), '',
    '브라우저와 DICO를 연결하는 등록:',
    ...result.registrations.map(item => `  ${item.name}: ${states[item.state]}`),
    `관리 프로그램: ${runtimes[result.runtime]}`, '',
    '확장 프로그램은 자동 판정하지 않습니다. 사용할 브라우저에서 직접 확인하세요.',
    'Chrome: chrome://extensions  /  Brave: brave://extensions',
    'DICO 확장이 있는지, 사용 설정이 켜져 있는지 확인하세요.',
    '설치 후 「압축해제된 확장 프로그램을 로드」에서 선택할 폴더:',
    `  ${result.extension}`, 'ZIP을 푼 임시 폴더 안의 extension 폴더를 선택하지 마세요.', '',
    result.installation === 'installed' ? '이미 설치되어 있습니다. 처음부터 다시 설치하기 전에 기존 관리 프로그램과 확장을 확인하세요.'
      : result.installation === 'missing' ? '새로 설치할 경우 배포 폴더의 처음 시작 안내를 따라 진행하세요.'
      : '기존 파일과 데이터를 그대로 두고, 이 결과를 확인한 뒤 설치 안내를 따라 진행하세요.',
    '이 결과는 현재 OS 사용자와 기본 설치 위치 기준입니다.', ''
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(formatInstallationCheck(await checkInstallation())); }
  catch { process.stderr.write('설치 상태 확인을 완료하지 못했습니다. 설치나 설정은 변경하지 않았습니다.\n'); process.exitCode = 1; }
}
