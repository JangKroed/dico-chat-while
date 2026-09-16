import test from 'node:test';
import assert from 'node:assert/strict';
import { createController, parseChannel } from '../controller.js';

const target = { tabId: 7, url: 'https://discord.com/channels/123/456', guildId: '123', channelId: '456', title: '공지' };
function rig(initial) {
  let stored = initial ? structuredClone(initial) : undefined;
  let time = 1000000;
  let alarm = null;
  const sent = [];
  const io = {
    load: async () => structuredClone(stored),
    save: async state => { stored = structuredClone(state); },
    schedule: async at => { alarm = at; },
    cancel: async () => { alarm = null; },
    inspect: async () => ({ ok: true }),
    send: async (channel, delivery) => { sent.push(delivery.text); return { status: 'confirmed' }; },
    now: () => time,
    id: () => `delivery-${time}`,
  };
  return {
    io, sent,
    controller: createController(io),
    get state() { return structuredClone(stored); },
    get alarm() { return alarm; },
    advance: seconds => { time += seconds * 1000; },
  };
}
async function configured() {
  const r = rig();
  await r.controller.updateSettings({ messages: ['공지 A', '공지 B'], intervalSeconds: 30 });
  await r.controller.bind(target);
  return r;
}

test('A 성공 후 중지하고 컨트롤러를 재생성해도 B부터 전송한다', async () => {
  const r = await configured();
  await r.controller.start();
  assert.deepEqual(r.sent, ['공지 A']);
  assert.equal(r.alarm, 1030000);
  await r.controller.stop();
  const restarted = createController(r.io);
  await restarted.start();
  assert.deepEqual(r.sent, ['공지 A', '공지 B']);
  assert.equal(r.state.nextIndex, 0);
});

test('기한 전 실행과 중복 알람은 추가 메시지를 보내지 않는다', async () => {
  const r = await configured();
  await r.controller.start();
  await r.controller.tick();
  assert.equal(r.sent.length, 1);
  r.advance(30);
  await r.controller.tick();
  await r.controller.tick();
  assert.equal(r.sent.length, 2);
});

test('전송 전 실패는 A 순서를 유지하고 예약을 중지한다', async () => {
  const r = await configured();
  r.io.send = async () => ({ status: 'blocked', error: '작성 중인 메시지가 있습니다.' });
  await r.controller.start();
  assert.equal(r.state.enabled, false);
  assert.equal(r.state.nextIndex, 0);
  assert.equal(r.state.pending, null);
  assert.equal(r.alarm, null);
});

test('응답 유실은 자동 재전송하지 않고 사용자가 발송 확인하면 B로 넘긴다', async () => {
  const r = await configured();
  r.io.send = async () => { throw new Error('응답 유실'); };
  await r.controller.start();
  assert.equal(r.state.enabled, false);
  assert.ok(r.state.pending);
  await assert.rejects(() => r.controller.start());
  await r.controller.resolvePending('sent');
  assert.equal(r.state.nextIndex, 1);
  assert.equal(r.state.pending, null);
  assert.equal(r.state.enabled, false);
});

test('불확실한 전송을 미발송으로 확인하면 순서를 유지한다', async () => {
  const r = await configured();
  r.io.send = async () => ({ status: 'uncertain', error: '확인 시간 초과' });
  await r.controller.start();
  await r.controller.resolvePending('not-sent');
  assert.equal(r.state.nextIndex, 0);
  assert.equal(r.state.pending, null);
});

test('실행 중 강제 종료 흔적이 있으면 복구 시 자동 발송을 막는다', async () => {
  const r = await configured();
  await r.controller.start();
  const interrupted = { ...r.state, pending: { id: 'lost', index: 0, text: '공지 A', startedAt: 1000000 } };
  const recovered = rig(interrupted);
  await recovered.controller.recover();
  assert.equal(recovered.state.enabled, false);
  assert.ok(recovered.state.pending);
  assert.equal(recovered.sent.length, 0);
});

test('절전 뒤 밀린 주기를 몰아서 발송하지 않는다', async () => {
  const r = await configured();
  await r.controller.start();
  r.advance(3600);
  await r.controller.tick();
  assert.deepEqual(r.sent, ['공지 A', '공지 B']);
  assert.equal(r.alarm, 4630000);
});

test('정상 저장 상태의 복구는 순서를 보존하고 알람을 복원한다', async () => {
  const r = await configured();
  await r.controller.start();
  const resumed = rig(r.state);
  await resumed.controller.recover();
  assert.equal(resumed.state.nextIndex, 1);
  assert.equal(resumed.alarm, 1030000);
  assert.deepEqual(resumed.sent, []);
});

