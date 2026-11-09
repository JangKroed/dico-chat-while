import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCentralApplication} from '../central/runtime/http.mjs';

const origin='http://127.0.0.1:43127',bridgeToken='b'.repeat(64);
test('읽기 전용 Native 상태 응답은 설치 파일과 별개인 실행 중앙 버전을 반환한다',async t=>{
 const app=createCentralApplication({manager:manager(),origin,bridgeToken,appVersion:'0.4.44'});t.after(()=>app.close());
 const r=await request(app,'/api/bridge/status',{headers:{authorization:`Bearer ${bridgeToken}`}});
 assert.equal(JSON.parse(r.body).appVersion,'0.4.44');assert.equal(r.body.includes(bridgeToken),false);
});
test('진단 이벤트 폭주가 발송 처리 안에서 매번 전체 화면을 계산하지 않는다',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let push,reads=0,revision=0,onClose;
 const chunks=[],m={...manager(),snapshot:()=>{reads++;return{revision};},subscribe:fn=>{push=fn;return()=>{};}};
 const app=createCentralApplication({manager:m,origin,bridgeToken});t.after(()=>app.close());
 const session=await request(app,'/api/session',{method:'POST',body:{token:app.issueBootstrap()},headers:{origin}});
 const req=Readable.from([]);req.method='GET';req.url='/api/events';req.headers={host:new URL(origin).host,cookie:session.headers['set-cookie'].split(';')[0]};
 const res={setHeader(){},writeHead(){},write:v=>chunks.push(v),end:()=>onClose?.(),on:(type,fn)=>{if(type==='close')onClose=fn;}};
 await app.handler(req,res);assert.equal(reads,1);
 for(let i=1;i<=100;i++){revision=i;push({type:'delivery.trace',eventId:i});}
 // 이벤트 이력은 모두 전달하지만 비싼 전체 화면 계산은 발송 호출 밖에서 합칩니다.
 assert.equal(chunks.filter(v=>v.includes('event: event')).length,100);assert.equal(reads,1);
 t.mock.timers.tick(50);await Promise.resolve();assert.equal(reads,2);
 assert.ok(chunks.at(-1).includes('"revision":100'));
 push({type:'delivery.trace',eventId:101});await app.close();t.mock.timers.tick(100);assert.equal(reads,2);
});
test('화면 갱신 예약 뒤 세션이 만료되면 최신 상태를 읽거나 전송하지 않는다',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let time=100000,push,reads=0,ended=0,onClose;
 const m={...manager(),snapshot:()=>{reads++;return{};},subscribe:fn=>{push=fn;return()=>{};}};
 const app=createCentralApplication({manager:m,origin,bridgeToken,now:()=>time});t.after(()=>app.close());
 const session=await request(app,'/api/session',{method:'POST',body:{token:app.issueBootstrap()},headers:{origin}});
 const req=Readable.from([]);req.method='GET';req.url='/api/events';req.headers={host:new URL(origin).host,cookie:session.headers['set-cookie'].split(';')[0]};
 await app.handler(req,{setHeader(){},writeHead(){},write(){},end(){ended++;onClose?.();},on(type,fn){if(type==='close')onClose=fn;}});
 push({type:'delivery.trace',eventId:1});time+=1e12;t.mock.timers.tick(50);await Promise.resolve();
 assert.equal(reads,1);assert.equal(ended,1);
});
function manager() {
  const state={stateVersion:1,messages:[],groups:[],incidents:[]};
  return {snapshot:()=>state,events:()=>[],analytics:()=>({}),subscribe:()=>()=>{},execute:(action,payload)=>({action,payload}),bridge:(m,id)=>({message:m.type,instanceId:id}),commands:()=>[]};
}
async function request(app,path,{method='GET',body,headers={},cookie}={}) {
  const req=Readable.from(body===undefined?[]:[typeof body==='string'?body:JSON.stringify(body)]);
  req.method=method;req.url=path;req.headers={host:new URL(origin).host,...(body!==undefined?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...headers};
  return new Promise((resolve,reject)=>{
    const result={status:200,headers:{},body:''};
    const res={setHeader:(k,v)=>{result.headers[k.toLowerCase()]=v;},writeHead:(s,h)=>{result.status=s;Object.assign(result.headers,h);},end:t=>{result.body+=t || '';resolve(result);},on(){}};
    Promise.resolve(app.handler(req,res)).catch(reject);
  });
}
test('UI 부트스트랩은 일회용이며 쿠키 세션과 CSRF 없이는 명령을 실행할 수 없다',async()=>{
  const app=createCentralApplication({manager:manager(),origin,bridgeToken});
  assert.equal((await request(app,'/api/snapshot')).status,401);
  const token=app.issueBootstrap();
  const session=await request(app,'/api/session',{method:'POST',body:{token},headers:{origin}});
  assert.equal(session.status,200);
  const csrf=JSON.parse(session.body).csrfToken,cookie=session.headers['set-cookie'].split(';')[0];
  assert.equal((await request(app,'/api/session',{method:'POST',body:{token},headers:{origin}})).status,401);
  assert.equal((await request(app,'/api/command',{method:'POST',body:{action:'service.stopAll'},cookie,headers:{origin}})).status,403);
  const command=await request(app,'/api/command',{method:'POST',body:{action:'service.stopAll',payload:{}},cookie,headers:{origin,'x-dico-csrf':csrf}});
  assert.equal(command.status,200);assert.equal(JSON.parse(command.body).result.action,'service.stopAll');
  assert.equal((await request(app,'/api/snapshot',{cookie,headers:{host:'evil.example'}})).status,403);
  assert.equal((await request(app,'/api/command',{method:'POST',cookie,body:{action:'service.stopAll'},headers:{origin:'https://evil.example','x-dico-csrf':csrf}})).status,403);
});
test('네이티브 API 자격은 UI API에서 사용되지 않고 토큰은 응답에 노출되지 않는다',async()=>{
  const app=createCentralApplication({manager:manager(),origin,bridgeToken});
  assert.equal((await request(app,'/api/bridge/status')).status,401);
  const headers={authorization:`Bearer ${bridgeToken}`};
  const status=await request(app,'/api/bridge/status',{headers});assert.equal(status.status,200);assert.equal(status.body.includes(bridgeToken),false);
  assert.equal((await request(app,'/api/snapshot',{headers})).status,401);
  assert.equal((await request(app,'/api/bridge',{method:'POST',headers:{...headers,origin:'https://evil.example'},body:{message:{type:'HELLO'}}})).status,403);
  const bridge=await request(app,'/api/bridge',{method:'POST',headers,body:{instanceId:'one',message:{type:'HELLO'}}});
  assert.equal(JSON.parse(bridge.body).instanceId,'one');
});
test('중앙 정적 파일은 origin 검증과 CSP를 적용하고 디렉터리 탈출을 거부한다',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'dico-ui-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'index.html'),'<h1>DICO</h1>');
  const app=createCentralApplication({manager:manager(),origin,bridgeToken,uiDirectory:dir});
  const page=await request(app,'/messages');assert.equal(page.status,200);assert.match(page.body,/DICO/);assert.match(page.headers['content-security-policy'],/default-src 'self'/);
  assert.equal((await request(app,'/%2e%2e/%2e%2e/package.json')).status,404);
});

