import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fingerprintExtension} from '../central/host/extension-update.mjs';
const run=promisify(execFile);
test('the real build synchronizes extension and content versions from manager metadata without losing manifest fields',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dico-build-version-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const path of ['scripts','central/host','central/extension'])await mkdir(join(root,path),{recursive:true});
 for(const path of ['scripts/build-central-extension.mjs','central/host/extension-update.mjs'])await cp(new URL(`../${path}`,import.meta.url),join(root,path));
 const directory=join(root,'central/extension');
 await writeFile(join(root,'central/package.json'),JSON.stringify({version:'0.4.34'}));
 const manifest={manifest_version:3,name:'DICO',version:'0.4.27',key:'unchanged-key',icons:{128:'icon128.png'},permissions:['storage']};
 await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest));
 await writeFile(join(root,'content.js'),"const CONTENT_VERSION = '0.3.0';\nconst CONTENT_BUILD_ID = 'unmanaged';\n");
 await writeFile(join(root,'emoji-data.js'),'const EMOJI_DATA = {};');
 await run(process.execPath,[join(root,'scripts/build-central-extension.mjs')]);
 const updated=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
 assert.equal(updated.version,'0.4.34');assert.deepEqual(updated,{...manifest,version:'0.4.34'});
 assert.match(await readFile(join(directory,'content.js'),'utf8'),/CONTENT_VERSION = '0\.4\.34'/);
 const build=await readFile(join(directory,'build-info.js'),'utf8');
 assert.equal(build,`export const BUILD_ID = '${await fingerprintExtension(directory)}';\n`);
});

test('central release checks reject a stale extension version even when scripts and CSP are valid',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dico-check-version-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const path of ['scripts','central/core','central/runtime','central/host','central/extension'])await mkdir(join(root,path),{recursive:true});
 await cp(new URL('../scripts/check-central.mjs',import.meta.url),join(root,'scripts/check-central.mjs'));
 await cp(new URL('../central/host/extension-update.mjs',import.meta.url),join(root,'central/host/extension-update.mjs'));
 await writeFile(join(root,'central/package.json'),JSON.stringify({version:'0.4.34'}));
 await writeFile(join(root,'central/extension/manifest.json'),JSON.stringify({version:'0.4.27',key:'fixed-key',background:{service_worker:'background.js'},side_panel:{default_path:'popup.html'},content_scripts:[{js:['content.js']}],host_permissions:['https://discord.com/*']}));
 await writeFile(join(root,'central/extension/background.js'),'');await writeFile(join(root,'central/extension/content.js'),'');await writeFile(join(root,'central/extension/popup.html'),'<html></html>');
 await assert.rejects(()=>run(process.execPath,[join(root,'scripts/check-central.mjs')]),error=>/version mismatch/.test(error.stderr));
});

for(const corruption of ['content-build','content-version','build-info'])test(`배포 검사는 ${corruption} 불일치를 거절하고 호스트도 reload를 승인하지 않는다`,async t=>{
 const {installedExtensionStatus}=await import('../central/host/extension-update.mjs');
 const root=await mkdtemp(join(tmpdir(),'dico-release-proof-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const path of ['central','scripts','content.js','emoji-data.js','package.json'])await cp(new URL(`../${path}`,import.meta.url),join(root,path),{recursive:true,filter:p=>!p.split(/[\\/]/).includes('node_modules')});
 await run(process.execPath,[join(root,'scripts/build-central-extension.mjs')]);
 const directory=join(root,'central/extension');
 const buildInfo=await readFile(join(directory,'build-info.js'),'utf8'),buildId=/[a-f0-9]{64}/.exec(buildInfo)[0];
 const file=join(directory,corruption==='build-info'?'build-info.js':'content.js');
 const original=await readFile(file,'utf8');
 await writeFile(file,corruption==='content-version'?original.replace(/const CONTENT_VERSION = '[^']+';/,"const CONTENT_VERSION = '0.0.1';"):original.replace(buildId,'f'.repeat(64)));
 // 호스트가 검사하는 설치 구조에서도 같은 파일을 사용한다.
 await cp(directory,join(root,'extension'),{recursive:true});
 const status=await installedExtensionStatus(root,{reloadSafe:true});assert.equal(status.reloadSafe,false);
 await assert.rejects(run(process.execPath,[join(root,'scripts/check-central.mjs')]),error=>/build|version/i.test(error.stderr));
});
