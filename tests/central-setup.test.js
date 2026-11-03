import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {join,delimiter,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {supportedNode,setupPlan,runSetup,findNpmCli,setupEnvironment} from '../scripts/setup-central.mjs';
import {assertServiceStopped} from '../central/host/install.mjs';

test('setup requires Node 24.13+ within the package-supported 24 series',()=>{
  for(const v of ['24.13.0','24.99.1'])assert.equal(supportedNode(v),true);
  for(const v of ['22.13.0','24.12.9','25.0.0','garbage'])assert.equal(supportedNode(v),false);
});
test('dry-run prints ordered setup without spawning commands or checking mutable runtime state',async()=>{
  let called=false;
  const result=await runSetup({root:'/tmp/한글 folder',npmCli:'/tool/npm-cli.js',dryRun:true,install:true,open:true,platform:'darwin',execute:()=>{called=true;throw Error();},preflight:()=>{called=true;throw Error();}});
  assert.equal(called,false);assert.equal(result.dryRun,true);
  assert.deepEqual(result.steps.slice(0,5).map(x=>x.id),['dependencies','build','central-check','extension-check','package']);
});
test('setup stops before any write when central service is active',async()=>{
  let called=false;
  await assert.rejects(runSetup({root:'/tmp/source',npmCli:'/tool/npm-cli.js',platform:'darwin',preflight:async()=>{throw Error('running');},execute:async()=>{called=true;}}),/running/);
  assert.equal(called,false);
});
test('failed setup step prevents later build, package and install',async()=>{
  const calls=[];
  await assert.rejects(runSetup({root:'/tmp/source',npmCli:'/tool/npm-cli.js',platform:'darwin',install:true,preflight:async()=>{},execute:async(step)=>{calls.push(step.id);if(step.id==='build')throw Error('build failed');return '';} }),/build/);
  assert.deepEqual(calls,['dependencies','build']);
});
test('installer uses actual package destination, with spaces preserved as argv',async()=>{
  const calls=[];
  await runSetup({root:'/tmp/한글 folder',npmCli:'/tool/npm-cli.js',platform:'darwin',install:true,preflight:async()=>{},execute:async(step)=>{calls.push(step);return step.id==='package'?JSON.stringify({destination:'/tmp/package 한글 folder'}):'';}});
  const step=calls.at(-1);assert.equal(step.id,'install');assert.equal(step.command,'/tmp/package 한글 folder/runtime/node');
  assert.deepEqual(step.args,['/tmp/package 한글 folder/central/host/install.mjs','install']);
});
test('open requires an explicit install option',()=>{
  assert.throws(()=>setupPlan({root:'/tmp',npmCli:'/npm',open:true}),/install/);
});
test('service-stopped preflight preserves corrupt descriptor and refuses mutation',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'dico-setup-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await assertServiceStopped(dir);
  await writeFile(join(dir,'runtime.json'),'broken',{mode:0o600});
  await assert.rejects(assertServiceStopped(dir),/invalid|unreadable/);
});
test('npm discovery supports portable runtime with spaced path',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'dico npm '));t.after(()=>rm(dir,{recursive:true,force:true}));
  const cli=join(dir,'lib/node_modules/npm/bin/npm-cli.js');await mkdir(join(dir,'lib/node_modules/npm/bin'),{recursive:true});await writeFile(cli,'');
  assert.equal(await findNpmCli(join(dir,'bin/node'),''),cli);
});

test('portable node is first in child PATH without changing the callers environment',()=>{
  const input={PATH:'/old/bin',OTHER:'keep'};const result=setupEnvironment('/portable tools/bin/node',input);
  assert.equal(result.PATH.split(delimiter)[0],'/portable tools/bin');assert.equal(input.PATH,'/old/bin');assert.equal(result.OTHER,'keep');
});

test('child lifecycle commands find selected node even with an empty incoming PATH',()=>{
 const child=spawnSync(process.execPath,['-e',"process.stdout.write(require('node:child_process').execFileSync('node',['-p','process.versions.node'],{encoding:'utf8'}).trim())"],{env:setupEnvironment(process.execPath,{PATH:''}),encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,process.versions.node);
});
