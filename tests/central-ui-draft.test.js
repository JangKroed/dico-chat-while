import test from 'node:test';
import assert from 'node:assert/strict';
import {draftVersion,savedDraftVersion} from '../central/ui/src/draft.ts';

test('realtime changes mark an open draft stale without raising its expected version',()=>{
  const message=draftVersion(3,4),channel=draftVersion(7,9),group=draftVersion(1,2);
  for(const [state,base] of [[message,3],[channel,7],[group,1]]){
    assert.equal(state.externalChanged,true);
    assert.equal(state.expectedVersion,base);
  }
});
test('a successful local save advances the captured version once',()=>{
  assert.deepEqual(draftVersion(savedDraftVersion(3),4),{expectedVersion:4,externalChanged:false});
});
