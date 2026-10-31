import test from 'node:test';
import assert from 'node:assert/strict';
import {createToastTimer} from '../central/ui/src/toast.ts';

function fixture(){
  let now=0,dismissed=0,next=0;
  const scheduled=new Map(),cancelled=new Set();
  const timer=createToastTimer({now:()=>now,schedule:(callback,delay)=>{const id=++next;scheduled.set(id,{callback,at:now+delay});return id},cancel:id=>cancelled.add(id),dismiss:()=>dismissed++});
  const advance=ms=>{now+=ms;for(const [id,job] of [...scheduled])if(job.at<=now&&!cancelled.has(id)){scheduled.delete(id);job.callback()}};
  return {timer,advance,scheduled,get dismissed(){return dismissed}};
}
test('a transient notice expires after its full display time',()=>{
  const f=fixture();f.timer.start(6000);f.advance(5999);assert.equal(f.dismissed,0);f.advance(1);assert.equal(f.dismissed,1);
});
test('a new notice restarts its entire duration even with identical text',()=>{
  const f=fixture();f.timer.start(6000);f.advance(5000);f.timer.start(6000);f.advance(1000);assert.equal(f.dismissed,0);f.advance(5000);assert.equal(f.dismissed,1);
});
test('hover and keyboard focus independently pause expiry until both end',()=>{
  const f=fixture();f.timer.start(9000);f.advance(2000);f.timer.pause('hover');f.timer.pause('focus');f.advance(20000);assert.equal(f.dismissed,0);
  f.timer.resume('hover');f.advance(20000);assert.equal(f.dismissed,0);f.timer.resume('focus');f.advance(6999);assert.equal(f.dismissed,0);f.advance(1);assert.equal(f.dismissed,1);
});
test('replacing a paused notice preserves interaction pause and resets remaining time',()=>{
  const f=fixture();f.timer.start(6000);f.advance(2000);f.timer.pause('hover');f.timer.start(9000);f.advance(20000);assert.equal(f.dismissed,0);
  f.timer.resume('hover');f.advance(8999);assert.equal(f.dismissed,0);f.advance(1);assert.equal(f.dismissed,1);
});
test('manual close cancels expiry and stale callbacks cannot dismiss a later notice',()=>{
  const f=fixture();f.timer.start(6000);const stale=[...f.scheduled.values()][0].callback;f.timer.clear();f.advance(9000);assert.equal(f.dismissed,0);
  f.timer.start(9000);stale();assert.equal(f.dismissed,0);f.advance(9000);assert.equal(f.dismissed,1);
});
