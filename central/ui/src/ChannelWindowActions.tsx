import type {Channel,Snapshot} from './api'
import {managedWindowAvailable} from './channel-window'

type Props={s:Snapshot;channel:Channel;busy:boolean;run:(action:string,payload:Record<string,unknown>,success?:string)=>Promise<boolean>}

export function ChannelWindowActions({s,channel,busy,run}:Props) {
  const available=managedWindowAvailable(s,channel)
  const help=available?'보기는 이 채널의 기존 전송 탭을 선택해 창을 표시합니다. 숨기기는 이 브라우저의 전송 탭들이 함께 있는 창을 최소화합니다.':'브라우저와 등록된 채널 탭의 검증 응답을 기다리고 있습니다. 누락된 등록 탭은 입력 차단과 로그인 검증 후 자동 복구합니다.'
  return <div className="channel-window-actions" title={help}>
    <button type="button" className="outline small" disabled={busy||!available} onClick={()=>void run('channel.reveal',{id:channel.id},'연결된 전송 창 표시를 요청했습니다.')}>전송 창 보기</button>
    {available&&<details className="channel-window-more"><summary aria-label={`${channel.name} 전송 창 추가 작업`}>더 보기</summary><button type="button" className="outline small" disabled={busy} onClick={()=>void run('channel.hide',{id:channel.id},'이 브라우저의 전송 창 숨기기를 요청했습니다.')}>전송 창 숨기기</button><small>이 브라우저의 전송 탭들이 있는 창 전체를 최소화합니다.</small></details>}
  </div>
}
