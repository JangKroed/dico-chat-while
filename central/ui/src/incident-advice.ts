import type { Incident, Snapshot } from './api'

type AdvicePage='connections'|'channels'|'history'|'groups'|'settings'
export type IncidentAdvice={title:string;cause:string;steps:string[];page:AdvicePage;actionLabel:string;knownReason:boolean;affected:string[];commandType?:string;rejectionCode?:string}
type Remedy=Pick<IncidentAdvice,'title'|'cause'|'steps'|'page'|'actionLabel'>
const text=(value:unknown)=>typeof value==='string'?value:undefined
const controlSteps=[
  '상단의 ‘전체 중지’를 요청하고, 모든 확장에서 중지 적용 확인 응답이 도착하는지 확인하세요.',
  '확인 응답이 계속 없으면 관리 프로그램과 모든 브라우저의 DICO 확장을 같은 최신 버전으로 업데이트하세요. 필요한 초안을 따로 보관한 뒤 Discord 탭을 새로고침하세요.',
  '브라우저를 다시 연결하고 ‘전체 중지’를 다시 요청한 뒤 중지 확인을 기다리세요.',
  '진행 중·미확인 시도는 실제 Discord 게시 내역으로 확인하세요. 중지 요청과 실행 차단은 과거 미발송의 증거가 아닙니다.'
]
const remedies:Record<string,Remedy>={
  DRAFT_MISMATCH:{title:'Discord 입력창에 다른 초안이 있습니다',cause:'설정한 문구와 다른 초안이 감지되어 확장이 입력 준비를 거절했습니다.',steps:['해당 브라우저의 전송용 Discord 탭을 열고 작성 중인 초안을 확인하세요.','필요한 초안을 다른 곳에 보관한 뒤 직접 정리하세요. 자동으로 초안을 지우지 않습니다.','채널 설정에서 대상 계정·채널과 적용 메시지를 확인하세요. 미확인 시도가 있으면 실행 기록에서 게시 여부부터 확인하세요.'],page:'channels',actionLabel:'채널·메시지 확인'},
  EDITOR_LOADING:{title:'Discord 입력창이 아직 준비되지 않았습니다',cause:'Discord 입력창을 찾지 못해 확장이 입력 준비를 거절했습니다.',steps:['해당 Discord 탭에서 채널과 입력창이 완전히 열릴 때까지 기다리세요.','계속 로딩 중이면 필요한 초안을 보관한 뒤 Discord를 새로고침하고, 메시지를 작성할 권한이 있는지 확인하세요.','채널 설정에서 실제 계정·채널의 연결 상태를 다시 확인하세요.'],page:'channels',actionLabel:'채널 상태 확인'},
  EDITOR_AMBIGUOUS:{title:'Discord 입력창이 여러 개 열려 있습니다',cause:'어느 입력창에 작성할지 확정할 수 없어 확장이 입력 준비를 거절했습니다.',steps:['전송용 Discord 탭에서 열린 스레드와 메시지 편집 창을 확인하세요.','필요한 초안을 보관하고 불필요한 편집 창·스레드를 닫아 대상 채널의 입력창을 하나만 남기세요.','채널 설정에서 대상과 연결 상태를 확인하세요.'],page:'channels',actionLabel:'대상 채널 확인'},
  ACCOUNT_UNVERIFIED:{title:'현재 Discord 계정을 확인해야 합니다',cause:'확장이 현재 로그인 계정을 검증하지 못했습니다.',steps:['해당 브라우저에서 올바른 Discord 계정으로 로그인했는지 확인하세요.','Discord 탭에서 DICO 확장을 열고 ‘현재 Discord 계정 등록’을 다시 누르세요.','등록된 계정 ID와 브라우저를 확인한 뒤 채널을 다시 연결하세요. 계정 ID를 확인할 수 없는 상태에서는 실행하지 않습니다.'],page:'connections',actionLabel:'등록 계정 확인'},
  CONFIG_MISMATCH:{title:'채널의 적용 설정이 일치하지 않습니다',cause:'확장이 가진 채널·계정 또는 구성 버전이 중앙 설정과 일치하지 않습니다.',steps:['채널 설정에서 사용할 계정과 대상 채널이 맞는지 확인하세요.','메시지 수정본과 순서를 확인하고 채널에 다시 적용한 뒤 중앙 구성과 확장 적용 버전이 같아질 때까지 기다리세요.','미확인 시도가 있으면 실행 기록에서 실제 게시 여부를 먼저 확인하세요.'],page:'channels',actionLabel:'채널 적용 상태 확인'},
  CONTENT_UNAVAILABLE:{title:'Discord 탭의 확장 응답이 없습니다',cause:'확장이 전송용 Discord 탭의 스크립트에 연결하지 못했습니다.',steps:['해당 브라우저에서 DICO 확장이 켜져 있고 최신 버전인지 확인하세요.','필요한 초안을 보관한 뒤 전송용 Discord 탭을 새로고침하세요.','현재 계정을 다시 등록하고 채널 연결·메시지 적용 상태를 확인하세요. 미확인 시도가 있으면 실제 게시 여부부터 확인하세요.'],page:'channels',actionLabel:'채널 연결 다시 확인'},
  EXTENSION_UPDATE_REQUIRED:{title:'관리 프로그램과 확장을 업데이트해야 합니다',cause:'현재 확장으로 요청한 기능을 처리할 수 없습니다.',steps:['관리 프로그램과 사용 중인 모든 브라우저의 DICO 확장을 같은 최신 버전으로 업데이트하세요.','필요한 초안을 보관한 뒤 Discord 탭을 새로고침하고 관리 프로그램에 다시 연결하세요.','계정을 다시 등록한 뒤 채널 연결과 적용 상태를 확인하세요.'],page:'settings',actionLabel:'설치·연결 진단'},
  OPEN_CHANNEL_FAILED:{title:'Discord 채널 열기를 완료하지 못했습니다',cause:'확장이 채널 열기 요청을 완료하지 못했습니다. 이 코드만으로 상세 내부 원인을 확인할 수는 없습니다.',steps:['해당 브라우저의 새 Discord 탭과 로그인 상태를 확인하세요.','채널 URL이 맞는지, 선택한 계정에 해당 서버·채널 접근 권한이 있는지 확인하세요.','확장과 관리 프로그램을 업데이트하고 계정을 다시 등록한 뒤 채널 연결을 요청하세요.'],page:'channels',actionLabel:'채널 연결 확인'},
  CONTROL_FAILED:{title:'중지·일시정지 적용을 확인해야 합니다',cause:'확장이 제어 명령을 적용하지 못했습니다. 상세 내부 원인은 확인되지 않았습니다.',steps:controlSteps,page:'groups',actionLabel:'그룹·중지 상태 확인'},
  EXECUTION_STOPPED:{title:'확장의 실행 중지 상태를 확인하세요',cause:'확장이 실행 중지 상태여서 요청을 거절했습니다.',steps:['그룹과 확장의 중지 상태를 확인하세요.','진행 중·미확인 시도는 실제 Discord 게시 내역을 확인한 뒤 실행 기록에서 처리하세요.','중지 적용 확인과 게시 여부 확인이 끝난 뒤 그룹의 준비 항목을 다시 점검하세요.'],page:'groups',actionLabel:'그룹 상태 확인'},
  TARGET_MISMATCH:{title:'전송용 Discord 탭의 채널이 바뀌었습니다',cause:'전송용 탭의 실제 채널이 설정한 대상과 일치하지 않습니다.',steps:['해당 브라우저에서 전송용 Discord 탭의 URL과 로그인 계정을 확인하세요.','채널 설정에서 대상 채널을 다시 연결하고 검증 결과를 기다리세요.','미확인 시도가 있으면 실행 기록에서 실제 게시 내역을 먼저 확인하세요.'],page:'channels',actionLabel:'대상 채널 확인'},
  ATTACHMENT_OR_REPLY:{title:'Discord 입력창의 첨부·답장 상태를 정리하세요',cause:'입력창에서 첨부파일 또는 답장 상태가 감지되어 요청이 거절됐습니다.',steps:['해당 Discord 탭에서 첨부파일·답장·작성 중인 초안을 확인하세요.','필요한 내용을 따로 보관한 뒤 직접 첨부·답장 상태를 정리하세요.','채널 설정의 대상과 메시지 적용 상태를 확인하세요.'],page:'channels',actionLabel:'채널·메시지 확인'}
}
remedies.OPEN_CHANNEL_UNSUPPORTED=remedies.EXTENSION_UPDATE_REQUIRED

