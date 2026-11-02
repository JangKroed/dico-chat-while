import test from 'node:test';
import assert from 'node:assert/strict';
import {createCentralManager} from '../central/core/index.js';

function fixture(){
  let time=1_800_000_000_000;
  const manager=createCentralManager({now:()=>time,monotonicNow:()=>time-1_799_999_999_000});
  const sessions=[];
  const connect=()=>{const session=manager.bridge({type:'HELLO',protocolVersion:1,capabilities:['managed-window-v1','managed-window-separation-v1']});sessions.push(session);manager.bridge({type:'OBSERVATION',sessionId:session.sessionId,legacyFrozen:true,legacyPending:false,channels:[1,2].map(n=>({accountId:'111',guildId:'222',channelId:String(330+n),tabId:n,verified:true}))},session.instanceId);return session;};
  const session=connect(),channels=manager.snapshot().channels;
  const request=(action='reveal',channel=channels[0])=>manager.execute(`channel.${action}`,{id:channel.id});
  const ack=(command,status='applied',owner=session)=>manager.bridge({type:'ACK',sessionId:owner.sessionId,commandId:command.commandId,status,...(status==='rejected'?{rejectionCode:'MANAGE_WINDOW_FAILED'}:{})},owner.instanceId);
  const reject=(action='reveal')=>{const command=request(action);ack(command,'rejected');return manager.snapshot().incidents.findLast(i=>i.commandId===command.commandId);};
  return{manager,session,channels,connect,request,ack,reject,advance:()=>time+=1000};
}

test('window failure recheck gives a concrete same-operation recovery without changing delivery',()=>{
  const f=fixture();try{const issue=f.reject(),before=f.manager.snapshot(),result=f.manager.execute('incident.recheck',{id:issue.id}),after=f.manager.snapshot();
    assert.equal(result.resolved,0);assert.equal(result.blocked[0].reasonCode,'WINDOW_ACTION_REQUIRED');assert.equal(result.blocked[0].page,'channels');assert.match(result.blocked[0].message,/전송 창 보기/);
    assert.deepEqual(after.attempts,before.attempts);assert.deepEqual(after.groups,before.groups);assert.deepEqual(after.commands,before.commands);
  }finally{f.manager.close();}
});

test('same-window same-operation applied retry resolves an old window incident',()=>{
  const f=fixture();try{const issue=f.reject();f.advance();f.ack(f.request());const result=f.manager.execute('incident.recheck',{id:issue.id});
    assert.equal(result.resolved,1);assert.equal(result.remaining,0);assert.equal(f.manager.snapshot().incidents.find(i=>i.id===issue.id).resolutionReason,'window_action_applied');assert.equal(f.manager.snapshot().attempts.length,0);
  }finally{f.manager.close();}
});

test('window recheck rejects earlier success, wrong action, wrong target, wrong browser and pending ACK',()=>{
  for(const mismatch of ['earlier','action','target','browser','pending']){const f=fixture();try{
    if(mismatch==='earlier'){f.ack(f.request());f.advance();}
    const issue=f.reject();f.advance();
    if(mismatch==='action')f.ack(f.request('hide'));
    if(mismatch==='target')f.ack(f.request('reveal',f.channels[1]));
    if(mismatch==='browser'){const other=f.connect(),channel=f.manager.snapshot().channels.find(c=>c.instanceId===other.instanceId);f.ack(f.request('reveal',channel),'applied',other);}
    if(mismatch==='pending')f.ack(f.request(),'received');
    assert.equal(f.manager.execute('incident.recheck',{id:issue.id}).resolved,0,mismatch);
  }finally{f.manager.close();}}
});
