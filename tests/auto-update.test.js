import test from 'node:test';
import assert from 'node:assert/strict';
import {createAutoUpdater} from '../auto-update.js';
function rig(channels=[]){
 let stored={autoUpdateEnabled:true},native=0,reloads=0,reply={ok:true,updated:true,version:'0.2.42'};
 const api={runtime:{getManifest:()=>({version:'0.2.41'}),sendNativeMessage:async()=>{native++;return reply},reload:()=>{reloads++}},
 permissions:{contains:async()=>true},storage:{local:{get:async()=>stored,set:async v=>Object.assign(stored,v)}},tabs:{get:async id=>({url:'https://discord.com/channels/1/'+id}),sendMessage:async()=>({ok:true,diagnostics:{draftEmpty:true}})}};
 api.runtime.connectNative=()=>{
  let receive,disconnect;
  return {onMessage:{addListener:fn=>receive=fn},onDisconnect:{addListener:fn=>disconnect=fn},disconnect(){},postMessage:message=>{Promise.resolve().then(()=>api.runtime.sendNativeMessage('test',message)).then(value=>receive(value),()=>disconnect());}};
 };
 const updater=createAutoUpdater(api,async()=>({channels}));
 return {updater,stored,api,native:()=>native,reloads:()=>reloads,reply:r=>{reply=r}};
}
test('자동 업데이트는 실행·pending·prepared 상태에서 파일 교체를 요청하지 않는다',async()=>{
 for(const flag of ['enabled','pending','prepared']){const r=rig([{[flag]:true}]);await r.updater.apply();assert.equal(r.native(),0);assert.equal(r.stored.autoUpdateStatus.phase,'waiting');}
});
test('빈 전용 탭만 확인하고 파일 교체 완료 후 확장 새로고침한다',async()=>{
 const r=rig([{target:{managed:true,tabId:7,guildId:'1',channelId:'7'}}]);await r.updater.apply();assert.equal(r.native(),1);assert.equal(r.reloads(),1);assert.deepEqual(r.stored.updaterReloadTabs,[{tabId:7,url:'https://discord.com/channels/1/7'}]);
});
test('초안·응답 실패가 있으면 업데이트하지 않고 설정을 보존한다',async()=>{
 const r=rig([{target:{managed:true,tabId:7,guildId:'1',channelId:'7'}}]);r.api.tabs.sendMessage=async()=>({ok:true,diagnostics:{draftEmpty:false}});await r.updater.apply();assert.equal(r.native(),0);assert.equal(r.reloads(),0);
});
test('보조 프로그램 실패·통신 유실은 자동 새로고침하지 않는다',async()=>{
 const r=rig();r.reply({ok:false,error:'hash mismatch'});await r.updater.apply();assert.equal(r.reloads(),0);assert.equal(r.stored.autoUpdateStatus.phase,'error');
});
test('중복 요청을 합치고 적용 중에는 잠근다',async()=>{
 const r=rig();let finish;r.api.runtime.sendNativeMessage=()=>new Promise(resolve=>finish=resolve);
 const first=r.updater.apply(),second=r.updater.apply();assert.equal(first,second);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(r.updater.locked,true);finish({ok:true,updated:false});await first;assert.equal(r.updater.locked,false);
});

test('다운로드 중 사용자가 새 초안을 쓰면 해당 탭은 새로고침 대상에서 제외한다',async()=>{
 const r=rig([{target:{managed:true,tabId:7,guildId:'1',channelId:'7'}}]);let reads=0;
 r.api.tabs.sendMessage=async()=>({diagnostics:{draftEmpty:++reads===1}});
 await r.updater.apply();assert.equal(r.reloads(),1);assert.deepEqual(r.stored.updaterReloadTabs,[]);assert.match(r.stored.autoUpdateStatus.message,/보존/);
});
