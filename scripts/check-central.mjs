import {readdir,readFile,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
let count=0;
async function check(directory){for(const item of await readdir(directory,{withFileTypes:true})){if(['node_modules','dist'].includes(item.name))continue;const file=join(directory,item.name);if(item.isDirectory())await check(file);else if(/\.(?:mjs|js)$/.test(item.name)){execFileSync(process.execPath,['--check',file],{stdio:'pipe'});count++;}}}
for(const name of ['core','runtime','host','extension'])await check(join(root,'central',name));
const folder=join(root,'central','extension'),manifest=JSON.parse(await readFile(join(folder,'manifest.json'),'utf8'));
for(const file of [manifest.background.service_worker,(manifest.side_panel?.default_path||manifest.action?.default_popup),...manifest.content_scripts.flatMap(x=>x.js)])await access(join(folder,file));
const popup=await readFile(join(folder,'popup.html'),'utf8');
if(/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(popup)||/\son\w+\s*=/i.test(popup))throw Error('Central popup violates extension CSP');
if(!manifest.key || manifest.host_permissions.some(host=>host!=='https://discord.com/*'))throw Error('Unexpected central extension permissions');
console.log(`중앙관리 JavaScript ${count}개·전용 확장 manifest·CSP 검사 통과`);
