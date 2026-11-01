import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagedWindow,createManagedWindowController} from '../central/extension/managed-windows.js';
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
test('additional channels open inactive tabs in the existing dedicated managed window',async()=>{
 const {chrome,calls}=fixture();chrome.storage.local.get=async()=>({dicoCentralTabs:[{...target,windowId:8}],dicoCentralWindowId:8});
 chrome.tabs.create=async info=>{calls.push(['createTab',info]);return{id:9,windowId:8};};
 const result=await createManagedWindow(chrome,{...target,channelId:'333'});
 assert.deepEqual(calls,[['createTab',{windowId:8,active:false,url:'https://discord.com/channels/111/333'}]]);assert.equal(result.tabs[0].id,9);
});
test('a dedicated window containing several recorded channel tabs can be hidden',async()=>{
 const {chrome,manage,calls}=fixture({otherTabs:[{id:9,windowId:8,url:'https://discord.com/channels/111/333'}]});
 chrome.storage.local.get=async()=>({dicoCentralTabs:[{...target,windowId:8},{...target,channelId:'333',tabId:9,windowId:8}]});
 await manage({...target,action:'hide'});assert.deepEqual(calls,[['window',8,{state:'minimized'}]]);
});
function consolidationFixture({failMove=false,missing=false,ordinary=false}={}){
 const records=[{...target},{...target,channelId:'333',tabId:9},{...target,channelId:'444',tabId:10}],calls=[];
 const tabs=new Map(records.map((record,index)=>[record.tabId,{id:record.tabId,windowId:index+20,url:`https://discord.com/channels/111/${record.channelId}`} ]));
 if(missing)tabs.delete(10);
 const saved={dicoCentralTabs:structuredClone(records)};
 const chrome={storage:{local:{get:async()=>structuredClone(saved),set:async data=>Object.assign(saved,structuredClone(data))}},tabs:{get:async id=>{if(!tabs.has(id))throw Error('missing');return {...tabs.get(id)};},move:async(id,{windowId})=>{if(failMove&&id===10)throw Error('closed during move');calls.push(['move',id,windowId]);tabs.get(id).windowId=windowId;return {...tabs.get(id)};}},windows:{get:async id=>({id,type:'normal',tabs:[...tabs.values()].filter(tab=>tab.windowId===id).concat(ordinary&&id!==50?[{id:99,url:'https://example.com'}]:[])}),create:async info=>{calls.push(['create',info]);tabs.get(info.tabId).windowId=50;return{id:50,type:'normal',tabs:[{...tabs.get(info.tabId)}]};},update:async(id,info)=>calls.push(['window',id,info])}};
 return{saved,calls,tabs,manage:createManagedWindowController({chrome})};
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
test('opening a new channel does not reuse a window that now contains ordinary tabs',async()=>{
 const {chrome,calls}=fixture({otherTabs:[{id:99,url:'https://example.com'}]});
 chrome.storage.local.get=async()=>({dicoCentralTabs:[{...target,windowId:8}],dicoCentralWindowId:8});
 await createManagedWindow(chrome,{...target,channelId:'333'});
 assert.equal(calls.length,1);assert.equal(calls[0][0],'create');assert.equal(calls[0][1].state,'minimized');
});
