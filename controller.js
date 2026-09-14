export const initialState = () => ({
  version: 1,
  messages: ['', ''],
  ownUserId: '',
  intervalSeconds: 300,
  enabled: false,
  target: null,
  nextIndex: 0,
  nextRunAt: null,
  pending: null,
  error: null,
  history: [],
  lastSentAt: null,
});

export function parseChannel(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://discord.com') return null;
    const match = url.pathname.match(/^\/channels\/(\d+)\/(\d+)(?:\/\d+)?\/?$/);
    return match ? { guildId: match[1], channelId: match[2] } : null;
  } catch { return null; }
}

export function validateSettings(settings) {
  if (settings?.ownUserId && !/^\d{17,20}$/.test(settings.ownUserId)) throw new Error('내 Discord 사용자 ID는 17~20자리 숫자로 입력해 주세요.');
  if (!Array.isArray(settings?.messages) || settings.messages.length !== 2 ||
      settings.messages.some(text => typeof text !== 'string' || !text.trim() || text.length > 2000)) {
    throw new Error('문구 A와 B를 각각 1~2,000자로 입력해 주세요.');
  }
  if (settings.messages.some(text => /@everyone|@here|<@&\d+>/i.test(text))) {
    throw new Error('전체·역할 멘션(@everyone, @here, 역할 태그)은 사용할 수 없습니다.');
  }
  if (!Number.isInteger(settings.intervalSeconds) || settings.intervalSeconds < 30 || settings.intervalSeconds > 86400) {
    throw new Error('전송 주기는 30~86,400초 사이의 정수로 입력해 주세요.');
  }
}

