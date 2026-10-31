// Self-contained for chrome.scripting isolated-world injection. Only the visible
// own-user panel is inspected; no auth storage, token or Discord private API.
export function pageIdentityObservation() {
  if(location.origin!=='https://discord.com')return {verified:false,reason:'NOT_DISCORD'};
  const match=location.pathname.match(/^\/channels\/(\d+)\/(\d+)(?:\/\d+)?\/?$/);
  const panel=document.querySelector('section[class*="panels"], div[class*="panels"], section[aria-label="User area"], section[aria-label="사용자 영역"]');
  const base={guildId:match?.[1]||null,channelId:match?.[2]||null,name:document.title};
  if(!panel)return {...base,verified:false,reason:'ACCOUNT_PANEL_MISSING'};
  let defaultAvatar=false;
  for(const img of panel.querySelectorAll('img')) {
    const source=img.getAttribute('src')||'';
    const found=source.match(/\/(?:avatars\/(\d{17,20})|users\/(\d{17,20})\/avatars)\//);
    if(found)return{...base,accountId:found[1]||found[2],verified:true};
    if(/\/embed\/avatars\//.test(source))defaultAvatar=true;
  }
  return{...base,verified:false,reason:defaultAvatar?'DEFAULT_AVATAR':'ACCOUNT_UNREADABLE'};
}
export function identityFailureMessage(seen) {
  return {NOT_DISCORD:'Discord 웹에서 로그인한 뒤 다시 눌러 주세요.',ACCOUNT_PANEL_MISSING:'왼쪽 아래 내 프로필 영역을 찾지 못했습니다. Discord 화면 로딩을 기다린 뒤 다시 확인하세요.',DEFAULT_AVATAR:'기본 아바타에서는 현재 계정 ID를 검증할 수 없습니다. 프로필 이미지를 설정한 뒤 Discord를 새로고침해 주세요.',ACCOUNT_UNREADABLE:'내 프로필에서 계정 ID를 확인하지 못했습니다. 로그인과 프로필 이미지를 확인하세요.',SCRIPT_UNAVAILABLE:'Discord 화면을 읽지 못했습니다. Discord 탭을 새로고침한 뒤 확장 접근 권한을 확인하세요.'}[seen?.reason]||'Discord 로그인 계정을 확인하지 못했습니다. 화면을 새로고침한 뒤 다시 확인하세요.';
}
