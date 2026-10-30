export type Timestamp = string|number
export type Message = { id:string; name:string; body:string; tags:string[]; archived:boolean; version:number; revisionId:string; createdAt:Timestamp; updatedAt:Timestamp; revisions:{id:string;version:number;body:string;at:Timestamp}[] }
export type Channel = { id:string; instanceId:string; accountId:string; guildId:string; channelId:string; name:string; verified:boolean; tabId?:number; version:number; configVersion:number; appliedVersion:number; playlist:{messageId:string;revisionId:string}[]; playlistIndex:number; intervalMs:number; slowmodeMs:number }
export type Group = { id:string; name:string; guildId:string; channelId:string; members:string[]; intervalMs:number; version:number; status:'stopped'|'running'|'paused'|'needs_review'|'resume_required'|'stop_pending'|'pause_pending'; cursor:number; activeAttemptId?:string; waitReason?:string; nextEligibleAt?:Timestamp }
export type Instance = {id:string;name:string;browser?:string;status?:string;connected?:boolean;lastSeenAt?:Timestamp;version?:number;accountId?:string;extensionVersion?:string;[key:string]:unknown}
export type Attempt = {id:string;groupId?:string;bindingId?:string;channelId?:string;accountId?:string;messageId?:string;messageIdRef?:string;messageName?:string;revisionId?:string;status?:string;state?:string;createdAt?:Timestamp;permittedAt?:Timestamp;finalizedAt?:Timestamp;attemptedAt?:Timestamp;confirmedAt?:Timestamp;postedAt?:Timestamp;executionBlocked?:boolean;manual?:boolean;reasonCode?:string;uncertain?:boolean;[key:string]:unknown}
export type Incident = {id:string;code?:string;title?:string;message?:string;description?:string;level?:string;severity?:string;status?:string;read?:boolean;readAt?:Timestamp;resolvedAt?:Timestamp;createdAt?:Timestamp;updatedAt?:Timestamp;lastSeenAt?:Timestamp;groupId?:string;attemptId?:string;[key:string]:unknown}
export type EventRecord = {id?:string;eventId?:number;type?:string;level?:string;message?:string;description?:string;at?:Timestamp;receivedAt?:Timestamp;createdAt?:Timestamp;reasonCode?:string;groupId?:string;attemptId?:string;[key:string]:unknown}
export type Snapshot = {schemaVersion:number;stateVersion:number;service?:Record<string,unknown>;settings?:Record<string,unknown>;messages:Message[];instances:Instance[];channels:Channel[];groups:Group[];attempts:Attempt[];commands?:Record<string,unknown>[];incidents:Incident[];events:EventRecord[];analytics?:Record<string,unknown>}

export type SetupStatus = {checkedAt:number;checks:{id:string;label:string;status:'ok'|'warning'|'error';detail:string;nextStep?:string}[];ready:boolean}

let csrfToken = ''
export class ApiError extends Error {
  status:number
  code?:string
  constructor(message:string,status:number,code?:string) { super(message);this.status=status;this.code=code }
}
export function requestErrorMessage(error:unknown):string {
  if(error instanceof ApiError && error.code==='VERSION_CONFLICT')return '다른 화면에서 변경되었습니다. 입력 내용은 유지됩니다. 최신 상태를 확인한 뒤 다시 시도해 주세요.'
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
export async function establishSession():Promise<void> {
  const fragment = new URLSearchParams(location.hash.replace(/^#/,''))
  const bootstrap = fragment.get('bootstrap')
  if (bootstrap) {
    history.replaceState(null,'',location.pathname + location.search)
    const session = await request<{csrfToken:string}>('/api/session',{method:'POST',body:JSON.stringify({token:bootstrap})})
    csrfToken = session.csrfToken
  } else {
    const session = await request<{csrfToken:string}>('/api/session')
    csrfToken = session.csrfToken
  }
}
export const getSetupStatus = () => request<SetupStatus>('/api/setup-status')
export const getSnapshot = () => request<Snapshot>('/api/snapshot')
export const command = (action:string,payload:Record<string,unknown>) => request<unknown>('/api/command',{method:'POST',body:JSON.stringify({action,payload})})
export const getAnalytics = (from:number,to:number) => request<Record<string,unknown>>(`/api/analytics?from=${from}&to=${to}`)
export const testNotification = () => request<{ok:boolean;result:{status:string}}>('/api/notification-test',{method:'POST',body:'{}'})
export function subscribe(onMessage:(data:unknown)=>void,onDisconnect:()=>void):()=>void {
  const source = new EventSource('/api/events',{withCredentials:true})
  const listener = (event:MessageEvent) => { try { onMessage(JSON.parse(event.data)) } catch { /* malformed event, recover with snapshot */ } }
  source.addEventListener('snapshot',listener)
  source.addEventListener('event',listener)
  source.onmessage = listener
  source.onerror = onDisconnect
  return () => source.close()
}
