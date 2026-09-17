import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../controller.js';
import { createChannelManager } from '../channel-manager.js';

const target = (tabId, channelId = String(tabId)) => ({ tabId, url: `https://discord.com/channels/123/${channelId}`, title: `채널 ${tabId}` });
const settings = (prefix = 'A', intervalSeconds = 30) => ({ messages: [`${prefix} 첫 문구`, `${prefix} 다음 문구`], intervalSeconds });
function rig(initial) {
  let stored = structuredClone(initial);
  let time = 1000000;
  let sequence = 0;
  let writes = 0;
  const alarms = new Map();
  const sent = [];
  const io = {
    load: async () => structuredClone(stored),
    save: async state => { stored = structuredClone(state); writes++; },
    schedule: async (id, at) => { alarms.set(id, at); },
    cancel: async id => { alarms.delete(id); },
    inspect: async () => ({ ok: true }),
    send: async (destination, delivery) => { sent.push({ destination, ...delivery }); return { status: 'confirmed' }; },
    now: () => time,
    id: () => `generated-${++sequence}`,
  };
  return { io, alarms, sent, manager: createChannelManager(io), advance: seconds => { time += seconds * 1000; }, get state() { return structuredClone(stored); }, get writes() { return writes; } };
}
async function configure(r, id, tabId, prefix = id, intervalSeconds = 30) {
  const current = (await r.manager.getState()).channels.find(channel => channel.id === id);
  await r.manager.updateSettings(id, settings(prefix, intervalSeconds), current.settingsRevision);
  await r.manager.bind(id, target(tabId));
}
async function pair() {
  const r = rig();
  const first = (await r.manager.getState()).channels[0].id;
  const second = (await r.manager.add()).channels[1].id;
  await configure(r, first, 7, '첫 채널');
  await configure(r, second, 8, '둘째 채널', 60);
  return { r, first, second };
}

test('초기 채널을 한 번 저장하고 동시 조회에도 같은 ID를 유지한다', async () => {
  const r = rig();
  const roots = await Promise.all(Array.from({ length: 8 }, () => r.manager.getState()));
  assert.equal(r.writes, 1);
  assert.ok(roots.every(root => root.version === 2 && root.channels.length === 1 && root.channels[0].id === 'channel-1'));
  await r.manager.getState();
  assert.equal(r.writes, 1);
  await assert.rejects(r.manager.remove('channel-1'), /최소|마지막/);
});

test('기존 단일 채널의 설정·순서·예약·미확인 전송을 그대로 이전한다', async () => {
  const legacy = { ...initialState(), ...settings(), target: target(7), enabled: true, nextIndex: 1, nextRunAt: 99, pending: { id: 'lost', index: 1, text: 'B', startedAt: 1 }, history: [{ at: 1, text: '기록' }] };
  const r = rig(legacy);
  const root = await r.manager.getState();
  assert.deepEqual(Object.keys(root).sort(), ['channels', 'revision', 'version']);
  for (const [key, value] of Object.entries(legacy)) if (key !== 'version') assert.deepEqual(root.channels[0][key], value);
  assert.equal(root.channels[0].settingsRevision, 0);
  const restarted = createChannelManager(r.io);
  assert.deepEqual(await restarted.getState(), root);
  assert.equal(r.writes, 1);
});

test('빈 v2 저장값도 최소 한 채널을 복원한다', async () => {
  const r = rig({ version: 2, channels: [] });
  assert.equal((await r.manager.getState()).channels[0].id, 'channel-1');
});

test('채널별 문구·주기·A/B 순서·예약과 중지가 독립적이다', async () => {
  const { r, first, second } = await pair();
  await r.manager.startAll();
  assert.equal(r.alarms.get(first), 1030000);
  assert.equal(r.alarms.get(second), 1060000);
  assert.deepEqual(r.sent.map(delivery => delivery.text), ['첫 채널 첫 문구', '둘째 채널 첫 문구']);
  assert.equal(r.sent[0].channelId, first);
  assert.equal(r.sent[0].text, '첫 채널 첫 문구');
  await r.manager.stop(first);
  assert.equal(r.alarms.has(first), false);
  assert.equal(r.alarms.has(second), true);
  r.advance(60);
  await r.manager.tick(second);
  await r.manager.start(first);
  assert.deepEqual(r.sent.map(delivery => delivery.text), ['첫 채널 첫 문구', '둘째 채널 첫 문구', '둘째 채널 다음 문구', '첫 채널 다음 문구']);
  assert.deepEqual(r.state.channels.map(channel => channel.nextIndex), [0, 0]);
});

