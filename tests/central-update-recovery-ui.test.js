import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(join(root,'central/ui/package.json'));
test('update failure screen shows automatic reporting and receipt instead of terminal troubleshooting',async()=>{
 const {build}=require('esbuild');
 const compiled=await build({stdin:{contents:"export {UpdateFailureDetails} from './src/UpdatePanel.tsx';export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';",resolveDir:join(root,'central/ui'),loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false});
 const dir=await mkdtemp(join(tmpdir(),'dico-update-screen-'));
 try{
  const file=join(dir,'screen.cjs');await writeFile(file,compiled.outputFiles[0].contents);
  const {UpdateFailureDetails,createElement,renderToStaticMarkup}=require(file);
  const render=support=>renderToStaticMarkup(createElement(UpdateFailureDetails,{result:{phase:'failed',message:'failed',retryCount:2,diagnostic:{code:'NETWORK',stage:'source',message:'연결이 끊겼습니다.'},support},onReport:()=>{}}));
  const sent=render({status:'sent',reportId:'report-123',receiptId:'receipt-123'});
  assert.match(sent,/관리자 접수 완료/);assert.match(sent,/receipt-123/);assert.match(sent,/자동 재시도 2회/);assert.doesNotMatch(sent,/터미널|네트워크·저장 공간을 확인/);
  assert.match(render({status:'queued'}),/전송 대기/);
  const disabled=render({status:'disabled'});assert.match(disabled,/꺼져/);assert.doesNotMatch(disabled,/관리자 접수 완료/);
  assert.match(render({status:'manual'}),/진단 정보 보내기/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('unified update card prioritizes active work and failure without duplicating completed version details',async()=>{
 const {build}=require('esbuild');
 const compiled=await build({stdin:{contents:"export {UpdateStatusCard} from './src/UpdatePanel.tsx';export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';",resolveDir:join(root,'central/ui'),loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false});
 const dir=await mkdtemp(join(tmpdir(),'dico-update-status-'));
 try{
  const file=join(dir,'screen.cjs');await writeFile(file,compiled.outputFiles[0].contents);
  const {UpdateStatusCard,createElement,renderToStaticMarkup}=require(file);
  const base={appVersion:'0.4.61',latest:{state:'current',currentVersion:'0.4.61',latestVersion:'0.4.61',checkedAt:1730000000000},checkingLatest:false,submitting:false,requestMode:'update',result:{phase:'completed',version:'0.4.61',message:'업데이트를 완료했습니다.',updatedAt:1729999000000}};
  const render=props=>renderToStaticMarkup(createElement(UpdateStatusCard,{...base,...props}));
  const current=render({});
  assert.equal((current.match(/class="update-state"/g)||[]).length,1);
  assert.match(current,/최신 버전 사용 중/);assert.match(current,/현재 0.4.61 · 공식 배포 0.4.61/);
  assert.doesNotMatch(current,/버전 정보|최근 작업 버전|업데이트를 완료했습니다/);
  assert.match(current,/마지막 확인/);assert.match(current,/업데이트 완료/);
  const applying=render({result:{phase:'applying',version:'0.4.62',message:'새 프로그램을 적용합니다.'}});
  assert.match(applying,/업데이트 적용 · 재시작 중/);assert.match(applying,/적용할 버전 0.4.62/);assert.match(applying,/<progress/);assert.doesNotMatch(applying,/최신 버전 사용 중/);
  const failed=render({checkingLatest:true,result:{phase:'failed',message:'업데이트 연결 실패'}});
  assert.match(failed,/업데이트 실패/);assert.match(failed,/업데이트 연결 실패/);assert.doesNotMatch(failed,/최신 버전 확인 중/);
  assert.match(render({result:{phase:'preparing',retrying:true,message:'재시도합니다.'}}),/자동 복구 중/);
  assert.match(render({result:{phase:'completed',mode:'rollback',version:'0.4.60'}}),/이전 버전 복원 완료/);
  assert.match(render({submitting:true,requestMode:'rollback'}),/이전 버전 복원 요청 중/);
  assert.match(render({latest:{state:'available',latestVersion:'0.4.62'}}),/새 업데이트 사용 가능/);
  assert.match(render({latest:{state:'ahead'}}),/공식 배포보다 높은 버전 사용 중/);
  assert.match(render({latest:{state:'unavailable'}}),/최신 버전을 확인하지 못했습니다/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
