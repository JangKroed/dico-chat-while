import { importSettings } from './settings-backup.js';
import { createController, initialState, parseChannel } from './controller.js';

const newChannel = (id, name, saved = {}) => {
  const { version: _version, ...state } = { ...initialState(), ...saved };
  return { ...state, id, name, settingsRevision: saved.settingsRevision ?? 0 };
};

export function createChannelManager(io) {
  let initialization;
  let mutations = Promise.resolve();
  const persistRoot = async root => {
    const saved = await io.load();
    root.revision = (saved?.revision ?? 0) + 1;
    await io.save(root);
  };
  const initialize = () => {
    if (!initialization) initialization = (async () => {
      const saved = await io.load();
      const root = saved?.version === 2 && Array.isArray(saved.channels)
        ? { ...saved, channels: saved.channels.map((channel, index) => newChannel(channel.id || `channel-${index + 1}`, channel.name || `채널 ${index + 1}`, channel)) }
        : { version: 2, channels: [newChannel('channel-1', '채널 1', saved)] };
      if (!root.channels.length) root.channels.push(newChannel('channel-1', '채널 1'));
      if (JSON.stringify(root) !== JSON.stringify(saved)) await persistRoot(root);
    })().catch(error => { initialization = undefined; throw error; });
    return initialization;
  };
  // Reads remain available while a send waits for the background's permission
  // check. Only the initial migration is shared; root state is never cached.
  const read = async () => { await initialize(); return io.load(); };
  const find = (root, id) => {
    const channel = root.channels.find(item => item.id === id);
    if (!channel) throw new Error('채널 설정을 찾을 수 없습니다. 최신 목록을 확인해 주세요.');
    return channel;
  };
  const editable = channel => {
    if (channel.enabled) throw new Error('먼저 자동 전송을 중지해 주세요.');
    if (channel.pending) throw new Error('이전 전송 결과를 먼저 확인해 주세요.');
  };
  const mutate = operation => {
    const task = mutations.then(async () => { await initialize(); await operation(); return read(); });
    mutations = task.catch(() => {});
    return task;
  };
  const controller = (id, { name, revise = false } = {}) => createController({
    load: async () => find(await read(), id),
    save: async state => {
      const root = await read();
      const current = find(root, id);
      const next = newChannel(id, name ?? current.name, { ...state, settingsRevision: current.settingsRevision + (revise ? 1 : 0) });
      root.channels = root.channels.map(channel => channel.id === id ? next : channel);
      await persistRoot(root);
    },
    schedule: when => io.schedule(id, when),
    cancel: () => io.cancel(id),
    inspect: target => io.inspect(target),
    send: (target, delivery) => io.send(target, { ...delivery, channelId: id }),
    now: () => io.now(),
    id: () => io.id(),
  });
  const recordFailure = async (id, error) => {
    const root = await read();
    const channel = find(root, id);
    channel.error = error?.message || String(error);
    channel.enabled = false;
    channel.nextRunAt = null;
    channel.history = [{ at: io.now(), kind: 'error', text: channel.error }, ...channel.history].slice(0, 30);
    await persistRoot(root);
    try { await io.cancel(id); } catch { /* Keep other channels recoverable. */ }
  };
  const each = async (method, ...args) => {
    const root = await read();
    for (const { id } of root.channels) {
      try { await controller(id)[method](...args); }
      catch (error) { await recordFailure(id, error); }
    }
  };
  const one = (method, id, ...args) => mutate(() => controller(id)[method](...args));

  return {
    getState: read,
    restoreSettings: backup => mutate(async () => {
      const root=await read();
      if(root.channels.some(c=>c.enabled || c.pending)) throw new Error('모두 중지하고 미확인 전송 결과를 확인한 뒤 복원하세요.');
      const imported=importSettings(backup);
      const channels=imported.map(c=>newChannel(io.id(),c.name,c));
      if(new Set(channels.map(c=>c.id)).size!==channels.length)throw new Error('채널 ID 생성 실패');
      for(const channel of root.channels)await io.cancel(channel.id);
      root.channels=channels;
      await persistRoot(root);
    }),
    updateSettings: (id, settings, expectedRevision) => mutate(async () => {
      const channel = find(await read(), id);
      if (!Number.isInteger(expectedRevision) || expectedRevision !== channel.settingsRevision) {
        throw new Error('다른 화면에서 설정이 변경되었습니다. 최신 설정을 불러온 뒤 다시 저장해 주세요.');
      }
      let name = channel.name;
      if (settings?.name !== undefined) {
        if (typeof settings.name !== 'string' || !settings.name.trim() || settings.name.trim().length > 80) {
          throw new Error('채널 이름은 1~80자로 입력해 주세요.');
        }
        name = settings.name.trim();
      }
      await controller(id, { name, revise: true }).updateSettings(settings);
    }),
    bind: (id, target) => mutate(async () => {
      const root = await read();
      editable(find(root, id));
      const parsed = parseChannel(target?.url);
      if (root.channels.some(channel => channel.id !== id && channel.target &&
        parsed && channel.target.guildId === parsed.guildId && channel.target.channelId === parsed.channelId)) {
        throw new Error('이미 다른 설정에 연결된 Discord 채널입니다.');
      }
      await controller(id, { revise: true }).bind(target);
    }),
    add: () => mutate(async () => {
      const root = await read();
      const id = io.id();
      if (typeof id !== 'string' || !id || root.channels.some(channel => channel.id === id)) throw new Error('새 채널 ID를 만들지 못했습니다. 다시 시도해 주세요.');
      let number = 1;
      while (root.channels.some(channel => channel.name === `채널 ${number}`)) number++;
      root.channels.push(newChannel(id, `채널 ${number}`));
      await persistRoot(root);
    }),
    remove: id => mutate(async () => {
      const root = await read();
      const channel = find(root, id);
      if (root.channels.length === 1) throw new Error('최소 한 개의 채널 설정은 남겨 두어야 합니다.');
      editable(channel);
      await io.cancel(id);
      root.channels = root.channels.filter(item => item.id !== id);
      await persistRoot(root);
    }),
    fail: (id, error) => mutate(() => recordFailure(id, error)),
    start: id => one('start', id),
    stop: id => one('stop', id),
    tick: id => one('tick', id),
    resolvePending: (id, resolution) => one('resolvePending', id, resolution),
    recover: options => mutate(() => each('recover', options)),
    targetLost: (tabId, reason) => mutate(() => each('targetLost', tabId, reason)),
    startAll: () => mutate(() => each('start')),
    stopAll: () => mutate(() => each('stop')),
  };
}
