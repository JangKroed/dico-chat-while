const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function extensionReloadDecision({loadedBuildId,status,idle,lastRequested,reloadFailures=0}) {
  if(!hash(status?.buildId)||status.buildId===loadedBuildId)return{action:'none'};
  if(!idle||status.reloadSafe!==true)return{action:'defer'};
  // 실패한 호출은 영속 백오프로 다시 시도합니다. 호출이 성공했는데 같은
  // 구형 코드가 돌아온 경우에는 실제 로드 폴더가 검증되기 전 reload를 반복하지 않습니다.
  if(lastRequested===status.buildId&&!(Number.isSafeInteger(status.repairedCopies)&&status.repairedCopies>0))return{action:'manual'};
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
    const elapsed=now()-lastCheck;
    if(checking||!force&&elapsed>=0&&elapsed<30000)return;
    checking=true;lastCheck=now();
    try {
      const status=await transport.request({type:'EXTENSION_STATUS'});
      const saved=(await chrome.storage.local.get('dicoUpdateReload')).dicoUpdateReload;
      const reloadFailures=saved?.buildId===status?.buildId&&Number.isSafeInteger(saved?.failures)?saved.failures:0;
      if(saved?.buildId===status?.buildId&&saved.failed&&Number.isFinite(saved.retryAfterAt)){
        // 벽시계가 뒤로 바뀌어도 과거 재시도 시각을 무기한 기다리지 않습니다.
        if(saved.requestedAt>now()||saved.retryAfterAt-now()>300000){await chrome.storage.local.set({dicoUpdateReload:{...saved,requestedAt:now(),retryAfterAt:now()+30000}});return;}
        if(now()<saved.retryAfterAt)return;
      }
      const decision=extensionReloadDecision({loadedBuildId,status,idle:executor.isMaintenanceIdle??executor.isIdle,lastRequested:saved?.failed?undefined:saved?.buildId,reloadFailures});
      // A busy configuration lane is transient. Recheck on the next scheduled
      // heartbeat instead of losing the entire pre-start reload window to the
      // ordinary 30-second update backoff. This creates no polling loop.
      if(decision.action==='defer'){lastCheck=-Infinity;return;}
      if(decision.action==='manual'){onIssue('확장 로드 폴더가 관리 폴더와 다를 수 있습니다. 검증 가능한 배포 폴더는 자동 동기화하며 같은 버전의 무한 재시작은 차단합니다.');return;}
      if(decision.action!=='reload'||!executor.beginMaintenance({allowBlocked:true}))return;
      try {
        await chrome.storage.local.set({dicoUpdateReload:{buildId:decision.buildId,requestedAt:now(),failures:reloadFailures}});
        // Maintenance blocks new commands and Enter during the asynchronous write.
        await chrome.runtime.reload();
      }catch(error){
        executor.endMaintenance();
        // 실패 횟수와 다음 시각은 워커 재시작 뒤에도 유지합니다. 실제 전환을
        // 확인하지 않고 완료로 만들거나, 횟수 소진으로 영구 중단하지 않습니다.
        const failures=reloadFailures+1,retryAfterAt=now()+Math.min(300000,30000*2**Math.min(4,failures-1));
        try{await chrome.storage.local.set({dicoUpdateReload:{buildId:decision.buildId,requestedAt:now(),failed:true,failures,retryAfterAt}});}catch{}
        onIssue('확장 자동 재시작을 완료하지 못했습니다. 설정을 보존하고 자동으로 다시 시도합니다.');
      }
    }catch{/* Old native hosts do not support update status until first migration. */}
    finally{checking=false;}
  }};
}
