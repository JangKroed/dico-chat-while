import type { Attempt } from './api'

export type SupportCheck={code?:string;severity?:string;message?:string;attemptId?:string;groupId?:string;instanceId?:string}
export type SupportReport={format:'dico-support-report';schemaVersion:number;reportId?:string;createdAt?:number|string;userDescription?:string;runtime?:Record<string,unknown>;selection?:Record<string,unknown>;privacy?:{includeBodies?:boolean;includeNames?:boolean;credentialsExcluded?:boolean};summary?:Record<string,unknown>;configuration?:Record<string,unknown>;attempts?:Attempt[];commands?:Record<string,unknown>[];events?:Record<string,unknown>[];incidents?:Record<string,unknown>[];timeline?:Record<string,unknown>[];checks?:SupportCheck[]}
export type SupportInspection={report:SupportReport;summary:Record<string,unknown>;findings:SupportCheck[]}
export type SupportReportOptions={attemptId?:string;from?:number;to?:number;includeBodies:boolean;includeNames:boolean}
export const SUPPORT_REPORT_MAX_BYTES=16*1024*1024

export async function readSupportReport(file:Pick<File,'size'|'text'>):Promise<SupportReport>{
  if(file.size>SUPPORT_REPORT_MAX_BYTES)throw new Error('제보 파일은 16 MiB 이하만 열 수 있습니다.')
  const raw=await file.text()
  if(new TextEncoder().encode(raw).length>SUPPORT_REPORT_MAX_BYTES)throw new Error('제보 파일은 16 MiB 이하만 열 수 있습니다.')
  let value:unknown
  try{value=JSON.parse(raw)}catch{throw new Error('올바른 JSON 제보 파일이 아닙니다.')}
  if(!value||typeof value!=='object'||Array.isArray(value)||(value as SupportReport).format!=='dico-support-report'||(value as SupportReport).schemaVersion!==1)throw new Error('지원하는 DICO 제보 파일이 아닙니다.')
  return value as SupportReport
}

export function supportReportSummary(report:SupportReport):string{
  const attempts=Array.isArray(report.attempts)?report.attempts:[]
  return ['DICO 관리자 제보',`제보 ID: ${report.reportId||'—'}`,`생성 시각: ${report.createdAt||'—'}`,`프로그램: ${JSON.stringify(report.runtime||{})}`,`범위: ${JSON.stringify(report.selection||{})}`,`증상: ${report.userDescription||'입력하지 않음'}`,`집계: ${JSON.stringify(report.summary||{})}`,`본문 포함: ${report.privacy?.includeBodies?'예':'아니요'} · 이름 포함: ${report.privacy?.includeNames?'예':'아니요'}`,...attempts.map(attempt=>[`시도 ${attempt.id} · ${attempt.status||'—'} · ${attempt.reasonCode||'—'}`,`관측: ${JSON.stringify(attempt.deliveryEvidence||{})}`,...(report.privacy?.includeBodies&&typeof attempt.body==='string'?[`시도 당시 메시지 본문:\n${attempt.body}`]:[])].join('\n')),'자세한 순서·로그·복구 기록은 함께 저장한 JSON 제보 파일을 확인하세요.'].join('\n\n')
}

export function saveSupportReport(report:SupportReport):void{
  const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json;charset=utf-8'})
  if(blob.size>SUPPORT_REPORT_MAX_BYTES)throw new Error('제보 파일이 16 MiB를 초과합니다. 기간을 줄여 다시 미리보기해 주세요.')
  const url=URL.createObjectURL(blob),anchor=document.createElement('a')
  anchor.href=url;anchor.download=`dico-support-${String(report.reportId||Date.now()).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,90)}.json`
  document.body.appendChild(anchor)
  try{anchor.click()}finally{anchor.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000)}
}
