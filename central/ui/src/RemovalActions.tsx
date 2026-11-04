import type {Snapshot,Target} from './api'

type Run=(action:string,payload:Record<string,unknown>,success?:string)=>Promise<boolean>
type Kind='channel'|'target'|'account'|'instance'
const labels:Record<Kind,string>={channel:'연결 해제',target:'채널 삭제',account:'계정 삭제',instance:'브라우저 삭제'}
const effects:Record<Kind,string>={
  channel:'이 계정과 채널의 연결을 해제하고 해당 전송 탭만 닫습니다. 계정 등록과 다른 채널 연결은 유지됩니다.',
  target:'저장한 채널과 이 채널의 모든 계정 연결을 삭제하고 해당 전송 탭들을 닫습니다. 계정 등록은 유지됩니다.',
  account:'계정 등록과 이 계정의 모든 채널 연결을 삭제하고 해당 전송 탭들을 닫습니다. 다시 사용하려면 확장에서 계정을 직접 등록해야 합니다.',
  instance:'이 브라우저 등록과 소속 계정·채널 연결을 삭제하고 해당 전송 탭들을 닫습니다. 다시 사용하려면 확장에서 관리 프로그램 연결을 직접 눌러야 합니다.'
}
export function RemovalAction({kind,id,version,name,busy,run,onRemoved}:{kind:Kind;id:string;version?:number;name:string;busy:boolean;run:Run;onRemoved?:()=>void}){
  const disabled=busy||version===undefined||id.startsWith('legacy:')
  const remove=async()=>{
    if(disabled||!confirm(`${name}\n\n${effects[kind]}\n관련 그룹에서 연결을 제외하며, 빈 그룹은 삭제됩니다. 진행 중인 입력은 중지 완료가 필요합니다. 입력 차단이 확인된 미확인 발송은 결과를 바꾸지 않고 기록에 보존합니다. 오프라인 브라우저의 탭은 다음 연결 때 닫습니다.\n\n계속할까요?`))return
    if(await run(`${kind}.delete`,{id,expectedVersion:version},kind==='channel'?'연결을 해제했습니다.':'삭제했습니다.'))onRemoved?.()
  }
  return <button type="button" className="text-action" disabled={disabled} aria-label={`${name} ${labels[kind]}`} onClick={()=>void remove()}>{labels[kind]}</button>
}

export function RenameTargetAction({target,busy,run}:{target:Target;busy:boolean;run:Run}){
  const disabled=busy||target.version===undefined||target.id.startsWith('legacy:')
  return <button type="button" className="text-action" disabled={disabled} onClick={()=>{if(disabled)return;const name=prompt('채널 표시 이름',target.name);if(name?.trim()&&name.trim()!==target.name)void run('target.update',{id:target.id,expectedVersion:target.version,name:name.trim()},'채널 표시 이름을 저장했습니다.')}}>채널 이름 변경</button>
}

// 삭제 트랜잭션은 이미 완료됐습니다. 브라우저의 물리적 탭 정리 기록은
// 진단 화면에서만 표시하며 재연결/수동 탭 닫기를 사용자에게 요구하지 않습니다.
export function PendingTabCloses({s}:{s:Snapshot}){
  const pending=s.pendingTabCloses||[]
  if(!pending.length)return null
  const labels:Record<string,string>={offline:'브라우저 오프라인 · 후속 정리 보관',queued:'후속 정리 예약됨',received:'후속 정리 처리 중',rejected:'후속 정리 미완료'}
  return <section className="panel" aria-label="삭제 후 정리 기록"><div className="panel-head"><div><h2>삭제 완료 · 후속 정리 기록 · {pending.length}개</h2><p>계정·연결 삭제는 완료됐습니다. 이 기록은 남은 탭을 안전하게 정리하기 위한 내부 기록이며 재연결할 필요가 없습니다.</p></div></div><ul>{pending.map(item=><li key={item.removalId}><strong>{item.accountName||item.accountId} · #{item.channelName||item.channelId}</strong><p>{labels[item.status]||'탭 닫기 확인 대기'}{item.rejectionCode&&<small> 사유: {item.rejectionCode}</small>}</p></li>)}</ul></section>
}
