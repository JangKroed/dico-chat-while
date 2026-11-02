import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createCentralApplication} from '../central/runtime/http.mjs';

const localOrigin='http://127.0.0.1:43127',lanOrigin='http://192.168.1.20:43128',bridgeToken='b'.repeat(64);
function fixture(options={}){
  let code='12345678',consumed=0,saves=0;
  const manager={snapshot:()=>({private:'workspace'}),analytics:()=>({}),events:()=>[],commands:()=>[],subscribe:()=>()=>{},execute:(action,payload)=>({action,payload}),bridge:()=>{throw Error('bridge must not execute');}};
  const app=createCentralApplication({manager,origin:lanOrigin,mode:'lan',pairingCodes:{consume(value){consumed++;if(value!==code)return false;code='used';return true;}},saveSessions:async()=>saves++,...options});
  return{app,consumed:()=>consumed,saves:()=>saves};
}
async function request(app,path,{origin=lanOrigin,method='GET',body,headers={},cookie}={}){
  const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);req.url=path;req.method=method;req.headers={host:new URL(origin).host,...(body!==undefined?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...headers};req.socket={remoteAddress:'192.168.1.30'};
  const result={status:200,headers:{},body:''};let finish;
  const done=new Promise(resolve=>{finish=resolve;});
  const res={setHeader(k,v){result.headers[k.toLowerCase()]=v;},writeHead(status){result.status=status;},end(value=''){result.body+=value;finish();},on(){},write(value){result.body+=value;finish();}};
  await app.handler(req,res);await done;return result;
}
async function login(app){const reply=await request(app,'/api/session',{method:'POST',body:{pairingCode:'12345678'},headers:{origin:lanOrigin}});assert.equal(reply.status,200);return{cookie:reply.headers['set-cookie'].split(';')[0],csrf:JSON.parse(reply.body).csrfToken};}

test('LAN exposes only access mode before authentication, never snapshots, logs, SSE or native bridge',async()=>{
  const {app}=fixture();try{
    const mode=await request(app,'/api/access-mode');assert.equal(mode.status,200);assert.deepEqual(JSON.parse(mode.body),{mode:'lan'});
    for(const path of ['/api/snapshot','/api/events','/api/logs','/api/history','/api/backup','/api/analytics'])assert.equal((await request(app,path)).status,401,path);
    for(const path of ['/api/bridge','/api/bridge/open','/api/bridge/status','/api/bridge/commands','/api/lan-access','/api/lan-access/pair','/api/remote-access-link'])assert.equal((await request(app,path,{method:'POST',body:{},headers:{authorization:`Bearer ${bridgeToken}`,origin:lanOrigin}})).status,404,path);
  }finally{await app.close();}
});

test('LAN pairing issues an isolated session, requires exact origin and CSRF and consumes code once',async()=>{
  const {app,consumed,saves}=fixture();try{
    const wrong=await request(app,'/api/session',{method:'POST',body:{pairingCode:'12345678'},headers:{origin:'http://evil.example'}});assert.equal(wrong.status,403);assert.equal(consumed(),0);
    const {cookie,csrf}=await login(app);assert.match(cookie,/^dico_lan_session=/);assert.equal(saves(),0);
    assert.equal((await request(app,'/api/session',{method:'POST',body:{pairingCode:'12345678'},headers:{origin:lanOrigin}})).status,401);
    assert.equal((await request(app,'/api/snapshot',{cookie})).status,200);
    assert.equal((await request(app,'/api/command',{method:'POST',body:{action:'group.stop',payload:{id:'group'}},cookie,headers:{origin:lanOrigin}})).status,403);
    const applied=await request(app,'/api/command',{method:'POST',body:{action:'group.stop',payload:{id:'group'}},cookie,headers:{origin:lanOrigin,'x-dico-csrf':csrf}});assert.equal(applied.status,200);assert.deepEqual(JSON.parse(applied.body).result,{action:'group.stop',payload:{id:'group'}});
    assert.equal((await request(app,'/api/snapshot',{cookie,headers:{host:'other.example:43128'}})).status,403);
    assert.equal((await request(app,'/api/remote-access-link',{method:'POST',body:{},cookie,headers:{origin:lanOrigin,'x-dico-csrf':csrf}})).status,404);
  }finally{await app.close();}assert.equal(saves(),0);
});

