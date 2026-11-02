import test from 'node:test';
import assert from 'node:assert/strict';
import {createCentralManager} from '../central/core/index.js';

test('clock suspension records measured wall, monotonic and drift values without claiming OS sleep',()=>{
 for(const mode of ['loop_delay','clock_drift','monotonic_reversal']){
  let wall=1_800_000_000_000,mono=1000;
  const manager=createCentralManager({now:()=>wall,monotonicNow:()=>mono});
  try{
   if(mode==='loop_delay'){wall+=16000;mono+=16000;}
   if(mode==='clock_drift'){wall+=4000;mono+=1000;}
   if(mode==='monotonic_reversal'){wall+=1000;mono-=1;}
   manager.tick();
   const event=manager.events().find(e=>e.type==='service.resume_required');
   assert.equal(event.clockDiagnostic.trigger,mode);
   assert.equal(event.clockDiagnostic.wallDeltaMs,wall-1_800_000_000_000);
   assert.equal(event.clockDiagnostic.monotonicDeltaMs,mono-1000);
   assert.equal(event.clockDiagnostic.driftMs,event.clockDiagnostic.wallDeltaMs-event.clockDiagnostic.monotonicDeltaMs);
   assert.deepEqual(manager.snapshot().service.clockDiagnostic,event.clockDiagnostic);
  }finally{manager.close();}
 }
});
