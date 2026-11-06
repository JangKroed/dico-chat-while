import test from 'node:test';
import assert from 'node:assert/strict';
import {createCentralExecutor} from '../central/extension/executor.js';
const emptyDraft=()=>({ok:true,draftText:'',draftMatches:false,unsupported:false,attachmentOrReply:false});

function rig() {
  let stored;const messages=[],reports=[];
  const transport={connected:true,request:async message=>{reports.push(message);return {ok:true};}};
  const chrome={storage:{local:{get:async()=>({dicoCentral:structuredClone(stored)}),set:async x=>{stored=structuredClone(x.dicoCentral);}}},tabs:{get:async()=>({id:7,url:'https://discord.com/channels/11111111111111111/22222222222222222'}),sendMessage:async(id,m)=>{messages.push(m);return m.type==='DICO_DRAFT_INSPECT'?emptyDraft():m.type==='DICO_PREPARE'?{status:'prepared'}:m.type==='DICO_INSPECT'?{ok:true,cooldownKnown:true,draftMatches:true,cooldownMs:0}:{status:'confirmed',messageId:'33333333333333333'};}}};
  const client=createCentralExecutor({chrome,transport});
  return {client,chrome,transport,messages,reports,get state(){return stored;}};
}
const payload={bindingId:'binding',attemptId:'attempt',groupId:'group',runId:'run',accountId:'44444444444444444',guildId:'11111111111111111',channelId:'22222222222222222',tabId:7,configVersion:1,body:'공지',revisionId:'rev'};
const cmd=(type,id=type)=>({id,type,instanceId:'instance',sessionId:'session',payload:{...payload,...(type==='COMMIT_PERMIT'?{permitId:'permit'}:{})}});
async function configured(r) {
  await r.client.load();await r.client.setSession({instanceId:'instance',sessionId:'session'});
  await r.client.handleCommand({id:'sync',type:'CONFIG_SYNC',instanceId:'instance',sessionId:'session',payload:{...payload,items:[{messageId:'m',revisionId:'rev',body:'공지'}]}});
}
for(const status of ['blocked','deferred'])test(`Enter 이후 ${status}는 과거 미발송으로 확정하지 않는다`,async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 r.chrome.tabs.sendMessage=async()=>({status,code:'ACCOUNT_UNVERIFIED',deliveryEvidence:{phase:'commit',stage:'authorize',enterAttempted:true}});
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));
 assert.equal(r.state.attempts.attempt.phase,'unknown');
 assert.equal(r.reports.find(m=>m.type==='DELIVERY_RESULT').outcome,'unknown');
 await r.client.handleCommand(cmd('COMMIT_PERMIT','duplicate-permit'));
 assert.equal(r.state.attempts.attempt.phase,'unknown');
});
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

test('retry wait is bound to the executing tab and forwards a bounded existing wait message',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 r.transport.request=async m=>{r.reports.push(m);return m.type==='DELIVERY_WAIT'?{allowed:true}:{ok:true};};
 r.chrome.tabs.sendMessage=async(id,m)=>{if(m.type==='DICO_DELIVER')return r.client.retryWait({id:'attempt',phase:'commit',retryCount:1,cooldownMs:0,elapsedMs:0},7).then(allowed=>({status:allowed?'blocked':'uncertain'}));return m.type==='DICO_DRAFT_INSPECT'?emptyDraft():m.type==='DICO_INSPECT'?{ok:true,cooldownKnown:true,draftMatches:true,cooldownMs:0}:{status:'prepared'};};
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));
 assert.deepEqual(r.reports.filter(m=>m.type==='DELIVERY_WAIT').map(({retryPhase,retryCount,cooldownMs})=>({retryPhase,retryCount,cooldownMs})),[{retryPhase:true,retryCount:1,cooldownMs:0}]);
 assert.equal(r.state.attempts.attempt.sendRetryCount,1);
 assert.equal(await r.client.retryWait({id:'attempt',phase:'commit',retryCount:2,cooldownMs:0,elapsedMs:0},7),false);
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
  r.chrome.tabs.sendMessage=async(id,m)=>{if(m.type==='DICO_DRAFT_INSPECT')return emptyDraft();if(m.type==='DICO_INSPECT')return{ok:true,draftMatches:true,cooldownKnown:true,cooldownMs:0};if(m.type==='DICO_DELIVER'){permission=r.client.canSend({id:'attempt',phase:'commit'},7);await waiting;clock+=60000;release({allowed:true});actualPermission=await permission;return {status:'blocked'};}return {status:'prepared'};};
  await r.client.handleCommand(cmd('COMMIT_PERMIT'));
  assert.equal(actualPermission,false);
});

test('입력 준비 거절 사유 코드를 보고하고 본문이나 오류 원문은 중앙에 보내지 않는다',async()=>{
 const r=rig();await configured(r);
 r.chrome.tabs.sendMessage=async(id,m)=>m.type==='DICO_DRAFT_INSPECT'?emptyDraft():({status:'blocked',code:'DRAFT_MISMATCH',error:'private message text'});
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

test('입력 이벤트·화면 상태 진단은 허용된 타입만 중앙으로 전달한다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 r.chrome.tabs.sendMessage=async()=>({status:'draft-retained',code:'DELIVERY_DRAFT_RETAINED',deliveryEvidence:{phase:'commit',stage:'observe',enterAttempted:true,enterDefaultPrevented:false,keyupDefaultPrevented:true,documentHidden:false,documentFocused:true,submitMethod:'keyboard',retryCount:2,maxSendRetries:5,nativeInputObserved:'private event',body:'private draft'}});
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));
 assert.deepEqual(r.reports.find(x=>x.type==='DELIVERY_RESULT').deliveryEvidence,{phase:'commit',stage:'observe',enterAttempted:true,enterDefaultPrevented:false,keyupDefaultPrevented:true,documentHidden:false,documentFocused:true,submitMethod:'keyboard',retryCount:2,maxSendRetries:5});
 assert.equal(JSON.stringify(r.reports).includes('private'),false);
});

test('잘못된 입력 진단 타입과 전송 방식은 보고하지 않는다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 r.chrome.tabs.sendMessage=async()=>({status:'uncertain',code:'DELIVERY_CONFIRMATION_TIMEOUT',deliveryEvidence:{phase:'commit',stage:'observe',enterAttempted:true,enterDefaultPrevented:'true',keyupDefaultPrevented:1,documentHidden:null,documentFocused:{secret:'private'},submitMethod:'private click',retryCount:Number.MAX_SAFE_INTEGER+1,maxSendRetries:'5'}});
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));
 assert.deepEqual(r.reports.find(x=>x.type==='DELIVERY_RESULT').deliveryEvidence,{phase:'commit',stage:'observe',enterAttempted:true});
 assert.equal(JSON.stringify(r.reports).includes('private'),false);
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
 r.chrome.tabs.sendMessage=async(id,m)=>{r.messages.push(m);return m.type==='DICO_DRAFT_INSPECT'?emptyDraft():m.type==='DICO_INSPECT'?{ok:true,cooldownKnown:true,draftMatches:true,cooldownMs:inspections++===0?500:0,diagnostics:{draft:'private'}}:{status:'prepared'};};
 await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 assert.deepEqual(waits,[500]);assert.deepEqual(r.reports.filter(x=>x.type==='PREPARED').map(x=>x.cooldownMs),[500,0]);
 assert.equal(r.messages.filter(x=>x.type==='DICO_PREPARE').length,1);assert.equal(r.messages.filter(x=>x.type==='DICO_DELIVER').length,0);
 assert.equal(JSON.stringify(r.reports).includes('private'),false);
});

