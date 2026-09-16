import { queueEmailReport } from './email-report.js';
// Explicit allowlist: never serialize channel state, message bodies or credentials.
const numericId = value => /^\d{1,20}$/.test(String(value ?? '')) ? String(value) : null;
export function channelDiagnostic(channel = {}, index = -1, revision = null) {
  const delivery=channel.pending || channel.prepared;
  return {channel:index+1,channelKey:String(channel.id || '').slice(0,100),rootRevision:revision,
    settingsRevision:channel.settingsRevision ?? null,discordGuildId:numericId(channel.target?.guildId),
    discordChannelId:numericId(channel.target?.channelId),tabId:Number.isInteger(channel.target?.tabId)?channel.target.tabId:null,
    intervalSeconds:channel.intervalSeconds ?? null,slowmodeSeconds:channel.slowmodeSeconds ?? null,
    slowmodeUntil:channel.slowmodeUntil ?? null,skipConfirmation:channel.skipConfirmation===true,
    nextRunAt:channel.nextRunAt ?? null,lastAttemptOrConfirmedAt:channel.lastSentAt ?? null,
    lastOutcome:channel.lastOutcome ?? null,lastDeliveryId:channel.lastDeliveryId ?? null,enabled:channel.enabled===true,
    ...(delivery?{deliveryId:delivery.id,deliveryScheduledAt:delivery.scheduledAt,deliveryStartedAt:delivery.startedAt,deliveryMessage:delivery.index===1?'B':'A',deliveryPhase:channel.pending?'commit':delivery.phase}:{}),
    pending:Boolean(channel.pending),nextMessage:channel.nextIndex===1?'B':'A'};
}
export function uiDiagnostic(message,state,now=Date.now()) {
  const index=state.channels.findIndex(c=>c.id===message.channelKey);
  if(index<0)return null;
  const event={...channelDiagnostic(state.channels[index],index,state.revision),at:new Date(now).toISOString(),kind:'ui-schedule'};
  for(const key of ['displayedAt','displayedRootRevision','displayedSettingsRevision','displayedIntervalSeconds','displayedNextRunAt','displayedRemainingSeconds']) {
    if(message[key]===null || Number.isFinite(message[key]))event[key]=message[key];
  }
  event.displayedDiscordChannelId=numericId(message.displayedDiscordChannelId);
  event.formChannelKey=String(message.formChannelKey || '').slice(0,100);
  event.draftDirty=message.draftDirty===true;
  if(['pending','stopped','preparing','ready','waiting'].includes(message.displayedMode))event.displayedMode=message.displayedMode;
  return event;
}
export function diagnosticEvents(previous, current, now = Date.now()) {
  return (current?.channels || []).flatMap((channel, index) => {
    const before = previous?.channels?.find(item => item.id === channel.id);
    const events = [];
    const deliveryId = channel.pending?.id || before?.pending?.id;
    const base = { ...channelDiagnostic(channel,index,current.revision), ...(deliveryId ? {deliveryId} : {}), at: new Date(now).toISOString(), channel: index + 1,
      intervalSeconds: channel.intervalSeconds, nextRunAt: channel.nextRunAt,
      pending: Boolean(channel.pending), nextMessage: channel.nextIndex === 1 ? 'B' : 'A',
      dedicatedTab: Boolean(channel.target?.managed), dedicatedWindow: Boolean(channel.target?.windowManaged)};
    if (before && (channel.settingsRevision!==before.settingsRevision || channel.intervalSeconds!==before.intervalSeconds || channel.skipConfirmation!==before.skipConfirmation)) events.push({...base,kind:'settings-changed',previousIntervalSeconds:before.intervalSeconds,previousSettingsRevision:before.settingsRevision,previousSkipConfirmation:before.skipConfirmation===true});
    if (!before || channel.target?.channelId!==before.target?.channelId || channel.target?.tabId!==before.target?.tabId) events.push({...base,kind:'channel-binding',previousDiscordChannelId:numericId(before?.target?.channelId),previousTabId:before?.target?.tabId ?? null});
    if (before && channel.nextRunAt!==before.nextRunAt) events.push({...base,kind:'schedule-changed',previousNextRunAt:before.nextRunAt ?? null});
    if(channel.prepared && (channel.prepared.id!==before?.prepared?.id || channel.prepared.phase!==before?.prepared?.phase)) events.push({...base,deliveryId:channel.prepared.id,kind:channel.prepared.phase==='ready'?'preparation-ready':'preparation-started'});
    if (channel.slowmodeSeconds && channel.slowmodeSeconds !== before?.slowmodeSeconds) events.push({...base,kind:'slowmode-minimum',slowmodeSeconds:channel.slowmodeSeconds,minimumSeconds:Math.max(30,channel.slowmodeSeconds+3)});
    if (channel.slowmodeUntil && channel.slowmodeUntil !== before?.slowmodeUntil) events.push({...base,kind:'slowmode-wait',until:channel.slowmodeUntil});
    if ((channel.draftRetries || 0) > (before?.draftRetries || 0)) events.push({...base,kind:'draft-retry-scheduled',attempt:channel.draftRetries});
    if (channel.error && channel.error !== before?.error) events.push({...base, kind:'error', reason:String(channel.error).slice(0,500)});
    if (before && before.enabled !== channel.enabled) events.push({...base, kind:channel.enabled?'started':channel.error?'automatic-stop':'stopped', reason:channel.error ? String(channel.error).slice(0,500) : '실행 상태 변경'});
    if (before && channel.lastSentAt && channel.lastSentAt !== before.lastSentAt) events.push({...base,kind:channel.lastOutcome==='unverified'?'delivery-unverified':before.pending && !before.enabled ? 'manual-confirmed' : 'delivery-confirmed'});
    if (before?.pending && !before.enabled && !channel.pending && channel.lastSentAt === before.lastSentAt) events.push({...base,kind:'manual-not-sent'});
    if (before && !before.pending && channel.pending) events.push({...base,kind:'delivery-started'});
    return events;
  });
}
export async function recordDiagnostics(api, previous, current) {
  const events = diagnosticEvents(previous,current);
  if (!events.length) return;
  return appendDiagnostics(api,events);
}
let writes = Promise.resolve();
export function appendDiagnostics(api,events) {
  const next=writes.then(async()=>{
  const {diagnosticLog=[],diagnosticTimeline=[]} = await api.storage.local.get(['diagnosticLog','diagnosticTimeline']);
  await api.storage.local.set({diagnosticLog:[...diagnosticLog,...events].slice(-500),diagnosticTimeline:[...diagnosticTimeline,...events.filter(e=>e.kind!=='delivery-trace' || ['enter-dispatched','finished','stability-failed','editor-recovered'].includes(e.stage))].slice(-2000)});
  await queueEmailReport(api,events);
  });
  writes=next.catch(()=>{});
  return next;
}

