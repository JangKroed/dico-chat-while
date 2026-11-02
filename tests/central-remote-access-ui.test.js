import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),require=createRequire(join(root,'central/ui/package.json'));
let loaded;
function components(){return loaded??=(async()=>{
  const {build}=require('esbuild');const result=await build({stdin:{contents:"export * from './src/remote-access.ts';export {RemoteAccessGuide} from './src/RemoteAccessGuide.tsx';export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';",resolveDir:join(root,'central/ui'),loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false});
  const dir=await mkdtemp(join(tmpdir(),'dico-remote-access-'));try{const file=join(dir,'component.cjs');await writeFile(file,result.outputFiles[0].contents);return require(file);}finally{await rm(dir,{recursive:true,force:true});}
})();}

test('remote instructions preserve both canonical ports and omit all current URL secrets',async()=>{
  const {remoteAccessAddress}=await components();const guide=remoteAccessAddress('http://127.0.0.1:47123/settings?private=do-not-copy#bootstrap=do-not-copy');
  assert.equal(guide.origin,'http://127.0.0.1:47123');assert.equal(guide.port,'47123');assert.match(guide.command,/-L 127\.0\.0\.1:47123:127\.0\.0\.1:47123 SSH_USER@CENTRAL_HOST$/);assert.ok(!JSON.stringify(guide).includes('do-not-copy'));assert.match(guide.command,/ExitOnForwardFailure=yes/);assert.ok(!guide.command.includes('0.0.0.0'));
  for(const href of ['http://localhost:47123','http://192.168.0.10:47123','https://127.0.0.1:47123','http://user:password@127.0.0.1:47123','file:///tmp/help','not-a-url'])assert.equal(remoteAccessAddress(href),null,href);
});

test('a handoff link must be fresh, canonical and contain only the one-time bootstrap',async()=>{
  const {validRemoteAccessLink}=await components(),origin='http://127.0.0.1:47123',reply={url:`${origin}/#bootstrap=${'a'.repeat(64)}`,expiresAt:120001};
  assert.equal(validRemoteAccessLink(reply,origin,1),true);assert.equal(validRemoteAccessLink(reply,origin,120001),false);
  for(const url of [reply.url.replace('47123','47124'),reply.url.replace('127.0.0.1','evil.example'),reply.url.replace('/#','/settings#'),reply.url.replace('/#','/?token=secret#'),reply.url+'&other=secret',reply.url.replace('#bootstrap=','#bridgeToken='),reply.url.replace('//127','//user:password@127')])assert.equal(validRemoteAccessLink({...reply,url},origin,1),false,url);
});

test('remote help explains owner permissions, separate networks and actual executor limits without exposing a login link on render',async()=>{
  const {RemoteAccessGuide,createElement,renderToStaticMarkup}=await components();const html=renderToStaticMarkup(createElement(RemoteAccessGuide,{href:'http://127.0.0.1:47123/#bootstrap=never-render'}));
  for(const text of ['SSH_USER','CENTRAL_HOST','VPN','아직 지원하지 않습니다','전체 관리 권한','현재 주소창 복사만으로는','2분짜리 접속 링크 만들기','터널 종료는 중앙 PC의 발송을 중지하지 않습니다'])assert.ok(html.includes(text),text);
  assert.ok(!html.includes('never-render'));assert.ok(!html.includes('일회용 원격 접속 링크'));assert.ok(html.includes('Apple 원격 로그인 안내'));
});

test('non-loopback pages cannot offer an executable tunnel or enabled login link issue button',async()=>{
  const {RemoteAccessGuide,createElement,renderToStaticMarkup}=await components();const html=renderToStaticMarkup(createElement(RemoteAccessGuide,{href:'https://elsewhere.example:47123/'}));assert.match(html,/정확한 중앙 관리 주소를 확인할 수 없습니다/);assert.ok(!html.includes('ssh -N'));assert.match(html,/<button[^>]*disabled=""[^>]*>2분짜리 접속 링크 만들기/);
});
