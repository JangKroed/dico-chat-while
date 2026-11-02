import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),require=createRequire(join(root,'central/ui/package.json')),{build}=require('esbuild');

test('rendered channel accounts show the same fixed numbered order as group configuration',async()=>{
  const source=`import {renderToStaticMarkup} from 'react-dom/server';import {ChannelCountdownCards} from './src/RuntimeCountdown.tsx';export function render(s){return renderToStaticMarkup(<ChannelCountdownCards s={s} go={()=>{}} run={async()=>true} busy={false}/>);}`;
  const result=await build({stdin:{contents:source,resolveDir:join(root,'central/ui'),loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false});
  const dir=await mkdtemp(join(tmpdir(),'dico-channel-order-'));try{
    const path=join(dir,'component.cjs');await writeFile(path,result.outputFiles[0].contents);const {render}=require(path),now=Date.now();
    const bindings=['coke','123','jang','extra'].map((id,index)=>({id,accountId:id,instanceId:'browser'+index,guildId:'g',channelId:'c',name:'채널',verified:true,playlist:[],playlistIndex:0,intervalMs:3000,slowmodeMs:0,configVersion:0,appliedVersion:0}));
    const s={serverNow:now,channels:bindings,groups:[{id:'group',name:'그룹1',guildId:'g',channelId:'c',members:['jang','123','coke'],cursor:1,status:'running'}],instances:bindings.map(c=>({id:c.instanceId,name:c.instanceId,connected:true,lastSeenAt:now})),accounts:bindings.map(c=>({id:'account'+c.id,instanceId:c.instanceId,accountId:c.accountId,name:c.accountId})),attempts:[],targets:[{id:'target',guildId:'g',channelId:'c',name:'채널'}]};
    const html=render(s);
    assert.ok(html.indexOf('data-binding-id="jang"')<html.indexOf('data-binding-id="123"'));assert.ok(html.indexOf('data-binding-id="123"')<html.indexOf('data-binding-id="coke"'));
    assert.match(html,/<[^>]+data-binding-id="123"[^>]+aria-current="step"/);
    for(const order of [1,2,3])assert.ok(html.includes(order+'번'),'visible fixed order number '+order);
    assert.ok(html.includes('그룹 미지정 계정'));assert.ok(html.includes('data-binding-id="extra"'));
    s.groups[0].cursor=2;const moved=render(s);assert.ok(moved.indexOf('data-binding-id="jang"')<moved.indexOf('data-binding-id="coke"'));assert.match(moved,/<[^>]+data-binding-id="coke"[^>]+aria-current="step"/);
    s.groups.push({...s.groups[0],id:'other',name:'다른 그룹',members:['coke','jang'],cursor:0,status:'paused'});s.attempts=[{id:'attempt',groupId:'group',bindingId:'jang',status:'permitted'}];
    const multiple=render(s),second=multiple.slice(multiple.indexOf('aria-label="다른 그룹 계정 순서"'),multiple.indexOf('aria-label="그룹 미지정 계정"'));
    assert.ok(second.indexOf('data-binding-id="coke"')<second.indexOf('data-binding-id="jang"'));assert.ok(second.includes('일시정지됨'));assert.ok(!second.includes('발송 확인 중'),'a paused group must not inherit the other group’s active attempt');
  }finally{await rm(dir,{recursive:true,force:true});}
});
