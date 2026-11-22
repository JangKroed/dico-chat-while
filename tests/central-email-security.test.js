import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';

// 실제 키나 네트워크를 쓰지 않고 배포용 스크립트의 보안 경계를 실행한다.
const key='synthetic-submission-key-for-security-tests';
const source=readFileSync(new URL('../mail-relay/Central.gs',import.meta.url),'utf8');
function report(extra={}){return {format:'dico-support-report',schemaVersion:1,reportId:randomUUID(),createdAt:1800000000000,runtime:{appVersion:'test'},selection:{},privacy:{includeBodies:false,includeNames:false,credentialsExcluded:true},configuration:{instances:[],accounts:[],targets:[],channels:[],groups:[],locks:[]},events:[],attempts:[],commands:[],incidents:[],timeline:[],...extra};}
function relay({props={REPORT_KEY:key},sent=[],clock={now:1800000000000},lockAvailable=true,sendFails=false,receiptWriteFails=false}={}){
 const logs=[];let lockCalls=0,released=0,propertyReads=0;
 const context={Date:class extends Date{static now(){return clock.now;}},ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({setMimeType:()=>JSON.parse(text)})},LockService:{getScriptLock:()=>({tryLock:()=>{lockCalls++;return lockAvailable;},releaseLock:()=>{released++;}})},PropertiesService:{getScriptProperties:()=>({getProperty:k=>{propertyReads++;return props[k];},setProperty:(k,v)=>{if(receiptWriteFails&&k.startsWith('RECEIPT_')&&JSON.parse(v).sent)throw Error('synthetic-storage-failure');props[k]=v;},deleteProperty:k=>{delete props[k];},getProperties:()=>({...props})})},Utilities:{getUuid:randomUUID,newBlob:(text,type,name)=>({text,type,name,getBytes:()=>Buffer.from(text)})},MailApp:{getRemainingDailyQuota:()=>100,sendEmail:mail=>{if(sendFails)throw Error('sensitive-provider-error');sent.push(mail);}},console:{log:(...v)=>logs.push(v),error:(...v)=>logs.push(v)},Logger:{log:(...v)=>logs.push(v)}};
 const post=runInNewContext(source+'\ndoPost',context);
 return {props,sent,clock,logs,post:data=>post({postData:{contents:JSON.stringify(data)}}),raw:contents=>post({postData:{contents}}),stats:()=>({lockCalls,released,propertyReads})};
}
test('공개 제출 키는 위조 보고서 제출이 가능하지만 수신자·메일 본문·헤더를 지정하지 못한다',()=>{
 const s=relay();const result=s.post({key,to:'other@example.invalid',bcc:'other@example.invalid',subject:'override',report:report({to:'other@example.invalid'})});
 assert.equal(result.delivery,'email');assert.equal(s.sent.length,1);assert.equal(s.sent[0].to,'didlsdydgh@gmail.com');assert.equal(s.sent[0].bcc,undefined);assert.match(s.sent[0].subject,/^\[DICO\]/);assert.match(s.sent[0].body,/검증되지 않은/);
});
test('새 보고서 ID와 재시작으로도 짧은 구간 발송 제한을 우회하지 못하고 중복 영수증은 반환한다',()=>{
 const s=relay(),first=report();const receipt=s.post({key,report:first});
 s.post({key,report:report()});s.post({key,report:report()});
 const restarted=relay(s);assert.equal(restarted.post({key,report:report()}).code,'RATE_LIMIT');
 assert.equal(restarted.post({key,report:first}).receiptId,receipt.receiptId);assert.equal(s.sent.length,3);
 s.clock.now+=60000;assert.equal(restarted.post({key,report:report()}).delivery,'email');
});
test('일일 20건 제한은 서로 다른 ID에도 적용되고 다음 UTC 날짜에만 갱신된다',()=>{
 const s=relay();for(let i=0;i<20;i++){assert.equal(s.post({key,report:report()}).delivery,'email');s.clock.now+=61000;}
 assert.equal(s.post({key,report:report()}).code,'QUOTA');assert.equal(s.sent.length,20);
 s.clock.now+=86400000;assert.equal(s.post({key,report:report()}).delivery,'email');
});
test('UTF-8 바이트 한도를 넘긴 한글 요청은 메일·영수증 저장 전에 거절한다',()=>{
 const s=relay();const body=JSON.stringify({key,report:report({userDescription:'가'.repeat(6*1024*1024)})});
 assert.ok(body.length<17*1024*1024);assert.ok(Buffer.byteLength(body)>17*1024*1024);
 assert.equal(s.raw(body).code,'INVALID');assert.equal(s.sent.length,0);assert.equal(s.props.REPORT_BUDGET,undefined);assert.equal(s.stats().propertyReads,0);
});
test('보고서 구조와 개인정보 플래그를 검증하고 허용하지 않은 깊이·노드를 거절한다',()=>{
 const malformed=[report({privacy:{includeBodies:'false',includeNames:false}}),report({createdAt:'now'}),report({reportId:'-'.repeat(36)}),report({events:[null]}),report({configuration:{}})];
 const deep=report();let cursor=deep.extra={};for(let i=0;i<14;i++)cursor=cursor.extra={};malformed.push(deep);malformed.push(report({extra:Array.from({length:49999},()=>({a:1,b:2,c:3}))}));
 for(const input of malformed){const s=relay();assert.equal(s.post({key,report:input}).code,'INVALID');assert.equal(s.sent.length,0);}
});
test('중계 첨부에서 비밀 필드·제출 키·동의 없는 본문과 이름을 제거하고 원문을 기록하지 않는다',()=>{
 const s=relay();const input=report({events:[{type:'failure',at:1,detail:{authorization:'Bearer synthetic-sensitive',message:'echo '+key,body:'private-body',name:'private-name'},token:'synthetic-sensitive'}],credentials:{password:'synthetic-sensitive'},key:'synthetic-sensitive'});
 assert.equal(s.post({key,report:input}).delivery,'email');const attachment=s.sent[0].attachments[0].text;
 assert.equal(attachment.includes(key),false);assert.doesNotMatch(attachment,/synthetic-sensitive|private-body|private-name/);assert.deepEqual(s.logs,[]);
});
test('긴급 차단은 발송을 막고 정상 재시도 영수증을 지우지 않는다',()=>{
 const s=relay(),input=report(),receipt=s.post({key,report:input});s.props.REPORT_DISABLED='true';
 assert.equal(s.post({key,report:report()}).code,'DISABLED');assert.equal(s.sent.length,1);
 delete s.props.REPORT_DISABLED;assert.equal(s.post({key,report:input}).receiptId,receipt.receiptId);assert.equal(s.sent.length,1);
});
test('형식·인증 실패 요청은 전역 발송 락을 점유하지 않고 응답에 입력을 반사하지 않는다',()=>{
 const s=relay();assert.equal(s.raw('{bad').code,'INVALID');assert.equal(s.post({key:'wrong',report:report()}).code,'UNAUTHORIZED');
 assert.equal(s.stats().lockCalls,0);assert.deepEqual(s.logs,[]);
});
test('중계 실패와 락 경쟁에도 메일 중복을 만들거나 예외 원문을 응답·로그에 남기지 않는다',()=>{
 const blocked=relay({lockAvailable:false});assert.equal(blocked.post({key,report:report()}).code,'BUSY');assert.equal(blocked.sent.length,0);
 const s=relay({sendFails:true}),input=report();assert.equal(s.post({key,report:input}).code,'DELIVERY_UNCERTAIN');
 const restarted=relay(s);assert.equal(restarted.post({key,report:input}).code,'DELIVERY_UNCERTAIN');assert.equal(s.sent.length,0);assert.deepEqual(s.logs,[]);
});

