import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {validateMailConfig,sendReport,queueEmailReport,flushEmailReport} from '../email-report.js';
const config={url:'https://script.google.com/macros/s/test/exec',key:'a'.repeat(40),enabled:true};
test('메일 목적지 제한 및 서버 성공 응답 검증',async()=>{
 assert.throws(()=>validateMailConfig({...config,url:'https://example.com'}));
 assert.throws(()=>validateMailConfig({...config,key:'short'}));
 await sendReport({},config,{id:'test'},async(url,options)=>{assert.equal(url,config.url);assert.equal(options.credentials,'omit');return {ok:true,json:async()=>({ok:true})};});
 await assert.rejects(sendReport({},config,{},async()=>({ok:true,json:async()=>({ok:false})})));
});
test('오류는 메일 예약, 성공 기록과 비활성 설정은 예약하지 않는다',async()=>{
 const stored={mailConfig:config,diagnosticLog:[{kind:'error'}]};let alarms=0;
 const api={storage:{local:{get:async()=>stored,set:async v=>Object.assign(stored,v)}},runtime:{getManifest:()=>({version:'test'})},alarms:{create:async()=>alarms++}};
 await queueEmailReport(api,[{kind:'delivery-confirmed'}]);assert.equal(alarms,0);
 await queueEmailReport(api,[{kind:'error'}]);assert.equal(alarms,1);assert.equal(stored.pendingEmailReport.events.length,1);
 stored.mailConfig={enabled:false};await queueEmailReport(api,[{kind:'error'}]);assert.equal(alarms,1);
});
test('메일 서버는 키·수신자·중복·하루 한도를 제한한다',()=>{
 const props={REPORT_KEY:config.key};const sent=[];
 const context={ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({setMimeType:()=>JSON.parse(text)})},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},PropertiesService:{getScriptProperties:()=>({getProperty:key=>props[key],setProperty:(key,value)=>props[key]=value})},MailApp:{getRemainingDailyQuota:()=>100,sendEmail:(...args)=>sent.push(args)}};
 const post=runInNewContext(readFileSync(new URL('../mail-relay/Code.gs',import.meta.url),'utf8')+'\ndoPost',context);
 const request=(id,key=config.key)=>post({postData:{contents:JSON.stringify({key,report:{id,events:[]},to:'someone@example.com'})}});
 const id='00000000-0000-0000-0000-000000000000';
 assert.equal(request(id,'wrong').ok,false);assert.equal(sent.length,0);
 assert.equal(request(id).ok,true);assert.equal(sent[0][0],'didlsdydgh@gmail.com');
 assert.equal(request(id).ok,false);assert.equal(sent.length,1);
 for(let i=1;i<20;i++)assert.equal(request(`00000000-0000-0000-0000-${String(i).padStart(12,'0')}`).ok,true);
 assert.equal(request('00000000-0000-0000-0000-000000000021').ok,false);assert.equal(sent.length,20);
});

test('발송 응답 유실 시 상태를 남기고 같은 보고서를 자동 재발송하지 않는다',async()=>{
 const stored={mailConfig:config,pendingEmailReport:{id:'test',events:[]}};
 const api={storage:{local:{get:async()=>({...stored}),set:async v=>Object.assign(stored,v),remove:async key=>delete stored[key]}}};
 const previous=globalThis.fetch;let attempts=0;
 globalThis.fetch=async()=>{attempts++;throw new Error('network');};
 try {
  await flushEmailReport(api);await flushEmailReport(api);
  assert.equal(attempts,1);assert.match(stored.mailStatus,/실패/);
 }finally{globalThis.fetch=previous;}
});
