import {channelMessagesChanged,messageSyncLabel} from './message-autosync'
import {OperationalDashboard} from './OperationalDashboard'
import {visiblePage,operationSummary} from './user-experience'
import {createPendingActions,submitAndRefresh} from './action-feedback'
import { useCallback, useEffect, useRef, useState } from 'react'
import {AutomaticSupport} from './AutomaticSupport'
import {SupportReportButton,AttemptMessageBody,AttemptMessageLookup} from './SupportReport'
import {useRetainedRecords} from './use-retained-records'
import { ApiError, command, establishSession, getSetupStatus, getSnapshot, requestErrorMessage, subscribe, testNotification, type Account, type Attempt, type Channel, type EventRecord, type Group, type Incident, type Instance, type Message, type SetupStatus, type Snapshot, type Timestamp } from './api'
import { confirmedSeries, matchesLogLevel, type ConfirmedBucket } from './chart'
import { draftVersion, savedDraftVersion } from './draft'
import { getAppearance, setAppearance, subscribeAppearance, type Appearance } from './appearance'
import { createSettingsDraft, editSettingsDraft, settingsDirty, settingsPayload, syncSettingsDraft } from './settings-draft'
import { createToastTimer } from './toast'
import { selectEligibleIds } from './bulk-selection'
import { UpdatePanel } from './UpdatePanel'
import { RemoteAccessGuide } from './RemoteAccessGuide'
import {LanAccessPanel} from './LanAccessPanel'
import {LanLogin} from './LanLogin'
import {lanLoginRequired} from './lan-access'
import {getAccessMode,type AccessMode} from './api'
import { ConnectionProgress } from './ConnectionProgress'
import { browserDisplayName } from './connection-progress'
import { waitReasonText } from './countdown'
import { attemptResultLabel, confirmationBasisText, deliveryReasonLabel, enterEvidenceText, evidenceFlags, evidenceStages, unknownDeliveryCause } from './delivery-evidence'
import { accountIdentity, accountLabel } from './account-label'
import { AccountCountdown, ChannelCountdownCards, GroupCountdown, ServerClock } from './RuntimeCountdown'
import { groupControls } from './group-controls'
import { ChannelWindowActions } from './ChannelWindowActions'
import { PendingTabCloses, RemovalAction, RenameTargetAction } from './RemovalActions'
import { DialogAccessibility } from './DialogAccessibility'
import { channelVerification, exactRecordedBinding, managedWindowAvailable } from './channel-window'
import { createReconnectWake, readUpdateIntent, reconnectDelay, UPDATE_RECONNECT_KEY, versionReloadDecision } from './reconnect'
import { customIntervalError, intervalDraftChanged, intervalPayload, intervalSettings, type IntervalMode } from './interval'
import { incidentAdvice, incidentState, isIncidentOpen, visibleIncidents } from './incident-advice'
import { canRetryNotSent, retryNotSentMessage, retryNotSentStatus, type RetryNotSentStatus } from './retry-attempt'
import { accountReady, allRunBlockers, bindingBlockers, browserOnline, groupBlockers, logicalTargets, pendingConnection, registeredAccounts, selectableConnectionAccountIds, setupSteps } from './onboarding'

type Page = 'dashboard'|'messages'|'connections'|'channels'|'groups'|'history'|'logs'|'settings'
const navigation: {id:Page; label:string; icon:string}[] = [
  {id:'dashboard',label:'대시보드',icon:'▦'}, {id:'messages',label:'메시지 보관함',icon:'▤'},
  {id:'connections',label:'계정 · 브라우저',icon:'◫'}, {id:'channels',label:'채널 설정',icon:'#'}, {id:'groups',label:'발송 그룹',icon:'◉'},
  {id:'settings',label:'설정 · 도움말',icon:'⚙'}
]
const empty:Snapshot = {schemaVersion:0,stateVersion:0,messages:[],instances:[],channels:[],groups:[],attempts:[],incidents:[],events:[]}
const date = (value?:Timestamp) => value ? new Date(value).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—'
const fullDate = (value?:Timestamp) => value ? new Date(value).toLocaleString('ko-KR',{timeZoneName:'short'}) : '—'
const label = (value?:string) => ({scheduled_input_ready:'입력 준비 완료 · 예정 시각 대기',discord_cooldown:'Discord 실제 제한 해제 대기',running:'실행 중',paused:'일시정지',stopped:'중지됨',needs_review:'발송 복구 대기',resume_required:'재개 필요',pause_pending:'일시정지 확인 대기',stop_pending:'중지 확인 대기',confirmed:'발송 처리',posted:'게시 확인',unknown:'미확인',not_sent:'확정 미발송',cancelled:'취소됨',preparing:'준비 중',permitted:'발송 허가됨',unconfirmed:'미확인',uncertain:'미확인',failed:'확정 미발송',connected:'연결됨',disconnected:'연결 끊김',ready:'준비됨',archived:'보관됨'} as Record<string,string>)[value || ''] || value || '정보 없음'
const tone = (value?:string) => ['running','connected','confirmed','posted','ready'].includes(value||'')?'good':['needs_review','resume_required','unconfirmed','uncertain','unknown','stop_pending','pause_pending'].includes(value||'')?'warn':['disconnected','failed','not_sent'].includes(value||'')?'bad':'muted'
const status = (value?:string,displayLabel?:string) => <span className={`status ${tone(value)}`}><span className="status-dot"/>{displayLabel||label(value)}</span>
const short = (id?:string) => id ? id.length>15 ? `${id.slice(0,12)}…` : id : '—'
const account = (channel:Channel|undefined,s:Snapshot) => channel ? accountLabel(s,channel) : '—'
const incidentText = (incident:Incident,s:Snapshot) => incidentAdvice(incident,s).title
const reasonText = (code?:string) => deliveryReasonLabel(code)||({'draft-retained':'입력창에 문구가 남아 게시 여부 미확인',uncertain:'게시 확인 증거 부족',no_response:'Discord 결과 응답 없음',content_unavailable:'Discord 탭의 확장 응답 없음',reconcile_inconclusive:'재연결 후 게시 여부 확인 불가',result_unknown:'게시 결과 미확인',DRAFT_MISMATCH:'전송용 창에 다른 초안이 남아 있습니다.',EDITOR_LOADING:'Discord 입력창이 아직 준비되지 않았습니다.',EDITOR_AMBIGUOUS:'열린 스레드나 편집 창 때문에 입력창이 여러 개입니다.',ACCOUNT_UNVERIFIED:'로그인 계정을 확인하지 못했습니다.',TARGET_MISMATCH:'전송용 창의 채널이 변경됐습니다.',ATTACHMENT_OR_REPLY:'첨부파일 또는 답장 상태를 정리해 주세요.',CONFIG_MISMATCH:'채널 또는 문구 설정이 확장과 일치하지 않습니다.',CONTENT_UNAVAILABLE:'전송용 Discord 탭의 확장 응답이 없습니다. 탭을 새로고침해 주세요.',PREPARE_REJECTED:'확장이 입력 준비를 거절했습니다.',command_rejected:'확장이 명령을 거절했습니다.'} as Record<string,string>)[code||'']||code||'—'
const eventText = (event:EventRecord) => event.message||event.description||(event.type==='delivery.confirmed'?(event.confirmationBasis==='composer_cleared'?'발송 처리 · 입력창 비움 확인':'Discord 게시 확인'):undefined)||(typeof event.rejectionCode==='string'?reasonText(event.rejectionCode):undefined)||event.type?.replaceAll('.', ' · ')||event.reasonCode||'상태 변경'

