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

test('응답 유실 후 게시 기록에서 확인되면 재발송 없이 다음 문구로 이어간다',async()=>{
 const r=await configured();let sends=0,checks=0;
 r.io.send=async()=>{sends++;throw new Error('port closed')};
 r.io.reconcile=async(_,delivery)=>{checks++;assert.equal(delivery.text,'공지 A');return {status:'confirmed'}};
 await r.controller.start();
 assert.equal(sends,1);assert.equal(checks,1);assert.equal(r.state.nextIndex,1);
 assert.equal(r.state.enabled,true);assert.equal(r.state.pending,null);assert.equal(r.alarm,1030000);
});
test('게시 재확인 실패·통신 오류는 원래 pending을 유지하고 추가 발송 없이 중지한다',async()=>{
 for(const throws of [false,true]){
 const r=await configured();let sends=0;
 r.io.send=async()=>{sends++;return {status:'uncertain'}};
 r.io.reconcile=async()=>{if(throws)throw new Error('offline');return {status:'uncertain'}};
 await r.controller.start();assert.equal(sends,1);assert.equal(r.state.nextIndex,0);
 assert.equal(r.state.enabled,false);assert.ok(r.state.pending);assert.equal(r.alarm,null);
 }
});
test('worker 중단 뒤 실행 중 pending만 재확인하며 사용자가 중지한 상태는 재개하지 않는다',async()=>{
 const r=await configured();r.io.send=async()=>({status:'uncertain'});await r.controller.start();
 let state=r.state;state.enabled=true;await r.io.save(state);let checks=0;
 r.io.reconcile=async()=>{checks++;return {status:'confirmed'}};
 await r.controller.recover();assert.equal(checks,1);assert.equal(r.state.nextIndex,1);assert.equal(r.state.pending,null);
 state={...state,enabled:false};await r.io.save(state);
 await r.controller.recover();assert.equal(checks,1);assert.equal(r.state.enabled,false);assert.ok(r.state.pending);
});

test('초안 재시도 전 늦게 게시된 현재 공지는 원래 전송과 A/B를 비교해 재발송 없이 복구한다',async()=>{
 const r=await configured();let sends=0;
 r.io.send=async()=>{sends++;return {status:'draft-retained'}};
 await r.controller.start();r.advance(30);
 r.io.inspect=async()=>({ok:false,code:'POSSIBLY_SENT',error:'게시 흔적'});
 r.io.reconcile=async(target,pending)=>{
  assert.deepEqual(target.messages,['공지 A','공지 B']);assert.equal(pending.index,0);
  return {status:'confirmed',draftAction:'replace-next'};
 };
 await r.controller.tick();assert.equal(sends,1);assert.equal(r.state.nextIndex,1);
 assert.equal(r.state.enabled,true);assert.equal(r.state.pending,null);
 assert.equal(r.state.draftRetryPending,null);
});

test('연결한 채널의 최소 주기를 적용하고 최소 미만 저장을 차단한다',async()=>{
 const r=await configured();await r.controller.bind({...target,slowmodeSeconds:600});
 assert.equal(r.state.intervalSeconds,603);assert.equal(r.state.slowmodeSeconds,600);
 await assert.rejects(r.controller.updateSettings({messages:['A','B'],intervalSeconds:602}),/603/);
 await r.controller.updateSettings({messages:['A','B'],intervalSeconds:700});assert.equal(r.state.intervalSeconds,700);
});
test('실행 도중 더 긴 슬로우 모드를 발견하면 마지막 발송 기준으로 다음 예약을 미룬다',async()=>{
 const r=await configured();await r.controller.start();r.advance(30);
 r.io.inspect=async()=>({ok:true,slowmodeSeconds:600,cooldownMs:0});
 await r.controller.tick();assert.equal(r.sent.length,1);assert.equal(r.state.intervalSeconds,603);
 assert.equal(r.alarm,1603000);assert.equal(r.state.nextIndex,1);
 r.advance(573);await r.controller.tick();assert.deepEqual(r.sent,['공지 A','공지 B']);
});

test('두 단계 전송은 3초 전 준비하고 예약 시각 전에는 Enter 단계로 넘기지 않는다',async()=>{
 const r=await configured();let preparations=0;
 r.io.prepare=async()=>{preparations++;return {status:'prepared'}};
 await r.controller.start();assert.equal(preparations,1);assert.equal(r.sent.length,1);
 assert.equal(r.alarm,1027000);
 r.advance(27);await r.controller.tick();
 assert.equal(preparations,2);assert.equal(r.sent.length,1);assert.equal(r.state.prepared.phase,'ready');
 assert.equal(r.state.pending,null);assert.equal(r.alarm,1030000);
 r.advance(3);await r.controller.tick();assert.equal(r.sent.length,2);assert.equal(r.state.prepared,null);
});

