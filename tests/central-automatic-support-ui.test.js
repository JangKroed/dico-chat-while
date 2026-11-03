import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),require=createRequire(join(root,'central/ui/package.json'));
let loaded;
async function components(){return loaded??=(async()=>{
 const {build}=require('esbuild');
 const built=await build({stdin:{contents:"export * from './src/AutomaticSupport.tsx';export * from './src/api.ts';export {SupportReportPreview} from './src/SupportReport.tsx';export {createElement,__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE as ReactInternals} from 'react';export {renderToStaticMarkup} from 'react-dom/server';",resolveDir:join(root,'central/ui'),loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false});
 const dir=await mkdtemp(join(tmpdir(),'dico-auto-support-ui-'));
 try{const path=join(dir,'components.cjs');await writeFile(path,built.outputFiles[0].contents);return require(path);}finally{await rm(dir,{recursive:true,force:true});}
})();}
const status={settings:{enabled:false,autoSend:false,receiverUrl:'',includeBodies:false,includeNames:false,receiverEnabled:false,retentionDays:30},configured:false,hasReporterToken:false,transportWarning:null,outbox:[],counts:{queued:2,sent:0,failed:1,inbox:1},inbox:[{receiptId:'r/1',reportId:'report-1',receivedAt:1700000000000,createdAt:1700000000000,summary:{attempts:1,events:2,unknown:1,blockedGroups:1}}]};
function hooks(internals,Component,props={}){const state=[];let cursor=0;const dispatcher={useState(initial){const i=cursor++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],value=>{state[i]=typeof value==='function'?value(state[i]):value;}];},useRef(initial){const i=cursor++;return state[i]??={current:initial};},useEffect(){}};return()=>{cursor=0;const old=internals.H;internals.H=dispatcher;try{return Component(props);}finally{internals.H=old;}};}
function elements(node){if(!node||typeof node!=='object')return[];return[node,...[node.props?.children].flat(Infinity).flatMap(elements)];}
const button=(tree,name)=>elements(tree).find(node=>node.type==='button'&&node.props.children===name);
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('automatic support starts off with explicit privacy choices and receiver setup',async()=>{
 const {AutomaticSupport,createElement,renderToStaticMarkup}=await components();
 const html=renderToStaticMarkup(createElement(AutomaticSupport,{}));
 assert.match(html,/문제 발생 시 자동 제보/);assert.match(html,/메시지 본문/);assert.match(html,/수신 주소/);assert.match(html,/개인정보/);
 assert.doesNotMatch(html,/checked=""/);assert.doesNotMatch(html,/전송 완료/);
});

test('enabling automatic support is staged until save and never reports queued as delivered',async()=>{
 const {AutomaticSupport,ReactInternals}=await components(),calls=[],old=globalThis.fetch;
 globalThis.fetch=async(path,init)=>{calls.push({path,init});return Response.json(status);};
 const render=hooks(ReactInternals,AutomaticSupport);
 try{
  let tree=render();button(tree,'제보 상태 새로고침').props.onClick();await settle();tree=render();
  const toggle=elements(tree).find(node=>node.type==='input'&&node.props['aria-label']==='문제 발생 시 자동 제보');
  toggle.props.onChange({target:{checked:true}});tree=render();assert.equal(calls.length,1);
  const url=elements(tree).find(node=>node.type==='input'&&node.props['aria-label']==='관리자 제보 수신 주소');url.props.onChange({target:{value:'https://reports.example/api/support/receive'}});
  tree=render();button(tree,'자동 제보 설정 저장').props.onClick();await settle();
  assert.equal(calls[1].path,'/api/support/automatic');assert.equal(calls[1].init.method,'POST');
  const payload=JSON.parse(calls[1].init.body);assert.equal(payload.enabled,true);assert.equal(payload.autoSend,true);assert.equal(payload.includeBodies,false);assert.equal(payload.includeNames,false);
  assert.equal(payload.receiverUrl,'https://reports.example/api/support/receive');assert.equal(payload.reporterToken,undefined);
  tree=render();const all=JSON.stringify(tree);assert.match(all,/미설정|수신 주소.*설정/);assert.match(all,/대기/);assert.doesNotMatch(all,/전송 완료/);
 }finally{globalThis.fetch=old;}
});

