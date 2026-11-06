import type { Account, Channel, Group, Instance, Snapshot, Target } from './api'

// An absent collection means an older server; an empty collection is authoritative.
export function registeredAccounts(s:Snapshot):Account[] {
  return s.accounts ?? [...new Map(s.channels.map(c=>[`${c.instanceId}:${c.accountId}`,{id:`legacy:${c.instanceId}:${c.accountId}`,instanceId:c.instanceId,accountId:c.accountId,name:c.accountId,version:0,verified:c.verified}])).values()]
}
export function logicalTargets(s:Snapshot):Target[] {
  const targets=s.targets ?? [...new Map(s.channels.map(c=>[`${c.guildId}:${c.channelId}`,{id:`legacy:${c.guildId}:${c.channelId}`,guildId:c.guildId,channelId:c.channelId,name:c.name,nameCustomized:c.nameCustomized,namePending:c.namePending}])).values()]
  return targets.map(target=>target.namePending||!target.name||target.name===target.channelId&&target.nameCustomized!==true?{...target,name:'채널 이름 확인 대기',namePending:true}:target)
}
export function browserOnline(i:Instance|undefined,now=Date.now()) {
  const lastSeen=i?.lastSeenAt===undefined?NaN:new Date(i.lastSeenAt).getTime()
  return Boolean(i&&(i.connected||i.status==='connected')&&Number.isFinite(lastSeen)&&now-lastSeen<=15000)
}
export function accountReady(s:Snapshot,a:Account,now=Date.now()) {
  return a.verified&&browserOnline(s.instances.find(i=>i.id===a.instanceId),now)
}
export function bindingBlockers(s:Snapshot,c:Channel,now=Date.now()):string[] {
  const reasons:string[]=[]
  const instance=s.instances.find(i=>i.id===c.instanceId)
  if(!browserOnline(instance,now))reasons.push('브라우저 연결 필요')
  if(instance?.legacyFrozen!==true||instance?.legacyPending!==false)reasons.push('기존 실행 중지 확인 필요')
  if(!c.verified)reasons.push('계정·채널 검증 필요')
  if(s.accounts!==undefined&&!s.accounts.some(a=>a.instanceId===c.instanceId&&a.accountId===c.accountId&&a.verified))reasons.push('계정 등록·검증 필요')
  if(!c.playlist.length)reasons.push('메시지 적용 필요')
  else if(c.playlist.some(p=>!s.messages.some(m=>m.id===p.messageId&&m.revisions.some(r=>r.id===p.revisionId))))reasons.push('메시지 연결 정보 확인 필요')
  if(c.playlist.length&&c.configVersion!==c.appliedVersion)reasons.push('확장 적용 확인 대기')
  return reasons
}
export function groupBlockers(s:Snapshot,g:Group,now=Date.now()):string[] {
  const reasons:string[]=[]
  if(g.enabled===false)reasons.push('비활성 그룹입니다. 먼저 활성화하세요.')
  if(!g.members.length)reasons.push('참여 계정 필요')
  if(g.activeAttemptId||g.status==='needs_review')reasons.push('진행·미확인 시도 확인 필요')
  if(['stop_pending','pause_pending'].includes(g.status))reasons.push('중지·일시정지 확인 대기')
  for(const id of g.members){const c=s.channels.find(c=>c.id===id);reasons.push(...(c?bindingBlockers(s,c,now):['채널 연결 필요']))}
  return [...new Set(reasons)]
}
export function allRunBlockers(s:Snapshot,now=Date.now()):string[] {
  const reasons=s.groups.filter(g=>g.enabled!==false&&g.status!=='running').flatMap(g=>{
    if(g.autoResume?.reasonCode==='delivery_recovery_requested')return []
    const active=s.attempts?.find(a=>a.id===g.activeAttemptId)
    // 결과 대기 중에도 중앙이 실행 요청을 보존하고 안전 조건이 회복되면 재개합니다.
    if(['stopped','paused','needs_review'].includes(g.status)&&active?.status==='unknown'&&active.executionBlocked===true)return []
    return groupBlockers(s,g,now)
  })
  const targets=new Set<string>()
  for(const g of s.groups.filter(g=>g.enabled!==false)){
    const key=`${g.guildId}:${g.channelId}`
    if(targets.has(key))reasons.push('같은 채널의 여러 그룹은 함께 실행할 수 없습니다. 실행할 그룹 하나를 남겨 주세요.')
    targets.add(key)
  }
  return [...new Set(reasons)]
}
export function setupSteps(s:Snapshot,now=Date.now()) {
  const accounts=registeredAccounts(s),targets=logicalTargets(s)
  const bound=s.channels.filter(c=>c.verified&&browserOnline(s.instances.find(i=>i.id===c.instanceId),now)&&accounts.some(a=>a.instanceId===c.instanceId&&a.accountId===c.accountId&&a.verified))
  const applied=s.channels.filter(c=>bindingBlockers(s,c,now).length===0)
  return [
    {title:'계정 등록',done:accounts.some(a=>accountReady(s,a,now)),page:'connections' as const,description:accounts.length?'등록된 계정과 브라우저의 현재 검증 상태를 확인하세요.':'Discord 탭에서 확장을 열어 ‘현재 Discord 계정 등록’을 누르세요.'},
    {title:'채널 추가',done:targets.length>0,page:'channels' as const,description:'Discord 채널 URL을 저장하세요. 계정과 독립적으로 관리합니다.'},
    {title:'계정과 채널 연결',done:bound.length>0,page:'channels' as const,description:'채널에 사용할 계정을 선택하고 브라우저의 실제 채널 검증을 기다리세요.'},
    {title:'메시지 적용',done:applied.length>0,page:(s.messages.some(m=>!m.archived)?'channels':'messages') as 'channels'|'messages',description:s.messages.some(m=>!m.archived)?'연결 계정에 메시지를 적용하고 확장 적용 완료를 확인하세요.':'메시지 보관함에 문구를 먼저 저장하세요.'},
    {title:'그룹 준비',done:s.groups.some(g=>groupBlockers(s,g,now).length===0),page:'groups' as const,description:s.groups.length?'그룹의 모든 참여 계정에 남은 준비 항목을 확인하세요.':'같은 채널의 계정 순서와 최소 간격을 저장하세요.'}
  ]
}
export function pendingConnection(s:Snapshot,a:Account,t:Target) {
  return (s.commands??[]).find(c=>{
    const p=c.payload as Record<string,unknown>|undefined
    return c.type==='OPEN_CHANNEL'&&['queued','received','applied'].includes(String(c.status))&&c.instanceId===a.instanceId&&(p?.accountEntityId===a.id||p?.accountId===a.accountId||p?.accountId===a.id)&&(p?.targetId===t.id||p?.guildId===t.guildId&&p?.channelId===t.channelId)
  })
}

export function selectableConnectionAccountIds(s:Snapshot,target:Target|undefined,now=Date.now()):string[] {
  if(!target||target.id.startsWith('legacy:'))return []
  return registeredAccounts(s).filter(a=>!a.id.startsWith('legacy:')&&accountReady(s,a,now)&&!pendingConnection(s,a,target)&&!s.channels.some(c=>c.guildId===target.guildId&&c.channelId===target.channelId&&c.instanceId===a.instanceId&&c.accountId===a.accountId&&c.verified)).map(a=>a.id)
}
