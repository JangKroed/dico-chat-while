import type {DeliveryEvidence} from './api'

export function unknownDeliveryCause(reason?:string) {
  const aliases:Record<string,string>={DELIVERY_DRAFT_RETAINED:'draft-retained',DELIVERY_CONFIRMATION_TIMEOUT:'uncertain',CONTENT_UNAVAILABLE:'content_unavailable'}
  return ({
    'draft-retained':'전송 요청 뒤 확인 시점에도 입력창에 문구가 남아 있어 실제 게시 여부를 확정하지 못했습니다. 초안이 남았다는 사실만으로 미발송으로 판단할 수 없습니다.',
    uncertain:'전송 요청 뒤 실제 게시를 확인할 증거가 충분하지 않아 결과가 미확인 상태입니다.',
    no_response:'Discord 탭의 결과 응답을 받지 못해 실제 게시 여부를 확정하지 못했습니다.',
    content_unavailable:'전송용 Discord 탭의 확장 응답을 확인하지 못했습니다. 실제 게시 여부는 별도로 확인해야 합니다.',
    reconcile_inconclusive:'다시 연결한 뒤 게시 내역을 재확인했지만 실제 게시 여부를 확정하지 못했습니다.',
    result_unknown:'현재 기록만으로 실제 게시 여부를 확정하지 못했습니다.',
    COMMIT_EDITOR_UNSTABLE:'전송 허가 직전 입력창의 문구·대상 상태를 안정적으로 확인하지 못했습니다. 남은 초안을 보존하고 실제 Discord 게시 내역을 확인하세요.',
    PREPARE_EDITOR_UNSTABLE:'입력 준비 중 문구나 입력창의 안정 상태를 확인하지 못했습니다. 남은 초안을 보존하고 실제 게시 여부를 별도로 확인해야 합니다.',
    CONTENT_EXCEPTION_AFTER_ENTER:'Enter 이벤트 요청 이후 처리 중 예외가 기록되어 게시 결과를 확인하지 못했습니다. Enter 요청 기록만으로 실제 게시를 확정할 수 없습니다.',
    CONTENT_EXCEPTION_BEFORE_ENTER:'Enter 이벤트 요청 전 확인 단계에서 입력창 처리 예외가 기록됐습니다. 이 기록만으로 실제 미발송을 확정하지 말고 게시 내역을 확인하세요.',
    COOLDOWN_UNVERIFIED:'Discord 화면의 실제 남은 대기 시간을 확인하지 못했습니다. 제한이 해제됐다고 판단하지 않고 초안과 실행 상태를 보존했습니다.',
    PREPARE_WAIT_TIMEOUT:'입력 준비 대기가 만료되어 현재 상태를 다시 확인해야 합니다. 남은 초안과 실제 게시 내역을 확인하기 전에는 다시 보내지 마세요.',
    TARGET_MISMATCH:'전송용 탭의 실제 채널이 설정한 대상과 일치하지 않았습니다. 대상 채널과 실제 게시 내역을 확인하세요.',
    ACCOUNT_UNVERIFIED:'전송용 탭의 로그인 계정을 검증하지 못했습니다. 등록 계정과 실제 게시 내역을 확인하세요.',
    EDITOR_LOADING:'Discord 입력창이 준비됐는지 확인하지 못했습니다. 입력창과 실제 게시 내역을 확인하세요.',
    EDITOR_AMBIGUOUS:'열린 입력창이 여러 개여서 대상 입력창을 확정하지 못했습니다. 스레드·편집 창과 실제 게시 내역을 확인하세요.',
    DRAFT_MISMATCH:'설정한 문구와 다른 초안이 감지됐습니다. 필요한 초안을 보관하고 실제 게시 내역을 확인하세요.',
    ATTACHMENT_OR_REPLY:'입력창에 첨부파일 또는 답장 상태가 감지됐습니다. 남은 초안과 실제 게시 내역을 확인하세요.',
    HISTORY_LOADING:'Discord 게시 내역이 아직 준비되지 않아 확인하지 못했습니다. 채팅 기록이 열린 뒤 실제 게시 여부를 확인하세요.',
    POSSIBLY_SENT:'이전 시도 이후 같은 문구가 게시된 것으로 보이는 흔적이 있어 다시 보내지 않았습니다. 실제 게시 내역을 직접 확인하세요.'
  } as Record<string,string>)[aliases[reason||'']||reason||'']||'발송 시도의 실제 게시 여부가 확정되지 않아 자동 진행이 멈췄습니다.'
}
export function deliveryReasonLabel(reason?:string):string|undefined {
  return ({DELIVERY_DRAFT_RETAINED:'입력창에 문구가 남아 게시 여부 미확인',DELIVERY_CONFIRMATION_TIMEOUT:'게시 확인 대기 시간 초과',COMMIT_EDITOR_UNSTABLE:'전송 직전 입력 상태 확인 필요',PREPARE_EDITOR_UNSTABLE:'입력 준비 상태 확인 필요',CONTENT_EXCEPTION_AFTER_ENTER:'Enter 요청 이후 확인 오류',CONTENT_EXCEPTION_BEFORE_ENTER:'Enter 요청 전 입력창 확인 오류',COOLDOWN_UNVERIFIED:'Discord 실제 남은 대기 시간 확인 불가',PREPARE_WAIT_TIMEOUT:'입력 준비 대기 만료'} as Record<string,string>)[reason||'']
}
export function enterEvidenceText(evidence?:DeliveryEvidence) {
  if(evidence?.enterAttempted===true)return 'Enter 키 이벤트를 요청하는 지점까지 진행된 기록이 있습니다. Discord가 이벤트를 처리했거나 메시지를 게시했다는 뜻은 아닙니다.'
  if(evidence?.enterAttempted===false)return '이 진단에서는 Enter 키 이벤트 요청 시도가 관측되지 않았습니다. 이 값만으로 실제 미발송을 확정할 수는 없습니다.'
  return 'Enter 키 이벤트 요청에 관한 진단 기록이 없습니다. 요청 여부나 실제 게시 결과를 추정하지 않습니다.'
}
export const evidenceStages:Record<string,string>={inspect:'초안·대상 점검',authorize:'전송 허가 재확인',prepare:'입력 준비',stable:'입력창 안정 상태 확인',enter:'Enter 이벤트 요청',observe:'실제 게시 관찰'}
export const evidenceFlags:{key:keyof DeliveryEvidence;label:string}[]=[{key:'composerRetained',label:'입력창에 문구 남음'},{key:'newMessage',label:'새 메시지 관측'},{key:'matchingMessage',label:'본문이 일치하는 메시지 관측'},{key:'sendingSeen',label:'전송 중 표시 관측'},{key:'failedSeen',label:'실패 표시 관측'},{key:'authorMismatch',label:'작성자 불일치 관측'},{key:'authorUnknown',label:'작성자 확인 불가'},{key:'timeMismatch',label:'게시 시각 불일치 관측'}]
