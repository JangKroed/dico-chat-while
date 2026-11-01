export const UPDATE_RECONNECT_KEY='dico.updateReconnect'
const delays=[1000,2000,3000,5000,8000,10000,10000,10000]
export function reconnectDelay(failures:number):number|null {return delays[failures-1]??null}
export function versionReloadDecision(loaded:string|undefined,next:string|undefined,initiatedHere:boolean,path:string,hasUnsavedSettings=false) {
  if(!loaded||!next||loaded===next)return 'none'
  return initiatedHere&&path==='/settings'&&!hasUnsavedSettings?'reload':'banner'
}
export function readUpdateIntent(storage:Pick<Storage,'getItem'>,now=Date.now()):{startedAt:number;fromVersion?:string}|null {
  try {
    const value=JSON.parse(storage.getItem(UPDATE_RECONNECT_KEY)||'null')
    if(!value||typeof value.startedAt!=='number'||value.startedAt>now||now-value.startedAt>30*60*1000)return null
    return {startedAt:value.startedAt,...(typeof value.fromVersion==='string'?{fromVersion:value.fromVersion}:{})}
  }catch{return null}
}
