import { useEffect, useRef, useState } from 'react'
import { ApiError, getLatestUpdate, getUpdateStatus, reportUpdateFailure, requestErrorMessage, startRollback, startUpdate, type LatestUpdate, type Snapshot, type UpdateStatus } from './api'
import { browserOnline } from './onboarding'
import { extensionVersionState, showUpdateBlockers,updateBlockers, updateInProgress, updatePollingDecision, rollbackActionState, rollbackUnavailableMessage, safeUpdateMessage, rollbackPhaseMessage } from './update'
import { UPDATE_RECONNECT_KEY } from './reconnect'

const phases:Record<UpdateStatus['phase'],string>={idle:'업데이트 대기',preparing:'새 버전 준비 중',ready:'새 버전 준비 완료',applying:'업데이트 적용 · 재시작 중',completed:'업데이트 완료',failed:'업데이트 실패'}
const timestamp=(value?:string|number)=>value===undefined?'—':new Date(value).toLocaleString('ko-KR')

// 최신 배포 확인과 실제 작업 상태를 한 카드에서 보여 주되 진행·실패를 우선합니다.
export function UpdateStatusCard({result,latest,checkingLatest,submitting,requestMode,appVersion}:{result:UpdateStatus|null;latest:LatestUpdate|null;checkingLatest:boolean;submitting:boolean;requestMode:'update'|'rollback';appVersion?:string}){
 const updating=updateInProgress(result?.phase),currentVersion=appVersion||latest?.currentVersion
 const rollback=result?.mode==='rollback'
 const operationLabel=result?(rollback?({idle:'이전 버전 복원 대기',preparing:'이전 버전 복원 준비 중',ready:'이전 버전 복원 준비 완료',applying:'이전 버전 적용 · 재시작 중',completed:'이전 버전 복원 완료',failed:'이전 버전 복원 실패'}[result.phase]):phases[result.phase]):'업데이트 상태 확인 중'
 const label=result?.retrying?'자동 복구 중':submitting?(requestMode==='rollback'?'이전 버전 복원 요청 중…':'업데이트 요청 중…'):updating||result?.phase==='failed'||rollback&&result?.phase==='completed'?operationLabel:checkingLatest?'최신 버전 확인 중…':latest?.state==='current'?'최신 버전 사용 중':latest?.state==='available'?'새 업데이트 사용 가능':latest?.state==='ahead'?'공식 배포보다 높은 버전 사용 중':'최신 버전을 확인하지 못했습니다'
 const tone=result?.phase==='failed'?'error':!submitting&&!updating&&(latest?.state==='current'||rollback&&result?.phase==='completed')?'ok':'warning'
 return <div className="update-state" role="status" aria-live="polite" aria-label="업데이트 상태">
  <strong className={`setup-status ${tone}`}>{label}</strong>
  <p>현재 {currentVersion||'확인 중'}{latest?.latestVersion?` · 공식 배포 ${latest.latestVersion}`:''}</p>
  {result?.version&&result.version!==currentVersion&&<span className="update-version">{updating?'적용할 버전':'최근 작업 버전'} {result.version}</span>}
  {result?.message&&(updating||result.phase==='failed')&&<p>{rollback?rollbackPhaseMessage(result.phase):result.message}</p>}
  {updating&&<progress aria-label="업데이트 진행 중"/>}
  {latest?.checkedAt&&<small>마지막 확인 {timestamp(latest.checkedAt)}</small>}
  {result?.updatedAt&&result.phase!=='idle'&&<small>{result.phase==='completed'?(rollback?'복원 완료':'업데이트 완료'):'작업 상태 변경'} {timestamp(result.updatedAt)}</small>}
 </div>
}

