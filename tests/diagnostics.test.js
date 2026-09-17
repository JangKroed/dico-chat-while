import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticEvents,recordDiagnostics,diagnosticTextContext,boundedDiagnosticHistory,deliveryTraceEvent} from '../diagnostics.js';
const before={channels:[{id:'1',enabled:true,messages:['SECRET','SECRET'],name:'PRIVATE',ownUserId:'USER',target:{url:'PRIVATE_URL'}}]};
test('자동 중지와 사용자 중지를 구분하고 비공개 필드를 제외한다',()=>{
 const after=structuredClone(before);after.channels[0].enabled=false;after.channels[0].error='연결 끊김';
 const events=diagnosticEvents(before,after,0);
 assert.deepEqual(events.map(e=>e.kind),['error','automatic-stop']);
 assert.equal(/SECRET|PRIVATE|USER/.test(JSON.stringify(events)),false);
 assert.equal(diagnosticEvents(after,after).length,0);
 after.channels[0].error=null;
 assert.equal(diagnosticEvents(before,after)[0].kind,'stopped');
});
test('진단 로그는 최근 500개로 제한된다',async()=>{
 let saved;
 const api={storage:{local:{get:async()=>({diagnosticLog:Array(500).fill({kind:'old'})}),set:async value=>{saved=value;}}}};
 const after=structuredClone(before);after.channels[0].error='오류';
 await recordDiagnostics(api,before,after);
 assert.equal(saved.diagnosticLog.length,500);
 assert.equal(saved.diagnosticLog.at(-1).kind,'error');
});

test('미검증 시도를 전송 성공으로 기록하지 않는다',()=>{
 const before={channels:[{id:'a',enabled:true,pending:{id:'delivery'},lastSentAt:null}]};
 const after={channels:[{id:'a',enabled:true,pending:null,lastSentAt:100,lastOutcome:'unverified'}]};
 const events=diagnosticEvents(before,after);assert.ok(events.some(e=>e.kind==='delivery-unverified'));
 assert.equal(events.some(e=>e.kind==='delivery-confirmed'),false);
});

test('채널 순서가 바뀌어도 설정·채팅방·탭 식별자와 이전 주기를 추적한다',()=>{
 const a={id:'stable-a',intervalSeconds:63,settingsRevision:1,target:{guildId:'123',channelId:'456',tabId:7}};
 const b={id:'stable-b',intervalSeconds:123,target:{guildId:'123',channelId:'789',tabId:8}};
 const events=diagnosticEvents({channels:[a,b]},{revision:9,channels:[b,{...a,intervalSeconds:93,settingsRevision:2}]},1000);
 const e=events.find(e=>e.kind==='settings-changed');
 assert.equal(e.channelKey,'stable-a');assert.equal(e.channel,2);assert.equal(e.discordChannelId,'456');
 assert.equal(e.tabId,7);assert.equal(e.previousIntervalSeconds,63);assert.equal(e.intervalSeconds,93);assert.equal(e.rootRevision,9);
});

test('팝업에 표시된 값과 저장된 값을 나란히 남겨 채널 혼선을 구분한다',async()=>{
 const {uiDiagnostic}=await import('../diagnostics.js');
 const state={revision:8,channels:[{id:'a',intervalSeconds:63,target:{channelId:'456'}},{id:'b',intervalSeconds:123,target:{channelId:'789'}}]};
 const e=uiDiagnostic({channelKey:'a',formChannelKey:'b',displayedIntervalSeconds:123,displayedDiscordChannelId:'789',displayedRootRevision:7,displayedNextRunAt:6000,displayedRemainingSeconds:5,text:'SECRET'},state,1000);
 assert.equal(e.channelKey,'a');assert.equal(e.formChannelKey,'b');assert.equal(e.intervalSeconds,63);assert.equal(e.displayedIntervalSeconds,123);
 assert.equal(e.discordChannelId,'456');assert.equal(e.displayedDiscordChannelId,'789');assert.equal(e.rootRevision,8);assert.equal(e.displayedRootRevision,7);
 assert.equal(JSON.stringify(e).includes('SECRET'),false);
 assert.equal(uiDiagnostic({channelKey:'missing'},state),null);
});

