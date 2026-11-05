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
  async function handlePacket(raw) {
      let requestId = typeof raw?.requestId === 'string' ? raw.requestId : '';
      try {
        const packet = validatePacket(raw);
        let result;
        if(packet.message.type==='EXTENSION_STATUS'){
          const status=await service.request('/api/bridge/status');
          // 실행 중에는 파일 전체 검사로 뒤의 승인 요청을 지연시키지 않습니다.
          // 유휴 검사에는 파일 복구도 포함되므로 기존 직렬 순서와 종료 대기를 유지합니다.
          result=status.reloadSafe===true
            ? await extensionStatus(installedRoot || '',{...status,extensionId:new URL(origin).hostname})
            : {buildId:null,reloadSafe:false,reason:'EXECUTION_BUSY'};
        }else result=packet.message.type === 'OPEN_DASHBOARD'
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
      } catch(error) { send({ type: 'RESPONSE', requestId, ok: false, code:/^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code||'')?error.code:'SERVICE_UNAVAILABLE',error: 'Invalid message or local service unavailable' }); }
  }
  const queue=[];
  let ended=false,wake,space;
  // Native 요청은 한 번에 하나만 실행합니다. 대기 중인 trace만 뒤로 보내고
  // 상태 변경 요청끼리의 순서와 HELLO/파일 복구 경계는 그대로 유지합니다.
  // 이미 진행 중인 I/O를 취소하거나 유휴 파일 교체와 Enter를 겹치지 않습니다.
  const processing=(async()=>{
    while(!ended||queue.length){
      if(!queue.length){await new Promise(resolve=>{wake=resolve;});continue;}
      const barrier=queue.findIndex(raw=>['HELLO','DISCONNECT','EXTENSION_STATUS'].includes(raw?.message?.type));
      const boundary=barrier<0?queue.length:barrier;
      let index=queue.slice(0,boundary).findIndex(raw=>raw?.message?.type!=='DELIVERY_TRACE');
      if(index<0)index=0;
      const raw=queue.splice(index,1)[0];space?.();space=null;
      await handlePacket(raw);
    }
  })();
  try {
    for await (const raw of readPackets(input)) {
      queue.push(raw);wake?.();wake=null;
      // 매우 큰 trace 묶음도 무제한 메모리 대기열로 만들지 않습니다.
      if(queue.length>=256)await new Promise(resolve=>{space=resolve;});
    }
  } finally {
    ended=true;wake?.();await processing;
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
