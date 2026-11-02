import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fingerprintExtension,installedExtensionStatus} from '../central/host/extension-update.mjs';
import {extensionReloadDecision} from '../central/extension/update.js';

test('extension identity includes code changes but excludes generated build identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dico-build-id-'));
 try{await writeFile(join(dir,'background.js'),'one');const first=await fingerprintExtension(dir);
 await writeFile(join(dir,'build-info.js'),'generated');assert.equal(await fingerprintExtension(dir),first);
 await writeFile(join(dir,'background.js'),'two');assert.notEqual(await fingerprintExtension(dir),first);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('native status verifies disk content instead of trusting build-info',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dico-update-proof-'));
 try{await mkdir(join(dir,'extension'));await writeFile(join(dir,'extension/background.js'),'one');
 const id=await fingerprintExtension(join(dir,'extension'));await writeFile(join(dir,'extension/build-info.js'),`export const BUILD_ID = '${id}';\n`);
 assert.deepEqual(await installedExtensionStatus(dir,{reloadSafe:true}),{buildId:id,reloadSafe:true});
 await writeFile(join(dir,'extension/background.js'),'changed');assert.deepEqual(await installedExtensionStatus(dir,{reloadSafe:true}),{buildId:null,reloadSafe:false,reason:'BUILD_INCOMPLETE'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('unchanged extensions and active operations never request reload',()=>{
 const id='a'.repeat(64),next='b'.repeat(64);
 assert.equal(extensionReloadDecision({loadedBuildId:id,status:{buildId:id,reloadSafe:true},idle:true}).action,'none');
 assert.equal(extensionReloadDecision({loadedBuildId:id,status:{buildId:next,reloadSafe:false},idle:true}).action,'defer');
 assert.equal(extensionReloadDecision({loadedBuildId:id,status:{buildId:next,reloadSafe:true},idle:false}).action,'defer');
 assert.equal(extensionReloadDecision({loadedBuildId:id,status:{buildId:next,reloadSafe:true},idle:true}).action,'reload');
});
test('reload is limited to once per build and malformed targets never reload',()=>{
 const id='a'.repeat(64),next='b'.repeat(64);
 assert.equal(extensionReloadDecision({loadedBuildId:id,status:{buildId:next,reloadSafe:true},idle:true,lastRequested:next}).action,'manual');
 assert.equal(extensionReloadDecision({loadedBuildId:id,status:{buildId:'../bad',reloadSafe:true},idle:true}).action,'none');
});

test('content refresh leaves a busy tab untouched and checks injected build evidence',async()=>{
 const {ensureManagedContent}=await import('../central/extension/update.js');let injections=0,phase='busy';
 const chrome={tabs:{get:async()=>({url:'https://discord.com/channels/1/2'}),sendMessage:async(_,m)=>{
  if(m.type==='DICO_CONTENT_STATUS')return phase==='busy'?{buildId:'old',busy:true}:{buildId:injections?'new':'old',busy:false};
  return{disposed:true};
 }},scripting:{executeScript:async()=>injections++}};
 const records=[{tabId:1,guildId:'1',channelId:'2'}];
 assert.equal((await ensureManagedContent(chrome,records,'new'))[0].reason,'CONTENT_BUSY');assert.equal(injections,0);
 phase='idle';assert.equal((await ensureManagedContent(chrome,records,'new'))[0].ready,true);assert.equal(injections,1);
});

test('automatic reload persists its target before reload and will not loop from another load folder',async()=>{
 const {createExtensionUpdater}=await import('../central/extension/update.js');
 let saved,reloads=0,maintenance=false;const issues=[];const order=[];
 const chrome={storage:{local:{get:async()=>({dicoUpdateReload:saved}),set:async v=>{saved=v.dicoUpdateReload;order.push('saved');}}},runtime:{reload:()=>{order.push('reload');reloads++;}}};
 const executor={isIdle:true,beginMaintenance:()=>{maintenance=true;return true;},endMaintenance:()=>{maintenance=false;}};
 const options={chrome,executor,transport:{request:async()=>({buildId:'b'.repeat(64),reloadSafe:true})},loadedBuildId:'a'.repeat(64),onIssue:s=>issues.push(s)};
 await createExtensionUpdater(options).check({force:true});assert.deepEqual(order,['saved','reload']);assert.equal(maintenance,true);
 await createExtensionUpdater(options).check({force:true});assert.equal(reloads,1);assert.match(issues[0],/로드 폴더/);
});
test('failed persistence never reloads and releases local maintenance',async()=>{
 const {createExtensionUpdater}=await import('../central/extension/update.js');let reloads=0,ended=false;
 await createExtensionUpdater({chrome:{storage:{local:{get:async()=>({}),set:async()=>{throw Error('disk');}}},runtime:{reload:()=>reloads++}},executor:{isIdle:true,beginMaintenance:()=>true,endMaintenance:()=>{ended=true;}},transport:{request:async()=>({buildId:'b'.repeat(64),reloadSafe:true})},loadedBuildId:'a'.repeat(64)}).check({force:true});
 assert.equal(reloads,0);assert.equal(ended,true);
});

test('a deferred reload retries on the next heartbeat once local work or the global stop barrier clears',async()=>{
 const {createExtensionUpdater}=await import('../central/extension/update.js');
 for(const initiallyBusy of ['local','global']){
  let now=1000,idle=initiallyBusy!=='local',reloadSafe=initiallyBusy!=='global',reloads=0,checks=0;
  const updater=createExtensionUpdater({now:()=>now,loadedBuildId:'a'.repeat(64),
   executor:{get isIdle(){return idle;},beginMaintenance:()=>idle,endMaintenance(){}},
   chrome:{storage:{local:{get:async()=>({}),set:async()=>{}}},runtime:{reload:()=>reloads++}},
   transport:{request:async()=>{checks++;return{buildId:'b'.repeat(64),reloadSafe};}}});
  await updater.check({force:true});assert.equal(reloads,0);
  now+=5000;idle=true;reloadSafe=true;await updater.check();
  assert.equal(reloads,1,initiallyBusy);assert.equal(checks,2,initiallyBusy);
 }
});

test('unchanged, manual and failed update checks retain the thirty-second backoff',async()=>{
 const {createExtensionUpdater}=await import('../central/extension/update.js');
 for(const mode of ['unchanged','manual','transport-error','reload-error']){
  let now=1000,checks=0,reloads=0;
  const updater=createExtensionUpdater({now:()=>now,loadedBuildId:'a'.repeat(64),onIssue:()=>{},
   executor:{isIdle:true,beginMaintenance:()=>true,endMaintenance(){}},
   chrome:{storage:{local:{get:async()=>mode==='manual'?{dicoUpdateReload:{buildId:'b'.repeat(64)}}:{},set:async()=>{}}},runtime:{reload:()=>{reloads++;throw Error('reload failed');}}},
   transport:{request:async()=>{checks++;if(mode==='transport-error')throw Error('unavailable');return{buildId:(mode==='unchanged'?'a':'b').repeat(64),reloadSafe:true};}}});
  await updater.check();now+=5000;await updater.check();assert.equal(checks,1,mode);
  now+=25000;await updater.check();assert.equal(checks,2,mode);assert.equal(reloads,mode==='reload-error'?2:0);
 }
});
