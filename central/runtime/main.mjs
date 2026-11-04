/**
 * 중앙 관리 Node.js 프로세스의 시작점입니다.
 * 시작 순서: 전용 데이터 폴더/프로세스 잠금 → 코어와 서비스 생성 → HTTP 연결 → 주기 처리.
 * 종료 시 연결과 저장소를 정리하며, 업데이트 종료와 사용자 종료 의도를 구분합니다.
 */
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdir,open,readFile,rename,unlink,chmod} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {dataDirectory,readDescriptor} from '../host/paths.mjs';

/**
 * 임시 파일에 쓰고 디스크 동기화 후 이름을 바꿉니다.
 * 쓰기 도중 종료되어 최종 JSON 파일이 일부만 남는 가능성을 줄입니다.
 */
export async function atomicJSON(path,value) {
  const handle=await open(path+'.tmp','w',0o600);
  try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
  await rename(path+'.tmp',path);
}
async function readJSON(path) {try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return undefined;throw e;}}
/**
 * SQLite의 OS 잠금으로 관리 프로그램의 중복 실행을 막습니다.
 * 프로세스가 종료되면 잠금도 해제되므로 오래된 PID 파일 삭제 경쟁에 의존하지 않습니다.
 */
export async function acquireLock(dir) {
  // An OS-backed SQLite exclusive lock dies with its process. Never race a
  // stale PID file deletion against another process acquiring the same file.
  const lock=new DatabaseSync(resolve(dir,'manager-lock.sqlite'));
  try{lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;');}
  catch{lock.close();throw Error('이미 관리 프로그램이 실행 중이거나 저장소 잠금을 사용할 수 없습니다.');}
  return async()=>{try{lock.exec('ROLLBACK');}finally{lock.close();}};
}
/**
 * 각 서비스를 조립하고 런타임 핸들을 반환합니다.
 * 교체 가능한 모듈은 잠금을 얻은 뒤 로드하여 업데이트와 시작이 동시에 파일을 읽지 않게 합니다.
 * 제보 기능의 초기화 실패가 본래 발송 관리 서비스까지 중단시키지 않도록 별도로 처리합니다.
 */
export async function startCentralRuntime({directory=dataDirectory(),port,uiDirectory=resolve(dirname(fileURLToPath(import.meta.url)),'../ui/dist')}={}) {
  await mkdir(directory,{recursive:true,mode:0o700});if(process.platform!=='win32')await chmod(directory,0o700);const unlock=await acquireLock(directory);
  let manager,server,app,timer,unsubscribe,updates,lanAccess,supportDelivery,notificationRefresh,closing=false;
  try {
    // The updater holds this same OS lock while replacing application trees.
    // Load replaceable modules only after startup owns the lock.
    const [{createCentralManager},{inspectInstallation},{createCentralApplication},{createNotificationDispatcher},{createUpdateController,captureLegacyRollback},{selectRuntimePort,createSessionStore},{createLanAccess},{createSupportDelivery},{createSupportReport},{createCoalescedRefresh}]=await Promise.all([
      import('../core/index.js'),import('./setup-status.mjs'),import('./http.mjs'),import('./notifications.mjs'),import('./updater.mjs'),import('./ui-state.mjs'),import('./lan-access.mjs'),import('./support-delivery.mjs'),import('./support-report.mjs'),import('./coalesced-refresh.mjs')
    ]);
    // 구버전 worker가 health 응답 이후 previous를 지우기 전에 검증된 코드만 보관한다.
    await captureLegacyRollback({directory});
    const selectedPort=await selectRuntimePort({directory,port});
    const packageInfo=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')),appVersion=packageInfo.version;
    manager=createCentralManager({databasePath:resolve(directory,'central.sqlite')});
    // Diagnostics must never take down the primary delivery service.
    try{const connection=await readJSON(fileURLToPath(new URL('../support-connection.json',import.meta.url)))??await readJSON(fileURLToPath(new URL('../support-email-connection.json',import.meta.url)));supportDelivery=createSupportDelivery({dir:resolve(directory,'support'),connection,createReport:options=>createSupportReport({manager,appVersion,...options})});supportDelivery.start();}catch{supportDelivery=undefined;}
    const dispatcher=createNotificationDispatcher({load:()=>readJSON(resolve(directory,'notification-state.json')),save:v=>atomicJSON(resolve(directory,'notification-state.json'),v)});
    const closeRuntime=async({forUpdate=false}={})=>{
      if(closing)return;closing=true;clearInterval(timer);unsubscribe?.();const notificationDrain=notificationRefresh?.close();let shutdownError;
      if(!forUpdate)try{manager.execute('service.stopAll',{});}catch(error){shutdownError=error;}
      // 먼저 새 발송을 차단하고, 기존 알림 쓰기를 정리한 뒤 프로세스 잠금을 해제합니다.
      await notificationDrain;
      try{await atomicJSON(resolve(directory,'shutdown.json'),{intent:forUpdate?'update':'user',at:Date.now()});}catch(error){shutdownError??=error;}
      try{await supportDelivery?.close();await lanAccess?.close();}catch(error){shutdownError??=error;}
      try{await app.close();}catch(error){shutdownError??=error;}
      try{await new Promise(r=>server.close(r));}
      finally{
        manager.close();
        try{const d=await readJSON(resolve(directory,'runtime.json'));if(d?.pid===process.pid)await unlink(resolve(directory,'runtime.json'));}
        finally{await unlock();}
      }
      if(shutdownError)throw shutdownError;
    };
    updates=createUpdateController({
      directory,manager,shutdown:()=>closeRuntime({forUpdate:true}),
      onFailure:({jobId,diagnostic,retryCount,automatic})=>supportDelivery?.queue({automatic,incidentId:'update:'+jobId,updateDiagnostic:{...diagnostic,retryCount}}),
      supportStatus:jobId=>{
        if(!supportDelivery)return {status:'unavailable'};
        const state=supportDelivery.status(),item=state.outbox.find(item=>item.incidentId==='update:'+jobId);
        if(item?.status==='sent')return item;
        if(!state.settings.enabled)return {status:'disabled'};
        if(!state.configured)return {status:'unconfigured'};
        if(item)return item;
        return {status:state.settings.autoSend?'collecting':'manual'};
      }
    });
    const bridgeToken=randomBytes(32).toString('hex');
    server=http.createServer((req,res)=>{if(app)return void app.handler(req,res);res.writeHead(503,{'Cache-Control':'no-store'});res.end('관리 프로그램을 시작하고 있습니다.');});server.requestTimeout=15000;server.headersTimeout=10000;
    await new Promise((accept,reject)=>{server.once('error',error=>reject(error.code==='EADDRINUSE'?Object.assign(Error(`중앙 관리 주소의 ${selectedPort} 포트를 다른 프로그램이 사용하고 있습니다. 해당 프로그램을 종료한 뒤 다시 실행하세요. 주소를 임의로 변경하지 않았습니다.`),{code:'PORT_IN_USE'}):error));server.listen(selectedPort,'127.0.0.1',accept);});
    const url=`http://127.0.0.1:${server.address().port}`,sessionStore=await createSessionStore({directory,origin:url});
    lanAccess=await createLanAccess({directory,defaultPort:server.address().port<65535?server.address().port+1:43128,createApplication:options=>createCentralApplication({manager,uiDirectory,notificationDispatcher:dispatcher,updates,appVersion,supportDelivery,setupStatus:()=>inspectInstallation({directory,uiDirectory,snapshot:manager.snapshot()}),...options})});
    app=createCentralApplication({manager,origin:url,bridgeToken,lanAccess,supportDelivery,uiDirectory,notificationDispatcher:dispatcher,updates,appVersion,initialSessions:sessionStore.sessions,saveSessions:sessionStore.save,setupStatus:()=>inspectInstallation({directory,uiDirectory,snapshot:manager.snapshot()})});
    const descriptor={protocolVersion:1,url,pid:process.pid,bridgeToken};
    await atomicJSON(resolve(directory,'runtime.json'),descriptor);updates.setRuntimeDescriptor(descriptor);
    await unlink(resolve(directory,'shutdown.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});
    // 알림 판단에 필요한 전체 상태 읽기도 발송 이벤트의 동기 응답 경로에서 분리합니다.
    // 알림 저장이 느린 동안에는 중복 처리를 겹치지 않고 마지막 상태를 다시 확인합니다.
    notificationRefresh=createCoalescedRefresh(()=>dispatcher.process(manager.snapshot()));
    const report=()=>notificationRefresh.request();
    unsubscribe=manager.subscribe(event=>{report();if(event.type==='incident.opened'&&supportDelivery)void supportDelivery.queue({automatic:true,incidentId:event.incidentId,attemptId:event.attemptId}).catch(()=>{});if(event.type==='settings.reset')void lanAccess.reset().catch(()=>{});});
    timer=setInterval(()=>{void updates.monitor();try{manager.tick();report();}catch{report();}},1000);timer.unref();
    return {url,manager,app,updates,lanAccess,supportDelivery,close:closeRuntime};
  } catch(error) {clearInterval(timer);unsubscribe?.();await notificationRefresh?.close();await supportDelivery?.close().catch(()=>{});await lanAccess?.close().catch(()=>{});await app?.close().catch(()=>{});if(server?.listening)await new Promise(accept=>server.close(accept));manager?.close();await unlock();throw error;}
}
function openBrowser(url) {
  const command=process.platform==='darwin'?'/usr/bin/open':process.platform==='win32'?'rundll32.exe':'xdg-open';
  const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
  const child=spawn(command,args,{stdio:'ignore',windowsHide:true});child.on('error',()=>{});child.unref();
}
async function main() {
  const args=process.argv.slice(2),index=args.indexOf('--data-dir'),directory=index<0?dataDirectory():resolve(args[index+1]);
  if(args.includes('--open')) {
    try{
      const descriptor=await readDescriptor(directory);
      const reply=await fetch(descriptor.url+'/api/bridge/open',{method:'POST',headers:{Authorization:`Bearer ${descriptor.bridgeToken}`},signal:AbortSignal.timeout(3000)});
      if(reply.ok){openBrowser((await reply.json()).url);return;}
    }catch{}
  }
  const runtime=await startCentralRuntime({directory});
  console.log(`DICO 중앙관리 실행: ${runtime.url}`);
  if(args.includes('--open'))openBrowser(`${runtime.url}/#bootstrap=${runtime.app.issueBootstrap()}`);
  const stop=()=>void runtime.close().then(()=>process.exit(0));process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(error.message);process.exitCode=1;});
