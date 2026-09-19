import test from 'node:test';
import assert from 'node:assert/strict';
import {receiptMeasurement,cooldownMeasurement} from '../timing-calibration.js';
import {createController,minimumInterval} from '../controller.js';

test('PC 시계와 서버 시각 차이를 전송 지연으로 사용하지 않는다',()=>{
 const receipt={messageId:String((1800000000000n-1420070400000n)<<22n),timing:{enterAt:1000000,confirmedAt:1007000,confirmationMs:7000,cooldownMs:60000}};
 const result=receiptMeasurement(receipt,1007000);
 assert.equal(result.confirmationMs,7000);assert.equal(result.serverCreatedAt,1800000000000);
 assert.equal(receiptMeasurement({...receipt,timing:{...receipt.timing,confirmedAt:1017000}},1017000),null);
});
test('67초 해제 관찰은 7초 보정이며 절전·시계 변경·잘못된 값은 적용하지 않는다',()=>{
 const sample={status:'observed',enterAt:1000000,observedAt:1067000,elapsedMs:67000,maxGapMs:500};
 assert.equal(cooldownMeasurement(sample,60).extraSeconds,7);
 assert.equal(cooldownMeasurement({...sample,maxGapMs:8000},60).extraSeconds,null);
 assert.equal(cooldownMeasurement({...sample,observedAt:1080000},60).extraSeconds,null);
 assert.equal(cooldownMeasurement({...sample,elapsedMs:NaN},60),null);
});
test('첫 정상 공지로 측정하고 67초 결과를 해당 채널 예약에 한 번만 반영한다',async()=>{
 let state,time=1000000,alarm,sends=0;
 const io={load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s)},now:()=>time,id:()=>String(time),
 schedule:async t=>{alarm=t},cancel:async()=>{},inspect:async()=>({ok:true,slowmodeSeconds:60}),
 send:async()=>{sends++;const enterAt=time;time+=7000;return {status:'confirmed',messageId:'1550522147103838379',timing:{enterAt,confirmedAt:time,confirmationMs:7000,cooldownMs:60000}}}};
 const controller=createController(io);
 await controller.updateSettings({messages:['A','B'],intervalSeconds:60});
 await controller.bind({tabId:1,url:'https://discord.com/channels/123/456',slowmodeSeconds:60});
 assert.equal(sends,0);assert.equal(state.timingCalibration.status,'awaiting');
 await controller.start();assert.equal(sends,1);assert.equal(state.timingCalibration.confirmationMs,7000);
 assert.equal(alarm,1070000);
 time=1067500;
 await controller.recordTiming(state.lastDeliveryId,{status:'observed',enterAt:1000000,observedAt:1067000,elapsedMs:67000,maxGapMs:500});
 assert.equal(minimumInterval(state),70);assert.equal(state.intervalSeconds,70);assert.equal(alarm,1070000);
 assert.equal(sends,1);assert.equal(state.nextIndex,1);
 const previous=structuredClone(state);
 await controller.recordTiming('old',{status:'observed',enterAt:1000000,observedAt:1120000,elapsedMs:120000,maxGapMs:500});
 assert.deepEqual(state,previous);
 await controller.stop();await controller.bind({tabId:2,url:'https://discord.com/channels/123/789',slowmodeSeconds:120});
 assert.equal(state.timingCalibration.extraSeconds,0);assert.equal(minimumInterval(state),123);
});
