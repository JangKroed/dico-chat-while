const $=selector=>document.querySelector(selector);
let sourceWindowId,activeTabId,busy=false,state=null,refreshGeneration=0;
const windowReady=chrome.windows.getCurrent().then(win=>{sourceWindowId=win.id;}).catch(()=>{});
const request=async(type,payload={})=>{
  await windowReady;
  const reply=await chrome.runtime.sendMessage({type,...payload,...(Number.isInteger(sourceWindowId)?{windowId:sourceWindowId}:{})});
  if(!reply?.ok)throw Error(reply?.error || '응답을 확인하지 못했습니다.');return reply.result;
};
function renderControls(){
  for(const button of document.querySelectorAll('button'))button.disabled=busy;
  const context=state?.activeTab;
  $('#register').disabled=busy||!state?.legacyDeclaration;
  $('#bind').disabled=busy||!state?.legacyDeclaration||!context?.eligible;
  $('#bind-reason').textContent=busy?'요청을 처리하고 있습니다.':!context?.eligible?(context?.reason||'현재 탭을 확인한 뒤 연결할 수 있습니다.'):!state?.legacyDeclaration?'아래에서 기존 실행기 사용 여부를 선택하고 ‘확인 상태 저장’을 먼저 눌러 주세요.':context.reason;
}
async function refresh(){
  const generation=++refreshGeneration;
  try{
    $('#version').textContent=`DICO 실행기 ${chrome.runtime.getManifest().version}`;
    const s=await request('CENTRAL_STATUS');if(generation!==refreshGeneration)return;state=s;
    activeTabId=s.activeTab?.tabId;
    $('#badge').textContent=s.connected?'연결됨':'연결 필요';
    $('#status').textContent=s.lastError || (s.connected?`관리 프로그램 연결됨 · 전송 채널 ${s.bindings}개`:'관리 프로그램을 실행한 뒤 다시 연결하세요.');
    $('#legacy-check').hidden=Boolean(s.legacyDeclaration);
    $('#tab-context').textContent=s.activeTab?.eligible?`서버 ${s.activeTab.guildId} · 채널 ${s.activeTab.channelId}`:'현재 탭: 연결할 서버 채널을 열어 주세요.';
    $('#account-status').textContent=s.account?`계정 ${s.account.accountId} · ${s.account.verified?'현재 확인됨':'다시 검증 필요'}`:'아직 등록된 계정이 없습니다.';
    if(s.legacyDeclaration){const input=document.querySelector(`input[value="${s.legacyDeclaration}"]`);if(input)input.checked=true;}
  }catch(error){if(generation!==refreshGeneration)return;state=null;$('#status').textContent=error.message;}
  renderControls();
}
function bind(id,type,payload=()=>({}),success='요청을 처리했습니다.'){
  $(id).addEventListener('click',async()=>{
    if(busy)return;
    busy=true;renderControls();$('#notice').textContent='처리 중…';
    try{await request(type,payload());$('#notice').textContent=success;}
    catch(error){$('#notice').textContent=error.message;}
    finally{busy=false;await refresh();}
  });
}
bind('#connect','CENTRAL_CONNECT',()=>({}),'관리 프로그램 연결 상태를 확인했습니다.');
bind('#open','CENTRAL_OPEN',()=>({}),'중앙 화면의 채널 설정을 열었습니다.');
bind('#register','CENTRAL_REGISTER_ACCOUNT',()=>({}),'계정을 등록했습니다. 현재 채널을 연결하거나 중앙 화면에서 사용할 채널을 선택하세요.');
bind('#bind','CENTRAL_BIND',()=>({}),'계정과 현재 채널의 연결 확인이 완료됐습니다. 메시지 적용은 중앙 화면에서 진행하세요.');
bind('#stop','CENTRAL_STOP',()=>({}),'이 브라우저를 긴급 중지했습니다. 진행 중이던 발송 결과는 중앙 화면에서 확인하세요.');
bind('#declare','CENTRAL_DECLARE',()=>({value:document.querySelector('input[name="legacy"]:checked')?.value}),'확인 상태를 저장했습니다. 현재 Discord 채널을 연결할 수 있습니다.');
const activated=info=>{if(info.windowId===sourceWindowId)void refresh();};
const updated=(tabId,change,tab)=>{if(tabId===activeTabId||tab.active&&tab.windowId===sourceWindowId)if(change.url||change.status)void refresh();};
const removed=(tabId,info)=>{if(info.windowId===sourceWindowId&&tabId===activeTabId)void refresh();};
chrome.tabs.onActivated.addListener(activated);chrome.tabs.onUpdated.addListener(updated);chrome.tabs.onRemoved.addListener(removed);
const poll=window.setInterval(()=>{if(!busy)void refresh();},5000);
window.addEventListener('unload',()=>{window.clearInterval(poll);chrome.tabs.onActivated.removeListener(activated);chrome.tabs.onUpdated.removeListener(updated);chrome.tabs.onRemoved.removeListener(removed);});
void refresh();

$('#load-backups').addEventListener('click',async()=>{
 try{
  const result=await request('CENTRAL_DRAFT_BACKUPS'),list=$('#backup-list');list.replaceChildren();
  for(const backup of [...(result.backups||[])].reverse()){
   const label=document.createElement('p');label.textContent=`${new Date(backup.createdAt).toLocaleString()} · 계정 ${backup.accountId} · 채널 ${backup.channelId}`;
   const field=document.createElement('textarea');field.readOnly=true;field.rows=5;field.value=backup.text;field.setAttribute('aria-label','보관한 초안 원문');field.style.width='100%';
   list.append(label,field);
  }
  if(!result.backups?.length)list.textContent='보관한 초안이 없습니다.';
 }catch(error){$('#notice').textContent=error.message;}
});

$('#clear-backups').addEventListener('click',async()=>{
 if(!confirm('보관한 초안 원문을 모두 삭제할까요? 필요한 문구는 먼저 복사해 주세요.'))return;
 try{await request('CENTRAL_CLEAR_DRAFT_BACKUPS');$('#backup-list').textContent='보관한 초안을 삭제했습니다.';}catch(error){$('#notice').textContent=error.message;}
});
