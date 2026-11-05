import test from 'node:test';
import assert from 'node:assert/strict';
import {intervalSettings,customIntervalError,intervalPayload,intervalDraftChanged} from '../central/ui/src/interval.ts';

test('직접 주기와 감지·보정 주기 중 긴 값만 계산하며 같은 대기를 더하지 않는다',()=>{
 for(const [custom,effective,extra] of [[64000,67,0],[70000,70,3],[90000,90,23]]){
  const info=intervalSettings({intervalMode:'custom',intervalMs:custom,customIntervalMs:custom,slowmodeMs:60000,correctedBaseIntervalMs:67000});
  assert.equal(info.effectiveSeconds,effective);assert.equal(info.extraSeconds,extra);
 }
});

test('auto interval is detected slowmode plus three seconds, including a detected zero',()=>{
  for(const [slowmodeMs,seconds] of [[60000,63],[120000,123],[0,3]]){
    const info=intervalSettings({intervalMode:'auto',intervalMs:60000,slowmodeMs,slowmodeObservedAt:1});
    assert.equal(info.floorSeconds,seconds);assert.equal(info.effectiveSeconds,seconds);assert.equal(info.observed,true);
  }
});
test('unknown observation stays visibly pending rather than claiming zero slowmode',()=>{
  const info=intervalSettings({intervalMode:'auto',intervalMs:60000,slowmodeMs:0});
  assert.equal(info.observed,false);assert.equal(info.floorSeconds,3);
  assert.equal(intervalSettings({intervalMode:'auto',intervalMs:3000,slowmodeMs:0,slowmodeObservedAt:null}).observed,false);
});
test('custom values below the live floor are rejected and increases keep the user draft intact',()=>{
  let channel={intervalMode:'custom',intervalMs:90000,slowmodeMs:60000,slowmodeObservedAt:1};
  assert.match(customIntervalError('60',intervalSettings(channel)),/63초/);
  assert.equal(customIntervalError('90',intervalSettings(channel)),'');
  channel={...channel,slowmodeMs:120000};
  assert.match(customIntervalError('90',intervalSettings(channel)),/123초/);
  assert.equal(intervalSettings(channel).effectiveSeconds,123);
});
test('auto saves mode only while custom saves its validated milliseconds',()=>{
  assert.deepEqual(intervalPayload('auto','60'),{intervalMode:'auto'});
  assert.deepEqual(intervalPayload('custom','123'),{intervalMode:'custom',intervalMs:123000});
});
test('auto draft ignores changing detected floor while a custom typed draft remains dirty',()=>{
  const channel={intervalMode:'auto',intervalMs:63000,slowmodeMs:60000,slowmodeObservedAt:1};
  assert.equal(intervalDraftChanged(channel,'auto','60'),false);
  assert.equal(intervalDraftChanged({...channel,slowmodeMs:120000},'auto','60'),false);
  assert.equal(intervalDraftChanged(channel,'custom','90'),true);
});
test('legacy modes infer auto when a stored interval no longer exceeds the slowmode floor',()=>{
  assert.equal(intervalSettings({intervalMs:60000,slowmodeMs:60000,slowmodeObservedAt:1}).mode,'auto');
  assert.equal(intervalSettings({intervalMs:60000,slowmodeMs:120000,slowmodeObservedAt:1}).mode,'auto');
  assert.equal(intervalSettings({intervalMs:90000,slowmodeMs:60000,slowmodeObservedAt:1}).mode,'custom');
});
test('minimum DTO and actual effective time are reflected instead of an older base setting',()=>{
  const info=intervalSettings({intervalMode:'custom',intervalMs:123000,minimumIntervalMs:123000,slowmodeMs:120000,slowmodeObservedAt:1,effectiveIntervalMs:123000});
  assert.equal(info.effectiveSeconds,123);assert.equal(info.floorSeconds,123);
});
test('untouched actual interval never overwrites a shorter saved custom intent',()=>{
  const channel={intervalMode:'custom',intervalMs:123000,customIntervalMs:90000,minimumIntervalMs:123000,slowmodeMs:120000,slowmodeObservedAt:1};
  assert.equal(intervalDraftChanged(channel,'custom','123',false),false,'untouched actual display cannot be saved as new intent');
  assert.equal(intervalDraftChanged(channel,'custom','123',true),true,'explicitly typing the actual value can replace the old intent');
  assert.equal(intervalDraftChanged(channel,'custom','90',true),false,'the original intent itself has not changed');
  assert.match(customIntervalError('90',intervalSettings(channel)),/123초/);
});
test('mode selection can be saved without typing, but returning to the saved mode is unchanged',()=>{
  const channel={intervalMode:'custom',intervalMs:123000,customIntervalMs:90000,slowmodeMs:120000,slowmodeObservedAt:1};
  assert.equal(intervalDraftChanged(channel,'auto','123',false),true);
  assert.equal(intervalDraftChanged(channel,'custom','123',false),false);
  assert.equal(intervalDraftChanged({...channel,intervalMode:'auto'},'custom','123',false),true);
  assert.equal(intervalDraftChanged(channel,'custom','200',true),true);
});

test('measured correction plus the custom excess are displayed without hiding either component',()=>{
 const base={slowmodeMs:60000,slowmodeObservedAt:1,intervalMs:63000,minimumIntervalMs:63000,correctedBaseIntervalMs:67000,cooldownCorrectionMs:4000,cooldownCalibratedAt:1000};
 const automatic=intervalSettings({...base,intervalMode:'auto',effectiveIntervalMs:67000});
 assert.equal(automatic.floorSeconds,63);assert.equal(automatic.correctedBaseSeconds,67);assert.equal(automatic.effectiveSeconds,67);assert.equal(automatic.extraSeconds,0);assert.equal(automatic.calibrated,true);
 const custom=intervalSettings({...base,intervalMode:'custom',intervalMs:70000,customIntervalMs:70000,effectiveIntervalMs:74000});
 assert.equal(custom.correctionSeconds,4);assert.equal(custom.extraSeconds,7);assert.equal(custom.effectiveSeconds,74);
 assert.equal(customIntervalError('63',custom),'');
});
