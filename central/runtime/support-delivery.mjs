/**
 * 오류 제보의 저장·전송·접수 상태를 관리합니다.
 * queue는 로컬 전송함에 넣는 작업이며, sent는 수신 측 접수 응답을 확인한 상태입니다.
 * 자동 제보 허용과 본문/이름 포함 동의는 별도로 적용하며 업데이트 진단은 본문/이름을 제외합니다.
 */
import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync,chmodSync,unlinkSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {isIP} from 'node:net';
import {inspectSupportReport,automaticSupportReport,SUPPORT_REPORT_MAX_BYTES} from './support-report.mjs';

const DEFAULTS={enabled:false,autoSend:false,receiverUrl:'',includeBodies:false,includeNames:false,receiverEnabled:false,retentionDays:30};
const DAY=86400000;
const fail=(message,status=400,code='SUPPORT_DELIVERY_INVALID')=>Object.assign(Error(message),{status,code});
const copy=value=>structuredClone(value);
// 이전 버전은 automatic 표식이 없다. 사건 식별자가 있는 구형 제보는 개인정보 최소화를 우선한다.
const automaticItem=item=>item.automatic===true||item.automatic===undefined&&Boolean(item.incidentId);
function readJSON(path,fallback){try{return JSON.parse(readFileSync(path,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}}
function atomicJSON(path,value){
 const temporary=path+'.tmp',fd=openSync(temporary,'w',0o600);
 try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}
 renameSync(temporary,path);if(process.platform!=='win32')chmodSync(path,0o600);
}
function privateHost(host){
 const name=host.replace(/^\[|\]$/g,'').toLowerCase();
 if(name==='localhost'||name==='::1')return true;
 if(isIP(name)===4){const [a,b]=name.split('.').map(Number);return a===127||a===10||a===192&&b===168||a===172&&b>=16&&b<=31;}
 return isIP(name)===6&&(/^(fc|fd)/.test(name)||/^fe[89ab]/.test(name));
}
function receiverURL(input){
 if(input==='')return '';
 if(typeof input!=='string'||input.length>2048)throw fail('수신 서버 주소를 확인하세요.');
 let url;try{url=new URL(input);}catch{throw fail('수신 서버 주소를 확인하세요.');}
 if(url.username||url.password||url.search||url.hash||!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!privateHost(url.hostname))throw fail('수신 주소는 인증정보 없는 HTTPS 또는 내부망 HTTP 주소여야 합니다.');
 return url.href;
}
function tokenValue(value){if(typeof value!=='string'||value.length>512||value!==''&&!/^[a-zA-Z0-9._~-]{24,512}$/.test(value))throw fail('수신 서버에서 발급한 연결 키를 확인하세요.');return value;}
function emailRelayURL(value){return /^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/.test(value);}
async function postReport(url,report,token,signal,fetchImpl){
 if(!emailRelayURL(url))return fetchImpl(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(report),signal});
 let response=await fetchImpl(url,{method:'POST',redirect:'manual',headers:{'content-type':'application/json'},body:JSON.stringify({key:token,report}),signal});
 if(response.status===302||response.status===303){
  const location=response.headers.get('location');await response.body?.cancel();
  const target=new URL(location);
  if(target.protocol!=='https:'||target.hostname!=='script.googleusercontent.com'||target.port||target.username||target.password||target.pathname!=='/macros/echo')throw fail('이메일 중계 응답 주소를 확인하지 못했습니다.',502);
  response=await fetchImpl(target.href,{method:'GET',redirect:'error',signal});
 }
 return response;
}
function settingsPatch(settings,patch){
 if(!patch||typeof patch!=='object'||Array.isArray(patch))throw fail('자동 제보 설정을 확인하세요.');
 const next={...settings};
 for(const key of ['enabled','autoSend','includeBodies','includeNames','receiverEnabled'])if(patch[key]!==undefined){if(typeof patch[key]!=='boolean')throw fail('자동 제보 설정 값을 확인하세요.');next[key]=patch[key];}
 if(patch.retentionDays!==undefined){if(!Number.isInteger(patch.retentionDays)||patch.retentionDays<1||patch.retentionDays>365)throw fail('보관 기간은 1~365일이어야 합니다.');next.retentionDays=patch.retentionDays;}
 if(patch.receiverUrl!==undefined)next.receiverUrl=receiverURL(patch.receiverUrl);
 return next;
}
async function receiptJSON(response){
 if(!response.ok){await response.body?.cancel();throw fail(`수신 서버가 HTTP ${response.status} 응답을 반환했습니다.`,502,'SUPPORT_RECEIVER_REJECTED');}
 const reader=response.body?.getReader();if(!reader)throw fail('수신 서버 접수 확인이 없습니다.',502);
 const chunks=[];let length=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>65536)throw fail('수신 서버 응답이 너무 큽니다.',502);chunks.push(Buffer.from(value));}}
 finally{await reader.cancel().catch(()=>{});}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('수신 서버 접수 확인 형식을 확인하세요.',502);}
}
function restrictPrivacy(input,policy){
 const report=inspectSupportReport(input).report;
 const privacy={...report.privacy,includeBodies:report.privacy.includeBodies&&policy.includeBodies,includeNames:report.privacy.includeNames&&policy.includeNames};
 if(privacy.includeBodies===report.privacy.includeBodies&&privacy.includeNames===report.privacy.includeNames)return report;
 return inspectSupportReport({...report,privacy}).report;
}

