import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createSupportDelivery} from '../central/runtime/support-delivery.mjs';

const at=1800000000000;
const report=()=>({format:'dico-support-report',schemaVersion:1,reportId:'report-1',createdAt:at,privacy:{includeBodies:true,includeNames:true},runtime:{},selection:{},configuration:{instances:[{id:'browser',name:'PRIVATE NAME'}],accounts:[],targets:[],channels:[],groups:[]},attempts:[{id:'attempt',status:'unknown',body:'PRIVATE BODY'}],commands:[],events:[{type:'connection.failed',at,error:{message:'Cookie: PRIVATE COOKIE',detail:'password=PRIVATE PASSWORD'},description:'Bearer PRIVATE TOKEN'}],incidents:[],timeline:[]});
function fixture(t,options={}){
 const dir=mkdtempSync(join(tmpdir(),'support-reliability-'));
 const delivery=createSupportDelivery({dir,createReport:async()=>report(),now:()=>at,...options});
 t.after(async()=>{await delivery.close();rmSync(dir,{recursive:true,force:true});});
 return {delivery,dir};
}
test('자동 제보 수집 실패도 재시작 후 같은 사건을 자동 수집·전송한다',async t=>{
 const {delivery,dir}=fixture(t,{createReport:async()=>{throw Error('temporary read failure');}});
 delivery.configure({enabled:true,autoSend:true,receiverUrl:'https://receiver.example/report',reporterToken:'x'.repeat(32)});
 await delivery.queue({automatic:true,incidentId:'collection-failed'}).catch(()=>{});await delivery.close();
 let sent=0;
 const restarted=createSupportDelivery({dir,createReport:async()=>report(),now:()=>at+60000,fetchImpl:async(url,options)=>{
  sent++;const payload=JSON.parse(options.body);return Response.json({reportId:payload.reportId,receiptId:'collection-recovered',receivedAt:at+60000});
 }});t.after(()=>restarted.close());
 await restarted.flush();assert.equal(sent,1);assert.equal(restarted.status().counts.sent,1);
 assert.equal(restarted.status().outbox[0].incidentId,'collection-failed');
});

test('먼저 시작한 수집이 느려도 뒤의 자동 사건 의도는 즉시 디스크에 남는다',async t=>{
 let release,entered;const started=new Promise(resolve=>{entered=resolve;});let calls=0;
 const {delivery,dir}=fixture(t,{createReport:async()=>{calls++;if(calls===1){entered();await new Promise(resolve=>{release=resolve;});}return report();}});
 delivery.configure({enabled:true,autoSend:true});
 const first=delivery.queue({automatic:true,incidentId:'first'});await started;
 const second=delivery.queue({automatic:true,incidentId:'second'});
 const saved=JSON.parse(readFileSync(join(dir,'state.json'),'utf8'));
 // 실패한 구현에서도 정리 훅이 멈추지 않도록 대기 작업을 먼저 풀어 줍니다.
 release();await Promise.all([first,second]);
 assert.deepEqual(saved.collections.map(c=>c.incidentId),['first','second']);
});

test('기본 자동 제보는 오프라인 8회 이후에도 동일 보고서로 복구한다',async t=>{
 let calls=0;const ids=[];
 const {delivery}=fixture(t,{fetchImpl:async(url,options)=>{
  const payload=JSON.parse(options.body);ids.push(payload.reportId);calls++;
  if(calls<=8)throw Error('offline');return Response.json({reportId:payload.reportId,receiptId:'online-again',receivedAt:at});
 }});
 delivery.configure({enabled:true,autoSend:true,receiverUrl:'https://receiver.example/report',reporterToken:'x'.repeat(32)});
 await delivery.queue({automatic:true,incidentId:'long-offline'});
 for(let n=0;n<9;n++)await delivery.flush({force:true});
 assert.equal(calls,9);assert.equal(delivery.status().counts.sent,1);assert.equal(new Set(ids).size,1);
});

