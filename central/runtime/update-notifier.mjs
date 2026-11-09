/** UI를 닫아도 새 배포를 확인합니다. 네트워크 지연은 발송/중지 경로를 막지 않습니다. */
export function createUpdateNotifier({check,snapshot,dispatch,now=()=>performance.now(),intervalMs=300000}){
 let nextAt=-Infinity,running=null,dispatching=null,closed=false;
 return {
  tick(){
   if(closed)return Promise.resolve();
   if(running)return running;
   if(now()<nextAt)return Promise.resolve();
   nextAt=now()+intervalMs;
   running=Promise.resolve().then(check).then(update=>{if(closed)return;dispatching=Promise.resolve().then(()=>{if(!closed)return dispatch(snapshot(),update)}).finally(()=>{dispatching=null});return dispatching}).catch(()=>{}).finally(()=>{running=null});
   return running;
  },
  // 읽기 전용 조회의 늦은 결과는 버리고, 시작된 알림 저장만 마친 뒤 종료합니다.
  close(){closed=true;return dispatching?.catch(()=>{})||Promise.resolve();}
 };
}
