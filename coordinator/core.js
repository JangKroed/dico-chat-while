const snowflake = value => typeof value==='string' && /^\d{17,20}$/.test(value);
const identifier = value => typeof value==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

export function validateConfig(config) {
  if (!config?.groups || Array.isArray(config.groups)) throw Error('groups 설정이 필요합니다.');
  const groups={};
  for (const name of Object.keys(config.groups).sort()) {
    const g=config.groups[name];
    if (!identifier(name) || ['__proto__','constructor','prototype'].includes(name) ||
        !Array.isArray(g?.members) || g.members.length<2 || g.members.length>100 ||
        g.members.some(m=>!snowflake(m)) || new Set(g.members).size!==g.members.length ||
        !snowflake(g.channelId) || !Number.isInteger(g.gapSeconds) || g.gapSeconds<1 || g.gapSeconds>86400) {
      throw Error('그룹 이름, 멤버 ID, 채널 ID 또는 간격 설정이 올바르지 않습니다.');
    }
    groups[name]={members:[...g.members],channelId:g.channelId,gapSeconds:g.gapSeconds};
  }
  if (!Object.keys(groups).length) throw Error('한 개 이상의 그룹이 필요합니다.');
  return {groups};
}

// One serialized writer. An issued permit never expires: an offline sender can
// still have an Enter in flight. Only an explicit outcome closes that permit.
export function createCoordinator(config, io) {
  config=validateConfig(config);
  const fingerprint=JSON.stringify(config);
  let state, queue=Promise.resolve(),storageFailed=false,persisted=false;
  const run = action => {
    const result=queue.then(async()=>{
      if (storageFailed) throw Error('저장 오류 이후에는 조정기를 재시작해야 합니다.');
      if (!state) {
        const saved=await io.load();
        if (saved!=null) {
          if (saved.version!==1 || saved.config!==fingerprint || !saved.groups ||
              Object.keys(saved.groups).length!==Object.keys(config.groups).length) throw Error('저장 상태가 손상되었거나 그룹 설정이 변경됐습니다. 원래 설정과 상태를 복구하세요.');
          for (const [name, c] of Object.entries(config.groups)) {
            const g=saved.groups[name];
            if (!g || !Number.isInteger(g.turn) || g.turn<0 || g.turn>=c.members.length ||
                !Number.isFinite(g.notBefore) || g.notBefore<0 || !g.bindings || !g.closed ||
                typeof g.bindings!=='object' || Array.isArray(g.bindings) || typeof g.closed!=='object' || Array.isArray(g.closed) ||
                Object.entries(g.bindings).some(([m,id])=>!c.members.includes(m) || !identifier(id)) ||
                Object.entries(g.closed).some(([id,v])=>!identifier(id) || !c.members.includes(v?.member) || !identifier(v?.clientId) || !['confirmed','not-sent'].includes(v?.outcome)) ||
                (g.active!==null && (!identifier(g.active?.attemptId) || g.active?.member!==c.members[g.turn] || g.bindings[g.active.member]!==g.active.clientId || Object.hasOwn(g.closed,g.active.attemptId)))) throw Error('저장 상태가 손상되었습니다.');
          }
          state=structuredClone(saved);
          persisted=true;
        } else state={version:1,config:fingerprint,groups:Object.fromEntries(Object.keys(config.groups).map(name=>[name,{turn:0,notBefore:0,active:null,bindings:{},closed:{}}]))};
      }
      const next=structuredClone(state);
      const result=action(next);
      // A failed fsync/rename cannot authorize a send or advance the turn.
      if (!persisted || JSON.stringify(next)!==JSON.stringify(state)) {
        try { await io.save(next);persisted=true; }
        catch(error) {storageFailed=true;throw error;}
      }
      state=next;
      return result;
    });
    queue=result.catch(()=>{});
    return result;
  };
  const locate = (next, r) => {
    if (!r || !Object.hasOwn(config.groups,r.group) || !identifier(r.clientId) || !identifier(r.attemptId) || ['__proto__','constructor','prototype'].includes(r.attemptId)) throw Error('잘못된 발송 요청입니다.');
    const c=config.groups[r.group], g=next.groups[r.group];
    if (!c.members.includes(r.member) || r.channelId!==c.channelId) throw Error('등록된 계정 또는 대상 채널과 다릅니다.');
    if (Object.hasOwn(g.bindings,r.member) && g.bindings[r.member]!==r.clientId) throw Error('이미 다른 브라우저 또는 채널 설정에 연결된 계정입니다.');
    g.bindings[r.member]=r.clientId;
    return {c,g};
  };
  return {
    acquire: r => run(next=>{
      const {c,g}=locate(next,r);
      if (Object.hasOwn(g.closed,r.attemptId) || g.active?.attemptId===r.attemptId) throw Error('이미 사용한 발송 허가입니다. 재사용할 수 없습니다. 발송 결과를 확인하세요.');
      if (g.active || c.members[g.turn]!==r.member || io.now()<g.notBefore) return {allowed:false,waitMs:Math.max(1000,g.notBefore-io.now()),turn:c.members[g.turn]};
      g.active={attemptId:r.attemptId,member:r.member,clientId:r.clientId};
      return {allowed:true};
    }),
    finish: r => run(next=>{
      const {g,c}=locate(next,r);
      if (!['confirmed','not-sent'].includes(r.outcome)) throw Error('올바른 전송 결과가 필요합니다.');
      const previous=g.closed[r.attemptId];
      if (previous) {
        if (previous.member!==r.member || previous.clientId!==r.clientId || previous.outcome!==r.outcome) throw Error('이전에 기록한 발송 결과와 다릅니다.');
        return {ok:true};
      }
      // An acquire may never have reached the server. Explicitly cancelling
      // that unknown ID tombstones it without touching another live permit.
      if (r.outcome==='not-sent' && g.active?.attemptId!==r.attemptId) {
        g.closed[r.attemptId]={member:r.member,clientId:r.clientId,outcome:r.outcome};
        return {ok:true};
      }
      if (g.active?.attemptId!==r.attemptId || g.active.member!==r.member || g.active.clientId!==r.clientId) throw Error('진행 중인 발송 허가와 다릅니다.');
      g.closed[r.attemptId]={member:r.member,clientId:r.clientId,outcome:r.outcome};
      g.active=null;
      if (r.outcome==='confirmed') { g.turn=(g.turn+1)%c.members.length;g.notBefore=io.now()+c.gapSeconds*1000; }
      return {ok:true};
    }),
    status: () => run(next=>Object.fromEntries(Object.entries(next.groups).map(([name,g])=>[name,{turn:config.groups[name].members[g.turn],notBefore:g.notBefore,active:g.active,bindings:g.bindings}]))),
  };
}
