import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {safeToUpdate,assertUpdateSafe,supportedUpdateNode,updateBuildPlan,swapUpdateDirectories,publicUpdateStatus,createUpdateController} from '../central/runtime/updater.mjs';

const idle=()=>({service:{status:'ready'},groups:[{id:'g',status:'paused',activeAttemptId:null}],attempts:[]});
async function temp(t){const dir=await mkdtemp(join(tmpdir(),'dico-updater-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('updater permits only genuinely idle groups and keeps uncertain delivery blocked',()=>{
  assert.equal(safeToUpdate(idle()),true);assert.doesNotThrow(()=>assertUpdateSafe(idle()));
  for(const status of ['running','stop_pending','pause_pending','needs_review','resume_required'])assert.throws(()=>assertUpdateSafe({...idle(),groups:[{status}]}),{code:'UPDATE_BUSY'});
  for(const status of ['preparing','prepared','permitted','executing','unknown'])assert.equal(safeToUpdate({...idle(),attempts:[{status}]}),false);
  assert.equal(safeToUpdate({...idle(),groups:[{status:'paused',controlIntent:'stop'}]}),false);
  assert.equal(safeToUpdate({...idle(),groups:[{status:'stopped',activeAttemptId:'a'}]}),false);
  assert.equal(safeToUpdate({...idle(),service:{status:'storage_failure'}}),false);
});

test('updater build pins repository and branch and invokes npm through a known Node without shell commands',()=>{
  assert.equal(supportedUpdateNode('24.12.9'),false);assert.equal(supportedUpdateNode('24.13.0'),true);assert.equal(supportedUpdateNode('26.0.0'),true);
  const steps=updateBuildPlan({checkout:'/private/job/checkout',workDirectory:'/private/job',node:'/private/job/node',npmCli:'/tools/npm-cli.js',git:'/tools/git'});
  assert.equal(steps[0].command,'/tools/git');assert.ok(steps[0].args.includes('https://github.com/JangKroed/dico-chat-while.git'));assert.ok(steps[0].args.includes('main'));
  assert.deepEqual(steps.slice(1).map(s=>s.args),[['/tools/npm-cli.js','--prefix','central/ui','ci'],['/tools/npm-cli.js','run','central:build'],['/tools/npm-cli.js','run','central:check']]);
  assert.ok(steps.slice(1).every(s=>s.command==='/private/job/node'&&s.cwd==='/private/job/checkout'));
});

test('updater public status drops private data and bounds surfaced fields',()=>{
  const result=publicUpdateStatus({phase:'preparing',message:'source',jobToken:'secret',bridgeToken:'secret',path:'/private/user',startedAt:1,updatedAt:2,version:'0.4.2'});
  assert.equal(result.phase,'preparing');assert.equal(result.version,'0.4.2');assert.equal(JSON.stringify(result).includes('secret'),false);assert.equal(JSON.stringify(result).includes('/private'),false);
  assert.equal(publicUpdateStatus({phase:'failed',message:'/private/user/secret'}).message.includes('/private'),false);
});

test('update swaps only JavaScript trees and rolls both back if the second directory fails',async t=>{
  const directory=await temp(t),app=join(directory,'app'),prepared=join(directory,'prepared'),backup=join(directory,'backup');
  for(const root of [app,prepared])for(const part of ['central','extension']){await mkdir(join(root,part),{recursive:true});await writeFile(join(root,part,'marker'),root===app?'old':'new');}
  await mkdir(join(app,'runtime'));await writeFile(join(app,'runtime/node'),'locked node');await writeFile(join(app,'launcher.exe'),'locked launcher');
  let failed=false;
  await assert.rejects(swapUpdateDirectories({app,prepared,backup,move:async(from,to)=>{if(!failed&&from===join(prepared,'extension')){failed=true;throw Error('simulated locked file');}await rename(from,to);}}));
  for(const part of ['central','extension'])assert.equal(await readFile(join(app,part,'marker'),'utf8'),'old');
  assert.equal(await readFile(join(app,'runtime/node'),'utf8'),'locked node');assert.equal(await readFile(join(app,'launcher.exe'),'utf8'),'locked launcher');
});

test('update controller rejects unsafe work and concurrent launches before starting a worker',async t=>{
  const directory=await temp(t);let snapshot=idle(),started=0;
  const controller=createUpdateController({directory,manager:{snapshot:()=>snapshot},shutdown:async()=>{},prepare:async()=>{started++;return {pid:process.pid};},inspect:async()=>({app:join(directory,'app'),node:process.execPath,npmCli:'/tools/npm-cli.js',git:'/tools/git'})});
  controller.setRuntimeDescriptor({url:'http://127.0.0.1:32123',pid:process.pid,bridgeToken:'b'.repeat(64)});
  snapshot.groups[0].status='running';await assert.rejects(controller.start(),{code:'UPDATE_BUSY'});assert.equal(started,0);
  snapshot=idle();assert.equal((await controller.start()).phase,'preparing');await controller.waitForLaunch();await assert.rejects(controller.start(),{code:'UPDATE_IN_PROGRESS'});assert.equal(started,1);
});

test('update apply requires its job token and fresh idle state before scheduling shutdown',async t=>{
  const directory=await temp(t);let snapshot=idle(),job,closed=0;
  const controller=createUpdateController({directory,manager:{snapshot:()=>snapshot},shutdown:async()=>{closed++;},prepare:async value=>{job=value;return {pid:process.pid};},inspect:async()=>({app:join(directory,'app'),node:process.execPath,npmCli:'/tools/npm-cli.js',git:'/tools/git'})});
  controller.setRuntimeDescriptor({url:'http://127.0.0.1:32123',pid:process.pid,bridgeToken:'b'.repeat(64)});
  await controller.start();await controller.waitForLaunch();
  await writeFile(join(directory,'updates/status.json'),JSON.stringify({phase:'ready',jobId:job.jobId}));
  await assert.rejects(controller.apply({jobToken:'wrong'}),{code:'UPDATE_AUTH_REQUIRED'});
  snapshot.groups[0].status='running';await assert.rejects(controller.apply({jobToken:job.jobToken}),{code:'UPDATE_BUSY'});assert.equal(closed,0);
  snapshot=idle();await controller.apply({jobToken:job.jobToken});assert.equal(controller.isApplying(),true);
  assert.equal(JSON.parse(await readFile(join(directory,'shutdown.json'),'utf8')).intent,'update');
  await new Promise(resolve=>setTimeout(resolve,100));assert.equal(closed,1);
});

test('update HTTP endpoints require UI session plus CSRF and private bridge plus job token',async()=>{
  const {createCentralApplication}=await import('../central/runtime/http.mjs'),{Readable}=await import('node:stream');
  const origin='http://127.0.0.1:43127',bridgeToken='b'.repeat(64);let started=0,applied=0,reported=0,phase='idle',applying=false;
  const updates={reportFailure:async()=>{reported++;},status:async()=>({phase,message:'safe status'}),start:async()=>{started++;return{phase:'preparing',message:'safe status'};},apply:async payload=>{if(payload.jobToken!=='private-job')throw Object.assign(Error('작업 인증 필요'),{status:401});applied++;return{accepted:true};},isApplying:()=>applying};
  const app=createCentralApplication({manager:{snapshot:idle,execute:()=>({}),subscribe:()=>()=>{}},origin,bridgeToken,updates});
  const request=async(path,{method='GET',payload,headers={},cookie}={})=>{
    const req=Readable.from(payload===undefined?[]:[JSON.stringify(payload)]);Object.assign(req,{method,url:path,headers:{host:'127.0.0.1:43127',...(payload===undefined?{}:{'content-type':'application/json'}),...(cookie?{cookie}:{}),...headers}});
    return new Promise((accept,reject)=>{const result={headers:{},body:'',status:200};const res={setHeader:(k,v)=>{result.headers[k.toLowerCase()]=v;},writeHead:s=>{result.status=s;},end:value=>{result.body+=value||'';accept(result);},on(){}};Promise.resolve(app.handler(req,res)).catch(reject);});
  };
  assert.equal((await request('/api/updates/report',{method:'POST',payload:{}})).status,401);
  assert.equal((await request('/api/updates')).status,401);
  const session=await request('/api/session',{method:'POST',payload:{token:app.issueBootstrap()},headers:{origin}}),cookie=session.headers['set-cookie'].split(';')[0],csrf=JSON.parse(session.body).csrfToken;
  assert.equal((await request('/api/updates',{cookie})).status,200);
  assert.equal((await request('/api/updates/report',{method:'POST',cookie,payload:{},headers:{origin}})).status,403);assert.equal(reported,0);
  assert.equal((await request('/api/updates/report',{method:'POST',cookie,payload:{},headers:{origin,'x-dico-csrf':csrf}})).status,202);assert.equal(reported,1);
  assert.equal((await request('/api/updates',{method:'POST',cookie,payload:{},headers:{origin}})).status,403);assert.equal(started,0);
  assert.equal((await request('/api/updates',{method:'POST',cookie,payload:{},headers:{origin,'x-dico-csrf':csrf}})).status,202);assert.equal(started,1);
  assert.equal((await request('/api/bridge/update/apply',{method:'POST',payload:{jobToken:'private-job'}})).status,401);
  const auth={authorization:`Bearer ${bridgeToken}`};assert.equal((await request('/api/bridge/update/apply',{method:'POST',headers:auth,payload:{jobToken:'wrong'}})).status,401);
  assert.equal((await request('/api/bridge/update/apply',{method:'POST',headers:auth,payload:{jobToken:'private-job'}})).status,202);assert.equal(applied,1);
  assert.equal(JSON.parse((await request('/api/bridge/status',{headers:auth})).body).reloadSafe,true);
  phase='preparing';assert.equal(JSON.parse((await request('/api/bridge/status',{headers:auth})).body).reloadSafe,false);
  applying=true;assert.equal((await request('/api/command',{method:'POST',cookie,payload:{action:'group.start'},headers:{origin,'x-dico-csrf':csrf}})).status,503);
});

async function workerFixture(t){
  const {writeUpdateJSON}=await import('../central/runtime/updater.mjs');
  const directory=await temp(t),jobId='c'.repeat(32),jobToken='d'.repeat(64),app=join(directory,'app'),workDirectory=join(directory,'updates/jobs',jobId);
  for(const part of ['central','extension','runtime'])await mkdir(join(app,part),{recursive:true});
  await writeFile(join(app,'central/marker'),'old');await writeFile(join(app,'extension/manifest.json'),JSON.stringify({key:'fixed-identity',version:'0.4.1'}));await writeFile(join(app,'runtime/node'),'bundled-runtime');await writeFile(join(app,'launcher.exe'),'bundled-launcher');
  await mkdir(workDirectory,{recursive:true});await mkdir(join(directory,'updates/active'));
  const job={directory,app,workDirectory,jobId,jobToken,startedAt:1,node:join(app,'runtime/node'),workerNode:join(workDirectory,'node'),npmCli:'/tools/npm-cli.js',git:'/tools/git',descriptor:{url:'http://127.0.0.1:32123',pid:12345,bridgeToken:'b'.repeat(64)}};
  const jobPath=join(workDirectory,'job.json');await writeUpdateJSON(jobPath,job);await writeUpdateJSON(join(directory,'updates/active/owner.json'),{jobToken,controllerPid:12345});
  const steps=[];
  const run=async(step,env)=>{
    steps.push(step.id);assert.equal(env.HOME,undefined);assert.equal(env.USERPROFILE,undefined);assert.equal(env.SECRET_TOKEN,undefined);
    if(step.id==='source'){
      const checkout=join(workDirectory,'checkout');for(const dir of ['central/extension','central/runtime','central/ui/dist'])await mkdir(join(checkout,dir),{recursive:true});
      await writeFile(join(checkout,'central/marker'),'new');await writeFile(join(checkout,'central/package.json'),JSON.stringify({version:'0.4.3',engines:{node:'>=24.13.0'}}));await writeFile(join(checkout,'central/extension/manifest.json'),JSON.stringify({key:'fixed-identity',version:'0.4.2'}));await writeFile(join(checkout,'central/runtime/main.mjs'),'// runtime');await writeFile(join(checkout,'central/ui/dist/index.html'),'new ui');
    }
  };
  return{job,jobPath,run,steps,readStatus:async()=>JSON.parse(await readFile(join(directory,'updates/status.json'),'utf8'))};
}

test('isolated worker builds before approval, preserves binaries and publishes no credentials',async t=>{
  const {runUpdateWorker}=await import('../central/runtime/updater.mjs'),f=await workerFixture(t);let approved=0,stopped=0,restarted=0;
  await runUpdateWorker(f.jobPath,{run:f.run,fetchRequest:async(url,options)=>{approved++;assert.equal(await readFile(join(f.job.app,'central/marker'),'utf8'),'old');assert.deepEqual(f.steps,['source','dependencies','build','check']);assert.equal(JSON.parse(options.body).jobToken,f.job.jobToken);return{ok:true};},waitStopped:async()=>{stopped++;},restart:async()=>{restarted++;assert.equal(await readFile(join(f.job.app,'central/marker'),'utf8'),'new');}});
  assert.deepEqual([approved,stopped,restarted],[1,1,1]);assert.equal(await readFile(join(f.job.app,'runtime/node'),'utf8'),'bundled-runtime');assert.equal(await readFile(join(f.job.app,'launcher.exe'),'utf8'),'bundled-launcher');
  const status=await f.readStatus();assert.equal(status.phase,'completed');assert.equal(status.version,'0.4.3');assert.equal(JSON.stringify(status).includes(f.job.jobToken),false);assert.equal(JSON.stringify(status).includes(f.job.descriptor.bridgeToken),false);
});

test('failed build or final busy denial never shuts down or modifies the installed app',async t=>{
  const {runUpdateWorker}=await import('../central/runtime/updater.mjs');
  for(const reason of ['build','busy']){
    const f=await workerFixture(t);let stop=0,restarts=0;
    await runUpdateWorker(f.jobPath,{run:async(step,env)=>{await f.run(step,env);if(reason==='build'&&step.id==='build')throw Error('private error /user/secret');},fetchRequest:async()=>({ok:false,status:409}),waitStopped:async()=>{stop++;},restart:async()=>{restarts++;}});
    assert.equal(await readFile(join(f.job.app,'central/marker'),'utf8'),'old');assert.equal(stop,0);assert.equal(restarts,0);const status=await f.readStatus();assert.equal(status.phase,'failed');assert.equal(status.message,reason==='build'?'build_failed':'busy');assert.equal(JSON.stringify(status).includes('secret'),false);
  }
});

test('failed new-runtime launch rolls back only with proof the new process stopped',async t=>{
  const {runUpdateWorker}=await import('../central/runtime/updater.mjs'),f=await workerFixture(t);let restarts=0;
  await runUpdateWorker(f.jobPath,{run:f.run,fetchRequest:async()=>({ok:true}),waitStopped:async()=>{},restart:async()=>{if(++restarts===1)throw Object.assign(Error('Exited'),{rollbackSafe:true});assert.equal(await readFile(join(f.job.app,'central/marker'),'utf8'),'old');}});
  assert.equal(restarts,2);assert.equal(await readFile(join(f.job.app,'central/marker'),'utf8'),'old');const status=await f.readStatus();assert.equal(status.phase,'failed');assert.equal(status.message,'restart_rolled_back');assert.equal(status.version,'0.4.1');
});

test('unconfirmed startup preserves rollback files and never replaces a possibly live runtime',async t=>{
  const {runUpdateWorker}=await import('../central/runtime/updater.mjs'),f=await workerFixture(t);
  await runUpdateWorker(f.jobPath,{run:f.run,fetchRequest:async()=>({ok:true}),waitStopped:async()=>{},restart:async()=>{throw Error('health check timeout');}});
  assert.equal(await readFile(join(f.job.app,'central/marker'),'utf8'),'new');assert.equal(await readFile(join(f.job.workDirectory,'previous/central/marker'),'utf8'),'old');assert.equal((await f.readStatus()).message,'restart_failed');
});

test('developer checkouts cannot use managed-install automatic update',async t=>{
  const {inspectUpdateInstallation}=await import('../central/runtime/updater.mjs'),directory=await temp(t);
  await assert.rejects(inspectUpdateInstallation({directory}),{code:'UPDATE_MANUAL_REQUIRED'});
});

test('a crashed worker releases its stale lock and exposes a retryable failure',async t=>{
  const directory=await temp(t);const controller=createUpdateController({directory,manager:{snapshot:idle},shutdown:async()=>{},prepare:async()=>({pid:2147483647}),inspect:async()=>({app:join(directory,'app'),node:process.execPath,npmCli:'/tools/npm-cli.js',git:'/tools/git'})});
  controller.setRuntimeDescriptor({url:'http://127.0.0.1:32123',pid:process.pid,bridgeToken:'b'.repeat(64)});
  await controller.start();await controller.waitForLaunch();assert.equal((await controller.status()).phase,'failed');
  assert.equal((await controller.start()).phase,'preparing');await controller.waitForLaunch();await controller.status();
});

test('automatic update refuses redirected staging directories',async t=>{
  const {symlink}=await import('node:fs/promises');const directory=await temp(t),outside=await temp(t);await symlink(outside,join(directory,'updates'),'dir');
  const controller=createUpdateController({directory,manager:{snapshot:idle},shutdown:async()=>{},prepare:async()=>{throw Error('must not launch');},inspect:async()=>({app:join(directory,'app'),node:process.execPath,npmCli:'/tools/npm-cli.js',git:'/tools/git'})});
  controller.setRuntimeDescriptor({url:'http://127.0.0.1:32123',pid:process.pid,bridgeToken:'b'.repeat(64)});
  await assert.rejects(controller.start(),{code:'UPDATE_MANUAL_REQUIRED'});
});

test('the update swap holds the same OS lock as runtime startup',async t=>{
  const {withUpdateManagerLock}=await import('../central/runtime/updater.mjs'),{acquireLock}=await import('../central/runtime/main.mjs'),directory=await temp(t);
  const unlock=await acquireLock(directory);await assert.rejects(withUpdateManagerLock(directory,async()=>{throw Error('must not swap');}),{code:'UPDATE_RUNTIME_ACTIVE'});await unlock();
  let changed=false;await withUpdateManagerLock(directory,async()=>{await assert.rejects(acquireLock(directory));changed=true;});assert.equal(changed,true);
  const reopened=await acquireLock(directory);await reopened();
});

test('a locked runtime refuses startup before loading replaceable application modules',async t=>{
  const {copyFile}=await import('node:fs/promises'),{execFileSync}=await import('node:child_process'),{pathToFileURL}=await import('node:url'),{acquireLock}=await import('../central/runtime/main.mjs');
  const directory=await temp(t),tree=await temp(t);await mkdir(join(tree,'runtime'));await mkdir(join(tree,'host'));await mkdir(join(tree,'core'));
  await copyFile(new URL('../central/runtime/main.mjs',import.meta.url),join(tree,'runtime/main.mjs'));await copyFile(new URL('../central/host/paths.mjs',import.meta.url),join(tree,'host/paths.mjs'));
  await writeFile(join(tree,'package.json'),' {"type":"module"}');await writeFile(join(tree,'core/index.js'),'throw Error("APP_LOGIC_WAS_LOADED"); export function createCentralManager() {}');
  const unlock=await acquireLock(directory);
  try{
    const source=`const {startCentralRuntime}=await import(${JSON.stringify(pathToFileURL(join(tree,'runtime/main.mjs')).href)});try{await startCentralRuntime({directory:${JSON.stringify(directory)}});}catch(error){console.log(error.message);}`;
    const output=execFileSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:5000});
    assert.match(output,/이미 관리 프로그램이 실행 중/);assert.equal(output.includes('APP_LOGIC_WAS_LOADED'),false);
  }finally{await unlock();}
});

