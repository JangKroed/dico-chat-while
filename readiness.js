import { parseChannel } from './controller.js';

// A newly created tab can expose its destination only as pendingUrl.
// Never authorize input until the committed URL and page are both ready.
export function tabReadiness(tab, target) {
  if (!tab) return {ok:false,code:'TAB_MISSING',error:'전송용 탭이 닫혔습니다.'};
  const matches = url => {
    const parsed = parseChannel(url);
    return parsed?.channelId === target.channelId && parsed.guildId === target.guildId;
  };
  const loading = {ok:false,code:'PAGE_LOADING',retryable:true,error:'Discord 페이지 로딩 중입니다.'};
  const wrong = {ok:false,code:'WRONG_CHANNEL',error:'대상 탭이 다른 페이지로 이동했습니다. 로그인 상태와 채널을 확인하세요.'};
  if (tab.pendingUrl) return matches(tab.pendingUrl) ? loading : wrong;
  if (tab.status === 'loading' && (!tab.url || tab.url === 'about:blank')) return loading;
  if (!matches(tab.url)) return wrong;
  if (tab.discarded || tab.frozen) return {ok:false,code:'TAB_SUSPENDED',error:'전송용 탭이 메모리 절약으로 중지되었습니다.'};
  return tab.status === 'loading' ? loading : {ok:true};
}

// Read-only probes may repeat while Discord mounts its editor. Delivery never retries.
export async function waitForReady(probe, {
  attempts = 25,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  cancelled = () => false,
} = {}) {
  let result;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (cancelled()) return { ok: false, code: 'CANCELLED', error: '입력창 준비 중 시작이 취소되었습니다.' };
    result = await probe();
    if (result?.ok || !result?.retryable) return result;
    if (attempt + 1 < attempts) await sleep(400);
  }
  return { ...result, retryable: false, error: `${result?.error || '입력창이 준비되지 않았습니다.'} 준비 대기 시간이 초과되었습니다. 전송용 창의 로그인·권한 상태를 확인하고 다시 시작해 주세요.` };
}
