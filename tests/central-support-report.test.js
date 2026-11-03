import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCentralManager} from '../central/core/index.js';
import {CentralStore} from '../central/core/store.js';
import {createCentralApplication} from '../central/runtime/http.mjs';
import {createSupportReport,inspectSupportReport,SUPPORT_REPORT_MAX_BYTES} from '../central/runtime/support-report.mjs';

const at=1_800_000_000_000,origin='http://127.0.0.1:43127';
function data(){return{serverNow:at,retainedFrom:at-1000,service:{status:'ready',clockDiagnostic:{wallGapMs:10000,monoGapMs:1000,monotonicDeltaMs:1000,driftMs:9000,trigger:'clock_drift'}},settings:{maxSendRetries:3},instances:[{id:'i',name:'private alias',connected:false,lastSeenAt:at-20000,extensionVersion:'0.4.22',bridgeToken:'NEVER-EXPORT-BRIDGE',sessionId:'NEVER-EXPORT-SESSION'}],accounts:[],targets:[],channels:[{id:'c',instanceId:'i',channelId:'discord-channel',verified:true,configVersion:2,appliedVersion:1,effectiveIntervalMs:67000,cooldownCorrectionMs:4000,cooldownCalibratedAt:at}],groups:[{id:'g',name:'private group',status:'needs_review',members:['c','c2'],cursor:1,activeAttemptId:'a',waitReason:'delivery_unknown'}],locks:[{key:'account:123',groupId:'g'}],attempts:[{id:'a',status:'unknown',body:'원본\r\n본문 <script>window.bad=true</script>',bodyAvailable:true,createdAt:at-500,instanceId:'i',groupId:'g',sessionId:'NEVER-EXPORT-SESSION',permitId:'NEVER-EXPORT-PERMIT',deliveryEvidence:{phase:'commit',stage:'observe',enterAttempted:true,sameComposer:true,editorReacquired:true,failedSeen:true,retryCount:3},draftBackups:[{body:'NEVER-EXPORT-DRAFT'}]}],commands:[{id:'cmd',type:'PREPARE',payload:{attemptId:'a',body:'NEVER-EXPORT-COMMAND-DRAFT',permitId:'NEVER-EXPORT-PERMIT'}}],events:[{type:'delivery.trace',at:at-100,eventId:2,attemptId:'a',sequence:7,data:{status:'unknown',pageHidden:true,editorCount:1,draftLength:4,observedPath:'/channels/111/222',rawTextContext:'NEVER-EXPORT-RAW',sameComposer:true,editorReacquired:true,retryCount:3,bridgeToken:'NEVER-EXPORT-BRIDGE',cookie:'NEVER-EXPORT-COOKIE',body:'NEVER-EXPORT-TRACE-DRAFT',unexpected:'drop',payload:{body:'drop'}}},{type:'attempt.created',at:at-500,eventId:1,attemptId:'a'}],incidents:[],intervals:[{id:'span',scope:'group',targetId:'g',from:at-500,to:null,reason:'delivery_unknown'}]};}
const report=()=>createSupportReport({manager:{supportData:data},appVersion:'0.4.23',now:()=>at,to:at});
async function request(app,path,{method='GET',body,chunks,cookie,headers={}}={}){
 const req=Readable.from(chunks||(body===undefined?[]:[typeof body==='string'?body:JSON.stringify(body)]));req.method=method;req.url=path;req.headers={host:new URL(origin).host,...(body!==undefined||chunks?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...headers};
 return new Promise((resolve,reject)=>{const result={status:200,headers:{},body:''};const res={setHeader:(k,v)=>result.headers[k.toLowerCase()]=v,writeHead:s=>result.status=s,end:text=>{result.body+=text||'';resolve(result);},on(){}};Promise.resolve(app.handler(req,res)).catch(reject);});
}
async function login(app){const response=await request(app,'/api/session',{method:'POST',body:{token:app.issueBootstrap()},headers:{origin}});return{cookie:response.headers['set-cookie'].split(';')[0],headers:{origin,'x-dico-csrf':JSON.parse(response.body).csrfToken}};}

test('support report exports immutable bodies, ordered trace scalars and diagnostic context while excluding credentials and drafts',async()=>{
 const r=await report(),serialized=JSON.stringify(r);assert.equal(r.attempts[0].body,data().attempts[0].body);assert.deepEqual(r.events.map(e=>e.eventId),[1,2]);assert.deepEqual(r.events[1].data,{status:'unknown',pageHidden:true,editorCount:1,draftLength:4,observedPath:'/channels/111/222',sameComposer:true,editorReacquired:true,retryCount:3});assert.equal(r.events[1].sequence,7);assert.equal(r.configuration.channels[0].cooldownCorrectionMs,4000);assert.equal(r.configuration.service.clockDiagnostic.monotonicDeltaMs,1000);assert.equal(r.configuration.service.clockDiagnostic.driftMs,9000);assert.deepEqual(r.configuration.groups[0].members,['c','c2']);assert.match(r.runtime.coreBuildId,/^[a-f0-9]{64}$/);assert.equal(r.runtime.nodeVersion,process.version);assert.doesNotMatch(serialized,/NEVER-EXPORT|bridgeToken|sessionId|permitId|draftBackups|cookie/);assert.ok(r.checks.some(c=>c.code==='EXECUTION_NOT_BLOCKED'));assert.ok(r.checks.some(c=>c.code==='DISCORD_FAILURE_OBSERVED'));assert.ok(r.checks.some(c=>c.code==='EXTENSION_VERSION_MISMATCH'));assert.ok(r.checks.some(c=>c.code==='RETENTION_PARTIAL'));
});

test('privacy options remove body and display aliases without changing preserved-body availability',async()=>{
 const r=await createSupportReport({manager:{supportData:data},appVersion:'0.4.23',includeBodies:false,includeNames:false,to:at});assert.equal(r.attempts[0].body,undefined);assert.equal(r.attempts[0].bodyAvailable,true);assert.equal(r.configuration.groups[0].name,undefined);assert.equal(r.configuration.instances[0].name,undefined);assert.equal(r.configuration.channels[0].channelId,'discord-channel');assert.doesNotMatch(JSON.stringify(r),/private alias|private group|원본/);
});

test('inspector strips unknown and secret fields, recomputes findings, preserves escaped-as-text bodies and user descriptions',async()=>{
 const r=await report();r.userDescription='<img src=x onerror=alert(1)> 문제 설명';r.summary={attempts:999};r.checks=[{code:'FAKE_VERIFIED'}];r.runtime.authorization='NEVER-EXPORT';r.attempts[0].tokens=['NEVER-EXPORT'];r.unknownField='drop';
 const inspected=inspectSupportReport(JSON.parse(JSON.stringify(r)));assert.equal(inspected.report.userDescription,r.userDescription);assert.equal(inspected.report.attempts[0].body,r.attempts[0].body);assert.equal(inspected.summary.attempts,1);assert.equal(inspected.findings[0].code,'IMPORTED_REPORT_UNVERIFIED');assert.doesNotMatch(JSON.stringify(inspected),/NEVER-EXPORT|FAKE_VERIFIED|unknownField/);assert.equal(inspected.report.events[1].data.editorReacquired,true);
});

test('inspector rejects prototype keys, deep structures, array bombs, malformed scalar fields and oversized files',async()=>{
 const original=await report();
 const cases=[];
 const proto=JSON.parse(JSON.stringify(original));proto.extra=JSON.parse('{"__proto__":{"polluted":true}}');cases.push(proto);
 const deep=structuredClone(original);let cursor=deep.extra={};for(let i=0;i<15;i++)cursor=cursor.extra={};cases.push(deep);
 const bomb=structuredClone(original);bomb.extra=Array(50001).fill(null);cases.push(bomb);
 const malformed=structuredClone(original);malformed.configuration.groups=[[]];cases.push(malformed);
 const scalar=structuredClone(original);scalar.attempts[0].status={confirmed:true};cases.push(scalar);
 const badReason=structuredClone(original);badReason.attempts[0].reasonCode={message:'invalid'};cases.push(badReason);
 const timestamp=structuredClone(original);timestamp.events[0].at='yesterday';cases.push(timestamp);
 const nonfinite=structuredClone(original);nonfinite.extra=Infinity;cases.push(nonfinite);
 const description=structuredClone(original);description.userDescription='x'.repeat(4001);cases.push(description);
 const circular=structuredClone(original);circular.extra=circular;cases.push(circular);
 const getter=structuredClone(original);Object.defineProperty(getter,'extra',{enumerable:true,get(){throw Error('must not execute');}});cases.push(getter);
 for(const input of cases)assert.throws(()=>inspectSupportReport(input),error=>error.code==='SUPPORT_REPORT_INVALID');
 assert.equal({}.polluted,undefined);
 const large=structuredClone(original);large.extra=Array.from({length:180},()=> 'x'.repeat(99000));assert.throws(()=>inspectSupportReport(large),{status:413});
});

test('support export and inspect require authentication, inspect CSRF, validate query bounds and return an attachment only on request',async t=>{
 let reads=0;const app=createCentralApplication({manager:{supportData:()=>{reads++;return data();}},origin,bridgeToken:'b'.repeat(64),appVersion:'0.4.23',now:()=>at});t.after(()=>app.close());
 assert.equal((await request(app,'/api/support/report?download=true')).status,401);assert.equal((await request(app,'/api/support/inspect',{method:'POST',body:{report:await report()},headers:{origin}})).status,401);assert.equal(reads,0);
 const auth=await login(app);const exported=await request(app,'/api/support/report?download=true&includeBodies=false&includeNames=false',auth);assert.equal(exported.status,200);assert.match(exported.headers['content-disposition'],/^attachment; filename="dico-support-/);assert.equal(JSON.parse(exported.body).attempts[0].body,undefined);
 assert.equal((await request(app,'/api/support/report?from=nan',auth)).status,400);assert.equal((await request(app,'/api/support/report?includeBodies=maybe',auth)).status,400);assert.equal((await request(app,'/api/support/report?from=200&to=100',auth)).status,400);
 assert.equal((await request(app,'/api/support/inspect',{method:'POST',body:{report:await report()},cookie:auth.cookie,headers:{origin}})).status,403);
 assert.equal((await request(app,'/api/support/inspect',{method:'POST',body:{report:await report()},...auth})).status,200);
});

test('only support inspection accepts requests larger than 1MiB and rejects above 16MiB before parsing',async t=>{
 const app=createCentralApplication({manager:{supportData:data,execute:()=>({}),snapshot:()=>({})},origin,bridgeToken:'b'.repeat(64),now:()=>at});t.after(()=>app.close());const auth=await login(app),r=await report();
 r.events=Array.from({length:1200},(_,i)=>({type:'delivery.trace',at,eventId:i+1,data:{message:'x'.repeat(1000)}}));const payload={report:r};assert.ok(Buffer.byteLength(JSON.stringify(payload))>1024*1024);
 const response=await request(app,'/api/support/inspect',{method:'POST',body:payload,...auth});assert.equal(response.status,200,response.body.slice(0,200));assert.equal(JSON.parse(response.body).report.events.length,1200);
 assert.equal((await request(app,'/api/command',{method:'POST',body:payload,...auth})).status,413);
 assert.equal((await request(app,'/api/support/inspect',{method:'POST',body:' '.repeat(SUPPORT_REPORT_MAX_BYTES+1),...auth})).status,413);
});

test('report import preserves exact Korean UTF-8 bodies across HTTP chunk boundaries',async t=>{
 const app=createCentralApplication({manager:{supportData:data},origin,bridgeToken:'b'.repeat(64),now:()=>at});t.after(()=>app.close());const auth=await login(app),r=await report(),encoded=Buffer.from(JSON.stringify({report:r})),cut=encoded.indexOf(Buffer.from('원본'))+1;assert.ok(cut>1);
 const response=await request(app,'/api/support/inspect',{method:'POST',chunks:[encoded.subarray(0,cut),encoded.subarray(cut,cut+1),encoded.subarray(cut+1)],...auth});assert.equal(response.status,200);assert.equal(JSON.parse(response.body).report.attempts[0].body,r.attempts[0].body);
});

function retainedFixture(t){
 const directory=mkdtempSync(join(tmpdir(),'dico-support-retained-')),databasePath=join(directory,'state.sqlite');let manager=createCentralManager({databasePath,now:()=>at});manager.close();const store=new CentralStore(databasePath),state=store.read();state.stateVersion++;
 state.attempts=Array.from({length:1205},(_,i)=>({id:`a-${i}`,status:'not_sent',body:i===0?'':'original-attempt-'+i,createdAt:at-5000+i,finalizedAt:at-5000+i,groupId:'group',instanceId:'instance',sessionId:'NEVER-EXPORT-SESSION',permitId:'NEVER-EXPORT-PERMIT'}));
 state.attempts[1].pruned=true;delete state.attempts[1].body;state.attempts[2].status='unknown';state.attempts[2].createdAt=at-100000;state.groups=[{id:'group',name:'retained',status:'needs_review',version:1,members:[],cursor:0,activeAttemptId:'a-2'}];
 state.commands=[{id:'context-old',instanceId:'instance',status:'applied',type:'CONFIG_SYNC',createdAt:at-1000,payload:{groupId:'group'}},{id:'context-current',instanceId:'instance',status:'applied',type:'CONFIG_SYNC',createdAt:at-10,payload:{groupId:'group'}},{id:'attempt-command',instanceId:'instance',status:'applied',type:'PREPARE',createdAt:at-1000,payload:{attemptId:'a-10'}}];
 store.commit(state,state.attempts.flatMap((a,i)=>[{type:'attempt.created',at:a.createdAt,attemptId:a.id,groupId:a.groupId},{type:'delivery.trace',at:a.createdAt+1,attemptId:a.id,sequence:i,data:{stage:'observe',retryCount:i%4,editorReacquired:true}}]));store.close();manager=createCentralManager({databasePath,now:()=>at});t.after(()=>{manager.close();rmSync(directory,{recursive:true,force:true});});return manager;
}

test('reports collect every retained attempt and related event beyond snapshot caps and include old unresolved evidence',async t=>{
 const manager=retainedFixture(t);assert.equal(manager.snapshot().attempts.length,201);const r=await createSupportReport({manager,appVersion:'0.4.23',to:at});assert.equal(r.attempts.length,1204);assert.equal(r.events.filter(e=>e.type==='delivery.trace').length,1205);assert.equal(r.attempts.find(a=>a.id==='a-0').body,'');assert.equal(r.attempts.find(a=>a.id==='a-0').bodyAvailable,true);assert.equal(r.attempts.some(a=>a.id==='a-1'),false);assert.equal(r.events[0].attemptId,'a-2');
 const narrow=await createSupportReport({manager,appVersion:'0.4.23',from:at-100,to:at});assert.equal(narrow.attempts.length,1);assert.equal(narrow.attempts[0].id,'a-2');assert.ok(narrow.events.some(e=>e.type==='delivery.trace'&&e.attemptId==='a-2'));
 const one=await createSupportReport({manager,appVersion:'0.4.23',attemptId:'a-10',from:at-100,to:at});assert.equal(one.attempts.length,1);assert.deepEqual(one.commands.map(c=>c.id),['context-current','attempt-command']);assert.ok(one.events.some(e=>e.type==='delivery.trace'&&e.attemptId==='a-10'));assert.ok(!one.events.some(e=>e.attemptId&&e.attemptId!=='a-10'));
 const pruned=await createSupportReport({manager,appVersion:'0.4.23',attemptId:'a-1',to:at});assert.equal(pruned.attempts[0].bodyAvailable,false);assert.ok(pruned.checks.some(c=>c.code==='BODY_UNAVAILABLE'));assert.doesNotMatch(JSON.stringify(r),/NEVER-EXPORT/);
});

test('history, snapshot and report keep the exact attempt body after the message library is edited',async t=>{
 const manager=createCentralManager({now:()=>at,monotonicNow:()=>1000});t.after(()=>manager.close());const hello=manager.bridge({type:'HELLO',protocolVersion:1,name:'browser'});
 manager.bridge({type:'OBSERVATION',sessionId:hello.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'a',guildId:'guild',channelId:'channel',name:'Channel',tabId:1,verified:true}]},hello.instanceId);
 const message=manager.execute('message.create',{name:'original',body:'exact\n original body'}),channel=manager.snapshot().channels[0];manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:[{messageId:message.id}]});for(const c of manager.commands(hello.instanceId))manager.bridge({type:'ACK',sessionId:hello.sessionId,commandId:c.id,status:'applied'},hello.instanceId);
 const group=manager.execute('group.create',{name:'rotation',members:[channel.id],intervalMs:0});manager.execute('group.start',{id:group.id});manager.tick();const attempt=manager.snapshot().attempts[0];assert.ok(attempt);
 manager.execute('message.update',{id:message.id,expectedVersion:message.version,body:'edited library body'});
 assert.equal(manager.snapshot().messages[0].body,'edited library body');for(const preserved of [manager.snapshot().attempts[0],manager.historyPage().items[0],(await createSupportReport({manager,attemptId:attempt.id,to:at})).attempts[0]]){assert.equal(preserved.body,'exact\n original body');assert.equal(preserved.bodyAvailable,true);assert.equal(preserved.sessionId,undefined);assert.equal(preserved.permitId,undefined);}
});

