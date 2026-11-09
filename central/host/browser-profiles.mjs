import {readdir,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';

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
  for(const entry of entries){
   if(!entry.isDirectory()||! /^(Default|Profile \d+)$/.test(entry.name))continue;
   try{const file=join(root,entry.name,'Preferences');if((await stat(file)).size>32*1024*1024)continue;
    const prefs=JSON.parse(await readFile(file,'utf8'));
    result.push({id:`${browser}:${entry.name}`,browser,profile:entry.name,name:String(prefs.profile?.name||entry.name).slice(0,100),executable,root});
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
// 실행 의도별 프로필 단일 요청. 성공은 연결 확인과 구분하며 응답이 없다고 창을 반복 생성하지 않습니다.
export function createBrowserPreparation({manager,discover=discoverBrowserProfiles,launch=launchBrowserProfile,now=Date.now}){
 let busy=false,closed=false;const jobs=new Map();
 const wanted=s=>new Set(s.groups.filter(g=>g.pendingStart||g.autoResume||g.status==='running').flatMap(g=>g.members.map(id=>s.channels.find(c=>c.id===id)?.instanceId)).filter(Boolean));
 return{
  async list(){return(await discover()).map(({executable,root,...p})=>p);},
  status(){return [...jobs].map(([instanceId,value])=>({instanceId,...value}));},
  close(){closed=true;},
  async tick(){
   if(busy||closed)return;busy=true;
   try{
    const snapshot=manager.snapshot(),needed=wanted(snapshot);
    for(const [id,job] of jobs)if(!needed.has(id)||snapshot.instances.find(i=>i.id===id)?.connected||['launch_failed','profile_missing'].includes(job.state)&&now()-job.at>=30000)jobs.delete(id);
    for(const i of snapshot.instances){
     if(!needed.has(i.id)||i.connected||!i.launchProfileId||jobs.has(i.id))continue;
     jobs.set(i.id,{state:'opening',profileId:i.launchProfileId,at:now()});
     const profile=(await discover()).find(p=>p.id===i.launchProfileId&&p.browser===i.browser);
     const fresh=manager.snapshot(),current=fresh.instances.find(x=>x.id===i.id);
     if(closed||!wanted(fresh).has(i.id)||current?.connected||current?.launchProfileId!==i.launchProfileId){jobs.delete(i.id);continue;}
     if(!profile){jobs.set(i.id,{state:'profile_missing',profileId:i.launchProfileId,at:now()});continue;}
     try{await launch(profile);jobs.set(i.id,{state:'waiting_connection',profileId:i.launchProfileId,at:now()});}
     catch{jobs.set(i.id,{state:'launch_failed',profileId:i.launchProfileId,at:now()});}
    }
   }finally{busy=false;}
  }
 };
}
