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
