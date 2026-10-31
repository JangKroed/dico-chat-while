const MAX_PACKET = 1024 * 1024;
const TYPES = new Set(['HELLO', 'HEARTBEAT', 'OBSERVATION', 'ACCOUNT_OBSERVATION', 'ACK', 'PREPARED', 'DELIVERY_RESULT', 'AUTHORIZE_ENTER', 'DISCONNECT', 'OPEN_DASHBOARD', 'EXTENSION_STATUS']);

export function encodePacket(packet) {
  const body = Buffer.from(JSON.stringify(packet), 'utf8');
  if (body.length > MAX_PACKET) throw new Error('native message exceeds size limit');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export async function* readPackets(input) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE(0);
      if (!size || size > MAX_PACKET) throw new Error('invalid native message size');
      if (buffer.length < size + 4) break;
      const body = buffer.subarray(4, 4 + size);
      buffer = buffer.subarray(size + 4);
      let packet;
      try { packet = JSON.parse(body.toString('utf8')); }
      catch { throw new Error('invalid native message JSON'); }
      yield packet;
    }
  }
  if (buffer.length) throw new Error('incomplete native message');
}

export function validateOrigin(origin, ids) {
  const match = /^chrome-extension:\/\/([a-p]{32})\/$/.exec(origin || '');
  if (!match || !ids.includes(match[1])) throw new Error('unauthorized extension origin');
  return match[1];
}

export function validatePacket(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet) ||
      typeof packet.requestId !== 'string' || !packet.requestId || packet.requestId.length > 128 ||
      !packet.message || typeof packet.message !== 'object' || Array.isArray(packet.message) ||
      !TYPES.has(packet.message.type) ||
      (packet.instanceId !== undefined && (typeof packet.instanceId !== 'string' || packet.instanceId.length > 128))) {
    throw new Error('invalid native message');
  }
  const secrets = /^(bridgeToken|token|password|secret|authorization)$/i;
  const containsSecret = (value) => value && typeof value === 'object' &&
    Object.entries(value).some(([key, child]) => secrets.test(key) || containsSecret(child));
  if (containsSecret(packet)) throw new Error('secret field in native message');
  return packet;
}
