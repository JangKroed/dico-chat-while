import {detectConnectedBrowser} from './browser-identity.js';
import {observeChannelLimit} from './channel-limit.js';
import {createNativeTransport} from './transport.js';
import {createCentralExecutor} from './executor.js';

const transport=createNativeTransport(chrome),executor=createCentralExecutor({chrome,transport});
let connecting=null,heartbeatTimer=null,lastError=null;
transport.onCommand(c=>void executor.handleCommand(c));
transport.onDisconnect(()=>{executor.disconnect();lastError='관리 프로그램과 연결이 끊겼습니다.';clearInterval(heartbeatTimer);if(!executor.state?.emergencyStopped)void chrome.alarms.create('dico-central-reconnect',{delayInMinutes:0.5});});

// Executed in the isolated extension world. It reads visible identity evidence,
// not Discord auth storage or private tokens.
function pageObservation() {
  const match=location.pathname.match(/^\/channels\/(\d+)\/(\d+)(?:\/\d+)?\/?$/);
  if(!match || location.origin!=='https://discord.com')return null;
  const panel=document.querySelector('section[class*="panels"], div[class*="panels"]');
  let accountId=null;
  for(const img of panel?.querySelectorAll('img') || []) {
    const found=(img.getAttribute('src') || '').match(/\/(?:avatars\/(\d{17,20})|users\/(\d{17,20})\/avatars)\//);
    if(found){accountId=found[1] || found[2];break;}
  }
  return {accountId,guildId:match[1],channelId:match[2],name:document.title,verified:Boolean(accountId)};
}
async function observe(tabId) {
  try{return (await chrome.scripting.executeScript({target:{tabId},func:pageObservation}))[0]?.result || null;}catch{return null;}
}
async function observation() {
  await executor.load();const records=(await chrome.storage.local.get('dicoCentralTabs')).dicoCentralTabs || [];
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
    await observation();lastError=null;
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
      const response=await transport.request({type:'HELLO',protocolVersion:1,instanceId:executor.state.instanceId || undefined,name:`연결된 ${browser}`,browser,extensionVersion:chrome.runtime.getManifest().version,capabilities:['central-executor-v1','strict-account-v1']});
      await executor.setSession(response);
      for(const command of response.commands || [])void executor.handleCommand(command);
      await observation();clearInterval(heartbeatTimer);heartbeatTimer=setInterval(()=>void heartbeat(),5000);lastError=null;
      await chrome.alarms.clear('dico-central-reconnect');
    } catch(error){lastError=String(error.message || error).slice(0,200);transport.disconnect();throw Error(lastError);}
  })().finally(()=>{connecting=null;});return connecting;
}
async function bindActive() {
  if(!executor.state?.legacyDeclaration)throw Error('기존 실행기 사용 여부를 먼저 선택해 주세요.');
  if(!transport.connected)await connect();
  const [source]=await chrome.tabs.query({active:true,currentWindow:true});
  const seen=source && await observe(source.id);
  if(!seen?.verified)throw Error('Discord 서버 채널을 열고 로그인 계정을 확인하세요. 기본 아바타 등으로 사용자 ID가 보이지 않으면 연결할 수 없습니다.');
  const records=(await chrome.storage.local.get('dicoCentralTabs')).dicoCentralTabs || [];
  if(records.some(r=>r.accountId===seen.accountId&&r.guildId===seen.guildId&&r.channelId===seen.channelId)) {
    const existing=records.find(r=>r.accountId===seen.accountId&&r.guildId===seen.guildId&&r.channelId===seen.channelId);
    try{await chrome.tabs.get(existing.tabId);await observation();return {alreadyConnected:true};}catch{}
    // Replacing a closed execution tab is allowed only when no unresolved local
    // attempt owns it. Reconcile first, never silently reset that ownership.
    if(Object.values(executor.state.attempts).some(a=>a.tabId===existing.tabId&&!['confirmed','not_sent','cancelled'].includes(a.phase)))throw Error('닫힌 탭의 발송 결과를 먼저 확인하세요.');
    records.splice(records.indexOf(existing),1);
  }
  const win=await chrome.windows.create({url:`https://discord.com/channels/${seen.guildId}/${seen.channelId}`,type:'normal',focused:false,width:1080,height:800});
  const tab=win.tabs?.[0];if(!tab)throw Error('전송용 창을 열지 못했습니다.');
  records.push({...seen,tabId:tab.id});await chrome.storage.local.set({dicoCentralTabs:records});
  for(let i=0;i<15;i++) {
    const ready=await observe(tab.id);if(ready?.verified)break;
    await new Promise(r=>setTimeout(r,500));
  }
  await observation();return {connected:true};
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id)return false;
  if(message?.type==='DICO_CAN_SEND' && sender.tab){executor.canSend(message,sender.tab.id).then(allowed=>respond({allowed,authorizedAt:Date.now(),maxAgeMs:2000})).catch(()=>respond({allowed:false}));return true;}
  if(sender.tab){if(['DICO_TRACE','DICO_TIMING_SAMPLE'].includes(message?.type)){respond({ok:true});return true;}return false;}
  if(!sender.url?.startsWith(chrome.runtime.getURL('')))return false;
  const action=async()=>{
    await executor.load();
    if(message.type==='CENTRAL_STATUS')return {connected:transport.connected,instanceId:executor.state.instanceId,legacyDeclaration:executor.state.legacyDeclaration,lastError:lastError || executor.state.lastError,bindings:Object.keys(executor.state.bindings).length};
    if(message.type==='CENTRAL_CONNECT'){executor.state.emergencyStopped=false;await executor.save();await connect();return {connected:true};}
    if(message.type==='CENTRAL_DECLARE'){await executor.declareLegacy(message.value);if(!transport.connected)await connect();await observation();return {saved:true};}
    if(message.type==='CENTRAL_BIND')return bindActive();
    if(message.type==='CENTRAL_OPEN'){if(!transport.connected)await connect();const result=await transport.request({type:'OPEN_DASHBOARD'});const u=new URL(result.url);if(u.hostname!=='127.0.0.1'||u.protocol!=='http:')throw Error('관리 페이지 주소를 확인할 수 없습니다.');await chrome.tabs.create({url:result.url});return {opened:true};}
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
