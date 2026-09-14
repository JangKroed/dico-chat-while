import test from 'node:test';
import assert from 'node:assert/strict';
import {newChannelErrors, notifyChannelErrors} from '../notifications.js';
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
  const api={storage:{local:{get:async()=>({})}},runtime:{getURL:p=>p},notifications:{create:async(...args)=>calls.push(args)}};
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
