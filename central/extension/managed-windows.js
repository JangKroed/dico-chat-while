function fail(code,message){throw Object.assign(Error(message),{code});}
function discordTab(tab){try{return new URL(tab?.url).origin==='https://discord.com';}catch{return false;}}
function channelTab(tab,record){try{const url=new URL(tab?.url);return url.origin==='https://discord.com'&&[ `/channels/${record.guildId}/${record.channelId}`,`/channels/${record.guildId}/${record.channelId}/`].includes(url.pathname);}catch{return false;}}
function ownsWindow(win,records){
  return win?.type==='normal'&&win.tabs?.length>0&&win.tabs.every(tab=>records.some(record=>!['adopted','grouped'].includes(record.ownership)&&record.tabId===tab.id&&record.windowId===win.id&&channelTab(tab,record)));
}
// A stored window ID is provenance, not sufficient ownership: users can move
// ordinary tabs into a managed window. Never minimize or reuse such a window.
async function ownedWindowId(chrome,saved){
  const records=saved.dicoCentralTabs||[];
  const candidates=[saved.dicoCentralWindowId,...records.map(record=>record.windowId)].filter(Number.isInteger);
  for(const windowId of new Set(candidates)){
    let win;try{win=await chrome.windows.get(windowId,{populate:true});}catch{continue;}
    if(ownsWindow(win,records))return windowId;
  }
}
export async function createManagedWindow(chrome,target,assertCurrent=()=>{}){
  assertCurrent();
  // 새 채널은 계정 확인에 사용한 탭과 같은 창/프로필에 만듭니다.
  // 사용자 창은 이동·최소화하지 않고, 서버별 DICO 탭 그룹만 관리합니다.
  if(Number.isInteger(target.sourceTabId)){
    const source=await chrome.tabs.get(target.sourceTabId);assertCurrent();
    if(!discordTab(source)||!Number.isInteger(source.windowId))fail('ACCOUNT_UNVERIFIED','로그인 확인 탭을 찾을 수 없습니다.');
    const tab=await chrome.tabs.create({windowId:source.windowId,active:false,url:`https://discord.com/channels/${target.guildId}/${target.channelId}`});
    try{
      assertCurrent();
      const title=`DICO · ${target.guildId}`;
      const groups=await chrome.tabGroups.query({windowId:source.windowId,title});assertCurrent();
      const groupId=await chrome.tabs.group({tabIds:[tab.id],...(groups.length?{groupId:groups[0].id}:{createProperties:{windowId:source.windowId}})});assertCurrent();
      await chrome.tabGroups.update(groupId,{title,color:'blue'});assertCurrent();
      return{id:source.windowId,tabs:[tab],ownership:'grouped'};
    }catch(error){try{await chrome.tabs.remove(tab.id);}catch{}throw error;}
  }
  const saved=await chrome.storage.local.get(['dicoCentralTabs','dicoCentralWindowId']);
  const windowId=await ownedWindowId(chrome,saved),url=`https://discord.com/channels/${target.guildId}/${target.channelId}`;
  assertCurrent();
  if(Number.isInteger(windowId)){
    const tab=await chrome.tabs.create({windowId,active:false,url});
    try{assertCurrent();}catch(error){try{await chrome.tabs.remove(tab.id);}catch{}throw error;}
    await chrome.storage.local.set({dicoCentralWindowId:windowId});return{id:windowId,tabs:[tab]};
  }
  const win=await chrome.windows.create({url,type:'normal',focused:false,state:'minimized'});
  try{assertCurrent();}catch(error){try{if(win.tabs?.[0]?.id)await chrome.tabs.remove(win.tabs[0].id);}catch{}throw error;}
  if(Number.isInteger(win?.id))await chrome.storage.local.set({dicoCentralWindowId:win.id});
  return win;
}
export async function ensureConsolidatedManagedWindow(chrome,target,assertCurrent=()=>{}){
  assertCurrent();
  const saved=await chrome.storage.local.get(['dicoCentralTabs','dicoCentralWindowId']),records=saved.dicoCentralTabs||[];
  const record=records.find(item=>item.tabId===target.tabId&&item.accountId===target.accountId&&item.guildId===target.guildId&&item.channelId===target.channelId);
  if(!record)fail('MANAGED_TAB_MISSING','연결된 전송용 탭을 찾을 수 없습니다.');
  const tab=await managedTab(chrome,record);
  assertCurrent();
  // 사용자가 이미 열어 둔 탭은 연결만 빌려 씁니다. 복구 과정에서 일반 창을
  // 전송 전용 창으로 바꾸거나 사용자 탭을 이동하면 안 됩니다.
  if(['adopted','grouped'].includes(record.ownership))return tab.windowId;
  let windowId=await ownedWindowId(chrome,saved);
  assertCurrent();
  if(!Number.isInteger(windowId)){
    const win=await chrome.windows.create({tabId:tab.id,type:'normal',state:'minimized',focused:false});
    if(!Number.isInteger(win?.id))fail('WINDOW_CONSOLIDATION_PARTIAL','전송 창을 모으지 못했습니다. 기존 탭을 확인해 주세요.');
    windowId=win.id;
  }else if(tab.windowId!==windowId)await chrome.tabs.move(tab.id,{windowId,index:-1});
  // Move the existing page without reload; keep every successful move recoverable.
  assertCurrent();
  record.windowId=windowId;await chrome.storage.local.set({dicoCentralTabs:records,dicoCentralWindowId:windowId});
  return windowId;
}
async function managedTab(chrome,record){
  let tab;try{tab=await chrome.tabs.get(record.tabId);}catch{fail('MANAGED_TAB_MISSING','닫힌 전송용 탭이 있습니다. 채널 연결을 먼저 확인해 주세요.');}
  if(!Number.isInteger(tab?.windowId)||!channelTab(tab,record))fail('TARGET_MISMATCH','등록된 채널을 벗어난 전송용 탭이 있습니다. 해당 탭을 확인해 주세요.');
  return tab;
}
async function separateRecord(chrome,records,record){
  const tab=await managedTab(chrome,record);
  if(['adopted','grouped'].includes(record.ownership))return tab.windowId;
  const win=await chrome.windows.get(tab.windowId,{populate:true});
  let windowId=tab.windowId;
  if(win.type!=='normal'||win.tabs?.length!==1||win.tabs[0].id!==tab.id){
    // windows.create(tabId) moves the live page; it never navigates or copies it.
    const created=await chrome.windows.create({tabId:tab.id,type:'normal',state:'minimized',focused:false});
    if(!Number.isInteger(created?.id))throw Error('missing window');
    windowId=created.id;
  }
  record.windowId=windowId;
  // Save after each move so interrupted migrations resume from actual ownership.
  await chrome.storage.local.set({dicoCentralTabs:records});
  return windowId;
}
export async function ensureSeparateManagedWindow(chrome,target){
  const records=(await chrome.storage.local.get('dicoCentralTabs')).dicoCentralTabs||[];
  const record=records.find(item=>item.tabId===target.tabId&&item.accountId===target.accountId&&item.guildId===target.guildId&&item.channelId===target.channelId);
  if(!record)fail('MANAGED_TAB_MISSING','연결된 전송용 탭을 찾을 수 없습니다.');
  return separateRecord(chrome,records,record);
}
async function separateManagedWindows(chrome,records,target){
  // No move occurs until all recorded tabs pass preflight.
  for(const record of records)await managedTab(chrome,record);
  try{for(const record of records)await separateRecord(chrome,records,record);}
  catch{fail('WINDOW_SEPARATION_PARTIAL','창 분리를 완료하지 못했습니다. 이미 이동한 탭과 초안은 유지됩니다. 탭 상태를 확인한 뒤 다시 분리하세요.');}
  return{action:'separate',tabId:target.tabId,windowId:records.find(record=>record.tabId===target.tabId).windowId,managedTabs:records.length};
}
async function consolidateManagedWindows(chrome,records,target){
  // Preflight every existing tab before the first move. Missing targets require
  // a reconnect; consolidation must never manufacture replacement tabs.
  const tabs=[];
  for(const record of records)tabs.push(await managedTab(chrome,record));
  let windowId;
  for(const candidate of new Set(records.map(record=>record.windowId).filter(Number.isInteger))){
    let win;try{win=await chrome.windows.get(candidate,{populate:true});}catch{continue;}
    if(ownsWindow(win,records)){windowId=candidate;break;}
  }
  try{
    if(!Number.isInteger(windowId)){
      const first=tabs[0];
      const win=await chrome.windows.create({tabId:first.id,type:'normal',state:'minimized',focused:false});
      if(!Number.isInteger(win?.id))throw Error('missing window');
      windowId=win.id;first.windowId=windowId;
      records.find(record=>record.tabId===first.id).windowId=windowId;
      await chrome.storage.local.set({dicoCentralTabs:records,dicoCentralWindowId:windowId});
    }
    for(const tab of tabs){
      if(tab.windowId!==windowId)await chrome.tabs.move(tab.id,{windowId,index:-1});
      records.find(record=>record.tabId===tab.id).windowId=windowId;
      // Persist each successful move so a later failure remains recoverable.
      await chrome.storage.local.set({dicoCentralTabs:records,dicoCentralWindowId:windowId});
    }
    const win=await chrome.windows.get(windowId,{populate:true});
    if(!ownsWindow(win,records))fail('WINDOW_NOT_DEDICATED','창에 일반 탭이 추가되어 자동으로 숨기지 않았습니다.');
    await chrome.windows.update(windowId,{state:'minimized'});
  }catch(error){
    if(error.code==='WINDOW_NOT_DEDICATED')throw error;
    fail('WINDOW_CONSOLIDATION_PARTIAL','창 정리를 완료하지 못했습니다. 이미 이동한 탭은 유지됩니다. 탭 상태를 확인한 뒤 다시 정리하세요.');
  }
  return{action:'consolidate',tabId:target.tabId,windowId,visible:false,managedTabs:tabs.length};
}
async function closeManagedChannel(chrome,records,record,target){
  if(!Number.isInteger(target.tabId))return{action:'close',closed:false,alreadyClosed:true};
  let tab;try{tab=await chrome.tabs.get(target.tabId);}catch{}
  const unregister=async()=>{if(record)await chrome.storage.local.set({dicoCentralTabs:records.filter(item=>item!==record)});};
  if(!tab){await unregister();return{action:'close',tabId:target.tabId,closed:false,alreadyClosed:true};}
  // 중앙의 채널 삭제는 연결 해제까지만 수행하고 사용자가 열었던 탭은 남깁니다.
  if(target.detachOnly||record?.ownership==='adopted'){await unregister();return{action:'close',tabId:target.tabId,closed:false,detached:true};}
  // 다른 계정/채널이 소유한 탭은 이전 삭제 요청으로 해제하지 않습니다.
  if(!record&&records.some(item=>item.tabId===target.tabId))fail('WINDOW_NOT_DEDICATED','다른 연결이 사용 중인 탭은 닫지 않습니다.');
  // 화면 이동 또는 이전 정리로 소유권을 잃었다면 탭은 보존하고 연결 해제만
  // 완료합니다. 여기서 거절하면 중앙이 같은 삭제를 무한 재요청합니다.
  if(!record||!channelTab(tab,target)){
    await unregister();return{action:'close',tabId:target.tabId,closed:false,detached:true};
  }
  await chrome.tabs.remove(tab.id);
  await unregister();return{action:'close',tabId:tab.id,closed:true};
}
export function createManagedWindowController({chrome}){
  return async function manageChannelWindow(target){
    if(!['prepare','reveal','hide','consolidate','separate','close'].includes(target.action))fail('INVALID_WINDOW_ACTION','지원하지 않는 창 동작입니다.');
    const records=(await chrome.storage.local.get('dicoCentralTabs')).dicoCentralTabs||[];
    const record=records.find(item=>(target.action==='close'&&target.tabId===undefined||item.tabId===target.tabId)&&item.accountId===target.accountId&&item.guildId===target.guildId&&item.channelId===target.channelId);
    if(target.action==='close')return closeManagedChannel(chrome,records,record,{...target,tabId:record?.tabId??target.tabId});
    if(!record&&target.action==='prepare')return{action:'prepare',visible:false};
    if(!record)fail('MANAGED_TAB_MISSING','연결된 전송용 탭을 찾을 수 없습니다. 채널 연결 상태를 확인해 주세요.');
    if(target.action==='separate')return separateManagedWindows(chrome,records,target);
    if(target.action==='consolidate'){
      if(records.some(item=>item.ownership==='adopted'))fail('WINDOW_NOT_DEDICATED','직접 열어 연결한 탭은 자동으로 이동하지 않습니다. 전송 전용 탭의 창만 정리할 수 있습니다.');
      return consolidateManagedWindows(chrome,records,target);
    }
    let tab;try{tab=await chrome.tabs.get(record.tabId);}catch{fail('MANAGED_TAB_MISSING','전송용 탭이 닫혔습니다. 채널을 다시 연결해 주세요.');}
    if(!Number.isInteger(tab?.windowId)||!discordTab(tab))fail('TARGET_MISMATCH','연결된 탭이 Discord 화면이 아닙니다. 탭 상태를 확인해 주세요.');
    let win;try{win=await chrome.windows.get(tab.windowId,{populate:true});}catch{fail('MANAGED_TAB_MISSING','전송용 창을 찾을 수 없습니다.');}
    if(target.action==='prepare'){
      // 최소화된 전용 창의 Discord 타이머가 늦게 갱신되지 않도록 복원한다.
      // 사용자가 직접 연결했거나 일반 탭이 섞인 창은 자동으로 변경하지 않는다.
      if(record.windowId!==tab.windowId||!ownsWindow(win,records))return{action:'prepare',visible:false};
      await chrome.tabs.update(tab.id,{active:true});
      if(win.state==='minimized'||win.state===undefined)await chrome.windows.update(tab.windowId,{state:'normal',focused:false});
      return{action:'prepare',visible:true};
    }
    if(target.action==='hide'){
      if(record.windowId!==tab.windowId||!ownsWindow(win,records))fail('WINDOW_NOT_DEDICATED','일반 탭이 섞였거나 소유권을 확인할 수 없는 창은 자동으로 숨기지 않습니다. 전송 창 상태를 확인해 주세요.');
      await chrome.windows.update(tab.windowId,{state:'minimized'});
    }else{
      // Visibility-only: an unreadable or mismatching login/channel is exactly
      // what the user may need to inspect. Never navigate, create, bind or send.
      await chrome.tabs.update(tab.id,{active:true});
      await chrome.windows.update(tab.windowId,{focused:true,state:'normal'});
    }
    return{action:target.action,tabId:tab.id,windowId:tab.windowId,visible:target.action==='reveal'};
  };
}
