import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {minimumInterval} from '../controller.js';
const source=readFileSync(new URL('../content.js',import.meta.url),'utf8');
const api=runInNewContext(source.slice(0,source.indexOf('  function slowmode(editor)'))+'return {parseSlowmodeSetting};})();');
test('스크린샷의 한국어 안내와 영문 안내에서 설정 시간을 읽는다',()=>{
 assert.equal(api.parseSlowmodeSetting('슬로우 모드를 사용 중입니다. 멤버는 10분 에 한 번만 메시지를 전송할 수 있습니다.'),600);
 assert.equal(api.parseSlowmodeSetting('슬로우 모드를 사용 중입니다. 멤버는 1시간 30분에 한 번만 메시지를 전송할 수 있습니다.'),5400);
 assert.equal(api.parseSlowmodeSetting('Slowmode is enabled. Members can send one message every 2 minutes.'),120);
});
test('카운트다운·일반 채팅·시간 없는 안내는 설정 시간으로 쓰지 않는다',()=>{
 for(const text of ['00:08','10분 뒤 만나요','슬로우 모드를 사용 중입니다.','Slowmode enabled 10:00']) assert.equal(api.parseSlowmodeSetting(text),null);
});
test('채널별 최소값은 3초 여유를 더하되 기본 최소 30초를 유지한다',()=>{
 assert.equal(minimumInterval({slowmodeSeconds:600}),603);
 assert.equal(minimumInterval({slowmodeSeconds:120}),123);
 assert.equal(minimumInterval({slowmodeSeconds:5}),30);
 assert.equal(minimumInterval({slowmodeSeconds:null}),30);
});

test('입력창의 안내 툴팁을 읽고 다른 채팅방으로 이동하면 이전 시간을 재사용하지 않는다',async()=>{
 let tooltipVisible=false;
 const location={origin:'https://discord.com',pathname:'/channels/123/456'};
 const icon={textContent:'',getAttribute:()=>null,getClientRects:()=>[1],dispatchEvent:event=>{tooltipVisible=event.type==='mouseover'}};
 const form={querySelectorAll:()=>location.pathname.endsWith('/456')?[icon]:[]};
 const editor={getClientRects:()=>[1],getAttribute:()=>null,closest:()=>form};
 const tooltip={textContent:'슬로우 모드를 사용 중입니다. 멤버는 10분에 한 번만 메시지를 전송할 수 있습니다.',getClientRects:()=>tooltipVisible?[1]:[]};
 const document={querySelectorAll:sel=>sel==='[role="tooltip"]'?[tooltip]:[editor],getElementById:()=>null};
 const api=runInNewContext(source.slice(0,source.indexOf('  function slowmode(editor)'))+'return {detectSlowmodeSetting};})();',{
  location,document,Date,MouseEvent:class{constructor(type){this.type=type}},setTimeout:fn=>setImmediate(fn),
 });
 assert.equal(await api.detectSlowmodeSetting({guildId:'123',channelId:'456'}),600);
 assert.equal(tooltipVisible,false);
 location.pathname='/channels/123/789';
 assert.equal(await api.detectSlowmodeSetting({guildId:'123',channelId:'789'}),null);
});
