/**
 * 누락된 등록 탭만 복구합니다. 로그인 관찰의 일시 실패는 동일 장애의 예산을
 * 초기화하지 않습니다. 대상 집합/세션이 바뀌거나 누락 상태가 해소돼야 재무장합니다.
 * 안전 조건으로 차단된 확인은 실제 복구 시도와 구분하며, 확인 자체도 간격을 둡니다.
 */
export function createRecoveryScheduler({now=Date.now,intervalMs=10000,maxAttempts=3,maxDelayMs=60000}={}){
 let fingerprint='',attempts=0,nextAt=0,running=false,eligible=false,generation=0;
 return {
  observe(snapshot){
   const missing=(snapshot.channels||[]).filter(c=>c.verified!==true&&c.verificationReason==='tab_missing');
   const next=missing.length?JSON.stringify([snapshot.sessionId,snapshot.account?.accountId,missing.map(c=>[c.accountId,c.guildId,c.channelId,c.tabId]).sort()]):'';
   eligible=snapshot.account?.verified!==false;
   if(next!==fingerprint){fingerprint=next;attempts=0;nextAt=0;generation++;}
  },
  async run({safe,repair}){
   if(!fingerprint||!eligible||running||attempts>=maxAttempts||now()<nextAt||!safe())return false;
   const version=generation;running=true;
   try{
    const result=await repair();
    // 이전 장애의 늦은 완료가 새 장애의 예산/대기 시간을 덮어쓰지 않도록 합니다.
    if(version!==generation)return false;
    if(result?.attempted!==false)attempts++;
    nextAt=now()+Math.min(maxDelayMs,intervalMs*2**Math.max(0,attempts-1));
    return !result?.status||result.status==='completed';
   }catch{
    if(version===generation){attempts++;nextAt=now()+Math.min(maxDelayMs,intervalMs*2**(attempts-1));}
    return false;
   }finally{running=false;}
  },
  get state(){return{pending:Boolean(fingerprint)&&attempts<maxAttempts,attempts,running,nextAt};}
 };
}
