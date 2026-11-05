/**
 * 중앙 관리의 업무 규칙과 상태 전이를 담당합니다. DOM이나 브라우저 입력은 직접 다루지 않습니다.
 * UI 명령은 execute, 확장 응답은 bridge, 주기적인 예약 판단은 tick으로 들어옵니다.
 * instance=연결된 확장, account=계정, target=목적지, channel/binding=계정과 채널의 실행 연결,
 * group=발송 순서, attempt=한 번의 발송 시도, command=확장에 전달할 명령입니다.
 */
import {DEFAULT_PREPARE_RETRIES,normalizeSendRetries} from '../extension/retry-policy.js';
import {supportRecordBuffer} from './support-budget.js';
import {traceData,validTraceStage} from '../extension/delivery-trace.js';
import {composerClearedEvidence} from '../extension/delivery-receipt.js';
import { randomUUID, createHash } from 'node:crypto';
import { CentralStore } from './store.js';
import { CentralError, requireValue as ensure, text, body, duration, tags, expected } from './validation.js';
export { CentralError } from './validation.js';

const ACTIVE = new Set(['preparing','permitted','unknown']);
// 입력 차단 후 연결에서 분리한 미확인 기록은 이력으로만 남기며 재실행하지 않습니다.
const activeAttempt=a=>ACTIVE.has(a.status)&&!(a.detached===true&&a.status==='unknown'&&a.executionBlocked===true);
const MAX_PRE_ENTER_WAIT_MS=21_630_000;
// 입력 준비나 명시적으로 Enter 전임이 입증된 응답에서만 사용하는 복구 사유입니다.
// 발송 결과가 불명확한 시도에 이 목록을 적용해 새 Enter를 만들지 않습니다.
const transientPreparationCodes=new Set(['DISCORD_SEND_FAILED','COMPOSER_EDITOR_MISSING','COMPOSER_EDITOR_CHANGED','COMPOSER_DRAFT_CHANGED','COMPOSER_STATE_UNREADABLE','MANAGED_DELAY_UNAVAILABLE','PREPARE_TIMEOUT','CONTENT_INSPECTION_TIMEOUT','PREPARE_BUSY','PREPARE_EDITOR_UNSTABLE','EDITOR_LOADING','HISTORY_LOADING','CONTENT_UNAVAILABLE','ACCOUNT_UNVERIFIED','ACCOUNT_UNREADABLE','DRAFT_INSPECTION_UNAVAILABLE','COOLDOWN_UNVERIFIED','AUTHORIZATION_EXPIRED','AUTHORIZATION_UNAVAILABLE','NATIVE_REQUEST_TIMEOUT','NATIVE_DISCONNECTED','NATIVE_SEND_FAILED','SERVICE_UNAVAILABLE','CONTENT_EXCEPTION_BEFORE_ENTER']);
const TERMINAL = new Set(['confirmed','not_sent','cancelled']);
const id = () => randomUUID();
const verificationReasons=new Set(['awaiting_observation','connection_lost','session_changed','tab_missing','tab_loading','script_unavailable','account_mismatch','target_mismatch','identity_unverified','content_refresh_required','unknown']);
const verificationReason=value=>verificationReasons.has(value)?value:'identity_unverified';
const clone = value => structuredClone(value);
function deliveryEvidence(value){
  if(!value||typeof value!=='object'||!['prepare','commit','send'].includes(value.phase)||!['inspect','authorize','prepare','stable','enter','observe'].includes(value.stage)||typeof value.enterAttempted!=='boolean')return undefined;
  const result={phase:value.phase,stage:value.stage,enterAttempted:value.enterAttempted};
  for(const key of ['composerRetained','newMessage','matchingMessage','sendingSeen','failedSeen','authorMismatch','authorUnknown','timeMismatch','enterDefaultPrevented','keyupDefaultPrevented','documentHidden','documentFocused','composerCleared','expectedDraftSubmitted','sameEditor','sameComposer','editorReacquired','targetMatched','accountMatched','scopeChanged','accountProofPending','accountVerifiedAtSubmission','composerEmpty','editorPresent','sendingActive','ownMessageSeen'])if(typeof value[key]==='boolean')result[key]=value[key];
  if(Number.isSafeInteger(value.emptyStableMs)&&value.emptyStableMs>=0&&value.emptyStableMs<=30000)result.emptyStableMs=value.emptyStableMs;
  if(['keyboard','button'].includes(value.submitMethod))result.submitMethod=value.submitMethod;
  for(const key of ['retryCount','maxSendRetries'])if(Number.isSafeInteger(value[key])&&value[key]>=0)result[key]=value[key];
  if(value.maxSendRetries===null)result.maxSendRetries=null;
  return result;
}
const minimumInterval = c => (c.slowmodeMs||0)+3000;
const cooldownCorrection = c => Number.isSafeInteger(c.cooldownCorrectionMs)&&c.cooldownCorrectionMs>=0?c.cooldownCorrectionMs:0;
const correctedBaseInterval = c => minimumInterval(c)+cooldownCorrection(c);
// 직접 설정 주기와 감지·보정한 최소 주기는 같은 계정의 대기 조건입니다.
// 이미 직접 주기에 포함된 여유를 보정값으로 다시 더하지 않습니다.
const effectiveInterval = c => Math.max(correctedBaseInterval(c),c.intervalMode==='custom'?(c.customIntervalMs??c.intervalMs):0);
const customExtraInterval = c => c.intervalMode==='custom'?Math.max(0,effectiveInterval(c)-correctedBaseInterval(c)):0;
const confirmationOffset = c => Number.isFinite(c.lastConfirmationMs)&&c.lastConfirmationMs>=0&&c.lastConfirmationMs<=30000?c.lastConfirmationMs:0;
const initial = at => ({schemaVersion:1,stateVersion:0,lastEventId:0,resetEpoch:0,service:{status:'ready',startedAt:at},settings:{notificationsEnabled:false,notificationTypes:['delivery_unknown','connection_lost','account_mismatch','command_rejected','storage_failure'],retentionDays:90,hideNotificationNames:true,onboardingStep:0,cooldownMs:300000,notifyRecovery:false,quietHours:{enabled:false,start:'22:00',end:'08:00'}},messages:[],instances:[],accounts:[],targets:[],channels:[],groups:[],attempts:[],commands:[],incidents:[],locks:[],intervals:[]});

