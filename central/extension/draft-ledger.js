const terminal=new Set(['confirmed','not_sent','cancelled']);
const sameTarget=(a,b)=>a.bindingId===b.bindingId||(a.accountId===b.accountId&&a.guildId===b.guildId&&a.channelId===b.channelId);
const sameAttempt=(a,b)=>['attemptId','bindingId','accountId','guildId','channelId','tabId','runId','configVersion','body'].every(key=>a[key]===b[key]);
const blocked=reasonCode=>({action:'blocked',reasonCode});

// Keep duplicate protection scoped to delivery identity. Repeated playlist text
// in a later, independently authorized attempt is intentional and remains valid.
export function planDraftPreparation({attempt,attempts={},inspection}){
  if(!attempt||typeof attempt.attemptId!=='string'||!attempt.attemptId||typeof attempt.bindingId!=='string'||!attempt.bindingId||typeof attempt.body!=='string'||!attempt.body.trim())return blocked('PREPARATION_MISMATCH');
  const known=Object.values(attempts);
  const existing=known.find(item=>item?.attemptId===attempt.attemptId);
  if(existing){
    if(!sameAttempt(existing,attempt))return blocked('PREPARATION_MISMATCH');
    if(existing.phase==='confirmed'&&existing.result?.outcome==='confirmed'&&/^\d{17,20}$/.test(existing.result.messageId||''))return{action:'confirmed',messageId:existing.result.messageId};
    if(existing.enterRequested||!['preparing','prepared'].includes(existing.phase))return blocked('ATTEMPT_UNRESOLVED');
  }
  if(known.some(item=>item&&item.attemptId!==attempt.attemptId&&sameTarget(item,attempt)&&!terminal.has(item.phase)))return blocked('ATTEMPT_UNRESOLVED');
  if(inspection?.ok!==true||typeof inspection.draftText!=='string'||typeof inspection.draftMatches!=='boolean'||typeof inspection.unsupported!=='boolean'||typeof inspection.attachmentOrReply!=='boolean')return blocked('DRAFT_INSPECTION_UNAVAILABLE');
  if(inspection.attachmentOrReply)return blocked('ATTACHMENT_OR_REPLY');
  if(inspection.unsupported)return blocked('DRAFT_MISMATCH');
  if(inspection.draftMatches)return{action:'reuse'};
  if(inspection.draftText==='')return{action:'empty'};
  // The exact string is a compare-and-swap token for the content script. A user
  // edit after inspection must never be overwritten by this authorization.
  return{action:'replace',backupText:inspection.draftText,replaceExpectedDraft:inspection.draftText};
}

// Caller must await durable chrome.storage persistence before authorizing the
// replacement. Never include these local drafts in bridge reports or telemetry.
export function recordDraftBackup(state,attempt,text,now=Date.now()){
  if(!state||!attempt?.attemptId||typeof text!=='string'||!text.length||text.length>20000||!Number.isFinite(now))throw Object.assign(Error('초안을 안전하게 보관할 수 없습니다.'),{code:'DRAFT_BACKUP_INVALID'});
  const backups=Array.isArray(state.draftBackups)?state.draftBackups:[];
  const existing=backups.find(item=>item.attemptId===attempt.attemptId&&item.bindingId===attempt.bindingId&&item.accountId===attempt.accountId&&item.guildId===attempt.guildId&&item.channelId===attempt.channelId&&item.text===text);
  if(existing)return existing;
  // Refuse when full instead of silently discarding previously preserved text.
  if(backups.length>=50||backups.reduce((sum,item)=>sum+(typeof item.text==='string'?item.text.length:0),0)+text.length>200000)throw Object.assign(Error('보관한 초안이 가득 찼습니다. 기존 초안을 확인한 뒤 다시 시도하세요.'),{code:'DRAFT_BACKUP_FULL'});
  const backup={id:`${attempt.attemptId}:${backups.length+1}`,attemptId:attempt.attemptId,bindingId:attempt.bindingId,accountId:attempt.accountId,guildId:attempt.guildId,channelId:attempt.channelId,tabId:attempt.tabId,text,createdAt:now};
  state.draftBackups=[...backups,backup];return backup;
}
