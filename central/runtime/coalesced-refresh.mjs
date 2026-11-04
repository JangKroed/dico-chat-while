/**
 * 화면·알림처럼 최신 상태만 필요한 읽기를 발송 트랜잭션 밖으로 옮깁니다.
 * 첫 요청으로부터 고정된 시간 뒤 실행하므로 이벤트가 계속 와도 무한 연기하지 않습니다.
 * 이미 실행 중이면 후속 요청을 한 번으로 합치며, 종료 뒤 새 읽기는 하지 않습니다.
 * 발송 명령·상태 저장·이벤트 기록에는 사용하지 않습니다.
 */
export function createCoalescedRefresh(refresh,{delayMs=50,onError=()=>{}}={}){
 let timer=null,running=false,dirty=false,closed=false,inFlight=Promise.resolve();
 const request=()=>{
  if(closed)return;dirty=true;
  if(timer!==null||running)return;
  timer=setTimeout(()=>{
   timer=null;if(closed)return;dirty=false;running=true;
   inFlight=(async()=>{
    try{await refresh();}catch(error){onError(error);}
    finally{running=false;if(dirty&&!closed)request();}
   })();
  },delayMs);timer.unref?.();
 };
 // 알림 저장이 진행 중이면 잠금을 해제하기 전에 완료를 기다려야 합니다.
 // 예약 취소만 하고 종료하면 구 프로세스가 새 프로세스의 기록을 덮을 수 있습니다.
 const close=()=>{closed=true;dirty=false;clearTimeout(timer);timer=null;return inFlight;};
 return{request,close};
}
