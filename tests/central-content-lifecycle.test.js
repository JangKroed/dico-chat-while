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
