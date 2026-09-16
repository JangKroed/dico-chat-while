export const EMAIL_ALARM = 'dico-email-report';
export function validateMailConfig(config) {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(config?.url || '')) throw new Error('Apps Script 웹 앱의 /exec 주소를 입력하세요.');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(config?.key || '')) throw new Error('연결 키는 영문·숫자·밑줄·하이픈 32~128자로 입력하세요.');
}
export async function sendReport(api, config, report, transport = fetch) {
  validateMailConfig(config);
  const response = await transport(config.url, {method:'POST', credentials:'omit',
    headers:{'Content-Type':'text/plain;charset=utf-8'},
    body:JSON.stringify({key:config.key,report}), signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('메일 서버 HTTP 오류');
  const result = await response.json();
  if (result.ok !== true) throw new Error('메일 서버에서 요청을 거부했습니다. 연결 키·배포 권한·발송 한도를 확인하세요.');
}
export async function queueEmailReport(api, events) {
  const {mailConfig, diagnosticLog=[]} = await api.storage.local.get(['mailConfig','diagnosticLog']);
  if (!mailConfig?.enabled || !events.some(e=>e.kind==='error' || e.kind==='runtime-error')) return;
  await api.storage.local.set({pendingEmailReport:{id:crypto.randomUUID(),createdAt:new Date().toISOString(),
    version:api.runtime.getManifest().version, events:diagnosticLog.slice(-100)}});
  await api.alarms.create(EMAIL_ALARM,{delayInMinutes:1});
}
let sending = false;
export async function flushEmailReport(api) {
  if (sending) return;
  sending=true;
  try {
    const {mailConfig,pendingEmailReport:report}=await api.storage.local.get(['mailConfig','pendingEmailReport']);
    if (!mailConfig?.enabled || !report) return;
    // One attempt: a lost response must not produce repeated emails.
    await api.storage.local.remove('pendingEmailReport');
    try {
      await sendReport(api,mailConfig,report);
      await api.storage.local.set({mailStatus:'메일 서버가 발송 처리를 완료했습니다.'});
    } catch {
      await api.storage.local.set({mailStatus:'메일 발송 실패 또는 응답 확인 불가. 연결 설정을 확인하고 진단 로그를 다운로드하세요.'});
    }
  } finally { sending=false; }
}
