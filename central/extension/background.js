import {BUILD_ID} from './build-info.js';
import {createExtensionUpdater,ensureManagedContent} from './update.js';
import {pageIdentityObservation,identityFailureMessage} from './identity-observation.js';
import {detectConnectedBrowser} from './browser-identity.js';
import {observeChannelLimit} from './channel-limit.js';
import {createNativeTransport} from './transport.js';
import {createCentralExecutor} from './executor.js';
import {channelTabContext} from './panel-context.js';

const transport=createNativeTransport(chrome),executor=createCentralExecutor({chrome,transport,openChannel:openManagedChannel});
let connecting=null,heartbeatTimer=null,lastError=null,updateIssue=null;
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
async function refreshManagedContent(){
  if(!executor.isIdle)return;
  let status;try{status=await transport.request({type:'EXTENSION_STATUS'});}catch{return;}
  if(!status.reloadSafe||status.buildId!==BUILD_ID||!executor.beginMaintenance())return;
  try{
    const records=(await chrome.storage.local.get('dicoCentralTabs')).dicoCentralTabs||[];
    const statuses=await ensureManagedContent(chrome,records,BUILD_ID);
    const failed=statuses.filter(s=>!s.ready);
    if(failed.length)updateIssue='기존 Discord 탭 '+failed.length+'개는 최초 한 번 새로고침이 필요합니다. 작성 중인 초안을 보관한 뒤 해당 탭을 새로고침하세요.';
    else if(updateIssue?.startsWith('기존 Discord 탭 '))updateIssue=null;
  }finally{executor.endMaintenance();}
}
transport.onCommand(c=>void executor.handleCommand(c));
transport.onDisconnect(()=>{executor.disconnect();lastError='관리 프로그램과 연결이 끊겼습니다.';clearInterval(heartbeatTimer);if(!executor.state?.emergencyStopped)void chrome.alarms.create('dico-central-reconnect',{delayInMinutes:0.5});});

