import {constants} from 'node:fs';
import {lstat,open,rename,rm} from 'node:fs/promises';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {join,resolve} from 'node:path';

export const UI_SESSION_TTL=12*60*60*1000;
const MAX_STATE_BYTES=65536,MAX_SESSIONS=64;
const invalid=()=>Object.assign(Error('관리 프로그램의 비공개 연결·로그인 파일을 확인할 수 없습니다. 파일 권한을 복구하거나 설치 도구로 점검하세요.'),{code:'PRIVATE_RUNTIME_STATE_INVALID'});
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function checkFile(info){if(!info.isFile()||info.isSymbolicLink()||process.platform!=='win32'&&(info.mode&0o777)!==0o600||typeof process.getuid==='function'&&info.uid!==process.getuid()||info.size>MAX_STATE_BYTES)throw invalid();}
export async function readPrivateState(file){
  let info;try{info=await lstat(file);}catch(error){if(error.code==='ENOENT')return undefined;throw invalid();}checkFile(info);
  let handle;
  try{
    handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const current=await handle.stat();checkFile(current);
    if(info.ino!==current.ino||info.dev!==current.dev)throw invalid();
    const value=await handle.readFile('utf8');if(Buffer.byteLength(value)>MAX_STATE_BYTES)throw invalid();return JSON.parse(value);
  }catch{throw invalid();}finally{await handle?.close();}
}
export async function writePrivateState(file,value){
  try{checkFile(await lstat(file));}catch(error){if(error.code!=='ENOENT')throw invalid();}
  const contents=JSON.stringify(value);if(Buffer.byteLength(contents)>MAX_STATE_BYTES)throw invalid();
  const temporary=`${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;let handle;
  try{
    handle=await open(temporary,'wx',0o600);await handle.chmod(0o600);await handle.writeFile(contents);await handle.sync();await handle.close();handle=undefined;
    // Reject a destination replaced by a symlink while preparing the new file.
    try{checkFile(await lstat(file));}catch(error){if(error.code!=='ENOENT')throw invalid();}
    await rename(temporary,file);
  }catch{throw invalid();}finally{await handle?.close();await rm(temporary,{force:true}).catch(()=>{});}
}
const validPort=port=>Number.isInteger(port)&&port>=1&&port<=65535;
function descriptorPort(descriptor){
  let url;try{url=new URL(descriptor?.url);}catch{throw invalid();}
  const port=Number(url.port);
  if(descriptor.protocolVersion!==1||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!validPort(port)||!Number.isSafeInteger(descriptor.pid)||descriptor.pid<1||!hex(descriptor.bridgeToken))throw invalid();
  return port;
}
function sameToken(a,b){return hex(a)&&hex(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
function processAlive(pid){if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}}
async function activeUpdatePort(directory){
  const owner=await readPrivateState(join(directory,'updates/active/owner.json'));if(owner===undefined)return undefined;if(!owner)throw invalid();
  const status=await readPrivateState(join(directory,'updates/status.json'));
  if(status?.phase!=='applying')return undefined;
  if(!hex(owner.jobToken)||!processAlive(owner.workerPid)||!/^[a-f0-9]{32}$/.test(status.jobId||''))throw invalid();
  const workDirectory=join(directory,'updates/jobs',status.jobId),job=await readPrivateState(join(workDirectory,'job.json'));
  if(!job||job.jobId!==status.jobId||!sameToken(job.jobToken,owner.jobToken)||job.directory!==directory||job.workDirectory!==workDirectory||job.app!==join(directory,'app'))throw invalid();
  return descriptorPort(job.descriptor);
}
export async function selectRuntimePort({directory,port}={}){
  if(port!==undefined){if(!Number.isInteger(port)||port<0||port>65535)throw invalid();return port;}
  directory=resolve(directory);const endpoint=await readPrivateState(join(directory,'endpoint.json'));
  if(endpoint!==undefined){if(!endpoint||endpoint.version!==1||!validPort(endpoint.port))throw invalid();return endpoint.port;}
  const previous=await readPrivateState(join(directory,'runtime.json'));
  const selected=previous!==undefined?descriptorPort(previous):(await activeUpdatePort(directory))??43127;
  await writePrivateState(join(directory,'endpoint.json'),{version:1,port:selected});return selected;
}
export function normalizeSessions(records,now=Date.now()){
  if(!Array.isArray(records))return[];const sessions=new Map();
  for(const entry of records){
    if(!entry||!hex(entry.id)||!hex(entry.csrfToken)||!Number.isSafeInteger(entry.issuedAt)||!Number.isSafeInteger(entry.expires)||entry.issuedAt>now||entry.issuedAt<0||entry.expires<=now||entry.expires>entry.issuedAt+UI_SESSION_TTL||entry.expires<=entry.issuedAt)continue;
    sessions.set(entry.id,{id:entry.id,csrfToken:entry.csrfToken,issuedAt:entry.issuedAt,expires:entry.expires});
  }
  return [...sessions.values()].sort((a,b)=>a.expires-b.expires).slice(-MAX_SESSIONS);
}
function validOrigin(origin){try{const url=new URL(origin);return origin===url.origin&&url.protocol==='http:'&&url.hostname==='127.0.0.1'&&validPort(Number(url.port));}catch{return false;}}
export async function createSessionStore({directory,origin,now=Date.now}={}){
  if(!validOrigin(origin))throw invalid();
  const file=join(directory,'ui-sessions.json'),stored=await readPrivateState(file);
  if(stored!==undefined&&(!stored||stored.version!==1||!validOrigin(stored.origin)||!Array.isArray(stored.sessions)))throw invalid();
  let pending=Promise.resolve();const sessions=normalizeSessions(stored?.origin===origin?stored.sessions:[],now());
  return{sessions,save(records){
    const snapshot=normalizeSessions(records,now());const write=pending.catch(()=>{}).then(()=>writePrivateState(file,{version:1,origin,sessions:snapshot}));pending=write;return write;
  }};
}