test('설치 진단은 UI 세션이 필요하며 읽기 전용 provider만 호출한다',async()=>{
  let count=0;
  const app=createCentralApplication({manager:manager(),origin,bridgeToken,setupStatus:async()=>{count++;return{ready:false,checkedAt:1,checks:[]};}});
  assert.equal((await request(app,'/api/setup-status')).status,401);assert.equal(count,0);
  const response=await request(app,'/api/session',{method:'POST',body:{token:app.issueBootstrap()},headers:{origin}});
  const cookie=response.headers['set-cookie'].split(';')[0];
  const status=await request(app,'/api/setup-status',{cookie});assert.equal(status.status,200);assert.equal(JSON.parse(status.body).ready,false);assert.equal(count,1);
  assert.equal((await request(app,'/api/setup-status',{method:'POST',body:{command:'install'},cookie,headers:{origin}})).status,403);
});
test('remote browser links require the current UI session and CSRF, expire, and can be used once',async()=>{
 let at=100000;const app=createCentralApplication({manager:manager(),origin,bridgeToken,now:()=>at});
 try{
  assert.equal((await request(app,'/api/remote-access-link',{method:'POST',body:{},headers:{origin}})).status,401);
  const session=await request(app,'/api/session',{method:'POST',body:{token:app.issueBootstrap()},headers:{origin}});
  const cookie=session.headers['set-cookie'].split(';')[0],csrf=JSON.parse(session.body).csrfToken;
  assert.equal((await request(app,'/api/remote-access-link',{method:'POST',body:{},cookie,headers:{origin}})).status,403);
  const make=()=>request(app,'/api/remote-access-link',{method:'POST',body:{},cookie,headers:{origin,'x-dico-csrf':csrf}});
  const link=await make();assert.equal(link.status,200);assert.equal(link.body.includes(bridgeToken),false);
  const result=JSON.parse(link.body);assert.equal(result.expiresAt,at+120000);assert.equal(new URL(result.url).origin,origin);
  const token=new URLSearchParams(new URL(result.url).hash.slice(1)).get('bootstrap');
  at+=119000;
  assert.equal((await request(app,'/api/session',{method:'POST',body:{token},headers:{origin}})).status,200);
  assert.equal((await request(app,'/api/session',{method:'POST',body:{token},headers:{origin}})).status,401);
  const expired=JSON.parse((await make()).body);at+=120001;
  assert.equal((await request(app,'/api/session',{method:'POST',body:{token:new URLSearchParams(new URL(expired.url).hash.slice(1)).get('bootstrap')},headers:{origin}})).status,401);
 }finally{app.close();}
});

