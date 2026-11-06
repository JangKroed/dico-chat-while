/**
 * 기존 설치 폴더 안에서 수행하는 업데이트와 실패 진단입니다.
 * 컨트롤러는 요청·상태·종료 승인을 관리하고, 독립 worker가 준비·검사·교체·재시작을 수행합니다.
 * worker는 자신과 Node를 별도 작업 폴더로 복사하여 실행하므로 교체할 앱 파일에 실행 중 의존하지 않습니다.
 */
import {randomBytes,timingSafeEqual,createHash} from 'node:crypto';
import {access,chmod,copyFile,cp,lstat,mkdir,mkdtemp,open,readFile,readdir,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve,delimiter,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {DatabaseSync,backup as backupSQLite} from 'node:sqlite';

const executeFile=promisify(execFile);
const updateSource='https://github.com/JangKroed/dico-chat-while.git';
const modulePath=fileURLToPath(import.meta.url);
const activeAttempts=new Set(['preparing','prepared','permitted','executing','unknown']);
const messages={idle:'업데이트를 실행하면 최신 버전을 준비한 뒤 관리 프로그램을 다시 엽니다.',preparing:'업데이트 작업을 준비하고 있습니다.',source:'공식 저장소의 최신 버전을 별도 폴더에 내려받고 있습니다.',dependencies:'업데이트 준비 정보를 확인하고 있습니다.',build:'검증된 화면 파일과 확장 프로그램을 준비하고 있습니다.',retrying:'일시적인 연결 오류를 감지했습니다. 프로그램이 자동으로 다시 시도하고 있습니다.',check:'새 버전의 구문과 확장 설정을 검사하고 있습니다.',ready:'준비가 끝났습니다. 발송이 중지되어 있는지 다시 확인합니다.',applying:'발송이 중지된 것을 확인했습니다. 관리 프로그램을 업데이트합니다.',completed:'업데이트를 완료했습니다. 새 관리 화면에서 버전을 확인하세요.',failed:'업데이트를 완료하지 못했습니다. 자동 진단 결과와 제보 상태를 확인하고 있습니다.',busy:'준비 중 실행 상태가 바뀌어 업데이트를 중단했습니다. 모든 그룹을 중지한 뒤 다시 시도하세요.',source_failed:'업데이트 파일을 받지 못했습니다. 자동 재시도 결과와 진단 정보를 기록했습니다.',dependencies_failed:'업데이트 준비 정보를 처리하지 못했습니다. 실패 진단을 기록했습니다.',build_failed:'업데이트 파일 준비를 완료하지 못했습니다. 현재 설치를 유지하고 진단 정보를 기록했습니다.',check_failed:'새 버전 검사를 통과하지 못했습니다. 현재 설치를 유지합니다.',apply_failed:'설치 파일을 교체하지 못했습니다. 기존 설치를 유지·복원했습니다. 파일을 사용하는 프로그램을 확인하세요.',authorize_failed:'최종 업데이트 적용을 승인받지 못했습니다. 현재 관리 화면에서 상태를 확인한 뒤 다시 시도하세요.',rollback_failed:'이전 버전 파일 복원을 완료하지 못했습니다. 관리 프로그램을 실행하기 전에 최신 설치 도구로 복구하세요.',restart_rolled_back:'새 버전을 시작하지 못해 이전 버전으로 복원했습니다. 최신 설치 도구를 실행하거나 나중에 다시 시도하세요.',restart_failed:'설치 후 관리 프로그램 시작을 확인하지 못했습니다. 설치된 실행기로 다시 열거나 설치 도구를 실행하세요.',shutdown_failed:'관리 프로그램 종료를 확인하지 못했습니다. 설치 파일은 바꾸지 않았습니다.',shutdown_recovered:'업데이트 종료 확인에 실패해 이전 관리 프로그램을 다시 열었습니다.',runtime_active:'다른 관리 프로그램이 실행되어 파일을 교체하지 않았습니다. 모두 종료한 뒤 다시 시도하세요.',manual:'이 설치에는 수동 설치 도구가 필요합니다. 최신 setup.command 또는 setup.ps1을 실행하세요.'};

const failureMessages={
 NETWORK:'업데이트 서버와의 연결이 끊겼습니다.',
 DISK_FULL:'업데이트 파일을 저장할 공간이 부족합니다. 기존 설치와 기록은 보존했습니다.',
 PERMISSION:'운영체제가 업데이트 파일 접근을 거부했습니다. 권한 설정을 임의로 변경하지 않았습니다.',
 TOOL_MISSING:'설치에 포함된 실행 도구를 찾지 못했습니다. 배포 파일 점검이 필요합니다.',
 PROCESS_BLOCKED:'업데이트 준비 프로그램이 운영체제에 의해 종료됐습니다.',
 BUNDLE_INVALID:'받은 업데이트 파일의 무결성 검사에 실패했습니다. 적용하지 않았습니다.',
 TIMEOUT:'업데이트 준비 작업이 제한 시간 안에 끝나지 않았습니다.',
 PROCESS_EXITED:'업데이트 작업이 예기치 않게 종료됐습니다.',
 DETAILS_UNAVAILABLE:'이전 버전이 상세 진단을 남기지 않았습니다. 남아 있는 실패 단계와 버전 정보를 수집했습니다.',
 ROLLBACK_INCOMPATIBLE:'보관된 버전이 현재 설정과 기록을 보존하지 못하여 되돌리기를 중단했습니다.',
 UNEXPECTED:'업데이트 처리 중 예상하지 못한 오류가 발생했습니다. 실패 단계와 실행 결과를 기록했습니다.'
};
const failureStages=new Set(['preparing','source','dependencies','build','check','authorize','busy','shutdown','apply','restart','unknown']);
/**
 * 내부 예외에서 알려진 실패 범주만 추립니다. UI에 원본 stderr·개인 경로·자격정보를 노출하지 않습니다.
 */
export function classifyUpdateFailure(error={},stage='unknown'){
 const text=[error.code,error.message,error.stderr].map(value=>String(value||'').slice(0,8192)).join('\n');
 const code=error.code==='ROLLBACK_INCOMPATIBLE'?'ROLLBACK_INCOMPATIBLE':/ENOSPC|no space left/i.test(text)?'DISK_FULL':/EACCES|EPERM|permission denied/i.test(text)?'PERMISSION':
 /UPDATE_(?:NPM|GIT|RUNTIME)_REQUIRED|npm:.*not found|not recognized as an internal|spawn.*ENOENT/i.test(text)?'TOOL_MISSING':
 /Prebuilt.*(?:mismatch|missing)|ENOENT.*prebuilt/i.test(text)?'BUNDLE_INVALID':
 error.signal==='SIGKILL'?'PROCESS_BLOCKED':
 /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|could not resolve host|failed to connect|connection timed out|requested URL returned error: (?:429|50[234])/i.test(text)?'NETWORK':
 error.killed||error.code==='UPDATE_SHUTDOWN_TIMEOUT'?'TIMEOUT':'UNEXPECTED';
 return publicUpdateDiagnostic({code,stage,exitCode:Number.isInteger(error.code)?error.code:undefined,signal:error.signal});
}
/**
 * 화면과 제보에 허용한 필드·값만 내보내는 경계입니다. 임의 객체 전체를 반환하지 않습니다.
 */
export function publicUpdateDiagnostic(value){
 if(!value||!Object.hasOwn(failureMessages,value.code))return undefined;
 return {code:value.code,stage:failureStages.has(value.stage)?value.stage:'unknown',message:failureMessages[value.code],
 ...(Number.isInteger(value.exitCode)&&value.exitCode>=0&&value.exitCode<=255?{exitCode:value.exitCode}:{}),
 ...(['SIGKILL','SIGTERM','SIGABRT','SIGSEGV'].includes(value.signal)?{signal:value.signal}:{})};
}
function publicSupport(value){
 if(!value||!['disabled','manual','unconfigured','collecting','queued','sending','sent','failed','unavailable'].includes(value.status))return undefined;
 return {status:value.status,...(typeof value.reportId==='string'&&/^[a-f0-9-]{36}$/.test(value.reportId)?{reportId:value.reportId}:{}),
 ...(typeof value.receiptId==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value.receiptId)?{receiptId:value.receiptId}:{})};
}

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
// 롤백 슬롯은 사용자가 전달한 경로를 받지 않는다. 설치별 고정 경로의 검증된
// central/extension 코드만 대상으로 하며 데이터베이스·설정·로그는 포함하지 않는다.
const rollbackPath=directory=>join(resolve(directory),'updates','rollback');
async function codeIdentity(root,{deadline=Infinity,maxBytes=256*1024*1024}={}){
  const digest=createHash('sha256');let bytes=0,files=0;
  async function visit(path,relative){
    if(Date.now()>deadline)throw Error('Rollback capture deadline exceeded');
    const info=await lstat(path);if(info.isSymbolicLink())throw Error('Linked rollback tree');
    if(info.isDirectory()){
      for(const entry of (await readdir(path)).sort())await visit(join(path,entry),relative+'/'+entry);
    }else if(info.isFile()){
      if(++files>20000||(bytes+=info.size)>maxBytes)throw Error('Oversized rollback tree');
      const body=await readFile(path);digest.update(relative);digest.update('\0');digest.update(String(body.length));digest.update('\0');digest.update(body);
    }else throw Error('Invalid rollback tree');
  }
  if((await lstat(root)).isSymbolicLink())throw Error('Linked rollback root');
  for(const part of ['central','extension'])await visit(join(root,part),part);
  const pkg=await readJSON(join(root,'central/package.json')),manifest=await readJSON(join(root,'extension/manifest.json'));
  if(pkg?.name!=='dico-manager'||!/^\d+\.\d+\.\d+$/.test(pkg.version||'')||typeof manifest?.key!=='string'||!manifest.key)throw Error('Invalid rollback identity');
  await access(join(root,'central/runtime/main.mjs'));await access(join(root,'central/core/index.js'));await access(join(root,'central/ui/dist/index.html'));
  return {version:pkg.version,key:manifest.key,hash:digest.digest('hex')};
}
async function verifiedRollback(directory){
  const updates=join(resolve(directory),'updates'),slot=rollbackPath(directory);
  if((await lstat(updates)).isSymbolicLink()||(await lstat(slot)).isSymbolicLink()||(await lstat(join(slot,'rollback.json'))).isSymbolicLink())throw Error('Linked rollback slot');
  const saved=await readJSON(join(slot,'rollback.json')),actual=await codeIdentity(slot);
  if(saved?.format!==1||saved.version!==actual.version||saved.key!==actual.key||saved.hash!==actual.hash)throw Error('Rollback integrity mismatch');
  const current=await readJSON(join(directory,'app/extension/manifest.json'));
  if(current&&current.key!==actual.key)throw Error('Rollback extension identity changed');
  return actual;
}
export async function rollbackAvailability({directory}={}){
  try{const value=await verifiedRollback(directory),current=await readJSON(join(directory,'app/central/package.json'));if(current?.version===value.version)return{available:false,version:value.version,reason:'SAME_VERSION'};return{available:true,version:value.version};}
  catch(e){return{available:false,reason:e.code==='ENOENT'?'NO_BACKUP':'BACKUP_INVALID'};}
}
/** 정상 시작을 확인한 업데이트의 직전 다른 버전 한 개만 원자적으로 보관한다. */
export async function retainRollbackVersion({directory,source,currentVersion,deadline=Infinity,maxBytes}={}){
  const identity=await codeIdentity(source,{deadline,maxBytes});if(identity.version===currentVersion)return;
  const updates=join(resolve(directory),'updates');await mkdir(updates,{recursive:true,mode:0o700});
  if((await lstat(updates)).isSymbolicLink())throw Error('Linked rollback parent');
  const slot=rollbackPath(directory),stage=join(updates,'rollback-next-'+randomBytes(8).toString('hex')),retired=join(updates,'rollback-retired-'+randomBytes(8).toString('hex'));
  await mkdir(stage,{mode:0o700});let moved=false;
  try{
    for(const part of ['central','extension'])await cp(join(source,part),join(stage,part),{recursive:true,filter:()=>{if(Date.now()>deadline)throw Error('Rollback capture deadline exceeded');return true;}});
    const copied=await codeIdentity(stage,{deadline,maxBytes});if(copied.hash!==identity.hash)throw Error('Rollback copy changed');
    await writeUpdateJSON(join(stage,'rollback.json'),{format:1,...copied,createdAt:Date.now()});
    try{await lstat(slot);if((await lstat(slot)).isSymbolicLink())throw Error('Linked rollback slot');await rename(slot,retired);moved=true;}catch(e){if(e.code!=='ENOENT')throw e;}
    try{await rename(stage,slot);}catch(e){if(moved)await rename(retired,slot);throw e;}
    if(moved)await rm(retired,{recursive:true,force:true});
  }finally{await rm(stage,{recursive:true,force:true}).catch(()=>{});}
}
/**
 * 구 worker는 새 앱의 health 응답을 받은 다음 previous를 삭제한다. 설치된 새 앱은
 * HTTP를 열기 전에 활성 작업의 private 토큰/경로/프로세스를 확인하고 이전본을 보관한다.
 * 실패해도 앱 시작을 막지 않으며 임의 작업 폴더를 탐색하거나 과거 파일을 추측하지 않는다.
 */