// 확장 설치 버전과 페이지에서 실제 관측한 코드를 분리합니다. 오래된 관측은
// 현재 버전 확인으로 바꾸지 않고, 원본 빌드 지문은 상세 진단 자료에 보존합니다.
export function PageCodeVersions({s}:{s:Snapshot}){
 return <div className="update-browsers" aria-label="Discord 페이지 실행 코드"><h3>Discord 페이지 실행 코드</h3>
  {s.channels.length?s.channels.map(c=>{
   const code=c.pageCode,owner=s.instances.find(i=>i.id===c.instanceId)
   const fresh=code?.state==='observed',mismatch=fresh&&((code.buildId&&typeof owner?.extensionBuildId==='string'&&code.buildId!==owner.extensionBuildId)||(code.version&&owner?.extensionVersion&&owner.extensionVersion!=='unknown'&&code.version!==owner.extensionVersion))
   return <div className="update-browser" key={c.id}><div><strong>{c.name}</strong><small>{owner?.browser||'브라우저'}</small></div>
    <span>{fresh?`페이지 관측 버전 ${code.version||'미확인'}`:code?.state==='stale'?`과거 관측 버전 ${code.version||'미확인'}`:'페이지 실행 코드 미확인'}</span>
    <span className={`setup-status ${fresh&&!mismatch?'ok':'warning'}`}>{mismatch?'확장과 다른 실행 코드 · 안전한 전환 대기':fresh&&code.buildId&&owner?.extensionBuildId===code.buildId?'확장 빌드 일치':fresh?'페이지 코드 관측됨':code?.state==='stale'?'새 관측 대기':'실제 코드 관측 대기'}</span>
    {code?.state!=='unknown'&&code?.observedAt!==undefined&&<small>최근 관측 {timestamp(code.observedAt)}</small>}
   </div>
  }):<p className="secondary">등록된 채널의 실제 페이지 코드 관측을 기다립니다.</p>}
  <p className="secondary">발송 경로에서 페이지가 보고한 값입니다. 관측이 없거나 오래된 경우 설치 버전으로 추정하지 않습니다.</p>
 </div>
}

const reportLabels:Record<string,string>={
 disabled:'오류 제보가 꺼져 있어 자동 전송하지 않았습니다. 설정의 오류 제보에서 전송을 허용할 수 있습니다.',
 manual:'자동 전송이 꺼져 있습니다. 아래 버튼으로 수집된 진단 정보를 보낼 수 있습니다.',
 unconfigured:'관리자 수신 연결이 없어 전송을 기다리고 있습니다.',
 collecting:'진단 정보를 자동으로 수집하고 있습니다.',
 queued:'진단 정보 전송 대기 중입니다. 프로그램이 자동으로 전송합니다.',
 sending:'관리자에게 진단 정보를 보내고 있습니다.',
 sent:'관리자 접수 완료',
 failed:'진단 정보 전송을 완료하지 못했습니다. 전송 상태는 오류 제보 설정에 보존됩니다.',
 unavailable:'진단 제보 기능을 시작하지 못했습니다. 실패 기록은 보존되어 있습니다.'
}
export function UpdateFailureDetails({result,onReport,sending=false}:{result:UpdateStatus;onReport:()=>void;sending?:boolean}){
 return <div className="update-next-step" role="status">
  <strong>자동 진단 결과</strong>
  <p>{safeUpdateMessage(result.diagnostic?.message,'기록된 실패 단계와 설치 상태를 확인하고 있습니다.')}</p>
  {result.diagnostic&&<small>진단 코드 {result.diagnostic.code} · 단계 {result.diagnostic.stage}</small>}
  {Boolean(result.retryCount)&&<p>자동 재시도 {result.retryCount}회 후 결과입니다.</p>}
  <p>{reportLabels[result.support?.status||'collecting']||reportLabels.unavailable}</p>
  {result.support?.reportId&&<small>제보 번호 {result.support.reportId}</small>}
  {result.support?.receiptId&&<p>접수 번호 {result.support.receiptId}</p>}
  {result.support?.status==='manual'&&<button className="outline small" disabled={sending} onClick={onReport}>{sending?'진단 정보 보내는 중…':'진단 정보 보내기'}</button>}
 </div>
}

