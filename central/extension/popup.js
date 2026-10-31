const $=selector=>document.querySelector(selector);
const request=async(type,payload={})=>{const reply=await chrome.runtime.sendMessage({type,...payload});if(!reply?.ok)throw Error(reply?.error || '응답을 확인하지 못했습니다.');return reply.result;};
async function refresh(){
  try{
    $('#version').textContent=`DICO 실행기 ${chrome.runtime.getManifest().version}`;
    const s=await request('CENTRAL_STATUS');$('#badge').textContent=s.connected?'연결됨':'연결 필요';
    $('#status').textContent=s.lastError || (s.connected?`관리 프로그램 연결됨 · 전송 채널 ${s.bindings}개`:'관리 프로그램을 실행한 뒤 다시 연결하세요.');
    $('#legacy-check').hidden=Boolean(s.legacyDeclaration);
    $('#register').disabled=!s.legacyDeclaration;
    $('#bind').disabled=!s.legacyDeclaration;
    $('#account-status').textContent=s.account?`계정 ${s.account.accountId} · ${s.account.verified?'현재 확인됨':'다시 검증 필요'}`:'아직 등록된 계정이 없습니다.';
    if(s.legacyDeclaration){const input=document.querySelector(`input[value="${s.legacyDeclaration}"]`);if(input)input.checked=true;}
  }catch(error){$('#status').textContent=error.message;}
}
function bind(id,type,payload=()=>({}),success='요청을 처리했습니다.'){
  $(id).addEventListener('click',async()=>{
    for(const button of document.querySelectorAll('button'))button.disabled=true;
    $('#notice').textContent='처리 중…';
    try{await request(type,payload());$('#notice').textContent=success;}
    catch(error){$('#notice').textContent=error.message;}
    finally{for(const button of document.querySelectorAll('button'))button.disabled=false;await refresh();}
  });
}
bind('#connect','CENTRAL_CONNECT',()=>({}),'관리 프로그램 연결 상태를 확인했습니다.');
bind('#open','CENTRAL_OPEN',()=>({}),'중앙 화면의 채널 설정을 열었습니다.');
bind('#register','CENTRAL_REGISTER_ACCOUNT',()=>({}),'계정을 등록했습니다. 중앙 화면에서 연결할 채널을 선택하세요.');
bind('#bind','CENTRAL_BIND',()=>({}),'계정과 현재 채널의 연결 확인이 완료됐습니다. 메시지 적용은 중앙 화면에서 진행하세요.');
bind('#stop','CENTRAL_STOP',()=>({}),'이 브라우저를 긴급 중지했습니다. 진행 중이던 발송 결과는 중앙 화면에서 확인하세요.');
bind('#declare','CENTRAL_DECLARE',()=>({value:document.querySelector('input[name="legacy"]:checked')?.value}),'확인 상태를 저장했습니다. 이제 Discord 계정을 등록하세요.');
void refresh();