test('completed updates report installed app version even when an older worker reported extension version',async t=>{
  const directory=await temp(t);await mkdir(join(directory,'app/central'),{recursive:true});await mkdir(join(directory,'updates'));
  await writeFile(join(directory,'app/central/package.json'),JSON.stringify({version:'0.4.3'}));
  await writeFile(join(directory,'updates/status.json'),JSON.stringify({phase:'completed',version:'0.4.2'}));
  const controller=createUpdateController({directory,manager:{snapshot:()=>idle()},shutdown:async()=>{}});
  assert.equal((await controller.status()).version,'0.4.3');
});

test('update failures are classified without exposing raw error paths or credentials',async()=>{
 const {classifyUpdateFailure}=await import('../central/runtime/updater.mjs');
 for(const [stderr,code] of [['sh: npm: command not found','TOOL_MISSING'],['fatal: Could not resolve host: github.com','NETWORK'],['ENOSPC: no space left on device','DISK_FULL'],['Prebuilt source mismatch','BUNDLE_INVALID']]){
  const result=classifyUpdateFailure({stderr:stderr+' /Users/private token=secret',code:127},'build');
  assert.equal(result.code,code);assert.equal(JSON.stringify(result).includes('secret'),false);
 }
 assert.equal(classifyUpdateFailure({signal:'SIGKILL'},'dependencies').code,'PROCESS_BLOCKED');
});
test('transient source failures retry automatically before applying and retain retry count',async t=>{
 const {runUpdateWorker}=await import('../central/runtime/updater.mjs'),f=await workerFixture(t);let failures=0,approved=0;
 await runUpdateWorker(f.jobPath,{run:async(step,env)=>{if(step.id==='source'&&failures++<2)throw Object.assign(Error('network'),{stderr:'Could not resolve host: github.com'});await f.run(step,env);},wait:async()=>{},fetchRequest:async()=>{approved++;return{ok:true};},waitStopped:async()=>{},restart:async()=>{}});
 const status=await f.readStatus();assert.equal(status.phase,'completed');assert.equal(status.retryCount,2);assert.equal(approved,1);
});
test('exhausted retries retain diagnostics and never stop the current app',async t=>{
 const {runUpdateWorker}=await import('../central/runtime/updater.mjs'),f=await workerFixture(t);let calls=0;
 await runUpdateWorker(f.jobPath,{run:async()=>{calls++;throw Object.assign(Error('private /user/secret'),{code:'ECONNRESET'});},wait:async()=>{},fetchRequest:async()=>{throw Error('must not approve');}});
 const status=await f.readStatus();assert.equal(calls,3);assert.equal(status.phase,'failed');assert.equal(status.diagnostic.code,'NETWORK');assert.equal(status.retryCount,2);
 const saved=JSON.parse(await readFile(join(f.job.workDirectory,'diagnostic.json'),'utf8'));assert.equal(saved.diagnostic.code,'NETWORK');
 assert.equal(await readFile(join(f.job.app,'central/marker'),'utf8'),'old');assert.equal(JSON.stringify(status).includes('secret'),false);
});
test('update failure reporting works without an open browser and contains safe diagnostics',async t=>{
 const directory=await temp(t);await mkdir(join(directory,'updates'));const jobId='f'.repeat(32);
 await writeFile(join(directory,'updates/status.json'),JSON.stringify({phase:'failed',message:'build_failed',jobId,diagnostic:{code:'TOOL_MISSING',stage:'build',exitCode:127,token:'secret'}}));
 let report;
 const controller=createUpdateController({directory,manager:{snapshot:idle},shutdown:async()=>{},onFailure:async data=>{report=data;return {status:'queued'};}});
 await controller.monitor();assert.equal(report.jobId,jobId);assert.equal(report.automatic,true);assert.equal(report.diagnostic.code,'TOOL_MISSING');assert.equal(JSON.stringify(report).includes('secret'),false);
 const status=await controller.status();assert.equal(status.diagnostic.code,'TOOL_MISSING');assert.equal(status.support.status,'queued');
});

