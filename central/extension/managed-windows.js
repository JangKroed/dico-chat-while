function fail(code,message){throw Object.assign(Error(message),{code});}
function discordTab(tab){try{return new URL(tab?.url).origin==='https://discord.com';}catch{return false;}}
function ownsWindow(win,records){
  return win?.type==='normal'&&win.tabs?.length>0&&win.tabs.every(tab=>discordTab(tab)&&records.some(record=>record.tabId===tab.id&&record.windowId===win.id));
}
// A stored window ID is provenance, not sufficient ownership: users can move
// ordinary tabs into a managed window. Never minimize or reuse such a window.
export async function createManagedWindow(chrome,target){
  // One active tab per window keeps channels from competing for tab activation.
  // Moving existing tabs uses the helper below so their drafts survive.
  return chrome.windows.create({url:`https://discord.com/channels/${target.guildId}/${target.channelId}`,type:'normal',focused:false,state:'minimized'});
}
async function managedTab(chrome,record){
  let tab;try{tab=await chrome.tabs.get(record.tabId);}catch{fail('MANAGED_TAB_MISSING','닫힌 전송용 탭이 있습니다. 채널 연결을 먼저 확인해 주세요.');}
  if(!Number.isInteger(tab?.windowId)||!discordTab(tab))fail('TARGET_MISMATCH','Discord를 벗어난 전송용 탭이 있습니다. 해당 탭을 확인해 주세요.');
  return tab;
}
async function separateRecord(chrome,records,record){
  const tab=await managedTab(chrome,record);
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
  for(const record of records){
    let tab;try{tab=await chrome.tabs.get(record.tabId);}catch{fail('MANAGED_TAB_MISSING','닫힌 전송용 탭이 있습니다. 채널 연결을 먼저 확인해 주세요.');}
    if(!Number.isInteger(tab?.windowId)||!discordTab(tab))fail('TARGET_MISMATCH','Discord를 벗어난 전송용 탭이 있습니다. 해당 탭을 확인해 주세요.');
    tabs.push(tab);
  }
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
export function createManagedWindowController({chrome}){
  return async function manageChannelWindow(target){
    if(!['reveal','hide','consolidate','separate'].includes(target.action))fail('INVALID_WINDOW_ACTION','지원하지 않는 창 동작입니다.');
    const records=(await chrome.storage.local.get('dicoCentralTabs')).dicoCentralTabs||[];
    const record=records.find(item=>item.tabId===target.tabId&&item.accountId===target.accountId&&item.guildId===target.guildId&&item.channelId===target.channelId);
    if(!record)fail('MANAGED_TAB_MISSING','연결된 전송용 탭을 찾을 수 없습니다. 채널 연결 상태를 확인해 주세요.');
    if(target.action==='separate')return separateManagedWindows(chrome,records,target);
    if(target.action==='consolidate')return consolidateManagedWindows(chrome,records,target);
    let tab;try{tab=await chrome.tabs.get(record.tabId);}catch{fail('MANAGED_TAB_MISSING','전송용 탭이 닫혔습니다. 채널을 다시 연결해 주세요.');}
    if(!Number.isInteger(tab?.windowId)||!discordTab(tab))fail('TARGET_MISMATCH','연결된 탭이 Discord 화면이 아닙니다. 탭 상태를 확인해 주세요.');
    let win;try{win=await chrome.windows.get(tab.windowId,{populate:true});}catch{fail('MANAGED_TAB_MISSING','전송용 창을 찾을 수 없습니다.');}
    if(target.action==='hide'){
      if(record.windowId!==tab.windowId||win.tabs?.length!==1||!ownsWindow(win,records))fail('WINDOW_NOT_DEDICATED','여러 탭이 있거나 소유권을 확인할 수 없는 창은 자동으로 숨기지 않습니다. 계정·브라우저에서 채널별 창 분리를 먼저 실행해 주세요.');
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