test('구형 8회 소진 제보는 현재 동의가 유지된 재시작에서 다시 전송한다',async t=>{
 const {delivery,dir}=fixture(t,{maxAttempts:8,fetchImpl:async()=>{throw Error('offline');}});
 delivery.configure({enabled:true,autoSend:true,receiverUrl:'https://receiver.example/report',reporterToken:'x'.repeat(32)});
 const item=await delivery.queue({automatic:true,incidentId:'old-budget'});
 for(let n=0;n<8;n++)await delivery.flush({force:true});assert.equal(delivery.status().outbox[0].nextAttemptAt,null);await delivery.close();
 const restarted=createSupportDelivery({dir,createReport:async()=>report(),now:()=>at+60000,fetchImpl:async(url,options)=>{
  const r=JSON.parse(options.body);assert.equal(r.reportId,item.reportId);return Response.json({reportId:r.reportId,receiptId:'migrated',receivedAt:at+60000});
 }});t.after(()=>restarted.close());
 await restarted.flush();assert.equal(restarted.status().counts.sent,1);assert.equal(restarted.status().outbox[0].attempts,9);
});
test('automatic reports exclude bodies, names and arbitrary error text even when manual sharing is enabled',async t=>{
 const {delivery,dir}=fixture(t);
 delivery.configure({enabled:true,autoSend:true,includeBodies:true,includeNames:true});
 const item=await delivery.queue({automatic:true,userDescription:'PRIVATE DESCRIPTION'});
 const stored=JSON.parse(readFileSync(join(dir,'outbox',`${item.id}.json`),'utf8'));
 assert.equal(stored.privacy.includeBodies,false);
 assert.equal(stored.privacy.includeNames,false);
 assert.doesNotMatch(JSON.stringify(stored),/PRIVATE/);
 assert.equal(stored.events[0].type,'connection.failed');
});
test('a transport ignoring abort cannot stall flush or close forever',async t=>{
 let release;
 const {delivery}=fixture(t,{timeoutMs:20,fetchImpl:()=>new Promise(resolve=>{release=resolve;})});
 delivery.configure({enabled:true,receiverUrl:'https://receiver.example/report',reporterToken:'x'.repeat(32)});
 await delivery.queue();
 const flush=delivery.flush();
 const completed=await Promise.race([flush.then(()=>true),delay(150).then(()=>false)]);
 // 실패 구현에서도 정리 훅이 멈추지 않도록 가짜 전송을 풀어 준다.
 release(new Response('{}',{status:503}));await flush;
 assert.equal(completed,true);
 assert.equal(delivery.status().counts.failed,1);
});
test('restart completes an interrupted durable queue transaction once',async t=>{
 const {delivery,dir}=fixture(t);delivery.configure({enabled:true,autoSend:true});await delivery.close();
 const item={id:'queued-item',reportId:'report-1',automatic:true,incidentId:'incident-1',createdAt:at,status:'queued',attempts:0,nextAttemptAt:at,lastError:null,receiptId:null,sentAt:null};
 writeFileSync(join(dir,'pending-queue.json'),JSON.stringify({item,report:report()}));
 const restarted=createSupportDelivery({dir,createReport:async()=>report(),now:()=>at});t.after(()=>restarted.close());
 assert.equal(restarted.status().counts.queued,1);
 assert.equal(existsSync(join(dir,'outbox','queued-item.json')),true);
 assert.equal(existsSync(join(dir,'pending-queue.json')),false);
 const duplicate=await restarted.queue({automatic:true,incidentId:'incident-1'});
 assert.equal(duplicate.id,item.id);
});

test('offline automatic reports survive restart and send only redacted payloads with a validated receipt',async t=>{
 let calls=0;
 const {delivery,dir}=fixture(t,{fetchImpl:async()=>{calls++;throw Error('network unavailable');}});
 delivery.configure({enabled:true,autoSend:true,includeBodies:true,includeNames:true,receiverUrl:'https://receiver.example/report',reporterToken:'x'.repeat(32)});
 const queued=await delivery.queue({automatic:true,incidentId:'offline'});
 await delivery.flush();assert.equal(calls,1);assert.equal(delivery.status().counts.failed,1);await delivery.close();
 let payload;
 const restarted=createSupportDelivery({dir,createReport:async()=>report(),now:()=>at+60000,fetchImpl:async(url,options)=>{
  payload=JSON.parse(options.body);return Response.json({reportId:payload.reportId,receiptId:'receipt-1',receivedAt:at+60000});
 }});t.after(()=>restarted.close());
 await restarted.flush();assert.equal(restarted.status().counts.sent,1);
 assert.equal(payload.reportId,queued.reportId);assert.doesNotMatch(JSON.stringify(payload),/PRIVATE/);
});

test('an unresponsive receipt stream is bounded and a late receipt cannot mark a timeout as sent',async t=>{
 let push;
 const {delivery}=fixture(t,{timeoutMs:20,fetchImpl:async()=>new Response(new ReadableStream({start(controller){push=controller;}}))});
 delivery.configure({enabled:true,receiverUrl:'https://receiver.example/report',reporterToken:'x'.repeat(32)});
 await delivery.queue();
 const flush=delivery.flush();
 const completed=await Promise.race([flush.then(()=>true),delay(150).then(()=>false)]);
 push.enqueue(new TextEncoder().encode(JSON.stringify({reportId:'report-1',receiptId:'late-receipt',receivedAt:at})));push.close();await flush;await delay(0);
 assert.equal(completed,true);assert.equal(delivery.status().counts.sent,0);assert.equal(delivery.status().counts.failed,1);
});

