// Service-worker timers avoid the chained timer throttling of hidden Discord
// pages. This schedules a wake-up only; it grants no input or send permission.
export async function managedPageDelay(message,sender,state,{extensionId,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  const durationMs=message?.durationMs;
  let discord=false;try{discord=new URL(sender?.url).origin==='https://discord.com';}catch{}
  if(sender?.id!==extensionId||!discord||(sender.frameId!==undefined&&sender.frameId!==0)||!Number.isInteger(sender.tab?.id)||!Object.values(state?.bindings||{}).some(binding=>binding.tabId===sender.tab.id)||!Number.isInteger(durationMs)||durationMs<0||durationMs>1000)return{ok:false};
  await wait(durationMs);
  return{ok:true};
}
