import {createContext,useContext,useEffect,useState,type ReactNode} from 'react'
import type {Channel,Group,Snapshot,Timestamp} from './api'
import {accountLabel} from './account-label'
import {accountTimingState,groupTimingState,secondsUntil,preparationDeadline} from './countdown'
import {intervalSettings} from './interval'
import {channelVerification} from './channel-window'
import {browserOnline} from './onboarding'
import {ChannelWindowActions} from './ChannelWindowActions'
import {browserDisplayName} from './connection-progress'

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
  const {seconds,live}=useCountdown(preparationDeadline(group.nextEligibleAt,preparationLead(s,channel)))
  return <span className="countdown-text">{!live&&group.status==='running'?'연결 상태 다시 확인 중':groupTimingState(group,seconds)}</span>
}
export function AccountCountdown({s,channel}:{s:Snapshot;channel:Channel}) {
  const groups=s.groups.filter(g=>g.members.includes(channel.id)),group=groups.find(g=>g.status==='running')||groups[0]
  const {seconds,live}=useCountdown(preparationDeadline(group?.nextEligibleAt,preparationLead(s,channel)))
  const attempt=s.attempts.find(a=>a.bindingId===channel.id&&['preparing','permitted','unknown'].includes(a.status||''))
  return <span className="countdown-text">{!live&&group?.status==='running'&&!attempt?'연결 상태 다시 확인 중':accountTimingState(channel,group,attempt,seconds)}</span>
}
export function ChannelCountdownCards({s,go,run,busy}:{s:Snapshot;go:()=>void;run:(action:string,payload:Record<string,unknown>,success?:string)=>Promise<boolean>;busy:boolean}) {
  const targets=s.targets??[...new Map(s.channels.map(c=>[`${c.guildId}:${c.channelId}`,{id:`${c.guildId}:${c.channelId}`,guildId:c.guildId,channelId:c.channelId,name:c.name}])).values()]
  if(!targets.length)return null
  return <section className="panel"><div className="panel-head"><div><h2>채널 · 계정별 다음 진행</h2><p>실행 중인 그룹의 다음 입력 준비 시간과 계정별 진행 상태를 표시합니다.</p></div><button className="text-action" onClick={go}>채널 설정 →</button></div><div className="runtime-channel-grid">{targets.map(target=>{
    const bindings=s.channels.filter(c=>c.guildId===target.guildId&&c.channelId===target.channelId),groups=s.groups.filter(g=>g.guildId===target.guildId&&g.channelId===target.channelId)
    return <article className="runtime-channel" key={target.id}><header><strong># {target.name}</strong><small>연결 계정 {bindings.length}개</small></header><div className="runtime-groups">{groups.length?groups.map(group=><div key={group.id}><strong>{group.name}</strong><GroupCountdown group={group} s={s}/>{group.status==='running'&&<small>현재 차례: {accountLabel(s,s.channels.find(c=>c.id===group.members[group.cursor%Math.max(1,group.members.length)])||{})}</small>}</div>):<p>발송 그룹 미지정 · 자동으로 발송하지 않습니다.</p>}</div>{bindings.length?<div className="runtime-accounts">{bindings.map(channel=>{const info=intervalSettings(channel),browser=s.instances.find(i=>i.id===channel.instanceId),online=browserOnline(browser,s.serverNow??Date.now()),verification=online?channelVerification(channel):{title:'브라우저 연결 끊김',action:'브라우저와 확장을 다시 연결해 주세요.'};return <div className="runtime-account" key={channel.id}><div className="runtime-account-main"><strong>{accountLabel(s,channel)}</strong><small>{browser?browserDisplayName(browser):'브라우저 연결 확인 필요'}</small><span className={channel.verified&&online?'verification-ok':'verification-help'}>{verification.title}</span></div><div className="runtime-account-status"><AccountCountdown s={s} channel={channel}/><ChannelWindowActions s={s} channel={channel} run={run} busy={busy}/></div><details className="runtime-account-meta"><summary>계정 · 주기 상세</summary><small>Discord ID {channel.accountId} · {verification.action}</small><small>실제 최소 {info.effectiveSeconds}초 · {info.observed?`슬로우 모드 ${info.slowmodeSeconds}초 + 여유 3초`:'슬로우 모드 감지 대기'}</small></details></div>})}</div>:<p className="runtime-empty">이 채널에 사용할 계정을 연결하세요.</p>}</article>
  })}</div><p className="countdown-note">입력 준비 후 Discord의 실제 제한이 해제되는지 확인하고 발송합니다.</p></section>
}
