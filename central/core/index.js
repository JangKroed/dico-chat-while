import { randomUUID, createHash } from 'node:crypto';
import { CentralStore } from './store.js';
import { CentralError, requireValue as ensure, text, body, duration, tags, expected } from './validation.js';
export { CentralError } from './validation.js';

const ACTIVE = new Set(['preparing','permitted','unknown']);
const MAX_PRE_ENTER_WAIT_MS=21_630_000;
const TERMINAL = new Set(['confirmed','not_sent','cancelled']);
const id = () => randomUUID();
const verificationReasons=new Set(['awaiting_observation','connection_lost','session_changed','tab_missing','tab_loading','script_unavailable','account_mismatch','target_mismatch','identity_unverified','content_refresh_required','unknown']);
const verificationReason=value=>verificationReasons.has(value)?value:'identity_unverified';
const clone = value => structuredClone(value);
function deliveryEvidence(value){
  if(!value||typeof value!=='object'||!['prepare','commit','send'].includes(value.phase)||!['inspect','authorize','prepare','stable','enter','observe'].includes(value.stage)||typeof value.enterAttempted!=='boolean')return undefined;
  const result={phase:value.phase,stage:value.stage,enterAttempted:value.enterAttempted};
  for(const key of ['composerRetained','newMessage','matchingMessage','sendingSeen','failedSeen','authorMismatch','authorUnknown','timeMismatch'])if(typeof value[key]==='boolean')result[key]=value[key];
  return result;
}
const minimumInterval = c => (c.slowmodeMs||0)+3000;
const effectiveInterval = c => Math.max(c.intervalMs,minimumInterval(c));
const initial = at => ({schemaVersion:1,stateVersion:0,lastEventId:0,service:{status:'ready',startedAt:at},settings:{notificationsEnabled:false,notificationTypes:['delivery_unknown','connection_lost','account_mismatch','command_rejected','storage_failure'],retentionDays:90,hideNotificationNames:true,onboardingStep:0,cooldownMs:300000,notifyRecovery:false,quietHours:{enabled:false,start:'22:00',end:'08:00'}},messages:[],instances:[],accounts:[],targets:[],channels:[],groups:[],attempts:[],commands:[],incidents:[],locks:[],intervals:[]});

