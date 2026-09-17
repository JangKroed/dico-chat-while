// Instrument the transport separately from delivery decisions. A timeout does not
// cancel a message already delivered to the tab: record its eventual reply too.
export function diagnosticError(error) {
  const clean=value=>String(value ?? '').replace(/https?:\/\/\S+/g,'[URL]').replace(/(Bearer\s+)[^\s]+/gi,'$1[REDACTED]');
  return {name:clean(error?.name || 'Error'),message:clean(error?.message ?? error),stack:clean(error?.stack)};
}
export function diagnosticRequest(action,{timeoutMs,operation,record,now=Date.now}) {
  const startedAt=now();let expired=false,timer;
  const emit=(stage,extra={})=>{try{Promise.resolve(record({kind:'transport',operation,stage,startedAt,eventAt:now(),elapsedMs:now()-startedAt,timeoutMs,...extra})).catch(()=>{});}catch{}};
  emit('request');
  const task=Promise.resolve().then(action).then(result=>{
    emit(expired?'late-response':'response',{result:result?.status ?? null});return result;
  },error=>{emit(expired?'late-error':'rejected',{exception:diagnosticError(error)});throw error;});
  return Promise.race([task,new Promise((_,reject)=>{
    timer=setTimeout(()=>{expired=true;const error=new Error(`${operation}: ${timeoutMs}ms 응답 시간 초과`);error.name='TimeoutError';emit('timeout',{exception:diagnosticError(error)});reject(error);},timeoutMs);
  })]).finally(()=>clearTimeout(timer));
}
