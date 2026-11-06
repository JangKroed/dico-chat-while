import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFile,realpath} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {safeToUpdate,safeToReloadExtension} from './updater.mjs';
import {normalizeSessions,UI_SESSION_TTL} from './ui-state.mjs';
import {createSupportReport,inspectSupportReport,SUPPORT_REPORT_MAX_BYTES} from './support-report.mjs';
import {createCoalescedRefresh} from './coalesced-refresh.mjs';

const secret=()=>randomBytes(32).toString('hex');
const equal=(a,b)=>typeof a==='string' && typeof b==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};
const spaRoutes=new Set(['/','/messages','/connections','/channels','/groups','/history','/logs','/settings','/tutorial']);
const fail=(code,message)=>Object.assign(Error(message),{status:code});
async function body(req,maxBytes=1024*1024) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415,'JSON 요청이 필요합니다.');
  const chunks=[];let bytes=0;
  for await (const chunk of req) {const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=buffer.length;if(bytes>maxBytes)throw fail(413,'요청 크기가 제한을 초과했습니다.');chunks.push(buffer);}
  const text=Buffer.concat(chunks,bytes).toString('utf8');
  try {const value=JSON.parse(text);if (!value || typeof value!=='object' || Array.isArray(value))throw Error();return value;}
  catch {throw fail(400,'JSON 요청을 확인하세요.');}
}
export function createCentralApplication({manager,origin='http://127.0.0.1:43127',bridgeToken,uiDirectory,notificationDispatcher,setupStatus,updates,appVersion,supportDelivery,collectSupportReport,initialSessions=[],saveSessions=async()=>{},now=Date.now,mode='local',pairingCodes,lanAccess}) {
  if(!['local','lan'].includes(mode))throw Error('Invalid access mode');
  if (mode==='local'&&(typeof bridgeToken!=='string' || bridgeToken.length<32))throw Error('Private bridge credential required');
  if(mode==='lan'&&typeof pairingCodes?.consume!=='function')throw Error('LAN pairing provider required');
  // LAN controllers have a separate, memory-only cookie namespace. Closing
  // this listener revokes them; local browser/native credentials never apply.
  const cookieName=mode==='lan'?'dico_lan_session':'dico_session';
  const sessions=new Map(normalizeSessions(mode==='lan'?[]:initialSessions,now()).map(({id,...session})=>[id,session])),bootstraps=new Map(),streams=new Set();let closed=false,failedPairings=0,pairingWindowStarted=now();
  const currentOrigin=()=>new URL(origin);
  const prune=()=>{for (const [k,v] of bootstraps)if(v<=now())bootstraps.delete(k);for (const [k,v] of sessions)if(v.expires<=now())sessions.delete(k);};
  const persistSessions=async()=>{prune();const records=normalizeSessions([...sessions].map(([id,session])=>({id,...session})),now());const retained=new Set(records.map(session=>session.id));for(const id of sessions.keys())if(!retained.has(id))sessions.delete(id);if(mode==='local')await saveSessions(records);};
  const issueBootstrap=(ttl=30000)=>{if(mode!=='local')throw Error('Local bootstrap only');prune();const token=secret();bootstraps.set(token,now()+ttl);return token;};
  const uiSession=req=>{
    prune();const id=(req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    const session=id && sessions.get(id);
    if (!session)throw fail(401,mode==='lan'?'중앙 PC에서 연결 코드를 발급받아 로그인해 주세요.':'관리 프로그램에서 중앙 페이지를 다시 열어 주세요.');
    return session;
  };
  const checkMutation=(req,session)=>{
    if (req.headers.origin!==origin || !equal(req.headers['x-dico-csrf'],session.csrfToken))throw fail(403,'요청 출처 또는 세션을 확인하세요.');
  };
  const json=(res,status,value)=>{res.setHeader('Content-Type','application/json; charset=utf-8');res.writeHead(status);res.end(JSON.stringify(value));};
  const handler=async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      if (req.headers.host!==currentOrigin().host || (req.headers.origin && req.headers.origin!==origin))throw fail(403,'허용되지 않은 요청 출처입니다.');
      const rawPath=(req.url || '/').split('?')[0];
      if (decodeURIComponent(rawPath).split('/').some(s=>s==='..' || s==='.') || rawPath.includes('\\'))throw fail(404,'경로를 찾을 수 없습니다.');
      const url=new URL(req.url,origin),path=url.pathname;
      if(closed){
        // 화면 탐색은 재시작 동안 문서를 유지하며 같은 주소의 복귀를 기다립니다.
        // API는 기존 503 JSON 계약을 유지합니다.
        if(mode==='local'&&req.method==='GET'&&spaRoutes.has(path)){
          const nonce=secret();
          res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
          res.setHeader('Content-Type','text/html; charset=utf-8');
          res.setHeader('Retry-After','3');
          res.writeHead(503);
          return res.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>DICO 다시 연결 중</title><h1>관리 프로그램을 다시 연결하고 있습니다</h1><p>연결이 돌아오면 이 화면이 자동으로 열립니다.</p><script nonce="${nonce}">async function reconnect(){try{const result=await fetch('/api/access-mode',{cache:'no-store',signal:AbortSignal.timeout(2000)});if(result.ok){location.reload();return;}}catch{}setTimeout(reconnect,3000);}setTimeout(reconnect,3000);</script></html>`);
        }
        throw fail(503,'관리 프로그램을 다시 시작하고 있습니다. 잠시 기다려 주세요.');
      }
      if(path==='/api/access-mode'&&req.method==='GET')return json(res,200,{mode});
      if(path==='/api/support/receive'&&req.method==='POST'){
        if(!supportDelivery)throw fail(404,'제보 수신 기능이 준비되지 않았습니다.');
        if(req.headers.origin)throw fail(403,'제보 전용 전송 경로입니다.');
        if(supportDelivery.authorizeReceiver(req.headers.authorization)===false)throw fail(401,'제보 수신 인증이 필요합니다.');
        return json(res,202,await supportDelivery.receive(await body(req,SUPPORT_REPORT_MAX_BYTES),req.headers.authorization));
      }
      // Check this before credentials or body parsing, even if a caller knows
      // the native bridge token or holds a valid LAN controller session.
      if(mode==='lan'&&(path.startsWith('/api/bridge')||path.startsWith('/api/lan-access')||path==='/api/remote-access-link'))throw fail(404,'이 접속에서는 사용할 수 없는 경로입니다.');
      if (path.startsWith('/api/bridge')) {
        // Only the native host reads this credential from the private descriptor.
        if (req.headers.origin || !equal(req.headers.authorization,`Bearer ${bridgeToken}`))throw fail(req.headers.origin?403:401,'브리지 인증이 필요합니다.');
        if (path==='/api/bridge/status' && req.method==='GET') {
          // 업데이트 상태 조회가 디스크 I/O를 기다리는 동안 새 발송이 시작될 수 있다.
          // 비동기 조회 뒤 최신 실행 상태를 읽어 과거의 유휴 상태로 reload를 승인하지 않는다.
          const updatePhase=(await updates?.status?.())?.phase,snapshot=manager.snapshot();
          return json(res,200,{ok:true,protocolVersion:1,pid:process.pid,...(appVersion?{appVersion}:{}),serviceStatus:snapshot.service?.status,reloadSafe:safeToReloadExtension(snapshot)&&!['preparing','ready','applying'].includes(updatePhase),busy:(snapshot.attempts || []).some(a=>['preparing','permitted','unknown'].includes(a.status)) || (snapshot.groups || []).some(g=>['running','stop_pending','pause_pending','needs_review'].includes(g.status))});
        }
        if (path==='/api/bridge/update/apply' && req.method==='POST') {
          if(!updates)throw fail(503,'업데이트 기능이 준비되지 않았습니다.');
          return json(res,202,await updates.apply(await body(req)));
        }
        if (path==='/api/bridge/open' && req.method==='POST')return json(res,200,{url:`${origin}/#bootstrap=${issueBootstrap()}`});
        if (path==='/api/bridge/commands' && req.method==='GET') {
          const id=url.searchParams.get('instanceId'),sessionId=url.searchParams.get('sessionId');
          const commands=manager.commands(id,{pendingOnly:true}).filter(c=>!sessionId || c.sessionId===sessionId);
          return json(res,200,{commands});
        }
        if (path==='/api/bridge' && req.method==='POST') {
          const payload=await body(req);
          if (!payload.message || typeof payload.message.type!=='string')throw fail(400,'브리지 메시지가 필요합니다.');
          if(updates?.isApplying())throw fail(503,'업데이트를 적용하고 있습니다. 관리 화면이 다시 열릴 때까지 기다려 주세요.');
          manager.tick?.();
          return json(res,200,manager.bridge(payload.message,payload.instanceId));
        }
        throw fail(404,'브리지 경로를 찾을 수 없습니다.');
      }
      if (path==='/api/session' && req.method==='POST') {
        if (req.headers.origin!==origin)throw fail(403,'요청 출처를 확인하세요.');
        const payload=await body(req);prune();
        if(closed)throw fail(503,'접속이 종료됐습니다. 중앙 PC에서 접속 상태를 확인해 주세요.');
        if(mode==='lan'){
          if(now()-pairingWindowStarted>=120000){pairingWindowStarted=now();failedPairings=0;}
          if(failedPairings>=10){res.setHeader('Retry-After',String(Math.max(1,Math.ceil((pairingWindowStarted+120000-now())/1000))));throw fail(429,'연결 코드 입력 시도가 많습니다. 최대 2분 뒤 중앙 PC에서 새 코드를 받아 다시 입력해 주세요.');}
          if(typeof payload.pairingCode!=='string'||payload.pairingCode.length>64||!pairingCodes.consume(payload.pairingCode)){failedPairings++;throw fail(401,'연결 코드가 올바르지 않거나 만료·사용됐습니다. 중앙 PC에서 새 코드를 확인해 주세요.');}
        }else{
          const {token}=payload;
          if (typeof token!=='string' || !bootstraps.has(token))throw fail(401,'페이지 연결이 만료됐습니다. 관리 프로그램에서 다시 열어 주세요.');
          bootstraps.delete(token);
        }
        const id=secret(),issuedAt=now(),session={csrfToken:secret(),issuedAt,expires:issuedAt+UI_SESSION_TTL};sessions.set(id,session);
        try{await persistSessions();}catch(error){sessions.delete(id);throw error;}
        res.setHeader('Set-Cookie',`${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
        return json(res,200,{csrfToken:session.csrfToken,...(appVersion?{appVersion}:{})});
      }
      if (path.startsWith('/api/')) {
        const session=uiSession(req);
        if (path==='/api/session' && req.method==='GET')return json(res,200,{csrfToken:session.csrfToken,...(appVersion?{appVersion}:{})});
        if(path==='/api/support/automatic'||path==='/api/support/send'||path==='/api/support/receiver-key'||path==='/api/support/inbox'||path.startsWith('/api/support/inbox/')){
          if(mode!=='local')throw fail(403,'중앙 PC에서 제보 전송·수신 설정을 관리하세요.');
          if(!supportDelivery)throw fail(503,'자동 제보 기능이 준비되지 않았습니다.');
          if(path==='/api/support/automatic'&&req.method==='GET')return json(res,200,supportDelivery.status());
          if(path==='/api/support/inbox'&&req.method==='GET')return json(res,200,{items:supportDelivery.inbox()});
          if(path.startsWith('/api/support/inbox/')&&req.method==='GET')return json(res,200,supportDelivery.get(decodeURIComponent(path.slice('/api/support/inbox/'.length))));
          checkMutation(req,session);
          if(path==='/api/support/automatic'&&req.method==='POST')return json(res,200,supportDelivery.configure(await body(req)));
          if(path==='/api/support/receiver-key'&&req.method==='POST'){await body(req);return json(res,200,supportDelivery.receiverKey());}
          if(path==='/api/support/send'&&req.method==='POST'){
            const p=await body(req);const record=await supportDelivery.queue({attemptId:p.attemptId,userDescription:p.userDescription||p.description,from:p.from,to:p.to,includeBodies:p.includeBodies,includeNames:p.includeNames});
            return json(res,202,record);
          }
          throw fail(405,'지원하지 않는 요청입니다.');
        }

        if(path==='/api/lan-access'&&req.method==='GET'){
          if(!lanAccess)throw fail(404,'내부망 접속 기능이 준비되지 않았습니다.');
          return json(res,200,await lanAccess.status());
        }
        if (path==='/api/setup-status' && req.method==='GET') {
          if (!setupStatus)throw fail(503,'설치 진단 기능이 준비되지 않았습니다.');
          return json(res,200,await setupStatus());
        }
        if (path==='/api/updates' && req.method==='GET') {
          if(!updates)throw fail(503,'업데이트 기능이 준비되지 않았습니다.');
          return json(res,200,await updates.status());
        }
        if (path==='/api/snapshot' && req.method==='GET')return json(res,200,manager.snapshot());
        if (path==='/api/support/report' && req.method==='GET'){
          const boolean=key=>{const value=url.searchParams.get(key);if(value!==null&&!['true','false','1','0'].includes(value))throw fail(400,'보고서 포함 옵션을 확인하세요.');return value===null||value==='true'||value==='1';};
          const timestamp=(key,fallback)=>{const raw=url.searchParams.get(key);if(raw===null)return fallback;const value=Number(raw);if(!raw||!Number.isSafeInteger(value)||value<0)throw fail(400,'보고서 조회 기간을 확인하세요.');return value;};
          const options={attemptId:url.searchParams.get('attemptId')||undefined,from:timestamp('from',0),to:timestamp('to',now()),includeBodies:boolean('includeBodies'),includeNames:boolean('includeNames')};
          const report=await (collectSupportReport?collectSupportReport(options):createSupportReport({manager,appVersion,...options,now}));
          if(['true','1'].includes(url.searchParams.get('download')))res.setHeader('Content-Disposition',`attachment; filename="dico-support-${report.reportId}.json"`);
          return json(res,200,report);
        }
        if (path==='/api/analytics' && req.method==='GET')return json(res,200,manager.analytics({from:Number(url.searchParams.get('from')) || undefined,to:Number(url.searchParams.get('to')) || undefined}));
        if (req.method==='GET'&&(path==='/api/history'||path==='/api/logs'&&url.searchParams.get('paged')==='1')){
          const options={cursor:url.searchParams.get('cursor')||undefined,limit:Math.min(500,Math.max(1,Number(url.searchParams.get('limit'))||100)),from:Number(url.searchParams.get('from'))||0,to:Number(url.searchParams.get('to'))||Number.MAX_SAFE_INTEGER,query:(url.searchParams.get('query')||'').slice(0,200),status:url.searchParams.get('status')||undefined,level:url.searchParams.get('level')||undefined};
          return json(res,200,path==='/api/history'?manager.historyPage(options):manager.eventPage(options));
        }
        if (path==='/api/logs' && req.method==='GET')return json(res,200,{events:manager.events({after:Number(url.searchParams.get('after')) || 0,limit:Math.min(500,Number(url.searchParams.get('limit')) || 200)})});
        if (path==='/api/events' && req.method==='GET') {
          res.setHeader('Content-Type','text/event-stream');res.setHeader('Connection','keep-alive');res.writeHead(200);
          const write=(type,data,id)=>res.write(`${id?`id: ${id}\n`:''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
          let heartbeat,snapshotRefresh,unsubscribe=()=>{},ended=false;
          const finish=()=>{if(ended)return;ended=true;clearInterval(heartbeat);snapshotRefresh?.close();unsubscribe();streams.delete(res);};
          const authorized=()=>{if(ended)return false;try{if(!closed&&uiSession(req)===session)return true;}catch{}finish();res.end();return false;};
          res.on('close',finish);streams.add(res);
          // 진단 이벤트마다 통계·기록을 다시 계산하면 승인 응답도 그 계산을 기다립니다.
          // 이벤트는 즉시 보존·전달하고 화면용 최신 상태만 최대 50ms 단위로 합칩니다.
          // 실행 시 인증을 다시 확인하여 대기 중 만료된 세션으로 내용을 보내지 않습니다.
          snapshotRefresh=createCoalescedRefresh(()=>{if(authorized())write('snapshot',manager.snapshot());},{onError:()=>{finish();res.end();}});
          write('snapshot',manager.snapshot());
          // An open stream does not extend cookie authentication. Check the
          // live session before every push, and revoke idle expired streams.
          unsubscribe=manager.subscribe(event=>{if(!authorized())return;write('event',event,event.eventId);snapshotRefresh.request();});
          if(ended){unsubscribe();return;}
          heartbeat=setInterval(()=>{if(authorized())res.write(': keepalive\n\n');},15000);heartbeat.unref?.();return;
        }
        if (req.method==='POST') {
          checkMutation(req,session);const payload=await body(req,path==='/api/support/inspect'?SUPPORT_REPORT_MAX_BYTES:1024*1024);
          if(closed)throw fail(503,'접속이 종료됐습니다. 중앙 PC에서 접속 상태를 확인해 주세요.');
          if(path==='/api/support/inspect')return json(res,200,inspectSupportReport(payload.report));
          if(updates?.isApplying())throw fail(503,'업데이트를 적용하고 있습니다. 관리 화면이 다시 열릴 때까지 기다려 주세요.');
          if(path==='/api/lan-access'||path==='/api/lan-access/pair'){
            if(!lanAccess)throw fail(404,'내부망 접속 기능이 준비되지 않았습니다.');
            return json(res,200,await(path==='/api/lan-access'?lanAccess.update(payload):lanAccess.pair()));
          }
          if(path==='/api/updates/report'){
            if(!updates?.reportFailure)throw fail(503,'업데이트 진단 제보 기능이 준비되지 않았습니다.');
            await updates.reportFailure({automatic:false});return json(res,202,await updates.status());
          }
          // 대상 경로를 클라이언트에서 받지 않는다. 검증된 로컬 복원본만
          // 기존 UI 인증·CSRF·적용 중 차단을 통과한 요청으로 되돌릴 수 있다.
          if(path==='/api/updates/rollback'){
            if(!updates?.rollback)throw fail(503,'이전 버전 복원 기능이 준비되지 않았습니다.');
            return json(res,202,await updates.rollback());
          }
          if(path==='/api/updates'){
            if(!updates)throw fail(503,'업데이트 기능이 준비되지 않았습니다.');
            return json(res,202,await updates.start());
          }
          if(path==='/api/remote-access-link')return json(res,200,{url:`${origin}/#bootstrap=${issueBootstrap(120000)}`,expiresAt:now()+120000});
          if (path==='/api/command') {
            if (typeof payload.action!=='string')throw fail(400,'명령을 확인하세요.');
            const result=manager.execute(payload.action,payload.payload || {});
            return json(res,200,{ok:true,result,snapshot:manager.snapshot()});
          }
          if (path==='/api/notification-test')return json(res,200,{ok:true,result:await notificationDispatcher?.test?.() || {status:'unavailable'}});
          if (path==='/api/import')return json(res,200,{ok:true,result:manager.execute(payload.backup?.format==='dico-settings'?'legacy.import':'backup.import',payload),snapshot:manager.snapshot()});
        }
        if (path==='/api/backup' && req.method==='GET') {
          res.setHeader('Content-Disposition','attachment; filename="dico-central-backup.json"');
          return json(res,200,manager.exportBackup?manager.exportBackup():manager.execute('backup.export',{}));
        }
        throw fail(404,'API 경로를 찾을 수 없습니다.');
      }
      if (!['GET','HEAD'].includes(req.method))throw fail(405,'지원하지 않는 요청입니다.');
      if (!uiDirectory)throw fail(503,'관리 화면 빌드가 필요합니다. central/ui에서 빌드를 실행하세요.');
      const root=await realpath(uiDirectory),file=resolve(root,spaRoutes.has(path)?'index.html':'.'+path);
      if (!file.startsWith(root+sep))throw fail(404,'경로를 찾을 수 없습니다.');
      let safeFile;
      try {safeFile=await realpath(file);} catch {throw fail(404,'파일을 찾을 수 없습니다.');}
      if (!safeFile.startsWith(root+sep))throw fail(404,'파일을 찾을 수 없습니다.');
      const content=await readFile(safeFile);res.setHeader('Content-Type',mime[extname(safeFile)] || 'application/octet-stream');res.writeHead(200);res.end(req.method==='HEAD'?'':content);
    } catch(error) {
      const status=Number.isInteger(error.status) && error.status>=400 && error.status<600?error.status:500;
      const message=status===500?'요청 처리 중 오류가 발생했습니다. 로그와 관리 프로그램 상태를 확인하세요.':error.message;
      json(res,status,{ok:false,error:{code:error.code || 'REQUEST_FAILED',message}});
    }
  };
  return {handler,issueBootstrap,setOrigin:value=>{const u=new URL(value);if(mode!=='local'||u.hostname!=='127.0.0.1' || u.protocol!=='http:')throw Error('Loopback origin required');origin=u.origin;},close:async()=>{if(closed)return;closed=true;try{await persistSessions();}finally{for(const res of streams)res.end();streams.clear();sessions.clear();bootstraps.clear();}}};
}
