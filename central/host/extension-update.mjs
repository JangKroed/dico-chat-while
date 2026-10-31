import {createHash} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';

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
export async function installedExtensionStatus(root,{reloadSafe=false}={}) {
  try {
    const directory=join(root,'extension'),info=await readFile(join(directory,'build-info.js'),'utf8');
    const buildId=/^export const BUILD_ID = '([a-f0-9]{64})';\s*$/.exec(info)?.[1];
    if(!buildId||buildId!==await fingerprintExtension(directory))return{buildId:null,reloadSafe:false,reason:'BUILD_INCOMPLETE'};
    return{buildId,reloadSafe:reloadSafe===true};
  }catch{return{buildId:null,reloadSafe:false,reason:'INSTALLATION_REQUIRED'};}
}
