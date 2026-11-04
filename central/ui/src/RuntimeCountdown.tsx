import {createContext,useContext,useEffect,useState,type ReactNode} from 'react'
import type {Channel,Group,Snapshot,Timestamp} from './api'
import {accountLabel} from './account-label'
import {accountTimingState,groupTimingState,secondsUntil,preparationDeadline,groupScheduleText} from './countdown'
import {intervalSettings} from './interval'
import {channelVerification} from './channel-window'
import {browserOnline,logicalTargets} from './onboarding'
import {ChannelWindowActions} from './ChannelWindowActions'
import {browserDisplayName} from './connection-progress'
import {channelAccountOrder} from './channel-order'

const Clock=createContext<{serverNow?:number;elapsed:number;live:boolean}>({elapsed:0,live:false})
export function ServerClock({serverNow,receivedAt,connected,children}:{serverNow?:number;receivedAt:number;connected:boolean;children:ReactNode}) {
  const [now,setNow]=useState(()=>performance.now())
  useEffect(()=>{if(!connected)return;setNow(performance.now());const timer=window.setInterval(()=>setNow(performance.now()),1000);return()=>window.clearInterval(timer)},[connected])
  return <Clock value={{serverNow,elapsed:Math.max(0,now-receivedAt),live:connected}}>{children}</Clock>
}
function useCountdown(deadline?:Timestamp|null) {
  const clock=useContext(Clock)
  return {seconds:secondsUntil(deadline,clock.serverNow,clock.elapsed,clock.live),live:clock.live&&clock.elapsed<=20000&&clock.serverNow!==undefined}
}
function preparationLead(s:Snapshot,channel:Channel|undefined) {
  const capabilities=s.instances.find(i=>i.id===channel?.instanceId)?.capabilities
  return Array.isArray(capabilities)&&capabilities.includes('early-prepare-v1')?5:0
}
export function GroupCountdown({group,s}:{group:Group;s:Snapshot}) {
  const channel=s.channels.find(c=>c.id===group.members[group.cursor%Math.max(1,group.members.length)])
  const {seconds,live}=useCountdown(group.nextPreparationAt===undefined?preparationDeadline(group.nextEligibleAt,preparationLead(s,channel)):group.nextPreparationAt)
  const send=useCountdown(group.nextEligibleAt)
  return <span className="countdown-text">{!live&&group.status==='running'?'연결 상태 다시 확인 중':groupScheduleText(group,seconds,send.seconds)}</span>
}
export function AccountCountdown({s,channel,group:assignedGroup}:{s:Snapshot;channel:Channel;group?:Group|null}) {
  const groups=s.groups.filter(g=>g.members.includes(channel.id)),group=assignedGroup===undefined?groups.find(g=>g.status==='running')||groups[0]:assignedGroup||undefined
  const {seconds,live}=useCountdown(group?.nextPreparationAt===undefined?preparationDeadline(group?.nextEligibleAt,preparationLead(s,channel)):group.nextPreparationAt)
  const attempt=s.attempts.find(a=>a.bindingId===channel.id&&['preparing','permitted','unknown'].includes(a.status||'')&&(!assignedGroup||!a.groupId||a.groupId===assignedGroup.id))
  return <span className="countdown-text">{!live&&group?.status==='running'&&!attempt?'연결 상태 다시 확인 중':accountTimingState(channel,group,attempt,seconds)}</span>
}
function RuntimeAccountRow({s,channel,bindingId,group,order,current=false,run,busy}:{s:Snapshot;channel?:Channel;bindingId:string;group?:Group;order?:number;current?:boolean;run:(action:string,payload:Record<string,unknown>,success?:string)=>Promise<boolean>;busy:boolean}) {
  const marker=current?(group?.status==='running'||group?.activeAttemptId?'현재 차례':'다음 차례'):undefined
  if(!channel)return <div className="runtime-account" data-binding-id={bindingId} aria-current={current?'step':undefined}><div className="runtime-account-main"><small>{order}번{marker&&` · ${marker}`}</small><strong>연결 계정 정보 없음</strong><small>이 순서에 지정한 계정의 채널 연결을 확인하세요.</small></div></div>
  const info=intervalSettings(channel),browser=s.instances.find(i=>i.id===channel.instanceId),online=browserOnline(browser,s.serverNow??Date.now()),verification=online?channelVerification(channel):{title:'브라우저 연결 끊김',action:'브라우저와 확장을 다시 연결해 주세요.'}
  return <div className="runtime-account" data-binding-id={channel.id} aria-current={current?'step':undefined}><div className="runtime-account-main">{order!==undefined&&<small>{order}번{marker&&` · ${marker}`}</small>}<strong>{accountLabel(s,channel)}</strong><small>{browser?browserDisplayName(browser):'브라우저 연결 확인 필요'}</small><span className={channel.verified&&online?'verification-ok':'verification-help'}>{verification.title}</span></div><div className="runtime-account-status"><AccountCountdown s={s} channel={channel} group={group??null}/><ChannelWindowActions s={s} channel={channel} run={run} busy={busy}/></div><details className="runtime-account-meta"><summary>계정 · 주기 상세</summary><small>Discord ID {channel.accountId} · {verification.action}</small><small>적용 주기 {info.effectiveSeconds}초 · 보정 {info.correctionSeconds}초 · 추가 {info.extraSeconds}초 · {info.observed?`슬로우 모드 ${info.slowmodeSeconds}초 + 여유 3초`:'슬로우 모드 감지 대기'}</small></details></div>
}
export function ChannelCountdownCards({s,go,run,busy,renderGroupActions}:{s:Snapshot;go:()=>void;run:(action:string,payload:Record<string,unknown>,success?:string)=>Promise<boolean>;busy:boolean;renderGroupActions?:(group:Group)=>ReactNode}) {
  const targets=logicalTargets(s)
  if(!targets.length)return null
  return <section className="panel"><div className="panel-head"><div><h2>채널 · 계정별 다음 진행</h2><p>그룹에 설정한 계정 순서와 다음 입력 준비 시간, 현재 차례를 표시합니다.</p></div><button className="text-action" onClick={go}>채널 설정 →</button></div><div className="runtime-channel-grid">{targets.map(target=>{
    const {bindings,groups,ungrouped}=channelAccountOrder(s,target)
    return <article className="runtime-channel" key={target.id}><header><strong># {target.name}</strong><small>연결 계정 {bindings.length}개</small></header>
      {groups.map(({group,entries})=><section key={group.id} aria-label={`${group.name} 계정 순서`}><div className="runtime-groups"><div><strong>{group.name}</strong><GroupCountdown group={group} s={s}/>{group.status==='running'&&<small>현재 차례: {accountLabel(s,entries.find(entry=>entry.current)?.binding||{})}</small>}{renderGroupActions?.(group)}</div></div><div className="runtime-accounts">{entries.map(entry=><RuntimeAccountRow key={`${group.id}:${entry.order}`} s={s} channel={entry.binding} bindingId={entry.bindingId} group={group} order={entry.order} current={entry.current} run={run} busy={busy}/>)}</div></section>)}
      {!groups.length&&<div className="runtime-groups"><p>발송 그룹 미지정 · 자동으로 발송하지 않습니다.</p></div>}
      {ungrouped.length>0&&<section aria-label="그룹 미지정 계정">{groups.length>0&&<div className="runtime-groups"><p>그룹 미지정 계정</p></div>}<div className="runtime-accounts">{ungrouped.map(channel=><RuntimeAccountRow key={channel.id} s={s} channel={channel} bindingId={channel.id} run={run} busy={busy}/>)}</div></section>}
      {!bindings.length&&!groups.length&&<p className="runtime-empty">이 채널에 사용할 계정을 연결하세요.</p>}
    </article>
  })}</div><p className="countdown-note">계정 대기는 최대 5초 먼저 준비하며, 그룹 최소 간격은 발송 처리 후 온전히 기다립니다. Discord 잔여 제한과 입력 준비 시간이 달라도, 발송 직전 실제 제한 해제를 다시 확인합니다. 적용 주기 = 보정된 기본값 + 직접 추가한 시간입니다.</p></section>
}
