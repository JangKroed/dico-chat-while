import { cp, mkdir, readFile, stat, writeFile, chmod, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {findNpmCli} from './setup-central.mjs';
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
const appMetadata = JSON.parse(await readFile(join(source, 'central', 'package.json'), 'utf8'));
const fixedId = extensionIdFromKey(manifest.key);
if (extensionOverride && (!/^[a-p]{32}$/.test(extensionOverride) || extensionOverride !== fixedId)) throw new Error('Developer extension override must match the pinned manifest key');
const extensionId = fixedId;
const packageName = `dico-manager-${platform}-${arch}-node-${version.stdout.trim()}`;
const destination = join(output, packageName);
const plan = { platform, arch, node, source, destination, extensionId, archive: `${destination}.zip`, install: platform === 'darwin' ? 'install.command' : 'install.cmd', check: platform === 'darwin' ? 'check-installation.command' : 'check-installation.cmd' };
if (dryRun) { process.stdout.write(JSON.stringify(plan, null, 2) + '\n'); process.exit(0); }
await stat(join(source, 'central', 'ui', 'dist', 'index.html'));
await stat(join(source, 'docs', 'central-management', 'FIRST-SETUP.html'));
await stat(join(source, 'central', 'runtime', 'main.mjs'));
await stat(join(source, 'central', 'extension', manifest.background.service_worker));
if (manifest.action?.default_popup) await stat(join(source, 'central', 'extension', manifest.action.default_popup));
const npmCli = await findNpmCli(node);
await rm(destination, { recursive: true, force: true });
await rm(plan.archive, { force: true });
await mkdir(destination, { recursive: true });
await cp(join(source, 'central'), join(destination, 'central'), {
  recursive: true, filter: path => !path.split(/[\\/]/).some(part => part === 'node_modules' || part === '.git')
});
await mkdir(join(destination, 'runtime'), { recursive: true });
await cp(node, join(destination, 'runtime', platform === 'win32' ? 'node.exe' : 'node'));
let nodeLicense;
for(const candidate of [join(dirname(node),'..','LICENSE'),join(dirname(node),'LICENSE')]){try{await stat(candidate);nodeLicense=candidate;break;}catch{}}
if(!nodeLicense)throw new Error('Official Node LICENSE is required for redistribution');
await cp(nodeLicense,join(destination,'runtime','NODE-LICENSE.txt'));
await cp(dirname(dirname(npmCli)), join(destination, 'runtime', 'node_modules', 'npm'), { recursive: true, dereference: true });
await cp(join(source, 'docs', 'central-management', 'FIRST-SETUP.html'), join(destination, 'START-HERE.html'));
await mkdir(join(destination, 'extension'), { recursive: true });
await cp(join(source, 'central', 'extension'), join(destination, 'extension'), { recursive: true });
for (const file of ['content.js', 'emoji-data.js']) {
  try { await stat(join(source, 'central', 'extension', file)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await cp(join(source, file), join(destination, 'extension', file));
  }
}
await writeFile(join(destination,'update-installation.json'),JSON.stringify({formatVersion:1,repository:'https://github.com/JangKroed/dico-chat-while.git',ref:'main'},null,2)+'\n');
await writeFile(join(destination, 'allowed_extensions.json'), JSON.stringify({ extensionIds: [extensionId] }, null, 2) + '\n');
if (platform === 'darwin') {
  const launcher = `#!/bin/sh\nBASE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$BASE/runtime/node" "$BASE/central/host/main.mjs" "$@"\n`;
  await writeFile(join(destination, 'launcher'), launcher, { mode: 0o755 });
  await chmod(join(destination, 'launcher'), 0o755);
  for (const [name, action] of [['install.command', 'install'], ['uninstall.command', 'uninstall']]) {
    await writeFile(join(destination, name), `#!/bin/sh\nBASE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$BASE/runtime/node" "$BASE/central/host/install.mjs" ${action}${action === 'install' ? ' --open' : ''} "$@"\n`, { mode: 0o755 });
    await chmod(join(destination, name), 0o755);
  }
  await writeFile(join(destination, plan.check), `#!/bin/sh\nBASE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\n"$BASE/runtime/node" "$BASE/central/host/check-installation.mjs" "$@"\nRESULT=$?\nprintf '\\n확인이 끝났습니다. Enter 키를 누르면 닫힙니다.\\n'\nread -r ANSWER\nexit "$RESULT"\n`, { mode: 0o755 });
  await chmod(join(destination, plan.check), 0o755);
  await writeFile(join(destination, 'open-manager.command'), `#!/bin/sh\nDICO_APP="$HOME/Library/Application Support/DICO/app"\nif [ ! -f "$DICO_APP/runtime/node" ] || [ ! -f "$DICO_APP/central/runtime/main.mjs" ]; then\n  printf 'DICO 설치 파일이 없습니다. 처음 시작 안내를 따라 먼저 설치하세요.\\n'\n  read -r ANSWER\n  exit 1\nfi\nprintf '관리 프로그램을 엽니다. 이 창에서 실행 중이면 창을 닫지 마세요.\\n'\n"$DICO_APP/runtime/node" "$DICO_APP/central/runtime/main.mjs" --open\nRESULT=$?\nprintf '\\nEnter 키를 누르면 이 창이 닫힙니다.\\n'\nread -r ANSWER\nexit "$RESULT"\n`, { mode: 0o755 });
  await chmod(join(destination, 'open-manager.command'), 0o755);
} else {
  await writeFile(join(destination, 'manager-start.vbs'), 'Set fs = CreateObject("Scripting.FileSystemObject")\r\nbase = fs.GetParentFolderName(WScript.ScriptFullName)\r\nq = Chr(34)\r\ncommand = q & base & "\\runtime\\node.exe" & q & " " & q & base & "\\central\\runtime\\main.mjs" & q\r\nCreateObject("WScript.Shell").Run command, 0, False\r\n');
  const compiler = spawnSync('cl.exe', ['/nologo', '/O2', `/Fe:${join(destination, 'launcher.exe')}`, join(destination, 'central', 'host', 'launcher-win.c')], { cwd: destination, encoding: 'utf8' });
  if (compiler.status !== 0) throw new Error('Windows package requires MSVC cl.exe to build a real native host launcher');
  for (const [name, action] of [['install.cmd', 'install'], ['uninstall.cmd', 'uninstall']]) {
    await writeFile(join(destination, name), `@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0central\\host\\install.mjs" ${action}${action === 'install' ? ' --open' : ''} %*\r\n`);
  }
  await writeFile(join(destination, plan.check), '@echo off\r\nchcp 65001 >nul\r\n"%~dp0runtime\\node.exe" "%~dp0central\\host\\check-installation.mjs" %*\r\nset "DICO_CHECK_RESULT=%ERRORLEVEL%"\r\necho.\r\npause\r\nexit /b %DICO_CHECK_RESULT%\r\n');
  await writeFile(join(destination, 'open-manager.cmd'), '@echo off\r\nchcp 65001 >nul\r\nset "DICO_APP=%LOCALAPPDATA%\\DICO\\app"\r\nif not defined LOCALAPPDATA set "DICO_APP=%USERPROFILE%\\AppData\\Local\\DICO\\app"\r\nif not exist "%DICO_APP%\\runtime\\node.exe" goto missing\r\nif not exist "%DICO_APP%\\central\\runtime\\main.mjs" goto missing\r\necho 관리 프로그램을 엽니다. 이 창에서 실행 중이면 창을 닫지 마세요.\r\n"%DICO_APP%\\runtime\\node.exe" "%DICO_APP%\\central\\runtime\\main.mjs" --open\r\nset "DICO_OPEN_RESULT=%ERRORLEVEL%"\r\npause\r\nexit /b %DICO_OPEN_RESULT%\r\n:missing\r\necho DICO 설치 파일이 없습니다. 처음 시작 안내를 따라 먼저 설치하세요.\r\npause\r\nexit /b 1\r\n');
}
await writeFile(join(destination, 'README.txt'), `DICO central manager ${appMetadata.version}\nExtension version: ${manifest.version}\n\nTarget: ${platform} ${arch}; bundled Node: ${version.stdout.trim()}\nExtension ID: ${extensionId}\nOpen START-HERE.html for the offline step-by-step guide.\nFirst double-click ${plan.check}: it only reads installation state and does not install or start DICO.\nRead 처음시작-${platform === 'darwin' ? 'Mac' : 'Windows'}.txt before installation.\nDouble-click ${plan.install} to register the native host for this OS user and open the manager.\nAfter installation, load the stable installed DICO/app/extension folder printed by the check, not the extracted ZIP folder.\nTo reopen the installed manager later, double-click open-manager.${platform === 'darwin' ? 'command' : 'cmd'}.\nOptional: pass --autostart to the installer to start the service at the next login.\nUninstall preserves your database and settings.\nThe development bundle is unsigned; distribution requires code signing and platform verification.\n`);
await writeFile(join(destination, `처음시작-${platform === 'darwin' ? 'Mac' : 'Windows'}.txt`), `DICO 관리 프로그램 ${appMetadata.version} 처음 시작\n확장 프로그램 버전: ${manifest.version}\n\n이 배포 파일 대상: ${platform === 'darwin' ? 'macOS' : 'Windows'} / ${arch}\n${platform === 'darwin' && arch === 'arm64' ? 'Apple Silicon (M1/M2/M3/M4 등) Mac용입니다. Intel Mac이나 Windows용 설치 파일이 아닙니다.\n' : ''}먼저 START-HERE.html을 더블 클릭해 순서별 안내를 여세요.\nGit이나 Node.js를 따로 설치하지 않아도 됩니다. 필요한 실행 프로그램과 npm이 포함되어 있습니다.\n처음 설치에는 Git이 필요 없지만, 나중에 앱 안에서 소스 기반 자동 업데이트를 사용할 때는 Git이 필요합니다. START-HERE.html의 업데이트 준비를 참고하세요.\n\n1. ZIP 전체를 압축 해제하고 폴더를 여세요. ZIP 안에서 바로 실행하지 마세요.\n2. 먼저 ${plan.check} 파일을 더블 클릭하세요.\n   기존 DICO 설치·버전·브라우저 연결·실행 상태를 읽기 전용으로 확인합니다.\n   이 단계는 설치하거나 실행 중인 프로그램을 종료하지 않습니다.\n   설치 파일이 이미 있으면 기존 프로그램을 먼저 확인하세요.\n   데이터 폴더만 있다는 결과는 설치 완료라는 뜻이 아닙니다. 기존 데이터를 삭제하지 마세요.\n3. 새로 설치할 때는 Chrome 또는 Brave를 준비하고 ${plan.install} 파일을 더블 클릭하세요.\n   기존 DICO가 실행 중이면 새 설치를 반복하지 말고 기존 관리 화면의 업데이트를 사용하세요. 설정과 기록은 보존됩니다.\n4. 관리 화면이 열리면 사용할 브라우저에서 chrome://extensions 또는 brave://extensions를 여세요.\n   개발자 모드를 켜고 「압축해제된 확장 프로그램을 로드」를 누르세요.\n   ${plan.check}를 다시 실행하면 표시되는 DICO/app/extension 폴더를 선택하세요.\n   압축을 푼 배포 폴더 안의 extension을 선택하지 마세요.\n5. 확장이 켜져 있는지 확인하고, 관리 화면의 연결 안내에 따라 Discord를 여세요.\n6. 나중에 관리 화면을 다시 열 때는 open-manager.${platform === 'darwin' ? 'command' : 'cmd'}를 더블 클릭하세요.\n   이 창에서 관리 프로그램을 실행 중이면 창을 닫지 마세요.\n\n확인 창은 Enter 키를 누를 때까지 열려 있습니다. 확인 결과에는 인증 토큰을 표시하지 않습니다.\n${platform === 'darwin' ? 'Mac에서 .command 파일은 터미널로 열립니다. 실행 권한 오류가 나면 ZIP을 기본 압축 유틸리티로 다시 풀어 확인하세요.\n' : ''}이 배포본은 서명되지 않았습니다. OS가 차단하면 출처를 확인하고 설치 안내를 검토하세요. 시스템 보안 기능을 끄지 마세요.\nWindows 배포본과 macOS 배포본은 서로 대체할 수 없습니다.\n`);
const zip = spawnSync('zip', ['-qry', plan.archive, packageName], { cwd: output, encoding: 'utf8' });
if (zip.status !== 0) process.stderr.write('zip unavailable; folder package is ready.\n');
process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
