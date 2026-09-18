import {UPDATE_ORIGIN,checkForUpdate} from './update-check.js';
const status=document.querySelector('#update-status'),button=document.querySelector('#check-update'),link=document.querySelector('#download-update');
function render(result){
 link.hidden=true;
 if(result.disabled){status.textContent='업데이트 확인을 한 번 허용하면 브라우저 실행 중 매시간 새 버전을 확인합니다.';return;}
 if(result.error){status.textContent=result.error+' · 잠시 후 다시 확인하세요.';return;}
 if(result.update){link.href=result.update.url;link.hidden=false;status.textContent=`현재 ${chrome.runtime.getManifest().version} → 새 버전 ${result.update.version}. 모두 중지한 뒤 ZIP을 기존 폴더에 덮어쓰고 확장 프로그램을 새로고침하세요.`;}
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
