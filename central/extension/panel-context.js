export function channelTabContext(tab) {
  const disabled=reason=>({eligible:false,...(Number.isInteger(tab?.id)?{tabId:tab.id}:{}),reason});
  if(!Number.isInteger(tab?.id))return disabled('현재 브라우저 탭을 확인할 수 없습니다. 연결할 Discord 서버 채널을 열어 주세요.');
  if(tab.status==='loading')return disabled('현재 탭을 불러오는 중입니다. Discord 채널이 열린 뒤 연결해 주세요.');
  if(typeof tab.url!=='string')return disabled('현재 탭 주소를 확인할 수 없습니다. 연결할 Discord 서버 채널을 열어 주세요.');
  const target=/^https:\/\/discord\.com\/channels\/(\d{1,30})\/(\d{1,30})\/?$/.exec(tab.url);
  if(!target)return disabled(tab.url.startsWith('https://discord.com/channels/@me')?'친구 목록·DM에서는 채널을 연결할 수 없습니다. 서버의 텍스트 채널을 열어 주세요.':'현재 탭이 Discord 서버 채널이 아닙니다. 연결할 서버 텍스트 채널을 열어 주세요.');
  return{eligible:true,tabId:tab.id,guildId:target[1],channelId:target[2],reason:'현재 Discord 서버 채널을 연결할 수 있습니다.'};
}
