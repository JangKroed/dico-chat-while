const stages=new Set(['stability-failed','stability-timer-delayed','editor-recovered','received','prior-post-check','prior-post-confirmed','before-paste','paste-dispatched','after-paste','prepared','prepared-verified','authorization-request','authorization-response','before-enter','enter-dispatched','observation','retry-wait','slowmode-wait','network-start','network-result','exception','finished']);
const booleans=new Set('pageHidden documentFocused editorFocused editorConnected editorReplaced selectionInside selectionCollapsed draftEmpty textMatches composing targetMatches draftMatchesA draftMatchesB draftHasVoid rawTextMatches emojiEquivalent unsupportedEditorContent whitespaceOnlyDifference newMessage matchingMessage sendingSeen sendingActive failedSeen ownMessageSeen authorMismatch authorUnknown timeMismatch composerRetained composerCleared composerEmpty editorPresent expectedDraftSubmitted sameEditor sameComposer editorReacquired targetMatched accountMatched scopeChanged accountProofPending accountVerifiedAtSubmission enterAttempted enterDefaultPrevented keyupDefaultPrevented documentHidden documentFocused allowed slowmodeDetected cooldownKnown retryRisk authorized enterPrevented keyupPrevented networkObserverReady networkError hiddenCooldownIndicator editorAriaDisabled editorAriaReadonly submitControlPresent submitControlDisabled'.split(' '));
const numbers=new Set('stableWaitMs stableRequiredMs maxStableMs maxSampleGapMs sampleCount eventAt scheduledAt startedAt elapsedMs latenessMs retryBackoffMs retryPermitMs networkOrdinal networkDurationMs slowmodeSeconds priorRetryCount editorCount selectionRanges draftLength renderedDraftLength expectedLength messageALength messageBLength draftLineCount expectedLineCount unicodeEmojiCount messageIndex retryCount maxSendRetries cooldownMs slowmodeMs remainingMs maxWaitMs observedAt confirmationMs'.split(' '));
export const validTraceStage=stage=>stages.has(stage);
export function traceData(input){const out={};if(!input||typeof input!=='object'||Array.isArray(input))return out;for(const [key,value]of Object.entries(input)){
 if(key==='failedChecks'&&Array.isArray(value))out[key]=[...new Set(value.filter(v=>['channel_changed','editor_detached','editor_count','editor_replaced','text_mismatch','composing','focus_lost','selection_missing','selection_not_collapsed','selection_outside'].includes(v)))];
 else if(booleans.has(key)&&typeof value==='boolean')out[key]=value;
 else if(numbers.has(key)&&typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=Number.MAX_SAFE_INTEGER)out[key]=value;
 else if(key==='httpStatus'&&Number.isInteger(value)&&value>=100&&value<=599)out[key]=value;
 else if(key==='maxSendRetries'&&value===null)out[key]=null;
 else if(key==='contentVersion'&&typeof value==='string'&&/^\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?$/.test(value)&&value.length<=40)out[key]=value;
 else if(key==='contentBuildId'&&typeof value==='string'&&/^[a-f0-9]{64}$/.test(value))out[key]=value;
 else if(key==='deliveryPhase'&&['prepare','commit','send'].includes(value))out[key]=value;
 else if(key==='observedPath'&&typeof value==='string'&&/^\/channels\/\d{1,30}\/\d{1,30}(?:\/\d{1,30})?\/?$/.test(value))out[key]=value;
 else if(['code','reasonCode'].includes(key)&&typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value))out[key]=value;
 else if(key==='result'&&['confirmed','uncertain','blocked','draft-retained','deferred','prepared','unverified'].includes(value))out[key]=value;
 else if(['status','submitMethod','editorReadMode'].includes(key)&&typeof value==='string'&&/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(value))out[key]=value;
 }return out;}
export function createDeliveryTracer({executor,now=Date.now}){
 const recent=new Map();return async(message,tabId)=>{
  await executor.load();const state=executor.state,a=state?.attempts?.[message?.id];
  if(!Number.isInteger(tabId)||!a||a.tabId!==tabId||a.sessionId!==state.sessionId||!validTraceStage(message.stage))return false;
  const at=now(),key=message.id+'\0'+message.stage,prior=recent.get(key);
  if(!['network-start','network-result'].includes(message.stage)&&prior!==undefined&&at-prior>=0&&at-prior<1000)return false;
  recent.set(key,at);if(recent.size>4000)recent.delete(recent.keys().next().value);
  const sequence=(a.traceSequence||0)+1;a.traceSequence=sequence;
  const data=traceData({...message.data,contentVersion:message.version,contentBuildId:message.buildId});const result=await executor.request({type:'DELIVERY_TRACE',attemptId:a.attemptId,sequence,stage:message.stage,observedAt:Number.isSafeInteger(data.eventAt)?data.eventAt:at,data});return result?.recorded===true;
 };
}
