import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { createCoordinator } from './core.js';

export async function openStore(directory) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const lockPath=resolve(directory,'coordinator.lock');
  const lock=await open(lockPath,'wx',0o600);
  await lock.writeFile(String(process.pid));
  const file=resolve(directory,'state.json');
  return {
    load:async()=>{
      try { return JSON.parse(await readFile(file,'utf8')); }
      catch(error) { if(error.code==='ENOENT')return undefined;throw error; }
    },
    save:async state=>{
      const temp=file+'.tmp', handle=await open(temp,'w',0o600);
      try { await handle.writeFile(JSON.stringify(state));await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp,file);
      if (process.platform==='win32') return; // Windows cannot open/fsync a directory handle.
      const directoryHandle=await open(dirname(file),'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    },
    close:async()=>{await lock.close();await unlink(lockPath);},
  };
}

export function createCoordinatorServer({core,token}) {
  if (typeof token!=='string' || !/^[A-Za-z0-9_-]{32,200}$/.test(token)) throw Error('DICO_COORDINATOR_TOKEN에 32~200자 영문·숫자·_- 토큰을 설정하세요.');
  return http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Type','application/json');
    const reply=(code,body)=>{res.writeHead(code);res.end(JSON.stringify(body));};
    const auth=Buffer.from(req.headers.authorization || ''), expected=Buffer.from(`Bearer ${token}`);
    if (auth.length!==expected.length || !timingSafeEqual(auth,expected)) {req.resume();return reply(401,{error:'인증 실패'});}
    if (req.headers.origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin)) {req.resume();return reply(403,{error:'허용되지 않은 요청 출처'});}
    try {
      if (req.method==='GET' && req.url==='/status') return reply(200,await core.status());
      if (req.method!=='POST' || !['/acquire','/finish'].includes(req.url)) {req.resume();return reply(404,{error:'지원하지 않는 요청'});}
      if (!req.headers['content-type']?.startsWith('application/json')) {req.resume();return reply(415,{error:'JSON 요청이 필요합니다.'});}
      let text='';
      for await (const chunk of req) {text+=chunk;if(Buffer.byteLength(text)>8192)return reply(413,{error:'요청이 너무 큽니다.'});}
      const result=await core[req.url.slice(1)](JSON.parse(text));
      reply(200,result);
    } catch { reply(409,{error:'발송 순서 요청을 처리하지 못했습니다. 계정·채널 연결, 발송 결과와 조정기 상태를 확인하세요.'}); }
  });
}

async function main() {
  const configPath=process.argv[2];
  if (!configPath) throw Error('실행: node coordinator/server.js <config.json> [state-directory]');
  const config=JSON.parse(await readFile(configPath,'utf8'));
  const token=process.env.DICO_COORDINATOR_TOKEN;
  // Keep live state outside an extension installation that an updater swaps.
  const store=await openStore(resolve(process.argv[3] || process.env.DICO_COORDINATOR_STATE_DIR || resolve(homedir(),'.dico-coordinator')));
  let server;
  try {
    const core=createCoordinator(config,{...store,now:()=>Date.now()});
    server=createCoordinatorServer({core,token});
    // Fail startup on corrupt/incompatible state before accepting clients.
    await core.status();
    const port=Number(process.env.DICO_COORDINATOR_PORT || 43127);
    const host=process.env.DICO_COORDINATOR_HOST || '127.0.0.1';
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
    console.log(`DICO 조정기 실행: ${host}:${port}`);
    const stop=()=>server.close(()=>store.close().then(()=>process.exit(0)));
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
  } catch(error) {server?.close();await store.close();throw error;}
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(error=>{console.error(error.message);process.exitCode=1;});
