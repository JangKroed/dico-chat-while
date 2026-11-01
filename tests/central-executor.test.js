import test from 'node:test';
import assert from 'node:assert/strict';
import {createCentralExecutor} from '../central/extension/executor.js';

function rig() {
  let stored;const messages=[],reports=[];
  const transport={connected:true,request:async message=>{reports.push(message);return {ok:true};}};
  const chrome={storage:{local:{get:async()=>({dicoCentral:structuredClone(stored)}),set:async x=>{stored=structuredClone(x.dicoCentral);}}},tabs:{get:async()=>({id:7,url:'https://discord.com/channels/11111111111111111/22222222222222222'}),sendMessage:async(id,m)=>{messages.push(m);return m.type==='DICO_PREPARE'?{status:'prepared'}:m.type==='DICO_INSPECT'?{ok:true,cooldownKnown:true,draftMatches:true,cooldownMs:0}:{status:'confirmed',messageId:'33333333333333333'};}}};
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

test('입력 준비 거절 사유 코드를 보고하고 본문이나 오류 원문은 중앙에 보내지 않는다',async()=>{
 const r=rig();await configured(r);
 r.chrome.tabs.sendMessage=async()=>({status:'blocked',code:'DRAFT_MISMATCH',error:'private message text'});
 await r.client.handleCommand(cmd('PREPARE'));
 const rejected=r.reports.find(x=>x.type==='ACK'&&x.status==='rejected');
 assert.equal(rejected.rejectionCode,'DRAFT_MISMATCH');
 assert.equal(JSON.stringify(r.reports).includes('private message text'),false);
});

test('채널 열기 명령은 창 연결만 수행하고 발송 준비·Enter를 실행하지 않는다',async()=>{
 const r=rig();const opened=[];
 const client=createCentralExecutor({chrome:r.chrome,transport:r.transport,openChannel:async p=>{opened.push(p);}});
 await client.load();await client.setSession({instanceId:'instance',sessionId:'session'});
 const command={id:'open-channel',type:'OPEN_CHANNEL',instanceId:'instance',sessionId:'session',payload:{accountId:'44444444444444444',guildId:'11111111111111111',channelId:'22222222222222222'}};
 await client.handleCommand(command);await client.handleCommand(command);
 assert.equal(opened.length,1);assert.equal(r.messages.length,0);assert.equal(Object.keys(client.state.attempts).length,0);
 assert.ok(r.reports.some(x=>x.type==='ACK'&&x.commandId==='open-channel'&&x.status==='applied'));
});

test('업데이트 유지보수는 유휴 상태에서만 시작하고 새 입력 준비를 차단한다',async()=>{
 const r=rig();await configured(r);assert.equal(r.client.isIdle,true);assert.equal(r.client.beginMaintenance(),true);assert.equal(r.client.beginMaintenance(),false);
 await r.client.handleCommand(cmd('PREPARE'));
 assert.equal(r.messages.length,0);assert.equal(r.reports.at(-1).rejectionCode,'UPDATE_IN_PROGRESS');
 const active=rig();await configured(active);await active.client.handleCommand(cmd('PREPARE'));
 assert.equal(active.client.beginMaintenance(),false);
});

test('불명 결과의 허용된 진단만 저장하고 중앙에 보고하며 재검사로 첫 원인을 덮지 않는다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 const evidence={phase:'commit',stage:'observe',enterAttempted:true,composerRetained:true,newMessage:false,matchingMessage:false,sendingSeen:true,failedSeen:false,authorMismatch:false,authorUnknown:true,timeMismatch:false};
 r.chrome.tabs.sendMessage=async(id,m)=>{r.messages.push(m);return m.type==='DICO_RECONCILE'?{status:'uncertain',code:'DELIVERY_CONFIRMATION_TIMEOUT',deliveryEvidence:{phase:'send',stage:'observe',enterAttempted:false}}:{status:'draft-retained',code:'DELIVERY_DRAFT_RETAINED',deliveryEvidence:{...evidence,body:'private draft',error:'private DOM'},error:'private error'};};
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));
 assert.equal(r.state.attempts.attempt.phase,'unknown');
 assert.equal(r.state.attempts.attempt.result.reasonCode,'DELIVERY_DRAFT_RETAINED');
 assert.deepEqual(r.state.attempts.attempt.result.deliveryEvidence,evidence);
 await r.client.handleCommand(cmd('RECONCILE'));
 const reports=r.reports.filter(x=>x.type==='DELIVERY_RESULT');
 assert.equal(reports.length,2);
 for(const report of reports){assert.equal(report.outcome,'unknown');assert.equal(report.reasonCode,'DELIVERY_DRAFT_RETAINED');assert.deepEqual(report.deliveryEvidence,evidence);}
 assert.equal(JSON.stringify(reports).includes('private'),false);
 assert.equal(r.messages.filter(x=>x.type==='DICO_DELIVER').length,1);
});