test('문구·주기 수정은 B 순서를 초기화하지 않는다', async () => {
  const r = await configured();
  await r.controller.start();
  await r.controller.stop();
  await r.controller.updateSettings({ messages: ['새 A', '새 B'], intervalSeconds: 60 });
  assert.equal(r.state.nextIndex, 1);
});

test('잘못된 설정과 발송 중 설정 변경을 거부한다', async () => {
  const r = await configured();
  for (const settings of [
    { messages: ['', 'B'], intervalSeconds: 30 },
    { messages: ['A', 'B'], intervalSeconds: 29 },
    { messages: ['A', 'B'], intervalSeconds: 30.5 },
    { messages: ['A'.repeat(2001), 'B'], intervalSeconds: 30 },
    { messages: ['@everyone', 'B'], intervalSeconds: 30 },
    { messages: ['A', '<@&123>'], intervalSeconds: 30 },
  ]) await assert.rejects(() => r.controller.updateSettings(settings));
  await r.controller.start();
  await assert.rejects(() => r.controller.updateSettings({ messages: ['X', 'Y'], intervalSeconds: 60 }));
});

test('다른 도메인·DM·불완전한 경로는 채널 대상으로 허용하지 않는다', () => {
  assert.deepEqual(parseChannel('https://discord.com/channels/123/456'), { guildId: '123', channelId: '456' });
  for (const url of ['https://evil.test/channels/123/456', 'https://discord.com/channels/@me/456', 'https://discord.com/channels/123', 'http://discord.com/channels/123/456']) {
    assert.equal(parseChannel(url), null);
  }
});

test('전송 전 watchdog 등록 실패는 순서를 유지하고 정지한다', async () => {
  const r = await configured();
  r.io.schedule = async () => { throw new Error('alarm unavailable'); };
  await r.controller.start();
  assert.equal(r.state.enabled, false);
  assert.equal(r.state.pending, null);
  assert.equal(r.state.nextIndex, 0);
  assert.deepEqual(r.sent, []);
});

test('성공 직후 종료로 남은 이른 watchdog도 다음 예약을 복원한다', async () => {
  const r = await configured();
  await r.controller.updateSettings({ messages: ['A', 'B'], intervalSeconds: 300 });
  await r.controller.start();
  r.advance(60);
  await r.io.cancel();
  await r.controller.tick();
  assert.equal(r.alarm, 1300000);
  assert.deepEqual(r.sent, ['A']);
});

test('알람으로 깨어난 worker 복구는 도래한 전송을 계속 미루지 않는다', async () => {
  const r = await configured();
  await r.controller.start();
  r.advance(31);
  await r.controller.recover({ preserveDue: true });
  await r.controller.tick();
  assert.deepEqual(r.sent, ['공지 A', '공지 B']);
});

test('복구 중 알람 등록 실패도 실행 중으로 방치하지 않는다', async () => {
  const r = await configured();
  await r.controller.start();
  r.io.schedule = async () => { throw new Error('alarm unavailable'); };
  await r.controller.recover();
  assert.equal(r.state.enabled, false);
  assert.equal(r.state.pending, null);
});


test('이미 실행 중인 채널을 다시 시작해도 즉시 중복 발송하지 않는다', async () => {
  const r = await configured();
  await r.controller.start();
  await r.controller.start();
  assert.deepEqual(r.sent, ['공지 A']);
  assert.equal(r.alarm, 1030000);
});

test('즉시 발송이 확인된 시점부터 설정한 주기를 예약한다', async () => {
  const r = await configured();
  r.io.send = async (_target, delivery) => {
    assert.equal(r.state.pending.id, delivery.id);
    assert.equal(r.alarm, 1060000);
    r.advance(5);
    return { status: 'confirmed' };
  };
  await r.controller.start();
  assert.equal(r.state.lastSentAt, 1005000);
  assert.equal(r.alarm, 1035000);
  assert.equal(r.state.nextIndex, 1);
});

test('대상 연결은 확장 기능이 관리하는 탭 표시를 유지한다', async () => {
  const r = await configured();
  await r.controller.bind({ ...target, managed: true });
  assert.equal(r.state.target.managed, true);
});

