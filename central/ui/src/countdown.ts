import type {Attempt,Channel,Group,Timestamp} from './api'

export function secondsUntil(deadline:Timestamp|null|undefined,serverNow:number|undefined,elapsedMs:number,live:boolean):number|null {
  if(!live||serverNow===undefined||!Number.isFinite(serverNow)||!Number.isFinite(elapsedMs)||elapsedMs<0||elapsedMs>20000||deadline===null||deadline===undefined)return null
  const at=typeof deadline==='number'?deadline:Date.parse(deadline)
  return Number.isFinite(at)?Math.ceil(Math.max(0,at-serverNow-elapsedMs)/1000):null
}
type TimingGroup=Pick<Group,'status'>&Partial<Pick<Group,'members'|'cursor'|'activeAttemptId'|'waitReason'>>
export function waitReasonText(reason?:string) {
  return ({preparation_retry:'현재 계정 입력 준비 자동 재시도 중',preparation_failed:'입력 준비 실패 · 전송 창 확인 필요',send_retry:'현재 계정 전송 재시도 중',scheduled_input_ready:'입력 준비 완료 · 예정 시각 대기',discord_cooldown:'Discord 실제 제한 해제 대기',awaiting_result:'게시 결과 확인 대기',account_unverified:'계정·채널 검증 필요',connection_lost:'브라우저 연결 다시 확인 필요',config_pending:'확장 적용 확인 대기'} as Record<string,string>)[reason||'']||reason||'실행 조건 확인 중'
}
export function preparationDeadline(deadline:Timestamp|null|undefined,leadSeconds:number):number|null {
  if(deadline===null||deadline===undefined)return null
  const at=typeof deadline==='number'?deadline:Date.parse(deadline)
  return Number.isFinite(at)?at-Math.max(0,leadSeconds)*1000:null
}
function stoppedState(group:TimingGroup|undefined):string|null {
  if(!group)return '발송 그룹 미지정'
  return ({stopped:'중지됨',paused:'일시정지됨',pause_pending:'일시정지 확인 중',stop_pending:'중지 확인 중',resume_required:'재개 확인 필요',needs_review:'실제 게시 여부 확인 필요'} as Record<string,string>)[group.status]||null
}
export function groupTimingState(group:TimingGroup,seconds:number|null):string {
  const stopped=stoppedState(group);if(stopped)return stopped
  if(group.waitReason==='preparation_retry')return '현재 계정 입력 준비 자동 재시도 중'
  if(group.waitReason==='send_retry')return '현재 계정 전송 재시도 중'
  if(group.waitReason==='scheduled_input_ready')return '입력 준비 완료 · 발송 대기'
  if(group.waitReason==='discord_cooldown')return 'Discord 제한 해제 대기'
  if(group.activeAttemptId)return group.waitReason==='awaiting_result'?'발송 확인 중':'입력 준비 중'
  if(seconds===null)return '연결·설정 확인 필요'
  return seconds>0?`입력 준비까지 약 ${seconds}초`:'입력 준비 대기'
}
export function accountTimingState(channel:Pick<Channel,'id'|'nextEligibleAt'>,group:TimingGroup|undefined,attempt:Pick<Attempt,'status'>|undefined,seconds:number|null):string {
  if(attempt?.status==='unknown')return '실제 게시 여부 확인 필요'
  if(attempt?.status==='permitted')return group?.waitReason==='send_retry'?'전송 재시도 중':'발송 확인 중'
  const stopped=stoppedState(group);if(stopped)return stopped
  if(attempt?.status==='preparing')return group?.waitReason==='scheduled_input_ready'?'입력 준비 완료 · 발송 대기':group?.waitReason==='discord_cooldown'?'Discord 제한 해제 대기':'입력 준비 중'
  if(group?.members?.[Math.max(0,group.cursor??0)%Math.max(1,group.members.length)]!==channel.id)return '차례 대기'
  if(group?.waitReason==='preparation_retry')return '현재 계정 입력 준비 자동 재시도 중'
  if(seconds===null)return '연결·설정 확인 필요'
  return seconds>0?`입력 준비까지 약 ${seconds}초`:'입력 준비 대기'
}
