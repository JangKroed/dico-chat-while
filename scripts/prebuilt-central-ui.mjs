import {readdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const project=fileURLToPath(new URL('../',import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function tree(directory,prefix='',skip=new Set()){
 const result={};
 for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:1)){
  if(skip.has(entry.name)||entry.name.endsWith('.tsbuildinfo'))continue;
  const path=join(directory,entry.name),key=prefix+entry.name;
  if(entry.isSymbolicLink())throw Error('Prebuilt tree contains symbolic link');
  if(entry.isDirectory())Object.assign(result,await tree(path,key+'/',skip));
  else if(entry.isFile())result[key]=digest(await readFile(path));
 }
 return result;
}
async function sources(root){
 const values=await tree(join(root,'central/ui'),'',new Set(['node_modules','dist','prebuilt.json']));
 for(const name of ['central/package.json','central/package-lock.json','scripts/prebuilt-central-ui.mjs']){
  try{values[name]=digest(await readFile(join(root,name)));}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 return digest(JSON.stringify(values));
}
async function assets(root){
 const result=await tree(join(root,'central/ui/dist'));
 if(!result['index.html']||!Object.keys(result).some(name=>name.endsWith('.js')))throw Error('Prebuilt asset entry missing');
 return result;
}
export async function sealUI(root=project){
 const manifest={schemaVersion:1,sourceHash:await sources(root),assets:await assets(root)};
 await writeFile(join(root,'central/ui/prebuilt.json'),JSON.stringify(manifest,null,2)+'\n');
}
export async function verifyUI(root=project){
 const manifest=JSON.parse(await readFile(join(root,'central/ui/prebuilt.json'),'utf8'));
 if(manifest.schemaVersion!==1||manifest.sourceHash!==await sources(root))throw Error('Prebuilt source mismatch: run npm run central:compile before publishing');
 if(JSON.stringify(manifest.assets)!==JSON.stringify(await assets(root)))throw Error('Prebuilt asset mismatch: update files are incomplete or changed');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv[2]==='--seal')await sealUI();else await verifyUI();
 console.log('중앙관리 사전 빌드 파일 검사 완료');
}