function App() {
  const [page,setPage] = useState<Page>(() => visiblePage(location.pathname))
  useEffect(()=>{
    const next=visiblePage(location.pathname),path=next==='dashboard'?'/':`/${next}`
    if(location.pathname!==path)history.replaceState(null,'',path)
  },[])
  const pageRef=useRef(page),navigationGuard=useRef<(()=>boolean)|null>(null)
  const registerNavigationGuard=useCallback((guard:(()=>boolean)|null)=>{navigationGuard.current=guard},[])
  const [snapshot,setSnapshot] = useState<Snapshot>(empty)
  const [auth,setAuth] = useState<'loading'|'ready'|'unauthorized'|'error'>('loading')
  const [accessMode,setAccessMode]=useState<AccessMode|null>(null)
  const accessModeRef=useRef<AccessMode|null>(null)
  const [connected,setConnected] = useState(false)
  const [connectionPhase,setConnectionPhase]=useState<'connecting'|'connected'|'reconnecting'|'offline'|'expired'>('connecting')
  const [reconnectKey,setReconnectKey]=useState(0),[retryCount,setRetryCount]=useState(0)
  // 재시도 한도에 도달해도 네트워크/화면이 실제 복귀하면 사용자의 재검사 클릭 없이
  // 새 유한 회차를 시작합니다. 인증 만료와 진행 중 회차는 이 경로로 재시작하지 않습니다.
  const connectionPhaseRef=useRef(connectionPhase)
  connectionPhaseRef.current=connectionPhase
  useEffect(()=>createReconnectWake({target:window,visibilityTarget:document,
    phase:()=>connectionPhaseRef.current,visible:()=>document.visibilityState==='visible',
    restart:()=>setReconnectKey(key=>key+1)}),[])

  const [appVersion,setAppVersion]=useState<string|undefined>(),[newAppVersion,setNewAppVersion]=useState('')
  const loadedVersion=useRef<string|undefined>(undefined),hasConnected=useRef(false),settingsHaveDraft=useRef(false)
  const snapshotRequest=useRef<Promise<Snapshot>|null>(null)
  const [lastSeen,setLastSeen] = useState<number>(0)
  const [snapshotReceivedAt,setSnapshotReceivedAt]=useState(0)
  const [notice,setNotice] = useState<{id:number;text:string;kind:'success'|'error'}|null>(null)
  const noticeSequence=useRef(0)
  const toastTimer=useRef<ReturnType<typeof createToastTimer>|null>(null)
  if(!toastTimer.current)toastTimer.current=createToastTimer({now:()=>performance.now(),schedule:(callback,delay)=>window.setTimeout(callback,delay),cancel:id=>window.clearTimeout(id),dismiss:()=>setNotice(null)})
  const showNotice=(text:string,kind:'success'|'error'='success')=>setNotice({id:++noticeSequence.current,text,kind})
  const clearNotice=()=>{toastTimer.current?.clear();setNotice(null)}
  useEffect(()=>{if(notice)toastTimer.current?.start(notice.kind==='error'?9000:6000);else toastTimer.current?.clear()},[notice])
  useEffect(()=>()=>toastTimer.current?.clear(),[])
  // 저장과 중단이 겹쳐도 각각의 진행 상태를 보존합니다. 중단은 공용 busy에 묶지 않습니다.
  const pendingActions=useRef(createPendingActions())
  const [pendingCount,setPendingCount]=useState(0)
  const busy=pendingCount>0
  const beginAction=(key:string)=>{const started=pendingActions.current.begin(key);if(started)setPendingCount(pendingActions.current.size);return started}
  const endAction=(key:string)=>{pendingActions.current.end(key);setPendingCount(pendingActions.current.size)}
  const [notifications,setNotifications] = useState(false)
  const [menu,setMenu] = useState(false)
  const menuButtonRef=useRef<HTMLButtonElement>(null),sidebarRef=useRef<HTMLElement>(null)
  const closeMenu=()=>{setMenu(false);menuButtonRef.current?.focus()}
  useEffect(()=>{if(!menu)return;sidebarRef.current?.querySelector<HTMLButtonElement>('.nav-item')?.focus();const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();closeMenu()}};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape)},[menu])
  const refresh = useCallback(async (signal?:AbortSignal,afterMutation=false) => {
    // POST 이전에 시작한 GET을 저장 완료의 최신 상태로 사용하지 않습니다.
    if(afterMutation&&snapshotRequest.current)await snapshotRequest.current.catch(()=>{})
    if(!snapshotRequest.current)snapshotRequest.current=getSnapshot(signal).finally(()=>{snapshotRequest.current=null})
    const next=await snapshotRequest.current
    setSnapshot(next);setLastSeen(Date.now());setSnapshotReceivedAt(performance.now())
  },[])
  useEffect(() => {
    let active=true,inFlight=false,wanted=false,needsSession=true,streamOpen=false,stopped=false,epoch=0,failures=0
    let close=()=>{},timer=0,deadline=0,controller:AbortController|null=null
    const closeStream=()=>{close();close=()=>{};streamOpen=false}
    const schedule=(delay:number)=>{if(!active||stopped)return;window.clearTimeout(timer);timer=window.setTimeout(()=>void sync(),delay)}
    const requestSync=()=>{if(inFlight)wanted=true;else schedule(0)}
    const disconnected=()=>{
      if(!active||stopped)return
      epoch++;needsSession=true;closeStream();setConnected(false);setConnectionPhase('reconnecting');requestSync()
    }
    const checkVersion=(next?:string)=>{
      if(!next)return false
      setAppVersion(next)
      let intent:ReturnType<typeof readUpdateIntent>=null
      try{intent=readUpdateIntent(sessionStorage)}catch{}
      const decision=versionReloadDecision(loadedVersion.current,next,Boolean(intent),location.pathname,settingsHaveDraft.current)
      if(!loadedVersion.current){
        loadedVersion.current=next
        if(intent?.fromVersion&&intent.fromVersion!==next)try{sessionStorage.removeItem(UPDATE_RECONNECT_KEY)}catch{}
      }
      if(decision==='reload'){
        stopped=true;closeStream()
        try{sessionStorage.removeItem(UPDATE_RECONNECT_KEY)}catch{}
        location.reload();return true
      }
      if(decision==='banner'){
        setNewAppVersion(next)
        try{sessionStorage.removeItem(UPDATE_RECONNECT_KEY)}catch{}
      }
      return false
    }
    const sync=async()=>{
      if(!active||stopped)return
      if(inFlight){wanted=true;return}
      inFlight=true;wanted=false;window.clearTimeout(timer)
      const requestEpoch=epoch
      controller=new AbortController();deadline=window.setTimeout(()=>controller?.abort(),10000)
      let nextDelay=15000
      try {
        if(needsSession){
          const access=await getAccessMode(controller.signal)
          if(!active||requestEpoch!==epoch){wanted=true;return}
          accessModeRef.current=access.mode;setAccessMode(access.mode)
          const session=await establishSession(controller.signal)
          if(!active||requestEpoch!==epoch){wanted=true;return}
          if(checkVersion(session.appVersion))return
          needsSession=false
        }
        await refresh(controller.signal)
        if(!active||requestEpoch!==epoch){wanted=true;return}
        failures=0;setRetryCount(0);setConnected(true);setConnectionPhase('connected');setAuth('ready');hasConnected.current=true
        if(!streamOpen){streamOpen=true;close=subscribe(requestSync,disconnected)}
      }catch(error){
        if(!active)return
        if(requestEpoch!==epoch){wanted=true;return}
        closeStream();needsSession=true;setConnected(false)
        if(error instanceof ApiError&&error.status===401){stopped=true;setAuth('unauthorized');setConnectionPhase('expired');if(accessModeRef.current==='lan'){hasConnected.current=false;setSnapshot(empty);setNotice(null);setNotifications(false);navigationGuard.current=null;settingsHaveDraft.current=false}}
        else {
          failures++;setRetryCount(failures)
          const delay=reconnectDelay(failures)
          if(delay===null){stopped=true;setConnectionPhase('offline');if(!hasConnected.current)setAuth('error')}
          else{nextDelay=delay;setConnectionPhase('reconnecting')}
        }
      }finally{
        window.clearTimeout(deadline);inFlight=false
        if(active&&!stopped)schedule(wanted?0:nextDelay)
      }
    }
    if(!hasConnected.current)setAuth('loading')
    setConnectionPhase(hasConnected.current?'reconnecting':'connecting');setRetryCount(0);void sync()
    return()=>{active=false;stopped=true;closeStream();window.clearTimeout(timer);window.clearTimeout(deadline);controller?.abort()}
  },[refresh,reconnectKey])
  useEffect(() => { const pop = () => {const next=visiblePage(location.pathname);if(location.pathname!==(next==='dashboard'?'/':`/${next}`))history.replaceState(null,'',next==='dashboard'?'/':`/${next}`);if(next!==pageRef.current&&navigationGuard.current&&!navigationGuard.current()){history.pushState(null,'',pageRef.current==='dashboard'?'/':`/${pageRef.current}`);return}pageRef.current=next;setPage(next)}; window.addEventListener('popstate',pop); return () => window.removeEventListener('popstate',pop) },[])
  const go = (requested:Page) => {const next=visiblePage(requested);if(next!==page&&navigationGuard.current&&!navigationGuard.current())return;pageRef.current=next;setPage(next);setMenu(false);setNotifications(false);history.pushState(null,'',next==='dashboard'?'/':`/${next}`);window.scrollTo(0,0)}
  const run = async (action:string,payload:Record<string,unknown>,success='저장했습니다') => {
    if(auth!=='ready'||!connected){showNotice(auth==='unauthorized'?'연결 세션이 만료됐습니다. 입력 내용은 유지됩니다. 확장에서 다시 인증한 뒤 연결을 확인하세요.':'관리 프로그램에 다시 연결한 뒤 요청해 주세요. 입력 내용은 유지됩니다.','error');return false}
    const key=`${action}:${String(payload.id||'all')}`
    if(!beginAction(key))return false
    clearNotice()
    const noticeId=++noticeSequence.current
    try {
      const result=await submitAndRefresh(()=>command(action,payload),()=>refresh(undefined,true))
      const queued=action==='service.startAll'?(result.response as {result?:{queuedForRecovery?:number}})?.result?.queuedForRecovery:0
      if(queued)success=`실행 요청을 접수했습니다. ${queued}개 그룹은 이전 발송 확인 후 자동으로 시작합니다.`
      if(noticeSequence.current===noticeId)showNotice(result.refreshed?success:`${success} 요청은 접수됐으며 화면 상태를 다시 불러오고 있습니다.`)
      return true
    }
    catch(error) {if(error instanceof ApiError&&error.code==='VERSION_CONFLICT')await refresh().catch(()=>{});if(noticeSequence.current===noticeId)showNotice(requestErrorMessage(error),'error'); return false}
    finally {endAction(key)}
  }
  const stale = !connected || Date.now()-lastSeen>20000
  const notificationCount=['blocked','pending','recovering','stale'].includes(operationSummary(snapshot,stale).kind)?1:0
  const startReasons = allRunBlockers(snapshot)
  const startBlocked = stale||!snapshot.groups.some(g=>g.enabled!==false)||startReasons.length>0||Boolean(snapshot.service?.status&&!['ready','resume_required','stopped'].includes(String(snapshot.service.status)))
  const actionBusy=busy||auth!=='ready'||!connected
  if(lanLoginRequired(accessMode,auth))return <LanLogin onAuthenticated={()=>{setAuth('loading');setReconnectKey(key=>key+1)}}/>
  if (auth!=='ready'&&!hasConnected.current) return <div className="gate"><div className="brand-logo">D</div><h1>DICO 중앙 관리</h1><p>{auth==='loading'?(connectionPhase==='reconnecting'?`관리 프로그램에 다시 연결하고 있습니다… (${retryCount} / 8)`:'로컬 관리 프로그램에 연결하고 있습니다…'):auth==='unauthorized'?'연결 세션이 만료됐습니다. DICO 확장의 ‘채널 설정 열기’로 다시 인증해 주세요.':'연결을 기다리고 있습니다. 1분 간격으로 연결을 다시 확인하며, 네트워크나 화면이 돌아오면 더 빨리 확인합니다.'}</p><button onClick={()=>setReconnectKey(key=>key+1)}>연결 다시 확인</button></div>
  return <ServerClock serverNow={snapshot.serverNow} receivedAt={snapshotReceivedAt} connected={connected&&auth==='ready'}><div className="shell"><DialogAccessibility/>
    <aside id="main-sidebar" ref={sidebarRef} className={`sidebar ${menu?'open':''}`}>
      <div className="brand"><span className="brand-logo">D</span><span><b>DICO</b><small>CONTROL CENTER</small></span></div>
      <div className="workspace-label">WORKSPACE <span>개인 작업 공간</span></div>
      <nav aria-label="주 메뉴">{navigation.map(item=><button key={item.id} aria-current={page===item.id?'page':undefined} className={`nav-item ${page===item.id?'active':''}`} onClick={()=>go(item.id)}><span className="nav-icon" aria-hidden="true">{item.icon}</span>{item.label}</button>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-help"><span>◈</span><strong>처음 사용하시나요?</strong><p>연결부터 첫 실행까지<br/>차근차근 안내해 드립니다.</p><button onClick={()=>go('settings')}>설정 가이드 보기 →</button></div><div className="sidebar-foot">DICO · LOCAL WORKSPACE</div></div>
    </aside>
    {menu&&<button className="scrim" aria-label="메뉴 닫기" onClick={closeMenu}/>}
    <div className="main-col">
      <header className="topbar"><button ref={menuButtonRef} className="mobile-menu" onClick={()=>setMenu(true)} aria-label="메뉴 열기" aria-expanded={menu} aria-controls="main-sidebar">☰</button><div className="breadcrumb">개인 작업 공간 <span>/</span> <strong>{navigation.find(x=>x.id===page)?.label}</strong></div><div className="top-actions"><span className={`connection ${stale?'offline':''}`}><i/>{connectionPhase==='reconnecting'?'관리 프로그램 재연결 중':connectionPhase==='offline'?'연결 복귀 대기':connectionPhase==='expired'?'인증 다시 확인 필요':stale?'상태 갱신 중':'로컬 서비스 연결됨'}</span><span className="last-seen">최근 수신 {lastSeen?new Date(lastSeen).toLocaleTimeString('ko-KR'):'—'}</span><div className="bell-wrap"><button className="icon-button bell" aria-label={`알림 ${notificationCount}건`} onClick={()=>setNotifications(!notifications)}>♧{notificationCount>0&&<span>{notificationCount}</span>}</button>{notifications&&<div className="notification-popover"><div className="popover-heading"><strong>알림 센터</strong><button onClick={()=>setNotifications(false)} aria-label="닫기">×</button></div>{<><p className="empty-pop"><strong>{operationSummary(snapshot,stale).title}</strong><br/>{operationSummary(snapshot,stale).description}</p><button className="popover-footer" onClick={()=>go('dashboard')}>현재 작업 상태 보기 →</button></>}</div>}</div><button className="primary" disabled={actionBusy||startBlocked} title={stale?'상태를 다시 수신한 뒤 실행할 수 있습니다.':startReasons.length?startReasons.join(' · '):snapshot.groups.length===0?'발송 그룹을 먼저 만들어 주세요.':startBlocked?'그룹의 연결·메시지·실행 상태를 확인하세요.':'모든 그룹의 실제 실행 조건을 다시 검사합니다.'} onClick={()=>{if(confirm('활성화된 발송 그룹을 모두 실행할까요? 실제 Discord 메시지가 발송됩니다. 준비되지 않은 그룹이 있으면 전체 요청이 취소됩니다.'))void run('service.startAll',{},'활성화된 그룹의 실행 요청을 적용했습니다.')}}>▶ <span>모두 실행</span></button><button className="danger-button" aria-label="전체 중지" disabled={auth!=='ready'||!connected||pendingActions.current.has('service.stopAll:all')} onClick={()=>void run('service.stopAll',{},'전체 중지를 요청했습니다. 브라우저 적용 상태를 자동으로 확인합니다.')}>■ <span>{pendingActions.current.has('service.stopAll:all')?'중지 요청 중…':'전체 중지'}</span></button></div></header>
      <main>{auth==='unauthorized'&&<div className="callout warning" role="alert"><b>연결 세션이 만료됐습니다.</b><span>현재 입력 내용은 유지되며 저장·발송 요청은 잠시 막혀 있습니다. DICO 확장의 ‘채널 설정 열기’로 다시 인증한 뒤 이 탭에서 연결을 확인하세요.</span><button className="outline small" disabled={connectionPhase==='reconnecting'} onClick={()=>setReconnectKey(key=>key+1)}>인증 후 연결 확인</button></div>}{connectionPhase==='reconnecting'&&<div className="callout warning" role="status"><b>관리 프로그램에 다시 연결하고 있습니다.</b><span>업데이트·재시작 중에도 현재 주소와 탭을 유지합니다. 잠시 기다려 주세요. ({retryCount} / 8)</span></div>}{connectionPhase==='offline'&&<div className="callout warning" role="status"><b>관리 프로그램의 연결 복귀를 기다리고 있습니다.</b><span>현재 편집 내용은 유지됩니다. 1분 간격으로 연결을 다시 확인하며, 네트워크나 화면이 돌아오면 더 빨리 확인합니다.</span><button className="outline small" onClick={()=>setReconnectKey(key=>key+1)}>다시 연결</button></div>}{newAppVersion&&<div className="callout version-banner" role="status"><b>새 관리 프로그램 {newAppVersion}에 연결됐습니다.</b><span>작성 중인 내용을 저장한 뒤 현재 탭의 화면을 업데이트해 주세요.</span><button className="outline small" disabled={actionBusy} onClick={()=>location.reload()}>화면 업데이트</button></div>}{notice&&<div className={`flash ${notice.kind}`} role={notice.kind==='error'?'alert':'status'} onMouseEnter={()=>toastTimer.current?.pause('hover')} onMouseLeave={()=>toastTimer.current?.resume('hover')} onFocusCapture={()=>toastTimer.current?.pause('focus')} onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node|null))toastTimer.current?.resume('focus')}}><span key={notice.id}>{notice.text}</span><button onClick={clearNotice} aria-label="알림 닫기">×</button></div>}
        {page==='dashboard'&&!stale&&snapshot.groups.length>0&&startReasons.length>0&&<section className="callout warning" aria-label="실행 준비 안내"><b>모두 실행 전 확인할 항목이 있습니다.</b><div><ul>{startReasons.map(reason=><li key={reason}>{reason}</li>)}</ul><p>준비된 그룹은 아래에서 개별 실행할 수 있습니다.</p></div><button className="outline small" onClick={()=>go('groups')}>그룹별 준비 상태 보기</button></section>}
        {page==='dashboard'&&<UserDashboard s={snapshot} run={run} busy={actionBusy} go={go} stale={stale}/>}
        {page==='messages'&&<Messages s={snapshot} run={run} busy={actionBusy} go={go} registerGuard={registerNavigationGuard}/>}
        {page==='connections'&&<AccountConnections s={snapshot} run={run} busy={actionBusy} go={go}/>}
        {page==='channels'&&<ChannelSetup s={snapshot} run={run} busy={actionBusy} go={go} registerGuard={registerNavigationGuard}/>}
        {page==='groups'&&<Groups s={snapshot} run={run} busy={actionBusy} go={go} registerGuard={registerNavigationGuard}/>}
        {page==='settings'&&<Settings accessMode={accessMode} draftStatus={settingsHaveDraft} s={snapshot} run={run} busy={actionBusy} go={go} registerGuard={registerNavigationGuard} appVersion={appVersion} notify={async()=>{if(auth!=='ready'||!connected){showNotice('다시 인증하고 관리 프로그램 연결을 확인한 뒤 알림을 요청해 주세요.','error');return}try {const response=await testNotification();showNotice(response.result.status==='requested'?'OS 테스트 알림을 요청했습니다. 표시 여부는 운영체제 설정에 따라 달라질 수 있습니다.':response.result.status==='disabled'?'OS 알림이 꺼져 있습니다. 알림 설정을 켠 뒤 다시 시도해 주세요.':'이 환경에서는 OS 알림을 사용할 수 없습니다. 화면 알림은 계속 표시됩니다.')}catch(e){showNotice(requestErrorMessage(e),'error')}}}/>}
      </main>
    </div>
  </div></ServerClock>
}

type Common = {diagnostic?:boolean;supportReport?:(attemptId?:string)=>void;s:Snapshot;run:(action:string,payload:Record<string,unknown>,success?:string)=>Promise<boolean>;busy:boolean;go:(page:Page)=>void;registerGuard?:(guard:(()=>boolean)|null)=>void}
type RetryAction={retryNotSent:(attemptId:string)=>Promise<RetryNotSentStatus|null>}
function RetryNotSentButton({attempt,s,busy,retryNotSent}:{attempt:Attempt;s:Snapshot;busy:boolean}&RetryAction){
  const [outcome,setOutcome]=useState<RetryNotSentStatus|null>(null)
  if(!canRetryNotSent(attempt,s))return outcome==='waiting'?<p className="secondary" role="status">{retryNotSentMessage(outcome)}</p>:null
  return <><button className="primary small" disabled={busy} onClick={()=>void retryNotSent(attempt.id).then(setOutcome)}>미발송 확인 · 같은 계정에서 계속</button>{outcome==='waiting'&&<p className="secondary" role="status">{retryNotSentMessage(outcome)}</p>}</>
}
function Heading({eyebrow,title,description,action}:{eyebrow:string;title:string;description?:string;action?:React.ReactNode}) {return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description&&<p>{description}</p>}</div>{action&&<div className="heading-action">{action}</div>}</div>}
function Empty({icon='◇',title,description,action}:{icon?:string;title:string;description:string;action?:React.ReactNode}) {return <div className="empty-state"><span className="empty-icon">{icon}</span><strong>{title}</strong><p>{description}</p>{action}</div>}
function Section({title,subtitle,action,children}:{title:string;subtitle?:string;action?:React.ReactNode;children:React.ReactNode}) {return <section className="panel"><div className="panel-head"><div><h2>{title}</h2>{subtitle&&<p>{subtitle}</p>}</div>{action}</div>{children}</section>}

function SetupProgress({s,go}:{s:Snapshot;go:Common['go']}) {
  const steps=setupSteps(s),next=steps.find(step=>!step.done)
  if(!next)return <section className="setup-progress setup-progress-complete" aria-label="첫 실행 준비"><div className="setup-progress-heading"><div><strong>첫 실행 준비 · 항목 확인 완료</strong><p>발송 전 현재 연결과 그룹 조건을 다시 확인하세요.</p></div><button className="outline small" onClick={()=>go('groups')}>그룹 보기 →</button></div></section>
  return <section className="setup-progress" aria-label="첫 실행 준비">
    <div className="setup-progress-heading"><div><strong>첫 실행 준비</strong><p>{next?`다음 단계: ${next.title} · ${next.description}`:'설정 항목을 확인했습니다. 그룹에서 실행 전 요약을 확인하세요.'}</p></div><button className="outline small" onClick={()=>go(next?.page||'groups')}>{next?'다음 단계로':'그룹 보기'} →</button></div>
    <ol>{steps.map((step,i)=><li key={step.title}><button onClick={()=>go(step.page)} aria-label={`${i+1}. ${step.title}: ${step.done?'확인됨':'준비 필요'}`}><span className={step.done?'done':''}>{step.done?'✓':i+1}</span><strong>{step.title}</strong><small>{step.done?'확인됨':'준비 필요'}</small></button></li>)}</ol>
    <small>이 안내는 현재 확인된 상태 기준입니다. 설정만으로 메시지를 보내지 않으며 실행 시 모든 조건을 다시 검사합니다.</small>
  </section>
}

function RegisteredAccountCard({a,s,run,busy}:Pick<Common,'s'|'run'|'busy'>&{a:Account}) {
  const [editing,setEditing]=useState(false),[name,setName]=useState(''),[baseVersion,setBaseVersion]=useState(0)
  const browser=s.instances.find(i=>i.id===a.instanceId),ready=accountReady(s,a)
  const save=async()=>{if(!name.trim())return;const ok=await run('account.update',{id:a.id,expectedVersion:baseVersion,name:name.trim()},'계정 표시 이름을 저장했습니다.');if(ok)setEditing(false)}
  return <article className="account-card"><div className="account-card-head"><span className="account-avatar" aria-hidden="true">{accountLabel(s,a).slice(0,1)}</span><div><strong>{accountLabel(s,a)}</strong><small>Discord ID {a.accountId}</small>{(a.observedName||a.username)&&<small>Discord 닉네임 {a.observedName||a.username}{a.username&&a.username!==a.observedName?` · @${a.username}`:''}</small>}</div><span className={`status ${ready?'good':'warn'}`}>{ready?'계정 검증됨':a.verified?'브라우저 재연결 필요':'다시 등록·검증 필요'}</span></div><p>{browser?browserDisplayName(browser):'브라우저 확인 필요'}</p><p>최근 계정 확인 {date(a.lastVerifiedAt)}</p>
    {editing?<form className="account-name-form" onSubmit={e=>{e.preventDefault();void save()}}><label>계정 표시 이름<input autoFocus value={name} maxLength={100} onChange={e=>setName(e.target.value)}/></label>{baseVersion!==a.version&&<p role="alert">다른 화면에서 계정 정보가 변경됐습니다. 입력은 유지됩니다. 취소 후 다시 편집하면 최신 버전을 불러옵니다.</p>}<div className="control-row"><button className="outline small" disabled={busy||!name.trim()}>이름 저장</button><button type="button" className="text-action" onClick={()=>setEditing(false)}>취소</button></div></form>:<button className="text-action" disabled={busy||a.id.startsWith('legacy:')} onClick={()=>{setName(a.name);setBaseVersion(a.version);setEditing(true)}}>계정 이름 편집</button>}
    <RemovalAction kind="account" id={a.id} version={a.version} name={accountLabel(s,a)} busy={busy} run={run}/>
  </article>
}

function BrowserConsolidateAction({instance,s,run,busy}:Pick<Common,'s'|'run'|'busy'>&{instance:Instance}) {
  const channels=s.channels.filter(c=>c.instanceId===instance.id)
  const binding=channels.find(c=>managedWindowAvailable(s,c))||channels[0]
  if(!binding)return null
  const active=s.attempts.some(a=>channels.some(c=>c.id===a.bindingId)&&['preparing','permitted','unknown'].includes(a.status||''))
  const running=s.groups.some(g=>g.members.some(id=>channels.some(c=>c.id===id))&&!['stopped','paused'].includes(g.status))
  const help=active?'진행·미확인 발송을 먼저 중지하고 실제 게시 여부를 확인해 주세요.':running?'해당 브라우저의 실행 중인 그룹을 먼저 중지해 주세요.':'이 브라우저의 전송 탭을 하나의 최소화된 창으로 모읍니다. 탭과 작성 중인 초안은 유지됩니다.'
  return <button className="outline small" disabled={busy||!managedWindowAvailable(s,binding)||active||running} title={help} onClick={()=>void run('channel.consolidate',{id:binding.id},'전송 창 모으기를 요청했습니다. 기존 탭과 초안을 유지하며, 정리 중에는 발송을 시작할 수 없습니다.')}>전송 창 하나로 모으기</button>
}

