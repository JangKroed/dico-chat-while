import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
test('로그·OS 알림 응답이 끝나지 않아도 상태 저장과 전송 준비를 계속한다',async()=>{
 const source=readFileSync(new URL('../background.js',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('  save: async state => {')+'  save: async state => {'.length,source.indexOf('  schedule: async'));
 let saved,logged=false;
 const save=runInNewContext('(async state=>{'+body.slice(0,body.lastIndexOf('  },'))+'})',{
 autoUpdater:undefined,chrome:{storage:{local:{get:async()=>({state:{channels:[]}}),set:async v=>saved=v.state}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}},
 recordDiagnostics:()=>{logged=true;return new Promise(()=>{});},notifyChannelErrors:()=>new Promise(()=>{}),console,
 });
 await Promise.race([save({channels:[]}),new Promise((_,reject)=>setTimeout(()=>reject(Error('blocked by logging')),200))]);
 assert.ok(saved);assert.ok(logged);
});