test('large generated diagnostics are bounded automatically and disclose omissions through inspection',async()=>{
 const input=data();input.attempts=Array.from({length:2000},(_,i)=>({id:'large-'+i,status:i===1999?'unknown':'confirmed',createdAt:at+i,body:'가'.repeat(9000)}));
 const r=await createSupportReport({manager:{supportData:()=>input},to:at});
 assert.ok(Buffer.byteLength(JSON.stringify(r))<4*1024*1024);assert.ok(r.attempts.some(a=>a.id==='large-1999'));
 assert.equal(r.selection.omittedCounts.attempts,2000-r.attempts.length);assert.ok(r.selection.partialRecords);
 const checked=inspectSupportReport(r).report;assert.equal(checked.selection.omittedCounts.attempts,r.selection.omittedCounts.attempts);assert.ok(checked.checks.some(x=>x.code==='REPORT_COMPACTED'));
});

test('large stored logs preserve recent errors without requiring the user to narrow the range',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'dico-support-budget-')),databasePath=join(directory,'state.sqlite');let manager=createCentralManager({databasePath,now:()=>at});manager.close();
 const store=new CentralStore(databasePath),state=store.read();state.stateVersion++;
 store.commit(state,[{type:'service.stopped',at:at-100,reasonCode:'IMPORTANT_ERROR'},...Array.from({length:900},(_,i)=>({type:'delivery.trace',at:at+i,data:{message:'x'.repeat(20000)}}))]);store.close();
 manager=createCentralManager({databasePath,now:()=>at+1000});t.after(()=>{manager.close();rmSync(directory,{recursive:true,force:true});});
 const r=await createSupportReport({manager,to:at+1000});assert.ok(r.events.some(e=>e.reasonCode==='IMPORTANT_ERROR'));assert.ok(r.selection.omittedCounts.events>0);assert.ok(r.checks.some(c=>c.code==='REPORT_COMPACTED'));assert.doesNotThrow(()=>inspectSupportReport(r));
});

test('compaction prioritizes old unresolved and active group attempts and preserves timeline omission counts',async()=>{
 const input=data();input.attempts=[{id:'critical-old',status:'unknown',createdAt:at-999999},...Array.from({length:2600},(_,i)=>({id:'ok-'+i,status:'confirmed',createdAt:at+i}))];input.groups[0].activeAttemptId='critical-old';
 input.intervals=Array.from({length:2600},(_,i)=>({id:'span-'+i,scope:'group',targetId:'g',from:at+i,to:at+i+1}));
 const r=await createSupportReport({manager:{supportData:()=>input},to:at});assert.ok(r.attempts.some(a=>a.id==='critical-old'));assert.ok(r.checks.some(c=>c.code==='DELIVERY_UNKNOWN'&&c.attemptId==='critical-old'));
 assert.ok(r.selection.omittedCounts.timeline>0);assert.equal(inspectSupportReport(r).report.selection.omittedCounts.timeline,r.selection.omittedCounts.timeline);
});
