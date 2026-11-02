export type Timestamp = string|number
export type Message = { id:string; name:string; body:string; tags:string[]; archived:boolean; version:number; revisionId:string; createdAt:Timestamp; updatedAt:Timestamp; revisions:{id:string;version:number;body:string;at:Timestamp}[] }
export type Channel = { id:string; instanceId:string; accountId:string; guildId:string; channelId:string; name:string; namePending?:boolean;nameCustomized?:boolean;observedName?:string; verified:boolean; verificationReason?:string|null; tabId?:number; version:number; configVersion:number; appliedVersion:number; playlist:{messageId:string;revisionId:string}[]; playlistIndex:number; intervalMs:number;intervalMode?:'auto'|'custom';minimumIntervalMs?:number;customIntervalMs?:number;pendingIntervalSync?:boolean;nextEligibleAt?:Timestamp|null; slowmodeMs:number;slowmodeObservedAt?:number|null;effectiveIntervalMs?:number;correctedBaseIntervalMs?:number;cooldownCorrectionMs?:number;customExtraMs?:number;cooldownCalibratedAt?:Timestamp }
export type Account = {id:string;instanceId:string;accountId:string;name:string;nameCustomized?:boolean;observedName?:string;username?:string;version:number;verified:boolean;connected?:boolean;lastVerifiedAt?:Timestamp}
export type Target = {id:string;guildId:string;channelId:string;name:string;namePending?:boolean;nameCustomized?:boolean;observedName?:string;url?:string;version?:number}
export type Group = { id:string; name:string; guildId:string; channelId:string; members:string[]; intervalMs:number; version:number; runId?:string; status:'stopped'|'running'|'paused'|'needs_review'|'resume_required'|'stop_pending'|'pause_pending'; cursor:number; activeAttemptId?:string; waitReason?:string; nextEligibleAt?:Timestamp|null; nextPreparationAt?:Timestamp|null }
export type Instance = {id:string;name:string;browser?:string;status?:string;connected?:boolean;lastSeenAt?:Timestamp;version?:number;accountId?:string;extensionVersion?:string;[key:string]:unknown}
export type DeliveryEvidence = {phase?:'prepare'|'commit'|'send';stage?:'inspect'|'authorize'|'prepare'|'stable'|'enter'|'observe';enterAttempted?:boolean;composerRetained?:boolean;composerCleared?:boolean;composerEmpty?:boolean;editorPresent?:boolean;expectedDraftSubmitted?:boolean;sameEditor?:boolean;targetMatched?:boolean;accountMatched?:boolean;emptyStableMs?:number;newMessage?:boolean;matchingMessage?:boolean;sendingSeen?:boolean;failedSeen?:boolean;authorMismatch?:boolean;authorUnknown?:boolean;timeMismatch?:boolean;enterDefaultPrevented?:boolean;keyupDefaultPrevented?:boolean;documentHidden?:boolean;documentFocused?:boolean;submitMethod?:'keyboard'|'button';retryCount?:number;maxSendRetries?:number|null}
export type Attempt = {id:string;accountName?:string;channelName?:string;groupName?:string;instanceName?:string;groupId?:string;bindingId?:string;channelId?:string;accountId?:string;messageId?:string;messageIdRef?:string;messageName?:string;revisionId?:string;status?:string;state?:string;confirmationBasis?:'composer_cleared'|'message_observed';createdAt?:Timestamp;permittedAt?:Timestamp;finalizedAt?:Timestamp;attemptedAt?:Timestamp;confirmedAt?:Timestamp;postedAt?:Timestamp;executionBlocked?:boolean;manual?:boolean;reasonCode?:string;deliveryEvidence?:DeliveryEvidence;uncertain?:boolean;[key:string]:unknown}
export type Incident = {id:string;code?:string;title?:string;message?:string;description?:string;level?:string;severity?:string;status?:string;read?:boolean;readAt?:Timestamp;resolvedAt?:Timestamp;createdAt?:Timestamp;updatedAt?:Timestamp;lastSeenAt?:Timestamp;groupId?:string;bindingId?:string;attemptId?:string;[key:string]:unknown}
export type EventRecord = {id?:string;eventId?:number;type?:string;level?:string;message?:string;description?:string;at?:Timestamp;receivedAt?:Timestamp;createdAt?:Timestamp;reasonCode?:string;groupId?:string;bindingId?:string;attemptId?:string;[key:string]:unknown}
export type PendingTabClose = {removalId:string;instanceId:string;accountId:string;guildId:string;channelId:string;accountName?:string;channelName?:string;createdAt:number;status:string;rejectionCode?:string}
export type Snapshot = {pendingTabCloses?:PendingTabClose[];serverNow?:number;configurationToken?:string;schemaVersion:number;stateVersion:number;service?:Record<string,unknown>;settings?:Record<string,unknown>;messages:Message[];instances:Instance[];accounts?:Account[];targets?:Target[];channels:Channel[];groups:Group[];attempts:Attempt[];commands?:Record<string,unknown>[];incidents:Incident[];events:EventRecord[];analytics?:Record<string,unknown>}