test('received report opens the existing inspector and receiver keys require an explicit request',async()=>{
 const {AutomaticSupport,SupportReportPreview,ReactInternals}=await components(),calls=[],old=globalThis.fetch;
 const report={format:'dico-support-report',schemaVersion:1,reportId:'report-1',privacy:{includeBodies:false,includeNames:false}};
 globalThis.fetch=async(path,init)=>{calls.push({path,init});if(path.includes('/inbox/'))return Response.json({report,findings:[],summary:{}});if(path.endsWith('receiver-key'))return Response.json({token:'one-time-secret'});return Response.json(status);};
 const render=hooks(ReactInternals,AutomaticSupport);
 try{
  let tree=render();button(tree,'제보 상태 새로고침').props.onClick();await settle();tree=render();
  assert.equal(calls.some(call=>call.path.endsWith('receiver-key')),false);
  button(tree,'제보 내용 보기').props.onClick();await settle();tree=render();
  assert.equal(calls[1].path,'/api/support/inbox/r%2F1');assert.ok(elements(tree).some(node=>node.type===SupportReportPreview&&node.props.report.reportId==='report-1'));
  button(tree,'수신 인증 키 표시').props.onClick();await settle();tree=render();assert.equal(calls[2].path,'/api/support/receiver-key');assert.equal(calls[2].init.method,'POST');
  assert.ok(elements(tree).some(node=>node.type==='input'&&node.props.value==='one-time-secret'&&node.props.readOnly));
 }finally{globalThis.fetch=old;}
});

test('support transport helpers preserve authenticated API semantics and encode inbox identifiers',async()=>{
 const api=await components(),old=globalThis.fetch,calls=[];
 globalThis.fetch=async(path,init)=>{calls.push({path,init});return Response.json(path.endsWith('/inbox')?{items:[]}:path.endsWith('/send')?{id:'job',status:'queued'}:{});};
 try{
  const queued=await api.sendSupportReport({attemptId:'a',description:'멈춤',includeBodies:false,includeNames:false});assert.equal(queued.status,'queued');
  await api.getSupportInbox();await api.getSupportInboxReport('x/?');await api.createSupportReceiverKey();
  assert.equal(calls[0].init.credentials,'same-origin');assert.equal(calls[0].init.method,'POST');assert.deepEqual(JSON.parse(calls[0].init.body),{attemptId:'a',description:'멈춤',includeBodies:false,includeNames:false});
  assert.equal(calls[2].path,'/api/support/inbox/x%2F%3F');assert.equal(calls[3].init.method,'POST');
 }finally{globalThis.fetch=old;}
});


test('turning off incident reporting preserves previously granted one-click sending consent',async()=>{
 const {AutomaticSupport,ReactInternals}=await components(),calls=[],old=globalThis.fetch;
 const enabled={...status,settings:{...status.settings,enabled:true,autoSend:true}};
 globalThis.fetch=async(path,init)=>{calls.push({path,init});return Response.json(enabled);};
 const render=hooks(ReactInternals,AutomaticSupport);
 try{
  let tree=render();button(tree,'제보 상태 새로고침').props.onClick();await settle();tree=render();
  elements(tree).find(node=>node.type==='input'&&node.props['aria-label']==='문제 발생 시 자동 제보').props.onChange({target:{checked:false}});
  tree=render();button(tree,'자동 제보 설정 저장').props.onClick();await settle();
  const payload=JSON.parse(calls[1].init.body);assert.equal(payload.enabled,true);assert.equal(payload.autoSend,false);
 }finally{globalThis.fetch=old;}
});
