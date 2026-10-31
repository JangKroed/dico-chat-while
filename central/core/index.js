import { randomUUID, createHash } from 'node:crypto';
import { CentralStore } from './store.js';
import { CentralError, requireValue as ensure, text, body, duration, tags, expected } from './validation.js';
export { CentralError } from './validation.js';

const ACTIVE = new Set(['preparing','permitted','unknown']);
const TERMINAL = new Set(['confirmed','not_sent','cancelled']);
const id = () => randomUUID();
const clone = value => structuredClone(value);
const effectiveInterval = c => Math.max(c.intervalMs, c.slowmodeMs>0?c.slowmodeMs+3000:0);
const initial = at => ({schemaVersion:1,stateVersion:0,lastEventId:0,service:{status:'ready',startedAt:at},settings:{notificationsEnabled:false,notificationTypes:['delivery_unknown','connection_lost','account_mismatch','command_rejected','storage_failure'],retentionDays:90,hideNotificationNames:true,onboardingStep:0,cooldownMs:300000,notifyRecovery:false,quietHours:{enabled:false,start:'22:00',end:'08:00'}},messages:[],instances:[],channels:[],groups:[],attempts:[],commands:[],incidents:[],locks:[],intervals:[]});

export function createCentralManager({databasePath=':memory:',now=Date.now,monotonicNow=()=>performance.now()}={}) {
  const store = new CentralStore(databasePath), listeners=new Set();
  let state=store.read(), closed=false, storageFailure=null, lastWall=now(), lastMono=monotonicNow();
  const loaded=!!state;state??=initial(now());state.intervals??=[];
  const get=(list,key)=>{const item=state[list].find(x=>x.id===key);ensure(item,'NOT_FOUND',`${list} item not found.`,404);return item;};
  const event=(type,details={},level='info')=>{pending.push({type,level,at:now(),stateVersion:state.stateVersion,...details});};
  let pending=[];
  function transact(fn){
    ensure(!closed,'CLOSED','Central manager is closed.',503);ensure(!storageFailure,'STORAGE_FAILURE','Storage failed. New commands are blocked.',503);
    const before=state;state=clone(state);state.stateVersion++;pending=[];
    let result;
    try {result=fn();recordIntervals();}catch(error){state=before;pending=[];throw error;}
    let committed;
    try{committed=store.commit(state,pending);}catch(error){state=before;storageFailure=error;throw new CentralError('STORAGE_FAILURE','Could not durably save the operation; execution is blocked.',503);}
    pending=[];for(const e of committed)for(const listener of listeners){try{listener(clone(e));}catch{ /* observers cannot undo a committed operation */ }}
    return result===undefined?undefined:clone(result);
  }
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
    const key=[code,details.attemptId||details.instanceId||details.groupId||'service'].join(':');
    let i=state.incidents.find(i=>i.key===key&&i.status==='open');
    if(i){i.count++;i.lastSeenAt=now();return i;}
    i={id:id(),key,code,status:'open',level:'error',createdAt:now(),lastSeenAt:now(),count:1,read:false,...details};state.incidents.push(i);event('incident.opened',{incidentId:i.id,reasonCode:code,...details},'error');return i;
  }
  function resolveIncidents(attemptId){for(const i of state.incidents.filter(i=>i.attemptId===attemptId&&i.status==='open')){i.status='resolved';i.resolvedAt=now();event('incident.resolved',{incidentId:i.id,attemptId});}}
  function markUnknown(a,reasonCode){if(!ACTIVE.has(a.status))return;a.status='unknown';a.reasonCode=reasonCode;const g=get('groups',a.groupId);if(!g.controlIntent)g.status='needs_review';g.waitReason='delivery_unknown';incident('delivery_unknown',{attemptId:a.id,groupId:g.id,instanceId:a.instanceId});event('delivery.unknown',{attemptId:a.id,groupId:g.id,reasonCode},'error');}
  function release(g){state.locks=state.locks.filter(l=>l.groupId!==g.id);}
  function controlComplete(g){
    if(!g.controlIntent||g.activeAttemptId)return;
    const controls=state.commands.filter(c=>c.type==='CONTROL'&&c.payload.groupId===g.id&&c.payload.controlGeneration===g.controlGeneration&&c.status!=='superseded');
    if(controls.every(c=>c.status==='applied')){g.status=g.controlIntent==='stop'?'stopped':'paused';g.controlIntent=null;g.waitReason=null;release(g);event('group.control_applied',{groupId:g.id,status:g.status});}
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
      incident('connection_lost',{instanceId});event('group.resume_required',{groupId:g.id,instanceId,reasonCode},'warning');
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
    const i=get('instances',c.instanceId);ensure(i.connected&&now()-i.lastSeenAt<=15000,'CONNECTION_LOST','Connect this browser before starting.',409);
    ensure(i.legacyFrozen===true&&i.legacyPending===false,'LEGACY_UNRESOLVED','Legacy execution must be frozen and pending attempts resolved.',409);
    ensure(c.verified&&c.sessionId===i.sessionId,'ACCOUNT_UNVERIFIED','Verify the account and channel in this browser.',409);
    ensure(c.playlist.length>0,'PLAYLIST_EMPTY','Apply at least one message to this channel.',409);
    ensure(c.appliedVersion===c.configVersion,'CONFIG_PENDING','Wait for the extension to apply the current configuration.',409);
  }
  function applyPlaylist(c,items){
    c.playlist=items;c.playlistIndex=0;c.configVersion++;c.appliedVersion=0;c.version++;c.updatedAt=now();
    const expanded=items.map(item=>{const m=get('messages',item.messageId),r=m.revisions.find(r=>r.id===item.revisionId);return {...item,name:m.name,body:r.body};});
    command('CONFIG_SYNC',c.instanceId,{bindingId:c.id,accountId:c.accountId,guildId:c.guildId,channelId:c.channelId,tabId:c.tabId,configVersion:c.configVersion,items:expanded,intervalMs:c.intervalMs});event('channel.playlist_applied',{channelId:c.id,configVersion:c.configVersion});
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
    if(c.pendingPlaylist){applyPlaylist(c,c.pendingPlaylist);delete c.pendingPlaylist;}
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
      case 'channel.update':{const c=get('channels',p.id);expected(c,p);ensure(!state.groups.some(g=>g.members.includes(c.id)&&(g.status==='running'||g.activeAttemptId)),'GROUP_RUNNING','Pause this channel’s group before editing.',409);if(p.name!==undefined)c.name=text(p.name,'name');if(p.intervalMs!==undefined)c.intervalMs=duration(p.intervalMs);c.version++;event('channel.updated',{channelId:c.id});return publicChannel(c);}
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
        const removed={messages:state.messages.length,channels:state.channels.length,groups:state.groups.length,instances:state.instances.length};
        for(const c of state.commands)if(['queued','received'].includes(c.status))c.status='superseded';
        state.messages=[];state.channels=[];state.groups=[];state.instances=[];state.locks=[];state.legacyImports=[];
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
    channels:state.channels.map(c=>({id:c.id,instanceId:c.instanceId,accountId:c.accountId,guildId:c.guildId,channelId:c.channelId,name:c.name,intervalMs:c.intervalMs,playlist:c.playlist,playlistIndex:c.playlistIndex})),
    groups:state.groups.map(g=>({id:g.id,name:g.name,members:g.members,intervalMs:g.intervalMs,cursor:g.cursor}))});}
  function restore(backup){
    ensure(!state.attempts.some(a=>ACTIVE.has(a.status)),'ATTEMPT_UNRESOLVED','Resolve every pending attempt before restoring a backup.',409);
    ensure(state.groups.every(g=>['stopped','paused','resume_required'].includes(g.status)&&!g.controlIntent),'GROUP_RUNNING','Stop all groups and wait for acknowledgments before restoring.',409);
    ensure(backup&&backup.format==='dico-central-backup'&&backup.version===1,'VALIDATION','Unsupported backup format.');
    for(const key of ['messages','instances','channels','groups'])ensure(Array.isArray(backup[key])&&backup[key].length<=10000,'VALIDATION',`Invalid backup ${key}.`);
    const checkIds=list=>{const ids=list.map(x=>text(x.id,'id',100));ensure(new Set(ids).size===ids.length,'VALIDATION','Duplicate identifiers in backup.');};
    for(const key of ['messages','instances','channels','groups'])checkIds(backup[key]);
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
      return{id:text(c.id,'id',100),instanceId:c.instanceId,accountId:text(c.accountId,'accountId',100),guildId:text(c.guildId,'guildId',100),channelId:text(c.channelId,'channelId',100),name:text(c.name,'name'),intervalMs:duration(c.intervalMs),playlist,playlistIndex:Number.isSafeInteger(c.playlistIndex)&&c.playlistIndex>=0&&c.playlistIndex<playlist.length?c.playlistIndex:0,version:1,configVersion:1,appliedVersion:0,verified:false,slowmodeMs:0,createdAt:at};
    });
    // All restored entities are built and validated before replacing current configuration.
    state.messages=messages;state.instances=instances;state.channels=channels;state.groups=[];
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
        let i=state.instances.find(i=>i.id===message.instanceId);
        if(!i){i={id:message.instanceId?text(message.instanceId,'instanceId',100):id(),version:1,name:text(message.name||'Connected browser','name'),browser:typeof message.browser==='string'?message.browser.slice(0,40):'Chromium',extensionVersion:typeof message.extensionVersion==='string'?message.extensionVersion.slice(0,40):'unknown',createdAt:now()};state.instances.push(i);}
        const automaticName=!i.nameCustomized&&['Connected browser','연결된 Chromium',`연결된 ${i.browser}`].includes(i.name);
        const browser=typeof message.browser==='string'&&message.browser.trim()?message.browser.trim().slice(0,40):i.browser;
        const extensionVersion=typeof message.extensionVersion==='string'&&message.extensionVersion.trim()?message.extensionVersion.trim().slice(0,40):i.extensionVersion;
        const name=automaticName?`연결된 ${browser}`:i.name;
        if(i.browser!==browser||i.extensionVersion!==extensionVersion||i.name!==name){i.browser=browser;i.extensionVersion=extensionVersion;i.name=name;i.version++;}
        if(i.sessionId)blockInstanceGroups(i.id,'session_changed');
        for(const c of state.commands.filter(c=>c.instanceId===i.id&&!['completed','applied','rejected'].includes(c.status)))c.status='superseded';
        i.sessionId=id();i.connected=true;i.stableSinceMono=monotonicNow();i.lastSeenAt=now();i.lastSeenMono=monotonicNow();i.legacyFrozen=false;i.legacyPending=true;
        for(const c of state.channels.filter(c=>c.instanceId===i.id)){c.verified=false;c.appliedVersion=0;delete c.tabId;}
        for(const a of state.attempts.filter(a=>a.instanceId===i.id&&ACTIVE.has(a.status))){markUnknown(a,'session_changed');command('RECONCILE',i.id,attemptPayload(a));}
        for(const g of state.groups.filter(g=>g.controlIntent&&g.members.some(m=>get('channels',m).instanceId===i.id)))command('CONTROL',i.id,controlPayload(g,i.id));
        event('instance.connected',{instanceId:i.id});return{instanceId:i.id,sessionId:i.sessionId,protocolVersion:1,commands:commands(i.id)};
      }
      const i=ensureSession(message,instanceId);
      if(message.type==='AUTHORIZE_ENTER'){
        if(clockGap()){suspendForClockGap();lastWall=now();lastMono=monotonicNow();return{allowed:false};}
        const a=state.attempts.find(a=>a.id===message.attemptId&&a.instanceId===i.id);
        if(!a||a.status!=='permitted'||a.sessionId!==i.sessionId||a.runId!==message.runId||a.configVersion!==message.configVersion)return{allowed:false};
        const g=state.groups.find(g=>g.id===a.groupId),c=state.channels.find(c=>c.id===a.bindingId);
        if(state.service.status!=='ready'||!g||g.status!=='running'||g.controlIntent||g.runId!==a.runId||g.activeAttemptId!==a.id||!c||c.configVersion!==a.configVersion||c.accountId!==a.accountId||c.guildId!==a.guildId||c.channelId!==a.channelId||c.tabId!==a.tabId)return{allowed:false};
        try{eligibleChannel(c);}catch{return{allowed:false};}
        return{allowed:true};
      }

      if(message.type==='HEARTBEAT'){
        const requested=message.knownAttemptIds??[];ensure(Array.isArray(requested)&&requested.length<=500&&requested.every(value=>typeof value==='string'&&value.length<=100),'VALIDATION','knownAttemptIds must contain at most 500 identifiers.');
        const ids=new Set(requested),terminalAttempts=state.attempts.filter(a=>a.instanceId===i.id&&ids.has(a.id)&&TERMINAL.has(a.status)).map(a=>({attemptId:a.id,status:a.status,...(a.messageId?{messageId:a.messageId}:{})}));
        return{ok:true,commands:commands(i.id),terminalAttempts};
      }
      if(message.type==='DISCONNECT'){
        blockInstanceGroups(i.id,'connection_lost');i.connected=false;for(const c of state.channels.filter(c=>c.instanceId===i.id))c.verified=false;
        for(const a of state.attempts.filter(a=>a.instanceId===i.id&&ACTIVE.has(a.status)))markUnknown(a,'connection_lost');
        for(const g of state.groups.filter(g=>g.status==='running'&&g.members.some(m=>get('channels',m).instanceId===i.id))){g.waitReason='connection_lost';incident('connection_lost',{instanceId:i.id});}
        event('instance.disconnected',{instanceId:i.id});return{ok:true};
      }
      if(message.type==='OBSERVATION'){
        ensure(Array.isArray(message.channels)&&message.channels.length<=100,'VALIDATION','Invalid channel observations.');
        i.legacyFrozen=message.legacyFrozen===true;i.legacyPending=message.legacyPending!==false;
        for(const c of state.channels.filter(c=>c.instanceId===i.id))c.verified=false;
        const seenTabs=new Set();
        for(const observed of message.channels){
          const accountId=text(observed.accountId,'accountId',100),channelId=text(observed.channelId,'channelId',100),guildId=text(observed.guildId||'@me','guildId',100);
          ensure(Number.isInteger(observed.tabId)&&observed.tabId>=0&&!seenTabs.has(observed.tabId),'VALIDATION','Each observed channel needs its own dedicated tab.');seenTabs.add(observed.tabId);
          ensure(!state.attempts.some(a=>a.instanceId===i.id&&a.tabId===observed.tabId&&ACTIVE.has(a.status)&&(a.accountId!==accountId||a.channelId!==channelId||a.guildId!==guildId)),'TAB_BUSY','An unresolved attempt owns this execution tab.',409);
          let c=state.channels.find(c=>c.instanceId===i.id&&c.accountId===accountId&&c.guildId===guildId&&c.channelId===channelId);
          if(!c){const candidates=state.channels.filter(x=>x.legacyPlaceholder&&x.accountId===accountId&&x.guildId===guildId&&x.channelId===channelId);if(candidates.length===1&&i.legacyFrozen&&i.legacyPending===false){c=candidates[0];const previousInstance=c.instanceId;c.instanceId=i.id;c.legacyPlaceholder=false;c.version++;if(!state.channels.some(x=>x.instanceId===previousInstance))state.instances=state.instances.filter(x=>x.id!==previousInstance);event('legacy.bound',{channelId:c.id,instanceId:i.id});}}
          if(!c){c={id:id(),instanceId:i.id,accountId,guildId,channelId,name:typeof observed.name==='string'?observed.name.slice(0,200):channelId,version:1,configVersion:0,appliedVersion:0,playlist:[],playlistIndex:0,intervalMs:60000,slowmodeMs:0,createdAt:now()};state.channels.push(c);event('channel.discovered',{channelId:c.id,instanceId:i.id});}
          const tabChanged=c.tabId!==observed.tabId||c.sessionId!==i.sessionId;
          if(tabChanged&&state.attempts.some(a=>a.bindingId===c.id&&ACTIVE.has(a.status))){c.verified=false;for(const a of state.attempts.filter(a=>a.bindingId===c.id&&ACTIVE.has(a.status)))markUnknown(a,'execution_tab_changed');continue;}
          c.tabId=observed.tabId;c.sessionId=i.sessionId;c.verified=observed.verified===true;c.observedAt=now();
          if(observed.slowmodeMs!==undefined){const previous=c.slowmodeMs;c.slowmodeMs=duration(observed.slowmodeMs,'slowmodeMs');c.slowmodeObservedAt=now();if(previous!==c.slowmodeMs)event('channel.slowmode_observed',{channelId:c.id,slowmodeMs:c.slowmodeMs,effectiveIntervalMs:effectiveInterval(c)});if(c.lastConfirmedMono!==undefined)c.nextMono=Math.max(c.nextMono||0,c.lastConfirmedMono+effectiveInterval(c));}
          if(c.verified&&c.playlist.length&&c.appliedVersion!==c.configVersion&&!state.commands.some(cmd=>cmd.type==='CONFIG_SYNC'&&cmd.payload.bindingId===c.id&&cmd.payload.configVersion===c.configVersion&&cmd.sessionId===i.sessionId&&['queued','received'].includes(cmd.status))){
            command('CONFIG_SYNC',i.id,{bindingId:c.id,accountId,guildId,channelId,tabId:c.tabId,configVersion:c.configVersion,intervalMs:c.intervalMs,items:c.playlist.map(item=>{const m=get('messages',item.messageId);return{...item,name:m.name,body:m.revisions.find(r=>r.id===item.revisionId).body};})});
          }
        }
        for(const g of state.groups.filter(g=>g.status==='running'))for(const bindingId of g.members){const c=get('channels',bindingId);if(c.instanceId===i.id&&!c.verified){g.waitReason='account_unverified';incident('account_mismatch',{groupId:g.id,instanceId:i.id});}}
        event('instance.observed',{instanceId:i.id,channelCount:message.channels.length});return{ok:true,channels:state.channels.filter(c=>c.instanceId===i.id).map(publicChannel),commands:commands(i.id)};
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
          if(rejectionCode)c.rejectionCode=rejectionCode;
          incident('command_rejected',{instanceId:i.id,commandId:c.id,groupId:c.payload.groupId});
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
        a.status='permitted';g.waitReason='awaiting_result';a.permitId=id();a.permittedAt=now();a.prepareDurationMs=Math.max(0,monotonicNow()-(a.readyMono??monotonicNow()));
        for(const cmd of state.commands.filter(cmd=>cmd.type==='PREPARE'&&cmd.payload.attemptId===a.id))cmd.status='completed';
        command('COMMIT_PERMIT',i.id,{...attemptPayload(a),permitId:a.permitId});event('delivery.permitted',{attemptId:a.id,groupId:g.id,instanceId:i.id});return{ok:true,permitId:a.permitId};
      }
      if(message.type==='DELIVERY_RESULT'){
        const a=get('attempts',message.attemptId);ensure(a.instanceId===i.id,'INSTANCE_MISMATCH','Attempt belongs to another instance.',409);
        ensure(['confirmed','not_sent','unknown'].includes(message.outcome),'VALIDATION','Invalid delivery outcome.');
        if(TERMINAL.has(a.status)){ensure(a.status===message.outcome,'RESULT_CONFLICT','Final outcome cannot be overwritten.',409);return{ok:true,attempt:publicAttempt(a)};}
        if(message.executionBlocked===true)a.executionBlocked=true;
        if(message.outcome==='unknown'){markUnknown(a,'result_unknown');return{ok:true};}
        if(message.outcome==='confirmed')ensure(typeof message.messageId==='string'&&message.messageId.trim(),'EVIDENCE_REQUIRED','A confirmed post requires an observed message ID.');
        else ensure(a.executionBlocked===true,'EXECUTION_UNCERTAIN','The executor must confirm the old attempt is blocked.',409);
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
      blockInstanceGroups(i.id,'connection_lost');i.connected=false;for(const c of state.channels.filter(c=>c.instanceId===i.id))c.verified=false;
      for(const a of state.attempts.filter(a=>a.instanceId===i.id&&ACTIVE.has(a.status)))markUnknown(a,'connection_lost');
      if(state.groups.some(g=>g.status==='running'&&g.members.some(m=>get('channels',m).instanceId===i.id)))incident('connection_lost',{instanceId:i.id});
      event('instance.disconnected',{instanceId:i.id});
    }
    for(const i of state.instances.filter(i=>i.connected&&mono-(i.stableSinceMono??mono)>=30000)){
      for(const problem of state.incidents.filter(problem=>problem.status==='open'&&problem.instanceId===i.id&&problem.code==='connection_lost')){
        problem.status='resolved';problem.resolvedAt=now();event('incident.resolved',{incidentId:problem.id,instanceId:i.id,reasonCode:'connection_recovered'});
      }
    }
    for(const a of state.attempts.filter(a=>['preparing','permitted'].includes(a.status)&&wall-(a.permittedAt||a.createdAt)>30000))markUnknown(a,'result_timeout');
    if(!state.lastPrunedAt||wall-state.lastPrunedAt>=86400000)pruneRecords();
    if(state.service.status!=='ready')return{ok:true};
    for(const g of state.groups.filter(g=>g.status==='running'&&!g.activeAttemptId&&!g.controlIntent)){
      const c=get('channels',g.members[g.cursor]);
      try{eligibleChannel(c);}catch(error){g.waitReason=error.code.toLowerCase();g.nextEligibleAt=null;continue;}
      const due=Math.max(g.nextMono||0,c.nextMono||0);
      if(mono<due){g.waitReason=(c.nextMono||0)>(g.nextMono||0)?'account_interval':'group_interval';g.nextEligibleAt=wall+(due-mono);continue;}
      const item=c.playlist[c.playlistIndex%c.playlist.length],m=get('messages',item.messageId),revision=m.revisions.find(r=>r.id===item.revisionId);
      const a={id:id(),groupId:g.id,runId:g.runId,bindingId:c.id,instanceId:c.instanceId,sessionId:get('instances',c.instanceId).sessionId,accountId:c.accountId,guildId:c.guildId,channelId:c.channelId,tabId:c.tabId,configVersion:c.configVersion,groupVersion:g.version,messageIdRef:m.id,messageName:m.name,revisionId:revision.id,revisionVersion:revision.version,body:revision.body,playlistIndex:c.playlistIndex,status:'preparing',createdAt:wall,readyMono:mono,executionBlocked:false};
      state.attempts.push(a);g.activeAttemptId=a.id;g.waitReason='preparing';g.nextEligibleAt=null;command('PREPARE',c.instanceId,attemptPayload(a));event('delivery.preparing',{attemptId:a.id,groupId:g.id,instanceId:c.instanceId,accountId:c.accountId,channelId:c.channelId});
    }
    return{ok:true};
  });}
  function commands(instanceId,{pendingOnly=true}={}){const i=get('instances',instanceId);return clone(state.commands.filter(c=>c.instanceId===instanceId&&c.sessionId===i.sessionId&&(!pendingOnly||['queued','received'].includes(c.status))));}
  function publicInstance(i){const{sessionId,lastSeenMono,stableSinceMono,...dto}=i;return clone(dto);}
  function publicChannel(c){const{sessionId,nextMono,lastConfirmedMono,...dto}=c;return {...clone(dto),effectiveIntervalMs:effectiveInterval(c)};}
  function publicGroup(g){const{nextMono,...dto}=g;return clone(dto);}
  function publicAttempt(a){const{sessionId,body,readyMono,permitId,...dto}=a;return clone(dto);}
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
  function configurationToken(){return createHash('sha256').update(JSON.stringify({settings:state.settings,...Object.fromEntries(['messages','channels','groups','instances'].map(key=>[key,state[key].map(x=>({id:x.id,version:x.version,configVersion:x.configVersion}))]))})).digest('hex');}
  function snapshot(){return{configurationToken:configurationToken(),schemaVersion:state.schemaVersion,stateVersion:state.stateVersion,lastEventId:state.lastEventId,service:{...clone(state.service),...(storageFailure?{status:'storage_failure'}:{})},settings:clone(state.settings),messages:clone(state.messages),instances:state.instances.map(publicInstance),channels:state.channels.map(publicChannel),groups:state.groups.map(publicGroup),attempts:state.attempts.filter(a=>!a.pruned).slice(-200).map(publicAttempt),commands:state.commands.slice(-200).map(publicCommand),incidents:clone(state.incidents),events:store.recent(100),analytics:analytics()};}
  if(loaded)transact(()=>{
    state.service={status:'resume_required',reasonCode:'service_restart',startedAt:now()};
    for(const span of state.intervals.filter(span=>span.to===null)){const old=span.scope==='instance'?state.instances.find(i=>i.id===span.targetId):null;const end=Math.max(span.from,Math.min(now(),old?.lastSeenAt||now()));span.to=end;if(end<now())state.intervals.push({id:id(),scope:span.scope,targetId:span.targetId,reason:'unobserved',from:end,to:now()});}
    for(const i of state.instances){i.connected=false;i.sessionId=id();delete i.lastSeenMono;}
    for(const c of state.channels){c.verified=false;c.appliedVersion=0;delete c.tabId;delete c.sessionId;delete c.nextMono;delete c.lastConfirmedMono;}
    for(const g of state.groups){delete g.nextMono;if(g.status==='running')g.status='resume_required';}
    for(const c of state.commands.filter(c=>['queued','received'].includes(c.status)))c.status='superseded';
    for(const a of state.attempts.filter(a=>ACTIVE.has(a.status)))markUnknown(a,'service_restart');event('service.started',{reasonCode:'manual_resume_required'});
  });
  else transact(()=>event('service.started'));
  return{execute,snapshot,bridge,tick,commands,analytics,exportBackup,importBackup,events:options=>store.events(options),subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},close(){if(!closed){closed=true;listeners.clear();store.close();}}};
}
