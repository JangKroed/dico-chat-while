import { diagnosticRequest } from './diagnostic-request.js';
import { recoverLoading } from './loading-recovery.js';
import { exportSettings } from './settings-backup.js';
import { EMAIL_ALARM, flushEmailReport } from './email-report.js';
import { recordDiagnostics, appendDiagnostics, deliveryTraceEvent, channelDiagnostic, uiDiagnostic, inspectionDiagnostic } from './diagnostics.js';
import { notifyChannelErrors } from './notifications.js';
import { waitForReady, tabReadiness } from './readiness.js';
import { createChannelQueue } from './channel-queue.js';
import { createChannelManager } from './channel-manager.js';
import { parseChannel, validateSettings } from './controller.js';

const ALARM_PREFIX = 'dico-channel:';
const queue = createChannelQueue();
const stopRequested = new Set();
let stopAllRequested = false;
const startsAfterStopAll = new Set();
const isStopped = id => stopRequested.has(id) || (stopAllRequested && !startsAfterStopAll.has(id));
const enqueue = (action, operation = 'background-event', key = 'control') => {
  const next = queue.run(key, action);
  void next.catch(async error => {
    const reason=String(error?.message || error).replace(/https?:\/\/\S+/g,'[URL]').slice(0,500);
    try { await appendDiagnostics(chrome,[{at:new Date().toISOString(),kind:'runtime-error',channelKey:key,operation,reason}]); } catch {}
    console.warn('Dico While:', operation, reason);
  });
  return next;
};
const withTimeout = (promise, milliseconds) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('응답 시간 초과')), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
};
function traceChannel(channelId,kind,details={}) {
  const at=new Date().toISOString();
  return manager.getState().then(state=>{
    const index=state.channels.findIndex(c=>c.id===channelId);
    return appendDiagnostics(chrome,[{...channelDiagnostic(state.channels[index],index,state.revision),channelKey:channelId,at,kind,...details}]);
  }).catch(()=>{});
}
async function inspect(target) {
  if (!target) return { ok: false, error: '대상 채널을 선택해 주세요.' };
  const state = await manager.getState();
  const channel = state.channels.find(item => item.target?.tabId === target.tabId);
  const cancelled = () => isStopped(channel?.id);
  const key = `loadingRecovery:${target.tabId}`;
  const probe = () => waitForReady(async () => {
    let tab;
    try { tab = await chrome.tabs.get(target.tabId); }
    catch { return {ok:false,code:'TAB_MISSING',error:'전송용 탭이 닫혔습니다.'}; }
    const readiness = tabReadiness(tab, target);
    if (!readiness.ok) return readiness;
    try {
      const result=await withTimeout(chrome.tabs.sendMessage(target.tabId,{type:'DICO_INSPECT',target}),5000);
      if(!result?.ok && channel) {
        try { await withTimeout(appendDiagnostics(chrome,[inspectionDiagnostic(result || {},channel,state.channels.indexOf(channel),state.revision)]),1500); } catch {}
      }
      return result;
    }
    catch {
      try { await chrome.scripting.executeScript({target:{tabId:target.tabId},files:['emoji-data.js','content.js']}); } catch {}
      return {ok:false,code:'CONNECTING',retryable:true,error:'Discord 입력창 연결을 기다리고 있습니다.'};
    }
  },{attempts:15,cancelled});
  // A pending delivery is never reloaded or sent again automatically.
  if (!target.managed || channel?.pending || channel?.prepared) return probe();
  return recoverLoading({probe,cancelled,
    readCount:async()=> (await chrome.storage.local.get(key))[key] || 0,
    saveCount:count=>chrome.storage.local.set({[key]:count}),
    reload:()=>chrome.tabs.reload(target.tabId),
    onAttempt:async(attempt,code)=>{
      await chrome.storage.local.set({[`loadingRecoveryStatus:${channel?.id || target.tabId}`]:{channelId:channel?.id,attempt,at:Date.now()}});
      try { await appendDiagnostics(chrome,[{at:new Date().toISOString(),kind:'loading-recovery',channel:state.channels.indexOf(channel)+1,attempt,reason:code}]); } catch {}
    },
  }).finally(()=>chrome.storage.local.set({[`loadingRecoveryStatus:${channel?.id || target.tabId}`]:null}));
}
const manager = createChannelManager({
  load: async () => (await chrome.storage.local.get('state')).state,
  save: async state => {
    const previous = (await chrome.storage.local.get('state')).state;
    await chrome.storage.local.set({ state });
    // State is durable above. Telemetry must not hold the channel commit queue:
    // a slow log write otherwise delays preparation and permission replies.
    void recordDiagnostics(chrome, previous, state).catch(error=>console.warn('DICO diagnostics:',error.message));
    try { await notifyChannelErrors(chrome, previous, state); }
    catch (error) { console.warn('DICO notification:', error.message); }
    const active = state.channels.filter(channel => channel.enabled).length;
    const error = state.channels.some(channel => channel.error);
    await chrome.action.setBadgeText({ text: active ? String(active) : error ? '!' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: active ? '#7565e8' : '#c75454' });
  },
  schedule: async (channelId, when) => {
    await chrome.alarms.create(ALARM_PREFIX + channelId, { when });
    void traceChannel(channelId,'alarm-scheduled',{alarmName:ALARM_PREFIX+channelId,alarmScheduledAt:when});
  },
  cancel: async channelId => { const removed=await chrome.alarms.clear(ALARM_PREFIX+channelId);void traceChannel(channelId,'alarm-cancelled',{removed});return removed; },
  inspect,
  prepare: (target, delivery) => isStopped(delivery.channelId)
    ? Promise.resolve({status:'blocked',error:'중지 요청으로 입력 준비를 취소했습니다.'})
    : diagnosticRequest(()=>chrome.tabs.sendMessage(target.tabId,{type:'DICO_PREPARE',target,delivery}),{timeoutMs:10000,operation:'prepare',record:event=>appendDiagnostics(chrome,[{...event,channelKey:delivery.channelId,deliveryId:delivery.id,tabId:target.tabId,at:new Date(event.eventAt).toISOString()}])}),
  waitUntil: async (id, when) => {
    while (!isStopped(id) && Date.now()<when) await new Promise(resolve=>setTimeout(resolve,Math.min(250,when-Date.now())));
    if (isStopped(id)) throw new Error('중지 요청으로 전송 대기를 취소했습니다.');
  },
  send: (target, delivery) => isStopped(delivery.channelId)
    ? Promise.resolve({ status: 'blocked', error: '중지 요청으로 전송을 취소했습니다.' })
    : diagnosticRequest(()=>chrome.tabs.sendMessage(target.tabId,{type:'DICO_DELIVER',target,delivery}),{timeoutMs:35000,operation:'send',record:event=>appendDiagnostics(chrome,[{...event,channelKey:delivery.channelId,deliveryId:delivery.id,tabId:target.tabId,at:new Date(event.eventAt).toISOString()}])}),
  reconcile: async (target, delivery) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (isStopped(delivery.channelId)) break;
      try {
        const result = await withTimeout(chrome.tabs.sendMessage(target.tabId, {type:'DICO_RECONCILE',target,delivery}),2000);
        if (result?.status === 'confirmed') return result;
      } catch { /* Read-only retries do not authorize a second delivery. */ }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve,2000));
    }
    return {status:'uncertain'};
  },
  now: () => Date.now(),
  id: () => crypto.randomUUID(),
});
void enqueue(async () => {
  await manager.getState();
  await chrome.alarms.clear('dico-next-delivery');
  await recoverChannels({ preserveDue: true });
});


