/**
 * Discord 페이지 안에서 실행되는 입력·관찰 담당 코드입니다.
 * 중앙 관리와 단독 확장이 공유하는 원본이며 central/extension/content.js는 빌드 시 복사됩니다.
 * 읽는 순서: deliver → performDelivery → watchMessage.
 * 중앙 관리에서는 prepare가 초안 준비, commit이 승인 확인 후 실제 Enter 단계입니다.
 * confirmed의 의미는 confirmationBasis로 구분합니다. composer_cleared는 제출한 입력창이
 * 비워졌다는 근거이며, Discord 서버의 게시물을 직접 조회했다는 뜻은 아닙니다.
 */
(() => {
  const CONTENT_BUILD_ID = 'unmanaged';
  const loadedRuntime=typeof chrome!=='undefined'?chrome.runtime:null;
  if (globalThis.__dicoWhileLoaded) {
    const previous=globalThis.__dicoWhileLifecycle;
    // Pre-lifecycle versions need one explicit page refresh. Never stack them.
    if(!previous || previous.isCurrent())return;
    if(!previous.dispose())return;
  }
  globalThis.__dicoWhileLoaded = true;
  let busy = false;
  // 현재 작업에만 취소를 귀속합니다. 다른 시도/이전 세션의 신호는 무시합니다.
  // 취소는 초안을 지우지 않으며 이미 실행한 Enter를 미발송으로 바꾸지 않습니다.
  let activeOperation=null;
  const assertOperationActive=()=>{if(activeOperation?.cancelled)throw Object.assign(Error('중단 요청으로 입력을 차단했습니다.'),{code:'EXECUTION_STOPPED'});};
  const seenDeliveries = new Set();
  const completedDeliveries = new Map();
  let lastManagedRetryProfile = null;
  const RECEIPT_TTL_MS=600000;
  const managedTiming=target=>target?.managed===true&&target?.coordinated===true;
  /**
   * 숨겨진 탭은 페이지 타이머가 지연될 수 있어 중앙 관리 대기는 확장 worker에 맡깁니다.
   * 대기 종료 자체는 발송 승인이 아닙니다. 이후 계정·채널·초안과 승인을 다시 확인합니다.
   */
  async function deliveryDelay(target,durationMs){
    assertOperationActive();
    if(!managedTiming(target))return new Promise(resolve=>setTimeout(resolve,durationMs));
    // Hidden Chromium tabs can throttle chained page timers to once a minute.
    // The extension worker supplies bounded wakeups; every resumed operation
    // still checks the editor, clock, target and current send authorization.
    // 재승인 응답은 최대 5초 대기를 요청하지만 worker는 한 요청을 1초로 제한합니다.
    // 전체 대기 시간을 유지하면서 나누어 요청하고, 매 응답 뒤 중단 신호를 확인합니다.
    // 대기가 끝나도 Enter 권한은 생기지 않으며 호출부가 다시 승인을 확인합니다.
    for(let remaining=durationMs;;){
      const chunk=Math.min(1000,remaining);
      let response;
      try{response=await chrome.runtime.sendMessage({type:'DICO_DELAY',durationMs:chunk});}
      catch{response={ok:false,reasonCode:'DELAY_TRANSPORT_FAILED'};}
      assertOperationActive();
      if(response?.ok!==true)throw Object.assign(Error('전송 창의 대기 연결이 끊겼습니다.'),{code:'MANAGED_DELAY_UNAVAILABLE',reasonCode:response?.reasonCode||'DELAY_RESPONSE_UNAVAILABLE'});
      remaining-=chunk;if(remaining<=0)break;
    }
  }

  const normalize = text => text.replace(/\r\n/g, '\n').replace(/\u200b/g, '').replace(/(\p{Emoji})\uFE0F/gu, '$1').trim();
  // Support heading/list rendering without weakening author or freshness checks.
  const comparableLines = text => normalize(text).split('\n').map(line => line.trim()).filter(Boolean).join('\n');
  /**
   * 원문과 Discord 표시 문구를 비교합니다. 지원하는 Markdown·이모지 차이만 허용합니다.
   * 문구가 같아도 다른 사용자의 메시지일 수 있으므로 작성자·시각 검증은 별도로 필요합니다.
   */
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
  /**
   * Slate 입력창에서 실제 초안 내용을 읽습니다. 단순 innerText만 사용하면 이모지나
   * 지원하지 않는 요소를 놓칠 수 있습니다. unsupported는 초안을 덮어쓰지 않기 위한 신호입니다.
   */
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
  /**
   * 현재 초안이 이번 작업의 예상 문구와 같은지 검사합니다.
   * 사용자가 수정한 초안을 우리 초안으로 오인하면 덮어쓰기·중복 전송이 생길 수 있습니다.
   */
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
  const ownPanel=()=>document.querySelector('section[class*="panels"], div[class*="panels"], section[aria-label="User area"], section[aria-label="사용자 영역"]');
  const ownPanelRoot=panel=>panel?.querySelector?.('[class*="accountPopoutButtonWrapper"]')||panel?.querySelector?.('[class*="nameTag"]')?.parentElement||panel;
  function ownPanelIds(panel){
    const root=ownPanelRoot(panel),ids=new Set();if(!root)return ids;
    const add=id=>{if(/^\d{17,20}$/.test(id||''))ids.add(id);};
    for(const node of [root,...(root.querySelectorAll?.('[data-user-id], [data-author-id]')||[])]){add(node.getAttribute?.('data-user-id'));add(node.getAttribute?.('data-author-id'));}
    for(const image of root.querySelectorAll?.('img')||[]){const src=image.getAttribute('src')||'',match=src.match(/\/(?:avatars\/(\d{17,20})|users\/(\d{17,20})\/avatars)\//);if(match)add(match[1]||match[2]);}
    for(const link of root.querySelectorAll?.('a[href]')||[]){try{const url=new URL(link.getAttribute('href'),location.origin);if(url.origin===location.origin)add(url.pathname.match(/^\/users\/(\d{17,20})\/?$/)?.[1]);}catch{}}
    return ids;
  }
  let ownIdentityProof=null;
  function rememberOwnIdentity(target,identity){
    if(!target?.coordinated)return;
    const panel=ownPanel();
    ownIdentityProof=identity?.verified===true&&/^\d{17,20}$/.test(identity.accountId||'')&&identity.guildId===target.guildId&&identity.channelId===target.channelId&&panel
      ?{...identity,panel,root:ownPanelRoot(panel),path:location.pathname,checkedAt:Date.now()}:null;
  }
  /**
   * 계정 증명을 현재 사용자 패널과 연결합니다. 일반 검증에는 2초 유효기간을 적용합니다.
   * ignoreAge는 실제 계정 변경을 판단할 때만 사용합니다. 만료는 미확인 상태이지
   * 계정 변경의 증거가 아니며, 오래된 증명으로 발송이나 완료를 허용하는 옵션도 아닙니다.
   */
  function proofMatchesPanel(proof,panel,ignoreAge=false){
    if(!proof||proof.panel!==panel||proof.root!==ownPanelRoot(panel)||proof.path!==location.pathname||Date.now()-proof.checkedAt<0||(!ignoreAge&&Date.now()-proof.checkedAt>2000))return false;
    const clean=value=>typeof value==='string'?value.replace(/[\u200b-\u200d\ufeff]/g,'').trim():'';
    const root=proof.root,username=proof.username;
    const names=[...(root.querySelectorAll?.('[class*="username"], [class*="userTag"], [class*="hovered"], [data-username], [class*="panelSubtextContainer"] *')||[])].map(node=>clean(node.getAttribute?.('data-username')||node.textContent));
    const subtext=root.querySelector?.('[class*="panelSubtextContainer"]');
    const firstSubtext=[...(subtext?.querySelectorAll?.('*')||[])].find(node=>!node.childElementCount&&clean(node.textContent))||subtext;
    const labels=[...(root.querySelectorAll?.('[class*="username"], [class*="userTag"], [data-username]')||[]),firstSubtext].filter(Boolean).map(node=>clean(node.getAttribute?.('data-username')||node.textContent).replace(/^@/,'')).filter(name=>/^[a-z0-9_.]{2,32}$/.test(name));
    if(username&&labels.some(name=>name!==username))return false;
    if(username&&names.some(name=>name===username||name==='@'+username))return true;
    const title=root.querySelector?.('[class*="panelTitleContainer"], [class*="displayName"], [data-display-name]');
    return proof.identitySource==='own-panel-current-user'&&Boolean(proof.accountName)&&clean(title?.textContent)===proof.accountName;
  }
  /**
   * 패널에서 사용자 ID를 직접 읽을 수 없으면 확장에 계정 확인을 요청합니다.
   * 기본 아바타처럼 이미지 URL에 ID가 없는 경우에도 현재 계정을 검증하기 위한 경로입니다.
   */
  async function refreshOwnIdentity(target,force=false){
    if(!target?.coordinated)return;
    const panel=ownPanel(),ids=ownPanelIds(panel);
    if(ids.size>0)return;
    if(!force&&proofMatchesPanel(ownIdentityProof,panel)&&Date.now()-ownIdentityProof.checkedAt<1000)return;
    const began=Date.now();let identity;
    try{identity=await chrome.runtime.sendMessage({type:'DICO_ACCOUNT_IDENTITY'});}catch{}
    if(Date.now()-began<0||Date.now()-began>2000)identity=null;
    rememberOwnIdentity(target,identity);
  }
  async function requestInputAuthorization(target,message){
    const response=await chrome.runtime.sendMessage(message);
    if(target?.coordinated&&response?.identity)rememberOwnIdentity(target,response.identity);
    return response;
  }
  /**
   * 실제 입력을 하기 전에 현재 시도에 대한 허가를 요청합니다.
   * 통신이 늦거나 복구된 뒤에는 같은 계정·채널·초안인지 다시 확인해야 합니다.
   */
  async function requestDeliveryPermission(target,delivery,message,guard=null) {
    let retried=false;
    const original=editors()[0],originalForm=original?.closest?.('form');
    for(;;){
      if(retried){
        await refreshOwnIdentity(target,true);
        const observed=await guard?.();if(observed)return {allowed:false,outcome:observed};
        const inspection=inspectForDelivery(target,delivery),found=editors();
        if(!inspection.ok)return {allowed:false,code:inspection.code||'INPUT_SCOPE_CHANGED'};
        if(found.length!==1||!found[0].isConnected||composing||!composerMatches(found[0],delivery.text))return {allowed:false,code:'DRAFT_MISMATCH'};
        if(found[0]!==original&&!(original?.isConnected===false&&originalForm?.isConnected===true&&found[0].closest?.('form')===originalForm))return {allowed:false,code:'COMPOSER_EDITOR_CHANGED'};
      }
      // 승인 유효시간은 성공한 개별 요청을 기준으로 계산합니다. 이전 거절과
      // 백오프까지 합산하면 방금 받은 정상 승인을 다시 만료시켜 불필요한 왕복이
      // 생깁니다. 서버 시각을 덮어쓰지 않고 페이지의 wall/monotonic 시작점도 보존합니다.
      const requestStartedAt=Date.now(),requestMonoStartedAt=globalThis.performance?.now() ?? requestStartedAt;
      const response=await requestInputAuthorization(target,message);
      if(response?.allowed===true)return{...response,requestStartedAt,requestMonoStartedAt};
      if(response?.retryable!==true||!managedTiming(target)||delivery.phase!=='commit')return response;
      // A transient denial grants no input permission. Keep the original
      // operation and exact draft, then ask again; cancellation stays terminal.
      const found=editors();
      if(!matchesTarget(target)||!coordinatedAccountMatches(target)||found.length!==1||!found[0].isConnected||composing||!composerMatches(found[0],delivery.text))return {allowed:false,code:'INPUT_SCOPE_CHANGED'};
      if(message.type==='DICO_CAN_SEND'){
        // Authorization can fail independently of the wait connection. This
        // heartbeat keeps only the current attempt alive; it never grants Enter.
        // Call directly so an observation denial cannot recurse into heartbeats.
        const progress=await requestInputAuthorization(target,{type:'DICO_OBSERVE_WAIT',id:delivery.id,phase:'commit',retryCount:message.retryCount??0,elapsedMs:Math.max(0,Date.now()-delivery.startedAt)});
        if(progress?.allowed!==true&&progress?.retryable!==true)return progress;
      }
      await deliveryDelay(target,Math.max(100,Math.min(5000,Number(response.retryAfterMs)||500)));
      retried=true;
    }
  }
  function ownUserId(target) {
    if (/^\d{17,20}$/.test(target.ownUserId || '')) return target.ownUserId;
    const ids=ownPanelIds(ownPanel());return ids.size===1?[...ids][0]:null;
  }
  function coordinatedAccountMatches(target) {
    if (!target.coordinated) return true;
    const panel=ownPanel(),ids=ownPanelIds(panel);
    if(ids.size)return ids.size===1&&ids.has(target.ownUserId);
    return proofMatchesPanel(ownIdentityProof,panel)&&ownIdentityProof.accountId===target.ownUserId;
  }
  /**
   * 연속 메시지는 아바타를 생략하므로 앞 행에서 작성자를 찾을 수 있습니다.
   * cache는 한 번의 DOM 검사에서만 공유하여 반복 탐색 비용을 줄입니다.
   * 다음 검사까지 재사용하면 가상 스크롤로 바뀐 행의 작성자를 잘못 판단할 수 있습니다.
   */
  function authorId(row, cache = null) {
    // Consecutive messages omit avatars. Memoize only within one DOM scan:
    // busy lists otherwise walk the same preceding rows quadratically. Never
    // reuse identity across mutations, where virtualized rows can change owner.
    let current = row, result = null;
    const visited = [];
    while (current) {
      if (cache?.has(current)) { result = cache.get(current); break; }
      visited.push(current);
      const avatar = avatarUserId(current);
      if (avatar) { result = avatar; break; }
      if (current.querySelector('[id^="message-username-"]')) break;
      current = current.previousElementSibling;
    }
    if (cache) for (const item of visited) cache.set(item,result);
    return result;
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
        await deliveryDelay(target,250);
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
    // Discord의 카운트다운 텍스트 변형을 같은 입력창 범위에서 함께 읽는다.
    // 일반 채팅 본문이나 다른 입력창의 시간 표시는 발송 제한으로 사용하지 않는다.
    const selector = '[class*="slowModeCooldown"], [class*="slowmodeCooldown"], [class*="cooldownText"]';
    const candidates = [...(form?.querySelectorAll?.(selector) || [])];
    const nodes = candidates.filter(node => node.getClientRects().length > 0);
    let seconds = 0,cooldownKnown=true;
    for (const node of nodes) {
      const text = (node.textContent || '').trim();
      const match = text.match(/^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/);
      if (!match || Number(match[3]) > 59 || (match[1] && Number(match[2]) > 59)) {cooldownKnown=false;continue;}
      seconds = Math.max(seconds, Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]));
    }
    // 표시 부재는 명시적 0초나 권한 면제의 증거가 아니다.
    // 기존 실행 허용값과 관찰 근거를 분리해 서버장 계정을 영구 대기시키지 않는다.
    const cooldownEvidence = !cooldownKnown ? 'unreadable' : nodes.length ? 'countdown' : candidates.length ? 'hidden' : 'absent';
    const allCandidates = [...(document.querySelectorAll?.(selector) || [])];
    const cooldownOutsideScopeCount = allCandidates.filter(node=>!candidates.includes(node)).length;
    return {slowmodeSeconds:slowmodeSetting.path===location.pathname?slowmodeSetting.seconds:null,slowmodeDetected:nodes.length > 0,hiddenCooldownIndicator:candidates.length>nodes.length,cooldownKnown,cooldownEvidence,cooldownOutsideScopeCount, cooldownMs:Math.min(seconds,21600)*1000};
  }
  let cooldownProbeCancel = null;
  /**
   * Enter 뒤 실제 쿨다운 변화를 관찰하여 타이밍 보정에 사용할 측정값을 만듭니다.
   * 채널·계정 변경이나 시계 이상이 있으면 측정 근거로 사용하지 않습니다.
   */
  function observeCooldown(target, delivery, enterAt, enterMono) {
    cooldownProbeCancel?.();
    const mono=()=>globalThis.performance?.now() ?? Date.now(),originalEditor=editors()[0];
    let timer,seen=false,last=mono(),maxGapMs=0,zeroSince=null,zeroAt=null,done=false,remainingSamples=0;
    const send=(status,elapsedMs,remainingMs,observedAt=Date.now())=>{
      const seconds=slowmode(originalEditor).slowmodeSeconds;
      chrome.runtime.sendMessage({type:'DICO_TIMING_SAMPLE',channelId:delivery.channelId,deliveryId:delivery.id,
        sample:{status,enterAt,observedAt,elapsedMs,maxGapMs,...(remainingMs===undefined?{}:{remainingMs}),...(Number.isFinite(seconds)&&seconds>=0?{slowmodeMs:seconds*1000}:{})}}).catch(()=>{});
    };
    const finish=status=>{
      if(done)return;done=true;clearInterval(timer);
      send(status,(status==='observed'?zeroSince:mono())-enterMono,undefined,status==='observed'?zeroAt:Date.now());
    };
    const check=()=>{
      const now=mono(),gap=now-last;maxGapMs=Math.max(maxGapMs,gap);last=now;
      const elapsed=now-enterMono,wallElapsed=Date.now()-enterAt,found=editors();
      // Read-only calibration belongs to this exact successful send. A changed
      // account/editor, sleep or clock jump cannot shorten the next interval.
      if(gap<0||maxGapMs>1500||elapsed<0||Math.abs(elapsed-wallElapsed)>1000||!matchesTarget(target)||!coordinatedAccountMatches(target)||found.length!==1||found[0]!==originalEditor)return finish('inconclusive');
      const editor=found[0];
      if(normalize(editorText(editor)) || elapsed>Math.min(21720000,((slowmodeSetting.seconds || 60)+120)*1000))return finish('inconclusive');
      const cooldown=slowmode(editor);
      if(cooldown.cooldownKnown!==true)return finish('inconclusive');
      if(cooldown.cooldownMs>0){
        seen=true;zeroSince=null;zeroAt=null;
        // Early positive readings reach the scheduler before early preparation
        // can replace the empty composer and end the full unlock observation.
        if(target.coordinated&&remainingSamples<3&&elapsed<=15000){remainingSamples++;send('remaining',elapsed,cooldown.cooldownMs);}
      } else if(seen && cooldown.cooldownKnown && cooldown.cooldownMs===0) {
        if(zeroSince===null){zeroSince=now;zeroAt=Date.now();}
        if(now-zeroSince>=500)return finish('observed');
      } else if(!seen && elapsed>10000)return finish('inconclusive');
    };
    cooldownProbeCancel=()=>{done=true;clearInterval(timer);};
    if(managedTiming(target)){
      void(async()=>{while(!done){await deliveryDelay(target,500);if(!done){await refreshOwnIdentity(target);if(!done)check();}}})().catch(()=>finish('inconclusive'));
    }else timer=setInterval(check,500);
    check();
  }
  function inspect(target) {
    if (!target || !matchesTarget(target)) return { ok: false, code:'TARGET_MISMATCH', error: '선택한 Discord 채널과 현재 페이지가 다릅니다.' };
    if (!coordinatedAccountMatches(target)) return {ok:false,code:'ACCOUNT_UNVERIFIED',error:'순환 발송: 로그인 계정이 등록된 사용자 ID와 다르거나 화면에서 확인되지 않습니다. 프로필 이미지와 사용자 ID를 확인하세요.'};
    const found = editors();
    if (found.length === 0) return { ok: false, code: 'EDITOR_LOADING', retryable: true, error: '아직 사용할 수 있는 채팅 입력창이 없습니다(0개).' };
    if (found.length > 1) return { ok: false, code: 'EDITOR_AMBIGUOUS', error: `채팅 입력창이 ${found.length}개입니다. 전송용 창에서 열린 스레드나 메시지 편집을 닫아 주세요.` };
    if (hasDraft(found[0]) && (!target.messages?.some(text => composerMatches(found[0],text)) || editorContent(found[0]).unsupported)) return { ok: false, code:'DRAFT_MISMATCH', error: '작성 중인 메시지가 있어 중지했습니다. 직접 전송하거나 비운 뒤 다시 시작해 주세요.' };
    const form = found[0].closest('form') || found[0].parentElement;
    if (form.querySelector('[class*="uploadContainer"], [class*="channelAttachmentArea"] li, [class*="replyBar"]')) {
      return { ok: false, code:'ATTACHMENT_OR_REPLY', error: '첨부파일 또는 답장 상태를 해제한 뒤 다시 시작해 주세요.' };
    }
    if ((!target.skipConfirmation || target.draftRetrySince) && !document.querySelector('[data-list-id="chat-messages"]')) return { ok: false, code: 'HISTORY_LOADING', retryable: true, error: '채팅 기록이 아직 준비되지 않았습니다.' };
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
    return { ok: true, ...(target.coordinated?{coordinationVersion:1}:{}), ...slowmode(found[0]) };
  }
  function inspectManagedDraft(target,delivery) {
    if(!target?.managed||!target.coordinated||!matchesTarget(target))return{ok:false,code:'TARGET_MISMATCH',error:'관리 대상 채널에서만 초안을 확인할 수 있습니다.'};
    if(!coordinatedAccountMatches(target))return{ok:false,code:'ACCOUNT_UNVERIFIED',error:'현재 로그인 계정을 확인할 수 없습니다.'};
    const found=editors();
    if(found.length!==1)return{ok:false,code:found.length?'EDITOR_AMBIGUOUS':'EDITOR_LOADING',error:'초안을 확인할 입력창이 하나여야 합니다.'};
    const editor=found[0],content=editorContent(editor),form=editor.closest('form')||editor.parentElement;
    return{ok:true,draftText:content.text,draftMatches:composerMatches(editor,delivery?.text??target.expectedText),unsupported:content.unsupported===true,attachmentOrReply:Boolean(form?.querySelector('[class*="uploadContainer"], [class*="channelAttachmentArea"] li, [class*="replyBar"]'))};
  }
  function inspectForDelivery(target,delivery) {
    // Only an authenticated managed prepare can carry a locally backed-up CAS
    // token. Ordinary inspect, legacy sends and commit never permit replacement.
    if(delivery.phase!=='prepare'||!target.managed||!target.coordinated||typeof delivery.replaceExpectedDraft!=='string')return inspect(target);
    const found=editors();
    if(found.length!==1)return inspect(target);
    const editor=found[0],content=editorContent(editor);
    if(content.text!==delivery.replaceExpectedDraft&&!composerMatches(editor,delivery.text))return{ok:false,code:'DRAFT_MISMATCH',error:'보관 이후 초안이 변경되었습니다. 현재 초안을 보존하고 중지합니다.'};
    return inspect({...target,messages:[...(target.messages||[]),delivery.replaceExpectedDraft]});
  }
  const CONTENT_VERSION = '0.3.0';
  let composing = false;
  const compositionStart=()=>{composing=true},compositionEnd=()=>{composing=false};
  document.addEventListener?.('compositionstart', compositionStart, true);
  document.addEventListener?.('compositionend', compositionEnd, true);
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
      const request = chrome.runtime.sendMessage({type:'DICO_TRACE',id:delivery.id,stage,version:CONTENT_VERSION,buildId:CONTENT_BUILD_ID,
        data:{...data,messageIndex:delivery.index,deliveryPhase:delivery.phase || 'send',eventAt:data.eventAt??Date.now(),scheduledAt:delivery.scheduledAt,startedAt:delivery.startedAt,observedPath:location.pathname,elapsedMs:Date.now()-delivery.startedAt,latenessMs:Date.now()-delivery.scheduledAt}});
      return request?.catch?.(() => {});
    } catch { /* Diagnostics must not change delivery behavior. */ }
  }
  /**
   * Enter 전부터 메시지 DOM과 입력창을 관찰하는 상태 기계입니다.
   * 기존 메시지는 기준 목록으로 제외하고, 새 메시지의 문구·작성자·시각을 함께 살핍니다.
   * sendingActive는 현재 화면의 전송 중 표시, sendingSeen은 이번 관찰에서 본 누적 근거입니다.
   * 행이 화면 밖으로 사라져도 sendingSeen을 지우면 안 됩니다. 삭제가 미전송을 뜻하지 않습니다.
   * 중앙 관리 완료는 같은 계정·채널·제출한 입력창이 유지되며 초안이 비워진 경우입니다.
   * 초안이 남아 있고 전송 근거가 없을 때만 재시도 후보가 됩니다. 전송 근거가 있으면 관찰을 유지합니다.
   */
  function watchMessage(editor, text, userId, startedAt, report = () => {}, submissionOnly = false, keepWatching = false, managed = false, submissionTarget = null, observationPermission = null) {
    const selector = '[data-list-id="chat-messages"] [id^="message-content-"]';
    const existing = new Set([...document.querySelectorAll(selector)].map(node => node.id));
    const locallySending = new Set();
    const localNodes = new WeakSet();
    // React can replace the content node and optimistic ID while retaining the
    // message row. Preserve row identity and the author observed during our
    // local sending state; matching text alone is never a receipt.
    const localRows = new WeakSet();
    const localAuthors = new Set();
    const replacementNodes = new WeakSet();
    // React can replace the entire optimistic row. Only transfer provenance
    // across a unique remove/add at the same DOM slot in one observer batch.
    // A matching message elsewhere (or a whole-list rerender) is not evidence.
    /**
     * React가 전송 중 행 전체를 교체하는 경우 이전 행의 근거를 연결합니다.
     * 같은 DOM 위치의 단일 교체만 연결하고, 문구가 같다는 이유만으로 다른 행을 연결하지 않습니다.
     */
    const linkReplacements = records => {
      const slots=[];
      const messages=root=>root?.id?.startsWith('message-content-')?[root]:[...(root?.querySelectorAll?.('[id^="message-content-"]') || [])];
      for(const record of records || []) {
        if(record.type!=='childList')continue;
        let slot=slots.find(s=>s.target===record.target && s.previous===record.previousSibling && s.next===record.nextSibling);
        if(!slot){slot={target:record.target,previous:record.previousSibling,next:record.nextSibling,removed:[],added:[]};slots.push(slot);}
        slot.removed.push(...[...record.removedNodes].flatMap(messages));
        const addedMessages=[...record.addedNodes].flatMap(messages);
        // Even a transient new row removed before this observer callback is
        // activity; absence from the current DOM is not permission to retry.
        if(addedMessages.some(node=>!existing.has(node.id)))evidence.newMessage=true;
        slot.added.push(...addedMessages);
      }
      for(const slot of slots) {
        const tracked=slot.removed.filter(node=>localNodes.has(node) || replacementNodes.has(node));
        if(tracked.length)evidence.removedSendingCount=(evidence.removedSendingCount || 0)+tracked.length;
        if(slot.removed.length!==1 || slot.added.length!==1){if(tracked.length)evidence.ambiguousReplacementCount=(evidence.ambiguousReplacementCount || 0)+1;continue;}
        const old=slot.removed[0],fresh=slot.added[0];
        if(!(localNodes.has(old) || replacementNodes.has(old)) || existing.has(fresh.id))continue;
        if(matchesRenderedText(text,messageText(old)) && matchesRenderedText(text,messageText(fresh))){replacementNodes.add(fresh);evidence.linkedReplacementCount=(evidence.linkedReplacementCount || 0)+1;}
      }
    };
    const expectedDraft=Boolean(submissionTarget&&editor.isConnected&&composerMatches(editor,text));
    // Enter 직전 검증한 계정을 제출 근거에 묶습니다. 이후 패널 응답 지연은
    // 같은 채널·입력창의 실제 비움을 완료하는 데 추가 대기 조건이 아닙니다.
    const accountVerifiedAtSubmission=Boolean(submissionTarget&&coordinatedAccountMatches(submissionTarget));
    const submittedEditor=editor,submittedForm=editor.closest?.('form');
    let submitted=false,composerReadable=false,editorReacquired=false,scopeChanged=false,ownSendFailed=false;
    let observer, timer, poll, resolve, latest, deadline=null, finished = false;
    let detail = '새 메시지가 화면에 나타나지 않았습니다.';
    const evidence = {newMessage:false,matchingMessage:false,sendingSeen:false,failedSeen:false,authorMismatch:false,authorUnknown:false,timeMismatch:false};
    const composerEvidence=()=>submissionTarget?Object.fromEntries(['composerEmpty','editorPresent','sameEditor','sameComposer','editorReacquired','targetMatched','accountMatched','expectedDraftSubmitted','sendingActive','ownMessageSeen','scopeChanged','accountProofPending','accountVerifiedAtSubmission'].filter(key=>typeof evidence[key]==='boolean').map(key=>[key,evidence[key]])):{};
    let promise = new Promise(done => { resolve = done; });
    const finish = value => {
      if (finished) return;
      finished = !(keepWatching && value.status==='draft-retained');
      report(evidence);
      const fields=['newMessage','matchingMessage','sendingSeen','failedSeen','authorMismatch','authorUnknown','timeMismatch'];
      const deliveryEvidence=Object.fromEntries(fields.map(key=>[key,evidence[key]===true]));
      Object.assign(deliveryEvidence,composerEvidence(),value.deliveryEvidence||{});
      if(finished){observer?.disconnect();clearInterval(poll);}
      clearTimeout(timer);deadline=null;latest={...value,deliveryEvidence};resolve(latest);
    };
    const currentEditor = () => editor.isConnected ? editor : editors()[0];
    /**
     * DOM 변화 또는 주기적 확인 때 호출됩니다. freshIdentity는 계정 갱신 후 검사라는 뜻입니다.
     * 일시적인 증명 만료와 실제 계정·채널 변경을 구분하여 같은 입력창의 관찰을 보존합니다.
     */
    const check = (freshIdentity=false) => {
      if (finished) return;
      if(submissionTarget){
        const targetMatched=matchesTarget(submissionTarget);
        // Expired proof is unknown, not evidence of an account switch.
        const panel=ownPanel(),ids=ownPanelIds(panel);
        // 패널 DOM 재생성/증명 만료는 미확인일 뿐 계정 변경의 증거가 아닙니다.
        // 실제 ID 불일치 또는 현재 패널에 연결된 다른 계정 증명만 변경으로 고정합니다.
        const accountChanged=ids.size>0?!(ids.size===1&&ids.has(submissionTarget.ownUserId)):Boolean(ownIdentityProof&&proofMatchesPanel(ownIdentityProof,panel,true)&&ownIdentityProof.accountId!==submissionTarget.ownUserId);
        if(!targetMatched||accountChanged)scopeChanged=true;
        const found=editors(),candidate=found.length===1?found[0]:null;
        // A Slate leaf can remount during submission while its live channel form
        // stays intact. Reacquire only that unique composer in this operation;
        // a new form, navigation or changed identity has no submission provenance.
        if(submitted&&!scopeChanged&&!editor.isConnected&&candidate?.isConnected&&submittedForm?.isConnected===true&&candidate.closest?.('form')===submittedForm){editor=candidate;editorReacquired=true;}
      }
      const liveEditor = currentEditor();
      const empty = liveEditor && !normalize(editorText(liveEditor));
      // Skipping server confirmation must not skip evidence that Enter submitted
      // the composer. Never advance A/B merely because dispatchEvent returned.
      if (submissionOnly && empty) { finish({status:'unverified'}); return; }
      let validSubmittedComposer=false;
      if(submissionTarget){
        const found=editors(),sameComposer=Boolean(!scopeChanged&&editor.isConnected&&found.length===1&&found[0]===editor),sameEditor=Boolean(editor===submittedEditor&&editor.isConnected&&found.length===1&&found[0]===editor);
        const targetMatched=matchesTarget(submissionTarget),accountMatched=coordinatedAccountMatches(submissionTarget);
        const form=editor.closest?.('form')||editor.parentElement;
        composerReadable=!composing&&!editorContent(editor).unsupported&&!form?.querySelector('[class*="uploadContainer"], [class*="channelAttachmentArea"] li, [class*="replyBar"]');
        Object.assign(evidence,{scopeChanged,accountProofPending:!accountMatched,accountVerifiedAtSubmission,editorPresent:found.length>0,sameEditor,sameComposer,editorReacquired,targetMatched,accountMatched,composerEmpty:Boolean(sameComposer&&empty),expectedDraftSubmitted:expectedDraft&&submitted});
        const submissionAccountMatched=accountMatched||accountVerifiedAtSubmission&&!scopeChanged;
        validSubmittedComposer=expectedDraft&&submitted&&sameComposer&&targetMatched&&submissionAccountMatched&&composerReadable;
        // 중앙 완료 기준은 실제 제출한 입력창이 비워진 상태입니다. 먼저 같은
        // 계정·채널·입력창을 검증하여 빠른 채팅의 전체 목록 순회를 기다리지 않습니다.
        // 이미 관찰한 메시지 ID는 보존하되, ID를 얻으려고 완료를 늦추지 않습니다.
        // 초안이 남거나 범위가 불명확하면 아래 전송·실패 근거 검사를 그대로 수행합니다.
        if(validSubmittedComposer&&empty){finish({status:'confirmed',confirmationBasis:'composer_cleared',...(evidence.messageId?{messageId:evidence.messageId}:{}),deliveryEvidence:{composerCleared:true,expectedDraftSubmitted:true,sameEditor,sameComposer:true,editorReacquired,targetMatched:true,accountMatched:true,accountVerifiedAtSubmission,accountProofPending:!accountMatched}});return;}
      }
      let sendingActive=false;
      const authorCache = new Map();
      for (const node of document.querySelectorAll(selector)) {
        if (existing.has(node.id)) continue;
        evidence.newMessage = true;
        const row = node.closest('li') || node;
        // A busy channel can render the same text from another account. Resolve
        // ownership before any sending/failure state or optimistic provenance;
        // foreign traffic must never keep our retained draft in observation.
        const author = authorId(row,authorCache);
        if (author && ((userId && author !== userId) || (localAuthors.size>0 && !localAuthors.has(author)))) {
          evidence.authorMismatch = true;
          continue;
        }
        // Keep failure diagnostics even when emoji/Markdown text differs.
        // Managed completion still follows the verified submitted composer.
        if (row.querySelector('[class*="isFailed"]') || row.matches('[class*="isFailed"]')) {
          evidence.failedSeen = true;detail = 'Discord가 메시지를 전송 실패로 표시했습니다.';
          const failedId=node.id.match(/^message-content-(\d{17,20})$/)?.[1];
          const failedAt=failedId?Number((BigInt(failedId)>>22n)+1420070400000n):0;
          const tracked=locallySending.has(node.id)||localNodes.has(node)||localRows.has(row)||replacementNodes.has(node);
          if(submitted&&evidence.sendingSeen&&matchesRenderedText(text,messageText(node))&&(tracked||(author===userId&&failedAt>=startedAt&&failedAt<=Date.now()+2000)))ownSendFailed=true;
          continue;
        }
        if (!matchesRenderedText(text, messageText(node))) {
          if(!evidence.matchingMessage)detail = '새 메시지는 있지만 문구가 일치하지 않습니다. Markdown·이모지 표시 차이를 확인하세요.';
          continue;
        }
        evidence.matchingMessage = true;
        const isSending = row.querySelector('[class*="isSending"]') || row.matches('[class*="isSending"]');
        // Optimistic IDs need not be final snowflakes. Observe them even while
        // Slate still displays the submitted draft, then require a final ID.
        if (isSending) {
          evidence.sendingSeen = true;sendingActive=true;
          locallySending.add(node.id); localNodes.add(node); localRows.add(row);
          const sendingAuthor=author;
          if(sendingAuthor && (!userId || sendingAuthor===userId))localAuthors.add(sendingAuthor);
          detail = '메시지가 아직 전송 중으로 표시됩니다.';
          continue;
        }
        const id = node.id.match(/^message-content-(\d{17,20})$/)?.[1];
        const created = id ? Number((BigInt(id) >> 22n) + 1420070400000n) : 0;
        if (!id || created < startedAt - 2000 || created > Date.now() + 2000) {
          evidence.timeMismatch = true;
          detail = '메시지 생성 시각을 이번 전송과 연결하지 못했습니다.'; continue;
        }
        const sameNode=localNodes.has(node),sameRow=localRows.has(row),sameReplacement=replacementNodes.has(node);
        const observedAuthor=Boolean(author && localAuthors.has(author));
        evidence.sameSendingReplacement=sameReplacement;evidence.sameSendingNode=sameNode;evidence.sameSendingRow=sameRow;evidence.observedSendingAuthor=observedAuthor;
        if (!locallySending.has(node.id) && !sameNode && !sameRow && !sameReplacement && !observedAuthor && (!userId || author !== userId)) {
          evidence.authorUnknown = true;
          detail = '작성자를 확인하지 못했습니다. 설정의 내 Discord 사용자 ID를 입력해 주세요.'; continue;
        }
        if(!submissionTarget||created>=startedAt)evidence.ownMessageSeen=true;
        if (!empty) { detail = '입력창이 비워졌는지 확인하지 못했습니다.'; continue; }
        evidence.messageId=id;
        if(!submissionTarget){finish({status:'confirmed',messageId:id,confirmationBasis:'message_observed'});return;}
      }
      if(submissionTarget){
        evidence.sendingActive=sendingActive;
        if(ownSendFailed&&!empty){finish({status:'uncertain',code:'DISCORD_SEND_FAILED',deliveryEvidence:{composerRetained:composerMatches(editor,text)},error:'이번 전송에 실패 표시가 확인되어 추가 Enter를 중지하고 초안을 보존합니다.'});return;}
        // Give the page its next observation turn; do not repeatedly spend a
        // 25-second post-confirmation window on a retained exact draft.
        if(freshIdentity&&deadline!==null&&validSubmittedComposer&&composerMatches(editor,text)&&!evidence.sendingSeen&&!sendingActive&&!evidence.ownMessageSeen)finish({status:'draft-retained',code:'DELIVERY_DRAFT_RETAINED',deliveryEvidence:{composerRetained:true},error:'입력창에 같은 문구가 남아 있어 실제 쿨다운 해제 후 재시도합니다.'});
      }
    };
    observer = new MutationObserver(records=>{linkReplacements(records);check();});
    observer.observe(document.querySelector('main') || document.body, {subtree:true,childList:true,characterData:true,attributes:true});
    // Read-only checks: no additional Enter, reload or retransmission.
    /**
     * 관찰 기한이 끝났을 때의 판단입니다. 기한 만료만으로 미발송을 확정하지 않습니다.
     * 중앙 관리에서 본인 전송 근거가 있고 같은 초안이면 관찰 기한을 연장합니다.
     */
    const expire = (freshIdentity=false) => {
      check(freshIdentity);if(finished||deadline===null)return;
      const liveEditor = currentEditor();
      const retained = Boolean(liveEditor&&composerMatches(liveEditor,text)&&(!submissionTarget||evidence.sameComposer));
      const retryDraft = retained && !evidence.newMessage && !evidence.sendingSeen && !evidence.failedSeen;
      if(submissionTarget){
        // 일시적인 계정 응답 유실 동안은 입력·재전송 없이 원래 제출 관찰만 유지합니다.
        if(managed&&!scopeChanged&&evidence.sameComposer&&evidence.targetMatched&&!evidence.accountMatched){deadline=Date.now()+5000;return;}
        if(managed&&retained&&composerReadable&&evidence.targetMatched&&evidence.accountMatched&&(evidence.sendingSeen||evidence.sendingActive||evidence.ownMessageSeen)){deadline=Date.now()+25000;return;}
        const code=evidence.failedSeen?'DISCORD_SEND_FAILED':!evidence.targetMatched?'TARGET_MISMATCH':!evidence.accountMatched?'ACCOUNT_UNVERIFIED':!evidence.editorPresent?'COMPOSER_EDITOR_MISSING':!evidence.sameComposer?'COMPOSER_EDITOR_CHANGED':!composerReadable?'COMPOSER_STATE_UNREADABLE':retained?'DELIVERY_DRAFT_RETAINED':!evidence.composerEmpty?'COMPOSER_DRAFT_CHANGED':'COMPOSER_STATE_UNREADABLE';
        const errors={DISCORD_SEND_FAILED:'Discord가 전송 실패를 표시했습니다. 초안과 오류 표시를 확인하세요.',TARGET_MISMATCH:'전송 후 다른 채널로 이동했습니다. 원래 채널의 입력 상태를 확인하세요.',ACCOUNT_UNVERIFIED:'전송 후 등록 계정을 확인할 수 없습니다. 로그인 계정과 입력 상태를 확인하세요.',COMPOSER_EDITOR_MISSING:'전송 후 입력창이 보이지 않습니다. 전송용 채널을 확인하세요.',COMPOSER_EDITOR_CHANGED:'전송 후 입력창이 바뀌었습니다. 남은 초안과 입력 상태를 확인하세요.',COMPOSER_STATE_UNREADABLE:'전송 후 입력 상태를 읽을 수 없습니다. 초안을 보존합니다.',COMPOSER_DRAFT_CHANGED:'전송 후 입력 문구가 바뀌었습니다. 변경된 초안을 보존합니다.',DELIVERY_DRAFT_RETAINED:'입력창에 문구가 남아 있습니다. 진행 중인 전송 표시와 초안을 확인하세요.'};
        finish({status:'uncertain',code,deliveryEvidence:{composerRetained:retained},error:errors[code]});return;
      }
      finish({status:retryDraft ? 'draft-retained' : 'uncertain',code:retryDraft?'DELIVERY_DRAFT_RETAINED':'DELIVERY_CONFIRMATION_TIMEOUT',deliveryEvidence:{composerRetained:retained},error:liveEditor && normalize(editorText(liveEditor))
        ? '전송 후 입력창에 문구가 남아 있습니다. 실제 게시 여부와 초안을 확인하세요.'
        : `25초 동안 발송 완료를 확인하지 못했습니다. ${detail} 실제 게시 여부를 확인하세요.`});
    };
    const armTimeout=()=>{deadline=Date.now()+(submissionOnly?3000:25000);if(!managed)timer=setTimeout(expire,submissionOnly?3000:25000);};
    armTimeout();
    if(managed){
      void(async()=>{let lastObservationAt=0;while(!finished){
        await deliveryDelay({managed:true,coordinated:true},500);if(finished)break;
        if(submissionTarget)await refreshOwnIdentity(submissionTarget,true);if(finished)break;
        if(deadline!==null&&Date.now()>=deadline)expire(true);else check(true);
        if(!finished&&submitted&&!scopeChanged&&(evidence.sendingSeen||evidence.sendingActive||evidence.ownMessageSeen||!evidence.accountMatched)&&Date.now()-lastObservationAt>=1000&&observationPermission){
          lastObservationAt=Date.now();report({...evidence,observationPending:true});
          const permission=await observationPermission();if(finished)break;
          if(permission?.allowed!==true)finish({status:'uncertain',code:permission?.code||'OBSERVATION_CANCELLED',error:'자동 관찰이 중지되어 남은 초안을 보존합니다.'});
        }
      }})().catch(()=>finish({status:'uncertain',code:'MANAGED_DELAY_UNAVAILABLE',error:'관찰 연결이 끊겨 초안과 발송 기록을 보존합니다.'}));
    }else poll=setInterval(check,500);
    return {
      get promise(){return promise;},
      get editor(){return editor;},
      submitted(){submitted=true;check();},
      snapshot(){
        const liveEditor=currentEditor();
        const fields=['newMessage','matchingMessage','sendingSeen','failedSeen','authorMismatch','authorUnknown','timeMismatch'];
        return {...Object.fromEntries(fields.map(key=>[key,evidence[key]===true])),...composerEvidence(),composerRetained:Boolean(liveEditor&&composerMatches(liveEditor,text)&&(!submissionTarget||evidence.sameComposer))};
      },
      // Preserve the original history baseline and observation across retry
      // waits. A late post must never become an ignored pre-existing message.
      retryOutcome(){
        check();
        if(finished)return latest;
        const fields=['newMessage','matchingMessage','sendingSeen','failedSeen','authorMismatch','authorUnknown','timeMismatch'];
        if(managed&&submissionTarget&&evidence.sameComposer&&evidence.targetMatched&&evidence.accountMatched&&composerReadable&&composerMatches(editor,text)&&(evidence.sendingSeen||evidence.sendingActive||evidence.ownMessageSeen))return{status:'observation-pending'};
        if((submissionTarget?evidence.sendingSeen||evidence.sendingActive||evidence.ownMessageSeen:fields.some(key=>evidence[key])) || !editor.isConnected || editors().length!==1 || editors()[0]!==editor || !composerMatches(editor,text))return{status:'uncertain',code:'RETRY_DELIVERY_AMBIGUOUS',error:'이전 Enter 이후 게시 기록 또는 입력창이 변경되어 추가 전송을 중지합니다.',deliveryEvidence:{...Object.fromEntries(fields.map(key=>[key,evidence[key]===true])),composerRetained:Boolean(editor.isConnected&&composerMatches(editor,text))}};
        return null;
      },
      rearm(){if(finished)return false;promise=new Promise(done=>{resolve=done;});armTimeout();return true;},
      stop(){finished=true;observer?.disconnect();clearTimeout(timer);clearInterval(poll);},
      cancel:code=>finish({status:'uncertain',...(code?{code}:{}),error:'입력 중 오류가 발생했습니다. 입력창과 채널을 확인해 주세요.'})
    };
  }
  /**
   * 응답 유실 등의 상황에서 현재 화면과 기존 발송 정보를 대조합니다.
   * 채널·초안·작성자가 불명확하면 uncertain을 반환하며 새 Enter를 실행하지 않습니다.
   */
  function reconcile(target, delivery, recoveryWindow) {
    const unknown = (reason, messageId) => ({status:'uncertain', reason, ...(messageId ? {messageId} : {})});
    if (!target || !matchesTarget(target)) return unknown('wrong-channel');
    if (!delivery?.id || typeof delivery.text !== 'string' || !Number.isFinite(delivery.startedAt)) return unknown('invalid-delivery');
    // 중앙이 증명한 조회 구간에서는 게시 이력만 읽으며 초안 상태로 판정을 막지 않습니다.
    const historyOnly=target.coordinated===true&&Number.isSafeInteger(recoveryWindow?.from)&&
      Number.isSafeInteger(recoveryWindow.until)&&recoveryWindow.from<=recoveryWindow.until;
    if(target.coordinated&&!coordinatedAccountMatches(target))return unknown('author-unknown');
    const found = editors();
    if (!historyOnly&&found.length !== 1) return unknown('draft-or-editor');
    const editor = found[0];
    const draft = historyOnly?'':normalize(editorText(editor));
    const nextText = !historyOnly&&[0,1].includes(delivery.index) ? target.messages?.[1-delivery.index] : undefined;
    const form = editor?.closest?.('form') || editor?.parentElement;
    if (!historyOnly&&(editorContent(editor).unsupported || form?.querySelector('[class*="uploadContainer"], [class*="channelAttachmentArea"] li, [class*="replyBar"]'))) return unknown('draft-or-editor');
    const user = ownUserId(target);
    if (!user) return unknown('author-unknown');
    const candidates = new Set();
    let nextAlreadyPosted = null;
    const oppositePosts=new Map();
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
      const from=historyOnly?recoveryWindow.from:delivery.startedAt;
      const until=historyOnly?Math.min(recoveryWindow.until,Date.now()+2000):Date.now()+2000;
      if (!id || created < from || created > until || authorId(row) !== user) continue;
      if (currentMatch) candidates.add(id);
      if (nextMatch && !currentMatch) { nextAlreadyPosted = id; oppositePosts.set(id,created); }
    }
    // Migration only: the old watcher accepted server timestamps up to 2s ahead
    // of the local clock, but did not persist the acknowledged message ID.
    if (!target.lastConfirmedMessageId && target.lastOutcome==='confirmed' &&
        Number.isFinite(target.lastSentAt) && delivery.startedAt===target.lastSentAt+1 &&
        !draft && candidates.size===0 && oppositePosts.size===1 &&
        oppositePosts.get(nextAlreadyPosted)<=target.lastSentAt+2000) {
      return unknown('acknowledged-legacy-post',nextAlreadyPosted);
    }
    if (nextAlreadyPosted) return unknown('next-already-posted',nextAlreadyPosted);
    if (candidates.size !== 1) return unknown(candidates.size ? 'multiple-matches' : 'no-proof');
    if(historyOnly)return {status:'confirmed',messageId:[...candidates][0]};
    let draftAction = 'empty';
    if (draft) {
      if (typeof nextText === 'string' && composerMatches(editor,nextText)) draftAction = 'reuse-next';
      else if (composerMatches(editor,delivery.text)) draftAction = 'replace-next';
      else return unknown('foreign-draft');
    }
    return {status:'confirmed',draftAction,messageId:[...candidates][0]};
  }
  /**
   * 입력창이 일정 시간 같은 상태로 유지되는지 확인합니다.
   * 렌더링 중 교체된 editor 참조나 사용자의 입력을 그대로 재사용하지 않기 위한 단계입니다.
   */
  async function stableEditor(target, text, editor, duration, report, allowDelayRecovery=false) {
    const began=Date.now(); let stableSince=null,maxStableMs=0,textStableSince=null,repaired=false;
    const failureCounts={};let lastFailedChecks=[];
    let lastSample=began,deadline=began+5000,delayRecovered=false;
    let maxSampleGapMs=0,sampleCount=0;
    const fail=()=>{
      // 진단 응답은 입력 차단·실패 반환의 선행 조건이 아닙니다. Native 제보가
      // 느려도 1.5초를 더 기다리지 않고 실행기가 즉시 복구/중지를 처리합니다.
      void report('stability-failed',{failedChecks:lastFailedChecks,failureCounts,maxStableMs,stableRequiredMs:duration,stableWaitMs:Date.now()-began,maxSampleGapMs,sampleCount});
      return false;
    };
    while (true) {
      await refreshOwnIdentity(target);
      const now=Date.now(),gap=now-lastSample;
      maxSampleGapMs=Math.max(maxSampleGapMs,gap);lastSample=now;
      // A suspended/throttled page cannot supply observations. Never count the
      // unobserved gap as stable input; allow one bounded, fresh sampling window.
      if(gap>1500) {
        stableSince=null;textStableSince=null;maxStableMs=0;
        report('stability-timer-delayed',{maxSampleGapMs,sampleCount,stableWaitMs:now-began});
        if(allowDelayRecovery && !delayRecovered && now-began<15000){delayRecovered=true;deadline=now+5000;}
      }
      if(now>=deadline || now-began>=20000)return fail();
      sampleCount++;
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
        await deliveryDelay(target,100);continue;
      }
      if(!lastFailedChecks.length) {
        stableSince ??=Date.now();maxStableMs=Math.max(maxStableMs,Date.now()-stableSince);
        if(maxStableMs>=duration)return true;
      } else stableSince=null;
      await deliveryDelay(target,100);
    }
    return fail();
  }
  /**
   * 실제 입력창의 쿨다운을 확인하며 commit 직전까지 기다립니다.
   * 예약 시각이 지났다는 사실과 Discord에서 실제 전송 가능한 상태는 구분합니다.
   */
  async function waitForCommitCooldown(target,delivery,editor,trace,state) {
    const maxWaitMs=21630000,mono=()=>globalThis.performance?.now() ?? Date.now();
    for(;;){
      await refreshOwnIdentity(target);
      const observed=await state.guard?.();if(observed)return observed;
      editor=state.currentEditor?.()||editor;
      const current=inspect(target),found=editors();
      if(!current.ok)return{status:'blocked',code:current.code,error:current.error};
      if(found.length!==1||found[0]!==editor||!editor.isConnected||composing||!composerMatches(editor,delivery.text))return{status:'blocked',code:'DRAFT_MISMATCH',error:'대기 중 입력창이나 준비한 문구가 변경되었습니다. 초안을 보존하고 중지합니다.'};
      if(!current.cooldownKnown)return{status:'deferred',code:'COOLDOWN_UNVERIFIED',draftPrepared:true,error:'Discord의 남은 대기 시간을 확인하지 못했습니다. 초안을 보존하고 중지합니다.'};
      const now=Date.now(),monoNow=mono();
      const elapsed=state.startedAt===undefined?0:now-state.startedAt,monoElapsed=state.monoStarted===undefined?0:monoNow-state.monoStarted;
      if(elapsed<0||monoElapsed<0||state.retryCount===0&&(elapsed>=maxWaitMs||monoElapsed>=maxWaitMs)||Math.abs(elapsed-monoElapsed)>1000)return{status:'deferred',code:'COOLDOWN_WAIT_TIMEOUT',retryAfterMs:current.cooldownMs,draftPrepared:true,error:'Discord 대기 확인 시간이 만료되었습니다. 현재 초안과 차례를 보존합니다.'};
      if(current.cooldownMs<=0){
        if(state.waiting){
          const progress=await requestDeliveryPermission(target,delivery,{type:state.retryCount>0?'DICO_RETRY_WAIT':'DICO_PRE_ENTER_WAIT',id:delivery.id,phase:'commit',retryCount:state.retryCount||0,elapsedMs:elapsed,cooldownMs:0,maxWaitMs,enterAttempted:state.retryCount>0},state.guard);
          if(progress?.outcome)return progress.outcome;
          if(progress?.allowed!==true)return{status:'blocked',code:progress?.code||'PRE_ENTER_WAIT_CANCELLED',error:'대기 해제 확인 중 발송이 중지되었습니다. 초안을 보존합니다.'};
          state.waiting=false;
        }
        return null;
      }
      state.waiting=true;
      state.startedAt??=now;state.monoStarted??=monoNow;
      if(state.lastTraceAt===undefined||elapsed-state.lastTraceAt>=5000){state.lastTraceAt=elapsed;trace('slowmode-wait',{cooldownMs:current.cooldownMs,elapsedMs:elapsed,maxWaitMs});}
      // This keeps the existing attempt alive and checks cancellation. It does
      // not authorize Enter; strict authorization is requested after waiting.
      const progress=await requestDeliveryPermission(target,delivery,{type:state.retryCount>0?'DICO_RETRY_WAIT':'DICO_PRE_ENTER_WAIT',id:delivery.id,phase:'commit',retryCount:state.retryCount||0,elapsedMs:elapsed,cooldownMs:current.cooldownMs,maxWaitMs,enterAttempted:state.retryCount>0},state.guard);
      if(progress?.outcome)return progress.outcome;
      if(progress?.allowed!==true)return{status:'blocked',code:progress?.code||'PRE_ENTER_WAIT_CANCELLED',error:'대기 중 발송이 중지되었거나 현재 시도의 연결이 만료되었습니다. 초안을 보존합니다.'};
      await deliveryDelay(target,500);
    }
  }
  /**
   * 발송 진입점입니다. 단계별 근거를 모으고 performDelivery 결과에 합칩니다.
   * 완료 영수증은 실제로 관찰한 동일 시도의 결과만 짧게 보관합니다.
   * 나중에 빈 입력창을 발견했다는 이유로 과거 시도의 성공 영수증을 만들지 않습니다.
   */
  async function deliver(target, delivery) {
    const evidence={phase:delivery?.phase==='prepare'?'prepare':delivery?.phase==='commit'?'commit':'send',stage:'inspect',enterAttempted:false};
    evidence.retryCount=0;
    // 정상 미발송은 사용자 횟수 설정으로 종료하지 않는다. 구형 유한 값도 무시한다.
    // null은 같은 초안의 안전한 재시도만 계속한다는 내부 표현이다. 중지·실제 오류·
    // 발송 여부 불확실은 아래 관찰/승인 보호 장치가 즉시 추가 Enter를 차단한다.
    evidence.maxSendRetries=delivery?.phase==='commit'?null:0;
    await refreshOwnIdentity(target);
    const result=await performDelivery(target,delivery,evidence);
    // Final-response metadata survives even when optional tracing is unavailable.
    // Never include message text, DOM, URLs or raw exceptions in this object.
    const completed={...result,deliveryEvidence:{...evidence,...result.deliveryEvidence}};
    if(target?.coordinated===true&&delivery?.phase==='commit'&&completed.status==='confirmed'&&completed.confirmationBasis==='composer_cleared'){
      lastManagedRetryProfile={path:location.pathname,accountId:target.ownUserId,at:Date.now(),retryCount:completed.deliveryEvidence.retryCount};
      // Retain the observed terminal result, never infer a receipt from a later
      // empty editor. This memory disappears with the content script/document.
      completedDeliveries.set(delivery.id,{result:completed,at:Date.now(),text:delivery.text,startedAt:delivery.startedAt,sessionId:delivery.sessionId,accountId:target.ownUserId,guildId:target.guildId,channelId:target.channelId,path:location.pathname,editor:editors()[0]});
      while(completedDeliveries.size>100)completedDeliveries.delete(completedDeliveries.keys().next().value);
    }
    return completed;
  }
  /**
   * 실제 작업 순서: 중복 차단 → 대상/초안 검사 → 준비 → 승인/쿨다운 확인 → Enter → 관찰.
   * busy는 동시 실행, seenDeliveries는 같은 요청 ID 재실행을 막습니다.
   * 재시도는 같은 시도와 초안을 유지하며, 이미 전송된 가능성이 있으면 Enter를 반복하지 않습니다.
   */
  async function performDelivery(target, delivery, evidence) {
    if (busy || seenDeliveries.has(delivery?.id)) return { status: 'uncertain', ...(delivery?.phase==='prepare'?{code:'PREPARE_BUSY'}:{}), error: '중복 전송 요청을 차단했습니다. 채널에서 확인해 주세요.' };
    if (!delivery?.id || typeof delivery.text !== 'string' || !delivery.text.trim() || delivery.text.length > 2000) return { status: 'blocked', error: '전송할 문구가 올바르지 않습니다.' };
    busy = true;
    const operation=activeOperation={id:delivery.id,sessionId:delivery.sessionId,cancelled:false,cancel:null};
    let entered = false;
    let watcher, originalEditor, priorAcknowledgedId;
    const trace = (stage, extra = {}) => {
      try { return reportTrace(delivery, stage, {...traceSnapshot(target, delivery.text, originalEditor), ...extra}); } catch {}
    };
    trace('received');
    try {
      if (!target.skipConfirmation && Number.isFinite(target.lastSentAt) && target.lastSentAt > 0) {
        const previous = reconcile(target, {...delivery,startedAt:target.lastSentAt + 1});
        trace('prior-post-check',{result:previous.status,reconciliationReason:previous.reason || 'confirmed',messageId:previous.messageId});
        if(previous.reason==='acknowledged-legacy-post') priorAcknowledgedId=previous.messageId;
        if (previous.status === 'confirmed') {
          trace('prior-post-confirmed', {result:'confirmed',draftAction:previous.draftAction});
          return previous;
        }
        if (['multiple-matches','next-already-posted','foreign-draft'].includes(previous.reason)) return {status:'uncertain',error:'이전 전송 이후 게시 기록과 초안의 순서를 확정할 수 없습니다. 중복 방지를 위해 확인이 필요합니다.'};
      }
      let result = inspectForDelivery(target,delivery);
      if (!result.ok) return { status: 'blocked', ...(result.code?{code:result.code}:{}), error: result.error };
      if(delivery.phase!=='prepare'&&!result.cooldownKnown)return{status:'deferred',code:'COOLDOWN_UNVERIFIED',error:'Discord의 남은 대기 시간을 읽지 못했습니다. 초안을 보존하고 중지합니다.'};
      if (delivery.phase!=='prepare' && delivery.phase!=='commit' && result.cooldownMs > 0) return {status:'deferred',retryAfterMs:result.cooldownMs};
      // 준비 단계는 본문을 바꾸기 전에 승인이 필요합니다. 반면 commit은 이미
      // 준비된 초안을 읽기만 하므로 여기서 승인을 받으면 안정 검사 뒤 다시 받는
      // 최종 승인과 중복됩니다. commit의 승인은 prepareCommit에서 Enter 직전에
      // 한 번 요청하며 중지·계정·채널·초안 검증과 승인 유효기간은 그대로 유지합니다.
      if(delivery.phase!=='commit'){
        evidence.stage='authorize';
        trace('authorization-request');
        const authorization=await requestDeliveryPermission(target,delivery,{type:'DICO_CAN_SEND',id:delivery.id,phase:delivery.phase});
        trace('authorization-response',{authorized:authorization?.allowed===true});
        if(!authorization?.allowed)return{status:'blocked',code:authorization?.code||'AUTHORIZATION_DENIED',error:'전송 예약이 취소되었거나 만료되었습니다.'};
      }
      result = inspectForDelivery(target,delivery);
      if (!result.ok) return { status: 'blocked', ...(result.code?{code:result.code}:{}), error: result.error };
      let editor = editors()[0];
      originalEditor = editor;
      const retryObservation=async()=>{
        let outcome=watcher.retryOutcome();
        while(outcome?.status==='observation-pending'){await deliveryDelay(target,500);await refreshOwnIdentity(target,true);outcome=watcher.retryOutcome();}
        if(!outcome&&watcher.editor!==editor){
          editor=watcher.editor;editor.focus();
          const range=document.createRange();range.selectNodeContents(editor);range.collapse(false);
          const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
        }
        return outcome;
      };
      const prepareCommit=async (retryCount,initialCooldownMs=0)=>{
        const cooldownWait={retryCount,waiting:initialCooldownMs>0,guard:retryCount>0?retryObservation:null,currentEditor:()=>editor};
        for(;;){
          evidence.stage='stable';
          const waiting=await waitForCommitCooldown(target,delivery,editor,trace,cooldownWait);
          if(waiting)return waiting;
          evidence.stage='stable';
          const stabilizingEditor=editor;
          const stable=await stableEditor(target,delivery.text,editor,500,trace,true);
          const afterStable=await cooldownWait.guard?.();if(afterStable)return afterStable;
          if(retryCount>0&&editor!==stabilizingEditor)continue;
          if(!stable)return {status:'blocked',code:'COMMIT_EDITOR_UNSTABLE',error:'전송 직전 입력 상태가 불안정합니다. 초안을 보존하고 중지합니다.'};
          evidence.stage='authorize';
          const authorizationStarted=Date.now(),authorizationMonoStarted=globalThis.performance?.now() ?? authorizationStarted;
          trace('authorization-request');
          const finalAuthorization=await requestDeliveryPermission(target,delivery,{type:'DICO_CAN_SEND',id:delivery.id,phase:'commit',retryCount},cooldownWait.guard);
          trace('authorization-response',{authorized:finalAuthorization?.allowed===true});
          const afterAuthorization=await cooldownWait.guard?.();if(afterAuthorization)return afterAuthorization;
          const authorizationNow=Date.now(),authorizationElapsed=authorizationNow-(finalAuthorization?.requestStartedAt??authorizationStarted);
          const authorizationMonoElapsed=(globalThis.performance?.now() ?? authorizationNow)-(finalAuthorization?.requestMonoStartedAt??authorizationMonoStarted);
          const staleAuthorization=delivery.strictAuthorization && (!Number.isFinite(finalAuthorization?.authorizedAt) || authorizationElapsed<0 || authorizationElapsed>2000 || authorizationMonoElapsed<0 || authorizationMonoElapsed>2000 || Math.abs(authorizationElapsed-authorizationMonoElapsed)>1000 || authorizationNow-finalAuthorization.authorizedAt<0 || authorizationNow-finalAuthorization.authorizedAt>2000);
          if(finalAuthorization?.outcome)return finalAuthorization.outcome;
          if(staleAuthorization&&finalAuthorization?.allowed&&managedTiming(target)){await deliveryDelay(target,500);continue;}
          if (!finalAuthorization?.allowed || staleAuthorization) return {status:'blocked',code:finalAuthorization?.code||(staleAuthorization?'AUTHORIZATION_EXPIRED':'AUTHORIZATION_DENIED'),error:'전송 준비 후 중지 또는 지연된 승인 응답을 확인했습니다.'};
          const finalCooldown=slowmode(editor);
          if(!finalCooldown.cooldownKnown)return{status:'deferred',code:'COOLDOWN_UNVERIFIED',draftPrepared:true,error:'최종 승인 후 대기 시간을 확인하지 못했습니다. 초안을 보존합니다.'};
          if(finalCooldown.cooldownMs>0)continue;
          break;
        }
        return null;
      };
      if (delivery.phase==='commit') {
        if (!Number.isFinite(delivery.scheduledAt) || Date.now()<delivery.scheduledAt) return {status:'blocked',error:'아직 전송 예약 시각이 아닙니다.'};
        if (!composerMatches(editor,delivery.text)) return {status:'blocked',error:'준비한 문구가 변경되었습니다. 입력창을 보존하고 중지합니다.'};
        editor.focus();
        const selection=window.getSelection(), range=document.createRange();
        range.selectNodeContents(editor);range.collapse(false);selection.removeAllRanges();selection.addRange(range);
        const commitReady=await prepareCommit(0);if(commitReady)return commitReady;
        trace('prepared-verified');
      } else {
        evidence.stage='prepare';
        editor.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        selection.removeAllRanges();
        selection.addRange(range);
        // Let Slate observe focus/selection before delivering a paste event.
        // Native DOM insertion can leave visible text outside Slate's model.
        await deliveryDelay(target,100);
        result = inspectForDelivery(target,delivery);
        if (!result.ok) return { status: 'blocked', ...(result.code?{code:result.code}:{}), error: result.error };
        if (!(await requestInputAuthorization(target,{ type: 'DICO_CAN_SEND', id: delivery.id, phase:delivery.phase }))?.allowed) {
          return { status: 'blocked', error: '문구 입력 전에 예약이 취소되었습니다.' };
        }
        assertOperationActive();
        const live = editors()[0];
        if (live !== editor) return {status:'blocked',error:'입력창이 교체되었습니다. 다음 시작 때 다시 확인해 주세요.'};
        result=inspectForDelivery(target,delivery);
        if(!result.ok)return{status:'blocked',...(result.code?{code:result.code}:{}),error:result.error};
        const reuseDraft = composerMatches(editor,delivery.text);
        trace(reuseDraft ? 'draft-reused' : 'draft-replaced');
        if (reuseDraft) {
          const range = document.createRange();
          range.selectNodeContents(editor);
          range.collapse(false);
          selection.removeAllRanges(); selection.addRange(range);
        } else {
          // Authorization may yield while the user moves the cursor. After the
          // final CAS check, select the current whole draft without another await.
          const range=document.createRange();range.selectNodeContents(editor);
          selection.removeAllRanges();selection.addRange(range);
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
          evidence.stage='stable';
          if (!await stableEditor(target,delivery.text,editor,1000,trace,target.managed===true)) return {status:'blocked',code:'PREPARE_EDITOR_UNSTABLE',error:
            editorContent(editor).unsupported ? '입력창에 해석하지 못한 요소가 있습니다. 초안을 보존하고 중지합니다. 진단 로그를 확인해 주세요.' :
            !composerMatches(editor,delivery.text) ? '설정 문구와 입력창 내용이 다릅니다. 이모지 표현을 비교한 뒤에도 불일치하여 초안을 보존하고 중지합니다.' :
            '문구는 일치하지만 커서·포커스·조합 입력 상태가 안정되지 않았습니다. 초안을 보존하고 중지합니다.'};
        } else await deliveryDelay(target,150);
        trace('after-paste', {pastePrevented:paste.defaultPrevented});
        const currentEditors = editors();
        if (currentEditors.length !== 1 || !composerMatches(currentEditors[0],delivery.text)) {
          return { status: 'uncertain', error: 'Discord 편집기에 문구가 반영되지 않았습니다. 페이지를 새로고침하고 남은 초안을 확인해 주세요.' };
        }
        editor = currentEditors[0];
        if (!matchesTarget(target)) return { status: 'uncertain', error: '문구 입력 중 채널이 변경되었습니다. 초안을 확인해 주세요.' };
        if (!(await requestInputAuthorization(target,{ type: 'DICO_CAN_SEND', id: delivery.id, phase:delivery.phase }))?.allowed) {
          return { status: 'uncertain', error: '문구 입력 후 예약이 취소되었습니다. 남은 초안을 확인해 주세요.' };
        }
        if (!matchesTarget(target) || !editor.isConnected || !composerMatches(editor,delivery.text)) {
          return { status: 'uncertain', error: '전송 직전에 채널이나 입력 내용이 변경되었습니다. 초안을 확인해 주세요.' };
        }

        if(delivery.phase==='prepare') {
          trace('prepared', {result:'prepared'});
          return {status:'prepared',priorAcknowledgedId};
        }
      }
      let retryCount=0,enterAt,enterMono;
      const afterEnter=outcome=>evidence.enterAttempted&&['blocked','deferred'].includes(outcome.status)?{...outcome,status:'uncertain'}:outcome;
      const finishOutcome=outcome=>{
        // A stop or revoked retry can return outside watcher.promise. Keep the
        // observations already made instead of erasing the reason for stopping.
        if(watcher)outcome={...outcome,deliveryEvidence:{...watcher.snapshot(),...outcome.deliveryEvidence}};
        if(outcome.status==='confirmed'){
          const confirmedAt=Date.now(),confirmationMs=(globalThis.performance?.now() ?? confirmedAt)-enterMono;
          outcome.timing={enterAt,confirmedAt,confirmationMs,cooldownMs:slowmode(editors()[0]).cooldownMs};
          const createdAt=/^\d{17,20}$/.test(outcome.messageId||'')?Number((BigInt(outcome.messageId)>>22n)+1420070400000n):0;
          // A late receipt for an earlier retry has no reliable last-Enter
          // anchor, so it confirms delivery without calibrating its duration.
          if(createdAt>=enterAt||outcome.confirmationBasis==='composer_cleared'&&retryCount===0)observeCooldown(target,delivery,enterAt,enterMono);
        }
        const result=afterEnter(outcome);
        trace('finished',{result:result.status,code:result.code,retryCount});
        return result;
      };
      for(;;){
        if(retryCount>0){
          let observed=await retryObservation();if(observed)return finishOutcome(observed);
          const retryStarted=Date.now(),initialCooldownMs=slowmode(editor).cooldownMs;
          const permission=await requestDeliveryPermission(target,delivery,{type:'DICO_RETRY_WAIT',id:delivery.id,phase:'commit',retryCount,cooldownMs:initialCooldownMs,elapsedMs:0},retryObservation);
          observed=await retryObservation();if(observed)return finishOutcome(observed);
          if(permission?.allowed!==true)return finishOutcome({status:'uncertain',code:permission?.code||'RETRY_CANCELLED',error:'재시도 권한이 취소되어 남은 초안을 보존합니다.'});
          // 같은 초안이 세 번 이상 남고 화면 쿨다운이 0이면, 장기 반복 징후로 기록합니다.
          // 실제 대기가 보이면 그 대기만 사용합니다. 관찰 중에는 새 Enter 권한을 발급받지 않습니다.
          const retryCooldown=slowmode(editor);
          const retryBackoffMs=managedTiming(target)&&retryCount>=3&&retryCooldown.cooldownKnown&&retryCooldown.cooldownMs===0?500:0;
          trace('retry-wait',{retryCount,maxSendRetries:evidence.maxSendRetries,retryBackoffMs,retryPermitMs:Date.now()-retryStarted,code:'DELIVERY_DRAFT_RETAINED'});
          if(retryBackoffMs>0){
            await deliveryDelay(target,retryBackoffMs);
            observed=await retryObservation();
            if(observed)return finishOutcome(observed);
          }
          const ready=await prepareCommit(retryCount,initialCooldownMs);if(ready)return finishOutcome(ready);
          observed=await retryObservation();if(observed)return finishOutcome(observed);
        }
        const finalSelection=window.getSelection();
        if (!coordinatedAccountMatches(target) || !matchesTarget(target) || editors()[0]!==editor || !editor.isConnected || composing || document.activeElement!==editor || !finalSelection?.isCollapsed || !editor.contains(finalSelection.anchorNode) || !editor.contains(finalSelection.focusNode) || !composerMatches(editor,delivery.text)) return afterEnter({status:'blocked',error:'Enter 직전 계정 또는 입력창 상태가 변경되었습니다. 초안을 보존하고 중지합니다.'});
        const cooldown = slowmode(editor);
        if(!cooldown.cooldownKnown)return afterEnter({status:'deferred',code:'COOLDOWN_UNVERIFIED',error:'Enter 직전 Discord의 남은 대기 시간을 확인하지 못했습니다. 초안을 보존하고 중지합니다.'});
        if (cooldown.cooldownMs > 0) {
          trace('slowmode-wait', cooldown);
          return afterEnter({status:'deferred',retryAfterMs:cooldown.cooldownMs,draftPrepared:true});
        }
        cooldownProbeCancel?.();
        enterAt=Date.now();enterMono=globalThis.performance?.now() ?? enterAt;
        assertOperationActive();
        if(!watcher)watcher = watchMessage(editor, delivery.text, ownUserId(target), enterAt, observation => trace('observation', observation),target.skipConfirmation,evidence.maxSendRetries===null||evidence.maxSendRetries>0,managedTiming(target),target.coordinated&&delivery.phase==='commit'?target:null,()=>requestDeliveryPermission(target,delivery,{type:'DICO_OBSERVE_WAIT',id:delivery.id,phase:'commit',retryCount,elapsedMs:Math.max(0,Date.now()-enterAt)}));
        else if(!watcher.rearm())return finishOutcome(watcher.retryOutcome());
        // 같은 계정·채널의 최근 반복 기록은 다음 발송의 사전 진단에만 사용합니다.
        // 과거 지연만으로 현재 쿨다운이나 최초 Enter 가능 시각을 바꾸지 않습니다.
        const profile=lastManagedRetryProfile,profileAge=profile?Date.now()-profile.at:-1;
        const retryRisk=managedTiming(target)&&retryCount===0&&profile?.path===location.pathname&&
          profile.accountId===target.ownUserId&&profileAge>=0&&profileAge<=RECEIPT_TTL_MS&&
          profile.retryCount>=3&&!cooldown.slowmodeDetected;
        // 화면에 노출된 제출 제한만 기록합니다. 숨은 카운트다운은 대기 시간으로 적용하지 않습니다.
        const submit=editor.closest('form')?.querySelector?.('button[type="submit"], input[type="submit"]');
        trace('before-enter',{
          retryCount,retryRisk,
          editorAriaDisabled:editor.getAttribute?.('aria-disabled')==='true',
          editorAriaReadonly:editor.getAttribute?.('aria-readonly')==='true',
          submitControlPresent:Boolean(submit),
          ...(submit?{submitControlDisabled:submit.disabled===true||submit.getAttribute?.('aria-disabled')==='true'}:{}),
          ...(retryRisk?{priorRetryCount:profile.retryCount}:{}),
        });
        operation.cancel=()=>watcher?.cancel('EXECUTION_STOPPED');
        assertOperationActive();
        const keydown = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed:true, view:window });
        const keyup = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed:true, view:window });
        // The latch records an actual submission attempt, never mere waiting.
        seenDeliveries.add(delivery.id);
        if(seenDeliveries.size>100)seenDeliveries.delete(seenDeliveries.values().next().value);
        evidence.stage='enter';evidence.enterAttempted=true;evidence.retryCount=retryCount;
        evidence.submitMethod='keyboard';
        evidence.documentHidden=document.hidden===true;
        evidence.documentFocused=document.hasFocus()===true;
        const dispatchAt=Date.now();
        const keyRoute={};
        if(target.managed&&typeof document.removeEventListener==='function'){
          // 우리가 만든 Enter 한 건의 전파만 관측합니다. 사용자 키나 이벤트 원문은 기록하지 않습니다.
          keyRoute.keyDownDocumentCapture=false;keyRoute.keyDownDocumentBubble=false;
          const capture=event=>{if(event===keydown)keyRoute.keyDownDocumentCapture=true;};
          const bubble=event=>{if(event===keydown)keyRoute.keyDownDocumentBubble=true;};
          document.addEventListener('keydown',capture,true);
          document.addEventListener('keydown',bubble);
          try{editor.dispatchEvent(keydown);}
          finally{document.removeEventListener('keydown',capture,true);document.removeEventListener('keydown',bubble);}
        }else editor.dispatchEvent(keydown);
        editor.dispatchEvent(keyup);
        evidence.enterDefaultPrevented=keydown.defaultPrevented===true;
        evidence.keyupDefaultPrevented=keyup.defaultPrevented===true;
        trace('enter-dispatched', {
          eventAt:dispatchAt,
          retryCount,
          cooldownMs:cooldown.cooldownMs,
          cooldownKnown:cooldown.cooldownKnown,
          slowmodeDetected:cooldown.slowmodeDetected,
          enterPrevented:keydown.defaultPrevented,
          keyupPrevented:keyup.defaultPrevented,
          ...keyRoute,
        });
        evidence.stage='observe';watcher.submitted();
        const outcome = await watcher.promise;
        const flags=['newMessage','matchingMessage','sendingSeen','failedSeen','authorMismatch','authorUnknown','timeMismatch'];
        if(outcome.status!=='draft-retained'||evidence.maxSendRetries!==null&&retryCount>=evidence.maxSendRetries||outcome.deliveryEvidence?.composerRetained!==true||(target.coordinated?outcome.deliveryEvidence?.sendingSeen===true||outcome.deliveryEvidence?.sendingActive===true||outcome.deliveryEvidence?.ownMessageSeen===true:flags.some(key=>outcome.deliveryEvidence?.[key]!==false)))return finishOutcome(outcome);
        const observed=await retryObservation();if(observed)return finishOutcome(observed);
        retryCount++;
      }
    } catch(error) {
      trace('exception',{code:error?.code,reasonCode:error?.reasonCode,exception:{name:error?.name,message:error?.message,stack:error?.stack}});
      watcher?.cancel();
      return { status: evidence.enterAttempted || (entered&&error?.code!=='EXECUTION_STOPPED') ? 'uncertain' : 'blocked',code:error?.code==='EXECUTION_STOPPED'?'EXECUTION_STOPPED':error?.code==='MANAGED_DELAY_UNAVAILABLE'?'MANAGED_DELAY_UNAVAILABLE':evidence.enterAttempted?'CONTENT_EXCEPTION_AFTER_ENTER':'CONTENT_EXCEPTION_BEFORE_ENTER', error: 'Discord 입력창에 연결하지 못했습니다. 채널과 남은 초안을 확인해 주세요.' };
    } finally { watcher?.stop();if(activeOperation===operation)activeOperation=null;busy = false; }
  }
  /**
   * 확장이 보내는 검사·준비·발송·영수증 조회 요청의 입구입니다.
   * 비동기 응답은 respond로 돌려주며, 각 요청의 실제 처리는 위 함수들로 분리합니다.
   */
  const messageListener=(message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if(message?.type==='DICO_CANCEL_DELIVERY'){
      const matches=Boolean(activeOperation&&message.delivery?.id===activeOperation.id&&message.delivery?.sessionId===activeOperation.sessionId);
      if(matches){activeOperation.cancelled=true;activeOperation.cancel?.();}
      respond({cancelRequested:matches});return false;
    }
    if(message?.type==='DICO_CONTENT_STATUS'){respond({buildId:CONTENT_BUILD_ID,busy});return false;}
    if(message?.type==='DICO_CONTENT_DISPOSE'){respond({disposed:globalThis.__dicoWhileLifecycle.dispose()});return false;}
    if(message?.type==='DICO_DELIVERY_RECEIPT'){
      void refreshOwnIdentity(message.target,true).then(()=>{
        const {target,delivery}=message,receipt=completedDeliveries.get(delivery?.id),elapsed=receipt?Date.now()-receipt.at:-1,found=editors();
        const valid=Boolean(receipt&&elapsed>=0&&elapsed<=RECEIPT_TTL_MS&&target?.coordinated===true&&delivery?.phase==='commit'&&delivery.text===receipt.text&&delivery.startedAt===receipt.startedAt&&delivery.sessionId===receipt.sessionId&&target.ownUserId===receipt.accountId&&target.guildId===receipt.guildId&&target.channelId===receipt.channelId&&location.pathname===receipt.path&&matchesTarget(target)&&coordinatedAccountMatches(target)&&found.length===1&&found[0]===receipt.editor&&receipt.editor?.isConnected);
        if(receipt&&elapsed>RECEIPT_TTL_MS)completedDeliveries.delete(delivery.id);
        respond(valid?receipt.result:{status:'uncertain',code:'DELIVERY_RECEIPT_UNAVAILABLE'});
      }).catch(()=>respond({status:'uncertain',code:'DELIVERY_RECEIPT_UNAVAILABLE'}));return true;
    }
    if (message?.type === 'DICO_RECONCILE') {
      void refreshOwnIdentity(message.target).then(()=>{const result=reconcile(message.target,message.delivery,message.recoveryWindow);reportTrace(message.delivery,'reconcile',{result:result.status,draftAction:result.draftAction});respond(result);}).catch(()=>respond({status:'uncertain',code:'ACCOUNT_UNREADABLE'}));return true;
    }
    if (message?.type === 'DICO_CHANNEL_LIMIT') { refreshOwnIdentity(message.target).then(()=>detectSlowmodeSetting(message.target)).then(slowmodeSeconds=>respond({slowmodeSeconds})).catch(()=>respond({slowmodeSeconds:null})); return true; }
    if(message?.type==='DICO_DRAFT_INSPECT'){void refreshOwnIdentity(message.target).then(()=>respond(inspectManagedDraft(message.target,message.delivery))).catch(()=>respond({status:'blocked',code:'ACCOUNT_UNREADABLE'}));return true;}
    if (message?.type === 'DICO_INSPECT') { refreshOwnIdentity(message.target).then(()=>detectSlowmodeSetting(message.target)).catch(()=>null).then(()=>refreshOwnIdentity(message.target)).then(()=>{const result=inspect(message.target),found=editors();const draftMatches=result.ok===true&&found.length===1&&typeof message.target?.expectedText==='string'&&composerMatches(found[0],message.target.expectedText);respond({...result,draftMatches,diagnostics:{...traceSnapshot(message.target,message.target.expectedText || ''),contentVersion:CONTENT_VERSION}});}).catch(()=>respond({ok:false,code:'ACCOUNT_UNREADABLE'})); return true; }
    if (message?.type === 'DICO_PREPARE') { deliver(message.target,{...message.delivery,phase:'prepare'}).then(respond); return true; }
    if (message?.type === 'DICO_DELIVER') { deliver(message.target, message.delivery).then(respond); return true; }
    return false;
  };
  const lifecycle={
    isCurrent(){try{return Boolean(loadedRuntime?.id)&&loadedRuntime.id===chrome.runtime.id;}catch{return false;}},
    dispose(){
      if(busy)return false;
      cooldownProbeCancel?.();ownIdentityProof=null;completedDeliveries.clear();
      try{loadedRuntime?.onMessage.removeListener?.(messageListener);}catch{}
      document.removeEventListener?.('compositionstart',compositionStart,true);
      document.removeEventListener?.('compositionend',compositionEnd,true);
      if(globalThis.__dicoWhileLifecycle===lifecycle){delete globalThis.__dicoWhileLoaded;delete globalThis.__dicoWhileLifecycle;}
      return true;
    }
  };
  globalThis.__dicoWhileLifecycle=lifecycle;
  chrome.runtime.onMessage.addListener(messageListener);
})();
