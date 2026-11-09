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

test('느린 파일 점검 중에도 현재 세션 heartbeat는 응답하고 발송 승인은 복구 완료를 기다린다',async()=>{
 const input=new PassThrough(),output=new PassThrough(),packets=readPackets(output),sent=[];
 let release,started;const began=new Promise(resolve=>{started=resolve;});
 const running=runNativeHost({input,output,origin:`chrome-extension://${id}/`,ids:[id],pollMs:60000,service:{request:async(path,method,body)=>{
  if(path==='/api/bridge/status')return{reloadSafe:true};
  sent.push(body.message.type);return body.message.type==='HELLO'?{instanceId:'i',sessionId:'s',resetEpoch:1}:{ok:true};
 }},extensionStatus:async()=>{started();return new Promise(resolve=>{release=resolve;});}});
 try{
  input.write(encodePacket({requestId:'hello',message:{type:'HELLO',protocolVersion:1}}));await packets.next();
  input.write(encodePacket({requestId:'status',message:{type:'EXTENSION_STATUS'}}));await began;
  input.write(encodePacket({requestId:'authorize',message:{type:'AUTHORIZE_ENTER',attemptId:'a'}}));
  input.write(encodePacket({requestId:'heartbeat',instanceId:'i',message:{type:'HEARTBEAT',sessionId:'s',resetEpoch:1}}));
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.deepEqual(sent,['HELLO','HEARTBEAT']);
  assert.equal((await packets.next()).value.requestId,'heartbeat');
 }finally{
  input.end();release({reloadSafe:true});await running;output.end();
 }
 assert.deepEqual(sent,['HELLO','HEARTBEAT','AUTHORIZE_ENTER','DISCONNECT']);
});

test('파일 점검 중 heartbeat 우회는 세션 교체·종료 경계를 넘지 않는다',async()=>{
 for(const boundary of ['HELLO','DISCONNECT']){
  const input=new PassThrough(),output=new PassThrough(),packets=readPackets(output),sent=[];
  let release,started;const began=new Promise(resolve=>{started=resolve;});
  const running=runNativeHost({input,output,origin:`chrome-extension://${id}/`,ids:[id],pollMs:60000,service:{request:async(path,method,body)=>{
   if(path==='/api/bridge/status')return{reloadSafe:true};sent.push(body.message.type);return{instanceId:'i',sessionId:'s',resetEpoch:1};
  }},extensionStatus:async()=>{started();return new Promise(resolve=>{release=resolve;});}});
  input.write(encodePacket({requestId:'hello',message:{type:'HELLO',protocolVersion:1}}));await packets.next();
  input.write(encodePacket({requestId:'status',message:{type:'EXTENSION_STATUS'}}));await began;
  input.write(encodePacket({requestId:'boundary',message:{type:boundary,protocolVersion:1,sessionId:'s',resetEpoch:1}}));
  input.end(encodePacket({requestId:'heartbeat',message:{type:'HEARTBEAT',sessionId:'s',resetEpoch:1}}));
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(sent,['HELLO']);
  release({reloadSafe:true});await running;output.end();
  assert.deepEqual(sent.slice(0,3),['HELLO',boundary,'HEARTBEAT']);
 }
});