test('LAN pairing brute-force budget is bounded across clients and recovers after the fixed window',async()=>{
  let time=100000;const {app,consumed}=fixture({now:()=>time});try{
    for(let i=0;i<10;i++)assert.equal((await request(app,'/api/session',{method:'POST',body:{pairingCode:'wrong'},headers:{origin:lanOrigin}})).status,401);
    assert.equal(consumed(),10);
    assert.equal((await request(app,'/api/session',{method:'POST',body:{pairingCode:'12345678'},headers:{origin:lanOrigin}})).status,429);assert.equal(consumed(),10);
    time+=120001;await login(app);assert.equal(consumed(),11);
  }finally{await app.close();}
});

test('local and LAN session cookies and bootstrap methods cannot authenticate each other',async()=>{
  const {app:lan}=fixture(),{app:local}=fixture({mode:'local',origin:localOrigin,bridgeToken});try{
    const session=await request(local,'/api/session',{origin:localOrigin,method:'POST',body:{token:local.issueBootstrap()},headers:{origin:localOrigin}});const localCookie=session.headers['set-cookie'].split(';')[0];
    assert.equal((await request(lan,'/api/snapshot',{cookie:localCookie})).status,401);
    assert.equal((await request(lan,'/api/session',{method:'POST',body:{token:local.issueBootstrap()},headers:{origin:lanOrigin}})).status,401);
    const {cookie:lanCookie}=await login(lan);assert.equal((await request(local,'/api/snapshot',{origin:localOrigin,cookie:lanCookie})).status,401);
    assert.throws(()=>lan.issueBootstrap());
    await lan.close();assert.equal((await request(lan,'/api/snapshot',{cookie:lanCookie})).status,503);
  }finally{await local.close();await lan.close();}
});

test('LAN setting and code issuance require a local UI session and CSRF',async()=>{
  const calls=[],lanAccess={status:()=>({enabled:false,addresses:[]}),update:async payload=>{calls.push(['update',payload]);return{enabled:payload.enabled};},pair:()=>{calls.push(['pair']);return{code:'87654321',expiresAt:120000,url:lanOrigin};}};
  const {app}=fixture({mode:'local',origin:localOrigin,bridgeToken,lanAccess});try{
    assert.deepEqual(JSON.parse((await request(app,'/api/access-mode',{origin:localOrigin})).body),{mode:'local'});
    assert.equal((await request(app,'/api/lan-access',{origin:localOrigin})).status,401);
    const session=await request(app,'/api/session',{origin:localOrigin,method:'POST',body:{token:app.issueBootstrap()},headers:{origin:localOrigin}}),cookie=session.headers['set-cookie'].split(';')[0],csrf=JSON.parse(session.body).csrfToken;
    assert.equal((await request(app,'/api/lan-access',{origin:localOrigin,cookie})).status,200);
    for(const path of ['/api/lan-access','/api/lan-access/pair'])assert.equal((await request(app,path,{origin:localOrigin,method:'POST',body:{enabled:true},cookie,headers:{origin:localOrigin}})).status,403);
    assert.equal(calls.length,0);
    assert.equal((await request(app,'/api/lan-access',{origin:localOrigin,method:'POST',body:{enabled:true,address:'192.168.1.20'},cookie,headers:{origin:localOrigin,'x-dico-csrf':csrf}})).status,200);
    const pair=await request(app,'/api/lan-access/pair',{origin:localOrigin,method:'POST',body:{},cookie,headers:{origin:localOrigin,'x-dico-csrf':csrf}});assert.equal(pair.status,200);assert.equal(JSON.parse(pair.body).code,'87654321');assert.deepEqual(calls,[['update',{enabled:true,address:'192.168.1.20'}],['pair']]);assert.ok(!pair.body.includes(bridgeToken));
  }finally{await app.close();}
});

