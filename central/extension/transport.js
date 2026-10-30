export function createNativeTransport(chrome,{host='com.dico.manager',timeoutMs=12000}={}) {
  let port=null,serial=0,listener=()=>{},disconnected=()=>{};const pending=new Map();
  const finish=reason=>{port=null;for(const task of pending.values()){clearTimeout(task.timer);task.reject(Error('관리 프로그램 연결이 끊겼습니다.'));}pending.clear();disconnected(reason);};
  function connect(){
    if(port)return;
    port=chrome.runtime.connectNative(host);
    const activePort=port;
    activePort.onMessage.addListener(packet=>{
      if(port!==activePort)return;
      if(packet.type==='COMMAND'){listener(packet.command);return;}
      if(packet.type!=='RESPONSE')return;const task=pending.get(packet.requestId);if(!task)return;
      pending.delete(packet.requestId);clearTimeout(task.timer);packet.ok?task.resolve(packet.result):task.reject(Error('관리 프로그램의 응답을 확인하지 못했습니다.'));
    });
    activePort.onDisconnect.addListener(()=>{if(port!==activePort)return;finish(chrome.runtime.lastError?.message);});
  }
  return {get connected(){return Boolean(port);},onCommand:fn=>{listener=fn;},onDisconnect:fn=>{disconnected=fn;},disconnect(){const previous=port;if(!previous)return;finish('연결을 종료했습니다.');previous.disconnect();},request(message,instanceId){
    return new Promise((resolve,reject)=>{try{connect();const requestId=String(++serial),timer=setTimeout(()=>{pending.delete(requestId);reject(Error('관리 프로그램 응답이 지연됩니다.'));},timeoutMs);pending.set(requestId,{resolve,reject,timer});port.postMessage({requestId,message,...(instanceId?{instanceId}:{})});}catch(error){reject(error);}});
  }};
}
