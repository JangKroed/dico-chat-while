import test from 'node:test';
import assert from 'node:assert/strict';
import {createCentralManager} from '../central/core/index.js';

test('2개 채널·2개 계정·문구 순서와 20초 간격을 120회 반복한다',{timeout:20000},t=>{
 let wall=1800000000000,mono=1000;
 const manager=createCentralManager({now:()=>wall,monotonicNow:()=>mono});t.after(()=>manager.close());
 const peers=['A','B'].map(accountId=>({...manager.bridge({type:'HELLO',protocolVersion:1,capabilities:['early-prepare-v1']}),accountId}));
 const observe=()=>{for(const p of peers)manager.bridge({type:'OBSERVATION',sessionId:p.sessionId,legacyFrozen:true,legacyPending:false,channels:['x','y'].map((channelId,n)=>({accountId:p.accountId,guildId:'g',channelId,tabId:(p.accountId==='A'?1:3)+n,verified:true,slowmodeMs:0}))},p.instanceId);};
 const send=(a,message)=>{const p=peers.find(p=>p.instanceId===a.instanceId);return manager.bridge({sessionId:p.sessionId,...message},p.instanceId);};
 observe();const messages=[0,1].map(n=>manager.execute('message.create',{name:'fixture-'+n,body:'synthetic-'+n}));
 for(const c of manager.snapshot().channels)manager.execute('channel.applyPlaylist',{id:c.id,expectedVersion:c.version,items:messages.map(m=>({messageId:m.id}))});
 for(const p of peers)for(const c of manager.commands(p.instanceId))manager.bridge({type:'ACK',sessionId:p.sessionId,commandId:c.id,status:'applied'},p.instanceId);
 const groups=['x','y'].map(channelId=>manager.execute('group.create',{name:channelId,members:peers.map(p=>manager.snapshot().channels.find(c=>c.accountId===p.accountId&&c.channelId===channelId).id),intervalMs:20000}));
 for(const g of groups)manager.execute('group.start',{id:g.id});
 const advance=ms=>{while(ms>0){const step=Math.min(1000,ms);ms-=step;wall+=step;mono+=step;observe();manager.tick();}};
 const prepared=a=>send(a,{type:'PREPARED',attemptId:a.id,accountId:a.accountId,channelId:a.channelId,configVersion:a.configVersion,draftClear:true,cooldownMs:0});
 const permit=a=>send(a,{type:'AUTHORIZE_ENTER',attemptId:a.id,runId:a.runId,configVersion:a.configVersion,retryCount:0});
 let lastCompleted=null;const enterTimes=new Map(),counts=new Map();
 for(let round=0;round<60;round++){
  if(round){
   for(const g of manager.snapshot().groups){assert.equal(g.intervalMs,20000);assert.equal(g.nextEligibleAt,lastCompleted+20000);}
   advance(15000);
  }else manager.tick();
  const pending=manager.snapshot().attempts.filter(a=>a.status==='preparing');assert.equal(pending.length,2);
  for(const a of pending){
   assert.equal(a.accountId,peers[round%2].accountId);assert.equal(a.messageIdRef,messages[Math.floor(round/2)%2].id);
   if(round){assert.equal(a.createdAt,lastCompleted+15000);assert.equal(prepared(a).permitIssued,false);assert.equal(permit(a).allowed,false);}
  }
  if(round){advance(4999);for(const a of pending){assert.equal(prepared(a).permitIssued,false);assert.equal(permit(a).allowed,false);}advance(1);}
  for(const a of pending){assert.ok(prepared(a).permitId);assert.equal(permit(a).allowed,true);const previous=enterTimes.get(a.groupId);if(previous!==undefined)assert.ok(wall-previous>=20000);enterTimes.set(a.groupId,wall);}
  // 처리 지연 뒤에도 마지막 완료부터 다음 간격을 지키고 밀린 발송을 따라잡지 않습니다.
  advance(round%3*200);
  for(const a of pending){send(a,{type:'DELIVERY_RESULT',attemptId:a.id,outcome:'confirmed',messageId:'synthetic-'+round+'-'+a.channelId});counts.set(a.groupId,(counts.get(a.groupId)||0)+1);}
  lastCompleted=wall;
 }
 const s=manager.snapshot();assert.equal(s.attempts.filter(a=>a.status==='confirmed').length,120);assert.deepEqual([...counts.values()],[60,60]);assert.equal(s.incidents.length,0);
 for(const g of groups)manager.execute('group.stop',{id:g.id});
 const last=s.attempts.at(-1);assert.equal(permit(last).allowed,false);
 t.diagnostic('모의 Enter 승인 120회: 계정·문구 순서, 15000ms 준비, 19999ms 차단, 20000ms 허가, 지연 후 간격 유지');
});