test('미리 입력 대기 중 중지 요청은 다음 허가 요청을 차단하고 같은 차례를 취소한다',async()=>{
 const r=rig();let stop;
 r.client=createCentralExecutor({chrome:r.chrome,transport:r.transport,wait:async()=>{stop=r.client.handleCommand({id:'stop-wait',type:'CONTROL',instanceId:'instance',sessionId:'session',payload:{groupId:'group',runId:'run',attemptId:'attempt'}});}});
 r.transport.request=async m=>{r.reports.push(m);return m.type==='PREPARED'?{ok:true,permitIssued:false,retryAfterMs:500}:{ok:true};};
 r.chrome.tabs.sendMessage=async(id,m)=>m.type==='DICO_DRAFT_INSPECT'?emptyDraft():m.type==='DICO_INSPECT'?{ok:true,cooldownKnown:true,draftMatches:true,cooldownMs:500}:{status:'prepared'};
 await configured(r);await r.client.handleCommand(cmd('PREPARE'));await stop;
 assert.equal(r.reports.filter(x=>x.type==='PREPARED').length,1);assert.equal(r.state.attempts.attempt.phase,'cancelled');
 assert.equal(r.reports.some(x=>x.type==='ACK'&&x.commandId==='stop-wait'&&x.executionBlocked),true);
});

test('미리 입력 대기의 현재 초안 불일치나 6시간 30초 한도는 허가를 요청하지 않고 중단한다',async()=>{
 for(const kind of ['draft','timeout']){
  const r=rig();let clock=100000;
  r.client=createCentralExecutor({chrome:r.chrome,transport:r.transport,now:()=>clock,monotonicNow:()=>clock,wait:async()=>{clock+=21630001;}});
  r.transport.request=async m=>{r.reports.push(m);return m.type==='PREPARED'?{ok:true,permitIssued:false,retryAfterMs:500}:{ok:true};};
  r.chrome.tabs.sendMessage=async(id,m)=>m.type==='DICO_DRAFT_INSPECT'?emptyDraft():m.type==='DICO_INSPECT'?{ok:true,cooldownKnown:true,draftMatches:kind!=='draft',cooldownMs:500}:{status:'prepared'};
  await configured(r);await r.client.handleCommand(cmd('PREPARE'));
  assert.equal(r.reports.filter(x=>x.type==='PREPARED').length,kind==='draft'?0:1);
  assert.equal(r.reports.at(-1).rejectionCode,kind==='draft'?'DRAFT_MISMATCH':'PREPARE_WAIT_TIMEOUT');
 }
});

test('해석하지 못한 Discord 카운트다운은 0초로 승인하지 않는다',async()=>{
 const r=rig();await configured(r);
 r.chrome.tabs.sendMessage=async(id,m)=>m.type==='DICO_DRAFT_INSPECT'?emptyDraft():m.type==='DICO_INSPECT'?{ok:true,draftMatches:true,cooldownKnown:false,cooldownMs:0}:{status:'prepared'};
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

test('전송 창 보기 명령은 기존 창 콜백만 호출하고 입력·발송을 실행하지 않는다',async()=>{
 const r=rig(),seen=[];const client=createCentralExecutor({chrome:r.chrome,transport:r.transport,manageChannelWindow:async p=>seen.push(p)});
 await client.load();await client.setSession({instanceId:'instance',sessionId:'session'});
 const c={...cmd('MANAGE_WINDOW'),payload:{...payload,action:'reveal'}};
 await client.handleCommand(c);await client.handleCommand(c);
 assert.equal(seen.length,1);assert.equal(r.messages.length,0);assert.equal(seen[0].tabId,7);
 assert.ok(r.reports.some(m=>m.type==='ACK'&&m.status==='applied'));
});

test('미확인 발송이 남으면 탭 모으기 콜백에 진입하지 않는다',async()=>{
 const r=rig(),seen=[];r.client=createCentralExecutor({chrome:r.chrome,transport:r.transport,manageChannelWindow:async p=>seen.push(p)});
 await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 await r.client.handleCommand({...cmd('MANAGE_WINDOW'),payload:{...payload,action:'consolidate'}});
 assert.equal(seen.length,0);assert.ok(r.reports.some(m=>m.type==='ACK'&&m.rejectionCode==='ATTEMPT_UNRESOLVED'));
});

test('다른 초안은 원문을 먼저 영구 보관한 뒤 정확한 교체 문자열로 준비한다',async()=>{
 const r=rig(),send=r.chrome.tabs.sendMessage;await configured(r);
 r.chrome.tabs.sendMessage=async(id,m)=>{
  if(m.type==='DICO_DRAFT_INSPECT')return{...emptyDraft(),draftText:'개인 초안\n보관'};
  if(m.type==='DICO_PREPARE'){
   assert.equal(r.state.draftBackups[0].text,'개인 초안\n보관');
   assert.equal(m.delivery.replaceExpectedDraft,'개인 초안\n보관');
  }
  return send(id,m);
 };
 await r.client.handleCommand(cmd('PREPARE'));
 assert.equal(r.state.attempts.attempt.phase,'prepared');assert.equal(r.state.draftBackups.length,1);
 assert.equal(JSON.stringify(r.reports).includes('개인 초안'),false);
});

test('같은 계획 문구는 교체 토큰이나 백업 없이 준비한다',async()=>{
 const r=rig(),send=r.chrome.tabs.sendMessage;await configured(r);
 r.chrome.tabs.sendMessage=async(id,m)=>{
  if(m.type==='DICO_DRAFT_INSPECT')return{...emptyDraft(),draftText:payload.body,draftMatches:true};
  if(m.type==='DICO_PREPARE')assert.equal(m.delivery.replaceExpectedDraft,undefined);
  return send(id,m);
 };
 await r.client.handleCommand(cmd('PREPARE'));assert.equal(r.state.draftBackups.length,0);
});

test('초안 보관 저장 실패 뒤에는 기존 입력을 교체하지 않는다',async()=>{
 const r=rig(),send=r.chrome.tabs.sendMessage,set=r.chrome.storage.local.set;await configured(r);
 r.chrome.tabs.sendMessage=async(id,m)=>m.type==='DICO_DRAFT_INSPECT'?{...emptyDraft(),draftText:'보존할 초안'}:send(id,m);
 r.chrome.storage.local.set=async value=>{if(value.dicoCentral.draftBackups.length)throw Error('storage unavailable');return set(value);};
 await assert.rejects(r.client.handleCommand(cmd('PREPARE')));
 assert.equal(r.messages.some(m=>m.type==='DICO_PREPARE'),false);
});

test('이전 미확인 시도가 있으면 새 시도의 초안 교체나 준비를 하지 않는다',async()=>{
 const r=rig();await configured(r);
 r.client.state.attempts.previous={...payload,attemptId:'previous',phase:'unknown',enterRequested:true};await r.client.save();
 await r.client.handleCommand(cmd('PREPARE'));
 assert.equal(r.reports.at(-1).rejectionCode,'ATTEMPT_UNRESOLVED');assert.equal(r.messages.some(m=>m.type==='DICO_PREPARE'),false);
});

test('완료된 동일 시도의 다른 준비 명령은 확인 영수증만 재보고한다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));await r.client.handleCommand(cmd('COMMIT_PERMIT'));
 const before=r.messages.length;await r.client.handleCommand(cmd('PREPARE','duplicate-prepare'));
 assert.equal(r.messages.length,before);assert.equal(r.reports.filter(m=>m.type==='DELIVERY_RESULT'&&m.outcome==='confirmed').length,2);
});

test('Enter 전 대기와 해제는 같은 허가에 보고하며 완료되기 전에는 결과를 만들지 않는다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 const request=r.transport.request;r.transport.request=async m=>{await request(m);return{ok:true,allowed:true};};
 r.chrome.tabs.sendMessage=async(id,m)=>{
  assert.equal(m.type,'DICO_DELIVER');
  for(const cooldownMs of [1000,500,0]){
   assert.equal(await r.client.preEnterWait({id:'attempt',phase:'commit',enterAttempted:false,cooldownMs,elapsedMs:1000-cooldownMs},7),true);
   assert.equal(r.reports.some(m=>m.type==='DELIVERY_RESULT'),false);
  }
  return{status:'confirmed',messageId:'33333333333333333'};
 };
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));
 assert.deepEqual(r.reports.filter(m=>m.type==='DELIVERY_WAIT').map(m=>m.cooldownMs),[1000,500,0]);
 assert.equal(r.reports.filter(m=>m.type==='DELIVERY_RESULT').length,1);
});

