import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFile,realpath} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';

const secret=()=>randomBytes(32).toString('hex');
const equal=(a,b)=>typeof a==='string' && typeof b==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};
const spaRoutes=new Set(['/','/messages','/connections','/channels','/groups','/history','/logs','/settings','/tutorial']);
const fail=(code,message)=>Object.assign(Error(message),{status:code});
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415,'JSON 요청이 필요합니다.');
  let text='';
  for await (const chunk of req) {text+=chunk;if(Buffer.byteLength(text)>1024*1024)throw fail(413,'요청 크기가 제한을 초과했습니다.');}
  try {const value=JSON.parse(text);if (!value || typeof value!=='object' || Array.isArray(value))throw Error();return value;}
  catch {throw fail(400,'JSON 요청을 확인하세요.');}
}
export function createCentralApplication({manager,origin='http://127.0.0.1:43127',bridgeToken,uiDirectory,notificationDispatcher,setupStatus,now=Date.now}) {
  if (typeof bridgeToken!=='string' || bridgeToken.length<32)throw Error('Private bridge credential required');
  const sessions=new Map(),bootstraps=new Map(),streams=new Set();
  const currentOrigin=()=>new URL(origin);
  const prune=()=>{for (const [k,v] of bootstraps)if(v<now())bootstraps.delete(k);for (const [k,v] of sessions)if(v.expires<now())sessions.delete(k);};
  const issueBootstrap=()=>{prune();const token=secret();bootstraps.set(token,now()+30000);return token;};
  const uiSession=req=>{
    prune();const id=(req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith('dico_session='))?.slice(13);
    const session=id && sessions.get(id);
    if (!session)throw fail(401,'관리 프로그램에서 중앙 페이지를 다시 열어 주세요.');
    session.expires=now()+12*60*60*1000;return session;
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
      if (path.startsWith('/api/bridge')) {
        // Only the native host reads this credential from the private descriptor.
        if (req.headers.origin || !equal(req.headers.authorization,`Bearer ${bridgeToken}`))throw fail(req.headers.origin?403:401,'브리지 인증이 필요합니다.');
        if (path==='/api/bridge/status' && req.method==='GET') {
          const snapshot=manager.snapshot();
          return json(res,200,{ok:true,protocolVersion:1,pid:process.pid,serviceStatus:snapshot.service?.status,busy:(snapshot.attempts || []).some(a=>['preparing','permitted','unknown'].includes(a.status)) || (snapshot.groups || []).some(g=>['running','stop_pending','pause_pending','needs_review'].includes(g.status))});
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
          manager.tick?.();
          return json(res,200,manager.bridge(payload.message,payload.instanceId));
        }
        throw fail(404,'브리지 경로를 찾을 수 없습니다.');
      }
      if (path==='/api/session' && req.method==='POST') {
        if (req.headers.origin!==origin)throw fail(403,'요청 출처를 확인하세요.');
        const {token}=await body(req);prune();
        if (typeof token!=='string' || !bootstraps.has(token))throw fail(401,'페이지 연결이 만료됐습니다. 관리 프로그램에서 다시 열어 주세요.');
        bootstraps.delete(token);const id=secret(),session={csrfToken:secret(),expires:now()+12*60*60*1000};sessions.set(id,session);
        res.setHeader('Set-Cookie',`dico_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
        return json(res,200,{csrfToken:session.csrfToken});
      }
      if (path.startsWith('/api/')) {
        const session=uiSession(req);
        if (path==='/api/session' && req.method==='GET')return json(res,200,{csrfToken:session.csrfToken});
        if (path==='/api/setup-status' && req.method==='GET') {
          if (!setupStatus)throw fail(503,'설치 진단 기능이 준비되지 않았습니다.');
          return json(res,200,await setupStatus());
        }
        if (path==='/api/snapshot' && req.method==='GET')return json(res,200,manager.snapshot());
        if (path==='/api/analytics' && req.method==='GET')return json(res,200,manager.analytics({from:Number(url.searchParams.get('from')) || undefined,to:Number(url.searchParams.get('to')) || undefined}));
        if (path==='/api/logs' && req.method==='GET')return json(res,200,{events:manager.events({after:Number(url.searchParams.get('after')) || 0,limit:Math.min(500,Number(url.searchParams.get('limit')) || 200)})});
        if (path==='/api/events' && req.method==='GET') {
          res.setHeader('Content-Type','text/event-stream');res.setHeader('Connection','keep-alive');res.writeHead(200);
          const write=(type,data,id)=>res.write(`${id?`id: ${id}\n`:''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
          write('snapshot',manager.snapshot());
          const unsubscribe=manager.subscribe(event=>{write('event',event,event.eventId);write('snapshot',manager.snapshot());});
          const heartbeat=setInterval(()=>res.write(': keepalive\n\n'),15000);heartbeat.unref?.();
          const finish=()=>{clearInterval(heartbeat);unsubscribe();streams.delete(res);};
          res.on('close',finish);streams.add(res);return;
        }
        if (req.method==='POST') {
          checkMutation(req,session);const payload=await body(req);
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
  return {handler,issueBootstrap,setOrigin:value=>{const u=new URL(value);if(u.hostname!=='127.0.0.1' || u.protocol!=='http:')throw Error('Loopback origin required');origin=u.origin;},close:()=>{for(const res of streams)res.end();streams.clear();sessions.clear();bootstraps.clear();}};
}