test('준비 완료 후 worker를 재생성해도 재입력하지 않고 같은 준비 ID로 전송한다',async()=>{
 const r=await configured();let count=0;
 r.io.prepare=async()=>{count++;return {status:'prepared'}};
 await r.controller.start();r.advance(27);await r.controller.tick();
 const id=r.state.prepared.id;
 const next=createController(r.io);await next.recover({preserveDue:true});
 assert.equal(r.state.prepared.id,id);assert.equal(count,2);
 r.advance(3);await next.tick();assert.equal(count,2);assert.equal(r.sent.length,2);
 await next.tick();assert.equal(r.sent.length,2);
});
test('준비만 한 상태에서 중지하면 초안 재전송 예약을 없애고 차례를 유지한다',async()=>{
 const r=await configured();r.io.prepare=async()=>({status:'prepared'});
 await r.controller.start();r.advance(27);await r.controller.tick();await r.controller.stop();
 assert.equal(r.state.prepared,null);assert.equal(r.state.pending,null);assert.equal(r.state.nextIndex,1);
 r.advance(3);await r.controller.tick();assert.equal(r.sent.length,1);assert.equal(r.alarm,null);
});
test('입력 준비 응답이 유실되면 Enter 단계로 넘어가지 않고 초안 확인을 위해 중지한다',async()=>{
 const r=await configured();r.io.prepare=async()=>{throw new Error('lost')};
 await r.controller.start();assert.equal(r.sent.length,0);assert.equal(r.state.enabled,false);
 assert.equal(r.state.pending,null);assert.equal(r.state.prepared,null);assert.equal(r.state.nextIndex,0);
});
test('입력 준비가 예약보다 늦으면 준비 완료 뒤에만 전송한다',async()=>{
 const r=await configured();r.io.prepare=async()=>{r.advance(5);return {status:'prepared'}};
 let at;
 r.io.send=async(_,delivery)=>{at=delivery.scheduledAt;return {status:'confirmed'}};
 await r.controller.start();assert.equal(at,1005000);assert.equal(r.state.lastSentAt,1005000);
});

test('채널별 확인 생략은 미검증 시도로 다음 차례를 예약하고 재확인을 호출하지 않는다',async()=>{
 const r=await configured();await r.controller.updateSettings({messages:['공지 A','공지 B'],intervalSeconds:30,skipConfirmation:true});
 r.io.send=async target=>{assert.equal(target.skipConfirmation,true);return {status:'unverified'}};
 r.io.reconcile=async()=>{throw new Error('호출하면 안 됨')};
 await r.controller.start();assert.equal(r.state.nextIndex,1);assert.equal(r.state.lastOutcome,'unverified');
 assert.equal(r.state.enabled,true);assert.equal(r.state.pending,null);assert.equal(r.alarm,1030000);
 assert.match(r.state.history[0].text,/결과 확인 생략/);
 await r.controller.stop();await r.controller.updateSettings({messages:['공지 A','공지 B'],intervalSeconds:30,skipConfirmation:false});
 r.io.send=async()=>({status:'uncertain'});await r.controller.start();assert.equal(r.state.enabled,false);assert.ok(r.state.pending);
});
test('확인 생략 시 응답 유실은 누락 가능성을 수용하고 진행하지만 입력 전 차단은 중지한다',async()=>{
 for(const blocked of [false,true]){
 const r=await configured();await r.controller.updateSettings({messages:['A','B'],intervalSeconds:30,skipConfirmation:true});
 r.io.send=async()=>{if(blocked)return {status:'blocked',error:'문구 변경'};throw new Error('lost')};
 await r.controller.start();assert.equal(r.state.nextIndex,blocked?0:1);assert.equal(r.state.enabled,!blocked);assert.equal(r.state.pending,null);
 }
});

test('수동 전송 확인은 입력 시작이 아니라 확인 시각을 다음 게시 검사 기준으로 저장한다',async()=>{
 const r=await configured();r.io.send=async()=>({status:'uncertain'});await r.controller.start();
 const started=r.state.pending.startedAt;r.advance(480);await r.controller.resolvePending('sent');
 assert.equal(r.state.lastSentAt,started+480000);assert.equal(r.state.nextIndex,1);
});
test('이전 버전의 수동 확인 기록으로 잘못된 시작 시각을 복구하고 B부터 재개한다',async()=>{
 const r=rig({messages:['공지 A','공지 B'],intervalSeconds:63,target,enabled:false,nextIndex:1,lastOutcome:'confirmed',lastSentAt:500000,history:[{at:900000,kind:'info',text:'사용자가 발송 완료를 확인했습니다. 다음 문구로 이어집니다.'}]});
 assert.equal((await r.controller.getState()).lastSentAt,900000);
 let checkedAt;r.io.send=async(t)=>{checkedAt=t.lastSentAt;return {status:'confirmed'};};
 await r.controller.start();assert.equal(checkedAt,900000);assert.deepEqual(r.sent,[]);assert.equal(r.state.nextIndex,0);
});
test('미확인 결과·다른 기록·미래 기록은 확인 시각 복구에 사용하지 않는다',async()=>{
 const entry={at:900000,kind:'info',text:'사용자가 발송 완료를 확인했습니다. 다음 문구로 이어집니다.'};
 for(const [lastOutcome,history] of [['unverified',[entry]],['confirmed',[{...entry,text:'다른 기록'}]],['confirmed',[{...entry,at:2000000}]]]){
  const r=rig({lastOutcome,lastSentAt:500000,history});assert.equal((await r.controller.getState()).lastSentAt,500000);
 }
});

test('확인된 게시 ID는 저장·재시작 후 다음 채널 검사에도 전달된다',async()=>{
 const r=await configured(),messageId='1548966122731216936';
 r.io.send=async()=>({status:'confirmed',messageId});
 await r.controller.start();
 assert.equal(r.state.lastConfirmedMessageId,messageId);
 const restarted=createController(r.io);
 r.io.send=async destination=>{
  assert.equal(destination.lastConfirmedMessageId,messageId);
  return {status:'confirmed',messageId:'1548966122731216937'};
 };
 r.advance(30);await restarted.tick();
 assert.equal(r.state.lastConfirmedMessageId,'1548966122731216937');
});
