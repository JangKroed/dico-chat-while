import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagedWindow,createManagedWindowController,ensureSeparateManagedWindow,ensureConsolidatedManagedWindow} from '../central/extension/managed-windows.js';
const target={accountId:'123456789012345678',guildId:'111',channelId:'222',tabId:7};
function fixture({record={...target,windowId:8},tab={id:7,windowId:8,url:'https://discord.com/channels/111/222'},seen={...target,verified:true},otherTabs=[]}={}){
 const calls=[];
 const chrome={storage:{local:{get:async()=>({dicoCentralTabs:record?[record]:[]}),set:async()=>{}}},tabs:{get:async()=>{if(!tab)throw Error('missing');return tab;},update:async(id,update)=>calls.push(['tab',id,update])},windows:{get:async()=>({id:8,type:'normal',tabs:[tab,...otherTabs]}),update:async(id,update)=>calls.push(['window',id,update]),create:async info=>{calls.push(['create',info]);return{id:8,tabs:[tab]};}}};
 return{chrome,calls,manage:createManagedWindowController({chrome,observe:async()=>seen})};
}
test('new dedicated windows start minimized without closing or focusing the browser',async()=>{
 const {chrome,calls}=fixture({record:null});await createManagedWindow(chrome,target);
 assert.deepEqual(calls,[['create',{url:'https://discord.com/channels/111/222',type:'normal',focused:false,state:'minimized'}]]);
});
test('reveal activates only the recorded tab and restores its actual window',async()=>{
 const {manage,calls}=fixture();const result=await manage({...target,action:'reveal'});
 assert.deepEqual(calls,[['tab',7,{active:true}],['window',8,{focused:true,state:'normal'}]]);assert.equal(result.visible,true);
});
test('hide minimizes a dedicated window without closing its tab',async()=>{
 const {manage,calls}=fixture();assert.equal((await manage({...target,action:'hide'})).visible,false);
 assert.deepEqual(calls,[['window',8,{state:'minimized'}]]);
});
test('missing tabs and stale bindings fail without creating, reloading or rebinding',async()=>{
 for(const options of [{tab:null},{record:null},{record:{...target,tabId:99,windowId:8}}]){
  const {manage,calls}=fixture(options);await assert.rejects(manage({...target,action:'reveal'}),{code:'MANAGED_TAB_MISSING'});assert.deepEqual(calls,[]);
 }
});
test('reveal exposes the exact managed tab for troubleshooting even when identity or channel has changed',async()=>{
 for(const options of [{seen:{...target,accountId:'987654321098765432',verified:true}},{seen:{verified:false}},{tab:{id:7,windowId:8,url:'https://discord.com/channels/111/999'}}]){
  const {manage,calls}=fixture(options);assert.equal((await manage({...target,action:'reveal'})).visible,true);assert.equal(calls.length,2);
 }
});
test('reveal refuses a managed tab that navigated outside Discord',async()=>{
 const {manage,calls}=fixture({tab:{id:7,windowId:8,url:'https://example.com'}});await assert.rejects(manage({...target,action:'reveal'}),{code:'TARGET_MISMATCH'});assert.deepEqual(calls,[]);
});
test('hide refuses legacy records, migrated tabs and windows shared with ordinary tabs',async()=>{
 for(const options of [{record:target},{tab:{id:7,windowId:9,url:'https://discord.com/channels/111/222'}},{otherTabs:[{id:99,url:'https://example.com'}]}]){
  const {manage,calls}=fixture(options);await assert.rejects(manage({...target,action:'hide'}),{code:'WINDOW_NOT_DEDICATED'});assert.deepEqual(calls,[]);
 }
});
test('legacy records may be revealed after current target identity is verified',async()=>{
 const {manage,calls}=fixture({record:target});assert.equal((await manage({...target,action:'reveal'})).visible,true);assert.equal(calls.length,2);
});
test('additional channels open inactive tabs in the existing owned window without stealing focus',async()=>{
 const {chrome,calls}=fixture();chrome.storage.local.get=async()=>({dicoCentralTabs:[{...target,windowId:8}],dicoCentralWindowId:8});
 chrome.tabs.create=async info=>{calls.push(['createTab',info]);return{id:9,windowId:8};};
 const result=await createManagedWindow(chrome,{...target,channelId:'333'});
 assert.equal(result.id,8);assert.deepEqual(calls,[['createTab',{windowId:8,active:false,url:'https://discord.com/channels/111/333'}]]);
});
test('hide minimizes a shared window only when every tab is a recorded managed channel',async()=>{
 const {chrome,manage,calls}=fixture({otherTabs:[{id:9,windowId:8,url:'https://discord.com/channels/111/333'}]});
 chrome.storage.local.get=async()=>({dicoCentralTabs:[{...target,windowId:8},{...target,channelId:'333',tabId:9,windowId:8}]});
 await manage({...target,action:'hide'});assert.deepEqual(calls,[['window',8,{state:'minimized'}]]);
});
test('new channel never reuses a managed window contaminated by an ordinary tab',async()=>{
 const {chrome,calls}=fixture({otherTabs:[{id:99,url:'https://example.com'}]});await createManagedWindow(chrome,{...target,channelId:'333'});
 assert.deepEqual(calls,[['create',{url:'https://discord.com/channels/111/333',type:'normal',focused:false,state:'minimized'}]]);
});
function separationFixture({failMove=false,missing=false,ordinary=false,separate=false}={}){
 const records=[{...target,windowId:20},{...target,channelId:'333',tabId:9,windowId:20},{...target,channelId:'444',tabId:10,windowId:20}],calls=[];
 const tabs=new Map(records.map((record,index)=>[record.tabId,{id:record.tabId,windowId:separate?20+index:20,url:`https://discord.com/channels/111/${record.channelId}`,draft:`draft-${record.tabId}`} ]));
 if(missing)tabs.delete(10);
 const saved={dicoCentralTabs:structuredClone(records),dicoCentralWindowId:20};let nextWindow=50;
 const chrome={storage:{local:{get:async()=>structuredClone(saved),set:async data=>Object.assign(saved,structuredClone(data))}},tabs:{get:async id=>{if(!tabs.has(id))throw Error('missing');return {...tabs.get(id)};}},windows:{get:async id=>({id,type:'normal',tabs:[...tabs.values()].filter(tab=>tab.windowId===id).concat(ordinary&&id===20?[{id:99,url:'https://example.com'}]:[])}),create:async info=>{if(failMove&&info.tabId===9){failMove=false;throw Error('closed during move');}calls.push(['create',info]);const id=nextWindow++;tabs.get(info.tabId).windowId=id;return{id,type:'normal',tabs:[{...tabs.get(info.tabId)}]};},update:async(id,info)=>calls.push(['window',id,info])}};
 return{chrome,saved,calls,tabs,manage:createManagedWindowController({chrome})};
}
test('separation moves existing shared tabs into individual windows while retaining tab IDs and drafts',async()=>{
 const {manage,saved,calls,tabs}=separationFixture();const result=await manage({...target,action:'separate'});
 assert.equal(result.managedTabs,3);assert.equal(result.windowId,50);
 assert.deepEqual(calls,[['create',{tabId:7,type:'normal',state:'minimized',focused:false}],['create',{tabId:9,type:'normal',state:'minimized',focused:false}]]);
 assert.deepEqual(saved.dicoCentralTabs.map(r=>r.windowId),[50,51,20]);
 assert.deepEqual([...tabs.values()].map(t=>[t.id,t.draft]),[[7,'draft-7'],[9,'draft-9'],[10,'draft-10']]);
});
test('separation does not move or minimize ordinary tabs in a shared window',async()=>{
 const {manage,saved,calls}=separationFixture({ordinary:true});await manage({...target,action:'separate'});
 assert.deepEqual(saved.dicoCentralTabs.map(r=>r.windowId),[50,51,52]);assert.equal(calls.length,3);
 assert.ok(calls.every(c=>c[0]==='create'&&c[1].tabId!==99));
});
test('separation refuses a missing tab before moving anything',async()=>{
 const {manage,calls}=separationFixture({missing:true});await assert.rejects(manage({...target,action:'separate'}),{code:'MANAGED_TAB_MISSING'});assert.deepEqual(calls,[]);
});
test('partial separation persists each move and safely resumes without recreating moved tabs',async()=>{
 const r=separationFixture({failMove:true});await assert.rejects(r.manage({...target,action:'separate'}),{code:'WINDOW_SEPARATION_PARTIAL'});
 assert.deepEqual(r.saved.dicoCentralTabs.map(record=>record.windowId),[50,20,20]);assert.equal(r.calls.length,1);
 await r.manage({...target,action:'separate'});assert.deepEqual(r.saved.dicoCentralTabs.map(record=>record.windowId),[50,51,20]);assert.equal(r.calls.length,2);
});
test('already separate windows remain in place and stale ownership is repaired without focus changes',async()=>{
 const r=separationFixture({separate:true});await r.manage({...target,action:'separate'});
 assert.deepEqual(r.calls,[]);assert.deepEqual(r.saved.dicoCentralTabs.map(record=>record.windowId),[20,21,22]);
});
function consolidationFixture({failMove=false,missing=false,ordinary=false}={}){
 const records=[{...target},{...target,channelId:'333',tabId:9},{...target,channelId:'444',tabId:10}],calls=[];
 const tabs=new Map(records.map((record,index)=>[record.tabId,{id:record.tabId,windowId:index+20,url:`https://discord.com/channels/111/${record.channelId}`} ]));
 if(missing)tabs.delete(10);
 const saved={dicoCentralTabs:structuredClone(records)};
 const chrome={storage:{local:{get:async()=>structuredClone(saved),set:async data=>Object.assign(saved,structuredClone(data))}},tabs:{get:async id=>{if(!tabs.has(id))throw Error('missing');return {...tabs.get(id)};},move:async(id,{windowId})=>{if(failMove&&id===10)throw Error('closed during move');calls.push(['move',id,windowId]);tabs.get(id).windowId=windowId;return {...tabs.get(id)};}},windows:{get:async id=>({id,type:'normal',tabs:[...tabs.values()].filter(tab=>tab.windowId===id).concat(ordinary&&id!==50?[{id:99,url:'https://example.com'}]:[])}),create:async info=>{calls.push(['create',info]);tabs.get(info.tabId).windowId=50;return{id:50,type:'normal',tabs:[{...tabs.get(info.tabId)}]};},update:async(id,info)=>calls.push(['window',id,info])}};
 return{chrome,saved,calls,tabs,manage:createManagedWindowController({chrome})};
}
test('explicit consolidation moves existing legacy tabs into one minimized window preserving tab identities',async()=>{
 const {manage,saved,calls,tabs}=consolidationFixture({ordinary:true});const result=await manage({...target,action:'consolidate'});
 assert.deepEqual(calls,[['create',{tabId:7,type:'normal',state:'minimized',focused:false}],['move',9,50],['move',10,50],['window',50,{state:'minimized'}]]);
 assert.equal(result.windowId,50);assert.equal(result.visible,false);assert.equal(result.managedTabs,3);
 assert.deepEqual([...tabs.keys()],[7,9,10]);assert.ok(saved.dicoCentralTabs.every(record=>record.windowId===50));assert.equal(saved.dicoCentralWindowId,50);
});
test('consolidation refuses a missing tab before moving or creating anything',async()=>{
 const {manage,calls}=consolidationFixture({missing:true});await assert.rejects(manage({...target,action:'consolidate'}),{code:'MANAGED_TAB_MISSING'});assert.deepEqual(calls,[]);
});
test('a partial consolidation saves moved ownership immediately and does not create replacement tabs',async()=>{
 const {manage,saved,calls}=consolidationFixture({failMove:true});await assert.rejects(manage({...target,action:'consolidate'}),{code:'WINDOW_CONSOLIDATION_PARTIAL'});
 assert.equal(saved.dicoCentralTabs[0].windowId,50);assert.equal(saved.dicoCentralTabs[1].windowId,50);assert.equal(saved.dicoCentralTabs[2].windowId,undefined);
 assert.equal(calls.filter(call=>call[0]==='create').length,1);assert.equal(calls.filter(call=>call[0]==='move').length,1);
});
test('consolidation reuses an existing proven managed window without creating a second one',async()=>{
 const {manage,saved,calls}=consolidationFixture();saved.dicoCentralTabs[0].windowId=20;
 const result=await manage({...target,action:'consolidate'});
 assert.equal(result.windowId,20);assert.deepEqual(calls,[['move',9,20],['move',10,20],['window',20,{state:'minimized'}]]);
 assert.ok(saved.dicoCentralTabs.every(record=>record.windowId===20));
});

