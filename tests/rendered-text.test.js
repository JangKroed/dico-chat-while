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
 assert.equal(matches('**공지**','공지'),false);
 assert.equal(matches('가격 -20','가격 20'),false);
});