test('한 채널의 미확인 전송과 복구 오류가 다른 채널에 영향을 주지 않는다', async () => {
  const { r, first, second } = await pair();
  await r.manager.startAll();
  r.io.send = async () => ({ status: 'uncertain', error: '발송 확인 필요' });
  r.advance(30);
  await r.manager.tick(first);
  assert.ok(r.state.channels[0].pending);
  assert.equal(r.state.channels[1].enabled, true);
  r.io.cancel = async id => { if (id === first) throw new Error('cancel failed'); r.alarms.delete(id); };
  r.alarms.clear();
  await r.manager.recover();
  assert.ok(r.alarms.has(second));
  assert.ok(r.state.channels[0].pending);
  r.io.cancel = async id => r.alarms.delete(id);
  await r.manager.resolvePending(first, 'sent');
  assert.equal(r.state.channels[0].nextIndex, 0);
  assert.equal(r.state.channels[1].nextIndex, 1);
});

test('오래된 설정 저장을 거부하고 실행 상태 변화는 설정 revision을 바꾸지 않는다', async () => {
  const { r, first } = await pair();
  const revision = r.state.channels[0].settingsRevision;
  await r.manager.updateSettings(first, { ...settings('수정'), name: '새 이름' }, revision);
  await assert.rejects(r.manager.updateSettings(first, settings('오래됨'), revision), /변경|최신/);
  await assert.rejects(r.manager.updateSettings(first, settings()), /변경|최신/);
  await r.manager.start(first);
  await r.manager.stop(first);
  assert.equal(r.state.channels[0].settingsRevision, revision + 1);
  assert.equal(r.state.channels[0].name, '새 이름');
  assert.equal(r.state.channels[0].messages[0], '수정 첫 문구');
});

test('같은 브라우저 탭에서 이동한 다른 채널은 연결하고 같은 Discord 채널의 중복은 거부한다', async () => {
  const r = rig();
  const first = (await r.manager.getState()).channels[0].id;
  const second = (await r.manager.add()).channels[1].id;
  await r.manager.bind(first, target(7, '10'));
  await r.manager.bind(second, target(7, '20'));
  assert.equal(r.state.channels.find(channel => channel.id === second).target.channelId, '20');
  await assert.rejects(r.manager.bind(second, target(8, '10')), /다른|이미/);
});

test('같은 Discord 채널의 중복 연결과 실행·미확인 상태의 변경을 거부한다', async () => {
  const { r, first, second } = await pair();
  await assert.rejects(r.manager.bind(second, target(9, '7')), /다른|이미/);
  await r.manager.start(first);
  await assert.rejects(r.manager.bind(first, target(9)), /중지/);
  await assert.rejects(r.manager.remove(first), /중지/);
  r.io.send = async () => ({ status: 'uncertain' });
  r.advance(30);
  await r.manager.tick(first);
  await assert.rejects(r.manager.remove(first), /확인/);
  await assert.rejects(r.manager.updateSettings(first, settings(), r.state.channels[0].settingsRevision), /확인/);
});

test('전체 시작은 오류를 개별 기록하고 정상 채널을 시작하며 순서를 유지한다', async () => {
  const { r, first, second } = await pair();
  await r.manager.start(first);
  const due = r.alarms.get(first);
  const third = (await r.manager.add()).channels[2].id;
  await r.manager.updateSettings(third, settings('연결 없음'), 0);
  const fourth = (await r.manager.add()).channels[3].id;
  const root = await r.manager.startAll();
  assert.equal(root.channels.find(channel => channel.id === first).nextIndex, 1);
  assert.equal(r.alarms.get(first), due);
  assert.deepEqual(r.sent.map(delivery => delivery.text), ['첫 채널 첫 문구', '둘째 채널 첫 문구']);
  assert.equal(root.channels.find(channel => channel.id === second).enabled, true);
  assert.match(root.channels.find(channel => channel.id === third).error, /선택/);
  assert.match(root.channels.find(channel => channel.id === fourth).error, /문구/);
  await r.manager.stopAll();
  assert.ok(r.state.channels.every(channel => !channel.enabled));
  assert.equal(r.alarms.size, 0);
  await r.manager.remove(third);
  assert.equal(r.state.channels.length, 3);
});

test('설정 validation과 이름 제한을 적용하며 채널별 저장은 다른 채널을 덮어쓰지 않는다', async () => {
  const { r, first, second } = await pair();
  const before = r.state.channels[1];
  await assert.rejects(r.manager.updateSettings(first, { ...settings(), name: 'x'.repeat(81) }, 2));
  await assert.rejects(r.manager.updateSettings(first, { ...settings(), intervalSeconds: 29 }, 2));
  await r.manager.updateSettings(first, settings('갱신'), 2);
  assert.deepEqual(r.state.channels[1], before);
  await Promise.all([r.manager.stop(first), r.manager.stop(second)]);
  assert.ok(r.state.channels.every(channel => channel.history[0].text.includes('중지')));
});