export function createCentralManager({databasePath=':memory:',now=Date.now,monotonicNow=()=>performance.now()}={}) {
  const store = new CentralStore(databasePath), listeners=new Set();
  let state=store.read(), closed=false, storageFailure=null, lastWall=now(), lastMono=monotonicNow();
  const loaded=!!state;state??=initial(now());state.intervals??=[];state.accounts??=[];state.targets??=[];for(const c of state.channels)initializeChannelInterval(c);
  const get=(list,key)=>{const item=state[list].find(x=>x.id===key);ensure(item,'NOT_FOUND',`${list} item not found.`,404);return item;};
  const event=(type,details={},level='info')=>{pending.push({type,level,at:now(),stateVersion:state.stateVersion,...details});};
  let pending=[];
  function transact(fn){
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
  function upsertAccount(instanceId,accountId,{verified=false,sessionId,observedAt=now()}={}){
    let account=state.accounts.find(a=>a.instanceId===instanceId&&a.accountId===accountId);
    if(!account){account={id:id(),instanceId,accountId,name:accountId,version:1,verified:false,createdAt:now(),updatedAt:now()};state.accounts.push(account);event('account.created',{accountEntityId:account.id,instanceId});}
    if(verified){account.verified=true;account.sessionId=sessionId;account.lastVerifiedAt=Math.max(account.lastVerifiedAt||0,observedAt);account.updatedAt=Math.max(account.updatedAt||0,observedAt);}
    return account;
  }
  function upsertTarget(guildId,channelId,name){
    let target=state.targets.find(t=>t.guildId===guildId&&t.channelId===channelId);
    if(!target){target={id:id(),guildId,channelId,url:`https://discord.com/channels/${guildId}/${channelId}`,name:name||channelId,version:1,createdAt:now(),updatedAt:now()};state.targets.push(target);event('target.created',{targetId:target.id});}
    return target;
  }
  function syncConnectionCatalog(){
    for(const c of state.channels){
      initializeChannelInterval(c);
      upsertAccount(c.instanceId,c.accountId,{verified:c.verified===true,sessionId:c.sessionId,observedAt:c.observedAt});
      upsertTarget(c.guildId,c.channelId,c.name);
    }
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
      removed++;return{id:a.id,status:a.status,instanceId:a.instanceId,createdAt:a.createdAt,finalizedAt:a.finalizedAt,manual:a.manual||false,permitIssued:!!a.permitId,pruned:true};
    });
    state.commands=state.commands.filter(c=>c.createdAt>=cutoff||['queued','received'].includes(c.status)||state.attempts.some(a=>ACTIVE.has(a.status)&&a.id===c.payload.attemptId));
    state.incidents=state.incidents.filter(i=>i.status==='open'||(i.resolvedAt||i.lastSeenAt)>=cutoff);
    state.intervals=state.intervals.filter(span=>span.to===null||span.to>=cutoff);
    state.prunedBefore=Math.max(state.prunedBefore||0,cutoff);state.lastPrunedAt=now();event('records.pruned',{cutoff,removedAttempts:removed});return{removedAttempts:removed,cutoff};
  }
  function command(type,instanceId,payload){
    const instance=get('instances',instanceId);
    const c={id:id(),type,instanceId,sessionId:instance.sessionId,status:'queued',createdAt:now(),payload:clone(payload)};
    state.commands.push(c);event('command.queued',{commandId:c.id,instanceId,groupId:payload.groupId,attemptId:payload.attemptId});return c;
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
    i={id:id(),key,code,status:'open',level:'error',createdAt:now(),lastSeenAt:now(),count:1,read:false,...details};state.incidents.push(i);event('incident.opened',{incidentId:i.id,reasonCode:code,...details},'error');return i;
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
      if((command?.type||i.commandType)==='CONTROL'&&(command?.payload.groupId||i.groupId)===groupId)resolveIncident(i,{groupId});
    }
  }
  function identityRecovered(problem){
    const instance=state.instances.find(i=>i.id===problem.instanceId);
    if(!instance?.connected||now()-instance.lastSeenAt>15000||now()<instance.lastSeenAt)return false;
    const group=state.groups.find(g=>g.id===problem.groupId);
    if(state.attempts.some(a=>ACTIVE.has(a.status)&&(a.instanceId===instance.id)&&(!group||a.groupId===group.id)))return false;
    const channels=state.channels.filter(c=>c.instanceId===instance.id&&(!problem.bindingId||c.id===problem.bindingId)&&(!group||group.members.includes(c.id)));
    const after=problem.lastSeenAt??problem.createdAt;
    return channels.length>0&&channels.every(c=>c.verified&&c.sessionId===instance.sessionId&&Number.isFinite(c.observedAt)&&c.observedAt>=after&&c.observedAt<=now()&&now()-c.observedAt<=15000);
  }
  function recheckIncidents(incidentId){
    const selected=incidentId===undefined?state.incidents:[get('incidents',incidentId)];
    let resolved=0;const blocked=[];
    for(const i of selected.filter(i=>i.status==='open')){
      const c=state.commands.find(c=>c.id===i.commandId),type=c?.type||i.commandType;
      const attemptId=c?.payload?.attemptId||i.attemptId,a=state.attempts.find(a=>a.id===attemptId);
      const groupId=c?.payload?.groupId||i.groupId||a?.groupId,g=state.groups.find(g=>g.id===groupId);
      let reasonCode=null,block='EVIDENCE_REQUIRED',message='해결을 확인할 기록이 부족합니다. 해당 알림의 안내를 확인하세요.',page='logs';
      if(a&&ACTIVE.has(a.status)){
        block='ATTEMPT_UNRESOLVED';message='전송 결과가 아직 확정되지 않았습니다. 기록에서 결과를 확인하세요.';page='history';
      }else if((i.code==='delivery_unknown'||i.code==='command_rejected'&&['PREPARE','COMMIT_PERMIT','RECONCILE'].includes(type))&&a&&TERMINAL.has(a.status)){
        reasonCode='terminal_attempt';
      }else if(['channel_unverified','account_mismatch'].includes(i.code)){
        if(identityRecovered(i))reasonCode='connection_reverified';
        else{block='CONNECTION_UNVERIFIED';message='해당 전송용 탭의 현재 계정·채널 확인이 필요합니다. 전송 창 보기로 상태를 확인하세요.';page='channels';}
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
      }else if(i.code==='command_rejected'&&type==='CONTROL'){
        const active=state.attempts.some(a=>a.groupId===groupId&&ACTIVE.has(a.status));
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
  function markUnknown(a,reasonCode){if(!ACTIVE.has(a.status))return;a.status='unknown';a.reasonCode=reasonCode;const g=get('groups',a.groupId);if(!g.controlIntent)g.status='needs_review';g.waitReason='delivery_unknown';incident('delivery_unknown',{attemptId:a.id,groupId:g.id,instanceId:a.instanceId});event('delivery.unknown',{attemptId:a.id,groupId:g.id,reasonCode},'error');}
  function release(g){state.locks=state.locks.filter(l=>l.groupId!==g.id);}
  function controlComplete(g){
    if(!g.controlIntent||g.activeAttemptId)return;
    const controls=state.commands.filter(c=>c.type==='CONTROL'&&c.payload.groupId===g.id&&c.payload.controlGeneration===g.controlGeneration&&c.status!=='superseded');
    if(controls.every(c=>c.status==='applied')){g.status=g.controlIntent==='stop'?'stopped':'paused';g.controlIntent=null;g.waitReason=null;release(g);resolveControlIncidents(g.id);event('group.control_applied',{groupId:g.id,status:g.status});}
  }
  function controlPayload(g,instanceId){
    const attempt=state.attempts.find(a=>a.id===g.activeAttemptId);
    return{action:g.controlIntent,groupId:g.id,runId:g.runId||null,controlGeneration:g.controlGeneration,attemptId:attempt?.instanceId===instanceId?attempt.id:null};
  }
  function control(g,intent){
    g.controlIntent=intent;g.controlGeneration=(g.controlGeneration||0)+1;g.status=intent==='stop'?'stop_pending':'pause_pending';g.nextEligibleAt=null;
    for(const instanceId of new Set(g.members.map(m=>get('channels',m).instanceId)))command('CONTROL',instanceId,controlPayload(g,instanceId));
    event(`group.${intent}_requested`,{groupId:g.id});controlComplete(g);
  }
  function blockInstanceGroups(instanceId,reasonCode){
    for(const g of state.groups.filter(g=>g.status==='running'&&g.members.some(m=>get('channels',m).instanceId===instanceId))){
      g.status=g.activeAttemptId?'needs_review':'resume_required';g.waitReason=reasonCode;g.nextEligibleAt=null;
      incident(reasonCode==='connection_lost'?'connection_lost':'account_mismatch',{instanceId});event('group.resume_required',{groupId:g.id,instanceId,reasonCode},'warning');
    }
  }
  function ensureSession(message,instanceId){const instance=get('instances',instanceId);ensure(instance.sessionId===message.sessionId,'STALE_SESSION','Session changed; reconnect and reconcile previous attempts.',409);if(!instance.connected)instance.stableSinceMono=monotonicNow();instance.lastSeenAt=now();instance.lastSeenMono=monotonicNow();instance.connected=true;return instance;}
  function validateMemberChannels(members){
    ensure(Array.isArray(members)&&members.length>=1&&members.length<=50&&new Set(members).size===members.length,'VALIDATION','Select 1–50 distinct channel connections.');
    const cs=members.map(m=>get('channels',m));ensure(cs.every(c=>c.channelId===cs[0].channelId&&c.guildId===cs[0].guildId),'CHANNEL_MISMATCH','Group members must belong to the same Discord channel.');
    ensure(new Set(cs.map(c=>c.accountId)).size===cs.length,'DUPLICATE_ACCOUNT','A Discord account may appear only once per group.');return cs;
  }
  function acquire(g){
    const keys=[`channel:${g.guildId}:${g.channelId}`,...g.members.map(m=>{const c=get('channels',m);return `account:${c.accountId}:${c.channelId}`;})];
    ensure(!state.locks.some(l=>keys.includes(l.key)&&l.groupId!==g.id),'RESOURCE_BUSY','This channel or account is already controlled by another group.',409);
    for(const key of keys)if(!state.locks.some(l=>l.key===key))state.locks.push({key,groupId:g.id});
  }
  function eligibleChannel(c){
    ensure(!state.commands.some(cmd=>cmd.type==='MANAGE_WINDOW'&&cmd.instanceId===c.instanceId&&cmd.payload.action==='consolidate'&&['queued','received'].includes(cmd.status)),'WINDOW_MANAGEMENT_PENDING','전송 창 정리가 끝난 뒤 실행하세요.',409);
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
    if(state.attempts.some(a=>a.bindingId===c.id&&ACTIVE.has(a.status))){
      c.intervalSyncBaseMs??=previous;
      if(value===c.intervalSyncBaseMs){delete c.pendingIntervalSync;delete c.intervalSyncBaseMs;}else c.pendingIntervalSync=true;
    }else commitIntervalConfiguration(c);
    if(c.lastConfirmedMono!==undefined)c.nextMono=Math.max(c.nextMono||0,c.lastConfirmedMono+effectiveInterval(c));
    event('channel.interval_updated',{channelId:c.id,intervalMode:c.intervalMode,intervalMs:c.intervalMs,pending:!!c.pendingIntervalSync});return true;
  }
  function applyPlaylist(c,items){
    c.playlist=items;c.playlistIndex=0;c.configVersion++;c.appliedVersion=0;c.version++;c.updatedAt=now();delete c.pendingIntervalSync;delete c.intervalSyncBaseMs;
    queueConfiguration(c);event('channel.playlist_applied',{channelId:c.id,configVersion:c.configVersion});
  }
  function finish(a,outcome,{messageId,manual=false,confirmationMs}={}){
    if(outcome==='confirmed')ensure(a.permitId||a.permitIssued,'PERMIT_REQUIRED','No commit permit was issued for this attempt.',409);
    if(TERMINAL.has(a.status)){ensure(a.status===outcome,'RESULT_CONFLICT','This attempt already has a different final result.',409);return a;}
    a.status=outcome;a.finalizedAt=now();a.manual=manual;if(messageId)a.messageId=text(messageId,'messageId',200);
    if(Number.isFinite(confirmationMs)&&confirmationMs>=0)a.confirmationMs=Math.min(confirmationMs,86_400_000);
    const g=get('groups',a.groupId),c=get('channels',a.bindingId);g.activeAttemptId=null;
    if(outcome==='confirmed'){
      g.cursor=(g.cursor+1)%g.members.length;g.lastConfirmedAt=now();g.nextMono=monotonicNow()+g.intervalMs;
      c.playlistIndex=(a.playlistIndex+1)%c.playlist.length;c.lastConfirmedAt=now();c.lastConfirmedMono=monotonicNow();c.nextMono=monotonicNow()+effectiveInterval(c);
    }
    for(const cmd of state.commands.filter(cmd=>cmd.payload.attemptId===a.id&&['PREPARE','COMMIT_PERMIT','RECONCILE'].includes(cmd.type)))cmd.status='completed';
    resolveIncidents(a.id);
    if(c.pendingPlaylist){applyPlaylist(c,c.pendingPlaylist);delete c.pendingPlaylist;}else if(c.pendingIntervalSync){c.version++;commitIntervalConfiguration(c);}
    if(g.controlIntent)controlComplete(g);else if(g.status==='needs_review'){g.status='paused';release(g);}
    event(`delivery.${outcome}`,{attemptId:a.id,groupId:g.id,instanceId:a.instanceId,accountId:a.accountId,channelId:a.channelId,manual});return a;
  }
  function start(g){
    ensure(!g.activeAttemptId,'ATTEMPT_UNRESOLVED','Resolve the current attempt before resuming.',409);
    ensure(!g.controlIntent,'CONTROL_PENDING','Wait for actual stop/pause acknowledgments.',409);
    acquire(g);g.members.map(m=>get('channels',m)).forEach(eligibleChannel);
    if(state.service.status==='resume_required'){
      state.service.status='ready';state.service.reasonCode=null;
      for(const x of state.groups)if(x.lastConfirmedAt)x.nextMono=monotonicNow()+x.intervalMs;
      for(const c of state.channels)if(c.lastConfirmedAt)c.nextMono=monotonicNow()+effectiveInterval(c);
    }
    ensure(state.service.status==='ready','SERVICE_STOPPED','Resume the central service before starting a group.',409);
    g.runId=id();g.status='running';g.waitReason=null;event('group.started',{groupId:g.id});return g;
  }
  function execute(action,p={}){return transact(()=>{
    switch(action){
      case 'message.create':{const at=now(),r={id:id(),version:1,body:body(p.body),at};const m={id:id(),name:text(p.name,'name'),tags:tags(p.tags),archived:false,version:1,revisionId:r.id,body:r.body,revisions:[r],createdAt:at,updatedAt:at};state.messages.push(m);event('message.created',{messageId:m.id});return m;}
      case 'message.update':{const m=get('messages',p.id);expected(m,p);if(p.name!==undefined)m.name=text(p.name,'name');if(p.tags!==undefined)m.tags=tags(p.tags);if(p.body!==undefined){const r={id:id(),version:m.revisions.length+1,body:body(p.body),at:now()};m.revisions.push(r);m.revisionId=r.id;m.body=r.body;}m.version++;m.updatedAt=now();event('message.updated',{messageId:m.id});return m;}
      case 'message.duplicate':{const original=get('messages',p.id),at=now(),r={id:id(),version:1,body:original.body,at};const m={...clone(original),id:id(),name:text(p.name||`${original.name.slice(0,190)} 복사`,'name'),version:1,archived:false,revisionId:r.id,revisions:[r],createdAt:at,updatedAt:at};state.messages.push(m);event('message.created',{messageId:m.id});return m;}
      case 'message.archive':{const m=get('messages',p.id);expected(m,p);m.archived=p.archived!==false;m.version++;event('message.archived',{messageId:m.id});return m;}
      case 'message.delete':{const m=get('messages',p.id);expected(m,p);ensure(!state.channels.some(c=>[...c.playlist,...(c.pendingPlaylist||[])].some(i=>i.messageId===m.id))&&!state.attempts.some(a=>a.messageIdRef===m.id&&ACTIVE.has(a.status)),'MESSAGE_IN_USE','This message is referenced. Archive it or remove its channel assignments.',409);state.messages=state.messages.filter(x=>x.id!==m.id);event('message.deleted',{messageId:m.id});return {id:m.id,deleted:true};}
      case 'instance.update':{const i=get('instances',p.id);expected(i,p);i.name=text(p.name,'name');i.nameCustomized=true;i.version++;event('instance.updated',{instanceId:i.id});return publicInstance(i);}
      case 'account.update':{const a=get('accounts',p.id);expected(a,p);a.name=text(p.name,'name');a.version++;a.updatedAt=now();event('account.updated',{accountEntityId:a.id,instanceId:a.instanceId});return publicAccount(a);}
      case 'target.create':{
        ensure(typeof p.url==='string'&&/^https:\/\/discord\.com\/channels\/\d{1,30}\/\d{1,30}\/?$/.test(p.url),'VALIDATION','Use a Discord server channel URL: https://discord.com/channels/server/channel.');
        const [,guildId,channelId]=/^https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/?$/.exec(p.url);
        return upsertTarget(guildId,channelId,p.name===undefined?undefined:text(p.name,'name'));
      }
      case 'channel.reveal':case 'channel.hide':case 'channel.consolidate':{
        const channel=get('channels',p.id),instance=get('instances',channel.instanceId);
        ensure(instance.connected&&now()-instance.lastSeenAt<=15000,'CONNECTION_LOST','Connect this browser first.',409);
        ensure(instance.capabilities?.includes('managed-window-v1'),'EXTENSION_UPDATE_REQUIRED','전송 창 관리를 지원하는 확장으로 업데이트하세요.',409);
        ensure(Number.isInteger(channel.tabId)&&channel.sessionId===instance.sessionId,'MANAGED_TAB_MISSING','기존 전송용 탭을 찾지 못했습니다. 채널 연결 상태를 확인하세요.',409);
        const windowAction=action.slice('channel.'.length);
        if(windowAction==='consolidate'){
          ensure(!state.attempts.some(a=>a.instanceId===instance.id&&ACTIVE.has(a.status)),'ATTEMPT_UNRESOLVED','발송을 중지하고 미확인 결과를 정리한 뒤 창을 모으세요.',409);
          ensure(state.groups.filter(g=>g.members.some(member=>get('channels',member).instanceId===instance.id)).every(g=>['stopped','paused'].includes(g.status)&&!g.controlIntent),'GROUP_RUNNING','해당 브라우저의 그룹을 중지한 뒤 창을 모으세요.',409);
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
        ensure(!state.attempts.some(a=>a.instanceId===instance.id&&a.guildId===target.guildId&&a.channelId===target.channelId&&ACTIVE.has(a.status)),'ATTEMPT_UNRESOLVED','Resolve the current attempt before opening this channel.',409);
        const channel=state.channels.find(c=>c.instanceId===instance.id&&c.accountId===account.accountId&&c.guildId===target.guildId&&c.channelId===target.channelId&&c.verified&&c.sessionId===instance.sessionId);
        if(channel)return{status:'connected',channel:publicChannel(channel)};
        ensure(instance.capabilities?.includes('open-channel-v1'),'EXTENSION_UPDATE_REQUIRED','채널을 연결하려면 중앙 관리 확장 프로그램을 최신 버전으로 업데이트하고 다시 연결하세요.',409);
        const pending=state.commands.find(c=>c.type==='OPEN_CHANNEL'&&c.instanceId===instance.id&&c.sessionId===instance.sessionId&&['queued','received','applied'].includes(c.status)&&c.payload.accountId===account.accountId&&c.payload.guildId===target.guildId&&c.payload.channelId===target.channelId);
        const queued=pending||command('OPEN_CHANNEL',instance.id,{accountId:account.accountId,guildId:target.guildId,channelId:target.channelId,accountEntityId:account.id,targetId:target.id});
        return{status:'pending',command:publicCommand(queued)};
      }
      case 'channel.update':{
        const c=get('channels',p.id);expected(c,p);ensure(!state.groups.some(g=>g.members.includes(c.id)&&(g.status==='running'||g.activeAttemptId)),'GROUP_RUNNING','Pause this channel’s group before editing.',409);
        if(p.name!==undefined)c.name=text(p.name,'name');
        if(p.intervalMode!==undefined||p.intervalMs!==undefined){
          const mode=p.intervalMode??'custom';ensure(['auto','custom'].includes(mode),'VALIDATION','간격 설정은 자동 또는 사용자 설정을 선택하세요.');
          const floor=minimumInterval(c),value=mode==='auto'?floor:duration(p.intervalMs??c.customIntervalMs??c.intervalMs);
          ensure(value>=floor,'INTERVAL_BELOW_SLOWMODE',`이 계정의 재전송 간격은 채널 슬로우 모드와 여유 3초를 포함해 최소 ${Math.ceil(floor/1000)}초여야 합니다.`);
          c.intervalMode=mode;if(mode==='custom')c.customIntervalMs=value;else delete c.customIntervalMs;
          setChannelInterval(c,value);
        }
        c.version++;event('channel.updated',{channelId:c.id});return publicChannel(c);
      }
      case 'channel.applyPlaylist':{const c=get('channels',p.id);expected(c,p);ensure(Array.isArray(p.items)&&p.items.length>=1&&p.items.length<=50,'VALIDATION','Select 1–50 messages.');const items=p.items.map(item=>{const m=get('messages',item.messageId);const revisionId=item.revisionId||m.revisionId;ensure(m.revisions.some(r=>r.id===revisionId),'VALIDATION','Message revision does not exist.');return{messageId:m.id,revisionId};});const active=state.attempts.find(a=>a.bindingId===c.id&&ACTIVE.has(a.status));ensure(active?.status!=='unknown','ATTEMPT_UNRESOLVED','Resolve the unknown attempt before applying messages.',409);
        if(active){c.pendingPlaylist=items;c.version++;control(get('groups',active.groupId),'pause');event('channel.playlist_pending',{channelId:c.id});}else applyPlaylist(c,items);return publicChannel(c);}
      case 'group.create':{const cs=validateMemberChannels(p.members);const g={id:id(),name:text(p.name,'name'),guildId:cs[0].guildId,channelId:cs[0].channelId,members:[...p.members],intervalMs:duration(p.intervalMs??60000),version:1,status:'stopped',cursor:0,activeAttemptId:null,waitReason:null,nextEligibleAt:null,createdAt:now()};state.groups.push(g);event('group.created',{groupId:g.id});return g;}
      case 'group.update':{const g=get('groups',p.id);expected(g,p);ensure(['stopped','paused'].includes(g.status)&&!g.activeAttemptId&&!g.controlIntent,'GROUP_RUNNING','Stop or pause and resolve pending attempts before editing.',409);if(p.members){const cs=validateMemberChannels(p.members);g.members=[...p.members];g.guildId=cs[0].guildId;g.channelId=cs[0].channelId;g.cursor=0;}if(p.name!==undefined)g.name=text(p.name,'name');if(p.intervalMs!==undefined)g.intervalMs=duration(p.intervalMs);g.version++;release(g);event('group.updated',{groupId:g.id});return g;}
      case 'group.delete':{const g=get('groups',p.id);expected(g,p);ensure(g.status==='stopped'&&!g.activeAttemptId&&!g.controlIntent,'GROUP_RUNNING','Stop this group before deleting it.',409);release(g);state.groups=state.groups.filter(x=>x.id!==g.id);event('group.deleted',{groupId:g.id});return{id:g.id,deleted:true};}
      case 'group.start':case 'group.resume':return start(get('groups',p.id));
      case 'group.pause':case 'group.stop':{const g=get('groups',p.id);control(g,action.endsWith('stop')?'stop':'pause');return g;}
      case 'service.startAll':{
        ensure(state.groups.length>0,'NO_GROUPS','먼저 발송 그룹을 만들어 주세요.',409);
        const candidates=state.groups.filter(g=>g.status!=='running');
        if(state.service.status==='stopped'){state.service.status='resume_required';}
        for(const g of candidates)start(g);
        event('service.started_all',{started:candidates.length,alreadyRunning:state.groups.length-candidates.length});
        return{started:candidates.length,alreadyRunning:state.groups.length-candidates.length};
      }
      case 'settings.reset':{
        ensure(p.confirmation==='RESET_ALL_SETTINGS','RESET_CONFIRMATION_REQUIRED','초기화 확인 문구가 필요합니다.');
        ensure(typeof p.expectedConfiguration==='string'&&p.expectedConfiguration===configurationToken(),'VERSION_CONFLICT','화면 상태가 변경되었습니다. 최신 상태를 확인한 뒤 다시 시도하세요.',409);
        ensure(!state.attempts.some(a=>ACTIVE.has(a.status)),'ATTEMPT_UNRESOLVED','진행 중 또는 미확인 발송을 먼저 확인하세요.',409);
        ensure(state.groups.every(g=>g.status==='stopped'&&!g.controlIntent&&!g.activeAttemptId),'GROUP_RUNNING','모든 그룹을 중지하고 중지 적용 완료를 확인하세요.',409);
        const removed={messages:state.messages.length,channels:state.channels.length,groups:state.groups.length,instances:state.instances.length,accounts:state.accounts.length,targets:state.targets.length};
        for(const c of state.commands)if(['queued','received'].includes(c.status))c.status='superseded';
        state.messages=[];state.channels=[];state.groups=[];state.instances=[];state.accounts=[];state.targets=[];state.locks=[];state.legacyImports=[];
        state.settings=initial(now()).settings;state.service.status='stopped';state.service.reasonCode='settings_reset';
        event('settings.reset',removed,'warning');return{reset:true,removed,historyPreserved:true};
      }
      case 'service.stopAll':state.service.status='stopped';for(const g of state.groups.filter(g=>g.status!=='stopped'||g.activeAttemptId))control(g,'stop');event('service.stopped');return state.service;
      case 'service.resume':state.service.status='ready';state.service.reasonCode=null;for(const g of state.groups)if(g.lastConfirmedAt)g.nextMono=monotonicNow()+g.intervalMs;for(const c of state.channels)if(c.lastConfirmedAt)c.nextMono=monotonicNow()+effectiveInterval(c);lastWall=now();lastMono=monotonicNow();event('service.resumed');return state.service;
      case 'attempt.resolve':{const a=get('attempts',p.id);ensure(p.outcome==='confirmed'||p.outcome==='not_sent','VALIDATION','Choose confirmed or not_sent.');if(p.outcome==='confirmed')ensure(p.messageId,'EVIDENCE_REQUIRED','Provide the observed Discord message ID.');else ensure(a.executionBlocked===true,'EXECUTION_UNCERTAIN','The executor must first confirm that the old attempt can no longer execute.',409);return finish(a,p.outcome,{messageId:p.messageId,manual:true});}
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
    ensure(!state.attempts.some(a=>ACTIVE.has(a.status)),'ATTEMPT_UNRESOLVED','Resolve all attempts before importing legacy settings.',409);
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
    if(p.notificationTypes!==undefined){const allowed=['delivery_unknown','connection_lost','account_mismatch','command_rejected','storage_failure','permit_delay'];ensure(Array.isArray(p.notificationTypes)&&p.notificationTypes.every(x=>allowed.includes(x)),'VALIDATION','Unknown notification type.');state.settings.notificationTypes=[...new Set(p.notificationTypes)];}
    if(p.quietHours!==undefined){const q=p.quietHours,hhmm=/^(?:[01]\d|2[0-3]):[0-5]\d$/;ensure(q&&typeof q.enabled==='boolean'&&hhmm.test(q.start)&&hhmm.test(q.end),'VALIDATION','Quiet hours require enabled and HH:mm start/end.');state.settings.quietHours={enabled:q.enabled,start:q.start,end:q.end};}
  }
  function exportBackup(){return clone({format:'dico-central-backup',version:1,createdAt:now(),settings:state.settings,messages:state.messages,
    instances:state.instances.map(i=>({id:i.id,name:i.name,browser:i.browser})),
    accounts:state.accounts.map(a=>({id:a.id,instanceId:a.instanceId,accountId:a.accountId,name:a.name})),
    targets:state.targets.map(t=>({id:t.id,url:t.url,guildId:t.guildId,channelId:t.channelId,name:t.name})),
    channels:state.channels.map(c=>({id:c.id,instanceId:c.instanceId,accountId:c.accountId,guildId:c.guildId,channelId:c.channelId,name:c.name,intervalMs:c.intervalMs,intervalMode:c.intervalMode,customIntervalMs:c.customIntervalMs,slowmodeMs:c.slowmodeMs,slowmodeObservedAt:c.slowmodeObservedAt,playlist:c.playlist,playlistIndex:c.playlistIndex})),
    groups:state.groups.map(g=>({id:g.id,name:g.name,members:g.members,intervalMs:g.intervalMs,cursor:g.cursor}))});}
  function restore(backup){
    ensure(!state.attempts.some(a=>ACTIVE.has(a.status)),'ATTEMPT_UNRESOLVED','Resolve every pending attempt before restoring a backup.',409);
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
      const playlist=c.playlist.map(item=>{const m=messages.find(m=>m.id===item.messageId);ensure(m&&m.revisions.some(r=>r.id===item.revisionId),'VALIDATION','Playlist references a missing message revision.');return{messageId:m.id,revisionId:item.revisionId};});
      if(c.intervalMode!==undefined)ensure(['auto','custom'].includes(c.intervalMode),'VALIDATION','Invalid interval mode.');
      if(c.customIntervalMs!==undefined)duration(c.customIntervalMs,'customIntervalMs');
      if(c.slowmodeObservedAt!==undefined)ensure(Number.isSafeInteger(c.slowmodeObservedAt)&&c.slowmodeObservedAt>=0,'VALIDATION','Invalid slowmode observation time.');
      return{id:text(c.id,'id',100),instanceId:c.instanceId,accountId:text(c.accountId,'accountId',100),guildId:text(c.guildId,'guildId',100),channelId:text(c.channelId,'channelId',100),name:text(c.name,'name'),intervalMs:duration(c.intervalMs),...(c.intervalMode?{intervalMode:c.intervalMode}:{}),...(c.customIntervalMs!==undefined?{customIntervalMs:c.customIntervalMs}:{}),...(c.slowmodeObservedAt!==undefined?{slowmodeObservedAt:c.slowmodeObservedAt}:{}),playlist,playlistIndex:Number.isSafeInteger(c.playlistIndex)&&c.playlistIndex>=0&&c.playlistIndex<playlist.length?c.playlistIndex:0,version:1,configVersion:1,appliedVersion:0,verified:false,slowmodeMs:duration(c.slowmodeMs??0,'slowmodeMs'),createdAt:at};
    });
    const accounts=(backup.accounts||[]).map(a=>{
      const instanceId=text(a.instanceId,'instanceId',100),accountId=text(a.accountId,'accountId',100);
      ensure(instances.some(i=>i.id===instanceId),'VALIDATION','Account references a missing browser.');
      // Existing v1 bindings may use legacy identity placeholders. Only those exact identities are grandfathered.
      ensure(/^\d{1,30}$/.test(accountId)||channels.some(c=>c.instanceId===instanceId&&c.accountId===accountId),'VALIDATION','Invalid Discord account ID.');
      return{id:text(a.id,'id',100),instanceId,accountId,name:text(a.name,'name'),version:1,verified:false,createdAt:at,updatedAt:at};
    });
    const targets=(backup.targets||[]).map(t=>{
      const guildId=text(t.guildId,'guildId',100),channelId=text(t.channelId,'channelId',100),url=text(t.url,'url',300);
      const numeric=/^\d{1,30}$/.test(guildId)&&/^\d{1,30}$/.test(channelId);
      const existing=channels.some(c=>c.guildId===guildId&&c.channelId===channelId);
      ensure((numeric||existing)&&url===`https://discord.com/channels/${guildId}/${channelId}`&&/^https:\/\/discord\.com\/channels\/(?:@me|[\w-]+)\/[\w-]+$/.test(url),'VALIDATION','Invalid Discord channel URL in backup.');
      return{id:text(t.id,'id',100),url,guildId,channelId,name:text(t.name,'name'),version:1,createdAt:at,updatedAt:at};
    });
    ensure(new Set(accounts.map(a=>JSON.stringify([a.instanceId,a.accountId]))).size===accounts.length,'VALIDATION','Duplicate account identities in backup.');
    ensure(new Set(targets.map(t=>JSON.stringify([t.guildId,t.channelId]))).size===targets.length,'VALIDATION','Duplicate channel targets in backup.');
    // All restored entities are built and validated before replacing current configuration.
    state.messages=messages;state.instances=instances;state.channels=channels;state.groups=[];state.accounts=accounts;state.targets=targets;
    for(const item of backup.groups){const cs=validateMemberChannels(item.members);state.groups.push({id:text(item.id,'id',100),name:text(item.name,'name'),members:[...item.members],guildId:cs[0].guildId,channelId:cs[0].channelId,intervalMs:duration(item.intervalMs),cursor:Number.isSafeInteger(item.cursor)&&item.cursor>=0&&item.cursor<cs.length?item.cursor:0,version:1,status:'stopped',activeAttemptId:null,waitReason:null,nextEligibleAt:null,createdAt:at});}
    for(const c of state.commands.filter(c=>['queued','received'].includes(c.status)))c.status='superseded';
    state.locks=[];state.service.status='resume_required';state.service.reasonCode='backup_restored';if(backup.settings)updateSettings(backup.settings);
    event('backup.restored',{messageCount:messages.length,channelCount:channels.length,groupCount:state.groups.length});return{restored:true,messageCount:messages.length,channelCount:channels.length,groupCount:state.groups.length};
  }
  function importBackup(backup){return transact(()=>restore(backup));}
  function attemptPayload(a){return{attemptId:a.id,groupId:a.groupId,runId:a.runId,bindingId:a.bindingId,accountId:a.accountId,guildId:a.guildId,channelId:a.channelId,tabId:a.tabId,configVersion:a.configVersion,body:a.body,revisionId:a.revisionId};}
  function bridge(message,instanceId){
    ensure(message&&typeof message==='object'&&!Array.isArray(message),'VALIDATION','Bridge message must be an object.');
    return transact(()=>{
      if(message.type==='HELLO'){
        ensure(message.protocolVersion===1,'PROTOCOL_MISMATCH','Update the extension to central protocol 1.',409);
        const capabilities=message.capabilities??[];ensure(Array.isArray(capabilities)&&capabilities.length<=32&&capabilities.every(value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)),'VALIDATION','Invalid extension capabilities.');
        let i=state.instances.find(i=>i.id===message.instanceId);
        if(!i){i={id:message.instanceId?text(message.instanceId,'instanceId',100):id(),version:1,name:text(message.name||'Connected browser','name'),browser:typeof message.browser==='string'?message.browser.slice(0,40):'Chromium',extensionVersion:typeof message.extensionVersion==='string'?message.extensionVersion.slice(0,40):'unknown',createdAt:now()};state.instances.push(i);}
        const automaticName=!i.nameCustomized&&['Connected browser','연결된 Chromium',`연결된 ${i.browser}`].includes(i.name);
        const browser=typeof message.browser==='string'&&message.browser.trim()?message.browser.trim().slice(0,40):i.browser;
        const extensionVersion=typeof message.extensionVersion==='string'&&message.extensionVersion.trim()?message.extensionVersion.trim().slice(0,40):i.extensionVersion;
        const name=automaticName?`연결된 ${browser}`:i.name;
        if(i.browser!==browser||i.extensionVersion!==extensionVersion||i.name!==name){i.browser=browser;i.extensionVersion=extensionVersion;i.name=name;i.version++;}
        i.capabilities=[...new Set(capabilities)];
        if(i.sessionId)blockInstanceGroups(i.id,'session_changed');
        for(const c of state.commands.filter(c=>c.instanceId===i.id&&(!['completed','applied','rejected'].includes(c.status)||c.type==='OPEN_CHANNEL'&&c.status==='applied')))c.status='superseded';
        invalidateAccounts(i.id);i.sessionId=id();i.connected=true;i.stableSinceMono=monotonicNow();i.lastSeenAt=now();i.lastSeenMono=monotonicNow();i.legacyFrozen=false;i.legacyPending=true;
        for(const c of state.channels.filter(c=>c.instanceId===i.id)){c.verified=false;c.verificationReason='session_changed';c.appliedVersion=0;delete c.tabId;}
        for(const a of state.attempts.filter(a=>a.instanceId===i.id&&ACTIVE.has(a.status))){markUnknown(a,'session_changed');command('RECONCILE',i.id,attemptPayload(a));}
        for(const g of state.groups.filter(g=>g.controlIntent&&g.members.some(m=>get('channels',m).instanceId===i.id)))command('CONTROL',i.id,controlPayload(g,i.id));
        event('instance.connected',{instanceId:i.id});return{instanceId:i.id,sessionId:i.sessionId,protocolVersion:1,commands:commands(i.id)};
      }
      const i=ensureSession(message,instanceId);
      if(message.type==='RECOVERY_STATUS')return{allowed:!state.attempts.some(a=>a.instanceId===i.id&&ACTIVE.has(a.status))};
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
        if(state.service.status!=='ready'||g.status!=='running'||g.controlIntent||g.activeAttemptId!==a.id||g.runId!==a.runId||c.configVersion!==a.configVersion||c.tabId!==a.tabId||now()-a.permittedAt>MAX_PRE_ENTER_WAIT_MS)return{allowed:false};
        try{eligibleChannel(c);}catch{return{allowed:false};}
        const waiting=message.cooldownMs>0,changed=Boolean(a.preEnterWaiting)!==waiting;
        a.preEnterWaiting=waiting;a.preEnterWaitObservedAt=now();
        if(!waiting)a.enterReadyAt=now();
        g.waitReason=waiting?'discord_cooldown':'awaiting_result';
        if(changed)event('delivery.pre_enter_wait',{attemptId:a.id,groupId:g.id,instanceId:i.id,waiting,cooldownMs:message.cooldownMs});
        return{allowed:true};
      }
      if(message.type==='AUTHORIZE_ENTER'){
        if(clockGap()){suspendForClockGap();lastWall=now();lastMono=monotonicNow();return{allowed:false};}
        const a=state.attempts.find(a=>a.id===message.attemptId&&a.instanceId===i.id);
        if(!a||a.status!=='permitted'||a.preEnterWaiting||a.sessionId!==i.sessionId||a.runId!==message.runId||a.configVersion!==message.configVersion)return{allowed:false};
        const g=state.groups.find(g=>g.id===a.groupId),c=state.channels.find(c=>c.id===a.bindingId);
        if(state.service.status!=='ready'||!g||g.status!=='running'||g.controlIntent||g.runId!==a.runId||g.activeAttemptId!==a.id||!c||c.configVersion!==a.configVersion||c.accountId!==a.accountId||c.guildId!==a.guildId||c.channelId!==a.channelId||c.tabId!==a.tabId)return{allowed:false};
        try{eligibleChannel(c);}catch{return{allowed:false};}
        if(monotonicNow()<Math.max(g.nextMono||0,c.nextMono||0))return{allowed:false};
        return{allowed:true};
      }

      if(message.type==='HEARTBEAT'){
        const requested=message.knownAttemptIds??[];ensure(Array.isArray(requested)&&requested.length<=500&&requested.every(value=>typeof value==='string'&&value.length<=100),'VALIDATION','knownAttemptIds must contain at most 500 identifiers.');
        const ids=new Set(requested),terminalAttempts=state.attempts.filter(a=>a.instanceId===i.id&&ids.has(a.id)&&TERMINAL.has(a.status)).map(a=>({attemptId:a.id,status:a.status,...(a.messageId?{messageId:a.messageId}:{})}));
        return{ok:true,commands:commands(i.id),terminalAttempts};
      }
      if(message.type==='DISCONNECT'){
        blockInstanceGroups(i.id,'connection_lost');i.connected=false;invalidateAccounts(i.id);for(const c of state.channels.filter(c=>c.instanceId===i.id))c.verified=false;
        for(const a of state.attempts.filter(a=>a.instanceId===i.id&&ACTIVE.has(a.status)))markUnknown(a,'connection_lost');
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
        const affected=accountId=>message.verified?accountId!==message.accountId:accountId===message.accountId;
        const transientReasons=new Set(['tab_loading','tab_missing','script_unavailable','identity_unverified','content_refresh_required','awaiting_observation']);
        const confirmedMismatch=message.verified===true||!transientReasons.has(message.verificationReason);
        const mismatched=state.accounts.some(a=>a.instanceId===i.id&&affected(a.accountId)&&a.verified)||state.channels.some(c=>c.instanceId===i.id&&affected(c.accountId)&&c.verified)||state.attempts.some(a=>a.instanceId===i.id&&affected(a.accountId)&&ACTIVE.has(a.status));
        for(const a of state.accounts.filter(a=>a.instanceId===i.id&&affected(a.accountId)))a.verified=false;
        for(const c of state.channels.filter(c=>c.instanceId===i.id&&affected(c.accountId))){c.verified=false;c.verificationReason=confirmedMismatch?'account_mismatch':verificationReason(message.verificationReason);}
        if(mismatched&&confirmedMismatch){
          blockInstanceGroups(i.id,'account_mismatch');
          for(const a of state.attempts.filter(a=>a.instanceId===i.id&&affected(a.accountId)&&ACTIVE.has(a.status)))markUnknown(a,'account_mismatch');
          incident('account_mismatch',{instanceId:i.id});
        }
        for(const c of state.commands.filter(c=>confirmedMismatch&&c.instanceId===i.id&&c.payload.accountId&&affected(c.payload.accountId)&&(['queued','received'].includes(c.status)||c.type==='OPEN_CHANNEL'&&c.status==='applied')&&['OPEN_CHANNEL','PREPARE','COMMIT_PERMIT'].includes(c.type)))c.status='superseded';
        const account=message.verified?upsertAccount(i.id,message.accountId,{verified:true,sessionId:i.sessionId}):state.accounts.find(a=>a.instanceId===i.id&&a.accountId===message.accountId);
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
          ensure(!state.attempts.some(a=>a.instanceId===i.id&&a.tabId===observed.tabId&&ACTIVE.has(a.status)&&(a.accountId!==accountId||a.channelId!==channelId||a.guildId!==guildId)),'TAB_BUSY','An unresolved attempt owns this execution tab.',409);
          let c=state.channels.find(c=>c.instanceId===i.id&&c.accountId===accountId&&c.guildId===guildId&&c.channelId===channelId);
          if(!c){const candidates=state.channels.filter(x=>x.legacyPlaceholder&&x.accountId===accountId&&x.guildId===guildId&&x.channelId===channelId);if(candidates.length===1&&i.legacyFrozen&&i.legacyPending===false){c=candidates[0];const previousInstance=c.instanceId;c.instanceId=i.id;c.legacyPlaceholder=false;c.version++;if(!state.channels.some(x=>x.instanceId===previousInstance)){
            state.instances=state.instances.filter(x=>x.id!==previousInstance);
            for(const old of state.accounts.filter(a=>a.instanceId===previousInstance)){
              const current=state.accounts.find(a=>a.instanceId===i.id&&a.accountId===old.accountId);
              if(current){if(current.name===current.accountId&&old.name!==old.accountId){current.name=old.name;current.version++;}state.accounts=state.accounts.filter(a=>a.id!==old.id);}
              else{old.instanceId=i.id;old.verified=false;old.version++;}
            }
          }event('legacy.bound',{channelId:c.id,instanceId:i.id});}}
          if(!c){c={id:id(),instanceId:i.id,accountId,guildId,channelId,name:typeof observed.name==='string'?observed.name.slice(0,200):channelId,version:1,configVersion:0,appliedVersion:0,playlist:[],playlistIndex:0,intervalMode:'auto',intervalMs:3000,slowmodeMs:0,createdAt:now()};state.channels.push(c);event('channel.discovered',{channelId:c.id,instanceId:i.id});}
          const tabChanged=c.tabId!==observed.tabId||c.sessionId!==i.sessionId;
          if(tabChanged&&state.attempts.some(a=>a.bindingId===c.id&&ACTIVE.has(a.status))){c.verified=false;for(const a of state.attempts.filter(a=>a.bindingId===c.id&&ACTIVE.has(a.status)))markUnknown(a,'execution_tab_changed');continue;}
          c.tabId=observed.tabId;c.sessionId=i.sessionId;c.verified=observed.verified===true;c.observedAt=now();if(c.verified)delete c.verificationReason;else c.verificationReason=verificationReason(observed.verificationReason);
          if(c.verified){
            upsertAccount(i.id,accountId,{verified:true,sessionId:i.sessionId});upsertTarget(guildId,channelId,c.name);
            for(const cmd of state.commands.filter(cmd=>cmd.type==='OPEN_CHANNEL'&&cmd.instanceId===i.id&&cmd.sessionId===i.sessionId&&['queued','received','applied'].includes(cmd.status)&&cmd.payload.accountId===accountId&&cmd.payload.guildId===guildId&&cmd.payload.channelId===channelId)){cmd.status='completed';cmd.completedAt=now();}
          }
          if(observed.slowmodeMs!==undefined){
            const previous=c.slowmodeMs;c.slowmodeMs=duration(observed.slowmodeMs,'slowmodeMs');c.slowmodeObservedAt=now();
            const interval=c.intervalMode==='auto'?minimumInterval(c):Math.max(c.customIntervalMs??c.intervalMs,minimumInterval(c));
            if(setChannelInterval(c,interval))c.version++;
            if(previous!==c.slowmodeMs)event('channel.slowmode_observed',{channelId:c.id,slowmodeMs:c.slowmodeMs,effectiveIntervalMs:effectiveInterval(c)});
          }
          if(c.verified&&c.playlist.length&&c.appliedVersion!==c.configVersion&&!state.attempts.some(a=>a.bindingId===c.id&&ACTIVE.has(a.status))&&!state.commands.some(cmd=>cmd.type==='CONFIG_SYNC'&&cmd.payload.bindingId===c.id&&cmd.payload.configVersion===c.configVersion&&cmd.sessionId===i.sessionId&&['queued','received'].includes(cmd.status))){
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
        if(['completed','superseded'].includes(c.status)||c.status==='applied'&&message.status==='received')return{ok:true};
        ensure(!(c.status==='rejected'&&message.status!=='rejected'),'COMMAND_REJECTED','Rejected command cannot later be applied.',409);
        c.status=message.status;c[`${message.status}At`]=now();
        if(message.status==='applied'&&c.type==='CONFIG_SYNC'){
          const channel=get('channels',c.payload.bindingId);if(channel.configVersion===c.payload.configVersion&&channel.sessionId===i.sessionId)channel.appliedVersion=c.payload.configVersion;
        }
        if(message.status==='applied'&&c.type==='CONTROL'){
          if(message.executionBlocked===true&&message.attemptId&&message.attemptId===c.payload.attemptId){const a=get('attempts',message.attemptId);ensure(a.instanceId===i.id,'INSTANCE_MISMATCH','Attempt belongs to another instance.');a.executionBlocked=true;
            if(a.status==='preparing')finish(a,'cancelled');
            else if(a.status==='unknown'&&!a.permitId&&!a.permitIssued)finish(a,'not_sent');
          }
          controlComplete(get('groups',c.payload.groupId));
        }
        if(message.status==='rejected'){
          const rejectionCode=typeof message.rejectionCode==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(message.rejectionCode)?message.rejectionCode:undefined;
          if(rejectionCode)c.rejectionCode=rejectionCode;else delete c.rejectionCode;
          incident('command_rejected',{instanceId:i.id,commandId:c.id,commandType:c.type,groupId:c.payload.groupId,...(c.payload.attemptId?{attemptId:c.payload.attemptId}:{}),...(rejectionCode?{rejectionCode}:{})});
          if(c.payload.attemptId){const a=get('attempts',c.payload.attemptId);if(ACTIVE.has(a.status))markUnknown(a,rejectionCode||'command_rejected');}
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
          control(g,'pause');g.waitReason=(c.nextMono||0)>(g.nextMono||0)?'account_interval':'group_interval';
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
        if(message.executionBlocked===true)a.executionBlocked=true;
        if(!a.deliveryEvidence){const evidence=deliveryEvidence(message.deliveryEvidence);if(evidence)a.deliveryEvidence=evidence;}
        if(message.outcome==='unknown'){
          const allowedReasons=new Set(['draft-retained','uncertain','no_response','content_unavailable','reconcile_inconclusive','TARGET_MISMATCH','ACCOUNT_UNVERIFIED','EDITOR_LOADING','EDITOR_AMBIGUOUS','DRAFT_MISMATCH','ATTACHMENT_OR_REPLY','HISTORY_LOADING','POSSIBLY_SENT','PREPARE_EDITOR_UNSTABLE','COMMIT_EDITOR_UNSTABLE','DELIVERY_DRAFT_RETAINED','DELIVERY_CONFIRMATION_TIMEOUT','CONTENT_EXCEPTION_BEFORE_ENTER','CONTENT_EXCEPTION_AFTER_ENTER','COOLDOWN_UNVERIFIED','COOLDOWN_WAIT_TIMEOUT','PRE_ENTER_WAIT_CANCELLED']);
          const reasonCode=allowedReasons.has(message.reasonCode)?message.reasonCode:'result_unknown';
          if(a.status!=='unknown')markUnknown(a,reasonCode);return{ok:true};
        }
        if(message.outcome==='confirmed')ensure(typeof message.messageId==='string'&&message.messageId.trim(),'EVIDENCE_REQUIRED','A confirmed post requires an observed message ID.');
        else {
          ensure(a.executionBlocked===true,'EXECUTION_UNCERTAIN','The executor must confirm the old attempt is blocked.',409);
          if(['deferred','blocked','COOLDOWN_UNVERIFIED','COOLDOWN_WAIT_TIMEOUT','PRE_ENTER_WAIT_CANCELLED'].includes(message.reasonCode))a.reasonCode=message.reasonCode;
          if(['deferred','COOLDOWN_UNVERIFIED','COOLDOWN_WAIT_TIMEOUT'].includes(message.reasonCode)){const g=get('groups',a.groupId);if(!g.controlIntent){g.status='needs_review';g.waitReason='discord_cooldown';}}
        }
        return{ok:true,attempt:publicAttempt(finish(a,message.outcome,{messageId:message.outcome==='confirmed'?message.messageId:undefined,confirmationMs:message.confirmationMs}))};
      }
      if(message.type==='EMERGENCY_STOP'){
        for(const g of state.groups.filter(g=>g.members.some(m=>get('channels',m).instanceId===i.id)&&g.status!=='stopped'))control(g,'stop');event('instance.emergency_stop',{instanceId:i.id},'warning');return{ok:true};
      }
      throw new CentralError('UNKNOWN_MESSAGE','Unknown bridge message.');
    });
  }
  function clockGap(){const elapsed=monotonicNow()-lastMono;return elapsed>15000||elapsed<0||Math.abs((now()-lastWall)-elapsed)>2000;}
  function suspendForClockGap(){
    state.service.status='resume_required';state.service.reasonCode='clock_or_sleep_gap';
    const affected=state.groups.filter(g=>g.status==='running'||g.activeAttemptId);
    for(const a of state.attempts.filter(a=>ACTIVE.has(a.status))){
      markUnknown(a,'clock_or_sleep_gap');
      // Keep the durable permit on the attempt, but stop transport retries.
      // Its outcome remains uncertain until executor reconciliation proves it.
      for(const c of state.commands.filter(c=>c.payload.attemptId===a.id&&['PREPARE','COMMIT_PERMIT'].includes(c.type)&&['queued','received'].includes(c.status)))c.status='superseded';
    }
    for(const g of affected){if(!g.controlIntent)control(g,'pause');g.waitReason='manual_resume';g.nextEligibleAt=null;}
    event('service.resume_required',{reasonCode:'clock_or_sleep_gap'},'warning');
  }
  function tick(){return transact(()=>{
    const wall=now(),mono=monotonicNow(),wallDelta=wall-lastWall,monoDelta=mono-lastMono;
    if(monoDelta>15000||monoDelta<0||Math.abs(wallDelta-monoDelta)>2000)suspendForClockGap();
    lastWall=wall;lastMono=mono;
    for(const i of state.instances.filter(i=>i.connected&&mono-(i.lastSeenMono??mono)>15000)){
      blockInstanceGroups(i.id,'connection_lost');i.connected=false;invalidateAccounts(i.id);for(const c of state.channels.filter(c=>c.instanceId===i.id))c.verified=false;
      for(const a of state.attempts.filter(a=>a.instanceId===i.id&&ACTIVE.has(a.status)))markUnknown(a,'connection_lost');
      if(state.groups.some(g=>g.status==='running'&&g.members.some(m=>get('channels',m).instanceId===i.id)))incident('connection_lost',{instanceId:i.id});
      event('instance.disconnected',{instanceId:i.id});
    }
    for(const i of state.instances.filter(i=>i.connected&&mono-(i.stableSinceMono??mono)>=30000)){
      for(const problem of state.incidents.filter(problem=>problem.status==='open'&&problem.instanceId===i.id&&problem.code==='connection_lost')){
        problem.status='resolved';problem.resolvedAt=now();event('incident.resolved',{incidentId:problem.id,instanceId:i.id,reasonCode:'connection_recovered'});
      }
    }
    for(const a of state.attempts.filter(a=>['preparing','permitted'].includes(a.status))){
      const stale=a.status==='preparing'&&a.earlyPrepare?wall-a.createdAt>MAX_PRE_ENTER_WAIT_MS||wall-(a.preparedObservedAt||a.createdAt)>30000:a.preEnterWaiting?wall-a.permittedAt>MAX_PRE_ENTER_WAIT_MS||wall-(a.preEnterWaitObservedAt||a.permittedAt)>30000:wall-(a.enterReadyAt||a.permittedAt||a.createdAt)>30000;
      if(stale)markUnknown(a,'result_timeout');
    }
    if(!state.lastPrunedAt||wall-state.lastPrunedAt>=86400000)pruneRecords();
    if(state.service.status!=='ready')return{ok:true};
    for(const g of state.groups.filter(g=>g.status==='running'&&!g.activeAttemptId&&!g.controlIntent)){
      const c=get('channels',g.members[g.cursor]);
      try{eligibleChannel(c);}catch(error){g.waitReason=error.code.toLowerCase();g.nextEligibleAt=null;continue;}
      const due=Math.max(g.nextMono||0,c.nextMono||0),earlyPrepare=get('instances',c.instanceId).capabilities?.includes('early-prepare-v1')===true;
      if(mono<due-(earlyPrepare?5000:0)){g.waitReason=(c.nextMono||0)>(g.nextMono||0)?'account_interval':'group_interval';g.nextEligibleAt=wall+(due-mono);continue;}
      const item=c.playlist[c.playlistIndex%c.playlist.length],m=get('messages',item.messageId),revision=m.revisions.find(r=>r.id===item.revisionId);
      const a={id:id(),groupId:g.id,runId:g.runId,bindingId:c.id,instanceId:c.instanceId,sessionId:get('instances',c.instanceId).sessionId,accountId:c.accountId,guildId:c.guildId,channelId:c.channelId,tabId:c.tabId,configVersion:c.configVersion,groupVersion:g.version,messageIdRef:m.id,messageName:m.name,revisionId:revision.id,revisionVersion:revision.version,body:revision.body,playlistIndex:c.playlistIndex,status:'preparing',createdAt:wall,readyMono:mono,earlyPrepare,executionBlocked:false};
      state.attempts.push(a);g.activeAttemptId=a.id;g.waitReason='preparing';g.nextEligibleAt=null;command('PREPARE',c.instanceId,attemptPayload(a));event('delivery.preparing',{attemptId:a.id,groupId:g.id,instanceId:c.instanceId,accountId:c.accountId,channelId:c.channelId});
    }
    return{ok:true};
  });}
  function commands(instanceId,{pendingOnly=true}={}){const i=get('instances',instanceId);return clone(state.commands.filter(c=>c.instanceId===instanceId&&c.sessionId===i.sessionId&&(!pendingOnly||['queued','received'].includes(c.status))));}
  function publicAccount(a){const{sessionId,...dto}=a;const connected=currentAccount(a);return{...clone(dto),verified:connected,connected};}
  function publicInstance(i){const{sessionId,lastSeenMono,stableSinceMono,...dto}=i;return clone(dto);}
  function deadlineClock(){
    const wall=now(),mono=monotonicNow(),elapsed=mono-lastMono;
    return{wall,mono,safe:Number.isFinite(wall)&&Number.isFinite(mono)&&elapsed>=0&&elapsed<=15000&&Math.abs((wall-lastWall)-elapsed)<=2000};
  }
  function channelNextEligibleAt(c,clock){
    if(!clock.safe||storageFailure||state.service.status!=='ready'||state.attempts.some(a=>a.bindingId===c.id&&ACTIVE.has(a.status)))return null;
    try{eligibleChannel(c);}catch{return null;}
    const instance=state.instances.find(i=>i.id===c.instanceId);
    if(clock.wall<instance.lastSeenAt||c.nextMono!==undefined&&!Number.isFinite(c.nextMono))return null;
    return clock.wall+Math.max(0,(c.nextMono??clock.mono)-clock.mono);
  }
  function publicChannel(c,clock=deadlineClock()){const{sessionId,nextMono,lastConfirmedMono,intervalSyncBaseMs,...dto}=c;return {...clone(dto),minimumIntervalMs:minimumInterval(c),effectiveIntervalMs:effectiveInterval(c),nextEligibleAt:channelNextEligibleAt(c,clock)};}
  function publicGroup(g,clock=deadlineClock()){
    const{nextMono,...dto}=g;let nextEligibleAt=null;
    if(g.status==='running'&&!g.activeAttemptId&&!g.controlIntent){
      const channel=state.channels.find(c=>c.id===g.members[g.cursor]);
      const channelAt=channel?channelNextEligibleAt(channel,clock):null;
      if(channelAt!==null&&(nextMono===undefined||Number.isFinite(nextMono)))nextEligibleAt=Math.max(channelAt,clock.wall+Math.max(0,(nextMono??clock.mono)-clock.mono));
    }
    return{...clone(dto),nextEligibleAt};
  }
  function publicAttempt(a){const{sessionId,body,readyMono,preparedObservedAt,preEnterWaitObservedAt,permitId,...dto}=a;return clone(dto);}
  function publicCommand(c){const{sessionId,payload,...dto}=c;const{body,items,permitId,...safe}=payload;return{...clone(dto),payload:clone(safe)};}
  function analytics({from=0,to=Number.MAX_SAFE_INTEGER,groupId,instanceId,accountId,channelId}={}){
    const matches=a=>!a.pruned&&(!groupId||a.groupId===groupId)&&(!instanceId||a.instanceId===instanceId)&&(!accountId||a.accountId===accountId)&&(!channelId||a.channelId===channelId);
    const attempts=state.attempts.filter(a=>a.createdAt>=from&&a.createdAt<=to&&matches(a)),confirmed=state.attempts.filter(a=>a.status==='confirmed'&&a.finalizedAt>=from&&a.finalizedAt<=to&&matches(a));
    const outcomes={confirmed:0,not_sent:0,cancelled:0,unknown:0,in_progress:0};for(const a of attempts)outcomes[ACTIVE.has(a.status)&&a.status!=='unknown'?'in_progress':a.status]++;
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
  function configurationToken(){return createHash('sha256').update(JSON.stringify({settings:state.settings,...Object.fromEntries(['messages','channels','groups','instances','accounts','targets'].map(key=>[key,state[key].map(x=>({id:x.id,version:x.version,configVersion:x.configVersion}))]))})).digest('hex');}
  function snapshot(){const clock=deadlineClock();return{serverNow:clock.wall,configurationToken:configurationToken(),schemaVersion:state.schemaVersion,stateVersion:state.stateVersion,lastEventId:state.lastEventId,service:{...clone(state.service),...(storageFailure?{status:'storage_failure'}:{})},settings:clone(state.settings),messages:clone(state.messages),instances:state.instances.map(publicInstance),accounts:state.accounts.map(publicAccount),targets:clone(state.targets),channels:state.channels.map(c=>publicChannel(c,clock)),groups:state.groups.map(g=>publicGroup(g,clock)),attempts:state.attempts.filter(a=>!a.pruned).slice(-200).map(publicAttempt),commands:state.commands.slice(-200).map(publicCommand),incidents:clone(state.incidents),events:store.recent(100),analytics:analytics()};}
  if(loaded)transact(()=>{
    state.service={status:'resume_required',reasonCode:'service_restart',startedAt:now()};
    for(const span of state.intervals.filter(span=>span.to===null)){const old=span.scope==='instance'?state.instances.find(i=>i.id===span.targetId):null;const end=Math.max(span.from,Math.min(now(),old?.lastSeenAt||now()));span.to=end;if(end<now())state.intervals.push({id:id(),scope:span.scope,targetId:span.targetId,reason:'unobserved',from:end,to:now()});}
    for(const i of state.instances){invalidateAccounts(i.id);i.connected=false;i.sessionId=id();delete i.lastSeenMono;}
    for(const c of state.channels){c.verified=false;c.appliedVersion=0;delete c.tabId;delete c.sessionId;delete c.nextMono;delete c.lastConfirmedMono;}
    for(const g of state.groups){delete g.nextMono;if(g.status==='running')g.status='resume_required';}
    for(const c of state.commands.filter(c=>['queued','received'].includes(c.status)))c.status='superseded';
    for(const a of state.attempts.filter(a=>ACTIVE.has(a.status)))markUnknown(a,'service_restart');event('service.started',{reasonCode:'manual_resume_required'});
  });
  else transact(()=>event('service.started'));
  return{execute,snapshot,bridge,tick,commands,analytics,exportBackup,importBackup,events:options=>store.events(options),subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},close(){if(!closed){closed=true;listeners.clear();store.close();}}};
}
