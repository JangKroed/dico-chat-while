import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeTransport} from '../central/extension/transport.js';

test('비동기 native disconnect도 요청을 즉시 정리하고 재연결 신호를 한 번 보낸다',async()=>{
  let onDisconnect,disconnectSignals=0;
  const chrome={runtime:{connectNative:()=>({onMessage:{addListener(){}},onDisconnect:{addListener:f=>{onDisconnect=f;}},postMessage(){},disconnect(){setImmediate(()=>onDisconnect());}})}};
  const transport=createNativeTransport(chrome,{timeoutMs:1000});transport.onDisconnect(()=>{disconnectSignals++;});
  const waiting=transport.request({type:'HELLO'}).then(()=>false,()=>true);transport.disconnect();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(disconnectSignals,1);
  assert.equal(await waiting,true);assert.equal(transport.connected,false);
});

test('native response preserves a bounded causal code and retryable signal',async()=>{
 let respond;
 const chrome={runtime:{connectNative:()=>({onMessage:{addListener:fn=>{respond=fn;}},onDisconnect:{addListener(){}},postMessage(packet){queueMicrotask(()=>respond({type:'RESPONSE',requestId:packet.requestId,ok:false,error:{code:'SERVICE_UNAVAILABLE',retryable:true}}));}})}};
 const transport=createNativeTransport(chrome);
 await assert.rejects(transport.request({type:'AUTHORIZE_ENTER'}),error=>error.code==='SERVICE_UNAVAILABLE'&&error.retryable===true);
});
test('native timeout has an explicit retryable cause',async()=>{
 const chrome={runtime:{connectNative:()=>({onMessage:{addListener(){}},onDisconnect:{addListener(){}},postMessage(){}})}};
 await assert.rejects(createNativeTransport(chrome,{timeoutMs:1}).request({type:'AUTHORIZE_ENTER'}),error=>error.code==='NATIVE_REQUEST_TIMEOUT'&&error.retryable===true);
});

test('synchronous native connection failure notifies recovery once without immediate retries',async()=>{
 let tries=0,signals=0;
 const transport=createNativeTransport({runtime:{connectNative(){tries++;throw Error('temporarily unavailable');}}});
 transport.onDisconnect(()=>signals++);
 await assert.rejects(transport.request({type:'HELLO'}),error=>error.code==='NATIVE_SEND_FAILED');
 assert.equal(signals,1);assert.equal(tries,1);assert.equal(transport.connected,false);
 transport.disconnect();assert.equal(signals,1);
});

test('synchronous send failure closes its port and a later request uses a fresh one',async()=>{
 let connections=0,signals=0,closed=0,oldDisconnect;
 const transport=createNativeTransport({runtime:{connectNative(){
  const number=++connections;let respond;
  return {onMessage:{addListener:fn=>{respond=fn;}},onDisconnect:{addListener:fn=>{if(number===1)oldDisconnect=fn;}},
   postMessage(packet){if(number===1)throw Error('port failed');queueMicrotask(()=>respond({type:'RESPONSE',requestId:packet.requestId,ok:true,result:'ready'}));},
   disconnect(){closed++;oldDisconnect();}};
 }}});
 transport.onDisconnect(()=>signals++);
 await assert.rejects(transport.request({type:'HELLO'}),error=>error.code==='NATIVE_SEND_FAILED');
 assert.equal(transport.connected,false);assert.equal(signals,1);assert.equal(closed,1);
 assert.equal(await transport.request({type:'HELLO'}),'ready');oldDisconnect();
 assert.equal(transport.connected,true);assert.equal(connections,2);assert.equal(signals,1);
});