test('reconnecting a shared channel preserves its tab and only separates that channel',async()=>{
 const r=separationFixture();assert.equal(await ensureSeparateManagedWindow(r.chrome,target),50);
 assert.deepEqual(r.saved.dicoCentralTabs.map(record=>record.windowId),[50,20,20]);assert.equal(r.tabs.get(7).draft,'draft-7');
 assert.equal(await ensureSeparateManagedWindow(r.chrome,target),50);assert.equal(r.calls.length,1);
 await assert.rejects(ensureSeparateManagedWindow(r.chrome,{...target,channelId:'wrong'}),{code:'MANAGED_TAB_MISSING'});assert.equal(r.calls.length,1);
});
test('bulk separation refuses a navigated non-Discord tab before moving any channel',async()=>{
 const r=separationFixture();r.tabs.get(10).url='https://example.com';
 await assert.rejects(r.manage({...target,action:'separate'}),{code:'TARGET_MISMATCH'});assert.deepEqual(r.calls,[]);
});

test('safe reconnect consolidates existing tabs preserving drafts and IDs without focus or navigation',async()=>{
 const r=consolidationFixture();r.saved.dicoCentralTabs.forEach((record,index)=>{record.windowId=20+index;r.tabs.get(record.tabId).draft='draft-'+record.tabId;});
 for(const record of [...r.saved.dicoCentralTabs])await ensureConsolidatedManagedWindow(r.chrome,record);
 assert.deepEqual(r.calls,[['move',9,20],['move',10,20]]);assert.deepEqual(r.saved.dicoCentralTabs.map(record=>record.windowId),[20,20,20]);
 assert.deepEqual([...r.tabs.values()].map(tab=>tab.draft),['draft-7','draft-9','draft-10']);
 await ensureConsolidatedManagedWindow(r.chrome,target);assert.equal(r.calls.length,2);
});
test('reconnect moves only known channel tabs out of ordinary windows into one new managed window',async()=>{
 const r=consolidationFixture({ordinary:true});
 for(const record of [...r.saved.dicoCentralTabs])await ensureConsolidatedManagedWindow(r.chrome,record);
 assert.deepEqual(r.calls,[['create',{tabId:7,type:'normal',state:'minimized',focused:false}],['move',9,50],['move',10,50]]);
 assert.equal(r.saved.dicoCentralWindowId,50);
});

