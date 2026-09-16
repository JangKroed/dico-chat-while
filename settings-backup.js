import {parseChannel,validateSettings,minimumInterval} from './controller.js';
export function exportSettings(root) {
  if (root.channels.some(c=>c.enabled || c.pending)) throw new Error('모두 중지하고 미확인 전송 결과를 확인한 뒤 백업하세요.');
  return {format:'dico-settings',version:1,createdAt:new Date().toISOString(),channels:root.channels.map(c=>({
    name:c.name,skipConfirmation:c.skipConfirmation===true,slowmodeSeconds:c.slowmodeSeconds ?? null,messages:[...c.messages],intervalSeconds:c.intervalSeconds,ownUserId:c.ownUserId,
    nextIndex:c.nextIndex,url:c.target?.url || null,
  }))};
}
export function importSettings(data) {
  if(data?.format!=='dico-settings' || data.version!==1 || !Array.isArray(data.channels) || !data.channels.length || data.channels.length>100) throw new Error('지원하는 설정 백업 파일이 아닙니다.');
  const destinations=new Set();
  return data.channels.map(c=>{
    if(!c || typeof c.name!=='string' || !c.name.trim() || c.name.trim().length>80 || ![0,1].includes(c.nextIndex)) throw new Error('채널 이름 또는 A/B 순서가 올바르지 않습니다.');
    validateSettings({...c,messages:Array.isArray(c.messages)?c.messages.map(text=>typeof text==='string' && !text.trim() && text.length<=2000?'미설정':text):c.messages});
    if(c.slowmodeSeconds!=null && (!Number.isInteger(c.slowmodeSeconds)||c.slowmodeSeconds<=0||c.slowmodeSeconds>21600)) throw new Error('슬로우 모드 시간이 올바르지 않습니다.');
    const parsed=c.url===null?null:parseChannel(c.url);
    if(c.url!==null && !parsed) throw new Error('백업의 채널 주소가 올바르지 않습니다.');
    const key=parsed && `${parsed.guildId}/${parsed.channelId}`;
    if(key && destinations.has(key)) throw new Error('백업에 중복 채팅방이 있습니다.');
    if(key)destinations.add(key);
    return {name:c.name.trim(),skipConfirmation:c.skipConfirmation===true,messages:[...c.messages],intervalSeconds:Math.max(c.intervalSeconds,minimumInterval(c)),slowmodeSeconds:c.slowmodeSeconds??null,ownUserId:c.ownUserId||'',nextIndex:c.nextIndex,
      target:parsed?{...parsed,url:`https://discord.com/channels/${key}`,tabId:0,title:c.name}:null};
  });
}
