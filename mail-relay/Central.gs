// 중앙 관리 전용 중계. 공개 REPORT_KEY는 발신자 인증 수단이 아니다.
// REPORT_TRUSTED_KEYS에는 저장소/배포본에 넣지 않는 설치별 키의 JSON 배열을 설정한다.
// 수신자는 서버에 고정하며 클라이언트의 to/cc/bcc 등은 사용하지 않는다.
function doPost(e) {
  const json = value => ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
  const reject = code => json({ok:false,code:code});
  let data;
  try {
    const raw = e && e.postData && e.postData.contents;
    if (typeof raw !== 'string' || raw.length > 17*1024*1024 || relayBytes(raw) > 17*1024*1024) return reject('INVALID');
    data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return reject('INVALID');
  } catch (_) { return reject('INVALID'); }
  const properties = PropertiesService.getScriptProperties();
  const publicKey = properties.getProperty('REPORT_KEY');
  let trustedKeys;
  try {
    trustedKeys = JSON.parse(properties.getProperty('REPORT_TRUSTED_KEYS') || '[]');
    if (!Array.isArray(trustedKeys) || trustedKeys.length > 50 || trustedKeys.some(k=>typeof k !== 'string' || k.length < 24 || k.length > 200 || k === publicKey)) return reject('CONFIG');
  } catch (_) { return reject('CONFIG'); }
  const trusted = trustedKeys.indexOf(data.key) !== -1;
  if (typeof data.key !== 'string' || !(trusted || publicKey && publicKey.length >= 24 && data.key === publicKey)) return reject('UNAUTHORIZED');
  let report;
  const now = Date.now();
  try { report = relayReport(data.report,now); } catch (_) { return reject('INVALID'); }
  const serialized = JSON.stringify(report), digest = relayHash(serialized);
  // 키별 공간과 내용 지문으로 다른 제출자의 ID 선점 및 내용 바꿔치기를 구분한다.
  const id = 'R2_' + relayHash(data.key + '\n' + report.reportId);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return reject('BUSY');
  try {
    const previous = JSON.parse(properties.getProperty(id) || 'null');
    if (previous) {
      if (previous[2] !== digest) return reject('CONFLICT');
      return previous[1] ? json(relayReceipt(report.reportId,previous)) : reject('DELIVERY_UNCERTAIN');
    }
    // 구형 영수증에는 내용 지문이 없다. 확인 없이 성공을 돌려주거나 재발송하지 않는다.
    if (!trusted && properties.getProperty('RECEIPT_' + report.reportId)) return reject('DELIVERY_UNCERTAIN');
    const all = properties.getProperties();
    Object.keys(all).filter(k=>k.indexOf('RECEIPT_')===0 || k.indexOf('R2_')===0).forEach(k=>{
      const entry=JSON.parse(all[k]),at=Array.isArray(entry)?entry[0]:entry.at;
      if (Number.isFinite(at) && at <= now-90*86400000) { properties.deleteProperty(k);delete all[k]; }
      else if (k.indexOf('RECEIPT_')===0 && Number.isFinite(at)) {
        // 구형 90일 기록도 상한 안에 들어오도록 ID 차단 흔적만 압축해 보존한다.
        const compact=JSON.stringify({at:at,sent:false});
        if(all[k]!==compact){properties.setProperty(k,compact);all[k]=compact;}
      }
    });
    const day = new Date(now).toISOString().slice(0,10);
    let budget = JSON.parse(properties.getProperty('REPORT_BUDGET') || '{}');
    if (budget.day !== day) budget = {day:day,count:0,publicCount:0};
    // 구형 당일 카운터는 모두 공개 제출로 취급하여 배포 시 한도를 초기화하지 않는다.
    if (!Number.isSafeInteger(budget.count) || budget.count < 0) return reject('CONFIG');
    const publicCount = budget.publicCount === undefined ? budget.count : budget.publicCount;
    if (!Number.isSafeInteger(publicCount) || publicCount < 0) return reject('CONFIG');
    if (budget.count >= 20 || !trusted && publicCount >= 5 || MailApp.getRemainingDailyQuota() < 1) {
      return json({ok:false,code:'QUOTA',retryAfterMs:86400000});
    }
    // 90일 x 하루 20건을 수용하는 짧은 영수증. 저장 실패 후 메일을 보내지 않는다.
    const entry = [now,'',digest],receiptId = Utilities.getUuid();
    const reservedBytes = relayBytes(id + JSON.stringify([now,receiptId,digest]));
    const usedBytes = Object.keys(all).reduce((sum,k)=>sum+relayBytes(k+all[k]),0);
    if (usedBytes + reservedBytes + 1024 > 400*1024) return reject('STORAGE');
    budget.count++;budget.publicCount=publicCount+(trusted?0:1);
    properties.setProperty('REPORT_BUDGET',JSON.stringify(budget));
    properties.setProperty(id,JSON.stringify(entry));
    const attachment = Utilities.newBlob(serialized,'application/json','dico-support-'+report.reportId+'.json');
    MailApp.sendEmail({to:'didlsdydgh@gmail.com',subject:'[DICO] 자동 오류 제보 '+report.reportId,
      body:'DICO 중앙 관리 오류 제보입니다. 발신자와 내용은 검증되지 않은 진단 자료입니다.\n보고서 ID: '+report.reportId+
        '\n이벤트: '+report.events.length+'건 / 발송 시도: '+report.attempts.length+'건\n진단 자료는 JSON 첨부 파일에 있습니다.',attachments:[attachment]});
    entry[1]=receiptId;properties.setProperty(id,JSON.stringify(entry));
    return json(relayReceipt(report.reportId,entry));
  } catch (_) { return reject('DELIVERY_UNCERTAIN'); }
  finally { lock.releaseLock(); }
}
function relayReceipt(reportId,entry) { return {reportId:reportId,receiptId:entry[1],receivedAt:entry[0],delivery:'email'}; }
function relayBytes(text) { return Utilities.newBlob(text).getBytes().length; }
function relayHash(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8).map(b=>('0'+(b&255).toString(16)).slice(-2)).join('');
}
function relayReport(input,now) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(input) || input.format !== 'dico-support-report' || input.schemaVersion !== 1 ||
      typeof input.reportId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.reportId) ||
      !Number.isSafeInteger(input.createdAt) || input.createdAt < now-30*86400000 || input.createdAt > now+300000 ||
      !object(input.privacy) || typeof input.privacy.includeBodies !== 'boolean' || typeof input.privacy.includeNames !== 'boolean') throw Error('invalid');
  for (const k of ['runtime','selection','configuration']) if (!object(input[k])) throw Error('invalid');
  for (const k of ['attempts','commands','events','incidents','timeline']) if (!Array.isArray(input[k]) || input[k].some(v=>!object(v))) throw Error('invalid');
  for (const k of ['instances','accounts','targets','channels','groups']) if (!Array.isArray(input.configuration[k]) || input.configuration[k].some(v=>!object(v))) throw Error('invalid');
  // 알 수 없는 필드를 포함해 전체 트리를 먼저 제한한다. 문자열 길이와 UTF-8 크기는 별개다.
  let nodes=0;
  function validate(value,depth) {
    if (++nodes > 200000 || depth > 12) throw Error('invalid');
    if (typeof value === 'string' && value.length > 100000) throw Error('invalid');
    if (Array.isArray(value)) { if(value.length > 50000)throw Error('invalid');value.forEach(v=>validate(v,depth+1)); }
    else if (object(value)) Object.keys(value).forEach(k=>{
      if (k.length > 200 || ['__proto__','prototype','constructor'].indexOf(k)!==-1) throw Error('invalid');validate(value[k],depth+1);
    });
    else if(typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value)>Number.MAX_SAFE_INTEGER))throw Error('invalid');
  }
  validate(input,0);
  const fields = new Set(RELAY_FIELDS.split(/\s+/));
  const names = new Set('name username observedName accountName channelName groupName instanceName messageName'.split(' '));
  const secret = /(?:token|secret|password|authorization|cookie|session|bootstrap|permitId|draftBackup|credential|csrf)/i;
  function clean(value,section) {
    if (typeof value === 'string') return redactSupportText(value);
    if (Array.isArray(value)) return value.map(v=>clean(v,section));
    if (!object(value)) return value;
    const out={};Object.keys(value).sort().forEach(k=>{
      if (!fields.has(k) || secret.test(k) || !input.privacy.includeNames && names.has(k) || k==='body' && (section!=='attempts' || !input.privacy.includeBodies)) return;
      out[k]=clean(value[k],section);
    });return out;
  }
  const report={format:input.format,schemaVersion:1,reportId:input.reportId,createdAt:input.createdAt,
    privacy:{includeBodies:input.privacy.includeBodies,includeNames:input.privacy.includeNames,credentialsExcluded:true}};
  for (const k of ['runtime','selection','configuration','attempts','commands','events','incidents','timeline']) report[k]=clean(input[k],k);
  if(typeof input.userDescription==='string') {
    if(input.userDescription.length>4000)throw Error('invalid');report.userDescription=redactSupportText(input.userDescription);
  }
  if(relayBytes(JSON.stringify(report))>16*1024*1024)throw Error('invalid');
  return report;
}