async function observe(tabId) {
  try{return (await chrome.scripting.executeScript({target:{tabId},func:pageIdentityObservation}))[0]?.result || {verified:false,reason:'SCRIPT_UNAVAILABLE'};}catch{return {verified:false,reason:'SCRIPT_UNAVAILABLE'};}
}
let lastAccountObservation=null;
async function currentAccount(expectedId,preferredTabId) {
  const candidates=[];
  if(Number.isInteger(preferredTabId))candidates.push(preferredTabId);
  for(const tab of await chrome.tabs.query({url:'https://discord.com/*'}))if(Number.isInteger(tab.id)&&!candidates.includes(tab.id))candidates.push(tab.id);
  for(const tabId of candidates.slice(0,30)){const seen=await observe(tabId);if(seen?.verified&&(!expectedId||seen.accountId===expectedId))return{...seen,tabId};}
  return null;
}
async function registerActiveAccount(windowId) {
  if(!executor.state?.legacyDeclaration)throw Error('기존 실행기 사용 여부를 먼저 확인 상태 저장으로 기록해 주세요.');
  if(!transport.connected)await connect();
  const tab=await activeSourceTab(windowId);
  const seen=tab&&await observe(tab.id);
  if(!seen?.verified)throw Error(identityFailureMessage(seen));
  const account={accountId:seen.accountId,sourceTabId:tab.id};
  const result=await executor.request({type:'ACCOUNT_OBSERVATION',accountId:seen.accountId,verified:true,legacyFrozen:true,legacyPending:false});
  await chrome.storage.local.set({dicoCentralAccount:account});lastAccountObservation={accountId:seen.accountId,verified:true};
  return{registered:true,account:result.account};
}
async function refreshRegisteredAccount() {
  const saved=(await chrome.storage.local.get('dicoCentralAccount')).dicoCentralAccount;
  if(!saved)return;
  const seen=await currentAccount(saved.accountId,saved.sourceTabId);
  lastAccountObservation={accountId:saved.accountId,verified:Boolean(seen)};
  await executor.request({type:'ACCOUNT_OBSERVATION',accountId:saved.accountId,verified:Boolean(seen)});
}
async function observation() {
  await executor.load();const records=(await chrome.storage.local.get('dicoCentralTabs')).dicoCentralTabs || [];
  await refreshRegisteredAccount();
  const channels=[];
  for(const record of records) {
    const seen=await observe(record.tabId);
    if(!seen || seen.accountId!==record.accountId || seen.guildId!==record.guildId || seen.channelId!==record.channelId)continue;
    const limit=await observeChannelLimit(chrome,record);
    channels.push({...seen,tabId:record.tabId,...limit});
  }
  return executor.request({type:'OBSERVATION',channels,legacyFrozen:Boolean(executor.state.legacyDeclaration),legacyPending:false});
}
async function heartbeat() {
  try {
    const knownAttemptIds=Object.values(executor.state.attempts).filter(a=>!['confirmed','not_sent','cancelled'].includes(a.phase)).slice(-500).map(a=>a.attemptId);
    const result=await executor.request({type:'HEARTBEAT',knownAttemptIds});
    for(const item of result.terminalAttempts || []) {
      const local=executor.state.attempts[item.attemptId];if(!local)continue;
      local.phase=item.status;local.reported=true;
      local.result={outcome:item.status==='confirmed'?'confirmed':'not_sent',messageId:item.messageId,executionBlocked:true};
    }
    await executor.save();
    for(const command of result.commands || [])void executor.handleCommand(command);
    await refreshManagedContent();await observation();await updater.check();lastError=null;
  }catch{lastError='관리 프로그램 응답이 지연됩니다. 자동으로 다시 연결합니다.';transport.disconnect();}
}
async function connect() {
  if(connecting)return connecting;
  connecting=(async()=>{
    await executor.load();
    if(executor.state.emergencyStopped)throw Error('긴급 중지 상태입니다. 다시 연결한 후 중앙 페이지에서 작업을 재개하세요.');
    try {
      const old=(await chrome.storage.local.get('state')).state;
      // Same-ID developer upgrades must never reactivate an older scheduler.
      if(old?.enabled || old?.pending || old?.channels?.some(c=>c.enabled || c.pending || c.prepared))throw Error('기존 발송을 먼저 중지하고 미확인 결과를 해소하세요.');
      const browser=await detectConnectedBrowser(chrome,navigator);
      const response=await transport.request({type:'HELLO',protocolVersion:1,instanceId:executor.state.instanceId || undefined,name:`연결된 ${browser}`,browser,extensionVersion:chrome.runtime.getManifest().version,extensionBuildId:BUILD_ID,capabilities:['central-executor-v1','strict-account-v1','account-registry-v1','open-channel-v1','managed-update-v1']});
      await executor.setSession(response);
      for(const command of response.commands || [])void executor.handleCommand(command);
      await refreshManagedContent();await observation();void updater.check({force:true});clearInterval(heartbeatTimer);heartbeatTimer=setInterval(()=>void heartbeat(),5000);lastError=null;
      await chrome.alarms.clear('dico-central-reconnect');
    } catch(error){lastError=String(error.message || error).slice(0,200);transport.disconnect();throw Error(lastError);}
  })().finally(()=>{connecting=null;});return connecting;
}
async function openManagedChannel(p) {
  if(!executor.state?.legacyDeclaration)throw Object.assign(Error('기존 실행기 사용 여부를 먼저 확인하세요.'),{code:'LEGACY_UNRESOLVED'});
  if(!/^\d{17,20}$/.test(p.accountId||'')||!/^\d{1,30}$/.test(p.guildId||'')||!/^\d{1,30}$/.test(p.channelId||''))throw Object.assign(Error('연결할 계정·채널 정보가 올바르지 않습니다.'),{code:'TARGET_MISMATCH'});
  const saved=(await chrome.storage.local.get('dicoCentralAccount')).dicoCentralAccount;
  if(!await currentAccount(p.accountId,saved?.sourceTabId))throw Object.assign(Error('이 브라우저의 로그인 계정을 다시 등록해 주세요.'),{code:'ACCOUNT_UNVERIFIED'});
  const records=(await chrome.storage.local.get('dicoCentralTabs')).dicoCentralTabs || [];
  const existing=records.find(r=>r.accountId===p.accountId&&r.guildId===p.guildId&&r.channelId===p.channelId);
  if(existing) {
    const seen=await observe(existing.tabId);
    if(seen?.verified&&seen.accountId===p.accountId&&seen.guildId===p.guildId&&seen.channelId===p.channelId){await observation();return {alreadyConnected:true};}
    if(Object.values(executor.state.attempts).some(a=>a.tabId===existing.tabId&&!['confirmed','not_sent','cancelled'].includes(a.phase)))throw Object.assign(Error('기존 전송용 창의 발송 결과를 먼저 확인하세요.'),{code:'ATTEMPT_UNRESOLVED'});
    try{await chrome.tabs.get(existing.tabId);throw Object.assign(Error('기존 전송용 창이 다른 화면에 있습니다. 원래 채널로 돌아가거나 창을 닫고 다시 연결하세요.'),{code:'TARGET_MISMATCH'});}catch(error){if(error.code==='TARGET_MISMATCH')throw error;}
    records.splice(records.indexOf(existing),1);
  }
  const win=await chrome.windows.create({url:`https://discord.com/channels/${p.guildId}/${p.channelId}`,type:'normal',focused:false,width:1080,height:800});
  const tab=win.tabs?.[0];if(!tab)throw Error('전송용 창을 열지 못했습니다.');
  records.push({accountId:p.accountId,guildId:p.guildId,channelId:p.channelId,tabId:tab.id});await chrome.storage.local.set({dicoCentralTabs:records});
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
  const source=await activeSourceTab(windowId);
  const context=channelTabContext(source);if(!context.eligible)throw Error(context.reason);
  const seen=source&&await observe(source.id);
  if(!seen?.verified)throw Error(identityFailureMessage(seen));
  if(!seen.guildId||!seen.channelId)throw Error('계정은 확인됐습니다. 연결할 서버의 텍스트 채널을 열어 주세요.');
  if(seen.guildId!==context.guildId||seen.channelId!==context.channelId)throw Error('탭의 실제 채널이 주소와 일치하지 않습니다. 대상 채널을 다시 열어 주세요.');
  await registerActiveAccount(windowId);return openManagedChannel(seen);
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id)return false;
  if(message?.type==='DICO_CAN_SEND' && sender.tab){executor.canSend(message,sender.tab.id).then(allowed=>respond({allowed,authorizedAt:Date.now(),maxAgeMs:2000})).catch(()=>respond({allowed:false}));return true;}
  if(sender.tab){if(['DICO_TRACE','DICO_TIMING_SAMPLE'].includes(message?.type)){respond({ok:true});return true;}return false;}
  if(!sender.url?.startsWith(chrome.runtime.getURL('')))return false;
  const action=async()=>{
    await executor.load();
    if(message.type==='CENTRAL_STATUS')return {connected:transport.connected,instanceId:executor.state.instanceId,legacyDeclaration:executor.state.legacyDeclaration,lastError:updateIssue || lastError || executor.state.lastError,bindings:Object.keys(executor.state.bindings).length,account:lastAccountObservation,activeTab:await activeChannelContext(message.windowId)};
    if(message.type==='CENTRAL_TAB_CONTEXT')return activeChannelContext(message.windowId);
    if(message.type==='CENTRAL_REGISTER_ACCOUNT')return registerActiveAccount(message.windowId);
    if(message.type==='CENTRAL_CONNECT'){if(transport.connected&&!executor.state.emergencyStopped){await observation();return {connected:true};}executor.state.emergencyStopped=false;await executor.save();await connect();return {connected:true};}
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
