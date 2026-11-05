import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createSupportReport,inspectSupportReport} from '../central/runtime/support-report.mjs';
import {relay,publicKey as key,privateKey} from './helpers/email-relay.js';
const sample=()=>({serverNow:Date.now(),retainedFrom:0,service:{},settings:{},instances:[],accounts:[],targets:[],channels:[],groups:[],locks:[],attempts:[],commands:[],events:[],incidents:[],intervals:[]});
const report=()=>createSupportReport({manager:{supportData:sample},includeBodies:false,includeNames:false});

test('public submissions cannot consume the reserved private-installation mail budget',async()=>{
 const s=relay(),r=await report();s.props.REPORT_TRUSTED_KEYS=JSON.stringify([privateKey]);
 for(let i=0;i<20;i++)s.post({key,report:{...r,reportId:randomUUID()}});
 assert.equal(s.sent.length,5);
 for(let i=0;i<15;i++)assert.ok(s.post({key:privateKey,report:{...r,reportId:randomUUID()}}).receiptId);
 const result=s.post({key:privateKey,report:{...r,reportId:randomUUID()}});
 assert.equal(result.code,'QUOTA');assert.ok(result.retryAfterMs>0);assert.equal(s.sent.length,20);
});
test('receipt is bound to report content and submitting key, while lost-response retry remains idempotent',async()=>{
 const s=relay(),r=await report();s.props.REPORT_TRUSTED_KEYS=JSON.stringify([privateKey]);
 const first=s.post({key,report:r});assert.equal(s.post({key,report:r}).receiptId,first.receiptId);
 assert.equal(s.post({key,report:{...r,events:[{type:'fake',at:Date.now()}]}}).code,'CONFLICT');
 assert.ok(s.post({key:privateKey,report:r}).receiptId);assert.equal(s.sent.length,2);
});
test('relay removes credential fields, enforces privacy flags and drops unknown report properties',async()=>{
 const s=relay(),r=await report();
 r.attempts=[{id:'a',status:'unknown',body:'PRIVATE BODY',name:'PRIVATE NAME',authorization:'PRIVATE AUTH'}];
 r.events=[{type:'error',at:Date.now(),detail:'Authorization: Bearer synthetic-sensitive-value'}];
 r.unknown='PRIVATE UNKNOWN';r.runtime.cookie='PRIVATE COOKIE';
 assert.ok(s.post({key,report:r}).receiptId);
 const attachment=s.sent[0].attachments[0].text;
 assert.doesNotMatch(attachment,/PRIVATE|synthetic-sensitive-value/);
 assert.equal(JSON.parse(attachment).privacy.credentialsExcluded,true);
});
test('client export and imported free text redact explicit credentials, including descriptions',async()=>{
 const r=await report();r.userDescription='Authorization: Bearer synthetic-sensitive-value';r.events=[{type:'error',at:Date.now(),message:'password=synthetic-password'}];
 assert.doesNotMatch(JSON.stringify(inspectSupportReport(r)),/synthetic-sensitive-value|synthetic-password/);
 const data=sample();data.events=[{type:'error',at:Date.now(),detail:'access_token=synthetic-export-value'}];
 assert.doesNotMatch(JSON.stringify(await createSupportReport({manager:{supportData:()=>data}})),/synthetic-export-value/);
});
test('invalid privacy, stale/future reports and malformed JSON do not spend quota or store receipts',async()=>{
 for(const change of [r=>{r.privacy={};},r=>{r.createdAt=0;},r=>{r.createdAt=Date.now()+86400000;},r=>{r.reportId='-'.repeat(36);},r=>{r.configuration=null;}]){
  const s=relay(),r=await report();change(r);assert.equal(s.post({key,report:r}).code,'INVALID');assert.equal(s.sent.length,0);assert.equal(Object.keys(s.props).length,1);
 }
 const s=relay();assert.equal(s.raw('{').code,'INVALID');assert.equal(s.post({key:'wrong',report:await report()}).code,'UNAUTHORIZED');
});
test('UTF-8 request size and deeply nested unknown data are rejected before mail',async()=>{
 const s=relay(),r=await report();r.extra='한'.repeat(6*1024*1024);
 assert.equal(s.post({key,report:r}).code,'INVALID');assert.equal(s.sent.length,0);
 delete r.extra;let cursor=r.extra={};for(let i=0;i<15;i++)cursor=cursor.extra={};
 assert.equal(s.post({key,report:r}).code,'INVALID');assert.equal(s.sent.length,0);
});
test('unbound legacy receipts never falsely acknowledge an attacker-supplied body',async()=>{
 const s=relay(),r=await report();s.props['RECEIPT_'+r.reportId]=JSON.stringify({at:s.now(),sent:true,receipt:{reportId:r.reportId,receiptId:randomUUID(),receivedAt:s.now()}});
 assert.equal(s.post({key,report:r}).code,'DELIVERY_UNCERTAIN');assert.equal(s.sent.length,0);
});
test('90 days of reserved-path receipts stay below Apps Script property storage limit',async()=>{
 const s=relay(),r=await report();s.props.REPORT_TRUSTED_KEYS=JSON.stringify([privateKey]);
 for(let day=0;day<91;day++){
  for(let i=0;i<20;i++)assert.ok(s.post({key:privateKey,report:{...r,createdAt:s.now(),reportId:randomUUID()}}).receiptId);
  s.advance(86400000);
 }
 const size=Object.entries(s.props).reduce((n,[k,v])=>n+Buffer.byteLength(k+v),0);
 assert.ok(size<400*1024,`property bytes: ${size}`);assert.equal(s.sent.length,1820);
});
test('storage pressure and ambiguous mail fail closed without duplicate sends',async()=>{
 const s=relay(),r=await report();s.props.OTHER='x'.repeat(400*1024);
 assert.equal(s.post({key,report:r}).code,'STORAGE');assert.equal(s.sent.length,0);
 delete s.props.OTHER;s.reject();assert.equal(s.post({key,report:r}).code,'DELIVERY_UNCERTAIN');assert.equal(s.post({key,report:r}).code,'DELIVERY_UNCERTAIN');assert.equal(s.sent.length,0);
});

