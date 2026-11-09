import {useEffect,useState} from 'react'
import {getLatestUpdate,type LatestUpdate} from './api'

const dismissedKey='dico.dismissedUpdateVersion'
const readDismissed=()=>{try{return localStorage.getItem(dismissedKey)||''}catch{return ''}}
export function UpdateNotice({connected,onOpen}:{connected:boolean;onOpen:()=>void}){
 const [latest,setLatest]=useState<LatestUpdate|null>(null),[dismissed,setDismissed]=useState(readDismissed)
 useEffect(()=>{const sync=()=>setDismissed(readDismissed());window.addEventListener('storage',sync);return()=>window.removeEventListener('storage',sync)},[])
 useEffect(()=>{
  if(!connected)return;
  let active=true,timer=0,controller:AbortController|null=null;
  const check=async()=>{
   controller=new AbortController();const timeout=window.setTimeout(()=>controller?.abort(),15000)
   try{const next=await getLatestUpdate(controller.signal);if(active&&next.state!=='unavailable')setLatest(next)}catch{/* 조회 실패로 이미 확인한 새 버전 안내를 지우지 않습니다. */}
   finally{window.clearTimeout(timeout);if(active)timer=window.setTimeout(()=>void check(),300000)}
  }
  void check();return()=>{active=false;window.clearTimeout(timer);controller?.abort()}
 },[connected])
 if(!connected||latest?.state!=='available'||!latest.latestVersion||latest.latestVersion===dismissed)return null
 const dismiss=()=>{setDismissed(latest.latestVersion!);try{localStorage.setItem(dismissedKey,latest.latestVersion!)}catch{}}
 return <section className="callout version-banner" role="status" aria-label="새 업데이트 안내"><div><strong>DICO {latest.latestVersion} 업데이트가 준비됐습니다.</strong><p>현재 {latest.currentVersion} · 설정에서 변경 사항을 확인하고 업데이트할 수 있습니다.</p></div><button className="primary small" onClick={()=>{window.dispatchEvent(new Event('dico:check-update'));onOpen()}}>업데이트 확인</button><button className="text-action" aria-label="이 버전 업데이트 알림 닫기" onClick={dismiss}>나중에</button></section>
}
