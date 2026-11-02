import type {Attempt,EventRecord} from './api'
export type RetainedRecord=Attempt|EventRecord
export type RecordPage<T>={items:T[];nextCursor:string|null;retentionDays:number}
export function mergeRetainedRecords<T extends RetainedRecord>(stored:T[],latest:T[],kind:'history'|'logs'):T[]{
  const key=(row:T)=>kind==='history'?String(row.id):String((row as EventRecord).eventId??row.id)
  const records=new Map(stored.map(row=>[key(row),row]))
  for(const row of latest)records.set(key(row),row)
  return [...records.values()].sort((a,b)=>kind==='logs'?Number((b as EventRecord).eventId)-Number((a as EventRecord).eventId):Number(b.createdAt)-Number(a.createdAt)||String(b.id).localeCompare(String(a.id)))
}
export async function fetchRecordPage<T extends RetainedRecord>(kind:'history'|'logs',filters:Record<string,string>,cursor?:string,signal?:AbortSignal):Promise<RecordPage<T>>{
  const query=new URLSearchParams({...filters,paged:'1',limit:'100',...(cursor?{cursor}:{})})
  const response=await fetch(`/api/${kind}?${query}`,{credentials:'same-origin',signal})
  if(!response.ok)throw Error(response.status===401?'관리 프로그램 인증을 다시 확인해 주세요.':'이전 기록을 불러오지 못했습니다. 다시 시도해 주세요.')
  return response.json()
}
