import {createRecoveryScheduler} from './recovery-scheduler.js';
/**
 * 중앙 관리 전용 확장의 service worker 진입점입니다. 루트 background.js의 단독 확장과 구분합니다.
 * Native transport, 명령 실행기, 계정/채널 관찰, 하트비트, 관리 탭과 업데이트를 조립합니다.
 * 주기 관찰은 상태 확인용이며, 관찰 자체가 메시지를 전송하도록 설계하지 않습니다.
 */
import {createDeliveryTracer} from './delivery-trace.js';
import {currentRegistration} from './registration-state.js';
import {managedPageDelay} from './managed-delay.js';
import {recoverConnections} from './connection-recovery.js';
import {BUILD_ID} from './build-info.js';
import {createExtensionUpdater,ensureManagedContent} from './update.js';
import {identityFailureMessage,accountIdentityMetadata} from './identity-observation.js';
import {readAccountIdentity,authorizeAccountInput} from './account-identity.js';
import {detectConnectedBrowser} from './browser-identity.js';
import {observeChannelLimit} from './channel-limit.js';
import {createNativeTransport} from './transport.js';
import {createCentralExecutor} from './executor.js';
import {channelTabContext} from './panel-context.js';
import {createManagedWindow,createManagedWindowController,ensureConsolidatedManagedWindow} from './managed-windows.js';
import {createObservationQueue,createSingleFlight,observeManagedChannel,observeRegisteredAccount} from './observation-queue.js';
import {lookupExistingChannelName} from './channel-name.js';

const windowController=createManagedWindowController({chrome});
const transport=createNativeTransport(chrome),executor=createCentralExecutor({chrome,transport,openChannel:openManagedChannel,manageChannelWindow,lookupChannelName:target=>lookupExistingChannelName(chrome,observe,target)});
const traceDelivery=createDeliveryTracer({executor});
const observation=createObservationQueue(collectObservation,publishObservation);
const heartbeat=createSingleFlight(runHeartbeat);
const automaticRecovery=createRecoveryScheduler();
let channelOpening=Promise.resolve();
let connecting=null,heartbeatTimer=null,lastError=null,updateIssue=null,recoveryPending=false;
const updater=createExtensionUpdater({chrome,executor,transport,loadedBuildId:BUILD_ID,onIssue:message=>{updateIssue=message;}});
async function configurePanelAction(){
  if(chrome.sidePanel?.setPanelBehavior){
    try{await chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true});await chrome.action.setPopup({popup:''});return;}catch{}
  }
  // Chromium variants without the side panel API retain a usable toolbar popup.
  await chrome.action.setPopup({popup:'popup.html'});
}
async function activeSourceTab(windowId){
  const [tab]=await chrome.tabs.query({active:true,...(Number.isInteger(windowId)?{windowId}:{currentWindow:true})});return tab;
}
async function activeChannelContext(windowId){return channelTabContext(await activeSourceTab(windowId));}
void configurePanelAction().catch(()=>{});
chrome.runtime.onInstalled?.addListener(()=>void configurePanelAction().catch(()=>{}));
/**
 * 실행기가 쉬고 있고 중앙이 갱신을 허용할 때 기존 탭의 content script를 확인합니다.
 * 발송 도중 코드가 교체되어 관찰 근거가 사라지는 일을 피하기 위한 조건입니다.
 */
async function refreshManagedContent(){
  if(!executor.isIdle)return;
  let status;try{status=await transport.request({type:'EXTENSION_STATUS'});}catch{return;}
  if(!status.reloadSafe||status.buildId!==BUILD_ID||!executor.beginMaintenance())return;
  try{
    const records=currentRegistration(await chrome.storage.local.get('dicoCentralTabs'),executor.state.resetEpoch??0).dicoCentralTabs;
    const statuses=await ensureManagedContent(chrome,records,BUILD_ID);
    const failed=statuses.filter(s=>!s.ready&&s.reason!=='TAB_MISSING'&&s.reason!=='CONTENT_BUSY');
    if(failed.length)updateIssue='기존 Discord 탭 '+failed.length+'개는 최초 한 번 새로고침이 필요합니다. 작성 중인 초안을 보관한 뒤 해당 탭을 새로고침하세요.';
    else if(updateIssue?.startsWith('기존 Discord 탭 '))updateIssue=null;
  }finally{executor.endMaintenance();}
}
transport.onCommand(c=>void executor.handleCommand(c));
transport.onDisconnect(()=>{executor.disconnect();lastError='관리 프로그램과 연결이 끊겼습니다.';clearInterval(heartbeatTimer);if(!executor.state?.emergencyStopped)void chrome.alarms.create('dico-central-reconnect',{delayInMinutes:0.5});});

