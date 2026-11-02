// Metadata only: inspect an already open, exact Discord channel without opening,
// activating, modifying, or sending to any tab.
export async function lookupExistingChannelName(chrome,observe,{guildId,channelId}) {
  if(!/^\d{1,30}$/.test(guildId||'')||!/^\d{1,30}$/.test(channelId||''))return null;
  let tabs;try{tabs=await chrome.tabs.query({url:'https://discord.com/channels/*'});}catch{return null;}
  for(const tab of tabs.slice(0,100)){
    let url;try{url=new URL(tab.url);}catch{continue;}
    const path=url.pathname.match(/^\/channels\/(\d+)\/(\d+)(?:\/\d+)?\/?$/);
    if(url.origin!=='https://discord.com'||path?.[1]!==guildId||path?.[2]!==channelId||!Number.isInteger(tab.id))continue;
    let seen;try{seen=await observe(tab.id);}catch{continue;}
    if(seen?.verified!==true||seen.guildId!==guildId||seen.channelId!==channelId)continue;
    const name=typeof seen.channelName==='string'?seen.channelName.trim():typeof seen.name==='string'?seen.name.trim():'';
    if(name&&name.length<=100&&name!==channelId&&!/[\u0000-\u001f\u007f]/.test(name))return name;
  }
  return null;
}
