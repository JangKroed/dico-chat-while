import test from 'node:test';
import assert from 'node:assert/strict';
import {groupControls} from '../central/ui/src/group-controls.ts';

function fixture(){
  const now=1_800_000_000_000;
  const channel={id:'binding',instanceId:'browser',accountId:'111',guildId:'222',channelId:'333',verified:true,playlist:[{messageId:'message',revisionId:'revision'}],configVersion:1,appliedVersion:1};
  const group={id:'group',name:'첫 그룹',guildId:'222',channelId:'333',members:['binding'],status:'stopped',cursor:0,version:1};
  return{s:{serverNow:now,service:{status:'ready'},instances:[{id:'browser',connected:true,lastSeenAt:now,legacyFrozen:true,legacyPending:false}],channels:[channel],messages:[{id:'message',revisions:[{id:'revision'}]}],groups:[group],attempts:[],commands:[]},group};
}

test('one ready group can start without a separate service resume or unrelated group recovery',()=>{
  for(const status of ['ready','resume_required','stopped']){const {s,group}=fixture();s.service.status=status;s.groups.push({...group,id:'other',guildId:'other-guild',channelId:'other-channel',members:[],status:'needs_review',activeAttemptId:'unknown'});s.attempts=[{id:'unknown',groupId:'other',status:'unknown'}];
    const controls=groupControls(s,group);assert.equal(controls.start.action,'group.start');assert.equal(controls.start.disabled,false);assert.deepEqual(controls.start.reasons,[]);assert.equal(controls.stop.disabled,true);assert.equal(controls.needsReview,false);
  }
});

test('unknown delivery stays blocked after stop completion while history remains reachable',()=>{
  const {s,group}=fixture();group.activeAttemptId='unknown';s.attempts=[{id:'unknown',groupId:group.id,status:'unknown',executionBlocked:true}];
  const controls=groupControls(s,group);assert.equal(controls.start.disabled,true);assert.equal(controls.needsReview,true);assert.equal(controls.stop.disabled,true);assert.ok(controls.start.reasons.some(reason=>/미확인/.test(reason)));
});

test('running group can stop despite stale state and cannot start a duplicate run',()=>{
  const {s,group}=fixture();group.status='running';group.activeAttemptId='active';s.attempts=[{id:'active',status:'permitted'}];
  const controls=groupControls(s,group,{stale:true});assert.equal(controls.start.disabled,true);assert.equal(controls.stop.action,'group.stop');assert.equal(controls.stop.disabled,false);assert.equal(controls.needsReview,false);
  assert.equal(groupControls(s,group,{busy:true}).stop.disabled,false,'다른 작업 진행 중에도 중지할 수 있어야 합니다.');
});

test('pause and pending controls map to correct commands and never offer immediate restart',()=>{
  const {s,group}=fixture();group.status='paused';let controls=groupControls(s,group);assert.equal(controls.start.action,'group.resume');assert.equal(controls.start.disabled,false);assert.equal(controls.stop.disabled,false);
  for(const status of ['stop_pending','pause_pending']){group.status=status;controls=groupControls(s,group);assert.equal(controls.start.disabled,true);assert.ok(controls.start.reasons.some(reason=>/확인 대기/.test(reason)));}
  group.status='stop_pending';assert.equal(groupControls(s,group).stop.disabled,true);
});

test('service failure, stale state and an incomplete own binding explain disabled start',()=>{
  const {s,group}=fixture();s.service.status='storage_failure';assert.equal(groupControls(s,group).start.disabled,true);
  s.service.status='ready';assert.equal(groupControls(s,group,{stale:true}).start.disabled,true);
  s.channels[0].verified=false;const controls=groupControls(s,group);assert.equal(controls.start.disabled,true);assert.ok(controls.start.reasons.some(reason=>/검증/.test(reason)));
});

test('another reserved group on the same target blocks only the conflicting start',()=>{
  const {s,group}=fixture();s.groups.push({...group,id:'other',status:'running'});const controls=groupControls(s,group);assert.equal(controls.start.disabled,true);assert.ok(controls.start.reasons.some(reason=>/다른 그룹|같은 채널/.test(reason)));
  s.groups[1].status='stopped';assert.equal(groupControls(s,group).start.disabled,false);
});

test('pending window moves prevent starting their browser group without blocking unrelated browsers',()=>{
  const {s,group}=fixture();s.commands=[{type:'MANAGE_WINDOW',instanceId:'browser',status:'queued',payload:{action:'separate'}}];assert.equal(groupControls(s,group).start.disabled,true);
  s.commands[0].instanceId='other-browser';assert.equal(groupControls(s,group).start.disabled,false);
});

test('stale stopped or pending snapshots still allow an explicit stop against current service state',()=>{
  const {s,group}=fixture();
  for(const status of ['stopped','stop_pending']){group.status=status;assert.equal(groupControls(s,group,{stale:true}).stop.disabled,false);assert.equal(groupControls(s,group,{stale:true,busy:true}).stop.disabled,false);}
});
test('자동 프로필이 지정되면 오프라인 시작을 예약하고 준비 중 중지할 수 있다',()=>{
 const {s,group}=fixture();s.instances[0].launchProfileId='Chrome:Default';s.instances[0].connected=false;s.channels[0].verified=false;
 assert.equal(groupControls(s,group).start.disabled,false);
 group.pendingStart={requestedAt:s.serverNow};const controls=groupControls(s,group);assert.equal(controls.start.disabled,true);assert.equal(controls.stop.disabled,false);assert.equal(controls.start.label,'연결 준비 중');
});
