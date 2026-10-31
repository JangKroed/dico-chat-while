const fresh=()=>({version:1,instanceId:null,sessionId:null,legacyDeclaration:null,emergencyStopped:false,bindings:{},attempts:{},processed:{},stoppedGroups:{},stoppedRuns:{},lastError:null});
export function createCentralExecutor({chrome,transport,openChannel,now=Date.now,monotonicNow=()=>performance.now()}) {
  let state,loading,writes=Promise.resolve();const lanes=new Map(),volatileStops=new Set(),volatileStoppedRuns=new Set();
  const load=()=>loading??=(async()=>{state={...fresh(),...(await chrome.storage.local.get('dicoCentral')).dicoCentral};return state;})();
  const save=()=>{const snapshot=structuredClone(state);const task=writes.then(()=>chrome.storage.local.set({dicoCentral:snapshot}));writes=task.catch(()=>{});return task;};
  const request=async message=>transport.request({...message,sessionId:state.sessionId},state.instanceId);
  const ack=(c,status,extra={})=>request({type:'ACK',commandId:c.id,status,...extra});
  const target=a=>({tabId:a.tabId,guildId:a.guildId,channelId:a.channelId,ownUserId:a.accountId,coordinated:true,managed:true,skipConfirmation:false,messages:[a.body,a.body],expectedText:a.body});
  const delivery=a=>({id:a.attemptId,index:0,text:a.body,startedAt:a.startedAt,scheduledAt:a.startedAt,strictAuthorization:true,...(a.phase==='preparing'?{phase:'prepare'}:{phase:'commit'})});
  const matches=(a,p)=>['bindingId','accountId','guildId','channelId','tabId','configVersion','body'].every(k=>a[k]===p[k]);
  const tabMatches=async a=>{try{const tab=await chrome.tabs.get(a.tabId);return new URL(tab.url).pathname===`/channels/${a.guildId}/${a.channelId}` && new URL(tab.url).origin==='https://discord.com';}catch{return false;}};
  async function canSend(message,tabId) {
    await load();const a=state.attempts[message.id];
    const localAllowed=()=>{
      if(!transport.connected || state.emergencyStopped || !a || a.tabId!==tabId || a.sessionId!==state.sessionId || volatileStops.has(a.groupId) || state.stoppedGroups[a.groupId] || state.stoppedRuns[a.runId] || volatileStoppedRuns.has(a.runId))return false;
      const config=state.bindings[a.bindingId];if(!config || config.configVersion!==a.configVersion)return false;
      return message.phase==='prepare'?a.phase==='preparing':a.phase==='executing' && Boolean(a.permitId) && a.enterRequested===true;
    };
    if(!localAllowed())return false;
    if(message.phase==='prepare')return true;
    // Revalidate service state immediately before Enter, including any sleep,
    // stale run, configuration change or global pause since the permit arrived.
    const started=now(),monoStarted=monotonicNow();
    try{
      const response=await request({type:'AUTHORIZE_ENTER',attemptId:a.attemptId,runId:a.runId,configVersion:a.configVersion});
      const elapsed=now()-started,monoElapsed=monotonicNow()-monoStarted;
      return elapsed>=0&&elapsed<=2000&&monoElapsed>=0&&monoElapsed<=2000&&Math.abs(elapsed-monoElapsed)<=1000&&response?.allowed===true&&localAllowed();
    }catch{return false;}
  }
  async function report(a) {
    await request({type:'DELIVERY_RESULT',attemptId:a.attemptId,outcome:a.result?.outcome || 'unknown',messageId:a.result?.messageId,confirmationMs:a.result?.confirmationMs,executionBlocked:a.result?.executionBlocked===true,reasonCode:a.result?.reasonCode || 'executor_result'});
    a.reported=true;await save();
  }
  async function perform(c) {
    const p=c.payload || {};
    if(c.sessionId!==state.sessionId || c.instanceId!==state.instanceId)return;
    if(state.processed[c.id])return;
    await ack(c,'received');
    if(c.type==='OPEN_CHANNEL') {
      if(state.emergencyStopped)throw Object.assign(Error('긴급 중지를 해제하고 다시 연결하세요.'),{code:'EXECUTION_STOPPED'});
      if(typeof openChannel!=='function')throw Object.assign(Error('채널 연결 기능을 지원하는 확장으로 업데이트하세요.'),{code:'OPEN_CHANNEL_UNSUPPORTED'});
      await openChannel({...p,commandId:c.id});await ack(c,'applied');
    } else if(c.type==='CONFIG_SYNC') {
      if(Object.values(state.attempts).some(a=>a.bindingId===p.bindingId && ['preparing','prepared','executing','unknown'].includes(a.phase)))throw Error('진행 중 발송 결과를 먼저 확인하세요.');
      state.bindings[p.bindingId]=structuredClone(p);await save();await ack(c,'applied');
    } else if(c.type==='PREPARE') {
      if(!p.runId || state.stoppedRuns[p.runId] || volatileStoppedRuns.has(p.runId) || state.emergencyStopped)throw Error('이미 중지된 실행의 입력 준비를 다시 시작할 수 없습니다.');
      const config=state.bindings[p.bindingId];
      if(!config || config.configVersion!==p.configVersion || config.accountId!==p.accountId || config.channelId!==p.channelId || !await tabMatches(p))throw Object.assign(Error('채널 또는 적용된 구성 버전이 다릅니다.'),{code:'CONFIG_MISMATCH'});
      let a=state.attempts[p.attemptId];
      if(!a) {
        delete state.stoppedGroups[p.groupId];volatileStops.delete(p.groupId);
        a={...structuredClone(p),sessionId:state.sessionId,phase:'preparing',startedAt:now(),enterRequested:false};state.attempts[p.attemptId]=a;await save();
      } else if(!matches(a,p) || a.sessionId!==state.sessionId || !['preparing','prepared'].includes(a.phase))throw Error('기존 발송 시도를 다시 준비할 수 없습니다.');
      if(a.phase!=='prepared') {
        let result;
        try{result=await chrome.tabs.sendMessage(a.tabId,{type:'DICO_PREPARE',target:target(a),delivery:delivery(a)});}catch{throw Object.assign(Error('전송용 Discord 탭의 확장 스크립트에 연결하지 못했습니다. 탭을 새로고침하고 연결을 확인하세요.'),{code:'CONTENT_UNAVAILABLE'});}
        if(result?.status!=='prepared')throw Object.assign(Error(result?.error || '입력 준비 결과를 확인하지 못했습니다.'),{code:/^[A-Z][A-Z0-9_]{0,63}$/.test(result?.code||'')?result.code:'PREPARE_REJECTED'});
        a.phase='prepared';await save();
      }
      if(volatileStops.has(a.groupId) || state.stoppedGroups[a.groupId])throw Error('중지 요청으로 준비를 취소했습니다.');
      await request({type:'PREPARED',attemptId:a.attemptId,configVersion:a.configVersion,accountId:a.accountId,channelId:a.channelId,draftClear:true});await ack(c,'applied');
    } else if(c.type==='COMMIT_PERMIT') {
      const a=state.attempts[p.attemptId];
      if(!a || !matches(a,p) || a.runId!==p.runId || state.stoppedRuns[p.runId] || volatileStoppedRuns.has(p.runId) || state.emergencyStopped || a.sessionId!==state.sessionId || !p.permitId)throw Error('발송 허가가 준비한 문구와 일치하지 않거나 중지된 실행입니다.');
      if(a.enterRequested) {if(!a.reported)await report(a);await ack(c,'applied');}
      else {
        if(a.phase!=='prepared' || state.stoppedGroups[a.groupId] || volatileStops.has(a.groupId) || !transport.connected || !await tabMatches(a))throw Error('현재 발송을 실행할 수 없습니다.');
        a.permitId=p.permitId;a.phase='executing';a.enterRequested=true;await save();
        let result;
        try{result=await chrome.tabs.sendMessage(a.tabId,{type:'DICO_DELIVER',target:target(a),delivery:delivery(a)});}catch{result={status:'uncertain'};}
        if(result?.status==='confirmed' && /^\d{17,20}$/.test(result.messageId || '')) {
          a.phase='confirmed';a.result={outcome:'confirmed',messageId:result.messageId,confirmationMs:result.timing?.confirmationMs};
        } else if(result?.status==='blocked' || result?.status==='deferred') {
          a.phase='not_sent';a.result={outcome:'not_sent',executionBlocked:true,reasonCode:result.status};
        } else {a.phase='unknown';a.result={outcome:'unknown',reasonCode:result?.status || 'no_response'};}
        await save();await report(a);await ack(c,'applied');
      }
    } else if(c.type==='CONTROL') {
      if(p.runId)state.stoppedRuns[p.runId]=true;
      state.stoppedGroups[p.groupId]=true;volatileStops.add(p.groupId);await save();
      const a=state.attempts[p.attemptId];
      // This lane has drained any in-flight send. Revocation prevents any new
      // Enter, but does not claim an earlier Enter never reached Discord.
      await ack(c,'applied',{executionBlocked:true,...(p.attemptId?{attemptId:p.attemptId}:{})});
      if(a && !a.enterRequested){a.phase='cancelled';await save();}
    } else if(c.type==='RECONCILE') {
      const prior=state.attempts[p.attemptId];
      if(prior?.result?.outcome==='confirmed'){await report(prior);await ack(c,'applied');}
      else {
        const a=prior || {...p,startedAt:now(),phase:'unknown'};
        let result;try{result=await chrome.tabs.sendMessage(a.tabId,{type:'DICO_RECONCILE',target:target(a),delivery:delivery(a)});}catch{}
        if(result?.status==='confirmed' && /^\d{17,20}$/.test(result.messageId || '')){a.phase='confirmed';a.result={outcome:'confirmed',messageId:result.messageId};state.attempts[p.attemptId]=a;await save();await report(a);}
        else await request({type:'DELIVERY_RESULT',attemptId:p.attemptId,outcome:'unknown',reasonCode:'reconcile_inconclusive'});
        await ack(c,'applied');
      }
    } else throw Error('지원하지 않는 중앙 명령입니다.');
    state.processed[c.id]=true;state.lastError=null;await save();
  }
  async function handleCommand(c) {
    if(c?.type==='CONTROL'){volatileStops.add(c.payload?.groupId);if(c.payload?.runId)volatileStoppedRuns.add(c.payload.runId);}
    await load();const key=c.payload?.bindingId || (c.payload?.attemptId && state.attempts[c.payload.attemptId]?.bindingId) || c.payload?.groupId || 'config';
    const job=(lanes.get(key) || Promise.resolve()).then(()=>perform(c)).catch(async error=>{
      state.lastError=String(error.message || error).slice(0,250);await save();
      if(c.sessionId===state.sessionId)try{await ack(c,'rejected',{rejectionCode:/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code||'')?error.code:`${c.type}_FAILED`});}catch{}
    });lanes.set(key,job);return job;
  }
  return {load,save,request,handleCommand,canSend,async setSession(s){await load();state.instanceId=s.instanceId;state.sessionId=s.sessionId;await save();},async declareLegacy(value){await load();if(!['fresh','legacy-stopped'].includes(value))throw Error('기존 실행기 상태를 선택하세요.');state.legacyDeclaration=value;await save();},get state(){return state;},disconnect(){for(const a of Object.values(state?.attempts || {}))volatileStops.add(a.groupId);}};
}
