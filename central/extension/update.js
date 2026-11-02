const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function extensionReloadDecision({loadedBuildId,status,idle,lastRequested}) {
  if(!hash(status?.buildId)||status.buildId===loadedBuildId)return{action:'none'};
  if(!idle||status.reloadSafe!==true)return{action:'defer'};
  if(lastRequested===status.buildId)return{action:'manual'};
  return{action:'reload',buildId:status.buildId};
}
export async function ensureManagedContent(chrome,records,buildId) {
  const results=[];
  for(const record of records) {
    const tabId=record.tabId;
    try {
      const tab=await chrome.tabs.get(tabId),url=new URL(tab.url);
      if(url.origin!=='https://discord.com'||url.pathname!==`/channels/${record.guildId}/${record.channelId}`)continue;
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
      const decision=extensionReloadDecision({loadedBuildId,status,idle:executor.isIdle,lastRequested:saved?.buildId});
      // A busy configuration lane is transient. Recheck on the next scheduled
      // heartbeat instead of losing the entire pre-start reload window to the
      // ordinary 30-second update backoff. This creates no polling loop.
      if(decision.action==='defer'){lastCheck=-Infinity;return;}
      if(decision.action==='manual'){onIssue('확장 로드 폴더가 관리 폴더와 다를 수 있습니다. 설정·도움말의 최초 전환 안내를 확인하세요. 같은 버전의 자동 재시작은 반복하지 않습니다.');return;}
      if(decision.action!=='reload'||!executor.beginMaintenance())return;
      try {
        await chrome.storage.local.set({dicoUpdateReload:{buildId:decision.buildId,requestedAt:now()}});
        // Maintenance blocks new commands and Enter during the asynchronous write.
        chrome.runtime.reload();
      }catch(error){executor.endMaintenance();onIssue('확장 자동 재시작을 완료하지 못했습니다. 확장 관리 화면에서 한 번 새로고침하세요.');}
    }catch{/* Old native hosts do not support update status until first migration. */}
    finally{checking=false;}
  }};
}
