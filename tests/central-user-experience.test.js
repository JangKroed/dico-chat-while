import test from 'node:test';
import assert from 'node:assert/strict';
import {readDiagnosticMode,writeDiagnosticMode,visiblePage,operationSummary,recentConfirmed} from '../central/ui/src/user-experience.ts';
const snapshot=()=>({schemaVersion:1,stateVersion:1,messages:[],instances:[],channels:[],groups:[],attempts:[],incidents:[],events:[],commands:[]});
test('diagnostic preference is opt-in and safely handles unavailable storage',()=>{
 assert.equal(readDiagnosticMode({getItem:()=>null}),false);
 assert.equal(readDiagnosticMode({getItem:()=>{throw Error('blocked')}}),false);
 assert.equal(readDiagnosticMode({getItem:()=> 'true'}),true);
 assert.doesNotThrow(()=>writeDiagnosticMode(false,{setItem:()=>{throw Error('blocked')}}));
 for(const page of ['history','logs','/logs/'])assert.equal(visiblePage(page,false),'dashboard');
 assert.equal(visiblePage('logs',true),'logs');assert.equal(visiblePage('unknown',true),'dashboard');
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

test('App routes, navigation and diagnostic-only pages share the preference boundary',async()=>{
 const {readFile}=await import('node:fs/promises');const app=await readFile(new URL('../central/ui/src/App.tsx',import.meta.url),'utf8');
 assert.match(app,/visiblePage\(location.pathname,readDiagnosticMode\(\)\)/);
 assert.match(app,/visiblePage\(location.pathname,diagnosticRef.current\)/);
 assert.match(app,/visiblePage\(requested,diagnosticRef.current\)/);
 assert.match(app,/diagnostic&&page==='history'/);assert.match(app,/diagnostic&&page==='logs'/);
 assert.match(app,/aria-label="개발자 진단 모드"/);
 assert.match(app,/<AutomaticSupport diagnostic=\{diagnostic\}/);
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
