import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagedWindowController} from '../central/extension/managed-windows.js';
import {createCentralExecutor} from '../central/extension/executor.js';
const target={bindingId:'binding',accountId:'123456789012345678',guildId:'111',channelId:'222',tabId:7};
function fixture(){
 const saved={dicoCentralTabs:[{...target,windowId:5},{...target,bindingId:'other',channelId:'333',tabId:8,windowId:5}]},tabs=new Map([[7,{id:7,windowId:5,url:'https://discord.com/channels/111/222'}],[8,{id:8,windowId:5,url:'https://discord.com/channels/111/333'}]]),removed=[];
 const chrome={storage:{local:{get:async()=>structuredClone(saved),set:async value=>Object.assign(saved,structuredClone(value))}},tabs:{get:async id=>{if(!tabs.has(id))throw Error('missing');return {...tabs.get(id)};},remove:async id=>{removed.push(id);tabs.delete(id);}},windows:{remove:async()=>{throw Error('must never remove whole window');}}};
 return{chrome,saved,tabs,removed,manage:createManagedWindowController({chrome})};
}
test('disconnect closes only the exact managed channel tab in a shared window',async()=>{
 const r=fixture();await r.manage({...target,action:'close'});
 assert.deepEqual(r.removed,[7]);assert.equal(r.tabs.has(8),true);assert.deepEqual(r.saved.dicoCentralTabs.map(record=>record.tabId),[8]);
 await r.manage({...target,action:'close'});assert.deepEqual(r.removed,[7]);
});
test('a navigated tab is detached successfully and repeat cleanup is idempotent',async()=>{
 const r=fixture();r.tabs.get(7).url='https://example.com';
 assert.equal((await r.manage({...target,action:'close'})).detached,true);
 assert.deepEqual(r.removed,[]);assert.deepEqual(r.saved.dicoCentralTabs.map(record=>record.tabId),[8]);
 assert.equal((await r.manage({...target,action:'close'})).detached,true);
});
test('tab removal failure remains retryable and retains the registered ownership record',async()=>{
 const r=fixture();r.chrome.tabs.remove=async()=>{throw Error('browser refused');};
 await assert.rejects(r.manage({...target,action:'close'}));assert.equal(r.saved.dicoCentralTabs.length,2);
});
test('unknown ownership and mismatching account never close a live tab even at the same URL',async()=>{
 const r=fixture();await assert.rejects(r.manage({...target,accountId:'other',action:'close'}),{code:'WINDOW_NOT_DEDICATED'});assert.deepEqual(r.removed,[]);assert.equal(r.saved.dicoCentralTabs.length,2);
});
test('executor close command acknowledges only after exact binding and local record cleanup',async()=>{
 const r=fixture(),reports=[];const transport={connected:true,request:async message=>{reports.push(message);return{ok:true};}};
 const executor=createCentralExecutor({chrome:r.chrome,transport,manageChannelWindow:r.manage});await executor.load();
 Object.assign(executor.state,{instanceId:'instance',sessionId:'session',bindings:{binding:{...target},other:{...target,channelId:'333',tabId:8}}});
 await executor.handleCommand({id:'close',type:'CLOSE_CHANNEL',instanceId:'instance',sessionId:'session',payload:target});
 assert.deepEqual(r.removed,[7]);assert.equal(executor.state.bindings.binding,undefined);assert.ok(executor.state.bindings.other);assert.ok(reports.some(message=>message.type==='ACK'&&message.status==='applied'));
});
test('executor refuses to close a channel with an unresolved send',async()=>{
 const r=fixture(),reports=[];const executor=createCentralExecutor({chrome:r.chrome,transport:{connected:true,request:async message=>{reports.push(message);return{ok:true};}},manageChannelWindow:r.manage});await executor.load();
 Object.assign(executor.state,{instanceId:'instance',sessionId:'session',attempts:{attempt:{...target,phase:'unknown'}},bindings:{binding:{...target}}});
 await executor.handleCommand({id:'close',type:'CLOSE_CHANNEL',instanceId:'instance',sessionId:'session',payload:target});
 assert.deepEqual(r.removed,[]);assert.ok(reports.some(message=>message.status==='rejected'&&message.rejectionCode==='ATTEMPT_UNRESOLVED'));
});

