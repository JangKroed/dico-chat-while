import http from 'node:http';
import {networkInterfaces} from 'node:os';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {join} from 'node:path';
import {readPrivateState,writePrivateState} from './ui-state.mjs';

export function isPrivateIPv4(address){
 const parts=String(address).split('.');if(parts.length!==4||parts.some(p=>!/^\d{1,3}$/.test(p)||String(Number(p))!==p||Number(p)>255))return false;
 const [a,b]=parts.map(Number);return a===10||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127;
}
export function lanAddresses(interfaces=networkInterfaces()){
 const found=new Map();for(const [name,items]of Object.entries(interfaces))for(const item of items||[])if(!item.internal&&(item.family==='IPv4'||item.family===4)&&isPrivateIPv4(item.address))found.set(item.address,{name,address:item.address});
 const priority=item=>item.address.startsWith('100.')||/^(?:utun|tun|tap)|tailscale|zerotier|hamachi/i.test(item.name)?2:/^(?:veth|docker|br-|bridge|vmnet)|vethernet|virtual|wsl/i.test(item.name)?1:0;
 return [...found.values()].sort((a,b)=>priority(a)-priority(b)||a.name.localeCompare(b.name)||a.address.localeCompare(b.address));
}
const validPort=value=>Number.isInteger(value)&&value>=1024&&value<=65535;
function failure(message){throw Object.assign(Error(message),{status:400});}

// This controller is created by the local runtime, not by a browser request.
// It never changes OS networking/firewall settings or binds a public/wildcard IP.
export async function createLanAccess({directory,defaultPort=43128,createApplication,addresses=lanAddresses,createServer=http.createServer,now=Date.now}={}){
 const file=join(directory,'lan-access.json');let config,loadError=null;
 try{config=await readPrivateState(file);if(config!==undefined&&(!config||config.version!==1||typeof config.enabled!=='boolean'||!validPort(config.port)||config.address!==''&&!isPrivateIPv4(config.address)))throw Error();}catch{config=undefined;loadError='내부망 접속 설정을 읽지 못해 접속을 끕니다. 로컬 화면에서 접속 설정을 다시 저장하세요.';}
 config??={version:1,enabled:false,address:'',port:validPort(defaultPort)?defaultPort:43128};
 let active=null,lastError=loadError,pending=Promise.resolve(),pairing=null,closed=false;
 const available=()=>addresses().filter(item=>isPrivateIPv4(item.address));
 const consume=code=>{
  if(!pairing||pairing.expiresAt<=now()||pairing.attempts>=10)return false;
  pairing.attempts++;
  const normalized=typeof code==='string'?code.replaceAll('-','').trim().toUpperCase():'';
  if(!/^[A-F0-9]{12}$/.test(normalized)||!timingSafeEqual(Buffer.from(normalized),Buffer.from(pairing.value)))return false;
  pairing=null;return true;
 };
 const status=()=>({enabled:!!active,address:active?.address||config.address,port:config.port,url:active?.url||null,addresses:available(),httpOnly:true,...(lastError?{error:lastError}:{})});
 async function stop(listener){if(!listener)return;pairing=null;await listener.app.close();await new Promise(resolve=>{listener.server.close(resolve);listener.server.closeAllConnections?.();});}
 async function start(address,port){
  const url=`http://${address}:${port}`,app=await createApplication({origin:url,mode:'lan',pairingCodes:{consume}}),server=createServer((req,res)=>void app.handler(req,res));
  server.requestTimeout=15000;server.headersTimeout=10000;
  try{await new Promise((resolve,reject)=>{const fail=error=>{server.removeListener('listening',ready);reject(error);};const ready=()=>{server.removeListener('error',fail);resolve();};server.once('error',fail);server.once('listening',ready);server.listen(port,address);});}
  catch(error){await app.close();throw Object.assign(Error(error.code==='EADDRINUSE'?`내부망 접속 포트 ${port}가 사용 중입니다. 포트를 바꾸거나 해당 프로그램을 확인하세요.`:'내부망 주소에 접속 창을 열지 못했습니다. 네트워크 연결을 확인하세요.'),{status:error.code==='EADDRINUSE'?409:503});}
  server.on('error',()=>{lastError='내부망 접속 연결에 오류가 발생했습니다. 접속 설정을 다시 확인하세요.';});
  return{address,port,url,app,server};
 }
 async function update(payload){
  if(closed)failure('관리 프로그램을 종료하고 있습니다.');
  if(typeof payload?.enabled!=='boolean')failure('내부망 접속 허용 여부를 선택하세요.');
  const port=payload.port??config.port;if(!validPort(port))failure('내부망 접속 포트는 1024~65535 사이 정수로 입력하세요.');
  if(payload.address!==undefined&&typeof payload.address!=='string')failure('사용 가능한 사설 IPv4 주소를 선택하세요.');
  const choices=available(),address=payload.address===undefined?(config.address||choices[0]?.address||''):(payload.address|| (payload.enabled?choices[0]?.address||'':''));
  if(address!==''&&!isPrivateIPv4(address))failure('사용 가능한 사설 IPv4 주소를 선택하세요.');
  if(payload.enabled&&!choices.some(item=>item.address===address))failure('현재 PC에 연결된 내부망 주소를 선택하세요.');
  const next={version:1,enabled:payload.enabled,address,interfaceName:choices.find(item=>item.address===address)?.name||config.interfaceName||'',port};let candidate=null;
  if(payload.enabled&&(!active||active.address!==address||active.port!==port))candidate=await start(address,port);
  try{await writePrivateState(file,next);}catch(error){await stop(candidate);throw error;}
  const previous=active;config=next;lastError=null;
  if(candidate){active=candidate;await stop(previous);}else if(!next.enabled){active=null;await stop(previous);}
  return status();
 }
 const run=fn=>{const job=pending.then(fn);pending=job.catch(()=>{});return job;};
 if(config.enabled){
  const choices=available(),address=choices.some(item=>item.address===config.address)?config.address:choices.find(item=>config.interfaceName&&item.name===config.interfaceName)?.address;
  if(address)try{active=await start(address,config.port);if(address!==config.address){config={...config,address};await writePrivateState(file,config);}}catch(error){lastError=error.message;}else lastError='사용 가능한 내부망 주소가 없습니다. 네트워크 연결을 확인하세요.';
 }
 return{status,update:payload=>run(()=>update(payload)),pair:()=>run(()=>{
  if(!active||closed)failure('먼저 내부망 접속을 허용하세요.');
  const value=randomBytes(6).toString('hex').toUpperCase();pairing={value,expiresAt:now()+120000,attempts:0};
  return{code:value.match(/.{4}/g).join('-'),expiresAt:pairing.expiresAt,url:active.url+'/'};
 }),reset:()=>run(()=>update({enabled:false,address:'',port:validPort(defaultPort)?defaultPort:43128})),close:()=>run(async()=>{closed=true;const previous=active;active=null;await stop(previous);})};
}
