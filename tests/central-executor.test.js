import test from 'node:test';
import assert from 'node:assert/strict';
import {createCentralExecutor} from '../central/extension/executor.js';

function rig() {
  let stored;const messages=[],reports=[];
  const transport={connected:true,request:async message=>{reports.push(message);return {ok:true};}};
  const chrome={storage:{local:{get:async()=>({dicoCentral:structuredClone(stored)}),set:async x=>{stored=structuredClone(x.dicoCentral);}}},tabs:{get:async()=>({id:7,url:'https://discord.com/channels/11111111111111111/22222222222222222'}),sendMessage:async(id,m)=>{messages.push(m);return m.type==='DICO_PREPARE'?{status:'prepared'}:{status:'confirmed',messageId:'33333333333333333'};}}};
  const client=createCentralExecutor({chrome,transport});
  return {client,chrome,transport,messages,reports,get state(){return stored;}};
}
const payload={bindingId:'binding',attemptId:'attempt',groupId:'group',runId:'run',accountId:'44444444444444444',guildId:'11111111111111111',channelId:'22222222222222222',tabId:7,configVersion:1,body:'공지',revisionId:'rev'};
const cmd=(type,id=type)=>({id,type,instanceId:'instance',sessionId:'session',payload:{...payload,...(type==='COMMIT_PERMIT'?{permitId:'permit'}:{})}});
async function configured(r) {
  await r.client.load();await r.client.setSession({instanceId:'instance',sessionId:'session'});
  await r.client.handleCommand({id:'sync',type:'CONFIG_SYNC',instanceId:'instance',sessionId:'session',payload:{...payload,items:[{messageId:'m',revisionId:'rev',body:'공지'}]}});
}
test('입력 준비만으로 Enter 권한이 생기지 않으며 중앙 허가 후 한 번만 전송한다',async()=>{
  const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
  assert.equal(await r.client.canSend({id:'attempt',phase:'commit'},7),false);
  await r.client.handleCommand(cmd('COMMIT_PERMIT'));await r.client.handleCommand(cmd('COMMIT_PERMIT'));
  assert.equal(r.messages.filter(m=>m.type==='DICO_DELIVER').length,1);
  assert.equal(r.reports.filter(m=>m.type==='DELIVERY_RESULT'&&m.outcome==='confirmed').length,1);
});
test('연결 끊김·오래된 세션·다른 탭·다른 구성은 Enter를 허용하지 않는다',async()=>{
  const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
  r.transport.connected=false;
  assert.equal(await r.client.canSend({id:'attempt',phase:'prepare'},7),false);
  r.transport.connected=true;
  await r.client.handleCommand({...cmd('COMMIT_PERMIT'),sessionId:'old'});
  assert.equal(r.messages.filter(m=>m.type==='DICO_DELIVER').length,0);
  assert.equal(await r.client.canSend({id:'attempt',phase:'commit'},99),false);
});
test('전송 중 응답 유실은 시도 흔적을 보존하고 같은 허가를 재실행하지 않는다',async()=>{
  const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
  r.chrome.tabs.sendMessage=async(id,m)=>{r.messages.push(m);throw Error('lost');};
  await r.client.handleCommand(cmd('COMMIT_PERMIT'));await r.client.handleCommand(cmd('COMMIT_PERMIT','redelivered'));
  assert.equal(r.messages.filter(m=>m.type==='DICO_DELIVER').length,1);
  assert.equal(r.state.attempts.attempt.phase,'unknown');
});
test('중지 게이트는 즉시 닫고 실제 적용 ACK를 구분한다',async()=>{
  const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
  await r.client.handleCommand({id:'stop',type:'CONTROL',instanceId:'instance',sessionId:'session',payload:{action:'stop',groupId:'group',runId:'run',attemptId:'attempt'}});
  assert.equal(await r.client.canSend({id:'attempt',phase:'prepare'},7),false);
  assert.ok(r.reports.some(m=>m.type==='ACK'&&m.commandId==='stop'&&m.status==='applied'&&m.executionBlocked===true));
});

test('중지 명령 뒤 늦게 도착한 준비·허가는 같은 실행을 다시 열지 않는다',async()=>{
  const r=rig();await configured(r);
  await r.client.handleCommand({id:'stop-first',type:'CONTROL',instanceId:'instance',sessionId:'session',payload:{action:'stop',groupId:'group',runId:'run',attemptId:'attempt'}});
  await r.client.handleCommand(cmd('PREPARE'));await r.client.handleCommand(cmd('COMMIT_PERMIT'));
  assert.equal(r.messages.length,0);
  await r.client.handleCommand({...cmd('PREPARE','fresh-run'),payload:{...payload,attemptId:'new-attempt',runId:'new-run'}});
  assert.equal(r.messages.filter(m=>m.type==='DICO_PREPARE').length,1);
});

test('절전 동안 버퍼에 머문 중앙 승인 응답은 Enter 권한으로 사용하지 않는다',async()=>{
  const r=rig();let clock=100000,release,started;
  r.client=createCentralExecutor({chrome:r.chrome,transport:r.transport,now:()=>clock,monotonicNow:()=>clock});
  await configured(r);await r.client.handleCommand(cmd('PREPARE'));
  let permission,actualPermission;
  const waiting=new Promise(resolve=>{started=resolve;});
  r.transport.request=async m=>{r.reports.push(m);if(m.type==='AUTHORIZE_ENTER'){started();return new Promise(resolve=>{release=resolve;});}return {ok:true};};
  r.chrome.tabs.sendMessage=async(id,m)=>{if(m.type==='DICO_DELIVER'){permission=r.client.canSend({id:'attempt',phase:'commit'},7);await waiting;clock+=60000;release({allowed:true});actualPermission=await permission;return {status:'blocked'};}return {status:'prepared'};};
  await r.client.handleCommand(cmd('COMMIT_PERMIT'));
  assert.equal(actualPermission,false);
});