export async function captureLegacyRollback({directory,applicationRoot=resolve(dirname(modulePath),'../..')}={}){
  try{
    const app=join(resolve(directory),'app'),updates=join(resolve(directory),'updates');
    if(resolve(applicationRoot)!==app)return;
    for(const path of [updates,join(updates,'active')])if((await lstat(path)).isSymbolicLink())return;
    const status=await readJSON(join(updates,'status.json')),owner=await readJSON(join(updates,'active/owner.json'));
    if(status?.phase!=='applying'||!/^[a-f0-9]{32}$/.test(status.jobId||'')||!alive(owner?.workerPid))return;
    const job=await validateJob(join(updates,'jobs',status.jobId,'job.json'));
    if(!tokenEqual(job.jobToken,owner.jobToken)||job.app!==app||job.directory!==resolve(directory))return;
    if(await realpath(job.workDirectory)!==join(await realpath(directory),'updates','jobs',job.jobId))return;
    const deadline=Date.now()+8000,source=join(job.workDirectory,'previous'),identity=await codeIdentity(source,{deadline,maxBytes:32*1024*1024});
    const current=await readJSON(join(app,'extension/manifest.json')),pkg=await readJSON(join(app,'central/package.json'));
    if(identity.key!==current?.key)return;
    await retainRollbackVersion({directory,source,currentVersion:pkg?.version,deadline,maxBytes:32*1024*1024});
  }catch{/* 캡처 불가 상태는 rollbackAvailability에서 NO_BACKUP/BACKUP_INVALID로 공개한다. */}
}
/**
 * 현재 SQLite를 backup API로 일관되게 복제한 뒤 구버전 core로 실제 읽기 검사를 한다.
 * 검사는 별도 프로세스·임시 DB에서만 실행하므로 실제 데이터의 마이그레이션/복원은 없다.
 * 실제 앱을 중지한 뒤에도 다시 검사하여 준비 이후의 저장 형식 변경을 놓치지 않는다.
 */
