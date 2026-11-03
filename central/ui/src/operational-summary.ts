import type {Group,Snapshot} from './api'
import {browserOnline} from './onboarding.ts'
// 집계는 수신한 스냅샷 범위만 사용합니다. 전체 기간 통계나 연결되지 않은
// 계정의 현재 상태를 추측하지 않고, 오래된 화면에서는 실시간 수치를 보류합니다.
export function operationalSummary(s:Snapshot,stale=false){
 const running=s.groups.filter(g=>g.status==='running')
 const nextGroup=stale?undefined:[...running].filter(g=>g.nextEligibleAt!=null&&Number.isFinite(new Date(g.nextEligibleAt).getTime())).sort((a,b)=>new Date(a.nextEligibleAt!).getTime()-new Date(b.nextEligibleAt!).getTime())[0]
 return {running:running.length,connectedAccounts:stale?0:(s.accounts||[]).filter(a=>a.verified&&browserOnline(s.instances.find(i=>i.id===a.instanceId),s.serverNow??Date.now())).length,confirmed:s.attempts.filter(a=>a.status==='confirmed').length,nextGroup}
}
// 다음 계정은 저장된 순환 순서입니다. 실제 발송 허가나 성공을 뜻하지 않습니다.
// 현재 차례의 적용된 문구 제목을 보여 주고 메시지 본문은 이 화면에 노출하지 않습니다.
export function groupOperation(s:Snapshot,g:Group){
 const length=g.members.length,cursor=length?g.cursor%length:0
 const current=s.channels.find(c=>c.id===g.members[cursor]),next=length?s.channels.find(c=>c.id===g.members[(cursor+1)%length]):undefined
 const item=current?.playlist[current.playlistIndex%Math.max(1,current.playlist.length)]
 return {current,next,channelName:current?.name||s.channels.find(c=>c.guildId===g.guildId&&c.channelId===g.channelId)?.name||'채널 정보 없음',messageTitle:s.messages.find(m=>m.id===item?.messageId)?.name||'적용 메시지 없음'}
}
