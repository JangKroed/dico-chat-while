/**
 * 중앙 명령을 브라우저 작업으로 번역하는 실행기입니다.
 * 중앙 코어는 차례와 승인을 관리하고, 이 파일은 탭·세션·content script 요청을 연결합니다.
 * 메시지 입력과 완료 관찰은 원본 content.js를 읽으면 이어서 확인할 수 있습니다.
 */
import {normalizeSendRetries} from './retry-policy.js';
import {composerClearedEvidence} from './delivery-receipt.js';
import {planDraftPreparation,recordDraftBackup} from './draft-ledger.js';
const fresh=()=>({version:1,instanceId:null,sessionId:null,resetEpoch:0,resetPending:false,legacyDeclaration:null,emergencyStopped:false,bindings:{},attempts:{},processed:{},stoppedGroups:{},stoppedRuns:{},draftBackups:[],lastError:null});
const deliveryCodes=new Set(['DISCORD_SEND_FAILED','COMPOSER_EDITOR_MISSING','COMPOSER_EDITOR_CHANGED','COMPOSER_DRAFT_CHANGED','COMPOSER_STATE_UNREADABLE','MANAGED_DELAY_UNAVAILABLE','RETRY_CANCELLED','RETRY_DELIVERY_AMBIGUOUS','TARGET_MISMATCH','ACCOUNT_UNVERIFIED','EDITOR_LOADING','EDITOR_AMBIGUOUS','DRAFT_MISMATCH','ATTACHMENT_OR_REPLY','HISTORY_LOADING','POSSIBLY_SENT','PREPARE_EDITOR_UNSTABLE','COMMIT_EDITOR_UNSTABLE','DELIVERY_DRAFT_RETAINED','DELIVERY_CONFIRMATION_TIMEOUT','CONTENT_EXCEPTION_BEFORE_ENTER','CONTENT_EXCEPTION_AFTER_ENTER','COOLDOWN_UNVERIFIED','COOLDOWN_WAIT_TIMEOUT','PRE_ENTER_WAIT_CANCELLED','AUTHORIZATION_DENIED','AUTHORIZATION_EXPIRED','AUTHORIZATION_TIMEOUT','AUTHORIZATION_UNAVAILABLE','NATIVE_REQUEST_TIMEOUT','NATIVE_DISCONNECTED','NATIVE_SEND_FAILED','NATIVE_RESPONSE_REJECTED','SERVICE_UNAVAILABLE','SERVICE_REJECTED','ACCOUNT_MISMATCH','SESSION_MISMATCH','EXECUTION_STOPPED','CONFIG_MISMATCH','UPDATE_IN_PROGRESS','RETRY_COUNT_MISMATCH','ATTEMPT_STATE','STALE_ATTEMPT','RETRY_STATE_MISMATCH','RETRY_LIMIT_REACHED','RETRY_OBSERVATION_STALE','CHANNEL_NOT_READY','DISCORD_COOLDOWN','INTERVAL_NOT_ELAPSED','CLOCK_UNSAFE','COOLDOWN_ACTIVE']);
const deliveryStatuses=new Set(['uncertain','draft-retained','blocked','deferred','confirmed','failed','no_response','reconcile_inconclusive','executor_result']);
const validCode=code=>typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(code);
const safeReason=code=>deliveryCodes.has(code)||deliveryStatuses.has(code)?code:undefined;
const transientCodes=new Set(['NATIVE_DISCONNECTED','NATIVE_REQUEST_TIMEOUT','NATIVE_SEND_FAILED','SERVICE_UNAVAILABLE','AUTHORIZATION_EXPIRED','COOLDOWN_ACTIVE','ACCOUNT_UNVERIFIED','EDITOR_LOADING']);
const denied=(code,retryable=false,retryAfterMs=500)=>({allowed:false,code,retryable,...(retryable?{retryAfterMs:Number.isSafeInteger(retryAfterMs)?Math.min(5000,Math.max(100,retryAfterMs)):500}:{})});
const remoteDenied=value=>{const candidate=value?.code??value?.reasonCode,code=validCode(candidate)?candidate:'AUTHORIZATION_DENIED';return denied(code,value?.retryable===true||transientCodes.has(code),value?.retryAfterMs);};
function deliveryEvidence(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const evidence={};
  if(['prepare','commit','send'].includes(value.phase))evidence.phase=value.phase;
  if(['inspect','authorize','prepare','stable','enter','observe'].includes(value.stage))evidence.stage=value.stage;
  for(const key of ['enterAttempted','composerRetained','newMessage','matchingMessage','sendingSeen','failedSeen','authorMismatch','authorUnknown','timeMismatch','enterDefaultPrevented','keyupDefaultPrevented','documentHidden','documentFocused','composerCleared','expectedDraftSubmitted','sameEditor','sameComposer','editorReacquired','targetMatched','accountMatched','composerEmpty','editorPresent','sendingActive','ownMessageSeen'])if(typeof value[key]==='boolean')evidence[key]=value[key];
  if(Number.isSafeInteger(value.emptyStableMs)&&value.emptyStableMs>=0&&value.emptyStableMs<=30000)evidence.emptyStableMs=value.emptyStableMs;
  if(['keyboard','button'].includes(value.submitMethod))evidence.submitMethod=value.submitMethod;
  for(const key of ['retryCount','maxSendRetries'])if(Number.isSafeInteger(value[key])&&value[key]>=0)evidence[key]=value[key];
  if(value.maxSendRetries===null)evidence.maxSendRetries=null;
  return Object.keys(evidence).length?evidence:undefined;
}
const diagnostic=result=>({reasonCode:safeReason(result?.code)||safeReason(result?.status)||'no_response',...(deliveryEvidence(result?.deliveryEvidence)?{deliveryEvidence:deliveryEvidence(result.deliveryEvidence)}:{})});
const finalUnknownResponse=result=>['uncertain','draft-retained'].includes(result?.status)&&result?.deliveryEvidence?.phase==='commit'&&result.deliveryEvidence.stage==='observe'&&result.deliveryEvidence.enterAttempted===true;
export function createCentralExecutor({chrome,transport,openChannel,manageChannelWindow,lookupChannelName,now=Date.now,monotonicNow=()=>performance.now(),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  const inspectionCancels=new Map();
  let state,loading,writes=Promise.resolve(),inFlight=0,maintenance=false;const lanes=new Map(),commandJobs=new Map(),volatileStops=new Set(),volatileStoppedRuns=new Set(),pendingCooldownSamples=new Map();
  const load=()=>loading??=(async()=>{state={...fresh(),...(await chrome.storage.local.get('dicoCentral')).dicoCentral};for(const attempt of Object.values(state.attempts))attempt.maxSendRetries=normalizeSendRetries(attempt.maxSendRetries);return state;})();
  const save=()=>{const snapshot=structuredClone(state);const task=writes.then(()=>chrome.storage.local.set({dicoCentral:snapshot}));writes=task.catch(()=>{});return task;};
  const request=async message=>{if(state.resetPending)throw Error('초기화된 연결 정보를 저장하는 중입니다.');return transport.request({...message,sessionId:state.sessionId,resetEpoch:state.resetEpoch},state.instanceId);};
  /**
   * 중앙과의 요청 통신을 재시도합니다. 통신 재요청을 메시지 재발송과 혼동하지 않습니다.
   */
  async function retryRequest(message){
    const sessionId=state.sessionId,instanceId=state.instanceId;
    for(let count=0;;count++){
      try{return await request(message);}catch(error){
        if(count>=2||error?.retryable!==true||sessionId!==state.sessionId||instanceId!==state.instanceId)throw error;
        await wait(250*(count+1));
        if(sessionId!==state.sessionId||instanceId!==state.instanceId)throw error;
      }
    }
  }
  async function ack(c,status,extra={}){
    if(status==='applied'){state.processed[c.id]={status:'ack-pending',extra};await save();}
    return retryRequest({type:'ACK',commandId:c.id,status,...extra});
  }
  const target=a=>({tabId:a.tabId,guildId:a.guildId,channelId:a.channelId,ownUserId:a.accountId,coordinated:true,managed:true,skipConfirmation:false,messages:[a.body,a.body],expectedText:a.body});
  // 과거 횟수 옵션은 내부 계속 시도 정책으로 이행합니다. 실제 입력은 매번
  // 동일 시도·연속 횟수·세션·중지 상태와 중앙 승인을 다시 확인해야 합니다.
  const delivery=a=>({id:a.attemptId,sessionId:a.sessionId,index:0,text:a.body,startedAt:a.startedAt,scheduledAt:a.startedAt,strictAuthorization:true,maxSendRetries:normalizeSendRetries(a.maxSendRetries),...(a.phase==='preparing'?{phase:'prepare'}:{phase:'commit'})});
  const isIdle=()=>Boolean(state)&&inFlight===0&&Object.values(state.attempts).every(a=>['confirmed','not_sent','cancelled'].includes(a.phase));
  // 업데이트는 이미 실행 차단된 미확인 결과를 그대로 보존해 재시작할 수 있습니다.
  // 일반 연결 복구 idle은 엄격하게 유지하며, 활성 호출/초안 준비/발송 중에는 허용하지 않습니다.
  const isMaintenanceIdle=()=>Boolean(state)&&!state.resetPending&&inFlight===0&&Object.values(state.attempts).every(a=>['confirmed','not_sent','cancelled'].includes(a.phase)||['unknown','needs_review'].includes(a.phase)&&a.result?.executionBlocked===true);
  const matches=(a,p)=>['bindingId','accountId','guildId','channelId','tabId','configVersion','body'].every(k=>a[k]===p[k])&&normalizeSendRetries(a.maxSendRetries)===normalizeSendRetries(p.maxSendRetries);
  const tabMatches=async a=>{try{const tab=await chrome.tabs.get(a.tabId);return new URL(tab.url).pathname.replace(/\/$/,'')===`/channels/${a.guildId}/${a.channelId}` && new URL(tab.url).origin==='https://discord.com';}catch{return false;}};
  function inputAllowed(message,tabId){
    const a=state?.attempts?.[message?.id];
    if(!state||state.resetPending||maintenance||!transport.connected||state.emergencyStopped||!a||a.tabId!==tabId||a.sessionId!==state.sessionId||volatileStops.has(a.groupId)||state.stoppedGroups[a.groupId]||state.stoppedRuns[a.runId]||volatileStoppedRuns.has(a.runId))return false;
    const config=state.bindings[a.bindingId];if(!config||config.configVersion!==a.configVersion)return false;
    return message.phase==='prepare'?a.phase==='preparing':a.phase==='executing'&&Boolean(a.permitId)&&a.enterRequested===true;
  }
  function localDenial(message,tabId){
    const a=state?.attempts?.[message?.id];
    if(!a||a.tabId!==tabId)return denied('TARGET_MISMATCH');
    if(a.sessionId!==state.sessionId||state.resetPending)return denied('SESSION_MISMATCH');
    if(state.emergencyStopped||volatileStops.has(a.groupId)||state.stoppedGroups[a.groupId]||state.stoppedRuns[a.runId]||volatileStoppedRuns.has(a.runId))return denied('EXECUTION_STOPPED');
    if(state.bindings[a.bindingId]?.configVersion!==a.configVersion)return denied('CONFIG_MISMATCH');
    if(maintenance)return denied('UPDATE_IN_PROGRESS');
    if(!transport.connected)return denied('NATIVE_DISCONNECTED',true);
    return denied('AUTHORIZATION_DENIED');
  }
  /**
   * content script의 입력 요청이 현재 탭·시도에 속하는지 확인한 뒤 중앙 승인을 받습니다.
   */
  async function authorizeInput(message,tabId) {
    await load();const a=state.attempts[message?.id],localAllowed=()=>inputAllowed(message,tabId);
    if(!localAllowed())return localDenial(message,tabId);
    if(message.phase==='prepare')return{allowed:true};
    const retryCount=message.retryCount??0;
    if(!Number.isSafeInteger(retryCount)||retryCount!==(a.sendRetryCount??0))return denied('RETRY_COUNT_MISMATCH');
    const started=now(),monoStarted=monotonicNow();
    try{
      const response=await request({type:'AUTHORIZE_ENTER',attemptId:a.attemptId,runId:a.runId,configVersion:a.configVersion,retryCount});
      if(!localAllowed())return localDenial(message,tabId);
      const elapsed=now()-started,monoElapsed=monotonicNow()-monoStarted;
      if(elapsed<0||elapsed>2000||monoElapsed<0||monoElapsed>2000||Math.abs(elapsed-monoElapsed)>1000)return denied('AUTHORIZATION_EXPIRED',true);
      return response?.allowed===true?{allowed:true}:remoteDenied(response);
    }catch(error){return localAllowed()?remoteDenied(error):localDenial(message,tabId);}
  }
  const canSend=async(message,tabId)=>(await authorizeInput(message,tabId)).allowed;
  async function report(a) {
    const evidence=deliveryEvidence(a.result?.deliveryEvidence);
    await retryRequest({type:'DELIVERY_RESULT',attemptId:a.attemptId,outcome:a.result?.outcome || 'unknown',...(a.result?.recoveryCommandId?{recoveryCommandId:a.result.recoveryCommandId}:{}),messageId:a.result?.messageId,confirmationBasis:a.result?.confirmationBasis,confirmationMs:a.result?.confirmationMs,executionBlocked:a.result?.executionBlocked===true,reasonCode:safeReason(a.result?.reasonCode) || 'executor_result',...(evidence?{deliveryEvidence:evidence}:{})});
    a.reported=true;await save();
    const samples=pendingCooldownSamples.get(a.attemptId)||[];pendingCooldownSamples.delete(a.attemptId);
    if(a.phase==='confirmed')for(const sample of samples)await cooldownSample({deliveryId:a.attemptId,sample},a.tabId);
  }
  /**
   * 재연결 때 이전 시도를 먼저 대조합니다. 응답이 사라졌다는 이유로 이미 실행한 요청을 새로 보내지 않습니다.
   */
  async function synchronizePreviousAttempts(p) {
    const knownAttemptIds=Object.values(state.attempts).filter(a=>a.attemptId!==p.attemptId&&a.bindingId===p.bindingId&&['preparing','prepared','executing','unknown'].includes(a.phase)).slice(-500).map(a=>a.attemptId);
    if(!knownAttemptIds.length)return;
    const sessionId=state.sessionId,instanceId=state.instanceId;
    let response;
    try{response=await request({type:'HEARTBEAT',knownAttemptIds});}catch{return;}
    if(response?.ok!==true||!Array.isArray(response.terminalAttempts)||sessionId!==state.sessionId||instanceId!==state.instanceId)return;
    const requested=new Set(knownAttemptIds);let changed=false;
    for(const item of response.terminalAttempts){
      const local=state.attempts[item?.attemptId];
      if(!requested.has(item?.attemptId)||!local||!['preparing','prepared','executing','unknown'].includes(local.phase)||!['confirmed','not_sent','cancelled'].includes(item.status))continue;
      if(item.status==='confirmed'&&!/^\d{17,20}$/.test(item.messageId||'')&&!(item.confirmationBasis==='composer_cleared'&&composerClearedEvidence(item.deliveryEvidence)))continue;
      local.phase=item.status;local.reported=true;
      local.result={outcome:item.status==='confirmed'?'confirmed':'not_sent',...(item.messageId?{messageId:item.messageId}:{}),confirmationBasis:item.confirmationBasis,...(item.deliveryEvidence?{deliveryEvidence:item.deliveryEvidence}:{}),executionBlocked:true};changed=true;
    }
    if(changed)await save();
  }
  /**
   * 쿨다운·재시도·결과 관찰 동안 현재 시도가 계속 유효한지 중앙에 확인합니다.
   * 관찰 하트비트가 있어야 긴 대기를 단순 응답 유실로 판단하지 않을 수 있습니다.
   */
  async function authorizeWait(message,tabId,mode){
    await load();const a=state.attempts[message?.id];
    const allowed=()=>inputAllowed(message,tabId);
    if(!allowed())return localDenial(message,tabId);
    if(message?.phase!=='commit'||!Number.isSafeInteger(message.elapsedMs)||message.elapsedMs<0)return denied('INVALID_WAIT');
    let requestFields;
    if(mode==='observation'){
      if(!Number.isSafeInteger(message.retryCount)||message.retryCount!==(a.sendRetryCount??0))return denied('RETRY_COUNT_MISMATCH');
      requestFields={observationPhase:true,retryCount:message.retryCount,cooldownMs:0};
    }else{
      if(!Number.isSafeInteger(message.cooldownMs)||message.cooldownMs<0||message.cooldownMs>21600000)return denied('INVALID_WAIT');
      if(mode==='retry'){
        if(!Number.isSafeInteger(message.retryCount)||message.retryCount<1||message.retryCount<(a.sendRetryCount??0)||message.retryCount>(a.sendRetryCount??0)+1)return denied('RETRY_COUNT_MISMATCH');
        requestFields={retryPhase:true,retryCount:message.retryCount,cooldownMs:message.cooldownMs};
      }else{
        if(message.enterAttempted!==false||(a.sendRetryCount??0)!==0)return denied('RETRY_COUNT_MISMATCH');
        requestFields={cooldownMs:message.cooldownMs};
      }
    }
    const started=now(),monoStarted=monotonicNow();
    try{
      const response=await request({type:'DELIVERY_WAIT',attemptId:a.attemptId,runId:a.runId,configVersion:a.configVersion,...requestFields,elapsedMs:message.elapsedMs});
      if(!allowed())return localDenial(message,tabId);
      const elapsed=now()-started,monoElapsed=monotonicNow()-monoStarted;
      if(elapsed<0||elapsed>2000||monoElapsed<0||monoElapsed>2000||Math.abs(elapsed-monoElapsed)>1000)return denied('AUTHORIZATION_EXPIRED',true);
      if(response?.allowed!==true)return remoteDenied(response);
      if(mode==='retry'){a.sendRetryCount=message.retryCount;await save();}
      return allowed()?{allowed:true}:localDenial(message,tabId);
    }catch(error){return allowed()?remoteDenied(error):localDenial(message,tabId);}
  }
  const authorizePreEnterWait=(message,tabId)=>authorizeWait(message,tabId,'pre-enter');
  const authorizeRetryWait=(message,tabId)=>authorizeWait(message,tabId,'retry');
  const observationWait=(message,tabId)=>authorizeWait(message,tabId,'observation');
  const preEnterWait=async(message,tabId)=>(await authorizePreEnterWait(message,tabId)).allowed;
  const retryWait=async(message,tabId)=>(await authorizeRetryWait(message,tabId)).allowed;
  async function cooldownSample(message,tabId){
    await load();const a=state.attempts[message?.deliveryId],value=message?.sample;
    if(!value||!['remaining','observed'].includes(value.status)||!Number.isFinite(value.elapsedMs)||value.elapsedMs<0||value.elapsedMs>21720000||!Number.isFinite(value.maxGapMs)||value.maxGapMs<0||value.maxGapMs>1500)return false;
    if(value.status==='remaining'&&(!Number.isSafeInteger(value.remainingMs)||value.remainingMs<=0||value.remainingMs>21600000||value.elapsedMs>15000))return false;
    if(value.slowmodeMs!==undefined&&(!Number.isSafeInteger(value.slowmodeMs)||value.slowmodeMs<0||value.slowmodeMs>21600000))return false;
    const valid=()=>Boolean(a&&transport.connected&&!state.emergencyStopped&&a.tabId===tabId&&a.sessionId===state.sessionId&&['executing','confirmed'].includes(a.phase)&&state.bindings[a.bindingId]?.configVersion===a.configVersion&&Object.values(state.attempts).filter(other=>other.bindingId===a.bindingId).at(-1)===a);
    if(!valid()||!await tabMatches(a)||!valid())return false;
    const sample={status:value.status,elapsedMs:value.elapsedMs,maxGapMs:value.maxGapMs,...(value.status==='remaining'?{remainingMs:value.remainingMs}:{}),...(value.slowmodeMs===undefined?{}:{slowmodeMs:value.slowmodeMs})};
    // The first DOM reading can arrive before DICO_DELIVER returns. Hold only
    // bounded scalar evidence until DELIVERY_RESULT has confirmed this attempt.
    if(a.phase!=='confirmed'||!a.reported){const queued=pendingCooldownSamples.get(a.attemptId)||[];if(queued.length>=4)return false;queued.push(sample);pendingCooldownSamples.set(a.attemptId,queued);return true;}
    try{return(await request({type:'COOLDOWN_SAMPLE',attemptId:a.attemptId,runId:a.runId,configVersion:a.configVersion,sample}))?.ok===true;}catch{return false;}
  }
  async function inspectBeforePrepare(a,message) {
    let timer,cancel;
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(a.tabId,message),
        new Promise((_,reject)=>{cancel=()=>reject(Object.assign(Error('중지 요청으로 Discord 탭 상태 조회를 취소했습니다.'),{code:'EXECUTION_STOPPED'}));inspectionCancels.set(a,cancel);if(volatileStops.has(a.groupId)||volatileStoppedRuns.has(a.runId))cancel();}),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('Discord 탭 상태 확인 응답이 지연됩니다. 초안을 보존하고 준비를 중단합니다.'),{code:'CONTENT_INSPECTION_TIMEOUT'})),20000);})
      ]);
    } catch(error) {
      // 읽기 전용 조회가 멈춰도 중지 명령이 같은 대기열에서 영구 대기하지 않게 합니다.
      // Enter를 요청하지 않은 현재 준비만 종료하며, 늦은 조회 응답은 사용하지 않습니다.
      if(['CONTENT_INSPECTION_TIMEOUT','EXECUTION_STOPPED'].includes(error?.code)&&state.attempts[a.attemptId]===a&&!a.enterRequested&&['preparing','prepared'].includes(a.phase)){
        a.phase='not_sent';a.result={outcome:'not_sent',executionBlocked:true};await save();
      }
      throw error;
    } finally {clearTimeout(timer);if(inspectionCancels.get(a)===cancel)inspectionCancels.delete(a);}
  }
  async function awaitPrepared(a) {
    const started=now(),monoStarted=monotonicNow();
    const stopped=()=>!transport.connected||state.emergencyStopped||a.sessionId!==state.sessionId||state.stoppedRuns[a.runId]||volatileStoppedRuns.has(a.runId)||state.stoppedGroups[a.groupId]||volatileStops.has(a.groupId);
    for(;;){
      if(stopped())return;
      const elapsed=now()-started,monoElapsed=monotonicNow()-monoStarted;
      if(elapsed<0||monoElapsed<0||elapsed>21630000||monoElapsed>21630000||Math.abs(elapsed-monoElapsed)>2000)throw Object.assign(Error('입력 준비 대기가 만료되었습니다. 남은 초안과 채널 상태를 확인하세요.'),{code:'PREPARE_WAIT_TIMEOUT'});
      if(state.bindings[a.bindingId]?.configVersion!==a.configVersion||!await tabMatches(a))throw Object.assign(Error('대기 중 채널 또는 구성이 변경되었습니다.'),{code:'CONFIG_MISMATCH'});
      let seen;try{seen=await inspectBeforePrepare(a,{type:'DICO_INSPECT',target:target(a)});}catch(error){if(['CONTENT_INSPECTION_TIMEOUT','EXECUTION_STOPPED'].includes(error?.code))throw error;throw Object.assign(Error('대기 중 Discord 탭의 연결을 확인하지 못했습니다.'),{code:'CONTENT_UNAVAILABLE'});}
      if(stopped())return;
      if(seen?.ok!==true)throw Object.assign(Error('대기 중 계정과 채널 상태를 확인하지 못했습니다.'),{code:deliveryCodes.has(seen?.code)?seen.code:'PREPARE_REJECTED'});
      if(seen.draftMatches!==true)throw Object.assign(Error('준비한 초안이 변경되었습니다. 남은 초안을 확인하세요.'),{code:'DRAFT_MISMATCH'});
      if(seen.cooldownKnown!==true||!Number.isSafeInteger(seen.cooldownMs)||seen.cooldownMs<0||seen.cooldownMs>21600000)throw Object.assign(Error('Discord의 남은 대기 시간을 확인하지 못했습니다.'),{code:'COOLDOWN_UNVERIFIED'});
      const response=await request({type:'PREPARED',attemptId:a.attemptId,configVersion:a.configVersion,accountId:a.accountId,channelId:a.channelId,draftClear:true,cooldownMs:seen.cooldownMs});
      if(response?.permitIssued!==false||!Number.isFinite(response.retryAfterMs)||response.retryAfterMs<=0)return;
      await wait(Math.min(1000,Math.max(500,response.retryAfterMs)));
    }
  }
  /**
   * 명령 종류별 실제 처리입니다. 준비와 실행 결과를 content script에서 받은 뒤 중앙에 보고합니다.
   * 오류가 Enter 이전인지 이후인지에 따라 미발송을 확정할 수 있는 범위가 달라집니다.
   */
  async function perform(c) {
    const p=c.payload || {};
    if(c.sessionId!==state.sessionId || c.instanceId!==state.instanceId)return;
    if(state.processed[c.id]&&state.processed[c.id]?.status!=='report-pending'){
      const previous=state.processed[c.id];
      if(previous?.status==='rejected')await ack(c,'rejected',{rejectionCode:previous.rejectionCode});
      else if(previous?.status==='ack-pending'){await ack(c,'applied',previous.extra);state.processed[c.id]=true;state.lastError=null;await save();}
      return;
    }
    if(maintenance&&c.type!=='CONTROL')throw Object.assign(Error('확장 업데이트 적용 중입니다.'),{code:'UPDATE_IN_PROGRESS'});
    await ack(c,'received');
    if(c.sessionId!==state.sessionId||c.instanceId!==state.instanceId)return;
    if(c.type==='LOOKUP_CHANNEL_NAME') {
      const name=typeof lookupChannelName==='function'?await lookupChannelName(p):null;
      if(c.sessionId!==state.sessionId||c.instanceId!==state.instanceId)return;
      await ack(c,'applied',typeof name==='string'&&name.trim()&&name.length<=100?{channelName:name.trim()}:{});
    } else if(c.type==='MANAGE_WINDOW') {
      if(typeof manageChannelWindow!=='function')throw Object.assign(Error('전송 창 관리를 지원하는 확장으로 업데이트하세요.'),{code:'EXTENSION_UPDATE_REQUIRED'});
      if(!['reveal','hide','consolidate','separate'].includes(p.action))throw Object.assign(Error('지원하지 않는 창 관리 요청입니다.'),{code:'INVALID_WINDOW_ACTION'});
      if(['consolidate','separate'].includes(p.action)&&(inFlight>1||Object.values(state.attempts).some(a=>!['confirmed','not_sent','cancelled'].includes(a.phase))))throw Object.assign(Error('발송을 중지하고 미확인 결과를 먼저 확인하세요.'),{code:'ATTEMPT_UNRESOLVED'});
      if(['consolidate','separate'].includes(p.action))maintenance=true;
      try{await manageChannelWindow(p);}finally{if(['consolidate','separate'].includes(p.action))maintenance=false;}
      await ack(c,'applied');
    } else if(c.type==='CLOSE_CHANNEL') {
      if(typeof manageChannelWindow!=='function')throw Object.assign(Error('채널 연결 해제를 지원하는 확장으로 업데이트하세요.'),{code:'EXTENSION_UPDATE_REQUIRED'});
      if(p.tabId!==undefined&&!Number.isInteger(p.tabId)||!p.accountId||!p.guildId||!p.channelId)throw Object.assign(Error('닫을 전송 탭 정보가 올바르지 않습니다.'),{code:'TARGET_MISMATCH'});
      if(Object.values(state.attempts).some(a=>(p.tabId!==undefined?a.tabId===p.tabId:['accountId','guildId','channelId'].every(key=>a[key]===p[key]))&&!['confirmed','not_sent','cancelled'].includes(a.phase)&&!(a.phase==='unknown'&&a.result?.executionBlocked===true)))throw Object.assign(Error('진행 중인 발송 입력 차단을 기다리고 있습니다.'),{code:'ATTEMPT_UNRESOLVED'});
      maintenance=true;
      try{
        await manageChannelWindow({...p,action:'close'});
        for(const [id,binding] of Object.entries(state.bindings)){
          if((!p.bindingId||id===p.bindingId)&&(p.tabId===undefined||binding.tabId===p.tabId)&&['accountId','guildId','channelId'].every(key=>binding[key]===p[key]))delete state.bindings[id];
        }
        await save();
      }finally{maintenance=false;}
      await ack(c,'applied');
    } else if(c.type==='OPEN_CHANNEL') {
      if(state.emergencyStopped)throw Object.assign(Error('긴급 중지를 해제하고 다시 연결하세요.'),{code:'EXECUTION_STOPPED'});
      if(typeof openChannel!=='function')throw Object.assign(Error('채널 연결 기능을 지원하는 확장으로 업데이트하세요.'),{code:'OPEN_CHANNEL_UNSUPPORTED'});
      await openChannel({...p,commandId:c.id});await ack(c,'applied');
    } else if(c.type==='CONFIG_SYNC') {
      // PREPARE 거절 ACK가 중앙에 도착해도 로컬 기록은 preparing에 남을 수 있습니다.
      // 재연결의 설정 동기화도 중앙 종료 기록을 먼저 대조해야 이 잔여 기록에 막히지 않습니다.
      // 중앙에서 종료를 확인한 시도만 정리하며, 미확인 결과나 응답 유실은 계속 차단합니다.
      await synchronizePreviousAttempts({bindingId:p.bindingId});
      if(c.sessionId!==state.sessionId||c.instanceId!==state.instanceId)return;
      if(Object.values(state.attempts).some(a=>a.bindingId===p.bindingId && ['preparing','prepared','executing','unknown'].includes(a.phase)))throw Error('진행 중 발송 결과를 먼저 확인하세요.');
      state.bindings[p.bindingId]=structuredClone(p);await save();await ack(c,'applied');
    } else if(c.type==='PREPARE') {
      if(!p.runId || state.stoppedRuns[p.runId] || volatileStoppedRuns.has(p.runId) || state.emergencyStopped)throw Error('이미 중지된 실행의 입력 준비를 다시 시작할 수 없습니다.');
      const config=state.bindings[p.bindingId];
      if(!config || config.configVersion!==p.configVersion || config.accountId!==p.accountId || config.channelId!==p.channelId || !await tabMatches(p))throw Object.assign(Error('채널 또는 적용된 구성 버전이 다릅니다.'),{code:'CONFIG_MISMATCH'});
      // Native command delivery can precede the periodic heartbeat after a
      // manual retry. Resolve old ledger entries only from the service first.
      await synchronizePreviousAttempts(p);
      if(c.sessionId!==state.sessionId||c.instanceId!==state.instanceId)return;
      if(!transport.connected||state.stoppedRuns[p.runId]||volatileStoppedRuns.has(p.runId)||state.emergencyStopped)throw Object.assign(Error('이전 결과 확인 중 발송 준비가 중지되었습니다.'),{code:'EXECUTION_STOPPED'});
      let a=state.attempts[p.attemptId];
      if(a?.phase==='confirmed'&&a.sessionId===state.sessionId){
        const receipt=planDraftPreparation({attempt:p,attempts:state.attempts});
        if(receipt.action!=='confirmed')throw Object.assign(Error('기존 전송 기록과 요청이 일치하지 않습니다.'),{code:receipt.reasonCode||'PREPARATION_MISMATCH'});
        await report(a);await ack(c,'applied');state.processed[c.id]=true;await save();return;
      }
      if(!a) {
        delete state.stoppedGroups[p.groupId];volatileStops.delete(p.groupId);
        a={...structuredClone(p),maxSendRetries:normalizeSendRetries(p.maxSendRetries),sessionId:state.sessionId,phase:'preparing',startedAt:now(),enterRequested:false};state.attempts[p.attemptId]=a;await save();
      } else if(!matches(a,p) || a.sessionId!==state.sessionId || !['preparing','prepared'].includes(a.phase))throw Error('기존 발송 시도를 다시 준비할 수 없습니다.');
      if(a.phase!=='prepared') {
        let inspection;
        try{inspection=await inspectBeforePrepare(a,{type:'DICO_DRAFT_INSPECT',target:target(a),delivery:delivery(a)});}catch(error){if(['CONTENT_INSPECTION_TIMEOUT','EXECUTION_STOPPED'].includes(error?.code))throw error;throw Object.assign(Error('기존 입력 내용을 확인하지 못했습니다. 초안을 보존합니다.'),{code:'DRAFT_INSPECTION_UNAVAILABLE'});}
        const plan=planDraftPreparation({attempt:a,attempts:state.attempts,inspection});
        if(plan.action==='blocked')throw Object.assign(Error('기존 초안 또는 이전 발송 결과를 확인해야 합니다.'),{code:plan.reasonCode});
        if(plan.action==='replace'){recordDraftBackup(state,a,plan.backupText,now());await save();}
        if(!transport.connected||state.emergencyStopped||a.sessionId!==state.sessionId||volatileStops.has(a.groupId)||state.stoppedGroups[a.groupId]||state.stoppedRuns[a.runId]||volatileStoppedRuns.has(a.runId))throw Object.assign(Error('초안 확인 중 발송 준비가 중지되었습니다.'),{code:'EXECUTION_STOPPED'});
        let result;
        let prepareTimer;
        try{
          result=await Promise.race([
            chrome.tabs.sendMessage(a.tabId,{type:'DICO_PREPARE',target:target(a),delivery:{...delivery(a),...(plan.action==='replace'?{replaceExpectedDraft:plan.replaceExpectedDraft}:{})}}),
            new Promise((_,reject)=>{prepareTimer=setTimeout(()=>reject(Object.assign(Error('입력 준비 응답이 지연되어 초안을 보존하고 준비 권한을 취소했습니다.'),{code:'PREPARE_TIMEOUT'})),20000);})
          ]);
        }catch(error){
          // PREPARE cannot press Enter. Revoke its local authorization before
          // releasing the lane; a late response must never request a permit.
          a.phase='not_sent';a.result={outcome:'not_sent',executionBlocked:true};await save();
          throw Object.assign(Error('전송용 Discord 탭의 입력 준비 응답을 확인하지 못했습니다. 초안을 보존합니다.'),{code:error?.code==='PREPARE_TIMEOUT'?'PREPARE_TIMEOUT':'CONTENT_UNAVAILABLE'});
        }finally{clearTimeout(prepareTimer);}
        if(result?.status!=='prepared')throw Object.assign(Error(result?.error || '입력 준비 결과를 확인하지 못했습니다.'),{code:/^[A-Z][A-Z0-9_]{0,63}$/.test(result?.code||'')?result.code:'PREPARE_REJECTED'});
        a.phase='prepared';await save();
      }
      if(volatileStops.has(a.groupId) || state.stoppedGroups[a.groupId])throw Error('중지 요청으로 준비를 취소했습니다.');
      await awaitPrepared(a);await ack(c,'applied');
    } else if(c.type==='COMMIT_PERMIT') {
      const a=state.attempts[p.attemptId];
      if(!a||!matches(a,p)||a.runId!==p.runId||a.sessionId!==state.sessionId||!p.permitId)throw Object.assign(Error('발송 허가가 준비한 문구와 일치하지 않습니다.'),{code:'STALE_ATTEMPT'});
      if(a.enterRequested) {if(!a.reported)await report(a);await ack(c,'applied');}
      else {
        if(state.stoppedRuns[p.runId]||volatileStoppedRuns.has(p.runId)||state.emergencyStopped||state.stoppedGroups[a.groupId]||volatileStops.has(a.groupId))throw Object.assign(Error('중지된 실행의 발송을 진행할 수 없습니다.'),{code:'EXECUTION_STOPPED'});
        if(a.phase!=='prepared')throw Object.assign(Error('준비가 완료되지 않은 발송입니다.'),{code:'ATTEMPT_STATE'});
        if(state.bindings[a.bindingId]?.configVersion!==a.configVersion)throw Object.assign(Error('발송 구성 버전이 변경되었습니다.'),{code:'CONFIG_MISMATCH'});
        if(!transport.connected)throw Object.assign(Error('관리 프로그램 연결을 기다립니다.'),{code:'NATIVE_DISCONNECTED',retryable:true});
        if(!await tabMatches(a))throw Object.assign(Error('발송 대상 채널이 변경되었습니다.'),{code:'TARGET_MISMATCH'});
        // Tab lookup yields; a stop/configuration change must close the gate
        // again before recording the operation that may request Enter.
        if(state.stoppedRuns[p.runId]||volatileStoppedRuns.has(p.runId)||state.emergencyStopped||state.stoppedGroups[a.groupId]||volatileStops.has(a.groupId))throw Object.assign(Error('중지된 실행의 발송을 진행할 수 없습니다.'),{code:'EXECUTION_STOPPED'});
        if(a.sessionId!==state.sessionId||state.bindings[a.bindingId]?.configVersion!==a.configVersion)throw Object.assign(Error('발송 세션 또는 구성이 변경되었습니다.'),{code:'CONFIG_MISMATCH'});
        a.permitId=p.permitId;a.phase='executing';a.enterRequested=true;await save();
        let result;
        try{result=await chrome.tabs.sendMessage(a.tabId,{type:'DICO_DELIVER',target:target(a),delivery:delivery(a)});}catch{}
        if(!result&&transport.connected&&a.phase==='executing'&&a.sessionId===state.sessionId&&await tabMatches(a)){
          // A response port can close after content already observed completion.
          // Query that exact operation's cached result once; never resend Enter
          // or reconstruct completion from today's empty editor/history.
          let receipt;try{receipt=await chrome.tabs.sendMessage(a.tabId,{type:'DICO_DELIVERY_RECEIPT',target:target(a),delivery:delivery(a)});}catch{}
          if(transport.connected&&a.phase==='executing'&&a.sessionId===state.sessionId&&receipt?.status==='confirmed'&&receipt.confirmationBasis==='composer_cleared'&&composerClearedEvidence(receipt.deliveryEvidence))result=receipt;
        }
        if(result?.status==='confirmed' && (result.confirmationBasis==='composer_cleared'?composerClearedEvidence(result.deliveryEvidence):(!result.confirmationBasis||result.confirmationBasis==='message_observed')&&/^\d{17,20}$/.test(result.messageId || ''))) {
          a.phase='confirmed';a.result={outcome:'confirmed',...(result.messageId?{messageId:result.messageId}:{}),confirmationBasis:result.confirmationBasis||'message_observed',confirmationMs:result.timing?.confirmationMs,...diagnostic(result)};
        } else if(result?.status==='blocked' || result?.status==='deferred') {
          a.phase='not_sent';a.result={outcome:'not_sent',executionBlocked:true,...diagnostic(result)};
        } else {
          a.phase='unknown';a.result={outcome:'unknown',...(finalUnknownResponse(result)?{executionBlocked:true}:{}),...diagnostic(result)};
          // A final observation drains the content operation; the persisted phase
          // also revokes any delayed AUTHORIZE_ENTER response. Lost responses
          // and busy/duplicate guards provide no such evidence.
        }
        await save();await report(a);await ack(c,'applied');
      }
    } else if(c.type==='CONTROL') {
      if(p.runId)state.stoppedRuns[p.runId]=true;
      state.stoppedGroups[p.groupId]=true;volatileStops.add(p.groupId);await save();
      const a=state.attempts[p.attemptId];
      // This lane has drained any in-flight send. Revocation prevents any new
      // Enter, but does not claim an earlier Enter never reached Discord.
      if(a?.result?.outcome==='unknown'){a.result.executionBlocked=true;await save();}
      await ack(c,'applied',{executionBlocked:true,...(p.attemptId?{attemptId:p.attemptId}:{})});
      if(a && !a.enterRequested){a.phase='cancelled';await save();}
    } else if(c.type==='RECONCILE') {
      const prior=state.attempts[p.attemptId];
      if(prior?.result?.outcome==='confirmed'&&(prior.result.confirmationBasis!=='composer_cleared'||prior.sessionId===state.sessionId&&composerClearedEvidence(prior.result.deliveryEvidence))){
        // 완료를 저장한 뒤 보고만 유실된 경우에도 이번 조회 ID로 재보고합니다.
        // 과거 조회 ID는 이미 끝났을 수 있으므로 현재 명령의 ID로 갱신합니다.
        if(prior.result.confirmationBasis==='composer_cleared')prior.result.recoveryCommandId=c.id;
        await report(prior);await ack(c,'applied');
      }
      else {
        const a=prior || {...p,startedAt:now(),phase:'unknown'};
        // 복구에서는 Enter를 재실행하지 않습니다. 동일 시도의 실제 완료 영수증을
        // 먼저 조회하고, 없을 때만 기존 게시 기록 대조로 넘어갑니다.
        // 현재 빈 입력창으로 성공을 추측하지 않으며 content가 시도/세션/초안을 검증합니다.
        let result;
        if(prior&&a.sessionId===state.sessionId){
          try{result=await chrome.tabs.sendMessage(a.tabId,{type:'DICO_DELIVERY_RECEIPT',target:target(a),delivery:delivery(a)});}catch{}
          // 조회 중 재연결/초기화가 일어났다면 과거 세션 영수증을 현재 결과로 저장하지 않습니다.
          if(!transport.connected||c.sessionId!==state.sessionId||a.sessionId!==state.sessionId||state.attempts[p.attemptId]!==a)return;
          if(result?.status==='confirmed'&&result.confirmationBasis==='composer_cleared'&&composerClearedEvidence(result.deliveryEvidence)){
            a.phase='confirmed';a.result={outcome:'confirmed',confirmationBasis:'composer_cleared',recoveryCommandId:c.id,...diagnostic(result)};
            await save();await report(a);await ack(c,'applied');state.processed[c.id]=true;await save();return;
          }
        }
        try{result=await chrome.tabs.sendMessage(a.tabId,{type:'DICO_RECONCILE',target:target(a),delivery:delivery(a)});}catch{}
        if(result?.status==='confirmed' && /^\d{17,20}$/.test(result.messageId || '')){a.phase='confirmed';a.result={outcome:'confirmed',messageId:result.messageId,confirmationBasis:'message_observed'};state.attempts[p.attemptId]=a;await save();await report(a);}
        else if(prior?.result?.outcome==='unknown')await report(prior);
        else await request({type:'DELIVERY_RESULT',attemptId:p.attemptId,outcome:'unknown',reasonCode:'reconcile_inconclusive'});
        await ack(c,'applied');
      }
    } else throw Error('지원하지 않는 중앙 명령입니다.');
    state.processed[c.id]=true;state.lastError=null;await save();
  }
  /**
   * 중앙에서 받은 명령의 실행 진입점입니다. 중복 명령과 실행 중인 작업 상태를 관리합니다.
   */
  function handleCommand(c) {
    // Native push and heartbeat can deliver the same command while its content
    // response is pending. Coalesce before enqueueing, including during load.
    const commandKey=`${c?.sessionId}:${c?.id}`;
    if(commandJobs.has(commandKey))return commandJobs.get(commandKey);
    /**
     * 중단은 발송 응답과 같은 대기열에 넣기 전에 입력 게이트부터 닫습니다.
     * 단, 과거 세션의 중단이 새 실행까지 막지 않도록 소유자/세션을 먼저 확인합니다.
     * content에 보내는 신호는 대기를 깨우는 용도이며 적용 ACK의 근거가 아닙니다.
     * 적용 ACK는 아래 기존 lane이 끝나 실제 작업이 반환된 뒤에만 보냅니다.
     */
    const interrupt=()=>{
      if(c?.type!=='CONTROL'||c.sessionId!==state?.sessionId||c.instanceId!==state?.instanceId||state.processed[c.id])return;
      volatileStops.add(c.payload?.groupId);if(c.payload?.runId)volatileStoppedRuns.add(c.payload.runId);
      for(const a of Object.values(state.attempts)){
        if(a.groupId!==c.payload?.groupId||(c.payload?.runId&&a.runId!==c.payload.runId)||a.sessionId!==state.sessionId||!['preparing','prepared','executing'].includes(a.phase))continue;
        // 읽기 전용 조회는 응답을 기다릴 필요 없이 대기열을 즉시 해제합니다.
        inspectionCancels.get(a)?.();
        void Promise.resolve().then(()=>chrome.tabs.sendMessage(a.tabId,{type:'DICO_CANCEL_DELIVERY',delivery:{id:a.attemptId,sessionId:a.sessionId}})).catch(()=>{});
      }
    };
    if(state)interrupt();
    const job=(async()=>{
      inFlight++;try {await load();interrupt();const key=c.type==='CLOSE_CHANNEL'?'config':c.payload?.bindingId || (c.payload?.attemptId && state.attempts[c.payload.attemptId]?.bindingId) || c.payload?.groupId || 'config';
      const lane=(lanes.get(key) || Promise.resolve()).then(()=>perform(c)).catch(async error=>{
        state.lastError=String(error.message || error).slice(0,250);
        const attempt=state.attempts[c.payload?.attemptId];
        if(state.processed[c.id]?.status==='ack-pending'||(['COMMIT_PERMIT','RECONCILE'].includes(c.type)&&attempt?.result)){
          if(state.processed[c.id]?.status!=='ack-pending')state.processed[c.id]={status:'report-pending',reasonCode:safeReason(error.code)||'REPORT_FAILED'};
          await save();return;
        }
        if(error?.retryable===true){await save();return;}

        // Rejection is terminal too. Persist before ACK so already queued or
        // replayed commands cannot replace the original cause with PREPARE_FAILED.
        const rejectionCode=/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code||'')?error.code:`${c.type}_FAILED`;
        state.processed[c.id]={status:'rejected',rejectionCode};await save();
        if(c.sessionId===state.sessionId)try{await ack(c,'rejected',{rejectionCode});}catch{}
      });lanes.set(key,lane);await lane;
      }finally{inFlight--;}
    })();
    commandJobs.set(commandKey,job);
    void job.finally(()=>{if(commandJobs.get(commandKey)===job)commandJobs.delete(commandKey);}).catch(()=>{});
    return job;
  }
  return {get isIdle(){return isIdle();},get isMaintenanceIdle(){return isMaintenanceIdle();},beginMaintenance({allowBlocked=false}={}){if(maintenance||!(allowBlocked?isMaintenanceIdle():isIdle()))return false;maintenance=true;return true;},endMaintenance(){maintenance=false;},load,save,request,handleCommand,canSend,authorizeInput,inputAllowed,inputDenial:localDenial,preEnterWait,retryWait,authorizePreEnterWait,authorizeRetryWait,observationWait,cooldownSample,async setSession(s){
      await load();const resetEpoch=s.resetEpoch??0;
      if(!Number.isSafeInteger(resetEpoch)||resetEpoch<0)throw Error('초기화 세대가 올바르지 않습니다.');
      const reset=state.resetPending===true||s.resetRequired===true||resetEpoch!==state.resetEpoch;
      if(reset){
        // Remove automation assignments, never Discord tabs or composer text.
        // Central reset only succeeds after active delivery results are resolved.
        state={...fresh(),legacyDeclaration:state.legacyDeclaration,emergencyStopped:state.emergencyStopped,draftBackups:state.draftBackups};
        volatileStops.clear();volatileStoppedRuns.clear();pendingCooldownSamples.clear();
      }
      state.instanceId=s.instanceId;state.sessionId=s.sessionId;state.resetEpoch=resetEpoch;state.resetPending=reset;
      if(reset){
        const snapshot={...structuredClone(state),resetPending:false};
        const task=writes.then(()=>chrome.storage.local.set({dicoCentral:snapshot,dicoCentralTabs:[],dicoCentralAccount:null,dicoCentralWindowId:null}));writes=task.catch(()=>{});await task;state.resetPending=false;
      }else await save();
      return{reset};
    },async declareLegacy(value){await load();if(!['fresh','legacy-stopped'].includes(value))throw Error('기존 실행기 상태를 선택하세요.');state.legacyDeclaration=value;await save();},get state(){return state;},disconnect(){for(const a of Object.values(state?.attempts || {}))volatileStops.add(a.groupId);}};
}
