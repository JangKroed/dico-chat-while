import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../notification-settings.js',import.meta.url),'utf8');
function rig(permission='granted'){
 const handlers={},status={},button={},toggle={},calls=[];
 button.addEventListener=(_,fn)=>handlers.click=fn;toggle.addEventListener=()=>{};
 runInNewContext(source,{document:{querySelector:s=>s==='#notification-status'?status:s==='#test-notification'?button:toggle},setTimeout,clearTimeout,chrome:{
 storage:{local:{get:async()=>({})},onChanged:{addListener(){}}},runtime:{getURL:p=>p},
 notifications:{getPermissionLevel:async()=>permission,clear:async id=>calls.push(['clear',id]),create:async id=>calls.push(['create',id])}
 }});return {handlers,status,button,calls};
}
test('클릭 즉시 진행 상태를 표시하고 이전 알림 제거 후 새 요청 결과를 안내한다',async()=>{
 const r=rig();const task=r.handlers.click();assert.match(r.status.textContent,/요청하는 중/);assert.equal(r.button.disabled,true);
 await task;assert.deepEqual(r.calls.map(c=>c[0]),['clear','create']);assert.match(r.status.textContent,/요청을 받았습니다/);assert.match(r.status.textContent,/Discord/);assert.equal(r.button.disabled,false);
});
test('차단 상태에서는 발송하지 않고 Chrome과 Brave 설정을 안내한다',async()=>{
 const r=rig('denied');await r.handlers.click();assert.equal(r.calls.length,0);assert.match(r.status.textContent,/Chrome 또는 Brave/);assert.equal(r.button.disabled,false);
});
