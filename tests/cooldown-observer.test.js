import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../content.js',import.meta.url),'utf8');
const monitor=source.slice(source.indexOf('  let cooldownProbeCancel'),source.indexOf('  function inspect(target)'));
function rig(initialCooldown=60000) {
 let clock=0,poll,draft='',matching=true,account=true,cooldown=initialCooldown,known=true,visibleZero=false,wallOffset=0;let editor={};
 const samples=[];
 const observe=runInNewContext(monitor+'\nobserveCooldown',{
 performance:{now:()=>clock},Date:{now:()=>1000000+clock+wallOffset},slowmodeSetting:{seconds:60},
 matchesTarget:()=>matching,coordinatedAccountMatches:()=>account,editors:()=>[editor],normalize:t=>t,editorText:()=>draft,
 slowmode:()=>({cooldownMs:cooldown,slowmodeDetected:cooldown>0||visibleZero,cooldownKnown:known,slowmodeSeconds:60}),
 chrome:{runtime:{sendMessage:async m=>samples.push(m)}},
 setInterval:fn=>{poll=fn;return 1},clearInterval:()=>{poll=null},
 });
 observe({coordinated:true}, {id:'d1',channelId:'c1'},1000000,0);
 return {samples,replaceEditor:()=>{editor={}},jumpWall:()=>{wallOffset+=5000},showZero:()=>{visibleZero=true;cooldown=0},unknown:()=>{known=false},wrongAccount:()=>{account=false},setCooldown:value=>{cooldown=value},draft:()=>{draft='manual'},navigate:()=>{matching=false},
 tick:ms=>{clock+=ms;poll?.()},active:()=>Boolean(poll)};
}
test('67초 제한 표시 해제는 메시지를 추가 발송하지 않고 관찰해 전달한다',()=>{
 const r=rig();for(let i=0;i<134;i++)r.tick(500);
 r.setCooldown(0);r.tick(500);r.tick(500);
 assert.equal(r.samples.filter(m=>m.sample.status==='remaining').length,3);assert.equal(r.samples.at(-1).sample.status,'observed');
 assert.equal(r.samples.at(-1).sample.maxGapMs,500);assert.equal(r.samples[0].channelId,'c1');assert.equal(r.active(),false);
});
test('채널 이동·수동 초안은 관찰 중단, 긴 샘플 간격은 그대로 기록한다',()=>{
 for(const action of ['navigate','draft','wrongAccount','unknown','replaceEditor','jumpWall']) {const r=rig();r[action]();r.tick(500);assert.equal(r.samples.at(-1).sample.status,'inconclusive');assert.equal(r.active(),false);}
 const r=rig();r.tick(8000);r.setCooldown(0);r.tick(500);r.tick(500);
 assert.equal(r.samples.at(-1).sample.maxGapMs,8000);
});
test('제한 표시가 없거나 끝없이 남으면 미완료로 종료한다',()=>{
 const missing=rig(0);for(let i=0;i<22;i++)missing.tick(500);
 assert.equal(missing.samples[0].sample.status,'inconclusive');assert.equal(missing.active(),false);
 const stuck=rig();for(let i=0;i<362;i++)stuck.tick(500);
 assert.equal(stuck.samples.at(-1).sample.status,'inconclusive');assert.equal(stuck.active(),false);
});

test('확인 직후 양수 쿨다운을 단조 시각 기준으로 바로 보내고 초기 3개만 추정에 사용한다',()=>{
 const r=rig(67000);assert.equal(r.samples[0].sample.status,'remaining');assert.equal(r.samples[0].sample.elapsedMs,0);assert.equal(r.samples[0].sample.remainingMs,67000);assert.equal(r.samples[0].sample.slowmodeMs,60000);
 r.setCooldown(66000);r.tick(500);r.tick(500);r.tick(500);
 const early=r.samples.filter(m=>m.sample.status==='remaining');assert.equal(early.length,3);assert.equal(early[2].sample.elapsedMs,1000);
});

test('보이는 00:00도 500ms 안정 확인 뒤 해제로 측정하며 알 수 없는 문구는 해제로 쓰지 않는다',()=>{
 const r=rig();r.tick(500);r.showZero();r.tick(500);assert.equal(r.active(),true);r.tick(500);assert.equal(r.samples.at(-1).sample.status,'observed');assert.equal(r.samples.at(-1).sample.elapsedMs,1000);
 const unknown=rig();unknown.showZero();unknown.unknown();unknown.tick(500);assert.equal(unknown.samples.at(-1).sample.status,'inconclusive');
});
