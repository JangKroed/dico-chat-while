// Service-worker timers avoid the chained timer throttling of hidden Discord
// pages. This schedules a wake-up only; it grants no input or send permission.
export async function managedPageDelay(message,sender,state,{extensionId,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  const durationMs=message?.durationMs;
  let url;try{url=new URL(sender?.url);}catch{}
  const rejected=reasonCode=>({ok:false,reasonCode});
  if(sender?.id!==extensionId||url?.origin!=='https://discord.com'||(sender.frameId!==undefined&&sender.frameId!==0)||!Number.isInteger(sender.tab?.id))return rejected('DELAY_INVALID_SENDER');
  if(!Number.isInteger(durationMs)||durationMs<0||durationMs>1000)return rejected('DELAY_INVALID_DURATION');
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
  return allowed()?{ok:true}:rejection();
}
