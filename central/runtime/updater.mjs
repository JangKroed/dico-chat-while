import {randomBytes,timingSafeEqual} from 'node:crypto';
import {access,chmod,copyFile,cp,lstat,mkdir,open,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve,delimiter,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';

const executeFile=promisify(execFile);
const modulePath=fileURLToPath(import.meta.url);
const activeAttempts=new Set(['preparing','prepared','permitted','executing','unknown']);
const messages={idle:'업데이트를 실행하면 최신 버전을 준비한 뒤 관리 프로그램을 다시 엽니다.',preparing:'업데이트 작업을 준비하고 있습니다.',source:'공식 저장소의 최신 버전을 별도 폴더에 내려받고 있습니다.',dependencies:'업데이트에 필요한 빌드 도구를 준비하고 있습니다.',build:'새 관리 화면과 확장 프로그램을 빌드하고 있습니다.',check:'새 버전의 구문과 확장 설정을 검사하고 있습니다.',ready:'준비가 끝났습니다. 발송이 중지되어 있는지 다시 확인합니다.',applying:'발송이 중지된 것을 확인했습니다. 관리 프로그램을 업데이트합니다.',completed:'업데이트를 완료했습니다. 새 관리 화면에서 버전을 확인하세요.',failed:'업데이트를 완료하지 못했습니다. 기존 설치를 확인하고 다시 시도하거나 설치 도구를 실행하세요.',busy:'준비 중 실행 상태가 바뀌어 업데이트를 중단했습니다. 모든 그룹을 중지한 뒤 다시 시도하세요.',source_failed:'최신 소스를 받지 못했습니다. 인터넷과 Git 설치 상태를 확인한 뒤 다시 시도하세요.',dependencies_failed:'빌드 의존성을 설치하지 못했습니다. 인터넷과 npm 설치 상태를 확인하세요.',build_failed:'새 버전 빌드에 실패했습니다. 현재 설치는 유지됩니다. 잠시 후 다시 시도하세요.',check_failed:'새 버전 검사를 통과하지 못했습니다. 현재 설치를 유지합니다.',apply_failed:'설치 파일을 교체하지 못했습니다. 기존 설치를 유지·복원했습니다. 파일을 사용하는 프로그램을 확인하세요.',authorize_failed:'최종 업데이트 적용을 승인받지 못했습니다. 현재 관리 화면에서 상태를 확인한 뒤 다시 시도하세요.',rollback_failed:'이전 버전 파일 복원을 완료하지 못했습니다. 관리 프로그램을 실행하기 전에 최신 설치 도구로 복구하세요.',restart_rolled_back:'새 버전을 시작하지 못해 이전 버전으로 복원했습니다. 최신 설치 도구를 실행하거나 나중에 다시 시도하세요.',restart_failed:'설치 후 관리 프로그램 시작을 확인하지 못했습니다. 설치된 실행기로 다시 열거나 설치 도구를 실행하세요.',shutdown_failed:'관리 프로그램 종료를 확인하지 못했습니다. 설치 파일은 바꾸지 않았습니다.',runtime_active:'다른 관리 프로그램이 실행되어 파일을 교체하지 않았습니다. 모두 종료한 뒤 다시 시도하세요.',manual:'이 설치에는 수동 설치 도구가 필요합니다. 최신 setup.command 또는 setup.ps1을 실행하세요.'};
const error=(code,message,status=409)=>Object.assign(Error(message),{code,status});
const tokenEqual=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
const sleep=ms=>new Promise(accept=>setTimeout(accept,ms));
async function readJSON(file){try{const contents=await readFile(file,'utf8');if(contents.length>16384)throw Error('Oversized update metadata');return JSON.parse(contents);}catch(e){if(e.code==='ENOENT')return undefined;throw e;}}
export async function writeUpdateJSON(file,value){
  const temporary=`${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,handle=await open(temporary,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
  try{await rename(temporary,file);}catch(e){await rm(temporary,{force:true});throw e;}
}
export function supportedUpdateNode(version){const [major,minor,patch]=String(version).split('.').map(Number);return Number.isInteger(major)&&Number.isInteger(minor)&&Number.isInteger(patch)&&(major>24||major===24&&minor>=13);}
export function safeToUpdate(snapshot){return Boolean(snapshot&&['ready','stopped','resume_required'].includes(snapshot.service?.status)&&Array.isArray(snapshot.groups)&&snapshot.groups.every(g=>['stopped','paused'].includes(g.status)&&!g.activeAttemptId&&!g.controlIntent)&&Array.isArray(snapshot.attempts)&&!snapshot.attempts.some(a=>activeAttempts.has(a.status)));}
export function assertUpdateSafe(snapshot){if(!safeToUpdate(snapshot))throw error('UPDATE_BUSY','모든 그룹을 중지하거나 일시정지하고 진행 중·미확인 발송과 중지 확인을 먼저 해결하세요.');}
export function publicUpdateStatus(value={}){
  const phase=['idle','preparing','ready','applying','completed','failed'].includes(value.phase)?value.phase:'idle';
  return{phase,message:messages[value.message]||messages[phase],...(Number.isSafeInteger(value.startedAt)?{startedAt:value.startedAt}:{}),...(Number.isSafeInteger(value.updatedAt)?{updatedAt:value.updatedAt}:{}),...(typeof value.version==='string'&&/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]{1,40})?$/.test(value.version)?{version:value.version}:{})};
}
async function findFile(candidates){for(const file of candidates)if(file&&isAbsolute(file))try{const actual=await realpath(file);if((await lstat(actual)).isFile())return actual;}catch{}return undefined;}
async function discoverNpm(node,app,env){
  const metadata=await readJSON(join(app,'update-installation.json')).catch(()=>undefined);
  const candidates=[metadata?.npmCli,join(dirname(node),'node_modules/npm/bin/npm-cli.js'),join(dirname(node),'../lib/node_modules/npm/bin/npm-cli.js')];
  for(const folder of (env.PATH||'').split(delimiter).filter(Boolean)){
    candidates.push(join(folder,'node_modules/npm/bin/npm-cli.js'),join(folder,'../lib/node_modules/npm/bin/npm-cli.js'));
    try{const path=await realpath(join(folder,'npm'));if(path.endsWith('npm-cli.js'))candidates.push(path);}catch{}
  }
  return findFile(candidates.filter(file=>typeof file==='string'&&file.endsWith('npm-cli.js')));
}
export async function inspectUpdateInstallation({directory,applicationRoot=resolve(dirname(modulePath),'../..'),node=process.execPath,nodeVersion=process.versions.node,env=process.env}={}){
  const app=join(resolve(directory),'app');
  try{
    if(resolve(applicationRoot)!==app||await realpath(app)!==app||await realpath(node)!==await realpath(join(app,'runtime',process.platform==='win32'?'node.exe':'node')))throw Error('Not installed');
    for(const part of ['central','extension','runtime'])if((await lstat(join(app,part))).isSymbolicLink())throw Error('Linked installation');
    await access(join(app,'central/runtime/main.mjs'));await access(join(app,'extension/manifest.json'));
  }catch{throw error('UPDATE_MANUAL_REQUIRED','설치된 관리 프로그램에서만 자동 업데이트할 수 있습니다. 최신 설치 도구로 설치한 관리 화면을 열어 주세요.');}
  if(!supportedUpdateNode(nodeVersion))throw error('UPDATE_RUNTIME_REQUIRED','Node 24.13 이상이 필요합니다. 런타임 변경은 setup.command 또는 setup.ps1로 설치하세요.');
  const npmCli=await discoverNpm(node,app,env);
  if(!npmCli)throw error('UPDATE_NPM_REQUIRED','npm을 찾지 못했습니다. npm이 포함된 Node 24.13 이상을 설치하거나 최신 설치 도구를 실행하세요.');
  const candidates=(env.PATH||'').split(delimiter).filter(Boolean).flatMap(folder=>[join(folder,process.platform==='win32'?'git.exe':'git')]);
  const git=await findFile(candidates);
  if(!git)throw error('UPDATE_GIT_REQUIRED','Git을 찾지 못했습니다. Git을 설치한 뒤 관리 프로그램을 다시 여세요.');
  try{await executeFile(git,['--version'],{timeout:5000,maxBuffer:4096,windowsHide:true});}catch{throw error('UPDATE_GIT_REQUIRED','Git을 실행하지 못했습니다. Git 설치를 확인한 뒤 관리 프로그램을 다시 여세요.');}
  return{app,node:await realpath(node),npmCli,git};
}
export function updateBuildPlan({checkout,workDirectory,node,npmCli,git}){
  return[{id:'source',command:git,args:['-c','credential.helper=','-c',`core.hooksPath=${join(workDirectory,'no-hooks')}`,'clone','--depth','1','--branch','main','--single-branch','--','https://github.com/JangKroed/dico-chat-while.git',checkout],cwd:workDirectory},
    {id:'dependencies',command:node,args:[npmCli,'--prefix','central/ui','ci'],cwd:checkout},
    {id:'build',command:node,args:[npmCli,'run','central:build'],cwd:checkout},
    {id:'check',command:node,args:[npmCli,'run','central:check'],cwd:checkout}];
}
export function updateEnvironment(node,workDirectory,source=process.env){
  const env={};for(const key of ['PATH','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL','PATHEXT'])if(source[key])env[key]=source[key];
  env.PATH=dirname(node)+delimiter+(env.PATH||'');
  env.GIT_TERMINAL_PROMPT='0';env.GIT_CONFIG_NOSYSTEM='1';env.GIT_CONFIG_GLOBAL=join(workDirectory,'empty-config');
  env.NPM_CONFIG_USERCONFIG=join(workDirectory,'empty-config');env.NPM_CONFIG_GLOBALCONFIG=join(workDirectory,'empty-global-config');env.NPM_CONFIG_CACHE=join(workDirectory,'npm-cache');env.NPM_CONFIG_REGISTRY='https://registry.npmjs.org/';
  return env;
}
async function workerLaunch(job){
  const privateNode=join(job.workDirectory,process.platform==='win32'?'node.exe':'node'),worker=join(job.workDirectory,'updater.mjs');
  await copyFile(job.node,privateNode);if(process.platform!=='win32')await chmod(privateNode,0o700);await copyFile(modulePath,worker);
  job.workerNode=privateNode;await writeUpdateJSON(join(job.workDirectory,'job.json'),job);
  const child=spawn(privateNode,[worker,'--job',join(job.workDirectory,'job.json')],{cwd:job.workDirectory,detached:true,stdio:'ignore',windowsHide:true});
  await new Promise((accept,reject)=>{child.once('spawn',accept);child.once('error',reject);});child.unref();return{pid:child.pid};
}
export function createUpdateController({directory,manager,shutdown,inspect=inspectUpdateInstallation,prepare=workerLaunch}={}){
  directory=resolve(directory);const updates=join(directory,'updates'),lock=join(updates,'active'),statusFile=join(updates,'status.json');
  let descriptor,activeJob,applying=false,launchPromise=Promise.resolve();
  const status=async()=>{
    let value=await readJSON(statusFile).catch(()=>({phase:'failed'}));
    const owner=await readJSON(join(lock,'owner.json')).catch(()=>undefined);
    if(['preparing','ready','applying'].includes(value?.phase)&&Number.isSafeInteger(owner?.workerPid)&&!alive(owner.workerPid)){
      value={...value,phase:'failed',message:'failed',updatedAt:Date.now()};await writeUpdateJSON(statusFile,value);
      await release(owner.jobToken);if(activeJob?.jobToken===owner.jobToken)activeJob=undefined;
    }
    // Earlier workers reported extension versions for manager-only updates.
    if(value?.phase==='completed'){
      const installed=await readJSON(join(directory,'app/central/package.json')).catch(()=>undefined);
      if(installed?.version)value={...value,version:installed.version};
    }
    return publicUpdateStatus(value);
  };
  async function release(jobToken){const owner=await readJSON(join(lock,'owner.json')).catch(()=>undefined);if(owner?.jobToken===jobToken)await rm(lock,{recursive:true,force:true});}
  async function start(){
    assertUpdateSafe(manager.snapshot());
    if(activeJob&&!applying){const latest=await readJSON(statusFile).catch(()=>undefined),owner=await readJSON(join(lock,'owner.json')).catch(()=>undefined);if(['completed','failed'].includes(latest?.phase)&&!owner)activeJob=undefined;}
    if(applying||activeJob)throw error('UPDATE_IN_PROGRESS','이미 업데이트를 준비하고 있습니다. 진행 상태를 확인하세요.');
    if(!descriptor)throw error('UPDATE_UNAVAILABLE','관리 프로그램의 연결 정보를 확인하지 못했습니다. 다시 실행하세요.',503);
    const installation=await inspect({directory});
    await mkdir(updates,{recursive:true,mode:0o700});
    if((await lstat(updates)).isSymbolicLink())throw error('UPDATE_MANUAL_REQUIRED','업데이트 작업 폴더가 다른 위치로 연결되어 있습니다. 설치 도구로 복구하세요.');
    await mkdir(join(updates,'jobs'),{recursive:true,mode:0o700});
    if((await lstat(join(updates,'jobs'))).isSymbolicLink())throw error('UPDATE_MANUAL_REQUIRED','업데이트 작업 폴더가 다른 위치로 연결되어 있습니다. 설치 도구로 복구하세요.');
    try{await mkdir(lock,{mode:0o700});}catch(e){
      if(e.code!=='EEXIST')throw e;
      const owner=await readJSON(join(lock,'owner.json')).catch(()=>undefined);
      if(!owner||alive(owner.controllerPid)||alive(owner.workerPid)||!Number.isSafeInteger(owner.workerPid))throw error('UPDATE_IN_PROGRESS','다른 업데이트 작업이 진행 중이거나 종료 확인이 필요합니다. 진행 상태를 확인하세요.');
      await rm(lock,{recursive:true});await mkdir(lock,{mode:0o700});
    }
    const jobToken=randomBytes(32).toString('hex'),jobId=randomBytes(16).toString('hex'),startedAt=Date.now(),workDirectory=join(updates,'jobs',jobId);
    try{
      await writeUpdateJSON(join(lock,'owner.json'),{jobToken,controllerPid:process.pid});
      await mkdir(workDirectory,{recursive:true,mode:0o700});
      const job={...installation,directory,workDirectory,jobId,jobToken,startedAt,descriptor};activeJob=job;
      await writeUpdateJSON(statusFile,{phase:'preparing',message:'preparing',startedAt,updatedAt:startedAt,jobId});
      launchPromise=(async()=>{
        try{
          const child=await prepare(job),owner=await readJSON(join(lock,'owner.json'));
          if(tokenEqual(owner?.jobToken,jobToken)&&!owner.workerPid)await writeUpdateJSON(join(lock,'owner.json'),{jobToken,controllerPid:process.pid,workerPid:child.pid});
        }catch{
          const latest=await readJSON(statusFile).catch(()=>undefined);
          if(latest?.jobId!==jobId||!['completed','failed'].includes(latest.phase))await writeUpdateJSON(statusFile,{phase:'failed',message:'failed',startedAt,updatedAt:Date.now(),jobId});
          await release(jobToken);if(activeJob?.jobToken===jobToken)activeJob=undefined;
        }
      })().catch(()=>{});
      return status();
    }catch(e){await release(jobToken);activeJob=undefined;throw e;}
  }
  async function apply({jobToken}={}){
    if(!activeJob||!tokenEqual(jobToken,activeJob.jobToken))throw error('UPDATE_AUTH_REQUIRED','업데이트 작업 인증이 필요합니다.',401);
    if(applying)throw error('UPDATE_IN_PROGRESS','업데이트 적용이 이미 진행 중입니다.');
    const prepared=await readJSON(statusFile);
    if(prepared?.phase!=='ready'||prepared.jobId!==activeJob.jobId)throw error('UPDATE_NOT_READY','업데이트 준비와 검사가 아직 끝나지 않았습니다.');
    assertUpdateSafe(manager.snapshot());
    applying=true;
    try{await writeUpdateJSON(join(directory,'shutdown.json'),{intent:'update',at:Date.now()});await writeUpdateJSON(statusFile,{phase:'applying',message:'applying',jobId:activeJob.jobId,startedAt:activeJob.startedAt,updatedAt:Date.now()});}
    catch(e){applying=false;throw e;}
    setTimeout(()=>void shutdown().catch(async()=>{await writeUpdateJSON(statusFile,{phase:'failed',message:'shutdown_failed',startedAt:activeJob.startedAt,updatedAt:Date.now()}).catch(()=>{});}),50);
    return{accepted:true};
  }
  return{status,start,apply,waitForLaunch:()=>launchPromise,isApplying:()=>applying,setRuntimeDescriptor:value=>{descriptor=value;}};
}
export async function withUpdateManagerLock(directory,action){
  const lock=new DatabaseSync(join(directory,'manager-lock.sqlite'));
  try{lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;');}
  catch{lock.close();throw error('UPDATE_RUNTIME_ACTIVE',messages.runtime_active);}
  try{return await action();}finally{try{lock.exec('ROLLBACK');}finally{lock.close();}}
}
export async function swapUpdateDirectories({app,prepared,backup,move=rename}){
  await mkdir(backup,{recursive:true,mode:0o700});const moved=[],installed=[];
  try{
    for(const part of ['central','extension']){
      await move(join(app,part),join(backup,part));moved.push(part);
      await move(join(prepared,part),join(app,part));installed.push(part);
    }
  }catch(failure){
    let rollbackFailed=false;
    for(const part of moved.reverse()){
      try{if(installed.includes(part))await move(join(app,part),join(prepared,part));await move(join(backup,part),join(app,part));}catch{rollbackFailed=true;}
    }
    throw error(rollbackFailed?'UPDATE_ROLLBACK_FAILED':'UPDATE_SWAP_FAILED',rollbackFailed?'이전 파일 복원을 완료하지 못했습니다. 설치 도구로 복구하세요.':messages.apply_failed,500);
  }
}
async function validateJob(jobPath){
  const info=await lstat(jobPath);if(!info.isFile()||process.platform!=='win32'&&(info.mode&0o077)||typeof process.getuid==='function'&&info.uid!==process.getuid())throw Error('Private update job required');
  const job=await readJSON(jobPath);
  if(!job||!isAbsolute(job.directory)||!/^[a-f0-9]{32}$/.test(job.jobId)||!/^[a-f0-9]{64}$/.test(job.jobToken)||resolve(job.workDirectory)!==join(resolve(job.directory),'updates','jobs',job.jobId)||resolve(jobPath)!==join(job.workDirectory,'job.json')||job.app!==join(resolve(job.directory),'app'))throw Error('Invalid update job');
  const url=new URL(job.descriptor.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!/^[a-f0-9]{64}$/.test(job.descriptor.bridgeToken)||!Number.isSafeInteger(job.descriptor.pid))throw Error('Invalid update endpoint');
  return job;
}
async function runStep(step,env){await executeFile(step.command,step.args,{cwd:step.cwd,env,timeout:20*60*1000,maxBuffer:1024*1024,windowsHide:true});}
async function waitForStopped(job){
  for(let count=0;count<120;count++){
    const descriptor=await readJSON(join(job.directory,'runtime.json')).catch(()=>undefined);
    if(!descriptor&&!alive(job.descriptor.pid))return;
    await sleep(250);
  }
  throw Error('Runtime did not stop');
}
export function restartArguments(job){return[join(job.app,'central/runtime/main.mjs'),'--data-dir',job.directory];}
async function restartApplication(job){
  const child=spawn(job.node,restartArguments(job),{cwd:job.app,detached:true,stdio:'ignore',windowsHide:true});
  await new Promise((accept,reject)=>{child.once('spawn',accept);child.once('error',reject);});child.unref();
  for(let count=0;count<80;count++){
    const descriptor=await readJSON(join(job.directory,'runtime.json')).catch(()=>undefined);
    if(Number.isSafeInteger(descriptor?.pid)&&alive(descriptor.pid)&&/^http:\/\/127\.0\.0\.1:\d+$/.test(descriptor.url||'')&&typeof descriptor.bridgeToken==='string'){const result=await fetch(descriptor.url+'/api/bridge/status',{headers:{Authorization:`Bearer ${descriptor.bridgeToken}`},signal:AbortSignal.timeout(1000)}).catch(()=>undefined);if(result?.ok)return;}
    if(!alive(child.pid))break;await sleep(250);
  }
  throw Object.assign(Error('Updated runtime did not become ready'),{rollbackSafe:!alive(child.pid)});
}
export async function runUpdateWorker(jobPath,{run=runStep,fetchRequest=fetch,waitStopped=waitForStopped,restart=restartApplication}={}){
  const job=await validateJob(resolve(jobPath)),updates=join(job.directory,'updates'),lock=join(updates,'active'),statusFile=join(updates,'status.json');
  const owner=await readJSON(join(lock,'owner.json'));if(!tokenEqual(owner?.jobToken,job.jobToken))throw Error('Update lock changed');
  await mkdir(join(job.workDirectory,'running'),{mode:0o700});
  await writeUpdateJSON(join(lock,'owner.json'),{jobToken:job.jobToken,controllerPid:job.descriptor.pid,workerPid:process.pid});
  let stage='source',shutdownApproved=false,version,previousVersion;
  const report=(phase,message)=>writeUpdateJSON(statusFile,{phase,message,startedAt:job.startedAt,updatedAt:Date.now(),jobId:job.jobId,...(version?{version}:{})});
  try{
    const checkout=join(job.workDirectory,'checkout'),prepared=join(job.workDirectory,'prepared'),backup=join(job.workDirectory,'previous'),env=updateEnvironment(job.workerNode,job.workDirectory);
    for(const name of ['no-hooks'])await mkdir(join(job.workDirectory,name),{recursive:true,mode:0o700});
    for(const name of ['empty-config','empty-global-config'])await writeFile(join(job.workDirectory,name),'',{mode:0o600});
    for(const step of updateBuildPlan({...job,node:job.workerNode,checkout})) {stage=step.id;await report('preparing',stage);await run(step,env);}
    const current=await readJSON(join(job.app,'extension/manifest.json')),next=await readJSON(join(checkout,'central/extension/manifest.json'));
    if(!current?.key||next?.key!==current.key)throw Error('Extension identity changed');
    const pkg=await readJSON(join(checkout,'central/package.json'));version=pkg?.version||next.version;previousVersion=(await readJSON(join(job.app,'central/package.json')))?.version||current.version;
    const minimum=/^>=(\d+\.\d+\.\d+)$/.exec(pkg?.engines?.node||'');
    if(!minimum||!supportedUpdateNode(process.versions.node)||minimum[1].split('.').some((part,index,parts)=>{const currentParts=process.versions.node.split('.').map(Number);return parts.slice(0,index).every((p,n)=>Number(p)===currentParts[n])&&Number(part)>currentParts[index];}))throw Error('Manual runtime upgrade required');
    await access(join(checkout,'central/ui/dist/index.html'));await access(join(checkout,'central/runtime/main.mjs'));
    await mkdir(prepared,{mode:0o700});
    await cp(join(checkout,'central'),join(prepared,'central'),{recursive:true,filter:file=>!file.split(/[\\/]/).some(part=>['node_modules','.git'].includes(part))});
    await cp(join(checkout,'central/extension'),join(prepared,'extension'),{recursive:true});
    await report('ready','ready');stage='authorize';
    const reply=await fetchRequest(job.descriptor.url+'/api/bridge/update/apply',{method:'POST',headers:{Authorization:`Bearer ${job.descriptor.bridgeToken}`,'Content-Type':'application/json'},body:JSON.stringify({jobToken:job.jobToken}),signal:AbortSignal.timeout(10000)});
    if(!reply.ok){stage=reply.status===409?'busy':'authorize';throw Error('Update apply denied');}
    shutdownApproved=true;stage='shutdown';await waitStopped(job);stage='apply';await report('applying','applying');
    await withUpdateManagerLock(job.directory,()=>swapUpdateDirectories({app:job.app,prepared,backup}));stage='restart';await restart(job);await report('completed','completed');
    await rm(checkout,{recursive:true,force:true});await rm(backup,{recursive:true,force:true});await rm(join(job.workDirectory,'npm-cache'),{recursive:true,force:true});
  }catch(e){
    let message=e.code==='UPDATE_RUNTIME_ACTIVE'?'runtime_active':e.code==='UPDATE_ROLLBACK_FAILED'?'rollback_failed':stage==='busy'?'busy':messages[`${stage}_failed`]?`${stage}_failed`:'failed';
    // Roll back a failed launch only after proving the new process exited; never swap a possibly live runtime.
    if(shutdownApproved&&stage==='restart'&&e.rollbackSafe===true){
      try{
        await withUpdateManagerLock(job.directory,()=>swapUpdateDirectories({app:job.app,prepared:join(job.workDirectory,'previous'),backup:join(job.workDirectory,'failed-version')}));
        version=previousVersion;message='restart_rolled_back';await restart(job);
      }catch(rollbackError){message=rollbackError.code==='UPDATE_RUNTIME_ACTIVE'?'restart_failed':'rollback_failed';}
    }else if(shutdownApproved&&stage==='apply'&&!['UPDATE_ROLLBACK_FAILED','UPDATE_RUNTIME_ACTIVE'].includes(e.code)){
      // The selective swap already restored the old JavaScript trees.
      await restart(job).catch(()=>{message='restart_failed';});
    }
    await report('failed',message);
  }finally{const latest=await readJSON(join(lock,'owner.json')).catch(()=>undefined);if(tokenEqual(latest?.jobToken,job.jobToken))await rm(lock,{recursive:true,force:true});}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const index=process.argv.indexOf('--job');
  if(index<0||!process.argv[index+1])process.exitCode=1;
  else await runUpdateWorker(process.argv[index+1]).catch(()=>{process.exitCode=1;});
}
