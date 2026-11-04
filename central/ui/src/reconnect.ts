export const UPDATE_RECONNECT_KEY='dico.updateReconnect'
const delays=[1000,2000,3000,5000,8000,10000,10000,10000]
export function reconnectDelay(failures:number):number|null {return delays[failures-1]??null}
export function versionReloadDecision(loaded:string|undefined,next:string|undefined,initiatedHere:boolean,path:string,hasUnsavedSettings=false) {
  if(!loaded||!next||loaded===next)return 'none'
  return initiatedHere&&path==='/settings'&&!hasUnsavedSettings?'reload':'banner'
}
export function readUpdateIntent(storage:Pick<Storage,'getItem'>,now=Date.now()):{startedAt:number;fromVersion?:string}|null {
  try {
    const value=JSON.parse(storage.getItem(UPDATE_RECONNECT_KEY)||'null')
    if(!value||typeof value.startedAt!=='number'||value.startedAt>now||now-value.startedAt>30*60*1000)return null
    return {startedAt:value.startedAt,...(typeof value.fromVersion==='string'?{fromVersion:value.fromVersion}:{})}
  }catch{return null}
}

/**
 * 재연결 횟수를 소진한 화면은 네트워크 복귀/화면 복귀 때 새 회차를 시작합니다.
 * 로컬 서비스 복귀는 브라우저 이벤트를 만들지 않으므로 60초마다 연결 회차를 재개합니다.
 * 외부 상태 변화에도 30초 간격을 두고, 발송 재개 없이 연결 상태만 확인합니다.
 * 인증 만료는 자동으로 우회하지 않고 진행 중 회차와 중복 실행하지 않습니다.
 * 해제 함수는 화면 종료 뒤 이벤트가 이전 화면의 작업을 다시 깨우지 않게 합니다.
 */
export function createReconnectWake({target,visibilityTarget=target,phase,visible,restart,now=Date.now,schedule=(callback,delay)=>setTimeout(callback,delay),cancel=id=>clearTimeout(id)}:{
 target:EventTarget;visibilityTarget?:EventTarget;phase:()=>string;visible:()=>boolean;restart:()=>void;now?:()=>number;
 schedule?:(callback:()=>void,delay:number)=>ReturnType<typeof setTimeout>;cancel?:(id:ReturnType<typeof setTimeout>)=>void
}){
 let lastWake=-Infinity,disposed=false
 const wake=()=>{
  const time=now()
  if(disposed||phase()!=='offline'||!visible()||time-lastWake<30000)return
  lastWake=time
  restart()
 }
 // 빠른 재시도 소진 뒤에도 활성 화면은 저빈도로 복귀를 확인합니다.
 // 인증 만료·진행 중 회차·숨겨진 화면은 wake의 동일한 조건을 따릅니다.
 let timer:ReturnType<typeof setTimeout>
 const probe=()=>{if(disposed)return;wake();timer=schedule(probe,60000)}
 timer=schedule(probe,60000)
 target.addEventListener('online',wake);target.addEventListener('focus',wake)
 visibilityTarget.addEventListener('visibilitychange',wake)
 return ()=>{disposed=true;cancel(timer);target.removeEventListener('online',wake);target.removeEventListener('focus',wake);visibilityTarget.removeEventListener('visibilitychange',wake)}
}
