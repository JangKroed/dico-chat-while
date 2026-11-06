const filter={urls:['https://discord.com/api/*'],types:['xmlhttprequest']};
const endpoint=/^https:\/\/discord\.com\/api\/(?:v\d+\/)?channels\/(\d+)\/messages(?:\?[^#]*)?$/;
const maxRequestsPerAttempt=12;
const pendingLimit=128;
const lifetimeMs=120000;

/**
 * 관리 탭의 진행 중 발송과 같은 채널에서 나간 POST만 관측합니다.
 * 요청 ID는 응답 연결에만 쓰고, 본문·헤더·URL·오류 원문은 전달하지 않습니다.
 */
export function observeDiscordSendRequests(webRequest,executor,trace) {
 const pending=new Map(),counts=new WeakMap();
 const emit=(entry,stage,data)=>{
  try{Promise.resolve(trace({id:entry.attempt.attemptId,stage,data:{retryCount:entry.retryCount,networkOrdinal:entry.ordinal,...data}},entry.tabId)).catch(()=>{});}catch{}
 };
 const begin=details=>{
  if(details.method!=='POST'||details.initiator!=='https://discord.com'||details.frameId!==0||!Number.isInteger(details.tabId)||details.tabId<0)return;
  const channelId=endpoint.exec(details.url)?.[1];
  if(!channelId||!Number.isFinite(details.timeStamp)||pending.has(details.requestId))return;
  const state=executor.state;
  const candidates=Object.values(state?.attempts||{}).filter(a=>a.phase==='executing'&&a.enterRequested===true&&a.sessionId===state.sessionId&&a.tabId===details.tabId&&a.channelId===channelId);
  if(candidates.length!==1)return;
  const [attempt]=candidates,count=counts.get(attempt)||0;
  if(count>=maxRequestsPerAttempt)return;
  for(const [id,entry] of pending)if(details.timeStamp-entry.startedAt>lifetimeMs)pending.delete(id);
  if(pending.size>=pendingLimit)pending.delete(pending.keys().next().value);
  const entry={attempt,tabId:details.tabId,retryCount:attempt.sendRetryCount??0,ordinal:count+1,startedAt:details.timeStamp};
  counts.set(attempt,count+1);
  pending.set(details.requestId,entry);
  emit(entry,'network-start',{eventAt:Math.round(details.timeStamp)});
 };
 const finish=(details,failed)=>{
  const entry=pending.get(details.requestId);
  if(!entry)return;
  pending.delete(details.requestId);
  const state=executor.state,duration=details.timeStamp-entry.startedAt;
  if(!state||entry.attempt.sessionId!==state.sessionId||state.attempts[entry.attempt.attemptId]!==entry.attempt||
    details.tabId!==entry.tabId||!Number.isFinite(duration)||duration<0||duration>lifetimeMs)return;
  if(!failed&&(!Number.isInteger(details.statusCode)||details.statusCode<100||details.statusCode>599))return;
  emit(entry,'network-result',{eventAt:Math.round(details.timeStamp),networkDurationMs:Math.round(duration),
    ...(failed?{networkError:true}:{httpStatus:details.statusCode})});
 };
 const listeners=[[webRequest?.onBeforeRequest,begin],[webRequest?.onCompleted,d=>finish(d,false)],[webRequest?.onErrorOccurred,d=>finish(d,true)]];
 if(listeners.some(([event])=>typeof event?.addListener!=='function'))return false;
 try{
  for(const [event,listener] of listeners)event.addListener(listener,filter);
  return true;
 }catch{
  for(const [event,listener] of listeners){try{event.removeListener(listener);}catch{}}
  pending.clear();
  return false;
 }
}
