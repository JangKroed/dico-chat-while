import test from 'node:test';
import assert from 'node:assert/strict';
import {lookupExistingChannelName} from '../central/extension/channel-name.js';
import {createCentralExecutor} from '../central/extension/executor.js';

test('name lookup only inspects existing exact-target tabs and verifies the observed target again',async()=>{
 const inspected=[];const tabs=[{id:1,url:'https://discord.com/channels/222/other'},{id:2,url:'https://evil.com/channels/222/333'},{id:3,url:'https://discord.com/channels/222/333'},{id:4,url:'https://discord.com/channels/222/333/444'}];
 const chrome={tabs:{query:async()=>tabs,create:()=>assert.fail('must not open a tab'),update:()=>assert.fail('must not activate a tab'),sendMessage:()=>assert.fail('must not send content commands')}};
 const result=await lookupExistingChannelName(chrome,async id=>{inspected.push(id);return id===3?{verified:true,guildId:'222',channelId:'444',channelName:'이동한 채널'}:{verified:true,guildId:'222',channelId:'333',channelName:'실제-이름'};},{guildId:'222',channelId:'333'});
 assert.equal(result,'실제-이름');assert.deepEqual(inspected,[3,4]);
 assert.equal(await lookupExistingChannelName({tabs:{query:async()=>[]}},()=>assert.fail('no matching tab'),{guildId:'222',channelId:'333'}),null);
});

test('executor acknowledges a read-only name lookup without creating attempts or sending tab messages',async()=>{
 let stored;const reports=[];let inspected=0;
 const chrome={storage:{local:{get:async()=>({dicoCentral:stored}),set:async values=>{stored=structuredClone(values.dicoCentral);}}},tabs:{sendMessage:()=>assert.fail('lookup must not send editor commands')}};
 const executor=createCentralExecutor({chrome,transport:{request:async m=>{reports.push(m);return{ok:true};}},lookupChannelName:async payload=>{inspected++;assert.equal(payload.channelId,'333');return'채널-이름';}});
 await executor.setSession({instanceId:'instance',sessionId:'session'});
 const command={id:'lookup',type:'LOOKUP_CHANNEL_NAME',instanceId:'instance',sessionId:'session',payload:{targetId:'target',guildId:'222',channelId:'333'}};
 await executor.handleCommand(command);await executor.handleCommand(command);
 assert.equal(inspected,1);assert.equal(reports.find(m=>m.status==='applied')?.channelName,'채널-이름');assert.deepEqual(executor.state.attempts,{});assert.deepEqual(executor.state.bindings,{});
});
