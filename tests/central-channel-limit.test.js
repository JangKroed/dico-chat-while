import test from 'node:test';
import assert from 'node:assert/strict';
import {observeChannelLimit} from '../central/extension/channel-limit.js';
const record={tabId:7,accountId:'account',guildId:'111',channelId:'222'};
const rig=value=>({tabs:{sendMessage:async(id,message)=>{assert.equal(id,7);assert.equal(message.type,'DICO_CHANNEL_LIMIT');assert.equal(message.target.channelId,'222');return value;},get:async()=>({url:'https://discord.com/channels/111/222'})}});
test('채널 슬로우 모드를 기존 content 검사로 읽어 밀리초로 전달한다',async()=>{
 assert.deepEqual(await observeChannelLimit(rig({slowmodeSeconds:60}),record),{slowmodeMs:60000});
});
test('읽기 실패와 잘못된 값은 제한 없음으로 바꾸지 않는다',async()=>{
 for(const value of [null,{}, {slowmodeSeconds:null},{slowmodeSeconds:-1},{slowmodeSeconds:'60'},{slowmodeSeconds:21601}])assert.deepEqual(await observeChannelLimit(rig(value),record),{});
 const chrome=rig(null);chrome.tabs.sendMessage=async()=>{throw Error('not ready');};assert.deepEqual(await observeChannelLimit(chrome,record),{});
});
test('응답을 기다리는 동안 다른 채널로 이동하면 적용하지 않는다',async()=>{
 const chrome=rig({slowmodeSeconds:60});chrome.tabs.get=async()=>({url:'https://discord.com/channels/111/333'});
 assert.deepEqual(await observeChannelLimit(chrome,record),{});
});
