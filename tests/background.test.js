import test from 'node:test';
import assert from 'node:assert/strict';

function event() {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), fire: (...args) => listeners.forEach(fn => fn(...args)), listeners };
}

test('실제 background 메시지 연결: 채널별 예약·중지·오래된 저장 차단', async () => {
  let stored;
  let clock = 1800000000000;
  const originalNow = Date.now;
  Date.now = () => clock;
  const alarms = new Map();
  const onMessage = event();
  const onAlarm = event();
  const tabs = new Map([
    [1, { id: 1, title: '첫 채널', status:'complete', url: 'https://discord.com/channels/123/456' }],
    [2, { id: 2, title: '둘째 채널', status:'complete', url: 'https://discord.com/channels/123/789' }],
  ]);
  stored = {version:1,messages:['기존 A','기존 B'],ownUserId:'',intervalSeconds:30,enabled:true,target:{tabId:1,url:'https://discord.com/channels/123/456',channelId:'456',guildId:'123'},nextIndex:1,nextRunAt:clock-1000,pending:null,error:null,history:[],lastSentAt:null};
  let nextTabId = 100;
  const created = [];
  const reloaded = [];
  let openingTab = false;
  let loadingReads = 0;
  let holdDelivery = false;
  let releaseDelivery;
  let startedDelivery;
  const deliveryStarted = new Promise(resolve => { startedDelivery = resolve; });
  const waitDelivery = new Promise(resolve => { releaseDelivery = resolve; });
  globalThis.chrome = {
    notifications: {create: async () => {}, onClicked: event()},
    windows: { create: async spec => {
      const tab=spec.tabId?tabs.get(spec.tabId):{id:++nextTabId,title:'전송용 창',url:spec.url,status:'complete'};
      if (openingTab) { tab.pendingUrl=tab.url; tab.url=''; tab.status='loading'; loadingReads=0; }
      tabs.set(tab.id,tab);created.push({...spec,id:tab.id});return {id:tab.id,tabs:[tab]};
    } },
    storage: { local: { get: async () => ({ state: structuredClone(stored) }), set: async values => { if ('state' in values) stored = structuredClone(values.state); } } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    alarms: { create: async (name, spec) => alarms.set(name, spec), clear: async name => alarms.delete(name), onAlarm },
    runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`, onMessage, onInstalled: event(), onStartup: event() },
    scripting: { executeScript: async () => {} },
    tabs: { reload: async id => { reloaded.push(id); tabs.get(id).discarded=false; tabs.get(id).frozen=false; }, create: async spec => { const tab={id:++nextTabId,title:'전송용 탭',url:spec.url,status:'complete'};tabs.set(tab.id,tab);created.push({...spec,id:tab.id});return tab; }, get: async id => { const tab=tabs.get(id); if (tab?.pendingUrl && ++loadingReads>1) { tab.url=tab.pendingUrl; delete tab.pendingUrl; tab.status='complete'; } return tab; }, query: async () => [...tabs.values()], onRemoved: event(), onUpdated: event(), sendMessage: async (tabId, message) => {
      if (message.type === 'DICO_INSPECT') { assert.equal(tabs.get(tabId).status,'complete'); assert.equal(tabs.get(tabId).pendingUrl,undefined); return { ok: true }; }
      if (message.type === 'DICO_DELIVER') {
        if (holdDelivery) { startedDelivery({...message,tabId}); await waitDelivery; }
        return { status: 'confirmed' };
      }
    } },
  };
  const request = (message, sender = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' }) =>
    new Promise(resolve => onMessage.listeners[0](message, sender, resolve));
  try {
    await import('../background.js');
    let reply = await request({ type: 'DICO_ADD' });
    assert.equal(reply.ok, true);
    assert.equal(reply.state.channels.length, 2);
    assert.equal(reply.state.channels[0].enabled,false,'legacy original-tab schedule stops on upgrade');
    assert.equal(reply.state.channels[0].nextIndex,1,'legacy next B preserved');
    const ids = reply.state.channels.map(channel => channel.id);
    for (let index = 0; index < 2; index++) {
      reply = await request({ type: 'DICO_BIND', channelId: ids[index], tabId: index + 1 });
      assert.equal(reply.ok, true);
      const channel = reply.state.channels.find(value => value.id === ids[index]);
      reply = await request({ type: 'DICO_SAVE', channelId: ids[index], expectedRevision: channel.settingsRevision,
        settings: { name: `채널 ${index + 1}`, messages: [`A${index}`, `B${index}`], ownUserId: '', intervalSeconds: 30 } });
      assert.equal(reply.ok, true);
    }
    reply = await request({ type: 'DICO_START_ALL' });
    assert.equal(reply.state.channels.filter(channel => channel.enabled).length, 2);
    assert.equal(alarms.size, 2);
    assert.equal(created.length, 2);
    assert.equal(created.every(tab=>tab.focused===false), true);
    assert.equal(reply.state.channels[0].target.managed, true);
    assert.equal(reply.state.channels[0].target.windowManaged, true);
    assert.equal(reply.state.channels[0].nextIndex, 0, 'start sends preserved B immediately');
    chrome.tabs.onUpdated.fire(1,{url:'https://discord.com/channels/123/999'});
    reply=await request({type:'DICO_START',channelId:ids[0]});
    assert.equal(reply.state.channels.filter(channel=>channel.enabled).length,2,'ordinary user tab navigation does not stop dedicated senders');
    assert.equal(created.length,2);
    holdDelivery = true;
    clock += 30000;
    onAlarm.fire({ name: `dico-channel:${ids[0]}` });
    const delivery = await deliveryStarted;
    assert.equal(delivery.tabId, 101, 'send uses dedicated tab, not original tab');
    const live = await request({ type: 'DICO_GET' });
    assert.ok(live.state.channels[0].pending, 'GET must not wait for delivery');
    const stopPromise = request({ type: 'DICO_STOP', channelId: ids[0] });
    const permitted = await request({ type: 'DICO_CAN_SEND', id: delivery.delivery.id }, { id: 'test-extension', tab: { id: 101 } });
    assert.equal(permitted.allowed, false);
    releaseDelivery();
    reply = await stopPromise;
    assert.equal(reply.state.channels[0].enabled, false);
    assert.equal(reply.state.channels[0].nextIndex, 1);
    assert.equal(reply.state.channels[1].enabled, true);
    assert.equal(reply.state.channels[1].nextIndex, 1);
    assert.equal(alarms.has(`dico-channel:${ids[0]}`), false);
    assert.equal(alarms.has(`dico-channel:${ids[1]}`), true);
    const revision = reply.state.channels[0].settingsRevision;
    const settings = { name: '수정', messages: ['새 A', '새 B'], ownUserId: '', intervalSeconds: 60 };
    assert.equal((await request({ type: 'DICO_SAVE', channelId: ids[0], settings, expectedRevision: revision })).ok, true);
    assert.equal((await request({ type: 'DICO_SAVE', channelId: ids[0], settings: {...settings,messages:['오래된 A','B']}, expectedRevision: revision })).ok, false);
    reply = await request({ type: 'DICO_STOP_ALL' });
    assert.equal(reply.state.channels.some(channel => channel.enabled), false);
    assert.equal(alarms.size, 0);
    assert.deepEqual(reply.state.channels[0].messages, ['새 A', '새 B']);
    holdDelivery = false;
    tabs.get(101).discarded=true;
    reply=await request({type:'DICO_START',channelId:ids[0]});
    assert.equal(reply.ok,true);
    assert.equal(created.length,2,'resume reuses existing dedicated tab');
    assert.deepEqual(reloaded,[101],'discarded sender is reloaded, not duplicated');
    await request({type:'DICO_STOP_ALL'});
    tabs.delete(101);
    openingTab = true;
    reply=await request({type:'DICO_START',channelId:ids[0]});
    assert.equal(reply.ok,true);
    assert.equal(created.length,3,'closed dedicated tab recreated');
    assert.ok(loadingReads>=2,'new window waits for the committed channel URL');
    assert.equal(reply.state.channels[0].enabled,true);
    assert.equal(reply.state.channels[0].pending,null);
    const recreatedId=reply.state.channels[0].target.tabId;
    chrome.tabs.onUpdated.fire(recreatedId,{url:'about:blank'});
    chrome.tabs.onUpdated.fire(recreatedId,{discarded:true});
    reply=await request({type:'DICO_START',channelId:ids[0]});
    assert.equal(reply.state.channels[0].enabled,true,'queued stale events do not stop the ready replacement');
    assert.equal(created.length,3,'restart reuses the replacement window');
    tabs.get(recreatedId).url='https://discord.com/channels/123/999';
    chrome.tabs.onUpdated.fire(recreatedId,{status:'complete'});
    await request({type:'DICO_STOP',channelId:ids[1]});
    reply=await request({type:'DICO_GET'});
    assert.equal(reply.state.channels[0].enabled,false,'real navigation still stops the sender');
    assert.match(reply.state.channels[0].error,/이동/);
    await request({type:'DICO_STOP_ALL'});
  } finally {
    releaseDelivery();
    Date.now = originalNow;
    delete globalThis.chrome;
  }
});
