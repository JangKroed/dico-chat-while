import test from 'node:test';
import assert from 'node:assert/strict';
import {selectEligibleIds} from '../central/ui/src/bulk-selection.ts';

test('select all preserves existing order and filtered selections while appending only eligible visible IDs',()=>{
 assert.deepEqual(selectEligibleIds(['hidden','second'],['first','second','third']),['hidden','second','first','third']);
 assert.deepEqual(selectEligibleIds(['hidden','second'],[]),['hidden','second']);
});
test('select all is idempotent and refuses to silently truncate selection at the history batch limit',()=>{
 assert.deepEqual(selectEligibleIds(['a'],['a','b'],2),['a','b']);
 assert.deepEqual(selectEligibleIds(['a','b'],['b','a'],2),['a','b']);
 assert.deepEqual(selectEligibleIds(['a','b'],['c'],2),['a','b']);
});
