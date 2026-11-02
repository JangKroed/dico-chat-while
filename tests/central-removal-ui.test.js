import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),require=createRequire(join(root,'central/ui/package.json'));
let loaded;
function components(){return loaded??=(async()=>{
  const {build}=require('esbuild');
  const result=await build({stdin:{contents:"export * from './src/RemovalActions.tsx';export {AccountConnections,ChannelSetup,BrowserConsolidateAction} from './src/App.tsx';export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';",resolveDir:join(root,'central/ui'),loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,plugins:[{name:'expose-components',setup(b){b.onLoad({filter:/\/App\.tsx$/},async({path})=>({contents:(await readFile(path,'utf8'))+'\nexport {AccountConnections,ChannelSetup,BrowserConsolidateAction};',loader:'tsx'}));}}]});
  const dir=await mkdtemp(join(tmpdir(),'dico-removal-ui-'));try{const file=join(dir,'component.cjs');await writeFile(file,result.outputFiles[0].contents);return require(file);}finally{await rm(dir,{recursive:true,force:true});}
})();}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){return{schemaVersion:1,stateVersion:1,messages:[],instances:[{id:'browser',name:'업무 Chrome',version:2,connected:true,lastSeenAt:Date.now(),capabilities:['managed-window-v1']}],accounts:[{id:'account',instanceId:'browser',accountId:'111',name:'호야',version:4,verified:true}],targets:[{id:'target',guildId:'222',channelId:'333',name:'공지',version:5}],channels:[{id:'binding',instanceId:'browser',accountId:'111',guildId:'222',channelId:'333',name:'공지',version:6,verified:true,tabId:10,playlist:[],playlistIndex:0,configVersion:1,appliedVersion:1,intervalMs:1000,slowmodeMs:0}],groups:[],attempts:[],incidents:[],events:[]};}

test('every removal requires scope confirmation and sends the exact versioned entity API',async()=>{
  const {RemovalAction}=await components(),before=globalThis.confirm;
  try{for(const kind of ['channel','target','account','instance']){
    const calls=[],confirmations=[];let removed=0;
    const button=RemovalAction({kind,id:'selected',version:7,name:'선택 항목',busy:false,run:async(...args)=>{calls.push(args);return true;},onRemoved:()=>removed++});
    globalThis.confirm=()=>false;button.props.onClick();await tick();assert.equal(calls.length,0);
    globalThis.confirm=text=>{confirmations.push(text);return true;};button.props.onClick();await tick();
    assert.equal(calls[0][0],`${kind}.delete`);assert.deepEqual(calls[0][1],{id:'selected',expectedVersion:7});assert.equal(removed,1);
    assert.match(confirmations[0],/오프라인 브라우저의 탭은 다음 연결 때 닫습니다/);assert.match(confirmations[0],/빈 그룹은 삭제/);
    if(kind==='channel')assert.match(confirmations[0],/해당 전송 탭만 닫습니다/);
  }}finally{globalThis.confirm=before;}
});

test('disabled, unsupported and failed removals never clear local selection',async()=>{
  const {RemovalAction}=await components(),before=globalThis.confirm;let calls=0,removed=0;globalThis.confirm=()=>true;
  try{for(const patch of [{busy:true},{version:undefined},{id:'legacy:old'}]){const button=RemovalAction({kind:'channel',id:'id',version:2,name:'채널',busy:false,run:async()=>{calls++;return true;},...patch});assert.equal(button.props.disabled,true);button.props.onClick();}await tick();assert.equal(calls,0);
    RemovalAction({kind:'target',id:'id',version:2,name:'채널',busy:false,run:async()=>false,onRemoved:()=>removed++}).props.onClick();await tick();assert.equal(removed,0);
  }finally{globalThis.confirm=before;}
});

test('target rename preserves version and ignores cancellation',async()=>{
  const {RenameTargetAction}=await components(),before=globalThis.prompt,calls=[];
  try{const button=RenameTargetAction({target:fixture().targets[0],busy:false,run:async(...args)=>calls.push(args)});globalThis.prompt=()=>null;button.props.onClick();assert.equal(calls.length,0);globalThis.prompt=()=>' 새 공지 ';button.props.onClick();assert.deepEqual(calls[0].slice(0,2),['target.update',{id:'target',expectedVersion:5,name:'새 공지'}]);}finally{globalThis.prompt=before;}
});

test('account and channel pages expose deletion controls and durable close status after binding removal',async()=>{
  const {AccountConnections,ChannelSetup,createElement,renderToStaticMarkup}=await components(),s=fixture();s.pendingTabCloses=[{removalId:'removed',instanceId:'gone',accountId:'444',guildId:'222',channelId:'555',accountName:'삭제 계정',channelName:'이전 채널',status:'rejected',rejectionCode:'TARGET_MISMATCH',createdAt:1}];
  const props={s,run:async()=>true,busy:false,go:()=>{}};
  const account=renderToStaticMarkup(createElement(AccountConnections,props));assert.match(account,/계정 삭제/);assert.match(account,/브라우저 삭제/);assert.match(account,/전송 창 하나로 모으기/);
  const channel=renderToStaticMarkup(createElement(ChannelSetup,props));assert.match(channel,/채널 이름 변경/);assert.match(channel,/채널 삭제/);assert.match(channel,/연결 해제/);assert.match(channel,/프로필마다 하나의 최소화된 창/);
  for(const html of [account,channel]){assert.match(html,/삭제 계정/);assert.match(html,/이전 채널/);assert.match(html,/TARGET_MISMATCH/);assert.match(html,/직접 닫고/);}
});

test('consolidation uses existing managed-window capability and refuses active groups',async()=>{
  const {BrowserConsolidateAction}=await components(),s=fixture(),calls=[],props={s,instance:s.instances[0],busy:false,run:async(...args)=>calls.push(args)};
  const button=BrowserConsolidateAction(props);assert.equal(button.props.disabled,false);button.props.onClick();assert.deepEqual(calls[0].slice(0,2),['channel.consolidate',{id:'binding'}]);
  s.groups=[{id:'group',members:['binding'],status:'running'}];assert.equal(BrowserConsolidateAction(props).props.disabled,true);
});
