import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// 확장 관리 목록과 도구 모음이 같은 아이콘을 사용하고, 배포 파일의 크기가 선언과 일치하는지 확인한다.
test('central extension ships correctly sized PNG icons for list and toolbar',async()=>{
 const root=new URL('../central/extension/',import.meta.url);
 const manifest=JSON.parse(await readFile(new URL('manifest.json',root),'utf8'));
 for(const size of [16,32,48,128]){
  const path=manifest.icons?.[size];assert.equal(path,`icons/icon${size}.png`);
  assert.equal(manifest.action.default_icon[size],path);
  const bytes=await readFile(new URL(path,root));
  assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);
 }
});