// This store is owned by the runtime's single-instance lock. All disk mutations
// are synchronous and atomic; report creation is serialized separately because
// it reads async build metadata. Credentials never enter the report/state file.
export function createSupportDelivery({dir,createReport,connection,now=Date.now,fetchImpl=globalThis.fetch,timeoutMs=15000,retryBaseMs=30000,pollMs=5000,maxAttempts=8}={}){
 if(!dir||typeof createReport!=='function')throw Error('Support delivery requires dir and createReport.');
 if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>100)throw Error('제보 전송 시도 한도는 1~100회여야 합니다.');
 const directory=resolve(dir),outDir=join(directory,'outbox'),inDir=join(directory,'inbox');
 for(const path of [directory,outDir,inDir]){mkdirSync(path,{recursive:true,mode:0o700});if(process.platform!=='win32')chmodSync(path,0o700);}
 const statePath=join(directory,'state.json'),credentialPath=join(directory,'credentials.json'),journalPath=join(directory,'pending-queue.json');
 let state=readJSON(statePath,{version:1,settings:{...DEFAULTS},outbox:[],inbox:[]});
 if(state.version!==1||!Array.isArray(state.outbox)||!Array.isArray(state.inbox))throw Error('자동 제보 저장소 형식을 확인하세요.');
 state.settings=settingsPatch(DEFAULTS,state.settings);
 let credentials=readJSON(credentialPath,null);
 if(!credentials){credentials={receiverToken:randomBytes(32).toString('hex'),reporterToken:''};atomicJSON(credentialPath,credentials);}
 tokenValue(credentials.receiverToken);tokenValue(credentials.reporterToken);
 // A distributor can preconnect its receiver; privacy consent always stays
 // with the user. Import once and never replace an existing destination.
 if(connection&&!state.connectionInitialized){
  if(!state.settings.receiverUrl&&!credentials.reporterToken){
   const url=receiverURL(connection.receiverUrl),token=tokenValue(connection.reporterToken);
   if(!url||!token)throw fail('배포본의 제보 수신 연결 정보가 비어 있습니다.');
   credentials={...credentials,reporterToken:token};atomicJSON(credentialPath,credentials);
   state.settings.receiverUrl=url;
  }
  state.connectionInitialized=true;
 }
 if(process.platform!=='win32')chmodSync(credentialPath,0o600);
 for(const entry of state.outbox)if(entry.status==='sending'){entry.status='queued';entry.nextAttemptAt=now();}
 const save=()=>atomicJSON(statePath,state);
 let closed=false,timer=null,queueTail=Promise.resolve(),flushing=null,controller=null,activeAutomatic=false;
 const pendingPolicies=new Set();
 save();
 const outPath=id=>join(outDir,`${id}.json`),inPath=id=>join(inDir,`${id}.json`);
 const safeId=id=>typeof id==='string'&&/^[a-zA-Z0-9-]{1,100}$/.test(id);
 // 보고서 파일과 색인은 별개 파일이다. 두 rename 사이에 프로세스가 종료되어도
 // fsync된 저널로 같은 식별자의 전송 항목을 복원하여 제보가 고아 파일이 되지 않는다.
 function recoverPendingQueue(){
 const pending=readJSON(journalPath,null);
 if(pending){
  if(!safeId(pending.item?.id))throw fail('제보 복구 식별자를 확인하세요.');
  const report=automaticItem(pending.item)?automaticSupportReport(pending.report):inspectSupportReport(pending.report).report;
  if(pending.item.reportId!==report.reportId)throw fail('제보 복구 보고서가 일치하지 않습니다.');
  if(!state.outbox.some(item=>item.id===pending.item.id)){
   atomicJSON(outPath(pending.item.id),report);state.outbox.unshift(pending.item);
  }
  save();unlinkSync(journalPath);
 }
 }
 recoverPendingQueue();
 function status(){
  const configured=Boolean(state.settings.receiverUrl&&credentials.reporterToken);
  return copy({settings:state.settings,configured,hasReporterToken:Boolean(credentials.reporterToken),transportWarning:state.settings.receiverUrl.startsWith('http:')?'내부망 HTTP는 보고서와 연결 키를 암호화하지 않습니다. 신뢰하는 네트워크에서만 사용하세요.':null,outbox:state.outbox,inbox:state.inbox,counts:{queued:state.outbox.filter(item=>['queued','sending'].includes(item.status)).length,sent:state.outbox.filter(item=>item.status==='sent').length,failed:state.outbox.filter(item=>item.status==='failed').length,inbox:state.inbox.length}});
 }
 function configure(patch){
  const next=settingsPatch(state.settings,patch);
  let reporterToken=credentials.reporterToken;
  if(next.receiverUrl!==state.settings.receiverUrl)reporterToken='';
  if(patch.reporterToken!==undefined)reporterToken=tokenValue(patch.reporterToken);
  const changedDestination=next.receiverUrl!==state.settings.receiverUrl||reporterToken!==credentials.reporterToken;
  const loweredPrivacy=state.settings.includeBodies&&!next.includeBodies||state.settings.includeNames&&!next.includeNames;
  // 자동 전송 동의 철회는 이미 전송 중인 자동 요청에도 즉시 적용한다.
  // 수동 전송은 enabled 동의가 남아 있으면 별도로 계속할 수 있다.
  if(!next.enabled||changedDestination||loweredPrivacy||!next.autoSend&&activeAutomatic)controller?.abort();
  credentials={...credentials,reporterToken};atomicJSON(credentialPath,credentials);
  state.settings=next;save();
  if(loweredPrivacy){
   for(const policy of pendingPolicies){policy.includeBodies&&=next.includeBodies;policy.includeNames&&=next.includeNames;}
   // Shrink unsent reports immediately, including the copy of an aborted
   // request. Re-enabling inclusion never restores removed data. A request
   // already accepted by the receiver cannot be recalled by aborting it.
   for(const item of state.outbox)if(item.status!=='sent')atomicJSON(outPath(item.id),restrictPrivacy(readJSON(outPath(item.id),null),next));
  }
  return status();
 }
 function authorizeReceiver(authorization){
  if(!state.settings.receiverEnabled)throw fail('이 설치에서 보고서 수신이 꺼져 있습니다.',403,'SUPPORT_RECEIVER_DISABLED');
  const provided=typeof authorization==='string'&&authorization.startsWith('Bearer ')?authorization.slice(7):'';
  const hash=value=>createHash('sha256').update(value).digest();
  if(!provided||!timingSafeEqual(hash(provided),hash(credentials.receiverToken)))throw fail('보고서 수신 연결 키가 필요합니다.',401,'SUPPORT_RECEIVER_UNAUTHORIZED');
  return true;
 }
 /**
  * 제보 생성 요청을 직렬화하고 동의·중복 사건을 검사한 뒤 보고서와 전송함을 저장합니다.
  * 자동 전송이 꺼진 경우 자동 요청은 건너뜁니다. 저장 완료를 메일 접수 완료로 표시하지 않습니다.
  */
 function queue(options={}){
  const job=queueTail.then(async()=>{
   if(closed)throw fail('자동 제보 처리가 종료되었습니다.',409);
   // 이전 디스크 쓰기가 실패했더라도 새 요청이 미완료 저널을 덮어쓰지 않는다.
   recoverPendingQueue();
   if(!state.settings.enabled||options.automatic&&!state.settings.autoSend){if(options.automatic)return null;throw fail('보고서 전송 허용 설정을 먼저 켜 주세요.',409,'SUPPORT_SENDING_DISABLED');}
   if(options.incidentId!==undefined&&(typeof options.incidentId!=='string'||!options.incidentId||options.incidentId.length>200))throw fail('문제 식별자를 확인하세요.');
   for(const key of ['includeBodies','includeNames'])if(options[key]!==undefined&&typeof options[key]!=='boolean')throw fail('보고서 개인정보 포함 옵션을 확인하세요.');
   const duplicate=options.incidentId&&state.outbox.find(item=>item.incidentId===options.incidentId);if(duplicate)return copy(duplicate);
   const settings={...state.settings};
   let report;pendingPolicies.add(settings);
   try{report=await createReport({...(options.updateDiagnostic?{updateDiagnostic:options.updateDiagnostic}:{}),...(options.attemptId!==undefined?{attemptId:options.attemptId}:{}),from:options.from??Math.max(0,now()-3600000),to:options.to??now(),includeBodies:!options.automatic&&!options.updateDiagnostic&&settings.includeBodies&&options.includeBodies!==false,includeNames:!options.automatic&&!options.updateDiagnostic&&settings.includeNames&&options.includeNames!==false});}finally{pendingPolicies.delete(settings);}
   if(options.userDescription!==undefined)report.userDescription=options.userDescription;
   if(closed||!state.settings.enabled||options.automatic&&!state.settings.autoSend)return null;
   const clean=restrictPrivacy(options.automatic?automaticSupportReport(report):report,{includeBodies:settings.includeBodies&&state.settings.includeBodies,includeNames:settings.includeNames&&state.settings.includeNames});
   const item={id:randomUUID(),reportId:clean.reportId,automatic:Boolean(options.automatic),...(options.incidentId?{incidentId:options.incidentId}:{}),createdAt:now(),status:'queued',attempts:0,nextAttemptAt:now(),lastError:null,receiptId:null,sentAt:null};
   atomicJSON(journalPath,{item,report:clean});
   atomicJSON(outPath(item.id),clean);state.outbox.unshift(item);save();unlinkSync(journalPath);
   if(timer)void flush().catch(()=>{});
   return copy(item);
  });
  queueTail=job.catch(()=>{});return job;
 }
 /**
  * 한 보고서를 전송하고 접수 응답을 검사합니다. 시간 초과나 실패는 전송함 상태에 남깁니다.
  */
 async function transmit(item){
  item.status='sending';item.attempts++;save();
  controller=new AbortController();activeAutomatic=automaticItem(item);const activeController=controller;
  // fetch 구현 또는 응답 스트림이 abort에 협조하지 않아도 전송함 전체가 멈추지 않는다.
  // 늦게 도착한 응답은 상태를 갱신하지 않으며 같은 reportId 재시도로 수신 측이 중복을 구분한다.
  let rejectAbort;
  const aborted=new Promise((_,reject)=>{rejectAbort=()=>reject(fail('제보 전송 시간이 초과되었거나 중단되었습니다.',504));activeController.signal.addEventListener('abort',rejectAbort,{once:true});});
  const timeout=setTimeout(()=>activeController.abort(),timeoutMs);timeout.unref?.();
  try{
   const stored=readFileSync(outPath(item.id));if(stored.length>SUPPORT_REPORT_MAX_BYTES)throw fail('보고서가 16MiB를 초과합니다.',413);
   const policy={...state.settings},reporterToken=credentials.reporterToken;
   const original=JSON.parse(stored.toString('utf8'));
   const report=restrictPrivacy(automaticItem(item)?automaticSupportReport(original):original,policy);atomicJSON(outPath(item.id),report);
   const payload=JSON.stringify(report);if(Buffer.byteLength(payload)>SUPPORT_REPORT_MAX_BYTES)throw fail('보고서가 16MiB를 초과합니다.',413);
   const receipt=await Promise.race([(async()=>{
    const response=await postReport(policy.receiverUrl,report,reporterToken,activeController.signal,fetchImpl);
    if(activeController.signal.aborted){void response.body?.cancel().catch(()=>{});throw fail('중단된 제보 응답입니다.',504);}
    return receiptJSON(response);
   })(),aborted]);
   if(receipt?.ok===false){
    const reasons={RATE_LIMIT:'이메일 중계의 짧은 시간 전송 한도에 도달했습니다. 대기열을 보존하고 자동으로 다시 시도합니다.',DISABLED:'이메일 중계가 일시적으로 접수를 중단했습니다. 보고서는 로컬 전송함에 보존됩니다.',STORAGE_LIMIT:'이메일 중계의 접수 기록 저장 공간이 부족합니다. 보고서는 로컬 전송함에 보존됩니다.',UNAUTHORIZED:'이메일 중계 연결 키가 일치하지 않습니다. 관리자 수신 연결 설정을 확인하세요.',QUOTA:'이메일 중계의 오늘 전송 한도에 도달했습니다. 대기열을 보존하고 다시 시도합니다.',DELIVERY_UNCERTAIN:'이메일 중계가 발송 결과를 확정하지 못했습니다. 관리자 확인이 필요하며 중계는 중복 메일을 보내지 않습니다.',BUSY:'이메일 중계가 다른 제보를 처리 중입니다. 자동으로 다시 시도합니다.',INVALID:'이메일 중계가 보고서 형식 또는 크기를 거절했습니다.'};
    const code=Object.hasOwn(reasons,receipt.code)?receipt.code:'UNKNOWN';
    throw fail(`[${code}] ${reasons[code]||'수신 서버가 제보를 거절했습니다.'}`,502,'SUPPORT_RECEIVER_REJECTED');
   }
   if(receipt.reportId!==item.reportId||!safeId(receipt.receiptId)||!Number.isSafeInteger(receipt.receivedAt)||receipt.receivedAt<0)throw fail('수신 서버의 접수 확인을 검증하지 못했습니다.',502);
   item.status='sent';item.sentAt=now();item.receiptId=receipt.receiptId;item.nextAttemptAt=null;item.lastError=null;
  }catch(error){
   item.status='failed';item.lastError=error.code==='SUPPORT_RECEIVER_REJECTED'?error.message:'전송하지 못했습니다. 수신 주소·연결 키·네트워크를 확인하세요. 자동으로 다시 시도합니다.';
   // 무한 재시도는 오프라인 로그와 중계 요청만 누적한다. 한도 이후에도 원본은
   // 보존하되 nextAttemptAt=null을 명시적 종료 상태로 저장하여 재시작에도 유지한다.
   item.nextAttemptAt=item.attempts>=maxAttempts?null:now()+Math.min(3600000,retryBaseMs*2**Math.min(10,item.attempts-1));
   if(item.nextAttemptAt===null)item.lastError=`${maxAttempts}회 전송 시도 후 자동 재시도를 종료했습니다. 보고서는 로컬 전송함에 보존됩니다.`;
  }finally{clearTimeout(timeout);activeController.signal.removeEventListener('abort',rejectAbort);controller=null;activeAutomatic=false;save();}
 }
 /**
  * 전송 가능한 대기 항목을 처리합니다. 이미 flush가 진행 중이면 같은 작업을 공유합니다.
  */
 function flush({force=false}={}){
  if(flushing)return flushing;
  flushing=(async()=>{
   for(const item of state.outbox){
    if(closed||!state.settings.enabled||!state.settings.receiverUrl||!credentials.reporterToken)break;
    // 저장 당시 동의만 믿지 않고 재전송 직전에 현재 자동 전송 동의를 검사한다.
    if(automaticItem(item)&&!state.settings.autoSend)continue;
    // Email receipts are retained for 90 days. Stop old retries well before
    // that boundary, even when the user explicitly flushes a stale queue.
    if(item.status!=='sent'&&emailRelayURL(state.settings.receiverUrl)&&now()-item.createdAt>=30*DAY){
     if(item.nextAttemptAt!==null){item.status='failed';item.nextAttemptAt=null;item.lastError='30일이 지난 이메일 제보는 중복 발송 방지를 위해 재전송하지 않습니다.';save();}
     continue;
    }
    if(item.status==='sent'||item.nextAttemptAt===null)continue;
    // 강제 flush는 대기 시간을 건너뛸 뿐, 종료된 항목이나 누적 시도 한도를 되살리지 않는다.
    // 구형 상태 파일의 이미 초과한 시도 횟수도 실제 요청 전에 종료 처리한다.
    if(item.attempts>=maxAttempts){item.status='failed';item.nextAttemptAt=null;item.lastError=`${maxAttempts}회 전송 시도 후 자동 재시도를 종료했습니다. 보고서는 로컬 전송함에 보존됩니다.`;save();continue;}
    if(!force&&item.nextAttemptAt>now())continue;
    await transmit(item);
   }
   return status();
  })().finally(()=>{flushing=null;});return flushing;
 }
 /**
  * 직접 수신 서버로 동작할 때의 입구입니다. 인증·보고서 검증 후 중복 reportId를 구분하여 접수합니다.
  */
 async function receive(input,authorization){
  authorizeReceiver(authorization);
  const inspected=inspectSupportReport(input),report=inspected.report;
  const existing=state.inbox.find(item=>item.reportId===report.reportId);
  if(existing)return {receiptId:existing.receiptId,reportId:existing.reportId,receivedAt:existing.receivedAt,duplicate:true};
  const item={receiptId:randomUUID(),reportId:report.reportId,receivedAt:now(),createdAt:report.createdAt,summary:inspected.summary};
  atomicJSON(inPath(item.receiptId),report);state.inbox.unshift(item);save();
  return {receiptId:item.receiptId,reportId:item.reportId,receivedAt:item.receivedAt,duplicate:false};
 }
 function get(receiptId){
  if(!safeId(receiptId)||!state.inbox.some(item=>item.receiptId===receiptId))throw fail('접수된 보고서를 찾을 수 없습니다.',404,'SUPPORT_RECEIPT_NOT_FOUND');
  return inspectSupportReport(readJSON(inPath(receiptId),null));
 }
 /**
  * 보관 기간이 지난 전송 완료 보고서와 수신 자료를 정리합니다. 대기/실패 보고서를 완료 자료처럼 삭제하지 않습니다.
  */
 function prune(){
  const cutoff=now()-state.settings.retentionDays*DAY;
  const removeOut=state.outbox.filter(item=>item.status==='sent'&&item.sentAt<cutoff),removeIn=state.inbox.filter(item=>item.receivedAt<cutoff);
  if(!removeOut.length&&!removeIn.length)return status();
  state.outbox=state.outbox.filter(item=>!removeOut.includes(item));state.inbox=state.inbox.filter(item=>!removeIn.includes(item));save();
  for(const path of [...removeOut.map(item=>outPath(item.id)),...removeIn.map(item=>inPath(item.receiptId))])try{unlinkSync(path);}catch(error){if(error.code!=='ENOENT')throw error;}
  return status();
 }
 function start(){if(closed)throw fail('자동 제보 처리가 종료되었습니다.',409);if(!timer){timer=setInterval(()=>{try{prune();void flush().catch(()=>{});}catch{}},pollMs);timer.unref?.();void flush().catch(()=>{});}return status();}
 async function close(){closed=true;clearInterval(timer);timer=null;controller?.abort();await queueTail;await flushing;}
 return {directory,load:status,status,configure,queue,flush,receive,authorizeReceiver,inbox:()=>copy(state.inbox),get,receiverKey:()=>({token:credentials.receiverToken}),prune,start,close};
}
