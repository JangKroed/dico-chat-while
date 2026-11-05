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

test('실행 중 확장 상태 조회는 파일 검사와 복구를 건너뛰고 다음 승인 요청을 처리한다',async()=>{
 for(const reloadSafe of [false,undefined]){
  const input=new PassThrough(),output=new PassThrough(),packets=readPackets(output);let inspections=0;
  const running=runNativeHost({input,output,origin:`chrome-extension://${id}/`,ids:[id],service:{request:async(path,method,body)=>path==='/api/bridge/status'?{reloadSafe}: {allowed:body.message.type==='AUTHORIZE_ENTER'}},extensionStatus:async()=>{inspections++;return{buildId:'a'.repeat(64),reloadSafe:false};}});
  input.write(encodePacket({requestId:'status',message:{type:'EXTENSION_STATUS'}}));
  input.end(encodePacket({requestId:'authorize',message:{type:'AUTHORIZE_ENTER',attemptId:'attempt'}}));
  const status=(await packets.next()).value,authorization=(await packets.next()).value;await running;
  assert.equal(inspections,0);
  assert.deepEqual(status.result,{buildId:null,reloadSafe:false,reason:'EXECUTION_BUSY'});
  assert.equal(authorization.requestId,'authorize');assert.equal(authorization.result.allowed,true);
 }
});

test('유휴 확장 파일 복구가 끝나기 전에는 다음 명령과 세션 종료를 실행하지 않는다',async()=>{
 const input=new PassThrough(),output=new PassThrough(),packets=readPackets(output);let release,started;
 const began=new Promise(resolve=>{started=resolve;}),sent=[];
 const running=runNativeHost({input,output,origin:`chrome-extension://${id}/`,ids:[id],service:{request:async(path,method,body)=>{if(path==='/api/bridge/status')return{reloadSafe:true};sent.push(body.message.type);return body.message.type==='HELLO'?{instanceId:'instance',sessionId:'session'}:{allowed:true};}},extensionStatus:async()=>{started();return new Promise(resolve=>{release=resolve;});}});
 input.write(encodePacket({requestId:'hello',message:{type:'HELLO',protocolVersion:1}}));await packets.next();
 input.write(encodePacket({requestId:'status',message:{type:'EXTENSION_STATUS'}}));await began;
 input.end(encodePacket({requestId:'authorize',message:{type:'AUTHORIZE_ENTER',attemptId:'attempt'}}));
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(sent,['HELLO']);
 release({buildId:'a'.repeat(64),reloadSafe:true});
 assert.equal((await packets.next()).value.requestId,'status');assert.equal((await packets.next()).value.requestId,'authorize');await running;
 assert.deepEqual(sent,['HELLO','AUTHORIZE_ENTER','DISCONNECT']);
});

test('누적 trace 대기열보다 발송 승인·결과를 우선하되 세션과 파일 복구 경계는 지킨다',async()=>{
 const input=new PassThrough(),output=new PassThrough(),packets=readPackets(output),sent=[];
 let release,started;const began=new Promise(resolve=>{started=resolve;});
 const running=runNativeHost({input,output,origin:`chrome-extension://${id}/`,ids:[id],pollMs:60000,service:{request:async(path,method,body)=>{
  const m=body.message;sent.push(m.type+(m.sequence||''));
  if(m.type==='HELLO')return{instanceId:'i',sessionId:'s'};
  if(m.type==='DELIVERY_TRACE'&&m.sequence===1){started();await new Promise(resolve=>{release=resolve;});}
  return{allowed:true};
 }}});
 input.write(encodePacket({requestId:'hello',message:{type:'HELLO',protocolVersion:1}}));await packets.next();
 input.write(encodePacket({requestId:'trace1',message:{type:'DELIVERY_TRACE',attemptId:'a',sequence:1}}));await began;
 for(let n=2;n<=15;n++)input.write(encodePacket({requestId:'trace'+n,message:{type:'DELIVERY_TRACE',attemptId:'a',sequence:n}}));
 input.end(encodePacket({requestId:'authorize',message:{type:'AUTHORIZE_ENTER',attemptId:'a'}}));
 await new Promise(resolve=>setImmediate(resolve));release();await running;output.end();
 assert.equal(sent[2],'AUTHORIZE_ENTER');
 assert.deepEqual(sent.filter(s=>s.startsWith('DELIVERY_TRACE')),Array.from({length:15},(_,n)=>'DELIVERY_TRACE'+(n+1)));
 assert.equal(sent.at(-1),'DISCONNECT');
});
