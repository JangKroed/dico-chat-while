import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdir,open,readFile,rename,unlink,chmod} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createCentralManager} from '../core/index.js';
import {createCentralApplication} from './http.mjs';
import {createNotificationDispatcher} from './notifications.mjs';
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
export async function startCentralRuntime({directory=dataDirectory(),port=0,uiDirectory=resolve(dirname(fileURLToPath(import.meta.url)),'../ui/dist')}={}) {
  await mkdir(directory,{recursive:true,mode:0o700});if(process.platform!=='win32')await chmod(directory,0o700);const unlock=await acquireLock(directory);
  let manager,server,app,timer,unsubscribe;
  try {
    manager=createCentralManager({databasePath:resolve(directory,'central.sqlite')});
    const dispatcher=createNotificationDispatcher({load:()=>readJSON(resolve(directory,'notification-state.json')),save:v=>atomicJSON(resolve(directory,'notification-state.json'),v)});
    const bridgeToken=randomBytes(32).toString('hex');
    app=createCentralApplication({manager,bridgeToken,uiDirectory,notificationDispatcher:dispatcher});
    server=http.createServer((req,res)=>void app.handler(req,res));server.requestTimeout=15000;server.headersTimeout=10000;
    await new Promise((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',accept);});
    const url=`http://127.0.0.1:${server.address().port}`;app.setOrigin(url);
    await atomicJSON(resolve(directory,'runtime.json'),{protocolVersion:1,url,pid:process.pid,bridgeToken});
    await unlink(resolve(directory,'shutdown.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});
    const report=()=>void dispatcher.process(manager.snapshot()).catch(()=>{});
    unsubscribe=manager.subscribe(report);
    timer=setInterval(()=>{try{manager.tick();report();}catch{report();}},1000);timer.unref();
    let closing=false;
    return {url,manager,app,async close(){
      if(closing)return;closing=true;clearInterval(timer);unsubscribe();let shutdownError;
      try{manager.execute('service.stopAll',{});}catch(error){shutdownError=error;}
      try{await atomicJSON(resolve(directory,'shutdown.json'),{intent:'user',at:Date.now()});}catch(error){shutdownError??=error;}
      app.close();
      try{await new Promise(r=>server.close(r));}
      finally{
        manager.close();
        try{const d=await readJSON(resolve(directory,'runtime.json'));if(d?.pid===process.pid)await unlink(resolve(directory,'runtime.json'));}
        finally{await unlock();}
      }
      if(shutdownError)throw shutdownError;
    }};
  } catch(error) {clearInterval(timer);unsubscribe?.();app?.close();server?.close();manager?.close();await unlock();throw error;}
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
