import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppearanceController,APPEARANCE_KEY} from '../central/ui/src/appearance.ts';
function fixture(value,systemDark=false,blocked=false){
  const root={dataset:{},style:{}},saved=new Map(value?[[APPEARANCE_KEY,value]]:[]),listeners=new Set();
  const media={matches:systemDark,addEventListener:(_event,fn)=>listeners.add(fn),removeEventListener:(_event,fn)=>listeners.delete(fn)};
  const storage={getItem:key=>{if(blocked)throw Error('blocked');return saved.get(key)??null},setItem:(key,value)=>{if(blocked)throw Error('blocked');saved.set(key,value)}};
  const controller=createAppearanceController({root,storage,media});
  return {root,saved,controller,changeDark(value){media.matches=value;for(const fn of listeners)fn()}};
}
test('appearance defaults to system and follows live OS color changes',()=>{
  const f=fixture(undefined,true);
  assert.equal(f.controller.get(),'system');assert.equal(f.root.dataset.theme,'dark');assert.equal(f.root.style.colorScheme,'dark');
  f.changeDark(false);assert.equal(f.root.dataset.theme,'light');
});
test('explicit appearance persists and ignores system changes until system is selected',()=>{
  const f=fixture('dark');assert.equal(f.root.dataset.theme,'dark');
  f.controller.set('light');f.changeDark(true);assert.equal(f.root.dataset.theme,'light');assert.equal(f.saved.get(APPEARANCE_KEY),'light');
  const reopened=fixture(f.saved.get(APPEARANCE_KEY),true);assert.equal(reopened.root.dataset.theme,'light');
  f.controller.set('system');assert.equal(f.root.dataset.theme,'dark');
});
test('invalid or unavailable local storage safely falls back to system',()=>{
  for(const f of [fixture('unexpected',true),fixture(undefined,true,true)]){
    assert.equal(f.controller.get(),'system');assert.equal(f.root.dataset.theme,'dark');
    assert.doesNotThrow(()=>f.controller.set('light'));assert.equal(f.root.dataset.theme,'light');
  }
});
test('appearance subscribers receive changes and can unsubscribe',()=>{
  const f=fixture();const seen=[];const unsubscribe=f.controller.subscribe(()=>seen.push(f.controller.get()));
  f.controller.set('dark');unsubscribe();f.controller.set('light');assert.deepEqual(seen,['dark']);
});
