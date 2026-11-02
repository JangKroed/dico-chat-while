import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,readFile,mkdir,rm,chmod,symlink,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startCentralRuntime} from '../central/runtime/main.mjs';
import {selectRuntimePort,createSessionStore} from '../central/runtime/ui-state.mjs';
import {restartArguments} from '../central/runtime/updater.mjs';

async function temp(t){const directory=await mkdtemp(join(tmpdir(),'dico-session-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}
async function listen(server,port=0){await new Promise((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',accept);});return server.address().port;}
async function freePort(){const server=http.createServer(),port=await listen(server);await new Promise(accept=>server.close(accept));return port;}
async function privateJSON(file,value){await writeFile(file,JSON.stringify(value),{mode:0o600});await chmod(file,0o600);}

test('runtime reuses its persisted endpoint and preserves the same cookie and CSRF across update restart',async t=>{
  let runtime;t.after(async()=>{await runtime?.close();});
  const directory=await temp(t),port=await freePort();await privateJSON(join(directory,'endpoint.json'),{version:1,port});runtime=await startCentralRuntime({directory});const originalUrl=runtime.url;
  const bootstrap=await fetch(originalUrl+'/api/session',{method:'POST',headers:{Origin:originalUrl,'Content-Type':'application/json'},body:JSON.stringify({token:runtime.app.issueBootstrap()})});
  assert.equal(bootstrap.status,200);const cookie=bootstrap.headers.get('set-cookie').split(';')[0],session=await bootstrap.json();assert.match(session.appVersion,/^\d+\.\d+\.\d+$/);
  const persisted=JSON.parse(await readFile(join(directory,'ui-sessions.json'),'utf8'));assert.equal(persisted.sessions[0].csrfToken,session.csrfToken);if(process.platform!=='win32')assert.equal((await stat(join(directory,'ui-sessions.json'))).mode&0o777,0o600);
  await runtime.close({forUpdate:true});runtime=await startCentralRuntime({directory});assert.equal(runtime.url,originalUrl);assert.equal(runtime.manager.snapshot().service.status,'ready');assert.equal(runtime.manager.snapshot().attempts.length,0);
  const resumed=await fetch(runtime.url+'/api/session',{headers:{Cookie:cookie}});assert.equal(resumed.status,200);assert.equal((await resumed.json()).csrfToken,session.csrfToken);
  const send=csrf=>fetch(runtime.url+'/api/command',{method:'POST',headers:{Origin:runtime.url,Cookie:cookie,'Content-Type':'application/json','X-Dico-CSRF':csrf},body:JSON.stringify({action:'message.create',payload:{name:'After restart',body:'Preserved session'}})});
  assert.equal((await send('wrong')).status,403);assert.equal((await send(session.csrfToken)).status,200);
  assert.equal(runtime.manager.exportBackup().sessions,undefined);assert.equal(JSON.stringify(runtime.manager.snapshot()).includes(session.csrfToken),false);
});

test('new persistent endpoints default to 43127 while an explicit ephemeral test port stays unpersisted',async t=>{
  const directory=await temp(t);assert.equal(await selectRuntimePort({directory}),43127);assert.deepEqual(JSON.parse(await readFile(join(directory,'endpoint.json'),'utf8')),{version:1,port:43127});
  const ephemeral=await temp(t);assert.equal(await selectRuntimePort({directory:ephemeral,port:0}),0);await assert.rejects(readFile(join(ephemeral,'endpoint.json')),{code:'ENOENT'});
});

test('first stable endpoint migration retains a valid prior runtime URL',async t=>{
  const directory=await temp(t);await privateJSON(join(directory,'runtime.json'),{protocolVersion:1,url:'http://127.0.0.1:45678',pid:process.pid,bridgeToken:'b'.repeat(64)});
  assert.equal(await selectRuntimePort({directory}),45678);assert.equal(JSON.parse(await readFile(join(directory,'endpoint.json'),'utf8')).port,45678);
});

test('first update migration derives the old port only from the matching private active job',async t=>{
  const directory=await temp(t),jobId='a'.repeat(32),jobToken='b'.repeat(64),workDirectory=join(directory,'updates/jobs',jobId);
  await mkdir(workDirectory,{recursive:true});await mkdir(join(directory,'updates/active'));
  await privateJSON(join(directory,'updates/status.json'),{phase:'applying',jobId});await privateJSON(join(directory,'updates/active/owner.json'),{jobToken,workerPid:process.pid});
  await privateJSON(join(workDirectory,'job.json'),{jobId,jobToken,directory,workDirectory,app:join(directory,'app'),descriptor:{protocolVersion:1,url:'http://127.0.0.1:45679',pid:process.pid,bridgeToken:'c'.repeat(64)}});
  assert.equal(await selectRuntimePort({directory}),45679);
  await rm(join(directory,'endpoint.json'));await privateJSON(join(directory,'updates/active/owner.json'),{jobToken:'d'.repeat(64),workerPid:process.pid});
  await assert.rejects(selectRuntimePort({directory}),{code:'PRIVATE_RUNTIME_STATE_INVALID'});
});

test('busy stable port fails clearly and never silently selects another origin',async t=>{
  const directory=await temp(t),other=http.createServer(),port=await listen(other);t.after(()=>new Promise(accept=>other.close(accept)));await privateJSON(join(directory,'endpoint.json'),{version:1,port});
  await assert.rejects(startCentralRuntime({directory}),error=>error.code==='PORT_IN_USE'&&error.message.includes(String(port))&&/[가-힣]/.test(error.message));
  assert.equal(JSON.parse(await readFile(join(directory,'endpoint.json'),'utf8')).port,port);await assert.rejects(readFile(join(directory,'runtime.json')),{code:'ENOENT'});
});

test('persistent session loader prunes expired and invalid records and bounds restored sessions',async t=>{
  const directory=await temp(t),now=1000000,valid={id:'a'.repeat(64),csrfToken:'b'.repeat(64),issuedAt:now-1000,expires:now+10000};
  await privateJSON(join(directory,'ui-sessions.json'),{version:1,origin:'http://127.0.0.1:43127',sessions:[valid,{...valid,id:'c'.repeat(64),expires:now-1},{id:'bad',csrfToken:'bad',expires:now+1000},{...valid,id:'d'.repeat(64),expires:now+43200001}]});
  const store=await createSessionStore({directory,origin:'http://127.0.0.1:43127',now:()=>now});assert.deepEqual(store.sessions,[valid]);
  const many=Array.from({length:80},(_,n)=>({id:n.toString(16).padStart(64,'0'),csrfToken:'f'.repeat(64),issuedAt:now,expires:now+10000+n}));await store.save(many);assert.equal(JSON.parse(await readFile(join(directory,'ui-sessions.json'),'utf8')).sessions.length,64);
});

test('authentication and endpoint files reject symlinks and unsafe permissions',async t=>{
  for(const name of ['ui-sessions.json','endpoint.json']){
    const directory=await temp(t),outside=join(await temp(t),'outside.json');await privateJSON(outside,name==='endpoint.json'?{version:1,port:45678}:{version:1,sessions:[]});await symlink(outside,join(directory,name));
    const read=()=>name==='endpoint.json'?selectRuntimePort({directory}):createSessionStore({directory,origin:'http://127.0.0.1:43127'});await assert.rejects(read(),{code:'PRIVATE_RUNTIME_STATE_INVALID'});
    await rm(join(directory,name));await privateJSON(join(directory,name),name==='endpoint.json'?{version:1,port:45678}:{version:1,sessions:[]});
    if(process.platform!=='win32'){await chmod(join(directory,name),0o644);await assert.rejects(read(),{code:'PRIVATE_RUNTIME_STATE_INVALID'});}
  }
});

test('normal updater restart keeps the browser tab and does not request another --open',()=>{
  assert.deepEqual(restartArguments({app:'/installed/app',directory:'/private/data'}),['/installed/app/central/runtime/main.mjs','--data-dir','/private/data']);
});

test('bootstrap persists before issuing its cookie and session expiry never renews on GET or restart',async()=>{
  const {createCentralApplication}=await import('../central/runtime/http.mjs'),{Readable}=await import('node:stream');let now=1000000,saved=[],release,entered;
  const waiting=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;}),origin='http://127.0.0.1:43127';
  const app=createCentralApplication({manager:{},origin,bridgeToken:'b'.repeat(64),appVersion:'0.4.4',now:()=>now,saveSessions:async records=>{saved=structuredClone(records);entered();await gate;}});
  const make=(application,path,{method='GET',payload,cookie}={})=>{
    const req=Readable.from(payload===undefined?[]:[JSON.stringify(payload)]);Object.assign(req,{method,url:path,headers:{host:'127.0.0.1:43127',origin,...(cookie?{cookie}:{}),...(payload===undefined?{}:{'content-type':'application/json'})}});
    const result={headers:{},status:0,body:''};result.done=new Promise((resolve,reject)=>{const res={setHeader:(key,value)=>{result.headers[key.toLowerCase()]=value;},writeHead:value=>{result.status=value;},end:value=>{result.body=value;resolve();},on(){}};Promise.resolve(application.handler(req,res)).catch(reject);});return result;
  };
  const login=make(app,'/api/session',{method:'POST',payload:{token:app.issueBootstrap()}});await waiting;assert.equal(login.headers['set-cookie'],undefined);release();await login.done;
  const cookie=login.headers['set-cookie'].split(';')[0],expires=saved[0].expires,issuedAt=saved[0].issuedAt;assert.equal(expires-issuedAt,43200000);
  now+=11*60*60*1000;const refresh=make(app,'/api/session',{cookie});await refresh.done;assert.equal(refresh.status,200);await app.close();assert.equal(saved[0].expires,expires);assert.equal(saved[0].issuedAt,issuedAt);
  const restored=createCentralApplication({manager:{},origin,bridgeToken:'c'.repeat(64),initialSessions:saved,now:()=>now});const resumed=make(restored,'/api/session',{cookie});await resumed.done;assert.equal(resumed.status,200);
  now=expires;const expired=make(restored,'/api/session',{cookie});await expired.done;assert.equal(expired.status,401);await restored.close();
});

test('failed session persistence never grants an unpersisted cookie or leaks private filesystem errors',async()=>{
  const {createCentralApplication}=await import('../central/runtime/http.mjs'),{Readable}=await import('node:stream'),origin='http://127.0.0.1:43127';
  const app=createCentralApplication({manager:{},origin,bridgeToken:'b'.repeat(64),saveSessions:async()=>{throw Error('/private/user/session-secret');}});
  const req=Readable.from([JSON.stringify({token:app.issueBootstrap()})]);Object.assign(req,{method:'POST',url:'/api/session',headers:{host:'127.0.0.1:43127',origin,'content-type':'application/json'}});
  const headers={};let status,body;await app.handler(req,{setHeader:(key,value)=>{headers[key.toLowerCase()]=value;},writeHead:value=>{status=value;},end:value=>{body=value;},on(){}});
  assert.equal(status,500);assert.equal(headers['set-cookie'],undefined);assert.equal(body.includes('/private/user'),false);await app.close().catch(()=>{});
});

test('malformed private endpoint and authentication envelopes fail closed',async t=>{
  for(const name of ['endpoint.json','ui-sessions.json','runtime.json']){
    const directory=await temp(t);await privateJSON(join(directory,name),false);
    await assert.rejects(name!=='ui-sessions.json'?selectRuntimePort({directory}):createSessionStore({directory,origin:'http://127.0.0.1:43127'}),{code:'PRIVATE_RUNTIME_STATE_INVALID'});
  }
});

test('persisted authentication is never restored on a different loopback port',async t=>{
  let runtime;t.after(async()=>{await runtime?.close();});const directory=await temp(t),port=await freePort();await privateJSON(join(directory,'endpoint.json'),{version:1,port});runtime=await startCentralRuntime({directory});const firstOrigin=runtime.url;
  const login=await fetch(firstOrigin+'/api/session',{method:'POST',headers:{Origin:firstOrigin,'Content-Type':'application/json'},body:JSON.stringify({token:runtime.app.issueBootstrap()})});const cookie=login.headers.get('set-cookie').split(';')[0];await login.arrayBuffer();await runtime.close();
  const stored=JSON.parse(await readFile(join(directory,'ui-sessions.json'),'utf8'));assert.equal(stored.origin,firstOrigin);
  runtime=await startCentralRuntime({directory,port:0});assert.notEqual(runtime.url,firstOrigin);
  const session=await fetch(runtime.url+'/api/session',{headers:{Cookie:cookie}});assert.equal(session.status,401);await session.arrayBuffer();
});
