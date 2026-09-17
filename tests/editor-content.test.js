import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../content.js',import.meta.url),'utf8');
const t=text=>({nodeType:3,textContent:text});
const el=(attrs={},children=[],tag='SPAN')=>({nodeType:1,tagName:tag,childNodes:children,getAttribute:key=>attrs[key]??null,get textContent(){return children.map(c=>c.textContent).join('');}});
const leaf=text=>el({'data-slate-string':'true'},[t(text)]);
const line=(...children)=>el({'data-slate-node':'element'},children,'DIV');
function read(editor){const ctx={};const begin=source.indexOf('  function editorContent('),end=source.indexOf('  const hasDraft',begin);assert.ok(begin>=0);runInNewContext(source.slice(begin,end)+'\nglobalThis.read=editorContent;',ctx);return ctx.read(editor);}
test('표시용 줄바꿈 대신 Slate 문단과 문자열을 읽고 원래 공백을 보존한다',()=>{
 const editor=el({},[line(leaf('공지  A')),line(leaf('둘째 줄')),line(leaf('')),line(leaf('마지막'))]);editor.innerText='공지  A\n\n둘째 줄\n\n\n마지막';
 const result=read(editor);assert.equal(result.text,'공지  A\n둘째 줄\n\n마지막');assert.equal(result.mode,'slate');assert.equal(result.unsupported,false);
});
test('비어 있는 Slate spacer만 가진 void는 내용으로 오인하지 않는다',()=>{
 const spacer=el({'data-slate-spacer':'true'},[el({'data-slate-zero-width':'z'},[t('\ufeff')])]);
 const result=read(el({},[line(leaf('공지'),el({'data-slate-void':'true'},[spacer]))]));assert.equal(result.text,'공지');assert.equal(result.unsupported,false);
});
test('이미지·멘션·알 수 없는 void와 누락될 문자열은 계속 차단한다',()=>{
 for(const special of [el({'data-slate-void':'true'},[el({alt:'emoji'},[],'IMG')]),el({'data-slate-void':'true'},[t('@someone')]),el({'data-slate-void':'true'},[]),el({},[t('다른 초안')])]){
  const result=read(el({},[line(leaf('공지'),special)]));assert.equal(result.unsupported,true);
 }
});
test('Slate 구조가 없으면 기존 원문으로 비교하며 임의 공백 삭제를 하지 않는다',()=>{
 assert.equal(read({innerText:'A B\nC'}).text,'A B\nC');
});
const emoji=(alt='💰')=>el({'data-slate-void':'true','data-slate-inline':'true'},[
 el({'data-slate-spacer':'true'},[el({'data-slate-zero-width':'z'},[t('\ufeff')])]),
 el({contenteditable:'false'},[el({class:'emoji emoji__test',alt},[],'IMG')])]);
test('사용자 공지의 💰 두 개와 Markdown 기호를 누락 없이 읽는다',()=>{
 const text='### 166풀이속숍 집뿌쩔 머쉬킹 끝나고 바로 시작하세요\n- __궁수,해적,전사 공용 35~43제 명중 방어구, 무기 대여로 2탐 후 3차까지__\n- 템대여 무보증금, 스초 X , 한타임 💰**1600** | 반타임 💰**800**\n- 메용20 · 리저렉션 · 깔끔한 심파컨\n### 직업/렙 상담 DM주세요';
 const editor=el({},text.split('\n').map(value=>{const parts=value.split('💰');return line(...parts.flatMap((part,i)=>i?[emoji(),leaf(part)]:[leaf(part)]));}));
 const result=read(editor);assert.equal(result.text,text);assert.equal(result.unsupported,false);assert.equal(result.unicodeEmojiCount,2);
});
test('shortcode·일반 이미지·이모지 뒤 숨은 텍스트는 허용하지 않는다',()=>{
 for(const item of [emoji(':moneybag:'),emoji('hello'),el({'data-slate-void':'true'},[el({alt:'💰'},[],'IMG')]),el({'data-slate-void':'true'},[emoji(),t('hidden')])])assert.equal(read(el({},[line(item)])).unsupported,true);
});
