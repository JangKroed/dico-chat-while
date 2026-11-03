import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..'),require=createRequire(join(root,'central/ui/package.json'));
const {build}=require('esbuild');
let componentPromise;
function components(){return componentPromise??=(async()=>{
  const result=await build({stdin:{contents:"export {DashboardGroupControls,Dashboard} from './src/App.tsx'; export {renderToStaticMarkup} from 'react-dom/server';",resolveDir:join(root,'central/ui'),loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,loader:{'.css':'empty'},plugins:[{name:'test-component-export',setup(builder){builder.onLoad({filter:/\/App\.tsx$/},async({path})=>({contents:(await readFile(path,'utf8'))+'\nexport {DashboardGroupControls,Dashboard};\n',loader:'tsx'}));}}]});
  const dir=await mkdtemp(join(tmpdir(),'dico-group-controls-'));try{const file=join(dir,'component.cjs');await writeFile(file,result.outputFiles[0].contents);return require(file);}finally{await rm(dir,{recursive:true,force:true});}
})();}
function fixture(){
  const now=Date.now(),group={id:'group',name:'선택한 그룹',guildId:'222',channelId:'333',members:['binding'],status:'stopped',cursor:0,version:3,intervalMs:1000};
  const s={schemaVersion:1,stateVersion:1,serverNow:now,service:{status:'ready'},settings:{},instances:[{id:'browser',name:'브라우저',connected:true,lastSeenAt:now,legacyFrozen:true,legacyPending:false}],channels:[{id:'binding',name:'채널',instanceId:'browser',accountId:'111',guildId:'222',channelId:'333',verified:true,playlist:[{messageId:'message',revisionId:'revision'}],playlistIndex:0,configVersion:1,appliedVersion:1,slowmodeMs:0,intervalMs:1000}],messages:[{id:'message',name:'문구',revisions:[{id:'revision'}]}],groups:[group],attempts:[],incidents:[],events:[],commands:[]};
  return{s,group};
}
function elements(node){if(!node||typeof node!=='object')return[];const children=node.props?.children;return[node,...(Array.isArray(children)?children.flat(Infinity):[children]).flatMap(elements)];}

test('dashboard controls invoke only the selected group API and honor start confirmation',async()=>{
  const {DashboardGroupControls}=await components(),{s,group}=fixture(),calls=[];
  const props={s,group,run:async(...args)=>{calls.push(args);return true;},busy:false,stale:false,go:()=>{}};
  const previous=globalThis.confirm;
  try{
    globalThis.confirm=()=>false;
    let buttons=elements(DashboardGroupControls(props)).filter(e=>e.type==='button');buttons[0].props.onClick();assert.equal(calls.length,0);
    globalThis.confirm=()=>true;buttons[0].props.onClick();assert.equal(calls[0][0],'group.start');assert.deepEqual(calls[0][1],{id:'group',expectedVersion:3});
    group.status='paused';buttons=elements(DashboardGroupControls(props)).filter(e=>e.type==='button');buttons[0].props.onClick();assert.equal(calls[1][0],'group.resume');
    group.status='running';buttons=elements(DashboardGroupControls({...props,stale:true})).filter(e=>e.type==='button');assert.equal(buttons[1].props.disabled,false);buttons[1].props.onClick();assert.equal(calls[2][0],'group.stop');assert.deepEqual(calls[2][1],{id:'group',expectedVersion:3});
    assert.ok(calls.every(([action])=>action.startsWith('group.')));
  }finally{globalThis.confirm=previous;}
});

test('unknown stopped group cannot dispatch a new start and exposes execution history',async()=>{
  const {DashboardGroupControls}=await components(),{s,group}=fixture(),calls=[],pages=[];group.activeAttemptId='unknown';s.attempts=[{id:'unknown',status:'unknown',executionBlocked:true}];
  const buttons=elements(DashboardGroupControls({s,group,run:async(...args)=>calls.push(args),busy:false,stale:false,go:page=>pages.push(page)})).filter(e=>e.type==='button');
  assert.equal(buttons[0].props.disabled,true);buttons[0].props.onClick();assert.deepEqual(calls,[]);buttons.at(-1).props.onClick();assert.deepEqual(pages,['history']);
});

test('dashboard renders controls for every group with no manual service resume step',async()=>{
  const {Dashboard,renderToStaticMarkup}=await components(),{s,group}=fixture();s.service.status='resume_required';s.groups=Array.from({length:8},(_,index)=>({...group,id:'group'+index,name:'그룹 '+index,channelId:String(333+index)}));
  const html=renderToStaticMarkup(Dashboard({s,analytics:null,analyticsStatus:'loading',analyticsAt:0,retryAnalytics:()=>{},lastSeen:s.serverNow,period:'24h',setPeriod:()=>{},go:()=>{},run:async()=>true,busy:false,stale:false}));
  for(let index=0;index<8;index++)assert.ok(html.includes(`aria-label="그룹 ${index} 시작"`),`group ${index} start is available in the rendered dashboard`);
  assert.ok(!html.includes('서비스 재개'));
});
