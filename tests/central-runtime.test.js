import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCentralApplication} from '../central/runtime/http.mjs';

const origin='http://127.0.0.1:43127',bridgeToken='b'.repeat(64);
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
