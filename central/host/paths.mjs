import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';

export function dataDirectory(platform = process.platform, home = homedir(), env = process.env) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'DICO');
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'DICO');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'DICO');
}

export async function readDescriptor(dir = dataDirectory()) {
  const path = join(dir, 'runtime.json');
  const stat = await lstat(path);
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('runtime descriptor must be a private file');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('runtime descriptor owner differs');
  const value = JSON.parse(await readFile(path, 'utf8'));
  let url;
  try { url = new URL(value.url); } catch { throw new Error('invalid runtime descriptor'); }
  if (value.protocolVersion !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      url.username || url.password ||
      !url.port || url.pathname !== '/' || url.search || url.hash ||
      !Number.isSafeInteger(value.pid) || value.pid < 1 ||
      typeof value.bridgeToken !== 'string' || value.bridgeToken.length < 8) {
    throw new Error('invalid runtime descriptor');
  }
  return value;
}
