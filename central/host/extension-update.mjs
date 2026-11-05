import {createHash,randomBytes} from 'node:crypto';
import {readdir,readFile,realpath,lstat,mkdir,cp,rename,rm} from 'node:fs/promises';
import {join,dirname,resolve,isAbsolute,win32} from 'node:path';
import {homedir} from 'node:os';

export async function fingerprintExtension(directory) {
  const hash=createHash('sha256');let total=0;
  async function visit(relative='') {
    const entries=await readdir(join(directory,relative),{withFileTypes:true});
    for(const entry of entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)) {
      if(entry.name==='build-info.js'||entry.name.startsWith('.'))continue;
      const path=relative?`${relative}/${entry.name}`:entry.name;
      if(entry.isSymbolicLink())throw Error('Extension symlinks are not supported');
      if(entry.isDirectory())await visit(path);
      else if(entry.isFile()) {
        let data=await readFile(join(directory,path));
        if(path==='content.js')data=Buffer.from(data.toString('utf8').replace(/const CONTENT_BUILD_ID = '(?:[a-f0-9]{64}|unmanaged)';/,"const CONTENT_BUILD_ID = 'unmanaged';"));
        total+=data.length;
        if(total>32*1024*1024)throw Error('Extension files exceed limit');
        hash.update(path);hash.update('\0');hash.update(String(data.length));hash.update('\0');hash.update(data);
      }else throw Error('Invalid extension file');
    }
  }
  await visit();return hash.digest('hex');
}
/** 해시 계산에서 제외한 생성 표식도 별도로 검증해 콘텐츠 구버전 잔류를 막는다. */
export async function verifiedExtensionBuild(directory,expectedVersion){
  const info=await readFile(join(directory,'build-info.js'),'utf8');
  const buildId=/^export const BUILD_ID = '([a-f0-9]{64})';\s*$/.exec(info)?.[1];
  const manifest=await boundedJSON(join(directory,'manifest.json'));
  const content=await readFile(join(directory,'content.js'),'utf8');
  if(!buildId||buildId!==await fingerprintExtension(directory)||
    !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version||'')||
    expectedVersion!==undefined&&manifest.version!==expectedVersion||
    /const CONTENT_VERSION = '([^']+)';/.exec(content)?.[1]!==manifest.version||
    /const CONTENT_BUILD_ID = '([a-f0-9]{64})';/.exec(content)?.[1]!==buildId)throw Error('Extension build/version mismatch');
  return buildId;
}
export function extensionBrowserRoots({platform=process.platform,home=homedir(),env=process.env}={}){
  if(platform==='darwin')return ['Google/Chrome','BraveSoftware/Brave-Browser'].map(browser=>join(home,'Library/Application Support',browser));
  if(platform==='win32'){const local=env.LOCALAPPDATA||win32.join(home,'AppData/Local');return ['Google/Chrome/User Data','BraveSoftware/Brave-Browser/User Data'].map(browser=>win32.join(local,browser));}
  return [];
}
async function boundedJSON(file,max=1024*1024){
  const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max)throw Error('Invalid metadata');
  return JSON.parse(await readFile(file,'utf8'));
}
async function registeredSources(extensionId,roots){
  const paths=new Set();
  for(const root of roots){
    let profiles;try{profiles=await readdir(root,{withFileTypes:true});}catch{continue;}
    for(const profile of profiles){
      if(!profile.isDirectory()||profile.isSymbolicLink()||!(/^(?:Default|Profile \d+)$/.test(profile.name)))continue;
      for(const name of ['Preferences','Secure Preferences'])try{
        const file=join(root,profile.name,name);if(await realpath(file)!==resolve(file))continue;
        const entry=(await boundedJSON(file,32*1024*1024))?.extensions?.settings?.[extensionId];
        if(typeof entry?.path==='string'&&isAbsolute(entry.path))paths.add(resolve(entry.path));
      }catch{/* Missing/incomplete profile snapshots cannot authorize writes. */}
    }
  }
  return [...paths];
}
async function packagedSource(directory,key,extensionId){
  if(await realpath(directory)!==resolve(directory)||!(await lstat(directory)).isDirectory()||directory!==join(dirname(directory),'extension'))return false;
  const bundle=dirname(directory);
  // Never rewrite a developer checkout or follow a package's parent symlinks.
  for(let parent=bundle;;parent=dirname(parent)){
    try{await lstat(join(parent,'.git'));return false;}catch(error){if(error.code!=='ENOENT')return false;}
    if(dirname(parent)===parent)break;
  }
  const manifest=await boundedJSON(join(directory,'manifest.json'));
  const allowed=await boundedJSON(join(bundle,'allowed_extensions.json'));
  const pkg=await boundedJSON(join(bundle,'central/package.json'));
  if(manifest.key!==key||pkg.name!=='dico-manager'||!allowed.extensionIds?.includes(extensionId))return false;
  const launcher=join(bundle,process.platform==='win32'?'launcher.exe':'launcher'),runtime=join(bundle,'runtime',process.platform==='win32'?'node.exe':'node');
  for(const file of [launcher,runtime,join(bundle,'central/package.json'),join(bundle,'allowed_extensions.json')])if(await realpath(file)!==resolve(file)||(await lstat(file)).isSymbolicLink())return false;
  // Includes every file and rejects nested symlinks before any copy or rename.
  await fingerprintExtension(directory);return true;
}
async function replacePackagedSource(source,destination,buildId,move=rename,copy=cp){
  const suffix=randomBytes(8).toString('hex'),staging=destination+'.dico-staging-'+suffix,backup=destination+'.dico-backup-'+suffix,lock=destination+'.dico-update-lock';
  await mkdir(lock);let oldMoved=false,installed=false;
  try{
    await copy(source,staging,{recursive:true,errorOnExist:true,force:false});
    if(await verifiedExtensionBuild(staging)!==buildId)throw Error('Staged build changed');
    await move(destination,backup);oldMoved=true;
    try{await move(staging,destination);installed=true;}catch(error){await move(backup,destination);oldMoved=false;throw error;}
    await rm(backup,{recursive:true,force:true});oldMoved=false;
  }finally{
    await rm(staging,{recursive:true,force:true}).catch(()=>{});
    // A failed restore keeps its backup for manual recovery; never delete it.
    if(!oldMoved||installed)await rm(lock,{recursive:true,force:true}).catch(()=>{});
  }
}
export async function installedExtensionStatus(root,options={}) {
  const {reloadSafe=false,extensionId,move,copy}=options;
  let directory,buildId;
  try {
    directory=join(root,'extension');
    try{buildId=await verifiedExtensionBuild(directory);}catch{return{buildId:null,reloadSafe:false,reason:'BUILD_INCOMPLETE'};}
  }catch{return{buildId:null,reloadSafe:false,reason:'INSTALLATION_REQUIRED'};}
  const status={buildId,reloadSafe:reloadSafe===true};
  if(!/^[a-p]{32}$/.test(extensionId||''))return status;
  const diagnostic={extensionDirectory:resolve(directory),repairedCopies:0};
  if(!reloadSafe)return{...status,...diagnostic};
  try{
    const manifest=await boundedJSON(join(directory,'manifest.json'));
    const id=createHash('sha256').update(Buffer.from(manifest.key||'','base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,digit=>'abcdefghijklmnop'[parseInt(digit,16)]);
    if(id!==extensionId||await realpath(directory)!==resolve(directory))throw Error('Source identity mismatch');
    const paths=await registeredSources(extensionId,options.browserRoots||extensionBrowserRoots(options));
    let manual=false,repairFailed=false,knownUpdated=false;
    for(const candidate of paths){
      if(candidate===resolve(directory)){knownUpdated=true;continue;}
      let valid=false;
      try{if(await verifiedExtensionBuild(candidate)===buildId){knownUpdated=true;continue;}}catch{}
      try{valid=await packagedSource(candidate,manifest.key,extensionId);}catch{}
      if(!valid){manual=true;continue;}
      try{await replacePackagedSource(directory,candidate,buildId,move,copy);diagnostic.repairedCopies++;knownUpdated=true;}
      catch{repairFailed=true;}
    }
    // A separate unsupported profile cannot starve profiles using a verified
    // current copy. Old clients still permit at most one reload per build.
    return{...status,...diagnostic,...(manual||repairFailed?{reloadSafe:!repairFailed&&knownUpdated,reason:repairFailed?'EXTENSION_SOURCE_REPAIR_FAILED':'EXTENSION_SOURCE_MANUAL'}:{})};
  }catch{return{...status,...diagnostic,reloadSafe:false,reason:'EXTENSION_SOURCE_MANUAL'};}
}
