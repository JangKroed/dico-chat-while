import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCentralApplication} from '../central/runtime/http.mjs';
import {createLanAccess} from '../central/runtime/lan-access.mjs';

async function request(handler,origin,path,{method='GET',body,cookie,csrf}={}){
  const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);req.url=path;req.method=method;req.headers={host:new URL(origin).host,...(method==='POST'?{origin,'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(csrf?{'x-dico-csrf':csrf}:{})};
  const result={status:0,headers:{},body:''};let finish;const done=new Promise(resolve=>finish=resolve);await handler(req,{setHeader(k,v){result.headers[k.toLowerCase()]=v;},writeHead(status){result.status=status;},end(body=''){result.body=body;finish();},on(){}});await done;return result;
}

test('local enable and pairing reach the real LAN auth boundary and disabling invalidates the remote session',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dico-lan-integration-'));t.after(()=>rm(directory,{recursive:true,force:true}));const servers=[],commands=[];
  const manager={snapshot:()=>({messages:[{id:'central-message'}]}),execute:(action,payload)=>{commands.push({action,payload});return{};}};
  const controller=await createLanAccess({directory,addresses:()=>[{name:'en0',address:'192.168.0.20'}],createApplication:options=>createCentralApplication({manager,...options}),createServer:handler=>{
    const server=new EventEmitter();Object.assign(server,{handler,listening:false,listen(port,address){this.port=port;this.address=address;this.listening=true;queueMicrotask(()=>this.emit('listening'));},close(callback){this.listening=false;queueMicrotask(callback);},closeAllConnections(){}});servers.push(server);return server;
  }});t.after(()=>controller.close());
  const localOrigin='http://127.0.0.1:43127',local=createCentralApplication({manager,origin:localOrigin,bridgeToken:'b'.repeat(64),lanAccess:controller});t.after(()=>local.close());
  const session=await request(local.handler,localOrigin,'/api/session',{method:'POST',body:{token:local.issueBootstrap()}}),cookie=session.headers['set-cookie'].split(';')[0],csrf=JSON.parse(session.body).csrfToken;
  assert.equal(servers.length,0);
  const enabled=await request(local.handler,localOrigin,'/api/lan-access',{method:'POST',body:{enabled:true},cookie,csrf});assert.equal(enabled.status,200);const lanOrigin=JSON.parse(enabled.body).url;assert.equal(lanOrigin,'http://192.168.0.20:43128');assert.equal(servers[0].address,'192.168.0.20');
  const lan=servers[0].handler;assert.equal((await request(lan,lanOrigin,'/api/snapshot')).status,401);
  const paired=await request(local.handler,localOrigin,'/api/lan-access/pair',{method:'POST',body:{},cookie,csrf});const pair=JSON.parse(paired.body);assert.match(pair.code,/^[A-F0-9]{4}(-[A-F0-9]{4}){2}$/);
  const remote=await request(lan,lanOrigin,'/api/session',{method:'POST',body:{pairingCode:pair.code.toLowerCase()}});assert.equal(remote.status,200);const remoteCookie=remote.headers['set-cookie'].split(';')[0],remoteCsrf=JSON.parse(remote.body).csrfToken;
  assert.deepEqual(JSON.parse((await request(lan,lanOrigin,'/api/snapshot',{cookie:remoteCookie})).body),{messages:[{id:'central-message'}]});
  assert.equal((await request(lan,lanOrigin,'/api/command',{method:'POST',body:{action:'group.stop',payload:{id:'selected'}},cookie:remoteCookie,csrf:remoteCsrf})).status,200);assert.deepEqual(commands,[{action:'group.stop',payload:{id:'selected'}}]);
  assert.equal((await request(lan,lanOrigin,'/api/bridge/open',{method:'POST',body:{},cookie:remoteCookie,csrf:remoteCsrf})).status,404);
  await request(local.handler,localOrigin,'/api/lan-access',{method:'POST',body:{enabled:false},cookie,csrf});assert.equal(servers[0].listening,false);assert.equal((await request(lan,lanOrigin,'/api/snapshot',{cookie:remoteCookie})).status,503);
  await request(local.handler,localOrigin,'/api/lan-access',{method:'POST',body:{enabled:true},cookie,csrf});const next=servers[1].handler;assert.equal((await request(next,lanOrigin,'/api/snapshot',{cookie:remoteCookie})).status,401);assert.equal((await request(next,lanOrigin,'/api/session',{method:'POST',body:{pairingCode:pair.code}})).status,401);
  assert.equal((await request(local.handler,localOrigin,'/api/snapshot',{cookie})).status,200);
});
