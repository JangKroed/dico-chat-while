// 호스트가 연 프로필의 일회용 표식만 중앙에 돌려줍니다.
// 계정 확인, 설정 적용 및 발송 권한은 기존 연결 절차에서 별도로 확인합니다.
(() => {
  const match=/^#dico-profile=([a-f0-9]{32})$/.exec(location.hash);
  if(!match)return;
  void chrome.runtime.sendMessage({type:'DICO_PROFILE_PROBE',probeId:match[1]}).catch(()=>{});
  history.replaceState(history.state,'',location.pathname+location.search);
})();
