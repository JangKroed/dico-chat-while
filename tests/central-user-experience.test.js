import test from 'node:test';
import assert from 'node:assert/strict';
import {visiblePage,operationSummary,recentConfirmed} from '../central/ui/src/user-experience.ts';
const snapshot=()=>({schemaVersion:1,stateVersion:1,messages:[],instances:[],channels:[],groups:[],attempts:[],incidents:[],events:[],commands:[]});
test('운영 화면만 열고 예전 진단 주소는 대시보드로 돌린다',()=>{
 for(const page of ['history','logs','/logs/','unknown'])assert.equal(visiblePage(page),'dashboard');
 assert.equal(visiblePage('/settings/'),'settings');
});
test('unresolved incidents never imply active recovery or demand login without evidence',()=>{
 const s=snapshot();s.incidents=[{id:'i',code:'account_mismatch'}];s.groups=[{id:'g',status:'needs_review'}];
 const result=operationSummary(s);assert.equal(result.kind,'blocked');assert.doesNotMatch(result.description,/로그인|새로고침|재검사/);
});
test('only a pending reconciliation is active recovery; exhausted recovery remains blocked',()=>{
 const s=snapshot();s.groups=[{id:'g',status:'needs_review',activeAttemptId:'a'}];s.attempts=[{id:'a',status:'unknown',executionBlocked:true,recoveryCount:3}];
 assert.equal(operationSummary(s).kind,'blocked');
 s.commands=[{id:'c',type:'RECONCILE',status:'received',payload:{attemptId:'a'}}];
 assert.equal(operationSummary(s).kind,'recovering');
 s.commands[0].status='rejected';assert.equal(operationSummary(s).kind,'blocked');
});
test('stop pending is never reported stopped and stale snapshot never implies active recovery',()=>{
 const s=snapshot();s.groups=[{id:'g',status:'stop_pending'}];assert.equal(operationSummary(s).kind,'pending');
 assert.equal(operationSummary(s,true).kind,'stale');s.groups[0].status='stopped';assert.equal(operationSummary(s).kind,'stopped');
});
test('recent results exclude unknown and order by confirmation time',()=>{
 const s=snapshot();s.attempts=[{id:'old',status:'confirmed',confirmedAt:1},{id:'unknown',status:'unknown',confirmedAt:9},{id:'new',status:'confirmed',confirmedAt:8}];
 assert.deepEqual(recentConfirmed(s).map(a=>a.id),['new','old']);
});

test('일반 화면에는 진단 모드 설정과 과거 진단 경로가 없다',async()=>{
 const {readFile}=await import('node:fs/promises');const app=await readFile(new URL('../central/ui/src/App.tsx',import.meta.url),'utf8');
 assert.match(app,/visiblePage\(location.pathname\)/);
 assert.match(app,/visiblePage\(requested\)/);
 assert.doesNotMatch(app,/개발자 진단 모드|readDiagnosticMode|diagnosticRef|page==='history'|page==='logs'/);
 assert.match(app,/<AutomaticSupport diagnostic=\{false\} accessMode=/);
 const dashboard=app.slice(app.indexOf('function UserDashboard('),app.indexOf('function DashboardGroupControls('));
 assert.doesNotMatch(dashboard,/go\('history'\)|go\('logs'\)|RetryNotSentButton|s\.events|incident\.recheck/);
 assert.match(dashboard,/<OperationalDashboard \{...props\}/);
 const operating=await readFile(new URL('../central/ui/src/OperationalDashboard.tsx',import.meta.url),'utf8');
 assert.match(operating,/disabled=\{controls.stop.disabled\}/);
});

test('historical unrelated incident does not turn a running operation into a current failure',()=>{
 const s=snapshot();s.groups=[{id:'g',status:'running'}];s.incidents=[{id:'old',code:'account_mismatch'}];
 assert.equal(operationSummary(s).kind,'running');
});
test('exhausted preparation remains a current failure even after active attempt is cleared',()=>{
 const s=snapshot();s.groups=[{id:'g',status:'paused',waitReason:'preparation_failed'}];
 assert.equal(operationSummary(s).kind,'blocked');
});

test('모두 실행 예약은 대조 명령 사이와 화면 재접속 후에도 예약으로 표시한다',()=>{
 const s=snapshot();
 s.groups=[{id:'g',status:'pause_pending',activeAttemptId:'old',autoResume:{reasonCode:'delivery_recovery_requested'}}];
 s.attempts=[{id:'old',status:'unknown'}];
 assert.equal(operationSummary(s).title,'실행을 예약했습니다');
 s.groups[0].status='paused';
 assert.equal(operationSummary(s).title,'실행을 예약했습니다');
 delete s.groups[0].autoResume;
 assert.equal(operationSummary(s).kind,'blocked');
});