export async function verifyRollbackCompatibility({directory,target,node=process.execPath,workDirectory}={}){
  const database=join(directory,'central.sqlite');let info;
  try{info=await lstat(database);}catch(e){if(e.code==='ENOENT')return;throw e;}
  if(info.isSymbolicLink()||!info.isFile())throw error('ROLLBACK_INCOMPATIBLE','현재 데이터 형식을 안전하게 검사하지 못했습니다.');
  const temporary=join(workDirectory,'rollback-compat-'+randomBytes(8).toString('hex')+'.sqlite');
  // 호환성은 단순히 파일을 열 수 있다는 뜻이 아닙니다. 같은 schemaVersion의
  // 과거 시작 코드도 사용자 설정·문구·확정 이력 등을 조용히 바꿀 수 있으므로
  // 복제본 실행 전후를 비교합니다. 원본 DB에는 읽기 전용 연결만 사용합니다.
  const inspect=(path,eventBoundary)=>{
    const db=new DatabaseSync(path,{readOnly:true});
    try{
      const row=db.prepare('SELECT data FROM central_state WHERE singleton=1').get();
      const state=row?JSON.parse(row.data):null;
      const boundary=eventBoundary??db.prepare('SELECT COALESCE(MAX(event_id),0) AS id FROM events').get().id;
      const digest=createHash('sha256');
      for(const event of db.prepare('SELECT event_id,at,type,data FROM events WHERE event_id<=? ORDER BY event_id').iterate(boundary))digest.update(JSON.stringify(event)).update('\0');
      return{state,boundary,eventHash:digest.digest('hex')};
    }finally{db.close();}
  };
  // 시작 시 새 세션을 만들거나 연결 검증을 해제하고 deadline을 재계산하는
  // 런타임 필드만 제외합니다. 사용자 필드의 삭제/값 변경, 배열 순서 변경은
  // 거절하고, 구버전이 기존 데이터를 보존하며 기본 필드를 추가하는 것은 허용합니다.
  const preserve=(before,after)=>{
    if(before===null||typeof before!=='object')return Object.is(before,after);
    if(!after||typeof after!=='object'||Array.isArray(before)!==Array.isArray(after))return false;
    if(Array.isArray(before))return before.length===after.length&&before.every((value,index)=>preserve(value,after[index]));
    return Object.keys(before).every(key=>Object.hasOwn(after,key)&&preserve(before[key],after[key]));
  };
  const omit=(value,fields)=>Object.fromEntries(Object.entries(value).filter(([key])=>!fields.includes(key)));
  const stable=state=>{
    const value=structuredClone(state);
    for(const key of ['service','stateVersion','lastEventId','retryPolicyVersion','intervals'])delete value[key];
    for(const [list,fields] of [
      ['instances',['sessionId','connected','lastSeenMono']],
      ['accounts',['verified']],
      ['channels',['verified','appliedVersion','tabId','sessionId','nextMono','lastConfirmedMono']],
      ['groups',['nextMono']],
    ])if(Array.isArray(value[list]))value[list]=value[list].map(item=>omit(item,fields));
    return value;
  };
  try{
    const source=new DatabaseSync(database,{readOnly:true});
    try{await backupSQLite(source,temporary);}finally{source.close();}
    const before=inspect(temporary);
    const module=pathToFileURL(join(target,'central/core/index.js')).href;
    const script=`const {createCentralManager}=await import(${JSON.stringify(module)}); const manager=createCentralManager({databasePath:${JSON.stringify(temporary)}}); try {const snapshot=manager.snapshot(); if(snapshot.schemaVersion!==1||snapshot.service?.status==='storage_failure')throw Error('incompatible');}finally{manager.close();}`;
    await executeFile(node,['--input-type=module','-e',script],{timeout:15000,maxBuffer:65536,windowsHide:true});
    const after=inspect(temporary,before.boundary);
    if(!before.state||!after.state||before.eventHash!==after.eventHash)throw Error('History changed');
    const oldStable=stable(before.state),newStable=stable(after.state);
    // 대기 명령을 재시작 시 폐기하는 것은 안전한 세션 차단입니다. 그 외 명령
    // 필드와 이미 완료된 명령 상태는 그대로 남아 있어야 합니다.
    for(let index=0;index<(oldStable.commands||[]).length;index++){
      const previous=oldStable.commands[index],next=newStable.commands?.[index];
      if(['queued','received'].includes(previous.status)&&next?.status==='superseded')previous.status='superseded';
    }
    if(!preserve(oldStable,newStable)||!safeToUpdate(after.state))throw Error('User data or stopped state changed');
    for(const interval of before.state.intervals||[]){
      const next=after.state.intervals?.find(item=>item.id===interval.id);
      if(!next)throw Error('Interval removed');
      if(interval.to===null){
        if(!preserve(omit(interval,['to']),omit(next,['to']))||!(next.to===null||Number.isFinite(next.to)&&next.to>=interval.from))throw Error('Open interval changed');
      }else if(!preserve(interval,next))throw Error('Closed interval changed');
    }
  }catch{throw error('ROLLBACK_INCOMPATIBLE','보관된 버전이 현재 설정과 기록을 보존하지 못하여 되돌리기를 중단했습니다.');}
  finally{for(const suffix of ['','-wal','-shm'])await rm(temporary+suffix,{force:true}).catch(()=>{});}
}
export function supportedUpdateNode(version){const [major,minor,patch]=String(version).split('.').map(Number);return Number.isInteger(major)&&Number.isInteger(minor)&&Number.isInteger(patch)&&(major>24||major===24&&minor>=13);}
/**
 * 그룹 중지와 실제 입력 차단을 함께 확인합니다. 과거 결과가 unknown이어도
 * 현재 실행 차단이 입증되면 이력을 그대로 보존하며 교체할 수 있습니다.
 */
