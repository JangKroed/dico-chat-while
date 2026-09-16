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