test('첨부는 직렬화 후 UTF-8 16MiB를 넘지 않고 하루 총량을 초과하면 거절한다',()=>{
 const s=relay();const big=()=>report({events:Array.from({length:140},()=>({type:'diagnostic',at:1,message:'x'.repeat(80000)}))});
 for(let i=0;i<2;i++){assert.equal(s.post({key,report:big()}).delivery,'email');s.clock.now+=61000;}
 assert.equal(s.post({key,report:big()}).code,'QUOTA');assert.equal(s.sent.length,2);
 for(const mail of s.sent)assert.ok(Buffer.byteLength(mail.attachments[0].text)<=16*1024*1024);
 const oversized=report({events:Array.from({length:220},()=>({type:'diagnostic',at:1,message:'x'.repeat(80000)}))});
 const fresh=relay();assert.equal(fresh.post({key,report:oversized}).code,'INVALID');assert.equal(fresh.sent.length,0);
});
test('기존 영수증을 읽고 최근 영수증을 유지한 채 저장 용량 부족을 거절한다',()=>{
 const s=relay(),r=report(),receipt={reportId:r.reportId,receiptId:randomUUID(),receivedAt:s.clock.now,delivery:'email'};
 s.props['RECEIPT_'+r.reportId]=JSON.stringify({at:s.clock.now,sent:true,receipt});
 // 실제 속성별 9KB 한도 내에서 전체 저장 공간 부족을 재현한다.
 for(let i=0;i<58;i++)s.props['other_'+i]='x'.repeat(8000);
 assert.equal(s.post({key,report:r}).receiptId,receipt.receiptId);
 assert.equal(s.post({key,report:report()}).code,'STORAGE_LIMIT');assert.equal(s.sent.length,0);
 assert.ok(s.props['RECEIPT_'+r.reportId]);
});
test('새 영수증 90일 보관량은 속성 저장 한도 아래이며 만료 자료만 정리한다',()=>{
 const s=relay();for(let i=0;i<1800;i++){const id=randomUUID();s.props['RECEIPT_'+id]=JSON.stringify({at:s.clock.now-86400000,sent:true,receiptId:randomUUID()});}
 const old='RECEIPT_'+randomUUID();s.props[old]=JSON.stringify({at:s.clock.now-91*86400000,sent:false});
 assert.equal(s.post({key,report:report()}).delivery,'email');assert.equal(s.props[old],undefined);
 assert.equal(Object.keys(s.props).filter(k=>k.startsWith('RECEIPT_')).length,1801);
 assert.ok(Object.entries(s.props).reduce((n,[k,v])=>n+Buffer.byteLength(k)+Buffer.byteLength(v),0)<450*1024);
});
test('잘못된 한도 상태는 발송 허용으로 초기화하지 않고 차단한다',()=>{
 const s=relay();s.props.REPORT_BUDGET=JSON.stringify({day:new Date(s.clock.now).toISOString().slice(0,10),count:'invalid'});
 assert.equal(s.post({key,report:report()}).code,'QUOTA');assert.equal(s.sent.length,0);
});

