import type { Incident, Snapshot } from './api'
import {accountLabel} from './account-label.ts'
import {unknownDeliveryCause} from './delivery-evidence.ts'
import {channelVerification} from './channel-window.ts'

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
remedies.COOLDOWN_UNVERIFIED={title:'Discord 실제 남은 대기 시간을 확인해야 합니다',cause:'Discord 화면의 남은 대기 시간을 신뢰할 수 있게 읽지 못해 입력 준비 요청을 중단했습니다. 설정된 슬로우 모드만으로 실제 제한 해제를 판단하지 않습니다.',steps:['해당 브라우저의 전송용 Discord 탭에서 서버 채널·입력창과 남은 대기 표시를 확인하세요.','Discord의 대기 제한이 실제로 해제되는지 확인하세요. 계속 읽히지 않으면 필요한 초안을 보관한 뒤 Discord 탭을 새로고침하고 계정·채널을 다시 검증하세요.','관리 프로그램과 확장이 같은 최신 상태인지 확인하세요.','미확인 시도는 전체 중지·적용 확인 후 실제 Discord 게시 내역을 확인하세요. 확인되지 않은 시도를 다시 보내지 마세요.'],page:'channels',actionLabel:'채널·대기 상태 확인'}
remedies.PREPARE_WAIT_TIMEOUT={title:'입력 준비 대기가 만료됐습니다',cause:'입력 준비 대기가 허용된 범위를 넘었거나 시간 변화가 감지되어 중단됐습니다. 남은 초안과 실행 결과를 다시 확인해야 합니다.',steps:['그룹의 현재 차례와 전송용 Discord 탭의 로그인 계정·채널·대기 표시를 확인하세요.','필요한 초안을 보관하세요. 화면 로딩이나 대기 표시가 멈춰 있으면 Discord 탭을 새로고침하고 채널을 다시 검증하세요.','그룹을 중지하고 모든 확장의 확인 응답을 기다리세요. 미확인 시도는 실제 Discord 게시 내역으로 확인한 뒤 실행 기록에서 처리하세요.','게시 여부와 적용 상태가 확인되기 전에는 같은 문구를 다시 보내지 마세요.'],page:'groups',actionLabel:'그룹·준비 상태 확인'}
remedies.DRAFT_INSPECTION_UNAVAILABLE={...remedies.CONTENT_UNAVAILABLE,title:'기존 입력 내용을 확인하지 못했습니다',cause:'입력창의 기존 문구를 비교하지 못해 교체와 발송 준비를 중단했습니다.'}
remedies.DRAFT_BACKUP_FULL={...remedies.DRAFT_MISMATCH,title:'보관한 초안을 정리해야 합니다',cause:'초안 보관 공간이 가득 차 기존 문구를 덮어쓰지 않았습니다.',steps:['확장 사이드패널의 ‘교체 전에 보관한 초안’에서 필요한 원문을 복사하세요.','보관 내용을 확인한 뒤 ‘보관한 초안 모두 삭제’로 공간을 확보하세요.','현재 채널과 메시지를 확인하고 다시 준비하세요. 미확인 발송은 실제 게시 여부부터 확인하세요.']}
remedies.DRAFT_BACKUP_INVALID={...remedies.DRAFT_MISMATCH,title:'기존 초안을 안전하게 보관하지 못했습니다',cause:'기존 원문을 보관할 수 없어 입력 내용을 교체하지 않았습니다.'}
remedies.COOLDOWN_WAIT_TIMEOUT={...remedies.COOLDOWN_UNVERIFIED,title:'Discord 제한 해제 대기가 만료됐습니다',cause:'지원하는 대기 시간을 넘겨 초안과 현재 차례를 보존하고 멈췄습니다.'}
remedies.PRE_ENTER_WAIT_CANCELLED={...remedies.EXECUTION_STOPPED,title:'발송 대기 중 실행이 차단됐습니다',cause:'중지·연결·세션·설정 상태가 바뀌어 Enter 전에 실행을 차단했습니다.'}
remedies.OPEN_CHANNEL_UNSUPPORTED=remedies.EXTENSION_UPDATE_REQUIRED
remedies.PREPARE_FAILED={title:'Discord 입력 준비를 완료하지 못했습니다',cause:'확장이 입력 준비 중 오류를 보고했습니다. 이 코드에는 상세 내부 원인이 기록되지 않았습니다.',steps:['아래 대상의 ‘전송 창 보기’를 눌러 로그인 계정·채널과 입력창을 확인하세요.','다른 초안·첨부·답장이 있으면 필요한 내용을 보관한 뒤 정리하고, 채널 설정에서 메시지 적용 상태를 확인하세요.','실행 기록에서 해당 시도의 최종 결과를 확인하세요. 미확인 상태이면 실제 게시 내역 확인 전에는 다시 보내지 마세요.'],page:'channels',actionLabel:'입력 준비 상태 확인'}
remedies.PREPARE_REJECTED={...remedies.PREPARE_FAILED,title:'Discord 입력 준비 확인이 거절됐습니다',cause:'전송용 탭에서 입력 준비 완료를 확인하지 못했습니다. 이 코드만으로 계정·초안·대기 상태 중 어느 항목이 원인인지는 알 수 없습니다.'}
remedies.MANAGED_DELAY_UNAVAILABLE={title:'전송 탭의 대기 연결을 확인하지 못했습니다',cause:'전송용 Discord 탭이 브라우저 확장의 대기 응답을 확인하지 못해 진행을 중단했습니다. 이 연결 오류만으로 과거 게시 여부를 판단할 수 없습니다.',steps:['해당 브라우저의 DICO 확장과 관리 프로그램 연결 상태를 확인하세요.','실행 기록에 미확인 시도가 있으면 해당 그룹의 중지 적용과 실행 차단을 확인하고 실제 Discord 게시 내역을 확인하세요.','남은 초안을 보관한 뒤 전송용 Discord 탭을 새로고침하고 계정·채널 연결 상태를 확인하세요.'],page:'channels',actionLabel:'전송 탭 연결 확인'}
remedies.RETRY_CANCELLED={title:'같은 메시지의 재시도가 중단됐습니다',cause:'재시도 중 중지 요청 또는 연결·세션 상태 변화를 확인해 추가 전송을 중단했습니다. 이전 전송의 게시 여부는 별도로 확인해야 합니다.',steps:['실행 기록에서 실행 차단 확인과 해당 계정·채널을 확인하세요.','실제 Discord 게시 내역을 확인하고 미확인 결과를 확정하세요. 미발송이 확인되기 전에는 같은 문구를 다시 보내지 마세요.'],page:'history',actionLabel:'재시도 결과 확인'}
remedies.RETRY_DELIVERY_AMBIGUOUS={...remedies.RETRY_CANCELLED,title:'게시 흔적이 있어 추가 재시도를 중단했습니다',cause:'이전 Enter 이후 게시 흔적이나 입력창 변화가 관측되어 추가 전송을 중단했습니다. 중복 발송을 피하려면 실제 게시 내역으로 이전 결과를 확인해야 합니다.'}
remedies.CLOCK_UNSAFE={title:'시간 흐름을 다시 확인해야 합니다',cause:'처리 간격 또는 시계 흐름이 허용 범위를 벗어나 새 발송을 멈췄습니다. 절전 복귀나 긴 처리 지연으로도 발생할 수 있으며, 기존 발송 결과는 별도로 확인해야 합니다.',steps:['관리 프로그램과 해당 브라우저가 실행 중인지 확인하세요.','미확인 시도는 중지 적용과 실행 차단을 확인한 뒤 실제 Discord 게시 내역으로 결과를 확정하세요.','미확인 결과를 정리하고 계정·채널 연결을 확인한 뒤 그룹에서 재개하세요. 시간 오류만으로 미발송을 확정하지 마세요.'],page:'history',actionLabel:'중단된 실행 결과 확인'}
remedies.clock_or_sleep_gap=remedies.CLOCK_UNSAFE

