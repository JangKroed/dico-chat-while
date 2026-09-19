import { receiptMeasurement, cooldownMeasurement } from './timing-calibration.js';
export const initialState = () => ({
  version: 1,
  messages: ['', ''],
  skipConfirmation: false,
  lastOutcome: null,
  ownUserId: '',
  intervalSeconds: 300,
  slowmodeSeconds: null,
  timingCalibration: null,
  enabled: false,
  target: null,
  nextIndex: 0,
  nextRunAt: null,
  pending: null,
  prepared: null,
  error: null,
  history: [],
  lastSentAt: null,
  lastConfirmedMessageId: null,
  slowmodeUntil: null,
  draftRetries: 0,
  draftRetrySince: null,
  draftRetryPending: null,
});

export function parseChannel(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://discord.com') return null;
    const match = url.pathname.match(/^\/channels\/(\d+)\/(\d+)(?:\/\d+)?\/?$/);
    return match ? { guildId: match[1], channelId: match[2] } : null;
  } catch { return null; }
}

export const minimumInterval = channel => Number.isInteger(channel?.slowmodeSeconds) && channel.slowmodeSeconds>0 && channel.slowmodeSeconds<=21600 ? Math.max(30,channel.slowmodeSeconds+3+Math.max(0,Math.min(30,channel.timingCalibration?.extraSeconds || 0))) : 30;

