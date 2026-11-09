import type {Account,Channel,Snapshot} from './api'
import {browserOnline} from './onboarding'
import {channelVerification} from './channel-window'

// 응답 지연은 재등록 실패와 구분합니다. 실제 검증 실패 사유는 그대로 보여 줍니다.
export function ChannelConnectionStatus({s,account,binding,pending}:{s:Snapshot;account:Account;binding?:Channel;pending:boolean}){
 const instance=s.instances.find(i=>i.id===account.instanceId)
 const online=browserOnline(instance,s.serverNow??Date.now())
 const ready=online&&account.verified&&binding?.verified&&!pending
 const problem=binding&&!binding.verified&&!['awaiting_observation','tab_loading','session_changed','connection_lost'].includes(binding.verificationReason||'')
 const waiting=!problem&&(pending||!online||!account.verified||Boolean(binding&&!binding.verified&&['awaiting_observation','tab_loading','session_changed','connection_lost'].includes(binding.verificationReason||'')))
 let title='연결 전',detail='이 계정을 선택해 채널에 추가할 수 있습니다.'
 if(pending){title='채널 여는 중';detail='요청을 접수했습니다. 브라우저의 계정·채널 확인을 기다립니다.'}
 else if(!online){title='브라우저 응답 대기';detail='최근 응답이 없습니다. 브라우저가 실행 중이면 자동 연결을 기다립니다.'}
 else if(problem&&binding){const verification=channelVerification(binding);title=verification.title;detail=verification.action}
 else if(!account.verified){title='로그인 계정 확인 중';detail='브라우저 연결은 유지 중입니다. 계정 확인 결과를 기다립니다.'}
 else if(ready){title='연결 완료';detail='다시 선택할 필요가 없습니다. 아래에서 메시지를 설정하세요.'}
 else if(binding){const verification=channelVerification(binding);title=verification.title;detail=verification.action}
 return <span className={`account-connection-state ${ready?'verified':''} ${waiting?'waiting':''}`}><strong>{waiting&&<span className="work-spinner" aria-hidden="true"/>}{ready?'✓ ':''}{title}</strong><small>{detail}</small></span>
}
