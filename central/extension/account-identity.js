import {pageIdentityObservation} from './identity-observation.js';

export async function readAccountIdentity(chrome,tabId){
  if(!Number.isInteger(tabId))return{verified:false,reason:'SCRIPT_UNAVAILABLE'};
  try{return(await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:pageIdentityObservation}))[0]?.result||{verified:false,reason:'SCRIPT_UNAVAILABLE'};}catch{return{verified:false,reason:'SCRIPT_UNAVAILABLE'};}
}
export async function authorizeAccountInput({chrome,executor,message,tabId,now=Date.now}){
  await executor.load?.();
  const began=now(),attempt=executor.state?.attempts?.[message?.id],sessionId=executor.state?.sessionId;
  const denied=()=>({allowed:false,authorizedAt:now(),maxAgeMs:2000});
  if(!attempt||attempt.tabId!==tabId||attempt.sessionId!==sessionId)return denied();
  if(!await executor.canSend(message,tabId))return denied();
  // Authorization yields to the central service. Read MAIN identity afterwards
  // so an account switch during that wait cannot reuse the old identity.
  const identity=await readAccountIdentity(chrome,tabId),elapsed=now()-began;
  if(elapsed<0||elapsed>2000||!executor.inputAllowed(message,tabId)||executor.state?.sessionId!==sessionId||executor.state?.attempts?.[message.id]!==attempt||identity.verified!==true||identity.accountId!==attempt.accountId||identity.guildId!==attempt.guildId||identity.channelId!==attempt.channelId)return denied();
  return{allowed:true,authorizedAt:began,maxAgeMs:2000,identity};
}
