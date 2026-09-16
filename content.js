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
    if (/[`*_\[\]<>]/.test(source) || source.includes('~~')) return false;
    const plain = source.split('\n').map(line => line
      .replace(/^ {0,3}#{1,3} +/, '')
      .replace(/^ {0,3}[-+] +/, '')).join('\n');
    return comparableLines(plain) === comparableLines(rendered);
  };
  function messageText(node) {
    // Discord appends screen-reader punctuation to headings/list items.
    // Traverse only message content; preserve real punctuation and block breaks.
    if (!node.childNodes) return node.innerText || node.textContent || '';
    const read = element => {
      if (element.nodeType === 3) return element.textContent || '';
      if (element.nodeType !== 1) return '';
      if (element.getAttribute('aria-hidden') === 'true' ||
          /(?:^|\s)hiddenVisually[_\s]/.test(element.getAttribute('class') || '')) return '';
      if (element.tagName === 'BR') return '\n';
      const text = [...element.childNodes].map(read).join('');
      return /^(H[1-6]|LI|UL|OL|P|DIV|BLOCKQUOTE)$/.test(element.tagName) ? `\n${text}\n` : text;
    };
    return [...node.childNodes].map(read).join('');
  }
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
      if (current.querySelector('[id^="message-username-"]')) return null;
      current = current.previousElementSibling;
    }
    return null;
  }
  // Read only the composer countdown, never message text or the channel's
  // configured slowmode duration (which may not apply to this member).
  function slowmode(editor) {
    const form = editor?.closest('form') || editor?.parentElement;
    const nodes = [...(form?.querySelectorAll?.('[class*="slowModeCooldown"], [class*="slowmodeCooldown"]') || [])]
      .filter(node => node.getClientRects().length > 0);
    let seconds = 0;
    for (const node of nodes) {
      const text = (node.textContent || '').trim();
      const match = text.match(/^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/);
      if (!match || Number(match[3]) > 59 || (match[1] && Number(match[2]) > 59)) continue;
      seconds = Math.max(seconds, Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]));
    }
    return {slowmodeDetected:nodes.length > 0, cooldownMs:Math.min(seconds,21600)*1000};
  }
  function inspect(target) {
    if (!target || !matchesTarget(target)) return { ok: false, error: '선택한 Discord 채널과 현재 페이지가 다릅니다.' };
    const found = editors();
    if (found.length === 0) return { ok: false, code: 'EDITOR_LOADING', retryable: true, error: '아직 사용할 수 있는 채팅 입력창이 없습니다(0개).' };
    if (found.length > 1) return { ok: false, code: 'EDITOR_AMBIGUOUS', error: `채팅 입력창이 ${found.length}개입니다. 전송용 창에서 열린 스레드나 메시지 편집을 닫아 주세요.` };
    if (hasDraft(found[0]) && (!target.messages?.some(text => normalize(text) === normalize(found[0].innerText || found[0].textContent || '')) || found[0].querySelector('[data-slate-void="true"]'))) return { ok: false, error: '작성 중인 메시지가 있어 중지했습니다. 직접 전송하거나 비운 뒤 다시 시작해 주세요.' };
    const form = found[0].closest('form') || found[0].parentElement;
    if (form.querySelector('[class*="uploadContainer"], [class*="channelAttachmentArea"] li, [class*="replyBar"]')) {
      return { ok: false, error: '첨부파일 또는 답장 상태를 해제한 뒤 다시 시작해 주세요.' };
    }
    if (!document.querySelector('[data-list-id="chat-messages"]')) return { ok: false, code: 'HISTORY_LOADING', retryable: true, error: '채팅 기록이 아직 준비되지 않았습니다.' };
    if (target.draftRetrySince) {
      const expected = target.expectedText;
      for (const node of document.querySelectorAll('[data-list-id="chat-messages"] [id^="message-content-"]')) {
        const id = node.id.match(/^message-content-(\d{17,20})$/)?.[1];
        const created = id ? Number((BigInt(id) >> 22n) + 1420070400000n) : 0;
        if (created >= target.draftRetrySince - 2000 && matchesRenderedText(expected, messageText(node))) {
          return {ok:false,code:'POSSIBLY_SENT',error:'이전 시도 이후 같은 공지가 게시된 흔적이 있어 재전송을 중지했습니다. 실제 게시 여부를 확인하세요.'};
        }
      }
    }
    return { ok: true, ...slowmode(found[0]) };
  }
  const CONTENT_VERSION = '0.2.15';
  let composing = false;
  document.addEventListener?.('compositionstart', () => { composing = true; }, true);
  document.addEventListener?.('compositionend', () => { composing = false; }, true);
  function traceSnapshot(target, text, originalEditor) {
    const found = editors(), editor = found[0], selection = window.getSelection();
    const draft = normalize(editor?.innerText || editor?.textContent || '');
    return {
      pageHidden: document.hidden, documentFocused: document.hasFocus(),
      editorCount: found.length, editorFocused: editor === document.activeElement,
      editorConnected: Boolean(editor?.isConnected), editorReplaced: Boolean(originalEditor && editor !== originalEditor),
      selectionRanges: selection?.rangeCount || 0,
      selectionInside: Boolean(editor && selection?.anchorNode && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)),
      selectionCollapsed: Boolean(selection?.isCollapsed), draftLength: draft.length,
      draftEmpty: !draft, textMatches: draft === normalize(text), composing,
      targetMatches: matchesTarget(target), ...slowmode(editor),
    };
  }
  function reportTrace(delivery, stage, data = {}) {
    try {
      // Never wait for telemetry before typing; record only allowlisted metadata.
      const request = chrome.runtime.sendMessage({type:'DICO_TRACE',id:delivery.id,stage,version:CONTENT_VERSION,
        data:{...data,elapsedMs:Date.now()-delivery.startedAt,latenessMs:delivery.startedAt-delivery.scheduledAt}});
      request?.catch?.(() => {});
    } catch { /* Diagnostics must not change delivery behavior. */ }
  }
  function watchMessage(editor, text, userId, startedAt, report = () => {}) {
    const selector = '[data-list-id="chat-messages"] [id^="message-content-"]';
    const existing = new Set([...document.querySelectorAll(selector)].map(node => node.id));
    const locallySending = new Set();
    const localNodes = new WeakSet();
    let observer, timer, poll, resolve, finished = false;
    let detail = '새 메시지가 화면에 나타나지 않았습니다.';
    const evidence = {newMessage:false,matchingMessage:false,sendingSeen:false,failedSeen:false,authorMismatch:false,authorUnknown:false,timeMismatch:false};
    const promise = new Promise(done => { resolve = done; });
    const finish = value => {
      if (finished) return;
      finished = true;
      report(evidence);
      observer?.disconnect(); clearTimeout(timer); clearInterval(poll); resolve(value);
    };
    const currentEditor = () => editor.isConnected ? editor : editors()[0];
    const check = () => {
      if (finished) return;
      const liveEditor = currentEditor();
      const empty = liveEditor && !normalize(liveEditor.innerText || liveEditor.textContent || '');
      for (const node of document.querySelectorAll(selector)) {
        if (existing.has(node.id)) continue;
        evidence.newMessage = true;
        if (!matchesRenderedText(text, messageText(node))) {
          detail = '새 메시지는 있지만 문구가 일치하지 않습니다. Markdown·이모지 표시 차이를 확인하세요.';
          continue;
        }
        evidence.matchingMessage = true;
        const row = node.closest('li') || node;
        const isSending = row.querySelector('[class*="isSending"]') || row.matches('[class*="isSending"]');
        // Optimistic IDs need not be final snowflakes. Observe them even while
        // Slate still displays the submitted draft, then require a final ID.
        if (isSending) {
          evidence.sendingSeen = true;
          locallySending.add(node.id); localNodes.add(node);
          detail = '메시지가 아직 전송 중으로 표시됩니다.';
          continue;
        }
        if (row.querySelector('[class*="isFailed"]') || row.matches('[class*="isFailed"]')) {
          evidence.failedSeen = true;
          detail = 'Discord가 메시지를 전송 실패로 표시했습니다.'; continue;
        }
        const id = node.id.match(/^message-content-(\d{17,20})$/)?.[1];
        const created = id ? Number((BigInt(id) >> 22n) + 1420070400000n) : 0;
        if (!id || created < startedAt - 2000 || created > Date.now() + 2000) {
          evidence.timeMismatch = true;
          detail = '메시지 생성 시각을 이번 전송과 연결하지 못했습니다.'; continue;
        }
        const author = authorId(row);
        if (userId && author && author !== userId) {
          evidence.authorMismatch = true;
          detail = '일치하는 메시지의 작성자가 본인과 다릅니다.'; continue;
        }
        if (!locallySending.has(node.id) && !localNodes.has(node) && (!userId || author !== userId)) {
          evidence.authorUnknown = true;
          detail = '작성자를 확인하지 못했습니다. 설정의 내 Discord 사용자 ID를 입력해 주세요.'; continue;
        }
        if (!empty) { detail = '입력창이 비워졌는지 확인하지 못했습니다.'; continue; }
        finish({status:'confirmed'}); return;
      }
    };
    observer = new MutationObserver(check);
    observer.observe(document.querySelector('main') || document.body, {subtree:true,childList:true,characterData:true,attributes:true});
    // Read-only checks: no additional Enter, reload or retransmission.
    poll = setInterval(check, 500);
    timer = setTimeout(() => {
      check();
      const liveEditor = currentEditor();
      const retained = liveEditor && normalize(liveEditor.innerText || liveEditor.textContent || '') === normalize(text);
      const retryDraft = retained && !evidence.newMessage && !evidence.sendingSeen && !evidence.failedSeen;
      finish({status:retryDraft ? 'draft-retained' : 'uncertain',error:liveEditor && normalize(liveEditor.innerText || liveEditor.textContent || '')
        ? '전송 후 입력창에 문구가 남아 있습니다. 실제 게시 여부와 초안을 확인하세요.'
        : `25초 동안 발송 완료를 확인하지 못했습니다. ${detail} 실제 게시 여부를 확인하세요.`});
    }, 25000);
    return {promise,cancel:()=>finish({status:'uncertain',error:'입력 중 오류가 발생했습니다. 입력창과 채널을 확인해 주세요.'})};
  }
  async function deliver(target, delivery) {
    if (busy || seenDeliveries.has(delivery?.id)) return { status: 'uncertain', error: '중복 전송 요청을 차단했습니다. 채널에서 확인해 주세요.' };
    if (!delivery?.id || typeof delivery.text !== 'string' || !delivery.text.trim() || delivery.text.length > 2000) return { status: 'blocked', error: '전송할 문구가 올바르지 않습니다.' };
    busy = true;
    let entered = false;
    let watcher, originalEditor;
    const trace = (stage, extra = {}) => {
      try { reportTrace(delivery, stage, {...traceSnapshot(target, delivery.text, originalEditor), ...extra}); } catch {}
    };
    trace('received');
    try {
      let result = inspect(target);
      if (!result.ok) return { status: 'blocked', error: result.error };
      if (result.cooldownMs > 0) return {status:'deferred',retryAfterMs:result.cooldownMs};
      const authorization = await chrome.runtime.sendMessage({ type: 'DICO_CAN_SEND', id: delivery.id });
      if (!authorization?.allowed) return { status: 'blocked', error: '전송 예약이 취소되었거나 만료되었습니다.' };
      result = inspect(target);
      if (!result.ok) return { status: 'blocked', error: result.error };
      let editor = editors()[0];
      originalEditor = editor;
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
      const live = editors()[0];
      if (live !== editor) return {status:'blocked',error:'입력창이 교체되었습니다. 다음 시작 때 다시 확인해 주세요.'};
      const reuseDraft = normalize(editor.innerText || editor.textContent || '') === normalize(delivery.text);
      trace(reuseDraft ? 'draft-reused' : 'draft-replaced');
      if (reuseDraft) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        selection.removeAllRanges(); selection.addRange(range);
      }
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', delivery.text);
      entered = true;
      trace('before-paste');
      const paste = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true, composed: true });
      if (!reuseDraft) editor.dispatchEvent(paste);
      // Paste updates the editor model and React may render it asynchronously.
      // Never send Enter in the same task as text insertion.
      await new Promise(resolve => setTimeout(resolve, 150));
      trace('after-paste', {pastePrevented:paste.defaultPrevented});
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
      const cooldown = slowmode(editor);
      if (cooldown.cooldownMs > 0) {
        trace('slowmode-wait', cooldown);
        return {status:'deferred',retryAfterMs:cooldown.cooldownMs,draftPrepared:true};
      }
      watcher = watchMessage(editor, delivery.text, ownUserId(target), Date.now(), evidence => trace('observation', evidence));
      trace('before-enter');
      const keydown = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
      const keyup = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
      editor.dispatchEvent(keydown);
      editor.dispatchEvent(keyup);
      trace('enter-dispatched', {enterPrevented:keydown.defaultPrevented,keyupPrevented:keyup.defaultPrevented});
      const outcome = await watcher.promise;
      trace('finished', {result:outcome.status});
      return outcome;
    } catch {
      trace('exception');
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
