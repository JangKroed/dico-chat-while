// Reuse the content script's visible Discord setting inspection. An unreadable
// setting is unknown, never an instruction to clear a previously known limit.
export async function observeChannelLimit(chrome,record) {
  let timer;
  try {
    const target={guildId:record.guildId,channelId:record.channelId,ownUserId:record.accountId,coordinated:true};
    const response=await Promise.race([chrome.tabs.sendMessage(record.tabId,{type:'DICO_CHANNEL_LIMIT',target}),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1500);})]);
    const seconds=response?.slowmodeSeconds;
    if(!Number.isInteger(seconds)||seconds<0||seconds>21600)return{};
    const tab=await chrome.tabs.get(record.tabId),url=new URL(tab.url);
    if(url.origin!=='https://discord.com'||url.pathname!==`/channels/${record.guildId}/${record.channelId}`)return{};
    return{slowmodeMs:seconds*1000};
  } catch {return{};} finally{clearTimeout(timer);}
}