export type SetupStatus = {checkedAt:number;checks:{id:string;label:string;status:'ok'|'warning'|'error';detail:string;nextStep?:string}[];ready:boolean}
export type UpdateStatus = {phase:'idle'|'preparing'|'ready'|'applying'|'completed'|'failed';message:string;startedAt?:Timestamp;updatedAt?:Timestamp;version?:string}

let csrfToken = ''
export class ApiError extends Error {
  status:number
  code?:string
  constructor(message:string,status:number,code?:string) { super(message);this.status=status;this.code=code }
}
const requestErrorGuidance:Record<string,string> = {
  WINDOW_SEPARATION_PARTIAL:'창 분리를 완료하지 못했습니다. 이미 이동한 탭과 초안은 유지됩니다. 전송 창 상태를 확인한 뒤 다시 분리해 주세요.',
  WINDOW_MANAGEMENT_PENDING:'전송 창 정리가 끝난 뒤 실행해 주세요.',
  VERSION_CONFLICT:'다른 화면에서 변경되었습니다. 입력 내용은 유지됩니다. 최신 상태를 확인한 뒤 다시 시도해 주세요.',
  ACCOUNT_UNVERIFIED:'이 브라우저의 계정 또는 채널 연결이 검증되지 않았습니다. 확장에서 현재 계정을 다시 등록하고, ‘채널 설정’에서 해당 계정·채널을 연결한 뒤 ‘검증됨’을 확인하세요. 계정 등록만으로 채널 연결이 완료되지는 않습니다.',
  CONNECTION_LOST:'대상 브라우저의 연결이 끊겼거나 최신 응답이 없습니다. 브라우저와 DICO 확장을 켜고 관리 프로그램에 다시 연결한 뒤 채널 검증 상태를 확인하세요.',
  LEGACY_UNRESOLVED:'기존 확장의 실행 중지와 미확인 결과 정리가 필요합니다. 기존 확장을 중지·비활성화하고 실제 게시 내역을 확인한 뒤 새 확장의 확인 상태를 저장하세요.',
  PLAYLIST_EMPTY:'적용된 메시지가 없습니다. ‘채널 설정’에서 사용할 메시지를 선택해 적용하세요.',
  CONFIG_PENDING:'확장이 최신 메시지·설정을 아직 적용하지 않았습니다. 대상 브라우저의 연결과 채널 적용 상태를 확인하고 적용 완료를 기다리세요.',
  ATTEMPT_UNRESOLVED:'결과가 확정되지 않은 발송 시도가 있습니다. 실제 Discord 게시 내역을 확인한 뒤 ‘실행 기록’에서 결과를 확정하세요.',
  EXECUTION_UNCERTAIN:'이전 시도의 실행 차단이 아직 확인되지 않았습니다. 확장의 최종 결과와 중지 적용 상태를 기다린 뒤 실제 게시 내역을 다시 확인해 주세요.',
  STALE_ATTEMPT:'그룹이나 최근 발송 시도가 변경됐습니다. 최신 실행 기록을 확인한 뒤 현재 시도에서 다시 요청해 주세요.',
  ATTEMPT_STATE:'이 시도는 더 이상 미확인 또는 미발송 상태가 아닙니다. 최신 실행 기록을 확인해 주세요.',
  CONTROL_PENDING:'중지·일시정지 확인 응답을 기다리고 있습니다. 대상 브라우저와 확장의 연결을 확인하고 적용 완료를 기다리세요.',
  RESOURCE_BUSY:'이 채널 또는 계정을 다른 그룹이 사용 중입니다. ‘발송 그룹’에서 겹치는 그룹을 확인하고 중지 적용이 완료된 뒤 실행하세요.',
  SERVICE_STOPPED:'중앙 서비스를 자동 준비하고 있습니다. 연결 상태가 갱신된 뒤 해당 그룹을 실행하세요.',
  STALE_SESSION:'브라우저 연결 세션이 변경됐습니다. 확장을 다시 연결하고 이전 미확인 시도의 실제 게시 여부를 확인하세요.',
  WINDOW_NOT_FOUND:'연결된 전송 창을 찾지 못했습니다. 브라우저와 확장을 확인하고 채널 설정에서 해당 계정을 다시 연결해 주세요.',
  TAB_NOT_FOUND:'연결된 전송 탭을 찾지 못했습니다. 채널 설정에서 해당 계정을 다시 연결해 주세요.',
  MANAGED_TAB_MISSING:'연결된 전송 탭을 찾지 못했습니다. 채널 설정에서 해당 계정을 다시 연결해 주세요.',
  MANAGED_WINDOW_NOT_FOUND:'연결된 전송 창을 찾지 못했습니다. 채널 설정에서 해당 계정을 다시 연결해 주세요.',
  WINDOW_NOT_DEDICATED:'일반 탭과 섞였거나 전송용 창인지 확인할 수 없습니다. 해당 탭을 확인하고 전송 창 하나로 모으기를 실행해 주세요.',
  GROUP_RUNNING:'해당 브라우저에서 실행 중인 그룹을 중지하고 적용 응답을 확인한 뒤 전송 창을 모아 주세요.',
  EXTENSION_UPDATE_REQUIRED:'이 기능을 사용하려면 관리 프로그램과 모든 브라우저의 확장을 같은 최신 버전으로 업데이트한 뒤 다시 연결하세요.'
}
export function requestErrorMessage(error:unknown):string {
  if(error instanceof ApiError && error.code && requestErrorGuidance[error.code])return requestErrorGuidance[error.code]
  return error instanceof Error?error.message:'요청을 처리하지 못했습니다'
}
async function request<T>(path:string, init:RequestInit={}):Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type','application/json')
  if (init.method && init.method !== 'GET') headers.set('X-Dico-CSRF',csrfToken)
  const response = await fetch(path,{...init,credentials:'same-origin',headers})
  if (!response.ok) {
    let detail = '', code: string|undefined
    try { const body = await response.json(); detail = body.error?.message || body.message || body.error || ''; code = body.error?.code } catch { /* server may return plain text */ }
    throw new ApiError(String(detail || `요청 실패 (${response.status})`),response.status,code)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}
