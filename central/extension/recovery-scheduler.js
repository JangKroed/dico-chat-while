/**
 * 연결은 살아 있는데 관리 탭이 사라진 경우에도 관찰 결과로 복구를 예약합니다.
 * 사용자가 다른 채널로 이동한 탭, 계정 불일치, 미확인 발송에는 탭을 새로 열지 않습니다.
 * 동일 장애는 10초 간격 최대 3회 시도하고, 정상 관찰 뒤 새 장애가 생기면 다시 예약합니다.
 */
export function createRecoveryScheduler({now=Date.now,intervalMs=10000,maxAttempts=3}={}){
 let fingerprint='',attempts=0,nextAt=0,running=false;
 return {
  observe(snapshot){
   const missing=(snapshot.channels||[]).filter(c=>c.verified!==true&&c.verificationReason==='tab_missing');
   const key=snapshot.account?.verified===false?'':JSON.stringify(missing.map(c=>[c.accountId,c.guildId,c.channelId,c.tabId]).sort());
   const next=missing.length?key:'';
   if(next!==fingerprint){fingerprint=next;attempts=0;nextAt=0;}
  },
  async run({safe,repair}){
   if(!fingerprint||running||attempts>=maxAttempts||now()<nextAt||!safe())return false;
   running=true;attempts++;nextAt=now()+intervalMs;
   try{await repair();return true;}catch{return false;}finally{running=false;}
  },
  get state(){return{pending:Boolean(fingerprint)&&attempts<maxAttempts,attempts,running};}
 };
}
