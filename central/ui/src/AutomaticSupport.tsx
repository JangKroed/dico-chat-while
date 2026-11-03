import {useEffect,useRef,useState} from 'react'
import {createSupportReceiverKey,getAutomaticSupport,getSupportInboxReport,requestErrorMessage,updateAutomaticSupport,type AccessMode,type AutomaticSupportSettings,type AutomaticSupportStatus} from './api'
import {SupportReportPreview} from './SupportReport'
import type {SupportInspection} from './support-report'

const defaults:AutomaticSupportSettings={enabled:false,autoSend:false,receiverUrl:'',includeBodies:false,includeNames:false,receiverEnabled:false,retentionDays:30}
const date=(at:number|null|undefined)=>at?new Date(at).toLocaleString('ko-KR'):'—'
export function AutomaticSupport({accessMode='local',disabled=false,diagnostic=true}:{accessMode?:AccessMode;disabled?:boolean;diagnostic?:boolean}){
  const [status,setStatus]=useState<AutomaticSupportStatus|null>(null),[draft,setDraft]=useState<AutomaticSupportSettings>(defaults),[reporterToken,setReporterToken]=useState('')
  const [loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[receiverKey,setReceiverKey]=useState(''),[inspection,setInspection]=useState<SupportInspection|null>(null)
  const alive=useRef(true),dirty=useRef(false),busy=useRef(false),inspectionGeneration=useRef(0)
  const local=accessMode==='local',blocked=disabled||!local||saving
  const accept=(next:AutomaticSupportStatus,replace=false)=>{setStatus(next);if(replace||!dirty.current){setDraft(next.settings);dirty.current=false}}
  const refresh=async()=>{
    if(busy.current||!local)return
    busy.current=true;setLoading(true);setError('')
    try{const next=await getAutomaticSupport();if(alive.current)accept(next)}catch(e){if(alive.current)setError(requestErrorMessage(e))}finally{busy.current=false;if(alive.current)setLoading(false)}
  }
  useEffect(()=>{alive.current=true;void refresh();const interval=window.setInterval(()=>void refresh(),15000);return()=>{alive.current=false;inspectionGeneration.current++;window.clearInterval(interval)}},[local])
  const edit=(patch:Partial<AutomaticSupportSettings>)=>{dirty.current=true;setDraft(value=>({...value,...patch}));setNotice('')}
  const save=async()=>{
    if(blocked||!status||busy.current)return
    busy.current=true;setSaving(true);setError('');setNotice('')
    // 과거 설정에 본문·이름 포함이 남아 있어도 자동 제보 저장 시 항상 제거한다.
    // 수신 연결 값은 그대로 보존하여 사용자 모드에서도 기존 전송 엔진을 사용한다.
    try{const next=await updateAutomaticSupport({...draft,includeBodies:false,includeNames:false,...(reporterToken?{reporterToken}:{})});if(alive.current){accept(next,true);setReporterToken('');setNotice('자동 제보 설정을 저장했습니다.')}}
    catch(e){if(alive.current)setError(requestErrorMessage(e))}finally{busy.current=false;if(alive.current)setSaving(false)}
  }
  const issueKey=async()=>{
    if(blocked||busy.current)return
    busy.current=true;setSaving(true);setError('');setReceiverKey('')
    try{const result=await createSupportReceiverKey();if(alive.current){setReceiverKey(result.token);setNotice('수신 인증 키를 표시했습니다. 이 화면을 닫기 전에 복사해 제보하는 프로그램에 등록하세요.')}}
    catch(e){if(alive.current)setError(requestErrorMessage(e))}finally{busy.current=false;if(alive.current)setSaving(false)}
  }
  const openReport=async(id:string)=>{
    const generation=++inspectionGeneration.current;setError('');setInspection(null)
    try{const next=await getSupportInboxReport(id);if(alive.current&&generation===inspectionGeneration.current)setInspection(next)}catch(e){if(alive.current&&generation===inspectionGeneration.current)setError(requestErrorMessage(e))}
  }
  const copyKey=async()=>{try{await navigator.clipboard.writeText(receiverKey);if(alive.current)setNotice('수신 인증 키를 복사했습니다.')}catch{if(alive.current)setError('수신 인증 키를 복사하지 못했습니다. 키를 선택해 복사하세요.')}}
  const active=status?.settings.enabled&&status?.settings.autoSend
  // 일반 사용자는 동의 여부와 결과만 확인한다. 수신 연결·인증 키·원시 오류는
  // 진단 화면에만 남기고, 미설정 또는 대기 중인 제보를 전송 성공으로 표시하지 않는다.
  // diagnostic 기본값은 기존 독립 사용처를 위한 것이며 App에서 사용자 모드를 지정한다.
  if(!diagnostic)return <section className="support-controls" aria-label="자동 오류 제보">
    <div className="panel-head"><div><h3>자동 오류 제보</h3><p>문제가 발생하면 메시지 본문과 표시 이름을 제외한 진단 정보를 자동으로 제보합니다.</p></div></div>
    {!local&&<p className="editor-note">자동 제보 동의는 프로그램이 실행되는 컴퓨터에서 변경할 수 있습니다.</p>}
    <label className="checkline"><input aria-label="문제 발생 시 자동 제보" type="checkbox" checked={draft.enabled&&draft.autoSend} disabled={blocked||!status} onChange={event=>edit({enabled:event.target.checked,autoSend:event.target.checked})}/> 문제 발생 시 자동 제보</label>
    <div className="control-row"><button className="primary" disabled={blocked||!status||loading} onClick={()=>void save()}>자동 제보 설정 저장</button></div>
    <div className="editor-note" role="status">{!status?'제보 설정을 확인하고 있습니다.':!status.configured?'자동 제보 연결이 준비되지 않아 아직 전송되지 않습니다.':active?'자동 제보 켜짐':'자동 제보 꺼짐'}{status&&<p>전송 대기 {status.counts.queued}건 · 수신 확인 {status.counts.sent}건 · 전송 실패 {status.counts.failed}건</p>}</div>
    <p className="secondary">수신 확인은 제보 서비스가 전송을 확인한 상태이며, 담당자의 확인 여부를 뜻하지 않습니다.</p>
    {error&&<p className="import-error" role="alert">제보 설정을 확인하거나 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.</p>}
    {notice&&<p className="editor-note" role="status">{notice}</p>}
  </section>
  return <section className="support-controls" aria-label="자동 오류 제보"><div className="panel-head"><div><h3>자동 오류 제보</h3><p>한 번 설정하면 문제가 발생할 때 진단을 수집하고 관리자 수신함으로 전송합니다.</p></div><button className="outline small" disabled={disabled||!local||loading||saving} onClick={()=>void refresh()}>제보 상태 새로고침</button></div>
    {!local&&<p className="editor-note">자동 제보와 관리자 수신 설정은 관리 프로그램이 실행되는 컴퓨터에서 변경할 수 있습니다.</p>}
    <label className="checkline"><input aria-label="관리자에게 진단 전송 허용" type="checkbox" checked={draft.enabled} disabled={blocked||!status} onChange={event=>edit({enabled:event.target.checked,...(!event.target.checked?{autoSend:false}:{})})}/> 관리자에게 진단 전송 허용</label>
    <label className="checkline"><input aria-label="문제 발생 시 자동 제보" type="checkbox" checked={draft.enabled&&draft.autoSend} disabled={blocked||!status} onChange={event=>edit({autoSend:event.target.checked,...(event.target.checked?{enabled:true}:{})})}/> 문제 발생 시 자동 제보</label>
    <p className="secondary">진단 전송 허용은 직접 제보할 때도 필요하며 기본으로 꺼져 있습니다. 자동 제보를 켜면 전송도 함께 허용됩니다. 켜서 저장하면 이후 발생한 문제의 버전·오류·전후 로그와 발송 시도 진단이 아래 수신 주소로 전달됩니다. 파일을 내려받아 직접 보낼 필요가 없습니다.</p>
    {/^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/.test(draft.receiverUrl)&&<p className="editor-note">이메일 중계 연결 · 기본 DICO 중계의 수신자는 didlsdydgh@gmail.com입니다. 수신 확인은 중계의 메일 발송 성공 응답을 뜻하며 받은편지함 도착 여부와는 다릅니다.</p>}
    <p className="secondary">자동 제보에는 메시지 본문과 표시 이름 등 개인정보를 포함하지 않습니다. 인증 토큰·쿠키·연결 비밀 키도 제외하며 사건을 연결하는 식별자는 포함됩니다.</p>
    <details><summary>관리자 수신 연결 설정</summary><div className="support-controls"><label>관리자 제보 수신 주소<input aria-label="관리자 제보 수신 주소" type="url" value={draft.receiverUrl} disabled={blocked||!status} onChange={event=>edit({receiverUrl:event.target.value})} placeholder="관리자가 제공한 수신 주소"/></label><label>수신 인증 키<input aria-label="제보 전송용 수신 인증 키" type="password" autoComplete="off" value={reporterToken} disabled={blocked||!status} onChange={event=>{dirty.current=true;setReporterToken(event.target.value);setNotice('')}} placeholder={status?.hasReporterToken?'등록됨 · 변경할 때만 입력':'관리자가 제공한 키'}/></label><p className="secondary">수신 주소와 인증 키는 관리자가 한 번 제공해야 합니다. 인증 키를 비워 두면 등록된 키를 유지합니다.</p></div></details>
    <div className="control-row"><button className="primary" disabled={blocked||!status||loading} onClick={()=>void save()}>자동 제보 설정 저장</button></div>
    <div className="editor-note" role="status">{!status?'제보 설정을 확인하고 있습니다.':!status.configured?'수신 주소 또는 인증 키 미설정 · 제보는 아직 전송되지 않습니다.':active?'자동 제보 켜짐 · 문제 발생 시 진단을 전송합니다.':'자동 제보 꺼짐'}{status&&<p>전송 대기 {status.counts.queued}건 · 수신 확인 {status.counts.sent}건 · 전송 실패 {status.counts.failed}건</p>}</div>
    {status?.transportWarning&&<p className="editor-note">{status.transportWarning}</p>}
    {status&&status.outbox.length>0&&<details><summary>최근 전송 상태</summary><ul>{status.outbox.slice(0,10).map(item=><li key={item.id}>{item.reportId} · {({queued:'전송 대기',sending:'전송 중',sent:'관리자 수신 확인',failed:'전송 실패'})[item.status]} · {date(item.sentAt||item.createdAt)}{item.lastError&&<p className="import-error">{item.lastError}</p>}</li>)}</ul></details>}
    <details><summary>관리자용 · 제보 수신함 설정</summary><div className="support-controls"><label className="checkline"><input aria-label="이 관리 프로그램에서 제보 수신" type="checkbox" checked={draft.receiverEnabled} disabled={blocked||!status} onChange={event=>edit({receiverEnabled:event.target.checked})}/> 이 관리 프로그램에서 제보 수신</label><p className="secondary">관리자 컴퓨터에서 수신을 켜고 설정을 저장한 뒤, 접속 가능한 수신 주소와 인증 키를 사용자에게 전달하세요. 수신 주소 끝에는 /api/support/receive가 필요합니다.</p><button className="outline small" disabled={blocked||!status} onClick={()=>void issueKey()}>수신 인증 키 표시</button><p className="secondary">수신 인증 키는 버튼을 눌렀을 때만 표시합니다. 일반 상태 조회에서는 공개하지 않습니다.</p>{receiverKey&&<label>표시된 수신 인증 키<input aria-label="표시된 수신 인증 키" value={receiverKey} readOnly/><button className="outline small" onClick={()=>void copyKey()}>수신 인증 키 복사</button></label>}</div></details>
    {error&&<p className="import-error" role="alert">{error}</p>}{notice&&<p className="editor-note" role="status">{notice}</p>}
    <h3>관리자 제보 수신함</h3>{status?.inbox.length?<ul className="support-timeline">{status.inbox.map(item=><li key={item.receiptId}><strong>{item.reportId}</strong><p>{date(item.receivedAt)} · 발송 시도 {item.summary.attempts||0}건 · 로그 {item.summary.events||0}건 · 미확인 {item.summary.unknown||0}건</p><button className="outline small" onClick={()=>void openReport(item.receiptId)}>제보 내용 보기</button></li>)}</ul>:<p className="secondary">{status?'받은 제보가 없습니다.':'수신함 상태를 확인하고 있습니다.'}</p>}
    {inspection&&<div><div className="control-row"><h3>받은 제보 상세</h3><button className="outline small" onClick={()=>{inspectionGeneration.current++;setInspection(null)}}>제보 상세 닫기</button></div><SupportReportPreview report={inspection.report} findings={inspection.findings}/></div>}
  </section>
}
