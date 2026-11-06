import test from 'node:test';
import assert from 'node:assert/strict';
import {observeDiscordSendRequests} from '../central/extension/send-network.js';
import {traceData,validTraceStage} from '../central/extension/delivery-trace.js';

function setup() {
 const hooks={},traces=[];
 const webRequest=Object.fromEntries(['onBeforeRequest','onCompleted','onErrorOccurred'].map(name=>[name,{
  addListener(fn,filter,...extra){assert.deepEqual(extra,[]);assert.deepEqual(filter.types,['xmlhttprequest']);hooks[name]=fn;},
  removeListener(){delete hooks[name];},
 }]));
 const a={attemptId:'a',phase:'executing',enterRequested:true,tabId:5,channelId:'123',sessionId:'s',sendRetryCount:4};
 const executor={state:{sessionId:'s',attempts:{a}}};
 assert.equal(observeDiscordSendRequests(webRequest,executor,(message,tabId)=>traces.push({message,tabId})),true);
 const post={method:'POST',url:'https://discord.com/api/v10/channels/123/messages',initiator:'https://discord.com',type:'xmlhttprequest',tabId:5,frameId:0,requestId:'private-id',timeStamp:1000,requestBody:{secret:'private-body'},requestHeaders:[{name:'Authorization',value:'private-token'}]};
 return {hooks,traces,executor,a,post};
}

test('관리 탭의 같은 채널 POST와 429 응답을 요청 내용 없이 연결한다',()=>{
 const {hooks,traces,post,a}=setup();
 hooks.onBeforeRequest(post);
 a.phase='confirmed';
 hooks.onCompleted({...post,timeStamp:1040,statusCode:429});
 assert.deepEqual(traces,[{tabId:5,message:{id:'a',stage:'network-start',data:{eventAt:1000,retryCount:4,networkOrdinal:1}}},{tabId:5,message:{id:'a',stage:'network-result',data:{eventAt:1040,retryCount:4,networkOrdinal:1,httpStatus:429,networkDurationMs:40}}}]);
 for(const {message} of traces){assert.equal(validTraceStage(message.stage),true);assert.deepEqual(traceData(message.data),message.data);}
});

test('다른 탭·채널·출처의 요청과 이전 세션 응답은 무시한다',()=>{
 const {hooks,traces,post,executor}=setup();
 for(const patch of [{tabId:6},{frameId:1},{method:'GET'},{initiator:'https://example.com'},{url:post.url.replace('/123/','/456/')},{url:post.url+'/456'}])hooks.onBeforeRequest({...post,...patch});
 assert.equal(traces.length,0);
 hooks.onBeforeRequest(post);
 executor.state.sessionId='next';
 hooks.onErrorOccurred({...post,error:'private-text',timeStamp:1040});
 assert.equal(traces.length,1);
});

test('관측 한도 이후 요청을 보관하지 않고 네트워크 실패 원문도 버린다',()=>{
 const {hooks,traces,post}=setup();
 for(let i=0;i<13;i++){
  const p={...post,requestId:String(i)};
  hooks.onBeforeRequest(p);
  hooks.onErrorOccurred({...p,timeStamp:1010,error:'private-error'});
 }
 assert.equal(traces.length,24);
 assert.deepEqual(traces.at(-1).message.data,{eventAt:1010,retryCount:4,networkOrdinal:12,networkDurationMs:10,networkError:true});
 assert.doesNotMatch(JSON.stringify(traces),/private|discord\.com/);
});

test('다른 경로로 리디렉션된 최종 응답을 메시지 POST 결과로 기록하지 않는다',()=>{
 const {hooks,traces,post}=setup();
 hooks.onBeforeRequest(post);
 hooks.onCompleted({...post,method:'GET',url:post.url+'/456',timeStamp:1040,statusCode:200});
 assert.deepEqual(traces.map(x=>x.message.stage),['network-start']);
});
