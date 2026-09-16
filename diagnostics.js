import { queueEmailReport } from './email-report.js';
// Explicit allowlist: never serialize channel state, message bodies or credentials.
export function diagnosticEvents(previous, current, now = Date.now()) {
  return (current?.channels || []).flatMap((channel, index) => {
    const before = previous?.channels?.find(item => item.id === channel.id);
    const events = [];
    const deliveryId = channel.pending?.id || before?.pending?.id;
    const base = { ...(deliveryId ? {deliveryId} : {}), at: new Date(now).toISOString(), channel: index + 1,
      intervalSeconds: channel.intervalSeconds, nextRunAt: channel.nextRunAt,
      pending: Boolean(channel.pending), nextMessage: channel.nextIndex === 1 ? 'B' : 'A',
      dedicatedTab: Boolean(channel.target?.managed), dedicatedWindow: Boolean(channel.target?.windowManaged)};
    if (channel.slowmodeUntil && channel.slowmodeUntil !== before?.slowmodeUntil) events.push({...base,kind:'slowmode-wait',until:channel.slowmodeUntil});
    if ((channel.draftRetries || 0) > (before?.draftRetries || 0)) events.push({...base,kind:'draft-retry-scheduled',attempt:channel.draftRetries});
    if (channel.error && channel.error !== before?.error) events.push({...base, kind:'error', reason:String(channel.error).slice(0,500)});
    if (before && before.enabled !== channel.enabled) events.push({...base, kind:channel.enabled?'started':channel.error?'automatic-stop':'stopped', reason:channel.error ? String(channel.error).slice(0,500) : '실행 상태 변경'});
    if (before && channel.lastSentAt && channel.lastSentAt !== before.lastSentAt) events.push({...base,kind:before.pending && !before.enabled ? 'manual-confirmed' : 'delivery-confirmed'});
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
  const {diagnosticLog=[]} = await api.storage.local.get('diagnosticLog');
  await api.storage.local.set({diagnosticLog:[...diagnosticLog,...events].slice(-500)});
  await queueEmailReport(api,events);
  });
  writes=next.catch(()=>{});
  return next;
}

const TRACE_STAGES = new Set(['received','before-paste','after-paste','before-enter','enter-dispatched','observation','finished','exception','draft-reused','draft-replaced','slowmode-wait']);
const TRACE_BOOLEANS = ['pageHidden','documentFocused','editorFocused','editorConnected','editorReplaced','selectionInside','selectionCollapsed','textMatches','draftEmpty','composing','pastePrevented','enterPrevented','keyupPrevented','newMessage','matchingMessage','sendingSeen','failedSeen','authorMismatch','authorUnknown','timeMismatch','targetMatches','slowmodeDetected'];
const TRACE_NUMBERS = ['elapsedMs','latenessMs','editorCount','draftLength','selectionRanges','cooldownMs'];
export function deliveryTraceEvent(message, state, tabId, now=Date.now()) {
  const index=state.channels.findIndex(c=>c.target?.tabId===tabId && c.pending?.id===message.id);
  if(index<0 || !TRACE_STAGES.has(message.stage)) return null;
  const event={at:new Date(now).toISOString(),kind:'delivery-trace',channel:index+1,deliveryId:message.id,stage:message.stage};
  if (/^\d+\.\d+\.\d+$/.test(message.version||'')) event.contentVersion=message.version;
  for(const key of TRACE_BOOLEANS) if(typeof message.data?.[key]==='boolean') event[key]=message.data[key];
  for(const key of TRACE_NUMBERS) if(Number.isFinite(message.data?.[key])) event[key]=Math.max(-86400000,Math.min(86400000,Math.round(message.data[key])));
  if(['confirmed','uncertain','blocked','draft-retained','deferred'].includes(message.data?.result)) event.result=message.data.result;
  return event;
}