export function safeToUpdate(snapshot){return safeToReloadExtension(snapshot)&&snapshot.groups.every(g=>['stopped','paused'].includes(g.status));}
/**
 * 확장 코드 교체는 관리 프로그램 전체 교체와 구분한다. 이미 입력 차단이 확인된
 * 미확인 결과는 기록·그룹 잠금을 그대로 보존한 채 확장만 교체할 수 있다.
 * 실제 준비/실행 중이거나 중지 확인 중인 경우에는 여전히 교체를 금지한다.
 */
export function safeToReloadExtension(snapshot){
  if(!snapshot||!['ready','stopped','resume_required'].includes(snapshot.service?.status)||!Array.isArray(snapshot.groups)||!Array.isArray(snapshot.attempts))return false;
  const blocked=new Map(snapshot.attempts.filter(a=>a.status==='unknown'&&a.executionBlocked===true&&typeof a.id==='string').map(a=>[a.id,a]));
  if(snapshot.attempts.some(a=>activeAttempts.has(a.status)&&!blocked.has(a.id)))return false;
  return snapshot.groups.every(group=>{
    if(!['stopped','paused','needs_review'].includes(group.status)||group.controlIntent)return false;
    if(!group.activeAttemptId)return true;
    const attempt=blocked.get(group.activeAttemptId);
    return Boolean(attempt&&attempt.groupId===group.id);
  });
}
export function assertUpdateSafe(snapshot){if(!safeToUpdate(snapshot))throw error('UPDATE_BUSY','모든 그룹을 중지하거나 일시정지하고 진행 중·미확인 발송과 중지 확인을 먼저 해결하세요.');}
export function publicUpdateStatus(value={}){
  const phase=['idle','preparing','ready','applying','completed','failed'].includes(value.phase)?value.phase:'idle';
  return{phase,mode:value.mode==='rollback'?'rollback':'update',...(publicUpdateDiagnostic(value.diagnostic)?{diagnostic:publicUpdateDiagnostic(value.diagnostic)}:{}),retryCount:Number.isInteger(value.retryCount)?Math.min(2,Math.max(0,value.retryCount)):0,retrying:value.retrying===true,message:messages[value.message]||messages[phase],...(Number.isSafeInteger(value.startedAt)?{startedAt:value.startedAt}:{}),...(Number.isSafeInteger(value.updatedAt)?{updatedAt:value.updatedAt}:{}),...(typeof value.version==='string'&&/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]{1,40})?$/.test(value.version)?{version:value.version}:{})};
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
export async function inspectUpdateInstallation({directory,applicationRoot=resolve(dirname(modulePath),'../..'),node=process.execPath,nodeVersion=process.versions.node,env=process.env,toolsRequired=true}={}){
  const app=join(resolve(directory),'app');
  try{
    if(resolve(applicationRoot)!==app||await realpath(app)!==app||await realpath(node)!==await realpath(join(app,'runtime',process.platform==='win32'?'node.exe':'node')))throw Error('Not installed');
    for(const part of ['central','extension','runtime'])if((await lstat(join(app,part))).isSymbolicLink())throw Error('Linked installation');
    await access(join(app,'central/runtime/main.mjs'));await access(join(app,'extension/manifest.json'));
  }catch{throw error('UPDATE_MANUAL_REQUIRED','설치된 관리 프로그램에서만 자동 업데이트할 수 있습니다. 최신 설치 도구로 설치한 관리 화면을 열어 주세요.');}
  if(!supportedUpdateNode(nodeVersion))throw error('UPDATE_RUNTIME_REQUIRED','Node 24.13 이상이 필요합니다. 런타임 변경은 setup.command 또는 setup.ps1로 설치하세요.');
  if(!toolsRequired)return{app,node:await realpath(node)};
  const npmCli=await discoverNpm(node,app,env);
  if(!npmCli)throw error('UPDATE_NPM_REQUIRED','npm을 찾지 못했습니다. npm이 포함된 Node 24.13 이상을 설치하거나 최신 설치 도구를 실행하세요.');
  const candidates=(env.PATH||'').split(delimiter).filter(Boolean).flatMap(folder=>[join(folder,process.platform==='win32'?'git.exe':'git')]);
  const git=await findFile(candidates);
  if(!git)throw error('UPDATE_GIT_REQUIRED','Git을 찾지 못했습니다. Git을 설치한 뒤 관리 프로그램을 다시 여세요.');
  try{await executeFile(git,['--version'],{timeout:5000,maxBuffer:4096,windowsHide:true});}catch{throw error('UPDATE_GIT_REQUIRED','Git을 실행하지 못했습니다. Git 설치를 확인한 뒤 관리 프로그램을 다시 여세요.');}
  return{app,node:await realpath(node),npmCli,git};
}
/**
 * 공식 소스를 준비하고 사전 빌드 결과를 검사하는 실행 계획입니다.
 * 사용자 기기에서 UI를 새로 컴파일하는 방식 대신 배포에 포함된 빌드 결과를 사용합니다.
 */
