import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,cp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as updater from '../central/runtime/updater.mjs';
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'dico-rollback-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}
async function tree(path,version){
 for(const part of ['central/runtime','central/core','central/ui/dist','extension'])await mkdir(join(path,part),{recursive:true});
 await writeFile(join(path,'central/package.json'),JSON.stringify({name:'dico-manager',version,engines:{node:'>=24.13.0'}}));
 await writeFile(join(path,'extension/manifest.json'),JSON.stringify({key:'fixed-key',version}));
 await writeFile(join(path,'central/runtime/main.mjs'),'// runtime');await writeFile(join(path,'central/core/index.js'),'export const marker=1;');await writeFile(join(path,'central/ui/dist/index.html'),version);
}
test('previous code is retained with verified tree identity and same-version updates preserve the older slot',async t=>{
 const dir=await fixture(t),previous=join(dir,'previous');await tree(previous,'0.4.34');
 assert.equal(typeof updater.retainRollbackVersion,'function');
 await updater.retainRollbackVersion({directory:dir,source:previous,currentVersion:'0.4.35'});
 assert.deepEqual(await updater.rollbackAvailability({directory:dir}),{available:true,version:'0.4.34'});
 const same=join(dir,'same');await tree(same,'0.4.35');await updater.retainRollbackVersion({directory:dir,source:same,currentVersion:'0.4.35'});
 assert.equal((await updater.rollbackAvailability({directory:dir})).version,'0.4.34');
 await writeFile(join(dir,'updates/rollback/central/ui/dist/index.html'),'tampered');
 assert.equal((await updater.rollbackAvailability({directory:dir})).available,false);
});
test('rollback backup rejects symlinked trees and never accepts arbitrary metadata paths',async t=>{
 const dir=await fixture(t),previous=join(dir,'previous');await tree(previous,'0.4.34');
 await symlink(join(dir,'outside'),join(previous,'central/foreign'));
 assert.equal(typeof updater.retainRollbackVersion,'function');
 await assert.rejects(()=>updater.retainRollbackVersion({directory:dir,source:previous,currentVersion:'0.4.35'}));
 assert.equal((await updater.rollbackAvailability({directory:dir})).available,false);
});

async function rollbackJob(t){
 const directory=await fixture(t),app=join(directory,'app'),source=join(directory,'old');await tree(app,'0.4.35');await tree(source,'0.4.34');
 await updater.retainRollbackVersion({directory,source,currentVersion:'0.4.35'});
 const jobId='c'.repeat(32),jobToken='d'.repeat(64),workDirectory=join(directory,'updates/jobs',jobId);await mkdir(workDirectory,{recursive:true});await mkdir(join(directory,'updates/active'));
 const job={mode:'rollback',directory,app,workDirectory,jobId,jobToken,startedAt:1,node:process.execPath,workerNode:process.execPath,descriptor:{url:'http://127.0.0.1:32123',pid:12345,bridgeToken:'b'.repeat(64)}};
 const jobPath=join(workDirectory,'job.json');await updater.writeUpdateJSON(jobPath,job);await updater.writeUpdateJSON(join(directory,'updates/active/owner.json'),{jobToken,controllerPid:12345});
 await writeFile(join(directory,'settings.json'),'KEEP SETTINGS');return{directory,app,job,jobPath,workDirectory};
}
test('rollback worker uses verified offline code and preserves user data without build tools',async t=>{
 const f=await rollbackJob(t);let builds=0,approvals=0,restarts=0;
 await updater.runUpdateWorker(f.jobPath,{run:async()=>{builds++;throw Error('must not build');},fetchRequest:async()=>{approvals++;return{ok:true};},waitStopped:async()=>{},restart:async()=>{restarts++;assert.equal(JSON.parse(await readFile(join(f.app,'central/package.json'))).version,'0.4.34');}});
 assert.equal(builds,0);assert.equal(approvals,1);assert.equal(restarts,1);assert.equal(await readFile(join(f.directory,'settings.json'),'utf8'),'KEEP SETTINGS');
 const status=JSON.parse(await readFile(join(f.directory,'updates/status.json')));assert.equal(status.phase,'completed');assert.equal(status.mode,'rollback');
});
test('failed rollback startup restores current code only after proof that the failed process exited',async t=>{
 const f=await rollbackJob(t);let restarts=0;
 await updater.runUpdateWorker(f.jobPath,{run:async()=>{throw Error('offline only');},fetchRequest:async()=>({ok:true}),waitStopped:async()=>{},restart:async()=>{if(++restarts===1)throw Object.assign(Error('exit'),{rollbackSafe:true});}});
 assert.equal(restarts,2);assert.equal(JSON.parse(await readFile(join(f.app,'central/package.json'))).version,'0.4.35');
 assert.equal((await updater.rollbackAvailability({directory:f.directory})).version,'0.4.34');
});

