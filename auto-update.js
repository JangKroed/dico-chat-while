export const NATIVE_HOST='com.dico.updater';
// A native port keeps the MV3 worker alive while the helper downloads/replaces
// files, so its update lock cannot disappear during an ordinary idle shutdown.
export function nativeCall(api,message){
 return new Promise((resolve,reject)=>{
  let port,done=false;
  const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);port?.disconnect();error?reject(error):resolve(result);};
  const timer=setTimeout(()=>finish(Error('보조 프로그램 응답이 지연됩니다. 설치 결과를 다시 확인한 뒤 시작하세요.')),180000);
  try{
   port=api.runtime.connectNative(NATIVE_HOST);
   port.onMessage.addListener(result=>finish(null,result));
   port.onDisconnect.addListener(()=>finish(Error(api.runtime.lastError?.message || '보조 프로그램 연결이 종료되었습니다.')));
   port.postMessage(message);
  }catch(error){finish(error);}
 });
}
export const updateBusy=state=>(state?.channels || []).some(c=>c.enabled || c.pending || c.prepared);
export function createAutoUpdater(api,load){
 let flight,locked=false;
 const inspectTarget=target=>{
  let timer;
  return Promise.race([api.tabs.sendMessage(target.tabId,{type:'DICO_INSPECT',target}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('전용 탭 확인이 지연됩니다. 전용 창을 닫은 뒤 다시 시도하세요.')),6000);})]).finally(()=>clearTimeout(timer));
 };
 const status=(phase,message)=>api.storage.local.set({autoUpdateStatus:{phase,message,at:Date.now()}});
 async function probe(){
  const result=await nativeCall(api,{operation:'probe'});
  if(!result?.ok)throw Error(result?.error || '보조 프로그램 연결에 실패했습니다.');
  return result;
 }
 function apply(){
  if(flight)return flight;
  flight=(async()=>{
   try{
    if(!await api.permissions.contains({permissions:['nativeMessaging']}))throw Error('먼저 보조 프로그램 연결을 허용해 주세요.');
    const state=await load();
    if(updateBusy(state)){await status('waiting','업데이트 대기 중입니다. 모든 채널을 중지하고 미확인 전송을 정리하면 자동 적용합니다.');return;}
    locked=true;
    const tabs=[];
    // Never reload a user's unrelated tab or discard a retained draft. A closed
    // dedicated tab is harmless, but a live tab with an unknown state is not.
    for(const c of state.channels || []){
     if(!c.target?.managed || !Number.isInteger(c.target.tabId))continue;
     let tab;try{tab=await api.tabs.get(c.target.tabId);}catch{continue;}
     if(tab.url!==`https://discord.com/channels/${c.target.guildId}/${c.target.channelId}`)throw Error('전용 탭 위치가 바뀌었습니다. 해당 전용 창을 닫은 뒤 다시 시도하세요.');
     const result=await inspectTarget(c.target);
     if(result?.diagnostics?.draftEmpty!==true){await status('waiting','전용 창에 남은 초안을 보내거나 지워 주세요. 초안을 보존하기 위해 업데이트를 기다립니다.');return;}
     tabs.push({tabId:c.target.tabId,url:tab.url,target:c.target});
    }
    if(updateBusy(await load()))throw Error('채널 실행 상태가 바뀌었습니다. 다음 확인 때 다시 시도합니다.');
    await status('applying','새 버전 검증 및 파일 교체 중입니다. 완료되면 확장이 자동으로 새로고침됩니다.');
    // The native host chooses a fixed repository and registered directory. Never
    // send a caller-controlled URL, destination or command to the host.
    const result=await nativeCall(api,{operation:'update',currentVersion:api.runtime.getManifest().version});
    if(!result?.ok)throw Error(result?.error || '보조 프로그램이 업데이트 결과를 반환하지 않았습니다.');
    if(result.updated){
     const reloadTabs=[];
     for(const tab of tabs){
      // A user can type while the package downloads. Recheck immediately before
      // reload and leave newly edited/unknown tabs intact.
      try{
       const live=await api.tabs.get(tab.tabId);
       const inspected=await inspectTarget(tab.target);
       if(live.url===tab.url && inspected?.diagnostics?.draftEmpty===true)reloadTabs.push({tabId:tab.tabId,url:tab.url});
      }catch{}
     }
     await api.storage.local.set({updaterReloadTabs:reloadTabs,autoUpdateStatus:{phase:'complete',message:`${result.version} 파일 적용 완료. 확장을 새로고침합니다.${reloadTabs.length<tabs.length?' 입력 상태가 바뀐 전용 창은 보존했습니다. 초안을 정리하고 해당 창을 닫은 뒤 시작하세요.':''}`,at:Date.now()}});
     api.runtime.reload();
    }else await status('current','현재 정식 최신 버전입니다.');
   }catch(error){await status('error',`자동 업데이트 실패: ${error.message}`);}
  })().finally(()=>{locked=false;flight=null;});
  return flight;
 }
 return {get locked(){return locked},probe,apply};
}
