// 공개 제출 키는 호출자 신원을 증명하지 않는다. 실행 계정의 메일 권한은 서버에만 둔다.
// 구형 확장용 Code.gs와 별도 프로젝트에 배포하며 수신자는 클라이언트가 바꾸지 못한다.
function relayBytes(text) {
  // UTF-16 문자열 길이가 아닌 실제 UTF-8 크기를 센다. 큰 바이트 배열 복사를 피한다.
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length &&
        text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}
function relayReport(input, key) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const records = value => Array.isArray(value) && value.length <= 50000 && value.every(object);
  if (!object(input) || input.format !== 'dico-support-report' || input.schemaVersion !== 1 ||
      typeof input.reportId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.reportId) ||
      !Number.isSafeInteger(input.createdAt) || input.createdAt < 0 || !object(input.privacy) ||
      typeof input.privacy.includeBodies !== 'boolean' || typeof input.privacy.includeNames !== 'boolean' ||
      !object(input.runtime) || !object(input.selection) || !object(input.configuration)) throw Error('INVALID');
  for (const field of ['events','attempts','commands','incidents','timeline']) if (!records(input[field])) throw Error('INVALID');
  for (const field of ['instances','accounts','targets','channels','groups']) if (!records(input.configuration[field])) throw Error('INVALID');
  // 가져온 보고서도 깊이·노드 수를 제한한다. 비밀 필드와 동의 없는 자료는 첨부하지 않는다.
  const secret = /(?:token|secret|password|authorization|cookie|session|bootstrap|permitId|draftBackup|credential|csrf|passphrase|private[_-]?key|access[_-]?key|signing[_-]?key)|^(?:key|report_key|api[_-]?key)$/i;
  const names = /^(?:name|username|observedName|accountName|channelName|groupName|instanceName|messageName)$/;
  let nodes = 0;
  function clean(value, depth, bodies) {
    if (++nodes > 200000 || depth > 12) throw Error('INVALID');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw Error('INVALID'); return value; }
    if (typeof value === 'string') {
      if (value.length > 100000) throw Error('INVALID');
      // 필드명 필터만으로 막을 수 없는 흔한 인증 헤더·자격증명 원문도 제거한다.
      return value.split(key).join('[REDACTED]')
        .replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g, '[REDACTED]')
        .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, '[REDACTED]')
        .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, '[REDACTED]')
        .replace(/\b(?:password|passphrase|api[_-]?key|access[_-]?key|token|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi, '[REDACTED]');
    }
    if (Array.isArray(value)) { if (value.length > 50000) throw Error('INVALID'); return value.map(item => clean(item, depth + 1, bodies)); }
    if (!object(value)) throw Error('INVALID');
    const result = {};
    for (const field of Object.keys(value)) {
      if (field.length > 200 || ['__proto__','constructor','prototype'].includes(field)) throw Error('INVALID');
      // 제외되는 필드도 검증해 매우 깊은 입력으로 검사를 우회하지 못하게 한다.
      const item = clean(value[field], depth + 1, bodies);
      if (field.includes(key) || secret.test(field) || field === 'body' && !bodies || names.test(field) && !input.privacy.includeNames) continue;
      result[field] = item;
    }
    return result;
  }
  const report = clean(input, 0, false);
  // 본문 포함은 발송 시도 목록에서만 허용한다. 클라이언트가 동의했다고 주장하는 값은 신원 증명이 아니다.
  if (input.privacy.includeBodies) { nodes = 0; report.attempts = clean(input.attempts, 0, true); }
  if (relayBytes(JSON.stringify(report)) > 16 * 1024 * 1024) throw Error('INVALID');
  return report;
}
function doPost(e) {
  const json = value => ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
  let properties, report;
  // 형식·인증 실패 요청이 전역 발송 락을 오래 점유하지 않도록 잠금 전에 검사한다.
  try {
    const raw = e && e.postData && e.postData.contents;
    if (typeof raw !== 'string' || raw.length > 17 * 1024 * 1024 || relayBytes(raw) > 17 * 1024 * 1024) return json({ok:false,code:'INVALID'});
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return json({ok:false,code:'INVALID'});
    properties = PropertiesService.getScriptProperties();
    const key = properties.getProperty('REPORT_KEY');
    if (!key || key.length < 24 || data.key !== key) return json({ok:false,code:'UNAUTHORIZED'});
    report = relayReport(data.report, key);
  } catch (_) { return json({ok:false,code:'INVALID'}); }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(500)) return json({ok:false,code:'BUSY'});
  try {
    if (properties.getProperty('REPORT_DISABLED') === 'true') return json({ok:false,code:'DISABLED'});
    const now = Date.now(), id = 'RECEIPT_' + report.reportId;
    const previous = JSON.parse(properties.getProperty(id) || 'null');
    // 기존 배포의 영수증 형식도 읽는다. 이미 보낸 ID는 한도에 도달해도 다시 보내지 않는다.
    if (previous) return json(previous.sent ? previous.receipt || {reportId:report.reportId,receiptId:previous.receiptId,receivedAt:previous.at,delivery:'email'} : {ok:false,code:'DELIVERY_UNCERTAIN'});
    const day = new Date(now).toISOString().slice(0,10);
    let budget = JSON.parse(properties.getProperty('REPORT_BUDGET') || '{}');
    if (budget.day !== day) budget = {day:day,count:0,bytes:0};
    if (!Number.isSafeInteger(budget.count) || budget.count < 0 || budget.bytes !== undefined && (!Number.isSafeInteger(budget.bytes) || budget.bytes < 0)) return json({ok:false,code:'QUOTA'});
    const attachmentText = JSON.stringify(report), bytes = relayBytes(attachmentText);
    if (budget.count >= 20 || (budget.bytes || 0) + bytes > 32 * 1024 * 1024 || MailApp.getRemainingDailyQuota() < 1) return json({ok:false,code:'QUOTA'});
    const recent = JSON.parse(properties.getProperty('REPORT_RECENT') || '[]');
    if (!Array.isArray(recent) || recent.some(at => !Number.isSafeInteger(at) || at < 0)) return json({ok:false,code:'RATE_LIMIT'});
    const active = recent.filter(at => at > now - 60000);
    if (active.length >= 3) return json({ok:false,code:'RATE_LIMIT'});
    // 중복 방지 자료는 90일간 보존한다. 저장 한도 때문에 최근 영수증을 버리지 않는다.
    const all = properties.getProperties();
    for (const field of Object.keys(all)) if (field.indexOf('RECEIPT_') === 0) {
      const entry = JSON.parse(all[field]);
      if (entry.at < now - 90 * 86400000) { properties.deleteProperty(field); delete all[field]; }
    }
    const storedBytes = Object.keys(all).reduce((sum, field) => sum + relayBytes(field) + relayBytes(all[field]), 0);
    if (storedBytes + 1024 > 450 * 1024) return json({ok:false,code:'STORAGE_LIMIT'});
    const attachment = Utilities.newBlob(attachmentText,'application/json','dico-support-'+report.reportId+'.json');
    const receipt = {reportId:report.reportId,receiptId:Utilities.getUuid(),receivedAt:now,delivery:'email'};
    budget.count++; budget.bytes = (budget.bytes || 0) + bytes; active.push(now);
    properties.setProperty('REPORT_BUDGET',JSON.stringify(budget));
    properties.setProperty('REPORT_RECENT',JSON.stringify(active));
    // 서비스 오류·응답 유실 때도 발송을 반복하지 않도록 호출 전에 예약을 영속화한다.
    properties.setProperty(id,JSON.stringify({at:now,sent:false}));
    MailApp.sendEmail({to:'didlsdydgh@gmail.com',subject:'[DICO] 자동 오류 제보 '+report.reportId,
      body:'공개 제출 경로에서 접수한 검증되지 않은 진단 자료입니다. 발신자 신원과 내용의 진위를 보장하지 않습니다.\n보고서 ID: '+report.reportId+
        '\n이벤트: '+report.events.length+'건 / 발송 시도: '+report.attempts.length+'건\n진단 자료는 JSON 첨부 파일에 있습니다.',
      attachments:[attachment]});
    properties.setProperty(id,JSON.stringify({at:now,sent:true,receiptId:receipt.receiptId}));
    return json(receipt);
  } catch (_) { return json({ok:false,code:'DELIVERY_UNCERTAIN'}); }
  finally { lock.releaseLock(); }
}
