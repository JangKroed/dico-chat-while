import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdir,open,readFile,rename,unlink,chmod} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {dataDirectory,readDescriptor} from '../host/paths.mjs';

export async function atomicJSON(path,value) {
  const handle=await open(path+'.tmp','w',0o600);
  try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
  await rename(path+'.tmp',path);
}
async function readJSON(path) {try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return undefined;throw e;}}
export async function acquireLock(dir) {
  // An OS-backed SQLite exclusive lock dies with its process. Never race a
  // stale PID file deletion against another process acquiring the same file.
  const lock=new DatabaseSync(resolve(dir,'manager-lock.sqlite'));
  try{lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;');}
  catch{lock.close();throw Error('이미 관리 프로그램이 실행 중이거나 저장소 잠금을 사용할 수 없습니다.');}
  return async()=>{try{lock.exec('ROLLBACK');}finally{lock.close();}};
}
export async function startCentralRuntime({directory=dataDirectory(),port,uiDirectory=resolve(dirname(fileURLToPath(import.meta.url)),'../ui/dist')}={}) {
  await mkdir(directory,{recursive:true,mode:0o700});if(process.platform!=='win32')await chmod(directory,0o700);const unlock=await acquireLock(directory);
  let manager,server,app,timer,unsubscribe,updates,closing=false;
  try {
    // The updater holds this same OS lock while replacing application trees.
    // Load replaceable modules only after startup owns the lock.
    const [{createCentralManager},{inspectInstallation},{createCentralApplication},{createNotificationDispatcher},{createUpdateController},{selectRuntimePort,createSessionStore}]=await Promise.all([
      import('../core/index.js'),import('./setup-status.mjs'),import('./http.mjs'),import('./notifications.mjs'),import('./updater.mjs'),import('./ui-state.mjs')
    ]);
    const selectedPort=await selectRuntimePort({directory,port});
    const packageInfo=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')),appVersion=packageInfo.version;
    manager=createCentralManager({databasePath:resolve(directory,'central.sqlite')});
    const dispatcher=createNotificationDispatcher({load:()=>readJSON(resolve(directory,'notification-state.json')),save:v=>atomicJSON(resolve(directory,'notification-state.json'),v)});
    const closeRuntime=async({forUpdate=false}={})=>{
      if(closing)return;closing=true;clearInterval(timer);unsubscribe?.();let shutdownError;
      if(!forUpdate)try{manager.execute('service.stopAll',{});}catch(error){shutdownError=error;}
      try{await atomicJSON(resolve(directory,'shutdown.json'),{intent:forUpdate?'update':'user',at:Date.now()});}catch(error){shutdownError??=error;}
      try{await app.close();}catch(error){shutdownError??=error;}
      try{await new Promise(r=>server.close(r));}
      finally{
        manager.close();
        try{const d=await readJSON(resolve(directory,'runtime.json'));if(d?.pid===process.pid)await unlink(resolve(directory,'runtime.json'));}
        finally{await unlock();}
      }
      if(shutdownError)throw shutdownError;
    };
    updates=createUpdateController({directory,manager,shutdown:()=>closeRuntime({forUpdate:true})});
    const bridgeToken=randomBytes(32).toString('hex');
    server=http.createServer((req,res)=>{if(app)return void app.handler(req,res);res.writeHead(503,{'Cache-Control':'no-store'});res.end('관리 프로그램을 시작하고 있습니다.');});server.requestTimeout=15000;server.headersTimeout=10000;
    await new Promise((accept,reject)=>{server.once('error',error=>reject(error.code==='EADDRINUSE'?Object.assign(Error(`중앙 관리 주소의 ${selectedPort} 포트를 다른 프로그램이 사용하고 있습니다. 해당 프로그램을 종료한 뒤 다시 실행하세요. 주소를 임의로 변경하지 않았습니다.`),{code:'PORT_IN_USE'}):error));server.listen(selectedPort,'127.0.0.1',accept);});
    const url=`http://127.0.0.1:${server.address().port}`,sessionStore=await createSessionStore({directory,origin:url});
    app=createCentralApplication({manager,origin:url,bridgeToken,uiDirectory,notificationDispatcher:dispatcher,updates,appVersion,initialSessions:sessionStore.sessions,saveSessions:sessionStore.save,setupStatus:()=>inspectInstallation({directory,uiDirectory,snapshot:manager.snapshot()})});
    const descriptor={protocolVersion:1,url,pid:process.pid,bridgeToken};
    await atomicJSON(resolve(directory,'runtime.json'),descriptor);updates.setRuntimeDescriptor(descriptor);
    await unlink(resolve(directory,'shutdown.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});
    const report=()=>void dispatcher.process(manager.snapshot()).catch(()=>{});
    unsubscribe=manager.subscribe(report);
    timer=setInterval(()=>{try{manager.tick();report();}catch{report();}},1000);timer.unref();
    return {url,manager,app,updates,close:closeRuntime};
  } catch(error) {clearInterval(timer);unsubscribe?.();await app?.close().catch(()=>{});if(server?.listening)await new Promise(accept=>server.close(accept));manager?.close();await unlock();throw error;}
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
