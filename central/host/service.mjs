import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { readDescriptor, dataDirectory } from './paths.mjs';

export async function bridgeRequest(descriptor, path, method = 'GET', body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(new URL(path, descriptor.url), {
      method, headers: { Authorization: `Bearer ${descriptor.bridgeToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, redirect: 'error'
    });
    if (!response.ok) throw new Error('Bridge request failed');
    return await response.json();
  } finally { clearTimeout(timeout); }
}

export async function connectService({ dir = dataDirectory(), node = process.execPath, runtime = new URL('../runtime/main.mjs', import.meta.url), timeoutMs = 8000 } = {}) {
  async function available() {
    try {
      const descriptor = await readDescriptor(dir);
      await bridgeRequest(descriptor, '/api/bridge/status');
      return descriptor;
    } catch { return null; }
  }
  const present = await available();
  if (present) return { request: (path, method, body) => bridgeRequest(present, path, method, body) };
  const marker = join(dir, 'shutdown.json');
  try {
    const stat = await lstat(marker);
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077)) ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('Open DICO manager manually');
    }
    const shutdown = JSON.parse(await readFile(marker, 'utf8'));
    if (shutdown.intent === 'user') throw new Error('Open DICO manager manually');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Open DICO manager manually');
  }
  const child = spawn(node, [runtime instanceof URL ? fileURLToPath(runtime) : runtime, '--data-dir', dir], {
    detached: true, stdio: 'ignore', windowsHide: true
  });
  child.on('error', () => { /* Report through the bounded discovery timeout. */ });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const descriptor = await available();
    if (descriptor) return { request: (path, method, body) => bridgeRequest(descriptor, path, method, body) };
  }
  throw new Error('Local management service unavailable');
}
