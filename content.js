(() => {
  if (globalThis.__dicoWhileLoaded) return;
  globalThis.__dicoWhileLoaded = true;
  let busy = false;
  const seenDeliveries = new Set();
  const normalize = text => text.replace(/\r\n/g, '\n').replace(/\u200b/g, '').trim();
  // Support heading/list rendering without weakening author or freshness checks.
  const comparableLines = text => normalize(text).split('\n').map(line => line.trim()).filter(Boolean).join('\n');
  const matchesRenderedText = (source, rendered) => {
    if (normalize(source) === normalize(rendered)) return true;
    // Unsupported constructs stay conservative (code, links, emphasis, etc.).
    if (/[`*_~\[\]<>]/.test(source)) return false;
    const plain = source.split('\n').map(line => line
      .replace(/^ {0,3}#{1,3} +/, '')
      .replace(/^ {0,3}[-+] +/, '')).join('\n');
    return comparableLines(plain) === comparableLines(rendered);
  };
  const editors = () => [...document.querySelectorAll('main [role="textbox"][contenteditable="true"][data-slate-editor="true"], [role="main"] [role="textbox"][contenteditable="true"][data-slate-editor="true"]')]
    .filter(element => element.getClientRects().length > 0 && element.getAttribute('aria-disabled') !== 'true');
  const matchesTarget = target => location.origin === 'https://discord.com' &&
    new RegExp(`^/channels/${target.guildId}/${target.channelId}(?:/\\d+)?/?$`).test(location.pathname);
  const hasDraft = editor => Boolean(normalize(editor.innerText || editor.textContent || '') || editor.querySelector('[data-slate-void="true"]'));
  function avatarUserId(scope) {
    for (const image of scope.querySelectorAll('img')) {
      const source = image.getAttribute('src') || '';
      const match = source.match(/\/avatars\/(\d{17,20})\//) || source.match(/\/users\/(\d{17,20})\/avatars\//);
      if (match) return match[1];
    }
    return null;
  }
  function ownUserId(target) {
    if (/^\d{17,20}$/.test(target.ownUserId || '')) return target.ownUserId;
    const panel = document.querySelector('section[class*="panels"], div[class*="panels"]');
    return panel ? avatarUserId(panel) : null;
  }
  function authorId(row) {
    // Consecutive messages can omit the avatar; their group inherits the
    // nearest preceding message header. Never scan outside the chat list.
    let current = row;
    while (current) {
      const avatar = avatarUserId(current);
      if (avatar) return avatar;
      if (current.querySelector('h3')) return null;
      current = current.previousElementSibling;
    }
    return null;
  }
  function inspect(target) {
    if (!target || !matchesTarget(target)) return { ok: false, error: '선택한 Discord 채널과 현재 페이지가 다릅니다.' };
    const found = editors();
    if (found.length === 0) return { ok: false, code: 'EDITOR_LOADING', retryable: true, error: '아직 사용할 수 있는 채팅 입력창이 없습니다(0개).' };
    if (found.length > 1) return { ok: false, code: 'EDITOR_AMBIGUOUS', error: `채팅 입력창이 ${found.length}개입니다. 전송용 창에서 열린 스레드나 메시지 편집을 닫아 주세요.` };
    if (hasDraft(found[0])) return { ok: false, error: '작성 중인 메시지가 있어 중지했습니다. 직접 전송하거나 비운 뒤 다시 시작해 주세요.' };
    const form = found[0].closest('form') || found[0].parentElement;
    if (form.querySelector('[class*="uploadContainer"], [class*="channelAttachmentArea"] li, [class*="replyBar"]')) {
      return { ok: false, error: '첨부파일 또는 답장 상태를 해제한 뒤 다시 시작해 주세요.' };
    }
    if (!document.querySelector('[data-list-id="chat-messages"]')) return { ok: false, code: 'HISTORY_LOADING', retryable: true, error: '채팅 기록이 아직 준비되지 않았습니다.' };
    return { ok: true };
  }
  function watchMessage(editor, text, userId, startedAt) {
    const selector = '[data-list-id="chat-messages"] [id^="message-content-"]';
    const existing = new Set([...document.querySelectorAll(selector)].map(node => node.id));
    const locallySending = new Set();
    let observer;
    let timer;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const finish = value => { observer?.disconnect(); clearTimeout(timer); resolve(value); };
    const check = () => {
      if (normalize(editor.innerText || editor.textContent || '')) return;
      for (const node of document.querySelectorAll(selector)) {
        if (existing.has(node.id) || !matchesRenderedText(text, node.innerText || node.textContent || '')) continue;
        const row = node.closest('li') || node;
        const id = node.id.match(/^message-content-(\d{17,20})$/)?.[1];
        if (!id || Number((BigInt(id) >> 22n) + 1420070400000n) < startedAt - 2000) continue;
        if (row.querySelector('[class*="isSending"]') || row.matches('[class*="isSending"]')) {
          // Only this account's optimistic messages enter the local sending
          // state. This also works for accounts with a default avatar.
          locallySending.add(node.id);
          continue;
        }
        if (row.querySelector('[class*="isFailed"]') || row.matches('[class*="isFailed"]')) continue;
        if (!locallySending.has(node.id) && (!userId || authorId(row) !== userId)) continue;
        finish({ status: 'confirmed' });
        return;
      }
    };
    observer = new MutationObserver(check);
    observer.observe(document.querySelector('main') || document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    timer = setTimeout(() => finish({ status: 'uncertain', error: normalize(editor.innerText || editor.textContent || '')
      ? '전송 키를 처리한 뒤에도 입력창에 문구가 남아 있습니다. 채널의 실제 발송 여부와 남은 초안을 확인해 주세요.'
      : '입력창은 비워졌지만 메시지 내용·작성자·전송 완료를 모두 확인하지 못했습니다. 실제 게시 여부를 확인하고, 반복되면 설정의 내 Discord 사용자 ID를 입력해 주세요.' }), 10000);
    return { promise, cancel: () => finish({ status: 'uncertain', error: '입력 중 오류가 발생했습니다. 입력창과 채널을 확인해 주세요.' }) };
  }
  async function deliver(target, delivery) {
    if (busy || seenDeliveries.has(delivery?.id)) return { status: 'uncertain', error: '중복 전송 요청을 차단했습니다. 채널에서 확인해 주세요.' };
    if (!delivery?.id || typeof delivery.text !== 'string' || !delivery.text.trim() || delivery.text.length > 2000) return { status: 'blocked', error: '전송할 문구가 올바르지 않습니다.' };
    busy = true;
    let entered = false;
    let watcher;
    try {
      let result = inspect(target);
      if (!result.ok) return { status: 'blocked', error: result.error };
      const authorization = await chrome.runtime.sendMessage({ type: 'DICO_CAN_SEND', id: delivery.id });
      if (!authorization?.allowed) return { status: 'blocked', error: '전송 예약이 취소되었거나 만료되었습니다.' };
      result = inspect(target);
      if (!result.ok) return { status: 'blocked', error: result.error };
      let editor = editors()[0];
      seenDeliveries.add(delivery.id);
      if (seenDeliveries.size > 100) seenDeliveries.delete(seenDeliveries.values().next().value);
      editor.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      // Let Slate observe focus/selection before delivering a paste event.
      // Native DOM insertion can leave visible text outside Slate's model.
      await new Promise(resolve => setTimeout(resolve, 100));
      result = inspect(target);
      if (!result.ok) return { status: 'blocked', error: result.error };
      if (!(await chrome.runtime.sendMessage({ type: 'DICO_CAN_SEND', id: delivery.id }))?.allowed) {
        return { status: 'blocked', error: '문구 입력 전에 예약이 취소되었습니다.' };
      }
      editor = editors()[0];
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', delivery.text);
      entered = true;
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true, composed: true }));
      // Paste updates the editor model and React may render it asynchronously.
      // Never send Enter in the same task as text insertion.
      await new Promise(resolve => setTimeout(resolve, 150));
      const currentEditors = editors();
      if (currentEditors.length !== 1 || normalize(currentEditors[0].innerText || currentEditors[0].textContent || '') !== normalize(delivery.text)) {
        return { status: 'uncertain', error: 'Discord 편집기에 문구가 반영되지 않았습니다. 페이지를 새로고침하고 남은 초안을 확인해 주세요.' };
      }
      editor = currentEditors[0];
      if (!matchesTarget(target)) return { status: 'uncertain', error: '문구 입력 중 채널이 변경되었습니다. 초안을 확인해 주세요.' };
      if (!(await chrome.runtime.sendMessage({ type: 'DICO_CAN_SEND', id: delivery.id }))?.allowed) {
        return { status: 'uncertain', error: '문구 입력 후 예약이 취소되었습니다. 남은 초안을 확인해 주세요.' };
      }
      if (!matchesTarget(target) || !editor.isConnected || normalize(editor.innerText || editor.textContent || '') !== normalize(delivery.text)) {
        return { status: 'uncertain', error: '전송 직전에 채널이나 입력 내용이 변경되었습니다. 초안을 확인해 주세요.' };
      }
      watcher = watchMessage(editor, delivery.text, ownUserId(target), Date.now());
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      return await watcher.promise;
    } catch {
      watcher?.cancel();
      return { status: entered ? 'uncertain' : 'blocked', error: 'Discord 입력창에 연결하지 못했습니다. 채널과 남은 초안을 확인해 주세요.' };
    } finally { busy = false; }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === 'DICO_INSPECT') { respond(inspect(message.target)); return false; }
    if (message?.type === 'DICO_DELIVER') { deliver(message.target, message.delivery).then(respond); return true; }
    return false;
  });
})();
