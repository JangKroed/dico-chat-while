import type {Group,Snapshot} from './api'
import type {UserPage} from './user-experience'
import {operationSummary,recentConfirmed} from './user-experience'
import {operationalSummary,groupOperation} from './operational-summary'
import {groupControls} from './group-controls'
import {accountLabel} from './account-label'
import {browserOnline} from './onboarding'
import {browserDisplayName} from './connection-progress'
import {GroupCountdown} from './RuntimeCountdown'
import {attemptResultLabel} from './delivery-evidence'
import './operational-dashboard.css'
export type OperationalDashboardProps={s:Snapshot;busy:boolean;stale:boolean;go:(page:UserPage)=>void;run:(action:string,payload:Record<string,unknown>,success?:string)=>Promise<boolean>}
const groupLabels:Record<string,string>={running:'실행 중',stopped:'중지됨',paused:'일시정지',needs_review:'안전 확인 대기',resume_required:'재개 대기',stop_pending:'중지 적용 대기',pause_pending:'일시정지 적용 대기'}
const timestamp=(value:unknown)=>typeof value==='number'||typeof value==='string'?new Date(value).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'확인 시각 없음'
function GroupRow({group,...props}:OperationalDashboardProps&{group:Group}){
 const {s,busy,stale,run}=props,row=groupOperation(s,group),controls=groupControls(s,group,{busy,stale})
 const unknown=s.attempts.find(a=>a.id===group.activeAttemptId&&a.status==='unknown'&&a.executionBlocked===true)
 const owner=s.instances.find(i=>i.id===unknown?.instanceId)
 const waitingForChoice=group.enabled!==false&&group.status==='paused'&&Boolean(group.autoResume)&&Boolean(unknown)
 const canSkip=waitingForChoice&&browserOnline(owner,s.serverNow??Date.now())&&Array.isArray(owner?.capabilities)&&owner.capabilities.includes('skip-unknown-v1')
 const skip=()=>{
  if(!canSkip||!unknown||busy||stale)return
  if(confirm('이전 발송의 게시 여부는 미확인으로 남습니다. 이 차례를 다시 보내지 않고 다음 차례부터 실행할까요?')){
   void run('attempt.skipUnknown',{id:unknown.id,confirmation:'SKIP_UNCONFIRMED_TURN'},'이전 차례를 건너뛰었습니다. 연결과 간격 확인 후 다음 차례가 시작됩니다.')
  }
 }
 // 중지는 다른 저장 요청의 busy에 종속시키지 않습니다. 기존 제어 정책과
 // 동일한 명령·버전 검사를 이용하여 화면 개편이 발송 안전 조건을 바꾸지 않습니다.
 return <article className="op-group" aria-label={`${group.name} 운영 상태`}><div className="op-group-name"><strong>{group.name}</strong><span>#{row.channelName}</span></div><div className="op-group-state"><span className={`op-badge ${group.status==='running'?'is-running':group.status.includes('pending')||group.status==='needs_review'?'is-waiting':''}`}>{groupLabels[group.status]||'상태 확인 중'}</span><small><GroupCountdown group={group} s={s}/></small></div><div className="op-turn"><small>현재 차례</small><strong>{row.current?accountLabel(s,row.current):'계정 미지정'}</strong><span>다음 {row.next?accountLabel(s,row.next):'계정 미지정'}</span></div><div className="op-message"><small>적용 메시지</small><strong>{row.messageTitle}</strong><span>계정 {group.members.length}개 · 그룹 간격 {Math.round(group.intervalMs/1000)}초</span></div><div className="op-controls"><button className="primary small" disabled={controls.start.disabled} onClick={()=>{if(!controls.start.disabled&&confirm(controls.start.confirmation))void run(controls.start.action,{id:group.id,expectedVersion:group.version},`${group.name} ${controls.start.label} 요청을 보냈습니다.`)}}>{controls.start.label}</button><button className="outline small" disabled={controls.stop.disabled} onClick={()=>void run(controls.stop.action,{id:group.id,expectedVersion:group.version},'중지 요청을 보냈습니다. 적용 확인을 기다립니다.')}>{controls.stop.label}</button>{waitingForChoice?<button className="outline small" disabled={!canSkip||busy||stale} onClick={skip}>{canSkip?'미확인 건 건너뛰고 재개':'브라우저 연결·업데이트 확인 중'}</button>:controls.start.disabled&&group.status!=='running'&&<small>시작 조건 확인 대기</small>}</div></article>
}
export function OperationalDashboard(props:OperationalDashboardProps){
 const {s,stale,go}=props,totals=operationalSummary(s,stale),summary=operationSummary(s,stale),recent=recentConfirmed(s)
 const problem=['blocked','pending','stale','recovering'].includes(summary.kind)
 return <div className="operational-dashboard"><div className="op-heading"><div><span className="op-eyebrow">WORKSPACE / 실시간 운영</span><h1>대시보드</h1><p>계정 순서, 다음 진행과 확인된 발송을 한눈에 확인하세요.</p></div><button className="outline small" onClick={()=>go('groups')}>그룹 관리 →</button></div>
 <section className="op-stats" aria-label="현재 운영 요약"><div><span>실행 중인 그룹</span><strong>{totals.running}<small> / {s.groups.length}</small></strong><small>{stale?'마지막 수신 상태':'현재 그룹 상태 기준'}</small></div><div><span>연결된 계정</span><strong>{stale?'—':totals.connectedAccounts}<small> / {s.accounts?.length||0}</small></strong><small>{stale?'최신 연결 확인 대기':'계정 검증 · 브라우저 응답 기준'}</small></div><div><span>최근 확인된 발송</span><strong>{totals.confirmed}<small>건</small></strong><small>현재 수신한 기록 범위</small></div><div className="op-next"><span>다음 발송 준비</span><strong>{totals.nextGroup?<GroupCountdown group={totals.nextGroup} s={s}/>:stale?'상태 확인 중':'예정 시각 없음'}</strong><small>{totals.nextGroup?.name||'실제 발송 전 준비 조건을 검사합니다'}</small></div></section>
 <div className={`op-summary ${problem?'has-attention':''}`} role="status"><span className="op-status-dot"/><div><strong>{summary.title}</strong>{problem&&<p>{summary.description}</p>}</div>{problem&&<button className="text-action" onClick={()=>go('settings')}>자동 오류 제보 설정</button>}</div>
 <section className="op-panel"><header><div><h2>채널 · 그룹 운영</h2><span>{s.groups.length}개 그룹 · 저장된 계정 순서대로 진행</span></div><button className="text-action" onClick={()=>go('channels')}>채널 설정 →</button></header>{s.groups.length?<div className="op-group-list">{s.groups.map(group=><GroupRow key={group.id} {...props} group={group}/>)}</div>:<div className="op-empty"><strong>첫 발송 그룹을 준비하세요</strong><p>계정과 채널에 메시지를 연결한 뒤 그룹을 만들 수 있습니다.</p><button className="primary small" onClick={()=>go('groups')}>그룹 만들기</button></div>}</section>
 <div className="op-bottom"><section className="op-panel"><header><div><h2>최근 발송 결과</h2><span>수신한 확정 결과 중 최근 8건 · 미확인 결과 제외</span></div><span className="op-badge">{recent.length}건 표시</span></header>{recent.length?<div className="op-results">{recent.map(a=><div className="op-result" key={a.id}><span className="op-result-icon">✓</span><div><strong>{a.messageName||s.messages.find(m=>m.id===a.messageIdRef)?.name||'발송 메시지'}</strong><span>{s.groups.find(g=>g.id===a.groupId)?.name||a.groupName||'이전 그룹'} · {accountLabel(s,a)}</span></div><div><strong>{attemptResultLabel(a)}</strong><time>{timestamp(a.confirmedAt||a.finalizedAt||a.createdAt)}</time></div></div>)}</div>:<p className="op-empty">아직 확인된 발송 결과가 없습니다.</p>}</section><section className="op-panel"><header><div><h2>계정 · 브라우저 연결</h2><span>계정과 프로필의 마지막 확인 상태</span></div><button className="text-action" onClick={()=>go('connections')}>관리 →</button></header>{s.instances.length?<div className="op-connections">{s.instances.map(browser=>{const accounts=(s.accounts||[]).filter(a=>a.instanceId===browser.id),online=!stale&&browserOnline(browser,s.serverNow??Date.now());return <div className="op-browser" key={browser.id}><div className="op-browser-title"><strong>{browserDisplayName(browser)}</strong><span className={`op-badge ${online?'is-running':''}`}>{stale?'확인 대기':online?'연결됨':'연결 끊김'}</span></div><div className="op-account-list">{accounts.length?accounts.map(a=><span key={a.id}><i className={online&&a.verified?'is-ready':''}/>{accountLabel(s,a)}<small>{online&&a.verified?'검증됨':'검증 대기'}</small></span>):<span>등록된 계정 없음</span>}</div></div>})}</div>:<p className="op-empty">아직 연결된 브라우저가 없습니다.</p>}</section></div></div>
}