export function createCentralManager({databasePath=':memory:',now=Date.now,monotonicNow=()=>performance.now(),readOnly=false}={}) {
  const store = new CentralStore(databasePath,{readOnly}), listeners=new Set();
  let state=store.read(), closed=false, storageFailure=null, lastWall=now(), lastMono=monotonicNow();
  const loaded=!!state;state??=initial(now());state.resetEpoch??=store.events({type:'settings.reset',limit:1}).length?1:0;state.intervals??=[];state.accounts??=[];state.targets??=[];state.removals??={targets:[],accounts:[],bindings:[],instances:[],closeRequests:[]};
  // 보고서에서는 저장된 버전·적용 상태·간격을 그대로 읽습니다. 설정 이행은
  // 실제 작성 코어가 시작할 때만 수행하여 관측하지 않은 새 설정을 만들지 않습니다.
  if(!readOnly)for(const c of state.channels)initializeChannelInterval(c);
  const get=(list,key)=>{const item=state[list].find(x=>x.id===key);ensure(item,'NOT_FOUND',`${list} item not found.`,404);return item;};
  const event=(type,details={},level='info')=>{pending.push({type,level,at:now(),stateVersion:state.stateVersion,...details});};
  let pending=[];
  /**
   * 상태 복사본에서 변경한 뒤 상태와 이벤트를 저장합니다. 처리 실패 시 이전 상태로 돌아갑니다.
   * 저장에 실패하면 새 실행을 차단합니다. 메모리에서만 성공한 발송을 진행하면 재시작 후 중복될 수 있습니다.
   * 구독자 알림은 저장 성공 후에 보내며, 구독자의 오류로 이미 저장한 작업을 취소하지 않습니다.
   */
  function transact(fn){
    ensure(!readOnly,'READ_ONLY','Read-only inspection cannot execute commands.',403);
    ensure(!closed,'CLOSED','Central manager is closed.',503);ensure(!storageFailure,'STORAGE_FAILURE','Storage failed. New commands are blocked.',503);
    const before=state;state=clone(state);state.stateVersion++;pending=[];
    let result;
    try {result=fn();syncConnectionCatalog();recordIntervals();}catch(error){state=before;pending=[];throw error;}
    let committed;
    try{committed=store.commit(state,pending);}catch(error){state=before;storageFailure=error;throw new CentralError('STORAGE_FAILURE','Could not durably save the operation; execution is blocked.',503);}
    pending=[];for(const e of committed)for(const listener of listeners){try{listener(clone(e));}catch{ /* observers cannot undo a committed operation */ }}
    return result===undefined?undefined:clone(result);
  }
  function initializeChannelInterval(c){
    const floor=minimumInterval(c),previous=c.intervalMs;
    if(!['auto','custom'].includes(c.intervalMode)){
      c.intervalMode=previous<=floor?'auto':'custom';
      if(c.intervalMode==='custom')c.customIntervalMs=previous;else delete c.customIntervalMs;
      c.version++;
    }
    if(c.intervalMode==='custom')c.customIntervalMs??=previous;
    c.intervalMs=c.intervalMode==='auto'?floor:Math.max(c.customIntervalMs,floor);
    if(c.intervalMs!==previous){c.configVersion++;c.appliedVersion=0;}
  }
  // Catalog entities describe identity and destination independently of execution tabs.
  function accountMetadataText(value){
    if(typeof value!=='string')return undefined;
    const trimmed=value.trim();return trimmed&&trimmed.length<=100&&!/[\u0000-\u001f\u007f]/.test(trimmed)?trimmed:undefined;
  }
  function accountNameCustomized(a){return typeof a.nameCustomized==='boolean'?a.nameCustomized:Boolean(a.name&&a.name!==a.accountId);}
  function upsertAccount(instanceId,accountId,{verified=false,sessionId,observedAt=now(),accountName,username}={}){
    let account=state.accounts.find(a=>a.instanceId===instanceId&&a.accountId===accountId);
    const created=!account;
    if(!account){account={id:id(),instanceId,accountId,name:accountId,nameCustomized:false,version:1,verified:false,createdAt:now(),updatedAt:now()};state.accounts.push(account);event('account.created',{accountEntityId:account.id,instanceId});}
    account.nameCustomized=accountNameCustomized(account);
    if(verified){
      let changed=false;
      for(const [key,value] of [['observedName',accountMetadataText(accountName)],['username',accountMetadataText(username)]])if(value!==undefined&&account[key]!==value){account[key]=value;changed=true;}
      const automaticName=account.observedName||account.username||accountId;
      if(!account.nameCustomized&&account.name!==automaticName){account.name=automaticName;changed=true;}
      if(changed&&!created)account.version++;
      account.verified=true;account.sessionId=sessionId;account.lastVerifiedAt=Math.max(account.lastVerifiedAt||0,observedAt);account.updatedAt=Math.max(account.updatedAt||0,observedAt);
    }
    return account;
  }
  const pendingChannelName='채널 이름 확인 대기';
  function channelObservedName(value,channelId){
    const name=accountMetadataText(value)?.replace(/^#\s*/,'').trim();
    return name&&name!==channelId&&name!==pendingChannelName&&!/^(?:\(\d+\)\s*)?Discord(?:\s*[|｜]|$)/i.test(name)&&!/[|｜].*Discord\s*$/i.test(name)&&!/\s[-–—]\sDiscord\s*$/i.test(name)?name:undefined;
  }
  function channelNameCustomized(entity){return typeof entity.nameCustomized==='boolean'?entity.nameCustomized:Boolean(channelObservedName(entity.name,entity.channelId));}
  function applyChannelName(entity,{name,observedName}={},created=false){
    const before=JSON.stringify([entity.name,entity.observedName]);
    entity.nameCustomized=channelNameCustomized(entity);
    const observed=channelObservedName(observedName,entity.channelId);
    if(observed)entity.observedName=observed;
    if(name!==undefined){entity.name=name;entity.nameCustomized=true;}
    if(!entity.nameCustomized)entity.name=channelObservedName(entity.observedName,entity.channelId)||pendingChannelName;
    entity.namePending=!entity.nameCustomized&&!channelObservedName(entity.observedName,entity.channelId);
    if(before!==JSON.stringify([entity.name,entity.observedName])&&!created){entity.version=(entity.version||1)+1;entity.updatedAt=now();}
  }
  function upsertTarget(guildId,channelId,metadata={}){
    let target=state.targets.find(t=>t.guildId===guildId&&t.channelId===channelId);
    const created=!target;
    if(!target){target={id:id(),guildId,channelId,url:`https://discord.com/channels/${guildId}/${channelId}`,name:pendingChannelName,nameCustomized:false,namePending:true,version:1,createdAt:now(),updatedAt:now()};state.targets.push(target);event('target.created',{targetId:target.id});}
    applyChannelName(target,metadata,created);
    return target;
  }
  function syncConnectionCatalog(){
    for(const target of state.targets)applyChannelName(target);
    for(const c of state.channels){
      initializeChannelInterval(c);
      applyChannelName(c);
      upsertAccount(c.instanceId,c.accountId,{verified:c.verified===true,sessionId:c.sessionId,observedAt:c.observedAt});
      if(!state.targets.some(t=>t.guildId===c.guildId&&t.channelId===c.channelId))upsertTarget(c.guildId,c.channelId,{observedName:c.verified?c.observedName:undefined});
    }
  }
  const removalKey=(...parts)=>JSON.stringify(parts);
  const targetKey=c=>removalKey(c.guildId,c.channelId);
  const accountKey=c=>removalKey(c.instanceId,c.accountId);
  const bindingKey=c=>removalKey(c.instanceId,c.accountId,c.guildId,c.channelId);
  function rememberRemoval(kind,key){if(!state.removals[kind].includes(key))state.removals[kind].push(key);}
  function removedScope(c){return state.removals.instances.includes(c.instanceId)||state.removals.targets.includes(targetKey(c))||state.removals.accounts.includes(accountKey(c))||state.removals.bindings.includes(bindingKey(c));}
  function queuePendingCloses(instanceId){
    const instance=state.instances.find(i=>i.id===instanceId);if(!instance?.connected)return;
    for(const request of state.removals.closeRequests.filter(r=>r.instanceId===instanceId)){
      const prior=state.commands.findLast(c=>c.type==='CLOSE_CHANNEL'&&c.instanceId===instanceId&&c.sessionId===instance.sessionId&&c.payload.removalId===request.removalId);
      const elapsed=prior?now()-(prior.rejectedAt||prior.createdAt):Infinity;
      const delay=Math.min(60000,30000*2**Math.min(1,request.retries||0));
      // 삭제 이력은 이미 확정돼 있습니다. 탭 정리의 일시 실패는 재연결이나
      // 사용자 재삭제를 기다리지 않고 계속 복구하되 30~60초 간격을 지킵니다.
      if(prior&&(['queued','received','applied'].includes(prior.status)||elapsed>=0&&elapsed<delay))continue;
      if(!prior)request.retries=0;else if(prior.status==='rejected')request.retries=(request.retries||0)+1;
      const {instanceId:owner,...payload}=request;command('CLOSE_CHANNEL',owner,payload);
    }
  }
  function removeConfiguration(kind,entity){
    const matches=c=>kind==='instance'?c.instanceId===entity.id:kind==='account'?c.instanceId===entity.instanceId&&c.accountId===entity.accountId:kind==='target'?c.guildId===entity.guildId&&c.channelId===entity.channelId:c.id===entity.id||c.bindingId===entity.id;
    const channels=state.channels.filter(matches),ids=new Set(channels.map(c=>c.id));
    const groups=state.groups.filter(g=>g.members.some(member=>ids.has(member)));
    const detachable=a=>a?.status==='unknown'&&a.executionBlocked===true;
    const blocked=groups.filter(g=>!['stopped','paused'].includes(g.status)||g.controlIntent||g.activeAttemptId&&!detachable(state.attempts.find(a=>a.id===g.activeAttemptId&&ids.has(a.bindingId))));
    const active=state.attempts.filter(a=>activeAttempt(a)&&(ids.has(a.bindingId)||matches(a)));
    ensure(!blocked.length&&!active.some(a=>!detachable(a)),'REMOVAL_BLOCKED',`삭제 전에 ${[...new Set([...blocked.map(g=>g.name),...active.map(a=>state.groups.find(g=>g.id===a.groupId)?.name||'미확인 발송')])].join(', ')} 그룹을 중지하고 진행 중·미확인 발송 결과를 확인하세요.`,409);
    for(const a of state.attempts.filter(a=>ids.has(a.bindingId)||matches(a))){
      const channel=state.channels.find(c=>c.id===a.bindingId),account=state.accounts.find(c=>c.instanceId===a.instanceId&&c.accountId===a.accountId);
      a.accountName??=account?.name||a.accountId;a.channelName??=channel?.name||state.targets.find(t=>t.guildId===a.guildId&&t.channelId===a.channelId)?.name;
      a.groupName??=state.groups.find(g=>g.id===a.groupId)?.name;a.instanceName??=state.instances.find(i=>i.id===a.instanceId)?.name;
    }
    // 이전 게시 여부는 unknown으로 보존하되 새 발송·재조회·그룹 잠금에서 분리합니다.
    for(const a of active){a.detached=true;a.detachedAt=now();const g=state.groups.find(g=>g.id===a.groupId);if(g?.activeAttemptId===a.id){g.activeAttemptId=null;g.waitReason=null;delete g.autoResume;}}
    const closing=[...channels];
    for(const c of state.commands.filter(c=>c.type==='OPEN_CHANNEL'&&['queued','received','applied'].includes(c.status))){const scope={...c.payload,instanceId:c.instanceId};if(matches(scope)&&!closing.some(x=>bindingKey(x)===bindingKey(scope)))closing.push(scope);}
    for(const c of closing){rememberRemoval('bindings',bindingKey(c));if(!state.removals.closeRequests.some(r=>bindingKey(r)===bindingKey(c)))state.removals.closeRequests.push({removalId:id(),instanceId:c.instanceId,accountId:c.accountId,guildId:c.guildId,channelId:c.channelId,...(c.id?{bindingId:c.id}:{}),...(Number.isInteger(c.tabId)?{tabId:c.tabId}:{}),accountName:state.accounts.find(a=>accountKey(a)===accountKey(c))?.name||c.accountId,channelName:c.name||entity.name,createdAt:now()});}
    for(const g of groups){const previous=g.members,remaining=previous.filter(member=>!ids.has(member));const next=previous.map((_,offset)=>previous[(g.cursor+offset)%previous.length]).find(member=>remaining.includes(member));release(g);g.members=remaining;g.cursor=Math.max(0,remaining.indexOf(next));g.version++;if(!remaining.length)state.groups=state.groups.filter(x=>x.id!==g.id);}
    for(const c of state.commands)if(c.type!=='CLOSE_CHANNEL'&&(ids.has(c.payload.bindingId)||matches({...c.payload,instanceId:c.instanceId})||groups.some(g=>g.id===c.payload.groupId)))c.status='superseded';
    state.channels=state.channels.filter(c=>!ids.has(c.id));
    if(kind==='target'){rememberRemoval('targets',targetKey(entity));state.targets=state.targets.filter(x=>x.id!==entity.id);}
    if(kind==='account'||kind==='instance'){for(const a of state.accounts.filter(a=>kind==='instance'?a.instanceId===entity.id:a.id===entity.id))rememberRemoval('accounts',accountKey(a));state.accounts=state.accounts.filter(a=>kind==='instance'?a.instanceId!==entity.id:a.id!==entity.id);}
    if(kind==='instance'){rememberRemoval('instances',entity.id);state.instances=state.instances.filter(i=>i.id!==entity.id);}
    for(const instanceId of new Set(closing.map(c=>c.instanceId)))queuePendingCloses(instanceId);
    event(`${kind}.deleted`,{entityId:entity.id,removedBindings:channels.length,pendingTabCloses:closing.length});return{id:entity.id,deleted:true,removedBindings:channels.length,pendingTabCloses:closing.length};
  }
  function invalidateAccounts(instanceId){for(const a of state.accounts.filter(a=>a.instanceId===instanceId))a.verified=false;}
  function currentAccount(account){const instance=state.instances.find(i=>i.id===account.instanceId);return !!(account.verified&&instance?.connected&&account.sessionId===instance.sessionId&&Number.isFinite(account.lastVerifiedAt)&&now()-account.lastVerifiedAt<=15000&&now()-instance.lastSeenAt<=15000);}
  function recordIntervals(){
    for(const [scope,entities] of [['group',state.groups],['instance',state.instances]]){
      for(const entity of entities){
        const reason=scope==='group'?(entity.waitReason||entity.status):(entity.connected?'connected':'disconnected');
        const current=state.intervals.findLast(span=>span.scope===scope&&span.targetId===entity.id&&span.to===null);
        if(current?.reason===reason)continue;
        if(current)current.to=Math.max(current.from,now());
        state.intervals.push({id:id(),scope,targetId:entity.id,reason,from:now(),to:null});
      }
      const existing=new Set(entities.map(e=>e.id));
      for(const span of state.intervals.filter(span=>span.scope===scope&&span.to===null&&!existing.has(span.targetId)))span.to=Math.max(span.from,now());
    }
  }
  function pruneRecords(){
    const cutoff=now()-state.settings.retentionDays*86400000;let removed=0;
    state.attempts=state.attempts.map(a=>{
      if(!TERMINAL.has(a.status)||a.pruned||a.finalizedAt>=cutoff)return a;
      removed++;return{id:a.id,status:a.status,instanceId:a.instanceId,createdAt:a.createdAt,finalizedAt:a.finalizedAt,manual:a.manual||false,permitIssued:!!a.permitId,...(a.confirmationBasis?{confirmationBasis:a.confirmationBasis}:{}),pruned:true};
    });
    state.commands=state.commands.filter(c=>c.createdAt>=cutoff||['queued','received'].includes(c.status)||state.attempts.some(a=>activeAttempt(a)&&a.id===c.payload.attemptId));
    state.incidents=state.incidents.filter(i=>i.status==='open'||(i.resolvedAt||i.lastSeenAt)>=cutoff);
    state.intervals=state.intervals.filter(span=>span.to===null||span.to>=cutoff);
    state.prunedBefore=Math.max(state.prunedBefore||0,cutoff);state.lastPrunedAt=now();event('records.pruned',{cutoff,removedAttempts:removed});return{removedAttempts:removed,cutoff};
  }
  function command(type,instanceId,payload){
    const instance=get('instances',instanceId);
    const c={id:id(),type,instanceId,sessionId:instance.sessionId,status:'queued',createdAt:now(),payload:clone(payload)};
    state.commands.push(c);event('command.queued',{commandId:c.id,instanceId,groupId:payload.groupId,attemptId:payload.attemptId});return c;
  }
  function incidentRecurrenceKey(problem){
    const c=state.commands.find(c=>c.id===problem.commandId),payload=c?.payload;
    const a=state.attempts.find(a=>a.id===(problem.attemptId||payload?.attemptId));
    // 명령/시도 ID는 재시도마다 달라집니다. 장애의 대상·작업·기록된 원인만
    // 비교하되 서로 다른 그룹, 채널, 창 작업을 같은 재발로 묶지 않습니다.
    // 본문/초안/오류 원문은 키에 넣지 않으며, 같은 원인이라는 추론도 하지 않습니다.
    return JSON.stringify([problem.code,problem.instanceId||c?.instanceId||a?.instanceId||null,
      problem.groupId||payload?.groupId||a?.groupId||null,problem.bindingId||payload?.bindingId||a?.bindingId||null,
      payload?.accountId||a?.accountId||null,payload?.guildId||a?.guildId||null,payload?.channelId||a?.channelId||null,
      problem.commandType||c?.type||null,payload?.action||null,problem.rejectionCode||problem.verificationReason||null]);
  }
  function incident(code,details={}){
    const key=[code,(code==='command_rejected'&&details.commandId)||(['channel_unverified','account_mismatch'].includes(code)&&details.bindingId)||details.attemptId||details.instanceId||details.groupId||'service'].join(':');
    let i=state.incidents.find(i=>i.key===key&&i.status==='open');
    if(i){
      i.count++;i.lastSeenAt=now();
      if(['channel_unverified','account_mismatch'].includes(code)&&details.verificationReason)i.verificationReason=verificationReason(details.verificationReason);
      if(code==='command_rejected')for(const key of ['commandId','commandType','rejectionCode','attemptId','groupId','instanceId']){if(details[key]!==undefined)i[key]=details[key];else delete i[key];}
      return i;
    }
    const recurrenceKey=incidentRecurrenceKey({code,...details});
    const previous=state.incidents.findLast(problem=>(problem.recurrenceKey||incidentRecurrenceKey(problem))===recurrenceKey);
    const recurrence={recurrenceKey,occurrenceNumber:(previous?.occurrenceNumber|| (previous?1:0))+1,firstOccurredAt:previous?.firstOccurredAt??previous?.createdAt??now(),...(previous?{previousIncidentId:previous.id}:{})};
    // 새 사건을 과거 사건과 연결할 뿐 읽음/해결 상태는 전파하지 않습니다.
    // 보존 기간 밖 기록은 삭제될 수 있으므로 이 횟수는 보존된 연결의 범위입니다.
    i={id:id(),key,code,status:'open',level:'error',createdAt:now(),lastSeenAt:now(),count:1,read:false,...details,...recurrence};state.incidents.push(i);event('incident.opened',{incidentId:i.id,reasonCode:code,...details,...recurrence},'error');return i;
  }
  function resolveIncident(i,details={}){i.status='resolved';i.resolvedAt=now();if(details.reasonCode)i.resolutionReason=details.reasonCode;event('incident.resolved',{incidentId:i.id,...details});}
  function resolveIncidents(attemptId){
    for(const i of state.incidents.filter(i=>i.status==='open')){
      const command=i.code==='command_rejected'?state.commands.find(c=>c.id===i.commandId):null;
      // A completed delivery does not prove that every browser applied a stop/pause.
      if(i.code==='command_rejected'&&(command?.type||i.commandType)==='CONTROL')continue;
      if(i.attemptId===attemptId||command?.payload.attemptId===attemptId)resolveIncident(i,{attemptId});
    }
  }
  function resolveControlIncidents(groupId){
    for(const i of state.incidents.filter(i=>i.status==='open'&&i.code==='command_rejected')){
      const command=state.commands.find(c=>c.id===i.commandId);
      if((command?.type||i.commandType)==='CONTROL'&&(command?.payload.groupId||i.groupId)===groupId)resolveIncident(i,{groupId,reasonCode:'control_applied'});
    }
  }
  function identityRecovered(problem){
    const instance=state.instances.find(i=>i.id===problem.instanceId);
    if(!instance?.connected||now()-instance.lastSeenAt>15000||now()<instance.lastSeenAt)return false;
    const group=state.groups.find(g=>g.id===problem.groupId);
    if(state.attempts.some(a=>activeAttempt(a)&&(a.instanceId===instance.id)&&(!group||a.groupId===group.id)))return false;
    const channels=state.channels.filter(c=>c.instanceId===instance.id&&(!problem.bindingId||c.id===problem.bindingId)&&(!group||group.members.includes(c.id)));
    const after=problem.lastSeenAt??problem.createdAt;
    return channels.length>0&&channels.every(c=>c.verified&&c.sessionId===instance.sessionId&&Number.isFinite(c.observedAt)&&c.observedAt>=after&&c.observedAt<=now()&&now()-c.observedAt<=15000);
  }
  function recheckIncidents(incidentId,{automatic=false}={}){
    const selected=incidentId===undefined?state.incidents:[get('incidents',incidentId)];
    let resolved=0;const blocked=[];
    for(const i of selected.filter(i=>i.status==='open')){
      const c=state.commands.find(c=>c.id===i.commandId),type=c?.type||i.commandType;
      const attemptId=c?.payload?.attemptId||i.attemptId,a=state.attempts.find(a=>a.id===attemptId);
      const groupId=c?.payload?.groupId||i.groupId||a?.groupId,g=state.groups.find(g=>g.id===groupId);
      let reasonCode=null,block='EVIDENCE_REQUIRED',message='해결을 확인할 기록이 부족합니다. 해당 알림의 안내를 확인하세요.',page='logs';
      // 미발송 확정과 원인 복구는 다릅니다. 준비 재시도 소진으로 멈춘 경고는
      // 자동 검사에서 지우지 않고, 사용자의 명시적 재검사/후속 실행 근거를 기다립니다.
      if(automatic&&type==='PREPARE'&&a?.status==='not_sent'&&g?.waitReason==='preparation_failed'){
        block='PREPARATION_FAILED';message='입력 준비 실패 원인이 아직 해소되지 않았습니다.';page='channels';
      }else if(a&&activeAttempt(a)){
        block='ATTEMPT_UNRESOLVED';message='전송 결과가 아직 확정되지 않았습니다. 기록에서 결과를 확인하세요.';page='history';
      }else if((i.code==='delivery_unknown'||i.code==='command_rejected'&&['PREPARE','COMMIT_PERMIT','RECONCILE'].includes(type))&&a&&TERMINAL.has(a.status)){
        reasonCode='terminal_attempt';
      }else if(['channel_unverified','account_mismatch'].includes(i.code)){
        if(identityRecovered(i))reasonCode='connection_reverified';
        else{block='CONNECTION_UNVERIFIED';message='해당 전송용 탭의 현재 계정·채널 확인이 필요합니다. 전송 창 보기로 상태를 확인하세요.';page='channels';}
      }else if(i.code==='command_rejected'&&type==='CONFIG_SYNC'){
        // 과거 거절은 현재 동일 연결의 설정이 실제 적용됐을 때만 해결합니다.
        // 단순 연결 성공이나 다른 채널의 ACK는 설정 적용의 증거가 아닙니다.
        const channel=state.channels.find(channel=>channel.id===c?.payload.bindingId);
        const instance=state.instances.find(instance=>instance.id===c?.instanceId);
        const after=Math.max(i.lastSeenAt||i.createdAt,c?.rejectedAt||0);
        const applied=channel&&state.commands.some(next=>next.type==='CONFIG_SYNC'&&next.instanceId===c.instanceId&&next.sessionId===instance?.sessionId&&next.payload.bindingId===channel.id&&next.payload.configVersion===channel.configVersion&&next.status==='applied'&&next.appliedAt>=after&&next.appliedAt<=now());
        if(instance?.connected&&channel?.verified&&channel.sessionId===instance.sessionId&&now()-instance.lastSeenAt>=0&&now()-instance.lastSeenAt<=15000&&channel.appliedVersion===channel.configVersion&&applied)reasonCode='configuration_applied';
        else{block='CONFIGURATION_PENDING';message='현재 설정의 브라우저 적용 확인을 기다리고 있습니다.';page='channels';}
      }else if(i.code==='command_rejected'&&type==='OPEN_CHANNEL'){
        block='CONNECTION_UNVERIFIED';message='거절된 계정·채널의 현재 연결을 확인하지 못했습니다. 채널 관리에서 해당 브라우저의 계정을 다시 연결하고 연결됨 표시를 확인하세요.';page='channels';
        const payload=c?.payload,instance=state.instances.find(instance=>instance.id===c?.instanceId);
        const routed=c?.type==='OPEN_CHANNEL'&&[c.instanceId,payload?.accountId,payload?.guildId,payload?.channelId].every(value=>typeof value==='string'&&value.length>0)&&(!i.instanceId||i.instanceId===c.instanceId);
        const binding=routed?state.channels.find(channel=>channel.instanceId===c.instanceId&&channel.accountId===payload.accountId&&channel.guildId===payload.guildId&&channel.channelId===payload.channelId):null;
        if(attemptId&&(!a||!TERMINAL.has(a.status))){block='EVIDENCE_REQUIRED';message='관련 전송 결과를 확인할 기록이 부족합니다. 기록에서 결과를 먼저 확인하세요.';page='history';}
        else if(binding?.verified){
          const rejectedTimes=[i.lastSeenAt,i.createdAt,c.rejectedAt].filter(Number.isFinite),rejectedAt=rejectedTimes.length?Math.max(...rejectedTimes):NaN;
          const heartbeatAge=now()-instance?.lastSeenAt;
          const current=instance?.connected&&typeof instance.sessionId==='string'&&binding.sessionId===instance.sessionId&&Number.isFinite(heartbeatAge)&&heartbeatAge>=0&&heartbeatAge<=15000;
          // Identity registration alone cannot prove the dedicated execution tab.
          // Require a current-session observation at or after the latest rejection.
          if(current&&Number.isFinite(binding.observedAt)&&binding.observedAt>=rejectedAt&&binding.observedAt<=now())reasonCode='connection_reverified';
          else{block='CONNECTION_STALE';message='거절 이후 현재 브라우저 세션에서 연결을 확인한 기록이 필요합니다. 전송용 Discord 창을 열고 채널 관리에서 다시 연결한 뒤 재확인하세요.';}
        }
      }else if(i.code==='command_rejected'&&type==='CLOSE_CHANNEL'){
        if(c?.payload.removalId&&state.commands.some(done=>done.type==='CLOSE_CHANNEL'&&done.payload.removalId===c.payload.removalId&&done.status==='applied'))reasonCode='managed_tab_closed';
        else{block='CLOSE_PENDING';message='해당 브라우저의 남은 전송 탭을 확인하세요. 브라우저와 확장을 다시 연결하면 닫기를 재시도합니다. 다른 페이지로 이동한 탭은 직접 닫아 주세요.';page='connections';}
      }else if(i.code==='command_rejected'&&type==='MANAGE_WINDOW'){
        const payload=c?.payload,action=payload?.action;
        const label=({reveal:'전송 창 보기',hide:'전송 창 숨기기',consolidate:'전송 창 모으기',separate:'채널별 창 분리'})[action]||'전송 창 관리';
        block='WINDOW_ACTION_REQUIRED';message=`채널 설정에서 해당 계정·채널의 ‘${label}’를 다시 요청하고 적용을 확인한 뒤 재검사하세요. 전송 탭을 찾지 못하면 해당 채널을 다시 연결하세요.`;page='channels';
        const routed=c?.type==='MANAGE_WINDOW'&&['reveal','hide','consolidate','separate'].includes(action)&&[c.instanceId,payload?.bindingId,payload?.accountId,payload?.guildId,payload?.channelId].every(value=>typeof value==='string'&&value.length>0)&&(!i.instanceId||i.instanceId===c.instanceId);
        const rejectedTimes=[i.createdAt,i.lastSeenAt,c?.rejectedAt].filter(Number.isFinite),rejectedAt=rejectedTimes.length?Math.max(...rejectedTimes):NaN;
        // Channel verification and delivery success cannot prove a window action.
        // Require a later applied request for this exact browser, action and target.
        if(routed&&Number.isFinite(rejectedAt)&&state.commands.some(next=>next.id!==c.id&&next.type==='MANAGE_WINDOW'&&next.instanceId===c.instanceId&&next.status==='applied'&&next.createdAt>=rejectedAt&&Number.isFinite(next.appliedAt)&&next.appliedAt>=next.createdAt&&next.appliedAt<=now()&&['action','bindingId','accountId','guildId','channelId'].every(key=>next.payload?.[key]===payload[key])))reasonCode='window_action_applied';
      }else if(i.code==='command_rejected'&&type==='CONTROL'){
        const active=state.attempts.some(a=>a.groupId===groupId&&activeAttempt(a));
        if(active||g?.activeAttemptId){block='ATTEMPT_UNRESOLVED';message='그룹의 전송 결과 확인이 아직 필요합니다.';page='history';}
        else if(g?.controlIntent||g&&['stop_pending','pause_pending'].includes(g.status)){
          block='CONTROL_PENDING';message='브라우저의 중지·일시정지 적용 확인을 기다리고 있습니다.';page='groups';
        }else if(attemptId&&(!a||!TERMINAL.has(a.status))){/* Missing evidence must not imply not-sent. */}
        else if(groupId&&!g){
          // Group deletion/reset requires no active attempt or pending control. Still
          // reject inconsistent old records that contain an executable command.
          const pending=state.commands.some(cmd=>cmd.payload.groupId===groupId&&['queued','received'].includes(cmd.status));
          if(!pending)reasonCode='obsolete_group';
          else{block='CONTROL_PENDING';message='삭제된 그룹의 미완료 명령이 남아 있어 자동으로 정리할 수 없습니다.';page='groups';}
        }else if(g&&['stopped','paused'].includes(g.status)){
          const controls=state.commands.filter(cmd=>cmd.type==='CONTROL'&&cmd.payload.groupId===g.id&&cmd.payload.controlGeneration===g.controlGeneration&&cmd.status!=='superseded');
          const owners=new Set(g.members.map(member=>state.channels.find(channel=>channel.id===member)?.instanceId));
          if(controls.length&&controls.every(cmd=>cmd.status==='applied')&&[...owners].every(owner=>owner&&controls.some(cmd=>cmd.instanceId===owner)))reasonCode='control_applied';
          else{block='CONTROL_PENDING';message='모든 브라우저가 중지를 적용했다는 기록을 확인할 수 없습니다.';page='groups';}
        }
      }
      if(reasonCode){resolveIncident(i,{reasonCode,...(attemptId?{attemptId}:{}),...(groupId?{groupId}:{})});resolved++;}
      else blocked.push({id:i.id,reasonCode:block,message,page});
    }
    return{resolved,remaining:selected.filter(i=>i.status==='open').length,blocked};
  }
  function markUnknown(a,reasonCode){if(!activeAttempt(a))return;const repeated=a.status==='unknown'&&a.reasonCode===reasonCode;a.status='unknown';a.reasonCode=reasonCode;const g=get('groups',a.groupId);if(g.status==='running'&&!g.controlIntent)g.reconcileResumeRunId=g.runId;if(!g.controlIntent&&!['stopped','paused'].includes(g.status))g.status='needs_review';if(repeated)return;g.waitReason='delivery_unknown';incident('delivery_unknown',{attemptId:a.id,groupId:g.id,instanceId:a.instanceId});event('delivery.unknown',{attemptId:a.id,groupId:g.id,reasonCode},'error');}
  function release(g){state.locks=state.locks.filter(l=>l.groupId!==g.id);}
  function controlComplete(g){
    if(!g.controlIntent)return;
    const active=state.attempts.find(a=>a.id===g.activeAttemptId);
    const blockedUnknown=active?.status==='unknown'&&active.executionBlocked===true;
    if(g.activeAttemptId&&!blockedUnknown)return;
    const controls=state.commands.filter(c=>c.type==='CONTROL'&&c.payload.groupId===g.id&&c.payload.controlGeneration===g.controlGeneration&&c.status!=='superseded');
    const owners=new Set(g.members.map(member=>state.channels.find(c=>c.id===member)?.instanceId));
    if(controls.length&&controls.every(c=>c.status==='applied')&&[...owners].every(owner=>owner&&controls.some(c=>c.instanceId===owner))){
      g.status=g.controlIntent==='stop'?'stopped':'paused';g.controlIntent=null;g.waitReason=blockedUnknown?'delivery_unknown':null;
      // Applied stop and fenced execution settle future activity, not the past
      // delivery. Retain its attempt and resource locks until a final result.
      if(!blockedUnknown)release(g);
      resolveControlIncidents(g.id);event('group.control_applied',{groupId:g.id,status:g.status});
    }
  }
  /**
   * 중단/일시정지는 재적용해도 새 메시지를 보내지 않는 제어 명령입니다.
   * 명시적으로 거절된 중지 명령은 횟수 제한 없이 재발급하며, 수신 대기 중 명령은 중복 생성하지 않습니다.
   * 이전 거절은 superseded로 남겨 완료 판정을 막지 않게 하되 진단 이력은 유지합니다.
   * 발송 결과 unknown은 이 복구로 해결하지 않습니다. 실행 차단과 과거 발송 결과는 별개입니다.
   */
  // 구버전의 반복 관찰이 덮어쓴 사용자 중지는 현재 실행의 실제 ACK로 복구합니다.
  function preserveAppliedUserStops(){
    for(const g of state.groups.filter(g=>g.status==='needs_review'&&!g.controlIntent&&!g.autoResume)){
      const a=state.attempts.find(a=>a.id===g.activeAttemptId);
      if(a?.status!=='unknown'||a.executionBlocked!==true)continue;
      const controls=state.commands.filter(c=>c.type==='CONTROL'&&c.payload.groupId===g.id&&c.payload.runId===g.runId&&c.payload.controlGeneration===g.controlGeneration&&c.status!=='superseded');
      const owners=new Set(g.members.map(member=>state.channels.find(c=>c.id===member)?.instanceId));
      if(!controls.length||!controls.every(c=>c.status==='applied'&&c.payload.action==='stop')||![...owners].every(owner=>controls.some(c=>c.instanceId===owner)))continue;
      g.status='stopped';delete g.reconcileResumeRunId;event('group.stop_state_restored',{groupId:g.id});
    }
  }
  function recoverControl(g){
    if(!g.controlIntent||now()<(g.controlRecoveryAfter||0))return;
    const failed=state.commands.filter(c=>c.type==='CONTROL'&&c.payload.groupId===g.id&&c.payload.controlGeneration===g.controlGeneration&&c.status==='rejected');
    if(!failed.length)return;
    g.controlRecoveryCount=(g.controlRecoveryCount||0)+1;g.controlRecoveryAfter=now()+3000;
    for(const previous of failed){
      previous.status='superseded';previous.supersededAt=now();
      command('CONTROL',previous.instanceId,controlPayload(g,previous.instanceId));
    }
    event('group.control_retried',{groupId:g.id,retryCount:g.controlRecoveryCount});
  }
  function controlPayload(g,instanceId){
    const attempt=state.attempts.find(a=>a.id===g.activeAttemptId);
    return{action:g.controlIntent,groupId:g.id,runId:g.runId||null,controlGeneration:g.controlGeneration,attemptId:attempt?.instanceId===instanceId?attempt.id:null};
  }
  function control(g,intent,{systemReason}={}){
    // 사용자 명령은 이미 예약된 시스템 복구보다 항상 우선합니다. 보호 중단에서만
    // 재개 의도를 저장하고, 사용자 pause/stop은 대기 중·적용 완료 여부와 관계없이 취소합니다.
    if(systemReason){
      g.autoResume={reasonCode:systemReason,requestedAt:now(),requestedMono:monotonicNow(),retryCount:0,retryAfterMono:monotonicNow()+3000};
    }else {delete g.autoResume;delete g.reconcileResumeRunId;}
    g.controlRecoveryCount=0;g.controlRecoveryAfter=0;
    g.controlIntent=intent;g.controlGeneration=(g.controlGeneration||0)+1;g.status=intent==='stop'?'stop_pending':'pause_pending';g.nextEligibleAt=null;
    for(const instanceId of new Set(g.members.map(m=>get('channels',m).instanceId)))command('CONTROL',instanceId,controlPayload(g,instanceId));
    event(`group.${intent}_requested`,{groupId:g.id});controlComplete(g);
  }
  function blockInstanceGroups(instanceId,reasonCode){
    for(const g of state.groups.filter(g=>(g.status==='running'||g.autoResume)&&g.members.some(m=>get('channels',m).instanceId===instanceId))){
      if(!g.controlIntent)control(g,'pause',{systemReason:reasonCode});
      else if(g.autoResume){g.autoResume.requestedMono=monotonicNow();g.autoResume.retryAfterMono=monotonicNow()+3000;}
      g.waitReason=reasonCode;g.nextEligibleAt=null;
      incident(reasonCode==='connection_lost'?'connection_lost':'account_mismatch',{instanceId});event('group.resume_required',{groupId:g.id,instanceId,reasonCode},'warning');
    }
  }
  function ensureSession(message,instanceId){const instance=get('instances',instanceId);ensure(state.resetEpoch===0||message.resetEpoch===state.resetEpoch,'RESET_REQUIRED','설정이 초기화되었습니다. 최신 확장으로 다시 연결하세요.',409);ensure(instance.sessionId===message.sessionId,'STALE_SESSION','Session changed; reconnect and reconcile previous attempts.',409);if(!instance.connected)instance.stableSinceMono=monotonicNow();instance.lastSeenAt=now();instance.lastSeenMono=monotonicNow();instance.connected=true;return instance;}
  function validateMemberChannels(members){
    ensure(Array.isArray(members)&&members.length>=1&&members.length<=50&&new Set(members).size===members.length,'VALIDATION','Select 1–50 distinct channel connections.');
    const cs=members.map(m=>get('channels',m));ensure(cs.every(c=>c.channelId===cs[0].channelId&&c.guildId===cs[0].guildId),'CHANNEL_MISMATCH','Group members must belong to the same Discord channel.');
    ensure(new Set(cs.map(c=>c.accountId)).size===cs.length,'DUPLICATE_ACCOUNT','A Discord account may appear only once per group.');return cs;
  }
  /**
   * 그룹 실행에 필요한 잠금을 확보합니다. 동일 자원을 여러 그룹이 동시에 사용해
   * 계정별 발송 순서가 섞이지 않도록 하는 경계입니다.
   */
  function resourceKeys(g){return[`channel:${g.guildId}:${g.channelId}`,...g.members.map(m=>{const c=get('channels',m);return `account:${c.accountId}:${c.channelId}`;})];}
  function acquire(g){
    const keys=resourceKeys(g);
    ensure(!state.locks.some(l=>keys.includes(l.key)&&l.groupId!==g.id),'RESOURCE_BUSY','This channel or account is already controlled by another group.',409);
    for(const key of keys)if(!state.locks.some(l=>l.key===key))state.locks.push({key,groupId:g.id});
  }
  function eligibleChannel(c){
    ensure(!state.commands.some(cmd=>cmd.type==='MANAGE_WINDOW'&&cmd.instanceId===c.instanceId&&['consolidate','separate'].includes(cmd.payload.action)&&['queued','received'].includes(cmd.status)),'WINDOW_MANAGEMENT_PENDING','전송 창 정리가 끝난 뒤 실행하세요.',409);
    const i=get('instances',c.instanceId);ensure(i.connected&&now()-i.lastSeenAt<=15000,'CONNECTION_LOST','Connect this browser before starting.',409);
    ensure(i.legacyFrozen===true&&i.legacyPending===false,'LEGACY_UNRESOLVED','Legacy execution must be frozen and pending attempts resolved.',409);
    ensure(c.verified&&c.sessionId===i.sessionId,'ACCOUNT_UNVERIFIED','Verify the account and channel in this browser.',409);
    ensure(c.playlist.length>0,'PLAYLIST_EMPTY','Apply at least one message to this channel.',409);
    ensure(c.appliedVersion===c.configVersion,'CONFIG_PENDING','Wait for the extension to apply the current configuration.',409);
  }
  function queueConfiguration(c){
    const items=c.playlist.map(item=>{const m=get('messages',item.messageId),r=m.revisions.find(r=>r.id===item.revisionId);return{...item,name:m.name,body:r.body};});
    command('CONFIG_SYNC',c.instanceId,{bindingId:c.id,accountId:c.accountId,guildId:c.guildId,channelId:c.channelId,tabId:c.tabId,configVersion:c.configVersion,items,intervalMs:c.intervalMs});
  }
  function commitIntervalConfiguration(c){
    delete c.pendingIntervalSync;delete c.intervalSyncBaseMs;c.configVersion++;c.appliedVersion=0;
    const instance=state.instances.find(i=>i.id===c.instanceId);
    if(c.playlist.length&&c.verified&&instance?.connected&&c.sessionId===instance.sessionId)queueConfiguration(c);
  }
  function setChannelInterval(c,value){
    if(c.intervalMs===value)return false;
    const previous=c.intervalMs;c.intervalMs=value;c.updatedAt=now();
    if(state.attempts.some(a=>a.bindingId===c.id&&activeAttempt(a))){
      c.intervalSyncBaseMs??=previous;
      if(value===c.intervalSyncBaseMs){delete c.pendingIntervalSync;delete c.intervalSyncBaseMs;}else c.pendingIntervalSync=true;
    }else commitIntervalConfiguration(c);
    if(c.lastConfirmedMono!==undefined)c.nextMono=Math.max(c.nextMono||0,c.lastConfirmedMono-confirmationOffset(c)+effectiveInterval(c));
    event('channel.interval_updated',{channelId:c.id,intervalMode:c.intervalMode,intervalMs:c.intervalMs,pending:!!c.pendingIntervalSync});return true;
  }
  function latestPlaylist(items){return items.map(item=>({messageId:item.messageId,revisionId:get('messages',item.messageId).revisionId}));}
  function refreshMessageAssignments(messageId){
    for(const c of state.channels){
      // 수동으로 편집 중인 다음 목록을 우선합니다. 여기서 빠진 문구를 현재
      // 목록에 있다는 이유로 되살리거나 순서를 초기화하지 않습니다.
      const source=c.pendingPlaylist||c.playlist;
      if(messageId&&!source.some(item=>item.messageId===messageId))continue;
      const items=latestPlaylist(source);
      if(!messageId&&items.every((item,index)=>item.revisionId===source[index].revisionId))continue;
      if(state.attempts.some(a=>a.bindingId===c.id&&activeAttempt(a))){
        // 현재 초안/허가의 body, revision, configVersion은 불변입니다.
        // 미확인 결과에도 새 입력을 만들지 않고 정상 종료 후 최신본만 적용합니다.
        if(!c.pendingPlaylist)c.pendingPlaylistPreserveIndex=true;
        c.pendingPlaylist=items;c.updatedAt=now();
        event('channel.message_refresh_pending',{channelId:c.id,...(messageId?{messageId}:{})});
      }else applyPlaylist(c,items,{preserveIndex:true});
    }
  }
  function applyPlaylist(c,items,{preserveIndex=false}={}){
    c.playlist=items;if(!preserveIndex)c.playlistIndex=0;c.configVersion++;c.appliedVersion=0;if(!preserveIndex)c.version++;c.updatedAt=now();delete c.pendingIntervalSync;delete c.intervalSyncBaseMs;
    // 자동 갱신은 사용자 목록 편집 version을 바꾸지 않습니다. 오프라인이면 다음
    // 연결 관찰에서 최신 config를 보내며 사라진 예전 탭의 명령을 만들지 않습니다.
    const instance=state.instances.find(i=>i.id===c.instanceId);
    if(!preserveIndex||c.verified&&instance?.connected&&c.sessionId===instance.sessionId)queueConfiguration(c);event('channel.playlist_applied',{channelId:c.id,configVersion:c.configVersion});
  }
  /**
   * 발송 시도를 끝내고 그룹·채널의 다음 상태를 계산합니다.
   * 순서와 대기 시각의 변경은 이 결과 처리에 모입니다. Enter 요청을 보낸 순간과 완료 시각을 혼동하지 않습니다.
   */
  function finish(a,outcome,{messageId,manual=false,confirmationMs,confirmationBasis}={}){
    if(outcome==='confirmed')ensure(a.permitId||a.permitIssued,'PERMIT_REQUIRED','No commit permit was issued for this attempt.',409);
    if(a.detached===true&&a.executionBlocked===true){a.status=outcome;a.finalizedAt=now();a.manual=manual;if(messageId)a.messageId=text(messageId,'messageId',200);event(`delivery.${outcome}`,{attemptId:a.id,detached:true,manual});return a;}
    if(TERMINAL.has(a.status)){ensure(a.status===outcome,'RESULT_CONFLICT','This attempt already has a different final result.',409);return a;}
    const automaticallyReconciled=state.commands.some(cmd=>cmd.type==='RECONCILE'&&cmd.payload.attemptId===a.id&&['queued','received'].includes(cmd.status)&&cmd.sessionId===state.instances.find(i=>i.id===a.instanceId)?.sessionId);
    a.status=outcome;a.finalizedAt=now();a.manual=manual;if(messageId)a.messageId=text(messageId,'messageId',200);if(outcome==='confirmed')a.confirmationBasis=confirmationBasis||'message_observed';
    if(Number.isFinite(confirmationMs)&&confirmationMs>=0)a.confirmationMs=Math.min(confirmationMs,86_400_000);
    const g=get('groups',a.groupId),c=get('channels',a.bindingId);g.activeAttemptId=null;
    if(outcome==='confirmed'){
      delete g.prepareRetryCount;delete g.prepareRetryAfterMono;
      g.cursor=(g.cursor+1)%g.members.length;g.lastConfirmedAt=now();g.nextMono=monotonicNow()+g.intervalMs;
      c.playlistIndex=(a.playlistIndex+1)%c.playlist.length;c.lastConfirmedAt=now();c.lastConfirmedMono=monotonicNow();c.lastConfirmedAttemptId=a.id;c.lastConfirmationMs=Number.isFinite(a.confirmationMs)&&a.confirmationMs<=30000?a.confirmationMs:0;c.nextMono=c.lastConfirmedMono-confirmationOffset(c)+effectiveInterval(c);
    }
    for(const cmd of state.commands.filter(cmd=>cmd.payload.attemptId===a.id&&['PREPARE','COMMIT_PERMIT','RECONCILE'].includes(cmd.type)))cmd.status='completed';
    resolveIncidents(a.id);
    if(c.pendingPlaylist){applyPlaylist(c,latestPlaylist(c.pendingPlaylist),{preserveIndex:c.pendingPlaylistPreserveIndex===true});delete c.pendingPlaylist;delete c.pendingPlaylistPreserveIndex;}else if(c.pendingIntervalSync){c.version++;commitIntervalConfiguration(c);}
    if(g.controlIntent)controlComplete(g);else if(g.status==='needs_review'){
      const resume=automaticallyReconciled&&!manual&&g.enabled!==false&&g.reconcileResumeRunId===g.runId;
      delete g.reconcileResumeRunId;g.status=resume?'running':'paused';g.waitReason=null;
      if(resume)event('group.reconciled_resumed',{groupId:g.id});else release(g);
    }
    else if(['stopped','paused'].includes(g.status)){g.waitReason=null;release(g);}
    event(`delivery.${outcome}`,{attemptId:a.id,groupId:g.id,instanceId:a.instanceId,accountId:a.accountId,channelId:a.channelId,manual,...(a.confirmationBasis?{confirmationBasis:a.confirmationBasis}:{})});return a;
  }
  function failPreparation(a,reasonCode){
    if(a.permitId||a.permitIssued||!['preparing','unknown'].includes(a.status))return false;
    const g=get('groups',a.groupId),wasRunning=g.status==='running'&&!g.controlIntent&&g.activeAttemptId===a.id;
    const canRetry=wasRunning&&transientPreparationCodes.has(reasonCode);
    // Only the service can issue a COMMIT permit. No permit means this attempt
    // cannot press Enter, even if its PREPARE response arrives after timeout.
    a.reasonCode=reasonCode;a.executionBlocked=true;finish(a,'not_sent');
    if(canRetry){
      schedulePreparationRetry(g,a,reasonCode);
    }else if(wasRunning){
      g.status='paused';g.waitReason='preparation_failed';g.nextEligibleAt=null;release(g);
      const cmd=state.commands.find(c=>c.type==='PREPARE'&&c.payload.attemptId===a.id);
      // This is a preparation failure with a known unsent outcome, not an
      // unresolved delivery. One final incident is enough after bounded retry.
      incident('command_rejected',{instanceId:a.instanceId,commandId:cmd?.id,commandType:'PREPARE',groupId:g.id,attemptId:a.id,rejectionCode:reasonCode});
    }
    return true;
  }
  function schedulePreparationRetry(g,a,reasonCode){
    g.prepareRetryCount=(g.prepareRetryCount||0)+1;g.prepareRetryAfterMono=monotonicNow()+5000;
    g.waitReason='preparation_retry';g.nextEligibleAt=now()+5000;
    event('delivery.prepare_retry',{attemptId:a.id,groupId:g.id,reasonCode,retryCount:g.prepareRetryCount},'warning');
  }
  function restoreConfirmedDeadlines(){
    const wall=now(),mono=monotonicNow();
    // Restarting or explicitly resuming does not constitute a new delivery.
    // A future wall timestamp cannot prove elapsed time, so bound it at zero.
    const elapsed=entity=>Number.isFinite(entity.lastConfirmedAt)?Math.max(0,wall-entity.lastConfirmedAt):null;
    for(const g of state.groups){const age=elapsed(g);g.nextMono=mono+(age===null?0:Math.max(0,g.intervalMs-age));}
    for(const c of state.channels){
      const age=elapsed(c);c.nextMono=mono+(age===null?0:Math.max(0,effectiveInterval(c)-age-confirmationOffset(c)));
      if(age===null)delete c.lastConfirmedMono;else c.lastConfirmedMono=mono-age;
    }
  }
  function start(g){
    ensure(g.enabled!==false,'GROUP_DISABLED','비활성 그룹을 먼저 활성화하세요.',409);
    ensure(!g.activeAttemptId,'ATTEMPT_UNRESOLVED','Resolve the current attempt before resuming.',409);
    ensure(!g.controlIntent,'CONTROL_PENDING','Wait for actual stop/pause acknowledgments.',409);
    acquire(g);g.members.map(m=>get('channels',m)).forEach(eligibleChannel);
    if(['resume_required','stopped'].includes(state.service.status)){
      state.service.status='ready';state.service.reasonCode=null;
      restoreConfirmedDeadlines();
    }
    ensure(state.service.status==='ready','SERVICE_STOPPED','Resume the central service before starting a group.',409);
    delete g.autoResume;delete g.prepareRetryCount;delete g.prepareRetryAfterMono;g.runId=id();g.status='running';g.waitReason=null;event('group.started',{groupId:g.id});return g;
  }
  /**
   * 화면에서 요청한 설정·실행·중지 등 업무 명령의 입구입니다.
   * 각 action 분기에서 입력과 현재 상태를 검사하고 transact 안에서 저장합니다.
   */
  function execute(action,p={}){return transact(()=>{
    switch(action){
      case 'message.create':{const at=now(),r={id:id(),version:1,body:body(p.body),at};const m={id:id(),name:text(p.name,'name'),tags:tags(p.tags),archived:false,version:1,revisionId:r.id,body:r.body,revisions:[r],createdAt:at,updatedAt:at};state.messages.push(m);event('message.created',{messageId:m.id});return m;}
      case 'message.update':{const m=get('messages',p.id);expected(m,p);if(p.name!==undefined)m.name=text(p.name,'name');if(p.tags!==undefined)m.tags=tags(p.tags);if(p.body!==undefined){const r={id:id(),version:m.revisions.length+1,body:body(p.body),at:now()};m.revisions.push(r);m.revisionId=r.id;m.body=r.body;}m.version++;m.updatedAt=now();if(p.body!==undefined||p.name!==undefined)refreshMessageAssignments(m.id);event('message.updated',{messageId:m.id});return m;}
      case 'message.duplicate':{const original=get('messages',p.id),at=now(),r={id:id(),version:1,body:original.body,at};const m={...clone(original),id:id(),name:text(p.name||`${original.name.slice(0,190)} 복사`,'name'),version:1,archived:false,revisionId:r.id,revisions:[r],createdAt:at,updatedAt:at};state.messages.push(m);event('message.created',{messageId:m.id});return m;}
      case 'message.archive':{const m=get('messages',p.id);expected(m,p);m.archived=p.archived!==false;m.version++;event('message.archived',{messageId:m.id});return m;}
      case 'message.delete':{const m=get('messages',p.id);expected(m,p);ensure(!state.channels.some(c=>[...c.playlist,...(c.pendingPlaylist||[])].some(i=>i.messageId===m.id))&&!state.attempts.some(a=>a.messageIdRef===m.id&&activeAttempt(a)),'MESSAGE_IN_USE','This message is referenced. Archive it or remove its channel assignments.',409);state.messages=state.messages.filter(x=>x.id!==m.id);event('message.deleted',{messageId:m.id});return {id:m.id,deleted:true};}
      case 'instance.update':{const i=get('instances',p.id);expected(i,p);i.name=text(p.name,'name');i.nameCustomized=true;i.version++;event('instance.updated',{instanceId:i.id});return publicInstance(i);}
      case 'account.update':{const a=get('accounts',p.id);expected(a,p);a.name=text(p.name,'name');a.nameCustomized=true;a.version++;a.updatedAt=now();event('account.updated',{accountEntityId:a.id,instanceId:a.instanceId});return publicAccount(a);}
      case 'instance.delete':case 'account.delete':case 'target.delete':case 'channel.delete':{const kind=action.split('.')[0],entity=get({instance:'instances',account:'accounts',target:'targets',channel:'channels'}[kind],p.id);expected(entity,p);return removeConfiguration(kind,entity);}
      case 'target.update':{const target=get('targets',p.id);expected(target,p);applyChannelName(target,{name:text(p.name,'name')});event('target.updated',{targetId:target.id});return target;}
      case 'target.create':{
        ensure(typeof p.url==='string'&&/^https:\/\/discord\.com\/channels\/\d{1,30}\/\d{1,30}\/?$/.test(p.url),'VALIDATION','Use a Discord server channel URL: https://discord.com/channels/server/channel.');
        const [,guildId,channelId]=/^https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/?$/.exec(p.url);
        state.removals.targets=state.removals.targets.filter(key=>key!==removalKey(guildId,channelId));
        const target=upsertTarget(guildId,channelId,p.name===undefined?{}:{name:text(p.name,'name')});
        if(target.namePending)for(const instance of state.instances.filter(i=>i.connected&&now()-i.lastSeenAt<=15000&&i.capabilities?.includes('channel-name-lookup-v1'))){
          if(!state.commands.some(c=>c.type==='LOOKUP_CHANNEL_NAME'&&c.instanceId===instance.id&&c.sessionId===instance.sessionId&&c.payload.targetId===target.id&&['queued','received'].includes(c.status)))command('LOOKUP_CHANNEL_NAME',instance.id,{targetId:target.id,guildId,channelId});
        }
        return target;
      }
      case 'channel.reveal':case 'channel.hide':case 'channel.consolidate':case 'channel.separate':{
        const channel=get('channels',p.id),instance=get('instances',channel.instanceId);
        ensure(instance.connected&&now()-instance.lastSeenAt<=15000,'CONNECTION_LOST','Connect this browser first.',409);
        ensure(instance.capabilities?.includes('managed-window-v1'),'EXTENSION_UPDATE_REQUIRED','전송 창 관리를 지원하는 확장으로 업데이트하세요.',409);
        ensure(Number.isInteger(channel.tabId)&&channel.sessionId===instance.sessionId,'MANAGED_TAB_MISSING','기존 전송용 탭을 찾지 못했습니다. 채널 연결 상태를 확인하세요.',409);
        const windowAction=action.slice('channel.'.length);
        if(windowAction==='separate')ensure(instance.capabilities?.includes('managed-window-separation-v1'),'EXTENSION_UPDATE_REQUIRED','채널별 창 분리를 지원하는 확장으로 업데이트하세요.',409);
        if(['consolidate','separate'].includes(windowAction)){
          ensure(!state.attempts.some(a=>a.instanceId===instance.id&&activeAttempt(a)),'ATTEMPT_UNRESOLVED','발송을 중지하고 미확인 결과를 정리한 뒤 전송 창을 정리하세요.',409);
          ensure(state.groups.filter(g=>g.members.some(member=>get('channels',member).instanceId===instance.id)).every(g=>['stopped','paused'].includes(g.status)&&!g.controlIntent),'GROUP_RUNNING','해당 브라우저의 그룹을 중지한 뒤 전송 창을 정리하세요.',409);
        }
        const pending=state.commands.find(c=>c.type==='MANAGE_WINDOW'&&c.instanceId===instance.id&&c.sessionId===instance.sessionId&&c.payload.bindingId===channel.id&&c.payload.action===windowAction&&['queued','received'].includes(c.status));
        const queued=pending||command('MANAGE_WINDOW',instance.id,{action:windowAction,bindingId:channel.id,accountId:channel.accountId,guildId:channel.guildId,channelId:channel.channelId,tabId:channel.tabId});
        return{status:'queued',commandId:queued.id};
      }
      case 'channel.connect':{
        const account=get('accounts',p.accountId),target=get('targets',p.targetId),instance=get('instances',account.instanceId);
        ensure(instance.connected&&now()-instance.lastSeenAt<=15000,'CONNECTION_LOST','Connect this browser before connecting a channel.',409);
        ensure(instance.legacyFrozen===true&&instance.legacyPending===false,'LEGACY_UNRESOLVED','Legacy execution must be frozen and pending attempts resolved.',409);
        ensure(currentAccount(account),'ACCOUNT_UNVERIFIED','Verify the account in this browser again.',409);
        ensure(/^\d{1,30}$/.test(target.guildId)&&/^\d{1,30}$/.test(target.channelId),'VALIDATION','Only Discord server channels can be connected.');
        ensure(!state.attempts.some(a=>a.instanceId===instance.id&&a.guildId===target.guildId&&a.channelId===target.channelId&&activeAttempt(a)),'ATTEMPT_UNRESOLVED','Resolve the current attempt before opening this channel.',409);
        const connectionKey=removalKey(instance.id,account.accountId,target.guildId,target.channelId);
        ensure(!state.removals.closeRequests.some(r=>bindingKey(r)===connectionKey),'CLOSE_PENDING','이전 전송 탭을 닫는 중입니다. 해당 브라우저와 확장을 연결한 뒤 닫기 완료 후 다시 연결하세요.',409);
        state.removals.bindings=state.removals.bindings.filter(key=>key!==connectionKey);
        const channel=state.channels.find(c=>c.instanceId===instance.id&&c.accountId===account.accountId&&c.guildId===target.guildId&&c.channelId===target.channelId&&c.verified&&c.sessionId===instance.sessionId);
        if(channel)return{status:'connected',channel:publicChannel(channel)};
        ensure(instance.capabilities?.includes('open-channel-v1'),'EXTENSION_UPDATE_REQUIRED','채널을 연결하려면 중앙 관리 확장 프로그램을 최신 버전으로 업데이트하고 다시 연결하세요.',409);
        const pending=state.commands.find(c=>c.type==='OPEN_CHANNEL'&&c.instanceId===instance.id&&c.sessionId===instance.sessionId&&['queued','received','applied'].includes(c.status)&&c.payload.accountId===account.accountId&&c.payload.guildId===target.guildId&&c.payload.channelId===target.channelId);
        const queued=pending||command('OPEN_CHANNEL',instance.id,{accountId:account.accountId,guildId:target.guildId,channelId:target.channelId,accountEntityId:account.id,targetId:target.id});
        return{status:'pending',command:publicCommand(queued)};
      }
      case 'channel.update':{
        const c=get('channels',p.id);expected(c,p);ensure(!state.groups.some(g=>g.members.includes(c.id)&&(g.status==='running'||g.activeAttemptId)),'GROUP_RUNNING','Pause this channel’s group before editing.',409);
        if(p.name!==undefined){c.name=text(p.name,'name');c.nameCustomized=true;c.namePending=false;}
        if(p.intervalMode!==undefined||p.intervalMs!==undefined){
          const mode=p.intervalMode??'custom';ensure(['auto','custom'].includes(mode),'VALIDATION','간격 설정은 자동 또는 사용자 설정을 선택하세요.');
          const floor=minimumInterval(c),value=mode==='auto'?floor:duration(p.intervalMs??c.customIntervalMs??c.intervalMs);
          ensure(value>=floor,'INTERVAL_BELOW_SLOWMODE',`이 계정의 재전송 간격은 채널 슬로우 모드와 여유 3초를 포함해 최소 ${Math.ceil(floor/1000)}초여야 합니다.`);
          c.intervalMode=mode;if(mode==='custom')c.customIntervalMs=value;else delete c.customIntervalMs;
          setChannelInterval(c,value);
        }
        c.version++;event('channel.updated',{channelId:c.id});return publicChannel(c);
      }
      case 'channel.applyPlaylist':{const c=get('channels',p.id);expected(c,p);ensure(Array.isArray(p.items)&&p.items.length>=1&&p.items.length<=50,'VALIDATION','Select 1–50 messages.');const items=p.items.map(item=>{const m=get('messages',item.messageId);const revisionId=item.revisionId||m.revisionId;ensure(m.revisions.some(r=>r.id===revisionId),'VALIDATION','Message revision does not exist.');return{messageId:m.id,revisionId:m.revisionId};});const active=state.attempts.find(a=>a.bindingId===c.id&&activeAttempt(a));ensure(active?.status!=='unknown','ATTEMPT_UNRESOLVED','Resolve the unknown attempt before applying messages.',409);
        if(active){c.pendingPlaylist=items;delete c.pendingPlaylistPreserveIndex;c.version++;control(get('groups',active.groupId),'pause');event('channel.playlist_pending',{channelId:c.id});}else applyPlaylist(c,items);return publicChannel(c);}
      case 'group.create':{const cs=validateMemberChannels(p.members);const g={id:id(),name:text(p.name,'name'),guildId:cs[0].guildId,channelId:cs[0].channelId,members:[...p.members],intervalMs:duration(p.intervalMs??20000),version:1,status:'stopped',cursor:0,activeAttemptId:null,waitReason:null,nextEligibleAt:null,createdAt:now()};state.groups.push(g);event('group.created',{groupId:g.id});return g;}
      case 'group.update':{const g=get('groups',p.id);expected(g,p);ensure(['stopped','paused'].includes(g.status)&&!g.activeAttemptId&&!g.controlIntent,'GROUP_RUNNING','Stop or pause and resolve pending attempts before editing.',409);if(p.members){const cs=validateMemberChannels(p.members);g.members=[...p.members];g.guildId=cs[0].guildId;g.channelId=cs[0].channelId;g.cursor=0;}if(p.name!==undefined)g.name=text(p.name,'name');if(p.intervalMs!==undefined)g.intervalMs=duration(p.intervalMs);g.version++;release(g);event('group.updated',{groupId:g.id});return g;}
      // 활성 설정은 실행 선택과 별도로 저장하며, 해제 시 기존 중지 경로를 사용합니다.
      case 'group.setEnabled':{const g=get('groups',p.id);expected(g,p);ensure(typeof p.enabled==='boolean','VALIDATION','활성 여부가 필요합니다.');g.enabled=p.enabled;g.version++;if(!p.enabled){delete g.autoResume;if(g.status!=='stopped'||g.activeAttemptId||g.controlIntent)control(g,'stop');}event('group.enabled_changed',{groupId:g.id,enabled:g.enabled});return g;}
      case 'group.delete':{const g=get('groups',p.id);expected(g,p);ensure(g.status==='stopped'&&!g.activeAttemptId&&!g.controlIntent,'GROUP_RUNNING','Stop this group before deleting it.',409);for(const attempt of state.attempts.filter(a=>a.groupId===g.id))attempt.groupName??=g.name;release(g);state.groups=state.groups.filter(x=>x.id!==g.id);event('group.deleted',{groupId:g.id});return{id:g.id,deleted:true};}
      case 'group.start':case 'group.resume':return start(get('groups',p.id));
      case 'group.pause':case 'group.stop':{const g=get('groups',p.id);control(g,action.endsWith('stop')?'stop':'pause');return g;}
      case 'service.startAll':{
        ensure(state.groups.length>0,'NO_GROUPS','먼저 발송 그룹을 만들어 주세요.',409);
        // 명시 선택은 빈 목록/삭제된 ID를 거절하고 한 트랜잭션에서 전체 검증합니다.
        if(p.groupIds!==undefined)ensure(Array.isArray(p.groupIds)&&p.groupIds.length>0&&p.groupIds.every(v=>typeof v==='string'),'VALIDATION','실행할 그룹을 선택하세요.');
        const targets=p.groupIds===undefined?state.groups.filter(g=>g.enabled!==false):[...new Set(p.groupIds)].map(gid=>get('groups',gid));
        ensure(targets.length>0,'NO_GROUPS','활성화된 그룹이 없습니다.',409);
        for(const g of targets)ensure(g.enabled!==false,'GROUP_DISABLED','비활성 그룹이 선택되어 있습니다.',409);
        const candidates=targets.filter(g=>g.status!=='running');
        for(const g of candidates)start(g);
        event('service.started_all',{started:candidates.length,alreadyRunning:targets.length-candidates.length});
        return{started:candidates.length,alreadyRunning:targets.length-candidates.length};
      }
      case 'settings.reset':{
        ensure(p.confirmation==='RESET_ALL_SETTINGS','RESET_CONFIRMATION_REQUIRED','초기화 확인 문구가 필요합니다.');
        ensure(typeof p.expectedConfiguration==='string'&&p.expectedConfiguration===configurationToken(),'VERSION_CONFLICT','화면 상태가 변경되었습니다. 최신 상태를 확인한 뒤 다시 시도하세요.',409);
        ensure(!state.attempts.some(a=>activeAttempt(a)),'ATTEMPT_UNRESOLVED','진행 중 또는 미확인 발송을 먼저 확인하세요.',409);
        ensure(state.groups.every(g=>g.status==='stopped'&&!g.controlIntent&&!g.activeAttemptId),'GROUP_RUNNING','모든 그룹을 중지하고 중지 적용 완료를 확인하세요.',409);
        state.resetEpoch++;state.removals={targets:[],accounts:[],bindings:[],instances:[],closeRequests:[]};
        const removed={messages:state.messages.length,channels:state.channels.length,groups:state.groups.length,instances:state.instances.length,accounts:state.accounts.length,targets:state.targets.length};
        for(const c of state.commands)if(['queued','received'].includes(c.status))c.status='superseded';
        state.messages=[];state.channels=[];state.groups=[];state.instances=[];state.accounts=[];state.targets=[];state.locks=[];state.legacyImports=[];
        state.settings=initial(now()).settings;state.service.status='ready';state.service.reasonCode=null;delete state.service.clockDiagnostic;
        event('settings.reset',{...removed,resetEpoch:state.resetEpoch},'warning');return{reset:true,removed,historyPreserved:true};
      }
      case 'service.stopAll':state.service.status='ready';state.service.reasonCode=null;for(const g of state.groups.filter(g=>g.status!=='stopped'||g.activeAttemptId))control(g,'stop');event('service.stopped');return state.service;
      case 'service.resume':state.service.status='ready';state.service.reasonCode=null;delete state.service.clockDiagnostic;restoreConfirmedDeadlines();lastWall=now();lastMono=monotonicNow();event('service.resumed');return state.service;
      case 'attempt.resolve':{const a=get('attempts',p.id);ensure(p.outcome==='confirmed'||p.outcome==='not_sent','VALIDATION','Choose confirmed or not_sent.');if(p.outcome==='confirmed')ensure(p.messageId,'EVIDENCE_REQUIRED','Provide the observed Discord message ID.');else ensure(a.executionBlocked===true,'EXECUTION_UNCERTAIN','The executor must first confirm that the old attempt can no longer execute.',409);return finish(a,p.outcome,{messageId:p.messageId,manual:true});}
      case 'attempt.retryNotSent':{
        ensure(p.confirmation==='CONFIRM_NOT_SENT','VALIDATION','Explicitly confirm that this attempt was not sent.');
        const a=get('attempts',p.id),g=get('groups',a.groupId);
        ensure(['unknown','not_sent'].includes(a.status),'ATTEMPT_STATE','Only an unconfirmed or unsent attempt can be retried.',409);
        ensure(a.executionBlocked===true,'EXECUTION_UNCERTAIN','The executor must first confirm that the old attempt can no longer execute.',409);
        ensure(state.attempts.findLast(item=>item.groupId===g.id)?.id===a.id&&g.version===a.groupVersion&&g.members[g.cursor]===a.bindingId,'STALE_ATTEMPT','The group or its latest attempt changed. Refresh before continuing.',409);
        ensure(!g.activeAttemptId||g.activeAttemptId===a.id,'STALE_ATTEMPT','Another attempt is already active.',409);
        if(a.retryRunId){
          ensure(g.runId===a.retryRunId&&g.status==='running'&&!g.controlIntent,'STALE_ATTEMPT','This retry was already handled. Use the current group controls.',409);
          return{status:'already_started',attemptId:a.id,groupId:g.id,runId:g.runId};
        }
        ensure(g.runId===a.runId,'STALE_ATTEMPT','This attempt belongs to an earlier group run.',409);
        if(a.status==='unknown'){
          ensure(g.activeAttemptId===a.id,'STALE_ATTEMPT','This attempt is no longer active.',409);
          finish(a,'not_sent',{manual:true});
        }
        // A pending stop belongs to all group members. Record the user's outcome
        // now, but require another explicit continue after every control is applied.
        if(g.controlIntent)return{status:'waiting',reasonCode:'CONTROL_PENDING',attemptId:a.id,groupId:g.id};
        // Failure rolls back the outcome, service state and locks together.
        start(g);a.retryRunId=g.runId;
        event('delivery.retry_not_sent',{attemptId:a.id,groupId:g.id,runId:g.runId});
        return{status:'started',attemptId:a.id,groupId:g.id,runId:g.runId};
      }
      case 'attempt.resolveMany':{
        ensure(p.outcome==='not_sent'&&p.confirmation==='CONFIRM_NOT_SENT','VALIDATION','Explicitly confirm that every selected attempt was not sent.');
        ensure(Array.isArray(p.ids)&&p.ids.length>=1&&p.ids.length<=200&&p.ids.every(value=>typeof value==='string'&&value.length>0&&value.length<=100)&&new Set(p.ids).size===p.ids.length,'VALIDATION','Select 1–200 distinct attempt IDs.');
        const attempts=p.ids.map(value=>get('attempts',value));
        for(const a of attempts){ensure(a.status==='unknown','ATTEMPT_STATE','Every selected attempt must still be unknown.',409);ensure(a.executionBlocked===true,'EXECUTION_UNCERTAIN','Every selected executor must first confirm execution is blocked.',409);}
        for(const a of attempts)finish(a,'not_sent',{manual:true});
        return{resolved:attempts.length,ids:attempts.map(a=>a.id)};
      }
      case 'incident.read':{const i=get('incidents',p.id);i.read=p.read!==false;event('incident.read',{incidentId:i.id});return i;}
      case 'incident.recheck':return recheckIncidents(p.id);
      case 'settings.update':updateSettings(p);event('settings.updated');return state.settings;
      case 'backup.import':return restore(p.backup||p);
      case 'maintenance.prune':return pruneRecords();
      case 'legacy.import':return importLegacy(p.backup,p.sourceId);
      default:throw new CentralError('UNKNOWN_ACTION',`Unknown action: ${String(action).slice(0,80)}`);
    }
  });}
  function importLegacy(backup,sourceId){
    ensure(!state.attempts.some(a=>activeAttempt(a)),'ATTEMPT_UNRESOLVED','Resolve all attempts before importing legacy settings.',409);
    ensure(state.groups.every(g=>['stopped','paused','resume_required'].includes(g.status)&&!g.controlIntent),'GROUP_RUNNING','Stop all groups before importing legacy settings.',409);
    ensure(backup?.format==='dico-settings'&&backup.version===1&&Array.isArray(backup.channels)&&backup.channels.length>0&&backup.channels.length<=100,'VALIDATION','Unsupported legacy settings file.');
    const normalized=backup.channels.map(c=>{
      ensure(c&&Array.isArray(c.messages)&&c.messages.length===2&&c.messages.every(v=>typeof v==='string'&&v.length<=2000)&&[0,1].includes(c.nextIndex),'VALIDATION','Invalid legacy A/B messages or next index.');
      const messages=c.messages.map(v=>v.trim()?body(v):'');
      ensure(Number.isInteger(c.intervalSeconds)&&c.intervalSeconds>=30&&c.intervalSeconds<=31_536_000,'VALIDATION','Legacy interval must be at least 30 seconds.');
      let target=null;
      if(c.url!==null&&c.url!==undefined){let url;try{url=new URL(c.url);}catch{}ensure(url?.protocol==='https:'&&['discord.com','www.discord.com'].includes(url.hostname),'VALIDATION','Invalid Discord channel URL.');const match=/^\/channels\/(@me|\d+)\/(\d+)\/?$/.exec(url.pathname);ensure(match,'VALIDATION','Invalid Discord channel URL.');target={guildId:match[1],channelId:match[2]};}
      ensure(c.ownUserId===undefined||typeof c.ownUserId==='string','VALIDATION','Invalid legacy account ID.');
      const accountId=c.ownUserId||'';ensure(!accountId||/^\d{1,30}$/.test(accountId),'VALIDATION','Invalid legacy account ID.');
      if(c.slowmodeSeconds!=null)ensure(Number.isInteger(c.slowmodeSeconds)&&c.slowmodeSeconds>0&&c.slowmodeSeconds<=21600,'VALIDATION','Invalid slowmode duration.');
      return{name:text(c.name,'name',80),messages,nextIndex:c.nextIndex,intervalMs:Math.max(c.intervalSeconds*1000,(c.slowmodeSeconds||0)*1000),slowmodeMs:(c.slowmodeSeconds||0)*1000,accountId,target};
    });
    const source=sourceId?text(sourceId,'sourceId',100):createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    state.legacyImports??=[];let importedChannels=0,importedMessages=0,skippedChannels=0;
    for(let index=0;index<normalized.length;index++){
      const old=normalized[index],key=`${source}:${index}`;if(state.legacyImports.includes(key)){skippedChannels++;continue;}
      const playlist=[],slots=[];
      for(let slot=0;slot<2;slot++)if(old.messages[slot]){const r={id:id(),version:1,body:old.messages[slot],at:now()},m={id:id(),name:`${old.name} · 기존 문구 ${slot+1}`,tags:[],archived:false,version:1,revisionId:r.id,body:r.body,revisions:[r],createdAt:now(),updatedAt:now()};state.messages.push(m);playlist.push({messageId:m.id,revisionId:r.id});slots.push(slot);importedMessages++;}
      if(old.target){
        const instance={id:id(),version:1,name:`이전 설정 · ${old.name}`,browser:'연결 필요',extensionVersion:'legacy',connected:false,legacyFrozen:false,legacyPending:true,placeholder:true,sessionId:id(),createdAt:now()};state.instances.push(instance);
        const c={id:id(),instanceId:instance.id,accountId:old.accountId||`unverified:${key}`,guildId:old.target.guildId,channelId:old.target.channelId,name:old.name,version:1,configVersion:1,appliedVersion:0,verified:false,playlist,playlistIndex:Math.max(0,slots.indexOf(old.nextIndex)),intervalMs:old.intervalMs,slowmodeMs:old.slowmodeMs,legacySource:key,legacyPlaceholder:true,createdAt:now()};state.channels.push(c);
        state.groups.push({id:id(),name:old.name,guildId:c.guildId,channelId:c.channelId,members:[c.id],intervalMs:old.intervalMs,version:1,status:'stopped',cursor:0,activeAttemptId:null,waitReason:null,nextEligibleAt:null,createdAt:now()});importedChannels++;
      }
      state.legacyImports.push(key);
    }
    event('legacy.imported',{importedChannels,importedMessages,skippedChannels});return{importedChannels,importedMessages,skippedChannels,requiresReconnect:true,legacyStopVerified:false};
  }
  function updateSettings(p){
    for(const key of ['notificationsEnabled','hideNotificationNames','notifyRecovery'])if(p[key]!==undefined){ensure(typeof p[key]==='boolean','VALIDATION',`${key} must be boolean.`);state.settings[key]=p[key];}
    if(p.retentionDays!==undefined){ensure([30,90,180].includes(p.retentionDays),'VALIDATION','Choose 30, 90 or 180 retention days.');state.settings.retentionDays=p.retentionDays;}
    if(p.onboardingStep!==undefined){ensure(Number.isInteger(p.onboardingStep)&&p.onboardingStep>=0&&p.onboardingStep<=10,'VALIDATION','Invalid onboarding step.');state.settings.onboardingStep=p.onboardingStep;}
    if(p.cooldownMs!==undefined){ensure(Number.isInteger(p.cooldownMs)&&p.cooldownMs>=300000&&p.cooldownMs<=86400000,'VALIDATION','Notification cooldown must be between 5 minutes and 24 hours.');state.settings.cooldownMs=p.cooldownMs;}
    // 이전 UI/백업의 횟수 설정은 호환 입력으로 무시합니다. 정상 미발송의
    // 계속 시도는 내부 정책이며 사용자 설정이나 실제 오류 복구 한도가 아닙니다.
    delete state.settings.maxSendRetries;
    if(p.notificationTypes!==undefined){const allowed=['delivery_unknown','connection_lost','account_mismatch','command_rejected','storage_failure','permit_delay'];ensure(Array.isArray(p.notificationTypes)&&p.notificationTypes.every(x=>allowed.includes(x)),'VALIDATION','Unknown notification type.');state.settings.notificationTypes=[...new Set(p.notificationTypes)];}
    if(p.quietHours!==undefined){const q=p.quietHours,hhmm=/^(?:[01]\d|2[0-3]):[0-5]\d$/;ensure(q&&typeof q.enabled==='boolean'&&hhmm.test(q.start)&&hhmm.test(q.end),'VALIDATION','Quiet hours require enabled and HH:mm start/end.');state.settings.quietHours={enabled:q.enabled,start:q.start,end:q.end};}
  }
  function exportBackup(){return clone({format:'dico-central-backup',version:1,createdAt:now(),settings:state.settings,messages:state.messages,
    instances:state.instances.map(i=>({id:i.id,name:i.name,browser:i.browser})),
    accounts:state.accounts.map(a=>({id:a.id,instanceId:a.instanceId,accountId:a.accountId,name:a.name,nameCustomized:accountNameCustomized(a),...(a.observedName?{observedName:a.observedName}:{}),...(a.username?{username:a.username}:{})})),
    targets:state.targets.map(t=>({id:t.id,url:t.url,guildId:t.guildId,channelId:t.channelId,name:t.name,nameCustomized:channelNameCustomized(t),namePending:t.namePending,observedName:t.observedName})),
    channels:state.channels.map(c=>({id:c.id,instanceId:c.instanceId,accountId:c.accountId,guildId:c.guildId,channelId:c.channelId,name:c.name,nameCustomized:channelNameCustomized(c),namePending:c.namePending,observedName:c.observedName,intervalMs:c.intervalMs,intervalMode:c.intervalMode,customIntervalMs:c.customIntervalMs,slowmodeMs:c.slowmodeMs,slowmodeObservedAt:c.slowmodeObservedAt,playlist:c.playlist,playlistIndex:c.playlistIndex})),
    groups:state.groups.map(g=>({id:g.id,name:g.name,enabled:g.enabled!==false,members:g.members,intervalMs:g.intervalMs,cursor:g.cursor}))});}
  function restore(backup){
    ensure(!state.attempts.some(a=>activeAttempt(a)),'ATTEMPT_UNRESOLVED','Resolve every pending attempt before restoring a backup.',409);
    ensure(state.groups.every(g=>['stopped','paused','resume_required'].includes(g.status)&&!g.controlIntent),'GROUP_RUNNING','Stop all groups and wait for acknowledgments before restoring.',409);
    ensure(backup&&backup.format==='dico-central-backup'&&backup.version===1,'VALIDATION','Unsupported backup format.');
    for(const key of ['messages','instances','channels','groups'])ensure(Array.isArray(backup[key])&&backup[key].length<=10000,'VALIDATION',`Invalid backup ${key}.`);
    const checkIds=list=>{const ids=list.map(x=>text(x.id,'id',100));ensure(new Set(ids).size===ids.length,'VALIDATION','Duplicate identifiers in backup.');};
    for(const key of ['messages','instances','channels','groups'])checkIds(backup[key]);
    for(const key of ['accounts','targets'])if(backup[key]!==undefined){ensure(Array.isArray(backup[key])&&backup[key].length<=10000,'VALIDATION',`Invalid backup ${key}.`);checkIds(backup[key]);}
    const at=now();
    const messages=backup.messages.map(m=>{
      ensure(Array.isArray(m.revisions)&&m.revisions.length>0&&m.revisions.length<=10000,'VALIDATION','Message revisions are missing.');checkIds(m.revisions);
      const revisions=m.revisions.map((r,index)=>({id:text(r.id,'revisionId',100),version:index+1,body:body(r.body),at:Number.isSafeInteger(r.at)?r.at:at}));
      const latest=revisions.find(r=>r.id===m.revisionId);ensure(latest,'VALIDATION','Current revision is missing.');
      return{id:text(m.id,'id',100),name:text(m.name,'name'),tags:tags(m.tags),archived:m.archived===true,version:1,revisionId:latest.id,body:latest.body,revisions,createdAt:at,updatedAt:at};
    });
    const instances=backup.instances.map(i=>({id:text(i.id,'id',100),version:1,name:text(i.name,'name'),browser:text(i.browser||'Chromium','browser',40),extensionVersion:'unknown',connected:false,legacyFrozen:false,legacyPending:true,sessionId:id(),createdAt:at}));
    const channels=backup.channels.map(c=>{
      ensure(instances.some(i=>i.id===c.instanceId),'VALIDATION','Channel references a missing browser.');
      ensure(Array.isArray(c.playlist)&&c.playlist.length<=50,'VALIDATION','Invalid playlist.');
      const playlist=c.playlist.map(item=>{const m=messages.find(m=>m.id===item.messageId);ensure(m&&m.revisions.some(r=>r.id===item.revisionId),'VALIDATION','Playlist references a missing message revision.');return{messageId:m.id,revisionId:m.revisionId};});
      if(c.intervalMode!==undefined)ensure(['auto','custom'].includes(c.intervalMode),'VALIDATION','Invalid interval mode.');
      if(c.customIntervalMs!==undefined)duration(c.customIntervalMs,'customIntervalMs');
      if(c.slowmodeObservedAt!==undefined)ensure(Number.isSafeInteger(c.slowmodeObservedAt)&&c.slowmodeObservedAt>=0,'VALIDATION','Invalid slowmode observation time.');
      return{id:text(c.id,'id',100),instanceId:c.instanceId,accountId:text(c.accountId,'accountId',100),guildId:text(c.guildId,'guildId',100),channelId:text(c.channelId,'channelId',100),name:text(c.name,'name'),nameCustomized:channelNameCustomized(c),observedName:channelObservedName(c.observedName,c.channelId),intervalMs:duration(c.intervalMs),...(c.intervalMode?{intervalMode:c.intervalMode}:{}),...(c.customIntervalMs!==undefined?{customIntervalMs:c.customIntervalMs}:{}),...(c.slowmodeObservedAt!==undefined?{slowmodeObservedAt:c.slowmodeObservedAt}:{}),playlist,playlistIndex:Number.isSafeInteger(c.playlistIndex)&&c.playlistIndex>=0&&c.playlistIndex<playlist.length?c.playlistIndex:0,version:1,configVersion:1,appliedVersion:0,verified:false,slowmodeMs:duration(c.slowmodeMs??0,'slowmodeMs'),createdAt:at};
    });
    const accounts=(backup.accounts||[]).map(a=>{
      const instanceId=text(a.instanceId,'instanceId',100),accountId=text(a.accountId,'accountId',100);
      ensure(instances.some(i=>i.id===instanceId),'VALIDATION','Account references a missing browser.');
      // Existing v1 bindings may use legacy identity placeholders. Only those exact identities are grandfathered.
      ensure(/^\d{1,30}$/.test(accountId)||channels.some(c=>c.instanceId===instanceId&&c.accountId===accountId),'VALIDATION','Invalid Discord account ID.');
      const observedName=accountMetadataText(a.observedName),username=accountMetadataText(a.username);
      return{id:text(a.id,'id',100),instanceId,accountId,name:text(a.name,'name'),nameCustomized:accountNameCustomized(a),...(observedName?{observedName}:{}),...(username?{username}:{}),version:1,verified:false,createdAt:at,updatedAt:at};
    });
    const targets=(backup.targets||[]).map(t=>{
      const guildId=text(t.guildId,'guildId',100),channelId=text(t.channelId,'channelId',100),url=text(t.url,'url',300);
      const numeric=/^\d{1,30}$/.test(guildId)&&/^\d{1,30}$/.test(channelId);
      const existing=channels.some(c=>c.guildId===guildId&&c.channelId===channelId);
      ensure((numeric||existing)&&url===`https://discord.com/channels/${guildId}/${channelId}`&&/^https:\/\/discord\.com\/channels\/(?:@me|[\w-]+)\/[\w-]+$/.test(url),'VALIDATION','Invalid Discord channel URL in backup.');
      return{id:text(t.id,'id',100),url,guildId,channelId,name:text(t.name,'name'),nameCustomized:channelNameCustomized(t),observedName:channelObservedName(t.observedName,channelId),version:1,createdAt:at,updatedAt:at};
    });
    ensure(new Set(accounts.map(a=>JSON.stringify([a.instanceId,a.accountId]))).size===accounts.length,'VALIDATION','Duplicate account identities in backup.');
    ensure(new Set(targets.map(t=>JSON.stringify([t.guildId,t.channelId]))).size===targets.length,'VALIDATION','Duplicate channel targets in backup.');
    // All restored entities are built and validated before replacing current configuration.
    state.messages=messages;state.instances=instances;state.channels=channels;state.groups=[];state.accounts=accounts;state.targets=targets;
    for(const [kind,keys] of [['instances',instances.map(i=>i.id)],['accounts',accounts.map(accountKey)],['targets',targets.map(targetKey)],['bindings',channels.map(bindingKey)]])state.removals[kind]=state.removals[kind].filter(key=>!keys.includes(key));
    state.removals.closeRequests=state.removals.closeRequests.filter(r=>!channels.some(c=>bindingKey(c)===bindingKey(r)));
    for(const item of backup.groups){const cs=validateMemberChannels(item.members);state.groups.push({id:text(item.id,'id',100),name:text(item.name,'name'),enabled:item.enabled!==false,members:[...item.members],guildId:cs[0].guildId,channelId:cs[0].channelId,intervalMs:duration(item.intervalMs),cursor:Number.isSafeInteger(item.cursor)&&item.cursor>=0&&item.cursor<cs.length?item.cursor:0,version:1,status:'stopped',activeAttemptId:null,waitReason:null,nextEligibleAt:null,createdAt:at});}
    for(const c of state.commands.filter(c=>['queued','received'].includes(c.status)))c.status='superseded';
    state.locks=[];state.service.status='ready';state.service.reasonCode=null;delete state.service.clockDiagnostic;delete state.settings.maxSendRetries;if(backup.settings)updateSettings(backup.settings);
    event('backup.restored',{messageCount:messages.length,channelCount:channels.length,groupCount:state.groups.length});return{restored:true,messageCount:messages.length,channelCount:channels.length,groupCount:state.groups.length};
  }
  function importBackup(backup){return transact(()=>restore(backup));}
  function attemptPayload(a){return{attemptId:a.id,originSessionId:a.sessionId,groupId:a.groupId,runId:a.runId,bindingId:a.bindingId,accountId:a.accountId,guildId:a.guildId,channelId:a.channelId,tabId:a.tabId,configVersion:a.configVersion,body:a.body,revisionId:a.revisionId,maxSendRetries:normalizeSendRetries(a.maxSendRetries)};}
  /**
   * 확장 프로토콜의 입구입니다. 세션과 시도 식별자를 확인한 뒤 응답에 맞춰 상태를 전이합니다.
   * 연결 응답, 명령 수신 확인, 실제 발송 결과는 서로 다른 근거이므로 같은 성공으로 취급하지 않습니다.
   */
  function bridge(message,instanceId){
    ensure(message&&typeof message==='object'&&!Array.isArray(message),'VALIDATION','Bridge message must be an object.');
    return transact(()=>{
      if(message.type==='HELLO'){
        ensure(message.resetEpoch===undefined||Number.isSafeInteger(message.resetEpoch)&&message.resetEpoch>=0,'VALIDATION','Invalid reset epoch.');
        ensure(message.protocolVersion===1,'PROTOCOL_MISMATCH','Update the extension to central protocol 1.',409);
        ensure(message.extensionBuildId===undefined||typeof message.extensionBuildId==='string'&&/^[a-f0-9]{64}$/.test(message.extensionBuildId),'VALIDATION','Invalid extension build identity.');
        const capabilities=message.capabilities??[];ensure(Array.isArray(capabilities)&&capabilities.length<=32&&capabilities.every(value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)),'VALIDATION','Invalid extension capabilities.');
        const completedRemovalIds=message.completedRemovalIds??[];
        ensure(Array.isArray(completedRemovalIds)&&completedRemovalIds.length<=100&&completedRemovalIds.every(value=>typeof value==='string'&&value.length<=100),'VALIDATION','Invalid completed removal IDs.');
        if(state.removals.instances.includes(message.instanceId)){
          const completed=state.removals.closeRequests.filter(r=>r.instanceId===message.instanceId&&completedRemovalIds.includes(r.removalId));
          for(const request of completed){for(const c of state.commands.filter(c=>c.type==='CLOSE_CHANNEL'&&c.instanceId===message.instanceId&&c.payload.removalId===request.removalId)){c.status='applied';c.appliedAt=now();for(const problem of state.incidents.filter(i=>i.status==='open'&&i.commandId===c.id))resolveIncident(problem,{reasonCode:'managed_tab_closed'});}event('channel.closed_after_removal',{instanceId:message.instanceId,removalId:request.removalId});}
          state.removals.closeRequests=state.removals.closeRequests.filter(r=>!completed.includes(r));
          if(message.explicitReconnect!==true)return{removed:true,protocolVersion:1,resetEpoch:state.resetEpoch,closeChannels:state.removals.closeRequests.filter(r=>r.instanceId===message.instanceId)};
          state.removals.instances=state.removals.instances.filter(key=>key!==message.instanceId);
        }
        let i=state.instances.find(i=>i.id===message.instanceId);
        if(!i){i={id:message.instanceId?text(message.instanceId,'instanceId',100):id(),version:1,name:text(message.name||'Connected browser','name'),browser:typeof message.browser==='string'?message.browser.slice(0,40):'Chromium',extensionVersion:typeof message.extensionVersion==='string'?message.extensionVersion.slice(0,40):'unknown',createdAt:now()};state.instances.push(i);}
        const automaticName=!i.nameCustomized&&['Connected browser','연결된 Chromium',`연결된 ${i.browser}`].includes(i.name);
        const browser=typeof message.browser==='string'&&message.browser.trim()?message.browser.trim().slice(0,40):i.browser;
        const extensionVersion=typeof message.extensionVersion==='string'&&message.extensionVersion.trim()?message.extensionVersion.trim().slice(0,40):i.extensionVersion;
        const name=automaticName?`연결된 ${browser}`:i.name;
        if(i.browser!==browser||i.extensionVersion!==extensionVersion||i.extensionBuildId!==message.extensionBuildId||i.name!==name){i.browser=browser;i.extensionVersion=extensionVersion;i.name=name;i.version++;}
        if(message.extensionBuildId===undefined)delete i.extensionBuildId;else i.extensionBuildId=message.extensionBuildId;
        i.capabilities=[...new Set(capabilities)];
        if(i.sessionId)blockInstanceGroups(i.id,'session_changed');
        // 새 세션에는 진행 중인 중지/일시정지를 아래에서 다시 발급합니다.
        // 이전 세션의 거절을 완료 판정에 남기면 자동 복구 3회 소진 후에는
        // 새 명령이 실제 적용되어도 영원히 pending이 됩니다. 과거 거절은
        // 진단 기록과 사유를 보존한 채 대체하고, 새 세션의 적용 ACK를 기다립니다.
        // 발송 명령이나 미확인 시도의 결과를 성공/미발송으로 바꾸지는 않습니다.
        for(const c of state.commands.filter(c=>c.instanceId===i.id&&(!['completed','applied','rejected'].includes(c.status)||c.type==='OPEN_CHANNEL'&&c.status==='applied'||c.type==='CONTROL'&&c.status==='rejected')))c.status='superseded';
        invalidateAccounts(i.id);i.sessionId=id();i.connected=true;i.stableSinceMono=monotonicNow();i.lastSeenAt=now();i.lastSeenMono=monotonicNow();i.legacyFrozen=false;i.legacyPending=true;
        for(const c of state.channels.filter(c=>c.instanceId===i.id)){c.verified=false;c.verificationReason='session_changed';c.appliedVersion=0;delete c.tabId;}
        for(const a of state.attempts.filter(a=>a.instanceId===i.id&&activeAttempt(a))){markUnknown(a,'session_changed');command('RECONCILE',i.id,attemptPayload(a));}
        for(const g of state.groups.filter(g=>g.controlIntent&&g.members.some(m=>get('channels',m).instanceId===i.id)))command('CONTROL',i.id,controlPayload(g,i.id));
        queuePendingCloses(i.id);event('instance.connected',{instanceId:i.id});return{instanceId:i.id,sessionId:i.sessionId,protocolVersion:1,resetEpoch:state.resetEpoch,resetRequired:(message.resetEpoch??0)!==state.resetEpoch,commands:commands(i.id)};
      }
      if(message.type==='HEARTBEAT'&&state.resetEpoch>0&&message.resetEpoch!==state.resetEpoch)return{ok:false,resetRequired:true,resetEpoch:state.resetEpoch};
      const i=ensureSession(message,instanceId);
      if(message.type==='DELIVERY_TRACE'){
        const a=get('attempts',message.attemptId);ensure(a.instanceId===i.id&&a.sessionId===i.sessionId,'STALE_ATTEMPT','Trace belongs to another execution session.',409);
        ensure(validTraceStage(message.stage)&&Number.isSafeInteger(message.sequence)&&message.sequence>0&&Number.isSafeInteger(message.observedAt)&&message.observedAt>=0,'VALIDATION','Invalid delivery trace.');
        if(message.sequence<=(a.lastTraceSequence||0))return{ok:true,recorded:false};a.lastTraceSequence=message.sequence;
        const data=traceData(message.data);
        // 실제 페이지가 보고한 코드만 관측값으로 보존합니다. 설치 manifest나
        // 연결 확장 버전으로 페이지 코드를 추정하지 않으며 기존 trace를 재사용합니다.
        if(data.contentVersion||data.contentBuildId)a.codeObservation={...(data.contentVersion?{version:data.contentVersion}:{}),...(data.contentBuildId?{buildId:data.contentBuildId}:{}),observedAt:message.observedAt};
        if(!a.traceWindowAt||now()-a.traceWindowAt>=60000){a.traceWindowAt=now();a.traceWindowCount=0;}
        if(a.traceWindowCount>=120&&!['finished','exception'].includes(message.stage))return{ok:true,recorded:false};a.traceWindowCount++;
        event('delivery.trace',{attemptId:a.id,groupId:a.groupId,instanceId:i.id,stage:message.stage,observedAt:message.observedAt,sequence:message.sequence,data});return{ok:true,recorded:true};
      }
      if(message.type==='RECOVERY_STATUS')return{allowed:!state.attempts.some(a=>a.instanceId===i.id&&activeAttempt(a)&&!(a.status==='unknown'&&a.executionBlocked===true))};
      if(message.type==='CONNECTION_PROGRESS'){
        ensure(['account','channels','configuration','blocked'].includes(message.stage)&&Number.isInteger(message.total)&&message.total>=0&&message.total<=100&&Number.isInteger(message.completed)&&message.completed>=0&&message.completed<=message.total,'VALIDATION','Invalid connection progress.');
        const allowedReasons=new Set(['LEGACY_UNRESOLVED','ACCOUNT_UNVERIFIED','ATTEMPT_UNRESOLVED','TARGET_MISMATCH','CHANNEL_NOT_READY','CONTENT_UNAVAILABLE']);
        i.connectionProgress={stage:message.stage,total:message.total,completed:message.completed,at:now(),...(allowedReasons.has(message.reasonCode)?{reasonCode:message.reasonCode}:{})};
        event('connection.progress',{instanceId:i.id,...i.connectionProgress});return{ok:true};
      }
      if(message.type==='DELIVERY_WAIT'){
        if(clockGap()){suspendForClockGap();lastWall=now();lastMono=monotonicNow();return{allowed:false};}
        const a=state.attempts.find(a=>a.id===message.attemptId&&a.instanceId===i.id);
        if(!a||a.status!=='permitted'||a.sessionId!==i.sessionId||a.runId!==message.runId||a.configVersion!==message.configVersion||!Number.isSafeInteger(message.cooldownMs)||message.cooldownMs<0||message.cooldownMs>21600000)return{allowed:false};
        const g=get('groups',a.groupId),c=get('channels',a.bindingId);
        if(state.service.status!=='ready'||g.status!=='running'||g.controlIntent||g.activeAttemptId!==a.id||g.runId!==a.runId||c.configVersion!==a.configVersion||c.tabId!==a.tabId||message.retryPhase!==true&&now()-a.permittedAt>MAX_PRE_ENTER_WAIT_MS)return{allowed:false};
        if(message.observationPhase===true){
          // Read-only observation keeps the original lane alive. It grants no
          // Enter authority and cannot reserve or skip a retry count.
          if(message.retryPhase===true||message.retryCount!==(a.sendRetryCount??0)||!Number.isSafeInteger(message.elapsedMs)||message.elapsedMs<0||message.cooldownMs!==0)return{allowed:false};
          a.preEnterWaitObservedAt=now();a.retryObservedAt=now();a.enterReadyAt=now();
          g.waitReason='delivery_observation';return{allowed:true};
        }
        if(message.observationPhase!==undefined&&message.observationPhase!==false)return{allowed:false};
        try{eligibleChannel(c);}catch{
          // A denied wait is still read-only liveness for this exact lane.
          // Do not spend the next retry while identity verification recovers.
          const current=a.sendRetryCount??0,count=message.retryCount;
          const validWait=Number.isSafeInteger(message.elapsedMs)&&message.elapsedMs>=0&&(message.retryPhase===true?Number.isSafeInteger(count)&&count>=1&&count>=current&&count<=current+1:current===0&&(message.retryPhase===undefined||message.retryPhase===false));
          if(!validWait)return{allowed:false};
          a.preEnterWaitObservedAt=now();a.enterReadyAt=now();if(current>0)a.retryObservedAt=now();
          return{allowed:false,retryable:true,code:'CHANNEL_NOT_READY',retryAfterMs:500};
        }
        if(message.retryPhase===true){
          const count=message.retryCount,current=a.sendRetryCount??0;
          if(!Number.isSafeInteger(count)||count<1||!Number.isSafeInteger(message.elapsedMs)||message.elapsedMs<0||now()-(a.retryObservedAt||a.enterReadyAt||a.permittedAt)>30000||count<current||count>current+1||count===current+1&&a.authorizedRetryCount!==count-1||count===current&&a.authorizedRetryCount!==count-1&&a.authorizedRetryCount!==count)return{allowed:false};
          a.sendRetryCount=count;a.retryObservedAt=now();
        }else if(message.retryPhase!==undefined&&message.retryPhase!==false||a.sendRetryCount>0)return{allowed:false};
        const waiting=message.cooldownMs>0,changed=Boolean(a.preEnterWaiting)!==waiting;
        a.preEnterWaiting=waiting;a.preEnterWaitObservedAt=now();
        if(!waiting)a.enterReadyAt=now();
        g.waitReason=waiting?'discord_cooldown':message.retryPhase===true?'send_retry':'awaiting_result';
        if(changed)event('delivery.pre_enter_wait',{attemptId:a.id,groupId:g.id,instanceId:i.id,waiting,cooldownMs:message.cooldownMs});
        return{allowed:true};
      }
      if(message.type==='COOLDOWN_SAMPLE'){
        const a=state.attempts.find(a=>a.id===message.attemptId&&a.instanceId===i.id);
        const c=a&&state.channels.find(c=>c.id===a.bindingId),g=a&&state.groups.find(g=>g.id===a.groupId),sample=message.sample;
        if(!a||!c||!g||a.status!=='confirmed'||a.manual||c.lastConfirmedAttemptId!==a.id||a.sessionId!==i.sessionId||c.sessionId!==i.sessionId||!i.connected||c.verified!==true||a.runId!==message.runId||g.runId!==a.runId||a.configVersion!==message.configVersion||c.configVersion!==a.configVersion||c.tabId!==a.tabId||c.accountId!==a.accountId||c.guildId!==a.guildId||c.channelId!==a.channelId||g.activeAttemptId||state.attempts.some(other=>other.id!==a.id&&other.bindingId===c.id&&activeAttempt(other))||now()-a.finalizedAt<0||now()-a.finalizedAt>17000||!Number.isFinite(c.slowmodeObservedAt)||!Number.isFinite(a.confirmationMs)||a.confirmationMs<0||a.confirmationMs>30000||!sample||typeof sample!=='object'||Array.isArray(sample)||sample.status!=='remaining'||!Number.isFinite(sample.elapsedMs)||sample.elapsedMs<0||sample.elapsedMs>15000||!Number.isFinite(sample.maxGapMs)||sample.maxGapMs<0||sample.maxGapMs>1500||!Number.isSafeInteger(sample.remainingMs)||sample.remainingMs<=0||sample.remainingMs>21600000||sample.slowmodeMs!==undefined&&sample.slowmodeMs!==c.slowmodeMs)return{ok:false};
        // The countdown starts at Enter. Its displayed seconds can omit a
        // fraction, so round the inferred full cycle up to the next second.
        const measuredFullCycle=Math.ceil((sample.elapsedMs+sample.remainingMs)/1000)*1000+3000;
        const correction=Math.max(0,measuredFullCycle-minimumInterval(c));
        const previous=c.cooldownCorrectionMs||0;
        c.cooldownCorrectionMs=c.cooldownCalibratedAttemptId===a.id?Math.max(previous,correction):correction;
        c.cooldownCalibratedAttemptId=a.id;c.cooldownCalibratedAt=now();
        if(c.lastConfirmedMono!==undefined)c.nextMono=c.lastConfirmedMono-confirmationOffset(c)+effectiveInterval(c);
        if(c.cooldownCorrectionMs!==previous)event('channel.cooldown_calibrated',{channelId:c.id,attemptId:a.id,correctedBaseIntervalMs:correctedBaseInterval(c)});
        return{ok:true};
      }
      if(message.type==='AUTHORIZE_ENTER'){
        const deny=(code,retryable=false,retryAfterMs=500)=>({allowed:false,code,retryable,...(retryable?{retryAfterMs}:{})});
        if(clockGap()){suspendForClockGap();lastWall=now();lastMono=monotonicNow();return deny('CLOCK_UNSAFE');}
        const a=state.attempts.find(a=>a.id===message.attemptId&&a.instanceId===i.id);
        if(!a||a.status!=='permitted')return deny('ATTEMPT_STATE');
        if(a.sessionId!==i.sessionId||a.runId!==message.runId)return deny('STALE_ATTEMPT');
        if(a.configVersion!==message.configVersion)return deny('CONFIG_MISMATCH');
        const g=state.groups.find(g=>g.id===a.groupId),c=state.channels.find(c=>c.id===a.bindingId);
        if(state.service.status!=='ready'||!g||g.status!=='running'||g.controlIntent||g.runId!==a.runId||g.activeAttemptId!==a.id)return deny('EXECUTION_STOPPED');
        if(!c||c.configVersion!==a.configVersion)return deny('CONFIG_MISMATCH');
        if(c.accountId!==a.accountId||c.guildId!==a.guildId||c.channelId!==a.channelId||c.tabId!==a.tabId)return deny('TARGET_MISMATCH');
        // A current, scoped authorization request is liveness, not evidence of
        // delivery. Keep transient permission waits from timing out the lane.
        a.enterReadyAt=now();if(a.sendRetryCount>0)a.retryObservedAt=now();
        if(a.preEnterWaiting)return deny('DISCORD_COOLDOWN',true);
        const retryCount=message.retryCount??0;
        if(!Number.isSafeInteger(retryCount)||retryCount<0||retryCount!==(a.sendRetryCount??0))return deny('RETRY_STATE_MISMATCH');
        if(retryCount>0&&(!a.retryObservedAt||now()-a.retryObservedAt>30000))return deny('RETRY_OBSERVATION_STALE',true);
        try{eligibleChannel(c);}catch(error){return deny(['ACCOUNT_UNVERIFIED','CHANNEL_UNVERIFIED','INSTANCE_OFFLINE','CONFIG_PENDING'].includes(error.code)?'CHANNEL_NOT_READY':error.code||'CHANNEL_NOT_READY',true);}
        if(monotonicNow()<Math.max(g.nextMono||0,c.nextMono||0))return deny('INTERVAL_NOT_ELAPSED',true);
        a.authorizedRetryCount=retryCount;return{allowed:true};
      }

      if(message.type==='HEARTBEAT'){
        queuePendingCloses(i.id);
        const requested=message.knownAttemptIds??[];ensure(Array.isArray(requested)&&requested.length<=500&&requested.every(value=>typeof value==='string'&&value.length<=100),'VALIDATION','knownAttemptIds must contain at most 500 identifiers.');
        const ids=new Set(requested),terminalAttempts=state.attempts.filter(a=>a.instanceId===i.id&&ids.has(a.id)&&TERMINAL.has(a.status)).map(a=>({attemptId:a.id,status:a.status,...(a.messageId?{messageId:a.messageId}:{}),...(a.confirmationBasis?{confirmationBasis:a.confirmationBasis}:{}),...(a.confirmationBasis==='composer_cleared'?{deliveryEvidence:a.deliveryEvidence}:{})}));
        return{ok:true,commands:commands(i.id),terminalAttempts};
      }
      if(message.type==='DISCONNECT'){
        blockInstanceGroups(i.id,'connection_lost');i.connected=false;invalidateAccounts(i.id);for(const c of state.channels.filter(c=>c.instanceId===i.id))c.verified=false;
        for(const a of state.attempts.filter(a=>a.instanceId===i.id&&activeAttempt(a)))markUnknown(a,'connection_lost');
        for(const g of state.groups.filter(g=>g.status==='running'&&g.members.some(m=>get('channels',m).instanceId===i.id))){g.waitReason='connection_lost';incident('connection_lost',{instanceId:i.id});}
        event('instance.disconnected',{instanceId:i.id});return{ok:true};
      }
      if(message.type==='ACCOUNT_OBSERVATION'){
        ensure(typeof message.verified==='boolean','VALIDATION','Account verification must be true or false.');
        ensure(typeof message.accountId==='string'&&/^\d{1,30}$/.test(message.accountId),'VALIDATION','Invalid Discord account ID.');
        if(message.legacyFrozen!==undefined||message.legacyPending!==undefined){
          ensure(typeof message.legacyFrozen==='boolean'&&typeof message.legacyPending==='boolean','VALIDATION','Both legacy execution flags are required.');
          i.legacyFrozen=message.legacyFrozen;i.legacyPending=message.legacyPending;
        }
        const deletedKey=removalKey(i.id,message.accountId);
        if(state.removals.accounts.includes(deletedKey)){if(message.explicitRegistration!==true||!message.verified)return{ok:true,account:null,commands:commands(i.id)};state.removals.accounts=state.removals.accounts.filter(key=>key!==deletedKey);}
        const affected=accountId=>message.verified?accountId!==message.accountId:accountId===message.accountId;
        const transientReasons=new Set(['tab_loading','tab_missing','script_unavailable','identity_unverified','content_refresh_required','awaiting_observation']);
        const confirmedMismatch=message.verified===true||!transientReasons.has(message.verificationReason);
        const mismatched=state.accounts.some(a=>a.instanceId===i.id&&affected(a.accountId)&&a.verified)||state.channels.some(c=>c.instanceId===i.id&&affected(c.accountId)&&c.verified)||state.attempts.some(a=>a.instanceId===i.id&&affected(a.accountId)&&activeAttempt(a));
        for(const a of state.accounts.filter(a=>a.instanceId===i.id&&affected(a.accountId)))a.verified=false;
        for(const c of state.channels.filter(c=>c.instanceId===i.id&&affected(c.accountId))){c.verified=false;c.verificationReason=confirmedMismatch?'account_mismatch':verificationReason(message.verificationReason);}
        if(mismatched&&confirmedMismatch){
          blockInstanceGroups(i.id,'account_mismatch');
          for(const a of state.attempts.filter(a=>a.instanceId===i.id&&affected(a.accountId)&&activeAttempt(a)))markUnknown(a,'account_mismatch');
          incident('account_mismatch',{instanceId:i.id});
        }
        for(const c of state.commands.filter(c=>confirmedMismatch&&c.instanceId===i.id&&c.payload.accountId&&affected(c.payload.accountId)&&(['queued','received'].includes(c.status)||c.type==='OPEN_CHANNEL'&&c.status==='applied')&&['OPEN_CHANNEL','PREPARE','COMMIT_PERMIT'].includes(c.type)))c.status='superseded';
        const account=message.verified?upsertAccount(i.id,message.accountId,{verified:true,sessionId:i.sessionId,accountName:message.accountName,username:message.username}):state.accounts.find(a=>a.instanceId===i.id&&a.accountId===message.accountId);
        event('account.observed',{accountEntityId:account?.id,instanceId:i.id,verified:message.verified});return{ok:true,account:account?publicAccount(account):null,commands:commands(i.id)};
      }
      if(message.type==='OBSERVATION'){
        ensure(Array.isArray(message.channels)&&message.channels.length<=100,'VALIDATION','Invalid channel observations.');
        i.legacyFrozen=message.legacyFrozen===true;i.legacyPending=message.legacyPending!==false;
        for(const c of state.channels.filter(c=>c.instanceId===i.id)){c.verified=false;c.verificationReason='awaiting_observation';}
        const seenTabs=new Set();
        for(const observed of message.channels){
          const accountId=text(observed.accountId,'accountId',100),channelId=text(observed.channelId,'channelId',100),guildId=text(observed.guildId||'@me','guildId',100);
          ensure(Number.isInteger(observed.tabId)&&observed.tabId>=0&&!seenTabs.has(observed.tabId),'VALIDATION','Each observed channel needs its own dedicated tab.');seenTabs.add(observed.tabId);
          if(removedScope({instanceId:i.id,accountId,guildId,channelId}))continue;
          ensure(!state.attempts.some(a=>a.instanceId===i.id&&a.tabId===observed.tabId&&activeAttempt(a)&&(a.accountId!==accountId||a.channelId!==channelId||a.guildId!==guildId)),'TAB_BUSY','An unresolved attempt owns this execution tab.',409);
          let c=state.channels.find(c=>c.instanceId===i.id&&c.accountId===accountId&&c.guildId===guildId&&c.channelId===channelId);
          if(!c){const candidates=state.channels.filter(x=>x.legacyPlaceholder&&x.accountId===accountId&&x.guildId===guildId&&x.channelId===channelId);if(candidates.length===1&&i.legacyFrozen&&i.legacyPending===false){c=candidates[0];const previousInstance=c.instanceId;c.instanceId=i.id;c.legacyPlaceholder=false;c.version++;if(!state.channels.some(x=>x.instanceId===previousInstance)){
            state.instances=state.instances.filter(x=>x.id!==previousInstance);
            for(const old of state.accounts.filter(a=>a.instanceId===previousInstance)){
              const current=state.accounts.find(a=>a.instanceId===i.id&&a.accountId===old.accountId);
              if(current){if(!accountNameCustomized(current)&&accountNameCustomized(old)){current.name=old.name;current.nameCustomized=true;current.version++;}state.accounts=state.accounts.filter(a=>a.id!==old.id);}
              else{old.instanceId=i.id;old.verified=false;old.version++;}
            }
          }event('legacy.bound',{channelId:c.id,instanceId:i.id});}}
          const createdChannel=!c;
          if(!c){c={id:id(),instanceId:i.id,accountId,guildId,channelId,name:pendingChannelName,nameCustomized:false,namePending:true,version:1,configVersion:0,appliedVersion:0,playlist:[],playlistIndex:0,intervalMode:'auto',intervalMs:3000,slowmodeMs:0,createdAt:now()};state.channels.push(c);event('channel.discovered',{channelId:c.id,instanceId:i.id});}
          const tabChanged=c.tabId!==observed.tabId||c.sessionId!==i.sessionId;
          if(tabChanged&&state.attempts.some(a=>a.bindingId===c.id&&activeAttempt(a)&&!(a.status==='unknown'&&a.executionBlocked===true))){c.verified=false;for(const a of state.attempts.filter(a=>a.bindingId===c.id&&activeAttempt(a)))markUnknown(a,'execution_tab_changed');continue;}
          c.tabId=observed.tabId;c.sessionId=i.sessionId;c.verified=observed.verified===true;c.observedAt=now();c.observedMono=monotonicNow();if(c.verified)delete c.verificationReason;else c.verificationReason=verificationReason(observed.verificationReason);
          if(c.verified){
            applyChannelName(c,{observedName:observed.channelName??observed.name},createdChannel);
            upsertAccount(i.id,accountId,{verified:true,sessionId:i.sessionId,accountName:observed.accountName,username:observed.username});upsertTarget(guildId,channelId,{observedName:c.observedName});
            for(const cmd of state.commands.filter(cmd=>cmd.type==='OPEN_CHANNEL'&&cmd.instanceId===i.id&&cmd.sessionId===i.sessionId&&['queued','received','applied'].includes(cmd.status)&&cmd.payload.accountId===accountId&&cmd.payload.guildId===guildId&&cmd.payload.channelId===channelId)){cmd.status='completed';cmd.completedAt=now();}
          }
          if(observed.slowmodeMs!==undefined){
            const previous=c.slowmodeMs;c.slowmodeMs=duration(observed.slowmodeMs,'slowmodeMs');c.slowmodeObservedAt=now();
            if(previous!==c.slowmodeMs){delete c.cooldownCorrectionMs;delete c.cooldownCalibratedAttemptId;delete c.cooldownCalibratedAt;}
            const interval=c.intervalMode==='auto'?minimumInterval(c):Math.max(c.customIntervalMs??c.intervalMs,minimumInterval(c));
            if(setChannelInterval(c,interval))c.version++;
            if(previous!==c.slowmodeMs)event('channel.slowmode_observed',{channelId:c.id,slowmodeMs:c.slowmodeMs,effectiveIntervalMs:effectiveInterval(c)});
          }
          if(c.verified&&c.playlist.length&&c.appliedVersion!==c.configVersion&&!state.attempts.some(a=>a.bindingId===c.id&&activeAttempt(a))&&!state.commands.some(cmd=>cmd.type==='CONFIG_SYNC'&&cmd.payload.bindingId===c.id&&cmd.payload.configVersion===c.configVersion&&cmd.sessionId===i.sessionId&&['queued','received'].includes(cmd.status))){
            command('CONFIG_SYNC',i.id,{bindingId:c.id,accountId,guildId,channelId,tabId:c.tabId,configVersion:c.configVersion,intervalMs:c.intervalMs,items:c.playlist.map(item=>{const m=get('messages',item.messageId);return{...item,name:m.name,body:m.revisions.find(r=>r.id===item.revisionId).body};})});
          }
        }
        for(const g of state.groups.filter(g=>g.status==='running'))for(const bindingId of g.members){const c=get('channels',bindingId);if(c.instanceId===i.id&&!c.verified){g.waitReason='account_unverified';incident(c.verificationReason==='account_mismatch'?'account_mismatch':'channel_unverified',{groupId:g.id,instanceId:i.id,bindingId:c.id,verificationReason:c.verificationReason});}}
        for(const g of state.groups.filter(g=>g.status==='running'&&g.waitReason==='account_unverified'))if(g.members.every(member=>{const c=get('channels',member),owner=get('instances',c.instanceId);return c.verified&&c.sessionId===owner.sessionId&&owner.connected;}))g.waitReason=g.activeAttemptId?'preparing':null;
        for(const problem of state.incidents.filter(p=>p.status==='open'&&['account_mismatch','channel_unverified'].includes(p.code)))if(identityRecovered(problem))resolveIncident(problem,{reasonCode:'connection_reverified'});
        event('instance.observed',{instanceId:i.id,channelCount:message.channels.length});return{ok:true,channels:state.channels.filter(c=>c.instanceId===i.id).map(c=>publicChannel(c)),commands:commands(i.id)};
      }
      if(message.type==='ACK'){
        const c=get('commands',message.commandId);ensure(c.instanceId===i.id&&c.sessionId===i.sessionId,'STALE_COMMAND','Command belongs to a different instance or session.',409);
        ensure(['received','applied','rejected'].includes(message.status),'VALIDATION','Invalid command acknowledgment.');
        if(['completed','superseded'].includes(c.status)||c.status==='rejected'&&message.status==='rejected'||c.status==='applied'&&message.status==='received')return{ok:true};
        ensure(!(c.status==='rejected'&&message.status!=='rejected'),'COMMAND_REJECTED','Rejected command cannot later be applied.',409);
        c.status=message.status;c[`${message.status}At`]=now();
        if(message.status==='applied'&&c.type==='CLOSE_CHANNEL'){state.removals.closeRequests=state.removals.closeRequests.filter(r=>r.removalId!==c.payload.removalId);for(const problem of state.incidents.filter(problem=>problem.status==='open'&&state.commands.some(old=>old.id===problem.commandId&&old.payload.removalId===c.payload.removalId)))resolveIncident(problem,{reasonCode:'managed_tab_closed'});}
        if(message.status==='applied'&&c.type==='LOOKUP_CHANNEL_NAME'){
          const target=state.targets.find(t=>t.id===c.payload.targetId&&t.guildId===c.payload.guildId&&t.channelId===c.payload.channelId);
          if(target)applyChannelName(target,{observedName:message.channelName});
        }
        if(message.status==='applied'&&c.type==='CONFIG_SYNC'){
          const channel=get('channels',c.payload.bindingId);if(channel.configVersion===c.payload.configVersion&&channel.sessionId===i.sessionId)channel.appliedVersion=c.payload.configVersion;
        }
        if(message.status==='applied'&&c.type==='CONTROL'){
          if(message.executionBlocked===true&&message.attemptId&&message.attemptId===c.payload.attemptId){const a=get('attempts',message.attemptId);ensure(a.instanceId===i.id,'INSTANCE_MISMATCH','Attempt belongs to another instance.');a.executionBlocked=true;
            if(a.status==='preparing')finish(a,'cancelled');
            else if(a.status==='unknown'&&!a.permitId&&!a.permitIssued)finish(a,'not_sent');
            else if(a.status==='permitted')markUnknown(a,'EXECUTION_STOPPED');
          }
          controlComplete(get('groups',c.payload.groupId));
        }
        if(message.status==='rejected'){
          const rejectionCode=typeof message.rejectionCode==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(message.rejectionCode)?message.rejectionCode:undefined;
          if(rejectionCode)c.rejectionCode=rejectionCode;else delete c.rejectionCode;
          const attempt=c.payload.attemptId?get('attempts',c.payload.attemptId):null;
          if(!(c.type==='PREPARE'&&attempt&&failPreparation(attempt,rejectionCode||'PREPARE_REJECTED'))){
            incident('command_rejected',{instanceId:i.id,commandId:c.id,commandType:c.type,groupId:c.payload.groupId,...(c.payload.attemptId?{attemptId:c.payload.attemptId}:{}),...(rejectionCode?{rejectionCode}:{})});
            if(attempt&&activeAttempt(attempt))markUnknown(attempt,rejectionCode||'command_rejected');
          }
        }
        event('command.ack',{commandId:c.id,instanceId:i.id,status:c.status,...(c.rejectionCode?{rejectionCode:c.rejectionCode}:{})});return{ok:true};
      }
      if(message.type==='PREPARED'){
        const elapsed=monotonicNow()-lastMono;ensure(elapsed>=0&&elapsed<=15000&&Math.abs((now()-lastWall)-elapsed)<=2000,'CLOCK_UNSAFE','Clock continuity is uncertain; manual resume is required.',409);
        const a=get('attempts',message.attemptId);ensure(a.instanceId===i.id&&a.sessionId===i.sessionId,'STALE_ATTEMPT','Attempt belongs to another instance or session.',409);
        if(a.status==='permitted')return{ok:true,permitId:a.permitId};
        ensure(a.status==='preparing','ATTEMPT_STATE','This attempt is no longer preparing.',409);
        const g=get('groups',a.groupId),c=get('channels',a.bindingId);
        ensure(state.service.status==='ready'&&g.status==='running'&&!g.controlIntent&&a.runId===g.runId,'EXECUTION_STOPPED','New commit permits are blocked.',409);
        eligibleChannel(c);ensure(message.accountId===a.accountId&&message.channelId===a.channelId&&message.configVersion===a.configVersion&&c.configVersion===a.configVersion&&message.draftClear===true,'PREPARATION_MISMATCH','Account, channel, draft or configuration did not match.',409);
        if(a.earlyPrepare){
          ensure(Number.isSafeInteger(message.cooldownMs)&&message.cooldownMs>=0&&message.cooldownMs<=31_536_000_000,'VALIDATION','A fresh Discord cooldown observation is required.');
          ensure(now()-a.createdAt<=MAX_PRE_ENTER_WAIT_MS,'PREPARATION_EXPIRED','Input preparation expired. Stop and inspect the preserved draft.',409);
          a.preparedObservedAt=now();
          const wait=Math.max(0,Math.max(g.nextMono||0,c.nextMono||0)-monotonicNow(),message.cooldownMs);
          if(wait>0){g.waitReason=message.cooldownMs>0?'discord_cooldown':'scheduled_input_ready';return{ok:true,permitIssued:false,retryAfterMs:Math.min(1000,Math.max(100,wait))};}
        }
        if(monotonicNow()<Math.max(g.nextMono||0,c.nextMono||0)){
          // Existing executors understand CONTROL and treat a thrown PREPARED
          // response as uncertain. Withhold the permit and wait for blocking proof.
          control(g,'pause',{systemReason:'interval_protection'});g.waitReason=(c.nextMono||0)>(g.nextMono||0)?'account_interval':'group_interval';
          event('delivery.interval_wait',{attemptId:a.id,groupId:g.id,instanceId:i.id,reasonCode:'INTERVAL_NOT_ELAPSED'});
          return{ok:true,permitIssued:false,reasonCode:'INTERVAL_NOT_ELAPSED'};
        }
        a.status='permitted';g.waitReason='awaiting_result';a.permitId=id();a.permittedAt=now();a.prepareDurationMs=Math.max(0,monotonicNow()-(a.readyMono??monotonicNow()));
        for(const cmd of state.commands.filter(cmd=>cmd.type==='PREPARE'&&cmd.payload.attemptId===a.id))cmd.status='completed';
        command('COMMIT_PERMIT',i.id,{...attemptPayload(a),permitId:a.permitId});event('delivery.permitted',{attemptId:a.id,groupId:g.id,instanceId:i.id});return{ok:true,permitId:a.permitId};
      }
      if(message.type==='DELIVERY_RESULT'){
        const a=get('attempts',message.attemptId);ensure(a.instanceId===i.id,'INSTANCE_MISMATCH','Attempt belongs to another instance.',409);
        ensure(['confirmed','not_sent','unknown'].includes(message.outcome),'VALIDATION','Invalid delivery outcome.');
        if(TERMINAL.has(a.status)){ensure(a.status===message.outcome,'RESULT_CONFLICT','Final outcome cannot be overwritten.',409);return{ok:true,attempt:publicAttempt(a)};}
        if(a.detached===true&&a.executionBlocked===true){event('delivery.detached_report',{attemptId:a.id,outcome:message.outcome});return{ok:true,attempt:publicAttempt(a)};}
        if(message.executionBlocked===true)a.executionBlocked=true;
        const reportedEvidence=deliveryEvidence(message.deliveryEvidence);
        if(!a.deliveryEvidence&&reportedEvidence)a.deliveryEvidence=reportedEvidence;
        if(message.outcome==='unknown'){
          const allowedReasons=new Set(['EXECUTION_STOPPED','RETRY_CANCELLED','RETRY_DELIVERY_AMBIGUOUS','DISCORD_SEND_FAILED','COMPOSER_EDITOR_MISSING','COMPOSER_EDITOR_CHANGED','COMPOSER_DRAFT_CHANGED','COMPOSER_STATE_UNREADABLE','MANAGED_DELAY_UNAVAILABLE','draft-retained','uncertain','no_response','content_unavailable','reconcile_inconclusive','TARGET_MISMATCH','ACCOUNT_UNVERIFIED','EDITOR_LOADING','EDITOR_AMBIGUOUS','DRAFT_MISMATCH','ATTACHMENT_OR_REPLY','HISTORY_LOADING','POSSIBLY_SENT','PREPARE_EDITOR_UNSTABLE','COMMIT_EDITOR_UNSTABLE','DELIVERY_DRAFT_RETAINED','DELIVERY_CONFIRMATION_TIMEOUT','CONTENT_EXCEPTION_BEFORE_ENTER','CONTENT_EXCEPTION_AFTER_ENTER','COOLDOWN_UNVERIFIED','COOLDOWN_WAIT_TIMEOUT','PRE_ENTER_WAIT_CANCELLED']);
          const reasonCode=allowedReasons.has(message.reasonCode)?message.reasonCode:'result_unknown';
          if(a.status!=='unknown')markUnknown(a,reasonCode);return{ok:true};
        }
        const group=state.groups.find(g=>g.id===a.groupId);
        const beforeEnter=reportedEvidence?.phase==='commit'&&['inspect','authorize','stable'].includes(reportedEvidence.stage)&&reportedEvidence.enterAttempted===false&&reportedEvidence.expectedDraftSubmitted!==true&&reportedEvidence.composerCleared!==true&&(reportedEvidence.retryCount||0)===0&&!(a.sendRetryCount>0);
        const retryUnsent=message.outcome==='not_sent'&&a.status==='permitted'&&a.sessionId===i.sessionId&&a.executionBlocked===true&&beforeEnter&&transientPreparationCodes.has(message.reasonCode)&&group?.status==='running'&&!group.controlIntent&&group.runId===a.runId&&group.activeAttemptId===a.id;
        if(message.outcome==='confirmed'){
          ensure(message.confirmationBasis===undefined||['message_observed','composer_cleared'].includes(message.confirmationBasis),'VALIDATION','Invalid delivery confirmation basis.');
          if(message.confirmationBasis==='composer_cleared'){
            // unknown 복구는 중앙이 발급한 현재 조회 명령에 대한 영수증만 받습니다.
            // 예전 미확인 시도에 새 입력창의 상태를 소급 적용하지 않습니다.
            const recovery=state.commands.find(c=>c.id===message.recoveryCommandId&&c.type==='RECONCILE'&&c.instanceId===i.id&&c.sessionId===i.sessionId&&c.payload.attemptId===a.id&&['queued','received'].includes(c.status));
            // 현재 통신 세션과 실제 제출의 원래 세션은 별개입니다. 재연결로
            // 제출 세션을 바꾸지 않고 현재 조회 명령에 묶인 원본 영수증만 복구합니다.
            const originalSession=typeof a.sessionId==='string'&&a.sessionId.length>0&&message.receiptOriginSessionId===a.sessionId&&recovery?.payload.originSessionId===a.sessionId;
            const sessionMatches=a.sessionId===i.sessionId||a.status==='unknown'&&a.executionBlocked===true&&recovery&&originalSession;
            ensure((a.status==='permitted'||a.status==='unknown'&&a.executionBlocked===true&&recovery)&&sessionMatches&&composerClearedEvidence(message.deliveryEvidence),'EVIDENCE_REQUIRED','A fresh submitted draft must clear in the same verified editor.');
          }else ensure(typeof message.messageId==='string'&&message.messageId.trim(),'EVIDENCE_REQUIRED','A confirmed post requires an observed message ID.');
        }
        else {
          ensure(a.executionBlocked===true,'EXECUTION_UNCERTAIN','The executor must confirm the old attempt is blocked.',409);
          // 새 입력 차단은 과거 Enter의 미발송 증거가 아닙니다. 모순된 결과는
          // 순서 진행/자동 재준비에 사용하지 않고 기존 시도를 보존합니다.
          ensure(reportedEvidence?.enterAttempted!==true,'EXECUTION_UNCERTAIN','An attempted submission cannot be declared unsent from execution blocking alone.',409);
          if(['deferred','blocked','COOLDOWN_UNVERIFIED','COOLDOWN_WAIT_TIMEOUT','PRE_ENTER_WAIT_CANCELLED'].includes(message.reasonCode))a.reasonCode=message.reasonCode;
          if(!retryUnsent&&['deferred','COOLDOWN_UNVERIFIED','COOLDOWN_WAIT_TIMEOUT'].includes(message.reasonCode)){const g=get('groups',a.groupId);if(!g.controlIntent&&!['stopped','paused'].includes(g.status)){g.status='needs_review';g.waitReason='discord_cooldown';}}
        }
        if(message.outcome==='confirmed'&&message.confirmationBasis==='composer_cleared')a.deliveryEvidence=deliveryEvidence(message.deliveryEvidence);
        const finished=finish(a,message.outcome,{messageId:message.outcome==='confirmed'?message.messageId:undefined,confirmationMs:message.confirmationMs,confirmationBasis:message.confirmationBasis});
        if(retryUnsent)schedulePreparationRetry(group,a,message.reasonCode);
        return{ok:true,attempt:publicAttempt(finished)};
      }
      if(message.type==='EMERGENCY_STOP'){
        for(const g of state.groups.filter(g=>g.members.some(m=>get('channels',m).instanceId===i.id)&&g.status!=='stopped'))control(g,'stop');event('instance.emergency_stop',{instanceId:i.id},'warning');return{ok:true};
      }
      throw new CentralError('UNKNOWN_MESSAGE','Unknown bridge message.');
    });
  }
  function clockGap(){const elapsed=monotonicNow()-lastMono;return elapsed>15000||elapsed<0||Math.abs((now()-lastWall)-elapsed)>2000;}
  function suspendForClockGap(){
    const wallDelta=now()-lastWall,monoDelta=monotonicNow()-lastMono;
    // Preserve the measured trigger; a scheduling delay is not proof of OS sleep.
    const clockDiagnostic={wallDeltaMs:Math.round(wallDelta),monotonicDeltaMs:Math.round(monoDelta),driftMs:Math.round(wallDelta-monoDelta),trigger:monoDelta<0?'monotonic_reversal':Math.abs(wallDelta-monoDelta)>2000?'clock_drift':'loop_delay'};
    state.service.clockDiagnostic=clockDiagnostic;
    state.service.status='ready';state.service.reasonCode='clock_or_sleep_gap';
    const affected=state.groups.filter(g=>g.status==='running'||g.activeAttemptId||g.autoResume);
    const resumable=new Set(affected.filter(g=>g.status==='running'&&!g.controlIntent).map(g=>g.id));
    for(const a of state.attempts.filter(a=>activeAttempt(a))){
      markUnknown(a,'clock_or_sleep_gap');
      // Keep the durable permit on the attempt, but stop transport retries.
      // Its outcome remains uncertain until executor reconciliation proves it.
      for(const c of state.commands.filter(c=>c.payload.attemptId===a.id&&['PREPARE','COMMIT_PERMIT'].includes(c.type)&&['queued','received'].includes(c.status)))c.status='superseded';
    }
    for(const g of affected){
      // 사용자가 요청한 중지는 시계 보호가 덮어쓰지 않습니다. 이미 보호 복구 중이면
      // 새 시계 기준으로 대기만 다시 시작하고 CONTROL 명령을 반복 발급하지 않습니다.
      if(!g.controlIntent&&(resumable.has(g.id)||g.autoResume))control(g,'pause',{systemReason:'clock_or_sleep_gap'});
      else if(g.autoResume){g.autoResume.requestedMono=monotonicNow();g.autoResume.retryAfterMono=monotonicNow()+3000;}
      g.waitReason=g.autoResume?'clock_or_sleep_gap':g.waitReason;g.nextEligibleAt=null;
    }
    // 간격 기준을 다시 만들되 이 호출에서는 재개하거나 밀린 발송을 승인하지 않습니다.
    // 후속 tick에서 현재 제어 적용·관찰·안정 시간이 확인된 그룹만 재개합니다.
    restoreConfirmedDeadlines();lastWall=now();lastMono=monotonicNow();
    event('service.resume_required',{reasonCode:'clock_or_sleep_gap',clockDiagnostic},'warning');
  }
  /**
   * 자동 재개는 시스템 보호 중단의 명시적 의도가 있는 그룹에만 허용합니다.
   * CONTROL 적용은 과거 발송 결과를 확정하지 않으므로 unknown/active가 하나라도
   * 남으면 대기합니다. 모든 멤버를 현재 세션에서 새로 관찰하고 설정 적용까지
   * 확인한 뒤 기존 start 경로로 잠금·새 runId를 확보합니다. 입력 재발급은 하지 않습니다.
   */
  function autoResumeGroups(){
    const mono=monotonicNow();
    for(const g of state.groups.filter(g=>g.autoResume)){
      const intent=g.autoResume;
      if(g.controlIntent||g.status!=='paused'||g.activeAttemptId||state.attempts.some(a=>a.groupId===g.id&&activeAttempt(a)))continue;
      if(mono<intent.retryAfterMono||mono-intent.requestedMono<3000)continue;
      const controls=state.commands.filter(c=>c.type==='CONTROL'&&c.payload.groupId===g.id&&c.payload.controlGeneration===g.controlGeneration&&c.status!=='superseded');
      const members=g.members.map(member=>get('channels',member));
      if(!controls.length||!controls.every(c=>c.status==='applied')||!members.every(c=>{
        const owner=get('instances',c.instanceId);
        return controls.some(cmd=>cmd.instanceId===owner.id&&cmd.sessionId===owner.sessionId)&&Number.isFinite(c.observedMono)&&c.observedMono>=intent.requestedMono&&mono-c.observedMono>=0&&mono-c.observedMono<=15000&&mono-(owner.stableSinceMono??mono)>=3000;
      }))continue;
      // 자원 경합은 정상적인 조건 대기이므로 실패 예산을 소모하지 않습니다.
      // tick마다 start를 호출하지 않고 3초 간격으로 잠금을 확인하며, 대기 상태가
      // 바뀔 때만 사건을 남깁니다. 경쟁 그룹이 종료되면 시간 경과와 무관하게 재개됩니다.
      const keys=resourceKeys(g);
      if(state.locks.some(lock=>keys.includes(lock.key)&&lock.groupId!==g.id)){
        if(g.waitReason!=='resource_busy')event('group.auto_resume_waiting',{groupId:g.id,reasonCode:'RESOURCE_BUSY'});
        g.waitReason='resource_busy';intent.retryAfterMono=mono+3000;continue;
      }
      // 연결/설정 대기는 예산을 소모하지 않습니다. 사전 검사 이후 예상하지 못한
      // start 오류는 최대 30초 간격으로 계속 확인하여 사용자 재개 조작을 기다리지 않습니다.
      try{members.forEach(eligibleChannel);}catch{continue;}
      try{
        start(g);event('group.auto_resumed',{groupId:g.id,reasonCode:intent.reasonCode});
      }catch(error){
        release(g);intent.retryCount=(intent.retryCount||0)+1;intent.retryAfterMono=mono+Math.min(30000,3000*2**Math.min(intent.retryCount,4));
        g.waitReason=error.code?.toLowerCase()||'resume_required';
        event('group.auto_resume_deferred',{groupId:g.id,reasonCode:error.code,retryCount:intent.retryCount},'warning');
      }
    }
  }
  /**
   * 런타임의 주기 호출로 연결 유효성·중지 완료·시도 제한시간·다음 차례를 검사합니다.
   * 실제 대기는 monotonic 시계를 사용하고 화면에 보여 줄 날짜는 wall clock으로 계산합니다.
   * 그룹 간격과 계정 간격을 모두 충족해야 하며, 조기 준비는 계정 대기 종료 최대 5초 전부터 가능합니다.
   * PREPARE를 큐에 넣는 단계이며 여기서 직접 Enter를 누르거나 다음 계정으로 넘어가지 않습니다.
   */
  function tick(){return transact(()=>{
    const wall=now(),mono=monotonicNow(),wallDelta=wall-lastWall,monoDelta=mono-lastMono;
    if(monoDelta>15000||monoDelta<0||Math.abs(wallDelta-monoDelta)>2000)suspendForClockGap();
    lastWall=wall;lastMono=mono;
    preserveAppliedUserStops();
    for(const g of state.groups.filter(g=>g.controlIntent)){recoverControl(g);controlComplete(g);}
    for(const i of state.instances.filter(i=>i.connected&&mono-(i.lastSeenMono??mono)>15000)){
      blockInstanceGroups(i.id,'connection_lost');i.connected=false;invalidateAccounts(i.id);for(const c of state.channels.filter(c=>c.instanceId===i.id))c.verified=false;
      for(const a of state.attempts.filter(a=>a.instanceId===i.id&&activeAttempt(a)))markUnknown(a,'connection_lost');
      if(state.groups.some(g=>g.status==='running'&&g.members.some(m=>get('channels',m).instanceId===i.id)))incident('connection_lost',{instanceId:i.id});
      event('instance.disconnected',{instanceId:i.id});
    }
    for(const i of state.instances.filter(i=>i.connected&&mono-(i.stableSinceMono??mono)>=30000)){
      for(const problem of state.incidents.filter(problem=>problem.status==='open'&&problem.instanceId===i.id&&problem.code==='connection_lost')){
        problem.status='resolved';problem.resolvedAt=now();event('incident.resolved',{incidentId:problem.id,instanceId:i.id,reasonCode:'connection_recovered'});
      }
    }
    for(const a of state.attempts.filter(a=>['preparing','permitted'].includes(a.status))){
      const absoluteWait=a.sendRetryCount?Infinity:MAX_PRE_ENTER_WAIT_MS;
      const stale=a.status==='preparing'&&a.earlyPrepare?wall-a.createdAt>MAX_PRE_ENTER_WAIT_MS||wall-(a.preparedObservedAt||a.createdAt)>30000:a.preEnterWaiting?wall-a.permittedAt>absoluteWait||wall-(a.preEnterWaitObservedAt||a.permittedAt)>30000:wall-a.permittedAt>absoluteWait||wall-(a.retryObservedAt||a.enterReadyAt||a.permittedAt||a.createdAt)>30000;
      if(stale&&!failPreparation(a,'PREPARE_TIMEOUT'))markUnknown(a,'result_timeout');
    }
    if(!state.lastPrunedAt||wall-state.lastPrunedAt>=86400000)pruneRecords();
    /**
     * 실행 종료가 확인된 미확인 시도만 읽기 전용으로 자동 대조합니다.
     * 같은 세션/탭/설정 연결이 유지된 경우에 한해 5~30초 간격으로 횟수 제한 없이 조회합니다.
     * 발송 실행 중인 시도나 교체된 탭을 건드리지 않고 PREPARE/Enter도 재발급하지 않습니다.
     */
    for(const a of state.attempts.filter(a=>a.status==='unknown'&&a.executionBlocked===true)){
      const owner=state.instances.find(i=>i.id===a.instanceId),channel=state.channels.find(c=>c.id===a.bindingId);
      if(!owner?.connected||now()-owner.lastSeenAt<0||now()-owner.lastSeenAt>15000||!channel?.verified||!Number.isInteger(channel.tabId)||channel.sessionId!==owner.sessionId||channel.accountId!==a.accountId||channel.guildId!==a.guildId||channel.channelId!==a.channelId)continue;
      // 읽기 전용 조회의 응답이 유실되어도 대기열에 영구히 묶이지 않습니다.
      for(const cmd of state.commands.filter(c=>c.type==='RECONCILE'&&c.payload.attemptId===a.id&&['queued','received'].includes(c.status)&&now()-c.createdAt>=30000))cmd.status='superseded';
      if(now()<(a.recoveryAfter||0)||state.commands.some(c=>c.type==='RECONCILE'&&c.payload.attemptId===a.id&&['queued','received'].includes(c.status)))continue;
      a.recoveryCount=(a.recoveryCount||0)+1;a.recoveryAfter=now()+Math.min(30000,5000*2**Math.min(3,Math.floor(a.recoveryCount/3)));
      command('RECONCILE',a.instanceId,{...attemptPayload(a),recoveryTabId:channel.tabId});
      event('delivery.recovery_requested',{attemptId:a.id,groupId:a.groupId,retryCount:a.recoveryCount});
    }
    // 자동 재검사도 수동 재검사와 같은 근거 규칙을 사용합니다.
    // 경고를 숨기거나 미확인 발송을 성공으로 바꾸지 않고, 후속 복구가 증명된 알림만 해결합니다.
    recheckIncidents(undefined,{automatic:true});
    if(state.service.status!=='ready')return{ok:true};
    autoResumeGroups();
    for(const g of state.groups.filter(g=>g.status==='running'&&!g.activeAttemptId&&!g.controlIntent)){
      const c=get('channels',g.members[g.cursor]);
      try{eligibleChannel(c);}catch(error){g.waitReason=error.code.toLowerCase();g.nextEligibleAt=null;continue;}
      if(monotonicNow()<(g.prepareRetryAfterMono||0)){g.waitReason='preparation_retry';g.nextEligibleAt=wall+(g.prepareRetryAfterMono-mono);continue;}
      const due=Math.max(g.nextMono||0,c.nextMono||0),earlyPrepare=get('instances',c.instanceId).capabilities?.includes('early-prepare-v1')===true;
      // 입력 준비는 실제 발송 가능 시각보다 최대 5초 앞서 진행합니다.
      // 그룹 간격과 계정 쿨다운은 PREPARED/Enter 승인에서 원래 시각까지 지킵니다.
      const prepareDue=due-(earlyPrepare?5000:0);
      if(mono<prepareDue){g.waitReason=(c.nextMono||0)>(g.nextMono||0)?'account_interval':'group_interval';g.nextEligibleAt=wall+(due-mono);continue;}
      const item=c.playlist[c.playlistIndex%c.playlist.length],m=get('messages',item.messageId),revision=m.revisions.find(r=>r.id===item.revisionId);
      const a={id:id(),groupId:g.id,runId:g.runId,bindingId:c.id,instanceId:c.instanceId,sessionId:get('instances',c.instanceId).sessionId,accountId:c.accountId,guildId:c.guildId,channelId:c.channelId,tabId:c.tabId,configVersion:c.configVersion,groupVersion:g.version,messageIdRef:m.id,messageName:m.name,revisionId:revision.id,revisionVersion:revision.version,body:revision.body,playlistIndex:c.playlistIndex,status:'preparing',createdAt:wall,readyMono:mono,earlyPrepare,executionBlocked:false,maxSendRetries:normalizeSendRetries()};
      state.attempts.push(a);g.activeAttemptId=a.id;g.waitReason='preparing';g.nextEligibleAt=null;command('PREPARE',c.instanceId,attemptPayload(a));event('delivery.preparing',{attemptId:a.id,groupId:g.id,instanceId:c.instanceId,accountId:c.accountId,channelId:c.channelId});
    }
    return{ok:true};
  });}
  function commands(instanceId,{pendingOnly=true}={}){const i=get('instances',instanceId);return clone(state.commands.filter(c=>c.instanceId===instanceId&&c.sessionId===i.sessionId&&(!pendingOnly||['queued','received'].includes(c.status))));}
  function publicAccount(a){const{sessionId,...dto}=a;const connected=currentAccount(a);return{...clone(dto),verified:connected,connected};}
  function publicInstance(i){const{sessionId,lastSeenMono,stableSinceMono,...dto}=i;return clone(dto);}
  function deadlineClock(){
    const wall=now(),mono=monotonicNow(),elapsed=mono-lastMono;
    return{wall,mono,safe:!readOnly&&Number.isFinite(wall)&&Number.isFinite(mono)&&elapsed>=0&&elapsed<=15000&&Math.abs((wall-lastWall)-elapsed)<=2000};
  }
  function channelNextEligibleAt(c,clock){
    if(!clock.safe||storageFailure||state.service.status!=='ready'||state.groups.some(g=>g.controlIntent&&g.members.includes(c.id))||state.attempts.some(a=>a.bindingId===c.id&&activeAttempt(a)))return null;
    try{eligibleChannel(c);}catch{return null;}
    const instance=state.instances.find(i=>i.id===c.instanceId);
    if(clock.wall<instance.lastSeenAt||c.nextMono!==undefined&&!Number.isFinite(c.nextMono))return null;
    return clock.wall+Math.max(0,(c.nextMono??clock.mono)-clock.mono);
  }
  function pageCode(c){
    const owner=state.instances.find(i=>i.id===c.instanceId);
    const a=owner?.connected&&c.sessionId===owner.sessionId&&state.attempts.findLast(a=>a.bindingId===c.id&&a.sessionId===c.sessionId&&a.tabId===c.tabId&&a.codeObservation);
    if(!a)return{state:'unknown'};
    const elapsed=now()-a.codeObservation.observedAt;
    return{state:elapsed>=0&&elapsed<=30000?'observed':'stale',...clone(a.codeObservation)};
  }
  function publicChannel(c,clock=deadlineClock()){const{sessionId,nextMono,lastConfirmedMono,intervalSyncBaseMs,...dto}=c;return {...clone(dto),pageCode:pageCode(c),minimumIntervalMs:minimumInterval(c),correctedBaseIntervalMs:correctedBaseInterval(c),cooldownCorrectionMs:cooldownCorrection(c),customExtraMs:customExtraInterval(c),effectiveIntervalMs:effectiveInterval(c),nextEligibleAt:channelNextEligibleAt(c,clock)};}
  function publicGroup(g,clock=deadlineClock()){
    const{nextMono,...dto}=g;let nextEligibleAt=null,nextPreparationAt=null;
    if(g.status==='running'&&!g.activeAttemptId&&!g.controlIntent){
      const channel=state.channels.find(c=>c.id===g.members[g.cursor]);
      const channelAt=channel?channelNextEligibleAt(channel,clock):null;
      if(channelAt!==null&&(nextMono===undefined||Number.isFinite(nextMono))){
        const groupAt=clock.wall+Math.max(0,(nextMono??clock.mono)-clock.mono);
        nextEligibleAt=Math.max(channelAt,groupAt);
        const lead=get('instances',channel.instanceId).capabilities?.includes('early-prepare-v1')===true?5000:0;
        nextPreparationAt=Math.max(clock.wall,nextEligibleAt-lead);
      }
    }
    return{...clone(dto),nextEligibleAt,nextPreparationAt};
  }
  function publicAttempt(a){const{sessionId,readyMono,preparedObservedAt,preEnterWaitObservedAt,permitId,...dto}=a;return {...clone(dto),bodyAvailable:typeof a.body==='string'};}
  function publicCommand(c){const{sessionId,payload,...dto}=c;const{body,items,permitId,originSessionId,...safe}=payload;return{...clone(dto),payload:clone(safe)};}
  function analytics({from=0,to=Number.MAX_SAFE_INTEGER,groupId,instanceId,accountId,channelId}={}){
    const matches=a=>!a.pruned&&(!groupId||a.groupId===groupId)&&(!instanceId||a.instanceId===instanceId)&&(!accountId||a.accountId===accountId)&&(!channelId||a.channelId===channelId);
    const attempts=state.attempts.filter(a=>a.createdAt>=from&&a.createdAt<=to&&matches(a)),confirmed=state.attempts.filter(a=>a.status==='confirmed'&&a.finalizedAt>=from&&a.finalizedAt<=to&&matches(a));
    const outcomes={confirmed:0,not_sent:0,cancelled:0,unknown:0,in_progress:0};for(const a of attempts)outcomes[activeAttempt(a)&&a.status!=='unknown'?'in_progress':a.status]++;
    const buckets=new Map();for(const a of confirmed){const at=Math.floor(a.finalizedAt/3600000)*3600000;const b=buckets.get(at)||{at,confirmed:0,manual:0,automatic:0};b.confirmed++;b[a.manual?'manual':'automatic']++;buckets.set(at,b);}
    const timings=attempts.filter(a=>Number.isFinite(a.confirmationMs)).map(a=>a.confirmationMs).sort((a,b)=>a-b),percentile=p=>timings.length?timings[Math.max(0,Math.ceil(timings.length*p)-1)]:null;
    const waitTotals=new Map();
    const spans=state.intervals.map(span=>({...span,from:Math.max(span.from,Number(from)||0),to:Math.min(span.to??now(),Number(to)||now())})).filter(span=>span.to>span.from);
    for(const span of spans.filter(span=>span.scope==='group'&&(!groupId||span.targetId===groupId))){
      if(['stopped','paused','stop_pending','pause_pending','running','preparing','awaiting_result'].includes(span.reason))continue;
      waitTotals.set(span.reason,(waitTotals.get(span.reason)||0)+span.to-span.from);
    }
    const waitReasons=[...waitTotals.entries()].map(([reason,durationMs])=>({reason,durationMs}));
    const connectionTimeline=spans.filter(span=>span.scope==='instance'&&(!instanceId||span.targetId===instanceId)).map(span=>({instanceId:span.targetId,from:span.from,to:span.to,status:span.reason}));
    return{from,to,partialRecords:!!state.prunedBefore&&from<state.prunedBefore,retainedFrom:state.prunedBefore||null,waitReasons,connectionTimeline,generatedAt:now(),lastEventId:state.lastEventId,total:attempts.length,confirmed:confirmed.length,outcomes,confirmedBuckets:[...buckets.values()].sort((a,b)=>a.at-b.at),confirmation:{samples:timings.length,p50:percentile(.5),p95:percentile(.95),insufficientSamples:timings.length<20},confirmationRate:outcomes.confirmed+outcomes.not_sent?outcomes.confirmed/(outcomes.confirmed+outcomes.not_sent):null,excludedFromRate:outcomes.cancelled+outcomes.unknown+outcomes.in_progress,timeline:attempts.slice(-200).map(publicAttempt)};
  }
  function historyPage({cursor,limit=100,from=0,to=Number.MAX_SAFE_INTEGER,status,query=''}={}){
    const size=Math.min(500,Math.max(1,Number(limit)||100)),q=String(query).toLocaleLowerCase(),items=[];
    let start=cursor?state.attempts.findIndex(a=>a.id===cursor)-1:state.attempts.length-1;
    for(let index=start;index>=0;index--){const a=state.attempts[index];if(a.pruned||a.createdAt<Number(from)||a.createdAt>Number(to)||status&&status!=='all'&&a.status!==status)continue;
      const account=state.accounts.find(account=>account.instanceId===a.instanceId&&account.accountId===a.accountId),group=state.groups.find(group=>group.id===a.groupId);
      if(q&&!`${a.id} ${a.accountId} ${account?.name||a.accountName||''} ${a.messageName||''} ${a.groupId} ${group?.name||a.groupName||''}`.toLocaleLowerCase().includes(q))continue;
      items.push(publicAttempt(a));if(items.length>size)break;
    }
    const hasMore=items.length>size;return{items:items.slice(0,size),nextCursor:hasMore?items[size-1].id:null,retentionDays:state.settings.retentionDays};
  }
  function supportData({attemptId,from=0,to=now()}={}){
    ensure(Number.isFinite(from)&&Number.isFinite(to)&&from>=0&&to>=from,'VALIDATION','보고서 조회 기간을 확인하세요.');
    const selected=attemptId?[get('attempts',attemptId)]:state.attempts.filter(a=>!a.pruned&&(a.createdAt>=from&&a.createdAt<=to||activeAttempt(a)));
    const contextFrom=attemptId&&from===0?Math.max(0,selected[0].createdAt-300000):from,contextTo=attemptId&&from===0?Math.min(to,(selected[0].finalizedAt||to)+120000):to;
    const attemptIds=new Set(selected.map(a=>a.id)),groupIds=new Set(selected.map(a=>a.groupId)),instanceIds=new Set(selected.map(a=>a.instanceId));
    const relatedCommands=state.commands.filter(c=>attemptIds.has(c.payload.attemptId)||!c.payload.attemptId&&c.createdAt>=contextFrom&&c.createdAt<=contextTo&&(!attemptId||groupIds.has(c.payload.groupId)||instanceIds.has(c.instanceId)));
    const commandIds=new Set(relatedCommands.map(c=>c.id)),importantEvents=supportRecordBuffer(),traceEvents=supportRecordBuffer();let after=0;
    // Retained unresolved attempts can predate a selected period. Include their
    // full attempt/command evidence as well as context within the selected period.
    // 보고서와 무관한 과거 이벤트를 매 배치마다 다시 정렬·해석하지 않습니다.
    // 저장소가 동일한 기간·시도·명령·맥락 조건으로 한 번 순회하며, 기간 밖에
    // 남아 있는 미해결 시도의 관련 근거도 포함합니다. 기록 예산은 그대로 적용합니다.
    for(const e of store.supportEvents({from:contextFrom,to:contextTo,attemptIds:[...attemptIds],commandIds:[...commandIds],groupIds:[...groupIds],instanceIds:[...instanceIds],attemptScoped:!!attemptId})){
      (e.type==='delivery.trace'?traceEvents:importantEvents).add(e);
    }
    const events=[...importantEvents.values(),...traceEvents.values()].sort((a,b)=>a.eventId-b.eventId);
    return{omittedEvents:importantEvents.omitted+traceEvents.omitted,contextFrom,contextTo,serverNow:now(),stateVersion:state.stateVersion,retainedFrom:state.prunedBefore||null,service:clone(state.service),settings:clone(state.settings),instances:state.instances.map(publicInstance),accounts:state.accounts.map(publicAccount),targets:clone(state.targets),channels:state.channels.map(c=>publicChannel(c)),groups:state.groups.map(g=>publicGroup(g)),attempts:selected.map(a=>({...publicAttempt(a),bodyAvailable:typeof a.body==='string'})),commands:relatedCommands.map(publicCommand),events,incidents:state.incidents.filter(i=>!attemptId||attemptIds.has(i.attemptId)||commandIds.has(i.commandId)||groupIds.has(i.groupId)||instanceIds.has(i.instanceId)).map(clone),intervals:state.intervals.filter(span=>(!attemptId||groupIds.has(span.targetId)||instanceIds.has(span.targetId))&&(span.to===null||span.to>=contextFrom)&&span.from<=contextTo).map(clone),locks:clone(state.locks)};
  }
  function configurationToken(){return createHash('sha256').update(JSON.stringify({settings:state.settings,...Object.fromEntries(['messages','channels','groups','instances','accounts','targets'].map(key=>[key,state[key].map(x=>({id:x.id,version:x.version,configVersion:x.configVersion}))]))})).digest('hex');}
  function snapshot(){const clock=deadlineClock();return{serverNow:clock.wall,configurationToken:configurationToken(),schemaVersion:state.schemaVersion,stateVersion:state.stateVersion,lastEventId:state.lastEventId,service:{...clone(state.service),...(storageFailure?{status:'storage_failure'}:{})},settings:clone(state.settings),messages:clone(state.messages),instances:state.instances.map(publicInstance),accounts:state.accounts.map(publicAccount),targets:clone(state.targets),channels:state.channels.map(c=>publicChannel(c,clock)),groups:state.groups.map(g=>publicGroup(g,clock)),attempts:state.attempts.filter((a,index)=>!a.pruned&&(activeAttempt(a)||index>=state.attempts.length-200)).map(publicAttempt),commands:state.commands.slice(-200).map(publicCommand),pendingTabCloses:state.removals.closeRequests.map(r=>{const instance=state.instances.find(i=>i.id===r.instanceId),cmd=state.commands.findLast(c=>c.type==='CLOSE_CHANNEL'&&c.payload.removalId===r.removalId);const{tabId,bindingId,retries,...dto}=r;return{...clone(dto),status:instance?.connected?(cmd?.status||'queued'):'offline',...(cmd?.rejectionCode?{rejectionCode:cmd.rejectionCode}:{})};}),incidents:clone(state.incidents),events:store.recent(100),analytics:analytics()};}
  if(loaded&&!readOnly)transact(()=>{
    // 과거 사용자별 횟수 제한은 폐기하되, 활성 시도의 누적 횟수·결과·
    // 잠금은 보존합니다. 바로 아래 재시작 절차에서 이전 실행을 차단하므로
    // 내부 계속 시도 정책으로의 이행이 과거 미확인 발송을 다시 보내지 않습니다.
    const hadRetryPreference=Object.hasOwn(state.settings,'maxSendRetries');
    delete state.settings.maxSendRetries;
    let normalizedAttempts=0;
    for(const a of state.attempts.filter(a=>activeAttempt(a))){
      if(a.maxSendRetries!==null){a.maxSendRetries=normalizeSendRetries();normalizedAttempts++;}
    }
    if(hadRetryPreference||normalizedAttempts)event('settings.retry_policy_migrated',{reasonCode:'CONTINUOUS_SEND_SEPARATE_ERROR_RECOVERY',maxSendRetries:null,prepareRetries:DEFAULT_PREPARE_RETRIES,normalizedAttempts});
    state.retryPolicyVersion=3;
    state.service={status:'ready',reasonCode:null,startedAt:now()};
    for(const span of state.intervals.filter(span=>span.to===null)){const old=span.scope==='instance'?state.instances.find(i=>i.id===span.targetId):null;const end=Math.max(span.from,Math.min(now(),old?.lastSeenAt||now()));span.to=end;if(end<now())state.intervals.push({id:id(),scope:span.scope,targetId:span.targetId,reason:'unobserved',from:end,to:now()});}
    for(const i of state.instances){invalidateAccounts(i.id);i.connected=false;i.sessionId=id();delete i.lastSeenMono;}
    for(const c of state.channels){c.verified=false;c.appliedVersion=0;delete c.tabId;delete c.sessionId;delete c.nextMono;delete c.lastConfirmedMono;}
    // 재시작은 사용자 중지가 아닙니다. 실행 의도가 있던 그룹만 보호 중단으로
    // 전환하고, 단조 시계·CONTROL은 새 프로세스/세션에서 다시 확보합니다.
    // 사용자 stop/pause는 복구 표식을 지우므로 이 경로에서 되살리지 않습니다.
    const resumeGroups=state.groups.filter(g=>g.enabled!==false&&(g.status==='running'||g.autoResume||!g.controlIntent&&g.reconcileResumeRunId===g.runId&&g.runId));
    for(const g of state.groups){delete g.autoResume;delete g.reconcileResumeRunId;delete g.nextMono;delete g.prepareRetryAfterMono;}
    for(const c of state.commands.filter(c=>['queued','received'].includes(c.status)))c.status='superseded';
    for(const g of resumeGroups)control(g,'pause',{systemReason:'service_restart'});
    // 이미 미확인인 시도의 원래 사유·사건·실행 차단 근거는 재시작으로
    // 덮어쓰지 않습니다. 진행 중이던 시도만 새로 미확인으로 전환합니다.
    for(const a of state.attempts.filter(a=>activeAttempt(a)&&a.status!=='unknown'))markUnknown(a,'service_restart');refreshMessageAssignments();restoreConfirmedDeadlines();event('service.started',{reasonCode:'groups_preserved'});
  });
  else if(!readOnly)transact(()=>{state.retryPolicyVersion=3;event('service.started');});
  return{execute,snapshot,bridge,tick,commands,analytics,exportBackup,importBackup,historyPage,supportData,eventPage:options=>({...store.eventPage(options),retentionDays:state.settings.retentionDays}),events:options=>store.events(options),subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},close(){if(!closed){closed=true;listeners.clear();store.close();}}};
}
