import type {Attempt,Channel,Group,Timestamp} from './api'

export function secondsUntil(deadline:Timestamp|null|undefined,serverNow:number|undefined,elapsedMs:number,live:boolean):number|null {
  if(!live||serverNow===undefined||!Number.isFinite(serverNow)||!Number.isFinite(elapsedMs)||elapsedMs<0||elapsedMs>20000||deadline===null||deadline===undefined)return null
  const at=typeof deadline==='number'?deadline:Date.parse(deadline)
  return Number.isFinite(at)?Math.ceil(Math.max(0,at-serverNow-elapsedMs)/1000):null
}
type TimingGroup=Pick<Group,'status'>&Partial<Pick<Group,'members'|'cursor'|'activeAttemptId'|'waitReason'>>
export function waitReasonText(reason?:string) {
  return ({scheduled_input_ready:'입력 준비 완료 · 예정 시각 대기',discord_cooldown:'Discord 실제 제한 해제 대기',awaiting_result:'게시 결과 확인 대기',account_unverified:'계정·채널 검증 필요',connection_lost:'브라우저 연결 다시 확인 필요',config_pending:'확장 적용 확인 대기'} as Record<string,string>)[reason||'']||reason||'실행 조건 확인 중'
}
export function groupTimingState(group:TimingGroup,seconds:number|null):string {
  if(group.status==='needs_review')return '실제 게시 여부 확인 필요'
  if(group.status==='running'&&(group.waitReason==='scheduled_input_ready'||group.waitReason==='discord_cooldown'))return waitReasonText(group.waitReason)
  if(group.activeAttemptId)return '진행 중 시도 결과 확인 중'
  if(group.status==='stopped')return '그룹 중지됨'
  if(group.status==='paused')return '그룹 일시정지됨'
  if(group.status==='pause_pending'||group.status==='stop_pending')return '중지·일시정지 확인 대기'
  if(group.status==='resume_required')return '그룹 재개 확인 필요'
  if(seconds===null)return '연결·설정 조건 확인 중'
  return seconds>0?`다음 계정 허가까지 약 ${seconds}초`:'다음 계정 허가 조건 확인 중'
}
export function accountTimingState(channel:Pick<Channel,'id'|'nextEligibleAt'>,group:TimingGroup|undefined,attempt:Pick<Attempt,'status'>|undefined,seconds:number|null):string {
  if(attempt?.status==='unknown')return '실제 게시 여부 확인 필요'
  if(attempt?.status==='preparing')return group?.waitReason==='scheduled_input_ready'||group?.waitReason==='discord_cooldown'?waitReasonText(group.waitReason):'입력 준비 확인 중'
  if(attempt?.status==='permitted')return '게시 결과 확인 중'
  if(seconds===null)return '서버 허가 조건 확인 필요'
  const waiting=group?.status==='stopped'?' · 그룹 중지':group?.status==='paused'?' · 그룹 일시정지':group?.status==='running'&&group.members?.[Math.max(0,group.cursor??0)%Math.max(1,group.members.length)]!==channel.id?' · 차례 대기':group?.status==='needs_review'?' · 그룹 결과 확인 필요':group?.status==='resume_required'?' · 그룹 재개 확인 필요':group?.status==='stop_pending'||group?.status==='pause_pending'?' · 그룹 중지 확인 대기':!group?' · 그룹 미지정':''
  return (seconds>0?`계정 간격 충족까지 ${seconds}초`:'계정 간격 충족')+waiting
}