test('저장 후 보고가 끊겨도 재전달은 같은 불명 진단을 보고하고 Enter를 다시 요청하지 않는다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 const evidence={phase:'commit',stage:'stable',enterAttempted:false};
 r.chrome.tabs.sendMessage=async(id,m)=>{r.messages.push(m);return {status:'uncertain',code:'COMMIT_EDITOR_UNSTABLE',deliveryEvidence:evidence};};
 const request=r.transport.request;let loseFirst=true;
 r.transport.request=async m=>{if(m.type==='DELIVERY_RESULT'&&loseFirst){loseFirst=false;throw Error('lost report');}return request(m);};
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));
 r.client=createCentralExecutor({chrome:r.chrome,transport:r.transport});await r.client.load();
 await r.client.handleCommand(cmd('COMMIT_PERMIT','redelivered'));
 const report=r.reports.find(x=>x.type==='DELIVERY_RESULT');
 assert.equal(report.outcome,'unknown');assert.equal(report.reasonCode,'COMMIT_EDITOR_UNSTABLE');assert.deepEqual(report.deliveryEvidence,evidence);
 assert.equal(r.messages.filter(x=>x.type==='DICO_DELIVER').length,1);
});

test('알 수 없는 코드와 진단 문자열은 외부로 보내지 않으며 Enter 미시도 진단으로 결과를 단정하지 않는다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 r.chrome.tabs.sendMessage=async()=>({status:'private status',code:'PRIVATE_MESSAGE_TEXT',deliveryEvidence:{phase:'private phase',stage:'private stage',enterAttempted:false,composerRetained:'private draft',newMessage:1,unknown:'private error'}});
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));
 const report=r.reports.find(x=>x.type==='DELIVERY_RESULT');
 assert.equal(report.outcome,'unknown');assert.equal(report.reasonCode,'no_response');
 assert.deepEqual(report.deliveryEvidence,{enterAttempted:false});
 assert.equal(JSON.stringify(report).includes('private'),false);
 assert.equal(JSON.stringify(report).includes('PRIVATE_MESSAGE_TEXT'),false);
});

test('실제 차단 응답은 미발송 판정을 유지하면서 고정 코드와 진단을 보존한다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 r.chrome.tabs.sendMessage=async()=>({status:'blocked',code:'ACCOUNT_UNVERIFIED',deliveryEvidence:{phase:'commit',stage:'inspect',enterAttempted:false}});
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));
 const report=r.reports.find(x=>x.type==='DELIVERY_RESULT');
 assert.equal(report.outcome,'not_sent');assert.equal(report.executionBlocked,true);assert.equal(report.reasonCode,'ACCOUNT_UNVERIFIED');assert.equal(report.deliveryEvidence.enterAttempted,false);
});

test('미리 입력한 같은 시도는 현재 초안과 남은 쿨다운을 재검사하며 허가까지 기다린다',async()=>{
 const r=rig();let clock=100000;const waits=[];let inspections=0;
 r.client=createCentralExecutor({chrome:r.chrome,transport:r.transport,now:()=>clock,monotonicNow:()=>clock,wait:async ms=>{waits.push(ms);clock+=ms;}});
 const request=r.transport.request;
 r.transport.request=async m=>{await request(m);return m.type==='PREPARED'?(m.cooldownMs>0?{ok:true,permitIssued:false,retryAfterMs:500}:{ok:true,permitIssued:true}):{ok:true};};
 r.chrome.tabs.sendMessage=async(id,m)=>{r.messages.push(m);return m.type==='DICO_INSPECT'?{ok:true,cooldownKnown:true,draftMatches:true,cooldownMs:inspections++===0?500:0,diagnostics:{draft:'private'}}:{status:'prepared'};};
 await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 assert.deepEqual(waits,[500]);assert.deepEqual(r.reports.filter(x=>x.type==='PREPARED').map(x=>x.cooldownMs),[500,0]);
 assert.equal(r.messages.filter(x=>x.type==='DICO_PREPARE').length,1);assert.equal(r.messages.filter(x=>x.type==='DICO_DELIVER').length,0);
 assert.equal(JSON.stringify(r.reports).includes('private'),false);
});