test('a pending-open cleanup resolves its tab only from the exact saved managed target',async()=>{
 const r=fixture();await r.manage({action:'close',accountId:target.accountId,guildId:target.guildId,channelId:target.channelId});
 assert.deepEqual(r.removed,[7]);assert.equal(r.tabs.has(8),true);
 await r.manage({action:'close',accountId:'absent',guildId:'111',channelId:'222'});assert.deepEqual(r.removed,[7]);
});
test('multiple queued close commands follow pending channel opens and do not reject each other as busy',async()=>{
 const r=fixture(),reports=[];const first={accountId:target.accountId,guildId:'111',channelId:'222'},second={...first,channelId:'333'};
 const executor=createCentralExecutor({chrome:r.chrome,transport:{connected:true,request:async message=>{reports.push(message);return{ok:true};}},openChannel:async()=>{await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(r.removed,[]);},manageChannelWindow:r.manage});
 await executor.load();Object.assign(executor.state,{instanceId:'instance',sessionId:'session',bindings:{binding:{...target},other:{...target,channelId:'333',tabId:8}}});
 const command=(id,type,payload)=>({id,type,payload,instanceId:'instance',sessionId:'session'});
 await Promise.all([executor.handleCommand(command('open','OPEN_CHANNEL',first)),executor.handleCommand(command('close-one','CLOSE_CHANNEL',first)),executor.handleCommand(command('close-two','CLOSE_CHANNEL',second))]);
 assert.deepEqual(r.removed,[7,8]);assert.deepEqual(executor.state.bindings,{});assert.equal(reports.filter(message=>message.status==='rejected').length,0);
});
test('another Discord channel is preserved while the removed connection completes',async()=>{
 const r=fixture();r.tabs.get(7).url='https://discord.com/channels/111/999';
 assert.equal((await r.manage({...target,action:'close'})).detached,true);assert.deepEqual(r.removed,[]);assert.equal(r.saved.dicoCentralTabs.some(record=>record.tabId===7),false);
});

test('입력 차단을 확인한 미확인 시도만 기록을 유지하며 연결 해제할 수 있다',async()=>{
 for(const blocked of [false,true]){
  const r=fixture(),reports=[];const executor=createCentralExecutor({chrome:r.chrome,transport:{connected:true,request:async m=>{reports.push(m);return{ok:true};}},manageChannelWindow:r.manage});await executor.load();
  Object.assign(executor.state,{instanceId:'instance',sessionId:'session',bindings:{binding:{...target}},attempts:{a:{...target,phase:'unknown',result:{outcome:'unknown',executionBlocked:blocked}}}});
  await executor.handleCommand({id:'close-unknown',type:'CLOSE_CHANNEL',instanceId:'instance',sessionId:'session',payload:target});
  assert.equal(r.removed.length,blocked?1:0);assert.equal(executor.state.attempts.a.result.outcome,'unknown');
  assert.ok(reports.some(m=>m.type==='ACK'&&m.status===(blocked?'applied':'rejected')));
 }
});

 test('같은 URL이어도 소유 기록이 이미 사라진 탭은 닫지 않고 연결 해제를 완료한다',async()=>{
 const r=fixture();r.saved.dicoCentralTabs=r.saved.dicoCentralTabs.filter(x=>x.tabId!==7);
 const result=await r.manage({...target,action:'close'});
 assert.equal(result.detached,true);assert.deepEqual(r.removed,[]);assert.equal(r.tabs.has(7),true);
 });

test('연결 해제 직전 중앙 종료 기록을 대조하여 오래된 로컬 준비 상태를 정리한다',async()=>{
 const r=fixture(),reports=[];
 const executor=createCentralExecutor({chrome:r.chrome,transport:{connected:true,request:async m=>{reports.push(m);return m.type==='HEARTBEAT'?{ok:true,terminalAttempts:[{attemptId:'a',status:'not_sent'}]}:{ok:true};}},manageChannelWindow:r.manage});await executor.load();
 Object.assign(executor.state,{instanceId:'instance',sessionId:'session',bindings:{binding:{...target}},attempts:{a:{...target,attemptId:'a',phase:'preparing'}}});
 await executor.handleCommand({id:'close-stale',type:'CLOSE_CHANNEL',instanceId:'instance',sessionId:'session',payload:target});
 assert.deepEqual(r.removed,[7]);assert.equal(executor.state.attempts.a.phase,'not_sent');assert.ok(reports.some(m=>m.status==='applied'));
});