function AccountConnections({s,run,busy,go}:Common) {
  const accounts=registeredAccounts(s)
  return <><Heading eyebrow="ACCOUNTS / 계정 등록" title="계정 · 브라우저" description="Discord 계정을 먼저 등록하세요. 사용할 채널은 ‘채널 설정’에서 따로 추가합니다." action={<button className="outline" onClick={()=>go('channels')}>채널 설정 →</button>}/><SetupProgress s={s} go={go}/>
    <details className="registration-help" open={accounts.length===0}><summary>계정 추가 방법 · Chrome / Brave / 다른 프로필</summary><div className="registration-guide"><div><h2>현재 로그인한 Discord 계정 등록</h2><ol><li>등록할 계정으로 로그인한 Discord 탭을 여세요.</li><li>그 브라우저에서 DICO 확장 아이콘을 누르세요.</li><li><strong>‘현재 Discord 계정 등록’</strong>을 누르고 아래 등록 결과를 확인하세요.</li></ol><p>채널을 연결하지 않아도 계정을 등록할 수 있습니다. 다른 브라우저 프로필도 같은 순서로 등록하세요.</p></div><div className="editor-note">계정 확인에 실패하면 Discord를 새로고침하고 계정 메뉴가 닫힌 상태에서 다시 등록하세요. 기본 프로필 사진도 등록할 수 있습니다. 현재 사용자 영역에서 계정 정보를 확인하지 못하면 확인 필요 상태로 남습니다. 등록 버튼이 없으면 확장을 최신 버전으로 업데이트하고 다시 연결하세요.</div></div></details>
    <Section title="등록된 Discord 계정" subtitle="등록 시 실제 Discord 닉네임을 자동으로 저장합니다. 표시 이름은 별도로 바꿀 수 있으며 계정 ID와 검증 상태도 함께 확인하세요.">{accounts.length?<div className="account-grid">{accounts.map(a=><RegisteredAccountCard key={a.id} a={a} s={s} run={run} busy={busy}/>)}</div>:<Empty title="아직 등록된 계정이 없습니다" description="위 안내에 따라 확장에서 현재 Discord 계정을 등록해 주세요. 브라우저 연결만으로 계정이 등록되지는 않습니다."/>}</Section>
    <Section title="브라우저 프로필" subtitle="등록 계정과 브라우저의 최근 응답을 프로필별로 확인합니다.">{s.instances.length?<div className="instance-grid">{s.instances.map(i=><div className="instance-card" key={i.id}><div className="instance-icon">◫</div><div><strong>{browserDisplayName(i)}</strong><p>{accounts.filter(a=>a.instanceId===i.id).map(a=>accountLabel(s,a)).join(' · ')||'등록 계정 없음'} · 확장 {i.extensionVersion||'버전 정보 없음'}</p>{status(browserOnline(i,s.serverNow??Date.now())?'connected':'disconnected')}<small>마지막 응답 {date(i.lastSeenAt)}</small><small>등록 계정 {accounts.filter(a=>a.instanceId===i.id).length}개</small><BrowserConsolidateAction instance={i} s={s} run={run} busy={busy}/><button className="text-action" disabled={busy} onClick={()=>{const name=prompt('브라우저 연결의 표시 이름',i.name);if(name?.trim()&&name!==i.name)void run('instance.update',{id:i.id,expectedVersion:i.version,name:name.trim()})}}>브라우저 이름 바꾸기</button><RemovalAction kind="instance" id={i.id} version={i.version} name={browserDisplayName(i)} busy={busy} run={run}/></div></div>)}</div>:<Empty icon="◫" title="연결된 브라우저가 없습니다" description="Chrome 또는 Brave에 DICO 확장을 설치한 뒤 확장의 관리 프로그램 연결 버튼을 눌러 주세요." action={<button className="outline" onClick={()=>go('settings')}>설치·연결 진단 →</button>}/>}</Section></>
}

