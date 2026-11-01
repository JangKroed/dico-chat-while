import test from 'node:test';
import assert from 'node:assert/strict';
import {nextDialogFocus} from '../central/ui/src/dialog-focus.ts';
test('Tab and Shift+Tab wrap at dialog edges while preserving native interior order',()=>{
 const a={},b={},c={};assert.equal(nextDialogFocus([a,b,c],c,false),a);assert.equal(nextDialogFocus([a,b,c],a,true),c);assert.equal(nextDialogFocus([a,b,c],b,false),null);assert.equal(nextDialogFocus([a,b,c],b,true),null);
});
test('outside focus enters the correct dialog edge and empty dialogs stay contained',()=>{
 const a={},b={};assert.equal(nextDialogFocus([a,b],{},false),a);assert.equal(nextDialogFocus([a,b],null,true),b);assert.equal(nextDialogFocus([],null,false),null);assert.equal(nextDialogFocus([a],a,false),a);
});
