import type {Attempt,Channel,Group,Timestamp} from './api'

export function secondsUntil(deadline:Timestamp|null|undefined,serverNow:number|undefined,elapsedMs:number,live:boolean):number|null {
  if(!live||serverNow===undefined||!Number.isFinite(serverNow)||!Number.isFinite(elapsedMs)||elapsedMs<0||elapsedMs>20000||deadline===null||deadline===undefined)return null
  const at=typeof deadline==='number'?deadline:Date.parse(deadline)
  return Number.isFinite(at)?Math.ceil(Math.max(0,at-serverNow-elapsedMs)/1000):null
}
type TimingGroup=Pick<Group,'status'>&Partial<Pick<Group,'members'|'cursor'|'activeAttemptId'|'waitReason'|'autoResume'>>
export function waitReasonText(reason?:string) {
  return ({group_interval:'그룹 최소 간격 대기',account_interval:'계정 주기 대기',preparing:'입력 준비 중',delivery_unknown:'발송 복구 대기',manual_resume:'실행 조건 다시 확인 필요',preparation_retry:'현재 계정 입력 준비 자동 재시도 중',preparation_failed:'입력 준비 실패 · 전송 창 확인 필요',send_retry:'현재 계정 전송 재시도 중',delivery_observation:'전송 처리 중 · 입력창 자동 관찰',authorization_retry:'전송 허가 연결 자동 복구 중',scheduled_input_ready:'입력 준비 완료 · 예정 시각 대기',discord_cooldown:'Discord 실제 제한 해제 대기',awaiting_result:'게시 결과 확인 대기',account_unverified:'계정·채널 검증 필요',connection_lost:'브라우저 연결 다시 확인 필요',config_pending:'확장 적용 확인 대기'} as Record<string,string>)[reason||'']||reason||'실행 조건 확인 중'
}
export function preparationDeadline(deadline:Timestamp|null|undefined,leadSeconds:number):number|null {
  if(deadline===null||deadline===undefined)return null
  const at=typeof deadline==='number'?deadline:Date.parse(deadline)
  return Number.isFinite(at)?at-Math.max(0,leadSeconds)*1000:null
}
function stoppedState(group:TimingGroup|undefined):string|null {
  if(!group)return '발송 그룹 미지정'
  // 시스템 복구 의도가 남아 있으면 수동 일시정지와 구분하되 발송 시각은 약속하지 않습니다.
  if(group.autoResume)return group.activeAttemptId?'발송 결과 확인 중 · 자동 복구 대기':'자동 복구 중 · 정상 확인 후 재개'
  return ({stopped:'중지됨',paused:'일시정지됨',pause_pending:'일시정지 확인 중',stop_pending:'중지 확인 중',resume_required:'재개 확인 필요',needs_review:'발송 복구 대기'} as Record<string,string>)[group.status]||null
}
export function groupTimingState(group:TimingGroup,seconds:number|null):string {
  const stopped=stoppedState(group);if(stopped)return stopped
  if(group.waitReason==='preparation_retry')return '현재 계정 입력 준비 자동 재시도 중'
  if(group.waitReason==='authorization_retry')return '전송 허가 연결 자동 복구 중'
  if(group.waitReason==='delivery_observation')return '전송 처리 중 · 입력창 자동 관찰'
  if(group.waitReason==='send_retry')return '현재 계정 전송 재시도 중'
  if(group.waitReason==='scheduled_input_ready')return '입력 준비 완료 · 발송 대기'
  if(group.waitReason==='discord_cooldown')return 'Discord 제한 해제 대기'
  if(group.activeAttemptId)return group.waitReason==='awaiting_result'?'발송 확인 중':'입력 준비 중'
  if(seconds===null)return '연결·설정 확인 필요'
  return seconds>0?`입력 준비까지 약 ${seconds}초`:'입력 준비 대기'
}
export function accountTimingState(channel:Pick<Channel,'id'|'nextEligibleAt'>,group:TimingGroup|undefined,attempt:Pick<Attempt,'status'>|undefined,seconds:number|null):string {
  if(attempt?.status==='unknown')return group?.autoResume?'발송 결과 확인 중 · 자동 복구 대기':'발송 복구 대기'
  if(attempt?.status==='permitted'&&group?.waitReason==='delivery_observation')return '전송 처리 중 · 입력창 자동 관찰'
  if(attempt?.status==='permitted'&&group?.waitReason==='authorization_retry')return '전송 허가 연결 자동 복구 중'
  if(attempt?.status==='permitted')return group?.waitReason==='send_retry'?'전송 재시도 중':'발송 확인 중'
  const stopped=stoppedState(group);if(stopped)return stopped
  if(attempt?.status==='preparing')return group?.waitReason==='scheduled_input_ready'?'입력 준비 완료 · 발송 대기':group?.waitReason==='discord_cooldown'?'Discord 제한 해제 대기':'입력 준비 중'
  if(group?.members?.[Math.max(0,group.cursor??0)%Math.max(1,group.members.length)]!==channel.id)return '차례 대기'
  if(group?.waitReason==='preparation_retry')return '현재 계정 입력 준비 자동 재시도 중'
  if(seconds===null)return '연결·설정 확인 필요'
  return seconds>0?`입력 준비까지 약 ${seconds}초`:'입력 준비 대기'
}
