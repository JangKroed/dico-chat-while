import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverConnections} from '../central/extension/connection-recovery.js';

function fixture(){
  const record={accountId:'12345678901234567',guildId:'222',channelId:'333',tabId:1};
  const state={legacyDeclaration:'fresh',emergencyStopped:false,attempts:{}},opened=[],progress=[];
  return{state,opened,progress,chrome:{storage:{local:{get:async()=>({dicoCentralAccount:{accountId:record.accountId,sourceTabId:9},dicoCentralTabs:[record]})}},tabs:{get:async()=>{throw Error('missing');}}},findAccount:async()=>({verified:true,accountId:record.accountId,tabId:9}),openChannel:async channel=>opened.push(channel),report:async item=>progress.push(item)};
}

test('an unresolved attempt appearing during tab lookup prevents automatic replacement',async()=>{
  const f=fixture();
  f.chrome.tabs.get=async()=>{f.state.attempts.late={phase:'unknown'};throw Error('missing');};
  await recoverConnections(f);
  assert.equal(f.opened.length,0);
  assert.equal(f.progress.at(-1).stage,'blocked');
});

test('emergency stop during recovery prevents opening the next missing tab',async()=>{
  const f=fixture();
  f.chrome.tabs.get=async()=>{f.state.emergencyStopped=true;throw Error('missing');};
  await recoverConnections(f);
  assert.equal(f.opened.length,0);
  assert.equal(f.progress.at(-1).stage,'blocked');
});