test('Enter 전 대기 보고는 잘못된 탭 실제 Enter 흔적 구성변경과 중지 뒤 응답을 거절한다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 const waitMessage={id:'attempt',phase:'commit',enterAttempted:false,cooldownMs:500,elapsedMs:0};
 assert.equal(await r.client.preEnterWait(waitMessage,7),false);
 r.chrome.tabs.sendMessage=async()=>{
  assert.equal(await r.client.preEnterWait(waitMessage,8),false);
  assert.equal(await r.client.preEnterWait({...waitMessage,enterAttempted:true},7),false);
  r.client.state.bindings.binding.configVersion=2;assert.equal(await r.client.preEnterWait(waitMessage,7),false);r.client.state.bindings.binding.configVersion=1;
  const request=r.transport.request;r.transport.request=async m=>{await request(m);if(m.type==='DELIVERY_WAIT'){r.client.disconnect();return{allowed:true};}return{ok:true};};
  assert.equal(await r.client.preEnterWait(waitMessage,7),false);
  return{status:'blocked'};
 };
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));
 assert.equal(r.reports.filter(m=>m.type==='DELIVERY_WAIT').length,1);
});

test('신선한 검사로 갱신되는 2분 이상의 쿨다운은 동일 준비 시도에서 기다린다',async()=>{
 const r=rig();let clock=100000,checks=0;
 r.client=createCentralExecutor({chrome:r.chrome,transport:r.transport,now:()=>clock,monotonicNow:()=>clock,wait:async ms=>{clock+=ms;}});
 const request=r.transport.request;r.transport.request=async m=>{await request(m);return m.type==='PREPARED'?{ok:true,permitIssued:++checks>130,retryAfterMs:1000}:{ok:true};};
 await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 assert.equal(checks,131);assert.equal(clock,230000);
 assert.equal(r.messages.filter(m=>m.type==='DICO_PREPARE').length,1);assert.equal(r.messages.some(m=>m.type==='DICO_DELIVER'),false);
 assert.equal(r.reports.some(m=>m.status==='rejected'),false);
});

test('지연된 Enter 전 대기 승인 응답은 현재 허가로 사용하지 않는다',async()=>{
 const r=rig();let clock=100000;
 r.client=createCentralExecutor({chrome:r.chrome,transport:r.transport,now:()=>clock,monotonicNow:()=>clock});
 await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 const request=r.transport.request;r.transport.request=async m=>{await request(m);if(m.type==='DELIVERY_WAIT'){clock+=2001;return{allowed:true};}return{ok:true};};
 r.chrome.tabs.sendMessage=async()=>{
  assert.equal(await r.client.preEnterWait({id:'attempt',phase:'commit',enterAttempted:false,cooldownMs:500,elapsedMs:0},7),false);
  return{status:'blocked'};
 };
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));
});

test('최종 불명 응답을 영구 저장한 뒤 실행 차단을 보고하고 늦은 Enter 승인을 거절한다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 let resolveAuthorization,authorization;
 const request=r.transport.request;
 r.transport.request=async m=>{
  if(m.type==='AUTHORIZE_ENTER')return new Promise(resolve=>{resolveAuthorization=resolve;});
  if(m.type==='DELIVERY_RESULT'){
   assert.equal(r.state.attempts.attempt.phase,'unknown');
   assert.equal(r.state.attempts.attempt.result.executionBlocked,true);
   assert.equal(m.outcome,'unknown');assert.equal(m.executionBlocked,true);
  }
  return request(m);
 };
 r.chrome.tabs.sendMessage=async()=>{
  authorization=r.client.canSend({id:'attempt',phase:'commit'},7);
  await new Promise(resolve=>setImmediate(resolve));
  return{status:'draft-retained',code:'DELIVERY_DRAFT_RETAINED',deliveryEvidence:{phase:'commit',stage:'observe',enterAttempted:true,composerRetained:true}};
 };
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));
 assert.equal(r.state.attempts.attempt.result.executionBlocked,true);
 assert.equal(r.reports.find(m=>m.type==='DELIVERY_RESULT')?.executionBlocked,true);
 resolveAuthorization({allowed:true});
 assert.equal(await authorization,false);
 assert.equal(await r.client.canSend({id:'attempt',phase:'commit'},7),false);
});

test('응답 유실 또는 불완전한 최종 증거는 실행 차단 확인으로 보고하지 않는다',async()=>{
 const cases=[undefined,{status:'uncertain'},{status:'uncertain',deliveryEvidence:{phase:'commit',stage:'inspect',enterAttempted:false}},{status:'uncertain',deliveryEvidence:{phase:'commit',stage:'observe',enterAttempted:false}},{status:'uncertain',deliveryEvidence:{phase:'prepare',stage:'observe',enterAttempted:true}},{status:'uncertain',deliveryEvidence:{phase:'commit',stage:'unknown',enterAttempted:false}},{status:'unknown',deliveryEvidence:{phase:'commit',stage:'observe',enterAttempted:true}},new Error('lost')];
 for(const result of cases){
  const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
  r.chrome.tabs.sendMessage=async()=>{if(result instanceof Error)throw result;return result;};
  await r.client.handleCommand(cmd('COMMIT_PERMIT'));
  const report=r.reports.find(m=>m.type==='DELIVERY_RESULT');
  assert.equal(report.outcome,'unknown');assert.equal(report.executionBlocked,false);
 }
});

test('재시도 준비는 이전 불명 결과의 중앙 종료 상태를 먼저 영구 반영한다',async()=>{
 const r=rig();await configured(r);
 r.client.state.attempts.previous={...payload,attemptId:'previous',sessionId:'session',phase:'unknown',enterRequested:true,result:{outcome:'unknown',executionBlocked:true}};await r.client.save();
 const request=r.transport.request,send=r.chrome.tabs.sendMessage;
 r.transport.request=async m=>{
  await request(m);
  if(m.type==='HEARTBEAT'){
   assert.deepEqual(m.knownAttemptIds,['previous']);assert.equal(m.sessionId,'session');
   return{ok:true,terminalAttempts:[{attemptId:'previous',status:'not_sent'}]};
  }
  return{ok:true};
 };
 r.chrome.tabs.sendMessage=async(id,m)=>{
  if(m.type==='DICO_DRAFT_INSPECT'||m.type==='DICO_PREPARE')assert.equal(r.state.attempts.previous.phase,'not_sent');
  return send(id,m);
 };
 await r.client.handleCommand(cmd('PREPARE'));
 assert.equal(r.state.attempts.attempt.phase,'prepared');assert.equal(r.state.attempts.previous.reported,true);
 assert.equal(r.messages.some(m=>m.type==='DICO_DELIVER'),false);
 assert.equal(r.reports.some(m=>m.type==='ACK'&&m.status==='rejected'),false);
});