export async function establishSession(signal?:AbortSignal):Promise<{appVersion?:string}> {
  const fragment = new URLSearchParams(location.hash.replace(/^#/,''))
  const bootstrap = fragment.get('bootstrap')
  type Session={csrfToken:string;appVersion?:string}
  const accept=(session:Session)=>{
    csrfToken=session.csrfToken
    if(bootstrap)history.replaceState(null,'',location.pathname+location.search)
    return {appVersion:session.appVersion}
  }
  if(!bootstrap)return accept(await request<Session>('/api/session',{signal}))
  try {return accept(await request<Session>('/api/session',{method:'POST',body:JSON.stringify({token:bootstrap}),signal}))}
  catch(postError){
    // The exchange may have consumed the token and set its cookie even if the
    // response was lost. Recover that session before requesting a new bootstrap.
    try {return accept(await request<Session>('/api/session',{signal}))}
    catch(cookieError){
      if(postError instanceof ApiError&&postError.status===401&&cookieError instanceof ApiError&&cookieError.status===401)throw cookieError
      throw postError
    }
  }
}
export const getSetupStatus = () => request<SetupStatus>('/api/setup-status')
export const getUpdateStatus = (signal?:AbortSignal) => request<UpdateStatus>('/api/updates',{signal})
export const startUpdate = (signal?:AbortSignal) => request<UpdateStatus>('/api/updates',{method:'POST',body:'{}',signal})
export const getSnapshot = (signal?:AbortSignal) => request<Snapshot>('/api/snapshot',{signal:signal??AbortSignal.timeout(10000)})
export const command = (action:string,payload:Record<string,unknown>) => request<unknown>('/api/command',{method:'POST',body:JSON.stringify({action,payload})})
export const getAnalytics = (from:number,to:number) => request<Record<string,unknown>>(`/api/analytics?from=${from}&to=${to}`)
export const testNotification = () => request<{ok:boolean;result:{status:string}}>('/api/notification-test',{method:'POST',body:'{}'})
export function subscribe(onMessage:(data:unknown)=>void,onDisconnect:()=>void):()=>void {
  const source = new EventSource('/api/events',{withCredentials:true})
  let active=true
  const close=()=>{if(!active)return;active=false;source.close()}
  const listener = (event:MessageEvent) => { if(!active)return;try { onMessage(JSON.parse(event.data)) } catch { /* malformed event, recover with snapshot */ } }
  source.addEventListener('snapshot',listener)
  source.addEventListener('event',listener)
  source.onmessage = listener
  // The app owns reconnect backoff and session recovery. Native EventSource
  // retries would otherwise race a second subscription after server restart.
  source.onerror = () => {if(!active)return;close();onDisconnect()}
  return close
}

export const createRemoteAccessLink = (signal?:AbortSignal) => request<{url:string;expiresAt:number}>('/api/remote-access-link',{method:'POST',body:'{}',signal})
