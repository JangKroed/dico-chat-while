import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {currentRegistration} from '../central/extension/registration-state.js';
const source=readFileSync(new URL('../central/extension/background.js',import.meta.url),'utf8');
const target={accountId:'123456789012345678',guildId:'111',channelId:'222'};
function rig({seen={...target,verified:true},busy=false,attempts={},records=[]}={}){
 const state={sessionId:'s',resetEpoch:0,legacyDeclaration:true,attempts},saved={dicoCentralTabs:records},calls=[];
 const tab={id:7,windowId:8,url:'https://discord.com/channels/111/222'};
 const scope={URL,executor:{state},transport:{connected:true},currentRegistration,currentAccount:async()=>true,observe:async()=>seen,observation:async()=>{},setTimeout:fn=>fn(),chrome:{storage:{local:{get:async()=>structuredClone(saved),set:async data=>Object.assign(saved,structuredClone(data))}},tabs:{query:async()=>[tab],get:async()=>tab,sendMessage:async()=>({busy}),remove:async()=>calls.push('remove')}},createManagedWindow:async()=>{calls.push('create');return{id:10,tabs:[{id:9}]};}};
 runInNewContext(source.slice(source.indexOf('function openManagedChannel('),source.indexOf('async function bindActive('))+'\nlet channelOpening=Promise.resolve();globalThis.openTest=openManagedChannel;',scope);
 return{state,saved,calls,scope,open:()=>scope.openTest(target)};
}
test('channel connection adopts a verified open tab without creating a window',async()=>{
 const r=rig();assert.equal((await r.open()).reused,true);assert.deepEqual(r.calls,[]);
 assert.equal(r.saved.dicoCentralTabs[0].tabId,7);assert.equal(r.saved.dicoCentralTabs[0].ownership,'adopted');
});
test('concurrent requests reuse the same tab and retain one registration',async()=>{
 const r=rig();await Promise.all([r.open(),r.open()]);assert.deepEqual(r.calls,[]);assert.equal(r.saved.dicoCentralTabs.length,1);
});
test('busy or unresolved existing tabs block adoption and duplicate creation',async()=>{
 for(const options of [{busy:true},{attempts:{a:{tabId:7,phase:'unknown'}}}]){const r=rig(options);await assert.rejects(r.open(),{code:'ATTEMPT_UNRESOLVED'});assert.deepEqual(r.calls,[]);assert.deepEqual(r.saved.dicoCentralTabs,[]);}
});
test('wrong account and unverified pages are never adopted',async()=>{
 for(const seen of [{...target,verified:false},{...target,verified:true,accountId:'987654321098765432'}]){const r=rig({seen});await assert.rejects(r.open(),{code:'CHANNEL_NOT_READY'});assert.deepEqual(r.calls,['create']);assert.equal(r.saved.dicoCentralTabs[0].tabId,9);}
});
test('reset during live identity read cancels registration and tab creation',async()=>{
 const r=rig();r.scope.observe=async()=>{r.state.resetEpoch++;return{...target,verified:true};};
 await assert.rejects(r.open(),{code:'STALE_SESSION'});assert.deepEqual(r.calls,[]);assert.deepEqual(r.saved.dicoCentralTabs,[]);
});
test('navigation during identity observation prevents adopting the old URL',async()=>{
 const r=rig();r.scope.chrome.tabs.get=async()=>({id:7,windowId:8,url:'https://discord.com/channels/111/999'});
 await r.open();assert.deepEqual(r.calls,['create']);assert.equal(r.saved.dicoCentralTabs[0].tabId,9);
});
test('이동한 기존 탭은 보존하고 다른 검증된 탭을 재사용한다',async()=>{
 const r=rig({records:[{...target,tabId:7,windowId:8}]}),replacement={id:12,windowId:13,url:'https://discord.com/channels/111/222'};
 r.scope.observe=async id=>({...target,channelId:id===7?'999':'222',verified:true});
 r.scope.chrome.tabs.get=async id=>id===7?{id:7,windowId:8,url:'https://discord.com/channels/111/999'}:replacement;
 r.scope.chrome.tabs.query=async()=>[replacement];
 const result=await r.scope.openTest({...target,recovery:true});assert.equal(result.reused,true);assert.deepEqual(r.calls,[]);assert.equal(r.saved.dicoCentralTabs[0].tabId,12);
});
test('tab adoption uses only read-only content status and preserves a user draft',async()=>{
 const r=rig(),messages=[];let draft='사용자가 작성 중인 초안';
 r.scope.chrome.tabs.sendMessage=async(_id,message)=>{messages.push(message.type);if(message.type!=='DICO_CONTENT_STATUS')draft='';return{busy:false};};
 await r.open();assert.deepEqual(messages,['DICO_CONTENT_STATUS']);assert.equal(draft,'사용자가 작성 중인 초안');
});
test('a queued request from the old reset generation cannot create or register a tab',async()=>{
 const r=rig(),pending=r.open();r.state.resetEpoch++;
 await assert.rejects(pending,{code:'STALE_SESSION'});assert.deepEqual(r.calls,[]);assert.deepEqual(r.saved.dicoCentralTabs,[]);
});
test('an unresolved attempt for a missing target tab blocks replacement creation',async()=>{
 const r=rig({attempts:{a:{...target,tabId:99,phase:'needs_review'}}});r.scope.chrome.tabs.query=async()=>[];
 await assert.rejects(r.open(),{code:'ATTEMPT_UNRESOLVED'});assert.deepEqual(r.calls,[]);
});
test('adopted ownership survives registration filtering and subsequent channel storage writes',async()=>{
 const adopted={...target,tabId:44,windowId:45,channelId:'333',resetEpoch:0,ownership:'adopted'};
 const r=rig({records:[adopted]});await r.open();
 assert.equal(currentRegistration(r.saved,0).dicoCentralTabs.find(record=>record.tabId===44).ownership,'adopted');
 assert.equal(currentRegistration(r.saved,0).dicoCentralTabs.find(record=>record.tabId===7).ownership,'adopted');
});
test('recovery replaces a closed adopted tab with a newly owned managed tab when no open match exists',async()=>{
 const r=rig({records:[{...target,tabId:7,windowId:8,ownership:'adopted'}]});
 r.scope.observe=async tabId=>tabId===7?{verified:false}:{...target,verified:true};
 r.scope.chrome.tabs.get=async()=>{throw Error('closed');};r.scope.chrome.tabs.query=async()=>[];
 await r.scope.openTest({...target,recovery:true});assert.deepEqual(r.calls,['create']);
 assert.equal(r.saved.dicoCentralTabs.length,1);assert.equal(r.saved.dicoCentralTabs[0].tabId,9);assert.equal(r.saved.dicoCentralTabs[0].ownership,undefined);
});
test('recovery of a closed adopted tab prefers another verified user tab before creating a window',async()=>{
 const r=rig({records:[{...target,tabId:7,windowId:8,ownership:'adopted'}]}),replacement={id:12,windowId:13,url:'https://discord.com/channels/111/222'};
 r.scope.observe=async tabId=>tabId===7?{verified:false}:{...target,verified:true};
 r.scope.chrome.tabs.get=async tabId=>{if(tabId===7)throw Error('closed');return replacement;};r.scope.chrome.tabs.query=async()=>[replacement];
 assert.equal((await r.scope.openTest({...target,recovery:true})).reused,true);assert.deepEqual(r.calls,[]);
 assert.equal(r.saved.dicoCentralTabs.length,1);assert.equal(r.saved.dicoCentralTabs[0].tabId,12);assert.equal(r.saved.dicoCentralTabs[0].ownership,'adopted');
});
test('같은 목적지의 일시 미검증 탭은 중복 생성하지 않는다',async()=>{
 const r=rig({records:[{...target,tabId:7,windowId:8}],seen:{verified:false}});
 await assert.rejects(r.scope.openTest({...target,recovery:true}),{code:'ACCOUNT_UNVERIFIED'});
 assert.deepEqual(r.calls,[]);assert.equal(r.saved.dicoCentralTabs[0].tabId,7);
});
test('재탐색 도중 세션이 바뀌면 새 탭을 만들지 않는다',async()=>{
 const r=rig({records:[{...target,tabId:7,windowId:8}],seen:{verified:false}});
 r.scope.chrome.tabs.get=async()=>{r.state.sessionId='new';return{id:7,url:'https://example.com'};};
 await assert.rejects(r.scope.openTest({...target,recovery:true}),{code:'STALE_SESSION'});assert.deepEqual(r.calls,[]);
});
