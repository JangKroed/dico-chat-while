import test from 'node:test';
import assert from 'node:assert/strict';
import {detectBrowser} from '../central/extension/browser-identity.js';
test('Brave uses isBrave despite sharing the Chrome user agent',async()=>{
 assert.equal(await detectBrowser({brave:{isBrave:async()=>true},userAgent:'Chrome/130.0.0.0',userAgentData:{brands:[{brand:'Chromium'},{brand:'Google Chrome'}]}}),'Brave');
});
test('Chrome and Edge report actual browser labels',async()=>{
 assert.equal(await detectBrowser({userAgentData:{brands:[{brand:'Chromium'},{brand:'Google Chrome'}]}}),'Chrome');
 assert.equal(await detectBrowser({userAgent:'Mozilla Chrome/130.0 Edg/130.0'}),'Edge');
});
test('unavailable identification is a conservative Chromium fallback',async()=>{
 assert.equal(await detectBrowser({}),'Chromium');
 assert.equal(await detectBrowser({brave:{isBrave:async()=>{throw Error('blocked');}},userAgent:'Chrome/130.0'}),'Chromium');
});

test('service worker에서 Brave API가 없으면 권한 있는 Discord 탭에서 확인한다',async()=>{
 const {detectConnectedBrowser}=await import('../central/extension/browser-identity.js');
 const chrome={tabs:{query:async()=>[{id:7}]},scripting:{executeScript:async()=>[{result:'Brave'}]}};
 assert.equal(await detectConnectedBrowser(chrome,{userAgentData:{brands:[{brand:'Google Chrome'}]}}),'Brave');
 chrome.scripting.executeScript=async()=>{throw Error('tab closed');};
 assert.equal(await detectConnectedBrowser(chrome,{}),'Chromium');
});
