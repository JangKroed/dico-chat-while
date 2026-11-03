// Central-manager relay. Deploy as owner; recipient cannot be supplied by clients.
// REPORT_KEY is a submission-only key, never a Gmail password or OAuth token.
function doPost(e) {
  const json = value => ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return json({ok:false,code:'BUSY'});
  try {
    if (!e || !e.postData || e.postData.contents.length > 17*1024*1024) return json({ok:false,code:'INVALID'});
    const data = JSON.parse(e.postData.contents), properties = PropertiesService.getScriptProperties();
    const key = properties.getProperty('REPORT_KEY');
    if (!key || key.length < 24 || data.key !== key) return json({ok:false,code:'UNAUTHORIZED'});
    const report = data.report;
    if (!report || report.format !== 'dico-support-report' || report.schemaVersion !== 1 ||
        !/^[a-f0-9-]{36}$/.test(report.reportId) || !report.privacy ||
        !Array.isArray(report.events) || !Array.isArray(report.attempts)) return json({ok:false,code:'INVALID'});
    const now = Date.now(), id = 'RECEIPT_' + report.reportId;
    const previous = JSON.parse(properties.getProperty(id) || 'null');
    if (previous) return json(previous.sent ? previous.receipt : {ok:false,code:'DELIVERY_UNCERTAIN'});
    // Retain receipts longer than the client's default 30-day report retention.
    const all = properties.getProperties();
    Object.keys(all).filter(k=>k.indexOf('RECEIPT_')===0).forEach(k=>{
      const entry=JSON.parse(all[k]);if(entry.at < now-90*86400000)properties.deleteProperty(k);
    });
    const day = new Date(now).toISOString().slice(0,10);
    let budget = JSON.parse(properties.getProperty('REPORT_BUDGET') || '{}');
    if (budget.day !== day) budget = {day:day,count:0};
    if (budget.count >= 20 || MailApp.getRemainingDailyQuota() < 1) return json({ok:false,code:'QUOTA'});
    const attachment = Utilities.newBlob(JSON.stringify(report,null,2),'application/json','dico-support-'+report.reportId+'.json');
    const receipt = {reportId:report.reportId,receiptId:Utilities.getUuid(),receivedAt:now,delivery:'email'};
    budget.count++;
    properties.setProperty('REPORT_BUDGET',JSON.stringify(budget));
    // An ambiguous provider failure must not cause duplicate mail on each retry.
    properties.setProperty(id,JSON.stringify({at:now,sent:false}));
    MailApp.sendEmail({to:'didlsdydgh@gmail.com',subject:'[DICO] 자동 오류 제보 '+report.reportId,
      body:'DICO 중앙 관리 자동 오류 제보입니다.\n보고서 ID: '+report.reportId+
        '\n이벤트: '+report.events.length+'건 / 발송 시도: '+report.attempts.length+'건\n진단 원본은 JSON 첨부 파일에 있습니다.',
      attachments:[attachment]});
    properties.setProperty(id,JSON.stringify({at:now,sent:true,receipt:receipt}));
    return json(receipt);
  } catch (_) { return json({ok:false,code:'DELIVERY_UNCERTAIN'}); }
  finally { lock.releaseLock(); }
}