// 런타임의 진단 필드와 추적 스칼라 목록. 계약 테스트로 정상 보고서 보존을 검증한다.
const RELAY_FIELDS = `accountEntityId accountId accountMatched accountName accountProofPending accountVerifiedAtSubmission accounts action active activeAttemptId actualVersion allowed alreadyRunning app appVersion appliedAt appliedVersion architecture at attemptId attemptRevision attemptStatus attemptedAt attempts authorMismatch authorUnknown authorizedRetryCount bindingId body bodyAvailable browser capabilities channelCount channelId channelName channels clockDiagnostic clockDifferenceMs code commandAppliedAt commandId commandReceivedAt commandType commands completed completedAt composerCleared composerEmpty composerRetained composing configVersion confirmationBasis confirmationMs confirmedAt connected connectedAt connectionProgress contentBuildId contentVersion contextFrom contextTo controlGeneration controlIntent controlRequestedAt controlVersion cooldownCalibratedAt cooldownCorrectionMs cooldownMs coreBuildId coreVersion correctedBaseIntervalMs correctionMs count createdAt credentialsExcluded cursor customExtraMs customIntervalMs cutoff data deliveryEvidence deliveryPhase description detail detectedAt disconnectedAt documentFocused documentHidden draftEmpty draftHasVoid draftLength draftLineCount draftMatchesA draftMatchesB driftMs durationMs earlyPrepare editorConnected editorCount editorFocused editorPresent editorReacquired editorReadMode editorReplaced effectiveIntervalMs elapsedMs elapsedSinceEnterMs emojiEquivalent emptyStableMs enabled end enterAttempted enterDefaultPrevented enterReadyAt entityId error eventAt eventId events evidence executionBlocked exitCode expectedDraftEmpty expectedDraftSubmitted expectedLength expectedLineCount expectedVersion extensionBuildId extensionReady extensionVersion failedSeen finalizedAt firstEnterAt freshnessMs from gapMs groupCount groupId groupName groupStatus groupVersion groups guildId hideNotificationNames id incidentId incidents includeBodies includeNames installedExtensionBuildId instanceId instanceName instances intervalMode intervalMs intervals key keyupDefaultPrevented lastConfirmationMs lastConfirmedAt lastConfirmedAttemptId lastConfirmedWall lastEnterAt lastHeartbeatAt lastSeenAt lastTraceSequence lastVerifiedAt latenessMs legacyFrozen legacyPending level lockedAt locks manual matchingMessage maxSendRetries maxWaitMs measuredFullCycleMs members message messageALength messageBLength messageCount messageId messageIdRef messageIndex messageName minimumIntervalMs monoDeltaMs monoElapsed monoGapMs monotonicDeltaMs monotonicElapsedMs name nameCustomized namePending newMessage nextEligibleAt nextPreparationAt nodeVersion notificationTypes notificationsEnabled notifyRecovery observedAt observedName observedPath observedRetryCount omittedCounts onboardingStep osRelease ownMessageSeen pageHidden partialRecords payload pending pendingIntervalSync pendingPlaylist pendingTabCloses permitIssued permittedAt phase platform playlist playlistIndex postedAt preEnterWaiting prepareDurationMs prepareRetryCount privacy protocolVersion pruned quietHours rawTextMatches read reason reasonCode receivedAt recoveryAction rejectedAt rejectionCode remainingMs removalId removedAttempts removedBindings renderedDraftLength resetEpoch resolutionReason resolvedAt retainedFrom retentionDays retries retryAfterMs retryAllowed retryCount retryDelayMs retryObservedAt retryRunId retryStartedAt revisionId revisionVersion runId runtime sameComposer sameEditor scheduledAt scope scopeChanged selection selectionCollapsed selectionInside selectionRanges sendRetryCount sendingActive sendingSeen sequence serverNow service settings signal slowmodeMs slowmodeObservedAt source stage start started startedAt state stateVersion status submitMethod targetId targetMatched targetMatches targets textMatches timeMismatch timeline to total traceWindowAt traceWindowCount trigger type unicodeEmojiCount unsupportedEditorContent updateDiagnostic updatedAt userDescription username verificationReason verified version versionMismatch waitReason waiting wallDeltaMs wallElapsed wallElapsedMs wallGapMs whitespaceOnlyDifference`;

/** 제보 자유 텍스트의 명시적인 인증정보 표기를 제거한다. 임의의 비밀 문자열 탐지를 보장하지 않는다. */
function redactSupportText(value){
 // 키 이름은 트리 검증의 200자 범위 안에서만 탐색해 긴 입력의 백트래킹을 제한한다.
 return value
  .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g,'[REDACTED PRIVATE KEY]')
  .replace(/\b(?:set-cookie|cookie)\s*:\s*[^\r\n]*/gi,'Cookie: [REDACTED]')
  .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.~-]+/gi,'[REDACTED AUTH]')
  .replace(/(^|[^\w-])((?:[\w-]{0,200}(?:token|secret|password|authorization|cookie|session|credential|csrf)[\w-]{0,200})["']?\s*[:=]\s*)(?:\[REDACTED(?: AUTH)?\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)/gi,'$1$2[REDACTED]')
  .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,'$1[REDACTED]@');
}
