export const UPDATE_ORIGIN='https://api.github.com/*';
export const RELEASES='https://github.com/JangKroed/dico-chat-while/releases';
const endpoint='https://api.github.com/repos/JangKroed/dico-chat-while/releases/latest';
export function newerVersion(candidate,current){
 const parse=v=>/^\d+\.\d+\.\d+$/.test(v)?v.split('.').map(Number):null;
 const a=parse(candidate),b=parse(current);if(!a||!b)return false;
 for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];return false;
}
export function releaseUpdate(release,current){
 const version=String(release.tag_name||'').replace(/^v/,'');
 if(release.draft || release.prerelease || !newerVersion(version,current))return null;
 const filename=`dico-while-${version}.zip`;
 const url=`${RELEASES}/download/v${version}/${filename}`;
 if(!release.assets?.some(a=>a.name===filename&&a.browser_download_url===url))throw Error('배포 ZIP이 아직 준비되지 않았습니다.');
 return {version,url};
}
let inFlight;
export function checkForUpdate(api,force=false,fetcher=fetch){
 if(inFlight)return inFlight;
 inFlight=(async()=>{
  if(!await api.permissions.contains({origins:[UPDATE_ORIGIN]}))return {disabled:true};
  const {releaseCheck={}}=await api.storage.local.get('releaseCheck');
  const current=api.runtime.getManifest().version;
  if(!force && releaseCheck.current===current && Date.now()-(releaseCheck.checkedAt||0)<3600000)return releaseCheck;
  try{
   const response=await fetcher(endpoint,{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(10000)});
   if(response.status!==404&&!response.ok)throw Error(`GitHub 확인 실패 (${response.status})`);
   const update=response.status===404?null:releaseUpdate(await response.json(),current);
   const result={checkedAt:Date.now(),current,update,noRelease:response.status===404};
   await api.storage.local.set({releaseCheck:result});return result;
  }catch(error){const result={checkedAt:Date.now(),current,error:String(error.message)};await api.storage.local.set({releaseCheck:result});return result;}
 })().finally(()=>{inFlight=null;});return inFlight;
}
export function installUpdateChecks(api,applyUpdate){
 if(!api.permissions?.contains)return;
 const poll=async()=>{
  const result=await checkForUpdate(api);
  if(result.update){
   const {autoUpdateEnabled}=await api.storage.local.get('autoUpdateEnabled');
   if(autoUpdateEnabled && applyUpdate){await applyUpdate();return;}
   const {notifiedRelease}=await api.storage.local.get('notifiedRelease');
   if(notifiedRelease!==result.update.version){
    await api.notifications.create('dico-update',{type:'basic',iconUrl:'notification-icon.png',title:'DICO 새 버전 안내',message:`${result.update.version} 버전이 나왔습니다. 사이드패널의 업데이트 안내를 확인하세요.`});
    await api.storage.local.set({notifiedRelease:result.update.version});
   }
  }
 };
 const retry=async()=>{
  const {autoUpdateEnabled,releaseCheck,autoUpdateStatus}=await api.storage.local.get(['autoUpdateEnabled','releaseCheck','autoUpdateStatus']);
  if(autoUpdateEnabled && releaseCheck?.update && autoUpdateStatus?.phase==='waiting' && applyUpdate)await applyUpdate();
 };
 api.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='dico-auto-update-retry')void retry().catch(()=>{});});
 const setup=async()=>{if(await api.permissions.contains({origins:[UPDATE_ORIGIN]})){await api.alarms.create('dico-update-check',{periodInMinutes:60});await api.alarms.create('dico-auto-update-retry',{periodInMinutes:1});await poll();}};
 api.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='dico-update-check')void poll().catch(()=>{});});
 api.storage.onChanged?.addListener((changes,area)=>{if(area==='local'&&changes.autoUpdateEnabled?.newValue===true)void poll().catch(()=>{});});
 api.permissions.onAdded.addListener(()=>{void setup().catch(()=>{});});
 api.permissions.onRemoved.addListener(()=>{void api.permissions.contains({origins:[UPDATE_ORIGIN]}).then(allowed=>{if(!allowed)return Promise.all([api.alarms.clear('dico-update-check'),api.alarms.clear('dico-auto-update-retry')]);}).catch(()=>{});});
 void setup().catch(()=>{});
}
