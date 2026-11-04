// 실제 계정과 분리한 임시 Chrome 프로필에서 SPA 이동 후 MessageSender를 관찰합니다.
// discord.com 요청은 CDP에서 빈 fixture 문서로 대체하며 DNS도 차단합니다.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const chrome=process.env.DICO_BROWSER_BINARY;
assert.ok(chrome,'DICO_BROWSER_BINARY에 확장 로드 가능한 Chrome for Testing 실행 경로를 지정하세요.');
const base=await mkdtemp(resolve(tmpdir(),'dico-delay-browser-')),ext=resolve(base,'extension'),profile=resolve(base,'profile');
let child,socket,nextId=0;const pending=new Map();
const until=async fn=>{for(let i=0;i<150;i++){try{const value=await fn();if(value)return value;}catch{}await delay(100);}throw Error('fixture timeout');};
const cmd=(method,params={})=>new Promise((resolve,reject)=>{const id=++nextId;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const r=await cmd('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
try{
 await mkdir(ext);
 await copyFile(new URL('../central/extension/managed-delay.js',import.meta.url),resolve(ext,'managed-delay.js'));
 await writeFile(resolve(ext,'manifest.json'),JSON.stringify({manifest_version:3,name:'DICO isolated sender fixture',version:'1.0',permissions:['tabs','scripting'],host_permissions:['https://discord.com/*'],background:{service_worker:'background.js',type:'module'},content_scripts:[{matches:['https://discord.com/*'],js:['content.js']}]}));
 await writeFile(resolve(ext,'background.js'),`import {managedPageDelay} from './managed-delay.js';
let previousSender;
chrome.runtime.onMessage.addListener((m,s,reply)=>{(async()=>{
 if(m.mode==='old-document')s=previousSender;else previousSender=s;
 const tab=await chrome.tabs.get(s.tab.id);
 const state={sessionId:'session',bindings:{b:{tabId:s.tab.id,guildId:'111',channelId:m.channel}},attempts:{}};
 const result=await managedPageDelay({durationMs:0},s,state,{extensionId:chrome.runtime.id,wait:async()=>{if(m.mode==='session')state.sessionId='replacement';},resolveDocument:async source=>{const [r]=await chrome.scripting.executeScript({target:{tabId:source.tab.id,documentIds:[source.documentId]},func:()=>location.href});return r&&{url:r.result,documentId:r.documentId,frameId:r.frameId};}});
 reply({url:s.url,tabUrl:s.tab.url,freshUrl:tab.url,documentId:s.documentId,frameId:s.frameId,result});
})().catch(e=>reply({error:e.message}));return true;});`);
 await writeFile(resolve(ext,'content.js'),`window.addEventListener('fixture-request',()=>{chrome.runtime.sendMessage({channel:location.pathname.split('/').filter(Boolean).at(-1),mode:document.documentElement.dataset.mode}).then(value=>{document.documentElement.dataset.result=JSON.stringify(value);});});document.documentElement.dataset.ready='yes';`);
 child=spawn(chrome,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,'--host-resolver-rules=MAP discord.com ~NOTFOUND','--no-first-run','--no-default-browser-check','--disable-background-networking','about:blank'],{stdio:['ignore','ignore','pipe']});
 let stderr='';child.stderr.on('data',c=>{stderr+=String(c).slice(0,500);});
 const port=await until(async()=>{if(child.exitCode!==null)throw Error(stderr);return Number((await readFile(resolve(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);});
 const tab=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();socket=new WebSocket(tab.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 socket.addEventListener('message',async e=>{const p=JSON.parse(e.data);if(p.id){const w=pending.get(p.id);pending.delete(p.id);p.error?w?.reject(Error(p.error.message)):w?.resolve(p.result);}if(p.method==='Fetch.requestPaused')await cmd('Fetch.fulfillRequest',{requestId:p.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html'}],body:Buffer.from('<!doctype html><html><body>Isolated route fixture</body></html>').toString('base64')});});
 await cmd('Page.enable');await cmd('Runtime.enable');await cmd('Fetch.enable',{patterns:[{urlPattern:'https://discord.com/*'}]});
 await cmd('Page.navigate',{url:'https://discord.com/channels/111/222'});
 await until(()=>evaluate(`document.documentElement.dataset.ready==='yes'`));
 const sample=async(mode='normal')=>{await evaluate(`document.documentElement.dataset.mode=${JSON.stringify(mode)};delete document.documentElement.dataset.result;window.dispatchEvent(new Event('fixture-request'));`);return until(async()=>{const r=await evaluate('document.documentElement.dataset.result');return r&&JSON.parse(r);});};
 const before=await sample();
 await evaluate(`history.pushState({},'', '/channels/111/333')`);
 const after=await sample();
 const sessionChanged=await sample('session');
 assert.equal(sessionChanged.result.reasonCode,'DELAY_SESSION_MISMATCH');
 await cmd('Page.navigate',{url:'https://discord.com/channels/111/444'});
 await until(()=>evaluate(`document.documentElement.dataset.ready==='yes'`));
 const replaced=await sample('old-document');
 assert.equal(replaced.result.reasonCode,'DELAY_DOCUMENT_UNAVAILABLE');
 console.log(JSON.stringify({browser:await cmd('Browser.getVersion'),before,after,sessionChanged,replaced},null,2));
 assert.equal(before.result.ok,true);
 assert.equal(after.result.ok,true,'같은 문서의 SPA 이동 뒤에도 관리 대기가 정상 완료되어야 합니다.');
 assert.equal(after.freshUrl,'https://discord.com/channels/111/333');
 assert.equal(before.documentId,after.documentId,'SPA 이동은 동일 문서');
}finally{
 socket?.close();if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,3000);});}
 await rm(base,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
