export type ActionPhase='submitting'|'refreshing'
/**
 * 접수된 명령과 화면 갱신은 서로 다른 작업입니다.
 * 명령 성공 뒤 조회만 실패한 경우 저장/중단을 다시 요청하게 만들지 않습니다.
 * 반환값 refreshed=false는 명령 실패가 아니라 다음 상태 갱신을 기다린다는 뜻입니다.
 */
export async function submitAndRefresh<T>(submit:()=>Promise<T>,refresh:()=>Promise<void>,onPhase?:(phase:ActionPhase)=>void) {
  onPhase?.('submitting')
  const response=await submit()
  onPhase?.('refreshing')
  try{await refresh();return {response,refreshed:true}}
  catch{return {response,refreshed:false}}
}
/**
 * 같은 버튼의 중복 요청은 합치고 서로 다른 중단 요청은 다른 작업과 독립적으로 허용합니다.
 * 종료 시 자신의 키만 제거하므로 먼저 끝난 요청이 다른 작업의 진행 표시를 지우지 않습니다.
 */
export function createPendingActions(){
 const keys=new Set<string>()
 return {begin(key:string){if(keys.has(key))return false;keys.add(key);return true},end(key:string){keys.delete(key)},has:(key:string)=>keys.has(key),get size(){return keys.size}}
}
