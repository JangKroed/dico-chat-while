import { channelDiagnostic } from './diagnostics.js';
const button = document.querySelector('#download-diagnostics');
const status = document.querySelector('#diagnostic-status');
button.addEventListener('click', async () => {
  try {
    const snapshotAt=new Date().toISOString();
    const {diagnosticLog=[],diagnosticTimeline=[],state} = await chrome.storage.local.get(['diagnosticLog','diagnosticTimeline','state']);
    const channels=(state?.channels || []).map((c,i)=>channelDiagnostic(c,i,state?.revision));
    const alarms=(await chrome.alarms.getAll()).filter(a=>a.name.startsWith('dico-channel:')).map(a=>({channelKey:a.name.slice('dico-channel:'.length),scheduledAt:a.scheduledTime}));
    const tabs=await Promise.all(channels.map(async c=>{try {const tab=await chrome.tabs.get(c.tabId); const path=new URL(tab.url).pathname.match(/^\/channels\/(\d+)\/(\d+)/);return {channelKey:c.channelKey,tabId:c.tabId,status:tab.status,discarded:tab.discarded,active:tab.active,windowId:tab.windowId,observedGuildId:path?.[1] || null,observedChannelId:path?.[2] || null};}catch{return {channelKey:c.channelKey,tabId:c.tabId,unavailable:true};}}));
    const report = {schemaVersion:3,version:chrome.runtime.getManifest().version, exportedAt:new Date().toISOString(), browser:navigator.userAgent, snapshotAt, channels,alarms,tabs,events:diagnosticLog,timeline:diagnosticTimeline};
    const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
    const link=document.createElement('a');
    link.href=url;link.download=`dico-diagnostics-${Date.now()}.json`;link.click();
    setTimeout(()=>URL.revokeObjectURL(url),10000);
    status.textContent='진단 로그를 저장했습니다. 오류가 발생한 기기에서 받은 파일을 전달해 주세요.';
  } catch(error) {status.textContent=`로그 저장 실패: ${error.message}`;}
});
