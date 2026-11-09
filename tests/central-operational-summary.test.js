import test from 'node:test';
import assert from 'node:assert/strict';
import {operationalSummary,groupOperation} from '../central/ui/src/operational-summary.ts';
const snapshot=()=>({serverNow:10000,groups:[],channels:[],accounts:[],instances:[],attempts:[],messages:[],incidents:[],events:[]});
test('operational totals use snapshot confirmed records and fresh verified accounts',()=>{const s=snapshot();s.instances=[{id:'b',connected:true,lastSeenAt:10000}];s.accounts=[{id:'a',instanceId:'b',verified:true},{id:'x',instanceId:'b',verified:false}];s.attempts=[{status:'confirmed'},{status:'unknown'}];s.groups=[{id:'g',status:'running'},{id:'p',status:'paused'}];const result=operationalSummary(s);assert.equal(result.running,1);assert.equal(result.connectedAccounts,1);assert.equal(result.confirmed,1);assert.equal(operationalSummary(s,true).connectedAccounts,0)});
test('next dispatch ignores paused deadlines and chooses earliest running schedule',()=>{const s=snapshot();s.groups=[{id:'paused',status:'paused',nextEligibleAt:10001},{id:'later',status:'running',nextEligibleAt:40000},{id:'next',status:'running',nextEligibleAt:20000}];assert.equal(operationalSummary(s).nextGroup.id,'next');assert.equal(operationalSummary(s,true).nextGroup,undefined)});
test('group row follows persisted cursor and playlist without inventing a missing next account',()=>{const s=snapshot();s.channels=[{id:'a',name:'모집',playlist:[{messageId:'m'}],playlistIndex:0},{id:'b',name:'모집',playlist:[],playlistIndex:0}];s.messages=[{id:'m',name:'첫 공지'}];const group={members:['a','b'],cursor:2};let row=groupOperation(s,group);assert.equal(row.current.id,'a');assert.equal(row.next.id,'b');assert.equal(row.messageTitle,'첫 공지');assert.equal(groupOperation(s,{members:[],cursor:0}).current,undefined);assert.equal(groupOperation(s,{members:['a'],cursor:0}).next.id,'a')});

test('계정은 Discord ID로 집계하고 비활성 그룹과 미확인 기록을 구분한다',()=>{
 const s=snapshot();s.instances=[{id:'a',connected:true,lastSeenAt:10000},{id:'b',connected:true,lastSeenAt:10000}];
 s.accounts=[{id:'old',accountId:'111',instanceId:'a',verified:false},{id:'new',accountId:'111',instanceId:'b',verified:true},{id:'second',accountId:'222',instanceId:'a',verified:true}];
 s.groups=[{id:'active',status:'running'},{id:'off',status:'stopped',enabled:false}];s.attempts=[{status:'confirmed'},{status:'unknown',detached:true}];
 const result=operationalSummary(s);assert.equal(result.totalAccounts,2);assert.equal(result.connectedAccounts,2);assert.equal(result.enabledGroups,1);assert.equal(result.disabledGroups,1);assert.equal(result.unconfirmed,1);
});
