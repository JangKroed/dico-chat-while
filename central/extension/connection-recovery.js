// Restore only previously saved destinations, never infer new channel URLs.
export async function recoverConnections({chrome,state,findAccount,openChannel,report,canRecover=async()=>true}){
 const saved=await chrome.storage.local.get(['dicoCentralAccount','dicoCentralTabs']);
 const records=saved.dicoCentralTabs||[];
 const locallySafe=()=>!state.emergencyStopped&&!Object.values(state.attempts||{}).some(a=>!['confirmed','not_sent','cancelled'].includes(a.phase));
 const safe=async()=>locallySafe()&&await canRecover()&&locallySafe();
 const progress=(stage,completed=0,reasonCode)=>report({stage,total:records.length,completed,...(reasonCode?{reasonCode}:{})});
 if(!state.legacyDeclaration){await progress('blocked',0,'LEGACY_UNRESOLVED');return;}
 await progress('account');
 const seen=await findAccount(saved.dicoCentralAccount?.accountId,saved.dicoCentralAccount?.sourceTabId);
 if(!seen?.verified){await progress('blocked',0,'ACCOUNT_UNVERIFIED');return;}
 if(!saved.dicoCentralAccount)await chrome.storage.local.set({dicoCentralAccount:{accountId:seen.accountId,sourceTabId:seen.tabId}});
 // New sessions may contain an old permit. Opening replacement tabs cannot
 // establish its past result and must wait for reconciliation instead.
 if(!await safe()){await progress('blocked',0,'ATTEMPT_UNRESOLVED');return;}
 let completed=0;
 for(const record of records){
  await progress('channels',completed);
  if(record.accountId!==seen.accountId){await progress('blocked',completed,'ACCOUNT_UNVERIFIED');return;}
  let tab;try{tab=await chrome.tabs.get(record.tabId);}catch{}
  if(tab){
   let matching=false;try{const url=new URL(tab.url);matching=url.origin==='https://discord.com'&&url.pathname===`/channels/${record.guildId}/${record.channelId}`;}catch{}
   if(!matching){await progress('blocked',completed,'TARGET_MISMATCH');return;}
  }else{
   if(!await safe()){await progress('blocked',completed,'ATTEMPT_UNRESOLVED');return;}
   try{await openChannel(record);}catch(error){await progress('blocked',completed,/^[A-Z_]{1,64}$/.test(error.code||'')?error.code:'CHANNEL_NOT_READY');return;}
  }
  completed++;
 }
 await progress('configuration',completed);
}
