import type {Snapshot} from './api'
import {accountLabel} from './account-label'
import {browserDisplayName,connectionProgress} from './connection-progress'

const labels=['브라우저 연결','계정 확인','채널 확인','설정 적용']
const date=(value?:string|number)=>value?new Date(value).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'기록 없음'

export function ConnectionProgress({s,stale=false,onOpenConnections,onNavigate}:{s:Snapshot;stale?:boolean;onOpenConnections?:()=>void;onNavigate?:(page:'connections'|'channels'|'history')=>void}){
 const states=s.instances.map(instance=>({instance,state:connectionProgress(s,instance)}))
 const needsAttention=stale||!states.length||states.some(({state})=>!state.ready)
 return <section className="panel connection-progress" aria-label="브라우저 연결 상태">
  <details key={needsAttention?'attention':'ready'} open={needsAttention}>
   <summary className="connection-summary"><span className="connection-summary-copy"><strong>자동 연결</strong><span>{!states.length?'등록된 브라우저가 없습니다':stale?'상태 수신 대기 · 최근 연결 확인 필요':needsAttention?`${states.filter(({state})=>!state.ready).length}개 브라우저 확인 필요`:`${states.length}개 브라우저 준비 완료`}</span></span><span className="connection-summary-toggle">브라우저별 상태</span></summary>
   <div className="connection-list">{states.length?states.map(({instance,state})=>{
    const aliases=[...new Set((s.accounts??[]).filter(a=>a.instanceId===instance.id).map(a=>accountLabel(s,a)))]
    const name=browserDisplayName(instance)
    const firstIncomplete=state.steps.findIndex(done=>!done)
    const action: 'connections'|'channels'|'history'=instance.connectionProgress&&typeof instance.connectionProgress==='object'&&(instance.connectionProgress as {reasonCode?:string}).reasonCode==='ATTEMPT_UNRESOLVED'?'history':stale||!state.steps[1]||instance.legacyFrozen!==true||instance.legacyPending!==false?'connections':'channels'
    const actionLabel=action==='history'?'실행 기록에서 결과 확인':action==='connections'?'계정 · 브라우저 확인':'채널 · 설정 확인'
    return <details key={instance.id} className="connection-row" open={!state.ready||stale}>
      <summary className="connection-row-head"><span className="connection-identity"><strong>{name}</strong><small className="connection-account-aliases">{aliases.length?aliases.join(' · '):'등록 계정 없음'}</small></span><span className={`status ${state.ready&&!stale?'good':'warn'}`}>{stale?'상태 수신 대기':state.label}</span><span className="connection-fraction">{state.completed}/4 단계 확인{state.blocked?' · 실행 확인 필요':''}</span></summary>
      <div className="connection-row-detail"><ol className="connection-steps" aria-label={`${name} 연결 단계`}>{labels.map((step,index)=>{const condition=state.steps[index]?'done':index===firstIncomplete?(state.blocked?'blocked':'current'):'pending';return <li className={`connection-step ${condition}`} key={step}><span aria-hidden="true">{condition==='done'?'✓':condition==='current'?'·':condition==='blocked'?'!':'○'}</span>{step}<small>{condition==='done'?'완료':condition==='current'?'진행 중':condition==='blocked'?'확인 필요':'대기'}</small></li>})}</ol><div className="connection-row-footer"><small>마지막 브라우저 응답 {date(instance.lastSeenAt)} · 확장 {instance.extensionVersion||'버전 정보 없음'}</small>{(!state.ready||stale)&&onNavigate&&<button className="text-action" onClick={()=>onNavigate(action)}>{actionLabel} →</button>}</div></div>
    </details>
   }):<div className="connection-empty"><p>Chrome 또는 Brave에서 DICO 확장을 연결하면 상태가 여기에 표시됩니다.</p>{onOpenConnections&&<button className="outline small" onClick={onOpenConnections}>계정 · 브라우저 설정 →</button>}</div>}</div>
  </details>
 </section>
}