test('이전 불명 결과가 중앙에서 종료되지 않았거나 응답이 유실되면 재시도 준비를 막는다',async()=>{
 const cases=[undefined,{ok:true,terminalAttempts:[]},{ok:false,terminalAttempts:[{attemptId:'previous',status:'not_sent'}]},{ok:true,terminalAttempts:[{attemptId:'previous',status:'executing'}]},{ok:true,terminalAttempts:[{attemptId:'previous',status:'confirmed',messageId:'invalid'}]},new Error('lost')];
 for(const result of cases){
  const r=rig();await configured(r);
  r.client.state.attempts.previous={...payload,attemptId:'previous',phase:'unknown',enterRequested:true};await r.client.save();
  const request=r.transport.request;r.transport.request=async m=>{if(m.type==='HEARTBEAT'){if(result instanceof Error)throw result;return result;}return request(m);};
  await r.client.handleCommand(cmd('PREPARE'));
  assert.equal(r.state.attempts.previous.phase,'unknown');
  assert.equal(r.messages.some(m=>m.type==='DICO_PREPARE'),false);
  assert.equal(r.reports.at(-1).rejectionCode,'ATTEMPT_UNRESOLVED');
 }
});

test('재시도 종료 동기화는 요청한 같은 연결의 이전 불명 시도에만 적용한다',async()=>{
 const r=rig();await configured(r);
 r.client.state.attempts.previous={...payload,attemptId:'previous',phase:'unknown',enterRequested:true};
 r.client.state.attempts.other={...payload,bindingId:'other-binding',channelId:'55555555555555555',attemptId:'other',phase:'unknown',enterRequested:true};await r.client.save();
 const request=r.transport.request;r.transport.request=async m=>{
  await request(m);return m.type==='HEARTBEAT'?{ok:true,terminalAttempts:[{attemptId:'previous',status:'not_sent'},{attemptId:'other',status:'not_sent'},{attemptId:'attempt',status:'not_sent'}]}:{ok:true};
 };
 await r.client.handleCommand(cmd('PREPARE'));
 assert.equal(r.state.attempts.previous.phase,'not_sent');assert.equal(r.state.attempts.other.phase,'unknown');assert.equal(r.state.attempts.attempt.phase,'prepared');
});

test('이전 결과 동기화 중 세션 변경이나 실행 중지는 새 준비 기록을 만들지 않는다',async()=>{
 for(const interruption of ['session','stop']){
  const r=rig();await configured(r);
  r.client.state.attempts.previous={...payload,attemptId:'previous',phase:'unknown',enterRequested:true};await r.client.save();
  const request=r.transport.request;
  r.transport.request=async m=>{
   if(m.type==='HEARTBEAT'){
    if(interruption==='session')await r.client.setSession({instanceId:'instance',sessionId:'replacement-session'});
    else r.client.state.stoppedRuns[payload.runId]=true;
    return{ok:true,terminalAttempts:[{attemptId:'previous',status:'not_sent'}]};
   }
   return request(m);
  };
  await r.client.handleCommand(cmd('PREPARE'));
  assert.equal(r.state.attempts.attempt,undefined);
  assert.equal(r.messages.length,0);
 }
});


test('중앙에서 종료된 재시작 전 실행 기록도 재시도 준비 전에 동기화한다',async()=>{
 for(const phase of ['preparing','prepared','executing']){
  const r=rig();await configured(r);
  r.client.state.attempts.previous={...payload,attemptId:'previous',phase,enterRequested:phase==='executing'};await r.client.save();
  const request=r.transport.request;r.transport.request=async m=>{await request(m);return m.type==='HEARTBEAT'?{ok:true,terminalAttempts:[{attemptId:'previous',status:'not_sent'}]}:{ok:true};};
  await r.client.handleCommand(cmd('PREPARE'));
  assert.equal(r.state.attempts.previous.phase,'not_sent');assert.equal(r.state.attempts.attempt.phase,'prepared');
 }
});

test('쿨다운 표본은 확인 완료 보고 뒤에만 전달하고 필드·탭·구성을 검증한다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 const sample={status:'remaining',elapsedMs:1000,remainingMs:67000,slowmodeMs:60000,maxGapMs:500,privateText:'private'};
 r.chrome.tabs.sendMessage=async(id,m)=>{if(m.type==='DICO_DELIVER'){
  assert.equal(await r.client.cooldownSample({deliveryId:'attempt',sample},7),true);
  assert.equal(r.reports.some(m=>m.type==='COOLDOWN_SAMPLE'),false);
  return{status:'confirmed',messageId:'33333333333333333'};
 }return m.type==='DICO_INSPECT'?{ok:true,draftMatches:true,cooldownKnown:true,cooldownMs:0}:emptyDraft();};
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));
 const forwarded=r.reports.find(m=>m.type==='COOLDOWN_SAMPLE');assert.ok(forwarded);
 assert.ok(r.reports.findIndex(m=>m.type==='DELIVERY_RESULT')<r.reports.indexOf(forwarded));
 assert.deepEqual(forwarded.sample,{status:'remaining',elapsedMs:1000,remainingMs:67000,slowmodeMs:60000,maxGapMs:500});assert.equal(forwarded.attemptId,'attempt');assert.equal(forwarded.runId,'run');
 assert.equal(await r.client.cooldownSample({deliveryId:'attempt',sample},99),false);
 for(const bad of [{...sample,maxGapMs:8000},{...sample,remainingMs:0},{...sample,elapsedMs:16000},{...sample,status:'inconclusive'}])assert.equal(await r.client.cooldownSample({deliveryId:'attempt',sample:bad},7),false);
 r.client.state.bindings.binding.configVersion=2;assert.equal(await r.client.cooldownSample({deliveryId:'attempt',sample},7),false);
});
test('미확인 전송 표본과 이전 세션·새 시도로 대체된 표본은 적용하지 않는다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 const sample={status:'remaining',elapsedMs:500,remainingMs:65000,maxGapMs:500};
 r.chrome.tabs.sendMessage=async(_id,m)=>{if(m.type==='DICO_DELIVER'){await r.client.cooldownSample({deliveryId:'attempt',sample},7);return{status:'uncertain'};}return{ok:true,draftMatches:true,cooldownKnown:true,cooldownMs:0};};
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));assert.equal(r.reports.some(m=>m.type==='COOLDOWN_SAMPLE'),false);
 assert.equal(await r.client.cooldownSample({deliveryId:'attempt',sample},7),false);
 r.client.state.attempts.attempt.phase='confirmed';r.client.state.attempts.attempt.reported=true;r.client.state.attempts.newer={...r.client.state.attempts.attempt,attemptId:'newer'};
 assert.equal(await r.client.cooldownSample({deliveryId:'attempt',sample},7),false);
 delete r.client.state.attempts.newer;await r.client.setSession({instanceId:'instance',sessionId:'new-session'});
 assert.equal(await r.client.cooldownSample({deliveryId:'attempt',sample},7),false);
});

test('duplicate in-flight PREPARE deliveries coalesce and a rejection is durably terminal',async()=>{
 const r=rig();await configured(r);let release,started;
 const began=new Promise(resolve=>{started=resolve;});
 r.chrome.tabs.sendMessage=async(id,m)=>{r.messages.push(m);if(m.type==='DICO_DRAFT_INSPECT')return emptyDraft();if(m.type==='DICO_PREPARE'){started();return new Promise(resolve=>{release=resolve;});}throw Error('unexpected message');};
 const original=r.client.handleCommand(cmd('PREPARE'));await began;
 const duplicates=Array.from({length:30},()=>r.client.handleCommand(cmd('PREPARE')));
 release({status:'blocked',code:'PREPARE_EDITOR_UNSTABLE'});await Promise.all([original,...duplicates]);
 assert.equal(r.reports.filter(x=>x.type==='ACK'&&x.commandId==='PREPARE'&&x.status==='received').length,1);
 assert.equal(r.reports.filter(x=>x.type==='ACK'&&x.commandId==='PREPARE'&&x.status==='rejected').length,1);
 assert.equal(r.messages.filter(x=>x.type==='DICO_PREPARE').length,1);
 const restarted=createCentralExecutor({chrome:r.chrome,transport:r.transport});await restarted.handleCommand(cmd('PREPARE'));
 assert.equal(r.messages.filter(x=>x.type==='DICO_PREPARE').length,1);
});

