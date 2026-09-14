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
