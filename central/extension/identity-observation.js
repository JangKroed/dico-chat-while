// Self-contained for chrome.scripting MAIN-world injection. Only the own-account
// panel's DOM and bounded component props are read; never stores, auth or APIs.
export function pageIdentityObservation() {
  if(location.origin!=='https://discord.com')return {verified:false,reason:'NOT_DISCORD'};
  const match=location.pathname.match(/^\/channels\/(\d+)\/(\d+)(?:\/\d+)?\/?$/);
  const base={guildId:match?.[1]||null,channelId:match?.[2]||null,name:document.title};
  const panel=document.querySelector('section[class*="panels"], div[class*="panels"], section[aria-label="User area"], section[aria-label="사용자 영역"]');
  if(!panel)return{...base,verified:false,reason:'ACCOUNT_PANEL_MISSING'};
  const select=(scope,selector)=>scope?.querySelector?.(selector)||null;
  const all=(scope,selector)=>[...(scope?.querySelectorAll?.(selector)||[])].slice(0,40);
  const clean=value=>typeof value==='string'?value.replace(/[\u200b-\u200d\ufeff]/g,'').trim().slice(0,100):'';
  const value=(object,key)=>{try{return Object.getOwnPropertyDescriptor(object,key)?.value;}catch{return undefined;}};
  const snowflake=id=>typeof id==='string'&&/^\d{17,20}$/.test(id);
  const accountRoot=select(panel,'[class*="accountPopoutButtonWrapper"]')||select(panel,'[class*="nameTag"]')?.parentElement||panel;
  const title=select(accountRoot,'[class*="panelTitleContainer"], [class*="displayName"], [data-display-name]');
  const accountName=clean(title?.textContent);
  const usernameNodes=all(accountRoot,'[class*="username"], [class*="userTag"], [class*="hovered"], [data-username], [class*="panelSubtextContainer"] *');
  const names=new Set(usernameNodes.map(node=>clean(node.getAttribute?.('data-username')||node.textContent)).filter(Boolean));
  const usernameVisible=name=>names.has(name)||names.has('@'+name);
  // Discord's own name tag renders userTag first in the subtext (including
  // its unhovered, CSS-hidden branch), followed by status text. Do not confuse
  // status/custom activity strings with an authoritative username.
  const subtext=select(accountRoot,'[class*="panelSubtextContainer"]');
  const firstSubtext=all(subtext,'*').find(node=>!node.childElementCount&&clean(node.textContent))||subtext;
  const usernameLabels=[...all(accountRoot,'[class*="username"], [class*="userTag"], [data-username]'),firstSubtext].filter(Boolean)
    .map(node=>clean(node.getAttribute?.('data-username')||node.textContent).replace(/^@/,''))
    .filter(name=>/^[a-z0-9_.]{2,32}$/.test(name));
  const usernameConflicts=name=>usernameLabels.some(label=>label!==name);
  const ids=new Set(),candidates=[];let defaultAvatar=false;
  const add=id=>{if(snowflake(id))ids.add(id);};
  for(const node of [accountRoot,...all(accountRoot,'[data-user-id], [data-author-id]')]){
    add(node.getAttribute?.('data-user-id'));add(node.getAttribute?.('data-author-id'));
  }
  for(const link of all(accountRoot,'a[href]')){
    try{const url=new URL(link.getAttribute('href'),location.origin);if(url.origin===location.origin)add(url.pathname.match(/^\/users\/(\d{17,20})\/?$/)?.[1]);}catch{}
  }
  for(const img of all(accountRoot,'img')){
    const src=img.getAttribute('src')||'',found=src.match(/\/(?:avatars\/(\d{17,20})|users\/(\d{17,20})\/avatars)\//);
    if(found)add(found[1]||found[2]);if(/\/embed\/avatars\//.test(src))defaultAvatar=true;
  }
  // Public Discord account-panel code passes currentUser to the component
  // rendering accountPopoutButtonWrapper and panelTitleContainer. The default
  // avatar contains no ID. Read only those explicit user props near that root.
  // Generic user props require the unique username in the own-panel DOM; a
  // display-name match alone is accepted only for explicit currentUser props.
  const consider=props=>{
    if(!props||typeof props!=='object')return;
    for(const key of ['currentUser','user']){
      const user=value(props,key);if(!user||typeof user!=='object')continue;
      const id=value(user,'id'),username=clean(value(user,'username')),display=clean(value(user,'globalName')||value(user,'global_name'));
      if(!snowflake(id)||!username||usernameConflicts(username))continue;
      const visible=usernameVisible(username);
      const explicit=key==='currentUser'&&accountRoot!==panel&&accountName&&(accountName===display||accountName===username);
      if(!visible&&!explicit)continue;
      add(id);candidates.push({id,username,accountName:accountName||display||username,identitySource:explicit?'own-panel-current-user':'own-panel-user'});
    }
  };
  if(accountRoot!==panel){
    const nodes=[accountRoot,select(accountRoot,'[class*="nameTag"]'),select(accountRoot,'img')].filter(Boolean);
    for(const node of nodes){
      let keys;try{keys=Object.keys(node).filter(key=>key.startsWith('__reactProps$')||key.startsWith('__reactFiber$')).slice(0,4);}catch{continue;}
      for(const key of keys){
        const attached=value(node,key);
        if(key.startsWith('__reactProps$')){consider(attached);continue;}
        let fiber=attached;const visited=new Set();
        for(let depth=0;fiber&&depth<12&&!visited.has(fiber);depth++){
          visited.add(fiber);const host=value(fiber,'stateNode');
          if(host?.nodeType===1&&host!==accountRoot&&!accountRoot.contains?.(host))break;
          consider(value(fiber,'memoizedProps'));
          fiber=value(fiber,'return');
        }
      }
    }
  }
  if(ids.size!==1)return{...base,verified:false,reason:ids.size>1?'ACCOUNT_ID_CONFLICT':defaultAvatar?'DEFAULT_AVATAR':'ACCOUNT_UNREADABLE'};
  const accountId=[...ids][0],profile=candidates.find(candidate=>candidate.id===accountId);
  const username=profile?.username||usernameLabels[0];
  return{...base,accountId,verified:true,identitySource:profile?.identitySource||'own-panel-dom',...(accountName||profile?.accountName?{accountName:accountName||profile.accountName}:{}),...(username?{username}:{})};
}
export function accountIdentityMetadata(seen){
  if(seen?.verified!==true)return{};
  return Object.fromEntries(['accountName','username'].filter(key=>typeof seen[key]==='string'&&seen[key].trim()).map(key=>[key,seen[key].trim().slice(0,100)]));
}
export function identityFailureMessage(seen) {
  return {NOT_DISCORD:'Discord 웹에서 로그인한 뒤 다시 눌러 주세요.',ACCOUNT_PANEL_MISSING:'왼쪽 아래 내 프로필 영역을 찾지 못했습니다. Discord 화면 로딩을 기다린 뒤 다시 확인하세요.',DEFAULT_AVATAR:'내 프로필에서 계정 정보를 아직 확인하지 못했습니다. Discord 화면 로딩 후 다시 등록해 주세요. 기본 아바타도 사용할 수 있습니다.',ACCOUNT_ID_CONFLICT:'내 프로필의 계정 정보가 서로 다릅니다. 계정 전환이 끝난 뒤 다시 확인하세요.',ACCOUNT_UNREADABLE:'내 프로필에서 계정 ID를 확인하지 못했습니다. 로그인 상태와 Discord 화면을 확인하세요.',SCRIPT_UNAVAILABLE:'Discord 화면을 읽지 못했습니다. Discord 탭을 새로고침한 뒤 확장 접근 권한을 확인하세요.'}[seen?.reason]||'Discord 로그인 계정을 확인하지 못했습니다. 화면을 새로고침한 뒤 다시 확인하세요.';
}
