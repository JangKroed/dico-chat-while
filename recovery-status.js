const element=document.querySelector('#recovery-status');
function render(value){
 element.hidden=!value;
 element.textContent=value?`로딩 자동 복구 중 · ${value.attempt}/10회. 기존 전송용 탭을 새로고침하고 있습니다. 중지 버튼으로 취소할 수 있습니다.`:'';
}
render((await chrome.storage.local.get('loadingRecoveryStatus')).loadingRecoveryStatus);
chrome.storage.onChanged.addListener(changes=>{if(changes.loadingRecoveryStatus)render(changes.loadingRecoveryStatus.newValue);});
