import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,createCoordinatorServer} from '../coordinator/server.js';
import {createCoordinator} from '../coordinator/core.js';
import {coordinationRequest,normalizeCoordination} from '../coordination.js';
import {Readable} from 'node:stream';
const token='a'.repeat(32),member='11111111111111111',channelId='44444444444444444';
const config={groups:{notice:{members:[member,'22222222222222222'],channelId,gapSeconds:1}}};
function handlerFetch(server) {
  return async(url,options={})=>new Promise((resolve,reject)=>{
    const req=Readable.from(options.body?[options.body]:[]);
    req.method=options.method || 'GET';req.url=new URL(url).pathname;
    req.headers=Object.fromEntries(Object.entries(options.headers || {}).map(([k,v])=>[k.toLowerCase(),v]));
    let status=200;
    const res={setHeader(){},writeHead:code=>{status=code;},end:text=>resolve(new Response(text,{status}))};
    try {server.emit('request',req,res);} catch(error){reject(error);}
  });
}
test('클라이언트 → HTTP 요청 처리 → 영속 허가 → 완료까지 소켓 없이 검증한다',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'dico-handler-')),store=await openStore(dir);
  t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true});});
  const core=createCoordinator(config,{...store,now:()=>100000});
  const server=createCoordinatorServer({core,token}),fetchImpl=handlerFetch(server);
  const url='http://127.0.0.1:43127';
  assert.equal((await fetchImpl(url+'/status')).status,401);
  assert.equal((await fetchImpl(url+'/status',{headers:{Authorization:`Bearer ${token}`,Origin:'https://evil.test'}})).status,403);
  const state={coordination:{url,token,group:'notice',clientId:'client-a'},ownUserId:member,target:{channelId}};
  const delivery={id:'handler-attempt'};
  assert.equal((await coordinationRequest('acquire',state,delivery,{fetchImpl})).allowed,true);
  await assert.rejects(()=>coordinationRequest('acquire',state,delivery,{fetchImpl}));
  await coordinationRequest('finish',state,{...delivery,coordinationOutcome:'confirmed'},{fetchImpl});
  await coordinationRequest('finish',state,{...delivery,coordinationOutcome:'confirmed'},{fetchImpl});
  const persisted=JSON.parse(await readFile(join(dir,'state.json'),'utf8'));
  assert.equal(persisted.groups.notice.turn,1);
  assert.equal((await fetchImpl(url+'/acquire',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:'{}'})).status,415);
  assert.equal((await fetchImpl(url+'/acquire',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{broken'})).status,409);
});
test('실제 HTTP 허가·완료, 인증 및 웹 출처 차단, 상태 파일 재시작 복구',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'dico-coordinator-'));
  let store=await openStore(dir);
  let server;
  let storeClosed=false;
  t.after(async()=>{if(server?.listening)await new Promise(resolve=>server.close(resolve));if(!storeClosed)await store.close();await rm(dir,{recursive:true,force:true});});
  await assert.rejects(()=>openStore(dir),/EEXIST/);
  let core=createCoordinator(config,{...store,now:()=>100000});
  server=createCoordinatorServer({core,token});
  try { await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);}); }
  catch(error) {await store.close();storeClosed=true;if(error.code==='EPERM')return t.skip('실행 환경에서 loopback 포트 열기를 허용하지 않음');throw error;}
  const url=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url+'/status')).status,401);
  assert.equal((await fetch(url+'/status',{headers:{Authorization:`Bearer ${token}`,Origin:'https://evil.test'}})).status,403);
  const state={coordination:{url,token,group:'notice',clientId:'client-a'},ownUserId:member,target:{channelId}};
  const delivery={id:'http-attempt'};
  assert.equal((await coordinationRequest('acquire',state,delivery)).allowed,true);
  assert.equal((await readFile(join(dir,'state.json'),'utf8')).includes(token),false);
  await store.close();store=await openStore(dir);
  core=createCoordinator(config,{...store,now:()=>900000000});
  const restarted=createCoordinatorServer({core,token});
  await new Promise(resolve=>restarted.listen(0,'127.0.0.1',resolve));
  try {
    const other={...state,coordination:{...state.coordination,url:`http://127.0.0.1:${restarted.address().port}`}};
    await assert.rejects(()=>coordinationRequest('acquire',other,delivery));
    await coordinationRequest('finish',other,{...delivery,coordinationOutcome:'confirmed'});
    await coordinationRequest('finish',other,{...delivery,coordinationOutcome:'confirmed'});
    assert.equal((await core.status()).notice.turn,'22222222222222222');
  } finally {await new Promise(resolve=>restarted.close(resolve));}
});
test('손상된 상태를 빈 상태로 초기화하지 않는다',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'dico-corrupt-'));const store=await openStore(dir);
  t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true});});
  await writeFile(join(dir,'state.json'),'{broken');
  const core=createCoordinator(config,{...store,now:Date.now});
  await assert.rejects(()=>core.status());
  assert.equal(await readFile(join(dir,'state.json'),'utf8'),'{broken');
});
test('조정기 클라이언트는 리디렉션·쿠키를 차단하며 토큰 없는 일반 오류를 반환한다',async()=>{
  const state={coordination:{url:'http://127.0.0.1:43127',token,group:'notice',clientId:'client-a'},ownUserId:member,target:{channelId}};
  await assert.rejects(()=>coordinationRequest('acquire',state,{id:'attempt'},{fetchImpl:async(url,options)=>{
    assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(JSON.parse(options.body).member,member);throw Error(token);
  }}),error=>!error.message.includes(token));
  for (const url of ['http://public.test','http://user:password@localhost','http://localhost/path','file:///tmp/test','http://localhost/?token=secret']) assert.throws(()=>normalizeCoordination({...state.coordination,url}));
});
