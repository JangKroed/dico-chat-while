const validCode=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value);
const transientCodes=new Set(['NATIVE_DISCONNECTED','NATIVE_REQUEST_TIMEOUT','NATIVE_SEND_FAILED','SERVICE_UNAVAILABLE']);
function transportError(message,details={},fallback='NATIVE_RESPONSE_REJECTED'){
  const candidate=details.code??details.errorCode??details.error?.code;
  const code=validCode(candidate)?candidate:fallback;
  return Object.assign(Error(message),{code,retryable:details.retryable===true||details.error?.retryable===true||transientCodes.has(code)});
}
export function createNativeTransport(chrome,{host='com.dico.manager',timeoutMs=12000}={}) {
  let port=null,serial=0,listener=()=>{},disconnected=()=>{};const pending=new Map();
  const finish=reason=>{port=null;for(const task of pending.values()){clearTimeout(task.timer);task.reject(transportError('관리 프로그램 연결이 끊겼습니다.',{},'NATIVE_DISCONNECTED'));}pending.clear();disconnected(reason);};
  function connect(){
    if(port)return;
    port=chrome.runtime.connectNative(host);
    const activePort=port;
    activePort.onMessage.addListener(packet=>{
      if(port!==activePort)return;
      if(packet.type==='COMMAND'){listener(packet.command);return;}
      if(packet.type!=='RESPONSE')return;const task=pending.get(packet.requestId);if(!task)return;
      pending.delete(packet.requestId);clearTimeout(task.timer);packet.ok?task.resolve(packet.result):task.reject(transportError('관리 프로그램의 응답을 확인하지 못했습니다.',packet));
    });
    activePort.onDisconnect.addListener(()=>{if(port!==activePort)return;finish(chrome.runtime.lastError?.message);});
  }
  return {get connected(){return Boolean(port);},onCommand:fn=>{listener=fn;},onDisconnect:fn=>{disconnected=fn;},disconnect(){const previous=port;if(!previous)return;finish('연결을 종료했습니다.');previous.disconnect();},request(message,instanceId){
    return new Promise((resolve,reject)=>{
      let requestId,timer;
      try{connect();requestId=String(++serial);timer=setTimeout(()=>{pending.delete(requestId);reject(transportError('관리 프로그램 응답이 지연됩니다.',{},'NATIVE_REQUEST_TIMEOUT'));},timeoutMs);pending.set(requestId,{resolve,reject,timer});port.postMessage({requestId,message,...(instanceId?{instanceId}:{})});}
      catch(error){if(timer)clearTimeout(timer);if(requestId)pending.delete(requestId);reject(transportError('관리 프로그램에 요청을 전달하지 못했습니다.',error,'NATIVE_SEND_FAILED'));}
    });
  }};
}
