import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encodePacket, readPackets, validateOrigin, validatePacket } from './protocol.mjs';
import { connectService } from './service.mjs';
import {installedExtensionStatus} from './extension-update.mjs';

export async function runNativeHost({ input, output, origin, ids, service, installedRoot, extensionStatus=installedExtensionStatus, pollMs = 1000 }) {
  validateOrigin(origin, ids);
  let instanceId, sessionId, resetEpoch;
  let busy = false;
  const send = packet => output.write(encodePacket(packet));
  const poll = setInterval(async () => {
    if (!instanceId || !sessionId || busy) return;
    busy = true;
    try {
      const result = await service.request(`/api/bridge/commands?instanceId=${encodeURIComponent(instanceId)}&sessionId=${encodeURIComponent(sessionId)}`);
      if (Array.isArray(result.commands)) for (const command of result.commands) send({ type: 'COMMAND', command });
    } catch { /* The next poll may reconnect; no secret-bearing error goes to the extension. */ }
    finally { busy = false; }
  }, pollMs);
  try {
    for await (const raw of readPackets(input)) {
      let requestId = typeof raw?.requestId === 'string' ? raw.requestId : '';
      try {
        const packet = validatePacket(raw);
        const result = packet.message.type === 'EXTENSION_STATUS'
          ? await extensionStatus(installedRoot || '',{...await service.request('/api/bridge/status'),extensionId:new URL(origin).hostname})
          : packet.message.type === 'OPEN_DASHBOARD'
          ? await service.request('/api/bridge/open', 'POST', {})
          : await service.request('/api/bridge', 'POST', { instanceId: packet.instanceId || instanceId, message: packet.message });
        if (packet.message.type === 'HELLO') {
          instanceId = result.instanceId;
          sessionId = result.sessionId;
          resetEpoch=Number.isSafeInteger(result.resetEpoch)?result.resetEpoch:undefined;
        }
        send({ type: 'RESPONSE', requestId, ok: true, result });
        if (packet.message.type === 'HELLO' && Array.isArray(result.commands)) {
          for (const command of result.commands) send({ type: 'COMMAND', command });
        }
      } catch { send({ type: 'RESPONSE', requestId, ok: false, error: 'Invalid message or local service unavailable' }); }
    }
  } finally {
    clearInterval(poll);
    if (instanceId && sessionId) {
      try { await service.request('/api/bridge', 'POST', { instanceId, message: { type: 'DISCONNECT', sessionId,...(resetEpoch===undefined?{}:{resetEpoch}) } }); }
      catch { /* The service may already have stopped. */ }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const installedRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const ids = JSON.parse(await readFile(join(installedRoot, 'allowed_extensions.json'), 'utf8')).extensionIds;
    const service = await connectService({ node: join(installedRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node') });
    await runNativeHost({ input: process.stdin, output: process.stdout, origin: process.argv[2], ids, service, installedRoot });
  } catch {
    process.exitCode = 1;
  }
}
