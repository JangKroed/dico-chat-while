import type {Snapshot} from './api'
export type UserPage='dashboard'|'messages'|'connections'|'channels'|'groups'|'history'|'logs'|'settings'
const preferenceKey='dico.developer-diagnostic-mode'
// 화면 선호만 저장합니다. 이 값은 관리자 인증이나 서버 권한을 부여하지 않습니다.
// 저장소가 차단된 환경에서도 기본 사용자 화면으로 안전하게 시작합니다.
export function readDiagnosticMode(storage?:Pick<Storage,'getItem'>){try{return (storage??localStorage).getItem(preferenceKey)==='true'}catch{return false}}
export function writeDiagnosticMode(value:boolean,storage?:Pick<Storage,'setItem'>){try{(storage??localStorage).setItem(preferenceKey,String(value))}catch{}}
export function visiblePage(path:string,diagnostic:boolean):UserPage {
 const page=path.replace(/^\/+|\/+$/g,'')||'dashboard'
 if(!['dashboard','messages','connections','channels','groups','history','logs','settings'].includes(page)||!diagnostic&&['history','logs'].includes(page))return 'dashboard'
 return page as UserPage
}
export function recentConfirmed(s:Snapshot){return s.attempts.filter(a=>a.status==='confirmed').sort((a,b)=>new Date(b.confirmedAt||b.finalizedAt||b.createdAt||0).getTime()-new Date(a.confirmedAt||a.finalizedAt||a.createdAt||0).getTime()).slice(0,8)}
export function operationSummary(s:Snapshot,stale=false):{kind:string;title:string;description:string}{
 if(stale)return {kind:'stale',title:'최신 상태를 기다리고 있습니다',description:'마지막으로 받은 상태를 표시합니다. 현재 실행·중지 완료 여부는 아직 확인할 수 없습니다.'}
 if(s.groups.some(g=>g.autoResume?.reasonCode!=='delivery_recovery_requested'&&['stop_pending','pause_pending'].includes(g.status)))return {kind:'pending',title:'중단 요청의 적용을 기다리고 있습니다',description:'브라우저 확인 전에는 중지 완료로 표시하지 않습니다. 이전 발송의 결과는 별도로 보존됩니다.'}
 const queued=s.groups.filter(g=>g.autoResume?.reasonCode==='delivery_recovery_requested').length
 if(queued)return {kind:'recovering',title:'실행을 예약했습니다',description:`${queued}개 그룹은 이전 발송 결과와 연결 상태가 확인되면 자동으로 시작합니다. 확인 중에는 기존 발송을 반복하지 않습니다.`}
 const unknown=s.attempts.filter(a=>a.status==='unknown'&&s.groups.some(g=>g.activeAttemptId===a.id))
 // 재시도 횟수나 과거 오류만으로 복구 중이라고 추측하지 않습니다.
 // 현재 대기·처리 중인 읽기 전용 대조 명령이 존재할 때만 진행 중으로 안내합니다.
 if(unknown.some(a=>s.commands?.some(c=>c.type==='RECONCILE'&&['queued','received'].includes(String(c.status))&&(c.payload as Record<string,unknown>|undefined)?.attemptId===a.id)))return {kind:'recovering',title:'발송 결과를 자동으로 확인하고 있습니다',description:'확인되지 않은 발송은 다시 보내지 않으며, 현재 차례와 결과를 보존합니다.'}
 // 과거 알림만으로 현재 작업 실패를 판단하지 않습니다. 현재 제어 상태를 우선합니다.
 if(unknown.length||s.groups.some(g=>g.status==='needs_review'||g.waitReason==='preparation_failed')||s.service?.status&&!['ready','stopped','resume_required'].includes(String(s.service.status)))return {kind:'blocked',title:'프로그램이 작업을 안전하게 완료하지 못했습니다',description:'확인되지 않은 결과는 그대로 보존하며 임의로 성공 처리하거나 다시 보내지 않습니다. 설정에서 자동 오류 제보에 동의하면 진단 자료를 관리자에게 전달할 수 있습니다.'}
 if(s.groups.some(g=>g.status==='running'))return {kind:'running',title:'발송 작업이 실행 중입니다',description:'설정된 계정 순서와 대기 조건에 따라 진행합니다.'}
 return {kind:'stopped',title:s.groups.length?'발송 작업이 중지 또는 대기 상태입니다':'발송 작업을 준비하세요',description:'메시지·계정·채널·그룹 설정 후 시작할 수 있습니다. 설정을 저장하는 것만으로 발송하지 않습니다.'}
}