test('a suspended PREPARE response times out, revokes authorization and releases the command lane',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const r=rig();await configured(r);let started,release;
 const began=new Promise(resolve=>{started=resolve;});
 r.chrome.tabs.sendMessage=async(id,m)=>m.type==='DICO_DRAFT_INSPECT'?emptyDraft():new Promise(resolve=>{release=resolve;started();});
 const job=r.client.handleCommand(cmd('PREPARE'));await began;t.mock.timers.tick(20001);await job;
 assert.equal(await r.client.canSend({id:'attempt',phase:'prepare'},7),false);
 assert.equal(r.state.attempts.attempt.phase,'not_sent');
 assert.equal(r.reports.find(x=>x.type==='ACK'&&x.status==='rejected').rejectionCode,'PREPARE_TIMEOUT');
 release({status:'prepared'});await Promise.resolve();
 assert.equal(r.reports.some(x=>x.type==='PREPARED'),false);
 await r.client.handleCommand({id:'stop-after-timeout',type:'CONTROL',instanceId:'instance',sessionId:'session',payload:{action:'stop',groupId:'group',runId:'run',attemptId:'attempt'}});
 assert.ok(r.reports.some(x=>x.type==='ACK'&&x.commandId==='stop-after-timeout'&&x.status==='applied'));
});

const clearedComposerReceipt=()=>({status:'confirmed',confirmationBasis:'composer_cleared',timing:{confirmationMs:0},deliveryEvidence:{phase:'commit',stage:'observe',submitMethod:'keyboard',enterAttempted:true,expectedDraftSubmitted:true,composerCleared:true,sameEditor:true,targetMatched:true,accountMatched:true,failedSeen:false,composerRetained:false}});
test('실행기는 메시지 ID 없는 입력창 비움 증명을 영구 보관·보고하고 같은 허가를 재실행하지 않는다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));const send=r.chrome.tabs.sendMessage;
 r.chrome.tabs.sendMessage=async(id,message)=>{if(message.type==='DICO_DELIVER'){r.messages.push(message);return clearedComposerReceipt();}return send(id,message);};
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));await r.client.handleCommand(cmd('COMMIT_PERMIT','duplicate'));
 assert.equal(r.state.attempts.attempt.phase,'confirmed');assert.equal(r.state.attempts.attempt.result.messageId,undefined);assert.equal(r.state.attempts.attempt.result.confirmationBasis,'composer_cleared');assert.equal(r.messages.filter(m=>m.type==='DICO_DELIVER').length,1);
 const report=r.reports.find(m=>m.type==='DELIVERY_RESULT');assert.equal(report.outcome,'confirmed');assert.equal(report.messageId,undefined);assert.equal(report.confirmationBasis,'composer_cleared');assert.equal(report.deliveryEvidence.emptyStableMs,undefined);
 await r.client.handleCommand(cmd('PREPARE','repeat-preparation'));assert.equal(r.messages.filter(m=>m.type==='DICO_DELIVER').length,1);assert.equal(r.state.processed['repeat-preparation'],true);
});
test('실행기는 불완전한 입력창 비움 증명을 성공으로 보고하지 않는다',async()=>{
 for(const patch of [{enterAttempted:false},{sameEditor:false}]){
  const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));r.chrome.tabs.sendMessage=async()=>({...clearedComposerReceipt(),deliveryEvidence:{...clearedComposerReceipt().deliveryEvidence,...patch}});
  await r.client.handleCommand(cmd('COMMIT_PERMIT'));assert.equal(r.state.attempts.attempt.phase,'unknown');assert.equal(r.reports.find(m=>m.type==='DELIVERY_RESULT').outcome,'unknown');
 }
});
test('정상 미발송 재시도는 과거 설정과 10회 제한을 넘되 중지·미확인 상태에서는 입력하지 않는다',async()=>{
 for(const oldLimit of [0,3,10,null]){
  const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));const a=r.client.state.attempts.attempt;
  Object.assign(a,{phase:'executing',permitId:'permit',enterRequested:true,sendRetryCount:0,maxSendRetries:oldLimit});r.transport.request=async()=>({allowed:true});
  for(let count=1;count<=12;count++){
   assert.equal(await r.client.retryWait({id:'attempt',phase:'commit',retryCount:count,cooldownMs:0,elapsedMs:count*1000},7),true);
   assert.equal(await r.client.canSend({id:'attempt',phase:'commit',retryCount:count},7),true);
  }
  assert.equal(a.sendRetryCount,12);a.phase='unknown';
  assert.equal(await r.client.retryWait({id:'attempt',phase:'commit',retryCount:13,cooldownMs:0,elapsedMs:13000},7),false);
  assert.equal(await r.client.canSend({id:'attempt',phase:'commit',retryCount:12},7),false);
  a.phase='executing';r.client.state.emergencyStopped=true;
  assert.equal(await r.client.retryWait({id:'attempt',phase:'commit',retryCount:13,cooldownMs:0,elapsedMs:13000},7),false);
  assert.equal(await r.client.canSend({id:'attempt',phase:'commit',retryCount:12},7),false);
 }
});

test('전송 응답만 유실되면 같은 content의 완료 영수증을 한 번 읽어 현재 시도를 확정한다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 r.chrome.tabs.sendMessage=async(id,m)=>{r.messages.push(m);if(m.type==='DICO_DELIVER')throw Error('lost response');if(m.type==='DICO_DELIVERY_RECEIPT')return clearedComposerReceipt();throw Error('unexpected');};
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));await r.client.handleCommand(cmd('COMMIT_PERMIT','again'));
 assert.equal(r.state.attempts.attempt.phase,'confirmed');assert.equal(r.messages.filter(m=>m.type==='DICO_DELIVER').length,1);assert.equal(r.messages.filter(m=>m.type==='DICO_DELIVERY_RECEIPT').length,1);
 assert.equal(r.reports.find(m=>m.type==='DELIVERY_RESULT').outcome,'confirmed');
});
test('전송 중 세션이 바뀌거나 연결이 끊기면 content 완료 영수증 복구를 새로 요청하지 않는다',async()=>{
 for(const mode of ['session','connection']){
  const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
  r.chrome.tabs.sendMessage=async(id,m)=>{r.messages.push(m);if(m.type==='DICO_DELIVER'){if(mode==='session')await r.client.setSession({instanceId:'instance',sessionId:'new'});else r.transport.connected=false;throw Error('lost response');}return clearedComposerReceipt();};
  await r.client.handleCommand(cmd('COMMIT_PERMIT'));assert.equal(r.messages.filter(m=>m.type==='DICO_DELIVERY_RECEIPT').length,0);assert.equal(r.state.attempts.attempt.phase,'unknown');
 }
});

