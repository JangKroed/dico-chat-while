import test from 'node:test';
import assert from 'node:assert/strict';
import {createNotificationDispatcher,inQuietHours} from '../central/runtime/notifications.mjs';
import {createCentralManager} from '../central/core/index.js';

test('기본 알림 유형에는 저장 실패와 실행 명령 거절이 포함된다',()=>{
  const manager=createCentralManager();
  try{const types=manager.snapshot().settings.notificationTypes;assert.ok(types.includes('storage_failure'));assert.ok(types.includes('command_rejected'));}
  finally{manager.close();}
});

test('중복 사건과 재시작·연결 반복은 한 번만 요청하고 본문·계정명을 숨긴다',async()=>{
  let stored,clock=100000;const sent=[];
  const options={notify:async packet=>{sent.push(packet);return {status:'requested'};},load:async()=>stored,save:async v=>{stored=structuredClone(v);},now:()=>clock};
  const snap={settings:{notificationsEnabled:true,notificationTypes:['connection_lost'],hideNotificationNames:true,cooldownMs:300000},incidents:[{id:'incident-one',code:'connection_lost',status:'open',instanceId:'chrome',name:'PRIVATE_ACCOUNT',body:'PRIVATE_MESSAGE'}]};
  let dispatcher=createNotificationDispatcher(options);
  await dispatcher.process(snap);await dispatcher.process(snap);assert.equal(sent.length,1);
  dispatcher=createNotificationDispatcher(options);await dispatcher.process(snap);assert.equal(sent.length,1);
  snap.incidents[0].id='incident-two';clock+=60000;await dispatcher.process(snap);assert.equal(sent.length,1);
  assert.equal(JSON.stringify(sent).includes('PRIVATE'),false);
  clock+=300000;await dispatcher.process(snap);assert.equal(sent.length,2);
});
test('알림 끔·유형 제외·방해금지는 OS 알림을 요청하지 않는다',async()=>{
  let count=0;
  const d=createNotificationDispatcher({notify:async()=>{count++;return {status:'requested'};},load:async()=>undefined,save:async()=>{},now:()=>new Date(2026,9,30,23,0).getTime()});
  const snap={settings:{notificationsEnabled:false},incidents:[{id:'one',code:'delivery_unknown',status:'open'}]};
  await d.process(snap);snap.settings={notificationsEnabled:true,notificationTypes:[]};await d.process(snap);
  snap.settings={notificationsEnabled:true,notificationTypes:['delivery_unknown'],quietHours:{enabled:true,start:'22:00',end:'07:00'}};await d.process(snap);
  assert.equal(count,0);assert.equal(inQuietHours(snap.settings.quietHours,new Date(2026,9,30,23,0)),true);
});
test('알림 이력 저장 실패 시 중복 위험이 있는 OS 전송을 수행하지 않는다',async()=>{
  let count=0;const d=createNotificationDispatcher({notify:async()=>{count++;},load:async()=>undefined,save:async()=>{throw Error('disk');}});
  await assert.rejects(()=>d.process({settings:{notificationsEnabled:true},incidents:[{id:'one',code:'delivery_unknown',status:'open'}]}));assert.equal(count,0);
});