const TRACE_STAGES = new Set(['received','before-paste','after-paste','before-enter','enter-dispatched','observation','finished','exception','draft-reused','draft-replaced','slowmode-wait','reconcile','prior-post-confirmed','prepared','prepared-verified','paste-dispatched','stability-failed','editor-recovered']);
const TRACE_BOOLEANS = ['pageHidden','documentFocused','editorFocused','editorConnected','editorReplaced','selectionInside','selectionCollapsed','textMatches','draftEmpty','composing','pastePrevented','enterPrevented','keyupPrevented','newMessage','matchingMessage','sendingSeen','failedSeen','authorMismatch','authorUnknown','timeMismatch','targetMatches','slowmodeDetected','draftMatchesA','draftMatchesB','draftHasVoid','whitespaceOnlyDifference','unsupportedEditorContent'];
const TRACE_NUMBERS = ['elapsedMs','latenessMs','editorCount','draftLength','selectionRanges','cooldownMs','slowmodeSeconds','eventAt','scheduledAt','startedAt','maxStableMs','stableRequiredMs','stableWaitMs','expectedLength','messageALength','messageBLength','draftLineCount','expectedLineCount','renderedDraftLength'];
export function deliveryTraceEvent(message, state, tabId, now=Date.now()) {
  const index=state.channels.findIndex(c=>c.target?.tabId===tabId && (c.pending?.id===message.id || c.prepared?.id===message.id || c.lastDeliveryId===message.id));
  if(index<0 || !TRACE_STAGES.has(message.stage)) return null;
  const event={...channelDiagnostic(state.channels[index],index,state.revision),at:new Date(now).toISOString(),kind:'delivery-trace',channel:index+1,deliveryId:message.id,stage:message.stage};
  if([0,1].includes(message.data?.messageIndex))event.deliveryMessage=message.data.messageIndex===1?'B':'A';
  if(['prepare','commit','send'].includes(message.data?.deliveryPhase))event.deliveryPhase=message.data.deliveryPhase;
  if (/^\d+\.\d+\.\d+$/.test(message.version||'')) event.contentVersion=message.version;
  for(const key of TRACE_BOOLEANS) if(typeof message.data?.[key]==='boolean') event[key]=message.data[key];
  for(const key of TRACE_NUMBERS) if(Number.isFinite(message.data?.[key])) event[key]=['eventAt','scheduledAt','startedAt'].includes(key)?Math.round(message.data[key]):Math.max(-86400000,Math.min(86400000,Math.round(message.data[key])));
  const path=String(message.data?.observedPath || '').match(/^\/channels\/(\d{1,20})\/(\d{1,20})(?:\/\d{1,20})?\/?$/);
  if(path){event.observedGuildId=path[1];event.observedChannelId=path[2];}
  const checks=['channel_changed','editor_detached','editor_count','editor_replaced','text_mismatch','composing','focus_lost','selection_missing','selection_not_collapsed','selection_outside'];
  if(Array.isArray(message.data?.failedChecks))event.failedChecks=checks.filter(key=>message.data.failedChecks.includes(key));
  if(message.data?.failureCounts)event.failureCounts=Object.fromEntries(checks.filter(key=>Number.isInteger(message.data.failureCounts[key])).map(key=>[key,Math.max(0,Math.min(10000,message.data.failureCounts[key]))]));
  if(['slate','rendered'].includes(message.data?.editorReadMode))event.editorReadMode=message.data.editorReadMode;
  if(['confirmed','uncertain','blocked','draft-retained','deferred','prepared','unverified'].includes(message.data?.result)) event.result=message.data.result;
  if (['empty','replace-next','reuse-next'].includes(message.data?.draftAction)) event.draftAction=message.data.draftAction;
  return event;
}

export function inspectionDiagnostic(result,channel,index,revision,now=Date.now()) {
  const event={...channelDiagnostic(channel,index,revision),at:new Date(now).toISOString(),kind:'inspection-failed'};
  const data=result.diagnostics || {};
  if(['slate','rendered'].includes(data.editorReadMode))event.editorReadMode=data.editorReadMode;
  if(/^[A-Z_]{1,40}$/.test(result.code || ''))event.code=result.code;
  if(/^\d+\.\d+\.\d+$/.test(data.contentVersion || ''))event.contentVersion=data.contentVersion;
  for(const key of TRACE_BOOLEANS)if(typeof data[key]==='boolean')event[key]=data[key];
  for(const key of TRACE_NUMBERS)if(Number.isFinite(data[key]))event[key]=Math.max(-86400000,Math.min(86400000,Math.round(data[key])));
  return event;
}
