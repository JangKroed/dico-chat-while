import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSupportDelivery} from '../central/runtime/support-delivery.mjs';

const connection={receiverUrl:'https://reports.example.test/api/support/receive',reporterToken:'a'.repeat(64)};
test('bundled receiver connection removes address entry but never grants transmission or body consent',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dico-support-connection-'));let delivery;
 try{
  delivery=createSupportDelivery({dir,connection,createReport:()=>{throw Error('No consent');}});
  const status=delivery.status();assert.equal(status.configured,true);assert.equal(status.settings.receiverUrl,connection.receiverUrl);
  assert.equal(status.settings.enabled,false);assert.equal(status.settings.autoSend,false);assert.equal(status.settings.includeBodies,false);
  assert.doesNotMatch(JSON.stringify(status),new RegExp(connection.reporterToken));
  assert.equal(await delivery.queue({automatic:true}),null);
  delivery.configure({receiverUrl:''});await delivery.close();
  delivery=createSupportDelivery({dir,connection,createReport:()=>{}});
  assert.equal(delivery.status().configured,false,'explicit removal survives restart');
 }finally{await delivery?.close();rmSync(dir,{recursive:true,force:true});}
});
test('bundled connection never overwrites an existing administrator destination',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dico-support-connection-'));let delivery;
 try{
  delivery=createSupportDelivery({dir,createReport:()=>{}});
  delivery.configure({receiverUrl:'https://existing.example.test/api/support/receive',reporterToken:'b'.repeat(64)});await delivery.close();
  delivery=createSupportDelivery({dir,connection,createReport:()=>{}});
  assert.equal(delivery.status().settings.receiverUrl,'https://existing.example.test/api/support/receive');
 }finally{await delivery?.close();rmSync(dir,{recursive:true,force:true});}
});
