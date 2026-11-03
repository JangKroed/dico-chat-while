import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const root=new URL('../',import.meta.url);
test('legacy update dependency installation has no packages or install hooks',async()=>{
 const pkg=JSON.parse(await readFile(new URL('central/ui/package.json',root)));
 const lock=JSON.parse(await readFile(new URL('central/ui/package-lock.json',root)));
 assert.deepEqual(Object.keys(pkg.dependencies||{}),[]);
 assert.deepEqual(Object.keys(pkg.devDependencies||{}),[]);
 assert.deepEqual(Object.keys(lock.packages),['']);
 for(const hook of ['preinstall','install','postinstall','prepare'])assert.equal(pkg.scripts?.[hook],undefined);
});
test('prebuilt verifier rejects stale source, altered assets and missing assets',async t=>{
 const {sealUI,verifyUI}=await import('../scripts/prebuilt-central-ui.mjs');
 const dir=await mkdtemp(join(tmpdir(),'dico-prebuilt-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(join(dir,'central/ui/src'),{recursive:true});await mkdir(join(dir,'central/ui/dist/assets'),{recursive:true});
 await writeFile(join(dir,'central/ui/src/main.tsx'),'source');
 await writeFile(join(dir,'central/ui/dist/index.html'),'<script src="/assets/main.js"></script>');
 await writeFile(join(dir,'central/ui/dist/assets/main.js'),'compiled');
 await sealUI(dir);await verifyUI(dir);
 await writeFile(join(dir,'central/ui/src/main.tsx'),'changed');
 await assert.rejects(verifyUI(dir),/source/);
 await writeFile(join(dir,'central/ui/src/main.tsx'),'source');
 await writeFile(join(dir,'central/ui/dist/assets/main.js'),'tampered');
 await assert.rejects(verifyUI(dir),/asset/);
 await rm(join(dir,'central/ui/dist/assets/main.js'));
 await assert.rejects(verifyUI(dir),/asset/);
});

test('legacy updater builds using bundled Node and npm CLI with no global npm in PATH', {skip:process.platform==='win32'}, async t=>{
 const {cp,copyFile,chmod,symlink}=await import('node:fs/promises');
 const {spawnSync}=await import('node:child_process');
 const {updateEnvironment}=await import('../central/runtime/updater.mjs');
 const {findNpmCli}=await import('../scripts/setup-central.mjs');
 const dir=await mkdtemp(join(tmpdir(),'dico portable '));t.after(()=>rm(dir,{recursive:true,force:true}));
 const checkout=join(dir,'checkout'),bin=join(dir,'bin');
 await mkdir(checkout);await mkdir(bin);await symlink('/bin/sh',join(bin,'sh'));
 const node=join(bin,'node');await copyFile(process.execPath,node);await chmod(node,0o700);
 for(const path of ['central','scripts','package.json','content.js','emoji-data.js']){
  await cp(new URL(path,root),join(checkout,path),{recursive:true,filter:p=>!p.split(/[\\/]/).includes('node_modules')});
 }
 const env=updateEnvironment(node,dir,{PATH:''}),npmCli=await findNpmCli();
 env.NPM_CONFIG_OFFLINE='true';
 for(const name of ['empty-config','empty-global-config'])await writeFile(join(dir,name),'');
 for(const args of [['--prefix','central/ui','ci'],['run','central:build'],['run','central:check']]){
  const result=spawnSync(node,[npmCli,...args],{cwd:checkout,env,encoding:'utf8',timeout:60000});
  assert.equal(result.status,0,args.join(' ')+'\n'+result.stdout+'\n'+result.stderr);
 }
 assert.match(await readFile(join(checkout,'central/extension/build-info.js'),'utf8'),/BUILD_ID/);
});
