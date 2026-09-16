const button = document.querySelector('#download-diagnostics');
const status = document.querySelector('#diagnostic-status');
button.addEventListener('click', async () => {
  try {
    const {diagnosticLog=[]} = await chrome.storage.local.get('diagnosticLog');
    const report = {schemaVersion:2,version:chrome.runtime.getManifest().version, exportedAt:new Date().toISOString(), browser:navigator.userAgent, events:diagnosticLog};
    const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
    const link=document.createElement('a');
    link.href=url;link.download=`dico-diagnostics-${Date.now()}.json`;link.click();
    setTimeout(()=>URL.revokeObjectURL(url),10000);
    status.textContent='진단 로그를 저장했습니다. 오류가 발생한 기기에서 받은 파일을 전달해 주세요.';
  } catch(error) {status.textContent=`로그 저장 실패: ${error.message}`;}
});