test('탭 소실은 연결된 실행 채널만 중지한다', async () => {
  const { r, first, second } = await pair();
  await r.manager.startAll();
  await r.manager.targetLost(7, '탭이 닫혔습니다.');
  assert.equal(r.state.channels[0].enabled, false);
  assert.equal(r.state.channels[1].enabled, true);
  assert.equal(r.alarms.has(first), false);
  assert.equal(r.alarms.has(second), true);
});

test('전송 확인 중 최신 상태 조회가 막히지 않으며 pending을 관찰한다', async () => {
  const { r, first } = await pair();
  r.io.send = async (_target, delivery) => {
    const root = await r.manager.getState();
    assert.equal(root.channels.find(channel => channel.id === first).pending.id, delivery.id);
    return { status: 'confirmed' };
  };
  await r.manager.start(first);
  assert.equal(r.state.channels[0].nextIndex, 1);
});

test('동시에 도착한 같은 revision 저장 중 첫 저장만 반영한다', async () => {
  const { r, first } = await pair();
  const revision = r.state.channels[0].settingsRevision;
  const results = await Promise.allSettled([
    r.manager.updateSettings(first, settings('첫 저장'), revision),
    r.manager.updateSettings(first, settings('늦은 저장'), revision),
  ]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  assert.equal(r.state.channels[0].messages[0], '첫 저장 첫 문구');
  assert.equal(r.state.channels[0].settingsRevision, revision + 1);
});


test('탭 준비 실패는 해당 채널에만 기록하고 미확인 전송을 유지한다', async () => {
  const { r, first, second } = await pair();
  await r.manager.start(second);
  r.io.send = async () => ({ status: 'uncertain', error: '발송 확인 필요' });
  await r.manager.start(first);
  const pending = r.state.channels[0].pending;
  const unaffected = r.state.channels[1];
  const root = await r.manager.fail(first, new Error('전용 탭을 준비하지 못했습니다.'));
  assert.equal(root.channels[0].enabled, false);
  assert.equal(root.channels[0].nextRunAt, null);
  assert.equal(root.channels[0].error, '전용 탭을 준비하지 못했습니다.');
  assert.deepEqual(root.channels[0].pending, pending);
  assert.deepEqual(root.channels[1], unaffected);
  assert.equal(r.alarms.has(first), false);
  assert.equal(r.alarms.has(second), true);
});

test('설정 복원은 전체 검증 후 교체하고 실행 중에는 거부한다',async()=>{
 const {r,first}=await pair();
 const backup={format:'dico-settings',version:1,channels:[{name:'복원',messages:['A','B'],intervalSeconds:60,ownUserId:'',nextIndex:1,url:'https://discord.com/channels/123/999'}]};
 const original=r.state;
 await assert.rejects(r.manager.restoreSettings({...backup,channels:[{...backup.channels[0],intervalSeconds:0}]}));
 assert.deepEqual(r.state,original);
 await r.manager.start(first);
 await assert.rejects(r.manager.restoreSettings(backup));
 await r.manager.stopAll();
 const restored=await r.manager.restoreSettings(backup);
 assert.equal(restored.channels.length,1);assert.equal(restored.channels[0].nextIndex,1);
 assert.equal(restored.channels[0].enabled,false);assert.equal(restored.channels[0].target.managed,undefined);
});

test('채널 1 전송이 멈춰도 채널 2는 시작하고 저장 결과가 유실되지 않는다',async()=>{
 const {r,first,second}=await pair();let release,entered;
 const gate=new Promise(resolve=>release=resolve), ready=new Promise(resolve=>entered=resolve);
 r.io.send=async(_,delivery)=>{if(delivery.channelId===first){entered();await gate;}return {status:'confirmed'};};
 const a=r.manager.start(first);await ready;
 try {
  const result=await Promise.race([r.manager.start(second).then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),100))]);
  assert.equal(result,true,'둘째 채널은 첫 채널의 전송 확인을 기다리면 안 된다');
  assert.equal(r.state.channels.find(c=>c.id===first).pending.index,0);
  assert.equal(r.state.channels.find(c=>c.id===second).nextIndex,1);
 } finally {release();await a;}
 assert.ok(r.state.channels.every(c=>c.nextIndex===1&&c.pending===null));
});