function windowAdvice(action:string|undefined,rejectionCode:string|undefined):Remedy {
  const label=({reveal:'전송 창 보기',hide:'전송 창 숨기기',consolidate:'전송 창 모으기',separate:'채널별 창 분리'} as Record<string,string>)[action||'']||'전송 창 관리'
  const missing=['WINDOW_NOT_FOUND','TAB_NOT_FOUND','MANAGED_TAB_MISSING','MANAGED_WINDOW_NOT_FOUND'].includes(rejectionCode||'')
  return {title:`${label}를 완료하지 못했습니다`,cause:missing?'연결된 전송용 탭 또는 창을 찾지 못했습니다.':rejectionCode==='MANAGE_WINDOW_FAILED'?`브라우저가 ‘${label}’ 요청을 완료하지 못했습니다. 상세 내부 오류는 기록되지 않았습니다.`:'전송 창 관리 요청이 거절됐습니다. 상세 거절 사유가 기록되지 않았습니다.',steps:[
    '아래 대상 브라우저가 켜져 있고 DICO 확장이 관리 프로그램에 연결되어 있는지 확인하세요.',
    ...(['consolidate','separate'].includes(action||'')?['해당 브라우저의 그룹을 중지하고 적용 확인을 기다리세요. 미확인 발송은 실제 게시 내역을 확인한 뒤 실행 기록에서 처리하세요.']:[]),
    `채널 설정에서 아래 계정·채널의 ‘${label}’를 다시 요청하세요. 전송 탭을 찾지 못하면 해당 계정·채널을 다시 연결하세요.`,
    '요청이 적용된 뒤 이 알림의 ‘해결 상태 재검사’를 누르세요. 창 요청의 적용 응답으로 지난 오류를 정리합니다.'
  ],page:'channels',actionLabel:'전송 창 상태 확인'}
}

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
  const accountId=text(i.accountId)||text(payload?.accountId)||binding?.accountId||attempt?.accountId
  const affected=[...(instance?['브라우저: '+instance.name]:instanceId?['브라우저: '+instanceId]:[]),...(accountId?['계정: '+accountLabel(s,{accountId,instanceId})]:[]),...(groups.length?groups.map(g=>'그룹: '+g.name):groupId?['그룹: '+groupId]:[]),...(target?['채널: #'+target.name]:binding?['채널: #'+binding.name]:channelId?['채널 ID: '+channelId]:[])]
  const commandType=text(i.commandType)||text(command?.type),rejectionCode=text(i.rejectionCode)||text(command?.rejectionCode)||(commandType==='PREPARE'&&attempt?.reasonCode&&remedies[attempt.reasonCode]?attempt.reasonCode:undefined)
  let remedy:Remedy,knownReason=false
  if(i.code==='command_rejected'){
    const known=rejectionCode?remedies[rejectionCode]:undefined
    if(commandType==='CLOSE_CHANNEL'){remedy={title:'연결 해제한 전송 탭을 닫아야 합니다',cause:'설정에서 연결을 해제했지만 해당 브라우저의 전송 탭 닫기가 완료되지 않았습니다.',steps:['해당 브라우저와 DICO 확장을 켜고 연결 상태를 확인하세요.','아래 계정·채널에 해당하는 남은 전송 탭을 확인하세요. 다른 페이지로 이동한 탭은 자동으로 닫지 않으므로 필요하면 직접 닫아 주세요.','닫기 요청은 제한된 횟수로 재시도됩니다. 계속 실패하면 확장의 관리 프로그램 연결을 눌러 다시 확인하세요.'],page:'connections',actionLabel:'브라우저·남은 전송 탭 확인'};knownReason=true}
    else if(commandType==='MANAGE_WINDOW'&&!known){remedy=windowAdvice(text(payload?.action),rejectionCode);knownReason=['MANAGE_WINDOW_FAILED','WINDOW_NOT_FOUND','TAB_NOT_FOUND','MANAGED_TAB_MISSING','MANAGED_WINDOW_NOT_FOUND'].includes(rejectionCode||'')}
    else if(known){remedy={...known};knownReason=true;if(rejectionCode==='COOLDOWN_UNVERIFIED'&&binding&&typeof binding.slowmodeObservedAt==='number')remedy.cause+=` 마지막으로 감지한 슬로우 모드는 ${Math.ceil(binding.slowmodeMs/1000)}초이며, 현재 남은 대기 시간을 확인했다는 뜻은 아닙니다.`}
    else if(commandType==='CONTROL')remedy={title:'중지·일시정지 적용을 확인해야 합니다',cause:'상세 거절 사유가 기록되지 않았습니다. 제어 명령이 적용되지 않았으므로 중지 완료로 판단할 수 없습니다.',steps:controlSteps,page:'groups',actionLabel:'그룹·중지 상태 확인'}
    else remedy={title:'확장 요청을 확인해야 합니다',cause:'상세 거절 사유가 기록되지 않았습니다. 현재 기록만으로 초안·계정·버전 등의 원인을 단정할 수 없습니다.',steps:['아래 대상 브라우저와 확장 상태를 확인하세요.','진행 중·미확인 시도가 있으면 전체 중지를 요청하고 실제 Discord 게시 내역을 확인하세요. 중지만으로 미발송 여부를 판단하지 마세요.','관리 프로그램과 모든 확장을 업데이트하고 필요한 초안을 보관한 뒤 Discord를 새로고침하세요. 같은 문제가 반복되면 새로 기록된 거절 사유를 확인하세요.'],page:attempt?.status==='unknown'?'history':commandType==='OPEN_CHANNEL'||commandType==='CONFIG_SYNC'?'channels':'connections',actionLabel:attempt?.status==='unknown'?'미확인 실행 기록 확인':commandType==='OPEN_CHANNEL'||commandType==='CONFIG_SYNC'?'채널·적용 상태 확인':'계정·브라우저 확인'}
  }else if(i.code==='delivery_unknown'){
    const reason=attempt?.reasonCode||text(i.reasonCode),specific=['MANAGED_DELAY_UNAVAILABLE','RETRY_CANCELLED','RETRY_DELIVERY_AMBIGUOUS','CLOCK_UNSAFE','clock_or_sleep_gap'].includes(reason||'')?remedies[reason!]:undefined
    remedy={title:specific?.title||'실제 Discord 게시 여부를 확인해야 합니다',cause:specific?.cause||unknownDeliveryCause(reason),steps:[
      attempt?.executionBlocked===true?'이전 시도의 실행 차단이 확인됐습니다. 해당 계정·채널의 실제 Discord 게시 내역을 직접 확인하세요.':'이전 실행의 최종 결과와 실행 차단 확인을 기다리세요. 필요하면 해당 그룹의 중지를 요청하고 확장의 적용 확인 응답을 기다리세요.',
      '중지와 실행 차단은 과거 미발송의 증거가 아닙니다. 게시 내역에서 실제 게시 여부를 판단하세요.',
      '실제 미발송이면 ‘미발송 확인 · 같은 계정에서 계속’을 눌러 같은 그룹의 해당 계정 차례에서 계속하세요. 확정 전에는 다시 보내지 마세요.',
      '다른 초안이 남아 있으면 보관한 뒤 직접 정리하세요. Discord 제한 해제 대기와 같은 계정·채널의 준비 상태도 확인하세요.'
    ],page:'history',actionLabel:'미확인 실행 기록 확인'};knownReason=true
  }else if(i.code==='connection_lost'){
    remedy={title:'브라우저 연결이 끊겼습니다',cause:'중앙 관리 프로그램이 해당 브라우저의 연결을 유지하지 못했습니다.',steps:['해당 브라우저와 DICO 확장이 실행 중인지 확인하고 관리 프로그램에 다시 연결하세요.','계정 등록과 채널 검증 상태를 확인하세요.','진행 중·미확인 발송은 실제 Discord 게시 내역을 확인한 뒤 실행 기록에서 처리하세요.'],page:'connections',actionLabel:'브라우저 연결 확인'};knownReason=true
  }else if(i.code==='channel_unverified'){
    const verification=channelVerification({verified:false,verificationReason:text(i.verificationReason)||binding?.verificationReason})
    remedy={title:verification.title,cause:`이 채널 연결을 현재 검증할 수 없습니다. ${verification.action}`,steps:[verification.action,'채널 설정에서 이 계정의 실제 채널 연결 상태를 확인하세요. 확인되기 전에는 발송 준비로 처리하지 않습니다.','진행 중·미확인 발송이 있으면 실행 기록에서 실제 Discord 게시 여부를 확인하세요.'],page:'channels',actionLabel:'채널 연결 확인'};knownReason=true
  }else if(i.code==='account_mismatch'){
    remedy=remedies.ACCOUNT_UNVERIFIED;knownReason=true
  }else if(i.code==='storage_failure'){
    remedy={title:'설정을 저장하는 데 문제가 있습니다',cause:'관리 프로그램이 로컬 데이터를 정상적으로 저장하지 못했습니다.',steps:['새 발송을 시작하지 말고 설정·도움말의 설치 진단을 확인하세요.','저장 공간과 데이터 폴더 접근 권한을 확인하세요.','진행 중·미확인 발송이 있으면 실제 Discord 게시 여부도 확인하세요.'],page:'settings',actionLabel:'설치·저장 환경 확인'};knownReason=true
  }else{
    remedy={title:i.title||'확인할 문제가 있습니다',cause:i.description||i.message||'서비스에 확인이 필요한 상태가 기록되었습니다. 상세 정보와 대상 상태를 확인하세요.',steps:['관련 브라우저·그룹 상태와 최근 로그를 확인하세요.','미확인 발송은 실제 Discord 게시 내역을 확인하기 전까지 다시 보내지 마세요.'],page:attemptId?'history':'settings',actionLabel:attemptId?'관련 실행 기록 확인':'설치·서비스 상태 확인'}
  }
  if(i.code==='command_rejected'&&['PREPARE','COMMIT_PERMIT','RECONCILE'].includes(commandType||'')&&['confirmed','not_sent','cancelled'].includes(attempt?.status||'')){
    const outcome=attempt?.status==='confirmed'?(attempt.confirmationBasis==='composer_cleared'?'발송 처리':'게시 확인'):attempt?.status==='not_sent'?'미발송':'취소'
    remedy={...remedy,cause:`${remedy.cause} 관련 시도는 현재 ${outcome}으로 확정되어 있습니다.`,steps:['‘해결 상태 재검사’를 눌러 확정된 시도의 지난 알림을 정리하세요.',...remedy.steps]}
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
