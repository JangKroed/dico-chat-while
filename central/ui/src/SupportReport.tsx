import {useEffect,useRef,useState} from 'react'
import {getSupportReport,inspectSupportReport,requestErrorMessage,type Attempt} from './api'
import {readSupportReport,saveSupportReport,supportReportSummary,type SupportCheck,type SupportReport} from './support-report'

export function SupportReportButton({attemptId,onOpen,disabled=false}:{attemptId?:string;onOpen?:(attemptId?:string)=>void;disabled?:boolean}){
  return <button className="outline small" disabled={disabled||!onOpen} onClick={()=>onOpen?.(attemptId)}>관리자에게 제보</button>
}

export function AttemptMessageBody({attempt}:{attempt:Attempt}){
  return <section className="support-message" aria-label="시도 당시 메시지 본문"><h3>시도 당시 메시지 본문</h3><p className="secondary">이 시도에 보존된 원문입니다. 현재 메시지 보관함에서 수정한 문구와 다를 수 있습니다.</p>{typeof attempt.body==='string'?<pre>{attempt.body||'(빈 본문)'}</pre>:<p className="secondary">이 시도의 본문이 보존되지 않았거나 아직 불러오지 않았습니다.</p>}</section>
}

export function AttemptMessageLookup({attemptId,attempt}:{attemptId:string;attempt?:Attempt}){
  const [loaded,setLoaded]=useState<Attempt|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('')
  const alive=useRef(true)
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
  const selected=loaded||attempt
  const load=async()=>{
    if(loading)return
    setLoading(true);setError('')
    try{const report=await getSupportReport({attemptId,includeBodies:true,includeNames:true});if(alive.current){const found=report.attempts?.find(value=>value.id===attemptId);if(found)setLoaded(found);else setError('보존 기간에 이 시도의 본문 기록이 없습니다.')}}
    catch(e){if(alive.current)setError(requestErrorMessage(e))}finally{if(alive.current)setLoading(false)}
  }
  return <><AttemptMessageBody attempt={selected||{id:attemptId}}/>{typeof selected?.body!=='string'&&<button className="outline small" disabled={loading} onClick={()=>void load()}>{loading?'본문 불러오는 중…':'관련 시도 원문 불러오기'}</button>}{error&&<p role="alert">{error}</p>}</>
}

const json=(value:unknown)=>JSON.stringify(value??{},null,2)
function ReportChecks({checks}:{checks:SupportCheck[]}){
  return checks.length?<ul className="support-checks">{checks.map((check,index)=><li key={index}><strong>{check.code||'분석'}{check.severity?` · ${check.severity}`:''}</strong><p>{check.message||'추가 설명 없음'}</p>{check.attemptId&&<small>시도 {check.attemptId}</small>}</li>)}</ul>:<p className="secondary">추가 분석 항목이 없습니다. 파일 기록만으로 실제 게시 여부를 새로 확정하지 않습니다.</p>
}

