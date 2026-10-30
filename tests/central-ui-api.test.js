import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiError,requestErrorMessage} from '../central/ui/src/api.ts';

test('only an actual version conflict gets the stale-edit guidance',()=>{
  const stale=new ApiError('This item changed.',409,'VERSION_CONFLICT');
  const blocked=new ApiError('Connect this browser before starting.',409,'CONNECTION_LOST');
  assert.match(requestErrorMessage(stale),/다른 화면에서 변경/);
  assert.equal(requestErrorMessage(blocked),'Connect this browser before starting.');
});
