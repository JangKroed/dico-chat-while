import type {Snapshot} from './api'
export type UserPage='dashboard'|'messages'|'connections'|'channels'|'groups'|'history'|'logs'|'settings'
export function visiblePage(path:string):UserPage {
 const page=path.replace(/^\/+|\/+$/g,'')||'dashboard'
 return ['dashboard','messages','connections','channels','groups','settings'].includes(page)?page as UserPage:'dashboard'
}
export function recentConfirmed(s:Snapshot){return s.attempts.filter(a=>a.status==='confirmed').sort((a,b)=>new Date(b.confirmedAt||b.finalizedAt||b.createdAt||0).getTime()-new Date(a.confirmedAt||a.finalizedAt||a.createdAt||0).getTime()).slice(0,8)}
export function operationSummary(s:Snapshot,stale=false):{kind:string;title:string;description:string}{
 if(stale)return {kind:'stale',title:'최신 상태를 기다리고 있습니다',description:'마지막으로 받은 상태를 표시합니다. 현재 실행·중지 완료 여부는 아직 확인할 수 없습니다.'}
 if(s.groups.some(g=>g.autoResume?.reasonCode!=='delivery_recovery_requested'&&['stop_pending','pause_pending'].includes(g.status)))return {kind:'pending',title:'중단 요청의 적용을 기다리고 있습니다',description:'브라우저 확인 전에는 중지 완료로 표시하지 않습니다. 이전 발송의 결과는 별도로 보존됩니다.'}
 const queued=s.groups.filter(g=>g.autoResume?.reasonCode==='delivery_recovery_requested'||g.autoResume&&s.attempts.some(a=>a.id===g.activeAttemptId&&a.status==='unknown')).length
 if(queued)return {kind:'recovering',title:'실행을 예약했습니다',description:`${queued}개 그룹이 이전 발송 결과 확인을 기다리고 있습니다. 게시 근거가 확인되면 자동으로 시작합니다.`}
 const unknown=s.attempts.filter(a=>a.status==='unknown'&&s.groups.some(g=>g.activeAttemptId===a.id))
 // 재시도 횟수나 과거 오류만으로 복구 중이라고 추측하지 않습니다.
 // 현재 대기·처리 중인 읽기 전용 대조 명령이 존재할 때만 진행 중으로 안내합니다.
 if(unknown.some(a=>s.commands?.some(c=>c.type==='RECONCILE'&&['queued','received'].includes(String(c.status))&&(c.payload as Record<string,unknown>|undefined)?.attemptId===a.id)))return {kind:'recovering',title:'발송 결과를 자동으로 확인하고 있습니다',description:'확인되지 않은 발송은 다시 보내지 않으며, 현재 차례와 결과를 보존합니다.'}
 // 과거 알림만으로 현재 작업 실패를 판단하지 않습니다. 현재 제어 상태를 우선합니다.
 if(unknown.length||s.groups.some(g=>g.status==='needs_review'||g.waitReason==='preparation_failed')||s.service?.status&&!['ready','stopped','resume_required'].includes(String(s.service.status)))return {kind:'blocked',title:'프로그램이 작업을 안전하게 완료하지 못했습니다',description:'확인되지 않은 결과는 그대로 보존하며 임의로 성공 처리하거나 다시 보내지 않습니다. 설정에서 자동 오류 제보에 동의하면 진단 자료를 관리자에게 전달할 수 있습니다.'}
 if(s.groups.some(g=>g.status==='running'))return {kind:'running',title:'발송 작업이 실행 중입니다',description:'설정된 계정 순서와 대기 조건에 따라 진행합니다.'}
 return {kind:'stopped',title:s.groups.length?'발송 작업이 중지 또는 대기 상태입니다':'발송 작업을 준비하세요',description:'메시지·계정·채널·그룹 설정 후 시작할 수 있습니다. 설정을 저장하는 것만으로 발송하지 않습니다.'}
}