test('controller exposes verified rollback and launches offline mode without requiring npm or git',async t=>{
 const directory=await fixture(t),source=join(directory,'previous'),app=join(directory,'app');await tree(source,'0.4.34');await tree(app,'0.4.35');await updater.retainRollbackVersion({directory,source,currentVersion:'0.4.35'});
 let inspected,job;
 const controller=updater.createUpdateController({directory,manager:{snapshot:()=>({service:{status:'ready'},groups:[],attempts:[]})},shutdown:async()=>{},inspect:async options=>{inspected=options;return{app,node:process.execPath};},prepare:async value=>{job=value;return{pid:process.pid};}});
 controller.setRuntimeDescriptor({url:'http://127.0.0.1:32123',pid:process.pid,bridgeToken:'b'.repeat(64)});
 assert.equal((await controller.status()).rollback?.version,'0.4.34');
 await controller.rollback();await controller.waitForLaunch();
 assert.equal(inspected.toolsRequired,false);assert.equal(job.mode,'rollback');assert.equal(job.git,undefined);assert.equal((await controller.status()).mode,'rollback');
 await assert.rejects(()=>controller.rollback(),{code:'UPDATE_IN_PROGRESS'});
});

test('startup adopts a legacy workers previous code before the health response allows its cleanup',async t=>{
 const f=await rollbackJob(t);await rm(join(f.directory,'updates/rollback'),{recursive:true});await tree(join(f.workDirectory,'previous'),'0.4.34');
 const job={...f.job};delete job.mode;await updater.writeUpdateJSON(f.jobPath,job);
 await updater.writeUpdateJSON(join(f.directory,'updates/active/owner.json'),{jobToken:f.job.jobToken,workerPid:process.pid});
 await updater.writeUpdateJSON(join(f.directory,'updates/status.json'),{phase:'applying',jobId:f.job.jobId});
 assert.equal(typeof updater.captureLegacyRollback,'function');
 await updater.captureLegacyRollback({directory:f.directory,applicationRoot:f.app});
 await rm(join(f.workDirectory,'previous'),{recursive:true});
 assert.deepEqual(await updater.rollbackAvailability({directory:f.directory}),{available:true,version:'0.4.34'});
});

test('an unconfirmed rollback startup never overwrites the possibly live older runtime',async t=>{
 const f=await rollbackJob(t);let restarts=0;
 await updater.runUpdateWorker(f.jobPath,{run:async()=>{throw Error('offline only');},fetchRequest:async()=>({ok:true}),waitStopped:async()=>{},restart:async()=>{restarts++;throw Object.assign(Error('still alive'),{rollbackSafe:false});}});
 assert.equal(restarts,1);assert.equal(JSON.parse(await readFile(join(f.app,'central/package.json'))).version,'0.4.34');
 assert.equal(JSON.parse(await readFile(join(f.workDirectory,'previous/central/package.json'))).version,'0.4.35');
});
test('legacy capture refuses a mismatched private owner token',async t=>{
 const f=await rollbackJob(t);await rm(join(f.directory,'updates/rollback'),{recursive:true});await tree(join(f.workDirectory,'previous'),'0.4.34');
 await updater.writeUpdateJSON(join(f.directory,'updates/active/owner.json'),{jobToken:'f'.repeat(64),workerPid:process.pid});
 await updater.writeUpdateJSON(join(f.directory,'updates/status.json'),{phase:'applying',jobId:f.job.jobId});
 await updater.captureLegacyRollback({directory:f.directory,applicationRoot:f.app});assert.equal((await updater.rollbackAvailability({directory:f.directory})).reason,'NO_BACKUP');
});
test('same-version backup has an explicit unavailable reason',async t=>{
 const dir=await fixture(t),source=join(dir,'source');await tree(source,'0.4.34');await updater.retainRollbackVersion({directory:dir,source,currentVersion:'0.4.35'});await tree(join(dir,'app'),'0.4.34');
 assert.deepEqual(await updater.rollbackAvailability({directory:dir}),{available:false,version:'0.4.34',reason:'SAME_VERSION'});
});