test('서로 다른 설정에서 동시에 같은 채팅방을 연결해도 하나만 저장한다', async () => {
  const {r, first, second} = await pair();
  const results = await Promise.allSettled([
    r.manager.bind(first, target(10, '999')),
    r.manager.bind(second, target(11, '999')),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(r.state.channels.filter(channel => channel.target.channelId === '999').length, 1);
});

test('채널별로 10분과 2분 슬로우 모드 최소값을 독립 저장한다',async()=>{
 const {r,first,second}=await pair();
 await Promise.all([r.manager.bind(first,{...target(7),slowmodeSeconds:600}),r.manager.bind(second,{...target(8),slowmodeSeconds:120})]);
 const a=r.state.channels.find(c=>c.id===first),b=r.state.channels.find(c=>c.id===second);
 assert.equal(a.intervalSeconds,603);assert.equal(b.intervalSeconds,123);
 assert.equal(a.slowmodeSeconds,600);assert.equal(b.slowmodeSeconds,120);
 await assert.rejects(r.manager.updateSettings(first,settings('수정',602),a.settingsRevision),/603/);
});

test('첫 채널의 입력 준비가 지연돼도 둘째 채널은 독립적으로 준비·전송한다',async()=>{
 const {r,first,second}=await pair();let release,entered;
 const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);
 r.io.prepare=async(_,delivery)=>{if(delivery.channelId===first){entered();await gate;}return {status:'prepared'}};
 const a=r.manager.start(first);await ready;
 try {
  const done=await Promise.race([r.manager.start(second).then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),100))]);
  assert.equal(done,true);assert.equal(r.state.channels.find(c=>c.id===first).prepared.phase,'preparing');
  assert.equal(r.state.channels.find(c=>c.id===second).nextIndex,1);
 } finally {release();await a;}
});

test('63초와 123초 확인 생략 채널을 동시에 실행해도 예약과 실제 대상이 뒤바뀌지 않는다',async()=>{
 const {r,first,second}=await pair();
 for(const [id,intervalSeconds] of [[first,63],[second,123]]) {
  const c=(await r.manager.getState()).channels.find(c=>c.id===id);
  await r.manager.updateSettings(id,{...settings(id,intervalSeconds),skipConfirmation:true},c.settingsRevision);
 }
 r.io.send=async(destination,delivery)=>{r.sent.push({destination,...delivery});return {status:'unverified'};};
 await r.manager.startAll();
 assert.equal(r.alarms.get(first),1063000);assert.equal(r.alarms.get(second),1123000);
 r.advance(63);await Promise.all([r.manager.tick(first),r.manager.tick(second)]);
 assert.equal(r.alarms.get(first),1126000);assert.equal(r.alarms.get(second),1123000);
 r.advance(60);await Promise.all([r.manager.tick(second),r.manager.tick(first)]);
 assert.equal(r.alarms.get(first),1126000);assert.equal(r.alarms.get(second),1246000);
 assert.deepEqual(r.sent.map(s=>s.destination.tabId),[7,8,7,8]);
 assert.deepEqual(r.state.channels.map(c=>c.intervalSeconds),[63,123]);
});

for (const intervals of [[120,60,60],[60,120,60]]) {
 test(`3채널 ${intervals.join('/')}초는 저장 순서를 뒤집어도 각 ID의 주기로 6분간 실행된다`,async()=>{
  const r=rig();await r.manager.getState();await r.manager.add();await r.manager.add();
  const ids=r.state.channels.map(c=>c.id),started=r.io.now(),actual=new Map(ids.map(id=>[id,[]]));
  for(let i=0;i<ids.length;i++)await configure(r,ids[i],20+i,ids[i],intervals[i]);
  r.io.prepare=async()=>({status:'prepared'});
  r.io.send=async(destination,delivery)=>{
   const i=ids.indexOf(delivery.channelId);
   assert.equal(destination.channelId,String(20+i));
   actual.get(delivery.channelId).push({at:r.io.now()-started,index:delivery.index});
   return {status:'confirmed'};
  };
  await r.manager.startAll();
  const root=r.state;root.channels.reverse();await r.io.save(root);
  while(true){
   const at=Math.min(...r.alarms.values());if(at>started+360000)break;
   r.advance((at-r.io.now())/1000);
   const due=[...r.alarms].filter(([,when])=>when<=at).map(([id])=>id);
   await Promise.all(due.map(id=>r.manager.tick(id)));
  }
  for(let i=0;i<ids.length;i++){
   const expected=Array.from({length:360/intervals[i]+1},(_,n)=>({at:n*intervals[i]*1000,index:n%2}));
   assert.deepEqual(actual.get(ids[i]),expected);
   assert.equal(r.state.channels.find(c=>c.id===ids[i]).intervalSeconds,intervals[i]);
  }
 });
}