async function observe(tabId) {
  return readAccountIdentity(chrome,tabId);
}
let lastAccountObservation=null;
const currentAccountResult=(expectedId,preferredTabId)=>observeRegisteredAccount(chrome,observe,expectedId,preferredTabId);
async function currentAccount(expectedId,preferredTabId){return(await currentAccountResult(expectedId,preferredTabId)).seen;}
async function registerActiveAccount(windowId) {
  if(!executor.state?.legacyDeclaration)throw Error('기존 실행기 사용 여부를 먼저 확인 상태 저장으로 기록해 주세요.');
  if(!transport.connected)await connect({explicit:true});
  const sessionId=executor.state.sessionId;
  const tab=await activeSourceTab(windowId);
  const seen=tab&&await observe(tab.id);
  if(sessionId!==executor.state.sessionId)throw Error('연결이 변경되었습니다. 계정을 다시 등록하세요.');
  if(!seen?.verified)throw Error(identityFailureMessage(seen));
  const account={accountId:seen.accountId,sourceTabId:tab.id,resetEpoch:executor.state.resetEpoch??0,...accountIdentityMetadata(seen)};
  const result=await executor.request({type:'ACCOUNT_OBSERVATION',accountId:seen.accountId,...accountIdentityMetadata(seen),explicitRegistration:true,verified:true,legacyFrozen:true,legacyPending:false});
  if(sessionId!==executor.state.sessionId)throw Error('연결이 변경되었습니다. 계정을 다시 등록하세요.');
  await chrome.storage.local.set({dicoCentralAccount:account});
  if(sessionId!==executor.state.sessionId)throw Error('연결이 변경되었습니다. 계정을 다시 등록하세요.');
  lastAccountObservation={accountId:seen.accountId,...accountIdentityMetadata(seen),verified:true};
  await observation();
  return{registered:true,account:result.account};
}
async function collectObservation() {
  await executor.load();
  const sessionId=executor.state.sessionId;
  const saved=currentRegistration(await chrome.storage.local.get(['dicoCentralTabs','dicoCentralAccount']),executor.state.resetEpoch??0);
  const records=saved.dicoCentralTabs||[],account=saved.dicoCentralAccount;
  // Channel-limit reads can each wait 1.5 seconds. Independent channel reads
  // run together so a browser with many tabs does not age the first result.
  const [accountResult,channels]=await Promise.all([
    account?currentAccountResult(account.accountId,account.sourceTabId):null,
    Promise.all(records.map(record=>observeManagedChannel(chrome,record,{observe,observeLimit:observeChannelLimit}))),
  ]);
  return{sessionId,account:account?{accountId:account.accountId,...accountIdentityMetadata(accountResult.seen),verified:Boolean(accountResult.seen),verificationReason:accountResult.verificationReason}:null,channels};
}
async function publishObservation(snapshot){
  if(!transport.connected||executor.state.emergencyStopped||snapshot.sessionId!==executor.state.sessionId)return{ignored:true};
  automaticRecovery.observe(snapshot);
  if(snapshot.account){lastAccountObservation=snapshot.account;await executor.request({type:'ACCOUNT_OBSERVATION',...snapshot.account});}
  if(!transport.connected||executor.state.emergencyStopped||snapshot.sessionId!==executor.state.sessionId)return{ignored:true};
  return executor.request({type:'OBSERVATION',channels:snapshot.channels,legacyFrozen:Boolean(executor.state.legacyDeclaration),legacyPending:false});
}
async function restoreSavedConnections({onlyMissing=false}={}){
  const sessionId=executor.state.sessionId;
  await recoverConnections({chrome,onlyMissing,state:executor.state,findAccount:currentAccount,openChannel:p=>openManagedChannel({...p,recovery:true}),ensureManagedWindow:consolidateRecoveredChannel,
    canRecover:async()=>{if(!transport.connected||executor.state.emergencyStopped||executor.state.sessionId!==sessionId||!executor.isIdle)return false;const result=await executor.request({type:'RECOVERY_STATUS'});return result.allowed===true&&transport.connected&&!executor.state.emergencyStopped&&executor.state.sessionId===sessionId&&executor.isIdle;},
    report:async progress=>{if(!transport.connected||executor.state.emergencyStopped||executor.state.sessionId!==sessionId)return;recoveryPending=progress.stage==='blocked'&&progress.reasonCode==='ATTEMPT_UNRESOLVED';await executor.request({type:'CONNECTION_PROGRESS',...progress});}});
}
async function runHeartbeat() {
  try {
    const knownAttemptIds=Object.values(executor.state.attempts).filter(a=>!['confirmed','not_sent','cancelled'].includes(a.phase)).slice(-500).map(a=>a.attemptId);
    const result=await executor.request({type:'HEARTBEAT',knownAttemptIds});
    if(result.resetRequired){if(result.resetEpoch!==executor.state.resetEpoch)await connect();return;}
    for(const item of result.terminalAttempts || []) {
      const local=executor.state.attempts[item.attemptId];if(!local)continue;
      local.phase=item.status;local.reported=true;
      local.result={outcome:item.status==='confirmed'?'confirmed':'not_sent',messageId:item.messageId,confirmationBasis:item.confirmationBasis,deliveryEvidence:item.deliveryEvidence,executionBlocked:true};
    }
    await executor.save();
    for(const command of result.commands || [])void executor.handleCommand(command);
    await refreshManagedContent();await observation();await automaticRecovery.run({safe:()=>transport.connected&&!executor.state.emergencyStopped&&executor.isIdle,repair:()=>restoreSavedConnections({onlyMissing:true})});await updater.check();lastError=null;
  }catch{lastError='관리 프로그램 응답이 지연됩니다. 자동으로 다시 연결합니다.';transport.disconnect();}
}
async function connect({explicit=false}={}) {
  if(connecting)return connecting;
  connecting=(async()=>{
    await executor.load();
    if(executor.state.emergencyStopped)throw Error('긴급 중지 상태입니다. 다시 연결한 후 중앙 페이지에서 작업을 재개하세요.');
    try {
      const old=(await chrome.storage.local.get('state')).state;
      // Same-ID developer upgrades must never reactivate an older scheduler.
      if(old?.enabled || old?.pending || old?.channels?.some(c=>c.enabled || c.pending || c.prepared))throw Error('기존 발송을 먼저 중지하고 미확인 결과를 해소하세요.');
      const browser=await detectConnectedBrowser(chrome,navigator);
      const response=await transport.request({type:'HELLO',protocolVersion:1,explicitReconnect:explicit,instanceId:executor.state.instanceId || undefined,resetEpoch:executor.state.resetEpoch,name:`연결된 ${browser}`,browser,extensionVersion:chrome.runtime.getManifest().version,extensionBuildId:BUILD_ID,capabilities:['central-executor-v1','strict-account-v1','account-registry-v1','open-channel-v1','channel-name-lookup-v1','managed-window-v1','managed-window-separation-v1','managed-update-v1','early-prepare-v1','reset-epoch-v1','close-channel-v1']});
      if(response.removed){
        // A deleted browser may reconnect only through an explicit user action.
        // Retain failed cleanup records so the next connection can retry safely.
        const failures=[],completedRemovalIds=[];for(const target of response.closeChannels||[]){try{await manageChannelWindow({...target,action:'close'});completedRemovalIds.push(target.removalId);}catch(error){failures.push(error);}}
        for(let offset=0;offset<completedRemovalIds.length;offset+=100)await transport.request({type:'HELLO',protocolVersion:1,instanceId:executor.state.instanceId,resetEpoch:executor.state.resetEpoch,completedRemovalIds:completedRemovalIds.slice(offset,offset+100)});
        await chrome.storage.local.remove('dicoCentralAccount');lastAccountObservation=null;recoveryPending=false;
        executor.state.sessionId=null;executor.state.bindings={};await executor.save();
        throw Error(failures.length?'삭제한 브라우저의 전송 탭을 닫지 못했습니다. 남은 전송 탭을 확인하고 직접 닫아 주세요.':'중앙 설정에서 삭제한 브라우저입니다. 다시 사용할 때 확장에서 관리 프로그램 연결을 눌러 등록하세요.');
      }
      const session=await executor.setSession(response);
      if(session.reset){lastAccountObservation=null;recoveryPending=false;}
      for(const command of response.commands||[])if(command.type==='CLOSE_CHANNEL')await executor.handleCommand(command);
      for(const command of response.commands||[])if(command.type!=='CLOSE_CHANNEL')void executor.handleCommand(command);
      await refreshManagedContent();
      await restoreSavedConnections();
      await observation();void updater.check({force:true});clearInterval(heartbeatTimer);heartbeatTimer=setInterval(()=>void heartbeat(),5000);lastError=null;
      await chrome.alarms.clear('dico-central-reconnect');
    } catch(error){lastError=String(error.message || error).slice(0,200);transport.disconnect();throw Error(lastError);}
  })().finally(()=>{connecting=null;});return connecting;
}
function openManagedChannel(p){
  const next=channelOpening.then(()=>openManagedChannelNow(p));channelOpening=next.catch(()=>{});return next;
}
async function consolidateRecoveredChannel(record){
  const next=channelOpening.then(async()=>{
    if(!transport.connected||executor.state?.emergencyStopped||!executor.beginMaintenance())throw Object.assign(Error('진행 중인 발송 결과를 확인한 뒤 전송 창을 모으세요.'),{code:'ATTEMPT_UNRESOLVED'});
    try{return await ensureConsolidatedManagedWindow(chrome,record);}finally{executor.endMaintenance();}
  });
  channelOpening=next.catch(()=>{});return next;
}
async function manageChannelWindow(p){
  if(!['consolidate','separate','close'].includes(p.action))return windowController(p);
  const next=channelOpening.then(async()=>{
    if(Object.values(executor.state.attempts).some(a=>!['confirmed','not_sent','cancelled'].includes(a.phase)))throw Object.assign(Error('진행 중인 발송 결과를 확인한 뒤 창을 정리하세요.'),{code:'ATTEMPT_UNRESOLVED'});
    return windowController(p);
  });
  channelOpening=next.catch(()=>{});return next;
}
async function openManagedChannelNow(p) {
  const sessionId=executor.state?.sessionId;
  const ensureCurrent=()=>{if(sessionId!==executor.state?.sessionId)throw Object.assign(Error('초기화 또는 재연결로 이전 채널 연결 요청을 취소했습니다.'),{code:'STALE_SESSION'});};
  if(executor.state?.emergencyStopped||!transport.connected)throw Object.assign(Error('중지된 브라우저에서는 자동 연결을 시작하지 않습니다.'),{code:'EXECUTION_STOPPED'});
  if(!executor.state?.legacyDeclaration)throw Object.assign(Error('기존 실행기 사용 여부를 먼저 확인하세요.'),{code:'LEGACY_UNRESOLVED'});
  if(!/^\d{17,20}$/.test(p.accountId||'')||!/^\d{1,30}$/.test(p.guildId||'')||!/^\d{1,30}$/.test(p.channelId||''))throw Object.assign(Error('연결할 계정·채널 정보가 올바르지 않습니다.'),{code:'TARGET_MISMATCH'});
  const saved=currentRegistration(await chrome.storage.local.get('dicoCentralAccount'),executor.state.resetEpoch??0).dicoCentralAccount;
  if(!await currentAccount(p.accountId,saved?.sourceTabId))throw Object.assign(Error('이 브라우저의 로그인 계정을 다시 등록해 주세요.'),{code:'ACCOUNT_UNVERIFIED'});
  const records=currentRegistration(await chrome.storage.local.get('dicoCentralTabs'),executor.state.resetEpoch??0).dicoCentralTabs;
  const existing=records.find(r=>r.accountId===p.accountId&&r.guildId===p.guildId&&r.channelId===p.channelId);
  if(p.recovery&&!existing)throw Object.assign(Error('연결 해제한 채널의 자동 복구를 취소했습니다.'),{code:'MANAGED_TAB_MISSING'});
  if(existing) {
    const seen=await observe(existing.tabId);
    if(seen?.verified&&seen.accountId===p.accountId&&seen.guildId===p.guildId&&seen.channelId===p.channelId){await observation();return {alreadyConnected:true};}
    if(Object.values(executor.state.attempts).some(a=>a.tabId===existing.tabId&&!['confirmed','not_sent','cancelled'].includes(a.phase)))throw Object.assign(Error('기존 전송용 창의 발송 결과를 먼저 확인하세요.'),{code:'ATTEMPT_UNRESOLVED'});
    try{await chrome.tabs.get(existing.tabId);throw Object.assign(Error('기존 전송용 창이 다른 화면에 있습니다. 원래 채널로 돌아가거나 창을 닫고 다시 연결하세요.'),{code:'TARGET_MISMATCH'});}catch(error){if(error.code==='TARGET_MISMATCH')throw error;}
    records.splice(records.indexOf(existing),1);
  }
  if(executor.state.emergencyStopped||!transport.connected)throw Object.assign(Error('브라우저 중지로 채널 열기를 취소했습니다.'),{code:'EXECUTION_STOPPED'});
  ensureCurrent();
  const win=await createManagedWindow(chrome,p);
  ensureCurrent();
  const tab=win.tabs?.[0];if(!tab)throw Error('전송용 창을 열지 못했습니다.');
  ensureCurrent();
  records.push({resetEpoch:executor.state.resetEpoch??0,accountId:p.accountId,guildId:p.guildId,channelId:p.channelId,tabId:tab.id,windowId:win.id});await chrome.storage.local.set({dicoCentralTabs:records});
  for(let n=0;n<20;n++) {
    const ready=await observe(tab.id);
    if(ready?.verified&&ready.accountId===p.accountId&&ready.guildId===p.guildId&&ready.channelId===p.channelId){await observation();return {connected:true};}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  await observation();throw Object.assign(Error('전송용 창을 열었지만 계정·채널 확인이 완료되지 않았습니다. 창에서 로그인·접근 권한을 확인하고 다시 연결하세요.'),{code:'CHANNEL_NOT_READY'});
}
async function bindActive(windowId) {
  if(!executor.state?.legacyDeclaration)throw Error('기존 실행기 사용 여부를 먼저 선택해 주세요.');
  if(!transport.connected)await connect();
  const sessionId=executor.state.sessionId;
  const source=await activeSourceTab(windowId);
  const context=channelTabContext(source);if(!context.eligible)throw Error(context.reason);
  const seen=source&&await observe(source.id);
  if(sessionId!==executor.state.sessionId)throw Error('연결이 변경되었습니다. 계정을 다시 등록하세요.');
  if(!seen?.verified)throw Error(identityFailureMessage(seen));
  if(!seen.guildId||!seen.channelId)throw Error('계정은 확인됐습니다. 연결할 서버의 텍스트 채널을 열어 주세요.');
  if(seen.guildId!==context.guildId||seen.channelId!==context.channelId)throw Error('탭의 실제 채널이 주소와 일치하지 않습니다. 대상 채널을 다시 열어 주세요.');
  await registerActiveAccount(windowId);return openManagedChannel(seen);
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id)return false;
  if(message?.type==='DICO_DELAY'){void executor.load().then(()=>managedPageDelay(message,sender,executor.state,{extensionId:chrome.runtime.id})).then(respond).catch(()=>respond({ok:false}));return true;}
  if(message?.type==='DICO_PRE_ENTER_WAIT'&&sender.tab){executor.authorizePreEnterWait(message,sender.tab.id).then(respond).catch(()=>respond({allowed:false}));return true;}
  if(message?.type==='DICO_RETRY_WAIT'&&sender.tab){executor.authorizeRetryWait(message,sender.tab.id).then(respond).catch(()=>respond({allowed:false}));return true;}
  if(message?.type==='DICO_OBSERVE_WAIT'&&sender.tab){executor.observationWait(message,sender.tab.id).then(respond).catch(()=>respond({allowed:false,retryable:true,code:'AUTHORIZATION_UNAVAILABLE',retryAfterMs:500}));return true;}
  if(message?.type==='DICO_ACCOUNT_IDENTITY'&&sender.tab){void observe(sender.tab.id).then(respond).catch(()=>respond({verified:false,reason:'SCRIPT_UNAVAILABLE'}));return true;}
  if(message?.type==='DICO_CAN_SEND' && sender.tab){authorizeAccountInput({chrome,executor,message,tabId:sender.tab.id}).then(respond).catch(()=>respond({allowed:false}));return true;}
  if(message?.type==='DICO_TIMING_SAMPLE'&&sender.tab){executor.cooldownSample(message,sender.tab.id).then(ok=>respond({ok})).catch(()=>respond({ok:false}));return true;}
  if(sender.tab){if(message?.type==='DICO_TRACE'){void traceDelivery(message,sender.tab.id).then(recorded=>respond({ok:true,recorded})).catch(()=>respond({ok:false}));return true;}return false;}
  if(!sender.url?.startsWith(chrome.runtime.getURL('')))return false;
  const action=async()=>{
    await executor.load();
    if(message.type==='CENTRAL_CLEAR_DRAFT_BACKUPS'){executor.state.draftBackups=[];await executor.save();return{cleared:true};}
    if(message.type==='CENTRAL_DRAFT_BACKUPS')return{backups:(executor.state.draftBackups||[]).map(({accountId,channelId,text,createdAt})=>({accountId,channelId,text,createdAt}))};
    if(message.type==='CENTRAL_STATUS')return {connected:transport.connected,instanceId:executor.state.instanceId,legacyDeclaration:executor.state.legacyDeclaration,lastError:updateIssue || lastError || executor.state.lastError,bindings:Object.keys(executor.state.bindings).length,account:lastAccountObservation,activeTab:await activeChannelContext(message.windowId)};
    if(message.type==='CENTRAL_TAB_CONTEXT')return activeChannelContext(message.windowId);
    if(message.type==='CENTRAL_REGISTER_ACCOUNT')return registerActiveAccount(message.windowId);
    if(message.type==='CENTRAL_CONNECT'){executor.state.emergencyStopped=false;await executor.save();await connect({explicit:true});return {connected:true};}
    if(message.type==='CENTRAL_DECLARE'){await executor.declareLegacy(message.value);if(!transport.connected)await connect();await observation();return {saved:true};}
    if(message.type==='CENTRAL_BIND')return bindActive(message.windowId);
    if(message.type==='CENTRAL_OPEN'){if(!transport.connected)await connect();const result=await transport.request({type:'OPEN_DASHBOARD'});const u=new URL(result.url);u.pathname='/channels';if(u.hostname!=='127.0.0.1'||u.protocol!=='http:')throw Error('관리 페이지 주소를 확인할 수 없습니다.');await chrome.tabs.create({url:u.href});return {opened:true};}
    if(message.type==='CENTRAL_STOP'){
      executor.state.emergencyStopped=true;executor.disconnect();clearInterval(heartbeatTimer);await chrome.alarms.clear('dico-central-reconnect');await executor.save();
      try{await executor.request({type:'DISCONNECT'});}catch{}
      transport.disconnect();return {stopped:true};
    }
    throw Error('지원하지 않는 요청입니다.');
  };
  void action().then(result=>respond({ok:true,result})).catch(error=>respond({ok:false,error:error.message}));return true;
});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='dico-central-reconnect')void connect().catch(()=>{});});
chrome.tabs.onRemoved.addListener(()=>{if(transport.connected)void observation().catch(()=>{});});
chrome.tabs.onUpdated.addListener((id,change)=>{if((change.url || change.status==='complete')&&transport.connected)void observation().catch(()=>{});});
void connect().catch(()=>{});