test('별칭 자격증명 필드·헤더 원문·키를 포함한 속성 이름도 첨부에서 제거한다',()=>{
 const s=relay();const r=report({events:[{type:'failure',at:1,detail:{privateKey:'synthetic-private-key',accessKey:'synthetic-access-key',passphrase:'synthetic-passphrase',message:'Authorization: Bearer synthetic-bearer\nCookie: synthetic-cookie\npassword=synthetic-password'}}]});
 r.extra={[key]:'synthetic-property'};
 assert.equal(s.post({key,report:r}).delivery,'email');const text=s.sent[0].attachments[0].text;
 assert.doesNotMatch(text,/synthetic-(?:private|access|passphrase|bearer|cookie|password|property)/);assert.equal(text.includes(key),false);
});
test('90일 이내 구형 영수증과 새 접수를 함께 유지한다',()=>{
 const s=relay(),receipts=[];
 for(let i=0;i<1750;i++){const id=randomUUID(),receipt={reportId:id,receiptId:randomUUID(),receivedAt:s.clock.now-86400000,delivery:'email'};receipts.push(receipt);s.props['RECEIPT_'+id]=JSON.stringify({at:receipt.receivedAt,sent:true,receipt});}
 // 기존 영수증과 별도 설정이 있어도 정상 용량에서는 새 접수를 허용한다.
 for(let i=0;i<5;i++)s.props['other_'+i]='x'.repeat(8000);
 assert.equal(s.post({key,report:report()}).delivery,'email');
 for(const receipt of [receipts[0],receipts[1749]])assert.equal(s.post({key,report:report({reportId:receipt.reportId})}).receiptId,receipt.receiptId);
 assert.equal(Object.keys(s.props).filter(k=>k.startsWith('RECEIPT_')).length,1751);assert.equal(s.sent.length,1);
});

test('잘린 개인키 PEM도 끝까지 제거하며 반복 BEGIN 입력을 다시 탐색하지 않는다',()=>{
 const s=relay();const r=report({events:[{type:'failure',at:1,message:'-----BEGIN PRIVATE KEY-----'.repeat(3000)+'synthetic-truncated-private-material'}]});
 assert.equal(s.post({key,report:r}).delivery,'email');assert.doesNotMatch(s.sent[0].attachments[0].text,/BEGIN PRIVATE KEY|synthetic-truncated-private-material/);
});
test('실제 발송 후 최종 영수증 저장 실패에도 재시작이 중복 메일을 보내지 않는다',()=>{
 const s=relay({receiptWriteFails:true}),r=report();assert.equal(s.post({key,report:r}).code,'DELIVERY_UNCERTAIN');assert.equal(s.sent.length,1);
 const restarted=relay(s);assert.equal(restarted.post({key,report:r}).code,'DELIVERY_UNCERTAIN');assert.equal(s.sent.length,1);
});