test('파일 복구 중 큐 포화는 초과 요청만 거절하고 뒤의 heartbeat를 계속 읽는다',async()=>{
 const input=new PassThrough(),output=new PassThrough(),responses=[],sent=[];
 const collecting=(async()=>{for await(const packet of readPackets(output))responses.push(packet);})();
 let release,started,healthSeen;const began=new Promise(r=>{started=r;}),healthy=new Promise(r=>{healthSeen=r;});
 const running=runNativeHost({input,output,origin:`chrome-extension://${id}/`,ids:[id],pollMs:60000,service:{request:async(path,method,body)=>{
  if(path==='/api/bridge/status')return{reloadSafe:true};sent.push(body.message.type);
  if(body.message.type==='HEARTBEAT')healthSeen();
  return{instanceId:'i',sessionId:'s',resetEpoch:1};
 }},extensionStatus:async()=>{started();return new Promise(r=>{release=r;});}});
 try{
  input.write(encodePacket({requestId:'hello',message:{type:'HELLO'}}));
  input.write(encodePacket({requestId:'status',message:{type:'EXTENSION_STATUS'}}));await began;
  for(let n=0;n<300;n++)input.write(encodePacket({requestId:`trace${n}`,message:{type:'DELIVERY_TRACE'}}));
  input.write(encodePacket({requestId:'health',message:{type:'HEARTBEAT',sessionId:'s',resetEpoch:1}}));
  await Promise.race([healthy,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('heartbeat blocked by full queue')),1000);timer.unref();})]);
  await new Promise(r=>setImmediate(r));
  assert.deepEqual(sent,['HELLO','HEARTBEAT']);
  const rejected=responses.filter(packet=>!packet.ok);
  assert.equal(rejected.length,44);assert.ok(rejected.every(packet=>packet.code==='SERVICE_UNAVAILABLE'&&packet.retryable===true));
  assert.ok(responses.some(packet=>packet.requestId==='health'&&packet.ok));
 }finally{input.end();release({reloadSafe:true});await running;output.end();await collecting;}
 assert.equal(sent.filter(type=>type==='DELIVERY_TRACE').length,256);
 assert.equal(sent.at(-1),'DISCONNECT');
});

test('포화 큐에서도 세션 경계 뒤의 heartbeat는 파일 복구를 기다린다',async()=>{
 for(const boundary of ['HELLO','DISCONNECT']){
  const input=new PassThrough(),output=new PassThrough(),sent=[];output.resume();
  let release,started;const began=new Promise(r=>{started=r;});
  const running=runNativeHost({input,output,origin:`chrome-extension://${id}/`,ids:[id],pollMs:60000,service:{request:async(path,method,body)=>{
   if(path==='/api/bridge/status')return{reloadSafe:true};sent.push(body.message.type);return{instanceId:'i',sessionId:'s',resetEpoch:1};
  }},extensionStatus:async()=>{started();return new Promise(r=>{release=r;});}});
  try{
   input.write(encodePacket({requestId:'hello',message:{type:'HELLO'}}));
   input.write(encodePacket({requestId:'status',message:{type:'EXTENSION_STATUS'}}));await began;
   for(let n=0;n<256;n++)input.write(encodePacket({requestId:`trace${n}`,message:{type:'DELIVERY_TRACE'}}));
   input.write(encodePacket({requestId:'boundary',message:{type:boundary,sessionId:'s',resetEpoch:1}}));
   input.write(encodePacket({requestId:'health',message:{type:'HEARTBEAT',sessionId:'s',resetEpoch:1}}));
   await new Promise(r=>setImmediate(r));assert.deepEqual(sent,['HELLO']);
  }finally{input.end();release({reloadSafe:true});await running;output.end();}
  assert.equal(sent[257],boundary);assert.equal(sent[258],'HEARTBEAT');
 }
});

