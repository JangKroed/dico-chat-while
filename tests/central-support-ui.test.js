import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),require=createRequire(join(root,'central/ui/package.json'));
let loaded;
async function components(){return loaded??=(async()=>{
  const {build}=require('esbuild');
  const built=await build({stdin:{contents:"export * from './src/SupportReport.tsx';export * from './src/support-report.ts';export {History,Logs,Settings} from './src/App.tsx';export {createElement,__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE as ReactInternals} from 'react';export {renderToStaticMarkup} from 'react-dom/server';",resolveDir:join(root,'central/ui'),loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,plugins:[{name:'expose-pages',setup(b){b.onLoad({filter:/\/App\.tsx$/},async({path})=>({contents:(await readFile(path,'utf8'))+'\nexport {History,Logs,Settings};',loader:'tsx'}));}}]});
  const dir=await mkdtemp(join(tmpdir(),'dico-support-ui-'));
  try{const path=join(dir,'components.cjs');await writeFile(path,built.outputFiles[0].contents);return require(path);}finally{await rm(dir,{recursive:true,force:true});}
})();}
const report={format:'dico-support-report',schemaVersion:1,reportId:'report-1',createdAt:1700000000000,runtime:{appVersion:'0.4.23',build:{commit:'abcdef'}},selection:{attemptId:'attempt-1',from:1,to:2},privacy:{includeBodies:true,includeNames:true,credentialsExcluded:true},summary:{attempts:1,events:1,unknown:1,blockedGroups:1},configuration:{groups:[{id:'g',members:['first','second'],cursor:1}],channels:[{id:'first',slowmodeMs:5000}]},attempts:[{id:'attempt-1',body:'원본\r\n <script>alert(1)</script>',status:'unknown',reasonCode:'DELIVERY_CONFIRMATION_TIMEOUT',deliveryEvidence:{enterAttempted:true,retryCount:3}}],commands:[],events:[],incidents:[],timeline:[{type:'attempt.result',at:1700000000000,message:'미확인'}],checks:[{code:'VERSION_MISMATCH',severity:'warning',message:'확장과 관리 프로그램 버전 불일치'}]};

test('report import rejects oversized and non-report JSON before inspection',async()=>{
  const {readSupportReport}=await components();
  await assert.rejects(()=>readSupportReport({size:16777217,text:async()=>{throw Error('must not read');}}),/16 MiB/);
  await assert.rejects(()=>readSupportReport({size:2,text:async()=>'[]'}),/제보 파일/);
  await assert.rejects(()=>readSupportReport({size:20,text:async()=>'{"format":"backup"}'}),/제보 파일/);
  assert.equal((await readSupportReport({size:1000,text:async()=>JSON.stringify(report)})).reportId,'report-1');
});

test('report summary preserves exact attempt body only when included in the report',async()=>{
  const {supportReportSummary}=await components();
  const summary=supportReportSummary({...report,userDescription:'문구가 남고 다음 순서가 멈춤'});
  assert.match(summary,/report-1/);assert.match(summary,/문구가 남고 다음 순서가 멈춤/);assert.match(summary,/원본\r\n <script>alert\(1\)<\/script>/);assert.match(summary,/DELIVERY_CONFIRMATION_TIMEOUT/);
  assert.doesNotMatch(supportReportSummary({...report,attempts:[{id:'a',status:'unknown'}],privacy:{includeBodies:false,includeNames:false}}),/alert\(1\)/);
});

test('administrator viewer escapes imported body and shows evidence, versions and ordered configuration',async()=>{
  const {SupportReportPreview,createElement,renderToStaticMarkup}=await components();
  const html=renderToStaticMarkup(createElement(SupportReportPreview,{report,findings:[{code:'UNVERIFIED_SOURCE',severity:'info',message:'파일의 원본 진위는 검증되지 않았습니다.'}]}));
  assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/원본 진위/);
  for(const text of ['0.4.23','abcdef','VERSION_MISMATCH','attempt.result','retryCount','slowmodeMs','first','second','DELIVERY_CONFIRMATION_TIMEOUT'])assert.ok(html.includes(text),text);
  assert.doesNotMatch(html,/<a[^>]+href=/);
});

test('attempt body view distinguishes a missing snapshot from an intentionally empty body',async()=>{
  const {AttemptMessageBody,createElement,renderToStaticMarkup}=await components();
  const original=renderToStaticMarkup(createElement(AttemptMessageBody,{attempt:{id:'a',body:'작성 당시\n본문'}}));
  assert.match(original,/작성 당시\n본문/);assert.match(original,/시도 당시/);
  assert.match(renderToStaticMarkup(createElement(AttemptMessageBody,{attempt:{id:'a'}})),/본문이 보존되지/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(AttemptMessageBody,{attempt:{id:'a',body:''}})),/본문이 보존되지/);
});