for(const receiverUrl of ['https://receiver.example/report','https://script.google.com/macros/s/test-relay/exec']){
 test(`retry budget persists and forced flush cannot revive terminal failures: ${receiverUrl}`,async t=>{
  let calls=0;
  const fetchImpl=async()=>{calls++;throw Error('offline');};
  const {delivery,dir}=fixture(t,{maxAttempts:2,fetchImpl});
  delivery.configure({enabled:true,autoSend:true,receiverUrl,reporterToken:'x'.repeat(32)});
  await delivery.queue({automatic:true});await delivery.flush();
  assert.equal(calls,1);assert.notEqual(delivery.status().outbox[0].nextAttemptAt,null);
  await delivery.flush();assert.equal(calls,1);
  await delivery.flush({force:true});
  assert.equal(calls,2);assert.equal(delivery.status().outbox[0].nextAttemptAt,null);
  await delivery.flush({force:true});assert.equal(calls,2);await delivery.close();
  const restarted=createSupportDelivery({dir,createReport:async()=>report(),now:()=>at+10000000,maxAttempts:2,fetchImpl});t.after(()=>restarted.close());
  await restarted.flush();await restarted.flush({force:true});
  assert.equal(calls,2);assert.equal(restarted.status().counts.failed,1);
  assert.match(restarted.status().outbox[0].lastError,/2회/);
 });
}

test('legacy incident reports without an automatic marker are redacted before retry',async t=>{
 const {delivery,dir}=fixture(t);delivery.configure({enabled:true,autoSend:true,includeBodies:true,includeNames:true,receiverUrl:'https://receiver.example/report',reporterToken:'x'.repeat(32)});
 const item=await delivery.queue({incidentId:'legacy-incident'});await delivery.close();
 const path=join(dir,'state.json'),state=JSON.parse(readFileSync(path,'utf8'));delete state.outbox[0].automatic;writeFileSync(path,JSON.stringify(state));
 writeFileSync(join(dir,'outbox',`${item.id}.json`),JSON.stringify(report()));
 let payload;
 const restarted=createSupportDelivery({dir,createReport:async()=>report(),now:()=>at,fetchImpl:async(url,options)=>{
  payload=JSON.parse(options.body);return Response.json({reportId:payload.reportId,receiptId:'receipt-legacy',receivedAt:at});
 }});t.after(()=>restarted.close());
 await restarted.flush();assert.equal(restarted.status().counts.sent,1);
 assert.doesNotMatch(JSON.stringify(payload),/PRIVATE/);assert.equal(payload.privacy.includeBodies,false);
});

test('revoked automatic consent pauses queued reports while manual reports remain deliverable',async t=>{
 let calls=0;
 const {delivery}=fixture(t,{fetchImpl:async(url,options)=>{calls++;const payload=JSON.parse(options.body);return Response.json({reportId:payload.reportId,receiptId:`receipt-${calls}`,receivedAt:at});}});
 delivery.configure({enabled:true,autoSend:true,receiverUrl:'https://receiver.example/report',reporterToken:'x'.repeat(32)});
 const automatic=await delivery.queue({automatic:true});const manual=await delivery.queue();
 delivery.configure({autoSend:false});await delivery.flush({force:true});
 assert.equal(calls,1);
 assert.equal(delivery.status().outbox.find(item=>item.id===manual.id).status,'sent');
 assert.equal(delivery.status().outbox.find(item=>item.id===automatic.id).attempts,0);
 delivery.configure({autoSend:true});await delivery.flush();assert.equal(calls,2);
});

test('revoking automatic consent aborts an in-flight automatic send and ignores its late receipt',async t=>{
 let release,arrive,signal;
 const arrived=new Promise(resolve=>{arrive=resolve;});
 const {delivery}=fixture(t,{fetchImpl:(url,options)=>{signal=options.signal;arrive();return new Promise(resolve=>{release=resolve;});}});
 delivery.configure({enabled:true,autoSend:true,receiverUrl:'https://receiver.example/report',reporterToken:'x'.repeat(32)});
 await delivery.queue({automatic:true});const flushing=delivery.flush();await arrived;
 delivery.configure({autoSend:false});const aborted=signal.aborted;
 release(Response.json({reportId:'report-1',receiptId:'late-receipt',receivedAt:at}));await flushing;
 assert.equal(aborted,true);assert.equal(delivery.status().counts.sent,0);
 await delivery.flush({force:true});assert.equal(delivery.status().outbox[0].attempts,1);
});
