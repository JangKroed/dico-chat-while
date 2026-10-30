import { cp, mkdir, readFile, stat, writeFile, chmod, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extensionIdFromKey } from '../central/host/install.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const option = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const source = resolve(option('--source') || repo);
const output = resolve(option('--out') || join(repo, 'dist', 'central-packages'));
const node = resolve(option('--node') || process.execPath);
const extensionOverride = option('--extension-id');
const dryRun = process.argv.includes('--dry-run');
const platform = process.platform, arch = process.arch;
if (!['darwin', 'win32'].includes(platform)) throw new Error('Packaging supports macOS and Windows only. Build on the target platform.');
const version = spawnSync(node, ['-p', 'process.versions.node'], { encoding: 'utf8' });
if (version.status !== 0 || !/^24\.(?:1[3-9]|[2-9][0-9])\./.test(version.stdout.trim())) throw new Error('Bundled Node 24.13+ is required for built-in SQLite');
const manifest = JSON.parse(await readFile(join(source, 'central', 'extension', 'manifest.json'), 'utf8'));
const fixedId = extensionIdFromKey(manifest.key);
if (extensionOverride && (!/^[a-p]{32}$/.test(extensionOverride) || extensionOverride !== fixedId)) throw new Error('Developer extension override must match the pinned manifest key');
const extensionId = fixedId;
const packageName = `dico-manager-${platform}-${arch}-node-${version.stdout.trim()}`;
const destination = join(output, packageName);
const plan = { platform, arch, node, source, destination, extensionId, archive: `${destination}.zip`, install: platform === 'darwin' ? 'install.command' : 'install.cmd' };
if (dryRun) { process.stdout.write(JSON.stringify(plan, null, 2) + '\n'); process.exit(0); }
await stat(join(source, 'central', 'ui', 'dist', 'index.html'));
await stat(join(source, 'central', 'runtime', 'main.mjs'));
await stat(join(source, 'central', 'extension', manifest.background.service_worker));
if (manifest.action?.default_popup) await stat(join(source, 'central', 'extension', manifest.action.default_popup));
await rm(destination, { recursive: true, force: true });
await rm(plan.archive, { force: true });
await mkdir(destination, { recursive: true });
await cp(join(source, 'central'), join(destination, 'central'), {
  recursive: true, filter: path => !path.split(/[\\/]/).some(part => part === 'node_modules' || part === '.git')
});
await mkdir(join(destination, 'runtime'), { recursive: true });
await cp(node, join(destination, 'runtime', platform === 'win32' ? 'node.exe' : 'node'));
await mkdir(join(destination, 'extension'), { recursive: true });
await cp(join(source, 'central', 'extension'), join(destination, 'extension'), { recursive: true });
for (const file of ['content.js', 'emoji-data.js']) {
  try { await stat(join(source, 'central', 'extension', file)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await cp(join(source, file), join(destination, 'extension', file));
  }
}
await writeFile(join(destination, 'allowed_extensions.json'), JSON.stringify({ extensionIds: [extensionId] }, null, 2) + '\n');
if (platform === 'darwin') {
  const launcher = `#!/bin/sh\nBASE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$BASE/runtime/node" "$BASE/central/host/main.mjs" "$@"\n`;
  await writeFile(join(destination, 'launcher'), launcher, { mode: 0o755 });
  await chmod(join(destination, 'launcher'), 0o755);
  for (const [name, action] of [['install.command', 'install'], ['uninstall.command', 'uninstall']]) {
    await writeFile(join(destination, name), `#!/bin/sh\nBASE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$BASE/runtime/node" "$BASE/central/host/install.mjs" ${action}${action === 'install' ? ' --open' : ''} "$@"\n`, { mode: 0o755 });
    await chmod(join(destination, name), 0o755);
  }
} else {
  await writeFile(join(destination, 'manager-start.vbs'), 'Set fs = CreateObject("Scripting.FileSystemObject")\r\nbase = fs.GetParentFolderName(WScript.ScriptFullName)\r\nq = Chr(34)\r\ncommand = q & base & "\\runtime\\node.exe" & q & " " & q & base & "\\central\\runtime\\main.mjs" & q\r\nCreateObject("WScript.Shell").Run command, 0, False\r\n');
  const compiler = spawnSync('cl.exe', ['/nologo', '/O2', `/Fe:${join(destination, 'launcher.exe')}`, join(destination, 'central', 'host', 'launcher-win.c')], { cwd: destination, encoding: 'utf8' });
  if (compiler.status !== 0) throw new Error('Windows package requires MSVC cl.exe to build a real native host launcher');
  for (const [name, action] of [['install.cmd', 'install'], ['uninstall.cmd', 'uninstall']]) {
    await writeFile(join(destination, name), `@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0central\\host\\install.mjs" ${action}${action === 'install' ? ' --open' : ''} %*\r\n`);
  }
}
await writeFile(join(destination, 'README.txt'), `DICO central manager ${manifest.version}\n\nBundled Node: ${version.stdout.trim()}\nExtension ID: ${extensionId}\nDouble-click ${plan.install} to register the native host for this OS user and open the manager.\nLoad the extension/ folder in a supported Chromium browser.\nOptional: pass --autostart to the installer to start the service at the next login.\nUninstall preserves your database and settings.\nThe development bundle is unsigned; distribution requires code signing and platform verification.\n`);
const zip = spawnSync('zip', ['-qry', plan.archive, packageName], { cwd: output, encoding: 'utf8' });
if (zip.status !== 0) process.stderr.write('zip unavailable; folder package is ready.\n');
process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
