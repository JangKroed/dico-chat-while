// Render production React components without a browser or any Discord connection.
// This checks markup/state contracts; it is not a visual browser acceptance test.
import {createRequire} from 'node:module';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const require=createRequire(join(root,'central/ui/package.json'));
const {build}=require('esbuild');
const contents=`
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {Dashboard} from './src/App.tsx';
import {ConnectionProgress} from './src/ConnectionProgress.tsx';
const now=Date.now();
const instances=['Brave','Chrome','Chrome'].map((browser,index)=>({id:'b'+index,name:'연결된 '+browser,browser,connected:true,lastSeenAt:now,legacyFrozen:true,legacyPending:false,capabilities:['managed-window-v1','early-prepare-v1'],extensionVersion:'0.4.7'}));
const accounts=instances.map((i,index)=>({id:'a'+index,instanceId:i.id,accountId:String(11111111111111111n+BigInt(index)),name:['브레이브 계정','업무 계정','테스트 계정'][index],version:1,verified:true}));
const targets=[{id:'t1',guildId:'guild',channelId:'channel',name:'테스트 채널'}];
const channels=accounts.map((a,index)=>({id:'c'+index,instanceId:a.instanceId,accountId:a.accountId,guildId:'guild',channelId:'channel',name:'테스트 채널',verified:true,tabId:index+1,version:1,configVersion:1,appliedVersion:1,playlist:[{messageId:'m1',revisionId:'r1'}],playlistIndex:0,intervalMs:63000,slowmodeMs:60000,slowmodeObservedAt:now,nextEligibleAt:now+63000}));
const snapshot={schemaVersion:1,stateVersion:1,serverNow:now,service:{status:'ready'},settings:{retentionDays:90,notificationsEnabled:false,hideNotificationNames:true},messages:[{id:'m1',name:'안내',body:'테스트',tags:[],archived:false,version:1,revisionId:'r1',createdAt:now,updatedAt:now,revisions:[{id:'r1',version:1,body:'테스트',at:now}]}],instances,accounts,targets,channels,groups:[{id:'g1',name:'순환 그룹',guildId:'guild',channelId:'channel',members:channels.map(c=>c.id),intervalMs:1000,version:1,status:'running',cursor:0,nextEligibleAt:now+63000}],attempts:[],incidents:[],events:[]};
const analytics={from:now-86400000,to:now,total:21,confirmed:21,outcomes:{confirmed:21},confirmedBuckets:[]};
const props={s:snapshot,analytics,analyticsStatus:'ready',analyticsAt:now,retryAnalytics:()=>{},lastSeen:now,period:'24h',setPeriod:()=>{},go:()=>{},run:async()=>true,busy:false,stale:false};
const html=renderToStaticMarkup(<Dashboard {...props}/>);
assert.ok(html.indexOf('stat-grid')>=0&&html.indexOf('stat-grid')<html.indexOf('aria-label="브라우저 연결 상태"'),'Operational summary must precede connection details');
const connections=renderToStaticMarkup(<ConnectionProgress s={snapshot}/>);
assert.ok(!connections.includes('연결된 Brave'));
assert.ok(connections.includes('업무 계정')&&connections.includes('테스트 계정'));
assert.ok(connections.includes('connection-steps'));
assert.ok(!connections.includes(' open=""'),'Ready connection details start collapsed');
assert.ok(!connections.includes('style='),'Connection layout must use responsive stylesheet classes');
const failed=renderToStaticMarkup(<Dashboard {...props} analytics={null} analyticsStatus="error"/>);
assert.ok(failed.includes('선택 기간 집계를 불러오지 못했습니다.'));
assert.ok(!failed.includes('class="chart-area"'),'Failed period request must not render a fabricated chart');
const loading=renderToStaticMarkup(<Dashboard {...props} analytics={null} analyticsStatus="loading"/>);
assert.ok(!loading.includes('class="chart-area"'),'Loading must not look like zero posts');
console.log('PASS production React SSR: operational hierarchy, compact ready state, account aliases, semantic progress, loading/error analytics');
`;
const result=await build({stdin:{contents,resolveDir:join(root,'central/ui'),sourcefile:'ux-check.tsx',loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,plugins:[{name:'dashboard-test-export',setup(builder){builder.onLoad({filter:/\/App\.tsx$/},async({path})=>({contents:(await readFile(path,'utf8'))+'\nexport {Dashboard};\n',loader:'tsx'}));}}]});
const directory=await mkdtemp(join(tmpdir(),'dico-ux-ssr-'));
try{const file=join(directory,'check.cjs');await writeFile(file,result.outputFiles[0].contents);require(file);}finally{await rm(directory,{recursive:true,force:true});}