// All mutations are serialized by the service worker. Persist an intent BEFORE
// touching Discord; a lost response then requires manual reconciliation.
export function createController(io) {
  const read = async () => ({ ...initialState(), ...await io.load() });
  const log = (state, kind, text) => {
    state.history = [{ at: io.now(), kind, text }, ...state.history].slice(0, 30);
  };
  const persist = async state => { await io.save(state); return state; };
  const pause = async (state, error) => {
    state.enabled = false;
    state.nextRunAt = null;
    state.error = error;
    log(state, 'error', error);
    await persist(state);
    await io.cancel();
    return state;
  };
  const requireEditable = state => {
    if (state.enabled) throw new Error('먼저 자동 전송을 중지해 주세요.');
    if (state.pending) throw new Error('이전 전송 결과를 먼저 확인해 주세요.');
  };
  const inspect = async target => {
    try { return await io.inspect(target); }
    catch { return { ok: false, error: '대상 탭에 연결할 수 없습니다. Discord 페이지를 확인해 주세요.' }; }
  };
  const api = {
    getState: read,
    async updateSettings(settings) {
      validateSettings(settings);
      const state = await read();
      requireEditable(state);
      state.messages = [...settings.messages];
      state.ownUserId = settings.ownUserId || '';
      state.intervalSeconds = settings.intervalSeconds;
      state.error = null;
      return persist(state);
    },
    async bind(target) {
      const state = await read();
      requireEditable(state);
      const channel = parseChannel(target?.url);
      if (!channel || !Number.isInteger(target.tabId) || target.tabId < 0) {
        throw new Error('Discord 서버의 텍스트 채널을 열고 팝업에서 선택해 주세요. DM은 지원하지 않습니다.');
      }
      // Reconnecting the same room from an ordinary tab must not lose its sender.
      if (!target.managed && state.target?.managed &&
          state.target.guildId === channel.guildId && state.target.channelId === channel.channelId) {
        target = { ...target, tabId: state.target.tabId, managed: true, windowManaged: state.target.windowManaged };
      }
      state.target = { tabId: target.tabId, url: `https://discord.com/channels/${channel.guildId}/${channel.channelId}`, ...channel, title: target.title || 'Discord 채널', ...(typeof target.managed === 'boolean' ? { managed: target.managed } : {}), ...(target.windowManaged ? {windowManaged: true} : {}) };
      state.error = null;
      log(state, 'info', `대상 채널 선택: ${state.target.title}`);
      return persist(state);
    },
    async start() {
      const state = await read();
      if (state.pending) throw new Error('이전 메시지가 발송되었는지 확인하고 전송 결과를 선택해 주세요.');
      if (state.enabled) return state;
      validateSettings(state);
      if (!state.target) throw new Error('현재 Discord 채널을 먼저 선택해 주세요.');
      const result = await inspect({ ...state.target, ownUserId: state.ownUserId });
      if (!result.ok) throw new Error(result.error);
      state.enabled = true;
      state.error = null;
      state.nextRunAt = io.now();
      log(state, 'info', `${state.nextIndex === 0 ? 'A' : 'B'}부터 자동 전송을 시작합니다.`);
      await persist(state);
      return api.tick();
    },
    async stop() {
      const state = await read();
      state.enabled = false;
      state.nextRunAt = null;
      log(state, 'info', '자동 전송을 중지했습니다. 다음 문구 순서는 유지됩니다.');
      await persist(state);
      await io.cancel();
      return state;
    },
    async tick() {
      const state = await read();
      if (!state.enabled) return state;
      if (state.pending) return pause(state, '이전 전송 결과가 확인되지 않아 중지했습니다. 채널을 확인해 주세요.');
      if (state.nextRunAt == null) return pause(state, '다음 예약 시간이 없어 중지했습니다. 다시 시작해 주세요.');
      if (state.nextRunAt > io.now()) {
        try { await io.schedule(state.nextRunAt); }
        catch { return pause(state, '예약을 복원하지 못해 중지했습니다.'); }
        return state;
      }
      const result = await inspect({ ...state.target, ownUserId: state.ownUserId });
      if (!result.ok) return pause(state, result.error);
      state.pending = { id: io.id(), index: state.nextIndex, text: state.messages[state.nextIndex], startedAt: io.now() };
      // Keep a watchdog alarm in case the worker is terminated during delivery.
      try { await io.schedule(io.now() + 60000); }
      catch {
        state.pending = null;
        return pause(state, '전송 확인용 예약을 등록할 수 없어 발송 전에 중지했습니다.');
      }
      await persist(state);
      let response;
      try { response = await io.send({ ...state.target, ownUserId: state.ownUserId }, state.pending); }
      catch { response = { status: 'uncertain', error: '전송 응답을 받지 못했습니다. 실제 채널에서 발송 여부를 확인해 주세요.' }; }
      if (response?.status === 'confirmed') {
        log(state, 'success', `문구 ${state.pending.index === 0 ? 'A' : 'B'} 전송 확인`);
        state.nextIndex = 1 - state.pending.index;
        state.pending = null;
        state.lastSentAt = io.now();
        state.error = null;
        state.nextRunAt = io.now() + state.intervalSeconds * 1000;
        await persist(state);
        try { await io.schedule(state.nextRunAt); }
        catch { return pause(state, '다음 예약을 등록하지 못해 중지했습니다.'); }
        return state;
      }
      if (response?.status === 'blocked') state.pending = null;
      return pause(state, response?.error || '전송 결과가 불확실합니다. 채널에서 확인해 주세요.');
    },
    async resolvePending(resolution) {
      const state = await read();
      if (state.enabled || !state.pending) throw new Error('확인이 필요한 중지된 전송이 없습니다.');
      if (!['sent', 'not-sent'].includes(resolution)) throw new Error('올바른 전송 결과를 선택해 주세요.');
      if (resolution === 'sent') {
        state.nextIndex = 1 - state.pending.index;
        state.lastSentAt = state.pending.startedAt;
      }
      state.pending = null;
      state.error = null;
      log(state, 'info', resolution === 'sent' ? '사용자가 발송 완료를 확인했습니다. 다음 문구로 이어집니다.' : '사용자가 미발송을 확인했습니다. 같은 문구로 이어집니다.');
      return persist(state);
    },
    async recover({ preserveDue = false } = {}) {
      const state = await read();
      if (state.pending) return pause(state, '중단된 전송이 있습니다. 채널에서 발송 여부를 확인한 뒤 재개해 주세요.');
      if (!state.enabled) { await io.cancel(); return state; }
      const result = await inspect({ ...state.target, ownUserId: state.ownUserId });
      if (!result.ok) return pause(state, result.error);
      // Never replay every missed interval after sleep or browser restart.
      if (!state.nextRunAt || (!preserveDue && state.nextRunAt < io.now())) {
        state.nextRunAt = io.now() + state.intervalSeconds * 1000;
        await persist(state);
      }
      try { await io.schedule(state.nextRunAt); }
      catch { return pause(state, '예약 복구에 실패해 중지했습니다. 다시 시작해 주세요.'); }
      return state;
    },
    async targetLost(tabId, reason) {
      const state = await read();
      if (state.target?.tabId !== tabId || !state.enabled) return state;
      return pause(state, reason);
    },
  };
  return api;
}
