import type {Group,Snapshot} from './api'
import {groupBlockers} from './onboarding.ts'

type ControlOptions={busy?:boolean;stale?:boolean;now?:number}
export type GroupControls={
  start:{action:'group.start'|'group.resume';label:string;disabled:boolean;reasons:string[];confirmation:string}
  stop:{action:'group.stop';label:string;disabled:boolean}
  needsReview:boolean
}

export function groupControls(s:Snapshot,g:Group,{busy=false,stale=false,now=s.serverNow??Date.now()}:ControlOptions={}):GroupControls {
  const running=g.status==='running',attempt=s.attempts.find(a=>a.id===g.activeAttemptId)
  const needsReview=g.status==='needs_review'||Boolean(g.activeAttemptId&&(!attempt||attempt.status==='unknown'))
  const reasons=running?['이미 실행 중입니다.']:groupBlockers(s,g,now)
  if(!running){
    if(stale)reasons.unshift('최신 상태 수신 후 시작할 수 있습니다.')
    if(s.service?.status&&!['ready','resume_required','stopped'].includes(String(s.service.status)))reasons.push(s.service.status==='storage_failure'?'저장 오류를 먼저 해결하세요. 설정의 설치 진단을 확인하세요.':'서비스 상태를 확인하세요. 문제 목록에서 원인을 확인할 수 있습니다.')
    const owners=new Set(g.members.map(id=>s.channels.find(c=>c.id===id)?.instanceId))
    if(s.commands?.some(c=>c.type==='MANAGE_WINDOW'&&owners.has(String(c.instanceId))&&['queued','received'].includes(String(c.status))&&['consolidate','separate'].includes(String((c.payload as Record<string,unknown>|undefined)?.action))))reasons.push('전송 창 정리 적용을 기다리세요.')
    if(s.groups.some(other=>other.id!==g.id&&other.guildId===g.guildId&&other.channelId===g.channelId&&(other.activeAttemptId||!['stopped','paused'].includes(other.status))))reasons.push('같은 채널의 다른 그룹을 중지하고 진행 중 시도를 확인하세요.')
  }
  const action=g.status==='stopped'?'group.start':'group.resume'
  return {
    start:{action,label:running?'실행 중':action==='group.start'?'시작':'재개',disabled:busy||running||reasons.length>0,reasons:[...new Set(reasons)],confirmation:`‘${g.name}’ 그룹을 ${action==='group.start'?'시작':'재개'}할까요? 조건이 충족되면 실제 Discord 메시지가 발송됩니다.`},
    // Stale display data must not remove the user's ability to request a stop.
    stop:{action:'group.stop',label:!stale&&g.status==='stop_pending'?'중지 확인 중':'중지',disabled:busy||!stale&&(g.status==='stop_pending'||g.status==='stopped'&&(!g.activeAttemptId||attempt?.executionBlocked===true))},
    needsReview
  }
}
