const status=document.querySelector('#backup-status');
const request=async(type,payload={})=>{
 const result=await chrome.runtime.sendMessage({type,...payload});
 if(!result?.ok)throw new Error(result?.error||'요청 실패');
 return result;
};
document.querySelector('#backup-export').addEventListener('click',async()=>{
 try{
  const {backup}=await request('DICO_EXPORT_SETTINGS');
  const url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=`dico-settings-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
  status.textContent='설정을 백업했습니다. 이 파일에는 공지 문구가 포함됩니다.';
 }catch(error){status.textContent=error.message;}
});
document.querySelector('#backup-import').addEventListener('change',async event=>{
 const file=event.target.files[0];if(!file)return;
 try{
  if(file.size>1000000)throw new Error('백업 파일은 1MB 이하여야 합니다.');
  const backup=JSON.parse(await file.text());
  if(!window.confirm('저장된 채널 설정을 백업 내용으로 교체합니다. 계속할까요?'))return;
  await request('DICO_IMPORT_SETTINGS',{backup});
  status.textContent='설정을 복원했습니다. 내용을 확인한 뒤 시작하세요.';
 }catch(error){status.textContent=error.message;}
 finally{event.target.value='';}
});
