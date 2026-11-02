import test from 'node:test';
import assert from 'node:assert/strict';
import {incidentAdvice,isIncidentOpen,incidentState,visibleIncidents} from '../central/ui/src/incident-advice.ts';

const snapshot=()=>({instances:[{id:'browser',name:'업무 Brave'}],groups:[{id:'group',name:'주말 공지',guildId:'guild',channelId:'channel'}],targets:[{id:'target',name:'모집방',guildId:'guild',channelId:'channel'}],channels:[],attempts:[],incidents:[],commands:[]});
test('known draft rejection has a specific Korean cause and preserves the user draft',()=>{
  const advice=incidentAdvice({id:'incident',code:'command_rejected',rejectionCode:'DRAFT_MISMATCH'},snapshot());
  assert.equal(advice.knownReason,true);assert.equal(advice.page,'channels');
  assert.match(advice.title,/초안/);assert.match(advice.cause,/다른 초안/);
  assert.ok(advice.steps.some(step=>step.includes('보관')));
  assert.ok(advice.steps.every(step=>!step.includes('자동으로 지')));
});
test('old command rejection infers affected browser, group and target from retained command',()=>{
  const s=snapshot();s.commands=[{id:'command',instanceId:'browser',type:'CONFIG_SYNC',rejectionCode:'CONFIG_MISMATCH',payload:{groupId:'group',targetId:'target'}}];
  const advice=incidentAdvice({id:'incident',code:'command_rejected',commandId:'command'},s);
  assert.equal(advice.knownReason,true);assert.equal(advice.page,'channels');
  assert.deepEqual(advice.affected,['브라우저: 업무 Brave','그룹: 주말 공지','채널: #모집방']);
});
test('unknown legacy rejection explicitly says reason was not recorded without inventing a cause',()=>{
  const advice=incidentAdvice({id:'incident',code:'command_rejected',commandId:'missing'},snapshot());
  assert.equal(advice.knownReason,false);assert.match(advice.cause,/상세 거절 사유가 기록되지 않았습니다/);
  assert.doesNotMatch(advice.cause,/초안이|버전이|계정이 변경/);
});
test('CONTROL rejection provides stop and acknowledgment recovery without recommending resume',()=>{
  const advice=incidentAdvice({id:'incident',code:'command_rejected',commandType:'CONTROL'},snapshot());
  assert.equal(advice.page,'groups');assert.equal(advice.knownReason,false);
  assert.match(advice.cause,/상세 거절 사유가 기록되지 않았습니다/);
  assert.ok(advice.steps.some(step=>step.includes('전체 중지')));
  assert.ok(advice.steps.some(step=>step.includes('확인 응답')));
  assert.ok(advice.steps.some(step=>step.includes('업데이트')));
  assert.ok(advice.steps.every(step=>!step.includes('재개')));
  assert.ok(advice.steps.some(step=>step.includes('실제 Discord 게시 내역')));
});
test('known CONTROL_FAILED still does not infer an unsupported internal root cause',()=>{
  const advice=incidentAdvice({id:'incident',code:'command_rejected',rejectionCode:'CONTROL_FAILED'},snapshot());
  assert.equal(advice.page,'groups');assert.equal(advice.knownReason,true);
  assert.match(advice.cause,/내부 원인은 확인되지/);
});
test('unknown delivery routes to history and never treats stop as evidence of non-delivery',()=>{
  const s=snapshot();s.attempts=[{id:'attempt',status:'unknown',groupId:'group',instanceId:'browser'}];
  const advice=incidentAdvice({id:'incident',code:'delivery_unknown',attemptId:'attempt'},s);
  assert.equal(advice.page,'history');assert.ok(advice.steps.some(step=>step.includes('미발송의 증거')));
  assert.ok(advice.steps.some(step=>step.includes('해당 그룹의 중지')));
  s.attempts[0].executionBlocked=true;
  const blocked=incidentAdvice({id:'incident',code:'delivery_unknown',attemptId:'attempt'},s);
  assert.ok(blocked.steps.some(step=>step.includes('같은 계정에서 계속')));
  assert.ok(blocked.steps.every(step=>!step.includes('전체 중지')));
});
test('read state never resolves a current issue and default list excludes resolved issues',()=>{
  const s=snapshot();const read={id:'read',code:'command_rejected',readAt:1};const resolved={id:'resolved',code:'command_rejected',resolvedAt:2};
  s.incidents=[read,resolved];
  assert.equal(isIncidentOpen(read),true);assert.equal(incidentState(read),'미해결 · 읽음');
  assert.equal(isIncidentOpen(resolved),false);assert.equal(incidentState(resolved),'해결됨 · 읽지 않음');
  assert.deepEqual(visibleIncidents(s,false).map(i=>i.id),['read']);
  assert.deepEqual(visibleIncidents(s,true).map(i=>i.id),['resolved','read']);
});
test('friendly titles and affected browser names are searchable',()=>{
  const s=snapshot();s.incidents=[{id:'incident',code:'command_rejected',instanceId:'browser',rejectionCode:'CONTENT_UNAVAILABLE'}];
  assert.equal(visibleIncidents(s,false,'업무 Brave').length,1);
  assert.equal(visibleIncidents(s,false,'응답').length,1);
});
test('direct incident metadata still resolves target and browser after old commands are pruned',()=>{
  const advice=incidentAdvice({id:'incident',code:'command_rejected',instanceId:'browser',targetId:'target',commandType:'OPEN_CHANNEL',rejectionCode:'OPEN_CHANNEL_FAILED'},snapshot());
  assert.equal(advice.page,'channels');assert.deepEqual(advice.affected,['브라우저: 업무 Brave','채널: #모집방']);
});
test('unknown-delivery advice uses retained-draft cause and the configured account alias',()=>{
  const s=snapshot();s.accounts=[{id:'account',instanceId:'browser',accountId:'123',name:'내 모집 계정'}];s.attempts=[{id:'attempt',status:'unknown',reasonCode:'draft-retained',accountId:'123',instanceId:'browser'}];
  const advice=incidentAdvice({id:'incident',code:'delivery_unknown',attemptId:'attempt'},s);
  assert.match(advice.cause,/초안이 남았다는 사실만으로 미발송으로 판단할 수 없습니다/);
  assert.ok(advice.affected.includes('계정: 내 모집 계정'));
});
test('cooldown and prepare timeout rejections explain recovery without declaring safe resend',()=>{
  const cooldown=incidentAdvice({id:'cooldown',code:'command_rejected',rejectionCode:'COOLDOWN_UNVERIFIED'},snapshot());
  assert.equal(cooldown.knownReason,true);assert.equal(cooldown.page,'channels');assert.match(cooldown.cause,/실제 제한 해제를 판단하지 않습니다/);
  const timeout=incidentAdvice({id:'timeout',code:'command_rejected',rejectionCode:'PREPARE_WAIT_TIMEOUT'},snapshot());
  assert.equal(timeout.knownReason,true);assert.equal(timeout.page,'groups');assert.match(timeout.cause,/대기.*시간 변화/);
  for(const advice of [cooldown,timeout])assert.ok(advice.steps.some(step=>step.includes('다시 보내지 마세요')));
});