test('report action opens a preview workflow without claiming delivery',async()=>{
  const {SupportReportButton}=await components();let selected;
  const button=SupportReportButton({attemptId:'a',onOpen:value=>selected=value});button.props.onClick();assert.equal(selected,'a');
  assert.equal(button.props.children,'관리자에게 제보');
});

test('history, incident list and settings each expose the support workflow',async()=>{
  const {History,Logs,Settings,createElement,renderToStaticMarkup}=await components();
  const s={schemaVersion:1,stateVersion:1,messages:[],instances:[],accounts:[],channels:[],groups:[],attempts:[],incidents:[],events:[]};
  const common={s,go:()=>{},run:async()=>true,busy:false,retryNotSent:async()=>null,retryWaitingId:null,supportReport:()=>{}};
  const oldWindow=globalThis.window,oldDocument=globalThis.document;
  globalThis.window={location:{href:'http://127.0.0.1:43128/'}};globalThis.document={documentElement:{dataset:{},style:{}}};
  try{for(const [Component,props] of [[History,{}],[Logs,{period:'24h',refresh:async()=>{}}],[Settings,{draftStatus:{current:false},accessMode:'local',notify:async()=>{}}]]){
    const html=renderToStaticMarkup(createElement(Component,{...common,...props}));assert.match(html,/관리자에게 제보/);
  }}finally{globalThis.window=oldWindow;globalThis.document=oldDocument;}
});

function hookRenderer(internals,Component,props){
  const state=[];let cursor=0;
  const dispatcher={useState(initial){const i=cursor++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],value=>{state[i]=typeof value==='function'?value(state[i]):value;}];},useRef(initial){const i=cursor++;return state[i]??=( {current:initial});},useEffect(){}};
  return()=>{cursor=0;const previous=internals.H;internals.H=dispatcher;try{return Component(props);}finally{internals.H=previous;}};
}
function elements(node){if(!node||typeof node!=='object')return[];return[node,...[node.props?.children].flat(Infinity).flatMap(elements)];}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('changing privacy cancels a pending preview and prevents a stale body export',async()=>{
  const {SupportReportDialog,SupportReportPreview,ReactInternals}=await components();
  const prior=globalThis.fetch,pending=[];
  globalThis.fetch=(path,init)=>new Promise(resolve=>pending.push({path,init,resolve}));
  const render=hookRenderer(ReactInternals,SupportReportDialog,{attemptId:'attempt-1',onClose:()=>{}});
  try{
    let tree=render();const preview=elements(tree).find(node=>node.type==='button'&&node.props.children==='제보 내용 미리보기');
    preview.props.onClick();tree=render();assert.ok(elements(tree).some(node=>node.type==='button'&&node.props.children==='기록 준비 중…'));
    const bodyToggle=elements(tree).find(node=>node.type==='input'&&node.props.type==='checkbox');bodyToggle.props.onChange({target:{checked:false}});
    assert.equal(pending[0].init.signal.aborted,true);
    pending[0].resolve(Response.json(report));await settle();tree=render();assert.equal(elements(tree).some(node=>node.type===SupportReportPreview),false);
    elements(tree).find(node=>node.type==='button'&&node.props.children==='제보 내용 미리보기').props.onClick();
    assert.equal(new URL(pending[1].path,'http://localhost').searchParams.get('includeBodies'),'false');
    pending[1].resolve(Response.json({...report,privacy:{includeBodies:false,includeNames:true},attempts:[{id:'attempt-1',status:'unknown'}]}));await settle();tree=render();
    const shown=elements(tree).find(node=>node.type===SupportReportPreview);assert.equal(shown.props.report.privacy.includeBodies,false);assert.equal(shown.props.report.attempts[0].body,undefined);
    assert.ok(elements(tree).some(node=>node.type==='button'&&node.props.children==='파일로 백업'));assert.equal(elements(tree).some(node=>typeof node.props?.children==='string'&&node.props.children==='전송 완료'),false);
  }finally{globalThis.fetch=prior;}
});

test('report preview explains a deliberately excluded body without claiming retention loss',async()=>{
  const {SupportReportPreview,createElement,renderToStaticMarkup}=await components();
  const html=renderToStaticMarkup(createElement(SupportReportPreview,{report:{...report,privacy:{includeBodies:false,includeNames:false},attempts:[{id:'a'}]}}));
  assert.match(html,/포함 선택에 따라.*본문.*제외/);assert.doesNotMatch(html,/본문이 보존되지/);
});

test('imported server findings are displayed once when also present in report checks',async()=>{
  const {SupportReportPreview,createElement,renderToStaticMarkup}=await components();
  const html=renderToStaticMarkup(createElement(SupportReportPreview,{report,findings:[...report.checks,{code:'OTHER',severity:'info',message:'별도 분석'}]}));
  assert.equal(html.split('확장과 관리 프로그램 버전 불일치').length-1,1);assert.match(html,/별도 분석/);
});
