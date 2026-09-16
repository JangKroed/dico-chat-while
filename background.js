import { exportSettings } from './settings-backup.js';
import { EMAIL_ALARM, flushEmailReport } from './email-report.js';
import { recordDiagnostics, appendDiagnostics } from './diagnostics.js';
import { notifyChannelErrors } from './notifications.js';
import { waitForReady } from './readiness.js';
import { createChannelManager } from './channel-manager.js';
import { parseChannel, validateSettings } from './controller.js';

const ALARM_PREFIX = 'dico-channel:';
let queue = Promise.resolve();
const stopRequested = new Set();
let stopAllRequested = false;
const enqueue = (action, operation = 'background-event') => {
  const next = queue.then(action);
  queue = next.catch(async error => {
    const reason=String(error?.message || error).replace(/https?:\/\/\S+/g,'[URL]').slice(0,500);
    try { await appendDiagnostics(chrome,[{at:new Date().toISOString(),kind:'runtime-error',operation,reason}]); } catch {}
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
async function inspect(target) {
  if (!target) return { ok: false, error: '대상 채널을 선택해 주세요.' };
  const tab = await chrome.tabs.get(target.tabId);
  const channel = parseChannel(tab.url);
  if (!channel || channel.channelId !== target.channelId || channel.guildId !== target.guildId) {
    return { ok: false, error: '대상 탭이 다른 페이지로 이동했습니다. 원래 채널을 열거나 대상을 다시 선택해 주세요.' };
  }
  if (tab.discarded || tab.frozen) return { ok: false, error: '대상 탭이 메모리 절약 등으로 중지되었습니다. 탭을 열고 다시 시작해 주세요.' };
  const state = await manager.getState();
  const channelId = state.channels.find(item => item.target?.tabId === target.tabId)?.id;
  const message = { type: 'DICO_INSPECT', target };
  let injected = false;
  return waitForReady(async () => {
    try { return await withTimeout(chrome.tabs.sendMessage(target.tabId, message), 1500); }
    catch {
      if (!injected) {
        injected = true;
        await chrome.scripting.executeScript({ target: { tabId: target.tabId }, files: ['content.js'] });
      }
      return { ok: false, code: 'CONNECTING', retryable: true, error: 'Discord 입력창 연결을 기다리고 있습니다.' };
    }
  }, {cancelled: () => stopAllRequested || stopRequested.has(channelId)});
}
const manager = createChannelManager({
  load: async () => (await chrome.storage.local.get('state')).state,
  save: async state => {
    const previous = (await chrome.storage.local.get('state')).state;
    await chrome.storage.local.set({ state });
    try { await recordDiagnostics(chrome, previous, state); }
    catch (error) { console.warn('DICO diagnostics:', error.message); }
    try { await notifyChannelErrors(chrome, previous, state); }
    catch (error) { console.warn('DICO notification:', error.message); }
    const active = state.channels.filter(channel => channel.enabled).length;
    const error = state.channels.some(channel => channel.error);
    await chrome.action.setBadgeText({ text: active ? String(active) : error ? '!' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: active ? '#7565e8' : '#c75454' });
  },
  schedule: (channelId, when) => chrome.alarms.create(ALARM_PREFIX + channelId, { when }),
  cancel: channelId => chrome.alarms.clear(ALARM_PREFIX + channelId),
  inspect,
  send: (target, delivery) => stopAllRequested || stopRequested.has(delivery.channelId)
    ? Promise.resolve({ status: 'blocked', error: '중지 요청으로 전송을 취소했습니다.' })
    : withTimeout(chrome.tabs.sendMessage(target.tabId, { type: 'DICO_DELIVER', target, delivery }), 15000),
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

async function waitUntilLoaded(tabId) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return tab;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('전송용 탭 로딩이 지연되었습니다. 로그인 상태를 확인하고 다시 시작해 주세요.');
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
      const parsed = parseChannel(candidate.url);
      if (parsed?.channelId === channel.target.channelId && parsed.guildId === channel.target.guildId) {
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
  await waitUntilLoaded(tab.id);
  if (stopAllRequested || stopRequested.has(channelId)) throw new Error('전송용 탭 준비 중 시작이 취소되었습니다.');
  return manager.start(channelId);
}
async function startAllChannels() {
  const { channels } = await manager.getState();
  for (const channel of channels) {
    if (stopAllRequested) break;
    try { await startChannel(channel.id); }
    catch (error) { await manager.fail(channel.id, error); }
  }
  return manager.getState();
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === 'DICO_CAN_SEND' && sender.tab) {
    manager.getState().then(state => respond({
      allowed: !stopAllRequested && state.channels.some(channel =>
        !stopRequested.has(channel.id) && channel.enabled && channel.target?.tabId === sender.tab.id && channel.pending?.id === message.id),
    })).catch(() => respond({ allowed: false }));
    return true;
  }
  if (sender.tab || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  if (message?.type === 'DICO_EXPORT_SETTINGS') {
    enqueue(async()=>exportSettings(await manager.getState()), 'settings-export')
      .then(backup=>respond({ok:true,backup})).catch(error=>respond({ok:false,error:error.message}));
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
  if (message?.type === 'DICO_STOP_ALL') stopAllRequested = true;
  const action = async () => {
    switch (message?.type) {
      case 'DICO_IMPORT_SETTINGS': return manager.restoreSettings(message.backup);
      case 'DICO_ADD': return manager.add();
      case 'DICO_REMOVE': return manager.remove(message.channelId);
      case 'DICO_SAVE': return manager.updateSettings(message.channelId, message.settings, message.expectedRevision);
      case 'DICO_BIND': {
        let tab;
        if (Number.isInteger(message.tabId)) tab = await chrome.tabs.get(message.tabId);
        else [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) throw new Error('Discord 탭을 먼저 열고 선택해 주세요.');
        return manager.bind(message.channelId, { tabId: tab.id, url: tab.url, title: tab.title });
      }
      case 'DICO_START':
        stopRequested.delete(message.channelId);
        stopAllRequested = false;
        try { return await startChannel(message.channelId); }
        catch (error) {
          if (!stopAllRequested && !stopRequested.has(message.channelId)) await manager.fail(message.channelId, error);
          throw error;
        }
      case 'DICO_STOP': return manager.stop(message.channelId);
      case 'DICO_START_ALL':
        stopRequested.clear();
        stopAllRequested = false;
        return startAllChannels();
      case 'DICO_STOP_ALL': return manager.stopAll();
      case 'DICO_RESOLVE': return manager.resolvePending(message.channelId, message.resolution);
      default: throw new Error('지원하지 않는 요청입니다. 확장 프로그램과 설정 페이지를 새로고침해 주세요.');
    }
  };
  enqueue(action, String(message?.type || 'unknown')).then(state => respond({ ok: true, state })).catch(async error => {
    respond({ ok: false, error: error.message, state: await manager.getState() });
  });
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === EMAIL_ALARM) { void flushEmailReport(chrome).catch(()=>{}); return; }
  if (alarm.name.startsWith(ALARM_PREFIX)) void enqueue(() => manager.tick(alarm.name.slice(ALARM_PREFIX.length)), 'alarm-delivery');
});
chrome.runtime.onInstalled.addListener(() => void enqueue(() => recoverChannels(), 'recover-channels'));
chrome.runtime.onStartup.addListener(() => void enqueue(() => recoverChannels(), 'recover-channels'));
chrome.tabs.onRemoved.addListener(tabId => void enqueue(() => manager.targetLost(tabId, '대상 탭이 닫혀 이 채널의 자동 전송을 중지했습니다.')));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url && !change.discarded && !change.frozen) return;
  void enqueue(async () => {
    const state = await manager.getState();
    const target = state.channels.find(channel => channel.target?.tabId === tabId)?.target;
    if (!target) return;
    const channel = change.url && parseChannel(change.url);
    if (change.discarded || change.frozen || (change.url && (!channel || channel.channelId !== target.channelId || channel.guildId !== target.guildId))) {
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
