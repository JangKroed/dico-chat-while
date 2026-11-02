import { useEffect, useRef, useState } from 'react'
import { ApiError, getUpdateStatus, requestErrorMessage, startUpdate, type Snapshot, type UpdateStatus } from './api'
import { browserOnline } from './onboarding'
import { extensionVersionState, updateBlockers, updateInProgress, updatePollingDecision } from './update'
import { UPDATE_RECONNECT_KEY } from './reconnect'

const phases:Record<UpdateStatus['phase'],string>={idle:'업데이트 대기',preparing:'새 버전 준비 중',ready:'새 버전 준비 완료',applying:'업데이트 적용 · 재시작 중',completed:'업데이트 완료',failed:'업데이트 실패'}
const timestamp=(value?:string|number)=>value===undefined?'—':new Date(value).toLocaleString('ko-KR')

export function UpdatePanel({s,busy,go,appVersion}:{s:Snapshot;busy:boolean;go:(page:'groups'|'history'|'connections')=>void;appVersion?:string}) {
  const [result,setResult]=useState<UpdateStatus|null>(null),[error,setError]=useState(''),[checking,setChecking]=useState(true),[submitting,setSubmitting]=useState(false),[pollKey,setPollKey]=useState(0),[paused,setPaused]=useState<'connection_lost'|'busy_timeout'|null>(null)
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
        lastResult.current=next;setResult(next);setError('');failures=0
        busyChecks=updateInProgress(next.phase)?busyChecks+1:0
      }catch(e){
        if(!active)return
        failures++
        setError(e instanceof ApiError&&e.status===404?'현재 관리 프로그램은 이 업데이트 기능을 지원하지 않습니다. 아래 최초 설치 안내를 확인하세요.':requestErrorMessage(e))
      }finally{window.clearTimeout(deadline);if(active)setChecking(false)}
      if(!active)return
      const decision=updatePollingDecision(lastResult.current?.phase,busyChecks,failures)
      if(decision==='continue')timer=window.setTimeout(()=>void poll(),3000)
      else setPaused(decision)
    }
    setChecking(true);void poll()
    return()=>{active=false;window.clearTimeout(timer);window.clearTimeout(deadline);controller?.abort()}
  },[pollKey,submitting])
  const blockers=updateBlockers(s),updating=updateInProgress(result?.phase)
  const start=async()=>{
    if(busy||submitting||updating||blockers.length||!result||error)return
    setSubmitting(true);setError('');setPaused(null)
    try{sessionStorage.setItem(UPDATE_RECONNECT_KEY,JSON.stringify({startedAt:Date.now(),fromVersion:appVersion}))}catch{}
    const controller=new AbortController();postController.current=controller
    const timeout=window.setTimeout(()=>controller.abort(),15000)
    try {const next=await startUpdate(controller.signal);if(next.phase==='failed')try{sessionStorage.removeItem(UPDATE_RECONNECT_KEY)}catch{};if(alive.current){lastResult.current=next;setResult(next)}}
    catch(e){if(e instanceof ApiError&&e.status>=400&&e.status<500)try{sessionStorage.removeItem(UPDATE_RECONNECT_KEY)}catch{};if(alive.current)setError(requestErrorMessage(e)+' 요청 결과를 확인한 뒤 다시 시도하세요.')}
    finally{window.clearTimeout(timeout);if(alive.current)setSubmitting(false)}
  }
  return <section className="panel update-panel" aria-label="프로그램 업데이트">
    <div className="panel-head"><div><h2>프로그램 · 확장 업데이트</h2><p>새 버전을 준비하고 관리 프로그램을 다시 시작합니다.</p></div><button className="outline small" disabled={checking||submitting} onClick={()=>setPollKey(k=>k+1)}>{checking?'확인 중…':'상태 다시 확인'}</button></div>
    <div className="update-body">
      <div className="update-state" role="status" aria-live="polite"><span className={`setup-status ${result?.phase==='failed'?'error':result?.phase==='completed'?'ok':'warning'}`}>{result?phases[result.phase]:'업데이트 상태 확인 중'}</span>{result?.version&&<span className="update-version">버전 정보 {result.version}</span>}{result?.message&&<p>{result.message}</p>}{updating&&<progress aria-label="업데이트 진행 중"/>}{result?.updatedAt&&<small>최근 갱신 {timestamp(result.updatedAt)}</small>}</div>
      {error&&<p className="update-error" role="alert">{error}</p>}
      {paused==='connection_lost'&&<div className="editor-note">업데이트 상태를 계속 받지 못해 자동 확인을 잠시 멈췄습니다. 재시작 중에는 연결이 잠시 끊기며 현재 탭에서 자동으로 다시 연결합니다. 잠시 기다리거나 ‘상태 다시 확인’을 눌러 주세요. 현재 화면만으로 완료 여부를 판단할 수 없습니다.</div>}
      {paused==='busy_timeout'&&<div className="editor-note">준비·적용 상태가 오래 이어져 자동 확인을 잠시 멈췄습니다. 중복 실행하지 말고 잠시 뒤 ‘상태 다시 확인’으로 진행 상황을 확인하세요.</div>}
      {result?.phase==='failed'&&<div className="update-next-step"><strong>다음 확인</strong><p>위 실패 사유와 PC의 네트워크·저장 공간을 확인하세요. 모든 발송과 중지 확인을 마친 뒤 ‘업데이트 실행’으로 다시 시도할 수 있습니다. 실패가 계속되면 설치·연결 진단도 확인하세요.</p></div>}
      <p className="update-description">고정된 공식 저장소의 새 소스를 별도 작업 공간에서 받아 설치와 빌드를 마친 뒤 적용합니다. 관리 프로그램이 다시 시작되면 같은 주소의 현재 탭에서 연결을 복구하고, 이 화면에서 시작한 업데이트는 새 버전 화면으로 이어집니다. 새 창을 열거나 주소를 바꿀 필요가 없습니다.</p>
      {blockers.length>0&&<div className="update-blockers"><strong>업데이트 전 남은 항목</strong><ul>{blockers.map(reason=><li key={reason}>{reason}</li>)}</ul><div className="control-row"><button className="text-action" onClick={()=>go('groups')}>그룹·중지 상태 확인 →</button>{s.attempts.some(a=>a.status==='unknown')&&<button className="text-action" onClick={()=>go('history')}>미확인 실행 기록 →</button>}</div></div>}
      <div className="update-actions"><button className="primary" disabled={busy||submitting||updating||blockers.length>0||!result||Boolean(error)} onClick={()=>void start()}>{submitting?'업데이트 요청 중…':updating?'업데이트 진행 중…':'업데이트 실행'}</button><small>설정과 실행 기록은 유지합니다. 업데이트 후 그룹을 자동으로 시작하거나 재개하지 않습니다.</small></div>
      <details className="update-migration"><summary>0.4.3 이하에서 처음 전환하는 경우</summary><p>0.4.3 이하 관리 프로그램은 주소와 연결 세션을 재시작 후 유지하는 기능이 없어, 처음 0.4.4로 옮길 때는 관리 화면을 한 번 다시 열어 인증해야 할 수 있습니다. 0.4.4부터 시작하는 이후 업데이트는 현재 주소와 탭을 유지합니다.</p><p>업데이트 버튼이 없는 0.4.0·0.4.1은 업데이트 기능이 포함된 관리 프로그램과 확장으로 최초 설치를 한 번 옮겨야 합니다. 브라우저 확장도 관리 경로에서 설치되어 있는지 확인하세요.</p></details>
      <div className="update-browsers"><div className="subheading"><h3>브라우저별 확장 확인</h3><button className="text-action" onClick={()=>go('connections')}>계정·브라우저 →</button></div>{s.instances.length?s.instances.map(i=>{const versionState=extensionVersionState(appVersion,i.extensionVersion,browserOnline(i));return <div className="update-browser" key={i.id}><div><strong>{i.browser||'브라우저'}</strong><small>{i.name||'등록된 연결'}</small></div><span>확장 보고 버전 {i.extensionVersion||'확인 필요'}</span><span className={`setup-status ${versionState==='current'?'ok':'warning'}`}>{versionState==='current'?'동일 버전 확인됨':versionState==='mismatch'?`확장 업데이트 필요 · 관리 프로그램 ${appVersion}`:versionState==='offline'?'브라우저 재연결 필요':'버전 확인 필요'}</span>{versionState==='mismatch'&&<p className="secondary">이 브라우저의 확장이 이전 버전입니다. 모든 그룹의 중지가 완료된 상태에서 자동 반영을 기다리세요. 버전이 그대로면 아래 설치·연결 진단의 관리 확장 폴더와 브라우저에 등록한 폴더가 같은지 확인하세요.</p>}</div>}):<p className="secondary">연결된 브라우저가 없습니다. 업데이트 후 사용할 브라우저의 확장을 연결하고 보고된 버전을 확인하세요.</p>}<p className="secondary">표시된 버전은 각 확장이 마지막으로 보고한 값입니다. 연결 응답만으로 채널 검증과 메시지 적용까지 완료된 것은 아닙니다.</p></div>
    </div>
  </section>
}
