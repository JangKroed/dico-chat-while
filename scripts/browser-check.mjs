// Dependency-free CDP checks against an isolated Chrome profile. All requests
// are intercepted and fulfilled locally; nothing is posted to Discord.
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
if (process.argv.includes('--ui')) {
  await import('./ui-sync-check.mjs');
  process.exit(0);
}
const response = await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' });
const tab = await response.json();
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
let sequence = 0;
const pending = new Map();
const events = new Map();
socket.addEventListener('message', async event => {
  const data = JSON.parse(event.data);
  if (data.id) {
    const waiting = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) waiting?.reject(new Error(data.error.message));
    else waiting?.resolve(data.result);
  } else for (const handler of events.get(data.method) || []) await handler(data.params);
});
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
function on(name, handler) { events.set(name, [...events.get(name) || [], handler]); }
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const fixture = `<!doctype html><html><body><main>
<section class="panels_test"><img src="https://cdn.discordapp.com/avatars/123456789012345678/test.png"></section><ol data-list-id="chat-messages"><li><div id="message-content-old">공지 A</div></li></ol>
<form><button class="uploadButton_xyz" type="button">첨부</button><input class="uploadInput_xyz" type="file" hidden>
<div role="textbox" contenteditable="true" data-slate-editor="true" style="width:400px;min-height:40px"></div></form>
</main></body></html>`;
on('Fetch.requestPaused', async ({ requestId, request }) => {
  const url = new URL(request.url);
  let body = fixture;
  let type = 'text/html';
  if (url.hostname === 'extension.test') {
    const filename = url.pathname.slice(1);
    if (!['popup.html', 'options.html', 'ui.js', 'styles.css'].includes(filename)) body = '';
    else body = await readFile(new URL(`../${filename}`, import.meta.url), 'utf8');
    type = filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html';
  }
  await command('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }], body: Buffer.from(body).toString('base64') });
});
await command('Page.enable');
await command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
async function navigate(url) {
  const loaded = new Promise(resolve => on('Page.loadEventFired', resolve));
  await command('Page.navigate', { url });
  await loaded;
}
let passed = 0;
async function check(name, action) {
  await action();
  passed++;
  console.log(`PASS ${name}`);
}
try {
  await navigate('https://discord.com/channels/123/456');
  await evaluate(`
    window.allowed = true;
    window.listeners = [];
    window.chrome = { runtime: { id: 'local-test', onMessage: { addListener: listener => listeners.push(listener) }, sendMessage: async () => ({allowed}) } };
    window.target = { guildId:'123',channelId:'456',tabId:7 };
    window.request = message => new Promise(resolve => listeners[0](message,{id:'local-test'},resolve));
    window.inspect = () => request({type:'DICO_INSPECT',target});
    window.deliver = id => request({type:'DICO_DELIVER',target,delivery:{id,text:'공지 A'}});
    window.editor = document.querySelector('[role=textbox]');
    window.mode = 'send';
    window.sentCount = 0;
    window.modelText = '';
    editor.addEventListener('paste', event => {
      event.preventDefault();
      const text = event.clipboardData.getData('text/plain');
      setTimeout(() => {
        modelText = mode === 'editDuringPaste' ? '사용자가 수정한 초안' : text;
        editor.innerText=modelText;
        if(mode === 'cancelDuringPaste') allowed=false;
      }, 0);
    });
    editor.addEventListener('keydown', event => {
      if(event.key !== 'Enter' || mode === 'ignore' || !modelText) return;
      event.preventDefault();
      const row = document.createElement('li');
      const content = document.createElement('div');
      sentCount++;
      content.id = 'message-content-' + ((BigInt(Date.now()) - 1420070400000n) << 22n).toString();
      const avatar = document.createElement('img');
      avatar.src = 'https://cdn.discordapp.com/avatars/' + (mode === 'other' ? '999999999999999999' : '123456789012345678') + '/test.png';
      row.append(avatar);
      content.textContent = modelText;
      content.className = mode === 'pending' ? 'isSending_xyz' : '';
      row.append(content);
      document.querySelector('ol').append(row);
      editor.innerText='';
      modelText='';
    });
  `);
  await evaluate(await readFile(new URL('../content.js', import.meta.url), 'utf8'));
  await check('일반 첨부 버튼이 있는 빈 입력창을 허용한다', async () => assert.equal((await evaluate('inspect()')).ok, true));
  await check('기존 초안을 보존하고 발송하지 않는다', async () => {
    await evaluate("editor.innerText='작성 중';");
    assert.equal((await evaluate("deliver('draft')")).status, 'blocked');
    assert.equal(await evaluate('editor.innerText'), '작성 중');
    await evaluate("editor.innerText='';");
  });
  await check('실제 첨부파일 대기 상태에서 발송을 막는다', async () => {
    await evaluate("const attachment=document.createElement('div');attachment.className='uploadContainer_xyz';attachment.id='attachment';editor.parentElement.append(attachment);");
    assert.equal((await evaluate('inspect()')).ok, false);
    await evaluate("document.getElementById('attachment').remove();");
  });
  await check('취소된 예약은 입력하지 않는다', async () => {
    await evaluate('allowed=false');
    assert.equal((await evaluate("deliver('cancelled')")).status, 'blocked');
    assert.equal(await evaluate('editor.innerText'), '');
    await evaluate('allowed=true');
  });
  await check('새 메시지가 표시되면 발송 성공으로 확인한다', async () => {
    assert.equal((await evaluate("deliver('success')")).status, 'confirmed');
    assert.equal(await evaluate('sentCount'), 1);
  });
  await check('같은 전송 ID를 다시 받아도 발송하지 않는다', async () => {
    assert.equal((await evaluate("deliver('success')")).status, 'uncertain');
    assert.equal(await evaluate('sentCount'), 1);
  });
  await check('붙여넣기 처리 중 중지하면 Enter를 보내지 않는다', async () => {
    await evaluate("mode='cancelDuringPaste'");
    assert.equal((await evaluate("deliver('cancel-after-paste')")).status, 'uncertain');
    assert.equal(await evaluate('sentCount'), 1);
    await evaluate("editor.innerText=''; modelText=''; allowed=true; mode='send'");
  });
  await check('입력 처리 중 수정된 초안을 발송하지 않는다', async () => {
    await evaluate("mode='editDuringPaste'");
    assert.equal((await evaluate("deliver('edited-after-paste')")).status, 'uncertain');
    assert.equal(await evaluate('editor.innerText'), '사용자가 수정한 초안');
    assert.equal(await evaluate('sentCount'), 1);
    await evaluate("editor.innerText=''; modelText=''; mode='send'");
  });
  await check('채널이 바뀌면 발송하지 않는다', async () => {
    await evaluate("history.pushState({},'', '/channels/123/999')");
    assert.equal((await evaluate("deliver('wrong-channel')")).status, 'blocked');
    await evaluate("history.pushState({},'', '/channels/123/456')");
  });
  await check('전송 중 표시가 남은 메시지를 성공으로 오인하지 않는다', async () => {
    await evaluate("mode='pending'");
    assert.equal((await evaluate("deliver('pending')")).status, 'uncertain');
  });
  await check('타인의 같은 문구를 발송 성공으로 오인하지 않는다', async () => {
    await evaluate("mode='other'");
    assert.equal((await evaluate("deliver('other')")).status, 'uncertain');
  });
  console.log(`${passed}개 실제 Chrome DOM 검사 통과 (네트워크 전송 없음)`);
} finally {
  await command('Page.close');
  socket.close();
}
