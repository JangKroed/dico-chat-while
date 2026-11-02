import {planDraftPreparation,recordDraftBackup} from './draft-ledger.js';
const fresh=()=>({version:1,instanceId:null,sessionId:null,resetEpoch:0,resetPending:false,legacyDeclaration:null,emergencyStopped:false,bindings:{},attempts:{},processed:{},stoppedGroups:{},stoppedRuns:{},draftBackups:[],lastError:null});
const deliveryCodes=new Set(['MANAGED_DELAY_UNAVAILABLE','RETRY_CANCELLED','RETRY_DELIVERY_AMBIGUOUS','TARGET_MISMATCH','ACCOUNT_UNVERIFIED','EDITOR_LOADING','EDITOR_AMBIGUOUS','DRAFT_MISMATCH','ATTACHMENT_OR_REPLY','HISTORY_LOADING','POSSIBLY_SENT','PREPARE_EDITOR_UNSTABLE','COMMIT_EDITOR_UNSTABLE','DELIVERY_DRAFT_RETAINED','DELIVERY_CONFIRMATION_TIMEOUT','CONTENT_EXCEPTION_BEFORE_ENTER','CONTENT_EXCEPTION_AFTER_ENTER','COOLDOWN_UNVERIFIED','COOLDOWN_WAIT_TIMEOUT','PRE_ENTER_WAIT_CANCELLED']);
const deliveryStatuses=new Set(['uncertain','draft-retained','blocked','deferred','confirmed','failed','no_response','reconcile_inconclusive','executor_result']);
const safeReason=code=>deliveryCodes.has(code)||deliveryStatuses.has(code)?code:undefined;
function deliveryEvidence(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const evidence={};
  if(['prepare','commit','send'].includes(value.phase))evidence.phase=value.phase;
  if(['inspect','authorize','prepare','stable','enter','observe'].includes(value.stage))evidence.stage=value.stage;
  for(const key of ['enterAttempted','composerRetained','newMessage','matchingMessage','sendingSeen','failedSeen','authorMismatch','authorUnknown','timeMismatch','enterDefaultPrevented','keyupDefaultPrevented','documentHidden','documentFocused'])if(typeof value[key]==='boolean')evidence[key]=value[key];
  if(['keyboard','button'].includes(value.submitMethod))evidence.submitMethod=value.submitMethod;
  for(const key of ['retryCount','maxSendRetries'])if(Number.isInteger(value[key])&&value[key]>=0&&value[key]<=5)evidence[key]=value[key];
  return Object.keys(evidence).length?evidence:undefined;
}
const diagnostic=result=>({reasonCode:deliveryCodes.has(result?.code)?result.code:safeReason(result?.status)||'no_response',...(deliveryEvidence(result?.deliveryEvidence)?{deliveryEvidence:deliveryEvidence(result.deliveryEvidence)}:{})});
const finalUnknownResponse=result=>['uncertain','draft-retained'].includes(result?.status)&&result?.deliveryEvidence?.phase==='commit'&&result.deliveryEvidence.stage==='observe'&&result.deliveryEvidence.enterAttempted===true;
export function createCentralExecutor({chrome,transport,openChannel,manageChannelWindow,lookupChannelName,now=Date.now,monotonicNow=()=>performance.now(),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  let state,loading,writes=Promise.resolve(),inFlight=0,maintenance=false;const lanes=new Map(),commandJobs=new Map(),volatileStops=new Set(),volatileStoppedRuns=new Set(),pendingCooldownSamples=new Map();
  const load=()=>loading??=(async()=>{state={...fresh(),...(await chrome.storage.local.get('dicoCentral')).dicoCentral};return state;})();
  const save=()=>{const snapshot=structuredClone(state);const task=writes.then(()=>chrome.storage.local.set({dicoCentral:snapshot}));writes=task.catch(()=>{});return task;};
  const request=async message=>{if(state.resetPending)throw Error('초기화된 연결 정보를 저장하는 중입니다.');return transport.request({...message,sessionId:state.sessionId,resetEpoch:state.resetEpoch},state.instanceId);};
  const ack=(c,status,extra={})=>request({type:'ACK',commandId:c.id,status,...extra});
  const target=a=>({tabId:a.tabId,guildId:a.guildId,channelId:a.channelId,ownUserId:a.accountId,coordinated:true,managed:true,skipConfirmation:false,messages:[a.body,a.body],expectedText:a.body});
  const delivery=a=>({id:a.attemptId,index:0,text:a.body,startedAt:a.startedAt,scheduledAt:a.startedAt,strictAuthorization:true,maxSendRetries:a.maxSendRetries??5,...(a.phase==='preparing'?{phase:'prepare'}:{phase:'commit'})});
  const isIdle=()=>Boolean(state)&&inFlight===0&&Object.values(state.attempts).every(a=>['confirmed','not_sent','cancelled'].includes(a.phase));
  const matches=(a,p)=>['bindingId','accountId','guildId','channelId','tabId','configVersion','body'].every(k=>a[k]===p[k])&&(a.maxSendRetries??5)===(p.maxSendRetries??5);
  const tabMatches=async a=>{try{const tab=await chrome.tabs.get(a.tabId);return new URL(tab.url).pathname===`/channels/${a.guildId}/${a.channelId}` && new URL(tab.url).origin==='https://discord.com';}catch{return false;}};
  function inputAllowed(message,tabId){
    const a=state?.attempts?.[message?.id];
    if(!state||state.resetPending||maintenance||!transport.connected||state.emergencyStopped||!a||a.tabId!==tabId||a.sessionId!==state.sessionId||volatileStops.has(a.groupId)||state.stoppedGroups[a.groupId]||state.stoppedRuns[a.runId]||volatileStoppedRuns.has(a.runId))return false;
    const config=state.bindings[a.bindingId];if(!config||config.configVersion!==a.configVersion)return false;
    return message.phase==='prepare'?a.phase==='preparing':a.phase==='executing'&&Boolean(a.permitId)&&a.enterRequested===true;
  }
  async function canSend(message,tabId) {
    await load();const a=state.attempts[message.id],localAllowed=()=>inputAllowed(message,tabId);
    if(!localAllowed())return false;
    if(message.phase==='prepare')return true;
    const retryCount=message.retryCount??0;
    if(!Number.isInteger(retryCount)||retryCount!==(a.sendRetryCount??0))return false;
    // Revalidate service state immediately before Enter, including any sleep,
    // stale run, configuration change or global pause since the permit arrived.
    const started=now(),monoStarted=monotonicNow();
    try{
      const response=await request({type:'AUTHORIZE_ENTER',attemptId:a.attemptId,runId:a.runId,configVersion:a.configVersion,retryCount});
      const elapsed=now()-started,monoElapsed=monotonicNow()-monoStarted;
      return elapsed>=0&&elapsed<=2000&&monoElapsed>=0&&monoElapsed<=2000&&Math.abs(elapsed-monoElapsed)<=1000&&response?.allowed===true&&localAllowed();
    }catch{return false;}
  }
  async function report(a) {
    const evidence=deliveryEvidence(a.result?.deliveryEvidence);
    await request({type:'DELIVERY_RESULT',attemptId:a.attemptId,outcome:a.result?.outcome || 'unknown',messageId:a.result?.messageId,confirmationMs:a.result?.confirmationMs,executionBlocked:a.result?.executionBlocked===true,reasonCode:safeReason(a.result?.reasonCode) || 'executor_result',...(evidence?{deliveryEvidence:evidence}:{})});
    a.reported=true;await save();
    const samples=pendingCooldownSamples.get(a.attemptId)||[];pendingCooldownSamples.delete(a.attemptId);
    if(a.phase==='confirmed')for(const sample of samples)await cooldownSample({deliveryId:a.attemptId,sample},a.tabId);
  }
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
      if(item.status==='confirmed'&&!/^\d{17,20}$/.test(item.messageId||''))continue;
      local.phase=item.status;local.reported=true;
      local.result={outcome:item.status==='confirmed'?'confirmed':'not_sent',...(item.messageId?{messageId:item.messageId}:{}),executionBlocked:true};changed=true;
    }
    if(changed)await save();
  }
  async function preEnterWait(message,tabId){
    await load();const a=state.attempts[message?.id];
    const allowed=()=>Boolean(!maintenance&&transport.connected&&!state.emergencyStopped&&a&&a.tabId===tabId&&a.phase==='executing'&&a.permitId&&a.enterRequested===true&&a.sessionId===state.sessionId&&!volatileStops.has(a.groupId)&&!state.stoppedGroups[a.groupId]&&!state.stoppedRuns[a.runId]&&!volatileStoppedRuns.has(a.runId)&&state.bindings[a.bindingId]?.configVersion===a.configVersion);
    if(message?.phase!=='commit'||message.enterAttempted!==false||(a.sendRetryCount??0)!==0||!Number.isSafeInteger(message.cooldownMs)||message.cooldownMs<0||message.cooldownMs>21600000||!Number.isSafeInteger(message.elapsedMs)||message.elapsedMs<0||message.elapsedMs>21630000||!allowed())return false;
    const began=now(),monoBegan=monotonicNow();
    try{
      const response=await request({type:'DELIVERY_WAIT',attemptId:a.attemptId,runId:a.runId,configVersion:a.configVersion,cooldownMs:message.cooldownMs,elapsedMs:message.elapsedMs});
      const elapsed=now()-began,monoElapsed=monotonicNow()-monoBegan;
      return response?.allowed===true&&elapsed>=0&&elapsed<=2000&&monoElapsed>=0&&monoElapsed<=2000&&Math.abs(elapsed-monoElapsed)<=1000&&allowed();
    }catch{return false;}
  }
  async function retryWait(message,tabId){
    await load();const a=state.attempts[message?.id];
    const allowed=()=>Boolean(!maintenance&&transport.connected&&!state.emergencyStopped&&a&&a.tabId===tabId&&a.phase==='executing'&&a.permitId&&a.enterRequested===true&&a.sessionId===state.sessionId&&!volatileStops.has(a.groupId)&&!state.stoppedGroups[a.groupId]&&!state.stoppedRuns[a.runId]&&!volatileStoppedRuns.has(a.runId)&&state.bindings[a.bindingId]?.configVersion===a.configVersion);
    if(message?.phase!=='commit'||!Number.isInteger(message.retryCount)||message.retryCount<1||message.retryCount>(a?.maxSendRetries??5)||!Number.isSafeInteger(message.cooldownMs)||message.cooldownMs<0||message.cooldownMs>21600000||!Number.isSafeInteger(message.elapsedMs)||message.elapsedMs<0||message.elapsedMs>23400000||message.retryCount<(a?.sendRetryCount??0)||message.retryCount>(a?.sendRetryCount??0)+1||!allowed())return false;
    const started=now(),monoStarted=monotonicNow();
    try{
      const response=await request({type:'DELIVERY_WAIT',attemptId:a.attemptId,runId:a.runId,configVersion:a.configVersion,retryPhase:true,retryCount:message.retryCount,cooldownMs:message.cooldownMs,elapsedMs:message.elapsedMs});
      const elapsed=now()-started,monoElapsed=monotonicNow()-monoStarted;
      if(response?.allowed!==true||elapsed<0||elapsed>2000||monoElapsed<0||monoElapsed>2000||Math.abs(elapsed-monoElapsed)>1000||!allowed())return false;
      a.sendRetryCount=message.retryCount;await save();return allowed();
    }catch{return false;}
  }
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
  async function awaitPrepared(a) {
    const started=now(),monoStarted=monotonicNow();
    const stopped=()=>!transport.connected||state.emergencyStopped||a.sessionId!==state.sessionId||state.stoppedRuns[a.runId]||volatileStoppedRuns.has(a.runId)||state.stoppedGroups[a.groupId]||volatileStops.has(a.groupId);
    for(;;){
      if(stopped())return;
      const elapsed=now()-started,monoElapsed=monotonicNow()-monoStarted;
      if(elapsed<0||monoElapsed<0||elapsed>21630000||monoElapsed>21630000||Math.abs(elapsed-monoElapsed)>2000)throw Object.assign(Error('입력 준비 대기가 만료되었습니다. 남은 초안과 채널 상태를 확인하세요.'),{code:'PREPARE_WAIT_TIMEOUT'});
      if(state.bindings[a.bindingId]?.configVersion!==a.configVersion||!await tabMatches(a))throw Object.assign(Error('대기 중 채널 또는 구성이 변경되었습니다.'),{code:'CONFIG_MISMATCH'});
      let seen;try{seen=await chrome.tabs.sendMessage(a.tabId,{type:'DICO_INSPECT',target:target(a)});}catch{throw Object.assign(Error('대기 중 Discord 탭의 연결을 확인하지 못했습니다.'),{code:'CONTENT_UNAVAILABLE'});}
      if(stopped())return;
      if(seen?.ok!==true)throw Object.assign(Error('대기 중 계정과 채널 상태를 확인하지 못했습니다.'),{code:deliveryCodes.has(seen?.code)?seen.code:'PREPARE_REJECTED'});
      if(seen.draftMatches!==true)throw Object.assign(Error('준비한 초안이 변경되었습니다. 남은 초안을 확인하세요.'),{code:'DRAFT_MISMATCH'});
      if(seen.cooldownKnown!==true||!Number.isSafeInteger(seen.cooldownMs)||seen.cooldownMs<0||seen.cooldownMs>21600000)throw Object.assign(Error('Discord의 남은 대기 시간을 확인하지 못했습니다.'),{code:'COOLDOWN_UNVERIFIED'});
      const response=await request({type:'PREPARED',attemptId:a.attemptId,configVersion:a.configVersion,accountId:a.accountId,channelId:a.channelId,draftClear:true,cooldownMs:seen.cooldownMs});
      if(response?.permitIssued!==false||!Number.isFinite(response.retryAfterMs)||response.retryAfterMs<=0)return;
      await wait(Math.min(1000,Math.max(500,response.retryAfterMs)));
    }
  }
  async function perform(c) {
    const p=c.payload || {};
    if(c.sessionId!==state.sessionId || c.instanceId!==state.instanceId)return;
    if(state.processed[c.id]){
      const previous=state.processed[c.id];
      if(previous?.status==='rejected')await ack(c,'rejected',{rejectionCode:previous.rejectionCode});
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
    } else if(c.type==='OPEN_CHANNEL') {
      if(state.emergencyStopped)throw Object.assign(Error('긴급 중지를 해제하고 다시 연결하세요.'),{code:'EXECUTION_STOPPED'});
      if(typeof openChannel!=='function')throw Object.assign(Error('채널 연결 기능을 지원하는 확장으로 업데이트하세요.'),{code:'OPEN_CHANNEL_UNSUPPORTED'});
      await openChannel({...p,commandId:c.id});await ack(c,'applied');
    } else if(c.type==='CONFIG_SYNC') {
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
        a={...structuredClone(p),sessionId:state.sessionId,phase:'preparing',startedAt:now(),enterRequested:false};state.attempts[p.attemptId]=a;await save();
      } else if(!matches(a,p) || a.sessionId!==state.sessionId || !['preparing','prepared'].includes(a.phase))throw Error('기존 발송 시도를 다시 준비할 수 없습니다.');
      if(a.phase!=='prepared') {
        let inspection;
        try{inspection=await chrome.tabs.sendMessage(a.tabId,{type:'DICO_DRAFT_INSPECT',target:target(a),delivery:delivery(a)});}catch{throw Object.assign(Error('기존 입력 내용을 확인하지 못했습니다. 초안을 보존합니다.'),{code:'DRAFT_INSPECTION_UNAVAILABLE'});}
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
      if(!a || !matches(a,p) || a.runId!==p.runId || state.stoppedRuns[p.runId] || volatileStoppedRuns.has(p.runId) || state.emergencyStopped || a.sessionId!==state.sessionId || !p.permitId)throw Error('발송 허가가 준비한 문구와 일치하지 않거나 중지된 실행입니다.');
      if(a.enterRequested) {if(!a.reported)await report(a);await ack(c,'applied');}
      else {
        if(a.phase!=='prepared' || state.stoppedGroups[a.groupId] || volatileStops.has(a.groupId) || !transport.connected || !await tabMatches(a))throw Error('현재 발송을 실행할 수 없습니다.');
        a.permitId=p.permitId;a.phase='executing';a.enterRequested=true;await save();
        let result;
        try{result=await chrome.tabs.sendMessage(a.tabId,{type:'DICO_DELIVER',target:target(a),delivery:delivery(a)});}catch{}
        if(result?.status==='confirmed' && /^\d{17,20}$/.test(result.messageId || '')) {
          a.phase='confirmed';a.result={outcome:'confirmed',messageId:result.messageId,confirmationMs:result.timing?.confirmationMs,...diagnostic(result)};
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
      await ack(c,'applied',{executionBlocked:true,...(p.attemptId?{attemptId:p.attemptId}:{})});
      if(a && !a.enterRequested){a.phase='cancelled';await save();}
    } else if(c.type==='RECONCILE') {
      const prior=state.attempts[p.attemptId];
      if(prior?.result?.outcome==='confirmed'){await report(prior);await ack(c,'applied');}
      else {
        const a=prior || {...p,startedAt:now(),phase:'unknown'};
        let result;try{result=await chrome.tabs.sendMessage(a.tabId,{type:'DICO_RECONCILE',target:target(a),delivery:delivery(a)});}catch{}
        if(result?.status==='confirmed' && /^\d{17,20}$/.test(result.messageId || '')){a.phase='confirmed';a.result={outcome:'confirmed',messageId:result.messageId};state.attempts[p.attemptId]=a;await save();await report(a);}
        else if(prior?.result?.outcome==='unknown')await report(prior);
        else await request({type:'DELIVERY_RESULT',attemptId:p.attemptId,outcome:'unknown',reasonCode:'reconcile_inconclusive'});
        await ack(c,'applied');
      }
    } else throw Error('지원하지 않는 중앙 명령입니다.');
    state.processed[c.id]=true;state.lastError=null;await save();
  }
  function handleCommand(c) {
    // Native push and heartbeat can deliver the same command while its content
    // response is pending. Coalesce before enqueueing, including during load.
    const commandKey=`${c?.sessionId}:${c?.id}`;
    if(commandJobs.has(commandKey))return commandJobs.get(commandKey);
    if(c?.type==='CONTROL'){volatileStops.add(c.payload?.groupId);if(c.payload?.runId)volatileStoppedRuns.add(c.payload.runId);}
    const job=(async()=>{
      inFlight++;try {await load();const key=c.payload?.bindingId || (c.payload?.attemptId && state.attempts[c.payload.attemptId]?.bindingId) || c.payload?.groupId || 'config';
      const lane=(lanes.get(key) || Promise.resolve()).then(()=>perform(c)).catch(async error=>{
        state.lastError=String(error.message || error).slice(0,250);
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
  return {get isIdle(){return isIdle();},beginMaintenance(){if(maintenance||!isIdle())return false;maintenance=true;return true;},endMaintenance(){maintenance=false;},load,save,request,handleCommand,canSend,inputAllowed,preEnterWait,retryWait,cooldownSample,async setSession(s){
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
