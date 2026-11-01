import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('종료 표식을 저장하지 못해도 HTTP 서비스와 허가 엔진은 종료된다',()=>{
  const source=`
    import {mkdtemp,mkdir,rm} from 'node:fs/promises';
    import {tmpdir} from 'node:os';import {join} from 'node:path';
    import {startCentralRuntime} from './central/runtime/main.mjs';
    const directory=await mkdtemp(join(tmpdir(),'dico-close-failure-'));
    const runtime=await startCentralRuntime({directory,port:0});
    await mkdir(join(directory,'shutdown.json'));
    let closeError=false,closed=false;
    try{await runtime.close();}catch{closeError=true;}
    try{await fetch(runtime.url+'/api/snapshot',{signal:AbortSignal.timeout(1000)});}catch{closed=true;}
    console.log(JSON.stringify({closeError,closed}));
    await rm(directory,{recursive:true,force:true});process.exit(0);
  `;
  const output=execFileSync(process.execPath,['--input-type=module','-e',source],{cwd:new URL('../',import.meta.url),encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:5000});
  assert.deepEqual(JSON.parse(output.trim()),{closeError:true,closed:true});
});