test('LAN session expiry and listener shutdown never restore a saved local session',async()=>{
  let time=100000;const seeded={id:'a'.repeat(64),csrfToken:'c'.repeat(64),issuedAt:time,expires:time+43200000};
  const {app}=fixture({now:()=>time,initialSessions:[seeded]});try{
    assert.equal((await request(app,'/api/snapshot',{cookie:`dico_lan_session=${seeded.id}`})).status,401);
    const response=await request(app,'/api/session',{method:'POST',body:{pairingCode:'12345678'},headers:{origin:lanOrigin}});assert.match(response.headers['set-cookie'],/HttpOnly; SameSite=Strict/);const cookie=response.headers['set-cookie'].split(';')[0];
    time+=43200000;assert.equal((await request(app,'/api/session',{cookie})).status,401);
  }finally{await app.close();}
});

test('disabling the LAN listener while a command body arrives prevents the late command',async()=>{
  let executions=0;const {app}=fixture({manager:{execute:()=>executions++}}),{cookie,csrf}=await login(app);
  const req=new Readable({read(){}});req.method='POST';req.url='/api/command';req.headers={host:new URL(lanOrigin).host,origin:lanOrigin,'content-type':'application/json',cookie,'x-dico-csrf':csrf};
  let status;const res={setHeader(){},writeHead(value){status=value;},end(){}};
  const running=app.handler(req,res);await app.close();req.push(JSON.stringify({action:'group.start',payload:{id:'group'}}));req.push(null);await running;assert.equal(status,503);assert.equal(executions,0);
});

test('disabling the LAN listener terminates authenticated SSE streams',async()=>{
  let unsubscribe=0;const {app}=fixture({manager:{snapshot:()=>({messages:[]}),subscribe:()=>()=>unsubscribe++}}),{cookie}=await login(app);
  const req=Readable.from([]);req.url='/api/events';req.method='GET';req.headers={host:new URL(lanOrigin).host,cookie};let ended=0,onClose;
  const res={setHeader(){},writeHead(){},write(){},end(){ended++;onClose?.();},on(event,callback){if(event==='close')onClose=callback;}};
  await app.handler(req,res);await app.close();assert.equal(ended,1);assert.equal(unsubscribe,1);
});

test('LAN SSE expires before a later manager push can disclose events or snapshots',async()=>{
  let time=100000,push,unsubscribed=0,snapshots=0;
  const {app}=fixture({now:()=>time,manager:{snapshot:()=>({revision:++snapshots}),subscribe:callback=>{push=callback;return()=>unsubscribed++;}}});
  try{
    const {cookie}=await login(app),req=Readable.from([]);req.url='/api/events';req.method='GET';req.headers={host:new URL(lanOrigin).host,cookie};
    const chunks=[];let ended=0,close;
    const res={setHeader(){},writeHead(){},write(value){chunks.push(value);},end(){ended++;close?.();},on(event,callback){if(event==='close')close=callback;}};
    await app.handler(req,res);push({type:'before-expiry',eventId:1});const written=chunks.length,reads=snapshots;
    time+=43200000;push({type:'private-after-expiry',eventId:2});
    assert.equal(chunks.length,written);assert.equal(snapshots,reads);assert.equal(ended,1);assert.equal(unsubscribed,1);
    push({type:'second-private-event',eventId:3});assert.equal(chunks.length,written);assert.equal(ended,1);
  }finally{await app.close();}
});

test('LAN SSE idle heartbeat ends an expired session and unsubscribes without sending more data',async t=>{
  t.mock.timers.enable({apis:['setInterval']});let time=100000,unsubscribed=0;
  const {app}=fixture({now:()=>time,manager:{snapshot:()=>({private:'workspace'}),subscribe:()=>()=>unsubscribed++}});
  try{
    const {cookie}=await login(app),req=Readable.from([]);req.url='/api/events';req.method='GET';req.headers={host:new URL(lanOrigin).host,cookie};
    const chunks=[];let ended=0,close;
    const res={setHeader(){},writeHead(){},write(value){chunks.push(value);},end(){ended++;close?.();},on(event,callback){if(event==='close')close=callback;}};
    await app.handler(req,res);const written=chunks.length;time+=43200000;t.mock.timers.tick(15000);
    assert.equal(chunks.length,written);assert.equal(ended,1);assert.equal(unsubscribed,1);t.mock.timers.tick(30000);assert.equal(ended,1);
  }finally{await app.close();}
});
