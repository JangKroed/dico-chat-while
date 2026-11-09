import {readdir,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';

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
export function launchBrowserProfile(profile,{spawnProcess=spawn,probeId}={}){
 return new Promise((resolve,reject)=>{
  const url=probeId?'https://discord.com/channels/@me#dico-profile='+probeId:'https://discord.com/app';
  const child=spawnProcess(profile.executable,[`--user-data-dir=${profile.root}`,`--profile-directory=${profile.profile}`,url],{detached:true,stdio:'ignore',shell:false,windowsHide:false});
  child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});
 });
}
// 실행 요청이 있을 때만 이미 등록된 DICO 프로필을 차례로 확인합니다.
// 프로필 이름은 후보의 순서만 정하며, 발송 허가는 실제 계정 확인 뒤에만 나갑니다.
export function createBrowserPreparation({manager,discover=discoverBrowserProfiles,launch=launchBrowserProfile,now=Date.now}){
 let busy=false,closed=false;
 const jobs=new Map(),tried=new Map(),firstSeen=new Map(),probes=new Map();
 function missing(snapshot){
  const wanted=new Map();
  for(const g of snapshot.groups.filter(g=>g.enabled!==false&&(g.controlIntent?g.controlIntent==='pause'&&g.autoResume:g.pendingStart||g.autoResume||g.status==='running'))){
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
  close(){closed=true;probes.clear();},
  observeProfile(message,instanceId){
   const probe=probes.get(message.probeId);
   if(!probe||now()>=probe.expiresAt)return{ok:true,recognized:false};
   // 프로필 경로는 브라우저가 제출하지 않습니다. 호스트가 직접 연 후보만 저장합니다.
   const result=manager.rememberBrowserProfile(message,instanceId,probe.profileId);
   if(result.recognized)probes.delete(message.probeId);
   return result;
  },
  async tick(){
   if(busy||closed)return;
   busy=true;
   try{
    const needed=missing(manager.snapshot()),at=now();
    for(const [id,probe] of probes)if(at>=probe.expiresAt)probes.delete(id);
    for(const id of firstSeen.keys())if(!needed.has(id)){
     firstSeen.delete(id);jobs.delete(id);
     // 연결이 회복된 뒤의 새 장애는 다른 브라우저의 대기와 별개입니다.
     for(const [profileId,ownerId] of tried)if(ownerId===id)tried.delete(profileId);
    }
    if(!needed.size)return;
    for(const id of needed.keys())if(!firstSeen.has(id))firstSeen.set(id,at);
    const due=[...needed.values()].filter(({instance,online})=>{
     const job=jobs.get(instance.id);
     if(online&&at-firstSeen.get(instance.id)<15000)return false;
     return !job||at-job.at>=30000;
    });
    if(!due.length)return;
    const profiles=await discover();
    for(const {instance} of due){
     const current=manager.snapshot(),fresh=missing(current).get(instance.id);
     if(closed||!fresh||fresh.instance.browser!==instance.browser||fresh.online&&now()-firstSeen.get(instance.id)<15000)continue;
     const {launchProfileId,observedProfileId}=fresh.instance;
     const candidates=profiles.filter(p=>p.browser===instance.browser&&(p.dicoInstalled||p.id===launchProfileId));
     const available=candidates.filter(p=>!tried.has(p.id)&&!current.instances.some(i=>
       i.id!==instance.id&&i.connected&&i.observedProfileId===p.id&&(i.lastSeenAt===undefined||now()-i.lastSeenAt<=15000)));
     const profile=available.find(p=>p.id===observedProfileId)||available.find(p=>p.id===launchProfileId)||available[0];
     if(!profile){
      const state=candidates.length?'waiting_account':'profile_missing';
      jobs.set(instance.id,{state,at:now()});
      continue;
     }
     jobs.set(instance.id,{state:'opening',profileId:profile.id,at:now()});
     tried.set(profile.id,instance.id);
     const probeId=randomBytes(16).toString('hex');
     probes.set(probeId,{profileId:profile.id,expiresAt:now()+120000});
     try{await launch(profile,{probeId});jobs.set(instance.id,{state:'waiting_connection',profileId:profile.id,at:now()});}
     catch{probes.delete(probeId);tried.delete(profile.id);jobs.set(instance.id,{state:'launch_failed',profileId:profile.id,at:now()});}
    }
   }finally{busy=false;}
  }
 };
}
