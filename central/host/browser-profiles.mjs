import {readdir,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';

const dicoExtensionId='ibkkihhaihlpjcahglnoiphcddcjipgh';
async function browserJson(file){
 if((await stat(file)).size>32*1024*1024)throw Error('Browser settings exceed size limit');
 return JSON.parse(await readFile(file,'utf8'));
}

// 실행 파일과 프로필 경로는 호스트가 발견합니다. 화면에서 임의 명령/경로를 받지 않습니다.
export async function discoverBrowserProfiles({platform=process.platform,home=homedir(),env=process.env}={}){
 const local=env.LOCALAPPDATA||join(home,'AppData','Local');
 const browsers=platform==='darwin'?[
  ['Chrome',join(home,'Library/Application Support/Google/Chrome'),'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  ['Brave',join(home,'Library/Application Support/BraveSoftware/Brave-Browser'),'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']
 ]:platform==='win32'?[
  ['Chrome',join(local,'Google/Chrome/User Data'),join(env.PROGRAMFILES||'C:\\Program Files','Google/Chrome/Application/chrome.exe')],
  ['Brave',join(local,'BraveSoftware/Brave-Browser/User Data'),join(env.PROGRAMFILES||'C:\\Program Files','BraveSoftware/Brave-Browser/Application/brave.exe')]
 ]:[];
 const result=[];
 for(const [browser,root,executable] of browsers){
  try{if(!(await stat(executable)).isFile())continue;}catch{continue;}
  let entries;try{entries=await readdir(root,{withFileTypes:true});}catch{continue;}
  const localState=await browserJson(join(root,'Local State')).catch(()=>null);
  const recent=[localState?.profile?.last_used,...(Array.isArray(localState?.profile?.last_active_profiles)?localState.profile.last_active_profiles:[])];
  const priority=name=>{const index=recent.indexOf(name);return index<0?Infinity:index;};
  entries.sort((a,b)=>priority(a.name)-priority(b.name)||a.name.localeCompare(b.name));
  for(const entry of entries){
   if(!entry.isDirectory()||! /^(Default|Profile \d+)$/.test(entry.name))continue;
   try{
    const directory=join(root,entry.name),prefs=await browserJson(join(directory,'Preferences'));
    const dicoInstalled=await stat(join(directory,'Local Extension Settings',dicoExtensionId)).then(s=>s.isDirectory(),()=>false);
    result.push({dicoInstalled,id:`${browser}:${entry.name}`,browser,profile:entry.name,name:String(prefs.profile?.name||entry.name).slice(0,100),executable,root});
   }catch{/* 잠긴/불완전 프로필은 실행 대상으로 추정하지 않습니다. */}
  }
 }
 return result;
}
export function launchBrowserProfile(profile,{spawnProcess=spawn}={}){
 return new Promise((resolve,reject)=>{
  const child=spawnProcess(profile.executable,[`--user-data-dir=${profile.root}`,`--profile-directory=${profile.profile}`,'https://discord.com/app'],{detached:true,stdio:'ignore',shell:false,windowsHide:false});
  child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});
 });
}
// 실행 요청이 있을 때만 이미 등록된 DICO 프로필을 차례로 확인합니다.
// 프로필 이름은 후보의 순서만 정하며, 발송 허가는 실제 계정 확인 뒤에만 나갑니다.
export function createBrowserPreparation({manager,discover=discoverBrowserProfiles,launch=launchBrowserProfile,now=Date.now}){
 let busy=false,closed=false;
 const jobs=new Map(),tried=new Map(),firstSeen=new Map();
 function missing(snapshot){
  const wanted=new Map();
  for(const g of snapshot.groups.filter(g=>!g.controlIntent&&(g.pendingStart||g.autoResume||g.status==='running'))){
   for(const id of g.members){
    const channel=snapshot.channels.find(c=>c.id===id);
    const instance=snapshot.instances.find(i=>i.id===channel?.instanceId);
    if(!instance||!instance.launchProfileId&&!['Chrome','Brave'].includes(instance.browser))continue;
    const online=instance.connected&&(instance.lastSeenAt===undefined||now()-instance.lastSeenAt<=15000);
    if(online&&(channel.verified||!channel.accountId||snapshot.accounts?.some(a=>a.instanceId===instance.id&&a.accountId===channel.accountId&&a.verified)))continue;
    wanted.set(instance.id,{instance,online});
   }
  }
  return wanted;
 }
 return{
  async list(){return(await discover()).map(({executable,root,...p})=>p);},
  status(){return [...jobs].map(([instanceId,value])=>({instanceId,...value}));},
  close(){closed=true;},
  async tick(){
   if(busy||closed)return;
   busy=true;
   try{
    const needed=missing(manager.snapshot()),at=now();
    for(const id of firstSeen.keys())if(!needed.has(id)){firstSeen.delete(id);jobs.delete(id);}
    if(!needed.size){tried.clear();return;}
    for(const id of needed.keys())if(!firstSeen.has(id))firstSeen.set(id,at);
    const due=[...needed.values()].filter(({instance,online})=>{
     const job=jobs.get(instance.id);
     if(online&&at-firstSeen.get(instance.id)<15000)return false;
     return !job||at-job.at>=30000;
    });
    if(!due.length)return;
    const profiles=await discover();
    for(const {instance} of due){
     const fresh=missing(manager.snapshot()).get(instance.id);
     if(closed||!fresh||fresh.instance.launchProfileId!==instance.launchProfileId||fresh.online&&now()-firstSeen.get(instance.id)<15000)continue;
     const candidates=profiles.filter(p=>p.browser===instance.browser&&(p.dicoInstalled||p.id===instance.launchProfileId));
     const profile=candidates.find(p=>p.id===instance.launchProfileId&&!tried.has(p.id))||
       candidates.find(p=>!tried.has(p.id));
     if(!profile){
      const state=candidates.length?'waiting_account':'profile_missing';
      jobs.set(instance.id,{state,at:now()});
      continue;
     }
     jobs.set(instance.id,{state:'opening',profileId:profile.id,at:now()});
     tried.set(profile.id,now());
     try{await launch(profile);jobs.set(instance.id,{state:'waiting_connection',profileId:profile.id,at:now()});}
     catch{tried.delete(profile.id);jobs.set(instance.id,{state:'launch_failed',profileId:profile.id,at:now()});}
    }
   }finally{busy=false;}
  }
 };
}
