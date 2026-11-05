import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createCentralManager} from '../central/core/index.js';
import {runUpdateWorker,writeUpdateJSON} from '../central/runtime/updater.mjs';
import {verifiedExtensionBuild} from '../central/host/extension-update.mjs';
const execute=promisify(execFile),root=new URL('../',import.meta.url);
// 과거 실코드 검증에서는 git archive로 준비한 고정 커밋을 명시적으로 전달한다.
const legacyRoot=process.env.DICO_TEST_LEGACY_ROOT?pathToFileURL(process.env.DICO_TEST_LEGACY_ROOT.replace(/\/$/,'')+'/'):null;
const legacyWorker=legacyRoot?await import(new URL('central/runtime/updater.mjs',legacyRoot)):null;
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<100;i++){const value=await check().catch(()=>false);if(value)return value;await pause(50);}throw Error('격리 런타임 준비 시간 초과');}
async function stop(directory){
 const descriptor=await json(join(directory,'runtime.json')).catch(()=>null);if(!descriptor)return;
 // 시험이 만든 전용 디렉터리의 런타임만 종료한다.
 try{process.kill(descriptor.pid,'SIGTERM');}catch{}
 await until(async()=>!(await json(join(directory,'runtime.json')).catch(()=>null)));
}
async function copySource(destination,sourceRoot=root){
 for(const name of ['central','scripts','package.json','content.js','emoji-data.js'])await cp(new URL(name,sourceRoot),join(destination,name),{recursive:true,filter:p=>!p.split(/[\\/]/).includes('node_modules')});
 // 시험 데이터는 제보 서버로 전송하지 않는다.
 for(const name of ['support-connection.json','support-email-connection.json'])await rm(join(destination,'central',name),{force:true});
}
function preserved(directory){
 const db=new DatabaseSync(join(directory,'central.sqlite'),{readOnly:true});
 try{const s=JSON.parse(db.prepare('SELECT data FROM central_state WHERE singleton=1').get().data);
  return {messages:s.messages,settings:s.settings,
   accounts:s.accounts.map(({id,accountId,name})=>({id,accountId,name})),
   channels:s.channels.map(({id,accountId,guildId,channelId,playlist,playlistIndex,intervalMs})=>({id,accountId,guildId,channelId,playlist,playlistIndex,intervalMs})),
   groups:s.groups.map(({id,name,members,cursor,intervalMs,status})=>({id,name,members,cursor,intervalMs,status})),attempts:s.attempts};
 }finally{db.close();}
}
async function fixture(t){
 const directory=await realpath(await mkdtemp(join(tmpdir(),'dico installed smoke '))),app=join(directory,'app');
 t.after(async()=>{await stop(directory);await rm(directory,{recursive:true,force:true});});
 await mkdir(app);await copySource(app,legacyRoot||root);
 // 이전 설치와 새 후보는 같은 데이터 형식을 사용하되 버전·빌드는 다르게 만든다.
 const pkg=await json(join(app,'central/package.json'));
 if(!legacyRoot){pkg.version='0.4.41';await writeFile(join(app,'central/package.json'),JSON.stringify(pkg));}
 else assert.equal(pkg.version,'0.4.42','고정한 0.4.42 실코드만 과거 설치로 사용한다');
 await execute(process.execPath,[join(app,'scripts/build-central-extension.mjs')]);
 await cp(join(app,'central/extension'),join(app,'extension'),{recursive:true});
 const manager=createCentralManager({databasePath:join(directory,'central.sqlite')});
 manager.execute('message.create',{name:'보존 문구',body:'Discord로 보내지 않는 합성 데이터'});
 manager.execute('settings.update',{retentionDays:180});
 const session=manager.bridge({type:'HELLO',protocolVersion:1});
 manager.bridge({type:'OBSERVATION',sessionId:session.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'111',guildId:'222',channelId:'333',tabId:1,verified:true}]},session.instanceId);
 const s=manager.snapshot(),c=s.channels[0];
 manager.execute('channel.applyPlaylist',{id:c.id,expectedVersion:c.version,items:[{messageId:s.messages[0].id}]});
 manager.execute('group.create',{name:'중지된 그룹',members:[c.id],intervalMs:20000});manager.close();
 const script=`import {startCentralRuntime} from ${JSON.stringify(pathToFileURL(join(app,'central/runtime/main.mjs')).href)};
 const runtime=await startCentralRuntime({directory:${JSON.stringify(directory)},port:0});
 console.log(JSON.stringify({token:runtime.app.issueBootstrap()}));
 process.once('SIGTERM',()=>void runtime.close().then(()=>process.exit(0)));`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
 let output='',stderr='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM');});
 const descriptor=await until(async()=>{if(child.exitCode!==null)throw Error(stderr);return await json(join(directory,'runtime.json'));});
 const bootstrap=await until(async()=>{try{return JSON.parse(output.trim());}catch{return false;}});
 const sessionResponse=await fetch(descriptor.url+'/api/session',{method:'POST',headers:{origin:descriptor.url,'content-type':'application/json'},body:JSON.stringify(bootstrap)});
 assert.equal(sessionResponse.status,200);const cookie=sessionResponse.headers.get('set-cookie').split(';')[0];
 // 재시작도 처음 할당받은 주소를 사용한다.
 await writeUpdateJSON(join(directory,'endpoint.json'),{version:1,port:Number(new URL(descriptor.url).port)});
 return {directory,app,descriptor,cookie,previousVersion:pkg.version,before:preserved(directory)};
}
async function job(f,mode='update'){
 const jobId=(mode==='update'?'c':'e').repeat(32),jobToken='d'.repeat(64),workDirectory=join(f.directory,'updates/jobs',jobId);
 await mkdir(workDirectory,{recursive:true});await mkdir(join(f.directory,'updates/active'),{recursive:true});
 const descriptor=await json(join(f.directory,'runtime.json'));
 const value={mode,directory:f.directory,app:f.app,workDirectory,jobId,jobToken,startedAt:Date.now(),node:process.execPath,workerNode:process.execPath,npmCli:'unused',git:'unused',descriptor};
 const path=join(workDirectory,'job.json');await writeUpdateJSON(path,value);await writeUpdateJSON(join(f.directory,'updates/active/owner.json'),{jobToken,controllerPid:descriptor.pid});return {path,...value};
}
async function apply(f,j,{failStartup=false}={}){
 const worker=j.mode==='update'&&legacyWorker?legacyWorker.runUpdateWorker:runUpdateWorker;
 await worker(j.path,{
  run:async step=>{
   const checkout=join(j.workDirectory,'checkout');
   if(step.id==='source'){await mkdir(checkout);await copySource(checkout);}
   if(step.id==='build')await execute(process.execPath,[join(checkout,'scripts/build-central-extension.mjs')]);
   if(step.id==='check'){
    await execute(process.execPath,[join(checkout,'scripts/check-central.mjs')]);
    // 검사 후 시작 과정에서 실패하는 상황을 주입한다. 기존 설치는 그대로 둔다.
    if(failStartup)await writeFile(join(checkout,'central/runtime/main.mjs'),"process.exit(9);\n");
   }
  },
  // 승인 HTTP만 대체한다. 실제 이전 프로세스 종료 확인·파일 교체·새 런타임 시작·health 검사는 그대로 실행한다.
  fetchRequest:async()=>{await stop(f.directory);return {ok:true};}
 });
 return json(join(f.directory,'updates/status.json'));
}
async function assertRunning(f,version){
 const descriptor=await json(join(f.directory,'runtime.json'));assert.equal(descriptor.url,f.descriptor.url);
 const response=await fetch(descriptor.url+'/api/session',{headers:{cookie:f.cookie}});
 assert.equal(response.status,200);assert.equal((await response.json()).appVersion,version);
 await verifiedExtensionBuild(join(f.app,'extension'),version);
 assert.deepEqual(preserved(f.directory),f.before);
}
test('격리 설치의 실제 업데이트와 오프라인 롤백은 설정·중지·주소·관리 세션을 보존한다',{timeout:30000},async t=>{
 const f=await fixture(t),version=(await json(new URL('central/package.json',root))).version;
 assert.equal((await apply(f,await job(f))).phase,'completed');await assertRunning(f,version);
 assert.equal((await apply(f,await job(f,'rollback'))).phase,'completed');await assertRunning(f,f.previousVersion);
});
test('새 프로세스 시작 실패 뒤 실제 이전 런타임으로 자동 복귀한다',{timeout:30000},async t=>{
 const f=await fixture(t),status=await apply(f,await job(f),{failStartup:true});
 assert.equal(status.phase,'failed');assert.equal(status.message,'restart_rolled_back');await assertRunning(f,f.previousVersion);
});
