export function normalizeCoordination(value) {
  if (value==null) return null;
  let url;
  try {url=new URL(value.url);} catch {throw Error('조정기 주소를 확인하세요.');}
  const h=url.hostname;
  const privateHost=h==='localhost' || h==='127.0.0.1' || /^10\.\d+\.\d+\.\d+$/.test(h) || /^192\.168\.\d+\.\d+$/.test(h) || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h);
  if (!['http:','https:'].includes(url.protocol) || (url.protocol==='http:' && !privateHost) || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw Error('조정기는 HTTPS 주소 또는 내부망 HTTP 주소를 사용하세요. 경로와 로그인 정보는 넣지 마세요.');
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(value.token || '') || !/^[A-Za-z0-9_-]{1,100}$/.test(value.group || '')) throw Error('조정기 토큰(32~200자)과 그룹 이름을 확인하세요.');
  return {url:url.origin,token:value.token,group:value.group,...(value.clientId?{clientId:value.clientId}:{})};
}

export async function coordinationRequest(action, state, delivery, {fetchImpl=fetch,timeoutMs=5000}={}) {
  const config=normalizeCoordination(delivery.coordination || state.coordination);
  if (!config) throw Error('조정기 연결 설정이 없습니다.');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    const response=await fetchImpl(`${config.url}/${action}`,{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.token}`},signal:controller.signal,
      redirect:'error',credentials:'omit',cache:'no-store',
      body:JSON.stringify({group:config.group,member:state.ownUserId,clientId:config.clientId,channelId:state.target.channelId,attemptId:delivery.id,
        ...(action==='finish'?{outcome:delivery.coordinationOutcome}:{})}),
    });
    if (!response.ok) throw Error('request rejected');
    const result=await response.json();
    if (action==='acquire' ? typeof result?.allowed!=='boolean' : result?.ok!==true) throw Error('invalid response');
    return result;
  } catch {throw Error('조정기 응답을 확인하지 못했습니다. 연결과 중앙 발송 상태를 확인한 뒤 전송 결과를 선택하세요.');}
  finally {clearTimeout(timer);}
}
