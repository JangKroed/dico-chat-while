// Discard scans invalidated by a newer trigger before publishing. A burst of
// tab events shares one follow-up scan, rather than racing full snapshots.
export function createObservationQueue(collect,publish){
  let revision=0,running=null;
  return function requestObservation(){
    revision++;
    if(!running)running=(async()=>{
      let result;
      for(;;){
        const started=revision,snapshot=await collect();
        if(started!==revision)continue;
        result=await publish(snapshot);
        if(started===revision)return result;
      }
    })().finally(()=>{running=null;});
    return running;
  };
}
export function createSingleFlight(work){
  let running=null;
  return function(...args){
    if(!running)running=Promise.resolve().then(()=>work(...args)).finally(()=>{running=null;});
    return running;
  };
}
export async function observeManagedChannel(chrome,record,{observe,observeLimit}){
  const expected={accountId:record.accountId,guildId:record.guildId,channelId:record.channelId,tabId:record.tabId};
  const failed=verificationReason=>({...expected,verified:false,verificationReason});
  let tab;try{tab=await chrome.tabs.get(record.tabId);}catch{return failed('tab_missing');}
  if(tab.status==='loading')return failed('tab_loading');
  try{const url=new URL(tab.url);if(url.origin!=='https://discord.com'||url.pathname!==`/channels/${record.guildId}/${record.channelId}`||url.search||url.hash)return failed('target_mismatch');}catch{return failed('target_mismatch');}
  const seen=await observe(record.tabId);
  if(seen?.verified&&seen.accountId!==record.accountId)return failed('account_mismatch');
  if(!seen?.verified)return failed(seen?.reason==='SCRIPT_UNAVAILABLE'?'script_unavailable':'identity_unverified');
  if(seen.guildId!==record.guildId||seen.channelId!==record.channelId)return failed('target_mismatch');
  return{...seen,...expected,verified:true,verificationReason:null,...await observeLimit(chrome,record)};
}

export async function observeRegisteredAccount(chrome,observe,expectedId,preferredTabId) {
  const candidates=[];let verificationReason='identity_unverified';
  if(Number.isInteger(preferredTabId))candidates.push(preferredTabId);
  for(const tab of await chrome.tabs.query({url:'https://discord.com/*'}))if(Number.isInteger(tab.id)&&!candidates.includes(tab.id))candidates.push(tab.id);
  for(const tabId of candidates.slice(0,30)){
    let tab;try{tab=await chrome.tabs.get(tabId);}catch{if(verificationReason!=='account_mismatch')verificationReason='tab_missing';continue;}
    if(tab.status==='loading'){if(verificationReason!=='account_mismatch')verificationReason='tab_loading';continue;}
    const seen=await observe(tabId);
    if(seen?.verified&&(!expectedId||seen.accountId===expectedId))return{seen:{...seen,tabId},verificationReason:null};
    if(seen?.verified)verificationReason='account_mismatch';
    else if(verificationReason!=='account_mismatch')verificationReason=seen?.reason==='SCRIPT_UNAVAILABLE'?'script_unavailable':'identity_unverified';
  }
  return{seen:null,verificationReason};
}
