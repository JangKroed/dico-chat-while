import test from 'node:test';import assert from 'node:assert/strict';
import {createBrowserPreparation,launchBrowserProfile} from '../central/host/browser-profiles.mjs';
function rig(){const s={instances:[{id:'i',browser:'Chrome',launchProfileId:'Chrome:Default',connected:false}],groups:[{id:'g',pendingStart:true,members:['c']}],channels:[{id:'c',instanceId:'i'}]},calls=[];const p={id:'Chrome:Default',browser:'Chrome',profile:'Default',root:'/root with space',executable:'/browser'};return{s,calls,p,manager:{snapshot:()=>structuredClone(s)},discover:async()=>[p],launch:async p=>calls.push(p.id)};}
test('닫힌 프로필은 한 번 열고 연결을 기다리며 기존 연결은 재사용한다',async()=>{const r=rig(),c=createBrowserPreparation(r);await Promise.all([c.tick(),c.tick()]);await c.tick();assert.deepEqual(r.calls,['Chrome:Default']);assert.equal(c.status()[0].state,'waiting_connection');r.s.instances[0].connected=true;await c.tick();assert.equal(c.status().length,0);assert.equal(r.calls.length,1);});
test('프로필 발견 도중 중지하면 브라우저를 열지 않는다',async()=>{const r=rig();r.discover=async()=>{r.s.groups=[];return[r.p];};await createBrowserPreparation(r).tick();assert.deepEqual(r.calls,[]);});
test('다른 브라우저 또는 삭제된 프로필을 대신 열지 않는다',async()=>{const r=rig();r.p.browser='Brave';const c=createBrowserPreparation(r);await c.tick();assert.deepEqual(r.calls,[]);assert.equal(c.status()[0].state,'profile_missing');});
test('실행 실패는 표시하고 창 생성 요청을 반복하지 않는다',async()=>{const r=rig();r.launch=async()=>{throw Error('missing');};const c=createBrowserPreparation(r);await c.tick();await c.tick();assert.equal(c.status()[0].state,'launch_failed');});
test('프로필 인자는 셸 해석 없이 별도 인자로 전달한다',async()=>{let seen;await launchBrowserProfile({executable:'/browser',root:'/root with space',profile:'Profile 2'},{spawnProcess:(...args)=>{seen=args;return{once(event,fn){if(event==='spawn')queueMicrotask(fn);},unref(){}};}});assert.equal(seen[2].shell,false);assert.deepEqual(seen[1],['--user-data-dir=/root with space','--profile-directory=Profile 2','https://discord.com/app']);});
test('저장한 프로필이 없어도 DICO가 발견된 브라우저만 자동 실행 후보가 된다',async()=>{
 const r=rig();delete r.s.instances[0].launchProfileId;
 r.s.channels[0].accountId='111';
 r.s.accounts=[{instanceId:'i',accountId:'111',verified:false}];
 r.discover=async()=>[{...r.p,id:'Chrome:Other'}, {...r.p,dicoInstalled:true}];
 const c=createBrowserPreparation(r);await c.tick();await c.tick();
 assert.deepEqual(r.calls,['Chrome:Default']);
 r.s.accounts[0].verified=true;r.s.instances[0].connected=true;
 await c.tick();assert.equal(c.status().length,0);
});
test('최근 후보에서 계정이 확인되지 않으면 다음 후보를 한 번 열고 같은 탭을 반복 생성하지 않는다',async()=>{
 const r=rig();delete r.s.instances[0].launchProfileId;
 r.s.channels[0].accountId='111';
 let time=0;r.now=()=>time;
 r.discover=async()=>[{...r.p,dicoInstalled:true},{...r.p,id:'Chrome:Profile 2',dicoInstalled:true}];
 const c=createBrowserPreparation(r);
 await c.tick();time+=29000;await c.tick();
 assert.deepEqual(r.calls,['Chrome:Default']);
 time+=1000;await c.tick();
 assert.deepEqual(r.calls,['Chrome:Default','Chrome:Profile 2']);
 time+=30000;await c.tick();
 assert.deepEqual(r.calls,['Chrome:Default','Chrome:Profile 2']);
 assert.equal(c.status()[0].state,'waiting_account');
});
test('다른 브라우저가 대기 중이어도 연결 복구 후 다시 끊긴 프로필을 다시 연다',async()=>{
 const r=rig();let time=0;r.now=()=>time;
 r.s.instances.push({id:'b',browser:'Brave',connected:false});
 r.s.groups[0].members.push('cb');r.s.channels.push({id:'cb',instanceId:'b'});
 const brave={...r.p,id:'Brave:Default',browser:'Brave',dicoInstalled:true};r.discover=async()=>[r.p,brave];
 const c=createBrowserPreparation(r);await c.tick();
 r.s.instances[0].connected=true;time+=5000;await c.tick();
 r.s.instances[0].connected=false;time+=31000;await c.tick();
 assert.deepEqual(r.calls,['Chrome:Default','Brave:Default','Chrome:Default']);
});
test('현재 계정의 실행기가 확인한 프로필을 브라우저의 최근 사용 프로필보다 먼저 연다',async()=>{
 const r=rig();delete r.s.instances[0].launchProfileId;r.s.instances[0].observedProfileId='Chrome:Profile 2';
 const correct={...r.p,id:'Chrome:Profile 2',profile:'Profile 2',dicoInstalled:true};
 r.discover=async()=>[{...r.p,dicoInstalled:true},correct];
 const c=createBrowserPreparation(r);await c.tick();
 assert.deepEqual(r.calls,['Chrome:Profile 2']);
});
test('자동 일시정지의 응답을 받기 위해 브라우저를 복원하되 사용자 중지에서는 열지 않는다',async()=>{
 const r=rig();r.s.groups[0]={status:'pause_pending',controlIntent:'pause',autoResume:{reasonCode:'connection_lost'},members:['c']};
 const c=createBrowserPreparation(r);await c.tick();
 assert.deepEqual(r.calls,['Chrome:Default']);
 const stopped=rig();stopped.s.groups[0]={status:'stop_pending',controlIntent:'stop',members:['c']};
 await createBrowserPreparation(stopped).tick();assert.deepEqual(stopped.calls,[]);
});