test('retained history and log pages require UI authentication and forward bounded page cursors and filters',async()=>{const calls=[];const paged={...manager(),historyPage:options=>{calls.push(['history',options]);return{items:[{id:'older'}],nextCursor:'older',retentionDays:90};},eventPage:options=>{calls.push(['logs',options]);return{items:[{eventId:20}],nextCursor:'20',retentionDays:90};}};const app=createCentralApplication({manager:paged,origin,bridgeToken});try{assert.equal((await request(app,'/api/history')).status,401);assert.equal((await request(app,'/api/logs?paged=1')).status,401);assert.equal(calls.length,0);const session=await request(app,'/api/session',{method:'POST',body:{token:app.issueBootstrap()},headers:{origin}}),cookie=session.headers['set-cookie'].split(';')[0];const history=await request(app,'/api/history?cursor=older&limit=99999&query=prior&status=unknown&from=100&to=200',{cookie});assert.equal(history.status,200);assert.equal(JSON.parse(history.body).nextCursor,'older');assert.deepEqual(calls[0],['history',{cursor:'older',limit:500,query:'prior',status:'unknown',level:undefined,from:100,to:200}]);const logs=await request(app,'/api/logs?paged=1&cursor=21&level=ERROR',{cookie});assert.equal(logs.status,200);assert.equal(calls[1][0],'logs');assert.equal(calls[1][1].cursor,'21');assert.equal(calls[1][1].level,'ERROR');assert.equal((await request(app,'/api/logs?after=0',{cookie})).status,200);}finally{await app.close();}});

