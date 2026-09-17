// Append-only IndexedDB archive: avoid rewriting the complete log on each event.
// No application count/age limit. Browser quota and available disk still apply.
let opening;
function openArchive() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  opening ??= new Promise((resolve,reject)=>{
    const request=indexedDB.open('dico-diagnostics',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('events',{autoIncrement:true});
    request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();opening=null;};resolve(db);};
    request.onerror=()=>{opening=null;reject(request.error);};
    request.onblocked=()=>{opening=null;reject(new Error('진단 저장소가 다른 페이지에서 사용 중입니다.'));};
  });
  return opening;
}
export async function archiveEvents(events) {
  const db=await openArchive();if(!db)return;
  await new Promise((resolve,reject)=>{
    const tx=db.transaction('events','readwrite');
    for(const event of events)tx.objectStore('events').add(event);
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error || Error('진단 기록 저장 취소'));
  });
}
export async function readDiagnosticArchive() {
  const db=await openArchive();if(!db)return [];
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('events','readonly'),request=tx.objectStore('events').getAll();
    tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
}
