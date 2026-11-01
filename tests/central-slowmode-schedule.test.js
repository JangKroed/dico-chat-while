import test from 'node:test';
import assert from 'node:assert/strict';
import {createCentralManager} from '../central/core/index.js';

test('two channel groups independently preserve Brave/Chrome order and each account cooldown',()=>{
 let time=100000;const manager=createCentralManager({now:()=>time,monotonicNow:()=>time});const sessions=[],posts=[];
 try{
  const guildId='111111111111111111',targets=['222222222222222221','222222222222222222'];
  for(const [browser,accountId]of [['Brave','333333333333333331'],['Chrome','333333333333333332']]){
   const hello=manager.bridge({type:'HELLO',protocolVersion:1,name:browser,browser});sessions.push({...hello,accountId});
   manager.bridge({type:'OBSERVATION',sessionId:hello.sessionId,legacyFrozen:true,legacyPending:false,channels:targets.map((channelId,index)=>({accountId,guildId,channelId,name:`test${index+1}`,tabId:posts.length+index+1,verified:true,slowmodeMs:index?120000:60000}))},hello.instanceId);
  }
  for(const c of manager.snapshot().channels){
   const browser=manager.snapshot().instances.find(i=>i.id===c.instanceId).browser;
   const names=browser==='Brave'?['111','222']:['333','444'];
   const items=names.map(name=>({messageId:manager.execute('message.create',{name,body:name}).id}));
   manager.execute('channel.applyPlaylist',{id:c.id,expectedVersion:c.version,items});
  }
  for(const s of sessions)for(const c of manager.commands(s.instanceId).filter(c=>c.type==='CONFIG_SYNC'))manager.bridge({type:'ACK',sessionId:s.sessionId,commandId:c.id,status:'applied'},s.instanceId);
  for(const channelId of targets){const members=manager.snapshot().channels.filter(c=>c.channelId===channelId).map(c=>c.id);const g=manager.execute('group.create',{name:channelId,members,intervalMs:1000});manager.execute('group.start',{id:g.id});}
  for(let tick=0;tick<=130;tick++){
   for(const s of sessions)manager.bridge({type:'HEARTBEAT',sessionId:s.sessionId},s.instanceId);
   manager.tick();
   for(const s of sessions)for(const cmd of manager.commands(s.instanceId).filter(c=>c.type==='PREPARE')){
    const p=cmd.payload;manager.bridge({type:'PREPARED',sessionId:s.sessionId,attemptId:p.attemptId,configVersion:p.configVersion,accountId:p.accountId,channelId:p.channelId,draftClear:true},s.instanceId);
    const permit=manager.commands(s.instanceId).find(c=>c.type==='COMMIT_PERMIT'&&c.payload.attemptId===p.attemptId);assert.ok(permit);
    posts.push({channelId:p.channelId,accountId:p.accountId,body:p.body,at:time-100000});
    manager.bridge({type:'DELIVERY_RESULT',sessionId:s.sessionId,attemptId:p.attemptId,outcome:'confirmed',messageId:String(444444444444444440n+BigInt(posts.length))},s.instanceId);
   }
   time+=1000;
  }
  assert.deepEqual(posts.filter(p=>p.channelId===targets[0]).map(p=>[p.at,p.body]),[[0,'111'],[1000,'333'],[63000,'222'],[64000,'444'],[126000,'111'],[127000,'333']]);
  assert.deepEqual(posts.filter(p=>p.channelId===targets[1]).map(p=>[p.at,p.body]),[[0,'111'],[1000,'333'],[123000,'222'],[124000,'444']]);
 }finally{manager.close();}
});
