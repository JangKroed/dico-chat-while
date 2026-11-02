import test from 'node:test';
import assert from 'node:assert/strict';
import {createCentralManager} from '../central/core/index.js';
const url='https://discord.com/channels/222/333';
function fixture(capabilities=[]){const manager=createCentralManager({now:()=>1_800_000_000_000,monotonicNow:()=>1000}),session=manager.bridge({type:'HELLO',protocolVersion:1,capabilities});const observe=fields=>manager.bridge({type:'OBSERVATION',sessionId:session.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'111',guildId:'222',channelId:'333',tabId:1,verified:true,...fields}]},session.instanceId);return{manager,session,observe};}

test('URL-only target stays explicitly pending and receives the verified actual channel name',()=>{const f=fixture();try{
 const target=f.manager.execute('target.create',{url});assert.equal(target.name,'채널 이름 확인 대기');assert.equal(target.namePending,true);assert.equal(target.nameCustomized,false);assert.equal(f.manager.snapshot().channels.length,0);
 f.observe({channelName:'실제-모집방',name:'noisy title | server - Discord'});let s=f.manager.snapshot();assert.equal(s.targets[0].name,'실제-모집방');assert.equal(s.targets[0].namePending,false);assert.equal(s.channels[0].name,'실제-모집방');
 f.observe({channelName:'바뀐-채널'});s=f.manager.snapshot();assert.equal(s.targets[0].name,'바뀐-채널');assert.equal(s.channels[0].name,'바뀐-채널');
 assert.equal(s.attempts.length,0);
}finally{f.manager.close();}});

test('explicit target and binding aliases survive later actual-name observations',()=>{const f=fixture();try{
 f.manager.execute('target.create',{url,name:'내 채널 별칭'});f.observe({channelName:'실제-이름'});let c=f.manager.snapshot().channels[0];f.manager.execute('channel.update',{id:c.id,expectedVersion:c.version,name:'이 계정의 채널 별칭'});f.observe({channelName:'새-실제-이름'});const s=f.manager.snapshot();assert.equal(s.targets[0].name,'내 채널 별칭');assert.equal(s.channels[0].name,'이 계정의 채널 별칭');assert.equal(s.targets[0].observedName,'새-실제-이름');
}finally{f.manager.close();}});

test('unverified, numeric IDs and raw document title noise do not become resolved channel names',()=>{const f=fixture();try{
 f.manager.execute('target.create',{url});for(const fields of [{verified:false,channelName:'검증되지 않음'},{name:'333'},{name:'(4) #모집방 | 서버 - Discord'},{name:'(49) Discord | #테스트1 | OpenClaw'},{name:'Discord'},{channelName:'x'.repeat(101)}])f.observe(fields);
 const s=f.manager.snapshot();assert.equal(s.targets[0].namePending,true);assert.equal(s.targets[0].name,'채널 이름 확인 대기');assert.equal(s.channels[0].name,'채널 이름 확인 대기');
}finally{f.manager.close();}});

test('automatic names remain automatic after backup restore while old ID names become pending',()=>{const f=fixture();try{
 f.manager.execute('target.create',{url});f.observe({channelName:'처음-이름'});const backup=f.manager.exportBackup();assert.equal(backup.targets[0].nameCustomized,false);assert.equal(backup.channels[0].nameCustomized,false);
 f.manager.importBackup(backup);const session=f.manager.bridge({type:'HELLO',protocolVersion:1,instanceId:f.session.instanceId});f.manager.bridge({type:'OBSERVATION',sessionId:session.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId:'111',guildId:'222',channelId:'333',tabId:1,verified:true,channelName:'복원-후-이름'}]},session.instanceId);assert.equal(f.manager.snapshot().targets[0].name,'복원-후-이름');
 const old=f.manager.exportBackup();for(const item of [...old.targets,...old.channels]){item.name='333';delete item.nameCustomized;delete item.namePending;delete item.observedName;}f.manager.importBackup(old);assert.equal(f.manager.snapshot().targets[0].name,'채널 이름 확인 대기');assert.equal(f.manager.snapshot().channels[0].name,'채널 이름 확인 대기');
}finally{f.manager.close();}});

test('URL creation can request a read-only exact-target name lookup without creating a binding or send',()=>{const f=fixture(['channel-name-lookup-v1']);try{
 const target=f.manager.execute('target.create',{url}),commands=f.manager.commands(f.session.instanceId);assert.equal(commands.length,1);const command=commands[0];assert.equal(command.type,'LOOKUP_CHANNEL_NAME');assert.deepEqual(command.payload,{targetId:target.id,guildId:'222',channelId:'333'});
 f.manager.execute('target.create',{url});assert.equal(f.manager.commands(f.session.instanceId).length,1);
 f.manager.bridge({type:'ACK',sessionId:f.session.sessionId,commandId:command.id,status:'applied',channelName:'기존-탭-이름'},f.session.instanceId);const s=f.manager.snapshot();assert.equal(s.targets[0].name,'기존-탭-이름');assert.equal(s.channels.length,0);assert.equal(s.attempts.length,0);assert.equal(s.groups.length,0);
}finally{f.manager.close();}});
