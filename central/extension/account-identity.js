import {pageIdentityObservation} from './identity-observation.js';

export async function readAccountIdentity(chrome,tabId){
  if(!Number.isInteger(tabId))return{verified:false,reason:'SCRIPT_UNAVAILABLE'};
  try{return(await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:pageIdentityObservation}))[0]?.result||{verified:false,reason:'SCRIPT_UNAVAILABLE'};}catch{return{verified:false,reason:'SCRIPT_UNAVAILABLE'};}
}
export async function authorizeAccountInput({chrome,executor,message,tabId,now=Date.now}){
  await executor.load?.();
  const began=now(),attempt=executor.state?.attempts?.[message?.id],sessionId=executor.state?.sessionId;
  const denied=(code,retryable=false,extra={})=>({allowed:false,authorizedAt:now(),maxAgeMs:2000,code,retryable,...(retryable?{retryAfterMs:500}:{}),...extra});
  if(!attempt||attempt.tabId!==tabId||attempt.sessionId!==sessionId)return denied('TARGET_MISMATCH');
  const authorization=executor.authorizeInput?await executor.authorizeInput(message,tabId):{allowed:await executor.canSend(message,tabId)};
  if(authorization?.allowed!==true)return denied(authorization?.code||'AUTHORIZATION_DENIED',authorization?.retryable===true,authorization);
  // Service approval never bypasses a fresh identity check or extends its TTL.
  const identity=await readAccountIdentity(chrome,tabId),elapsed=now()-began;
  if(executor.state?.sessionId!==sessionId||executor.state?.attempts?.[message.id]!==attempt)return denied('SESSION_MISMATCH');
  if(!executor.inputAllowed(message,tabId)){
    const cause=executor.inputDenial?.(message,tabId);
    return denied(cause?.code||'EXECUTION_STOPPED',cause?.retryable===true,cause||{});
  }
  if(identity.verified===true&&identity.accountId!==attempt.accountId)return denied('ACCOUNT_MISMATCH');
  if(identity.verified===true&&(identity.guildId!==attempt.guildId||identity.channelId!==attempt.channelId))return denied('TARGET_MISMATCH');
  if(elapsed<0||elapsed>2000)return denied('AUTHORIZATION_EXPIRED',true);
  if(identity.verified!==true)return denied('ACCOUNT_UNVERIFIED',true);
  return{allowed:true,authorizedAt:began,maxAgeMs:2000,identity};
}
