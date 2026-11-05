import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fingerprintExtension,installedExtensionStatus,extensionBrowserRoots} from '../central/host/extension-update.mjs';
const key=Buffer.from('public-packaged-test-key').toString('base64');
const extensionId=createHash('sha256').update(Buffer.from(key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,d=>'abcdefghijklmnop'[parseInt(d,16)]);
async function fixture(t){
 const home=await realpath(await mkdtemp(join(tmpdir(),'dico-extension-location-')));t.after(()=>rm(home,{recursive:true,force:true}));
 const root=join(home,'app'),copy=join(home,'Downloads','DICO','extension'),browser=join(home,'Chrome');
 const put=async(path,text)=>{await mkdir(join(path,'..'),{recursive:true});await writeFile(path,text);};
 for(const [directory,version] of [[join(root,'extension'),'0.4.19'],[copy,'0.4.13']]){
  await put(join(directory,'manifest.json'),JSON.stringify({key,version}));await put(join(directory,'background.js'),version);
  await put(join(directory,'content.js'),`const CONTENT_VERSION = '${version}';\nconst CONTENT_BUILD_ID = 'unmanaged';`);
  const buildId=await fingerprintExtension(directory);
  await put(join(directory,'build-info.js'),`export const BUILD_ID = '${buildId}';\n`);
  await put(join(directory,'content.js'),`const CONTENT_VERSION = '${version}';\nconst CONTENT_BUILD_ID = '${buildId}';`);
 }
 await put(join(copy,'../allowed_extensions.json'),JSON.stringify({extensionIds:[extensionId]}));
 await put(join(copy,'../central/package.json'),JSON.stringify({name:'dico-manager',version:'0.4.13'}));
 await put(join(copy,'../launcher'),'launcher');await put(join(copy,'../runtime/node'),'runtime');
 const prefs=JSON.stringify({extensions:{settings:{[extensionId]:{path:copy,location:4}}}});
 await put(join(browser,'Default/Preferences'),prefs);
 return{home,root,copy,browser,prefs,put,options:{reloadSafe:true,extensionId,browserRoots:[browser]}};
}
test('legacy EXTENSION_STATUS repairs a registered delivered unpacked copy before authorizing reload',async t=>{
 const r=await fixture(t);const result=await installedExtensionStatus(r.root,r.options);
 assert.equal(await readFile(join(r.copy,'background.js'),'utf8'),'0.4.19');assert.equal(result.reloadSafe,true);assert.equal(result.repairedCopies,1);
 assert.equal(await readFile(join(r.browser,'Default/Preferences'),'utf8'),r.prefs);
 assert.equal(await fingerprintExtension(r.copy),result.buildId);
});
test('all registered profiles are inspected and duplicate source paths repaired once',async t=>{
 const r=await fixture(t);await r.put(join(r.browser,'Profile 2/Secure Preferences'),r.prefs);
 const result=await installedExtensionStatus(r.root,r.options);assert.equal(result.repairedCopies,1);
 assert.equal((await installedExtensionStatus(r.root,r.options)).repairedCopies,0);
});
test('busy update status never changes a loaded extension copy',async t=>{
 const r=await fixture(t);const result=await installedExtensionStatus(r.root,{...r.options,reloadSafe:false});
 assert.equal(await readFile(join(r.copy,'background.js'),'utf8'),'0.4.13');assert.equal(result.reloadSafe,false);
});
test('unrecognized and repository extension sources stay untouched and require a manual managed-folder switch',async t=>{
 for(const scenario of ['metadata','key','repository']){
  const r=await fixture(t);
  if(scenario==='metadata')await rm(join(r.copy,'../allowed_extensions.json'));
  if(scenario==='key')await r.put(join(r.copy,'manifest.json'),JSON.stringify({key:Buffer.from('other').toString('base64'),version:'0.4.13'}));
  if(scenario==='repository')await mkdir(join(r.copy,'../.git'));
  const result=await installedExtensionStatus(r.root,r.options);
  assert.equal(await readFile(join(r.copy,'background.js'),'utf8'),'0.4.13');assert.equal(result.reloadSafe,false);assert.equal(result.reason,'EXTENSION_SOURCE_MANUAL');assert.equal(result.extensionDirectory,join(r.root,'extension'));
 }
});
test('symbolic links in a registered source are never followed for repair',async t=>{
 const r=await fixture(t);await symlink(join(r.home,'unrelated'),join(r.copy,'foreign.js'));
 const result=await installedExtensionStatus(r.root,r.options);
 assert.equal(result.reloadSafe,false);assert.equal(await readFile(join(r.copy,'background.js'),'utf8'),'0.4.13');
});
test('failed staged replacement restores the previous extension without changing profile settings',async t=>{
 const r=await fixture(t);const {rename}=await import('node:fs/promises');
 const result=await installedExtensionStatus(r.root,{...r.options,move:async(from,to)=>{if(from.includes('.dico-staging-'))throw Error('simulated replace failure');return rename(from,to);}});
 assert.equal(result.reloadSafe,false);assert.equal(result.reason,'EXTENSION_SOURCE_REPAIR_FAILED');assert.equal(await readFile(join(r.copy,'background.js'),'utf8'),'0.4.13');assert.equal(await readFile(join(r.browser,'Default/Preferences'),'utf8'),r.prefs);
});

test('Chrome and Brave platform roots include their per-user profile data directories',()=>{
 assert.deepEqual(extensionBrowserRoots({platform:'darwin',home:'/Users/owner'}),['/Users/owner/Library/Application Support/Google/Chrome','/Users/owner/Library/Application Support/BraveSoftware/Brave-Browser']);
 const roots=extensionBrowserRoots({platform:'win32',home:'C:/Users/owner',env:{LOCALAPPDATA:'C:/Users/owner/AppData/Local'}});
 assert.ok(roots.every(path=>path.endsWith('User Data')));assert.equal(roots.length,2);
});
test('different delivered copies across browser profiles are each brought to the installed build',async t=>{
 const first=await fixture(t),second=await fixture(t);
 const result=await installedExtensionStatus(first.root,{...first.options,browserRoots:[first.browser,second.browser]});
 assert.equal(result.repairedCopies,2);assert.equal(await readFile(join(second.copy,'background.js'),'utf8'),'0.4.19');
});
test('failed copy never moves the original extension out of its registered directory',async t=>{
 const r=await fixture(t);const result=await installedExtensionStatus(r.root,{...r.options,copy:async()=>{throw Error('disk full');}});
 assert.equal(result.reason,'EXTENSION_SOURCE_REPAIR_FAILED');assert.equal(result.reloadSafe,false);assert.equal(await readFile(join(r.copy,'background.js'),'utf8'),'0.4.13');
});

test('an unsupported profile does not prevent another verified delivered copy from updating',async t=>{
 const unsupported=await fixture(t),valid=await fixture(t);await rm(join(unsupported.copy,'../allowed_extensions.json'));
 const result=await installedExtensionStatus(valid.root,{...valid.options,browserRoots:[unsupported.browser,valid.browser]});
 assert.equal(await readFile(join(unsupported.copy,'background.js'),'utf8'),'0.4.13');assert.equal(await readFile(join(valid.copy,'background.js'),'utf8'),'0.4.19');
 assert.equal(result.repairedCopies,1);assert.equal(result.reason,'EXTENSION_SOURCE_MANUAL');assert.equal(result.reloadSafe,true);
});

test('등록 복사본의 콘텐츠 빌드 표식만 손상되어도 정상 설치본으로 자동 복구한다',async t=>{
 const r=await fixture(t);await installedExtensionStatus(r.root,r.options);
 const file=join(r.copy,'content.js');await writeFile(file,(await readFile(file,'utf8')).replace(/const CONTENT_BUILD_ID = '[^']+';/,"const CONTENT_BUILD_ID = '"+'f'.repeat(64)+"';"));
 const result=await installedExtensionStatus(r.root,r.options);
 assert.equal(result.repairedCopies,1);assert.equal(result.reloadSafe,true);
 assert.equal(await readFile(file,'utf8'),await readFile(join(r.root,'extension/content.js'),'utf8'));
 assert.equal(await readFile(join(r.browser,'Default/Preferences'),'utf8'),r.prefs);
});
