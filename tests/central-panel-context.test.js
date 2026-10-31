import test from 'node:test';
import assert from 'node:assert/strict';
import {channelTabContext} from '../central/extension/panel-context.js';

test('current server channel enables a channel connection with exact IDs',()=>{
  assert.deepEqual(channelTabContext({id:7,url:'https://discord.com/channels/123/456',status:'complete'}),{eligible:true,tabId:7,guildId:'123',channelId:'456',reason:'현재 Discord 서버 채널을 연결할 수 있습니다.'});
});
test('DM, other sites and a deeper thread route cannot be connected',()=>{
  for(const url of ['https://discord.com/channels/@me','https://discord.com/channels/@me/456','https://example.com/channels/123/456','https://discord.com/channels/123/456/789','http://discord.com/channels/123/456','https://canary.discord.com/channels/123/456','https://discord.com/channels/123/456?thread=789','https://discord.com/channels/123/456#message']){
    const context=channelTabContext({id:7,url,status:'complete'});assert.equal(context.eligible,false,url);assert.ok(context.reason.length>10);
  }
});
test('a missing visible tab URL or a loading tab never enables connection',()=>{
  assert.equal(channelTabContext(undefined).eligible,false);
  assert.equal(channelTabContext({id:7}).eligible,false);
  assert.equal(channelTabContext({id:7,url:'https://discord.com/channels/123/456',status:'loading'}).eligible,false);
});