async function recoverChannels(options) {
  const {channels}=await manager.getState();
  // Older schedules lack a dedicated window. Explicit start prepares it
  // while preserving the next message and any uncertain delivery.
  for (const channel of channels) {
    if (channel.enabled && !channel.target?.windowManaged) await manager.stop(channel.id);
  }
  return manager.recover(options);
}

async function startChannel(channelId) {
  const state = await manager.getState();
  const channel = state.channels.find(item => item.id === channelId);
  if (!channel) throw new Error('채널 설정을 찾을 수 없습니다.');
  if (channel.enabled) return state;
  if (channel.pending) throw new Error('이전 전송 결과를 먼저 확인해 주세요.');
  validateSettings(channel);
  if (!channel.target || !parseChannel(channel.target.url)) throw new Error('Discord 채널을 먼저 지정해 주세요.');
  let tab;
  if (channel.target.managed) {
    try {
      const candidate = await chrome.tabs.get(channel.target.tabId);
      const readiness = tabReadiness(candidate, channel.target);
      if (readiness.ok || readiness.code === 'PAGE_LOADING' || readiness.code === 'TAB_SUSPENDED') {
        tab = candidate;
        if (candidate.discarded || candidate.frozen) await chrome.tabs.reload(candidate.id);
      }
    } catch { /* A closed dedicated tab is recreated on explicit start. */ }
  }
  if (!tab || !channel.target.windowManaged) {
    const window = await chrome.windows.create({
      ...(tab ? {tabId: tab.id} : {url: channel.target.url}),
      type: 'normal', focused: false, width: 1000, height: 800,
    });
    tab = window.tabs?.[0] || (await chrome.tabs.query({windowId: window.id}))[0];
    if (!tab) throw new Error('전송용 창을 생성하지 못했습니다.');
    await manager.bind(channelId, { ...channel.target, tabId: tab.id, managed: true, windowManaged: true });
  }
  await chrome.storage.local.set({[`loadingRecovery:${tab.id}`]:0});
  if (isStopped(channelId)) throw new Error('전송용 탭 준비 중 시작이 취소되었습니다.');
  return manager.start(channelId);
}
async function startAllChannels() {
  const { channels } = await manager.getState();
  await Promise.all(channels.map(channel => enqueue(async () => {
    if (isStopped(channel.id)) return;
    try { await startChannel(channel.id); }
    catch (error) {
      if (!isStopped(channel.id)) await manager.fail(channel.id, error);
    }
  }, 'start-channel', channel.id)));
  return manager.getState();
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === 'DICO_TRACE' && sender.tab) {
    // Do not enqueue behind the delivery whose progress we are recording.
    manager.getState().then(async state => {
      const event = deliveryTraceEvent(message, state, sender.tab.id);
      if (event) await appendDiagnostics(chrome, [event]);
      respond({ok:Boolean(event)});
    }).catch(() => respond({ok:false}));
    return true;
  }
  if (message?.type === 'DICO_CAN_SEND' && sender.tab) {
    manager.getState().then(state => respond({
      allowed: state.channels.some(channel =>
        !isStopped(channel.id) && channel.enabled && channel.target?.tabId === sender.tab.id && (message.phase==='prepare' ? !channel.pending && channel.prepared?.phase==='preparing' && channel.prepared.id===message.id : channel.pending?.id===message.id && Date.now()>=channel.pending.scheduledAt)),
    })).catch(() => respond({ allowed: false }));
    return true;
  }
  if (sender.tab || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  if (message?.type === 'DICO_EXPORT_SETTINGS') {
    enqueue(async()=>exportSettings(await manager.getState()), 'settings-export')
      .then(backup=>respond({ok:true,backup})).catch(error=>respond({ok:false,error:error.message}));
    return true;
  }
  if (message?.type === 'DICO_UI_SCHEDULE') {
    manager.getState().then(async state=>{
      const event=uiDiagnostic(message,state);
      if(event) await appendDiagnostics(chrome,[event]);
      respond({ok:Boolean(event)});
    }).catch(()=>respond({ok:false}));
    return true;
  }
  if (message?.type === 'DICO_GET') {
    manager.getState().then(state => respond({ ok: true, state })).catch(error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'DICO_TABS') {
    chrome.tabs.query({ url: 'https://discord.com/channels/*' }).then(tabs => respond({
      ok: true, tabs: tabs.filter(tab => parseChannel(tab.url)).map(tab => ({ id: tab.id, title: tab.title, url: tab.url })),
    })).catch(error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'DICO_STOP') stopRequested.add(message.channelId);
  if (message?.type === 'DICO_STOP_ALL') { stopAllRequested = true; startsAfterStopAll.clear(); }
  if (message?.type === 'DICO_START') { stopRequested.delete(message.channelId); startsAfterStopAll.add(message.channelId); }
  if (message?.type === 'DICO_START_ALL') { stopRequested.clear(); stopAllRequested = false; }
  const requestedAt=Date.now();
  if(message.channelId) void traceChannel(message.channelId,'control-request',{
    operation:String(message.type || '').slice(0,60),requestedAt,
    ...(message.type==='DICO_SAVE'?{requestedIntervalSeconds:Number.isFinite(message.settings?.intervalSeconds)?message.settings.intervalSeconds:null,expectedSettingsRevision:message.expectedRevision ?? null,requestedSkipConfirmation:message.settings?.skipConfirmation===true}:{}),
    ...(message.type==='DICO_BIND'?{requestedTabId:Number.isInteger(message.tabId)?message.tabId:null}:{}),
  });
  const action = async () => {
    switch (message?.type) {
      case 'DICO_IMPORT_SETTINGS': return manager.restoreSettings(message.backup);
      case 'DICO_ADD': return manager.add();
      case 'DICO_REMOVE': return manager.remove(message.channelId);
      case 'DICO_SAVE': return manager.updateSettings(message.channelId, message.settings, message.expectedRevision);
      case 'DICO_BIND': {
        let tab;
        if (Number.isInteger(message.tabId)) tab = await chrome.tabs.get(message.tabId);
        else [tab] = await chrome.tabs.query(Number.isInteger(message.windowId) ? {active:true,windowId:message.windowId} : {active:true,lastFocusedWindow:true});
        if (!tab) throw new Error('Discord 탭을 먼저 열고 선택해 주세요.');
        let slowmodeSeconds=null;
        const target=parseChannel(tab.url);
        if(target) {
          const probe=()=>withTimeout(chrome.tabs.sendMessage(tab.id,{type:'DICO_CHANNEL_LIMIT',target}),5000);
          try { slowmodeSeconds=(await probe())?.slowmodeSeconds; }
          catch {
            try { await chrome.scripting.executeScript({target:{tabId:tab.id},files:['emoji-data.js','content.js']}); slowmodeSeconds=(await probe())?.slowmodeSeconds; } catch {}
          }
        }
        return manager.bind(message.channelId, { tabId: tab.id, url: tab.url, title: tab.title, slowmodeSeconds });
      }
      case 'DICO_START':
        try { return await startChannel(message.channelId); }
        catch (error) {
          if (!isStopped(message.channelId)) await manager.fail(message.channelId, error);
          throw error;
        }
      case 'DICO_STOP': return manager.stop(message.channelId);
      case 'DICO_START_ALL':
        return startAllChannels();
      case 'DICO_STOP_ALL': return manager.stopAll();
      case 'DICO_RESOLVE': return manager.resolvePending(message.channelId, message.resolution);
      default: throw new Error('지원하지 않는 요청입니다. 확장 프로그램과 설정 페이지를 새로고침해 주세요.');
    }
  };
  enqueue(action, String(message?.type || 'unknown'), message.channelId || (message?.type === 'DICO_STOP_ALL' ? 'stop-all' : 'control')).then(state => { if(message.channelId) void traceChannel(message.channelId,'control-completed',{operation:message.type,requestedAt}); respond({ ok: true, state }); }).catch(async error => {
    if(message.channelId) void traceChannel(message.channelId,'control-failed',{operation:message.type,requestedAt});
    respond({ ok: false, error: error.message, state: await manager.getState() });
  });
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === EMAIL_ALARM) { void flushEmailReport(chrome).catch(()=>{}); return; }
  if (alarm.name.startsWith(ALARM_PREFIX)) {
    const id=alarm.name.slice(ALARM_PREFIX.length),firedAt=Date.now();
    void traceChannel(id,'alarm-fired',{alarmName:alarm.name,alarmScheduledAt:alarm.scheduledTime,firedAt,alarmLatenessMs:firedAt-alarm.scheduledTime});
    void enqueue(()=>{void traceChannel(id,'alarm-processing',{firedAt,queueWaitMs:Date.now()-firedAt});return manager.tick(id);},'alarm-delivery',id);
  }
});
// Reapply when the worker starts, including install, update and browser restart.
void enqueue(() => chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}), 'configure-side-panel');
chrome.runtime.onInstalled.addListener(() => void enqueue(() => recoverChannels(), 'recover-channels'));
chrome.runtime.onStartup.addListener(() => void enqueue(() => recoverChannels(), 'recover-channels'));
function enqueueForTab(tabId, action) {
  void manager.getState().then(state => Promise.all(state.channels
    .filter(channel => channel.target?.tabId === tabId)
    .map(channel => enqueue(action, 'tab-event', channel.id)))).catch(() => {});
}
chrome.tabs.onRemoved.addListener(tabId => enqueueForTab(tabId, () => manager.targetLost(tabId, '대상 탭이 닫혀 이 채널의 자동 전송을 중지했습니다.')));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url && !change.discarded && !change.frozen && change.status !== 'complete') return;
  enqueueForTab(tabId, async () => {
    const state = await manager.getState();
    const target = state.channels.find(channel => channel.target?.tabId === tabId)?.target;
    if (!target) return;
    // Events may have waited behind a send/start. Inspect the current tab,
    // not a stale blank URL or suspension event from before recovery.
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return; }
    const readiness = tabReadiness(tab, target);
    if (readiness.code === 'WRONG_CHANNEL' || readiness.code === 'TAB_SUSPENDED') {
      return manager.targetLost(tabId, '대상 탭이 이동하거나 메모리 절약으로 중지되어 이 채널의 자동 전송을 중지했습니다.');
    }
  });
});

chrome.notifications.onClicked.addListener(id => {
  if (id.startsWith("dico-error:")) {
    void chrome.runtime.openOptionsPage();
    void chrome.notifications.clear(id);
  }
});