test('authorization diagnostics distinguish transient service failures from local stop',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));const a=r.client.state.attempts.attempt;
 Object.assign(a,{phase:'executing',permitId:'permit',enterRequested:true});
 r.transport.request=async()=>{throw Object.assign(Error('timeout'),{code:'NATIVE_REQUEST_TIMEOUT',retryable:true});};
 assert.deepEqual(await r.client.authorizeInput({id:'attempt',phase:'commit'},7),{allowed:false,code:'NATIVE_REQUEST_TIMEOUT',retryable:true,retryAfterMs:500});
 r.client.state.emergencyStopped=true;const stopped=await r.client.authorizeInput({id:'attempt',phase:'commit'},7);assert.equal(stopped.code,'EXECUTION_STOPPED');assert.equal(stopped.retryable,false);
});
test('known delivery survives report transport failure and retries reporting without another Enter',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));const request=r.transport.request;
 let failures=3;r.transport.request=async message=>{if(message.type==='DELIVERY_RESULT'&&failures-->0)throw Object.assign(Error('timeout'),{code:'NATIVE_REQUEST_TIMEOUT',retryable:true});return request(message);};
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));
 assert.equal(r.state.attempts.attempt.phase,'confirmed');assert.notEqual(r.state.processed.COMMIT_PERMIT?.status,'rejected');
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));
 assert.equal(r.state.attempts.attempt.reported,true);assert.equal(r.messages.filter(m=>m.type==='DICO_DELIVER').length,1);assert.equal(r.reports.some(m=>m.status==='rejected'),false);
});
test('lost applied ACK retries only the acknowledgement even for a mutating command',async()=>{
 const r=rig();await configured(r);const request=r.transport.request;let failed=0;
 r.transport.request=async message=>{if(message.type==='ACK'&&message.status==='applied'&&message.commandId==='PREPARE'&&failed++<3)throw Object.assign(Error('timeout'),{code:'NATIVE_REQUEST_TIMEOUT',retryable:true});return request(message);};
 await r.client.handleCommand(cmd('PREPARE'));assert.notEqual(r.state.processed.PREPARE?.status,'rejected');await r.client.handleCommand(cmd('PREPARE'));
 assert.equal(r.state.processed.PREPARE,true);assert.equal(r.messages.filter(m=>m.type==='DICO_PREPARE').length,1);assert.equal(r.reports.some(m=>m.status==='rejected'),false);
});

test('structured wait responses preserve transient denial without advancing the retry count',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));const a=r.client.state.attempts.attempt;
 Object.assign(a,{phase:'executing',permitId:'permit',enterRequested:true,maxSendRetries:1});
 r.transport.request=async()=>({allowed:false,code:'COOLDOWN_ACTIVE',retryable:true,retryAfterMs:750});
 const response=await r.client.authorizeRetryWait({id:'attempt',phase:'commit',retryCount:1,cooldownMs:0,elapsedMs:0},7);
 assert.equal(response.code,'COOLDOWN_ACTIVE');assert.equal(response.retryable,true);assert.equal(a.sendRetryCount,undefined);
 r.transport.request=async()=>({allowed:true});assert.equal((await r.client.authorizeRetryWait({id:'attempt',phase:'commit',retryCount:1,cooldownMs:0,elapsedMs:0},7)).allowed,true);
 assert.equal(a.sendRetryCount,1);assert.equal((await r.client.authorizeRetryWait({id:'attempt',phase:'commit',retryCount:3,cooldownMs:0,elapsedMs:0},7)).code,'RETRY_COUNT_MISMATCH');
});
test('observation wait refreshes only the executing attempt without spending another send retry',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));const a=r.client.state.attempts.attempt;
 Object.assign(a,{phase:'executing',permitId:'permit',enterRequested:true,sendRetryCount:2,maxSendRetries:2});
 r.transport.request=async message=>{r.reports.push(message);return{allowed:true};};
 assert.equal((await r.client.observationWait({id:'attempt',phase:'commit',retryCount:2,elapsedMs:50000},7)).allowed,true);
 const message=r.reports.at(-1);assert.equal(message.type,'DELIVERY_WAIT');assert.equal(message.observationPhase,true);assert.equal(message.retryCount,2);assert.equal(a.sendRetryCount,2);
 assert.equal((await r.client.observationWait({id:'attempt',phase:'commit',retryCount:1,elapsedMs:50000},7)).allowed,false);
 r.client.state.emergencyStopped=true;assert.equal((await r.client.observationWait({id:'attempt',phase:'commit',retryCount:2,elapsedMs:50000},7)).retryable,false);
});

test('COMMIT_PERMIT rejection keeps the exact local gate cause',async()=>{
 for(const [patch,code] of [[r=>{r.client.state.emergencyStopped=true;},'EXECUTION_STOPPED'],[r=>{r.chrome.tabs.get=async()=>({url:'https://discord.com/channels/11111111111111111/99999999999999999'});},'TARGET_MISMATCH']]){
  const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));patch(r);await r.client.handleCommand(cmd('COMMIT_PERMIT'));
  assert.equal(r.state.processed.COMMIT_PERMIT.rejectionCode,code);assert.equal(r.messages.filter(m=>m.type==='DICO_DELIVER').length,0);
 }
});
test('a stop during reporting never prevents delivery-result recovery or causes another Enter',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));const request=r.transport.request;let failures=3;
 r.transport.request=async message=>{if(message.type==='DELIVERY_RESULT'&&failures-->0)throw Object.assign(Error('timeout'),{code:'NATIVE_REQUEST_TIMEOUT',retryable:true});return request(message);};
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));r.client.state.emergencyStopped=true;await r.client.handleCommand(cmd('COMMIT_PERMIT'));
 assert.equal(r.state.attempts.attempt.reported,true);assert.equal(r.state.processed.COMMIT_PERMIT,true);assert.equal(r.messages.filter(m=>m.type==='DICO_DELIVER').length,1);
});

test('페이지 실행이 끝난 뒤 중앙 결과 보고가 느려도 중지 적용 ACK는 기다리지 않는다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 let release,started;const began=new Promise(resolve=>{started=resolve;});const request=r.transport.request;
 r.transport.request=async m=>{if(m.type==='DELIVERY_RESULT'){started();await new Promise(resolve=>{release=resolve;});}return request(m);};
 const sending=r.client.handleCommand(cmd('COMMIT_PERMIT'));await began;
 const stopping=r.client.handleCommand({...cmd('CONTROL','stop-report'),payload:{...payload,action:'stop'}});
 await new Promise(resolve=>setImmediate(resolve));
 const applied=r.reports.some(m=>m.type==='ACK'&&m.commandId==='stop-report'&&m.status==='applied');
 release();await Promise.all([sending,stopping]);
 assert.equal(applied,true);assert.equal(r.state.attempts.attempt.phase,'confirmed');assert.equal(r.state.stoppedGroups.group,true);assert.equal(r.messages.filter(m=>m.type==='DICO_DELIVER').length,1);
});

test('an exact submitted-and-cleared receipt retains failure indicator as diagnostic only',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 r.chrome.tabs.sendMessage=async()=>({...clearedComposerReceipt(),deliveryEvidence:{...clearedComposerReceipt().deliveryEvidence,failedSeen:true}});
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));
 assert.equal(r.state.attempts.attempt.phase,'confirmed');assert.equal(r.reports.find(m=>m.type==='DELIVERY_RESULT').deliveryEvidence.failedSeen,true);
});

test('중단은 발송 응답 대기열을 기다리지 않고 해당 탭에 취소 신호를 전달한다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 let release,started;const ready=new Promise(resolve=>started=resolve);
 const original=r.chrome.tabs.sendMessage;
 r.chrome.tabs.sendMessage=async(id,m)=>{r.messages.push(m);if(m.type==='DICO_DELIVER'){started();return new Promise(resolve=>release=resolve);}if(m.type==='DICO_CANCEL_DELIVERY'){release({status:'uncertain',code:'EXECUTION_STOPPED',deliveryEvidence:{enterAttempted:true}});return{cancelRequested:true};}return original(id,m);};
 const sending=r.client.handleCommand(cmd('COMMIT_PERMIT'));await ready;
 const stopping=r.client.handleCommand({id:'stop-pending',type:'CONTROL',instanceId:'instance',sessionId:'session',payload:{action:'stop',groupId:'group',runId:'run',attemptId:'attempt'}});
 await new Promise(resolve=>setImmediate(resolve));
 const signalled=r.messages.some(m=>m.type==='DICO_CANCEL_DELIVERY'&&m.delivery.id==='attempt');
 if(!signalled)release({status:'uncertain'});
 await Promise.all([sending,stopping]);assert.equal(signalled,true);
 assert.ok(r.reports.some(m=>m.commandId==='stop-pending'&&m.status==='applied'));
});
test('오래된 세션의 중단 명령은 현재 실행의 입력 게이트를 닫지 않는다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 await r.client.handleCommand({...cmd('CONTROL','stale-stop'),sessionId:'old'});
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));
 assert.equal(r.state.attempts.attempt.phase,'confirmed');
});

