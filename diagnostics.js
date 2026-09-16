// Explicit allowlist: never serialize channel state, message bodies or credentials.
export function diagnosticEvents(previous, current, now = Date.now()) {
  return (current?.channels || []).flatMap((channel, index) => {
    const before = previous?.channels?.find(item => item.id === channel.id);
    const events = [];
    const base = {at: new Date(now).toISOString(), channel: index + 1,
      intervalSeconds: channel.intervalSeconds, nextRunAt: channel.nextRunAt,
      pending: Boolean(channel.pending), nextMessage: channel.nextIndex === 1 ? 'B' : 'A',
      dedicatedTab: Boolean(channel.target?.managed), dedicatedWindow: Boolean(channel.target?.windowManaged)};
    if (channel.error && channel.error !== before?.error) events.push({...base, kind:'error', reason:String(channel.error).slice(0,500)});
    if (before && before.enabled !== channel.enabled) events.push({...base, kind:channel.enabled?'started':channel.error?'automatic-stop':'stopped', reason:channel.error ? String(channel.error).slice(0,500) : '실행 상태 변경'});
    if (before && channel.lastSentAt && channel.lastSentAt !== before.lastSentAt) events.push({...base,kind:'delivery-confirmed'});
    if (before && !before.pending && channel.pending) events.push({...base,kind:'delivery-started'});
    return events;
  });
}
export async function recordDiagnostics(api, previous, current) {
  const events = diagnosticEvents(previous,current);
  if (!events.length) return;
  const {diagnosticLog=[]} = await api.storage.local.get('diagnosticLog');
  await api.storage.local.set({diagnosticLog:[...diagnosticLog,...events].slice(-500)});
}
