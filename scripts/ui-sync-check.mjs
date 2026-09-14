// Two actual Chrome pages share the real channel manager. All page requests
// are served from this workspace; the transport never sends Discord messages.
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createChannelManager } from '../channel-manager.js';
let stored;
let nextId = 1;
const pages = [];
const requestTypes = [];
let holdNextDelivery = false;
let releaseDelivery;
const manager = createChannelManager({
  load: async () => structuredClone(stored),
  save: async state => {
    stored = structuredClone(state);
    for (const page of pages) void page.command('Runtime.evaluate', { expression: `window.emitState?.(${JSON.stringify(stored)})` });
  },
  schedule: async () => {}, cancel: async () => {},
  inspect: async () => ({ ok: true }), send: async () => {
    if (holdNextDelivery) { holdNextDelivery=false; await new Promise(resolve=>{releaseDelivery=resolve;}); }
    return {status:'confirmed'};
  },
  now: () => Date.now(), id: () => `test-channel-${nextId++}`,
});
const tabs = [{ id: 1, title: '첫 공지', url: 'https://discord.com/channels/123/456' }, { id: 2, title: '둘째 공지', url: 'https://discord.com/channels/123/789' }];
async function dispatch(message) {
  requestTypes.push(message.type);
  try {
    let state;
    switch (message.type) {
      case 'DICO_GET': state = await manager.getState(); break;
      case 'DICO_TABS': return { ok: true, tabs };
      case 'DICO_ADD': state = await manager.add(); break;
      case 'DICO_REMOVE': state = await manager.remove(message.channelId); break;
      case 'DICO_SAVE': state = await manager.updateSettings(message.channelId, message.settings, message.expectedRevision); break;
      case 'DICO_BIND': {
        const tab = tabs.find(tab => tab.id === message.tabId) || tabs[0];
        state = await manager.bind(message.channelId, { tabId: tab.id, ...tab }); break;
      }
      case 'DICO_START': state = await manager.start(message.channelId); break;
      case 'DICO_STOP': state = await manager.stop(message.channelId); break;
      case 'DICO_START_ALL': state = await manager.startAll(); break;
      case 'DICO_STOP_ALL': state = await manager.stopAll(); break;
      case 'DICO_RESOLVE': state = await manager.resolvePending(message.channelId, message.resolution); break;
      default: throw new Error(`unknown message: ${message.type}`);
    }
    return { ok: true, state };
  } catch (error) { return { ok: false, error: error.message, state: await manager.getState() }; }
}
async function makePage(filename, width, height) {
  const tab = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json();
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  socket.addEventListener('message', async event => {
    const data = JSON.parse(event.data);
    if (data.id) {
      const waiting = pending.get(data.id); pending.delete(data.id);
      if (data.error) waiting?.reject(new Error(data.error.message)); else waiting?.resolve(data.result);
    } else if (data.method === 'Fetch.requestPaused') {
      const { requestId, request } = data.params;
      const file = new URL(request.url).pathname.slice(1);
      const allowed = ['popup.html', 'options.html', 'ui.js', 'ui-state.js', 'styles.css'];
      const body = allowed.includes(file) ? await readFile(new URL(`../${file}`, import.meta.url), 'utf8') : '';
      await command('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }], body: Buffer.from(body).toString('base64') });
    } else if (data.method === 'Runtime.bindingCalled') {
      const { id, message } = JSON.parse(data.params.payload);
      const reply = await dispatch(message);
      await evaluate(`window.deliverReply(${id},${JSON.stringify(reply)})`);
    } else if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text);
  });
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Runtime.addBinding', { name: 'dicoBridge' });
  await command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `
    let nextRequest=0; const callbacks=new Map(); const listeners=[];
    window.chrome={runtime:{lastError:null,openOptionsPage(){},sendMessage(message,callback){
      if(!callback) return new Promise(resolve=>chrome.runtime.sendMessage(message,resolve));
      const id=++nextRequest;callbacks.set(id,callback);window.dicoBridge(JSON.stringify({id,message}));
    }},storage:{onChanged:{addListener(listener){listeners.push(listener);}}}};
    window.deliverReply=(id,reply)=>{callbacks.get(id)?.(reply);callbacks.delete(id);};
    window.emitState=state=>{for(const listener of listeners)listener({state:{newValue:state}},'local');};
  ` });
  const page = { command, evaluate, errors, close: async () => { await command('Page.close'); socket.close(); } };
  pages.push(page);
  await command('Page.navigate', { url: `https://extension.test/${filename}` });
  return page;
}
const waitFor = async (page, expression) => {
  for (let count = 0; count < 80; count++) {
    if (await page.evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Condition timed out: ${expression}`);
};
const edit = (page, selector, value) => page.evaluate(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const click = (page, selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
let checks = 0;
const check = async (name, action) => { await action(); checks++; console.log(`PASS ${name}`); };
try {
  const initial = await manager.getState();
  const id = initial.channels[0].id;
  await manager.bind(id, { tabId: 1, ...tabs[0] });
  let channel = (await manager.getState()).channels[0];
  await manager.updateSettings(id, { name: '첫 공지', messages: ['원래 A', '원래 B'], intervalSeconds: 30, ownUserId: '' }, channel.settingsRevision);
  const options = await makePage('options.html', 1200, 960);
  const popup = await makePage('popup.html', 380, 600);
  await waitFor(options, "document.querySelector('#message-a')?.value === '원래 A'");
  await waitFor(popup, "document.querySelector('#message-a')?.value === '원래 A'");
  const olderState=await manager.getState();
  await check('설정 페이지 저장이 열린 팝업에 동기화된다', async () => {
    await edit(options, '#message-a', '설정에서 저장한 A');
    await click(options, '#save-button');
    await waitFor(popup, "document.querySelector('#message-a').value === '설정에서 저장한 A'");
  });
  await check('늦게 도착한 이전 저장 상태는 최신 화면을 되돌리지 않는다', async () => {
    await popup.evaluate(`window.emitState(${JSON.stringify(olderState)})`);
    assert.equal(await popup.evaluate("document.querySelector('#message-a').value"),'설정에서 저장한 A');
  });
  await check('팝업 저장도 열린 설정 페이지에 동기화된다', async () => {
    await edit(popup, '#message-b', '팝업에서 저장한 B');
    await click(popup, '#save-button');
    await waitFor(options, "document.querySelector('#message-b').value === '팝업에서 저장한 B'");
  });
  await check('동시 편집에서 오래된 초안으로 덮어쓰지 않는다', async () => {
    await edit(popup, '#message-a', '저장 전 초안');
    await edit(options, '#message-a', '새로 확정된 A');
    await click(options, '#save-button');
    await waitFor(popup, "document.querySelector('#save-button').disabled");
    assert.equal(await popup.evaluate("document.querySelector('#message-a').value"), '저장 전 초안');
    assert.equal((await manager.getState()).channels[0].messages[0], '새로 확정된 A');
  });
  await check('충돌 후 최신 설정을 불러오면 두 화면이 일치한다', async () => {
    await click(popup, '#reload-button');
    await waitFor(popup, "document.querySelector('#message-a').value === '새로 확정된 A'");
  });
  await check('채널 추가는 다른 화면에도 보이고 초기 채널 설정을 보존한다', async () => {
    await click(options, '#add-channel-button');
    await waitFor(popup, "document.querySelectorAll('#channel-list [data-channel-id]').length === 2");
    assert.equal((await manager.getState()).channels[0].messages[0], '새로 확정된 A');
  });
  const secondId = (await manager.getState()).channels[1].id;
  await click(options, `[data-channel-id="${secondId}"] [data-action="select"]`);
  await check('둘째 채널의 독립 문구·주기·탭 연결을 저장한다', async () => {
    await edit(options, '#message-a', '둘째 채널 A');
    await edit(options, '#message-b', '둘째 채널 B');
    await edit(options, '#interval-seconds', '60');
    await click(options, '#save-button');
    await waitFor(options, "document.querySelector('#save-button').disabled");
    await options.evaluate("const select=document.querySelector('#target-tab-select');select.value='2';select.dispatchEvent(new Event('change',{bubbles:true}));");
    await click(options, '#bind-button');
    await waitFor(options, "!document.querySelector('#start-button').disabled");
    const channels = (await manager.getState()).channels;
    assert.equal(channels[0].intervalSeconds, 30);
    assert.equal(channels[1].intervalSeconds, 60);
    assert.equal(channels[1].target.tabId, 2);
    assert.deepEqual(channels[1].messages, ['둘째 채널 A', '둘째 채널 B']);
  });
  await check('모두 시작·채널별 중지·모두 종료가 양쪽 화면에 반영된다', async () => {
    await click(options, '#start-all-button');
    await waitFor(popup, "document.querySelectorAll('#channel-list [data-action=stop]').length === 2");
    assert.equal((await manager.getState()).channels.filter(channel=>channel.enabled).length, 2);
    await click(popup, `[data-channel-id="${id}"] [data-action="stop"]`);
    await waitFor(options, `document.querySelector('[data-channel-id="${id}"] [data-action="start"]') !== null`);
    assert.equal((await manager.getState()).channels[1].enabled, true);
    await click(options, '#stop-all-button');
    await waitFor(popup, "document.querySelectorAll('#channel-list [data-action=start]').length === 2");
    assert.equal((await manager.getState()).channels.some(channel=>channel.enabled), false);
  });
  await check('모두 시작의 응답 대기 중에도 모두 종료를 누를 수 있다', async () => {
    holdNextDelivery=true;
    await click(options,'#start-all-button');
    await waitFor(options, "!document.querySelector('#stop-all-button').disabled");
    const before=requestTypes.filter(type=>type==='DICO_STOP_ALL').length;
    await click(options,'#stop-all-button');
    assert.equal(requestTypes.filter(type=>type==='DICO_STOP_ALL').length,before+1);
    releaseDelivery();
    await waitFor(options,"document.querySelectorAll('#channel-list [data-action=start]').length === 2");
  });
  await check('데스크톱·팝업·모바일 설정 페이지에 가로 넘침이 없다', async () => {
    for (const page of [options, popup]) assert.equal(await page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);
    const shot=await options.command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
    await writeFile(new URL('../docs/options-preview.png',import.meta.url),Buffer.from(shot.data,'base64'));
    const small=await popup.command('Page.captureScreenshot',{format:'png'});
    await writeFile(new URL('../docs/popup-preview.png',import.meta.url),Buffer.from(small.data,'base64'));
    await options.command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
    assert.equal(await options.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);
  });
  for (const page of pages) assert.deepEqual(page.errors, []);
  console.log(`${checks}개 두 화면 동기화 검사 통과`);
} finally {
  releaseDelivery?.();
  for (const page of pages) await page.close();
}
