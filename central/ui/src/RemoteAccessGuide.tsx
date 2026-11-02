import {useEffect,useState} from 'react'
import {createRemoteAccessLink,requestErrorMessage} from './api'
import {remoteAccessAddress,validRemoteAccessLink} from './remote-access'

const appleHelp='https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac'
const windowsHelp='https://learn.microsoft.com/ko-kr/windows-server/administration/openssh/openssh_install_firstuse'

export function RemoteAccessGuide({busy=false,href=typeof window==='undefined'?'':window.location.href}:{busy?:boolean;href?:string}){
  const address=remoteAccessAddress(href)
  const [os,setOs]=useState<'mac'|'windows'>('mac'),[link,setLink]=useState<{url:string;expiresAt:number}|null>(null),[issuing,setIssuing]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('')
  useEffect(()=>{
    if(!link)return
    const timeout=setTimeout(()=>{setLink(null);setNotice('접속 링크가 만료됐습니다. 필요하면 새 링크를 만들어 주세요.')},Math.max(0,Math.min(120000,link.expiresAt-Date.now())))
    return()=>clearTimeout(timeout)
  },[link])
  const copy=async(text:string,label:string)=>{setError('');try{await navigator.clipboard.writeText(text);setNotice(`${label}를 복사했습니다.`)}catch{setError('클립보드에 복사하지 못했습니다. 아래 텍스트를 직접 선택해 복사해 주세요.')}}
  const issue=async()=>{
    if(!address||busy||issuing)return
    if(!confirm('이 링크로 로그인한 브라우저는 현재 작업 공간의 메시지·계정·설정을 조회·변경하고 발송을 시작·중지할 수 있습니다. 본인이 사용하는 다른 PC에만 전달할 2분짜리 일회용 접속 링크를 만들까요?'))return
    setIssuing(true);setLink(null);setError('');setNotice('')
    try{const result=await createRemoteAccessLink();if(!validRemoteAccessLink(result,address.origin))throw Error('접속 주소 또는 만료 시간을 확인할 수 없습니다. 중앙 PC의 시간을 확인하고 다시 시도해 주세요.');setLink(result);setNotice('2분 안에 다른 PC의 브라우저 주소창에 붙여 넣으세요. 이 PC에서 열면 일회용 링크가 먼저 사용됩니다.')}
    catch(error){setError(requestErrorMessage(error))}finally{setIssuing(false)}
  }
  return <section className="panel" aria-label="다른 PC에서 관리 화면 열기"><div className="panel-head"><div><h2>다른 PC에서 관리 화면 열기</h2><p>같은 사용자가 다른 PC에서 중앙 PC의 관리 화면을 조작하는 방법입니다.</p></div></div>
    <p>현재 실행 중인 중앙 PC와 Discord 브라우저는 계속 켜 두세요. 다른 PC의 Discord 계정을 이 중앙 PC에 연결하는 여러 PC 실행기 기능은 아직 지원하지 않습니다.</p>
    <details><summary>SSH 터널 연결 방법</summary>
      <ol>
        <li><strong>중앙 PC에서 SSH 접속 준비</strong><p>중앙 PC 운영체제를 선택하세요. OS 설정과 SSH 계정 준비는 사용자가 직접 진행합니다.</p><select aria-label="중앙 PC 운영체제" value={os} onChange={e=>setOs(e.target.value as 'mac'|'windows')}><option value="mac">macOS</option><option value="windows">Windows</option></select>
          {os==='mac'?<p>시스템 설정 → 일반 → 공유 → 원격 로그인에서 사용할 OS 계정만 허용합니다. 표시되는 SSH 사용자 이름과 중앙 PC 주소를 확인하세요. 전체 디스크 접근 허용은 이 터널에 필요하지 않습니다. <a href={appleHelp} target="_blank" rel="noreferrer">Apple 원격 로그인 안내</a></p>:<p>선택적 기능에서 OpenSSH Server를 준비하고 OpenSSH SSH Server 서비스를 실행합니다. 다른 PC에는 OpenSSH Client가 필요합니다. 허용 계정과 SSH 접속 범위는 사설망 또는 VPN으로 제한하세요. <a href={windowsHelp} target="_blank" rel="noreferrer">Microsoft OpenSSH 안내</a></p>}
        </li>
        <li><strong>다른 PC에서 터널 실행</strong><p>먼저 macOS 터미널에서 <code>ssh -V</code>, Windows PowerShell에서 <code>Get-Command ssh</code>로 SSH 클라이언트를 확인하세요. Windows에서 찾지 못하면 선택적 기능의 OpenSSH Client를 직접 설치합니다.</p><p>같은 내부망이면 중앙 PC의 사설 IP나 호스트 이름을 사용합니다. 서로 다른 내부망이면 먼저 두 PC를 신뢰하는 VPN으로 연결하고 중앙 PC의 VPN 주소를 사용합니다. 공유기에 중앙 관리 포트나 SSH 포트를 공인 공개하는 방식은 사용하지 않습니다.</p>
          {address?<><p>다른 PC의 macOS 터미널 또는 Windows PowerShell에서 아래 명령을 실행하세요. <code>SSH_USER</code>는 중앙 PC의 OS 사용자 이름, <code>CENTRAL_HOST</code>는 중앙 PC의 사설망·VPN 주소로 바꿉니다. DICO나 Discord 계정 이름을 넣는 곳이 아닙니다.</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}><code>{address.command}</code></pre><button type="button" className="outline small" onClick={()=>void copy(address.command,'터널 명령')}>터널 명령 복사</button><p>양쪽 포트는 반드시 {address.port}로 같아야 합니다. 접속 주소도 <code>{address.origin}/</code> 그대로 사용하고 localhost나 중앙 PC의 IP로 바꾸지 마세요. 다른 PC에서 같은 포트를 사용 중이면 해당 프로그램을 확인한 뒤 터널을 다시 실행하세요.</p></>:<p role="alert">정확한 중앙 관리 주소를 확인할 수 없습니다. 중앙 PC에서 관리 프로그램을 통해 127.0.0.1 주소로 이 화면을 다시 여세요.</p>}
          <p>처음 연결할 때 SSH 호스트 지문이 중앙 PC와 일치하는지 확인하고 OS 계정으로 인증합니다. 터널 터미널은 열린 상태로 유지하세요.</p>
        </li>
        <li><strong>이 화면에서 일회용 접속 링크 만들기</strong><p>터널이 연결된 뒤 아래 버튼으로 링크를 만드세요. 링크를 받은 브라우저에는 현재 작업 공간의 전체 관리 권한이 부여됩니다. 본인의 다른 PC에만 전달하고 채팅방·공개 문서에 남기지 마세요. 현재 주소창 복사만으로는 새 브라우저에 로그인되지 않습니다.</p><button type="button" className="primary small" disabled={busy||issuing||!address} onClick={()=>void issue()}>{issuing?'링크 만드는 중…':'2분짜리 접속 링크 만들기'}</button>
          {link&&<div><label>다른 PC에서 한 번 사용할 접속 링크<input aria-label="일회용 원격 접속 링크" readOnly spellCheck={false} value={link.url} onFocus={e=>e.target.select()}/></label><button type="button" className="outline small" onClick={()=>void copy(link.url,'접속 링크')}>접속 링크 복사</button><p>다른 PC 주소창에서 2분 안에 한 번 사용하세요. 로그인하면 링크의 인증 부분이 주소창에서 제거됩니다. 로그인 세션은 최대 12시간 유지되며, 만료되면 새 링크가 필요합니다.</p></div>}
        </li>
      </ol>
      <p>사용을 마치면 다른 PC에서 관리 탭을 닫고 터널 터미널에서 Ctrl+C를 누르세요. 터널 종료는 중앙 PC의 발송을 중지하지 않습니다. 발송을 멈추려면 연결된 관리 화면에서 그룹 중지 적용을 먼저 확인하세요.</p>
      <p>연결 거부: 중앙 PC 실행·SSH·VPN 상태를 확인하세요. 허용되지 않은 요청 출처: 양쪽 포트와 127.0.0.1 주소를 확인하세요. 페이지 연결 만료: 터널을 유지한 채 새 접속 링크를 만들어 주세요.</p>
    </details>
    {notice&&<p role="status">{notice}</p>}{error&&<p role="alert" className="import-error">{error}</p>}
  </section>
}
