const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function extensionReloadDecision({loadedBuildId,status,idle,lastRequested,reloadFailures=0}) {
  if(!hash(status?.buildId)||status.buildId===loadedBuildId)return{action:'none'};
  if(!idle||status.reloadSafe!==true)return{action:'defer'};
  // 런타임 재시작 자체의 실패는 최대 3회만 자동 복구한다. 실제 폴더 교체가
  // 검증된 경우에는 과거 잘못된 폴더에서 남긴 1회 제한 표식만 해제한다.
  if(reloadFailures>=3||lastRequested===status.buildId&&!(Number.isSafeInteger(status.repairedCopies)&&status.repairedCopies>0))return{action:'manual'};
  return{action:'reload',buildId:status.buildId};
}
export async function ensureManagedContent(chrome,records,buildId) {
  const results=[];
  for(const record of records) {
    const tabId=record.tabId;
    // 없어진 탭은 새로고침할 대상이 없습니다. 관찰 기반 자동 복원에 맡기고
    // 살아 있는 탭의 콘텐츠 교체 실패와 구분하여 사용자에게 잘못 안내하지 않습니다.
    let tab;try{tab=await chrome.tabs.get(tabId);}catch{results.push({tabId,ready:false,reason:'TAB_MISSING'});continue;}
    try {
      const url=new URL(tab.url);
      // 채널 연결과 같은 주소 범위를 사용하며, 다른 채널·하위 경로는 교체하지 않습니다.
      const channelPath=`/channels/${record.guildId}/${record.channelId}`;
      if(url.origin!=='https://discord.com'||![channelPath,channelPath+'/'].includes(url.pathname))continue;
      let current;try{current=await chrome.tabs.sendMessage(tabId,{type:'DICO_CONTENT_STATUS'});}catch{}
      if(current?.buildId===buildId){results.push({tabId,ready:true});continue;}
      if(current?.busy){results.push({tabId,ready:false,reason:'CONTENT_BUSY'});continue;}
      if(current?.buildId){const stopped=await chrome.tabs.sendMessage(tabId,{type:'DICO_CONTENT_DISPOSE'});if(!stopped?.disposed){results.push({tabId,ready:false,reason:'CONTENT_BUSY'});continue;}}
      await chrome.scripting.executeScript({target:{tabId},files:['emoji-data.js','content.js']});
      const updated=await chrome.tabs.sendMessage(tabId,{type:'DICO_CONTENT_STATUS'});
      results.push({tabId,ready:updated?.buildId===buildId,...(updated?.buildId===buildId?{}:{reason:'TAB_REFRESH_REQUIRED'})});
    }catch{results.push({tabId,ready:false,reason:'TAB_REFRESH_REQUIRED'});}
  }
  return results;
}

export function createExtensionUpdater({chrome,executor,transport,loadedBuildId,now=Date.now,onIssue=()=>{}}) {
  let checking=false,lastCheck=-Infinity;
  return {async check({force=false}={}) {
    if(checking||!force&&now()-lastCheck<30000)return;
    checking=true;lastCheck=now();
    try {
      const status=await transport.request({type:'EXTENSION_STATUS'});
      const saved=(await chrome.storage.local.get('dicoUpdateReload')).dicoUpdateReload;
      const reloadFailures=saved?.buildId===status?.buildId&&Number.isSafeInteger(saved?.failures)?saved.failures:0;
      const decision=extensionReloadDecision({loadedBuildId,status,idle:executor.isMaintenanceIdle??executor.isIdle,lastRequested:saved?.failed?undefined:saved?.buildId,reloadFailures});
      // A busy configuration lane is transient. Recheck on the next scheduled
      // heartbeat instead of losing the entire pre-start reload window to the
      // ordinary 30-second update backoff. This creates no polling loop.
      if(decision.action==='defer'){lastCheck=-Infinity;return;}
      if(decision.action==='manual'){onIssue(reloadFailures>=3?'확장 자동 재시작이 3회 실패하여 중단되었습니다. 기존 설정은 보존되며 자동 진단 대상입니다.':'확장 로드 폴더가 관리 폴더와 다를 수 있습니다. 검증 가능한 배포 폴더는 자동 동기화하며 같은 버전의 무한 재시작은 차단합니다.');return;}
      if(decision.action!=='reload'||!executor.beginMaintenance({allowBlocked:true}))return;
      try {
        await chrome.storage.local.set({dicoUpdateReload:{buildId:decision.buildId,requestedAt:now(),failures:reloadFailures}});
        // Maintenance blocks new commands and Enter during the asynchronous write.
        await chrome.runtime.reload();
      }catch(error){
        executor.endMaintenance();
        // 호출 전에 저장한 표식을 성공한 재시작으로 오인하지 않는다. 실패 횟수는
        // 워커 재시작에도 유지하여 다음 30초 검사에서 제한된 횟수만 재시도한다.
        try{await chrome.storage.local.set({dicoUpdateReload:{buildId:decision.buildId,requestedAt:now(),failed:true,failures:reloadFailures+1}});}catch{}
        onIssue('확장 자동 재시작을 완료하지 못했습니다. 기존 설정을 보존하고 제한된 횟수 안에서 자동으로 다시 시도합니다.');
      }
    }catch{/* Old native hosts do not support update status until first migration. */}
    finally{checking=false;}
  }};
}
