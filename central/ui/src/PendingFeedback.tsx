import {useEffect,useState} from 'react'
import type {ActionPhase} from './action-feedback'

export type PendingAction={action:string;phase:ActionPhase;startedAt:number}
const labels:Record<string,string>={'service.stopAll':'전체 중지','service.startAll':'모두 실행','group.stop':'그룹 중지','group.start':'그룹 실행','channel.connect':'계정·채널 연결','channel.reveal':'전송 창 표시','channel.hide':'전송 창 숨기기','channel.delete':'연결 해제','target.delete':'채널 삭제','account.delete':'계정 삭제','instance.delete':'브라우저 삭제','settings.update':'설정 저장','channel.playlist':'메시지 목록 저장','target.create':'채널 추가','message.create':'메시지 추가','message.update':'메시지 저장'}
export function PendingFeedback({items}:{items:Record<string,PendingAction>}){
 const [now,setNow]=useState(()=>performance.now())
 const active=Object.keys(items).length>0
 useEffect(()=>{if(!active)return;setNow(performance.now());const timer=window.setInterval(()=>setNow(performance.now()),1000);return()=>window.clearInterval(timer)},[active])
 if(!active)return null
 return <aside className="work-feedback" aria-label="처리 중인 작업">
  {Object.entries(items).map(([key,item])=>{const seconds=Math.max(0,Math.floor((now-item.startedAt)/1000));return <div className="work-feedback-row" key={key}>
   <span className="work-spinner" aria-hidden="true"/><div role="status"><strong>{labels[item.action]||'변경 사항 적용'} · {item.phase==='refreshing'?'접수 완료 · 화면 갱신 중':'요청 처리 중'}</strong><p>{seconds>=10?(item.phase==='refreshing'?'요청은 접수됐습니다. 최신 상태 수신이 지연되고 있습니다.':'응답이 늦어지고 있습니다. 아직 성공·실패를 확인하지 못했습니다. 중복 요청 없이 응답을 기다립니다.'):'잠시 기다려 주세요. 같은 작업을 다시 누르지 않아도 됩니다.'}</p></div><span className="work-elapsed" aria-label="대기 시간">{seconds}초</span>
  </div>})}
 </aside>
}
