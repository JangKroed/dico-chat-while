import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
test('릴리즈에 현재 설치 ZIP 안내와 모든 기록된 이전 버전 변경 내역을 포함한다',()=>{
 const root=new URL('../',import.meta.url);
 const notes=execFileSync('python3',['scripts/release-notes.py'],{cwd:root,encoding:'utf8'});
 const version=JSON.parse(readFileSync(new URL('manifest.json',root))).version;
 assert.ok(notes.includes(`dico-while-${version}.zip`));assert.ok(notes.includes('Source code'));
 const headings=[...readFileSync(new URL('README.md',root),'utf8').matchAll(/^## (\d+\.\d+\.\d+[^\n]*)/gm)].map(m=>m[1]);
 for(const heading of headings)assert.ok(notes.includes(`### ${heading}`),heading);
 assert.ok(notes.includes('<details>'));assert.ok(notes.length<125000);
});
