import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const require=createRequire(new URL('../central/ui/package.json',import.meta.url));

test('실제 페이지 코드 화면은 관측·불일치·과거 관측·미확인을 구분한다',async t=>{
 const {build}=require('esbuild');
 const result=await build({stdin:{contents:"export {PageCodeVersions} from './src/UpdatePanel.tsx';export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';",resolveDir:new URL('../central/ui/',import.meta.url).pathname,loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false});
 const dir=await mkdtemp(join(tmpdir(),'dico-code-ui-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'render.cjs');await writeFile(path,result.outputFiles[0].contents);const {PageCodeVersions,createElement,renderToStaticMarkup}=require(path);
 const s={instances:[{id:'i',extensionVersion:'0.4.44',extensionBuildId:'b'.repeat(64),browser:'Brave'}],channels:[{id:'c',instanceId:'i',name:'fixture',pageCode:{state:'observed',version:'0.4.12',buildId:'a'.repeat(64),observedAt:1800000000000}}]};
 const render=()=>renderToStaticMarkup(createElement(PageCodeVersions,{s}));
 let html=render();assert.match(html,/페이지 관측 버전 0.4.12/);assert.match(html,/확장과 다른 실행 코드/);assert.doesNotMatch(html,/수동|재연결|새로고침|a{64}/);
 s.channels[0].pageCode={state:'observed',version:'0.4.12',observedAt:1800000000000};html=render();assert.match(html,/확장과 다른 실행 코드/,'빌드 지문이 없어도 실제 보고 버전 불일치를 표시합니다.');
 s.channels[0].pageCode.state='stale';html=render();assert.match(html,/과거 관측 버전/);assert.doesNotMatch(html,/확장 빌드 일치/);
 s.channels[0].pageCode={state:'unknown'};html=render();assert.match(html,/페이지 실행 코드 미확인/);assert.doesNotMatch(html,/페이지 관측 버전 0.4.44/);
});
