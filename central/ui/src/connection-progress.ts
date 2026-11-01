import type {Instance,Snapshot} from './api'
import {browserOnline} from './onboarding.ts'
export function connectionProgress(s:Snapshot,instance:Instance){
 const channels=s.channels.filter(c=>c.instanceId===instance.id),accounts=s.accounts?.filter(a=>a.instanceId===instance.id)||[]
 const progress=instance.connectionProgress as {stage?:string;reasonCode?:string}|undefined
 const verified=channels.filter(c=>c.verified).length,applied=channels.filter(c=>c.verified&&c.playlist.length&&c.configVersion===c.appliedVersion).length
 const account=accounts.some(a=>a.verified),online=browserOnline(instance)
 let label='연결 상태 확인 중'
 if(!online)label='브라우저 연결 대기'
 else if(instance.legacyFrozen!==true||instance.legacyPending!==false)label='기존 실행기 확인 필요'
 else if(progress?.stage==='blocked'&&progress.reasonCode==='ATTEMPT_UNRESOLVED')label='이전 발송 결과 확인 필요'
 else if(!account)label='로그인 계정 확인 중'
 else if(!channels.length)label='사용할 채널을 추가하세요'
 else if(verified<channels.length)label=`채널 확인 중 · ${verified}/${channels.length}`
 else if(applied<channels.length)label='메시지 선택·설정 적용 확인 중'
 else label='연결·설정 완료'
 return{label,verified,total:channels.length,applied,steps:[online,online&&account,online&&account&&channels.length>0&&verified===channels.length,online&&account&&channels.length>0&&applied===channels.length]}
}
