import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const tokens=readFileSync(new URL('../central/ui/src/design-tokens.css',import.meta.url),'utf8');
const styles=readFileSync(new URL('../central/ui/src/style.css',import.meta.url),'utf8');
const themes=Object.fromEntries([...tokens.matchAll(/(:root|html\[data-theme=dark\])\s*\{([^}]+)\}/g)].map(([,selector,body])=>[
  selector===':root'?'light':'dark',Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([,key,value])=>[key,value]))
]));
// WCAG relative luminance: linearize sRGB before applying perceptual weights.
function luminance(hex){
  const channels=[1,3,5].map(offset=>parseInt(hex.slice(offset,offset+2),16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);
  return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;
}
function contrast(a,b){const values=[luminance(a),luminance(b)].sort((x,y)=>y-x);return(values[0]+0.05)/(values[1]+0.05);}
function check(theme,fg,bg,min){
  assert.ok(themes[theme][fg],`${theme}: missing ${fg}`);
  assert.ok(themes[theme][bg],`${theme}: missing ${bg}`);
  const ratio=contrast(themes[theme][fg],themes[theme][bg]);
  assert.ok(ratio>=min,`${theme} ${fg} on ${bg}: ${ratio.toFixed(2)}:1; expected at least ${min}:1`);
}

for(const theme of ['light','dark']){
  test(`${theme}: body, secondary and placeholder copy meet 4.5:1 on every neutral surface`,()=>{
    for(const fg of ['--text','--text-muted','--text-subtle'])
      for(const bg of ['--canvas','--surface','--surface-raised','--surface-inset','--surface-hover']) check(theme,fg,bg,4.5);
  });
  test(`${theme}: links and semantic status copy meet 4.5:1`,()=>{
    for(const role of ['accent','success','warning','danger']){
      for(const bg of ['--surface','--surface-raised',`--${role}-soft`]) check(theme,`--${role}`,bg,4.5);
    }
    for(const pair of [
      ['--on-primary','--primary'],['--on-primary','--primary-hover'],['--on-danger','--danger-solid'],
      ['--danger','--danger-hover'],['--toast-text','--toast'],['--toast-text','--toast-error'],
      ['--disabled-text','--disabled-surface'],
    ]) check(theme,...pair,4.5);
  });
  test(`${theme}: sidebar remains readable through hover and selection`,()=>{
    for(const fg of ['--sidebar-text','--sidebar-muted','--sidebar-accent'])
      for(const bg of ['--sidebar','--sidebar-raised','--sidebar-active']) check(theme,fg,bg,4.5);
  });
  test(`${theme}: control boundaries and focus ring meet 3:1 against adjacent surfaces`,()=>{
    for(const fg of ['--control-border','--focus'])
      for(const bg of ['--canvas','--surface','--surface-raised','--surface-inset','--surface-hover']) check(theme,fg,bg,3);
    for(const role of ['danger','warning','success']) check(theme,`--${role}-border`,`--${role}-soft`,3);
  });
  test(`${theme}: actual component text/background declarations retain 4.5:1`,()=>{
    for(const [,selector,body] of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
      const fg=body.match(/(?:^|;)\s*color:\s*var\((--[\w-]+)\)/)?.[1];
      const bg=body.match(/(?:^|;)\s*background(?:-color)?:\s*var\((--[\w-]+)\)/)?.[1];
      if(fg&&bg){
        assert.doesNotThrow(()=>check(theme,fg,bg,4.5),selector.trim());
      }
    }
  });
}

test('every component token exists in both themes; colors cannot bypass the semantic theme',()=>{
  assert.match(styles,/@import "\.\/design-tokens\.css"/);
  assert.doesNotMatch(styles,/#(?:[\da-f]{3,8})\b|(?:rgb|hsl)a?\(/i);
  assert.doesNotMatch(styles,/html\[data-theme=dark\]/);
  for(const [,name] of styles.matchAll(/var\((--[\w-]+)\)/g)){
    for(const theme of ['light','dark']) assert.ok(themes[theme][name],`${theme}: missing ${name}`);
  }
});
test('small copy is at least 12px and disabled controls do not dim whole containers',()=>{
  for(const [,size] of styles.matchAll(/font-size:\s*(\d+)px/g)) assert.ok(Number(size)>=12,`font-size ${size}px is too small`);
  for(const [,selector,body] of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
    if(selector.includes(':disabled')) assert.doesNotMatch(body,/opacity\s*:/);
  }
  assert.match(styles,/button:disabled,[\s\S]*?color: var\(--disabled-text\)/);
});
