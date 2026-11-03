import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync,statSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSupportReport} from '../central/runtime/support-report.mjs';
import {createSupportDelivery} from '../central/runtime/support-delivery.mjs';

const epoch=1_800_000_000_000;
const sample=()=>({serverNow:epoch,retainedFrom:0,service:{status:'ready'},settings:{},instances:[{id:'browser',name:'PRIVATE NAME',connected:true,lastSeenAt:epoch,bridgeToken:'NEVER-PLATFORM-SECRET'}],accounts:[],targets:[],channels:[],groups:[],locks:[],attempts:[{id:'attempt',status:'unknown',createdAt:epoch,body:'PRIVATE BODY',permitId:'NEVER-PERMIT'}],commands:[],events:[],incidents:[],intervals:[]});
function fixture(t,options={}){
 const dir=mkdtempSync(join(tmpdir(),'dico-delivery-'));
 const createReport=options.createReport||((opts)=>createSupportReport({manager:{supportData:sample},appVersion:'test',now:()=>epoch,...opts}));
 const delivery=createSupportDelivery({dir,createReport,now:()=>epoch,...options});
 t.after(async()=>{await delivery.close();rmSync(dir,{recursive:true,force:true});});
 return {delivery,dir,createReport};
}
async function receiverServer(t,receiver,{failures=0,dropReceipt=false}={}){
 let calls=0,fail=failures,drop=dropReceipt;
 const server=http.createServer(async(req,res)=>{
  calls++;try{
   if(fail-->0){res.writeHead(503);res.end('private backend details');return;}
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const result=await receiver.receive(JSON.parse(Buffer.concat(chunks).toString()),req.headers.authorization);
   if(drop){drop=false;res.destroy();return;}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  }catch(error){res.writeHead(error.status||500);res.end(JSON.stringify({error:error.code}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 return {url:`http://127.0.0.1:${server.address().port}/api/support/receive`,calls:()=>calls};
}

test('disabled automatic reporting never creates or sends a report; enabled without a destination queues honestly',async t=>{
 const {delivery}=fixture(t);
 assert.equal(await delivery.queue({automatic:true,incidentId:'incident'}),null);
 assert.equal(delivery.status().counts.queued,0);
 await assert.rejects(()=>delivery.queue(),{status:409});
 delivery.configure({enabled:true,autoSend:true});
 const queued=await delivery.queue({automatic:true,incidentId:'incident'});
 await delivery.flush();
 assert.equal(queued.status,'queued');assert.equal(delivery.status().configured,false);
 assert.equal(delivery.status().counts.queued,1);assert.equal(delivery.status().outbox[0].attempts,0);
});

test('real HTTP transfer uses dedicated pairing credential, strips private report data and saves server receipt',async t=>{
 const {delivery:receiver,dir}=fixture(t);receiver.configure({receiverEnabled:true});
 const key=receiver.receiverKey().token,server=await receiverServer(t,receiver);
 const {delivery:sender}=fixture(t);sender.configure({enabled:true,autoSend:true,receiverUrl:server.url,reporterToken:key});
 const item=await sender.queue({incidentId:'incident',automatic:true});await sender.flush();
 assert.equal(server.calls(),1);assert.equal(sender.status().outbox[0].status,'sent');
 const inbox=receiver.inbox();assert.equal(inbox.length,1);assert.equal(inbox[0].reportId,item.reportId);
 assert.equal(sender.status().outbox[0].receiptId,inbox[0].receiptId);
 const imported=receiver.get(inbox[0].receiptId);assert.equal(imported.report.attempts[0].id,'attempt');
 assert.doesNotMatch(JSON.stringify(imported),/PRIVATE BODY|PRIVATE NAME|NEVER-/);
 assert.doesNotMatch(JSON.stringify(sender.status()),new RegExp(key));assert.doesNotMatch(JSON.stringify(receiver.status()),new RegExp(key));
 assert.equal(statSync(join(dir,'credentials.json')).mode&0o077,0);
});

test('persistent retry and incident dedup survive process restart and receiver dedup survives lost acknowledgment',async t=>{
 let clock=epoch;
 const {delivery:receiver}=fixture(t);receiver.configure({receiverEnabled:true});const server=await receiverServer(t,receiver,{failures:1,dropReceipt:true});
 const {delivery:sender,dir,createReport}=fixture(t,{now:()=>clock,retryBaseMs:100});sender.configure({enabled:true,autoSend:true,receiverUrl:server.url,reporterToken:receiver.receiverKey().token});
 const first=await sender.queue({automatic:true,incidentId:'incident'});await sender.flush();
 assert.equal(sender.status().outbox[0].status,'failed');assert.equal(server.calls(),1);
 const duplicate=await sender.queue({automatic:true,incidentId:'incident'});assert.equal(duplicate.reportId,first.reportId);assert.equal(sender.status().outbox.length,1);
 await sender.close();const restarted=createSupportDelivery({dir,createReport,now:()=>clock,retryBaseMs:100});t.after(()=>restarted.close());
 await restarted.flush();assert.equal(server.calls(),1);clock+=101;await restarted.flush();assert.equal(receiver.inbox().length,1);assert.equal(restarted.status().counts.failed,1);
 clock+=201;await restarted.flush();assert.equal(server.calls(),3);assert.equal(receiver.inbox().length,1);assert.equal(restarted.status().counts.sent,1);
 const restoredReceiver=createSupportDelivery({dir:receiver.directory,createReport});t.after(()=>restoredReceiver.close());assert.equal(restoredReceiver.inbox().length,1);
});

test('receiver defaults off, rejects missing or wrong bearer, and never accepts malformed reports',async t=>{
 const {delivery,createReport}=fixture(t),report=await createReport({includeBodies:false,includeNames:false});
 await assert.rejects(()=>delivery.receive(report,`Bearer ${delivery.receiverKey().token}`),{status:403});
 delivery.configure({receiverEnabled:true});
 for(const authorization of [undefined,'Bearer wrong','Basic abc'])await assert.rejects(()=>delivery.receive(report,authorization),{status:401});
 await assert.rejects(()=>delivery.receive({reportId:'not-valid'},`Bearer ${delivery.receiverKey().token}`),{status:400});
 assert.equal(delivery.inbox().length,0);
});

test('settings validate transport, avoid credential URLs and clear destination credential when destination changes',t=>{
 const {delivery}=fixture(t);
 for(const receiverUrl of ['http://public.example/api','https://user:password@example.com/api','file:///tmp/report','https://example.com/api?token=secret','https://example.com/api#token'])assert.throws(()=>delivery.configure({receiverUrl}),{status:400});
 delivery.configure({receiverUrl:'http://192.168.1.5:43128/api/support/receive',reporterToken:'x'.repeat(40)});assert.ok(delivery.status().transportWarning);
 assert.equal(delivery.status().hasReporterToken,true);delivery.configure({receiverUrl:'https://receiver.example/api/support/receive'});assert.equal(delivery.status().hasReporterToken,false);
 for(const patch of [{enabled:'true'},{retentionDays:0},{retentionDays:366},{reporterToken:'bad\nheader'}])assert.throws(()=>delivery.configure(patch),{status:400});
});

test('retention never deletes unsent evidence and only expires completed deliveries and old inbox records',async t=>{
 let clock=epoch;const {delivery:receiver}=fixture(t,{now:()=>clock});receiver.configure({receiverEnabled:true,retentionDays:1});const server=await receiverServer(t,receiver);
 const {delivery:sender}=fixture(t,{now:()=>clock});sender.configure({enabled:true,retentionDays:1,receiverUrl:server.url,reporterToken:receiver.receiverKey().token});
 await sender.queue({incidentId:'sent'});await sender.flush();sender.configure({receiverUrl:''});await sender.queue({incidentId:'unsent'});
 clock+=2*86400000;sender.prune();receiver.prune();assert.equal(sender.status().outbox.length,1);assert.equal(sender.status().outbox[0].incidentId,'unsent');assert.equal(receiver.inbox().length,0);
});

test('parallel queues deduplicate the same incident and pause prevents pending transmission',async t=>{
 const {delivery:receiver}=fixture(t);receiver.configure({receiverEnabled:true});const server=await receiverServer(t,receiver);
 const {delivery}=fixture(t);delivery.configure({enabled:true,autoSend:true,receiverUrl:server.url,reporterToken:receiver.receiverKey().token});
 const entries=await Promise.all(Array.from({length:5},()=>delivery.queue({automatic:true,incidentId:'same'})));assert.equal(new Set(entries.map(e=>e.reportId)).size,1);
 delivery.configure({enabled:false});await delivery.flush({force:true});assert.equal(server.calls(),0);assert.equal(delivery.status().outbox.length,1);
});

test('manual privacy choices can exclude data but cannot exceed the saved inclusion consent',async t=>{
 const {delivery}=fixture(t);delivery.configure({enabled:true,includeBodies:true,includeNames:true});
 const first=await delivery.queue({includeBodies:false,includeNames:false});
 const {readFileSync}=await import('node:fs');
 const exported=id=>JSON.parse(readFileSync(join(delivery.directory,'outbox',id+'.json'),'utf8'));
 assert.equal(exported(first.id).attempts[0].body,undefined);assert.equal(exported(first.id).configuration.instances[0].name,undefined);
 delivery.configure({includeBodies:false,includeNames:false});
 const second=await delivery.queue({includeBodies:true,includeNames:true});assert.equal(exported(second.id).attempts[0].body,undefined);
 await assert.rejects(()=>delivery.queue({includeBodies:'true'}),{status:400});
});

test('background sender delivers queued reports without a manual flush',async t=>{
 const {delivery:receiver}=fixture(t);receiver.configure({receiverEnabled:true});const server=await receiverServer(t,receiver);
 const {delivery}=fixture(t,{pollMs:10});delivery.configure({enabled:true,autoSend:true,receiverUrl:server.url,reporterToken:receiver.receiverKey().token});delivery.start();
 await delivery.queue({automatic:true,incidentId:'background'});
 const deadline=Date.now()+2000;while(delivery.status().counts.sent===0&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(delivery.status().counts.sent,1);assert.equal(receiver.inbox().length,1);
});

test('sender bounds response time and rejects redirects without forwarding its credential',async t=>{
 let redirected=0;const sink=http.createServer((req,res)=>{redirected++;res.end('{}');});await new Promise(resolve=>sink.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{sink.close(resolve);sink.closeAllConnections();}));
 let mode='timeout';const server=http.createServer((req,res)=>{if(mode==='redirect'){res.writeHead(302,{location:`http://127.0.0.1:${sink.address().port}/`});res.end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const {delivery}=fixture(t,{timeoutMs:40});delivery.configure({enabled:true,receiverUrl:`http://127.0.0.1:${server.address().port}/`,reporterToken:'x'.repeat(64)});
 await delivery.queue();await delivery.flush();assert.equal(delivery.status().counts.failed,1);assert.equal(delivery.status().outbox[0].attempts,1);
 mode='redirect';await delivery.flush({force:true});assert.equal(delivery.status().counts.failed,1);assert.equal(delivery.status().outbox[0].attempts,2);assert.equal(redirected,0);
});

test('privacy revoked while report creation is awaiting is removed before the report reaches disk',async t=>{
 let release,started;const ready=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const {delivery}=fixture(t,{createReport:async options=>{const report=await createSupportReport({manager:{supportData:sample},...options});started();await gate;return report;}});
 delivery.configure({enabled:true,autoSend:true,includeBodies:true,includeNames:true});
 const pending=delivery.queue({automatic:true,incidentId:'revoked-during-create'});await ready;
 delivery.configure({includeBodies:false,includeNames:false});release();const item=await pending;
 const stored=JSON.parse(readFileSync(join(delivery.directory,'outbox',item.id+'.json'),'utf8'));
 assert.equal(stored.privacy.includeBodies,false);assert.equal(stored.privacy.includeNames,false);assert.doesNotMatch(JSON.stringify(stored),/PRIVATE BODY|PRIVATE NAME|NEVER-/);
});

test('revoking inclusion removes queued data permanently before a later HTTP send, including after restart',async t=>{
 const {delivery:receiver}=fixture(t);receiver.configure({receiverEnabled:true});const server=await receiverServer(t,receiver);
 const {delivery,dir,createReport}=fixture(t);delivery.configure({enabled:true,includeBodies:true,includeNames:true,receiverUrl:server.url,reporterToken:receiver.receiverKey().token});
 const item=await delivery.queue();delivery.configure({includeBodies:false,includeNames:false});
 const stored=JSON.parse(readFileSync(join(dir,'outbox',item.id+'.json'),'utf8'));assert.doesNotMatch(JSON.stringify(stored),/PRIVATE BODY|PRIVATE NAME|NEVER-/);assert.equal(stored.privacy.includeBodies,false);
 delivery.configure({includeBodies:true,includeNames:true});await delivery.close();const restarted=createSupportDelivery({dir,createReport,now:()=>epoch});t.after(()=>restarted.close());await restarted.flush();
 const received=receiver.get(receiver.inbox()[0].receiptId).report;assert.equal(received.privacy.includeBodies,false);assert.equal(received.privacy.includeNames,false);assert.doesNotMatch(JSON.stringify(received),/PRIVATE BODY|PRIVATE NAME|NEVER-/);
});

test('revoking transmission while report creation awaits prevents queuing or sending',async t=>{
 let release,started;const ready=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const {delivery:receiver}=fixture(t);receiver.configure({receiverEnabled:true});const server=await receiverServer(t,receiver);
 const {delivery}=fixture(t,{createReport:async options=>{const report=await createSupportReport({manager:{supportData:sample},...options});started();await gate;return report;}});
 delivery.configure({enabled:true,autoSend:true,receiverUrl:server.url,reporterToken:receiver.receiverKey().token});const pending=delivery.queue({automatic:true});await ready;delivery.configure({enabled:false});release();
 assert.equal(await pending,null);await delivery.flush({force:true});assert.equal(server.calls(),0);assert.equal(delivery.status().outbox.length,0);
});

test('lowering privacy aborts an in-flight HTTP request and retries only the redacted stored report',async t=>{
 let arrived;const ready=new Promise(resolve=>{arrived=resolve;}),payloads=[];
 const server=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const report=JSON.parse(Buffer.concat(chunks));payloads.push(report);if(payloads.length===1){arrived();return;}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({receiptId:'receipt',reportId:report.reportId,receivedAt:epoch}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const {delivery}=fixture(t,{timeoutMs:2000});delivery.configure({enabled:true,includeBodies:true,includeNames:true,receiverUrl:`http://127.0.0.1:${server.address().port}/`,reporterToken:'x'.repeat(64)});await delivery.queue();const sending=delivery.flush();await ready;
 delivery.configure({includeBodies:false,includeNames:false});
 let deadline;try{await Promise.race([sending,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('privacy revocation did not abort the active request')),300);})]);}finally{clearTimeout(deadline);}
 assert.equal(delivery.status().counts.failed,1);await delivery.flush({force:true});assert.equal(delivery.status().counts.sent,1);assert.equal(payloads.length,2);assert.doesNotMatch(JSON.stringify(payloads[1]),/PRIVATE BODY|PRIVATE NAME|NEVER-/);assert.equal(payloads[1].privacy.includeBodies,false);
});

test('automatic update reports preserve diagnostic codes, omit message content and deduplicate jobs',async t=>{
 const {delivery,dir}=fixture(t);
 const options={automatic:true,incidentId:'update:'+('a'.repeat(32)),updateDiagnostic:{code:'PROCESS_BLOCKED',stage:'dependencies',signal:'SIGKILL',exitCode:1,retryCount:2}};
 assert.equal(await delivery.queue(options),null);
 delivery.configure({enabled:true,autoSend:true,includeBodies:true,includeNames:true});
 const item=await delivery.queue(options),again=await delivery.queue(options);
 assert.equal(item.id,again.id);assert.equal(delivery.status().outbox.length,1);
 const report=JSON.parse(readFileSync(join(dir,'outbox',item.id+'.json'),'utf8'));
 assert.equal(report.runtime.updateDiagnostic.code,'PROCESS_BLOCKED');
 assert.equal(report.runtime.updateDiagnostic.signal,'SIGKILL');
 assert.equal(report.runtime.updateDiagnostic.retryCount,2);
 assert.equal(JSON.stringify(report).includes('PRIVATE BODY'),false);
 assert.equal(JSON.stringify(report).includes('PRIVATE NAME'),false);
});
