import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startCentralRuntime} from '../central/runtime/main.mjs';

test('runtime incident automatically reaches the administrator inbox without a downloaded file',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'dico-auto-report-'));let sender,receiver;
 t.after(async()=>{await sender?.close();await receiver?.close();await rm(directory,{recursive:true,force:true});});
 receiver=await startCentralRuntime({directory:join(directory,'receiver'),port:0});
 receiver.supportDelivery.configure({receiverEnabled:true});const {token}=receiver.supportDelivery.receiverKey();
 sender=await startCentralRuntime({directory:join(directory,'sender'),port:0});
 sender.supportDelivery.configure({enabled:true,autoSend:true,receiverUrl:receiver.url+'/api/support/receive',reporterToken:token,includeBodies:true});
 const m=sender.manager,hello=m.bridge({type:'HELLO',protocolVersion:1,name:'Browser'}),bridge=message=>m.bridge({sessionId:hello.sessionId,...message},hello.instanceId);
 bridge({type:'OBSERVATION',legacyFrozen:true,legacyPending:false,channels:[{accountId:'account',guildId:'guild',channelId:'channel',tabId:1,verified:true}]});
 const channel=m.snapshot().channels[0],message=m.execute('message.create',{name:'Message',body:'Original diagnostic body'});
 m.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:channel.version,items:[{messageId:message.id}]});bridge({type:'ACK',commandId:m.commands(hello.instanceId).find(c=>c.type==='CONFIG_SYNC').id,status:'applied'});
 const group=m.execute('group.create',{name:'Group',members:[channel.id],intervalMs:0});m.execute('group.start',{id:group.id});m.tick();const a=m.snapshot().attempts[0];
 bridge({type:'PREPARED',attemptId:a.id,accountId:a.accountId,channelId:a.channelId,configVersion:a.configVersion,draftClear:true});
 bridge({type:'DELIVERY_RESULT',attemptId:a.id,outcome:'unknown',executionBlocked:true,reasonCode:'CONTENT_EXCEPTION_AFTER_ENTER'});
 for(let n=0;n<100&&receiver.supportDelivery.inbox().length===0;n++)await new Promise(r=>setTimeout(r,10));
 assert.equal(receiver.supportDelivery.inbox().length,1);
 const report=receiver.supportDelivery.get(receiver.supportDelivery.inbox()[0].receiptId).report;
 assert.equal(report.attempts[0].body,'Original diagnostic body');assert.equal(report.attempts[0].reasonCode,'CONTENT_EXCEPTION_AFTER_ENTER');assert.equal(report.privacy.credentialsExcluded,true);
 assert.doesNotMatch(JSON.stringify(report),new RegExp(token));
 for(let n=0;n<100&&sender.supportDelivery.status().counts.sent===0;n++)await new Promise(r=>setTimeout(r,10));
 assert.equal(sender.supportDelivery.status().counts.sent,1);
});

test('broken diagnostic storage does not prevent the delivery service from starting',async t=>{
 const {mkdir,writeFile}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'dico-auto-report-bad-'));let runtime;
 t.after(async()=>{await runtime?.close();await rm(dir,{recursive:true,force:true});});await mkdir(join(dir,'support'));await writeFile(join(dir,'support','state.json'),JSON.stringify({version:999,outbox:[],inbox:[]}));
 runtime=await startCentralRuntime({directory:dir,port:0});assert.equal(runtime.manager.snapshot().service.status,'ready');assert.equal(runtime.supportDelivery,undefined);
});

test('update failure is automatically diagnosed and delivered with a receipt without opening the UI',async t=>{
 const {mkdir,writeFile}=await import('node:fs/promises');
 const directory=await mkdtemp(join(tmpdir(),'dico-update-report-'));let sender,receiver;
 t.after(async()=>{await sender?.close();await receiver?.close();await rm(directory,{recursive:true,force:true});});
 receiver=await startCentralRuntime({directory:join(directory,'receiver'),port:0});
 receiver.supportDelivery.configure({receiverEnabled:true});
 const senderDir=join(directory,'sender'),jobId='e'.repeat(32);
 await mkdir(join(senderDir,'updates'),{recursive:true});
 await writeFile(join(senderDir,'updates/status.json'),JSON.stringify({phase:'failed',message:'build_failed',jobId,retryCount:2,diagnostic:{code:'TOOL_MISSING',stage:'build',exitCode:127}}));
 sender=await startCentralRuntime({directory:senderDir,port:0});
 sender.supportDelivery.configure({enabled:true,autoSend:true,receiverUrl:receiver.url+'/api/support/receive',reporterToken:receiver.supportDelivery.receiverKey().token});
 for(let n=0;n<200&&sender.supportDelivery.status().counts.sent===0;n++)await new Promise(r=>setTimeout(r,25));
 const status=await sender.updates.status();
 assert.equal(status.support.status,'sent');assert.ok(status.support.receiptId);
 assert.equal(receiver.supportDelivery.inbox().length,1);
 const report=receiver.supportDelivery.get(status.support.receiptId).report;
 assert.equal(report.runtime.updateDiagnostic.code,'TOOL_MISSING');
 assert.equal(report.runtime.updateDiagnostic.retryCount,2);
 assert.equal(report.privacy.includeBodies,false);
 await sender.updates.reportFailure({automatic:false});
 assert.equal(sender.supportDelivery.status().outbox.length,1);
});