export function SupportReportPreview({report,findings=[]}:{report:SupportReport;findings?:SupportCheck[]}){
  const attempts=Array.isArray(report.attempts)?report.attempts:[],timeline=Array.isArray(report.timeline)?report.timeline:[]
  const seen=new Set<string>(),checks=[...findings,...(Array.isArray(report.checks)?report.checks:[])].filter(check=>{const key=JSON.stringify([check.code,check.severity,check.message,check.attemptId,check.groupId,check.instanceId]);if(seen.has(key))return false;seen.add(key);return true})
  return <div className="support-preview"><dl className="detail-list"><dt>제보 ID</dt><dd>{report.reportId||'—'}</dd><dt>생성 시각</dt><dd>{report.createdAt?new Date(report.createdAt).toLocaleString('ko-KR'):'—'}</dd><dt>범위</dt><dd><pre>{json(report.selection)}</pre></dd><dt>포함 항목</dt><dd>메시지 본문 {report.privacy?.includeBodies?'포함':'제외'} · 계정·채널 이름 {report.privacy?.includeNames?'포함':'제외'}</dd></dl>{report.userDescription&&<section><h3>제보자가 적은 증상</h3><pre>{report.userDescription}</pre></section>}<section><h3>버전 · 빌드 정보</h3><pre>{json(report.runtime)}</pre></section><section><h3>집계</h3><pre>{json(report.summary)}</pre></section><section><h3>분석 · 버전 차이 · 복구 확인</h3><ReportChecks checks={checks}/></section><section><h3>관련 사건 타임라인</h3>{timeline.length?<ol className="support-timeline">{timeline.map((event,index)=><li key={index}><pre>{json(event)}</pre></li>)}</ol>:<p className="secondary">보존된 타임라인이 없습니다.</p>}</section><section><h3>발송 시도 · 오류 · 재시도 증거</h3>{attempts.map((attempt,index)=><details key={`${attempt.id}-${index}`} open={attempts.length===1}><summary>{attempt.id} · {attempt.status||'—'} · {attempt.reasonCode||'사유 코드 없음'}</summary>{report.privacy?.includeBodies?<AttemptMessageBody attempt={attempt}/>:<p className="secondary">포함 선택에 따라 메시지 본문을 제외했습니다.</p>}<pre>{json(Object.fromEntries(Object.entries(attempt).filter(([key])=>key!=='body')))}</pre></details>)}</section><details><summary>슬로우 모드 · 그룹 계정 순서 · 연결 설정</summary><pre>{json(report.configuration)}</pre></details><details><summary>전체 로그 · 요청 · 문제 기록</summary><pre>{json({events:report.events,commands:report.commands,incidents:report.incidents})}</pre></details></div>
}

