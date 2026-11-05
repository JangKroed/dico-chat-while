import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createHash,randomUUID} from 'node:crypto';
// 외부 발송 없이 실제 Apps Script 코드를 실행하며 속성 저장소·시계·메일 경계만 대체한다.
export const publicKey='synthetic-public-submission-key';
export const privateKey='synthetic-private-installation-key';
export function relay({key=publicKey,clock=Date.now()}={}){
 const props={REPORT_KEY:key},sent=[];let reject=false,locked=false;
 const properties={getProperty:k=>props[k],setProperty:(k,v)=>{props[k]=v;},getProperties:()=>({...props}),deleteProperty:k=>{delete props[k];}};
 const context={Date:class extends Date{static now(){return clock;}},ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({setMimeType:()=>JSON.parse(text)})},LockService:{getScriptLock:()=>({tryLock:()=>!locked,releaseLock:()=>{}})},PropertiesService:{getScriptProperties:()=>properties},Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_alg,text)=>Array.from(createHash('sha256').update(text).digest()),getUuid:randomUUID,newBlob:(text,type,name)=>({text,type,name,getBytes:()=>Buffer.from(text)})},MailApp:{getRemainingDailyQuota:()=>100,sendEmail:options=>{if(reject)throw Error('ambiguous provider failure');sent.push(options);}}};
 const post=runInNewContext(readFileSync(new URL('../../mail-relay/Central.gs',import.meta.url),'utf8')+'\ndoPost',context);
 return {sent,props,post:body=>post({postData:{contents:JSON.stringify(body)}}),raw:contents=>post({postData:{contents}}),reject:()=>{reject=true;},busy:value=>{locked=value;},advance:ms=>{clock+=ms;},now:()=>clock};
}