test('이미 적용된 이전 실행의 중단 재전달은 새 실행을 막지 않는다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 const stop={id:'old-control',type:'CONTROL',instanceId:'instance',sessionId:'session',payload:{action:'stop',groupId:'group',runId:'run',attemptId:'attempt'}};
 await r.client.handleCommand(stop);
 const next={...payload,attemptId:'next',runId:'next-run'};
 await r.client.handleCommand({...cmd('PREPARE','next-prepare'),payload:next});await r.client.handleCommand(stop);
 await r.client.handleCommand({...cmd('COMMIT_PERMIT','next-commit'),payload:{...next,permitId:'next-permit'}});
 assert.equal(r.state.attempts.next.phase,'confirmed');
});

test('자동 복구는 정확한 완료 영수증을 다시 읽고 Enter 없이 결과를 복구한다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 r.chrome.tabs.sendMessage=async(id,m)=>m.type==='DICO_INSPECT'?{ok:true,draftMatches:true,cooldownKnown:true,cooldownMs:0}:{status:'uncertain'};
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));assert.equal(r.state.attempts.attempt.phase,'unknown');
 const calls=[];r.chrome.tabs.sendMessage=async(id,m)=>{calls.push(m.type);return m.type==='DICO_DELIVERY_RECEIPT'?clearedComposerReceipt():{status:'uncertain'};};
 await r.client.handleCommand(cmd('RECONCILE'));
 assert.equal(r.state.attempts.attempt.phase,'confirmed');assert.equal(calls.includes('DICO_DELIVER'),false);
});

test('복구 영수증 조회 중 세션이 바뀌면 과거 성공을 현재 결과로 저장하지 않는다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 r.chrome.tabs.sendMessage=async(id,m)=>m.type==='DICO_INSPECT'?{ok:true,draftMatches:true,cooldownKnown:true,cooldownMs:0}:{status:'uncertain'};
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));
 r.chrome.tabs.sendMessage=async(id,m)=>{if(m.type==='DICO_DELIVERY_RECEIPT'){await r.client.setSession({instanceId:'instance',sessionId:'new-session'});return clearedComposerReceipt();}return{status:'uncertain'};};
 await r.client.handleCommand(cmd('RECONCILE'));
 assert.notEqual(r.state.attempts.attempt.phase,'confirmed');assert.equal(r.reports.some(m=>m.type==='DELIVERY_RESULT'&&m.outcome==='confirmed'),false);
});

test('로컬 완료 저장 후 보고가 유실돼도 현재 복구 명령 ID로 성공을 다시 보고한다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 const original=r.transport.request;r.transport.request=async m=>{if(m.type==='DELIVERY_RESULT')throw Error('report lost');return original(m);};
 r.chrome.tabs.sendMessage=async(id,m)=>m.type==='DICO_INSPECT'?{ok:true,draftMatches:true,cooldownKnown:true,cooldownMs:0}:clearedComposerReceipt();
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));assert.equal(r.state.attempts.attempt.phase,'confirmed');
 r.transport.request=original;await r.client.handleCommand(cmd('RECONCILE','recovery-now'));
 assert.ok(r.reports.some(m=>m.type==='DELIVERY_RESULT'&&m.outcome==='confirmed'&&m.recoveryCommandId==='recovery-now'));
});


test('과거 재시도 옵션은 content 전달 전에 정상 미발송 계속 시도로 정규화한다',async()=>{
 const r=rig();await configured(r);const prepare=cmd('PREPARE');prepare.payload.maxSendRetries=0;await r.client.handleCommand(prepare);
 assert.equal(r.messages.find(m=>m.type==='DICO_PREPARE').delivery.maxSendRetries,null);
 const commit=cmd('COMMIT_PERMIT');commit.payload.maxSendRetries=3;await r.client.handleCommand(commit);
 assert.equal(r.messages.find(m=>m.type==='DICO_DELIVER').delivery.maxSendRetries,null);
});
test('확장 재시작으로 불러온 과거 제한은 제거하고 미확인 상태와 누적 횟수는 보존한다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 Object.assign(r.client.state.attempts.attempt,{maxSendRetries:3,sendRetryCount:6,phase:'unknown'});await r.client.save();
 const restarted=createCentralExecutor({chrome:r.chrome,transport:r.transport});await restarted.load();
 assert.equal(restarted.state.attempts.attempt.maxSendRetries,null);assert.equal(restarted.state.attempts.attempt.sendRetryCount,6);assert.equal(restarted.state.attempts.attempt.phase,'unknown');
});
test('업데이트 전용 maintenance는 실행 차단된 미확인 결과를 보존하고 일반 복구 idle과 구분한다',async()=>{
 for(const phase of ['unknown','needs_review']){
  const r=rig();await configured(r);r.client.state.attempts.blocked={phase,result:{outcome:'unknown',executionBlocked:true},sendRetryCount:12};await r.client.save();
  const before=structuredClone(r.client.state);assert.equal(r.client.isIdle,false);assert.equal(r.client.beginMaintenance(),false);
  assert.equal(r.client.isMaintenanceIdle,true);assert.equal(r.client.beginMaintenance({allowBlocked:true}),true);
  assert.deepEqual(r.client.state,before);r.client.endMaintenance();
 }
});
test('업데이트 maintenance도 활성 전송과 실행 차단 증거 없는 미확인 시도는 허용하지 않는다',async()=>{
 for(const phase of ['preparing','prepared','executing','unknown','needs_review']){
  const r=rig();await configured(r);r.client.state.attempts.active={phase,result:{outcome:'unknown',executionBlocked:!['unknown','needs_review'].includes(phase)}};
  assert.equal(r.client.isMaintenanceIdle,false);assert.equal(r.client.beginMaintenance({allowBlocked:true}),false);
 }
});

test('재연결 설정 동기화는 중앙에서 종료된 준비 실패 기록을 대조해 해제한다',async()=>{
 const r=rig();await configured(r);
 r.chrome.tabs.sendMessage=async(id,m)=>m.type==='DICO_DRAFT_INSPECT'?emptyDraft():{status:'blocked',code:'MANAGED_DELAY_UNAVAILABLE'};
 await r.client.handleCommand(cmd('PREPARE'));
 assert.equal(r.state.attempts.attempt.phase,'preparing');
 await r.client.setSession({instanceId:'instance',sessionId:'reconnected'});
 const request=r.transport.request;r.transport.request=async m=>{await request(m);return m.type==='HEARTBEAT'?{ok:true,terminalAttempts:[{attemptId:'attempt',status:'not_sent'}]}:{ok:true};};
 await r.client.handleCommand({...cmd('CONFIG_SYNC','reconnect-sync'),sessionId:'reconnected',payload:{...payload,attemptId:undefined,configVersion:2}});
 assert.equal(r.state.attempts.attempt.phase,'not_sent');
 assert.equal(r.state.bindings.binding.configVersion,2);
 assert.ok(r.reports.some(m=>m.type==='ACK'&&m.commandId==='reconnect-sync'&&m.status==='applied'));
 assert.equal(r.messages.some(m=>m.type==='DICO_DELIVER'),false);
});