test('automatic support controls require UI auth and CSRF; inbound reports use a separate receiver credential',async t=>{
 let configured=0,queued=0,received=0;
 const supportDelivery={status:()=>({configured:true,settings:{enabled:true},counts:{queued:0}}),configure:p=>{configured++;return{settings:p};},queue:async()=>{queued++;return{id:'report',status:'queued'};},flush:async()=>{},inbox:()=>[],get:()=>({report:{reportId:'report'}}),receiverKey:()=>({token:'dedicated-receiver-token'}),authorizeReceiver:value=>value==='Bearer receiver',receive:async()=>{received++;return{receiptId:'receipt'};}};
 const app=createCentralApplication({manager:manager(),origin,bridgeToken,supportDelivery});t.after(()=>app.close());
 assert.equal((await request(app,'/api/support/automatic')).status,401);
 const session=await request(app,'/api/session',{method:'POST',body:{token:app.issueBootstrap()},headers:{origin}}),cookie=session.headers['set-cookie'].split(';')[0],csrf=JSON.parse(session.body).csrfToken;
 assert.equal((await request(app,'/api/support/automatic',{method:'POST',body:{enabled:true},cookie,headers:{origin}})).status,403);
 assert.equal((await request(app,'/api/support/automatic',{method:'POST',body:{enabled:true},cookie,headers:{origin,'x-dico-csrf':csrf}})).status,200);assert.equal(configured,1);
 assert.equal((await request(app,'/api/support/send',{method:'POST',body:{},cookie,headers:{origin,'x-dico-csrf':csrf}})).status,202);assert.equal(queued,1);
 assert.equal((await request(app,'/api/support/receive',{method:'POST',body:{report:{}},headers:{authorization:`Bearer ${bridgeToken}`}})).status,401);
 assert.equal((await request(app,'/api/support/receive',{method:'POST',body:{report:{}},headers:{authorization:'Bearer receiver'}})).status,202);assert.equal(received,1);
});

test('재시작 중 설정 경로는 복구 화면을 반환하고 API와 외부 Host는 분리한다',async()=>{
 const app=createCentralApplication({manager:manager(),origin,bridgeToken});
 await app.close();
 const page=await request(app,'/settings');
 assert.equal(page.status,503);
 assert.match(page.headers['content-type'],/^text\/html/);
 assert.match(page.headers['content-security-policy'],/script-src 'nonce-[a-f0-9]+'/);
 assert.match(page.body,/fetch\('\/api\/access-mode'/);
 const api=await request(app,'/api/access-mode');
 assert.equal(api.status,503);
 assert.match(api.headers['content-type'],/^application\/json/);
 assert.equal((await request(app,'/settings',{headers:{host:'example.com'}})).status,403);
});

test('최신 업데이트 확인은 인증된 로컬 설정 화면에서 실행 버전을 비교한다',async t=>{
 const calls=[];
 const updates={latest:async version=>{calls.push(version);return{state:'current',currentVersion:version,latestVersion:version,checkedAt:1};}};
 const app=createCentralApplication({manager:manager(),origin,bridgeToken,updates,appVersion:'0.4.51'});
 t.after(()=>app.close());
 assert.equal((await request(app,'/api/updates/latest')).status,401);
 assert.deepEqual(calls,[]);
 const session=await request(app,'/api/session',{method:'POST',body:{token:app.issueBootstrap()},headers:{origin}});
 const response=await request(app,'/api/updates/latest',{cookie:session.headers['set-cookie'].split(';')[0]});
 assert.equal(response.status,200);
 assert.equal(JSON.parse(response.body).state,'current');
 assert.deepEqual(calls,['0.4.51']);
});
test('자동 실행 프로필 조회는 로그인 필요하고 발견하지 않은 경로는 저장하지 않는다',async t=>{
 const app=createCentralApplication({manager:manager(),origin,bridgeToken,browserPreparation:{list:async()=>[{id:'Chrome:Default',browser:'Chrome'}],status:()=>[]}});t.after(()=>app.close());
 assert.equal((await request(app,'/api/browser-profiles')).status,401);
 const login=await request(app,'/api/session',{method:'POST',body:{token:app.issueBootstrap()},headers:{origin}}),session=JSON.parse(login.body);
 const headers={origin,cookie:login.headers['set-cookie'].split(';')[0],'x-dico-csrf':session.csrfToken};
 assert.equal((await request(app,'/api/browser-profiles',{headers})).status,200);
 assert.equal((await request(app,'/api/command',{method:'POST',headers,body:{action:'instance.setLaunchProfile',payload:{id:'i',profileId:'/arbitrary/command'}}})).status,400);
 assert.equal((await request(app,'/api/command',{method:'POST',headers,body:{action:'instance.setLaunchProfile',payload:{id:'i',profileId:'Chrome:Default'}}})).status,200);
});
