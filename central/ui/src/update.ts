import type { Snapshot, UpdateStatus } from './api'

export function updateInProgress(phase?:UpdateStatus['phase']) {return phase==='preparing'||phase==='ready'||phase==='applying'}
export function updateBlockers(s:Snapshot):string[] {
  const reasons:string[]=[]
  const blocked=new Map(s.attempts.filter(a=>a.status==='unknown'&&a.executionBlocked===true&&typeof a.id==='string').map(a=>[a.id,a]))
  if(s.groups.some(g=>g.status==='running'))reasons.push('실행 중인 그룹이 있어 업데이트 적용 대기 중입니다.')
  if(s.groups.some(g=>!['stopped','paused','running','stop_pending','pause_pending','needs_review'].includes(g.status)))reasons.push('그룹 중지 상태 확인 대기 중입니다.')
  if(s.groups.some(g=>g.activeAttemptId&&(!blocked.has(g.activeAttemptId)||blocked.get(g.activeAttemptId)?.groupId!==g.id))||s.attempts.some(a=>['preparing','prepared','permitted','executing'].includes(a.status||'')))reasons.push('진행 중인 발송 결과를 자동 관찰하고 있습니다.')
  if(s.attempts.some(a=>a.status==='unknown'&&!blocked.has(a.id))||s.groups.some(g=>g.status==='needs_review'))reasons.push('게시 여부가 미확인인 기록을 보존하고 중복 전송을 차단하고 있습니다.')
  if(s.groups.some(g=>g.status==='stop_pending'||g.status==='pause_pending')||(s.commands??[]).some(c=>c.type==='CONTROL'&&['queued','received'].includes(String(c.status))))reasons.push('브라우저의 중지·일시정지 확인 응답을 수신하는 중입니다.')
  return reasons
}
export function updatePollingDecision(phase:UpdateStatus['phase']|undefined,busyChecks:number,failures:number) {
  if(failures>=3)return 'connection_lost'
  if(updateInProgress(phase)&&busyChecks>=120)return 'busy_timeout'
  return 'continue'
}

export function extensionVersionState(appVersion:string|undefined,extensionVersion:string|undefined,online:boolean) {
  if(!online)return 'offline'
  if(!appVersion||!extensionVersion||extensionVersion==='unknown')return 'unknown'
  return appVersion===extensionVersion?'current':'mismatch'
}

// 롤백도 실행 중인 발송·미확인 결과·중지 확인을 건너뛰지 않습니다.
// 백업 존재 여부는 서버가 검증한 available 값만 신뢰하며 버전 문자열로 추측하지 않습니다.
export function rollbackActionState(s:Snapshot,result:UpdateStatus|null,busy=false){
 const blockers=updateBlockers(s)
 return {disabled:busy||!result?.rollback?.available||updateInProgress(result?.phase)||blockers.length>0,blockers}
}
// 비활성 사유는 서버의 열거형에만 대응합니다. 모르는 값이나 경로를 그대로
// 노출하지 않고 검증되지 않은 백업을 '없음'으로 단정하지도 않습니다.
export function rollbackUnavailableMessage(reason?:string){
 const messages:Record<string,string>={
  NO_BACKUP:'이전 버전 백업이 없습니다. 이 기능을 지원하는 버전에서 업데이트한 뒤부터 이전 프로그램 파일을 보관합니다.',
  BACKUP_INVALID:'보관된 이전 버전 파일이 무결성 검증을 통과하지 못했습니다. 안전을 위해 복원을 차단했으며 현재 설치와 데이터는 유지합니다.',
  ROLLBACK_INCOMPATIBLE:'보관된 이전 버전이 현재 데이터를 안전하게 읽을 수 없어 복원을 차단했습니다. 현재 설치와 데이터는 유지합니다.',
  SAME_VERSION:'보관된 버전이 현재 실행 중인 버전과 같아 되돌릴 변경 사항이 없습니다.'
 }
 return messages[reason||'']||'이전 버전의 안전한 복원 가능 여부를 확인하지 못했습니다. 현재 설치와 데이터는 유지합니다.'
}
// 서버가 제공한 사용자용 진단 설명은 유지하되, 예상 밖 원본 경로가 섞인
// 응답은 일반 안내로 대체합니다. 파일 위치는 사용자 작업의 전제 조건이 아닙니다.
export function safeUpdateMessage(message:string|undefined,fallback:string){
 if(!message||/(?:file:\/\/|[A-Za-z]:[\\/]|\/(?:Users|Volumes|home|root|tmp|var|private|opt|usr|workspace)\/)/.test(message))return fallback
 return message
}
export function rollbackPhaseMessage(phase:UpdateStatus['phase']){
 return {idle:'이전 버전 복원을 시작할 수 있습니다.',preparing:'보관된 이전 버전 파일과 현재 데이터의 호환성을 검사하고 있습니다.',ready:'검사를 마쳤습니다. 안전한 중지 상태를 확인한 뒤 복원합니다.',applying:'이전 버전 파일을 적용하고 관리 프로그램을 다시 시작하고 있습니다.',completed:'이전 버전 복원을 완료했습니다. 설정과 실행 기록은 유지되며 그룹은 자동으로 재개하지 않습니다.',failed:'이전 버전 복원을 완료하지 못했습니다. 아래 진단 결과에 중단 이유를 표시합니다.'}[phase]
}

// 완료된 작업에 현재 발송 상태를 과거의 미완료 업데이트처럼 표시하지 않습니다.
export function showUpdateBlockers(phase:UpdateStatus['phase']|undefined){return phase!=='completed'}
