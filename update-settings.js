import {UPDATE_ORIGIN,checkForUpdate} from './update-check.js';
const status=document.querySelector('#update-status'),button=document.querySelector('#check-update'),link=document.querySelector('#download-update');
function render(result){
 link.hidden=true;
 if(result.disabled){status.textContent='업데이트 확인을 한 번 허용하면 브라우저 실행 중 매시간 새 버전을 확인합니다.';return;}
 if(result.error){status.textContent=result.error+' · 잠시 후 다시 확인하세요.';return;}
 if(result.update){link.href=result.update.url;link.hidden=false;status.textContent=`현재 ${chrome.runtime.getManifest().version} → 새 버전 ${result.update.version}. 보조 프로그램 연결 시 모두 중지한 뒤 자동 적용합니다. 미연결이면 ZIP으로 업데이트하세요.`;}
 else status.textContent=result.noRelease?'아직 GitHub에 게시된 정식 버전이 없습니다.':`현재 ${chrome.runtime.getManifest().version} · 게시된 새 버전이 없습니다.`;
}
button.addEventListener('click',async()=>{
 try{
  // Permission is requested directly from the click, never in a timer.
  const allowed=await chrome.permissions.request({origins:[UPDATE_ORIGIN]});
  if(!allowed){render({disabled:true});return;}
  button.disabled=true;status.textContent='새 버전 확인 중…';render(await checkForUpdate(chrome,true));
 }catch(error){status.textContent=`확인 실패: ${error.message}`;}finally{button.disabled=false;}
});
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.releaseCheck)render(changes.releaseCheck.newValue||{disabled:true});});
checkForUpdate(chrome).then(render).catch(error=>{status.textContent=`확인 실패: ${error.message}`;});

const autoStatus=document.querySelector('#auto-update-status'),connect=document.querySelector('#connect-updater'),apply=document.querySelector('#apply-update'),autoToggle=document.querySelector('#auto-update-enabled');
document.querySelector('#updater-extension-id').value=chrome.runtime.id;
for(const platform of ['macos','windows'])document.querySelector(`#helper-${platform}`).href=`https://github.com/JangKroed/dico-chat-while/releases/download/v${chrome.runtime.getManifest().version}/dico-updater-${platform}.zip`;
async function refreshAuto(){
 const settings=await chrome.storage.local.get(['autoUpdateEnabled','autoUpdateStatus']);
 autoToggle.checked=settings.autoUpdateEnabled===true;
 const applying=settings.autoUpdateStatus?.phase==='applying';autoToggle.disabled=applying;apply.disabled=applying;connect.disabled=applying;
 autoStatus.textContent=settings.autoUpdateStatus?.message || '보조 프로그램을 최초 한 번 연결하세요.';
}
connect.addEventListener('click',async()=>{
 connect.disabled=true;autoStatus.textContent='보조 프로그램 연결 확인 중…';
 try{
  if(!await chrome.permissions.request({permissions:['nativeMessaging'],origins:[UPDATE_ORIGIN]}))throw Error('연결 권한이 허용되지 않았습니다.');
  const result=await chrome.runtime.sendMessage({type:'DICO_UPDATER_PROBE'});
  if(!result?.ok)throw Error(result?.error || '연결 응답이 없습니다.');
  await chrome.storage.local.set({autoUpdateEnabled:true,autoUpdateStatus:{phase:'connected',message:'자동 업데이트 연결 완료. 새 정식 버전을 확인하고, 모든 채널이 중지되면 자동 적용합니다.'}});
  await checkForUpdate(chrome,true);
 }catch(error){autoStatus.textContent=`연결 실패: ${error.message} · 설치 앱에서 이 확장 ID와 설치 폴더를 연결했는지 확인하세요.`;}
 finally{connect.disabled=false;}
});
autoToggle.addEventListener('change',async()=>{
 if(autoToggle.checked){autoToggle.checked=false;connect.click();return;}
 await chrome.storage.local.set({autoUpdateEnabled:false,autoUpdateStatus:{phase:'disabled',message:'자동 적용을 껐습니다. 필요할 때 지금 적용 버튼을 사용할 수 있습니다.'}});
});
apply.addEventListener('click',async()=>{
 apply.disabled=true;
 try{
  if(!await chrome.permissions.request({permissions:['nativeMessaging']}))throw Error('보조 프로그램 연결 권한이 필요합니다.');
  const result=await chrome.runtime.sendMessage({type:'DICO_UPDATER_APPLY'});
  if(!result?.ok)throw Error(result?.error || '업데이트 응답이 없습니다.');
  await refreshAuto();
 }catch(error){autoStatus.textContent=`업데이트 안내: ${error.message}`;}finally{apply.disabled=false;}
});
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&(changes.autoUpdateStatus||changes.autoUpdateEnabled))void refreshAuto();});
void refreshAuto();
