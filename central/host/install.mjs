import { createHash } from 'node:crypto';
import { cp, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, win32 } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { dataDirectory, readDescriptor } from './paths.mjs';
import { bridgeRequest } from './service.mjs';

const HOST = 'com.dico.manager';
export function extensionIdFromKey(base64) {
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('fixed extension public key required');
  const digest = createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex').slice(0, 32);
  return digest.replace(/[0-9a-f]/g, digit => 'abcdefghijklmnop'[parseInt(digit, 16)]);
}

export function installPlan({ platform = process.platform, home = homedir(), env = process.env, source, extensionIds, autostart = false }) {
  if (!Array.isArray(extensionIds) || !extensionIds.length || extensionIds.some(id => !/^[a-p]{32}$/.test(id))) throw new Error('fixed extension ID required');
  if (!['darwin', 'win32'].includes(platform)) throw new Error('Only macOS and Windows native host installation is supported');
  const path = platform === 'win32' ? win32 : { join };
  const app = path.join(dataDirectory(platform, home, env), 'app');
  const manifestPath = path.join(app, `${HOST}.json`);
  const manifest = {
    name: HOST, description: 'DICO local management bridge',
    path: path.join(app, platform === 'win32' ? 'launcher.exe' : 'launcher'),
    type: 'stdio', allowed_origins: extensionIds.map(id => `chrome-extension://${id}/`)
  };
  const browsers = platform === 'darwin'
    ? ['Google/Chrome', 'BraveSoftware/Brave-Browser']
    : ['Google\\Chrome', 'BraveSoftware\\Brave-Browser'];
  return {
    platform, source, app, manifestPath, manifest,
    autostart: platform === 'darwin'
      ? { enabled: autostart, path: path.join(home, 'Library', 'LaunchAgents', `${HOST}.plist`) }
      : { enabled: autostart, key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', name: 'DICOManager', value: `wscript.exe "${path.join(app, 'manager-start.vbs')}"` },
    manifests: platform === 'darwin' ? browsers.map(browser => path.join(home, 'Library', 'Application Support', browser, 'NativeMessagingHosts', `${HOST}.json`)) : [],
    registry: platform === 'win32' ? browsers.map(browser => `HKCU\\Software\\${browser}\\NativeMessagingHosts\\${HOST}`) : []
  };
}

function xml(value) { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function launchAgent(plan) {
  const node = join(plan.app, 'runtime', 'node'), main = join(plan.app, 'central', 'runtime', 'main.mjs');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${HOST}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(main)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>\n`;
}

function reg(args) {
  const result = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Registry command failed: ${args[0]}`);
  return result.stdout;
}

async function serviceStopped(plan) {
  const directory = dirname(plan.app), file = join(directory, 'runtime.json');
  try { await lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error('Runtime descriptor cannot be checked; close the manager before changing it');
  }
  let descriptor;
  try { descriptor = await readDescriptor(directory); }
  catch { throw new Error('Runtime descriptor is unreadable or invalid; preserve it and close the manager before changing it'); }
  try {
    await bridgeRequest(descriptor, '/api/bridge/status');
    throw new Error('Management service is running; exit it before installing or uninstalling');
  } catch (error) {
    if (error.message.startsWith('Management service is running')) throw error;
  }
  try {
    process.kill(descriptor.pid, 0);
    throw new Error('Management service process is still running; exit it before installing or uninstalling');
  } catch (error) {
    if (error.code !== 'ESRCH') {
      if (error.message.startsWith('Management service process is still running')) throw error;
      throw new Error('Management service process cannot be verified; exit it before installing or uninstalling');
    }
  }
}

export async function assertServiceStopped(directory = dataDirectory()) {
  await serviceStopped({ app: join(directory, 'app') });
}

async function secureDataDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('Data directory is not owned by this user');
  if (process.platform !== 'win32') await chmod(path, 0o700);
}

export async function install(plan) {
  await serviceStopped(plan);
  const source = resolve(plan.source), app = resolve(plan.app);
  if (source === app || app.startsWith(source + (plan.platform === 'win32' ? '\\' : '/'))) throw new Error('Source overlaps installation');
  const staging = `${app}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await secureDataDirectory(dirname(app));
  await cp(source, staging, { recursive: true, force: true });
  const replacement = join(staging, plan.platform === 'win32' ? 'launcher.exe' : 'launcher');
  await readFile(replacement); // Never register an absent launcher.
  await writeFile(join(staging, HOST + '.json'), JSON.stringify(plan.manifest, null, 2) + '\n');
  const old = `${app}.previous-${process.pid}`;
  try {
    await serviceStopped(plan);
    try { await rename(app, old); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(staging, app);
  } catch (error) {
    try { await rename(old, app); } catch { /* Existing installation may not have existed. */ }
    throw error;
  }
  if (plan.platform === 'darwin') {
    for (const file of plan.manifests) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(plan.manifest, null, 2) + '\n');
    }
    if (plan.autostart.enabled) {
      await mkdir(dirname(plan.autostart.path), { recursive: true });
      await writeFile(plan.autostart.path, launchAgent(plan));
    }
  } else {
    for (const key of plan.registry) reg(['add', key, '/ve', '/t', 'REG_SZ', '/d', plan.manifestPath, '/f']);
    if (plan.autostart.enabled) reg(['add', plan.autostart.key, '/v', plan.autostart.name, '/t', 'REG_SZ', '/d', plan.autostart.value, '/f']);
  }
  await rm(old, { recursive: true, force: true });
}

export async function uninstall(plan) {
  await serviceStopped(plan);
  if (plan.platform === 'darwin') {
    for (const file of plan.manifests) {
      try {
        const current = JSON.parse(await readFile(file, 'utf8'));
        if (current.name === HOST && current.path === plan.manifest.path) await rm(file);
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    }
    try {
      const current = await readFile(plan.autostart.path, 'utf8');
      if (current.includes(xml(join(plan.app, 'central', 'runtime', 'main.mjs')))) await rm(plan.autostart.path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } else {
    for (const key of plan.registry) {
      const result = spawnSync('reg.exe', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true });
      if (result.status === 0 && result.stdout.includes(plan.manifestPath)) reg(['delete', key, '/f']);
    }
    const result = spawnSync('reg.exe', ['query', plan.autostart.key, '/v', plan.autostart.name], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0 && result.stdout.includes(plan.autostart.value)) reg(['delete', plan.autostart.key, '/v', plan.autostart.name, '/f']);
  }
  try {
    const current = JSON.parse(await readFile(join(plan.app, 'allowed_extensions.json'), 'utf8'));
    if (JSON.stringify(current.extensionIds) === JSON.stringify(plan.manifest.allowed_origins.map(origin => origin.slice(19, -1)))) {
      await rm(plan.app, { recursive: true, force: true });
    }
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const source = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const { extensionIds } = JSON.parse(await readFile(join(source, 'allowed_extensions.json'), 'utf8'));
    const plan = installPlan({ source, extensionIds, autostart: process.argv.includes('--autostart') });
    if (process.argv.includes('--dry-run')) process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    else if (process.argv[2] === 'install') {
      await install(plan);
      if (process.argv.includes('--open')) {
        const node = join(plan.app, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
        const child = spawn(node, [join(plan.app, 'central', 'runtime', 'main.mjs'), '--open'], { detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', () => {}); child.unref();
      }
    }
    else if (process.argv[2] === 'uninstall') await uninstall(plan);
    else throw new Error('Usage: install | uninstall [--dry-run]');
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
