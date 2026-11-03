import test from 'node:test';import assert from 'node:assert/strict';
import {ensureManagedContent} from '../central/extension/update.js';
test('없어진 탭은 새로고침 안내 대신 자동 복원 대상으로 구분한다',async()=>{
 let injected=false;const result=await ensureManagedContent({tabs:{get:async()=>{throw Error('No tab');}},scripting:{executeScript:async()=>{injected=true;}}},[{tabId:1,guildId:'g',channelId:'c'}],'build');
 assert.equal(result[0].reason,'TAB_MISSING');assert.equal(injected,false);
});
