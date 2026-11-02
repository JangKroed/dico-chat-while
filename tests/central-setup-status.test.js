import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectInstallation} from '../central/runtime/setup-status.mjs';

test('packaged readiness distinguishes missing host registration from disconnected executors without requiring Git',async t=>{
  const home=await mkdtemp(join(tmpdir(),'dico-doctor-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const result=await inspectInstallation({platform:'darwin',home,directory:join(home,'DICO'),uiDirectory:join(home,'ui'),snapshot:{instances:[],channels:[]}});
  assert.equal(result.ready,false);assert.equal(result.checks.find(x=>x.id==='browser-link').status,'warning');
  assert.equal(result.checks.some(x=>/git|msvc|npm/.test(x.id)),false);
  const source=result.checks.find(x=>x.id==='extension-directory');
  assert.equal(source.status,'warning');assert.equal(source.detail,join(home,'DICO','app','extension'));
  assert.match(source.nextStep,/압축해제된 확장/);
  assert.equal(JSON.stringify(result.checks.filter(x=>x.id!=='extension-directory')).includes(home),false);
});
test('host registration checks expected launcher and extension identity, not just file presence',async t=>{
  const home=await mkdtemp(join(tmpdir(),'dico-doctor-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const directory=join(home,'DICO'),dir=join(home,'Library/Application Support/Google/Chrome/NativeMessagingHosts');await mkdir(dir,{recursive:true});
  await writeFile(join(dir,'com.dico.manager.json'),JSON.stringify({name:'com.dico.manager',path:'/wrong/launcher',allowed_origins:['chrome-extension://wrong/']}));
  const result=await inspectInstallation({platform:'darwin',home,directory,uiDirectory:join(home,'ui'),snapshot:{instances:[],channels:[]}});
  assert.equal(result.checks.find(x=>x.id==='host-chrome').status,'error');
});
test('real connection and applied configuration are independent and checked without leaking tokens',async t=>{
  const home=await mkdtemp(join(tmpdir(),'dico-doctor-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const result=await inspectInstallation({platform:'darwin',home,directory:home,uiDirectory:home,snapshot:{instances:[{connected:true,sessionId:'secret'}],channels:[{verified:true,configVersion:2,appliedVersion:1}],settings:{bridgeToken:'secret'}}});
  assert.equal(result.checks.find(x=>x.id==='browser-link').status,'ok');
  assert.equal(result.checks.find(x=>x.id==='channel-apply').status,'warning');
  assert.equal(JSON.stringify(result).includes('secret'),false);
});

test('ready requires a real registered launcher and a nonempty applied playlist',async t=>{
 const home=await mkdtemp(join(tmpdir(),'dico-doctor-ready-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const directory=join(home,'DICO'),launcher=join(directory,'app/launcher'),dir=join(home,'Library/Application Support/Google/Chrome/NativeMessagingHosts');
 await mkdir(join(directory,'app'),{recursive:true});await writeFile(launcher,'launcher');await mkdir(join(directory,'app/extension'),{recursive:true});await writeFile(join(directory,'app/extension/manifest.json'),'{}');await writeFile(join(directory,'index.html'),'ui');await mkdir(dir,{recursive:true});
 await writeFile(join(dir,'com.dico.manager.json'),JSON.stringify({name:'com.dico.manager',type:'stdio',path:launcher,allowed_origins:['chrome-extension://ibkkihhaihlpjcahglnoiphcddcjipgh/']}));
 const snapshot={instances:[{connected:true,extensionVersion:'0.4.0'}],channels:[{verified:true,configVersion:2,appliedVersion:2,playlist:[]}]};
 const options={platform:'darwin',home,directory,uiDirectory:directory,snapshot};
 assert.equal((await inspectInstallation(options)).ready,false);
 snapshot.channels[0].playlist=[{messageId:'message'}];
 assert.equal((await inspectInstallation(options)).ready,true);
});
