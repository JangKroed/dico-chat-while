import type {Snapshot} from './api'

type IdentityRef={[key:string]:unknown;accountId?:unknown;instanceId?:unknown;bindingId?:unknown;channelId?:unknown;accountEntityId?:unknown;accountName?:unknown;observedAccountName?:unknown;username?:unknown;name?:unknown;attemptId?:unknown;commandId?:unknown}
type IdentitySnapshot=Pick<Snapshot,'accounts'|'channels'>&Partial<Pick<Snapshot,'commands'|'attempts'>>
const string=(value:unknown)=>typeof value==='string'&&value.trim()?value.trim():undefined
export function accountIdentity(s:IdentitySnapshot,ref:IdentityRef) {
  const attempt=s.attempts?.find(a=>a.id===ref.attemptId),command=s.commands?.find(c=>c.id===ref.commandId)
  const payload=command?.payload as Record<string,unknown>|undefined
  const binding=s.channels.find(c=>c.id===(ref.bindingId||attempt?.bindingId||payload?.bindingId||ref.channelId))
  const entity=s.accounts?.find(a=>a.id===(ref.accountEntityId||payload?.accountEntityId))
  const accountId=string(ref.accountId)||attempt?.accountId||string(payload?.accountId)||binding?.accountId||entity?.accountId
  const instanceId=string(ref.instanceId)||string(attempt?.instanceId)||string(command?.instanceId)||binding?.instanceId||entity?.instanceId
  const candidates=s.accounts?.filter(a=>a.accountId===accountId)??[]
  const account=entity||candidates.find(a=>a.instanceId===instanceId)||(candidates.length===1?candidates[0]:undefined)
  const record=account as Record<string,unknown>|undefined
  const alias=string(account?.name)
  const observed=string(record?.observedName)||string(record?.displayName)||string(record?.username)||string(ref.accountName)||string(ref.observedAccountName)||string(ref.username)
  const customized=record?.nameCustomized===true||record?.nameCustomized!==false&&alias!==accountId
  return {name:alias&&customized?alias:observed||alias||accountId||'계정 정보 없음',accountId,instanceId}
}
export function accountLabel(s:IdentitySnapshot,ref:IdentityRef) {return accountIdentity(s,ref).name}