test('설정 동기화 대조에서 미확인 결과 또는 바뀐 세션은 설정 적용을 막는다',async()=>{
 for(const mode of ['unknown','lost','session']){
  const r=rig();await configured(r);
  r.client.state.attempts.previous={...payload,attemptId:'previous',sessionId:'session',phase:'unknown',enterRequested:true};await r.client.save();
  r.transport.request=async m=>{if(m.type==='HEARTBEAT'){if(mode==='lost')throw Error('lost');if(mode==='session')await r.client.setSession({instanceId:'instance',sessionId:'new'});return{ok:true,terminalAttempts:mode==='unknown'?[]:[{attemptId:'previous',status:'not_sent'}]};}return{ok:true};};
  await r.client.handleCommand({...cmd('CONFIG_SYNC','reconnect-sync'),payload:{...payload,attemptId:undefined,configVersion:2}});
  assert.equal(r.state.bindings.binding.configVersion,1,mode);assert.equal(r.state.attempts.previous.phase,'unknown',mode);
  assert.equal(r.messages.some(m=>m.type==='DICO_DELIVER'),false);
 }
});

test('재사용 채널 URL의 마지막 슬래시는 입력 준비 대상을 바꾸지 않는다',async()=>{
 const r=rig();await configured(r);r.chrome.tabs.get=async()=>({id:7,url:`https://discord.com/channels/${payload.guildId}/${payload.channelId}/`});
 await r.client.handleCommand(cmd('PREPARE'));
 assert.equal(r.state.attempts.attempt?.phase,'prepared');
 assert.equal(r.messages.some(m=>m.type==='DICO_DELIVER'),false);
});

for(const stalledType of ['DICO_DRAFT_INSPECT','DICO_INSPECT'])for(const mode of ['stop','timeout'])test(`${stalledType} ${mode}는 준비 권한과 대기열을 해제하며 늦은 응답을 무시한다`,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const r=rig();await configured(r);let release,started;
 const began=new Promise(resolve=>{started=resolve;});
 const original=r.chrome.tabs.sendMessage;
 r.chrome.tabs.sendMessage=async(id,m)=>{
  if(m.type===stalledType){started();return new Promise(resolve=>{release=resolve;});}
  return original(id,m);
 };
 const job=r.client.handleCommand(cmd('PREPARE'));await began;
 const stop=mode==='stop'?r.client.handleCommand({id:'inspection-stop',type:'CONTROL',instanceId:'instance',sessionId:'session',payload:{action:'stop',groupId:'group',runId:'run',attemptId:'attempt'}}):Promise.resolve();
 if(mode==='timeout')t.mock.timers.tick(20001);
 await Promise.all([job,stop]);
 assert.equal(await r.client.canSend({id:'attempt',phase:'prepare'},7),false);
 assert.ok(r.reports.some(x=>x.type==='ACK'&&x.commandId==='PREPARE'&&x.status==='rejected'&&x.rejectionCode===(mode==='stop'?'EXECUTION_STOPPED':'CONTENT_INSPECTION_TIMEOUT')));
 if(mode==='stop')assert.ok(r.reports.some(x=>x.type==='ACK'&&x.commandId==='inspection-stop'&&x.status==='applied'));
 assert.equal(r.state.attempts.attempt.body,'공지');
 assert.equal(r.messages.some(x=>x.type==='DICO_PREPARE'),stalledType==='DICO_INSPECT');
 assert.equal(r.client.isIdle,true);
 const snapshot=structuredClone(r.state);
 release(stalledType==='DICO_DRAFT_INSPECT'?emptyDraft():{ok:true,draftMatches:true,cooldownKnown:true,cooldownMs:0});
 await Promise.resolve();await Promise.resolve();
 assert.deepEqual(r.state,snapshot);
 assert.equal(r.reports.some(x=>x.type==='PREPARED'),false);
 assert.equal(r.messages.some(x=>x.type==='DICO_DELIVER'),false);
});

test('교체 탭에서는 게시 이력만 대조하며 원래 전송 탭의 영수증과 Enter를 재사용하지 않는다',async()=>{
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 r.chrome.tabs.sendMessage=async(id,m)=>m.type==='DICO_INSPECT'?{ok:true,draftMatches:true,cooldownKnown:true,cooldownMs:0}:{status:'uncertain'};
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));
 const originalTab=r.state.attempts.attempt.tabId,calls=[];
 r.chrome.tabs.sendMessage=async(id,m)=>{calls.push({id,type:m.type});return{status:'uncertain'};};
 const recovery=cmd('RECONCILE');recovery.payload.recoveryTabId=999;
 await r.client.handleCommand(recovery);
 assert.ok(calls.some(m=>m.id===999&&m.type==='DICO_RECONCILE'));
 assert.ok(!calls.some(m=>m.id===999&&m.type==='DICO_DELIVERY_RECEIPT'));
 assert.ok(!calls.some(m=>['DICO_DELIVER','DICO_PREPARE'].includes(m.type)));
 assert.equal(r.state.attempts.attempt.tabId,originalTab);assert.equal(r.state.attempts.attempt.phase,'unknown');
});

for(const type of ['DICO_DELIVERY_RECEIPT','DICO_RECONCILE'])for(const action of ['stop','timeout','session','disconnect'])test(`과거 세션 ${type} 미응답도 ${action} 시 조회 대기열을 해제하고 늦은 성공을 버린다`,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const r=rig();await configured(r);await r.client.handleCommand(cmd('PREPARE'));
 r.chrome.tabs.sendMessage=async()=>({status:'uncertain',deliveryEvidence:{phase:'commit',stage:'observe',enterAttempted:true}});
 await r.client.handleCommand(cmd('COMMIT_PERMIT'));await r.client.setSession({instanceId:'instance',sessionId:'new-session'});
 let release,started,settled=false;const began=new Promise(resolve=>{started=resolve;});
 r.chrome.tabs.sendMessage=async(id,m)=>{if(m.type===type){started();return new Promise(resolve=>{release=resolve;});}return{status:'uncertain'};};
 const recovery={...cmd('RECONCILE','historical-query'),sessionId:'new-session',payload:{...payload,originSessionId:'session'}};
 const job=r.client.handleCommand(recovery).then(()=>{settled=true;});await began;
 let stopping=Promise.resolve();
 if(action==='stop')stopping=r.client.handleCommand({...cmd('CONTROL','stop-query'),sessionId:'new-session',payload:{...payload,action:'stop'}});
 if(action==='timeout')t.mock.timers.tick(20001);
 if(action==='session')await r.client.setSession({instanceId:'instance',sessionId:'third-session'});
 if(action==='disconnect')r.client.disconnect();
 await new Promise(resolve=>setImmediate(resolve));
 const beforeLate=settled,stopApplied=r.reports.some(m=>m.type==='ACK'&&m.commandId==='stop-query'&&m.status==='applied');
 // 실패 구현에서도 테스트 정리가 멈추지 않도록 미응답 포트를 먼저 해제합니다.
 release(clearedComposerReceipt());await Promise.all([job,stopping]);
 assert.equal(beforeLate,true,'읽기 조회가 lane을 영구 점유하면 안 됩니다.');
 if(action==='stop')assert.equal(stopApplied,true,'중지 적용 ACK는 늦은 조회 응답을 기다리지 않습니다.');
 assert.equal(r.state.attempts.attempt.phase,'unknown');assert.equal(r.state.attempts.attempt.sessionId,'session');
 assert.equal(r.reports.some(m=>m.type==='DELIVERY_RESULT'&&m.outcome==='confirmed'),false);
 assert.equal(r.client.isMaintenanceIdle,true);
});

test('건너뛴 미확인 시도의 하트비트 반영은 실행만 닫고 미발송으로 바꾸지 않는다',async()=>{
 const {applyTerminalAttempt}=await import('../central/extension/executor.js');
 const a={phase:'unknown',result:{outcome:'unknown',executionBlocked:true}};
 assert.equal(applyTerminalAttempt(a,{status:'skipped_unknown'}),true);
 assert.equal(a.phase,'cancelled');
 assert.equal(a.result.outcome,'unknown');
 assert.equal(a.result.executionBlocked,true);
 assert.equal(a.reported,true);
 assert.equal(applyTerminalAttempt(a,{status:'confirmed',messageId:'123456789012345678'}),false);
});
