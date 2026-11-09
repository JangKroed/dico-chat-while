import {currentRegistration} from './registration-state.js';
/**
 * 저장된 목적지만 복구합니다. 비동기 경계마다 세션·초기화 세대·긴급 중지를
 * 재확인하여 이전 연결의 계정/탭 관찰이 새 상태를 변경하지 못하게 합니다.
 * attempted는 실제 탭 생성/이동을 시도했는지이며, 안전 차단은 예산을 소모하지 않습니다.
 */
export async function recoverConnections({chrome,state,findAccount,openChannel,report,ensureManagedWindow=async()=>{},canRecover=async()=>true,isCurrent=()=>true,onlyMissing=false}){
 const sessionId=state.sessionId,epoch=state.resetEpoch??0;
 let attempted=false,completed=0;
 const current=()=>!state.emergencyStopped&&state.sessionId===sessionId&&(state.resetEpoch??0)===epoch&&isCurrent();
 const cancelled=()=>({status:'cancelled',attempted,completed,reasonCode:'STALE_SESSION'});
 if(!current())return cancelled();
 const saved=currentRegistration(await chrome.storage.local.get(['dicoCentralAccount','dicoCentralTabs']),epoch);
 if(!current())return cancelled();
 const records=saved.dicoCentralTabs||[];
 if(!saved.dicoCentralAccount&&!records.length)return{status:'skipped',skipped:true,attempted:false,completed};
 const locallySafe=()=>current()&&!Object.values(state.attempts||{}).some(a=>!['confirmed','not_sent','cancelled'].includes(a.phase)&&!(a.phase==='unknown'&&a.result?.executionBlocked===true));
 const safe=async()=>locallySafe()&&await canRecover()&&locallySafe();
 const progress=(stage,reasonCode)=>current()?report({stage,total:records.length,completed,...(reasonCode?{reasonCode}:{})}):undefined;
 const blocked=async reasonCode=>{if(!current())return cancelled();await progress('blocked',reasonCode);return{status:'blocked',attempted,completed,reasonCode};};
 if(!state.legacyDeclaration)return blocked('LEGACY_UNRESOLVED');
 await progress('account');
 if(!current())return cancelled();
 const seen=await findAccount(saved.dicoCentralAccount?.accountId,saved.dicoCentralAccount?.sourceTabId);
 if(!current())return cancelled();
 if(!seen?.verified||saved.dicoCentralAccount&&saved.dicoCentralAccount.accountId!==seen.accountId||records.some(r=>r.accountId!==seen.accountId))return blocked('ACCOUNT_UNVERIFIED');
 if(!await safe())return blocked('ATTEMPT_UNRESOLVED');
 if(!saved.dicoCentralAccount)await chrome.storage.local.set({dicoCentralAccount:{accountId:seen.accountId,sourceTabId:seen.tabId,resetEpoch:epoch}});
 if(!await safe())return blocked('ATTEMPT_UNRESOLVED');
 for(const record of records){
  await progress('channels');
  if(!current())return cancelled();
  let tab;try{tab=await chrome.tabs.get(record.tabId);}catch{}
  if(!current())return cancelled();
  // 탭 번호는 영속 식별자가 아닙니다. 사용자가 다른 페이지로 이동한 탭은
  // 그대로 두고 openChannel의 계정·채널 재탐색과 기존 탭 재사용 경로를 이용합니다.
  if(tab){
   let matching=false;try{const url=new URL(tab.url);matching=url.origin==='https://discord.com'&&[ `/channels/${record.guildId}/${record.channelId}`,`/channels/${record.guildId}/${record.channelId}/`].includes(url.pathname);}catch{}
   if(!matching)tab=null;
   else if(onlyMissing){completed++;continue;}
  }
  if(!await safe())return blocked('ATTEMPT_UNRESOLVED');
  attempted=true;
  try{if(tab)await ensureManagedWindow(record);else await openChannel(record);}
  catch(error){return blocked(/^[A-Z_]{1,64}$/.test(error.code||'')?error.code:tab?'WINDOW_CONSOLIDATION_PARTIAL':'CHANNEL_NOT_READY');}
  if(!current())return cancelled();
  completed++;
 }
 await progress('configuration');
 return current()?{status:'completed',attempted,completed}:cancelled();
}
