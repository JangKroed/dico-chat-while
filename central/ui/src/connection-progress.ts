import type {Instance,Snapshot} from './api'
import {browserOnline} from './onboarding.ts'
export function connectionProgress(s:Snapshot,instance:Instance){
 const channels=s.channels.filter(c=>c.instanceId===instance.id),accounts=s.accounts?.filter(a=>a.instanceId===instance.id)||[]
 const progress=instance.connectionProgress as {stage?:string;reasonCode?:string}|undefined
 const verified=channels.filter(c=>c.verified).length,applied=channels.filter(c=>c.verified&&c.playlist.length&&c.configVersion===c.appliedVersion).length
 const account=accounts.some(a=>a.verified),online=browserOnline(instance,s.serverNow??Date.now())
 let label='연결 상태 확인 중'
 if(!online)label='브라우저 연결 대기'
 else if(instance.legacyFrozen!==true||instance.legacyPending!==false)label='기존 실행기 확인 필요'
 else if(progress?.stage==='blocked'&&progress.reasonCode==='ATTEMPT_UNRESOLVED')label='이전 발송 결과 자동 대조 대기'
 else if(progress?.stage==='blocked')label='연결 복구 조건 대기'
 else if(!account)label='로그인 계정 확인 중'
 else if(!channels.length)label='사용할 채널을 추가하세요'
 else if(verified<channels.length)label=`채널 확인 중 · ${verified}/${channels.length}`
 else if(applied<channels.length)label='메시지 선택·설정 적용 확인 중'
 else label='연결·설정 완료'
 const blocked=progress?.stage==='blocked'||!online||instance.legacyFrozen!==true||instance.legacyPending!==false
 const steps=[online,online&&account,online&&account&&channels.length>0&&verified===channels.length,online&&account&&channels.length>0&&applied===channels.length]
 return{label,verified,total:channels.length,applied,steps,completed:steps.filter(Boolean).length,blocked,ready:steps.every(Boolean)&&!blocked}
}

/** The extension supplies these names until a person saves a browser alias. */
export function browserDisplayName(instance:Instance):string {
 const name=instance.name?.trim()
 if(instance.nameCustomized===true)return name||instance.browser||'브라우저'
 const generated=['Connected browser','연결된 Chromium',`연결된 ${instance.browser||''}`]
 if(!name||generated.includes(name))return instance.browser||'브라우저'
 return name
}