test('reported update jobs remain deduplicated across restart even after the outbox is pruned',async t=>{
 const directory=await temp(t);await mkdir(join(directory,'updates'));const jobId='a'.repeat(32);
 await writeFile(join(directory,'updates/status.json'),JSON.stringify({phase:'failed',message:'build_failed',jobId,diagnostic:{code:'TOOL_MISSING',stage:'build'}}));
 let calls=0;
 const options={directory,manager:{snapshot:idle},shutdown:async()=>{},onFailure:async()=>{calls++;return {status:'sent',reportId:'12345678-1234-1234-1234-123456789012',receiptId:'receipt-1'};},supportStatus:()=>({status:'collecting'})};
 await createUpdateController(options).monitor();
 const restarted=createUpdateController(options);await restarted.monitor();await restarted.reportFailure({automatic:false});
 assert.equal(calls,1);assert.equal((await restarted.status()).support.status,'sent');
});
test('missing initial update tools are recorded and reported without launching a worker',async t=>{
 const directory=await temp(t);let reported=0;
 const controller=createUpdateController({directory,manager:{snapshot:idle},shutdown:async()=>{},inspect:async()=>{throw Object.assign(Error('private path'),{code:'UPDATE_NPM_REQUIRED'});},prepare:async()=>{throw Error('must not launch');},onFailure:async({diagnostic})=>{reported++;assert.equal(diagnostic.code,'TOOL_MISSING');return {status:'queued'};}});
 controller.setRuntimeDescriptor({url:'http://127.0.0.1:32123',pid:process.pid,bridgeToken:'b'.repeat(64)});
 const status=await controller.start();assert.equal(status.phase,'failed');await controller.monitor();assert.equal(reported,1);
});
