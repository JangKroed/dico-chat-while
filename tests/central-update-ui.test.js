import test from 'node:test';
import assert from 'node:assert/strict';
import {extensionVersionState,updateBlockers,updateInProgress,updatePollingDecision} from '../central/ui/src/update.ts';

const snapshot=()=>({groups:[],attempts:[],commands:[]});
test('update is available only after running groups, unresolved attempts and control requests are settled',()=>{
  const s=snapshot();assert.deepEqual(updateBlockers(s),[]);
  s.groups=[{status:'running'}];assert.ok(updateBlockers(s).some(reason=>reason.includes('실행 중')));
  s.groups=[{status:'paused',activeAttemptId:'active'}];assert.ok(updateBlockers(s).some(reason=>reason.includes('진행 중')));
  s.groups=[];s.attempts=[{status:'unknown',executionBlocked:true}];assert.ok(updateBlockers(s).some(reason=>reason.includes('게시 여부')));
  s.attempts=[];s.commands=[{type:'CONTROL',status:'received'}];assert.ok(updateBlockers(s).some(reason=>reason.includes('확인 응답')));
});
test('settled stop requests and terminal delivery records do not prevent update retry',()=>{
  const s=snapshot();s.groups=[{status:'stopped'},{status:'paused'}];s.attempts=[{status:'confirmed'},{status:'not_sent'},{status:'cancelled'}];s.commands=[{type:'CONTROL',status:'applied'}];
  assert.deepEqual(updateBlockers(s),[]);
});
test('every staged update phase is busy until an explicit completed or failed status',()=>{
  for(const phase of ['preparing','ready','applying'])assert.equal(updateInProgress(phase),true);
  for(const phase of ['idle','completed','failed',undefined])assert.equal(updateInProgress(phase),false);
});
test('busy polling has a bound and repeated network failures pause automatic polling',()=>{
  assert.equal(updatePollingDecision('preparing',119,0),'continue');
  assert.equal(updatePollingDecision('preparing',120,0),'busy_timeout');
  assert.equal(updatePollingDecision('applying',1,3),'connection_lost');
  assert.equal(updatePollingDecision('failed',500,0),'continue');
  assert.equal(updatePollingDecision('completed',500,0),'continue');
});
test('resume-required groups and nonterminal phases explain why update cannot start',()=>{
 const s=snapshot();s.groups=[{status:'resume_required'}];assert.ok(updateBlockers(s).some(reason=>reason.includes('중지')));
 s.groups=[];for(const status of ['prepared','executing']){s.attempts=[{status}];assert.ok(updateBlockers(s).some(reason=>reason.includes('진행 중')));}
});

test('connected older extensions remain update-required instead of reporting completion',()=>{
 assert.equal(extensionVersionState('0.4.18','0.4.13',true),'mismatch');
 assert.equal(extensionVersionState('0.4.18','0.4.18',true),'current');
 assert.equal(extensionVersionState('0.4.18','0.4.18',false),'offline');
 assert.equal(extensionVersionState(undefined,'0.4.18',true),'unknown');
 assert.equal(extensionVersionState('0.4.18',undefined,true),'unknown');
});

test('완료된 업데이트에 현재 발송의 수동 처리 안내를 남기지 않는다',async()=>{
 const {showUpdateBlockers}=await import('../central/ui/src/update.ts');
 assert.equal(showUpdateBlockers('completed'),false);assert.equal(showUpdateBlockers('idle'),true);
 const s=snapshot();s.attempts=[{status:'unknown'}];s.groups=[{status:'running'}];
 assert.ok(updateBlockers(s).length>0,'미확인 발송 보호는 유지한다');
 for(const text of updateBlockers(s))assert.doesNotMatch(text,/하세요|처리하세요|확인하세요/);
});
