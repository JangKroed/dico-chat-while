import test from 'node:test';import assert from 'node:assert/strict';
import {rollbackActionState} from '../central/ui/src/update.ts';
import {createRequire} from 'node:module';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),require=createRequire(join(root,'central/ui/package.json'));
const s={groups:[],attempts:[],commands:[]};
test('rollback requires server verified backup and shares update safety blockers',()=>{
 const status={phase:'idle',rollback:{available:true,version:'0.4.33'}};
 assert.equal(rollbackActionState(s,status).disabled,false);
 for(const result of [null,{phase:'idle'},{phase:'idle',rollback:{available:false}},{...status,phase:'applying'}])assert.equal(rollbackActionState(s,result).disabled,true);
 assert.equal(rollbackActionState(s,status,true).disabled,true);
 assert.equal(rollbackActionState({...s,groups:[{status:'stop_pending'}]},status).disabled,true);
 assert.equal(rollbackActionState({...s,attempts:[{status:'unknown'}]},status).disabled,true);
});
let loaded;
async function components(){return loaded??=(async()=>{const {build}=require('esbuild');const result=await build({stdin:{contents:"export {RollbackControls,UpdateFailureDetails} from './src/UpdatePanel.tsx';export {startRollback,establishSession} from './src/api.ts';export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';",resolveDir:join(root,'central/ui'),loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false});const dir=await mkdtemp(join(tmpdir(),'dico-rollback-ui-'));try{const file=join(dir,'test.cjs');await writeFile(file,result.outputFiles[0].contents);return require(file)}finally{await rm(dir,{recursive:true,force:true})}})()}
test('rollback screen shows exact previous version, data preservation and honest missing backup',async()=>{
 const {RollbackControls,createElement,renderToStaticMarkup}=await components();const render=result=>renderToStaticMarkup(createElement(RollbackControls,{s,result,busy:false,submitting:false,onStart:()=>{}}));
 const ready=render({phase:'idle',rollback:{available:true,version:'0.4.33'}});assert.match(ready,/0\.4\.33/);assert.match(ready,/이전 버전으로 되돌리기/);assert.match(ready,/설정과 실행 기록/);assert.match(ready,/자동으로 시작하거나 재개하지/);
 const absent=render({phase:'idle',rollback:{available:false,reason:'NO_BACKUP'}});assert.match(absent,/disabled/);assert.match(absent,/지원하는 버전에서 업데이트/);assert.doesNotMatch(absent,/\/Users\/private/);
});
test('rollback API sends one authenticated POST to rollback endpoint',async()=>{
 const {startRollback,establishSession}=await components();const previous={fetch:globalThis.fetch,location:globalThis.location,history:globalThis.history};const calls=[];
 globalThis.location={hash:'',pathname:'/',search:''};globalThis.history={replaceState:()=>{}};globalThis.fetch=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url==='/api/session'?{csrfToken:'csrf',appVersion:'0.4.34'}:{phase:'preparing',mode:'rollback'}),{status:200,headers:{'content-type':'application/json'}})};
 try{await establishSession();const result=await startRollback();assert.equal(result.mode,'rollback');assert.equal(calls.at(-1).url,'/api/updates/rollback');assert.equal(calls.at(-1).options.method,'POST');assert.equal(calls.at(-1).options.body,'{}');assert.equal(calls.at(-1).options.headers.get('X-Dico-CSRF'),'csrf')}finally{Object.assign(globalThis,previous)}
});
test('unavailable rollback reasons distinguish missing backup, damaged files, incompatible data and same version',async()=>{
 const {RollbackControls,createElement,renderToStaticMarkup}=await components();
 for(const [reason,expected] of [['NO_BACKUP',/지원하는 버전에서 업데이트/],['BACKUP_INVALID',/무결성 검증/],['ROLLBACK_INCOMPATIBLE',/현재 데이터/],['SAME_VERSION',/현재 실행 중인 버전과 같/]]){
  const html=renderToStaticMarkup(createElement(RollbackControls,{s,result:{phase:'idle',rollback:{available:false,reason}},busy:false,submitting:false,onStart:()=>{}}));assert.match(html,expected);assert.match(html,/disabled/);
 }
});

test('rollback keeps safe server diagnosis and completion wording without exposing raw file paths',async()=>{
 const {rollbackPhaseMessage}=await import('../central/ui/src/update.ts');
 assert.match(rollbackPhaseMessage('completed'),/복원을 완료했습니다/);assert.doesNotMatch(rollbackPhaseMessage('completed'),/검사하고|확인합니다/);
 const {UpdateFailureDetails,createElement,renderToStaticMarkup}=await components();
 const render=message=>renderToStaticMarkup(createElement(UpdateFailureDetails,{result:{phase:'failed',mode:'rollback',diagnostic:{code:'ROLLBACK_INCOMPATIBLE',stage:'compatibility',message}},onReport:()=>{}}));
 assert.match(render('보관된 버전이 현재 데이터를 읽지 못하여 되돌리기를 중단했습니다.'),/현재 데이터를 읽지 못하여/);
 assert.doesNotMatch(render('failed /Users/private/rollback/file.js'),/Users|file.js/);
});
