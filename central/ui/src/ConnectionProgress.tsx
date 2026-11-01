import type {Snapshot} from './api'
import {connectionProgress} from './connection-progress'
const labels=['브라우저 연결','계정 확인','채널 확인','설정 적용']
export function ConnectionProgress({s}:{s:Snapshot}){
 return <section className="panel"><div className="panel-head"><div><h2>자동 연결 진행 상황</h2><p>저장된 연결을 복구하고 실제 계정·채널과 설정 적용을 확인합니다.</p></div></div><div style={{padding:20,display:'grid',gap:16}}>{s.instances.length?s.instances.map(instance=>{const state=connectionProgress(s,instance);return <article key={instance.id} style={{border:'1px solid var(--border, #dfe6f0)',borderRadius:10,padding:16}}><strong>{instance.name} · {state.label}</strong><ol aria-label={`${instance.name} 연결 단계`} style={{display:'flex',flexWrap:'wrap',gap:20,paddingLeft:20,marginBottom:0}}>{labels.map((label,index)=><li key={label}><span aria-label={state.steps[index]?'완료':'대기'}>{state.steps[index]?'✓':'○'}</span> {label}</li>)}</ol></article>}):<p>각 브라우저에서 확장을 연결하면 진행 상황이 표시됩니다.</p>}</div></section>
}