test('failed window reveal uses the recorded operation and routes to the exact channel recovery',()=>{
  const s=snapshot();s.channels=[{id:'binding',name:'모집방',instanceId:'browser',accountId:'123',guildId:'guild',channelId:'channel'}];
  s.commands=[{id:'command',instanceId:'browser',type:'MANAGE_WINDOW',rejectionCode:'MANAGE_WINDOW_FAILED',payload:{action:'reveal',bindingId:'binding'}}];
  const advice=incidentAdvice({id:'incident',code:'command_rejected',commandId:'command'},s);
  assert.equal(advice.page,'channels');assert.equal(advice.knownReason,true);assert.match(advice.title,/전송 창.*보기/);
  assert.ok(advice.steps.some(step=>step.includes('전송 창 보기')));
  assert.ok(advice.steps.some(step=>step.includes('해결 상태 재검사')));
  assert.ok(advice.steps.every(step=>!step.includes('전체 중지')));
  assert.ok(advice.affected.includes('채널: #모집방'));
});

test('window reorganization guidance requires stop while unknown reveal errors remain honest',()=>{
  const s=snapshot();s.commands=[{id:'command',type:'MANAGE_WINDOW',payload:{action:'separate'}}];
  const split=incidentAdvice({id:'incident',code:'command_rejected',commandId:'command'},s);
  assert.equal(split.page,'channels');assert.match(split.title,/분리/);assert.equal(split.knownReason,false);
  assert.ok(split.steps.some(step=>step.includes('중지')));
  assert.match(split.cause,/상세.*기록되지/);
});

test('prepare failures retain phase-specific recovery and a recorded not-sent outcome',()=>{
  const s=snapshot();s.commands=[{id:'command',type:'PREPARE',payload:{attemptId:'attempt'}}];s.attempts=[{id:'attempt',status:'not_sent',reasonCode:'PREPARE_FAILED'}];
  const advice=incidentAdvice({id:'incident',code:'command_rejected',commandId:'command'},s);
  assert.equal(advice.page,'channels');assert.equal(advice.rejectionCode,'PREPARE_FAILED');assert.match(advice.title,/입력 준비/);
  assert.match(advice.cause,/미발송으로 확정/);assert.ok(advice.steps.some(step=>step.includes('해결 상태 재검사')));
  s.attempts[0].status='unknown';const unknown=incidentAdvice({id:'incident',code:'command_rejected',commandId:'command'},s);
  assert.doesNotMatch(unknown.cause,/미발송으로 확정/);
});
