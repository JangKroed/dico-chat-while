import {access,realpath} from 'node:fs/promises';
import {dirname,join,resolve,delimiter} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {assertServiceStopped} from '../central/host/install.mjs';
import {dataDirectory} from '../central/host/paths.mjs';

export const supportedNode=version=>/^24\.(?:1[3-9]|[2-9]\d)\.\d+$/.test(version);
export async function findNpmCli(node=process.execPath,path=process.env.PATH||'') {
  const candidates=[join(dirname(node),'node_modules/npm/bin/npm-cli.js'),join(dirname(node),'../lib/node_modules/npm/bin/npm-cli.js')];
  for(const dir of path.split(delimiter).filter(Boolean)) {
    candidates.push(join(dir,'node_modules/npm/bin/npm-cli.js'),join(dir,'../lib/node_modules/npm/bin/npm-cli.js'));
    try {const file=await realpath(join(dir,'npm'));if(file.endsWith('npm-cli.js'))candidates.push(file);}catch{}
  }
  for(const file of candidates)try{await access(file);return resolve(file);}catch{}
  throw Error('npm을 찾지 못했습니다. 공식 Node 24.13 배포본(npm 포함)을 사용하세요.');
}
export function setupPlan({root,npmCli,install=false,open=false,platform=process.platform}) {
  if(open&&!install)throw Error('--open requires --install');
  if(!['darwin','win32'].includes(platform))throw Error('macOS / Windows에서 실행하세요.');
  const npm=(id,args)=>({id,command:process.execPath,args:[npmCli,...args],cwd:root});
  const steps=[npm('dependencies',['--prefix','central/ui','ci']),npm('build',['run','central:build']),npm('central-check',['run','central:check']),npm('extension-check',['run','check']),{id:'package',command:process.execPath,args:[join(root,'scripts/package-central.mjs')],cwd:root}];
  if(install)steps.push({id:'install',description:'실제 package destination의 네이티브 호스트를 현재 OS 사용자에게 등록'});
  if(open)steps.push({id:'open',description:'설치된 런타임으로 중앙 페이지 열기 (Ctrl+C로 종료)'});
  return steps;
}
export function setupEnvironment(node=process.execPath,env=process.env) {
  return{...env,PATH:dirname(node)+delimiter+(env.PATH||'')};
}
export function executeStep(step) {
  console.log(`\n[DICO 설정] ${step.id}`);
  return new Promise((accept,reject)=>{
    let output='';
    const child=spawn(step.command,step.args,{cwd:step.cwd,env:setupEnvironment(),stdio:step.id==='open'?'inherit':['inherit','pipe','inherit'],windowsHide:false});
    child.stdout?.on('data',chunk=>{process.stdout.write(chunk);if(step.id==='package')output+=chunk;});
    child.once('error',reject);child.once('exit',(code,signal)=>code===0?accept(output):reject(Error(`${step.id}: 종료 코드 ${code??signal}`)));
  });
}
export async function runSetup({root,npmCli,install=false,open=false,dryRun=false,platform=process.platform,execute=executeStep,preflight=()=>assertServiceStopped(dataDirectory())}) {
  const steps=setupPlan({root,npmCli,install,open,platform});
  if(dryRun)return{dryRun:true,steps};
  await preflight(); // Before npm ci or central:build touches files loaded by browsers.
  let destination;
  for(const planned of steps) {
    let step=planned;
    if(planned.id==='install') {
      if(!destination)throw Error('패키지 destination이 없습니다. 설치를 중단합니다.');
      step={id:'install',command:join(destination,'runtime',platform==='win32'?'node.exe':'node'),args:[join(destination,'central/host/install.mjs'),'install'],cwd:root};
    }
    if(planned.id==='open') {
      const app=join(dataDirectory(),'app');
      step={id:'open',command:join(app,'runtime',platform==='win32'?'node.exe':'node'),args:[join(app,'central/runtime/main.mjs'),'--open'],cwd:root};
    }
    try {
      if(['build','package','install'].includes(step.id))await preflight();
      const output=await execute(step);
      if(step.id==='package') {
        const parsed=JSON.parse(output);if(typeof parsed.destination!=='string'||!parsed.destination)throw Error('Invalid package output');
        destination=resolve(parsed.destination);
      }
    } catch(error) {throw Error(`${step.id} 단계에서 중단했습니다. 오류를 해결하고 같은 설정 명령을 다시 실행하세요. ${error.message}`);}
  }
  return{ok:true,destination};
}
export async function setupDoctor({root,npmCli,platform=process.platform}={}) {
  const checks=[{id:'node',ok:supportedNode(process.versions.node),detail:`실행 Node ${process.versions.node} / ${process.arch}`},{id:'npm',ok:Boolean(npmCli),detail:npmCli?'npm CLI 확인':'Node 배포본의 npm 필요'},{id:'platform',ok:['darwin','win32'].includes(platform),detail:platform}];
  if(platform==='win32') {
    const {spawnSync}=await import('node:child_process');
    const result=spawnSync('where.exe',['cl.exe'],{stdio:'pipe',timeout:3000,windowsHide:true});
    checks.push({id:'msvc',ok:result.status===0,detail:result.status===0?'MSVC 환경 활성화됨':'setup.ps1로 VS 환경 자동 탐색 또는 C++ Build Tools 설치 필요'});
  }
  try {await access(join(root,'central/extension/manifest.json'));checks.push({id:'source',ok:true,detail:'전용 확장 소스 확인'});}catch{checks.push({id:'source',ok:false,detail:'저장소 루트에서 실행하세요.'});}
  return{checks,ready:checks.every(c=>c.ok)};
}
async function main() {
  const args=new Set(process.argv.slice(2));
  for(const arg of args)if(!['--doctor','--dry-run','--install','--open'].includes(arg))throw Error(`지원하지 않는 옵션: ${arg}`);
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  let npmCli;try{npmCli=await findNpmCli();}catch(error){if(!args.has('--doctor')&&!args.has('--dry-run'))throw error;}
  if(args.has('--doctor')){const report=await setupDoctor({root,npmCli});console.log(JSON.stringify(report,null,2));process.exitCode=report.ready?0:1;return;}
  if(!args.has('--dry-run')&&!supportedNode(process.versions.node))throw Error('Node 24.13 이상 24.x가 필요합니다. setup.command / setup.ps1을 사용하세요.');
  if(!args.has('--dry-run')) {
    const report=await setupDoctor({root,npmCli});
    if(!report.ready)throw Error(report.checks.filter(c=>!c.ok).map(c=>c.detail).join(' · '));
  }
  const result=await runSetup({root,npmCli:npmCli||'<Node에 포함된 npm-cli.js>',install:args.has('--install'),open:args.has('--open'),dryRun:args.has('--dry-run')});
  console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(`[DICO 설정 실패] ${error.message}`);process.exitCode=1;});
