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
