import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverConnections} from '../central/extension/connection-recovery.js';
function rig(){const saved={dicoCentralTabs:[{accountId:'a',guildId:'g',channelId:'c',tabId:1}]},progress=[],opened=[];return{saved,progress,opened,chrome:{storage:{local:{get:async()=>saved,set:async p=>Object.assign(saved,p)}},tabs:{get:async()=>{throw Error('closed');}}},state:{legacyDeclaration:'fresh',attempts:{}},findAccount:async()=>({verified:true,accountId:'a',tabId:4}),openChannel:async p=>opened.push(p),report:async p=>progress.push(p)};}
test('saved channel destinations reconnect automatically without sending and report progress',async()=>{const r=rig();await recoverConnections(r);assert.equal(r.opened.length,1);assert.equal(r.saved.dicoCentralAccount.accountId,'a');assert.deepEqual(r.progress.map(p=>p.stage),['account','channels','configuration']);});
test('unknown old attempts and changed accounts cannot create replacement execution tabs',async()=>{for(const changed of [false,true]){const r=rig();if(changed)r.findAccount=async()=>({verified:true,accountId:'other'});else r.state.attempts.x={phase:'unknown'};await recoverConnections(r);assert.equal(r.opened.length,0);assert.equal(r.progress.at(-1).stage,'blocked');}});
test('an existing tab on a different page is preserved and requires inspection',async()=>{const r=rig();r.chrome.tabs.get=async()=>({url:'https://discord.com/channels/g/other'});await recoverConnections(r);assert.equal(r.opened.length,0);assert.equal(r.progress.at(-1).reasonCode,'TARGET_MISMATCH');});
test('first-time legacy declaration is never fabricated for automatic connection',async()=>{const r=rig();r.state.legacyDeclaration=null;await recoverConnections(r);assert.equal(r.opened.length,0);assert.equal(r.progress.at(-1).reasonCode,'LEGACY_UNRESOLVED');});

test('recovery separates an existing matching tab without opening or reloading it',async()=>{
 const r=rig(),separated=[];r.chrome.tabs.get=async()=>({id:1,windowId:5,url:'https://discord.com/channels/g/c'});r.ensureSeparate=async record=>separated.push(record.tabId);
 await recoverConnections(r);assert.deepEqual(separated,[1]);assert.equal(r.opened.length,0);assert.equal(r.progress.at(-1).stage,'configuration');
});
test('recovery rechecks permission before moving an existing shared tab',async()=>{
 const r=rig(),separated=[];let checks=0;r.canRecover=async()=>++checks===1;r.chrome.tabs.get=async()=>({id:1,windowId:5,url:'https://discord.com/channels/g/c'});r.ensureSeparate=async record=>separated.push(record.tabId);
 await recoverConnections(r);assert.deepEqual(separated,[]);assert.equal(r.progress.at(-1).reasonCode,'ATTEMPT_UNRESOLVED');
});
