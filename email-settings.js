import {validateMailConfig,sendReport} from './email-report.js';
const url=document.querySelector('#mail-url'),key=document.querySelector('#mail-key'),enabled=document.querySelector('#mail-enabled'),status=document.querySelector('#mail-status');
const origins=['https://script.google.com/*','https://script.googleusercontent.com/*'];
const {mailConfig,mailStatus}=await chrome.storage.local.get(['mailConfig','mailStatus']);
url.value=mailConfig?.url||'';key.value=mailConfig?.key||'';enabled.checked=Boolean(mailConfig?.enabled);status.textContent=mailStatus||'연결 후 새 오류부터 자동 발송합니다.';
document.querySelector('#mail-save').addEventListener('click',async()=>{
 try {
  const config={url:url.value.trim(),key:key.value.trim(),enabled:enabled.checked};
  if(config.enabled){validateMailConfig(config);if(!await chrome.permissions.request({origins}))throw new Error('메일 서버 연결 권한이 필요합니다.');}
  await chrome.storage.local.set({mailConfig:config});
  status.textContent=config.enabled?'자동 발송 설정을 저장했습니다. 테스트 메일로 수신을 확인하세요.':'자동 메일 발송을 껐습니다.';
 }catch(error){status.textContent=error.message;}
});
document.querySelector('#mail-test').addEventListener('click',async event=>{
 event.target.disabled=true;
 try {
  const {mailConfig:config}=await chrome.storage.local.get('mailConfig');
  await sendReport(chrome,config,{id:crypto.randomUUID(),createdAt:new Date().toISOString(),version:chrome.runtime.getManifest().version,events:[{kind:'test',reason:'DICO 연결 테스트'}]});
  status.textContent='테스트 메일 발송 처리 완료. didlsdydgh@gmail.com의 받은편지함과 스팸함을 확인하세요.';
 }catch{status.textContent='발송 실패 또는 응답 확인 불가. 저장한 URL·키·권한 및 받은편지함을 확인하세요.';}
 finally{event.target.disabled=false;}
});
chrome.storage.onChanged.addListener(changes=>{if(changes.mailStatus)status.textContent=changes.mailStatus.newValue;});
