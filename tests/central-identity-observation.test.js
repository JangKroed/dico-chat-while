import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {pageIdentityObservation} from '../central/extension/identity-observation.js';
function read({path='/channels/@me',src='https://cdn.discordapp.com/avatars/123456789012345678/hash.png',panel=true}={}){
 const context={location:{origin:'https://discord.com',pathname:path},document:{title:'Discord',querySelector:()=>panel?{querySelectorAll:()=>[{getAttribute:()=>src}]}:null}};
 return vm.runInNewContext(`(${pageIdentityObservation.toString()})()`,context);
}
test('계정 등록은 친구 목록에서도 동작하고 채널 연결을 만들지 않는다',()=>{
 const result=read();assert.equal(result.verified,true);assert.equal(result.accountId,'123456789012345678');assert.equal(result.channelId,null);assert.equal(result.guildId,null);
});
test('서버 채널에서는 계정과 대상 정보를 분리해 관측한다',()=>{
 const result=read({path:'/channels/111111111111111111/222222222222222222'});assert.equal(result.channelId,'222222222222222222');assert.equal(result.accountId,'123456789012345678');
});
test('기본 아바타와 계정 영역 부재는 구체적인 사유와 함께 미검증으로 남긴다',()=>{
 assert.equal(read({src:'https://cdn.discordapp.com/embed/avatars/0.png'}).reason,'DEFAULT_AVATAR');
 assert.equal(read({panel:false}).reason,'ACCOUNT_PANEL_MISSING');
});

function ownPanel({id='123456789012345678',username='hoya',display='호야',domUsername=username,field='currentUser',profile=null,avatar='/embed/avatars/0.png',extra=null}={}){
 const attrs=values=>({getAttribute:key=>values[key]??null});
 const image=attrs({src:avatar}),title={textContent:display},tag={textContent:domUsername,childElementCount:0,...attrs({})};
 const subtext=domUsername?{textContent:domUsername+'온라인',querySelectorAll:()=>[tag,{textContent:'온라인',childElementCount:0}]}:null;
 const root={nodeType:1,...attrs({}),contains:node=>node===image||node===root,
  querySelector:selector=>selector.includes('panelTitleContainer')?title:selector.includes('panelSubtextContainer')?subtext:selector==='img'?image:null,
  querySelectorAll:selector=>selector==='img'?[image]:selector==='a[href]'&&profile?[attrs({href:profile})]:selector.includes('username')?(domUsername?[tag]:[]):[]};
 root.__reactFiber$own={memoizedProps:{[field]:{id,username,globalName:display}},stateNode:root,return:extra};
 const panel={querySelector:selector=>selector.includes('accountPopoutButtonWrapper')?root:null};
 return{root,panel,read:()=>vm.runInNewContext(`(${pageIdentityObservation.toString()})()`,{URL,location:{origin:'https://discord.com',pathname:'/channels/111/222'},document:{title:'Channel name must not become account name',querySelector:()=>panel}})};
}
test('기본 아바타는 MAIN의 내 계정 currentUser와 화면 이름으로 ID·닉네임을 읽는다',()=>{
 const r=ownPanel({domUsername:''}),result=r.read();assert.equal(result.verified,true);assert.equal(result.accountId,'123456789012345678');assert.equal(result.accountName,'호야');assert.equal(result.username,'hoya');assert.equal(result.identitySource,'own-panel-current-user');
});
test('숨겨진 userTag textContent는 기본 아바타의 고유 사용자명을 검증한다',()=>{
 const r=ownPanel({field:'user'});assert.equal(r.read().verified,true);
});
test('동일 표시명이어도 실제 사용자명과 오래된 props가 다르면 거부한다',()=>{
 for(const field of ['user','currentUser'])assert.equal(ownPanel({field,domUsername:'new_account'}).read().verified,false);
});
test('일반 user props는 표시명만 같아도 내 계정으로 사용하지 않는다',()=>{
 assert.equal(ownPanel({field:'user',domUsername:''}).read().verified,false);
});
test('내 패널의 DOM·props 계정 ID가 충돌하면 검증하지 않는다',()=>{
 assert.equal(ownPanel({profile:'/users/987654321098765432'}).read().reason,'ACCOUNT_ID_CONFLICT');
 assert.equal(ownPanel({avatar:'/avatars/987654321098765432/a.png'}).read().reason,'ACCOUNT_ID_CONFLICT');
});
test('기본 아바타 자체의 숫자는 계정 ID로 쓰지 않고 명시적 내 프로필 링크를 허용한다',()=>{
 const r=ownPanel({profile:'/users/123456789012345678'});delete r.root.__reactFiber$own;assert.equal(r.read().accountId,'123456789012345678');
 const unreadable=ownPanel();delete unreadable.root.__reactFiber$own;assert.equal(unreadable.read().reason,'DEFAULT_AVATAR');
});
test('React 탐색은 내 계정 루트를 벗어나거나 12단계를 넘는 계정 정보를 읽지 않는다',()=>{
 const other={nodeType:1};const r=ownPanel({extra:{stateNode:other,memoizedProps:{currentUser:{id:'987654321098765432',username:'hoya',globalName:'호야'}}}});assert.equal(r.read().accountId,'123456789012345678');
 const deep=ownPanel();let fiber={memoizedProps:{currentUser:{id:'123456789012345678',username:'hoya',globalName:'호야'}}};for(let i=0;i<12;i++)fiber={return:fiber};deep.root.__reactFiber$own=fiber;assert.equal(deep.read().verified,false);
});
test('계정 관측은 허용한 scalar 값만 반환하고 getter·관련 없는 객체를 읽지 않는다',()=>{
 let accesses=0;const r=ownPanel();const user=r.root.__reactFiber$own.memoizedProps.currentUser;
 Object.defineProperty(user,'token',{get(){accesses++;throw Error('secret');}});Object.defineProperty(user,'email',{get(){accesses++;throw Error('private');}});
 Object.defineProperty(r.root.__reactFiber$own.memoizedProps,'unrelated',{get(){accesses++;throw Error('unrelated');}});
 const result=r.read();assert.equal(result.verified,true);assert.equal(accesses,0);assert.deepEqual(Object.keys(result).sort(),['accountId','accountName','channelId','guildId','identitySource','name','username','verified'].sort());
 Object.defineProperty(user,'id',{get(){accesses++;return'123456789012345678';}});assert.equal(r.read().verified,false);assert.equal(accesses,0);
});
