import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCentralManager} from '../central/core/index.js';
import {createCentralExecutor} from '../central/extension/executor.js';
import {startCentralRuntime,acquireLock} from '../central/runtime/main.mjs';

test('실제 중앙 코어와 세 확장 실행기를 연결해 A B C 순환·중지·허가 검사를 확인한다',async()=>{
  let time=100000;const manager=createCentralManager({now:()=>time,monotonicNow:()=>time}),clients=[],order=[];
  const guildId='11111111111111111',channelId='22222222222222222';
  try {
    for(let i=0;i<3;i++) {
      let stored;const accountId=String(33333333333333333n+BigInt(i)),tabId=i+1;
      const hello=manager.bridge({type:'HELLO',protocolVersion:1,name:`검증용 가상 브라우저 ${i}`});
      manager.bridge({type:'OBSERVATION',sessionId:hello.sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId,guildId,channelId,tabId,verified:true,name:'검증 채널'}]},hello.instanceId);
      const transport={connected:true,request:async message=>manager.bridge(message,hello.instanceId)};
      let executor;
      const chrome={storage:{local:{get:async()=>({dicoCentral:structuredClone(stored)}),set:async v=>{stored=structuredClone(v.dicoCentral);}}},tabs:{get:async()=>({id:tabId,url:`https://discord.com/channels/${guildId}/${channelId}`}),sendMessage:async(id,m)=>{
        const allowed=await executor.canSend({id:m.delivery.id,phase:m.type==='DICO_PREPARE'?'prepare':'commit'},id);
        assert.equal(allowed,true,'현재 중앙 상태에서도 허가돼야 함');
        if(m.type==='DICO_PREPARE')return {status:'prepared'};
        order.push(i);return {status:'confirmed',messageId:String(44444444444444444n+BigInt(order.length))};
      }}};
      executor=createCentralExecutor({chrome,transport,now:()=>time});await executor.load();await executor.setSession(hello);
      clients.push({executor,hello});
    }
    const message=manager.execute('message.create',{name:'검증용 메시지',body:'실제 Discord로 보내지 않는 검증 문구'});
    for(const channel of manager.snapshot().channels) {
      manager.execute('channel.update',{id:channel.id,expectedVersion:channel.version,intervalMs:3000});
      const current=manager.snapshot().channels.find(c=>c.id===channel.id);
      manager.execute('channel.applyPlaylist',{id:channel.id,expectedVersion:current.version,items:[{messageId:message.id}]});
    }
    async function drain() {
      for(let pass=0;pass<10;pass++) {
        let handled=0;
        for(const client of clients)for(const command of manager.commands(client.hello.instanceId)){await client.executor.handleCommand(command);handled++;}
        if(!handled)break;
      }
    }
    await drain();
    const group=manager.execute('group.create',{name:'가상 3계정 순환',members:manager.snapshot().channels.map(c=>c.id),intervalMs:0});
    manager.execute('group.start',{id:group.id,expectedVersion:group.version});
    for(let n=0;n<36;n++) {
      time+=1000;
      for(const c of clients)manager.bridge({type:'HEARTBEAT',sessionId:c.hello.sessionId},c.hello.instanceId);
      manager.tick();await drain();
    }
    assert.equal(order.length,36);assert.ok(order.every((account,index)=>account===index%3));
    assert.ok(manager.snapshot().attempts.every(a=>a.status==='confirmed'));
    manager.execute('group.stop',{id:group.id});await drain();
    assert.equal(manager.snapshot().groups[0].status,'stopped');
    time+=1000;manager.tick();await drain();assert.equal(order.length,36);
  } finally {manager.close();}
});

test('실제 loopback 세션·UI·SQLite 단일 실행과 정상 종료 표식을 검증한다',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dico-live-runtime-'));let runtime;
  t.after(async()=>{await runtime?.close();await rm(directory,{recursive:true,force:true});});
  runtime=await startCentralRuntime({directory});
  assert.equal((await fetch(runtime.url+'/api/snapshot')).status,401);
  assert.equal((await fetch(runtime.url)).status,200);
  await assert.rejects(()=>acquireLock(directory));
  const token=runtime.app.issueBootstrap();
  const response=await fetch(runtime.url+'/api/session',{method:'POST',headers:{Origin:runtime.url,'Content-Type':'application/json'},body:JSON.stringify({token})});
  const {csrfToken}=await response.json(),cookie=response.headers.get('set-cookie').split(';')[0];
  const created=await fetch(runtime.url+'/api/command',{method:'POST',headers:{Origin:runtime.url,'Content-Type':'application/json',Cookie:cookie,'X-Dico-CSRF':csrfToken},body:JSON.stringify({action:'message.create',payload:{name:'로컬 HTTP 검증',body:'테스트'}})});
  assert.equal(created.status,200);assert.equal((await created.json()).snapshot.messages.length,1);
  if(process.platform!=='win32')assert.equal((await stat(directory)).mode&0o777,0o700);
  await runtime.close();runtime=null;
  assert.ok(await stat(join(directory,'shutdown.json')));
});