test('같은 채팅방을 일반 탭에서 다시 연결해도 전송용 창을 보존한다', async () => {
  const r = await configured();
  await r.controller.bind({...target, tabId:99, managed:true, windowManaged:true});
  await r.controller.bind({...target, tabId:7});
  assert.equal(r.state.target.tabId,99);
  assert.equal(r.state.target.windowManaged,true);
  await r.controller.bind({...target, tabId:8, url:'https://discord.com/channels/123/789'});
  assert.equal(r.state.target.tabId,8);
  assert.equal(r.state.target.managed,undefined);
});

test('남은 공지는 주기 후 같은 차례로 최대 3회 재시도하고 성공하면 차례를 넘긴다',async()=>{
 const r=await configured();let calls=0;
 r.io.send=async()=>++calls<3?{status:'draft-retained',error:'남음'}:{status:'confirmed'};
 await r.controller.start();assert.equal(r.state.enabled,true);assert.equal(r.state.pending,null);assert.equal(r.state.nextIndex,0);
 await r.controller.tick();assert.equal(calls,1);
 r.advance(30);await r.controller.tick();assert.equal(calls,2);assert.equal(r.state.nextIndex,0);
 r.advance(30);await r.controller.tick();assert.equal(r.state.nextIndex,1);assert.equal(r.state.draftRetries,0);
});
test('잔류 초안 재시도 횟수는 worker 재생성 뒤에도 유지되고 한도에서 중지한다',async()=>{
 const r=await configured();let calls=0;r.io.send=async()=>{calls++;return {status:'draft-retained',error:'남음'};};
 await r.controller.start();
 for(let i=0;i<3;i++){r.advance(30);await createController(r.io).tick();}
 assert.equal(calls,4);assert.equal(r.state.enabled,false);assert.ok(r.state.pending);assert.equal(r.state.nextIndex,0);
});
test('재시도 전에 늦게 게시된 흔적이 발견되면 재전송 없이 원래 전송 확인으로 전환한다',async()=>{
 const r=await configured();let calls=0;r.io.send=async()=>{calls++;return {status:'draft-retained',error:'남음'};};
 await r.controller.start();const original=r.state.draftRetryPending.id;
 r.io.inspect=async()=>({ok:false,code:'POSSIBLY_SENT',error:'게시 흔적'});
 r.advance(30);await r.controller.tick();
 assert.equal(calls,1);assert.equal(r.state.enabled,false);assert.equal(r.state.pending.id,original);
 await r.controller.resolvePending('sent');assert.equal(r.state.nextIndex,1);assert.equal(r.state.draftRetrySince,null);
});

test('슬로우 모드가 남아 있으면 입력하지 않고 A 차례로 대기한 뒤 한 번 전송한다', async () => {
  const r = await configured();
  r.io.inspect = async () => ({ok:true,cooldownMs:65000});
  await r.controller.start();
  assert.equal(r.sent.length,0);
  assert.equal(r.state.enabled,true);
  assert.equal(r.state.pending,null);
  assert.equal(r.state.nextIndex,0);
  assert.equal(r.alarm,1066500);
  r.advance(66.5);
  r.io.inspect = async () => ({ok:true,cooldownMs:0});
  await r.controller.tick();
  assert.deepEqual(r.sent,['공지 A']);
  assert.equal(r.state.nextIndex,1);
  assert.equal(r.state.slowmodeUntil,null);
});
test('입력 후 제한을 발견하면 재시도 횟수 없이 대기하고 수동 게시 흔적은 보호한다',async()=>{
 const r=await configured();
 r.io.send=async()=>({status:'deferred',retryAfterMs:1000,draftPrepared:true});
 await r.controller.start();
 assert.equal(r.state.pending,null);
 assert.equal(r.state.draftRetries,0);
 assert.equal(r.state.nextIndex,0);
 assert.equal(r.state.draftRetrySince,1000000);
 assert.equal(r.alarm,1030000);
 r.advance(30);
 r.io.inspect=async()=>({ok:false,code:'POSSIBLY_SENT',error:'게시 흔적'});
 await r.controller.tick();
 assert.equal(r.state.enabled,false);
 assert.ok(r.state.pending);
});
test('슬로우 모드 대기 중 중지하면 알람을 해제하고 재개 시 현재 제한을 다시 확인한다',async()=>{
 const r=await configured();r.io.inspect=async()=>({ok:true,cooldownMs:120000});
 await r.controller.start();await r.controller.stop();r.advance(130);
 await r.controller.tick();assert.equal(r.sent.length,0);assert.equal(r.alarm,null);
 r.io.inspect=async()=>({ok:true});await r.controller.start();assert.deepEqual(r.sent,['공지 A']);
});
