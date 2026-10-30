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
