import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync(new URL('../content.js',import.meta.url),'utf8');
function fixture(){
 const listeners=new Set(),documentListeners=new Set();
 const runtime={id:'ext',onMessage:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}};
 const context=createContext({chrome:{runtime},document:{addEventListener:(n,fn)=>documentListeners.add(fn),removeEventListener:(n,fn)=>documentListeners.delete(fn)}});
 runInContext(source,context);
 const send=type=>{let result;for(const fn of listeners)fn({type},{id:'ext'},value=>result=value);return result;};
 return {listeners,documentListeners,context,send};
}
test('content handshake exposes running build and safe disposal removes its listeners',()=>{
 const f=fixture();assert.equal(f.send('DICO_CONTENT_STATUS')?.buildId,'unmanaged');
 assert.equal(f.send('DICO_CONTENT_DISPOSE')?.disposed,true);assert.equal(f.listeners.size,0);assert.equal(f.documentListeners.size,0);
 runInContext(source,f.context);assert.equal(f.listeners.size,1);assert.equal(f.documentListeners.size,2);
});
test('reinjecting the same active context does not duplicate handlers',()=>{
 const f=fixture();runInContext(source,f.context);assert.equal(f.listeners.size,1);assert.equal(f.documentListeners.size,2);
});
test('legacy boolean guard is preserved for explicit one-time tab refresh',()=>{
 const context=createContext({__dicoWhileLoaded:true});runInContext(source,context);assert.equal(context.__dicoWhileLifecycle,undefined);
});

test('이전 콘텐츠의 실제 리스너를 해제하고 새 빌드를 주입해도 초안·설정은 건드리지 않는다',async()=>{
 const {ensureManagedContent}=await import('../central/extension/update.js');
 const listeners=new Set(),documentListeners=new Set(),calls=[];
 const runtime={id:'ext',onMessage:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}};
 const document={draft:'사용자 초안',addEventListener:(n,fn)=>documentListeners.add(fn),removeEventListener:(n,fn)=>documentListeners.delete(fn)};
 const context=createContext({chrome:{runtime},document});
 const old='a'.repeat(64),next='b'.repeat(64);
 runInContext(source.replace("const CONTENT_BUILD_ID = 'unmanaged';",`const CONTENT_BUILD_ID = '${old}';`),context);
 const chrome={tabs:{get:async()=>({url:'https://discord.com/channels/1/2'}),sendMessage:async(_,message)=>{
  calls.push(message.type);let result;for(const listener of listeners)listener(message,{id:'ext'},value=>{result=value;});return result;
 }},scripting:{executeScript:async()=>runInContext(source.replace("const CONTENT_BUILD_ID = 'unmanaged';",`const CONTENT_BUILD_ID = '${next}';`),context)}};
 assert.equal((await ensureManagedContent(chrome,[{tabId:1,guildId:'1',channelId:'2'}],next))[0].ready,true);
 assert.equal(listeners.size,1);assert.equal(documentListeners.size,2);assert.equal(document.draft,'사용자 초안');
 assert.deepEqual(calls,['DICO_CONTENT_STATUS','DICO_CONTENT_DISPOSE','DICO_CONTENT_STATUS']);
});
