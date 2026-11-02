import test from 'node:test';
import assert from 'node:assert/strict';
import {channelAccountOrder} from '../central/ui/src/channel-order.ts';

const target={guildId:'guild',channelId:'channel'};
function fixture(){return{channels:['coke','123','jang','extra'].map(id=>({id,...target})),groups:[{id:'group',name:'그룹',...target,members:['jang','123','coke'],cursor:0,status:'running'}]};}

test('channel account rows follow configured order rather than connection discovery or current cursor',()=>{
  const s=fixture();s.groups[0].cursor=2;
  const result=channelAccountOrder(s,target),rows=result.groups[0].entries;
  assert.deepEqual(rows.map(row=>row.binding.id),['jang','123','coke']);assert.deepEqual(rows.map(row=>row.order),[1,2,3]);assert.deepEqual(rows.filter(row=>row.current).map(row=>row.binding.id),['coke']);
  assert.deepEqual(result.ungrouped.map(c=>c.id),['extra']);assert.deepEqual(s.channels.map(c=>c.id),['coke','123','jang','extra']);
});

test('missing or wrong-channel members retain their configured positions without showing unrelated bindings',()=>{
  const s=fixture();s.groups[0].members=['jang','missing','foreign','coke'];s.groups[0].cursor=1;s.channels.push({id:'foreign',guildId:'another',channelId:'elsewhere'});
  const result=channelAccountOrder(s,target),rows=result.groups[0].entries;
  assert.deepEqual(rows.map(row=>row.binding?.id),['jang',undefined,undefined,'coke']);assert.deepEqual(rows.map(row=>row.order),[1,2,3,4]);assert.equal(rows[1].current,true);assert.deepEqual(result.ungrouped.map(c=>c.id),['123','extra']);
});

test('each same-channel group retains its own order and all ungrouped accounts remain visible',()=>{
  const s=fixture();s.groups.push({...s.groups[0],id:'other',members:['coke','jang'],cursor:1,status:'stopped'});s.groups.push({...s.groups[0],id:'foreign',guildId:'another'});
  const result=channelAccountOrder(s,target);assert.equal(result.groups.length,2);assert.deepEqual(result.groups.map(section=>section.entries.map(row=>row.binding.id)),[['jang','123','coke'],['coke','jang']]);assert.deepEqual(result.ungrouped.map(c=>c.id),['extra']);
});

test('channels with no matching group show all bindings and never invent an order or current account',()=>{
  const s=fixture();s.groups=[];const result=channelAccountOrder(s,target);assert.deepEqual(result.groups,[]);assert.deepEqual(result.ungrouped.map(c=>c.id),['coke','123','jang','extra']);
});
