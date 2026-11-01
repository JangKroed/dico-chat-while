import test from 'node:test';
import assert from 'node:assert/strict';
import {canRetryNotSent,retryNotSentMessage,retryNotSentStatus} from '../central/ui/src/retry-attempt.ts';

const snapshot=()=>({groups:[{id:'group',activeAttemptId:'latest',version:1,runId:'run',members:['binding'],cursor:0}],attempts:[{id:'older',groupId:'group',status:'unknown',executionBlocked:true},{id:'latest',groupId:'group',status:'unknown',executionBlocked:true,groupVersion:1,runId:'run',bindingId:'binding'}]});
test('retry control is limited to latest blocked unknown or not_sent attempt of a group',()=>{
  const s=snapshot();
  assert.equal(canRetryNotSent(s.attempts[0],s),false);
  assert.equal(canRetryNotSent(s.attempts[1],s),true);
  s.attempts[1].status='not_sent';s.groups[0].activeAttemptId=undefined;
  assert.equal(canRetryNotSent(s.attempts[1],s),true);
  s.attempts[1].retryRunId='run';assert.equal(canRetryNotSent(s.attempts[1],s),false);
  delete s.attempts[1].retryRunId;s.attempts[1].status='confirmed';assert.equal(canRetryNotSent(s.attempts[1],s),false);
  s.attempts[1].status='not_sent';s.groups[0].activeAttemptId='different';assert.equal(canRetryNotSent(s.attempts[1],s),false);
  s.groups[0].activeAttemptId=undefined;s.attempts[1].executionBlocked=false;assert.equal(canRetryNotSent(s.attempts[1],s),false);
  s.attempts[1].executionBlocked=true;s.groups[0].version=2;assert.equal(canRetryNotSent(s.attempts[1],s),false);
  s.groups[0].version=1;s.groups[0].runId='next-run';assert.equal(canRetryNotSent(s.attempts[1],s),false);
  s.groups[0].runId='run';s.groups[0].members=['different'];assert.equal(canRetryNotSent(s.attempts[1],s),false);
});
test('retry response labels waiting as no execution and requires a second user click',()=>{
  assert.equal(retryNotSentStatus({result:{status:'waiting',reasonCode:'CONTROL_PENDING'}}),'waiting');
  assert.match(retryNotSentMessage('waiting'),/아직 다시 실행하지 않았습니다/);
  assert.match(retryNotSentMessage('waiting'),/다시 눌러/);
  assert.equal(retryNotSentStatus({result:{status:'started'}}),'started');
  assert.equal(retryNotSentStatus({result:{status:'already_started'}}),'already_started');
  assert.equal(retryNotSentStatus({result:{status:'unrecognized'}}),null);
});