function ChannelSetup({s,run,busy,go,registerGuard}:Common) {
  const targets=logicalTargets(s),accounts=registeredAccounts(s)
  const [url,setUrl]=useState(''),[name,setName]=useState(''),[targetKey,setTargetKey]=useState(''),[selectedAccounts,setSelectedAccounts]=useState<string[]>([]),[error,setError]=useState(''),[connecting,setConnecting]=useState(false),[bindingDirty,setBindingDirty]=useState(false)
  useEffect(()=>{registerGuard?.(()=>!bindingDirty&&!(url.trim()||name.trim())||confirm('저장하지 않은 채널 변경을 버리고 이동할까요?'));return()=>registerGuard?.(null)},[bindingDirty,url,name,registerGuard])
  const target=targets.find(t=>`${t.guildId}:${t.channelId}`===targetKey)||(!targetKey?targets[0]:undefined)
  const bindings=target?s.channels.filter(c=>c.guildId===target.guildId&&c.channelId===target.channelId):[]
  const selectableAccounts=selectableConnectionAccountIds(s,target)
  const selectedEligibleAccounts=selectedAccounts.filter(id=>selectableAccounts.includes(id))
  const allAccountsSelected=selectableAccounts.length>0&&selectableAccounts.every(id=>selectedEligibleAccounts.includes(id))
  const chooseTarget=(key:string)=>{if(key===`${target?.guildId}:${target?.channelId}`)return;if(bindingDirty&&!confirm('저장하지 않은 메시지 목록·주기 변경을 버리고 다른 채널을 열까요?'))return;setTargetKey(key);setSelectedAccounts([]);setBindingDirty(false)}
  const create=async()=>{
    setError('');let parsed:URL
    try {parsed=new URL(url);if(parsed.protocol!=='https:'||!['discord.com','canary.discord.com','ptb.discord.com'].includes(parsed.hostname)||!/^\/channels\/\d{1,30}\/\d{1,30}\/?$/.test(parsed.pathname))throw Error()}catch {setError('Discord 서버 채널의 URL을 입력하세요. 예: https://discord.com/channels/서버ID/채널ID');return}
    if(bindingDirty&&!confirm('새 채널을 추가하면 현재 열어 둔 메시지 편집이 닫힙니다. 계속할까요?'))return
    const ok=await run('target.create',{url:`https://discord.com${parsed.pathname}`,...(name.trim()?{name:name.trim()}:{})},'채널을 저장했습니다. 사용할 계정을 선택해 연결을 요청하세요.')
    if(ok){const parts=parsed.pathname.split('/');setTargetKey(`${parts[2]}:${parts[3]}`);setSelectedAccounts([]);setUrl('');setName('');setBindingDirty(false)}
  }
  const connect=async()=>{if(!target)return;setConnecting(true);try{for(const id of selectedEligibleAccounts){const a=accounts.find(a=>a.id===id);if(!a||!accountReady(s,a)||pendingConnection(s,a,target))continue;const ok=await run('channel.connect',{accountId:a.id,targetId:target.id},'브라우저에 채널 열기를 요청했습니다. 실제 계정·채널 검증을 기다려 주세요.');if(!ok)break;setSelectedAccounts(ids=>ids.filter(x=>x!==id))}}finally{setConnecting(false)}}
  return <><Heading eyebrow="CHANNELS / 채널 설정" title="채널 설정" description="채널 URL을 저장하고, 등록 계정 중 이 채널에서 사용할 계정을 연결하세요."/><SetupProgress s={s} go={go}/>
    <Section title="1. Discord 채널 추가" subtitle="열려 있는 Discord 탭에서 실제 채널 이름을 확인합니다. 이름을 읽을 수 없으면 계정 연결 후 자동으로 갱신합니다."><form className="target-create" onSubmit={e=>{e.preventDefault();void create()}}><label>Discord 채널 URL<input type="url" required value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://discord.com/channels/서버ID/채널ID"/></label><label>채널 별칭 <small>선택 · 비워 두면 실제 이름 자동 표시</small><input value={name} maxLength={100} onChange={e=>setName(e.target.value)} placeholder="예: 모집 공지방"/></label><button className="primary" disabled={busy||!url.trim()}>채널 추가</button>{error&&<p role="alert" className="target-error">{error}</p>}</form></Section>
    <Section title="2. 채널 선택 · 계정 연결" subtitle="연결 요청은 채널만 엽니다. 검증과 메시지 적용이 끝나기 전에는 실행 준비로 표시하지 않습니다.">
      {targets.length?<div className="target-workspace"><div className="target-list" aria-label="저장한 채널">{targets.map(t=><button className={`target-item ${target?.id===t.id?'selected':''}`} aria-pressed={target?.id===t.id} key={t.id} onClick={()=>chooseTarget(`${t.guildId}:${t.channelId}`)}><strong># {t.name}</strong><small>서버 {t.guildId} · 채널 {t.channelId}</small><span>연결 계정 {s.channels.filter(c=>c.guildId===t.guildId&&c.channelId===t.channelId&&c.verified&&browserOnline(s.instances.find(i=>i.id===c.instanceId))).length}개</span></button>)}</div><div className="target-account-picker">{target?<><h3>{target.namePending?'추가한 채널에 사용할 계정':`#${target.name}에 사용할 계정`}</h3><div className="control-row"><RenameTargetAction target={target} busy={busy||connecting} run={run}/><RemovalAction kind="target" id={target.id} version={target.version} name={`#${target.name}`} busy={busy||connecting} run={run} onRemoved={()=>{setTargetKey('');setSelectedAccounts([]);setBindingDirty(false)}}/></div>{target.namePending&&<p className="secondary" role="status">채널 이름 확인 대기 중입니다. 계정을 이 채널에 연결하면 실제 이름을 자동으로 확인합니다. 채널 ID는 아래 식별 정보에서 확인할 수 있습니다.</p>}<p className="secondary">Discord 서버 접근 권한이 있는 계정을 선택하세요. 새 탭을 열고 실제 로그인 계정과 대상 채널을 검사합니다.</p>{accounts.length?<><fieldset disabled={busy||connecting}><legend className="sr-only">연결할 등록 계정</legend><div className="control-row"><button type="button" className="outline small" disabled={!selectableAccounts.length||allAccountsSelected} onClick={()=>setSelectedAccounts(ids=>selectEligibleIds(ids.filter(id=>selectableAccounts.includes(id)),selectableAccounts))}>전체 선택</button><button type="button" className="outline small" disabled={!selectedAccounts.length} onClick={()=>setSelectedAccounts([])}>전체 해제</button><small>연결 가능한 계정 {selectableAccounts.length}개 · 선택 {selectedEligibleAccounts.length}개</small></div>{accounts.map(a=>{const binding=bindings.find(c=>c.instanceId===a.instanceId&&c.accountId===a.accountId),pending=pendingConnection(s,a,target),ready=accountReady(s,a);return <div className="connect-account-row" key={a.id}><label className="connect-account"><input type="checkbox" checked={selectedEligibleAccounts.includes(a.id)} disabled={!selectableAccounts.includes(a.id)} onChange={e=>setSelectedAccounts(ids=>e.target.checked?[...ids,a.id]:ids.filter(id=>id!==a.id))}/><span><strong>{accountLabel(s,a)}</strong><small>{s.instances.find(i=>i.id===a.instanceId)?.name||'브라우저'} · {short(a.accountId)}</small></span><span className={`account-connection-state ${binding?.verified&&ready?'verified':''}`}>{pending?'채널 열기 · 검증 대기':binding&&!browserOnline(s.instances.find(i=>i.id===binding.instanceId))?'브라우저 연결 끊김 · 브라우저와 확장을 다시 연결해 주세요.':binding&&!ready?'계정 재등록·연결 필요':binding?`${channelVerification(binding).title} · ${channelVerification(binding).action}`:!ready?'계정 재등록·연결 필요':'연결 전'}</span></label>{binding&&<div className="control-row"><ChannelWindowActions s={s} channel={binding} run={run} busy={busy||connecting}/><RemovalAction kind="channel" id={binding.id} version={binding.version} name={`${accountLabel(s,a)} · #${target.name}`} busy={busy||connecting} run={run}/></div>}</div>})}</fieldset><div className="control-row"><button className="primary" disabled={busy||connecting||!selectedEligibleAccounts.length} onClick={()=>void connect()}>{connecting?'연결 요청 중…':`선택 계정 ${selectedEligibleAccounts.length}개 연결`}</button><button className="text-action" onClick={()=>go('connections')}>계정 등록·상태 확인 →</button></div><p className="secondary">전송용 Discord 탭은 브라우저 프로필마다 하나의 최소화된 창에 모입니다. 전송 창 보기로 해당 채널 탭을 확인하세요. 기존에 나뉜 창은 계정·브라우저의 전송 창 하나로 모으기로 정리할 수 있습니다. 브라우저는 계속 실행 중이어야 합니다. 등록된 전송 탭이 사라지면 진행 중·미확인 발송이 없는 상태에서 자동 복원을 시도합니다.</p></>:<Empty title="등록 계정이 필요합니다" description="채널은 저장되었습니다. 확장에서 계정을 등록한 뒤 이곳으로 돌아오세요." action={<button className="outline" onClick={()=>go('connections')}>계정 등록 안내 →</button>}/>}</>:<Empty title="채널을 선택하세요" description="저장한 채널을 선택하면 계정을 연결할 수 있습니다."/>}</div></div>:<Empty icon="#" title="저장한 채널이 없습니다" description="위에 Discord 채널 URL을 붙여 넣어 첫 채널을 추가하세요. 계정 등록 전에도 저장할 수 있습니다."/>}
    </Section>{target&&<BindingEditor key={target.id} s={s} run={run} busy={busy||connecting} go={go} bindings={bindings} onDirty={setBindingDirty}/>}
    {bindings.some(c=>bindingBlockers(s,c).length===0)&&<div className="callout"><b>메시지 적용까지 확인된 계정이 있습니다.</b><span>발송 그룹에서 계정 순서와 간격을 설정하세요.</span><button className="outline small" onClick={()=>go('groups')}>발송 그룹 →</button></div>}
  </>
}

// 사용자 화면은 확정된 결과와 현재 제어 상태만 보여 줍니다. 발송 엔진과
// 시작·중지 명령은 진단 화면과 공유하므로 화면 전환이 실행 상태를 바꾸지 않습니다.
function UserDashboard(props:Common&{stale:boolean}) {
  return <OperationalDashboard {...props}/>
}

function DashboardGroupControls({s,group,run,busy,stale,go}:{s:Snapshot;group:Group;run:Common['run'];busy:boolean;stale:boolean;go:(p:Page)=>void}) {
  const controls=groupControls(s,group,{busy,stale})
  const start=()=>{if(controls.start.disabled)return;if(!confirm(controls.start.confirmation))return;void run(controls.start.action,{id:group.id,expectedVersion:group.version},`${group.name}의 ${controls.start.label}을 요청했습니다.`)}
  const stop=()=>{if(!controls.stop.disabled)void run(controls.stop.action,{id:group.id,expectedVersion:group.version},`${group.name}의 중지를 요청했습니다.`)}
  return <div className="dashboard-group-controls"><div className="control-row"><button className="primary small" disabled={controls.start.disabled} title={controls.start.reasons.join(' · ')} aria-label={`${group.name} ${controls.start.label}`} onClick={start}>{controls.start.label}</button><button className="outline small" disabled={controls.stop.disabled} aria-label={`${group.name} ${controls.stop.label}`} onClick={stop}>{controls.stop.label}</button><button className="text-action" onClick={()=>go('groups')}>상세</button></div>{controls.needsReview?<button className="text-action" onClick={()=>go('history')}>이전 발송 결과 확인 →</button>:group.status!=='running'&&controls.start.reasons.length>0?<small className="secondary">{controls.start.reasons.join(' · ')}</small>:null}</div>
}

function Dashboard({s,analytics,analyticsStatus,analyticsAt,retryAnalytics,lastSeen,period,setPeriod,go,run,busy,stale}:{s:Snapshot;analytics:Record<string,unknown>|null;analyticsStatus:'loading'|'ready'|'error';analyticsAt:number;retryAnalytics:()=>void;lastSeen:number;period:string;setPeriod:(s:string)=>void;go:(p:Page)=>void;run:Common['run'];busy:boolean;stale:boolean}) {
  const open = s.incidents.filter(isIncidentOpen)
  const running = s.groups.filter(g=>g.status==='running').length
  const confirmed = typeof analytics?.confirmed==='number'?analytics.confirmed:null
  const connected = s.instances.filter(i=>browserOnline(i,s.serverNow??Date.now())).length
  const fresh = s.groups.length||s.channels.length||s.messages.length||s.instances.length
  const needsSetupGuide=!registeredAccounts(s).length||!logicalTargets(s).length||!s.channels.some(c=>c.playlist.length)||!s.groups.length
  const buckets = Array.isArray(analytics?.confirmedBuckets)?analytics.confirmedBuckets as ConfirmedBucket[]:[]
  const end=typeof analytics?.to==='number'?analytics.to:0
  const start=typeof analytics?.from==='number'?analytics.from:0
  const hours=analytics&&start&&end?confirmedSeries(buckets,start,end,period==='1h'?'1h':period==='7d'?'7d':'24h'):[]
  const max = Math.max(1,...hours.map(h=>h.count))
  return <><Heading eyebrow="OVERVIEW / 실시간 운영 현황" title="대시보드" description="연결과 발송 상태를 한눈에 확인하고 필요한 작업을 이어가세요." action={<span className="updated">◷ 마지막 수신 {date(lastSeen)}</span>}/>
    <div className="stat-grid dashboard-priority"><Stat title="실행 중 그룹" value={running} suffix="개" icon="◉" hint={`전체 ${s.groups.length}개 그룹`}/><Stat title="확인 필요한 그룹" value={s.groups.filter(g=>['needs_review','resume_required','stop_pending','pause_pending'].includes(g.status)||s.attempts.some(a=>a.id===g.activeAttemptId&&a.status==='unknown')).length} suffix="개" icon="◈" hint="자동으로 차례를 넘기지 않습니다"/><Stat title="연결된 브라우저" value={stale?'—':connected} suffix={`/ ${s.instances.length}`} icon="◫" hint={stale?'최근 상태 수신 대기':'확장 최근 응답 기준'}/><Stat title="선택 기간 발송 처리" value={confirmed??'—'} suffix="건" icon="▥" hint={analyticsStatus==='error'?'집계 조회 실패 · 이전 값은 참고용':analyticsStatus==='loading'?'집계 불러오는 중':analyticsAt?`집계 수신 ${date(analyticsAt)}`:'발송 처리된 시도 집계'}/></div>
    {open.length>0&&<div className="issue-banner dashboard-issues"><div className="issue-icon">!</div><div><strong>확인할 문제 {open.length}건</strong><p>{incidentText(open[0],s)}</p></div><button onClick={()=>go('logs')}>문제 확인 →</button></div>}
    {stale&&<div className="callout warning"><b>상태 갱신이 지연되고 있습니다.</b><span>새 발송 여부를 판단하기 전 연결을 확인해 주세요.</span></div>}
    <ConnectionProgress s={s} stale={stale} onOpenConnections={()=>go('connections')} onNavigate={go}/>
    <ChannelCountdownCards s={s} go={()=>go('channels')} run={run} busy={busy} renderGroupActions={group=><DashboardGroupControls s={s} group={group} run={run} busy={busy} stale={stale} go={go}/>}/>
    {needsSetupGuide&&<SetupProgress s={s} go={go}/>}
    {!fresh?<div className="onboarding"><div className="onboarding-copy"><span className="eyebrow">GETTING STARTED</span><h2>첫 발송을 준비해 볼까요?</h2><p>확장에서 계정을 등록한 뒤 채널과 메시지, 계정 순서를 설정해 주세요. 설정만으로 메시지가 전송되지는 않습니다.</p><button className="primary" onClick={()=>go('settings')}>시작 가이드 보기 <span>→</span></button></div><div className="steps-preview">{['계정 등록','채널 추가','계정과 채널 연결','메시지 적용','그룹 준비'].map((x,i)=><div key={x}><span>{String(i+1).padStart(2,'0')}</span>{x}<small>대기 중</small></div>)}</div></div>:<>
      <Section title="발송 그룹" subtitle="현재 순서와 다음 진행 조건" action={<button className="text-action" onClick={()=>go('groups')}>모든 그룹 보기 →</button>}>{s.groups.length?<div className="group-rows">{s.groups.map(group=><div className="group-row" key={group.id}><div className="group-identity"><span className="group-mark">◉</span><span><strong>{group.name}</strong><small>{short(group.guildId)} · #{s.channels.find(c=>c.id===group.members[group.cursor%safeLength(group.members)])?.name||short(group.channelId)}</small></span></div><div>{status(group.status)}</div><div className="row-detail"><small>현재 · 다음 차례</small><strong>{account(s.channels.find(c=>c.id===group.members[group.cursor%safeLength(group.members)]),s)}</strong></div><div className="row-detail"><small>다음 진행</small><strong><GroupCountdown group={group} s={s}/></strong></div><DashboardGroupControls s={s} group={group} run={run} busy={busy} stale={stale} go={go}/></div>)}</div>:<Empty title="아직 발송 그룹이 없습니다" description="채널과 메시지를 연결한 뒤 계정 순서를 설정하세요." action={<button className="outline" onClick={()=>go('groups')}>그룹 만들기 →</button>}/>}</Section>
      <div className="dashboard-lower"><Section title="발송 처리 추이" subtitle="확인 시각 기준 · 중앙 집계 · 양끝 구간은 일부 시간" action={<div className="filter-actions"><select aria-label="그래프 기간" value={period} onChange={e=>setPeriod(e.target.value)}><option value="1h">최근 1시간</option><option value="24h">최근 24시간</option><option value="7d">최근 7일</option></select><button className="text-action" onClick={()=>go('history')}>원본 기록 →</button></div>}>{analyticsStatus==='loading'&&!analytics?<p className="chart-note" role="status">선택 기간 집계를 불러오는 중입니다.</p>:analyticsStatus==='error'&&!analytics?<div className="connection-empty" role="alert">선택 기간 집계를 불러오지 못했습니다. <button className="outline small" onClick={retryAnalytics}>집계 다시 확인</button></div>:<>{analyticsStatus==='error'&&<div className="connection-empty" role="status">집계 갱신에 실패했습니다. {date(analyticsAt)}에 받은 이전 결과를 표시합니다. <button className="outline small" onClick={retryAnalytics}>다시 확인</button></div>}<div className="chart-area" role="img" aria-label="시간대별 발송 처리 건수"><div className="chart-grid"><span>{max}</span><span>{Math.round(max/2)}</span><span>0</span></div><div className="bars">{hours.map((h,i)=><button key={h.at} title={`${h.label}${h.partial?' (일부 시간)':''}: ${h.count}건`} onClick={()=>go('history')} className="bar-wrap"><span className="bar" style={{height:`${Math.max(h.count?8:2, h.count/max*100)}%`}}/><small>{i%Math.max(1,Math.ceil(hours.length/12))===0?h.label:''}</small></button>)}</div></div><details className="chart-table"><summary>표로 보기</summary><table><thead><tr><th>시간</th><th>처리 확인</th></tr></thead><tbody>{hours.map(h=><tr key={h.at}><td>{h.label}{h.partial?' (일부 시간)':''}</td><td>{h.count}건</td></tr>)}</tbody></table></details></>}</Section><Section title="최근 활동" subtitle="저장된 이벤트 순서" action={<button className="text-action" onClick={()=>go('logs')}>로그 보기 →</button>}>{s.events.length?<div className="activity-list">{[...s.events].reverse().slice(0,5).map((event,i)=><div key={event.eventId||event.id||i}><span className="activity-dot"/><div><strong>{eventText(event)}</strong>{accountIdentity(s,event).accountId&&<small>{accountLabel(s,event)} · Discord ID {accountIdentity(s,event).accountId}</small>}<small>{date(event.at||event.receivedAt||event.createdAt)}</small></div></div>)}</div>:<Empty icon="◷" title="아직 활동 기록이 없습니다" description="연결과 설정 변경 내용이 여기에 표시됩니다."/>}</Section></div>
    </>}
  </>
}
const safeLength = (items:unknown[]) => Math.max(1,items.length)
function Stat({title,value,suffix,icon,hint}:{title:string;value:number|string;suffix:string;icon:string;hint:string}) {return <div className="stat-card"><div className="stat-top"><span>{title}</span><span className="stat-icon">{icon}</span></div><div className="stat-value">{value}<small>{suffix}</small></div><div className="stat-hint">{hint}</div></div>}

function Messages({s,run,busy,go,registerGuard}:Common) {
  const [selected,setSelected] = useState<string|null>(null), [query,setQuery]=useState(''), [showArchived,setShowArchived]=useState(false)
  const current = s.messages.find(m=>m.id===selected)
  const [name,setName]=useState(''),[body,setBody]=useState(''),[tags,setTags]=useState(''),[editing,setEditing]=useState(false)
  const [baseVersion,setBaseVersion]=useState<number|null>(null)
  const messageDraft=current&&baseVersion!==null?draftVersion(baseVersion,current.version):null
  const dirty=editing&&(name!==(current?.name||'')||body!==(current?.body||'')||tags!==(current?.tags.join(', ')||''))
  useEffect(()=>{registerGuard?.(()=>!dirty||confirm('저장하지 않은 메시지 변경을 버리고 이동할까요?'));return()=>registerGuard?.(null)},[dirty,registerGuard])
  const open = (m?:Message) => { if(dirty&&!confirm('저장하지 않은 변경을 버릴까요?'))return;setSelected(m?.id||null);setBaseVersion(m?.version??null);setName(m?.name||'');setBody(m?.body||'');setTags(m?.tags.join(', ')||'');setEditing(true) }
  const filtered = s.messages.filter(m=>(showArchived||!m.archived)&&`${m.name} ${m.body} ${m.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()))
  const refs = current?s.channels.filter(c=>c.playlist.some(p=>p.messageId===current.id)):[]
  const save=async()=>{if(selected&&!current){alert('메시지가 다른 화면에서 삭제됐습니다. 입력 내용은 유지됩니다.');return}if(!name.trim()||!body.trim()){alert('이름과 본문을 입력해 주세요.');return}if(body.length>2000){alert('본문은 2,000자 이하로 입력해 주세요.');return}const ok=await run(current?'message.update':'message.create',current?{id:current.id,expectedVersion:draftVersion(baseVersion,current.version).expectedVersion,name:name.trim(),body,tags:tags.split(',').map(t=>t.trim()).filter(Boolean)}:{name:name.trim(),body,tags:tags.split(',').map(t=>t.trim()).filter(Boolean)},current?'변경사항을 저장했습니다. 연결된 채널의 다음 발송에 자동 반영됩니다.':'메시지를 보관함에 저장했습니다.');if(ok&&current&&baseVersion!==null)setBaseVersion(savedDraftVersion(baseVersion));if(ok&&!current){setEditing(false);setName('');setBody('')}}
  return <><Heading eyebrow="LIBRARY / 메시지 관리" title="메시지 보관함" description="메시지를 수정해 저장하면 연결된 모든 채널의 다음 발송에 자동 반영됩니다." action={<button className="primary" onClick={()=>open()}>＋ 새 메시지</button>}/><div className="split-view"><section className="panel message-list"><div className="list-tools"><input aria-label="메시지 검색" placeholder="이름, 태그, 내용 검색" value={query} onChange={e=>setQuery(e.target.value)}/><label className="checkline"><input type="checkbox" checked={showArchived} onChange={e=>setShowArchived(e.target.checked)}/> 보관 항목 포함</label></div><div className="list-caption">메시지 <b>{filtered.length}</b>개</div>{filtered.length?filtered.map(m=><button className={`message-item ${selected===m.id?'selected':''}`} key={m.id} onClick={()=>open(m)}><span className="message-item-icon">▤</span><span><strong>{m.name}</strong><small>{m.body.slice(0,75)||'내용 없음'}</small><em>{m.tags.map(t=><span key={t}>{t}</span>)}{m.archived&&<span>보관됨</span>}</em></span><span className="message-item-meta"><small>{date(m.updatedAt)}</small></span></button>):<Empty title="표시할 메시지가 없습니다" description="새 메시지를 작성하거나 검색 조건을 바꿔 보세요."/>}</section><section className="panel editor-panel">{editing?<><div className="panel-head"><div><h2>{current?'메시지 편집':'새 메시지'}</h2><p>{current?`${refs.length}개 채널에서 사용 중 · 저장하면 자동 반영`:'작성한 메시지는 채널 목록에 추가하고 그룹을 시작한 뒤 발송됩니다.'}</p></div>{current&&status(current.archived?'archived':'ready')}</div>{messageDraft?.externalChanged&&<div className="draft-warning" role="alert"><strong>다른 화면에서 이 메시지가 변경됐습니다.</strong><span>현재 입력은 유지됩니다. 다른 화면의 변경과 충돌하면 덮어쓰지 않습니다.</span><button className="outline small" onClick={()=>open(current)}>최신본 다시 불러오기</button></div>}{selected&&!current&&<div className="draft-warning" role="alert">이 메시지가 다른 화면에서 삭제됐습니다. 입력 내용을 복사해 새 메시지로 저장해 주세요.</div>}<div className="editor-fields"><label>메시지 이름<input value={name} maxLength={100} onChange={e=>setName(e.target.value)} placeholder="예: 주말 모집 공지"/></label><label>태그 <small>쉼표로 구분</small><input value={tags} onChange={e=>setTags(e.target.value)} placeholder="모집, 주말"/></label><label>메시지 본문 <small className="length">{body.length} / 2,000자</small><textarea rows={12} value={body} maxLength={2000} onChange={e=>setBody(e.target.value)} placeholder="Discord에 보낼 내용을 입력하세요"/></label><div className="editor-note">ⓘ 저장한 문구는 연결된 채널에 자동 반영됩니다. 이미 진행 중인 발송은 기존 문구로 마치고 다음 발송부터 변경한 문구를 사용합니다.</div><div className="editor-actions"><button className="primary" disabled={busy||!name.trim()||!body.trim()||!!selected&&!current} onClick={()=>void save()}>{current?'변경사항 저장':'보관함에 저장'}</button>{current&&<><button className="outline" disabled={busy} onClick={()=>void run('message.duplicate',{id:current.id,expectedVersion:current.version},'복제한 메시지를 만들었습니다.')}>복제</button><button className="outline" disabled={busy} onClick={()=>void run('message.archive',{id:current.id,expectedVersion:draftVersion(baseVersion,current.version).expectedVersion,archived:!current.archived},current.archived?'보관을 해제했습니다.':'메시지를 보관했습니다.').then(ok=>{if(ok&&baseVersion!==null)setBaseVersion(savedDraftVersion(baseVersion))})}>{current.archived?'보관 해제':'보관하기'}</button><button className="text-danger" disabled={busy||refs.length>0} title={refs.length?'사용 중인 채널에서 먼저 해제해야 합니다.':''} onClick={()=>{if(confirm('이 메시지를 영구 삭제할까요?'))void run('message.delete',{id:current.id,expectedVersion:current.version}).then(ok=>{if(ok){setSelected(null);setEditing(false)}})}}>영구 삭제</button></>}</div></div>{current&&<div className="editor-bottom"><h3>적용 현황</h3>{refs.length?<div className="used-list">{refs.map(c=><div key={c.id}><span>#{c.name}</span><small>{messageSyncLabel(c,s)}</small></div>)}</div>:<p className="secondary">아직 적용된 채널이 없습니다.</p>}<button className="text-action" onClick={()=>go('channels')}>채널 메시지 목록 편집 →</button><details><summary>수정 이력 · 참고용</summary><div className="revision-list">{[...current.revisions].reverse().map(r=><div key={r.id}><span>{date(r.at)}</span><p>{r.body.slice(0,110)}</p></div>)}</div></details></div>}</>:<Empty icon="▤" title="메시지를 선택하세요" description="왼쪽 목록에서 메시지를 선택하거나 새 메시지를 작성하세요." action={<button className="primary" onClick={()=>open()}>새 메시지 작성</button>}/>}</section></div></>
}

function BindingEditor({s,run,busy,go,bindings,onDirty}:Common&{bindings:Channel[];onDirty:(dirty:boolean)=>void}) {
  const [selected,setSelected]=useState<string|null>(null),[draft,setDraft]=useState<string[]>([]),[interval,setIntervalValue]=useState('')
  const [baseVersion,setBaseVersion]=useState<number|null>(null)
  const [intervalMode,setIntervalMode]=useState<IntervalMode>('auto'),[intervalTouched,setIntervalTouched]=useState(false)
  const channel=bindings.find(c=>c.id===selected)
  const intervalInfo=channel?intervalSettings(channel):null
  const intervalValue=channel&&!intervalTouched&&intervalMode===intervalSettings(channel).mode?String(Math.ceil(channel.intervalMs/1000)):interval
  const intervalError=intervalMode==='custom'&&intervalInfo?customIntervalError(intervalValue,intervalInfo):''
  const intervalChanged=Boolean(channel&&intervalDraftChanged(channel,intervalMode,intervalValue,intervalTouched))
  useEffect(()=>{onDirty(Boolean(channel&&(channelMessagesChanged(draft,channel)||intervalDraftChanged(channel,intervalMode,intervalValue,intervalTouched))))},[channel,draft,intervalMode,intervalValue,intervalTouched,onDirty])
  // 자동 문구 동기화는 configVersion만 바꿉니다. 사용자 목록 편집의 충돌 검사는 유지합니다.
  const expectedChannelVersion=baseVersion
  const channelDraft=channel&&expectedChannelVersion!==null?draftVersion(expectedChannelVersion,channel.version):null
  const choose=(c:Channel)=>{const changed=channel&&(channelMessagesChanged(draft,channel)||intervalDraftChanged(channel,intervalMode,intervalValue,intervalTouched));if(changed&&!confirm('저장하지 않은 채널 목록과 주기 변경을 버리고 다시 불러올까요?'))return;setSelected(c.id);setBaseVersion(c.version);setDraft(c.playlist.map(p=>p.messageId));setIntervalMode(intervalSettings(c).mode);setIntervalValue(String(Math.ceil(c.intervalMs/1000)));setIntervalTouched(false)}
  const saveInterval=async()=>{if(!channel||intervalError||!intervalChanged)return;const ok=await run('channel.update',{id:channel.id,expectedVersion:expectedChannelVersion!,...intervalPayload(intervalMode,intervalValue)},'계정·채널 주기를 저장했습니다. 브라우저 적용 상태를 확인해 주세요.');if(ok&&baseVersion!==null){setBaseVersion(savedDraftVersion(expectedChannelVersion!));setIntervalTouched(false)}}
  const move=(from:number,to:number)=>setDraft(items=>{const next=[...items];next.splice(to,0,next.splice(from,1)[0]);return next})
  const apply=async()=>{if(!channel)return;if(!draft.length){alert('메시지를 한 개 이상 선택해 주세요.');return}if(!confirm(`#${channel.name}에 ${draft.length}개 메시지를 순서대로 적용할까요? 새 목록은 첫 문구부터 시작합니다. 진행 중 시도는 기존 문구를 사용합니다.`))return;const ok=await run('channel.applyPlaylist',{id:channel.id,expectedVersion:expectedChannelVersion!,items:draft.map(id=>({messageId:id}))},'메시지 목록을 저장했습니다. 최신 문구를 브라우저에 동기화합니다.');if(ok&&baseVersion!==null)setBaseVersion(savedDraftVersion(expectedChannelVersion!))}
  return <><Section title="계정별 메시지 · 주기" subtitle="연결이 검증된 계정마다 메시지 목록을 적용합니다. 실제 발송은 그룹에서 시작합니다.">{bindings.length?<div className="connection-layout"><div className="channel-list">{bindings.map(c=><button key={c.id} className={`channel-item ${selected===c.id?'selected':''}`} onClick={()=>choose(c)}><span className="channel-symbol">#</span><span><strong>{account(c,s)}</strong><small>Discord ID {c.accountId} · {s.instances.find(i=>i.id===c.instanceId)?.name||short(c.instanceId)}</small></span><span className="channel-indicator">{c.verified&&browserOnline(s.instances.find(i=>i.id===c.instanceId))?'검증됨':'확인 필요'}</span></button>)}</div><div className="channel-detail">{channel?<><div className="panel-head"><div><h2>#{channel.name}</h2><p>계정 {account(channel,s)} · {channel.verified?'채널 검증됨':'채널 확인 필요'}</p><p><AccountCountdown s={s} channel={channel}/></p></div>{status(bindingBlockers(s,channel).length===0&&!channel.pendingIntervalSync?'ready':'resume_required')}</div><div className="applied-line"><strong>{channel.pendingIntervalSync?'주기 동기화 대기':!channel.playlist.length?'메시지 미적용':messageSyncLabel(channel,s)}</strong></div>{channelDraft?.externalChanged&&<div className="draft-warning" role="alert"><strong>다른 화면에서 채널 설정이 변경됐습니다.</strong><span>현재 목록은 유지됩니다. 저장 시 원래 버전으로 검사합니다.</span><button className="outline small" onClick={()=>choose(channel)}>최신 구성 다시 불러오기</button></div>}<p className="binding-blockers">{bindingBlockers(s,channel).join(' · ')||'현재 연결·메시지 적용 확인 완료. 실행 시 조건을 다시 검사합니다.'}</p><div className="subheading"><h3>메시지 재생 목록</h3><span>{draft.length} / 50개</span></div><p className="secondary">선택 순서대로 최신 문구를 반복합니다. 목록을 변경해 저장하면 첫 문구부터 시작합니다. 보관함에서 본문만 수정하면 순서는 유지됩니다.</p>{draft.map((id,index)=>{const message=s.messages.find(m=>m.id===id);return <div className="playlist-item" key={`${id}-${index}`}><span className="order-number">{index+1}</span><div><strong>{message?.name||'삭제된 메시지'}</strong><small>{message?'보관함의 최신 문구 자동 반영':'참조 확인 필요'}</small></div><button disabled={index===0} onClick={()=>move(index,index-1)} aria-label={`${message?.name} 위로`}>↑</button><button disabled={index===draft.length-1} onClick={()=>move(index,index+1)} aria-label={`${message?.name} 아래로`}>↓</button><button onClick={()=>setDraft(x=>x.filter((_,i)=>i!==index))} aria-label={`${message?.name} 제거`}>×</button></div>})}<select aria-label="목록에 메시지 추가" value="" onChange={e=>{if(e.target.value)setDraft(x=>[...x,e.target.value])}} disabled={draft.length>=50}><option value="">＋ 목록에 메시지 추가</option>{s.messages.filter(m=>!m.archived&&!draft.includes(m.id)).map(m=><option value={m.id} key={m.id}>{m.name}</option>)}</select>{!s.messages.length&&<button className="text-action" onClick={()=>go('messages')}>먼저 보관 메시지 만들기 →</button>}<div className="subheading"><h3>이 계정 · 같은 채널의 최소 주기</h3><span>{intervalInfo?.observed?`슬로우 모드 ${intervalInfo.slowmodeSeconds}초 감지`:'슬로우 모드 감지 대기'}</span></div><fieldset className="interval-mode"><legend className="sr-only">최소 주기 설정 방식</legend><label><input type="radio" name={`interval-mode-${channel.id}`} checked={intervalMode==='auto'} onChange={()=>setIntervalMode('auto')}/><span><strong>슬로우 모드 기준 자동</strong><small>{intervalInfo?.observed?`감지된 ${intervalInfo.slowmodeSeconds}초 + 여유 3초 = ${intervalInfo.floorSeconds}초`:'감지 전에는 기본 여유 3초를 적용하고, 감지되면 자동으로 반영합니다.'}</small></span></label><label><input type="radio" name={`interval-mode-${channel.id}`} checked={intervalMode==='custom'} onChange={()=>{setIntervalMode('custom');if(!intervalTouched)setIntervalValue(String(Math.max(Number(intervalValue)||0,intervalInfo?.floorSeconds||3)))}}/><span><strong>더 길게 직접 설정</strong><small>직접 설정한 주기와 감지·보정한 최소 주기 중 긴 값을 적용합니다.</small></span></label></fieldset>{intervalMode==='custom'&&<div className="interval-custom"><label htmlFor={`interval-${channel.id}`}>직접 설정할 주기 <small>최소 {intervalInfo?.floorSeconds}초</small></label><div className="inline-form"><input id={`interval-${channel.id}`} type="number" step="1" min={intervalInfo?.floorSeconds||3} max="86400" value={intervalValue} onChange={e=>{setIntervalValue(e.target.value);setIntervalTouched(true)}} aria-invalid={Boolean(intervalError)} aria-describedby={`interval-error-${channel.id}`}/><span>초</span></div>{intervalError&&<p id={`interval-error-${channel.id}`} className="interval-error" role="alert">{intervalError}</p>}</div>}<p className="interval-effective"><strong>현재 적용 주기 {intervalInfo?.effectiveSeconds}초</strong>{intervalInfo?.observed?<span>감지·보정 최소 {intervalInfo.correctedBaseSeconds}초와 직접 설정 주기 중 긴 값인 {intervalInfo.effectiveSeconds}초로 적용합니다.</span>:<span>슬로우 모드 0초로 확인된 상태가 아닙니다. 감지가 끝날 때까지 이전 제한 또는 기본 여유를 유지합니다.</span>}</p>{channel.intervalMode==='custom'&&channel.customIntervalMs!==undefined&&channel.customIntervalMs<channel.intervalMs&&<p className="secondary">직접 지정한 값은 {Math.ceil(channel.customIntervalMs/1000)}초입니다. 현재 슬로우 모드 기준이 더 길어 실제로는 {Math.ceil(channel.intervalMs/1000)}초를 적용하며, 제한이 낮아지면 직접 지정한 값 이상으로 조정합니다.</p>}<p className="secondary">슬로우 모드가 늘어나면 실제 주기도 최소 기준 이상으로 늘어납니다. 이미 입력한 편집 내용은 유지되며, 새 기준보다 짧으면 다시 저장할 수 없습니다.</p>{channel.pendingIntervalSync&&<p className="interval-sync" role="status">진행 중인 발송 결과 확인 후 새 주기를 확장에 전달합니다. 아직 적용 완료로 판단하지 마세요.</p>}<button className="outline" disabled={busy||Boolean(intervalError)||!intervalChanged} onClick={()=>void saveInterval()}>주기 저장</button><div className="editor-actions"><button className="primary" disabled={busy||!draft.length} onClick={apply}>메시지 목록 저장</button></div></>:<Empty title="채널을 선택하세요" description="채널을 선택하면 현재 적용 상태와 메시지 목록을 편집할 수 있습니다."/>}</div></div>:<Empty icon="#" title="이 채널에 연결된 계정이 없습니다" description="위에서 등록 계정을 선택해 연결을 요청한 뒤 실제 채널 검증을 기다리세요." action={<button className="outline" onClick={()=>go('connections')}>계정 등록 보기 →</button>}/>}</Section></>
}

function Groups({s,run,busy,go,registerGuard,diagnostic=false}:Common) {
  const [selected,setSelected]=useState<string|null>(null),[creating,setCreating]=useState(false)
  const [name,setName]=useState(''),[members,setMembers]=useState<string[]>([]),[interval,setIntervalValue]=useState('20'),[target,setTarget]=useState('')
  // 체크 선택은 이번 실행 대상이며, 활성 설정은 서버에 영구 보존됩니다.
  const [checked,setChecked]=useState<string[]>([])
  const selectedGroups=s.groups.filter(g=>checked.includes(g.id))
  const selectionBlockers=allRunBlockers({...s,groups:selectedGroups})
  const group=s.groups.find(g=>g.id===selected)
  const [baseVersion,setBaseVersion]=useState<number|null>(null)
  const groupDraft=group&&baseVersion!==null?draftVersion(baseVersion,group.version):null
  const dirty=creating&&(name!==(group?.name||'')||members.join('|')!==(group?.members||[]).join('|')||interval!==String(Math.round((group?.intervalMs??20000)/1000))||target!==(group?`${group.guildId}:${group.channelId}`:''))
  useEffect(()=>{registerGuard?.(()=>!dirty||confirm('저장하지 않은 그룹 구성을 버리고 이동할까요?'));return()=>registerGuard?.(null)},[dirty,registerGuard])
  const canDiscard=()=>!dirty||confirm('저장하지 않은 그룹 구성을 버릴까요?')
  const open=(g?:Group)=>{if(!canDiscard())return;setSelected(g?.id||null);setBaseVersion(g?.version??null);setCreating(true);setName(g?.name||'');setMembers(g?.members||[]);setIntervalValue(String(Math.round((g?.intervalMs??20000)/1000)));setTarget(g?`${g.guildId}:${g.channelId}`:'')}
  const targets=Array.from(new Set(s.channels.map(c=>`${c.guildId}:${c.channelId}`)))
  const candidates=s.channels.filter(c=>`${c.guildId}:${c.channelId}`===target)
  const move=(from:number,to:number)=>setMembers(items=>{const next=[...items];next.splice(to,0,next.splice(from,1)[0]);return next})
  const save=async()=>{if(!name.trim()||!target||!members.length||Number(interval)<1)return;if(selected&&!group)return;const action=group?'group.update':'group.create';const ok=await run(action,group?{id:group.id,expectedVersion:draftVersion(baseVersion,group.version).expectedVersion,name:name.trim(),members,intervalMs:Number(interval)*1000}:{name:name.trim(),members,intervalMs:Number(interval)*1000},'그룹 구성을 저장했습니다. 실행 시작은 별도로 선택해 주세요.');if(ok&&group&&baseVersion!==null)setBaseVersion(savedDraftVersion(baseVersion));if(ok&&!group)setCreating(false)}
  const blockers=group?groupBlockers(s,group):[]
  const serviceBlocked=Boolean(s.service?.status&&!['ready','resume_required','stopped'].includes(String(s.service.status)))
  const control=(g:Group,action:string)=>{const confirmations:Record<string,string>={start:'조건이 충족되면 첫 발송이 즉시 시작될 수 있습니다. 계정 순서와 문구를 확인했나요?',resume:'같은 차례에서 다시 시작할까요? 미확인 발송은 먼저 해결해야 합니다.'};if(confirmations[action]&&!confirm(confirmations[action]))return;void run(`group.${action}`,{id:g.id,expectedVersion:g.version},`${label(g.status)} 그룹에 ${action==='start'?'시작':action==='resume'?'재개':action==='pause'?'일시정지':'중지'} 요청을 보냈습니다. 실제 상태를 확인해 주세요.`)}
  return <><Heading eyebrow="SCHEDULE / 순서 관리" title="발송 그룹" description="한 Discord 채널에 참여하는 계정의 순서와 최소 간격을 관리합니다." action={<button className="primary" onClick={()=>open()}>＋ 새 그룹</button>}/><SetupProgress s={s} go={go}/><div className="groups-layout"><section className="panel groups-list"><div className="panel-head"><div><h2>그룹 목록</h2><p>총 {s.groups.length}개 · 활성 {s.groups.filter(g=>g.enabled!==false).length}개</p></div></div><div className="control-row"><button className="outline small" onClick={()=>setChecked(s.groups.filter(g=>g.enabled!==false).map(g=>g.id))}>활성 전체 선택</button><button className="outline small" onClick={()=>setChecked([])}>선택 해제</button><button className="primary small" disabled={busy||!selectedGroups.length||selectedGroups.some(g=>g.enabled===false)||selectionBlockers.length>0||serviceBlocked} title={selectionBlockers.join(' · ')} onClick={()=>{if(confirm(`선택한 ${selectedGroups.length}개 그룹을 실행할까요? 실제 Discord 메시지가 발송됩니다.`))void run('service.startAll',{groupIds:selectedGroups.map(g=>g.id)},'선택한 그룹의 실행 요청을 적용했습니다.')}}>선택 실행 ({selectedGroups.length})</button></div><p className="secondary">체크한 그룹만 선택 실행합니다. 상단 모두 실행은 활성 그룹 전체에 적용됩니다.</p>{s.groups.length?s.groups.map(g=>{const c=s.channels.find(c=>c.id===g.members[g.cursor%safeLength(g.members)]);return <div key={g.id}><div className="control-row"><label><input type="checkbox" aria-label={`${g.name} 실행 선택`} checked={checked.includes(g.id)} onChange={e=>setChecked(ids=>e.target.checked?[...ids,g.id]:ids.filter(id=>id!==g.id))}/> 실행 선택</label><label><input type="checkbox" aria-label={`${g.name} 활성`} checked={g.enabled!==false} disabled={busy} onChange={e=>void run('group.setEnabled',{id:g.id,expectedVersion:g.version,enabled:e.target.checked},e.target.checked?'그룹을 활성화했습니다. 실행은 별도로 선택하세요.':'그룹을 비활성화했습니다. 실행 중이면 중지를 요청합니다.')}/> 활성</label></div><button className={`group-card ${selected===g.id?'selected':''}`} key={g.id} onClick={()=>{if(!canDiscard())return;setSelected(g.id);setCreating(false)}}><span className="group-card-top"><strong>{g.name}</strong>{status(g.status)}</span><small>#{s.channels.find(x=>x.guildId===g.guildId&&x.channelId===g.channelId)?.name||short(g.channelId)} · 계정 {g.members.length}개</small><span className="group-card-bottom">다음 차례 <b>{account(c,s)}</b><span>→</span></span></button></div>}):<Empty icon="◉" title="그룹이 없습니다" description="같은 채널에 연결된 계정을 선택해 순서를 만드세요." action={<button className="outline" onClick={()=>open()}>그룹 만들기</button>}/>}</section><section className="panel group-editor">{creating?<><div className="panel-head"><div><h2>{group?'그룹 구성 편집':'새 그룹 만들기'}</h2><p>대상 채널 → 계정 순서 → 최소 간격 → 저장</p></div><button className="icon-button" onClick={()=>{if(canDiscard())setCreating(false)}} aria-label="편집 닫기">×</button></div>{groupDraft?.externalChanged&&<div className="draft-warning" role="alert"><strong>다른 화면에서 그룹 구성이 변경됐습니다.</strong><span>현재 편집 내용은 유지됩니다. 저장 시 원래 버전으로 검사합니다.</span><button className="outline small" onClick={()=>open(group)}>최신 구성 다시 불러오기</button></div>}{selected&&!group&&<div className="draft-warning" role="alert">그룹이 다른 화면에서 삭제됐습니다. 현재 편집은 저장할 수 없습니다.</div>}<div className="editor-fields"><label>그룹 이름<input value={name} maxLength={100} onChange={e=>setName(e.target.value)} placeholder="예: 모집방 순환"/></label><label>대상 Discord 채널<select value={target} disabled={!!group} onChange={e=>{setTarget(e.target.value);setMembers([])}}><option value="">채널 선택</option>{targets.map(t=>{const c=s.channels.find(x=>`${x.guildId}:${x.channelId}`===t);return <option value={t} key={t}>#{c?.name||short(t)} · 서버 {short(c?.guildId)}</option>})}</select></label>{!targets.length&&<div className="editor-note">연결된 채널이 없습니다. 채널을 추가하고 등록 계정을 연결해 주세요. <button className="text-action" onClick={()=>go('channels')}>채널 보기 →</button></div>}<div className="subheading"><h3>계정 차례</h3><span>{members.length}개 참여</span></div><p className="secondary">같은 채널에 연결된 계정만 선택할 수 있습니다. 위·아래 버튼으로 순서를 바꿉니다.</p>{members.map((id,i)=>{const c=s.channels.find(x=>x.id===id);return <div className="playlist-item" key={id}><span className="order-number">{i+1}</span><div><strong>{account(c,s)} · {c?.name||'채널 확인 필요'}</strong><small>{s.instances.find(x=>x.id===c?.instanceId)?.name||'브라우저'} · 메시지 {c?.playlist.length||0}개 · {c?.verified?'검증됨':'검증 필요'}</small></div><button disabled={i===0} onClick={()=>move(i,i-1)} aria-label="위로">↑</button><button disabled={i===members.length-1} onClick={()=>move(i,i+1)} aria-label="아래로">↓</button><button onClick={()=>setMembers(x=>x.filter(v=>v!==id))} aria-label="참여 제거">×</button></div>})}<select aria-label="계정 추가" value="" onChange={e=>{if(e.target.value)setMembers(x=>[...x,e.target.value])}}><option value="">＋ 연결 계정 추가</option>{candidates.filter(c=>!members.includes(c.id)).map(c=><option value={c.id} key={c.id}>{account(c,s)} · {s.instances.find(i=>i.id===c.instanceId)?.name||short(c.instanceId)}{!c.playlist.length?' · 메시지 미적용':''}</option>)}</select><label>그룹 최소 간격 <small>발송 처리 후 대기 · 입력 준비와 전송 지연은 추가</small><div className="inline-form"><input type="number" min="1" value={interval} onChange={e=>setIntervalValue(e.target.value)}/><span>초</span></div></label><div className="editor-note">ⓘ 저장만으로 발송하지 않습니다. 시작 전 연결, 적용 문구, 순서, 대기 조건을 다시 확인하세요.</div><button className="primary" disabled={busy||!name.trim()||!target||!members.length||Number(interval)<1||!!selected&&!group||!!group&&group.status!=='stopped'&&group.status!=='paused'} onClick={()=>void save()}>그룹 구성 저장</button>{group&&group.status!=='stopped'&&group.status!=='paused'&&<p className="secondary">실행 중인 그룹은 일시정지와 진행 시도 확인 후 편집할 수 있습니다.</p>}</div></>:group?<><div className="panel-head"><div><h2>{group.name}</h2><p>#{s.channels.find(c=>c.guildId===group.guildId&&c.channelId===group.channelId)?.name||short(group.channelId)} · 최소 간격 {Math.round(group.intervalMs/1000)}초</p></div>{status(group.status)}</div>{diagnostic&&group.waitReason&&<div className="callout warning"><b>현재 대기 이유</b><span>{waitReasonText(group.waitReason)}</span></div>}{diagnostic&&group.activeAttemptId&&<div className="callout warning"><b>진행 중 시도</b><span>{short(group.activeAttemptId)} · 결과가 확정되기 전에는 차례를 넘기지 않습니다.</span></div>}<div className="group-readiness" role="status">{diagnostic&&serviceBlocked?<p>서비스 상태를 확인하세요: {label(String(s.service?.status))} <button className="text-action" onClick={()=>go('logs')}>문제 확인 →</button></p>:null}<strong>{blockers.length?'실행 전 남은 준비 항목':'현재 계정·메시지 준비 확인됨'}</strong>{!diagnostic&&(blockers.length>0||serviceBlocked)?<p>{operationSummary(s).kind==='blocked'?operationSummary(s).description:'현재 연결·메시지 설정 또는 작업 상태가 시작 조건을 충족하지 않습니다.'}</p>:blockers.length?<><ul>{blockers.map(reason=><li key={reason}>{reason}</li>)}</ul><button className="text-action" onClick={()=>go(registeredAccounts(s).some(a=>accountReady(s,a))?'channels':'connections')}>연결·메시지 설정 확인 →</button></>:<p>시작하면 실제 발송할 수 있습니다. 서버에서 실행 조건을 다시 검사합니다.</p>}</div><div className="subheading"><h3>계정 순서</h3><span>다음 차례 {group.members.length?group.cursor%group.members.length+1:0} / {group.members.length}</span></div><div className="member-steps">{group.members.map((id,i)=>{const c=s.channels.find(x=>x.id===id);const message=s.messages.find(m=>m.id===c?.playlist[c.playlistIndex%safeLength(c.playlist)]?.messageId);return <div className={`member-step ${i===group.cursor%safeLength(group.members)?'next':''}`} key={id}><span>{i+1}</span><div><strong>{account(c,s)} <small>· {s.instances.find(x=>x.id===c?.instanceId)?.name||'연결 확인 필요'}</small></strong><p>{message?`${message.name} · 적용본 ${c?.configVersion===c?.appliedVersion?'적용 완료':'확장 적용 대기'}`:'적용 메시지가 없습니다'}</p></div>{i===group.cursor%safeLength(group.members)&&<em>다음 차례</em>}</div>})}</div><p className="secondary"><GroupCountdown group={group} s={s}/></p><div className="control-row">{group.status==='stopped'&&<button className="primary" disabled={busy||blockers.length>0||serviceBlocked} title={[...blockers,...(serviceBlocked?['서비스 상태를 확인하세요.']:[])].join(' · ')} onClick={()=>control(group,'start')}>▶ 실행 전 확인 · 시작</button>}{['paused','resume_required'].includes(group.status)&&<button className="primary" disabled={busy||blockers.length>0||serviceBlocked} title={[...blockers,...(serviceBlocked?['서비스 상태를 확인하세요.']:[])].join(' · ')} onClick={()=>control(group,'resume')}>▶ 재개</button>}{group.status==='running'&&<button className="outline" onClick={()=>control(group,'pause')}>Ⅱ 일시정지</button>}{!['stopped','stop_pending'].includes(group.status)&&<button className="outline" onClick={()=>control(group,'stop')}>■ 중지</button>}<button className="outline" onClick={()=>open(group)} disabled={busy}>구성 편집</button>{group.status==='stopped'&&<button className="text-danger" disabled={busy||Boolean(group.activeAttemptId)} onClick={()=>{if(confirm(`${group.name} 그룹을 삭제할까요? 발송 기록은 유지됩니다.`))void run('group.delete',{id:group.id,expectedVersion:group.version}).then(ok=>{if(ok)setSelected(null)})}}>그룹 삭제</button>}{diagnostic&&(group.status==='needs_review'||s.attempts.some(a=>a.id===group.activeAttemptId&&a.status==='unknown'))&&<button className="outline" onClick={()=>go('history')}>이전 발송 결과 확인 →</button>}</div></>:<Empty icon="◉" title="그룹을 선택하세요" description="목록에서 그룹을 선택해 상태를 확인하거나 새 그룹을 만드세요." action={<button className="primary" onClick={()=>open()}>그룹 만들기</button>}/>}</section></div></>
}

function AttemptDiagnostics({attempt}:{attempt:Attempt}) {
  const evidence=attempt.deliveryEvidence
  if(!evidence&&attempt.status!=='unknown')return null
  return <section className="attempt-diagnostics" aria-label="입력·게시 관측 진단"><h3>Enter 요청 · 게시 관측</h3>{typeof evidence?.retryCount==='number'&&<p>재시도 {evidence.retryCount}회{typeof evidence.maxSendRetries==='number'?` / 당시 최대 ${evidence.maxSendRetries}회`:evidence.maxSendRetries===null?' · 중단 또는 오류까지 계속':' · 정책 기록 없음'} · 최초 요청 제외</p>}{attempt.status==='unknown'&&<p>{unknownDeliveryCause(attempt.reasonCode)}</p>}<p>{enterEvidenceText(evidence)}</p>{evidence&&<dl><dt>진행 단계</dt><dd>{evidence.phase?({prepare:'입력 준비',commit:'전송 허가',send:'전송 진행'} as Record<string,string>)[evidence.phase]||'기록 없음':'기록 없음'} · {evidence.stage?evidenceStages[evidence.stage]||'기록 없음':'상세 단계 기록 없음'}</dd>{evidenceFlags.filter(flag=>typeof evidence[flag.key]==='boolean').map(flag=><div className="diagnostic-pair" key={flag.key}><dt>{flag.label}</dt><dd>{evidence[flag.key]?'관측됨':'관측되지 않음'}</dd></div>)}</dl>}<small>진단은 확인 지점에서 관측한 사실입니다. 실제 게시 확정 상태와 구분해서 읽어 주세요. 미확인 시도는 실제 Discord 게시 내역을 확인하기 전까지 다시 보내지 마세요.</small></section>
}

function History({s,go,run,busy,retryNotSent,retryWaitingId,supportReport}:Common&RetryAction&{retryWaitingId:string|null}) {
  const [evidence,setEvidence]=useState('')
  const [query,setQuery]=useState(''),[filter,setFilter]=useState('all'),[detailId,setDetailId]=useState<string|null>(null)
  const history=useRetainedRecords<Attempt>('history',s.attempts,{query,status:filter})
  const [selected,setSelected]=useState<string[]>([])
  const detail=history.records.find(a=>a.id===detailId)||null
  const setDetail=(attempt:Attempt|null)=>{setDetailId(attempt?.id||null);setEvidence('')}
  const eligible=(a:Attempt)=>a.status==='unknown'&&a.executionBlocked===true
  useEffect(()=>{
    const eligibleIds=new Set(s.attempts.filter(a=>a.status==='unknown'&&a.executionBlocked===true).map(a=>a.id))
    setSelected(ids=>{const next=ids.filter(id=>eligibleIds.has(id));return next.length===ids.length?ids:next})
  },[s.attempts])
  const attempts=history.records.filter(a=>(filter==='all'||(a.status||a.state)===filter)&&`${a.id} ${a.accountId} ${accountLabel(s,a)} ${a.messageName} ${a.groupId} ${s.groups.find(g=>g.id===a.groupId)?.name||a.groupName||''}`.toLowerCase().includes(query.toLowerCase()))
  const visible=attempts
  const visibleEligible=visible.filter(eligible)
  const selectedIds=selected.filter(id=>s.attempts.some(a=>a.id===id&&eligible(a)))
  const allVisibleSelected=visibleEligible.length>0&&visibleEligible.every(a=>selectedIds.includes(a.id))
  const visibleSelectionSize=new Set([...selectedIds,...visibleEligible.map(a=>a.id)]).size
  const toggleVisible=()=>setSelected(ids=>allVisibleSelected?ids.filter(id=>!visibleEligible.some(a=>a.id===id)):selectEligibleIds(ids,visibleEligible.map(a=>a.id),200))
  const resolveNotSent=async(attempt:Attempt)=>{
    if(!eligible(attempt)||!confirm('실제 Discord 게시 내역을 직접 확인했으며 이 시도가 미발송임을 확인했나요? 실행 차단만으로 과거 미발송을 판단할 수 없습니다.'))return
    const ok=await run('attempt.resolve',{id:attempt.id,outcome:'not_sent'},'실제 미발송으로 확정했습니다. 자동 재발송하지 않습니다.')
    if(ok){history.reload();setSelected(ids=>ids.filter(id=>id!==attempt.id));if(detailId===attempt.id)setDetail(null)}
  }
  const resolveSelected=async()=>{
    const ids=[...selectedIds]
    if(!ids.length||ids.length>200||!confirm(`선택한 ${ids.length}건 모두의 실제 Discord 게시 내역을 직접 확인했으며 미발송임을 확인했나요? 현재 필터 밖에서 선택한 기록도 포함됩니다. 실행 차단만으로 과거 미발송을 판단할 수 없습니다.`))return
    const ok=await run('attempt.resolveMany',{ids,outcome:'not_sent',confirmation:'CONFIRM_NOT_SENT'},`${ids.length}건을 실제 미발송으로 확정했습니다. 자동 재발송하지 않습니다.`)
    if(ok){history.reload();setSelected([]);if(detailId&&ids.includes(detailId))setDetail(null)}
  }
  return <>
    <Heading eyebrow="DELIVERY / 발송 이력" title="실행 기록" description="입력창 비움으로 처리한 발송과 실제 게시 확인, 미확인 결과를 구분합니다." action={<SupportReportButton onOpen={supportReport} disabled={busy}/>}/>{retryWaitingId&&s.attempts.some(a=>a.id===retryWaitingId&&canRetryNotSent(a,s))&&<div className="callout warning" role="status"><b>중지 적용 확인 대기</b><span>{retryNotSentMessage('waiting')}</span><button className="primary small" onClick={()=>setDetail(s.attempts.find(a=>a.id===retryWaitingId)||null)}>해당 시도 상세 보기</button></div>}
    <Section title="발송 시도" subtitle="전송 요청 후 입력창이 비워지면 발송 처리로 집계합니다." action={<div className="filter-actions"><input aria-label="실행 기록 검색" value={query} onChange={e=>setQuery(e.target.value)} placeholder="계정·메시지·시도 검색"/><select aria-label="결과 필터" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">모든 결과</option><option value="confirmed">발송 처리 · 게시 확인</option><option value="unknown">미확인</option><option value="not_sent">확정 미발송</option></select></div>}>
      <div className="history-resolution">
        <div className="history-resolution-actions"><strong>현재 표시 중 확정 가능 {visibleEligible.length}건 · 전체 선택 {selectedIds.length} / 200건</strong><button className="outline small" disabled={busy||!visibleEligible.length||allVisibleSelected||visibleSelectionSize>200} title="현재 검색·필터에 표시된 확정 가능 기록만 선택합니다." onClick={()=>setSelected(ids=>selectEligibleIds(ids,visibleEligible.map(a=>a.id),200))}>전체 선택</button><button className="outline small" disabled={busy||!selectedIds.length} onClick={()=>setSelected([])}>전체 해제</button><button className="primary small" disabled={busy||!selectedIds.length||selectedIds.length>200} onClick={()=>void resolveSelected()}>선택 {selectedIds.length}건 실제 미발송</button></div>
        <p className="secondary">실제 Discord 게시 내역을 확인한 미확인 시도만 선택해 주세요. 실행 차단은 과거 미발송의 증거가 아닙니다. 전체 선택은 현재 검색·필터에 불러온 기록 중 확정 가능한 기록에만 적용됩니다. 필터를 바꿔도 선택은 유지되며 한 번에 최대 200건까지 확정할 수 있습니다.</p>
        <p className="secondary">실행 차단 확인 대기인 기록은 그룹 또는 전체 중지를 먼저 요청한 뒤 확장의 중지 적용 확인을 기다려 주세요. 미발송 확정 후에도 자동 재발송하지 않습니다.</p>
      </div>
      {attempts.length?<div className="table-scroll"><table><thead><tr><th><input type="checkbox" aria-label="현재 표시된 확정 가능 기록 전체 선택" checked={allVisibleSelected} ref={node=>{if(node)node.indeterminate=!allVisibleSelected&&visibleEligible.some(a=>selectedIds.includes(a.id))}} disabled={busy||!visibleEligible.length||!allVisibleSelected&&visibleSelectionSize>200} title={visibleSelectionSize>200&&!allVisibleSelected?'선택은 최대 200건입니다. 기존 선택을 해제해 주세요.':''} onChange={toggleVisible}/></th><th>발송 시도</th><th>그룹 · 채널</th><th>계정</th><th>문구</th><th>결과</th><th>처리 확인</th><th>결과 확인</th></tr></thead><tbody>{visible.map(a=><tr key={a.id}>
        <td>{a.status==='unknown'&&<input type="checkbox" aria-label={`${a.id} 미발송 확인 대상으로 선택`} checked={selectedIds.includes(a.id)} disabled={busy||!eligible(a)||!selectedIds.includes(a.id)&&selectedIds.length>=200} title={!eligible(a)?'실행 차단 확인 대기':undefined} onChange={e=>setSelected(ids=>e.target.checked?Array.from(new Set([...ids,a.id])).slice(0,200):ids.filter(id=>id!==a.id))}/>}</td>
        <td>{date(a.permittedAt||a.createdAt)}</td><td><strong>{s.groups.find(g=>g.id===a.groupId)?.name||a.groupName||short(a.groupId)}</strong><small>#{s.channels.find(c=>c.id===a.bindingId)?.name||a.channelName||short(a.channelId)}</small></td><td><strong>{accountLabel(s,a)}</strong><small>Discord ID {accountIdentity(s,a).accountId||'—'}</small></td><td>{a.messageName||s.messages.find(m=>m.id===a.messageIdRef)?.name||short(a.messageId)}</td><td>{status(a.status||a.state,attemptResultLabel(a))}{a.reasonCode&&<small>{reasonText(a.reasonCode)}</small>}{a.status==='unknown'&&!eligible(a)&&<small>실행 차단 확인 대기</small>}</td><td>{a.status==='confirmed'?date(a.finalizedAt):'—'}</td><td><div className="history-row-actions">{eligible(a)&&<button className="outline small" disabled={busy} onClick={()=>void resolveNotSent(a)}>실제 미발송</button>}<button className="text-action" onClick={()=>setDetail(a)}>상세</button></div></td>
      </tr>)}</tbody></table></div>:<Empty icon="◷" title="실행 기록이 없습니다" description="그룹이 실제로 발송을 시도하면 이곳에 기록됩니다." action={<button className="outline" onClick={()=>go('groups')}>그룹 보기 →</button>}/>}
      <div className="control-row"><small>보관 기간 {String(s.settings?.retentionDays||90)}일 · 현재 {visible.length}건 표시 · 건수에 따른 보관 제한 없음</small><button className="text-action" disabled={history.loading} onClick={history.reload}>최신부터 다시 조회</button>{history.error&&<span role="alert">{history.error}</span>}{(history.hasMore||history.error)&&<button className="outline small" disabled={history.loading} onClick={()=>void history.loadMore()}>이전 실행 기록 더 보기</button>}{history.loading&&<span role="status">기록 불러오는 중…</span>}</div>
    </Section>{detail&&<div className="modal-backdrop" onClick={()=>setDetail(null)}><div className="modal" role="dialog" aria-modal="true" tabIndex={0} autoFocus aria-label="발송 시도 상세" onClick={e=>e.stopPropagation()}><div className="panel-head"><div><h2>발송 시도 상세</h2><p>{short(detail.id)}</p></div><button className="icon-button" onClick={()=>setDetail(null)} aria-label="닫기">×</button></div><dl className="detail-list"><dt>결과</dt><dd>{status(detail.status||detail.state,attemptResultLabel(detail))}</dd><dt>시도 시각</dt><dd>{fullDate(detail.permittedAt||detail.createdAt)}</dd><dt>처리 확인 시각</dt><dd>{detail.status==='confirmed'?fullDate(detail.finalizedAt):'—'}</dd><dt>계정</dt><dd><strong>{accountLabel(s,detail)}</strong><small>Discord ID {accountIdentity(s,detail).accountId||'—'}</small></dd><dt>채널</dt><dd>#{s.channels.find(c=>c.id===detail.bindingId)?.name||detail.channelName||short(detail.channelId)}</dd><dt>메시지</dt><dd>{detail.messageName||s.messages.find(m=>m.id===detail.messageIdRef)?.name||short(detail.messageId)}</dd></dl>{confirmationBasisText(detail)&&<p className="editor-note">{confirmationBasisText(detail)}</p>}<AttemptMessageBody attempt={detail}/><div className="control-row"><SupportReportButton attemptId={detail.id} onOpen={supportReport} disabled={busy}/></div><AttemptDiagnostics attempt={detail}/>{canRetryNotSent(detail,s)&&<div className="resolution"><h3>확인 후 같은 계정에서 계속</h3><p className="secondary">해당 계정·채널의 실제 Discord 게시 내역을 확인하고 미발송일 때만 누르세요. 그룹의 현재 차례부터 다시 진행하며, 중지 적용 확인 대기 중이면 적용 뒤 다시 눌러야 합니다.</p><RetryNotSentButton key={detail.id} attempt={detail} s={s} busy={busy} retryNotSent={async id=>{const result=await retryNotSent(id);if(result)history.reload();return result}}/></div>}{exactRecordedBinding(s,detail)&&<div className="record-window-actions"><strong>해당 채널의 전송 창</strong><ChannelWindowActions s={s} channel={exactRecordedBinding(s,detail)!} run={run} busy={busy}/></div>}{detail.status==='unknown'&&<div className="callout warning"><b>발송 상태 복구 대기</b><span>프로그램이 동일 시도의 완료 기록을 자동 대조합니다. 이 과정에서는 메시지를 다시 보내지 않습니다. 확인 근거가 부족한 결과는 보존하며, 자동 제보가 켜져 있으면 진단을 전송합니다.</span></div>}{detail.status==='unknown'&&<div className="resolution"><h3>이전 기록 직접 정리 · 선택 사항</h3><p className="secondary">사유: {reasonText(detail.reasonCode)}</p><p className="secondary">게시 내역에서 확인한 Discord 메시지 ID를 입력해야 게시됨으로 확정할 수 있습니다.</p><input aria-label="게시 메시지 ID" value={evidence} onChange={e=>setEvidence(e.target.value)} placeholder="게시 메시지 ID"/><div className="control-row"><button className="outline small" disabled={busy||!evidence.trim()} onClick={()=>{if(confirm('실제 게시된 메시지 ID가 맞나요?'))void run('attempt.resolve',{id:detail.id,outcome:'confirmed',messageId:evidence.trim()}).then(ok=>{if(ok){history.reload();setDetail(null);setEvidence('')}})}}>실제 게시됨</button><button className="outline small" disabled={busy||!detail.executionBlocked} title={!detail.executionBlocked?'중지 요청의 실행 차단 확인을 먼저 기다려 주세요.':''} onClick={()=>void resolveNotSent(detail)}>실제 미발송</button></div>{!detail.executionBlocked&&<p className="secondary">실행 차단 확인 대기: 그룹 또는 전체 중지를 요청한 뒤 확장의 중지 적용 확인을 기다려 주세요. 실행 차단은 과거 미발송의 증거가 아니므로 실제 Discord 게시 내역도 확인해야 합니다.</p>}</div>}<button className="outline" onClick={()=>setDetail(null)}>닫기</button></div></div>}</>
}

type IncidentReview={resolved:number;remaining:number;blocked:{id:string;reasonCode:string;message:string;page?:Page}[]}
function Logs({s,analytics,analyticsStatus,analyticsAt,retryAnalytics,period,go,run,busy,refresh,retryNotSent,retryWaitingId,supportReport}:Common&RetryAction&{analytics:Record<string,unknown>|null;analyticsStatus:'loading'|'ready'|'error';analyticsAt:number;retryAnalytics:()=>void;period:string;refresh:()=>Promise<void>;retryWaitingId:string|null}) {
  const [review,setReview]=useState<IncidentReview|null>(null),[reviewing,setReviewing]=useState(false),[reviewError,setReviewError]=useState('')
  const recheck=async(id?:string)=>{
    if(reviewing)return
    setReviewing(true);setReviewError('')
    try{
      const response=await command('incident.recheck',id?{id}:{}) as {result:IncidentReview}
      setReview(response.result);await refresh()
    }catch(error){setReviewError(requestErrorMessage(error))}
    finally{setReviewing(false)}
  }

  const [tab,setTab]=useState<'incidents'|'analysis'|'events'>('incidents'),[query,setQuery]=useState(''),[level,setLevel]=useState('all'),[detail,setDetail]=useState<EventRecord|null>(null)
  const logTabs=['incidents','analysis','events'] as const
  const selectLogTab=(next:typeof logTabs[number])=>{if(next!==tab){setQuery('');setLevel('all')}if(next==='events'){setHeld(s.events);setNewCount(0)}setTab(next)}
  const moveLogTab=(event:React.KeyboardEvent<HTMLDivElement>)=>{if(!['ArrowRight','ArrowLeft','Home','End'].includes(event.key))return;event.preventDefault();const current=logTabs.indexOf(tab);const next=event.key==='Home'?0:event.key==='End'?logTabs.length-1:(current+(event.key==='ArrowRight'?1:-1)+logTabs.length)%logTabs.length;selectLogTab(logTabs[next]);event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()}
  const [includeResolved,setIncludeResolved]=useState(false)
  const [live,setLive]=useState(false),[held,setHeld]=useState<EventRecord[]>([]),[newCount,setNewCount]=useState(0)
  useEffect(()=>{if(tab!=='events')return;if(live||held.length===0){setHeld(s.events);setNewCount(0)}else{const last=held.at(-1)?.eventId||0;setNewCount(s.events.filter(e=>(e.eventId||0)>last).length)}},[tab,live,s.events])
  const incidents=visibleIncidents(s,includeResolved,query)
  const retainedLogs=useRetainedRecords<EventRecord>('logs',held,{query,level},tab==='events')
  const events=retainedLogs.records.filter(e=>matchesLogLevel(e.level,level)&&`${e.message} ${e.description} ${e.type} ${accountLabel(s,e)}`.toLowerCase().includes(query.toLowerCase()))
  const outcomes = analytics?.outcomes as Record<string,number>|undefined
  const distribution = outcomes?[{name:'게시 확인',count:outcomes.confirmed??0},{name:'미확인',count:outcomes.unknown??0},{name:'그 외',count:(outcomes.not_sent||0)+(outcomes.cancelled||0)+(outcomes.in_progress||0)}]:[]
  const max=Math.max(1,...distribution.map(x=>x.count))
  const waits=Array.isArray(analytics?.waitReasons)?analytics.waitReasons as {reason:string;durationMs:number}[]:[]
  const timeline=Array.isArray(analytics?.timeline)?analytics.timeline as Attempt[]:[]
  const waitMax=Math.max(1,...waits.map(x=>x.durationMs))
  return <><Heading eyebrow="INSIGHTS / 기록과 분석" title="로그 · 분석" description="현재 문제를 먼저 확인하고, 같은 사건의 기록과 집계를 살펴보세요." action={<SupportReportButton onOpen={supportReport} disabled={busy}/>}/><PendingTabCloses s={s}/>{retryWaitingId&&s.attempts.some(a=>a.id===retryWaitingId&&canRetryNotSent(a,s))&&<div className="callout warning" role="status"><b>중지 적용 확인 대기</b><span>{retryNotSentMessage('waiting')}</span><button className="primary small" onClick={()=>go('history')}>실행 기록에서 계속 →</button></div>}<div className="tabbar" role="tablist" aria-label="로그 화면" onKeyDown={moveLogTab}><button id="logs-tab-incidents" role="tab" aria-controls="logs-panel-incidents" tabIndex={tab==='incidents'?0:-1} aria-selected={tab==='incidents'} className={tab==='incidents'?'active':''} onClick={()=>selectLogTab('incidents')}>현재 문제 <span>{s.incidents.filter(isIncidentOpen).length}</span></button><button id="logs-tab-analysis" role="tab" aria-controls="logs-panel-analysis" tabIndex={tab==='analysis'?0:-1} aria-selected={tab==='analysis'} className={tab==='analysis'?'active':''} onClick={()=>selectLogTab('analysis')}>분석</button><button id="logs-tab-events" role="tab" aria-controls="logs-panel-events" tabIndex={tab==='events'?0:-1} aria-selected={tab==='events'} className={tab==='events'?'active':''} onClick={()=>selectLogTab('events')}>전체 로그</button></div>{tab==='incidents'&&<div role="tabpanel" id="logs-panel-incidents" aria-labelledby="logs-tab-incidents" tabIndex={0}><div className="incident-recovery"><div><strong>지난 오류가 계속 남아 있나요?</strong><p>현재 실행 결과와 그룹 상태를 다시 검사해 해결된 기록을 정리합니다. 읽음 표시와 다르며, 미확인 발송을 임의로 확정하거나 그룹을 실행하지 않습니다.</p></div><button className="primary" disabled={busy||reviewing||!s.incidents.some(isIncidentOpen)} onClick={()=>void recheck()}>{reviewing?'해결 상태 확인 중…':'미해결 알림 한 번에 재검사'}</button>{review&&<div className="incident-recheck-result" role="status"><strong>이번 검사에서 {review.resolved}건 해결 · 검사 대상 중 {review.remaining}건 확인 필요</strong>{review.blocked.length>0&&<ul>{review.blocked.map(block=><li key={block.id}>{block.message}{block.page&&navigation.some(n=>n.id===block.page)&&<button className="text-action" onClick={()=>go(block.page!)}>관련 화면 →</button>}</li>)}</ul>}</div>}{reviewError&&<p className="import-error" role="alert">{reviewError}</p>}</div><Section title="문제 · 알림" subtitle={`현재 미해결 ${s.incidents.filter(isIncidentOpen).length}건 · 복구가 확인된 문제는 자동으로 해결 처리됩니다.`} action={<div className="incident-filters"><label className="checkline"><input type="checkbox" checked={includeResolved} onChange={e=>setIncludeResolved(e.target.checked)}/> 해결된 기록 포함</label><input aria-label="문제 검색" value={query} onChange={e=>setQuery(e.target.value)} placeholder="문제·브라우저·사유 검색"/></div>}>{incidents.length?<div className="incident-list">{incidents.map(i=>{const advice=incidentAdvice(i,s);return <article className="incident-row incident-advice-row" key={i.id}><span className={`alert-symbol ${isIncidentOpen(i)?'':'resolved'}`}>{isIncidentOpen(i)?'!':'✓'}</span><div className="incident-advice"><strong>{advice.title}</strong><p className="incident-cause">{advice.cause}</p>{!isIncidentOpen(i)&&typeof i.resolutionReason==='string'&&<p className="incident-resolution">정리 사유: {({terminal_attempt:'이미 확정된 발송 결과를 확인했습니다.',obsolete_group:'삭제된 이전 그룹의 지난 요청입니다.',control_applied:'현재 중지·일시정지 적용 응답을 모두 확인했습니다.',window_action_applied:'같은 계정·채널의 전송 창 요청 적용을 확인했습니다.',connection_reverified:'같은 브라우저·계정·채널의 정상 연결을 다시 확인했습니다.'} as Record<string,string>)[String(i.resolutionReason)]||'현재 상태를 다시 확인했습니다.'}</p>}{advice.affected.length>0&&<ul className="incident-affected" aria-label="영향받은 대상">{advice.affected.map(affected=><li key={affected}>{affected}</li>)}</ul>}{isIncidentOpen(i)&&<details className="incident-help"><summary>직접 확인이 필요한 경우</summary><ol className="incident-steps">{advice.steps.map(step=><li key={step}>{step}</li>)}</ol></details>}<small className="incident-state">{date(i.createdAt||i.updatedAt)} · <b>{incidentState(i)}</b>{i.resolvedAt&&<> · 해결 시각 {date(i.resolvedAt)}</>}</small><details className="incident-technical"><summary>기록 식별 정보</summary><dl><dt>문제 종류</dt><dd>{i.code||'정보 없음'}</dd><dt>요청 종류</dt><dd>{advice.commandType||'기록 없음'}</dd><dt>거절 사유 코드</dt><dd>{advice.rejectionCode||'기록 없음'}</dd></dl></details><div className="incident-actions"><SupportReportButton attemptId={i.attemptId} onOpen={supportReport} disabled={busy}/>{isIncidentOpen(i)&&i.code==='delivery_unknown'&&s.attempts.some(a=>a.id===i.attemptId&&canRetryNotSent(a,s))&&<RetryNotSentButton key={i.attemptId} attempt={s.attempts.find(a=>a.id===i.attemptId)!} s={s} busy={busy||reviewing} retryNotSent={retryNotSent}/>}{isIncidentOpen(i)&&<button className="outline small" disabled={busy||reviewing} onClick={()=>void recheck(i.id)}>해결 상태 재검사</button>}<button className="outline small" onClick={()=>go(advice.page)}>{advice.actionLabel} →</button>{exactRecordedBinding(s,i)&&<ChannelWindowActions s={s} channel={exactRecordedBinding(s,i)!} run={run} busy={busy}/>} {i.attemptId&&advice.page!=='history'&&<button className="text-action" onClick={()=>go('history')}>관련 실행 기록 →</button>}{!i.readAt&&!i.read&&<button className="text-action" disabled={busy} onClick={()=>void run('incident.read',{id:i.id},'읽음으로 표시했습니다. 미해결 상태와 실행 차단은 유지됩니다.')}>읽음으로 표시</button>}</div></div></article>})}</div>:<Empty icon="✓" title={query?'검색 조건에 맞는 문제가 없습니다':includeResolved?'기록된 문제가 없습니다':'현재 미해결 문제가 없습니다'} description={query?'검색어나 해결된 기록 포함 여부를 바꿔 보세요.':'해결된 기록 포함을 켜면 지난 문제를 확인할 수 있습니다. 읽음으로 표시한 문제도 해결 전까지 현재 목록에 남습니다.'}/>}</Section></div>}{tab==='analysis'&&<div role="tabpanel" id="logs-panel-analysis" aria-labelledby="logs-tab-analysis" tabIndex={0}>{analyticsStatus==='error'&&<div className="callout warning" role="status"><b>선택 기간 집계 갱신에 실패했습니다.</b><span>{analytics?`${date(analyticsAt)}에 받은 이전 결과를 표시합니다.`:'기간 집계를 확인할 수 없습니다.'}</span><button className="outline small" onClick={retryAnalytics}>집계 다시 확인</button></div>}{analyticsStatus==='loading'&&!analytics&&<p className="chart-note" role="status">{period==='1h'?'최근 1시간':period==='7d'?'최근 7일':'최근 24시간'} 집계를 불러오는 중입니다.</p>}{analytics&&<div className="analysis-grid"><Section title="시도 결과 분포" subtitle="선택 기간 · 고유 발송 시도의 현재 결과" action={<button className="text-action" onClick={()=>go('history')}>원본 기록 →</button>}><div className="hbars">{distribution.length?distribution.map(d=><button key={d.name} onClick={()=>go('history')}><span>{d.name}</span><span className="hbar-track"><i style={{width:`${d.count/max*100}%`}}/></span><strong>{d.count}건</strong></button>):<p className="secondary">선택 기간 결과 분포가 제공되지 않았습니다.</p>}</div><p className="chart-note">발송 처리 건수와 시도 수는 기준 시각이 달라 기간별 합계가 다를 수 있습니다.</p></Section><Section title="서비스 집계" subtitle="서버가 제공한 분석 값"><div className="aggregate-list">{([['total','기간 내 발송 시도','건'],['confirmed','기간 내 발송 처리','건'],['excludedFromRate','확정 비율 제외 시도','건']] as const).filter(([key])=>typeof analytics[key]==='number').map(([key,title,unit])=><div key={key}><span>{title}</span><strong>{Number(analytics[key])}{unit}</strong></div>)}{typeof analytics.confirmationRate==='number'&&<div><span>확정 시도 중 발송 처리 비율</span><strong>{Math.round(analytics.confirmationRate*100)}%</strong></div>}{analytics.partialRecords===true&&<p className="secondary">보존 기간 이전 기록은 집계에 포함되지 않을 수 있습니다.</p>}</div></Section><Section title="대기 원인" subtitle="그룹·초 기준 · 의도된 대기와 장애를 구분합니다."><div className="hbars">{waits.length?waits.map(w=><div className="wait-row" key={w.reason}><span title={w.reason}>{waitReasonText(w.reason)===w.reason?'기타 대기':waitReasonText(w.reason)}</span><span className="hbar-track"><i style={{width:`${w.durationMs/waitMax*100}%`}}/></span><strong>{Math.round(w.durationMs/1000)}초</strong></div>):<p className="secondary">측정된 대기 구간이 없습니다.</p>}</div><details className="chart-table"><summary>표로 보기</summary><table><thead><tr><th>대기 원인</th><th>누적 그룹·초</th></tr></thead><tbody>{waits.map(w=><tr key={w.reason}><td>{waitReasonText(w.reason)===w.reason?'기타 대기':waitReasonText(w.reason)}</td><td>{Math.round(w.durationMs/1000)}</td></tr>)}</tbody></table></details></Section><Section title="계정별 진행" subtitle="최근 발송 시도 순서와 결과" action={<button className="text-action" onClick={()=>go('history')}>원본 기록 →</button>}><div className="timeline-list">{timeline.length?[...timeline].slice(-12).reverse().map(a=><div key={a.id}><span className="activity-dot"/><strong title={`Discord ID ${accountIdentity(s,a).accountId||'—'}`}>{accountLabel(s,a)}<small>{accountIdentity(s,a).accountId||'—'}</small></strong><span>{s.groups.find(g=>g.id===a.groupId)?.name||a.groupName||short(a.groupId)}</span>{status(a.status,attemptResultLabel(a))}<small>{date(a.permittedAt||a.createdAt)}</small></div>):<p className="secondary">아직 발송 시도가 없습니다.</p>}</div></Section></div>}</div>}{tab==='events'&&<div role="tabpanel" id="logs-panel-events" aria-labelledby="logs-tab-events" tabIndex={0}><Section title="전체 로그" subtitle="설정한 보관 기간의 모든 로그를 조회할 수 있습니다. 민감한 본문은 표시하지 않습니다." action={<div className="filter-actions"><button className="outline small" onClick={()=>{setLive(!live);setHeld(s.events);setNewCount(0)}}>{live?'실시간 보기 켜짐':`실시간 보기 ${newCount?`· 새 로그 ${newCount}개`:'꺼짐'}`}</button><input aria-label="로그 검색" value={query} onChange={e=>setQuery(e.target.value)} placeholder="설명·종류 검색"/><select aria-label="레벨 필터" value={level} onChange={e=>setLevel(e.target.value)}><option value="all">모든 레벨</option>{['DEBUG','INFO','WARN','ERROR','CRITICAL'].map(x=><option key={x}>{x}</option>)}</select></div>}>{events.length?<div className="table-scroll"><table><thead><tr><th>수신 시각</th><th>레벨</th><th>종류</th><th>계정</th><th>설명</th><th></th></tr></thead><tbody>{events.map((e,i)=><tr key={e.eventId||e.id||i}><td>{date(e.receivedAt||e.at||e.createdAt)}</td><td><span className={`level ${e.level||''}`}>{e.level||'INFO'}</span></td><td>{e.type||'상태 변경'}</td><td>{accountIdentity(s,e).accountId?<><strong>{accountLabel(s,e)}</strong><small>{accountIdentity(s,e).accountId}</small></>:'—'}</td><td>{eventText(e)}</td><td><button className="text-action" onClick={()=>setDetail(e)}>상세</button></td></tr>)}</tbody></table></div>:<Empty icon="▥" title="표시할 로그가 없습니다" description="이벤트가 기록되면 여기에서 확인할 수 있습니다."/>}<div className="control-row"><small>보관 기간 {String(s.settings?.retentionDays||90)}일 · 현재 {events.length}건 표시 · 건수에 따른 보관 제한 없음</small><button className="text-action" disabled={retainedLogs.loading} onClick={retainedLogs.reload}>최신부터 다시 조회</button>{retainedLogs.error&&<span role="alert">{retainedLogs.error}</span>}{(retainedLogs.hasMore||retainedLogs.error)&&<button className="outline small" disabled={retainedLogs.loading} onClick={()=>void retainedLogs.loadMore()}>이전 로그 더 보기</button>}{retainedLogs.loading&&<span role="status">로그 불러오는 중…</span>}</div></Section></div>}{detail&&<div className="modal-backdrop" onClick={()=>setDetail(null)}><div className="modal" role="dialog" aria-modal="true" tabIndex={0} autoFocus aria-label="로그 상세" onClick={e=>e.stopPropagation()}><div className="panel-head"><h2>로그 상세</h2><button className="icon-button" onClick={()=>setDetail(null)} aria-label="닫기">×</button></div><dl className="detail-list"><dt>시각</dt><dd>{fullDate(detail.receivedAt||detail.at||detail.createdAt)}</dd><dt>레벨 · 종류</dt><dd>{detail.level||'INFO'} · {detail.type||'—'}</dd><dt>설명</dt><dd>{eventText(detail)}</dd><dt>그룹</dt><dd>{s.groups.find(g=>g.id===detail.groupId)?.name||short(detail.groupId)}</dd><dt>계정</dt><dd>{accountLabel(s,detail)}{accountIdentity(s,detail).accountId&&<small>Discord ID {accountIdentity(s,detail).accountId}</small>}</dd><dt>시도</dt><dd>{short(detail.attemptId)}</dd></dl>{detail.attemptId&&<AttemptMessageLookup key={detail.attemptId} attemptId={detail.attemptId} attempt={s.attempts.find(attempt=>attempt.id===detail.attemptId)}/>}<div className="control-row"><SupportReportButton attemptId={detail.attemptId} onOpen={supportReport} disabled={busy}/></div>{exactRecordedBinding(s,detail)&&<div className="record-window-actions"><strong>해당 채널의 전송 창</strong><ChannelWindowActions s={s} channel={exactRecordedBinding(s,detail)!} run={run} busy={busy}/></div>}<button className="outline" onClick={()=>setDetail(null)}>닫기</button></div></div>}</>
}

function SetupDiagnostics() {
  const [result,setResult]=useState<SetupStatus|null>(null)
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const generation=useRef(0)
  const refresh=useCallback(async()=>{
    const current=++generation.current
    setLoading(true);setError('')
    try {
      const response=await getSetupStatus()
      if(current===generation.current)setResult(response)
    } catch(e) {
      if(current===generation.current)setError(requestErrorMessage(e))
    } finally {
      if(current===generation.current)setLoading(false)
    }
  },[])
  useEffect(()=>{void refresh();return ()=>{generation.current++}},[refresh])
  const statusLabel={ok:'정상',warning:'확인 필요',error:'문제 있음'}
  return <Section title="설치 · 연결 진단" subtitle="현재 PC의 실행 환경과 브라우저 연결 상태를 확인합니다." action={<button className="outline small" disabled={loading} onClick={()=>void refresh()}>{loading?'확인 중…':'다시 확인'}</button>}>
    <div className="setup-summary" aria-live="polite" aria-busy={loading}>
      {loading&&<p>설치 상태를 확인하고 있습니다.</p>}
      {error&&<p className="import-error" role="alert">진단을 불러오지 못했습니다. {error} 다시 확인을 눌러 재시도해 주세요.</p>}
      {result&&<p>{error?'이전 진단 결과':result.ready?'실행 환경 준비 완료':'아래 항목을 확인해 주세요'} · {fullDate(result.checkedAt)}</p>}
    </div>
    {result&&<div className="setup-checks">{result.checks.map(check=><div className="setup-check" key={check.id}>
      <div className="setup-check-title"><strong>{check.label}</strong><span className={`setup-status ${check.status}`}>{statusLabel[check.status]}</span></div>
      <p>{check.detail}</p>{check.nextStep&&<p className="setup-next-step">다음 단계: {check.nextStep}</p>}
    </div>)}</div>}
    <div className="editor-note">Git · npm · C++ 빌드 도구는 소스에서 직접 빌드할 때만 필요합니다. 패키지로 설치한 프로그램 실행에는 필요하지 않습니다.<br/>확장 설치를 위한 브라우저 개발자 모드 켜기와 기존 확장 중지는 브라우저에서 직접 진행해 주세요.</div>
  </Section>
}

function Settings({s,run,busy,go,notify,appVersion,draftStatus,registerGuard,accessMode}:Common&{accessMode:AccessMode|null;notify:()=>Promise<void>;appVersion?:string;draftStatus:{current:boolean}}) {
  const [appearance,showAppearance]=useState(getAppearance)
  useEffect(()=>subscribeAppearance(()=>showAppearance(getAppearance())),[])
  const [draft,setDraft]=useState(()=>createSettingsDraft(s.settings))
  const synced=syncSettingsDraft(draft,s.settings)
  if(synced!==draft)setDraft(synced)
  const preferences=synced?.values
  const retention=preferences?String(preferences.retentionDays):''
  const notificationsEnabled=preferences?.notificationsEnabled??false,hideNames=preferences?.hideNotificationNames??false
  const notificationChanges=settingsPayload(synced,'notifications'),retentionChanges=settingsPayload(synced,'retention')
  draftStatus.current=settingsDirty(synced)
  useEffect(()=>{registerGuard?.(()=>!settingsDirty(synced)||confirm('저장하지 않은 설정 변경을 버리고 이동할까요?'));return()=>registerGuard?.(null)},[synced,registerGuard])
  useEffect(()=>()=>{draftStatus.current=false},[draftStatus])
  const [importFile,setImportFile]=useState<{name:string;data:Record<string,unknown>}|null>(null)
  const [importError,setImportError]=useState('')
  const steps=setupSteps(s)
  const fileSelected=async(file?:File)=>{
    setImportError('');setImportFile(null)
    if(!file)return
    try {
      if(file.size>2*1024*1024)throw Error('2MB 이하의 JSON 백업을 선택해 주세요.')
      const data=JSON.parse(await file.text())
      if(!data||typeof data!=='object'||!['dico-central-backup','dico-settings'].includes(data.format))throw Error('지원하는 DICO 백업 형식이 아닙니다.')
      setImportFile({name:file.name,data})
    } catch(e) {setImportError(e instanceof Error?e.message:'백업 파일을 읽지 못했습니다.')}
  }
  const restore=async()=>{
    if(!importFile)return
    const legacy=importFile.data.format==='dico-settings'
    const text=legacy?'기존 A/B 설정에서 메시지와 그룹을 가져올까요? 결과는 중지 상태이며, 브라우저와 채널은 다시 검증해야 합니다.':'현재 메시지·채널·그룹 설정을 백업 내용으로 교체할까요? 모든 그룹은 중지되고 연결을 다시 확인해야 합니다.'
    if(!confirm(text))return
    const ok=await run(legacy?'legacy.import':'backup.import',{backup:importFile.data},legacy?'기존 설정을 가져왔습니다. 연결과 적용 상태를 다시 확인해 주세요.':'백업을 복원했습니다. 그룹은 중지 상태입니다.')
    if(ok)setImportFile(null)
  }
  return <><Heading eyebrow="PREFERENCES / 도움말" title="설정 · 도움말" description="처음 시작하는 방법과 로컬 작업 공간의 설정을 확인하세요."/>
    <div className="settings-grid"><div className="settings-main"><UpdatePanel s={s} busy={busy} go={go} appVersion={appVersion}/><LanAccessPanel mode={accessMode} busy={busy}/>{accessMode==='local'&&<details><summary>고급: SSH 터널로 접속</summary><RemoteAccessGuide busy={busy}/></details>}<Section title="시작 가이드" subtitle={`${steps.filter(x=>x.done).length} / ${steps.length}단계 완료 · 실제 저장과 연결 상태 기준`}>
      <div className="guide-list">{steps.map((step,i)=><div className="guide-step" key={step.title}><span className={step.done?'done':''}>{step.done?'✓':i+1}</span><div><strong>{step.title}</strong><p>{step.description}</p></div><button className="text-action" onClick={()=>go(step.page)}>{step.done?'다시 보기':'설정하기'} →</button></div>)}</div>
      <div className="editor-note">ⓘ 설정을 마쳐도 자동으로 시험 메시지를 보내지 않습니다. 발송은 그룹에서 명시적으로 시작합니다.</div>
    </Section></div><div className="settings-side"><Section title="화면 모드" subtitle="이 브라우저에 자동으로 저장됩니다."><div className="setting-row"><div><strong>테마</strong><p>시스템 설정을 선택하면 운영체제의 화면 모드를 따릅니다.</p></div><select aria-label="화면 모드" value={appearance} onChange={e=>setAppearance(e.target.value as Appearance)}><option value="system">시스템 설정</option><option value="light">라이트</option><option value="dark">다크</option></select></div></Section><Section title="알림" subtitle="OS 알림과 화면의 작업 상태 안내는 별도로 동작합니다.">
      <div className="setting-row"><div><strong>OS 문제 알림</strong><p>관리 프로그램에서 확인이 필요한 문제를 알립니다.</p></div><label className="switch-label"><input type="checkbox" disabled={!preferences} checked={notificationsEnabled} onChange={e=>setDraft(d=>editSettingsDraft(d,'notificationsEnabled',e.target.checked))}/> 켬</label></div>
      <div className="setting-row"><div><strong>알림에서 이름 숨기기</strong><p>메시지 본문과 연결 키는 표시하지 않습니다.</p></div><label className="switch-label"><input type="checkbox" disabled={!preferences} checked={hideNames} onChange={e=>setDraft(d=>editSettingsDraft(d,'hideNotificationNames',e.target.checked))}/> 숨김</label></div>
      <div className="setting-row"><div><strong>테스트 알림</strong><p>Discord에는 메시지를 보내지 않습니다.</p></div><button className="outline small" onClick={()=>void notify()}>테스트 요청</button></div>
      <div className="setting-row"><div><strong>화면 알림</strong><p>완료하지 못한 작업은 상단 알림 센터에 계속 표시됩니다.</p></div><span>{operationSummary(s).title}</span></div>
      <button className="outline small" disabled={busy||!notificationChanges||!Object.keys(notificationChanges).length} onClick={()=>{if(notificationChanges&&Object.keys(notificationChanges).length)void run('settings.update',notificationChanges)}}>알림 설정 저장</button>
    </Section><Section title="기록 보존" subtitle="종료된 운영 기록의 보존 기간">
      <div className="setting-row"><div><strong>보존 기간</strong><p>진행 중·미확인 발송 정보는 정리 대상에서 제외됩니다.</p></div><select aria-label="기록 보존 기간" disabled={!preferences} value={retention} onChange={e=>setDraft(d=>editSettingsDraft(d,'retentionDays',Number(e.target.value)))}>{!preferences&&<option value="">설정 불러오는 중</option>}<option value="30">30일</option><option value="90">90일</option><option value="180">180일</option></select></div>
      <button className="outline small" disabled={busy||!retentionChanges||!Object.keys(retentionChanges).length} onClick={()=>{if(retentionChanges&&Object.keys(retentionChanges).length)void run('settings.update',retentionChanges)}}>설정 저장</button>
    </Section><Section title="데이터 · 백업" subtitle="메시지와 구성만 내보내며 연결 키는 제외합니다.">
      <div className="backup-actions"><a className="outline" href="/api/backup" download="dico-central-backup.json">백업 다운로드</a><label className="outline file-picker">백업 파일 선택<input type="file" accept="application/json,.json" onChange={e=>void fileSelected(e.target.files?.[0])}/></label></div>
      {importError&&<p className="import-error" role="alert">{importError}</p>}
      {importFile&&<div className="import-preview"><strong>{importFile.name}</strong><p>형식: {importFile.data.format==='dico-settings'?'기존 A/B 설정':'중앙 관리 백업'} · 메시지 {Array.isArray(importFile.data.messages)?importFile.data.messages.length:'파일 내용 검사 필요'}개</p><p>복원 시 그룹은 중지 상태입니다. 진행 중이거나 미확인 발송이 있으면 복원되지 않습니다.</p><button className="primary" disabled={busy} onClick={()=>void restore()}>{importFile.data.format==='dico-settings'?'기존 설정 가져오기':'백업 복원'}</button></div>}
    </Section><Section title="모든 설정 초기화" subtitle="메시지·채널·그룹·브라우저 연결 설정을 삭제하고 환경 설정을 기본값으로 되돌립니다.">
      <p className="secondary">실행 기록과 중복 방지 기록은 보존합니다. Discord의 게시물·로그인·초안과 OS 설치 등록은 삭제하지 않습니다. 모든 그룹을 중지하고 미확인 결과를 해소한 뒤 진행하세요. 연결된 확장의 저장된 계정·채널도 초기화되며, 꺼져 있던 브라우저는 다음 연결 때 정리됩니다. 이후 계정·채널을 새로 연결하고 메시지를 적용하세요.</p>
      <div className="backup-actions"><a className="outline" href="/api/backup" download="dico-central-backup.json">초기화 전 백업 다운로드</a><button className="danger-button" disabled={busy||s.groups.some(g=>g.status!=='stopped')||s.attempts.some(a=>['preparing','permitted','unknown'].includes(a.status||''))} onClick={()=>{if(prompt('메시지와 모든 연결·그룹 설정을 삭제합니다. 백업을 저장했는지 확인한 뒤 ‘초기화’를 입력하세요.')==='초기화')void run('settings.reset',{confirmation:'RESET_ALL_SETTINGS',expectedConfiguration:s.configurationToken},'설정을 초기화했습니다. 저장된 확장 연결도 정리됩니다. 계정·채널과 메시지를 새로 설정하세요.')}}>모든 설정 초기화</button></div>
    </Section><Section title="자동 오류 제보" subtitle="문제 발생 시 진단을 자동 전송하고 접수 상태를 확인합니다."><AutomaticSupport diagnostic={false} accessMode={accessMode||undefined} disabled={busy}/></Section><Section title="프로그램 정보" subtitle="이 작업 공간은 이 PC의 로컬 서비스에 연결됩니다.">
      <div className="aggregate-list"><div><span>데이터 버전</span><strong>{s.schemaVersion}</strong></div><div><span>상태 버전</span><strong>{s.stateVersion}</strong></div><div><span>연결된 브라우저</span><strong>{s.instances.length}개</strong></div></div>
      <p className="secondary">관리 프로그램을 종료하면 새 발송 허가가 중단됩니다. 페이지를 닫아도 프로그램과 브라우저가 실행 중이면 작업 상태는 유지됩니다.</p>
    </Section></div></div></>
}

export default App