test('미리 입력 대기 중 중지 요청은 다음 허가 요청을 차단하고 같은 차례를 취소한다',async()=>{
 const r=rig();let stop;
 r.client=createCentralExecutor({chrome:r.chrome,transport:r.transport,wait:async()=>{stop=r.client.handleCommand({id:'stop-wait',type:'CONTROL',instanceId:'instance',sessionId:'session',payload:{groupId:'group',runId:'run',attemptId:'attempt'}});}});
 r.transport.request=async m=>{r.reports.push(m);return m.type==='PREPARED'?{ok:true,permitIssued:false,retryAfterMs:500}:{ok:true};};
 r.chrome.tabs.sendMessage=async(id,m)=>m.type==='DICO_INSPECT'?{ok:true,cooldownKnown:true,draftMatches:true,cooldownMs:500}:{status:'prepared'};
 await configured(r);await r.client.handleCommand(cmd('PREPARE'));await stop;
 assert.equal(r.reports.filter(x=>x.type==='PREPARED').length,1);assert.equal(r.state.attempts.attempt.phase,'cancelled');
 assert.equal(r.reports.some(x=>x.type==='ACK'&&x.commandId==='stop-wait'&&x.executionBlocked),true);
});

test('미리 입력 대기의 현재 초안 불일치나 120초 한도는 허가를 요청하지 않고 중단한다',async()=>{
 for(const kind of ['draft','timeout']){
  const r=rig();let clock=100000;
  r.client=createCentralExecutor({chrome:r.chrome,transport:r.transport,now:()=>clock,monotonicNow:()=>clock,wait:async()=>{clock+=120001;}});
  r.transport.request=async m=>{r.reports.push(m);return m.type==='PREPARED'?{ok:true,permitIssued:false,retryAfterMs:500}:{ok:true};};
  r.chrome.tabs.sendMessage=async(id,m)=>m.type==='DICO_INSPECT'?{ok:true,cooldownKnown:true,draftMatches:kind!=='draft',cooldownMs:500}:{status:'prepared'};
  await configured(r);await r.client.handleCommand(cmd('PREPARE'));
  assert.equal(r.reports.filter(x=>x.type==='PREPARED').length,kind==='draft'?0:1);
  assert.equal(r.reports.at(-1).rejectionCode,kind==='draft'?'DRAFT_MISMATCH':'PREPARE_WAIT_TIMEOUT');
 }
});

test('해석하지 못한 Discord 카운트다운은 0초로 승인하지 않는다',async()=>{
 const r=rig();await configured(r);
 r.chrome.tabs.sendMessage=async(id,m)=>m.type==='DICO_INSPECT'?{ok:true,draftMatches:true,cooldownKnown:false,cooldownMs:0}:{status:'prepared'};
 await r.client.handleCommand(cmd('PREPARE'));
 assert.equal(r.reports.some(x=>x.type==='PREPARED'),false);
 assert.equal(r.reports.at(-1).rejectionCode,'COOLDOWN_UNVERIFIED');
});

test('준비 대기 중 연결이 끊기면 추가 검사와 허가 요청을 하지 않는다',async()=>{
 const r=rig();
 r.client=createCentralExecutor({chrome:r.chrome,transport:r.transport,wait:async()=>{r.transport.connected=false;r.client.disconnect();}});
 r.transport.request=async m=>{r.reports.push(m);return m.type==='PREPARED'?{ok:true,permitIssued:false,retryAfterMs:500}:{ok:true};};
 await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 assert.equal(r.reports.filter(x=>x.type==='PREPARED').length,1);
 assert.equal(r.messages.filter(x=>x.type==='DICO_INSPECT').length,1);
 assert.equal(r.messages.filter(x=>x.type==='DICO_DELIVER').length,0);
});
