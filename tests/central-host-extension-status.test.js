import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {encodePacket,readPackets} from '../central/host/protocol.mjs';
import {runNativeHost} from '../central/host/main.mjs';
const id='abcdefghijklmnopabcdefghijklmnop';
test('legacy status requests carry validated caller identity to loaded-folder repair without new client fields',async()=>{
 const input=new PassThrough(),output=new PassThrough(),packets=readPackets(output);let received;
 const running=runNativeHost({input,output,origin:`chrome-extension://${id}/`,ids:[id],installedRoot:'/installed/app',service:{request:async path=>{assert.equal(path,'/api/bridge/status');return{reloadSafe:true};}},extensionStatus:async(root,options)=>{received={root,options};return{buildId:'a'.repeat(64),reloadSafe:true};}});
 input.end(encodePacket({requestId:'old13',message:{type:'EXTENSION_STATUS'}}));
 assert.equal((await packets.next()).value.ok,true);await running;
 assert.deepEqual(received,{root:'/installed/app',options:{reloadSafe:true,extensionId:id}});
});
test('native shutdown forwards the HELLO reset epoch for authenticated disconnect',async()=>{
 const input=new PassThrough(),output=new PassThrough(),packets=readPackets(output),sent=[];
 const running=runNativeHost({input,output,origin:`chrome-extension://${id}/`,ids:[id],service:{request:async(path,method,body)=>{sent.push(body);return{instanceId:'instance',sessionId:'session',resetEpoch:3,commands:[]};}}});
 input.end(encodePacket({requestId:'hello',message:{type:'HELLO',protocolVersion:1}}));await packets.next();await running;
 assert.deepEqual(sent.at(-1).message,{type:'DISCONNECT',sessionId:'session',resetEpoch:3});
});