export function validateSettings(settings) {
  if (settings?.skipConfirmation!==undefined && typeof settings.skipConfirmation!=='boolean') throw new Error('전송 확인 옵션이 올바르지 않습니다.');
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
  const read = async () => {
    const state={...initialState(),...await io.load()};
    // Older versions stored preparation time when the user confirmed a send.
    // Recover only from an explicit, same-channel manual-confirmation history.
    if(state.lastOutcome==='confirmed' && Number.isFinite(state.lastSentAt) && state.lastSentAt>0){
      const acknowledged=(state.history || []).filter(entry=>entry.kind==='info' &&
        entry.text==='사용자가 발송 완료를 확인했습니다. 다음 문구로 이어집니다.' &&
        Number.isFinite(entry.at) && entry.at>state.lastSentAt && entry.at<=io.now());
      if(acknowledged.length)state.lastSentAt=Math.max(...acknowledged.map(entry=>entry.at));
    }
    return state;
  };
  const log = (state, kind, text) => {
    state.history = [{ at: io.now(), kind, text }, ...state.history].slice(0, 30);
  };
  const persist = async state => { await io.save(state); return state; };
  const scheduleNext = state => io.schedule(io.prepare && !state.prepared && state.timingCalibration?.status!=='measuring' ? Math.max(io.now(),state.nextRunAt-3000) : state.nextRunAt);
  const destination = state => ({...state.target,ownUserId:state.ownUserId,skipConfirmation:state.skipConfirmation,lastSentAt:state.lastSentAt,lastConfirmedMessageId:state.lastConfirmedMessageId,lastOutcome:state.lastOutcome,messages:state.messages,expectedText:state.messages[state.nextIndex],draftRetrySince:state.draftRetrySince});
  const pause = async (state, error) => {
    state.prepared = null;
    state.enabled = false;
    state.nextRunAt = null;
    state.error = error;
    log(state, 'error', error);
    await persist(state);
    await io.cancel();
    return state;
  };
  const deferSlowmode = async (state, milliseconds) => {
    state.pending = null;
    state.error = null;
    // Alarm-based waiting survives worker suspension and does not occupy a
    // delivery timeout. The countdown is checked again before the next send.
    state.nextRunAt = io.now() + Math.max(30000, Math.min(21600000, milliseconds) + 1500);
    state.slowmodeUntil = state.nextRunAt;
    log(state, 'info', '슬로우 모드 해제를 기다립니다. 문구 차례는 유지합니다.');
    await persist(state);
    try { await scheduleNext(state); }
    catch { return pause(state, '슬로우 모드 대기 예약을 등록하지 못했습니다.'); }
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
  const measuredDeadline = state => {
    const timing=state.timingCalibration;
    if(!timing || timing.deliveryId!==state.lastDeliveryId || !Number.isFinite(timing.enterAt) ||
       !Number.isFinite(timing.confirmedAt))return null;
    // A duration measured from Enter must not be added again after the receipt.
    // Still honor a full server cooldown after confirmation as a safety bound.
    return Math.max(timing.enterAt+state.intervalSeconds*1000,
      timing.confirmedAt+(state.slowmodeSeconds>0?state.slowmodeSeconds+3:0)*1000,
      timing.confirmedAt+(timing.cooldownMs>0?timing.cooldownMs+3000:0));
  };
  const applySlowmode = (state, seconds) => {
    if (!Number.isInteger(seconds) || seconds<=0 || seconds>21600) return;
    if(state.slowmodeSeconds!==null && state.slowmodeSeconds!==seconds)state.timingCalibration={status:'awaiting',sampleCount:0,extraSeconds:0};
    state.slowmodeSeconds=seconds;
    const minimum=minimumInterval(state);
    if (state.enabled && Number.isFinite(state.lastSentAt) && state.lastSentAt>0) state.nextRunAt=Math.max(state.nextRunAt || 0,measuredDeadline({...state,intervalSeconds:Math.max(state.intervalSeconds,minimum)}) ?? state.lastSentAt+minimum*1000);
    if(state.intervalSeconds<minimum) {
      state.intervalSeconds=minimum;
      log(state,'info',`슬로우 모드 ${seconds}초와 여유·측정 보정을 반영해 주기를 ${minimum}초로 조정했습니다.`);
    }
  };
  const confirmed = async (state, verified=true, receipt=null) => {
    if (receipt && /^\d{17,20}$/.test(receipt.messageId || '')) state.lastConfirmedMessageId=receipt.messageId;
    state.lastOutcome=verified?'confirmed':'unverified';
    state.lastDeliveryId=state.pending.id;
    state.prepared = null;
    state.draftRetries = 0;
    state.draftRetrySince = null;
    state.draftRetryPending = null;
    log(state, verified?'success':'info', `문구 ${state.pending.index === 0 ? 'A' : 'B'} ${verified?'전송 확인':'전송 시도 · 결과 확인 생략'}`);
    state.nextIndex = 1 - state.pending.index;
    state.pending = null;
    state.lastSentAt = io.now();
    state.error = null;
    const measurement=verified?receiptMeasurement(receipt,io.now()):null;
    if(measurement) {
      state.timingCalibration={...state.timingCalibration,status:'measuring',deliveryId:state.lastDeliveryId,
        sampleCount:(state.timingCalibration?.sampleCount || 0)+1,...measurement};
      log(state,'info',`시간 측정: Enter 후 게시 확인까지 ${(measurement.confirmationMs/1000).toFixed(2)}초. 슬로우 모드 해제를 관찰합니다.`);
    } else if(state.timingCalibration) state.timingCalibration={...state.timingCalibration,status:verified?'awaiting':'confirmation-required'};
    // Keep the existing safe confirmation-based interval. A measured cooldown
    // may extend this deadline, but must never accelerate an unverified send.
    state.nextRunAt = measurement ? Math.max(io.now(),measuredDeadline(state)) : io.now() + state.intervalSeconds * 1000;
    await persist(state);
    try { await scheduleNext(state); }
    catch { return pause(state, '다음 예약을 등록하지 못해 중지했습니다.'); }
    return state;
  };
  const recheck = async state => {
    if (!io.reconcile) return false;
    try {
      const result = await io.reconcile({...state.target, ownUserId:state.ownUserId,skipConfirmation:state.skipConfirmation,lastConfirmedMessageId:state.lastConfirmedMessageId, messages:state.messages}, state.pending);
      log(state, 'info', result?.status === 'confirmed' ? '게시 기록 재확인으로 본인의 전송을 확인했습니다.' : '게시 기록 재확인에서 전송을 확정하지 못했습니다.');
      if (result?.status === 'confirmed' && result.draftAction === 'replace-next') log(state,'info','이미 게시된 공지 초안은 다음 전송 시 현재 차례 문구로 교체합니다.');
      if (result?.status === 'confirmed' && result.draftAction === 'reuse-next') log(state,'info','다음 차례의 초안을 보존합니다. 다음 전송 시 재사용합니다.');
      if(result?.status==='confirmed' && /^\d{17,20}$/.test(result.messageId || '')) state.lastConfirmedMessageId=result.messageId;
      return result?.status === 'confirmed';
    } catch { log(state, 'info', '게시 기록 재확인에 연결하지 못했습니다.'); return false; }
  };
  const api = {
    getState: read,
    async updateSettings(settings) {
      validateSettings(settings);
      const state = await read();
      requireEditable(state);
      if (settings.intervalSeconds<minimumInterval(state)) throw new Error(`이 채널은 슬로우 모드 때문에 최소 ${minimumInterval(state)}초 이상으로 설정해야 합니다.`);
      state.messages = [...settings.messages];
      state.skipConfirmation = settings.skipConfirmation === true;
      state.ownUserId = settings.ownUserId || '';
      state.intervalSeconds = settings.intervalSeconds;
      state.error = null;
      return persist(state);
    },
    async recordTiming(deliveryId, sample) {
      const state=await read();
      if(state.lastDeliveryId!==deliveryId || state.timingCalibration?.deliveryId!==deliveryId)return state;
      const result=cooldownMeasurement(sample,state.slowmodeSeconds);
      if(!result || result.enterAt!==state.timingCalibration.enterAt)return state;
      state.timingCalibration={...state.timingCalibration,status:result.extraSeconds!==null && result.extraSeconds<=30?result.status:'inconclusive',cooldownObservation:result};
      // Large excess waits may be UI stalls or unrelated user activity. Report
      // them without permanently inflating the channel's configured interval.
      if(result.extraSeconds!==null && result.extraSeconds<=30) {
        state.timingCalibration.extraSeconds=Math.max(state.timingCalibration.extraSeconds || 0,result.extraSeconds);
        applySlowmode(state,state.slowmodeSeconds);
        if(state.enabled && !state.pending && !state.prepared)state.nextRunAt=Math.max(io.now(),measuredDeadline(state),state.slowmodeUntil || 0);
        log(state,'info',`시간 측정 완료: Enter부터 슬로우 모드 표시 해제까지 ${(result.elapsedMs/1000).toFixed(2)}초. 채널 최소 ${minimumInterval(state)}초 적용.`);
      } else log(state,'info','시간 측정이 불완전하거나 관찰 지연이 큽니다. 기존 안전 주기를 유지하고 다음 발송에서 다시 측정합니다.');
      await persist(state);
      if(state.enabled && !state.pending)await scheduleNext(state);
      return state;
    },
    async bind(target) {
      const state = await read();
      requireEditable(state);
      const channel = parseChannel(target?.url);
      if (!channel || !Number.isInteger(target.tabId) || target.tabId < 0) {
        throw new Error('Discord 서버의 텍스트 채널을 열고 팝업에서 선택해 주세요. DM은 지원하지 않습니다.');
      }
      if (state.target?.guildId!==channel.guildId || state.target?.channelId!==channel.channelId) { state.slowmodeSeconds=null; state.lastSentAt=null; state.lastConfirmedMessageId=null; state.timingCalibration=null; }
      state.timingCalibration ||= {status:'awaiting',sampleCount:0,extraSeconds:0};
      applySlowmode(state,target.slowmodeSeconds);
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
      const result = await inspect({ ...state.target, ownUserId: state.ownUserId, skipConfirmation: state.skipConfirmation, messages: state.messages, expectedText: state.messages[state.nextIndex], draftRetrySince: state.draftRetrySince });
      applySlowmode(state,result.slowmodeSeconds);
      if (!result.ok) {
        if (result.code === 'POSSIBLY_SENT' && state.draftRetryPending) {
          state.pending = state.draftRetryPending; await persist(state);
          if (await recheck(state)) { state.enabled = true; return confirmed(state); }
        }
        throw new Error(result.error);
      }
      state.enabled = true;
      state.draftRetries = 0;
      state.error = null;
      state.nextRunAt = io.now();
      log(state, 'info', `${state.nextIndex === 0 ? 'A' : 'B'}부터 자동 전송을 시작합니다.`);
      await persist(state);
      return api.tick();
    },
    async stop() {
      const state = await read();
      state.prepared = null;
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
      if (state.pending && await recheck(state)) return confirmed(state);
      if (state.pending) return pause(state, '이전 전송 결과가 확인되지 않아 중지했습니다. 채널을 확인해 주세요.');
      if (state.prepared?.phase==='preparing') { state.prepared=null; await persist(state); }
      if (state.nextRunAt == null) return pause(state, '다음 예약 시간이 없어 중지했습니다. 다시 시작해 주세요.');
      if (state.nextRunAt - (io.prepare && !state.prepared ? 3000 : 0) > io.now()) {
        try { await scheduleNext(state); }
        catch { return pause(state, '예약을 복원하지 못해 중지했습니다.'); }
        if (state.prepared && io.waitUntil && state.nextRunAt-io.now()<=3000) { await io.waitUntil(state.nextRunAt); return api.tick(); }
        return state;
      }
      const result = await inspect({ ...state.target, ownUserId: state.ownUserId, skipConfirmation: state.skipConfirmation, messages: state.messages, expectedText: state.messages[state.nextIndex], draftRetrySince: state.draftRetrySince });
      applySlowmode(state,result.slowmodeSeconds);
      if (!result.ok) {
        if (result.code === 'POSSIBLY_SENT' && state.draftRetryPending) {
          state.pending = state.draftRetryPending; await persist(state);
          if (await recheck(state)) return confirmed(state);
        }
        return pause(state, result.error);
      }
      if (state.nextRunAt-(io.prepare && !state.prepared ? 3000 : 0)>io.now()) {
        state.slowmodeUntil=state.nextRunAt;
        await persist(state);
        try { await scheduleNext(state); } catch { return pause(state,'슬로우 모드 최소 주기 예약에 실패했습니다.'); }
        return state;
      }
      if (state.nextRunAt<=io.now() && Number.isFinite(result.cooldownMs) && result.cooldownMs > 0) return deferSlowmode(state, result.cooldownMs);
      state.slowmodeUntil = null;
      if (io.prepare && !state.prepared) {
        state.prepared={id:io.id(),index:state.nextIndex,text:state.messages[state.nextIndex],scheduledAt:state.nextRunAt,startedAt:io.now(),phase:'preparing'};
        // This durable intent can type, but it can never authorize Enter.
        await persist(state);
        try { await io.schedule(io.now()+15000); }
        catch { return pause(state,'입력 준비 복구용 예약을 등록하지 못했습니다.'); }
        let prepared;
        try { prepared=await io.prepare(destination(state),state.prepared); }
        // A rejected transport is not proof of an empty composer; never resend here.
        catch(error) { prepared={status:'blocked',error:`입력 준비 응답 실패 (${String(error?.message || error).slice(0,500)}). 남은 초안을 보존하고 중지합니다.`}; }
        if (prepared?.status==='confirmed') { state.pending=state.prepared; return confirmed(state,true,prepared); }
        if (prepared?.status!=='prepared') return pause(state,prepared?.error || '문구 입력 준비를 완료하지 못했습니다.');
        if(/^\d{17,20}$/.test(prepared.priorAcknowledgedId || ''))state.lastConfirmedMessageId=prepared.priorAcknowledgedId;
        state.prepared.phase='ready';
        state.prepared.readyAt=io.now();
        state.nextRunAt=Math.max(state.nextRunAt,io.now());
        log(state,'info','문구 입력 준비를 마쳤습니다. 예약 시각에 다시 확인한 뒤 전송합니다.');
        await persist(state);
        try { await scheduleNext(state); } catch { return pause(state,'전송 시각 예약을 등록하지 못했습니다.'); }
      }
      if (state.nextRunAt>io.now()) {
        if (io.waitUntil && state.nextRunAt-io.now()<=3000) { await io.waitUntil(state.nextRunAt); return api.tick(); }
        return state;
      }
      if (state.prepared && (state.prepared.phase!=='ready' || state.prepared.index!==state.nextIndex || state.prepared.text!==state.messages[state.nextIndex])) return pause(state,'저장된 입력 준비 상태가 현재 문구 차례와 다릅니다.');
      state.pending = state.prepared ? {...state.prepared,scheduledAt:state.nextRunAt,phase:'commit'} : { id: io.id(), index: state.nextIndex, text: state.messages[state.nextIndex], scheduledAt: state.nextRunAt, startedAt: io.now() };

      // Keep a watchdog alarm in case the worker is terminated during delivery.
      try { await io.schedule(io.now() + 60000); }
      catch {
        state.pending = null;
        return pause(state, '전송 확인용 예약을 등록할 수 없어 발송 전에 중지했습니다.');
      }
      await persist(state);
      let response;
      try { response = await io.send(destination(state), state.pending); }
      catch { response = { status: 'uncertain', error: '전송 응답을 받지 못했습니다. 실제 채널에서 발송 여부를 확인해 주세요.' }; }
      if (state.skipConfirmation && response?.status==='unverified') return confirmed(state,false);
      if (response?.status === 'uncertain' && await recheck(state)) response = {status:'confirmed'};
      if (response?.status === 'deferred' && Number.isFinite(response.retryAfterMs) && response.retryAfterMs > 0) {
        if (response.draftPrepared) {
          state.draftRetrySince ||= state.pending.startedAt;
          state.draftRetryPending ||= state.pending;
        }
        return deferSlowmode(state, response.retryAfterMs);
      }
      if (response?.status === 'draft-retained' && (state.draftRetries || 0) < 3) {
        state.prepared = null;
        state.draftRetries = (state.draftRetries || 0) + 1;
        state.draftRetrySince ||= state.pending.startedAt;
        state.draftRetryPending ||= state.pending;
        state.pending = null;
        state.error = null;
        state.nextRunAt = io.now() + state.intervalSeconds * 1000;
        log(state, 'info', `입력창에 남은 공지를 다음 주기에 다시 확인합니다 (${state.draftRetries}/3). A/B 차례는 유지합니다.`);
        await persist(state);
        try { await scheduleNext(state); }
        catch { return pause(state, '초안 재확인 예약을 등록하지 못했습니다.'); }
        return state;
      }
      if (response?.status === 'confirmed') return confirmed(state,true,response);
      if (response?.status === 'blocked') state.pending = null;
      return pause(state, response?.error || '전송 결과가 불확실합니다. 채널에서 확인해 주세요.');
    },
    async resolvePending(resolution) {
      const state = await read();
      if (state.enabled || !state.pending) throw new Error('확인이 필요한 중지된 전송이 없습니다.');
      if (!['sent', 'not-sent'].includes(resolution)) throw new Error('올바른 전송 결과를 선택해 주세요.');
      state.lastOutcome=resolution==='sent'?'confirmed':null;
      if (resolution === 'sent') {
        state.nextIndex = 1 - state.pending.index;
        state.lastSentAt = io.now();
      }
      state.pending = null;
      state.prepared = null;
      state.draftRetries = 0;
      state.draftRetrySince = null;
      state.draftRetryPending = null;
      state.error = null;
      log(state, 'info', resolution === 'sent' ? '사용자가 발송 완료를 확인했습니다. 다음 문구로 이어집니다.' : '사용자가 미발송을 확인했습니다. 같은 문구로 이어집니다.');
      return persist(state);
    },
    async recover({ preserveDue = false } = {}) {
      const state = await read();
      if (state.pending && state.enabled && await recheck(state)) return confirmed(state);
      if (state.pending) {
        if(!state.enabled && state.error) { await io.cancel(); return state; }
        return pause(state, state.error || '중단된 전송이 있습니다. 채널에서 발송 여부를 확인한 뒤 재개해 주세요.');
      }
      if (!state.enabled) { await io.cancel(); return state; }
      if (state.prepared?.phase==='preparing') { state.prepared=null; await persist(state); }
      const result = await inspect({ ...state.target, ownUserId: state.ownUserId, skipConfirmation: state.skipConfirmation, messages: state.messages, expectedText: state.messages[state.nextIndex], draftRetrySince: state.draftRetrySince });
      applySlowmode(state,result.slowmodeSeconds);
      if (!result.ok) {
        if (result.code === 'POSSIBLY_SENT' && state.draftRetryPending) {
          state.pending = state.draftRetryPending; await persist(state);
          if (await recheck(state)) return confirmed(state);
        }
        return pause(state, result.error);
      }
      await persist(state);
      // Never replay every missed interval after sleep or browser restart.
      if (!state.nextRunAt || (!state.prepared && !preserveDue && state.nextRunAt < io.now())) {
        state.nextRunAt = io.now() + state.intervalSeconds * 1000;
        await persist(state);
      }
      try { await scheduleNext(state); }
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
