import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {createSupportDelivery} from '../central/runtime/support-delivery.mjs';
import {createSupportReport} from '../central/runtime/support-report.mjs';

const url='https://script.google.com/macros/s/test-deployment/exec',key='a'.repeat(40);
const sample=()=>({serverNow:1800000000000,retainedFrom:0,service:{status:'ready'},settings:{},instances:[],accounts:[],targets:[],channels:[],groups:[],locks:[],attempts:[],commands:[],events:[],incidents:[],intervals:[]});
function relay(){
 const props={REPORT_KEY:key},sent=[];
 const properties={getProperty:k=>props[k],setProperty:(k,v)=>{props[k]=v;},getProperties:()=>({...props}),deleteProperty:k=>{delete props[k];}};
 let reject=false;
 const context={ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({setMimeType:()=>JSON.parse(text)})},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},PropertiesService:{getScriptProperties:()=>properties},Utilities:{getUuid:()=>crypto.randomUUID(),newBlob:(text,type,name)=>({text,type,name})},MailApp:{getRemainingDailyQuota:()=>100,sendEmail:options=>{if(reject)throw Error('ambiguous provider failure');sent.push(options);}}};
 const post=runInNewContext(readFileSync(new URL('../mail-relay/Central.gs',import.meta.url),'utf8')+'\ndoPost',context);
 return {sent,props,post:body=>post({postData:{contents:JSON.stringify(body)}}),reject:()=>{reject=true;}};
}
function sender(t,fetchImpl,options={}){
 const dir=mkdtempSync(join(tmpdir(),'dico-email-'));
 const delivery=createSupportDelivery({dir,fetchImpl,createReport:opts=>createSupportReport({manager:{supportData:sample},appVersion:'test',...opts}),...options});
 t.after(async()=>{await delivery.close();rmSync(dir,{recursive:true,force:true});});
 delivery.configure({enabled:true,autoSend:true,receiverUrl:url,reporterToken:key});return delivery;
}
test('central automatic incident reaches fixed email recipient and duplicate receipt does not send twice',async t=>{
 const server=relay();let calls=0;
 const delivery=sender(t,async(target,init)=>{
  calls++;assert.equal(target,url);assert.equal(init.redirect,'manual');assert.equal(init.headers.authorization,undefined);
  const body=JSON.parse(init.body);assert.equal(body.key,key);
  const result=server.post({...body,to:'attacker@example.com'});
  if(calls===1)throw Error('lost receipt');
  return Response.json(result);
 });
 await delivery.queue({automatic:true,incidentId:'same-incident'});await delivery.flush();
 assert.equal(delivery.status().counts.failed,1);assert.equal(server.sent.length,1);
 await delivery.flush({force:true});assert.equal(delivery.status().counts.sent,1);assert.equal(server.sent.length,1);
 assert.equal(server.sent[0].to,'didlsdydgh@gmail.com');assert.match(server.sent[0].attachments[0].name,/\.json$/);
});
test('Apps Script response redirect is read with GET without resending report or key',async t=>{
 let calls=0;let reportId;
 const delivery=sender(t,async(target,init)=>{
  calls++;
  if(calls===1){reportId=JSON.parse(init.body).report.reportId;return new Response(null,{status:302,headers:{location:'https://script.googleusercontent.com/macros/echo?receipt=abc'}});}
  assert.equal(target,'https://script.googleusercontent.com/macros/echo?receipt=abc');assert.equal(init.method,'GET');assert.equal(init.body,undefined);assert.equal(init.headers?.authorization,undefined);
  return Response.json({reportId,receiptId:'email-1',receivedAt:1800000000000});
 });
 await delivery.queue({automatic:true});await delivery.flush();assert.equal(delivery.status().counts.sent,1);assert.equal(calls,2);
});
test('email response cannot redirect to an unrelated host',async t=>{
 let calls=0;const delivery=sender(t,async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://attacker.example/steal'}});});
 await delivery.queue({automatic:true});await delivery.flush();assert.equal(calls,1);assert.equal(delivery.status().counts.failed,1);
});
test('old email reports stop retrying before relay dedup receipts can expire, including forced flush',async t=>{
 let clock=1800000000000,calls=0;
 const delivery=sender(t,async()=>{calls++;throw Error('lost receipt');},{now:()=>clock});
 await delivery.queue({automatic:true});await delivery.flush();assert.equal(calls,1);
 clock+=30*86400000;
 await delivery.flush({force:true});await delivery.flush({force:true});
 assert.equal(calls,1);assert.equal(delivery.status().counts.sent,0);assert.equal(delivery.status().outbox[0].nextAttemptAt,null);
 assert.match(delivery.status().outbox[0].lastError,/30일/);
});
test('relay refuses invalid auth, malformed reports, over-quota mail and ambiguous sends',async()=>{
 const server=relay(),report=await createSupportReport({manager:{supportData:sample},appVersion:'test'});
 assert.equal(server.post({key:'wrong',report}).ok,false);assert.equal(server.post({key,report:{reportId:'bad'}}).ok,false);assert.equal(server.sent.length,0);
 server.props.REPORT_BUDGET=JSON.stringify({day:new Date().toISOString().slice(0,10),count:20});
 assert.equal(server.post({key,report}).ok,false);assert.equal(server.sent.length,0);
 delete server.props.REPORT_BUDGET;server.reject();
 assert.equal(server.post({key,report}).ok,false);assert.equal(server.post({key,report}).ok,false);assert.equal(server.sent.length,0);
});

test('email relay rejection codes are surfaced instead of a generic network error',async t=>{
 for(const code of ['UNAUTHORIZED','QUOTA','DELIVERY_UNCERTAIN','BUSY','INVALID','RATE_LIMIT','DISABLED','STORAGE_LIMIT']){
  const delivery=sender(t,async()=>Response.json({ok:false,code}));await delivery.queue();await delivery.flush();
  const item=delivery.status().outbox[0];assert.equal(item.status,'failed');assert.match(item.lastError,new RegExp(code));assert.notEqual(item.receiptId,undefined);
 }
});
