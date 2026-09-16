const LOADING_CODES=new Set(['EDITOR_LOADING','HISTORY_LOADING','CONNECTING','PAGE_LOADING','TAB_SUSPENDED']);
export async function recoverLoading({probe,reload,cancelled=()=>false,readCount=async()=>0,saveCount=async()=>{},onAttempt=async()=>{},maxAttempts=10}) {
  let attempts=await readCount();
  while(true){
    if(cancelled())return {ok:false,code:'CANCELLED',error:'사용자 중지 요청으로 자동 복구를 취소했습니다.'};
    const result=await probe();
    if(result?.ok){await saveCount(0);return result;}
    if(!LOADING_CODES.has(result?.code))return result;
    if(attempts>=maxAttempts)return {ok:false,code:'RECOVERY_EXHAUSTED',error:`로딩 자동 복구 ${maxAttempts}회에 실패했습니다. 마지막 상태: ${result.error || result.code}. 전송용 창의 로그인·채널 권한·네트워크를 확인하세요.`};
    if(cancelled())continue;
    attempts++;
    await saveCount(attempts);
    await onAttempt(attempts,result.code);
    if(cancelled())continue;
    try{await reload();}catch{return {ok:false,code:'RECOVERY_RELOAD_FAILED',error:'전송용 탭을 새로고침하지 못했습니다. 탭이 닫혔는지 확인하세요.'};}
  }
}
