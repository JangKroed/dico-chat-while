import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../content.js',import.meta.url),'utf8');
const helpers=source.slice(source.indexOf('  const normalize'),source.indexOf('  const editors'));
const matches=runInNewContext(helpers+'\nmatchesRenderedText');
test('제목과 목록의 렌더링 후 텍스트를 비교한다',()=>{
 assert.equal(matches('### 166 전사\n- 공수, 해적\n- 매물20\n### 직업 상담 DM주세요','166 전사\n\n공수, 해적\n매물20\n\n직업 상담 DM주세요'),true);
 assert.equal(matches('공지 A','공지 B'),false);
 assert.equal(matches('### 공지 A','공지 B'),false);
 assert.equal(matches('**공지**','공지'),true);
 assert.equal(matches('가격 -20','가격 20'),false);
});

test('일반 범위 물결표는 서식 차단 대상이 아니다',()=>{
 assert.equal(matches('### 제목\n- 공용 35~43제 장비','제목\n공용 35~43제 장비'),true);
 assert.equal(matches('### 제목\n- ~~취소~~','제목\n취소'),false);
});
test('Discord 숨김 쉼표는 제외하고 실제 문장 쉼표는 보존한다',()=>{
 const read=runInNewContext(helpers+'\nmessageText');
 const text=value=>({nodeType:3,textContent:value});
 const element=(tag,children,cls='')=>({nodeType:1,tagName:tag,childNodes:children,getAttribute:key=>key==='class'?cls:null});
 const hidden=()=>element('SPAN',[text(',')],'hiddenVisually_b18fe2');
 const dom=element('DIV',[element('H3',[text('테스트 제목'),hidden()]),element('UL',[element('LI',[text('궁수, 해적 35~43제'),hidden()]),element('LI',[text('메용20• 리저렉션 ### 상담'),hidden()])])]);
 const rendered=read(dom);
 assert.equal(matches('### 테스트 제목\n- 궁수, 해적 35~43제\n- 메용20• 리저렉션 ### 상담',rendered),true);
 assert.equal(matches('### 테스트 제목\n- 궁수 해적 35~43제\n- 메용20• 리저렉션 ### 상담',rendered),false);
});

test('이모지 표시 선택자만 정규화하고 문구·공백 차이는 유지한다',()=>{
 const normalize=runInNewContext(helpers+'\nnormalize');
 assert.equal(normalize('❤️ 1️⃣'),normalize('❤ 1⃣'));
 assert.notEqual(normalize('공지  A'),normalize('공지 A'));
 assert.notEqual(normalize('👍🏽'),normalize('👍'));
 assert.notEqual(normalize('🇰🇷'),normalize('🇺🇸'));
});

test('사용자 공지의 밑줄·굵게와 이모지 게시 결과를 비교한다',()=>{
 const input='### 공지\n- __궁수,해적 35~43제__\n- 한타임 💰**1600** | 반타임 💰**800**\n### DM주세요';
 const output='공지\n궁수,해적 35~43제\n한타임 💰1600 | 반타임 💰800\nDM주세요';
 assert.equal(matches(input,output),true);
 assert.equal(matches(input,output.replace('1600','1601')),false);
 assert.equal(matches('`**1600**`','1600'),false);
 assert.equal(matches('**1600','1600'),false);
 assert.equal(matches('[1600](https://example.com)','1600'),false);
});
