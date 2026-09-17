import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {channelDiagnostic,diagnosticTextContext} from '../diagnostics.js';

test('다운로드 파일에 채널·실제 탭·알람·보존 타임라인을 넣고 문구는 포함하고 인증정보는 제외한다',async()=>{
 let click,report;
 const status={};
 const channels=[{id:'a',intervalSeconds:63,messages:['공지 A 💰','공지 B :moneybag:'],ownUserId:'SECRET',target:{tabId:7,channelId:'456',guildId:'123',title:'SECRET'}},{id:'b',intervalSeconds:123,target:{tabId:8,channelId:'789',guildId:'123'}}];
 const code=readFileSync(new URL('../diagnostic-settings.js',import.meta.url),'utf8').replace(/^import .*;\n/,'');
 runInNewContext(code,{
  readDiagnosticArchive:async()=>[{kind:"archived"}],channelDiagnostic,diagnosticTextContext,JSON,Date,Promise,setTimeout:()=>{},navigator:{userAgent:'test'},
  document:{querySelector:selector=>selector==='#download-diagnostics'?{addEventListener:(_,fn)=>click=fn}:status,createElement:()=>({click(){}})},
  Blob:class{constructor(parts){report=JSON.parse(parts[0]);}},URL:class extends URL{static createObjectURL(){return 'blob:test';}},
  chrome:{runtime:{getManifest:()=>({version:'test'})},storage:{local:{get:async()=>({state:{revision:8,channels},diagnosticLog:[{kind:'recent'}],diagnosticTimeline:[{kind:'settings-changed'}],mailConfig:{key:'SECRET'}})}},
   alarms:{getAll:async()=>[{name:'dico-channel:a',scheduledTime:1000},{name:'mail',scheduledTime:2000}]},
   tabs:{get:async id=>{if(id===8)throw Error('closed');return {url:'https://discord.com/channels/123/999',status:'complete',active:false,discarded:false,windowId:4};}}}
 });
 await click();
 assert.equal(report.channels[0].textContext.messageA,'공지 A 💰');assert.equal(report.channels[0].textContext.messageB,'공지 B :moneybag:');
 assert.equal(report.archive[0].kind,"archived");assert.equal(report.schemaVersion,5);assert.equal(report.channels[0].discordChannelId,'456');assert.equal(report.tabs[0].observedChannelId,'999');
 assert.equal(report.tabs[1].unavailable,true);assert.equal(report.alarms.length,1);assert.equal(report.alarms[0].channelKey,'a');
 assert.equal(report.timeline[0].kind,'settings-changed');assert.equal(JSON.stringify(report).includes('SECRET'),false);
 assert.match(status.textContent,/저장했습니다/);
});

test('실제 팝업 기록 함수는 선택 변경과 화면의 주기 값을 전달하고 초 단위 중복 기록을 줄인다',()=>{
 const source=readFileSync(new URL('../ui.js',import.meta.url),'utf8');
 const code=source.slice(source.indexOf("let lastScheduleTraceKey="),source.indexOf('function renderSchedule()'));
 const sent=[];
 const ctx={rootState:{revision:9},loadedBase:{channelId:'b'},elements:{interval:{value:'123'}},isDirty:()=>true,sendMessage:(_,m)=>{sent.push(m);return Promise.resolve();},Date,JSON,Number,Math};
 runInNewContext(code+"\nconst channel={id:'a',settingsRevision:2,intervalSeconds:63,nextRunAt:Date.now()+63000,target:{channelId:'456'}};reportScheduleDisplay(channel);reportScheduleDisplay(channel);",ctx);
 assert.equal(sent.length,1);assert.equal(sent[0].channelKey,'a');assert.equal(sent[0].formChannelKey,'b');assert.equal(sent[0].displayedIntervalSeconds,123);assert.equal(sent[0].displayedDiscordChannelId,'456');assert.equal(sent[0].draftDirty,true);
});
