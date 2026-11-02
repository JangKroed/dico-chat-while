import type {Channel,Snapshot} from './api'
import {managedWindowAvailable} from './channel-window'

type Props={s:Snapshot;channel:Channel;busy:boolean;run:(action:string,payload:Record<string,unknown>,success?:string)=>Promise<boolean>}

export function ChannelWindowActions({s,channel,busy,run}:Props) {
  const available=managedWindowAvailable(s,channel)
  const help=available?'보기는 이 채널의 기존 전송 탭을 선택해 창을 표시합니다. 숨기기는 이 채널만 담긴 전송 창을 최소화합니다. 여러 탭이 있는 창은 계정·브라우저에서 채널별로 분리해 주세요.':'브라우저가 연결돼 있고 확장이 최신 버전인지 확인해 주세요. 전송 탭이 닫혔다면 채널 설정에서 다시 연결해야 합니다.'
  return <div className="channel-window-actions" title={help}>
    <button type="button" className="outline small" disabled={busy||!available} onClick={()=>void run('channel.reveal',{id:channel.id},'연결된 전송 창 표시를 요청했습니다.')}>전송 창 보기</button>
    {available&&<details className="channel-window-more"><summary aria-label={`${channel.name} 전송 창 추가 작업`}>더 보기</summary><button type="button" className="outline small" disabled={busy} onClick={()=>void run('channel.hide',{id:channel.id},'이 채널의 전송 창 숨기기를 요청했습니다.')}>전송 창 숨기기</button><small>이 채널만 담긴 창을 최소화합니다.</small></details>}
  </div>
}
