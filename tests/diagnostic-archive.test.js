import test from 'node:test';
import assert from 'node:assert/strict';
// Transaction-shaped fixture tests append/export contract without new dependencies.
test('보관소는 2,000개를 넘는 기록을 삭제하지 않고 재조회한다',async()=>{
 const rows=[];let fail=false;
 const db={createObjectStore(){},transaction(){
  const tx={objectStore:()=>({add:e=>rows.push(structuredClone(e)),getAll:()=>({result:structuredClone(rows)})})};
  queueMicrotask(()=>{if(fail){tx.error=Error('quota');tx.onabort();}else tx.oncomplete();});return tx;
 }};
 globalThis.indexedDB={open(){const request={result:db};queueMicrotask(()=>request.onsuccess());return request;}};
 try{
  const {archiveEvents,readDiagnosticArchive}=await import('../diagnostic-archive.js');
  await archiveEvents(Array.from({length:2501},(_,n)=>({n})));
  await archiveEvents([{n:2501}]);
  const archive=await readDiagnosticArchive();assert.equal(archive.length,2502);assert.equal(archive[0].n,0);assert.equal(archive.at(-1).n,2501);
  fail=true;await assert.rejects(archiveEvents([]),/quota/);
 }finally{delete globalThis.indexedDB;}
});
