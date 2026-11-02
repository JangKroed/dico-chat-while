import test from 'node:test';
import assert from 'node:assert/strict';
import {accountLabel,accountIdentity} from '../central/ui/src/account-label.ts';

const s={accounts:[{id:'a',instanceId:'browser',accountId:'123',name:'내가 정한 업무 계정'}],channels:[{id:'binding',instanceId:'browser',accountId:'123',name:'이것은 채널 이름'}]};
test('user account aliases identify attempts, bindings and accounts before raw IDs',()=>{
  assert.equal(accountLabel(s,{accountId:'123',instanceId:'browser'}),'내가 정한 업무 계정');
  assert.equal(accountLabel(s,{bindingId:'binding'}),'내가 정한 업무 계정');
  assert.equal(accountLabel(s,{accountEntityId:'a'}),'내가 정한 업무 계정');
  assert.equal(accountIdentity(s,{bindingId:'binding'}).accountId,'123');
});
test('the correct browser alias is used when a Discord account appears in multiple profiles',()=>{
  const multiple={...s,accounts:[...s.accounts,{id:'b',instanceId:'other',accountId:'123',name:'다른 프로필 별칭'}]};
  assert.equal(accountLabel(multiple,{accountId:'123',instanceId:'other'}),'다른 프로필 별칭');
  assert.equal(accountLabel(multiple,{accountId:'123',accountName:'관찰된 이름'}),'관찰된 이름');
});
test('observed account names and IDs are safe fallbacks, never channel names',()=>{
  assert.equal(accountLabel({accounts:[],channels:[]},{accountId:'456',accountName:'관찰된 Discord 이름'}),'관찰된 Discord 이름');
  assert.equal(accountLabel({accounts:[],channels:[]},{accountId:'456',name:'채널 이름'}),'456');
  assert.equal(accountLabel({accounts:[],channels:[]},{}),'계정 정보 없음');
});
test('logs resolve their account name through command, attempt or binding references',()=>{
  const events={...s,commands:[{id:'command',instanceId:'browser',payload:{accountId:'123'}}],attempts:[{id:'attempt',bindingId:'binding',accountId:'123'}]};
  assert.equal(accountLabel(events,{commandId:'command'}),'내가 정한 업무 계정');
  assert.equal(accountLabel(events,{attemptId:'attempt'}),'내가 정한 업무 계정');
  assert.equal(accountLabel(events,{channelId:'binding'}),'내가 정한 업무 계정');
});

test('automatic account labels prefer refreshed observed names while custom numeric aliases are respected',()=>{
  const snapshot={accounts:[{id:'a',instanceId:'browser',accountId:'123',name:'오래된 자동 이름',observedName:'최신 Discord 이름',username:'fresh.user',nameCustomized:false}],channels:[]};
  assert.equal(accountLabel(snapshot,{accountId:'123',instanceId:'browser'}),'최신 Discord 이름');
  snapshot.accounts[0].name='123';snapshot.accounts[0].nameCustomized=true;
  assert.equal(accountLabel(snapshot,{accountId:'123',instanceId:'browser'}),'123');
});
