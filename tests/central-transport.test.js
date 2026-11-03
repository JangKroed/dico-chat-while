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
