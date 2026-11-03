import test from 'node:test';
import assert from 'node:assert/strict';
import {createCentralApplication} from '../central/runtime/http.mjs';
import {safeToUpdate} from '../central/runtime/updater.mjs';

const blocked=()=>({service:{status:'ready'},groups:[{id:'group',status:'needs_review',activeAttemptId:'attempt',controlIntent:null}],attempts:[{id:'attempt',groupId:'group',status:'unknown',executionBlocked:true}]});
async function status(snapshot,phase='idle'){
 const token='b'.repeat(64),app=createCentralApplication({manager:{snapshot:()=>snapshot},bridgeToken:token,updates:{status:async()=>({phase})}});
 let result;
 try{await app.handler({method:'GET',url:'/api/bridge/status',headers:{host:'127.0.0.1:43127',authorization:`Bearer ${token}`}},{setHeader(){},writeHead(code){assert.equal(code,200);},end(text){result=JSON.parse(text);}});return result;}
 finally{await app.close();}
}
test('a blocked unknown attempt permits extension replacement without releasing delivery locks or whole-app update',async()=>{
 const snapshot=blocked(),before=structuredClone(snapshot);
 assert.equal((await status(snapshot)).reloadSafe,true);
 assert.equal(safeToUpdate(snapshot),false);
 assert.deepEqual(snapshot,before);
});
test('extension replacement still rejects executing, unblocked, stopping and unrelated active attempts',async()=>{
 const cases=[];
 for(const phase of ['preparing','prepared','permitted','executing']){const s=blocked();s.attempts[0].status=phase;cases.push(s);}
 for(const value of [undefined,false]){const s=blocked();s.attempts[0].executionBlocked=value;cases.push(s);}
 for(const phase of ['running','stop_pending','pause_pending']){const s=blocked();s.groups[0].status=phase;cases.push(s);}
 {const s=blocked();s.groups[0].controlIntent='stop';cases.push(s);}
 {const s=blocked();s.groups[0].activeAttemptId='missing';cases.push(s);}
 {const s=blocked();s.attempts[0].groupId='different';cases.push(s);}
 {const s=blocked();s.service.status='storage_failure';cases.push(s);}
 for(const snapshot of cases)assert.equal((await status(snapshot)).reloadSafe,false,JSON.stringify(snapshot));
 for(const phase of ['preparing','ready','applying'])assert.equal((await status(blocked(),phase)).reloadSafe,false,phase);
});

test('reload permission reads current delivery state after asynchronous update status resolves',async()=>{
 let snapshot={service:{status:'ready'},groups:[{id:'group',status:'paused'}],attempts:[]};
 let release,started;
 const waiting=new Promise(resolve=>{started=resolve;});
 const token='b'.repeat(64),app=createCentralApplication({manager:{snapshot:()=>structuredClone(snapshot)},bridgeToken:token,updates:{status:()=>{started();return new Promise(resolve=>{release=resolve;});}}});
 let result;
 try{
  const response=app.handler({method:'GET',url:'/api/bridge/status',headers:{host:'127.0.0.1:43127',authorization:`Bearer ${token}`}},{setHeader(){},writeHead(code){assert.equal(code,200);},end(text){result=JSON.parse(text);}});
  await waiting;
  snapshot={service:{status:'ready'},groups:[{id:'group',status:'running',activeAttemptId:'attempt'}],attempts:[{id:'attempt',groupId:'group',status:'preparing'}]};
  release({phase:'idle'});await response;
  assert.equal(result.reloadSafe,false);assert.equal(result.busy,true);
 }finally{await app.close();}
});