export function isIncidentOpen(i:Incident) {return !i.resolvedAt&&!['resolved','closed'].includes(String(i.status||''))}
export function incidentState(i:Incident) {return `${isIncidentOpen(i)?'미해결':'해결됨'} · ${i.readAt||i.read?'읽음':'읽지 않음'}`}
export function incidentAdvice(i:Incident,s:Snapshot):IncidentAdvice {
  const command=s.commands?.find(c=>c.id===i.commandId),payload=command?.payload as Record<string,unknown>|undefined
  const attemptId=text(i.attemptId)||text(payload?.attemptId),attempt=s.attempts.find(a=>a.id===attemptId)
  const bindingId=text(i.bindingId)||text(payload?.bindingId)||attempt?.bindingId,binding=s.channels.find(c=>c.id===bindingId)
  const groupId=i.groupId||text(payload?.groupId)||attempt?.groupId
  const groups=groupId?s.groups.filter(g=>g.id===groupId):binding?s.groups.filter(g=>g.members?.includes(binding.id)):[]
  const group=groups[0]
  const instanceId=text(i.instanceId)||text(command?.instanceId)||binding?.instanceId||text(attempt?.instanceId)
  const instance=s.instances.find(b=>b.id===instanceId)
  const guildId=text(i.guildId)||text(payload?.guildId)||binding?.guildId||group?.guildId,channelId=text(i.channelId)||text(payload?.channelId)||binding?.channelId||group?.channelId
  const targetId=text(i.targetId)||text(payload?.targetId)
  const target=s.targets?.find(t=>t.id===targetId||Boolean(guildId&&channelId&&t.guildId===guildId&&t.channelId===channelId))
  const affected=[...(instance?['브라우저: '+instance.name]:instanceId?['브라우저: '+instanceId]:[]),...(groups.length?groups.map(g=>'그룹: '+g.name):groupId?['그룹: '+groupId]:[]),...(target?['채널: #'+target.name]:binding?['채널: #'+binding.name]:channelId?['채널 ID: '+channelId]:[])]
  const commandType=text(i.commandType)||text(command?.type),rejectionCode=text(i.rejectionCode)||text(command?.rejectionCode)
  let remedy:Remedy,knownReason=false
  if(i.code==='command_rejected'){
    const known=rejectionCode?remedies[rejectionCode]:undefined
    if(known){remedy=known;knownReason=true}
    else if(commandType==='CONTROL')remedy={title:'중지·일시정지 적용을 확인해야 합니다',cause:'상세 거절 사유가 기록되지 않았습니다. 제어 명령이 적용되지 않았으므로 중지 완료로 판단할 수 없습니다.',steps:controlSteps,page:'groups',actionLabel:'그룹·중지 상태 확인'}
    else remedy={title:'확장 요청을 확인해야 합니다',cause:'상세 거절 사유가 기록되지 않았습니다. 현재 기록만으로 초안·계정·버전 등의 원인을 단정할 수 없습니다.',steps:['아래 대상 브라우저와 확장 상태를 확인하세요.','진행 중·미확인 시도가 있으면 전체 중지를 요청하고 실제 Discord 게시 내역을 확인하세요. 중지만으로 미발송 여부를 판단하지 마세요.','관리 프로그램과 모든 확장을 업데이트하고 필요한 초안을 보관한 뒤 Discord를 새로고침하세요. 같은 문제가 반복되면 새로 기록된 거절 사유를 확인하세요.'],page:attempt?.status==='unknown'?'history':commandType==='OPEN_CHANNEL'||commandType==='CONFIG_SYNC'?'channels':'connections',actionLabel:attempt?.status==='unknown'?'미확인 실행 기록 확인':commandType==='OPEN_CHANNEL'||commandType==='CONFIG_SYNC'?'채널·적용 상태 확인':'계정·브라우저 확인'}
  }else if(i.code==='delivery_unknown'){
    remedy={title:'실제 Discord 게시 여부를 확인해야 합니다',cause:'발송 시도의 실제 게시 여부가 확정되지 않아 자동 진행이 멈췄습니다.',steps:['전체 중지를 요청하고 확장의 실행 차단 확인을 기다리세요.','해당 계정·채널의 실제 Discord 게시 내역을 확인하세요. 중지와 실행 차단은 과거 미발송의 증거가 아닙니다.','실행 기록에서 게시된 메시지 ID를 입력하거나 실제 미발송을 확인한 경우에만 결과를 확정하세요. 확인되지 않은 시도를 다시 보내지 마세요.'],page:'history',actionLabel:'미확인 실행 기록 확인'};knownReason=true
  }else if(i.code==='connection_lost'){
    remedy={title:'브라우저 연결이 끊겼습니다',cause:'중앙 관리 프로그램이 해당 브라우저의 연결을 유지하지 못했습니다.',steps:['해당 브라우저와 DICO 확장이 실행 중인지 확인하고 관리 프로그램에 다시 연결하세요.','계정 등록과 채널 검증 상태를 확인하세요.','진행 중·미확인 발송은 실제 Discord 게시 내역을 확인한 뒤 실행 기록에서 처리하세요.'],page:'connections',actionLabel:'브라우저 연결 확인'};knownReason=true
  }else if(i.code==='account_mismatch'){
    remedy=remedies.ACCOUNT_UNVERIFIED;knownReason=true
  }else if(i.code==='storage_failure'){
    remedy={title:'설정을 저장하는 데 문제가 있습니다',cause:'관리 프로그램이 로컬 데이터를 정상적으로 저장하지 못했습니다.',steps:['새 발송을 시작하지 말고 설정·도움말의 설치 진단을 확인하세요.','저장 공간과 데이터 폴더 접근 권한을 확인하세요.','진행 중·미확인 발송이 있으면 실제 Discord 게시 여부도 확인하세요.'],page:'settings',actionLabel:'설치·저장 환경 확인'};knownReason=true
  }else{
    remedy={title:i.title||'확인할 문제가 있습니다',cause:i.description||i.message||'서비스에 확인이 필요한 상태가 기록되었습니다. 상세 정보와 대상 상태를 확인하세요.',steps:['관련 브라우저·그룹 상태와 최근 로그를 확인하세요.','미확인 발송은 실제 Discord 게시 내역을 확인하기 전까지 다시 보내지 마세요.'],page:attemptId?'history':'settings',actionLabel:attemptId?'관련 실행 기록 확인':'설치·서비스 상태 확인'}
  }
  return {...remedy,knownReason,affected,commandType,rejectionCode}
}
export function visibleIncidents(s:Snapshot,includeResolved=false,query='') {
  const q=query.trim().toLocaleLowerCase()
  return [...s.incidents].reverse().filter(i=>{
    if(!includeResolved&&!isIncidentOpen(i))return false
    const a=incidentAdvice(i,s)
    return `${a.title} ${a.cause} ${a.affected.join(' ')} ${i.code||''} ${a.rejectionCode||''}`.toLocaleLowerCase().includes(q)
  })
}