const inputTime=(value:number)=>new Date(value-new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,16)
export function SupportReportDialog({attemptId,onClose}:{attemptId?:string;onClose:()=>void}){
  const [includeBodies,setBodies]=useState(true),[includeNames,setNames]=useState(true),[description,setDescription]=useState('')
  const [from,setFrom]=useState(()=>inputTime(Date.now()-86400000)),[to,setTo]=useState(()=>inputTime(Date.now()))
  const [report,setReport]=useState<SupportReport|null>(null),[findings,setFindings]=useState<SupportCheck[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[imported,setImported]=useState(false)
  const generation=useRef(0),controller=useRef<AbortController|null>(null)
  useEffect(()=>()=>{generation.current++;controller.current?.abort()},[])
  const invalidate=()=>{generation.current++;controller.current?.abort();setLoading(false);setReport(null);setFindings([]);setNotice('');setError('');setImported(false)}
  const preview=async()=>{
    const start=new Date(from).getTime(),end=new Date(to).getTime()
    if(!attemptId&&(!Number.isFinite(start)||!Number.isFinite(end)||start>end)){setError('올바른 시작·종료 시각을 입력하세요.');return}
    invalidate();const current=generation.current,abort=new AbortController();controller.current=abort;setLoading(true)
    try{const next=await getSupportReport({attemptId,...(!attemptId?{from:start,to:end}:{}),includeBodies,includeNames},abort.signal);if(current===generation.current)setReport(next)}
    catch(e){if(current===generation.current)setError(requestErrorMessage(e))}finally{if(current===generation.current)setLoading(false)}
  }
  const importFile=async(file:File)=>{
    invalidate();const current=generation.current,abort=new AbortController();controller.current=abort;setLoading(true)
    try{const value=await readSupportReport(file);if(current!==generation.current)return;const inspected=await inspectSupportReport(value,abort.signal);if(current===generation.current){setReport(inspected.report);setFindings(inspected.findings);setDescription(inspected.report.userDescription||'');setImported(true)}}
    catch(e){if(current===generation.current)setError(requestErrorMessage(e))}finally{if(current===generation.current)setLoading(false)}
  }
  const prepared=report?{...report,...(!imported?{userDescription:description}: {})}:null
  const save=()=>{if(!prepared||loading)return;try{saveSupportReport(prepared);setNotice('제보 파일 저장을 요청했습니다. 저장된 파일을 원하는 메신저나 메일로 관리자에게 직접 전달하세요.')}catch(e){setError(requestErrorMessage(e))}}
  const copy=async()=>{if(!prepared||loading)return;try{await navigator.clipboard.writeText(supportReportSummary(prepared));setNotice('제보 요약을 복사했습니다. 전체 로그는 JSON 제보 파일과 함께 전달하세요.')}catch{setError('클립보드에 복사하지 못했습니다. 제보 파일을 저장해 전달하세요.')}}
  return <div className="modal-backdrop" onClick={onClose}><div className="modal support-modal" role="dialog" aria-modal="true" aria-label="관리자에게 제보" tabIndex={0} autoFocus onClick={event=>event.stopPropagation()}><div className="panel-head"><div><h2>관리자에게 제보</h2><p>증상과 실행 기록을 한 파일로 모아 전달합니다.</p></div><button className="icon-button" aria-label="제보 창 닫기" onClick={onClose}>×</button></div><div className="support-controls"><p className="editor-note">파일을 저장한 뒤 원하는 메신저나 메일로 관리자에게 직접 전달하세요. 이 화면에서 외부로 자동 전송하지 않습니다.</p><label>겪은 문제 · 재현 방법<textarea maxLength={4000} rows={3} readOnly={imported} value={description} onChange={event=>setDescription(event.target.value)} placeholder="언제, 어떤 계정·채널에서, 어떤 문구로 멈췄는지 적어 주세요."/></label>{attemptId?<p className="secondary">선택한 시도: {attemptId} · 관련 전후 로그와 그룹 정보를 포함합니다.</p>:<div className="support-range"><label>시작 시각<input type="datetime-local" value={from} onChange={event=>{invalidate();setFrom(event.target.value)}}/></label><label>종료 시각<input type="datetime-local" value={to} onChange={event=>{invalidate();setTo(event.target.value)}}/></label></div>}<label className="checkline"><input type="checkbox" checked={includeBodies} onChange={event=>{invalidate();setBodies(event.target.checked)}}/> 실제 발송을 시도한 메시지 본문 포함</label><label className="checkline"><input type="checkbox" checked={includeNames} onChange={event=>{invalidate();setNames(event.target.checked)}}/> 계정·채널·그룹·브라우저 표시 이름 포함</label><p className="secondary">본문과 이름에는 개인정보가 포함될 수 있습니다. 아래 미리보기에서 공유할 내용을 확인하세요. 인증 토큰·쿠키·연결 비밀 키는 제외하며, 이름을 제외해도 사건 연결에 필요한 식별자는 남습니다.</p><div className="control-row"><button className="primary" disabled={loading} onClick={()=>void preview()}>{loading?'기록 준비 중…':'제보 내용 미리보기'}</button><label className="outline support-file">관리자용 제보 파일 열기<input type="file" accept=".json,application/json" disabled={loading} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void importFile(file)}}/></label></div></div>{error&&<p className="import-error" role="alert">{error}</p>}{notice&&<p className="editor-note" role="status">{notice}</p>}{prepared&&<><div className="control-row support-actions"><button className="primary" disabled={loading} onClick={save}>제보 파일 저장</button><button className="outline" disabled={loading} onClick={()=>void copy()}>제보 요약 복사</button><small>{imported?'가져온 파일은 인증된 원본으로 간주하지 않습니다. 열람만 하며 설정·발송 상태를 변경하지 않습니다.':'미리보기한 내용으로 파일을 만듭니다.'}</small></div><SupportReportPreview report={prepared} findings={findings}/></>}<div className="control-row"><button className="outline" onClick={onClose}>닫기</button></div></div></div>
}