test('상세 로그가 밀려도 Enter와 설정 변경 타임라인은 보존한다',async()=>{
 const {appendDiagnostics}=await import('../diagnostics.js');let saved={diagnosticLog:[],diagnosticTimeline:[]};
 const api={storage:{local:{get:async()=>saved,set:async v=>{saved={...saved,...v};}}}};
 await appendDiagnostics(api,[{kind:'settings-changed',channelKey:'a'},{kind:'delivery-trace',stage:'enter-dispatched',channelKey:'a'},...Array.from({length:600},()=>({kind:'delivery-trace',stage:'observation'}))]);
 assert.equal(saved.diagnosticLog.length,500);assert.equal(saved.diagnosticTimeline.length,2);
 assert.equal(saved.diagnosticTimeline[0].kind,'settings-changed');assert.equal(saved.diagnosticTimeline[1].stage,'enter-dispatched');
});

test('남은 초안의 A/B 일치 여부와 길이만 기록하며 원문은 버린다',async()=>{
 const {inspectionDiagnostic}=await import('../diagnostics.js');
 const e=inspectionDiagnostic({code:'DRAFT_MISMATCH',diagnostics:{draftLength:109,expectedLength:108,draftMatchesA:false,draftMatchesB:false,whitespaceOnlyDifference:true,draftHasVoid:false,body:'SECRET',token:'SECRET'}},{id:'a',target:{tabId:7}},0,2);
 assert.equal(e.kind,'inspection-failed');assert.equal(e.code,'DRAFT_MISMATCH');assert.equal(e.expectedLength,108);assert.equal(e.draftMatchesA,false);assert.equal(e.whitespaceOnlyDifference,true);assert.equal(JSON.stringify(e).includes('SECRET'),false);
});

test('문구 원문·개행·이모지와 최초 차이 위치를 남기며 추가 비공개 필드는 버린다',()=>{
 const data=diagnosticTextContext({expected:'공지 :moneybag:\n A',actual:'공지 💰\n A',rendered:'공지 :moneybag:\n\n A',messageA:'A',messageB:'B',token:'SECRET'});
 assert.equal(data.expected,'공지 :moneybag:\n A');assert.equal(data.actual,'공지 💰\n A');assert.equal(data.firstDifferenceIndex,3);assert.equal(data.token,undefined);
 const long=diagnosticTextContext({actual:'x'.repeat(5000)});assert.equal(long.actual.length,4000);assert.deepEqual(long.truncatedFields,['actual']);
});
test('상세 로그와 타임라인은 본문 용량 한도 내에서 최신 기록을 보존한다',()=>{
 const records=Array.from({length:30},(_,i)=>({index:i,text:'가'.repeat(2000)}));
 const kept=boundedDiagnosticHistory(records,20,20000);assert.equal(kept.at(-1).index,29);assert.ok(kept.length<20);
 assert.ok(kept.reduce((sum,e)=>sum+JSON.stringify(e).length*2,0)<=20000);
});
test('오류 전송 로그에 본문을 보존하고 잘못된 전송 ID는 거부한다',()=>{
 const state={channels:[{id:'a',target:{tabId:7},prepared:{id:'attempt'}}]};
 const message={id:'attempt',stage:'stability-failed',data:{textContext:{expected:'A :moneybag:',actual:'A 💰',messageA:'A :moneybag:',messageB:'B',token:'SECRET'}}};
 assert.equal(deliveryTraceEvent(message,state,7).textContext.actual,'A 💰');
 assert.equal(deliveryTraceEvent(message,state,8),null);
 assert.equal(deliveryTraceEvent({...message,stage:'observation'},state,7).textContext.actual,'A 💰');
});

test('충돌 후보와 마지막 확인 게시 ID를 채널별 진단에 보존한다',()=>{
 const state={channels:[{id:'one',target:{tabId:7},pending:{id:'delivery'},lastConfirmedMessageId:'1548966122731216936'}]};
 const event=deliveryTraceEvent({id:'delivery',stage:'prior-post-check',data:{messageId:'1548966122731216937',reconciliationReason:'next-already-posted'}},state,7,1000);
 assert.equal(event.messageId,'1548966122731216937');
 assert.equal(event.lastConfirmedMessageId,'1548966122731216936');
});
