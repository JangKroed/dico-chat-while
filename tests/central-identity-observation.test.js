import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {pageIdentityObservation} from '../central/extension/identity-observation.js';
function read({path='/channels/@me',src='https://cdn.discordapp.com/avatars/123456789012345678/hash.png',panel=true}={}){
 const context={location:{origin:'https://discord.com',pathname:path},document:{title:'Discord',querySelector:()=>panel?{querySelectorAll:()=>[{getAttribute:()=>src}]}:null}};
 return vm.runInNewContext(`(${pageIdentityObservation.toString()})()`,context);
}
test('계정 등록은 친구 목록에서도 동작하고 채널 연결을 만들지 않는다',()=>{
 const result=read();assert.equal(result.verified,true);assert.equal(result.accountId,'123456789012345678');assert.equal(result.channelId,null);assert.equal(result.guildId,null);
});
test('서버 채널에서는 계정과 대상 정보를 분리해 관측한다',()=>{
 const result=read({path:'/channels/111111111111111111/222222222222222222'});assert.equal(result.channelId,'222222222222222222');assert.equal(result.accountId,'123456789012345678');
});
test('기본 아바타와 계정 영역 부재는 구체적인 사유와 함께 미검증으로 남긴다',()=>{
 assert.equal(read({src:'https://cdn.discordapp.com/embed/avatars/0.png'}).reason,'DEFAULT_AVATAR');
 assert.equal(read({panel:false}).reason,'ACCOUNT_PANEL_MISSING');
});
