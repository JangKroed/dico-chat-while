export type Preferences = {retentionDays:number;notificationsEnabled:boolean;hideNotificationNames:boolean;maxSendRetries:number|null}
export type SettingsDraft = {saved:Preferences;values:Preferences}
const fields = ['retentionDays','notificationsEnabled','hideNotificationNames','maxSendRetries'] as const
function readPreferences(settings:Record<string,unknown>|undefined):Preferences|null {
  if(!settings||![30,90,180].includes(Number(settings.retentionDays))||typeof settings.notificationsEnabled!=='boolean'||typeof settings.hideNotificationNames!=='boolean')return null
  return {retentionDays:Number(settings.retentionDays),notificationsEnabled:settings.notificationsEnabled,hideNotificationNames:settings.hideNotificationNames,maxSendRetries:Number.isSafeInteger(settings.maxSendRetries)&&Number(settings.maxSendRetries)>=0?Number(settings.maxSendRetries):null}
}
export function createSettingsDraft(settings:Record<string,unknown>|undefined):SettingsDraft|null {
  const saved=readPreferences(settings)
  return saved?{saved,values:{...saved}}:null
}
export function syncSettingsDraft(draft:SettingsDraft|null,settings:Record<string,unknown>|undefined):SettingsDraft|null {
  const saved=readPreferences(settings)
  if(!saved)return draft
  if(!draft)return {saved,values:{...saved}}
  if(fields.every(key=>saved[key]===draft.saved[key]))return draft
  // Only pristine fields follow server changes; saves in another section and
  // reconnect snapshots must never replace a pending local edit.
  const values={...draft.values}
  for(const key of fields)if(draft.values[key]===draft.saved[key])Object.assign(values,{[key]:saved[key]})
  return {saved,values}
}
export function editSettingsDraft<K extends keyof Preferences>(draft:SettingsDraft|null,key:K,value:Preferences[K]):SettingsDraft|null {
  if(key==='maxSendRetries'&&value!==null&&(!Number.isSafeInteger(value)||Number(value)<0))return draft
  return draft?{...draft,values:{...draft.values,[key]:value}}:null
}
export function settingsPayload(draft:SettingsDraft|null,section:'notifications'|'retention'|'delivery'):Record<string,unknown>|null {
  if(!draft)return null
  const keys=section==='delivery'?['maxSendRetries'] as const:section==='retention'?['retentionDays'] as const:['notificationsEnabled','hideNotificationNames'] as const
  return Object.fromEntries(keys.filter(key=>draft.values[key]!==draft.saved[key]).map(key=>[key,draft.values[key]]))
}
export function settingsDirty(draft:SettingsDraft|null):boolean {
  return Boolean(draft&&fields.some(key=>draft.values[key]!==draft.saved[key]))
}
