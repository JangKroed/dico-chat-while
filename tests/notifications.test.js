import test from 'node:test';
import assert from 'node:assert/strict';
import {newChannelErrors, notifyChannelErrors,createDiagnosticNotification} from '../notifications.js';
const root = error => ({channels:[{id:'one',name:'공지',error,messages:['private A','private B']}]});
test('새 오류만 알리고 동일 상태 저장·초기화는 반복 알리지 않는다', () => {
  assert.equal(newChannelErrors(root(null),root('연결 실패')).length,1);
  assert.equal(newChannelErrors(root('연결 실패'),root('연결 실패')).length,0);
  assert.equal(newChannelErrors(undefined,root('연결 실패')).length,0);
  assert.equal(newChannelErrors(root('연결 실패'),root(null)).length,0);
  assert.equal(newChannelErrors(root('연결 실패'),root('전송 불확실')).length,1);
});
test('알림에는 채널 이름과 오류만 포함하고 문구는 노출하지 않는다', async () => {
  const calls=[];
  const api={storage:{local:{get:async()=>({}),set:async()=>{}}},runtime:{getURL:p=>p,getManifest:()=>({version:'test'})},notifications:{getPermissionLevel:async()=>'granted',clear:async()=>{},getAll:async()=>({}),create:async(...args)=>calls.push(args)}};
  await notifyChannelErrors(api,root(null),root('연결 실패'));
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],'dico-error:one');
  assert.equal(calls[0][1].title,'DICO · 공지 오류');
  assert.equal(calls[0][1].message,'연결 실패');
  assert.equal(JSON.stringify(calls).includes('private'),false);
  api.storage.local.get=async()=>({errorNotificationsEnabled:false});
  await notifyChannelErrors(api,root(null),root('새 오류'));
  assert.equal(calls.length,1);
});

test('알림 생성 성공과 등록 실패를 구분하고 버전·허용 상태를 진단에 남긴다',async()=>{
 let saved;const api={runtime:{getManifest:()=>({version:'0.2.40'})},storage:{local:{set:async d=>saved=d}},notifications:{getPermissionLevel:async()=>'granted',clear:async()=>{},create:async id=>id,getAll:async()=>({})}};
 const result=await createDiagnosticNotification(api,'test',{message:'private'});
 assert.equal(result.registered,false);assert.equal(saved.lastNotificationDiagnostic.stage,'checked');
 assert.equal(saved.lastNotificationDiagnostic.permission,'granted');assert.equal(saved.lastNotificationDiagnostic.version,'0.2.40');
 assert.equal(JSON.stringify(saved).includes('private'),false);
 api.notifications.create=async()=>{throw Error('API failed')};
 await assert.rejects(createDiagnosticNotification(api,'test',{}),/API failed/);
 assert.equal(saved.lastNotificationDiagnostic.error,'API failed');
});
