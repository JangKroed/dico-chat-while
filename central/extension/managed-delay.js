// Service-worker timers avoid the chained timer throttling of hidden Discord
// pages. This schedules a wake-up only; it grants no input or send permission.
export async function managedPageDelay(message,sender,state,{extensionId,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  const durationMs=message?.durationMs;
  let url;try{url=new URL(sender?.url);}catch{}
  if(sender?.id!==extensionId||url?.origin!=='https://discord.com'||(sender.frameId!==undefined&&sender.frameId!==0)||!Number.isInteger(sender.tab?.id)||!Number.isInteger(durationMs)||durationMs<0||durationMs>1000)return{ok:false};
  const matchesRoute=context=>url.pathname===`/channels/${context.guildId}/${context.channelId}`;
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
  if(!allowed())return{ok:false};
  await wait(durationMs);
  return{ok:allowed()};
}
