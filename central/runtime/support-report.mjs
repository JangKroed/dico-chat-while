import {supportRecordBuffer} from '../core/support-budget.js';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {release} from 'node:os';
import {traceData} from '../extension/delivery-trace.js';
export const SUPPORT_REPORT_MAX_BYTES=16*1024*1024;
const fail=(message,status=400)=>Object.assign(Error(message),{status,code:'SUPPORT_REPORT_INVALID'});
const NAME_FIELDS=new Set(['name','username','observedName','accountName','channelName','groupName','instanceName','messageName']);
const FIELDS=new Set(`updateDiagnostic exitCode signal omittedCounts timeline id eventId stateVersion type level at createdAt updatedAt finalizedAt permittedAt attemptedAt confirmedAt postedAt receivedAt appliedAt rejectedAt completedAt observedAt lastSeenAt lastVerifiedAt startedAt resolvedAt lastConfirmedAt lastConfirmedWall lastConfirmedAttemptId accountId accountEntityId guildId channelId targetId bindingId instanceId groupId attemptId commandId runId revisionId revisionVersion messageId messageIdRef messageName name username observedName accountName channelName groupName instanceName body bodyAvailable status state version configVersion appliedVersion groupVersion intervalMs intervalMode customIntervalMs minimumIntervalMs correctedBaseIntervalMs effectiveIntervalMs customExtraMs cooldownCorrectionMs slowmodeMs slowmodeObservedAt cooldownCalibratedAt lastConfirmationMs confirmationMs prepareDurationMs confirmationBasis connected verified verificationReason capabilities browser extensionVersion extensionBuildId freshnessMs activeAttemptId controlIntent controlVersion controlRequestedAt executionBlocked permitIssued maxSendRetries retryCount sendRetryCount retryObservedAt authorizedRetryCount retryRunId preEnterWaiting earlyPrepare reasonCode waitReason nextEligibleAt nextPreparationAt members cursor playlist playlistIndex pendingPlaylist pendingIntervalSync messageCount channelCount groupCount manual pruned detail error message description code rejectionCode commandType action source reason count key read nameCustomized namePending targetId lockedAt service settings instances accounts targets channels groups attempts commands events incidents intervals locks payload deliveryEvidence evidence clockDiagnostic wallElapsedMs monotonicElapsedMs wallGapMs monoGapMs gapMs clockDifferenceMs wallDeltaMs monoDeltaMs wallElapsed monoElapsed observedAt detectedAt elapsedMs total completed stage phase enterAttempted composerRetained composerCleared composerEmpty editorPresent expectedDraftSubmitted sameEditor targetMatched accountMatched emptyStableMs newMessage matchingMessage sendingSeen failedSeen authorMismatch authorUnknown timeMismatch enterDefaultPrevented keyupDefaultPrevented documentHidden documentFocused submitMethod retries correctionMs measuredFullCycleMs retentionDays notificationsEnabled notificationTypes hideNotificationNames onboardingStep cooldownMs notifyRecovery quietHours enabled start end scope targetId from to contextFrom contextTo resolutionReason retainedFrom serverNow platform osRelease architecture nodeVersion appVersion coreBuildId installedExtensionBuildId selection attemptId includeBodies includeNames credentialsExcluded privacy app runtime data sequence sameComposer editorReacquired sendingActive ownMessageSeen contentVersion protocolVersion connectedAt disconnectedAt lastHeartbeatAt commandReceivedAt commandAppliedAt retryDelayMs retryStartedAt observedRetryCount attemptStatus groupStatus active phase durationMs incidentId partialRecords coreVersion extensionReady versionMismatch expectedVersion actualVersion recoveryAction userDescription monotonicDeltaMs driftMs trigger connectionProgress legacyFrozen legacyPending controlGeneration prepareRetryCount retryAfterMs waiting pending cutoff removedAttempts removedBindings pendingTabCloses entityId removalId resetEpoch started alreadyRunning lastTraceSequence traceWindowAt traceWindowCount enterReadyAt firstEnterAt lastEnterAt attemptRevision expectedDraftEmpty elapsedSinceEnterMs retryAllowed`.split(/\s+/));
const SECRET=/(?:token|secret|password|authorization|cookie|session|bootstrap|permitId|draftBackup|credential|csrf)/i;
const RECORD_LIMIT=50000,NODE_LIMIT=200000,STRING_LIMIT=100000;
const TEXT_FIELDS=new Set('id type status reasonCode waitReason reason code rejectionCode confirmationBasis phase stage submitMethod scope name username observedName accountName channelName groupName instanceName messageName body message description resolutionReason'.split(' '));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
// Validate before stringifying or traversing imported data, including unknown keys.
// No imported prototypes, accessors, cycles, or unbounded nesting are accepted.
function validateTree(input){
  const stack=[{value:input,depth:0}],seen=new Set();let count=0;
  while(stack.length){
    const {value,depth}=stack.pop();if(++count>NODE_LIMIT)throw fail('보고서 항목이 너무 많습니다.',413);
    if(depth>12)throw fail('보고서 구조가 너무 깊습니다.');
    if(value===null||typeof value==='boolean')continue;
    if(typeof value==='string'){if(value.length>STRING_LIMIT)throw fail('보고서 문자열이 너무 깁니다.');continue;}
    if(typeof value==='number'){if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)throw fail('보고서 숫자 범위를 확인하세요.');continue;}
    if(typeof value!=='object'||seen.has(value))throw fail('보고서 JSON 값을 확인하세요.');
    seen.add(value);
    if(Array.isArray(value)){if(value.length>RECORD_LIMIT)throw fail('보고서 목록이 너무 큽니다.',413);for(const item of value)stack.push({value:item,depth:depth+1});continue;}
    if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw fail('보고서 객체 형식을 확인하세요.');
    for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))){
      if(['__proto__','prototype','constructor'].includes(key)||key.length>200||!('value' in descriptor))throw fail('보고서에 허용되지 않는 속성이 있습니다.');
      if(FIELDS.has(key)&&(TEXT_FIELDS.has(key)||key!=='eventId'&&key.endsWith('Id'))&&descriptor.value!==null&&typeof descriptor.value!=='string')throw fail(`보고서 ${key} 텍스트·식별자 값을 확인하세요.`);
      stack.push({value:descriptor.value,depth:depth+1});
    }
  }
}
function sanitize(value,{includeBodies=true,includeNames=true}={},depth=0,parentKey=''){
  if(depth>12)throw fail('보고서 구조가 너무 깊습니다.');
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(typeof value==='string'){if(value.length>STRING_LIMIT)throw fail('보고서 문자열이 너무 깁니다.');return value;}
  if(Array.isArray(value)){if(value.length>RECORD_LIMIT)throw fail('보고서 항목이 너무 많습니다. 기간을 줄여 주세요.',413);return value.map(item=>sanitize(item,{includeBodies,includeNames},depth+1));}
  if(object(value)){
    const result={};for(const [key,item] of Object.entries(value)){
      if(!FIELDS.has(key)||SECRET.test(key)||!includeBodies&&key==='body'||!includeNames&&NAME_FIELDS.has(key))continue;
      if(key==='data'){result.data=traceData(item);continue;}
      // Trace payloads carry a fixed set of observation scalars, never arbitrary objects.
      if(parentKey==='data'&&item!==null&&!['string','number','boolean'].includes(typeof item))continue;
      const clean=sanitize(item,{includeBodies,includeNames},depth+1,key);if(clean!==undefined)result[key]=clean;
    }return result;
  }
}
const recordList=(value,label)=>{if(!Array.isArray(value)||value.length>RECORD_LIMIT||value.some(item=>!object(item)))throw fail(`보고서 ${label} 목록 형식을 확인하세요.`);};
const summary=report=>({attempts:report.attempts.length,events:report.events.length,unknown:report.attempts.filter(a=>a.status==='unknown').length,blockedGroups:report.configuration.groups.filter(g=>g.activeAttemptId||g.controlIntent||['needs_review','stop_pending','pause_pending'].includes(g.status)).length});
function checksFor(report){
  const checks=[];
  if(report.selection.partialRecords&&report.selection.omittedCounts)checks.push({code:'REPORT_COMPACTED',severity:'warning',message:'전송 크기를 맞추기 위해 일부 과거 기록을 제외했습니다. 범위의 omittedCounts에 제외 건수가 표시됩니다. 원본 로그는 그대로 보존됩니다.'});
  for(const a of report.attempts){if(a.status==='unknown')checks.push({code:'DELIVERY_UNKNOWN',severity:'warning',attemptId:a.id,message:'게시 여부가 확정되지 않았습니다. 실제 Discord 게시 내역과 실행 차단 여부를 확인하세요.'});if(a.bodyAvailable===false)checks.push({code:'BODY_UNAVAILABLE',severity:'info',attemptId:a.id,message:'이 시도의 당시 본문은 보관 기간 정리 또는 이전 형식으로 인해 남아 있지 않습니다.'});}
  for(const g of report.configuration.groups){if(g.waitReason||g.controlIntent)checks.push({code:'GROUP_BLOCKING_STATE',severity:'info',groupId:g.id,message:`현재 그룹 상태: ${g.status||'unknown'}, 대기 사유: ${g.waitReason||g.controlIntent||'없음'}`});}
  for(const i of report.configuration.instances){if(!i.connected||i.freshnessMs>15000)checks.push({code:'BROWSER_STALE',severity:'warning',instanceId:i.id,message:'브라우저 연결 또는 최근 응답을 확인하세요.'});if(report.runtime.installedExtensionBuildId&&i.extensionBuildId&&report.runtime.installedExtensionBuildId!==i.extensionBuildId)checks.push({code:'EXTENSION_BUILD_MISMATCH',severity:'warning',instanceId:i.id,message:'중앙 프로그램에 포함된 확장과 브라우저가 보고한 확장의 빌드가 다릅니다.'});}
  for(const c of report.configuration.channels){if(c.verified===false||c.appliedVersion!==c.configVersion)checks.push({code:c.verified===false?'CHANNEL_UNVERIFIED':'CONFIG_PENDING',severity:'warning',instanceId:c.instanceId,message:`채널 ${c.channelId||c.id}: ${c.verificationReason||'최신 설정 적용 여부'}를 확인하세요.`});}
  if(report.configuration.service?.clockDiagnostic)checks.push({code:'CLOCK_CONTINUITY',severity:'warning',message:'절전·시계 변경으로 인한 실행 중단 진단이 있습니다. 시간 진단과 관련 이벤트를 함께 확인하세요.'});
  for(const a of report.attempts){
    if(a.status==='confirmed'&&a.confirmationBasis==='composer_cleared')checks.push({code:'COMPOSER_COMPLETION_ONLY',severity:'info',attemptId:a.id,message:'이 시도는 검증된 입력창 비워짐으로 발송 처리를 완료했습니다. 게시 메시지 자체를 관찰한 증거와 구분하세요.'});
    if(a.status==='unknown'&&a.executionBlocked!==true)checks.push({code:'EXECUTION_NOT_BLOCKED',severity:'warning',attemptId:a.id,message:'이전 시도의 실행 차단 응답이 없습니다. 재시도 전 실행 중지·재확인 기록을 확인하세요.'});
    if(a.deliveryEvidence?.failedSeen===true)checks.push({code:'DISCORD_FAILURE_OBSERVED',severity:'warning',attemptId:a.id,message:'Discord 전송 실패 표시가 관찰됐습니다. 재시도 횟수와 마지막 입력창 상태를 확인하세요.'});
  }
  for(const i of report.configuration.instances){if(report.runtime.appVersion&&i.extensionVersion&&report.runtime.appVersion!==i.extensionVersion)checks.push({code:'EXTENSION_VERSION_MISMATCH',severity:'warning',instanceId:i.id,message:'관리 프로그램과 브라우저 확장의 버전이 다릅니다. 업데이트 적용·브라우저 재연결 기록을 확인하세요.'});}
  if(report.selection.retainedFrom&&report.selection.from<report.selection.retainedFrom)checks.push({code:'RETENTION_PARTIAL',severity:'info',message:'조회 기간 일부가 보관 기간 밖입니다. 정리된 기록은 이 파일로 복원하거나 확인할 수 없습니다.'});
  return checks;
}
function bounded(report){if(Buffer.byteLength(JSON.stringify(report))>SUPPORT_REPORT_MAX_BYTES)throw fail('보고서가 16MiB를 초과합니다. 조회 기간을 줄이거나 특정 발송 시도만 선택하세요.',413);return report;}
export async function createSupportReport({manager,appVersion,updateDiagnostic,attemptId,from=0,to=Date.now(),includeBodies=true,includeNames=true,now=Date.now}={}){
  if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<from||typeof includeBodies!=='boolean'||typeof includeNames!=='boolean'||attemptId!==undefined&&(typeof attemptId!=='string'||attemptId.length>100))throw fail('보고서 조회 조건을 확인하세요.');
  const data=manager.supportData({attemptId,from,to}),privacy={includeBodies,includeNames,credentialsExcluded:true};
  const omittedCounts={events:data.omittedEvents||0};
  const activeIds=new Set(data.groups.map(group=>group.activeAttemptId).filter(Boolean));
  const priority=record=>activeIds.has(record.id)?2:['unknown','preparing','permitted'].includes(record.status)?1:0;
  const prioritized=records=>[...records.filter(record=>priority(record)===0),...records.filter(record=>priority(record)===1),...records.filter(record=>priority(record)===2)];
  const take=(records,key)=>{
    if(key==='events'){
      const important=supportRecordBuffer({maxBytes:512*1024}),traces=supportRecordBuffer({maxBytes:512*1024});
      for(const record of records)(record.type==='delivery.trace'?traces:important).add(record);
      omittedCounts[key]=(omittedCounts[key]||0)+important.omitted+traces.omitted;
      return [...important.values(),...traces.values()].sort((a,b)=>a.at-b.at||a.eventId-b.eventId);
    }
    const buffer=supportRecordBuffer();for(const record of key==='attempts'?prioritized(records):records)buffer.add(record);
    omittedCounts[key]=(omittedCounts[key]||0)+buffer.omitted;
    const kept=new Set(buffer.values());return records.filter(record=>kept.has(record));
  };
  // Bound generated data before sanitization; imported reports remain strictly validated.
  const selected={...data};
  for(const key of ['attempts','commands','events','incidents','intervals'])selected[key]=take(data[key],key==='intervals'?'timeline':key);
  const runtime={appVersion:appVersion||'unknown',platform:process.platform,osRelease:release(),architecture:process.arch,nodeVersion:process.version};
  if(updateDiagnostic)runtime.updateDiagnostic=sanitize(updateDiagnostic,{includeBodies:false,includeNames:false});
  try{runtime.coreBuildId=createHash('sha256').update(await readFile(new URL('../core/index.js',import.meta.url))).digest('hex');}catch{}
  try{runtime.installedExtensionBuildId=(await readFile(new URL('../extension/build-info.js',import.meta.url),'utf8')).match(/[a-f0-9]{64}/)?.[0];}catch{}
  const configuration=sanitize({service:data.service,settings:data.settings,instances:data.instances.map(i=>({...i,freshnessMs:Number.isFinite(i.lastSeenAt)?Math.max(0,data.serverNow-i.lastSeenAt):null})),accounts:data.accounts,targets:data.targets,channels:data.channels,groups:data.groups,locks:data.locks},{...privacy,includeBodies:false});
  const report={format:'dico-support-report',schemaVersion:1,reportId:randomUUID(),createdAt:now(),runtime,selection:{...(attemptId?{attemptId}:{}),from,to,...(data.contextFrom!==undefined?{contextFrom:data.contextFrom,contextTo:data.contextTo}:{}),retainedFrom:data.retainedFrom},privacy,configuration,attempts:sanitize(selected.attempts,privacy),commands:sanitize(selected.commands,{...privacy,includeBodies:false}),events:sanitize(selected.events,{...privacy,includeBodies:false}).sort((a,b)=>a.at-b.at||a.eventId-b.eventId),incidents:sanitize(selected.incidents,{...privacy,includeBodies:false}),timeline:sanitize(selected.intervals,{...privacy,includeBodies:false})};
  // Leave ample room for email attachment formatting and object traversal limits.
  for(;;){
    report.selection.omittedCounts=Object.fromEntries(Object.entries(omittedCounts).filter(([,count])=>count>0));
    if(Object.keys(report.selection.omittedCounts).length)report.selection.partialRecords=true;
    else delete report.selection.omittedCounts;
    report.summary=summary(report);report.checks=checksFor(report);
    let fits=Buffer.byteLength(JSON.stringify(report))<4*1024*1024;
    if(fits){try{validateTree(JSON.parse(JSON.stringify(report)));}catch(error){if(error.status!==413)throw error;fits=false;}}
    if(fits)return report;
    const key=['events','commands','timeline','attempts','incidents'].filter(key=>report[key].length>1).sort((a,b)=>Buffer.byteLength(JSON.stringify(report[b]))-Buffer.byteLength(JSON.stringify(report[a])))[0];
    if(!key)throw fail('환경 설정만으로 제보 크기를 초과합니다. 관리자에게 제보 수집 오류를 알려 주세요.',413);
    const remove=Math.ceil(report[key].length/2);
    const victims=new Set((key==='attempts'?prioritized(report[key]):report[key]).slice(0,remove));
    report[key]=report[key].filter(record=>!victims.has(record));omittedCounts[key]=(omittedCounts[key]||0)+remove;
  }
}
export function inspectSupportReport(input){
  validateTree(input);bounded(input);
  if(!object(input)||input.format!=='dico-support-report'||input.schemaVersion!==1||typeof input.reportId!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(input.reportId)||!Number.isSafeInteger(input.createdAt)||input.createdAt<0)throw fail('지원하지 않는 관리자 보고서 형식입니다.');
  for(const key of ['attempts','commands','events','incidents','timeline'])recordList(input[key],key);
  if(!object(input.configuration)||!object(input.runtime)||!object(input.selection)||!object(input.privacy))throw fail('보고서 환경·설정 형식을 확인하세요.');
  for(const key of ['instances','accounts','targets','channels','groups'])recordList(input.configuration[key],key);
  for(const key of ['service','settings'])if(input.configuration[key]!==undefined&&!object(input.configuration[key]))throw fail('보고서 설정 객체 형식을 확인하세요.');
  if(input.configuration.locks!==undefined)recordList(input.configuration.locks,'locks');
  for(const a of input.attempts)if(typeof a.id!=='string'||a.id.length>100||!a.id||!['preparing','permitted','unknown','confirmed','not_sent','cancelled'].includes(a.status)||a.body!==undefined&&typeof a.body!=='string'||a.bodyAvailable!==undefined&&typeof a.bodyAvailable!=='boolean'||a.deliveryEvidence!==undefined&&!object(a.deliveryEvidence))throw fail('보고서 발송 시도 형식을 확인하세요.');
  for(const key of ['appVersion','platform','osRelease','architecture','nodeVersion','coreBuildId','installedExtensionBuildId'])if(input.runtime[key]!==undefined&&typeof input.runtime[key]!=='string')throw fail('보고서 실행 환경 값을 확인하세요.');
  for(const key of ['includeBodies','includeNames'])if(typeof input.privacy[key]!=='boolean')throw fail('보고서 개인정보 포함 옵션을 확인하세요.');
  for(const e of input.events){if(typeof e.type!=='string'||!Number.isFinite(e.at)||e.eventId!==undefined&&!Number.isSafeInteger(e.eventId)||e.data!==undefined&&!object(e.data))throw fail('보고서 이벤트 형식을 확인하세요.');}
  if(input.userDescription!==undefined&&(typeof input.userDescription!=='string'||input.userDescription.length>4000))throw fail('문제 설명은 4000자 이내로 입력하세요.');
  const privacy={includeBodies:input.privacy.includeBodies,includeNames:input.privacy.includeNames,credentialsExcluded:true},metadata={...privacy,includeBodies:false};
  const report={format:'dico-support-report',schemaVersion:1,reportId:input.reportId,createdAt:input.createdAt,runtime:sanitize(input.runtime,metadata),selection:sanitize(input.selection,metadata),privacy,configuration:sanitize(input.configuration,metadata),attempts:sanitize(input.attempts,privacy),commands:sanitize(input.commands,metadata),events:sanitize(input.events,metadata).sort((a,b)=>a.at-b.at||(a.eventId||0)-(b.eventId||0)),incidents:sanitize(input.incidents,metadata),timeline:sanitize(input.timeline,metadata)};
  if(input.userDescription!==undefined)report.userDescription=input.userDescription;
  report.configuration.service??={};report.summary=summary(report);report.checks=checksFor(report);
  return bounded({report,summary:report.summary,findings:[{code:'IMPORTED_REPORT_UNVERIFIED',severity:'info',message:'가져온 파일의 기록을 분석한 결과입니다. 실제 실행 환경이나 게시 여부를 별도로 검증한 것은 아닙니다.'},...report.checks]});
}