export function updateBuildPlan({checkout,workDirectory,node,npmCli,git}){
  return[{id:'source',command:git,args:['-c','credential.helper=','-c',`core.hooksPath=${join(workDirectory,'no-hooks')}`,'clone','--depth','1','--branch','main','--single-branch','--',updateSource,checkout],cwd:workDirectory},
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
// 설치 경로와 같은 Git·저장소를 사용해 버전 파일만 읽습니다.
export async function readPublishedVersion({git,node}){
  const workDirectory=await mkdtemp(join(tmpdir(),'dico-version-'));
  try{
    const cwd=join(workDirectory,'source');
    const env=updateEnvironment(node,workDirectory);
    const options={env,timeout:12000,maxBuffer:16384,windowsHide:true};
    const isolated=['-c','credential.helper=','-c',`core.hooksPath=${join(workDirectory,'no-hooks')}`];
    await executeFile(git,[...isolated,'clone','--depth','1','--filter=blob:none','--no-checkout','--branch','main','--single-branch','--',updateSource,cwd],options);
    const {stdout}=await executeFile(git,[...isolated,'show','HEAD:central/package.json'],{...options,cwd});
    return JSON.parse(stdout).version;
  }finally{await rm(workDirectory,{recursive:true,force:true});}
}
export async function checkLatestUpdate(currentVersion,{readVersion,now=Date.now}={}){
  const parse=value=>typeof value==='string'&&/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value)?value.split('.').map(Number):null;
  const current=parse(currentVersion);
  if(!current)return {state:'unavailable',checkedAt:now()};
  try{
    const version=await readVersion();
    const latest=parse(version);
    if(!latest)throw Error('Invalid version');
    const difference=latest.map((part,index)=>part-current[index]).find(value=>value!==0)||0;
    return {state:difference>0?'available':difference===0?'current':'ahead',currentVersion,latestVersion:version,checkedAt:now()};
  }catch{
    return {state:'unavailable',currentVersion,checkedAt:now()};
  }
}
export function createUpdateController({directory,manager,shutdown,inspect=inspectUpdateInstallation,prepare=workerLaunch,onFailure,supportStatus}={}){
  directory=resolve(directory);const updates=join(directory,'updates'),lock=join(updates,'active'),statusFile=join(updates,'status.json');
  let descriptor,activeJob,applying=false,launchPromise=Promise.resolve();

  const reportStateFile=join(updates,'report-state.json');
  let reporting=null,reportedJob=null,lastSupport=null,nextMonitorAt=0;
  /**
   * 실패 작업 ID별 제보를 생성합니다. 동시 요청은 같은 Promise를 공유합니다.
   * report-state.json은 재시작하거나 outbox가 정리되어도 동일 작업의 중복 제보를 막는 기록입니다.
   */
  async function reportFailure({automatic=false}={}){
    if(reporting)return reporting;
    reporting=(async()=>{
      const value=await readJSON(statusFile);
      if(value?.phase!=='failed'||!/^[a-f0-9]{32}$/.test(value.jobId||''))throw error('UPDATE_NO_FAILURE','제보할 업데이트 실패 기록이 없습니다.');
      const saved=await readJSON(reportStateFile).catch(()=>undefined);
      if(saved?.jobId===value.jobId&&publicSupport(saved.support)){
        reportedJob=value.jobId;lastSupport=publicSupport(saved.support);
        return lastSupport;
      }
      if(!onFailure){lastSupport={status:'unavailable'};return lastSupport;}
      const diagnostic=publicUpdateDiagnostic(value.diagnostic)||publicUpdateDiagnostic({code:'DETAILS_UNAVAILABLE',stage:String(value.message||'').replace(/_failed$/,'')});
      const result=await onFailure({jobId:value.jobId,diagnostic,retryCount:value.retryCount||0,automatic});
      if(result){reportedJob=value.jobId;lastSupport=publicSupport(result);await writeUpdateJSON(reportStateFile,{jobId:value.jobId,support:lastSupport});}
      return result;
    })();
    try{return await reporting;}finally{reporting=null;}
  }
  /**
   * UI를 열지 않아도 실패를 감시합니다. 제보 시도 간격을 제한하고 기존 자동 전송 동의를 따릅니다.
   */
  async function monitor(){
    if(Date.now()<nextMonitorAt)return;
    try{
      await status();
      const value=await readJSON(statusFile);
      if(value?.phase==='failed'&&value.jobId!==reportedJob){nextMonitorAt=Date.now()+30000;await reportFailure({automatic:true});}
    }catch{lastSupport={status:'failed'};}
  }

  const status=async()=>{
    let value=await readJSON(statusFile).catch(()=>({phase:'failed'}));
    const owner=await readJSON(join(lock,'owner.json')).catch(()=>undefined);
    if(['preparing','ready','applying'].includes(value?.phase)&&Number.isSafeInteger(owner?.workerPid)&&!alive(owner.workerPid)){
      value={...value,phase:'failed',message:'failed',diagnostic:{code:'PROCESS_EXITED',stage:'preparing'},updatedAt:Date.now()};await writeUpdateJSON(statusFile,value);
      await release(owner.jobToken);if(activeJob?.jobToken===owner.jobToken)activeJob=undefined;
    }
    // Earlier workers reported extension versions for manager-only updates.
    if(value?.phase==='completed'){
      const installed=await readJSON(join(directory,'app/central/package.json')).catch(()=>undefined);
      if(installed?.version)value={...value,version:installed.version};
    }
    let support=publicSupport(supportStatus?.(value?.jobId)||(reportedJob===value?.jobId?lastSupport:null));
    const saved=await readJSON(reportStateFile).catch(()=>undefined);
    if(saved?.jobId&&saved.jobId===value?.jobId&&publicSupport(saved.support)){
      if(support?.status==='sent'){
        if(JSON.stringify(saved.support)!==JSON.stringify(support))await writeUpdateJSON(reportStateFile,{jobId:value.jobId,support}).catch(()=>{});
      }else if(saved.support.status==='sent')support=publicSupport(saved.support);
      else if(!support)support=publicSupport(saved.support);
      else if(['collecting','manual'].includes(support.status))support={status:'unavailable'};
    }
    const rollback=await rollbackAvailability({directory});
    if(['ROLLBACK_INCOMPATIBLE','BACKUP_INVALID'].includes(value?.rollbackReason)&&rollback.available){rollback.available=false;rollback.reason=value.rollbackReason;}
    return {...publicUpdateStatus(value),rollback,...(support?{support}:{})};
  };
  async function release(jobToken){const owner=await readJSON(join(lock,'owner.json')).catch(()=>undefined);if(owner?.jobToken===jobToken)await rm(lock,{recursive:true,force:true});}
  /**
   * 현재 상태와 설치 경로를 검사한 뒤 작업 ID·잠금·전용 작업 폴더를 준비합니다.
   * 초기 도구 누락도 실패 상태로 기록하여 자동 진단과 제보 대상이 되게 합니다.
   */
  async function launch(mode='update'){
    assertUpdateSafe(manager.snapshot());
    if(activeJob&&!applying){const latest=await readJSON(statusFile).catch(()=>undefined),owner=await readJSON(join(lock,'owner.json')).catch(()=>undefined);if(['completed','failed'].includes(latest?.phase)&&!owner)activeJob=undefined;}
    if(applying||activeJob)throw error('UPDATE_IN_PROGRESS','이미 업데이트를 준비하고 있습니다. 진행 상태를 확인하세요.');
    if(!descriptor)throw error('UPDATE_UNAVAILABLE','관리 프로그램의 연결 정보를 확인하지 못했습니다. 다시 실행하세요.',503);
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
      let installation;
      try{installation=await inspect({directory,...(mode==='rollback'?{toolsRequired:false}:{})});
        if(mode==='rollback'){const available=await rollbackAvailability({directory});if(!available.available)throw error('ROLLBACK_UNAVAILABLE','검증된 이전 버전이 없어 되돌릴 수 없습니다.');}
      }
      catch(failure){
        if(!['UPDATE_GIT_REQUIRED','UPDATE_NPM_REQUIRED','UPDATE_RUNTIME_REQUIRED'].includes(failure.code))throw failure;
        const diagnostic=classifyUpdateFailure(failure,'preparing');
        await writeUpdateJSON(join(workDirectory,'diagnostic.json'),{diagnostic,at:Date.now()});
        await writeUpdateJSON(statusFile,{phase:'failed',mode,message:'failed',diagnostic,jobId,startedAt,updatedAt:Date.now()});
        await release(jobToken);return status();
      }
      const job={...installation,mode,directory,workDirectory,jobId,jobToken,startedAt,descriptor};activeJob=job;
      await writeUpdateJSON(statusFile,{phase:'preparing',mode,message:'preparing',startedAt,updatedAt:startedAt,jobId});
      launchPromise=(async()=>{
        try{
          const child=await prepare(job),owner=await readJSON(join(lock,'owner.json'));
          if(tokenEqual(owner?.jobToken,jobToken)&&!owner.workerPid)await writeUpdateJSON(join(lock,'owner.json'),{jobToken,controllerPid:process.pid,workerPid:child.pid});
        }catch(failure){
          const latest=await readJSON(statusFile).catch(()=>undefined);
          if(latest?.jobId!==jobId||!['completed','failed'].includes(latest.phase))await writeUpdateJSON(statusFile,{phase:'failed',mode,message:'failed',diagnostic:classifyUpdateFailure(failure,'preparing'),startedAt,updatedAt:Date.now(),jobId});
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
    try{await writeUpdateJSON(join(directory,'shutdown.json'),{intent:'update',at:Date.now()});await writeUpdateJSON(statusFile,{phase:'applying',mode:activeJob.mode,message:'applying',jobId:activeJob.jobId,startedAt:activeJob.startedAt,updatedAt:Date.now()});}
    catch(e){applying=false;throw e;}
    // 종료 콜백이 뒤늦게 실패해도 교체 worker의 확정 상태를 덮어쓰지 않습니다.
    // 종료·잠금 확인과 실패 후 복구 상태는 독립 worker가 기록합니다.
    setTimeout(()=>void shutdown().catch(()=>{}),50);
    return{accepted:true};
  }
  let versionCheck=null;
  const latest=currentVersion=>{
    versionCheck??=checkLatestUpdate(currentVersion,{readVersion:async()=>readPublishedVersion(await inspect({directory}))}).finally(()=>{versionCheck=null;});
    return versionCheck;
  };
  return{status,latest,start:()=>launch('update'),rollback:()=>launch('rollback'),apply,monitor,reportFailure,waitForLaunch:()=>launchPromise,isApplying:()=>applying,setRuntimeDescriptor:value=>{descriptor=value;}};
}
export async function withUpdateManagerLock(directory,action){
  const lock=new DatabaseSync(join(directory,'manager-lock.sqlite'));
  try{lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;');}
  catch{lock.close();throw error('UPDATE_RUNTIME_ACTIVE',messages.runtime_active);}
  try{return await action();}finally{try{lock.exec('ROLLBACK');}finally{lock.close();}}
}
/**
 * 준비된 앱 트리를 적용하고 부분 실패 시 이전 트리로 복구합니다.
 * 사용자 데이터 폴더를 새 앱 파일로 덮어쓰는 작업이 아닙니다.
 */
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
  if(!job||job.mode!==undefined&&!['update','rollback'].includes(job.mode)||!isAbsolute(job.directory)||!/^[a-f0-9]{32}$/.test(job.jobId)||!/^[a-f0-9]{64}$/.test(job.jobToken)||resolve(job.workDirectory)!==join(resolve(job.directory),'updates','jobs',job.jobId)||resolve(jobPath)!==join(job.workDirectory,'job.json')||job.app!==join(resolve(job.directory),'app'))throw Error('Invalid update job');
  const url=new URL(job.descriptor.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!/^[a-f0-9]{64}$/.test(job.descriptor.bridgeToken)||!Number.isSafeInteger(job.descriptor.pid))throw Error('Invalid update endpoint');
  return job;
}
async function runStep(step,env){await executeFile(step.command,step.args,{cwd:step.cwd,env,timeout:20*60*1000,maxBuffer:1024*1024,windowsHide:true});}
async function runtimeReleased(directory){
  try{await lstat(join(directory,'runtime.json'));return false;}
  catch(failure){if(failure.code!=='ENOENT')throw failure;}
  // 설명자가 제거됐더라도 DB 관리 잠금을 잡고 있으면 아직 교체할 수 없습니다.
  // 이전 PID는 종료 후 재사용되거나 열린 핸들 때문에 남을 수 있어 판정에 쓰지 않습니다.
  try{await withUpdateManagerLock(directory,()=>{});return true;}
  catch(failure){if(failure.code==='UPDATE_RUNTIME_ACTIVE')return false;throw failure;}
}
export async function waitForStopped(job,{attempts=120,wait=sleep}={}){
  for(let count=0;count<attempts;count++){
    if(await runtimeReleased(job.directory))return;
    await wait(250);
  }
  throw error('UPDATE_SHUTDOWN_TIMEOUT',messages.shutdown_failed);
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
/**
 * 준비 → 빌드 검사 → 종료 승인 → 기존 프로세스 종료 확인 → 교체 → 재시작 순서입니다.
 * 자동 재시도는 소스/의존성 준비의 네트워크 오류만 최대 2회 허용합니다.
 * 앱 교체나 결과 불명 상태를 무조건 반복하면 실행 중 파일과 데이터가 충돌할 수 있습니다.
 */
export async function runUpdateWorker(jobPath,{run=runStep,fetchRequest=fetch,waitStopped=waitForStopped,restart=restartApplication,wait=sleep}={}){
  const job=await validateJob(resolve(jobPath)),updates=join(job.directory,'updates'),lock=join(updates,'active'),statusFile=join(updates,'status.json');
  const owner=await readJSON(join(lock,'owner.json'));if(!tokenEqual(owner?.jobToken,job.jobToken))throw Error('Update lock changed');
  await mkdir(join(job.workDirectory,'running'),{mode:0o700});
  await writeUpdateJSON(join(lock,'owner.json'),{jobToken:job.jobToken,controllerPid:job.descriptor.pid,workerPid:process.pid});
  let stage='source',shutdownApproved=false,version,previousVersion,diagnostic,rollbackReason,rollbackHash,retryCount=0,retrying=false;
  const report=(phase,message)=>writeUpdateJSON(statusFile,{phase,message,mode:job.mode==='rollback'?'rollback':'update',...(rollbackReason?{rollbackReason}:{}),retryCount,retrying,...(diagnostic?{diagnostic}:{}),startedAt:job.startedAt,updatedAt:Date.now(),jobId:job.jobId,...(version?{version}:{})});
  try{
    const checkout=join(job.workDirectory,'checkout'),prepared=join(job.workDirectory,'prepared'),backup=join(job.workDirectory,'previous'),env=updateEnvironment(job.workerNode,job.workDirectory);
    if(job.mode==='rollback'){
      stage='check';await report('preparing','check');
      const identity=await verifiedRollback(job.directory),current=await readJSON(join(job.app,'central/package.json'));
      version=identity.version;previousVersion=current?.version;rollbackHash=identity.hash;
      await mkdir(prepared,{mode:0o700});
      for(const part of ['central','extension'])await cp(join(rollbackPath(job.directory),part),join(prepared,part),{recursive:true});
      if((await codeIdentity(prepared)).hash!==identity.hash)throw error('ROLLBACK_INVALID','되돌릴 파일의 검증에 실패했습니다.');
      await verifyRollbackCompatibility({directory:job.directory,target:prepared,node:job.workerNode||job.node,workDirectory:job.workDirectory});
    }else{
    for(const name of ['no-hooks'])await mkdir(join(job.workDirectory,name),{recursive:true,mode:0o700});
    for(const name of ['empty-config','empty-global-config'])await writeFile(join(job.workDirectory,name),'',{mode:0o600});
    for(const step of updateBuildPlan({...job,node:job.workerNode,checkout})) {
      stage=step.id;
      for(;;){
        await report('preparing',stage);
        try{await run(step,env);diagnostic=undefined;break;}
        catch(failure){
          diagnostic=classifyUpdateFailure(failure,stage);
          if(diagnostic.code!=='NETWORK'||!['source','dependencies'].includes(stage)||retryCount>=2)throw failure;
          retryCount++;retrying=true;await report('preparing','retrying');
          await wait(retryCount===1?2000:5000);retrying=false;
          if(stage==='source')await rm(checkout,{recursive:true,force:true});
        }
      }
    }
    const current=await readJSON(join(job.app,'extension/manifest.json')),next=await readJSON(join(checkout,'central/extension/manifest.json'));
    if(!current?.key||next?.key!==current.key)throw Error('Extension identity changed');
    const pkg=await readJSON(join(checkout,'central/package.json'));version=pkg?.version||next.version;previousVersion=(await readJSON(join(job.app,'central/package.json')))?.version||current.version;
    const minimum=/^>=(\d+\.\d+\.\d+)$/.exec(pkg?.engines?.node||'');
    if(!minimum||!supportedUpdateNode(process.versions.node)||minimum[1].split('.').some((part,index,parts)=>{const currentParts=process.versions.node.split('.').map(Number);return parts.slice(0,index).every((p,n)=>Number(p)===currentParts[n])&&Number(part)>currentParts[index];}))throw Error('Manual runtime upgrade required');
    await access(join(checkout,'central/ui/dist/index.html'));await access(join(checkout,'central/runtime/main.mjs'));
    await mkdir(prepared,{mode:0o700});
    await cp(join(checkout,'central'),join(prepared,'central'),{recursive:true,filter:file=>!file.split(/[\\/]/).some(part=>['node_modules','.git'].includes(part))});
    await cp(join(checkout,'central/extension'),join(prepared,'extension'),{recursive:true});
    }
    await report('ready','ready');stage='authorize';
    const reply=await fetchRequest(job.descriptor.url+'/api/bridge/update/apply',{method:'POST',headers:{Authorization:`Bearer ${job.descriptor.bridgeToken}`,'Content-Type':'application/json'},body:JSON.stringify({jobToken:job.jobToken}),signal:AbortSignal.timeout(10000)});
    if(!reply.ok){stage=reply.status===409?'busy':'authorize';throw Error('Update apply denied');}
    shutdownApproved=true;stage='shutdown';await waitStopped(job);stage='apply';await report('applying','applying');
    await withUpdateManagerLock(job.directory,async()=>{
      if(job.mode==='rollback'){
        if((await codeIdentity(prepared)).hash!==rollbackHash)throw error('ROLLBACK_INVALID','되돌릴 파일이 준비 이후 변경되었습니다.');
        await verifyRollbackCompatibility({directory:job.directory,target:prepared,node:job.workerNode||job.node,workDirectory:job.workDirectory});
      }
      await swapUpdateDirectories({app:job.app,prepared,backup});
    });stage='restart';await restart(job);
    // 정상 시작 확인 이후에만 직전 코드를 보존한다. 보관 실패로 정상 시작한 앱을
    // 되돌리지는 않으며 슬롯 검증 결과가 unavailable로 정확하게 표시된다.
    let retained=false;
    try{await retainRollbackVersion({directory:job.directory,source:backup,currentVersion:version});retained=true;}catch{rollbackReason='BACKUP_INVALID';}
    await report('completed','completed');
    await rm(checkout,{recursive:true,force:true});if(retained)await rm(backup,{recursive:true,force:true});await rm(join(job.workDirectory,'npm-cache'),{recursive:true,force:true});
  }catch(e){
    retrying=false;rollbackReason=e.code==='ROLLBACK_INCOMPATIBLE'?e.code:undefined;diagnostic=classifyUpdateFailure(e,stage);
    await writeUpdateJSON(join(job.workDirectory,'diagnostic.json'),{diagnostic,retryCount,at:Date.now()}).catch(()=>{});
    let message=e.code==='UPDATE_RUNTIME_ACTIVE'?'runtime_active':e.code==='UPDATE_ROLLBACK_FAILED'?'rollback_failed':stage==='busy'?'busy':messages[`${stage}_failed`]?`${stage}_failed`:'failed';
    // Roll back a failed launch only after proving the new process exited; never swap a possibly live runtime.
    if(shutdownApproved&&stage==='restart'&&e.rollbackSafe===true){
      try{
        await withUpdateManagerLock(job.directory,()=>swapUpdateDirectories({app:job.app,prepared:join(job.workDirectory,'previous'),backup:join(job.workDirectory,'failed-version')}));
        version=previousVersion;message='restart_rolled_back';await restart(job);
      }catch(rollbackError){message=rollbackError.code==='UPDATE_RUNTIME_ACTIVE'?'restart_failed':'rollback_failed';}
    }else if(shutdownApproved&&stage==='shutdown'){
      // 업데이트 종료로 서비스가 이미 내려간 경우에만 기존 설치로 화면을 복구합니다.
      // 사용자가 직접 중지했거나 현재 관리자가 잠금을 보유하면 개입하지 않습니다.
      const marker=await readJSON(join(job.directory,'shutdown.json')).catch(()=>undefined);
      if(marker?.intent==='update'&&await runtimeReleased(job.directory).catch(()=>false)){
        try{await restart(job);message='shutdown_recovered';version=previousVersion;}
        catch{message='restart_failed';}
      }
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