test('포화 응답의 출력이 막히면 버퍼 증가를 멈추고 출력 재개 후 heartbeat를 처리한다',{timeout:3000},async()=>{
 const input=new PassThrough(),output=new PassThrough({highWaterMark:1024}),sent=[],responses=[];
 let release,started,healthSeen,blocked,collecting,writes=0;
 const began=new Promise(r=>{started=r;}),healthy=new Promise(r=>{healthSeen=r;}),backpressured=new Promise(r=>{blocked=r;});
 const write=output.write.bind(output);
 output.write=(...args)=>{writes++;const accepted=write(...args);if(!accepted)blocked();return accepted;};
 const running=runNativeHost({input,output,origin:`chrome-extension://${id}/`,ids:[id],pollMs:60000,service:{request:async(path,method,body)=>{
  if(path==='/api/bridge/status')return{reloadSafe:true};sent.push(body.message.type);
  if(body.message.type==='HEARTBEAT')healthSeen();
  return{instanceId:'i',sessionId:'s',resetEpoch:1};
 }},extensionStatus:async()=>{started();return new Promise(r=>{release=r;});}});
 try{
  input.write(encodePacket({requestId:'hello',message:{type:'HELLO'}}));
  input.write(encodePacket({requestId:'status',message:{type:'EXTENSION_STATUS'}}));await began;
  for(let n=0;n<10000;n++)input.write(encodePacket({requestId:`trace${n}`,message:{type:'DELIVERY_TRACE'}}));
  input.end(encodePacket({requestId:'health',message:{type:'HEARTBEAT',sessionId:'s',resetEpoch:1}}));
  await backpressured;
  const stalledWrites=writes,stalledBytes=output.writableLength;
  await new Promise(r=>setImmediate(r));
  assert.equal(writes,stalledWrites);assert.equal(output.writableLength,stalledBytes);
  assert.ok(stalledWrites<100,'stalled output must stop rejection production');
  assert.ok(stalledBytes<2048,'output queue must remain near its high water mark');
  assert.deepEqual(sent,['HELLO']);
  collecting=(async()=>{for await(const packet of readPackets(output))responses.push(packet);})();
  await healthy;await new Promise(r=>setImmediate(r));
  assert.deepEqual(sent,['HELLO','HEARTBEAT']);
  assert.ok(responses.some(packet=>packet.requestId==='health'&&packet.ok));
 }finally{
  if(!collecting)output.resume();input.end();release?.({reloadSafe:true});await running;output.end();await collecting;
 }
 assert.equal(responses.filter(packet=>!packet.ok).length,10000-256);
 assert.equal(sent.filter(type=>type==='DELIVERY_TRACE').length,256);
 assert.equal(sent.at(-1),'DISCONNECT');
});

test('복구 중 heartbeat는 하나씩 실행하고 종료는 진행 중인 heartbeat를 기다린다',async()=>{
 const input=new PassThrough(),output=new PassThrough(),sent=[];output.resume();
 let releaseStatus,releaseHealth,started,healthStarted,active=0,peak=0,draining=false;
 const began=new Promise(r=>{started=r;}),healthBegan=new Promise(r=>{healthStarted=r;});
 const running=runNativeHost({input,output,origin:`chrome-extension://${id}/`,ids:[id],pollMs:60000,service:{request:async(path,method,body)=>{
  if(path==='/api/bridge/status')return{reloadSafe:true};sent.push(body.message.type);
  if(body.message.type==='HEARTBEAT'){
   peak=Math.max(peak,++active);healthStarted();if(!draining)await new Promise(r=>{releaseHealth=r;});active--;
  }
  return{instanceId:'i',sessionId:'s',resetEpoch:1};
 }},extensionStatus:async()=>{started();return new Promise(r=>{releaseStatus=r;});}});
 try{
  input.write(encodePacket({requestId:'hello',message:{type:'HELLO'}}));
  input.write(encodePacket({requestId:'status',message:{type:'EXTENSION_STATUS'}}));await began;
  input.write(encodePacket({requestId:'health1',message:{type:'HEARTBEAT',sessionId:'s',resetEpoch:1}}));await healthBegan;
  input.end(encodePacket({requestId:'health2',message:{type:'HEARTBEAT',sessionId:'s',resetEpoch:1}}));
  await new Promise(r=>setImmediate(r));assert.deepEqual(sent,['HELLO','HEARTBEAT']);
  releaseStatus({reloadSafe:true});await new Promise(r=>setImmediate(r));assert.deepEqual(sent,['HELLO','HEARTBEAT']);
  releaseHealth();await new Promise(r=>setImmediate(r));assert.deepEqual(sent,['HELLO','HEARTBEAT','HEARTBEAT']);
  assert.equal(peak,1);assert.equal(active,1);
 }finally{draining=true;input.end();releaseStatus?.({reloadSafe:true});releaseHealth?.();await running;output.end();}
 assert.equal(sent.at(-1),'DISCONNECT');
});