// 이전 릴리스 파일의 유무만 안내합니다. 서버의 내부 파일 경로나 원문 오류는
// 표시하지 않으며, 사용자의 버튼 선택을 별도 확인창으로 반복하지 않습니다.
export function RollbackControls({s,result,busy,submitting,onStart}:{s:Snapshot;result:UpdateStatus|null;busy:boolean;submitting:boolean;onStart:()=>void}){
 const state=rollbackActionState(s,result,busy||submitting)
 return <div className="update-migration" aria-label="이전 버전 복원"><h3>이전 버전으로 되돌리기</h3>
  {result?.rollback?.available?<p>보관된 이전 버전 <strong>{result.rollback.version||'버전 정보 없음'}</strong>으로 프로그램을 되돌립니다.</p>:<p>{!result?'이전 버전 보관 상태를 확인하고 있습니다.':rollbackUnavailableMessage(result.rollback?.reason)}</p>}
  <p>설정과 실행 기록은 유지합니다. 복원 후 그룹을 자동으로 시작하거나 재개하지 않습니다.</p>
  <div className="update-actions"><button className="outline" disabled={state.disabled} onClick={onStart}>{submitting?'이전 버전 복원 요청 중…':result?.mode==='rollback'&&updateInProgress(result.phase)?'이전 버전 복원 중…':'이전 버전으로 되돌리기'}</button>{state.blockers.length>0&&<small>위의 발송·중지 상태 조건이 충족되면 복원할 수 있습니다.</small>}</div>
 </div>
}

