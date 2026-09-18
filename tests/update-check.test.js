import test from 'node:test';
import assert from 'node:assert/strict';
import {newerVersion,releaseUpdate,RELEASES,checkForUpdate} from '../update-check.js';
test('버전은 숫자로 비교하고 정식 릴리스의 정확한 저장소 ZIP만 허용한다',()=>{
 assert.equal(newerVersion('0.2.100','0.2.99'),true);assert.equal(newerVersion('0.2.38','0.2.38'),false);
 assert.equal(newerVersion('0.2.39-beta','0.2.38'),false);
 const r={tag_name:'v0.2.39',assets:[{name:'dico-while-0.2.39.zip',browser_download_url:`${RELEASES}/download/v0.2.39/dico-while-0.2.39.zip`}]};
 assert.equal(releaseUpdate(r,'0.2.38').version,'0.2.39');assert.equal(releaseUpdate({...r,prerelease:true},'0.2.38'),null);
 assert.throws(()=>releaseUpdate({...r,assets:[]},'0.2.38'),/ZIP/);
});
test('권한 미승인 시 통신하지 않고 404와 네트워크 실패를 구분한다',async()=>{
 let allowed=false,stored={};const api={permissions:{contains:async()=>allowed},storage:{local:{get:async()=>stored,set:async v=>stored=v}},runtime:{getManifest:()=>({version:'0.2.38'})}};
 assert.equal((await checkForUpdate(api,true,()=>{throw Error('must not call')})).disabled,true);
 allowed=true;assert.equal((await checkForUpdate(api,true,async()=>({status:404})) ).noRelease,true);
 assert.match((await checkForUpdate(api,true,async()=>{throw Error('offline')})).error,/offline/);
});
