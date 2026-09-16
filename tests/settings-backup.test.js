import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../controller.js';
import {exportSettings,importSettings} from '../settings-backup.js';
const channel={...initialState(),name:'공지',messages:['A','B'],nextIndex:1,target:{url:'https://discord.com/channels/123/456',tabId:99,managed:true,windowManaged:true}};
test('설정과 B 차례 복원, 이전 탭·실행 상태는 가져오지 않는다',()=>{
 const backup=exportSettings({channels:[channel]});
 const [restored]=importSettings(backup);
 assert.deepEqual(restored.messages,['A','B']);assert.equal(restored.nextIndex,1);
 assert.equal(restored.target.tabId,0);assert.equal(restored.target.managed,undefined);
 assert.equal(JSON.stringify(backup).includes('tabId'),false);
});
test('실행·미확인 상태 백업 차단, 중복 채팅방과 잘못된 문구 거부',()=>{
 assert.throws(()=>exportSettings({channels:[{...channel,enabled:true}]}));
 assert.throws(()=>exportSettings({channels:[{...channel,pending:{}}]}));
 const backup=exportSettings({channels:[channel]});backup.channels.push({...backup.channels[0]});
 assert.throws(()=>importSettings(backup));backup.channels.pop();backup.channels[0].messages=['@everyone','B'];
 assert.throws(()=>importSettings(backup));
});
test('초기 미설정 채널도 백업 복원 가능',()=>{
 const backup=exportSettings({channels:[{...initialState(),name:'채널 1'}]});
 assert.deepEqual(importSettings(backup)[0].messages,['','']);
});

test('채널별 슬로우 모드 최소값을 백업·복원하고 이전 형식도 지원한다',()=>{
 const backup=exportSettings({channels:[{...channel,slowmodeSeconds:600,intervalSeconds:603}]});
 assert.equal(importSettings(backup)[0].slowmodeSeconds,600);
 assert.equal(importSettings(backup)[0].intervalSeconds,603);
 delete backup.channels[0].slowmodeSeconds;
 assert.equal(importSettings(backup)[0].slowmodeSeconds,null);
});