export function UpdatePanel({s,busy,go,appVersion}:{s:Snapshot;busy:boolean;go:(page:'groups'|'history'|'connections')=>void;appVersion?:string}) {
  const [sendingReport,setSendingReport]=useState(false)
  const [latest,setLatest]=useState<LatestUpdate|null>(null),[checkingLatest,setCheckingLatest]=useState(true)
  const [requestMode,setRequestMode]=useState<'update'|'rollback'>('update')
  const [result,setResult]=useState<UpdateStatus|null>(null),[error,setError]=useState(''),[checking,setChecking]=useState(true),[submitting,setSubmitting]=useState(false),[pollKey,setPollKey]=useState(0),[paused,setPaused]=useState<'connection_lost'|'busy_timeout'|null>(null)
  useEffect(()=>{const check=()=>setPollKey(key=>key+1);window.addEventListener('dico:check-update',check);return()=>window.removeEventListener('dico:check-update',check)},[])
  const alive=useRef(true),postController=useRef<AbortController|null>(null)
  const lastResult=useRef<UpdateStatus|null>(null)
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;postController.current?.abort()}},[])
  useEffect(()=>{
    if(submitting)return
    let active=true,timer=0,deadline=0,failures=0,busyChecks=0,controller:AbortController|null=null
    setPaused(null)
    const poll=async()=>{
      controller=new AbortController()
      deadline=window.setTimeout(()=>controller?.abort(),10000)
      try {
        const next=await getUpdateStatus(controller.signal)
        if(!active)return
        lastResult.current=next;setResult(next);setError('');setPaused(null);failures=0
        busyChecks=updateInProgress(next.phase)?busyChecks+1:0
      }catch(e){
        if(!active)return
        failures++
        setError(e instanceof ApiError&&e.status===404?'현재 관리 프로그램은 이 업데이트 기능을 지원하지 않습니다. 아래 최초 설치 안내를 확인하세요.':requestErrorMessage(e))
      }finally{window.clearTimeout(deadline);if(active)setChecking(false)}
      if(!active)return
      const decision=updatePollingDecision(lastResult.current?.phase,busyChecks,failures)
      if(decision==='continue')timer=window.setTimeout(()=>void poll(),3000)
      // 연결 오류나 긴 작업 때문에 사용자의 재확인 버튼을 기다리지 않습니다.
      else {setPaused(decision);timer=window.setTimeout(()=>void poll(),15000)}
    }
    setChecking(true);void poll()
    return()=>{active=false;window.clearTimeout(timer);window.clearTimeout(deadline);controller?.abort()}
  },[pollKey,submitting])
  const sendReport=async()=>{setSendingReport(true);setError('');try{const next=await reportUpdateFailure();if(alive.current)setResult(next)}catch(e){if(alive.current)setError(requestErrorMessage(e))}finally{if(alive.current)setSendingReport(false)}}
  const blockers=updateBlockers(s),updating=updateInProgress(result?.phase)
  useEffect(()=>{
    if(submitting||updating)return
    const controller=new AbortController()
    setCheckingLatest(true);setLatest(null)
    void getLatestUpdate(controller.signal).then(value=>{
      if(!controller.signal.aborted)setLatest(value)
    }).catch(()=>{
      if(!controller.signal.aborted)setLatest({state:'unavailable',checkedAt:Date.now()})
    }).finally(()=>{if(!controller.signal.aborted)setCheckingLatest(false)})
    return()=>controller.abort()
  },[pollKey,appVersion,submitting,updating])
  const canUpdate=latest?.state==='available'&&!checkingLatest
  const start=async(mode:'update'|'rollback'='update')=>{
    if(busy||submitting||postController.current||updating||blockers.length||!result||error||(mode==='rollback'?!result.rollback?.available:!canUpdate))return
    setRequestMode(mode);setSubmitting(true);setError('');setPaused(null)
    try{sessionStorage.setItem(UPDATE_RECONNECT_KEY,JSON.stringify({startedAt:Date.now(),fromVersion:appVersion}))}catch{}
    const controller=new AbortController();postController.current=controller
    const timeout=window.setTimeout(()=>controller.abort(),15000)
    try {const next=await (mode==='rollback'?startRollback:startUpdate)(controller.signal);if(next.phase==='failed')try{sessionStorage.removeItem(UPDATE_RECONNECT_KEY)}catch{};if(alive.current){lastResult.current=next;setResult(next)}}
    catch(e){if(e instanceof ApiError&&e.status>=400&&e.status<500)try{sessionStorage.removeItem(UPDATE_RECONNECT_KEY)}catch{};if(alive.current)setError(mode==='rollback'?safeUpdateMessage(e instanceof ApiError?requestErrorMessage(e):undefined,'이전 버전 복원 요청을 완료했는지 확인하지 못했습니다. 상태를 다시 확인해 주세요.'):requestErrorMessage(e)+' 요청 결과를 확인한 뒤 다시 시도하세요.')}
    finally{window.clearTimeout(timeout);postController.current=null;if(alive.current)setSubmitting(false)}
  }
  return <section className="panel update-panel" aria-label="프로그램 업데이트">
    <div className="panel-head"><div><h2>프로그램 · 확장 업데이트</h2><p>새 버전을 준비하고 관리 프로그램을 다시 시작합니다.</p></div><button className="outline small" disabled={checking||checkingLatest&&!updating||submitting} onClick={()=>setPollKey(k=>k+1)}>{checking||checkingLatest&&!updating?'확인 중…':'새로고침'}</button></div>
    <div className="update-body">
      <UpdateStatusCard result={result} latest={latest} checkingLatest={checkingLatest} submitting={submitting} requestMode={requestMode} appVersion={appVersion}/>
      {error&&<p className="update-error" role="alert">{error}</p>}
      {paused==='connection_lost'&&<div className="editor-note">업데이트 상태 연결을 복구하고 있습니다. 15초 간격으로 자동 재확인하며 현재 설치와 실행 기록을 유지합니다.</div>}
      {paused==='busy_timeout'&&<div className="editor-note">준비·적용이 이어지고 있습니다. 15초 간격으로 자동 재확인하며 같은 업데이트를 중복 실행하지 않습니다.</div>}
      {result?.phase==='failed'&&<UpdateFailureDetails result={result} onReport={()=>void sendReport()} sending={sendingReport}/>}
      <p className="update-description">공식 저장소에서 검증된 업데이트 파일을 받아 준비·검사를 마친 뒤 적용합니다. 일시적인 연결 오류는 자동 재시도하고, 실패 원인과 제보 상태를 이 화면에 표시합니다. 관리 프로그램이 다시 시작되면 같은 주소의 현재 탭에서 연결을 복구하고, 이 화면에서 시작한 업데이트는 새 버전 화면으로 이어집니다. 새 창을 열거나 주소를 바꿀 필요가 없습니다.</p>
      {showUpdateBlockers(result?.phase)&&blockers.length>0&&<div className="update-blockers"><strong>발송 상태 자동 확인 중</strong><ul>{blockers.map(reason=><li key={reason}>{reason}</li>)}</ul></div>}
      <div className="update-actions"><button className="primary" disabled={busy||submitting||updating||blockers.length>0||!result||Boolean(error)||!canUpdate} onClick={()=>void start()}>{submitting?requestMode==='rollback'?'이전 버전 복원 요청 중…':'업데이트 요청 중…':updating?result?.mode==='rollback'?'이전 버전 복원 중…':'업데이트 진행 중…':'업데이트 실행'}</button><small>설정과 실행 기록은 유지합니다. 사용자 중지와 게시 결과가 확인되지 않은 발송을 보호합니다.</small></div>
      <RollbackControls s={s} result={result} busy={busy||Boolean(error)||submitting} submitting={submitting&&requestMode==='rollback'} onStart={()=>void start('rollback')}/>
      <details className="update-migration"><summary>0.4.3 이하에서 처음 전환하는 경우</summary><p>0.4.3 이하 관리 프로그램은 주소와 연결 세션을 재시작 후 유지하는 기능이 없어, 처음 0.4.4로 옮길 때는 관리 화면을 한 번 다시 열어 인증해야 할 수 있습니다. 0.4.4부터 시작하는 이후 업데이트는 현재 주소와 탭을 유지합니다.</p><p>업데이트 버튼이 없는 0.4.0·0.4.1은 업데이트 기능이 포함된 관리 프로그램과 확장으로 최초 설치를 한 번 옮겨야 합니다. 브라우저 확장도 관리 경로에서 설치되어 있는지 확인하세요.</p></details>
      <div className="update-browsers"><div className="subheading"><h3>브라우저별 확장 확인</h3><button className="text-action" onClick={()=>go('connections')}>계정·브라우저 →</button></div>{s.instances.length?s.instances.map(i=>{const versionState=extensionVersionState(appVersion,i.extensionVersion,browserOnline(i));return <div className="update-browser" key={i.id}><div><strong>{i.browser||'브라우저'}</strong><small>{i.name||'등록된 연결'}</small></div><span>확장 보고 버전 {i.extensionVersion||'확인 필요'}</span><span className={`setup-status ${versionState==='current'?'ok':'warning'}`}>{versionState==='current'?'동일 버전 확인됨':versionState==='mismatch'?`확장 업데이트 필요 · 관리 프로그램 ${appVersion}`:versionState==='offline'?'브라우저 연결 대기':'버전 확인 필요'}</span>{versionState==='mismatch'&&<p className="secondary">관리 프로그램과 확장의 보고 버전이 다릅니다. 발송이 안전하게 멈추면 확장 파일과 실행 버전을 자동으로 확인하고 갱신합니다. 현재 발송 결과와 설정은 보존됩니다.</p>}</div>}):<p className="secondary">연결된 브라우저가 없습니다. 업데이트 후 사용할 브라우저의 확장을 연결하고 보고된 버전을 확인하세요.</p>}<p className="secondary">표시된 버전은 각 확장이 마지막으로 보고한 값입니다. 연결 응답만으로 채널 검증과 메시지 적용까지 완료된 것은 아닙니다.</p></div>
      <PageCodeVersions s={s}/>
    </div>
  </section>
}
