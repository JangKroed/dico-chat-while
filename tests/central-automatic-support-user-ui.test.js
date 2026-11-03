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
function hooks(internals,Component,props={},initialStatus=status){const state=[initialStatus,initialStatus.settings];let cursor=0;const dispatcher={useState(initial){const i=cursor++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],value=>{state[i]=typeof value==='function'?value(state[i]):value;}];},useRef(initial){const i=cursor++;return state[i]??={current:initial};},useEffect(){}};return()=>{cursor=0;const old=internals.H;internals.H=dispatcher;try{return Component(props);}finally{internals.H=old;}};}
function elements(node){if(!node||typeof node!=='object')return[];return[node,...[node.props?.children].flat(Infinity).flatMap(elements)];}
const button=(tree,name)=>elements(tree).find(node=>node.type==='button'&&node.props.children===name);
const settle=()=>new Promise(resolve=>setImmediate(resolve));

// 사용자 화면은 수신 연결 및 원시 진단을 노출하지 않고 동의와 실제 전송 결과만 보여 준다.
test('ordinary support view exposes one consent and truthful aggregate results only',async()=>{
 const {AutomaticSupport,ReactInternals}=await components();
 const render=hooks(ReactInternals,AutomaticSupport,{diagnostic:false});
 const tree=render(),all=JSON.stringify(tree),nodes=elements(tree);
 assert.equal(nodes.filter(node=>node.type==='input'&&node.props.type==='checkbox').length,1);
 assert.match(all,/문제 발생 시 자동 제보/);assert.match(all,/전송 대기/);assert.match(all,/전송 실패/);assert.match(all,/수신 확인/);
 assert.doesNotMatch(all,/수신 인증 키|수신 주소|수신함|제보 내용 보기|최근 전송 상태|내려받|전송 완료/);
 assert.match(all,/아직 전송되지 않습니다/);
});

// 기존에 개인정보 포함 옵션이 저장되어 있어도 자동 제보에는 다시 사용하지 않는다.
test('ordinary consent saves through existing endpoint and always excludes bodies and names',async()=>{
 const {AutomaticSupport,ReactInternals}=await components(),calls=[],old=globalThis.fetch;
 const legacy={...status,settings:{...status.settings,includeBodies:true,includeNames:true,receiverUrl:'https://reports.example/api/support/receive'}};
 globalThis.fetch=async(path,init)=>{calls.push({path,init});return Response.json(legacy);};
 const render=hooks(ReactInternals,AutomaticSupport,{diagnostic:false},legacy);
 try{
  let tree=render();elements(tree).find(node=>node.type==='input'&&node.props['aria-label']==='문제 발생 시 자동 제보').props.onChange({target:{checked:true}});
  assert.equal(calls.length,0);tree=render();button(tree,'자동 제보 설정 저장').props.onClick();await settle();
  assert.equal(calls[0].path,'/api/support/automatic');const payload=JSON.parse(calls[0].init.body);
  assert.equal(payload.enabled,true);assert.equal(payload.autoSend,true);assert.equal(payload.includeBodies,false);assert.equal(payload.includeNames,false);
  assert.equal(payload.receiverUrl,legacy.settings.receiverUrl);
 }finally{globalThis.fetch=old;}
});

test('diagnostic support no longer offers automatic body or name inclusion',async()=>{
 const {AutomaticSupport,ReactInternals}=await components();
 const tree=hooks(ReactInternals,AutomaticSupport)();
 assert.equal(elements(tree).some(node=>node.type==='input'&&/자동 제보 메시지 본문 포함|자동 제보 표시 이름 포함/.test(node.props['aria-label']||'')),false);
 assert.ok(button(tree,'수신 인증 키 표시'));
});
