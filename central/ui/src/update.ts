import type { Snapshot, UpdateStatus } from './api'

export function updateInProgress(phase?:UpdateStatus['phase']) {return phase==='preparing'||phase==='ready'||phase==='applying'}
export function updateBlockers(s:Snapshot):string[] {
  const reasons:string[]=[]
  if(s.groups.some(g=>g.status==='running'))reasons.push('실행 중인 그룹을 먼저 중지하세요.')
  if(s.groups.some(g=>!['stopped','paused','running','stop_pending','pause_pending','needs_review'].includes(g.status)))reasons.push('재개 대기 그룹을 포함해 모든 그룹을 중지하거나 일시정지하세요.')
  if(s.groups.some(g=>g.activeAttemptId)||s.attempts.some(a=>['preparing','prepared','permitted','executing'].includes(a.status||'')))reasons.push('진행 중인 발송 시도의 결과를 확인하세요.')
  if(s.attempts.some(a=>a.status==='unknown')||s.groups.some(g=>g.status==='needs_review'))reasons.push('미확인 시도의 실제 Discord 게시 여부를 확인하고 실행 기록에서 처리하세요.')
  if(s.groups.some(g=>g.status==='stop_pending'||g.status==='pause_pending')||(s.commands??[]).some(c=>c.type==='CONTROL'&&['queued','received'].includes(String(c.status))))reasons.push('모든 확장의 중지·일시정지 확인 응답을 기다리세요.')
  return reasons
}
export function updatePollingDecision(phase:UpdateStatus['phase']|undefined,busyChecks:number,failures:number) {
  if(failures>=3)return 'connection_lost'
  if(updateInProgress(phase)&&busyChecks>=120)return 'busy_timeout'
  return 'continue'
}
