import {useRef,useState} from 'react'
import type {Channel,Snapshot} from './api'
import {managedWindowAvailable} from './channel-window'

type Props={s:Snapshot;channel:Channel;busy:boolean;run:(action:string,payload:Record<string,unknown>,success?:string)=>Promise<boolean>}

export function ChannelWindowActions({s,channel,busy,run}:Props) {
  const available=managedWindowAvailable(s,channel)
  const lock=useRef(false),[requesting,setRequesting]=useState<string|null>(null)
  const pending=(s.commands||[]).find(c=>c.type==='MANAGE_WINDOW'&&c.instanceId===channel.instanceId&&['queued','received'].includes(String(c.status))&&(c.payload as {bindingId?:string})?.bindingId===channel.id)
  const working=requesting||Boolean(pending)
  const act=async(action:'reveal'|'hide')=>{if(lock.current||pending)return;lock.current=true;setRequesting(action);try{await run(`channel.${action}`,{id:channel.id},action==='reveal'?'전송 창 표시를 요청했습니다. 브라우저 응답을 기다립니다.':'전송 창 숨기기를 요청했습니다. 브라우저 응답을 기다립니다.')}finally{lock.current=false;setRequesting(null)}}
  const help=available?'보기는 이 채널의 기존 전송 탭을 선택해 창을 표시합니다. 숨기기는 이 브라우저의 전송 탭들이 함께 있는 창을 최소화합니다.':'브라우저와 등록된 채널 탭의 검증 응답을 기다리고 있습니다. 누락된 등록 탭은 입력 차단과 로그인 검증 후 자동 복구합니다.'
  return <div className="channel-window-actions" title={help}>
    <button type="button" className="outline small" disabled={busy||!available||Boolean(working)} onClick={()=>void act('reveal')}>{working?<><span className="work-spinner" aria-hidden="true"/>창 작업 처리 중…</>:'전송 창 보기'}</button>
    {available&&<details className="channel-window-more"><summary aria-label={`${channel.name} 전송 창 추가 작업`}>더 보기</summary><button type="button" className="outline small" disabled={busy||Boolean(working)} onClick={()=>void act('hide')}>전송 창 숨기기</button><small>이 브라우저의 전송 탭들이 있는 창 전체를 최소화합니다.</small></details>}
  {pending&&<small role="status">브라우저가 창 작업을 적용하는 중입니다.</small>}
  </div>
}
