import type { Channel } from './api'

type IntervalChannel=Pick<Channel,'intervalMs'|'customIntervalMs'|'slowmodeMs'|'slowmodeObservedAt'|'intervalMode'|'effectiveIntervalMs'|'minimumIntervalMs'|'correctedBaseIntervalMs'|'cooldownCorrectionMs'|'customExtraMs'|'cooldownCalibratedAt'>
export type IntervalMode='auto'|'custom'
export function intervalSettings(c:IntervalChannel) {
  const slowmodeMs=Number.isFinite(c.slowmodeMs)?Math.max(0,c.slowmodeMs):0
  const floorMs=Math.max(3000,slowmodeMs+3000,c.minimumIntervalMs??0)
  const mode=c.intervalMode??(c.intervalMs<=floorMs?'auto':'custom')
  const correctedBaseMs=Math.max(floorMs,Number.isFinite(c.correctedBaseIntervalMs)?c.correctedBaseIntervalMs!:floorMs)
  const extraMs=mode==='custom'?Math.max(0,(c.customIntervalMs??c.intervalMs)-floorMs):0
  const effectiveMs=Number.isFinite(c.effectiveIntervalMs)?Math.max(correctedBaseMs+extraMs,c.effectiveIntervalMs!):correctedBaseMs+extraMs
  return {mode,correctedBaseSeconds:Math.ceil(correctedBaseMs/1000),correctionSeconds:Math.ceil((correctedBaseMs-floorMs)/1000),extraSeconds:Math.ceil(extraMs/1000),calibrated:typeof c.cooldownCalibratedAt==='number',observed:typeof c.slowmodeObservedAt==='number'&&Number.isFinite(c.slowmodeObservedAt),slowmodeSeconds:Math.ceil(slowmodeMs/1000),floorMs,floorSeconds:Math.ceil(floorMs/1000),effectiveSeconds:Math.ceil(effectiveMs/1000)}
}
export function customIntervalError(value:string,info:ReturnType<typeof intervalSettings>) {
  const seconds=Number(value)
  if(!value.trim()||!Number.isSafeInteger(seconds))return '주기를 정수 초 단위로 입력하세요.'
  if(seconds<info.floorSeconds)return `${info.observed?'감지된':'현재 적용할'} 최소 주기 ${info.floorSeconds}초 이상으로 입력하세요.`
  if(seconds>86400)return '주기는 86,400초 이하로 입력하세요.'
  return ''
}
export function intervalPayload(mode:IntervalMode,value:string) {
  return mode==='auto'?{intervalMode:'auto' as const}:{intervalMode:'custom' as const,intervalMs:Number(value)*1000}
}
export function intervalDraftChanged(c:IntervalChannel,mode:IntervalMode,value:string,touched=false) {
  const saved=intervalSettings(c)
  return mode!==saved.mode||mode==='custom'&&touched&&Number(value)*1000!==(c.customIntervalMs??c.intervalMs)
}