test('consolidation refuses a recorded tab navigated to another Discord channel before moving anything',async()=>{
 const r=consolidationFixture();r.tabs.get(10).url='https://discord.com/channels/111/999';
 await assert.rejects(r.manage({...target,action:'consolidate'}),{code:'TARGET_MISMATCH'});assert.deepEqual(r.calls,[]);
 await assert.rejects(ensureConsolidatedManagedWindow(r.chrome,{...target,tabId:10,channelId:'444'}),{code:'TARGET_MISMATCH'});assert.deepEqual(r.calls,[]);
});

test('adopted user tabs stay in place during recovery and are never automatically hidden or closed',async()=>{
 const r=fixture({record:{...target,windowId:8,ownership:'adopted'}});
 assert.equal(await ensureConsolidatedManagedWindow(r.chrome,target),8);
 await assert.rejects(r.manage({...target,action:'hide'}),{code:'WINDOW_NOT_DEDICATED'});
 const result=await r.manage({...target,action:'close'});assert.equal(result.closed,false);assert.equal(result.detached,true);assert.deepEqual(r.calls,[]);
});
test('new managed channels never use adopted user windows as owned containers',async()=>{
 const r=fixture({record:{...target,windowId:8,ownership:'adopted'}});
 await createManagedWindow(r.chrome,{...target,channelId:'333'});assert.equal(r.calls[0][0],'create');
});
