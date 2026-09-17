(() => {
  if (globalThis.__dicoWhileLoaded) return;
  globalThis.__dicoWhileLoaded = true;
  let busy = false;
  const seenDeliveries = new Set();
  const normalize = text => text.replace(/\r\n/g, '\n').replace(/\u200b/g, '').replace(/(\p{Emoji})\uFE0F/gu, '$1').trim();
  // Support heading/list rendering without weakening author or freshness checks.
  const comparableLines = text => normalize(text).split('\n').map(line => line.trim()).filter(Boolean).join('\n');
  const matchesRenderedText = (source, rendered) => {
    if (normalize(source) === normalize(rendered)) return true;
    // Parse only supported, paired emphasis; code/links/escapes stay conservative.
    if (/[`\\\[\]<>]/.test(source)) return false;
    let formatted=source.replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g,'$1').replace(/__(?=\S)([^_\n]*?\S)__/g,'$1');
    if(/[*_]/.test(formatted) || formatted.includes('~~'))return false;
    formatted=formatted.replace(/:[a-zA-Z0-9_+-]+:(?::skin-tone-[2-6]:)*/g,alias=>globalThis.__dicoEmojiNames?.[alias] || alias);
    const plain = formatted.split('\n').map(line => line
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
      if (element.tagName === 'IMG') {
        const alt=element.getAttribute('alt') || '';
        if(!/(?:^|\s)emoji(?:_|\s|$)/.test(element.getAttribute('class') || ''))return '\u0000';
        const names=globalThis.__dicoEmojiNames || {};
        return names[alt] || (Object.values(names).includes(alt)?alt:'\u0000');
      }
      const text = [...element.childNodes].map(read).join('');
      return /^(H[1-6]|LI|UL|OL|P|DIV|BLOCKQUOTE)$/.test(element.tagName) ? `\n${text}\n` : text;
    };
    return [...node.childNodes].map(read).join('');
  }
  const editors = () => [...document.querySelectorAll('main [role="textbox"][contenteditable="true"][data-slate-editor="true"], [role="main"] [role="textbox"][contenteditable="true"][data-slate-editor="true"]')]
    .filter(element => element.getClientRects().length > 0 && element.getAttribute('aria-disabled') !== 'true');
  const matchesTarget = target => location.origin === 'https://discord.com' &&
    new RegExp(`^/channels/${target.guildId}/${target.channelId}(?:/\\d+)?/?$`).test(location.pathname);
  function editorContent(editor) {
    const raw=editor?.innerText || editor?.textContent || '';
    if(!editor?.childNodes)return {text:raw,mode:'rendered',unsupported:Boolean(editor?.querySelector?.('[data-slate-void="true"]'))};
    let unsupported=false,unsupportedElement=false,sawString=false,sawBlock=false,unicodeEmojiCount=0;
    const attr=(node,key)=>node.getAttribute?.(key);
    const emptySpacer=node=>{
      if(node.nodeType===3)return /^[\s\u200b\ufeff]*$/.test(node.textContent || '');
      if(node.nodeType!==1 || !['SPAN','BR'].includes(node.tagName))return false;
      if(['contenteditable','role','alt','src'].some(key=>attr(node,key)!==null && attr(node,key)!==undefined))return false;
      return [...node.childNodes].every(emptySpacer);
    };
    const unicodeEmoji=node=>{
      const images=[],descriptions=[];let invalid=false;
      // Resolve built-in emoji names using the offline Unicode table.
      const aliases=globalThis.__dicoEmojiNames || {};
      const known=editorContent.knownEmoji ||= new Set(Object.values(aliases));
      const visit=n=>{
        if(n.nodeType===3){if(!/^[\s\u200b\ufeff]*$/.test(n.textContent || ''))invalid=true;return;}
        if(n.nodeType!==1){invalid=true;return;}
        if(attr(n,'data-slate-spacer')==='true'){if(!emptySpacer(n))invalid=true;return;}
        if(n.tagName==='IMG'){
          const alt=attr(n,'alt') || '';
          const builtIn=attr(n,'data-type')==='emoji' && attr(n,'data-name')===alt &&
            /^(?:https:\/\/discord\.com)?\/assets\/[a-f0-9]+\.svg$/.test(attr(n,'src') || '');
          const value=builtIn && Object.hasOwn(aliases,alt)?aliases[alt]:alt;
          if(!/(?:^|\s)emoji(?:_|\s|$)/.test(attr(n,'class') || '') ||
            !(known.has(value) || /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)$/u.test(value)))invalid=true;
          images.push({value,alt,description:attr(n,'aria-describedby')});return;
        }
        if(n.tagName!=='SPAN'){invalid=true;return;}
        if(/(?:^|\s)hiddenVisually(?:_|\s|$)/.test(attr(n,'class') || '')){descriptions.push(n);return;}
        [...n.childNodes].forEach(visit);
      };
      [...node.childNodes].forEach(visit);
      if(invalid || images.length!==1 || descriptions.length>1)return null;
      const image=images[0];
      // Ignore only the image's exact, text-only accessibility description.
      if(descriptions.some(n=>!attr(n,'id') || attr(n,'id')!==image.description ||
        n.textContent!==image.alt || ![...n.childNodes].every(c=>c.nodeType===3)))return null;
      return image;
    };
    const read=node=>{
      if(node.nodeType===3){if(/\S/.test(node.textContent || ''))unsupported=true;return {text:'',block:false};}
      if(node.nodeType!==1)return {text:'',block:false};
      if(attr(node,'data-slate-void')==='true'){
        const emoji=unicodeEmoji(node);
        if(emoji){unicodeEmojiCount++;sawString=true;return {text:emoji.value,block:false,segments:[emoji]};}
        const children=[...node.childNodes].filter(n=>n.nodeType!==3 || /\S/.test(n.textContent || ''));
        if(!children.length || !children.every(n=>attr(n,'data-slate-spacer')==='true' && emptySpacer(n)))unsupported=unsupportedElement=true;
        return {text:'',block:false};
      }
      if(attr(node,'data-slate-zero-width')!==null && attr(node,'data-slate-zero-width')!==undefined){sawString=true;if(!/^[\s\u200b\ufeff]*$/.test(node.textContent || ''))unsupported=true;return {text:'',block:false};}
      if(attr(node,'data-slate-string')==='true'){
        sawString=true;
        const plain=n=>n.nodeType===3 || (n.nodeType===1 && n.tagName==='SPAN' && attr(n,'data-slate-void')!=='true' && attr(n,'contenteditable')!=='false' && [...n.childNodes].every(plain));
        if(![...node.childNodes].every(plain))unsupported=true;
        return {text:node.textContent || '',block:false};
      }
      const block=attr(node,'data-slate-node')==='element' && attr(node,'data-slate-inline')!=='true';
      sawBlock ||=block;
      if(['IMG','VIDEO','AUDIO','INPUT','BUTTON'].includes(node.tagName) || attr(node,'contenteditable')==='false')unsupported=unsupportedElement=true;
      const children=[...node.childNodes].map(read).filter(child=>child.text || child.block);
      let text='';const segments=[];children.forEach((child,index)=>{if(index && (child.block || children[index-1].block)){text+='\n';segments.push('\n');}text+=child.text;segments.push(...(child.segments || [child.text]));});
      return {text,block,segments};
    };
    const result=read(editor);
    if(!sawString && !sawBlock)return {text:raw,mode:'rendered',unsupported:unsupportedElement || Boolean(editor.querySelector?.('[data-slate-void="true"]'))};
    return {text:result.text,segments:result.segments,mode:'slate',unsupported,unicodeEmojiCount};
  }
  const editorText=editor=>{const result=editorContent(editor);return result.unsupported?'\u0000'+result.text:result.text;};
  // Only actual emoji image positions may match a source shortcode. Literal
  // text elsewhere (including code, URLs and private drafts) is not rewritten.
  function composerMatches(editor, expected) {
    const content=editorContent(editor);
    if(content.unsupported || typeof expected!=='string')return false;
    const source=normalize(expected);
    if(normalize(content.text)===source)return true;
    if(!content.segments)return false;
    const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const clean=value=>value.replace(/\r\n/g,'\n').replace(/\u200b/g,'').replace(/(\p{Emoji})\uFE0F/gu,'$1');
    const segments=content.segments.map(part=>typeof part==='string'?clean(part):part);
    // Empty outer Slate leaves and whitespace are equivalent to normalize().
    while(typeof segments[0]==='string'){segments[0]=segments[0].trimStart();if(segments[0])break;segments.shift();}
    while(typeof segments.at(-1)==='string'){segments[segments.length-1]=segments.at(-1).trimEnd();if(segments.at(-1))break;segments.pop();}
    const images=[];
    const aliasesByValue=composerMatches.aliasesByValue ||= Object.entries(globalThis.__dicoEmojiNames || {}).reduce((map,[alias,value])=>{
      const key=normalize(value);(map[key] ||= []).push(alias);return map;
    },Object.create(null));
    const pattern=segments.map(part=>{
      if(typeof part==='string')return escape(part);
      images.push(part);
      const value=normalize(part.value);
      return '('+[value,...(aliasesByValue[value] || [])].map(escape).join('|')+')';
    }).join('');
    const match=new RegExp('^'+pattern+'$','d').exec(source);
    if(!match)return false;
    const protectedRanges=[];let delimiter=null,start=0;
    const escaped=at=>{let count=0;while(at>0 && source[--at]==='\\')count++;return count%2===1;};
    for(const token of source.matchAll(/`+|~{3,}/g)){
      if(escaped(token.index))continue;
      if(delimiter===null){delimiter=token[0];start=token.index;}
      else if(token[0]===delimiter){protectedRanges.push([start,token.index+token[0].length]);delimiter=null;}
    }
    if(delimiter!==null)protectedRanges.push([start,source.length]);
    for(const token of source.matchAll(/https?:\/\/\S+|<[^>]*>/g))protectedRanges.push([token.index,token.index+token[0].length]);
    return images.every((part,index)=>{
      if(match[index+1]===normalize(part.value))return true;
      const at=match.indices[index+1][0];
      return !escaped(at) && !protectedRanges.some(([begin,end])=>at>=begin && at<end);
    });
  }
  const hasDraft = editor => Boolean(normalize(editorText(editor)) || editorContent(editor).unsupported);
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
  function parseSlowmodeSetting(text) {
    const value = String(text || '').replace(/\s+/g,' ').trim();
    if (!/슬로우\s*모드|slow\s*mode/i.test(value)) return null;
    const ko = value.match(/(?:멤버는|사용자는)\s*(.*?)\s*에\s*한\s*번/);
    const en = value.match(/(?:one|a) message every\s+([\d\s.,a-z]+)/i);
    const duration = ko?.[1] || en?.[1];
    if (!duration) return null;
    let seconds=0, found=false;
    for (const match of duration.matchAll(/(\d+)\s*(시간|분|초|hours?|minutes?|seconds?)/gi)) {
      const unit=match[2].toLowerCase();
      seconds+=Number(match[1])*(unit==='시간'||unit.startsWith('hour')?3600:unit==='분'||unit.startsWith('minute')?60:1);found=true;
    }
    return found && seconds>0 && seconds<=21600 ? seconds : null;
  }
  let slowmodeSetting = {path:null,seconds:null,checkedAt:0};
  async function detectSlowmodeSetting(target) {
    if (!target || !matchesTarget(target)) return null;
    const path=location.pathname;
    if (slowmodeSetting.path===path && Date.now()-slowmodeSetting.checkedAt<30000) return slowmodeSetting.seconds;
    const editor=editors()[0], form=editor?.closest('form') || editor?.parentElement;
    const icons=[...(form?.querySelectorAll?.('[class*="slowMode"], [class*="slowmode"]') || [])].filter(node=>node.getClientRects().length>0);
    let seconds=null;
    const read = node => {
      const labels=[node.textContent,node.getAttribute('aria-label'),node.getAttribute('title')];
      for(const id of (node.getAttribute('aria-describedby')||'').split(/\s+/)) if(id) labels.push(document.getElementById(id)?.textContent);
      return labels.map(parseSlowmodeSetting).find(value=>value!==null) ?? null;
    };
    for (const icon of icons.slice(0,3)) {
      seconds=read(icon);
      if(seconds!==null) break;
      try {
        icon.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
        await new Promise(resolve=>setTimeout(resolve,250));
        seconds=read(icon);
        if(seconds===null) for(const tooltip of document.querySelectorAll('[role="tooltip"]')) {
          if(tooltip.getClientRects().length>0) seconds=parseSlowmodeSetting(tooltip.textContent);
          if(seconds!==null) break;
        }
      } finally {icon.dispatchEvent(new MouseEvent('mouseout',{bubbles:true}));}
      if(seconds!==null) break;
    }
    if (!matchesTarget(target) || location.pathname!==path) return null;
    if(seconds===null && slowmodeSetting.path===path) seconds=slowmodeSetting.seconds;
    slowmodeSetting={path,seconds,checkedAt:Date.now()};
    return seconds;
  }
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
    return {slowmodeSeconds:slowmodeSetting.path===location.pathname?slowmodeSetting.seconds:null,slowmodeDetected:nodes.length > 0, cooldownMs:Math.min(seconds,21600)*1000};
  }
  function inspect(target) {
    if (!target || !matchesTarget(target)) return { ok: false, error: '선택한 Discord 채널과 현재 페이지가 다릅니다.' };
    const found = editors();
    if (found.length === 0) return { ok: false, code: 'EDITOR_LOADING', retryable: true, error: '아직 사용할 수 있는 채팅 입력창이 없습니다(0개).' };
    if (found.length > 1) return { ok: false, code: 'EDITOR_AMBIGUOUS', error: `채팅 입력창이 ${found.length}개입니다. 전송용 창에서 열린 스레드나 메시지 편집을 닫아 주세요.` };
    if (hasDraft(found[0]) && (!target.messages?.some(text => composerMatches(found[0],text)) || editorContent(found[0]).unsupported)) return { ok: false, code:'DRAFT_MISMATCH', error: '작성 중인 메시지가 있어 중지했습니다. 직접 전송하거나 비운 뒤 다시 시작해 주세요.' };
    const form = found[0].closest('form') || found[0].parentElement;
    if (form.querySelector('[class*="uploadContainer"], [class*="channelAttachmentArea"] li, [class*="replyBar"]')) {
      return { ok: false, error: '첨부파일 또는 답장 상태를 해제한 뒤 다시 시작해 주세요.' };
    }
    if (!target.skipConfirmation && !document.querySelector('[data-list-id="chat-messages"]')) return { ok: false, code: 'HISTORY_LOADING', retryable: true, error: '채팅 기록이 아직 준비되지 않았습니다.' };
    if (!target.skipConfirmation && target.draftRetrySince) {
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
  const CONTENT_VERSION = '0.2.33';
  let composing = false;
  document.addEventListener?.('compositionstart', () => { composing = true; }, true);
  document.addEventListener?.('compositionend', () => { composing = false; }, true);
  function draftEvidence(target,editor) {
    const draft=normalize(editorContent(editor).text);
    const expected=normalize(target.expectedText || ''),messages=target.messages || [];
    return {textContext:{expected:target.expectedText || '',actual:editorContent(editor).text,rendered:editor?.innerText || editor?.textContent || '',messageA:messages[0] || '',messageB:messages[1] || ''},rawTextMatches:!editorContent(editor).unsupported && draft===expected,emojiEquivalent:composerMatches(editor,target.expectedText || '') && draft!==expected,unicodeEmojiCount:editorContent(editor).unicodeEmojiCount || 0,editorReadMode:editorContent(editor).mode,unsupportedEditorContent:editorContent(editor).unsupported,renderedDraftLength:normalize(editor?.innerText || editor?.textContent || '').length,expectedLength:expected.length,messageALength:normalize(messages[0] || '').length,messageBLength:normalize(messages[1] || '').length,
      draftMatchesA:typeof messages[0]==='string' && composerMatches(editor,messages[0]),draftMatchesB:typeof messages[1]==='string' && composerMatches(editor,messages[1]),
      draftHasVoid:Boolean(editor?.querySelector('[data-slate-void="true"]')),
      whitespaceOnlyDifference:draft!==expected && draft.replace(/\s/g,'')===expected.replace(/\s/g,''),
      draftLineCount:draft.split('\n').length,expectedLineCount:expected.split('\n').length};
  }
  function traceSnapshot(target, text, originalEditor) {
    const found = editors(), editor = found[0], selection = window.getSelection();
    const draft = normalize(editorContent(editor).text);
    return {
      pageHidden: document.hidden, documentFocused: document.hasFocus(),
      editorCount: found.length, editorFocused: editor === document.activeElement,
      editorConnected: Boolean(editor?.isConnected), editorReplaced: Boolean(originalEditor && editor !== originalEditor),
      selectionRanges: selection?.rangeCount || 0,
      selectionInside: Boolean(editor && selection?.anchorNode && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)),
      selectionCollapsed: Boolean(selection?.isCollapsed), draftLength: draft.length,
      draftEmpty: !draft, textMatches: composerMatches(editor,text), composing,
      targetMatches: matchesTarget(target), ...slowmode(editor), ...draftEvidence({...target,expectedText:text},editor),
    };
  }
  function reportTrace(delivery, stage, data = {}) {
    try {
      // Never wait for telemetry before typing; record only allowlisted metadata.
      const request = chrome.runtime.sendMessage({type:'DICO_TRACE',id:delivery.id,stage,version:CONTENT_VERSION,
        data:{...data,messageIndex:delivery.index,deliveryPhase:delivery.phase || 'send',eventAt:Date.now(),scheduledAt:delivery.scheduledAt,startedAt:delivery.startedAt,observedPath:location.pathname,elapsedMs:Date.now()-delivery.startedAt,latenessMs:Date.now()-delivery.scheduledAt}});
      return request?.catch?.(() => {});
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
      const empty = liveEditor && !normalize(editorText(liveEditor));
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
        evidence.messageId=id;
        finish({status:'confirmed',messageId:id}); return;
      }
    };
    observer = new MutationObserver(check);
    observer.observe(document.querySelector('main') || document.body, {subtree:true,childList:true,characterData:true,attributes:true});
    // Read-only checks: no additional Enter, reload or retransmission.
    poll = setInterval(check, 500);
    timer = setTimeout(() => {
      check();
      const liveEditor = currentEditor();
      const retained = liveEditor && composerMatches(liveEditor,text);
      const retryDraft = retained && !evidence.newMessage && !evidence.sendingSeen && !evidence.failedSeen;
      finish({status:retryDraft ? 'draft-retained' : 'uncertain',error:liveEditor && normalize(editorText(liveEditor))
        ? '전송 후 입력창에 문구가 남아 있습니다. 실제 게시 여부와 초안을 확인하세요.'
        : `25초 동안 발송 완료를 확인하지 못했습니다. ${detail} 실제 게시 여부를 확인하세요.`});
    }, 25000);
    return {promise,cancel:()=>finish({status:'uncertain',error:'입력 중 오류가 발생했습니다. 입력창과 채널을 확인해 주세요.'})};
  }
  function reconcile(target, delivery) {
    const unknown = (reason, messageId) => ({status:'uncertain', reason, ...(messageId ? {messageId} : {})});
    if (!target || !matchesTarget(target)) return unknown('wrong-channel');
    if (!delivery?.id || typeof delivery.text !== 'string' || !Number.isFinite(delivery.startedAt)) return unknown('invalid-delivery');
    const found = editors();
    if (found.length !== 1) return unknown('draft-or-editor');
    const editor = found[0];
    const draft = normalize(editorText(editor));
    const nextText = [0,1].includes(delivery.index) ? target.messages?.[1-delivery.index] : undefined;
    const form = editor.closest?.('form') || editor.parentElement;
    if (editorContent(editor).unsupported || form?.querySelector('[class*="uploadContainer"], [class*="channelAttachmentArea"] li, [class*="replyBar"]')) return unknown('draft-or-editor');
    const user = ownUserId(target);
    if (!user) return unknown('author-unknown');
    const candidates = new Set();
    let nextAlreadyPosted = null;
    for (const node of document.querySelectorAll('[data-list-id="chat-messages"] [id^="message-content-"]')) {
      const rendered = messageText(node);
      const currentMatch = matchesRenderedText(delivery.text, rendered);
      const nextMatch = typeof nextText === 'string' && normalize(nextText) !== normalize(delivery.text) && matchesRenderedText(nextText, rendered);
      if (!currentMatch && !nextMatch) continue;
      const row = node.closest('li') || node;
      if (row.querySelector('[class*="isSending"], [class*="isFailed"]') || row.matches('[class*="isSending"], [class*="isFailed"]')) continue;
      const id = node.id.match(/^message-content-(\d{17,20})$/)?.[1];
      const created = id ? Number((BigInt(id) >> 22n) + 1420070400000n) : 0;
      // Server snowflake time can be ahead of the local acknowledgement clock.
      // Use the acknowledged server ID as an independent high-water mark.
      if (id && /^\d{17,20}$/.test(target.lastConfirmedMessageId || '') && BigInt(id)<=BigInt(target.lastConfirmedMessageId)) continue;
      // No backwards tolerance: an older identical announcement is not proof.
      if (!id || created < delivery.startedAt || created > Date.now() + 2000 || authorId(row) !== user) continue;
      if (currentMatch) candidates.add(id);
      if (nextMatch && !currentMatch) nextAlreadyPosted = id;
    }
    if (nextAlreadyPosted) return unknown('next-already-posted',nextAlreadyPosted);
    if (candidates.size !== 1) return unknown(candidates.size ? 'multiple-matches' : 'no-proof');
    let draftAction = 'empty';
    if (draft) {
      if (typeof nextText === 'string' && composerMatches(editor,nextText)) draftAction = 'reuse-next';
      else if (composerMatches(editor,delivery.text)) draftAction = 'replace-next';
      else return unknown('foreign-draft');
    }
    return {status:'confirmed',draftAction,messageId:[...candidates][0]};
  }
  async function stableEditor(target, text, editor, duration, report) {
    const began=Date.now(); let stableSince=null,maxStableMs=0,textStableSince=null,repaired=false;
    const failureCounts={};let lastFailedChecks=[];
    const fail=async()=>{
      let timer;
      try { await Promise.race([report('stability-failed',{failedChecks:lastFailedChecks,failureCounts,maxStableMs,stableRequiredMs:duration,stableWaitMs:Date.now()-began}),new Promise(resolve=>{timer=setTimeout(resolve,1500);})]); } finally { clearTimeout(timer); }
      return false;
    };
    while (Date.now()-began<5000) {
      const found=editors(),selection=window.getSelection();
      const checks={channel_changed:!matchesTarget(target),editor_detached:!editor.isConnected,
        editor_count:found.length!==1,editor_replaced:found[0]!==editor,
        text_mismatch:!composerMatches(editor,text),
        composing,focus_lost:document.activeElement!==editor,
        selection_missing:!selection || !selection.rangeCount,
        selection_not_collapsed:!selection?.isCollapsed,
        selection_outside:!selection || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)};
      lastFailedChecks=Object.keys(checks).filter(key=>checks[key]);
      for(const key of lastFailedChecks)failureCounts[key]=(failureCounts[key] || 0)+1;
      if(checks.channel_changed || checks.editor_detached || checks.editor_count || checks.editor_replaced)return fail();
      if(!checks.text_mismatch && !checks.composing)textStableSince ??=Date.now();else textStableSince=null;
      // A paste can leave Slate's old selection active. Repair only our dedicated
      // editor, once, after exact text settles; never overwrite text or other inputs.
      const repairable=lastFailedChecks.length && lastFailedChecks.every(key=>['focus_lost','selection_missing','selection_not_collapsed','selection_outside'].includes(key));
      if(target.managed && !repaired && repairable && textStableSince!==null && Date.now()-textStableSince>=500 &&
          (!document.activeElement || document.activeElement===document.body || document.activeElement===editor)) {
        repaired=true;editor.focus();
        const range=document.createRange(),currentSelection=window.getSelection();
        if(currentSelection){range.selectNodeContents(editor);range.collapse(false);currentSelection.removeAllRanges();currentSelection.addRange(range);}
        report('editor-recovered',{failedChecks:lastFailedChecks,failureCounts});
        stableSince=null;
        await new Promise(resolve=>setTimeout(resolve,100));continue;
      }
      if(!lastFailedChecks.length) {
        stableSince ??=Date.now();maxStableMs=Math.max(maxStableMs,Date.now()-stableSince);
        if(maxStableMs>=duration)return true;
      } else stableSince=null;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    return fail();
  }
  async function deliver(target, delivery) {
    if (busy || seenDeliveries.has(delivery?.id)) return { status: 'uncertain', error: '중복 전송 요청을 차단했습니다. 채널에서 확인해 주세요.' };
    if (!delivery?.id || typeof delivery.text !== 'string' || !delivery.text.trim() || delivery.text.length > 2000) return { status: 'blocked', error: '전송할 문구가 올바르지 않습니다.' };
    busy = true;
    let entered = false;
    let watcher, originalEditor;
    const trace = (stage, extra = {}) => {
      try { return reportTrace(delivery, stage, {...traceSnapshot(target, delivery.text, originalEditor), ...extra}); } catch {}
    };
    trace('received');
    try {
      if (!target.skipConfirmation && Number.isFinite(target.lastSentAt) && target.lastSentAt > 0) {
        const previous = reconcile(target, {...delivery,startedAt:target.lastSentAt + 1});
        trace('prior-post-check',{result:previous.status,reconciliationReason:previous.reason || 'confirmed',messageId:previous.messageId});
        if (previous.status === 'confirmed') {
          trace('prior-post-confirmed', {result:'confirmed',draftAction:previous.draftAction});
          return previous;
        }
        if (['multiple-matches','next-already-posted','foreign-draft'].includes(previous.reason)) return {status:'uncertain',error:'이전 전송 이후 게시 기록과 초안의 순서를 확정할 수 없습니다. 중복 방지를 위해 확인이 필요합니다.'};
      }
      let result = inspect(target);
      if (!result.ok) return { status: 'blocked', error: result.error };
      if (delivery.phase!=='prepare' && result.cooldownMs > 0) return {status:'deferred',retryAfterMs:result.cooldownMs};
      const authorization = await chrome.runtime.sendMessage({ type: 'DICO_CAN_SEND', id: delivery.id, phase:delivery.phase });
      if (!authorization?.allowed) return { status: 'blocked', error: '전송 예약이 취소되었거나 만료되었습니다.' };
      result = inspect(target);
      if (!result.ok) return { status: 'blocked', error: result.error };
      let editor = editors()[0];
      originalEditor = editor;
      if(delivery.phase!=='prepare') seenDeliveries.add(delivery.id);
      if (seenDeliveries.size > 100) seenDeliveries.delete(seenDeliveries.values().next().value);
      if (delivery.phase==='commit') {
        if (!Number.isFinite(delivery.scheduledAt) || Date.now()<delivery.scheduledAt) return {status:'blocked',error:'아직 전송 예약 시각이 아닙니다.'};
        if (!composerMatches(editor,delivery.text)) return {status:'blocked',error:'준비한 문구가 변경되었습니다. 입력창을 보존하고 중지합니다.'};
        editor.focus();
        const selection=window.getSelection(), range=document.createRange();
        range.selectNodeContents(editor);range.collapse(false);selection.removeAllRanges();selection.addRange(range);
        if(!await stableEditor(target,delivery.text,editor,500,trace)) return {status:'blocked',error:'전송 직전 입력 상태가 불안정합니다. 초안을 보존하고 중지합니다.'};
        if (!(await chrome.runtime.sendMessage({type:'DICO_CAN_SEND',id:delivery.id,phase:'commit'}))?.allowed) return {status:'blocked',error:'전송 준비 후 중지 요청을 확인했습니다.'};
        trace('prepared-verified');
      } else {
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
        if (!(await chrome.runtime.sendMessage({ type: 'DICO_CAN_SEND', id: delivery.id, phase:delivery.phase }))?.allowed) {
          return { status: 'blocked', error: '문구 입력 전에 예약이 취소되었습니다.' };
        }
        const live = editors()[0];
        if (live !== editor) return {status:'blocked',error:'입력창이 교체되었습니다. 다음 시작 때 다시 확인해 주세요.'};
        const reuseDraft = composerMatches(editor,delivery.text);
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
        trace('paste-dispatched',{pastePrevented:paste.defaultPrevented});
        // Paste updates the editor model and React may render it asynchronously.
        // Never send Enter in the same task as text insertion.
        if (delivery.phase==='prepare') {
          if (!await stableEditor(target,delivery.text,editor,1000,trace)) return {status:'blocked',error:
            editorContent(editor).unsupported ? '입력창에 해석하지 못한 요소가 있습니다. 초안을 보존하고 중지합니다. 진단 로그를 확인해 주세요.' :
            !composerMatches(editor,delivery.text) ? '설정 문구와 입력창 내용이 다릅니다. 이모지 표현을 비교한 뒤에도 불일치하여 초안을 보존하고 중지합니다.' :
            '문구는 일치하지만 커서·포커스·조합 입력 상태가 안정되지 않았습니다. 초안을 보존하고 중지합니다.'};
        } else await new Promise(resolve => setTimeout(resolve,150));
        trace('after-paste', {pastePrevented:paste.defaultPrevented});
        const currentEditors = editors();
        if (currentEditors.length !== 1 || !composerMatches(currentEditors[0],delivery.text)) {
          return { status: 'uncertain', error: 'Discord 편집기에 문구가 반영되지 않았습니다. 페이지를 새로고침하고 남은 초안을 확인해 주세요.' };
        }
        editor = currentEditors[0];
        if (!matchesTarget(target)) return { status: 'uncertain', error: '문구 입력 중 채널이 변경되었습니다. 초안을 확인해 주세요.' };
        if (!(await chrome.runtime.sendMessage({ type: 'DICO_CAN_SEND', id: delivery.id, phase:delivery.phase }))?.allowed) {
          return { status: 'uncertain', error: '문구 입력 후 예약이 취소되었습니다. 남은 초안을 확인해 주세요.' };
        }
        if (!matchesTarget(target) || !editor.isConnected || !composerMatches(editor,delivery.text)) {
          return { status: 'uncertain', error: '전송 직전에 채널이나 입력 내용이 변경되었습니다. 초안을 확인해 주세요.' };
        }

        if(delivery.phase==='prepare') {
          trace('prepared', {result:'prepared'});
          return {status:'prepared'};
        }
      }
      const finalSelection=window.getSelection();
      if (!matchesTarget(target) || editors()[0]!==editor || !editor.isConnected || composing || document.activeElement!==editor || !finalSelection?.isCollapsed || !editor.contains(finalSelection.anchorNode) || !editor.contains(finalSelection.focusNode) || !composerMatches(editor,delivery.text)) return {status:'blocked',error:'Enter 직전 입력창 상태가 변경되었습니다. 초안을 보존하고 중지합니다.'};
      const cooldown = slowmode(editor);
      if (cooldown.cooldownMs > 0) {
        trace('slowmode-wait', cooldown);
        return {status:'deferred',retryAfterMs:cooldown.cooldownMs,draftPrepared:true};
      }
      if (!target.skipConfirmation) watcher = watchMessage(editor, delivery.text, ownUserId(target), Date.now(), evidence => trace('observation', evidence));
      trace('before-enter');
      const keydown = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
      const keyup = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
      editor.dispatchEvent(keydown);
      editor.dispatchEvent(keyup);
      trace('enter-dispatched', {enterPrevented:keydown.defaultPrevented,keyupPrevented:keyup.defaultPrevented});
      if (target.skipConfirmation) { trace('finished',{result:'unverified'}); return {status:'unverified'}; }
      const outcome = await watcher.promise;
      trace('finished', {result:outcome.status,messageId:outcome.messageId});
      return outcome;
    } catch {
      trace('exception');
      watcher?.cancel();
      return { status: entered ? 'uncertain' : 'blocked', error: 'Discord 입력창에 연결하지 못했습니다. 채널과 남은 초안을 확인해 주세요.' };
    } finally { busy = false; }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === 'DICO_RECONCILE') {
      const result = reconcile(message.target, message.delivery);
      reportTrace(message.delivery, 'reconcile', {result:result.status,draftAction:result.draftAction});
      respond(result); return false;
    }
    if (message?.type === 'DICO_CHANNEL_LIMIT') { detectSlowmodeSetting(message.target).then(slowmodeSeconds=>respond({slowmodeSeconds})).catch(()=>respond({slowmodeSeconds:null})); return true; }
    if (message?.type === 'DICO_INSPECT') { detectSlowmodeSetting(message.target).catch(()=>null).then(()=>{const result=inspect(message.target);respond({...result,diagnostics:{...traceSnapshot(message.target,message.target.expectedText || ''),contentVersion:CONTENT_VERSION}});}); return true; }
    if (message?.type === 'DICO_PREPARE') { deliver(message.target,{...message.delivery,phase:'prepare'}).then(respond); return true; }
    if (message?.type === 'DICO_DELIVER') { deliver(message.target, message.delivery).then(respond); return true; }
    return false;
  });
})();
