import {useState} from 'react'
import {establishLanSession,requestErrorMessage} from './api'
import {normalizePairingCode,validPairingCode} from './lan-access'
export function LanLogin({onAuthenticated}:{onAuthenticated:()=>void}){
  const [code,setCode]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const login=async()=>{if(busy||!validPairingCode(code))return;setBusy(true);setError('');try{await establishLanSession(normalizePairingCode(code));setCode('');onAuthenticated()}catch(error){setError(requestErrorMessage(error))}finally{setBusy(false)}}
  return <div className="gate"><div className="brand-logo">D</div><h1>DICO 내부망 로그인</h1><p>중앙 PC의 설정 · 도움말 → 내부망 접속에서 발급한 일회용 코드를 입력하세요.</p><form onSubmit={event=>{event.preventDefault();void login()}}><label htmlFor="lan-pairing-code">접속 코드</label><input id="lan-pairing-code" autoFocus autoComplete="off" spellCheck={false} autoCapitalize="characters" placeholder="XXXX-XXXX-XXXX" maxLength={20} value={code} disabled={busy} onChange={event=>setCode(event.target.value)}/><p>코드는 발급 후 2분 동안 한 번만 사용할 수 있습니다. 세션이 만료되거나 중앙 프로그램을 다시 시작했다면 새 코드를 발급하세요.</p>{error&&<p role="alert">{error}</p>}<button className="primary" type="submit" disabled={busy||!validPairingCode(code)}>{busy?'로그인 중…':'코드로 로그인'}</button></form><small>로그인하면 현재 작업 공간을 조회·변경하고 발송을 시작·중지할 수 있습니다.</small></div>
}
