import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';

// DB 조회·JSON 해석·압축을 발송/중지 이벤트 루프에서 분리합니다.
// 같은 업무 규칙의 읽기 전용 코어를 사용하며 보고서용 판단 경로를 복제하지 않습니다.
export function createSupportCollector({databasePath,appVersion,timeoutMs=30000}={}){
 let closed=false,tail=Promise.resolve(),active=null;const terminations=new Set();
 const unavailable=()=>Object.assign(Error('진단 자료 수집을 완료하지 못했습니다. 자동 수집을 다시 시도합니다.'),{code:'SUPPORT_COLLECTION_FAILED',status:503});
 function collect(options={}){
  const task=tail.then(()=>{
   if(closed)throw unavailable();
   return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL(import.meta.url),{workerData:{databasePath,appVersion,options}});
    let settled=false;
    const finish=(error,report)=>{
     if(settled)return;settled=true;clearTimeout(timer);active=null;
     const ending=worker.terminate();terminations.add(ending);void ending.finally(()=>terminations.delete(ending));
     error?reject(error):resolve(report);
    };
    const timer=setTimeout(()=>finish(unavailable()),timeoutMs);
    active={cancel:()=>finish(unavailable())};
    worker.once('message',packet=>packet.ok?finish(null,packet.report):finish(Object.assign(unavailable(),{status:packet.status||503,code:packet.code||'SUPPORT_COLLECTION_FAILED'})));
    worker.once('error',()=>finish(unavailable()));
    worker.once('exit',()=>{if(!settled)finish(unavailable());});
   });
  });
  tail=task.catch(()=>{});return task;
 }
 return{collect,async close(){closed=true;active?.cancel();await tail;await Promise.all(terminations);}};
}

if(!isMainThread&&workerData){
 const {createCentralManager}=await import('../core/index.js');
 const {createSupportReport}=await import('./support-report.mjs');
 let manager;
 try{
  manager=createCentralManager({databasePath:workerData.databasePath,readOnly:true});
  const report=await createSupportReport({manager,appVersion:workerData.appVersion,...workerData.options});
  parentPort.postMessage({ok:true,report});
 }catch(error){
  // 파일 경로·SQL·외부 응답 등 자유 텍스트를 worker 오류에 싣지 않습니다.
  parentPort.postMessage({ok:false,status:[400,404,413].includes(error.status)?error.status:503,code:error.code==='NOT_FOUND'?'NOT_FOUND':'SUPPORT_COLLECTION_FAILED'});
 }finally{manager?.close();}
}
