import type { Attempt, Snapshot } from './api'

// The snapshot helps hide stale controls; the server still checks the whole
// group, current run, pending controls, and execution proof on every click.
export function canRetryNotSent(attempt:Attempt,snapshot:Snapshot):boolean {
  if(!['unknown','not_sent'].includes(attempt.status||'')||attempt.executionBlocked!==true||attempt.retryRunId)return false
  const group=snapshot.groups.find(group=>group.id===attempt.groupId)
  if(!group||[...snapshot.attempts].reverse().find(item=>item.groupId===group.id)?.id!==attempt.id)return false
  if(typeof attempt.groupVersion==='number'&&group.version!==attempt.groupVersion)return false
  if(attempt.runId&&group.runId!==attempt.runId)return false
  if(attempt.bindingId&&group.members[group.cursor]!==attempt.bindingId)return false
  if(group.activeAttemptId&&group.activeAttemptId!==attempt.id)return false
  if(attempt.status==='unknown'&&group.activeAttemptId!==attempt.id)return false
  return true
}

export type RetryNotSentStatus='started'|'waiting'|'already_started'
export function retryNotSentStatus(response:unknown):RetryNotSentStatus|null {
  if(!response||typeof response!=='object'||!('result' in response))return null
  const result=response.result
  if(!result||typeof result!=='object'||!('status' in result))return null
  return result.status==='started'||result.status==='waiting'||result.status==='already_started'?result.status:null
}

export function retryNotSentMessage(status:RetryNotSentStatus):string {
  if(status==='waiting')return '미발송 확인을 기록했습니다. 중지 적용 확인 응답을 기다리는 중이며 아직 다시 실행하지 않았습니다. 적용이 끝나면 실행 기록에서 같은 계정 계속을 다시 눌러 주세요.'
  if(status==='already_started')return '이 시도의 계속 실행 요청은 이미 처리됐습니다. 현재 그룹과 실행 기록을 확인해 주세요.'
  return '같은 그룹의 같은 계정에서 계속 실행을 요청했습니다. 실제 게시 여부는 실행 기록에서 확인해 주세요.'
}