test('normal report evidence survives relay filtering and consented Korean body stays intact',async()=>{
 const s=relay(),data=sample();
 data.attempts=[{id:'attempt-1',status:'confirmed',body:'정상 한글 본문',bodyAvailable:true,confirmationBasis:'composer_cleared'}];
 data.instances=[{id:'browser-1',name:'브라우저',connected:true}];
 data.events=[{type:'delivery.trace',at:Date.now(),data:{pageHidden:true,editorCount:2,status:'confirmed',contentVersion:'0.4.42',observedPath:'/channels/123/456'}}];
 const r=await createSupportReport({manager:{supportData:()=>data},includeBodies:true,includeNames:true});
 assert.ok(s.post({key,report:r,to:'evil@example.test',cc:'evil@example.test'}).receiptId);
 const received=JSON.parse(s.sent[0].attachments[0].text);
 assert.equal(s.sent[0].to,'didlsdydgh@gmail.com');assert.equal(s.sent[0].cc,undefined);
 for(const field of ['runtime','selection','configuration','attempts','commands','events','incidents','timeline','privacy'])assert.deepEqual(received[field],r[field]);
});
test('invalid authentication never acquires the busy submission lock; valid traffic retries BUSY',async()=>{
 const s=relay(),r=await report();s.busy(true);
 assert.equal(s.post({key:'wrong',report:r}).code,'UNAUTHORIZED');
 assert.equal(s.post({key,report:r}).code,'BUSY');assert.equal(s.sent.length,0);assert.equal(Object.keys(s.props).length,1);
 s.busy(false);assert.ok(s.post({key,report:r}).receiptId);
});
test('a public key cannot be promoted to trusted and old budget usage survives upgrade',async()=>{
 const s=relay(),r=await report();s.props.REPORT_TRUSTED_KEYS=JSON.stringify([key]);
 assert.equal(s.post({key,report:r}).code,'CONFIG');assert.equal(s.sent.length,0);
 delete s.props.REPORT_TRUSTED_KEYS;s.props.REPORT_BUDGET=JSON.stringify({day:new Date(s.now()).toISOString().slice(0,10),count:6});
 assert.equal(s.post({key,report:r}).code,'QUOTA');assert.equal(s.sent.length,0);
});
test('credential redaction remains idempotent across client, disk reinspection and relay',async()=>{
 const s=relay(),r=await report();r.userDescription='password="synthetic pw"; access_token=synthetic-value https://user:synthetic-pass@example.test';
 const first=inspectSupportReport(r).report,second=inspectSupportReport(first).report;
 assert.equal(first.userDescription,second.userDescription);
 assert.ok(s.post({key,report:first}).receiptId);
 const received=JSON.parse(s.sent[0].attachments[0].text);
 assert.equal(received.userDescription,first.userDescription);
 assert.doesNotMatch(received.userDescription,/synthetic/);
});

test('multi-cookie headers and escaped quoted credential values are fully redacted at both boundaries',async()=>{
 const texts=[
  'Cookie: SID=synthetic-first-cookie; HSID=synthetic-second-cookie; SSID=synthetic-third-cookie',
  'Set-Cookie: SID=synthetic-first-cookie; Path=/; Secure',
  JSON.stringify({password:'synthetic-first"synthetic-tail',note:'diagnostic'}),
  "password='synthetic-first\\'synthetic-tail'"
 ];
 for(const text of texts){
  const r=await report();r.userDescription=text;
  assert.doesNotMatch(inspectSupportReport(r).report.userDescription,/synthetic/);
  const s=relay();assert.ok(s.post({key,report:r}).receiptId);
  assert.doesNotMatch(s.sent[0].attachments[0].text,/synthetic/);
 }
});

test('upgrade compacts a full legacy receipt store without dropping duplicate tombstones',async()=>{
 const s=relay(),r=await report();s.props.REPORT_TRUSTED_KEYS=JSON.stringify([privateKey]);
 const ids=[];
 for(let i=0;i<1800;i++){
  const reportId=randomUUID();ids.push(reportId);
  s.props['RECEIPT_'+reportId]=JSON.stringify({at:s.now()-86400000,sent:true,receipt:{reportId,receiptId:randomUUID(),receivedAt:s.now()-86400000,delivery:'email'}});
 }
 assert.ok(s.post({key:privateKey,report:r}).receiptId);
 assert.equal(s.post({key,report:{...r,reportId:ids[0]}}).code,'DELIVERY_UNCERTAIN');
 assert.equal(s.sent.length,1);assert.equal(Object.keys(s.props).filter(k=>k.startsWith('RECEIPT_')).length,1800);
 assert.ok(Object.entries(s.props).reduce((n,[k,v])=>n+Buffer.byteLength(k+v),0)<400*1024);
});

test('long noncredential and repeated credential-word text cannot monopolize report filtering',()=>{
 const result=spawnSync(process.execPath,['--input-type=module','-e',`
  import {redactSupportText} from './central/core/support-redaction.js';
  for(const text of ['a'.repeat(100000),'a-'.repeat(50000),'token'.repeat(20000)])redactSupportText(text);
 `],{cwd:new URL('..',import.meta.url),timeout:3000});
 assert.equal(result.error,undefined);assert.equal(result.status,0);
});
