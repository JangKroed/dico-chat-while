import test from 'node:test';
import assert from 'node:assert/strict';
import {createNotificationDispatcher} from '../central/runtime/notifications.mjs';

test('새 버전은 재시작·동시 조회에도 한 번 알리고 계정 정보는 넣지 않는다',async()=>{
 let stored;const sent=[];
 const options={load:async()=>stored,save:async x=>{stored=structuredClone(x)},notify:async x=>{sent.push(x);return{status:'requested'}}};
 const s={settings:{notificationsEnabled:true,notificationTypes:[]}};
 const version={state:'available',currentVersion:'0.4.60',latestVersion:'0.4.61'};
 let d=createNotificationDispatcher(options);
 assert.equal(typeof d.update,'function');
 await Promise.all([d.update(s,version),d.update(s,version)]);
 d=createNotificationDispatcher(options);await d.update(s,version);
 assert.equal(sent.length,1);assert.equal(sent[0].route,'/settings');assert.match(sent[0].body,/0\.4\.61/);
 await d.update(s,{...version,latestVersion:'0.4.62'});assert.equal(sent.length,2);
});
test('알림 끔·방해금지·조회 실패는 새 버전 알림을 소비하지 않는다',async()=>{
 let stored,count=0,clock=new Date(2026,10,9,23).getTime();
 const d=createNotificationDispatcher({now:()=>clock,load:async()=>stored,save:async x=>stored=x,notify:async()=>{count++}});
 assert.equal(typeof d.update,'function');
 const update={state:'available',currentVersion:'0.4.60',latestVersion:'0.4.61'};
 await d.update({settings:{notificationsEnabled:false}},update);
 await d.update({settings:{notificationsEnabled:true,quietHours:{enabled:true,start:'22:00',end:'07:00'}}},update);
 await d.update({settings:{notificationsEnabled:true}},{...update,state:'unavailable'});
 assert.equal(count,0);
 clock+=9*60*60*1000;await d.update({settings:{notificationsEnabled:true}},update);assert.equal(count,1);
});
test('알림 이력 저장 실패 시 OS 알림을 보내지 않는다',async()=>{
 let count=0;const d=createNotificationDispatcher({save:async()=>{throw Error('disk')},notify:async()=>count++});
 assert.equal(typeof d.update,'function');
 await assert.rejects(d.update({settings:{notificationsEnabled:true}},{state:'available',currentVersion:'0.4.60',latestVersion:'0.4.61'}));assert.equal(count,0);
});

test('주기 확인은 중복되지 않고 종료 뒤 늦은 결과로 알리지 않는다',async()=>{
 const {createUpdateNotifier}=await import('../central/runtime/update-notifier.mjs');
 let time=0,checks=0,dispatches=0,release;
 const monitor=createUpdateNotifier({now:()=>time,intervalMs:100,check:()=>{checks++;return new Promise(r=>release=r)},snapshot:()=>({}),dispatch:()=>dispatches++});
 const first=monitor.tick();await Promise.resolve();await Promise.resolve();assert.equal(monitor.tick(),first);assert.equal(checks,1);
 release({state:'current'});await first;assert.equal(dispatches,1);
 time=99;await monitor.tick();assert.equal(checks,1);
 time=100;const second=monitor.tick();await Promise.resolve();await Promise.resolve();const closing=monitor.close();release({state:'available'});await Promise.all([second,closing]);assert.equal(dispatches,1);
 time=1000;await monitor.tick();assert.equal(checks,2);
});
test('버전 확인 실패도 다음 주기에 재시도하고 발송 루프에 오류를 던지지 않는다',async()=>{
 const {createUpdateNotifier}=await import('../central/runtime/update-notifier.mjs');let time=0,calls=0;
 const monitor=createUpdateNotifier({now:()=>time,intervalMs:10,check:async()=>{calls++;throw Error('offline')},snapshot:()=>({}),dispatch:()=>assert.fail()});
 await monitor.tick();time=10;await monitor.tick();assert.equal(calls,2);await monitor.close();
});

test('읽기 전용 버전 조회가 늦어도 종료와 업데이트 교체를 붙잡지 않는다',async()=>{
 const {createUpdateNotifier}=await import('../central/runtime/update-notifier.mjs');let release,closed=false,dispatched=false;
 const monitor=createUpdateNotifier({check:()=>new Promise(r=>release=r),snapshot:()=>({}),dispatch:()=>{dispatched=true}});
 const pending=monitor.tick();await Promise.resolve();await Promise.resolve();
 const closing=monitor.close().then(()=>{closed=true});await new Promise(r=>setImmediate(r));
 const before=closed;release({state:'available'});await Promise.all([pending,closing]);
 assert.equal(before,true);assert.equal(dispatched,false);
});
test('이미 시작한 알림 저장은 종료 전에 끝내고 잠금을 해제한다',async()=>{
 const {createUpdateNotifier}=await import('../central/runtime/update-notifier.mjs');let release,closed=false;
 const monitor=createUpdateNotifier({check:async()=>({state:'available'}),snapshot:()=>({}),dispatch:()=>new Promise(r=>release=r)});
 const pending=monitor.tick();await new Promise(r=>setImmediate(r));assert.equal(typeof release,'function');
 const closing=monitor.close().then(()=>{closed=true});await new Promise(r=>setImmediate(r));assert.equal(closed,false);
 release();await Promise.all([pending,closing]);assert.equal(closed,true);
});
test('알림 저장 실패와 종료가 겹쳐도 서버 정리 경로로 오류를 전파하지 않는다',async()=>{
 const {createUpdateNotifier}=await import('../central/runtime/update-notifier.mjs');let reject;
 const monitor=createUpdateNotifier({check:async()=>({state:'available'}),snapshot:()=>({}),dispatch:()=>new Promise((_,r)=>reject=r)});
 const pending=monitor.tick();await new Promise(r=>setImmediate(r));
 const closing=monitor.close();reject(Error('disk'));await assert.doesNotReject(closing);await pending;
});
