const DEFAULT_CHANNEL = Object.freeze({
  id: "",
  name: "새 채널",
  settingsRevision: 0,
  messages: ["", ""],
  intervalSeconds: 300,
  ownUserId: "",
  enabled: false,
  target: null,
  nextIndex: 0,
  nextRunAt: null,
  pending: null,
  error: null,
  history: [],
  lastSentAt: null,
});

export function normalizeChannel(value) {
  const channel = value && typeof value === "object" ? value : {};
  return {
    ...DEFAULT_CHANNEL,
    ...channel,
    id: String(channel.id || ""),
    name: String(channel.name || "새 채널"),
    settingsRevision: Number.isInteger(channel.settingsRevision) ? channel.settingsRevision : 0,
    messages: Array.isArray(channel.messages)
      ? [String(channel.messages[0] ?? ""), String(channel.messages[1] ?? "")]
      : [...DEFAULT_CHANNEL.messages],
    intervalSeconds: Number.isInteger(channel.intervalSeconds) ? channel.intervalSeconds : 300,
    ownUserId: String(channel.ownUserId || ""),
    history: Array.isArray(channel.history) ? channel.history : [],
    nextIndex: channel.nextIndex === 1 ? 1 : 0,
  };
}

export function normalizeRootState(value) {
  const state = value && typeof value === "object" ? value : {};
  return {
    version: Number.isInteger(state.version) ? state.version : 2,
    revision: Number.isInteger(state.revision) ? state.revision : 0,
    channels: Array.isArray(state.channels) ? state.channels.map(normalizeChannel) : [],
  };
}

export function settingsBase(channel) {
  const normalized = normalizeChannel(channel);
  return {
    channelId: normalized.id,
    settingsRevision: normalized.settingsRevision,
    name: normalized.name,
    messages: [...normalized.messages],
    intervalText: String(normalized.intervalSeconds),
    ownUserId: normalized.ownUserId,
  };
}

export function draftMatchesBase(draft, base) {
  if (!draft || !base) return true;
  return draft.name === base.name &&
    draft.messages[0] === base.messages[0] &&
    draft.messages[1] === base.messages[1] &&
    draft.intervalText === base.intervalText &&
    draft.ownUserId === base.ownUserId;
}

export function selectExistingChannel(channels, selectedId) {
  if (channels.some(channel => channel.id === selectedId)) return selectedId;
  return channels[0]?.id || null;
}
