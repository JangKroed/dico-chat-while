import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const emojiSource=readFileSync(new URL('../emoji-data.js',import.meta.url),'utf8');
const source=readFileSync(new URL('../content.js',import.meta.url),'utf8');
const t=text=>({nodeType:3,textContent:text});
const el=(attrs={},children=[],tag='SPAN')=>({nodeType:1,tagName:tag,childNodes:children,getAttribute:key=>attrs[key]??null,get textContent(){return children.map(c=>c.textContent).join('');}});
const leaf=text=>el({'data-slate-string':'true'},[t(text)]);
const line=(...children)=>el({'data-slate-node':'element'},children,'DIV');
const readerContext={};runInNewContext(emojiSource,readerContext);
const begin=source.indexOf('  function editorContent('),end=source.indexOf('  const hasDraft',begin);assert.ok(begin>=0);runInNewContext(source.slice(begin,end)+'\nglobalThis.read=editorContent;',readerContext);
const read=editor=>readerContext.read(editor);
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
// Structure observed in the user's Discord composer on 2026-09-17.
const discordMoneybag=(overrides={},label=':moneybag:')=>el({'data-slate-node':'element','data-slate-inline':'true','data-slate-void':'true',contenteditable:'false'},[
 el({class:'emoji','data-type':'emoji','data-name':':moneybag:',alt:':moneybag:','aria-describedby':'emoji-description',src:'/assets/60e4658040396168.svg',...overrides},[],'IMG'),
 el({id:'emoji-description',class:'hiddenVisually_b18fe2'},[t(label)]),
 el({'data-slate-spacer':'true'},[el({'data-slate-node':'text'},[el({'data-slate-leaf':'true'},[el({'data-slate-zero-width':'z','data-slate-length':'0'},[t('\ufeff')])])])])]);
test('실제 Discord moneybag shortcode와 연결된 숨김 설명을 Unicode 한 글자로 읽는다',()=>{
 const result=read(el({},[line(leaf('한타임 '),discordMoneybag(),leaf('**1600** | 반타임 '),discordMoneybag(),leaf('**800**'))]));
 assert.equal(result.text,'한타임 💰**1600** | 반타임 💰**800**');assert.equal(result.unsupported,false);assert.equal(result.unicodeEmojiCount,2);
});
test('다른 설명·커스텀 이모지·알 수 없는 shortcode는 추측하지 않는다',()=>{
 for(const item of [discordMoneybag({},'다른 내용'),discordMoneybag({src:'https://cdn.discordapp.com/emojis/123.png'}),discordMoneybag({'data-name':':other:'}),discordMoneybag({alt:':unknown:','data-name':':unknown:'},':unknown:')])assert.equal(read(el({},[line(item)])).unsupported,true);
});

test('특정 문구 목록 없이 번들 전체 이모지 이름을 같은 이미지 구조로 읽는다',()=>{
 const ctx={};runInNewContext(emojiSource,ctx);
 for(const [name,value] of Object.entries(ctx.__dicoEmojiNames)){
  const node=discordMoneybag({alt:name,'data-name':name},name);
  const result=read(el({},[line(leaf('**공지** '),node,leaf(' __한글 ABC 123__'))]));
  assert.equal(result.unsupported,false,name);assert.equal(result.text,'**공지** '+value+' __한글 ABC 123__',name);
 }
});
test('국기·키캡·피부색·가족 합성 이모지를 Unicode alt로도 읽는다',()=>{
 for(const value of ['🇰🇷','1️⃣','👍🏽','👨‍👩‍👧‍👦','🏴󠁧󠁢󠁥󠁮󠁧󠁿']){
  const result=read(el({},[line(emoji(value))]));assert.equal(result.unsupported,false,value);assert.equal(result.text,value);
 }
});

runInNewContext(source.slice(source.indexOf('  const normalize'),source.indexOf('  // Support heading')),readerContext);
const matches=(editor,text)=>readerContext.composerMatches(editor,text);
test('실제 이모지 위치에서만 shortcode 대체를 허용한다',()=>{
 const editor=el({},[line(leaf('가격 '),discordMoneybag(),leaf(' 1600 / 문자 :moneybag:'))]);
 assert.equal(matches(editor,'가격 :moneybag: 1600 / 문자 :moneybag:'),true);
 assert.equal(matches(editor,'가격 💰 1600 / 문자 :moneybag:'),true);
 assert.equal(matches(editor,'가격 :moneybag: 1600 / 문자 💰'),false);
 for(const text of ['가격 :moneybag: 1601 / 문자 :moneybag:','가격  :moneybag: 1600 / 문자 :moneybag:','가격 :moneybag: 1600\n/ 문자 :moneybag:','가격 :unknown: 1600 / 문자 :moneybag:'])assert.equal(matches(editor,text),false,text);
});
test('인라인 코드·코드 블록·이스케이프·URL의 shortcode는 이미지와 같다고 보지 않는다',()=>{
 for(const [left,right] of [['`','`'],['``','``'],['```txt\n','\n```'],['~~~\n','\n~~~'],['\\',''],['https://example.com/',''],['<https://example.com/','>']]){
  const transformed=el({},[line(leaf(left),discordMoneybag(),leaf(right))]);
  assert.equal(matches(transformed,left+':moneybag:'+right),false,left);
  assert.equal(matches(el({},[line(leaf(left+':moneybag:'+right))]),left+':moneybag:'+right),true,left);
 }
 assert.equal(matches(el({},[line(leaf('`예제 :moneybag:` '),discordMoneybag())]),'`예제 :moneybag:` :moneybag:'),true);
});
test('전체 이름 목록에서 Unicode와 이름은 동일하고 잘못된 이름은 거부한다',()=>{
 for(const [alias,value] of Object.entries(readerContext.__dicoEmojiNames)){
  const editor=el({},[line(leaf('A '),discordMoneybag({alt:alias,'data-name':alias},alias),leaf(' B'))]);
  assert.equal(matches(editor,'A '+alias+' B'),true,alias);
  assert.equal(matches(editor,'A '+value+' B'),true,alias);
  assert.equal(matches(editor,'A :definitely_unknown: B'),false,alias);
 }
});
test('같은 이모지의 다른 이름과 Unicode alt도 함께 비교한다',()=>{
 const thumb=discordMoneybag({alt:':+1:','data-name':':+1:'},':+1:');
 assert.equal(matches(el({},[line(thumb)]),':thumbsup:'),true);
 assert.equal(matches(el({},[line(emoji())]),':moneybag:'),true);
 assert.equal(matches(el({},[line(thumb)]),':thumbsup::skin-tone-4:'),false);
});
