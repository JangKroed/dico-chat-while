// Service-worker timers avoid the chained timer throttling of hidden Discord
// pages. This schedules a wake-up only; it grants no input or send permission.
export async function managedPageDelay(message,sender,state,{extensionId,resolveDocument,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  const durationMs=message?.durationMs;
  let url;try{url=new URL(sender?.url);}catch{}
  const rejected=reasonCode=>({ok:false,reasonCode});
  if(sender?.id!==extensionId||url?.origin!=='https://discord.com'||(sender.frameId!==undefined&&sender.frameId!==0)||!Number.isInteger(sender.tab?.id))return rejected('DELAY_INVALID_SENDER');
  if(!Number.isInteger(durationMs)||durationMs<0||durationMs>1000)return rejected('DELAY_INVALID_DURATION');
  if(sender.documentLifecycle!==undefined&&sender.documentLifecycle!=='active')return rejected('DELAY_DOCUMENT_UNAVAILABLE');
  const sessionId=state?.sessionId;
  // Chrome의 sender.url은 SPA 이동 전 문서 생성 경로에 남을 수 있습니다.
  // 탭 경로와 다를 때만 동일 documentId의 실제 location을 조회합니다. 탭 URL만
  // 믿으면 문서 교체 직전의 오래된 요청을 새 문서의 요청으로 잘못 해석할 수 있습니다.
  const needsDocument=typeof sender.tab?.url==='string'&&sender.tab.url!==sender.url;
  const refreshDocument=async()=>{
    if(!needsDocument)return true;
    if(typeof sender.documentId!=='string'||!sender.documentId||typeof resolveDocument!=='function')return false;
    try{
      const current=await resolveDocument(sender),currentUrl=new URL(current?.url);
      if(current?.documentId!==sender.documentId||current?.frameId!==0||currentUrl.origin!=='https://discord.com')return false;
      url=currentUrl;return true;
    }catch{return false;}
  };
  if(!await refreshDocument())return rejected('DELAY_DOCUMENT_UNAVAILABLE');
  if(state?.sessionId!==sessionId)return rejected('DELAY_SESSION_MISMATCH');
  // 탭 재사용과 같은 채널 경로 규칙을 사용하며 마지막 슬래시 한 개만 정규화합니다.
  const matchesRoute=context=>url.pathname.replace(/\/$/,'')===`/channels/${context.guildId}/${context.channelId}`;
  const allowed=()=>{
    const bindings=state?.bindings||{};
    // CONFIG_SYNC is versioned by message/settings changes, not tab lifetime.
    // Reopening a channel may keep its version while PREPARE has the new tab.
    // Use that current-session, validated attempt as the execution context.
    for(const attempt of Object.values(state?.attempts||{})){
      const binding=bindings[attempt.bindingId];
      if(attempt.tabId===sender.tab.id&&attempt.sessionId===state.sessionId&&['preparing','prepared','executing','confirmed'].includes(attempt.phase)&&binding&&['accountId','guildId','channelId','configVersion'].every(key=>binding[key]===attempt[key])&&matchesRoute(attempt))return true;
    }
    // Configuration alone also supports read-only channel observations before
    // the first attempt, but a same-tab navigation is not the managed target.
    return Object.values(bindings).some(binding=>binding.tabId===sender.tab.id&&matchesRoute(binding));
  };
  const rejection=()=>{
    // 실패 원인은 고정 코드만 반환합니다. 메시지 본문·탭 ID·계정 ID는 진단에 싣지 않으며,
    // 이 분류는 위 allowed 검사를 통과시키거나 실패한 작업을 재실행하지 않습니다.
    const bindings=Object.values(state?.bindings||{}).filter(binding=>binding.tabId===sender.tab.id);
    const attempts=Object.values(state?.attempts||{}).filter(attempt=>attempt.tabId===sender.tab.id);
    if(!bindings.length&&!attempts.length)return rejected('DELAY_UNREGISTERED_TAB');
    if(![...bindings,...attempts].some(matchesRoute))return rejected('DELAY_ROUTE_MISMATCH');
    if(attempts.some(attempt=>matchesRoute(attempt)&&attempt.sessionId!==state.sessionId))return rejected('DELAY_SESSION_MISMATCH');
    return rejected('DELAY_CONTEXT_MISMATCH');
  };
  if(!allowed())return rejection();
  await wait(durationMs);
  // SPA 조회 경로는 대기 뒤에도 같은 문서인지 다시 확인합니다. 대기는 발송 권한이
  // 아니며, 실제 입력은 기존 실행기에서 현재 채널·계정·세션 승인을 별도로 확인합니다.
  if(!await refreshDocument())return rejected('DELAY_DOCUMENT_UNAVAILABLE');
  if(state?.sessionId!==sessionId)return rejected('DELAY_SESSION_MISMATCH');
  return allowed()?{ok:true}:rejection();
}
