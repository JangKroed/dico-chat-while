import { channelDiagnostic, diagnosticTextContext, readDiagnosticArchive } from './diagnostics.js';
const button = document.querySelector('#download-diagnostics');
const status = document.querySelector('#diagnostic-status');
button.addEventListener('click', async () => {
  try {
    const snapshotAt=new Date().toISOString();
    const {diagnosticLog=[],diagnosticTimeline=[],diagnosticArchiveError=null,lastNotificationDiagnostic=null,state} = await chrome.storage.local.get(['diagnosticLog','diagnosticTimeline','diagnosticArchiveError','lastNotificationDiagnostic','state']);
    const channels=(state?.channels || []).map((c,i)=>({...channelDiagnostic(c,i,state?.revision),textContext:diagnosticTextContext({messageA:c.messages?.[0],messageB:c.messages?.[1]})}));
    const alarms=(await chrome.alarms.getAll()).filter(a=>a.name.startsWith('dico-channel:')).map(a=>({channelKey:a.name.slice('dico-channel:'.length),scheduledAt:a.scheduledTime}));
    const tabs=await Promise.all(channels.map(async c=>{try {const tab=await chrome.tabs.get(c.tabId); const path=new URL(tab.url).pathname.match(/^\/channels\/(\d+)\/(\d+)/);return {channelKey:c.channelKey,tabId:c.tabId,status:tab.status,discarded:tab.discarded,active:tab.active,windowId:tab.windowId,observedGuildId:path?.[1] || null,observedChannelId:path?.[2] || null};}catch{return {channelKey:c.channelKey,tabId:c.tabId,unavailable:true};}}));
    let archive=[],archiveError=null;
    try{archive=await readDiagnosticArchive();}catch(error){archiveError=String(error.message);}
    const report = {schemaVersion:5,lastNotificationDiagnostic,archive,archiveError,archiveWriteError:diagnosticArchiveError,retention:{archive:'no-count-or-age-limit',recentCache:500,timelineCache:2000},version:chrome.runtime.getManifest().version, exportedAt:new Date().toISOString(), browser:navigator.userAgent, snapshotAt, channels,alarms,tabs,events:diagnosticLog,timeline:diagnosticTimeline};
    const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
    const link=document.createElement('a');
    link.href=url;link.download=`dico-diagnostics-${Date.now()}.json`;link.click();
    setTimeout(()=>URL.revokeObjectURL(url),10000);
    status.textContent=(archiveError || diagnosticArchiveError?'전체 기록을 읽지 못해 최근 기록만 저장했습니다. ':'')+'진단 로그를 저장했습니다. 설정 문구와 입력창 초안이 포함되어 있으니 내용을 확인한 후 전달해 주세요.';
  } catch(error) {status.textContent=`로그 저장 실패: ${error.message}`;}
});
