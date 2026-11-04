import test from 'node:test';
import assert from 'node:assert/strict';
import {CentralStore} from '../central/core/store.js';

function fixture(t,events){
 const store=new CentralStore(':memory:');t.after(()=>store.close());
 const insert=store.db.prepare('INSERT INTO events(at,type,data) VALUES(?,?,?)');
 store.db.exec('BEGIN');for(const event of events)insert.run(event.at,event.type,JSON.stringify(event));store.db.exec('COMMIT');return store;
}

test('support event selection preserves old unresolved evidence and individual-attempt context',t=>{
 const events=[
  {at:1,type:'attempt.created',attemptId:'open'},
  {at:2,type:'command.applied',commandId:'related'},
  {at:3,type:'delivery.trace',attemptId:'closed'},
  {at:100,type:'delivery.trace',attemptId:'other',groupId:'group'},
  {at:101,type:'channel.updated',groupId:'group'},
  {at:102,type:'instance.connected',instanceId:'instance'},
  {at:103,type:'service.clock_gap'},
  {at:104,type:'service.started'},
  {at:105,type:'service.stopped'},
  {at:106,type:'settings.updated'},
  {at:107,type:'channel.updated',groupId:'other'},
  {at:201,type:'channel.updated',groupId:'group'},
  {at:202,type:'delivery.trace',attemptId:'open'},
 ];
 const store=fixture(t,events),options={from:100,to:200,attemptIds:['open'],commandIds:['related'],groupIds:['group'],instanceIds:['instance']};
 assert.deepEqual([...store.supportEvents(options)].map(e=>e.eventId),[1,2,4,5,6,7,8,9,10,11,13]);
 assert.deepEqual([...store.supportEvents({...options,attemptScoped:true})].map(e=>e.eventId),[1,2,5,6,7,8,9,10,13]);
 assert.equal(store.db.prepare('SELECT COUNT(*) AS total FROM events').get().total,events.length);
});

test('support selection decodes only relevant records in a large unrelated history',t=>{
 const events=Array.from({length:15000},(_,i)=>({at:i,type:'delivery.trace',attemptId:`old-${i}`,data:{message:'x'.repeat(200)}}));
 events.push({at:15001,type:'attempt.created',attemptId:'open'},{at:15002,type:'service.clock_gap'});
 const store=fixture(t,events),parse=JSON.parse;let decoded=0,selected;
 try{JSON.parse=(...args)=>{decoded++;return parse(...args);};selected=[...store.supportEvents({from:15002,to:15002,attemptIds:['open']})];}finally{JSON.parse=parse;}
 assert.deepEqual(selected.map(e=>e.eventId),[15001,15002]);assert.equal(decoded,2);
});

test('event pagination preserves ascending cursors and filters over multiple pages',t=>{
 const events=Array.from({length:2205},(_,i)=>({at:i,type:i%2?'delivery.trace':'attempt.created',groupId:i%3?'other':'selected',attemptId:`a-${i}`}));
 const store=fixture(t,events),all=[];let after=0;
 for(;;){const page=store.events({after,limit:1000});all.push(...page);if(page.length<1000)break;after=page.at(-1).eventId;}
 assert.deepEqual(all.map(e=>e.eventId),events.map((_,i)=>i+1));
 assert.deepEqual(store.events({from:100,to:200,type:'delivery.trace',groupId:'selected',limit:7}).map(e=>e.eventId),[106,112,118,124,130,136,142]);
});
