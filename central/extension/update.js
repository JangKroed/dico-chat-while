const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function extensionReloadDecision({loadedBuildId,status,idle,lastRequested}) {
  if(!hash(status?.buildId)||status.buildId===loadedBuildId)return{action:'none'};
  if(!idle||status.reloadSafe!==true)return{action:'defer'};
  // 성공 응답 이후에도 구버전이면 폴더 복구 근거 없이 reload를 반복하지 않는다.
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

/** 어느 상태 조회가 폴더를 복구하더라도 일회성 신호를 다음 안전 시점까지 보존한다. */
export async function rememberExtensionRepair(chrome,status,loadedBuildId){
  const saved=(await chrome.storage.local.get('dicoUpdateReload')).dicoUpdateReload;
  if(!hash(status?.buildId)||status.buildId===loadedBuildId||!Number.isSafeInteger(status.repairedCopies)||status.repairedCopies<=0)return saved;
  // 같은 빌드의 실패 횟수·다음 시각은 유지해 추가 프로필 복구가 대기를 우회하지 않는다.
  const next={...(saved?.buildId===status.buildId?saved:{}),buildId:status.buildId,repairPending:true};
  await chrome.storage.local.set({dicoUpdateReload:next});return next;
}

export function createExtensionUpdater({chrome,executor,transport,loadedBuildId,now=Date.now,onIssue=()=>{}}) {
  let checking=false,lastCheck=-Infinity;
  return {async check({force=false}={}) {
    if(checking||!force&&now()-lastCheck<30000)return;
    checking=true;lastCheck=now();
    try {
      const status=await transport.request({type:'EXTENSION_STATUS'});
      const saved=await rememberExtensionRepair(chrome,status,loadedBuildId);
      if(hash(status?.buildId)&&status.buildId===loadedBuildId){
        // 실제 새 워커의 빌드 확인 이후에만 완료 표식을 정리한다.
        if(saved)await chrome.storage.local.set({dicoUpdateReload:null});
        return;
      }
      const reloadFailures=saved?.buildId===status?.buildId&&Number.isSafeInteger(saved?.failures)?saved.failures:0;
      const decision=extensionReloadDecision({loadedBuildId,status,idle:executor.isMaintenanceIdle??executor.isIdle,lastRequested:saved?.failed||saved?.repairPending?undefined:saved?.buildId});
      // A busy configuration lane is transient. Recheck on the next scheduled
      // heartbeat instead of losing the entire pre-start reload window to the
      // ordinary 30-second update backoff. This creates no polling loop.
      if(decision.action==='defer'){lastCheck=-Infinity;return;}
      if(decision.action==='manual'){onIssue('확장 로드 폴더가 관리 폴더와 다를 수 있습니다. 검증 가능한 배포 폴더는 자동 동기화하며 같은 버전의 무한 재시작은 차단합니다.');return;}
      // 강제 확인과 워커 재생성도 실패 대기를 우회하지 않는다. 시계 역행은 최대 5분으로 제한한다.
      if(saved?.buildId===status?.buildId&&saved.failed&&Number.isFinite(saved.nextAttemptAt)&&saved.nextAttemptAt>now()){
        if(saved.nextAttemptAt-now()>300000)await chrome.storage.local.set({dicoUpdateReload:{...saved,nextAttemptAt:now()+300000}});
        return;
      }
      if(decision.action!=='reload'||!executor.beginMaintenance({allowBlocked:true}))return;
      try {
        await chrome.storage.local.set({dicoUpdateReload:{buildId:decision.buildId,requestedAt:now(),failures:reloadFailures}});
        // Maintenance blocks new commands and Enter during the asynchronous write.
        await chrome.runtime.reload();
      }catch(error){
        executor.endMaintenance();
        // 실패는 영구 중단하지 않는다. 기존 heartbeat에서 30초~5분 간격으로 복구한다.
        const failures=Math.min(30,Math.max(0,reloadFailures)+1),delay=Math.min(300000,30000*2**Math.min(4,failures-1));
        try{await chrome.storage.local.set({dicoUpdateReload:{buildId:decision.buildId,requestedAt:now(),failed:true,failures,nextAttemptAt:now()+delay}});}catch{}
        onIssue('확장 자동 재시작을 완료하지 못했습니다. 기존 설정을 보존하고 잠시 후 자동으로 다시 시도합니다.');
      }
    }catch{/* Old native hosts do not support update status until first migration. */}
    finally{checking=false;}
  }};
}
