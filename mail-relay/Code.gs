// Set REPORT_KEY in Project Settings > Script Properties before deploying.
// Recipient is fixed: clients cannot choose who receives email.
function doPost(e) {
  const json = value => ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return json({ok:false});
  try {
    if (!e.postData || e.postData.contents.length > 100000) return json({ok:false});
    const data = JSON.parse(e.postData.contents);
    const properties = PropertiesService.getScriptProperties();
    const key = properties.getProperty('REPORT_KEY');
    if (!key || key.length < 32 || data.key !== key) return json({ok:false});
    const report = data.report;
    if (!report || !/^[a-f0-9-]{36}$/.test(report.id) || !Array.isArray(report.events) || report.events.length > 100) return json({ok:false});
    const day = new Date().toISOString().slice(0,10);
    let budget = JSON.parse(properties.getProperty('REPORT_BUDGET') || '{}');
    if (budget.day !== day) budget = {day:day,count:0,ids:[]};
    if (budget.ids.indexOf(report.id) !== -1) return json({ok:false});
    if (budget.count >= 20 || MailApp.getRemainingDailyQuota() < 1) return json({ok:false});
    // Reserve before send to avoid duplicate delivery after an ambiguous failure.
    budget.count++; budget.ids.push(report.id);
    properties.setProperty('REPORT_BUDGET',JSON.stringify(budget));
    MailApp.sendEmail('didlsdydgh@gmail.com','[DICO] 오류 진단 로그',JSON.stringify(report,null,2));
    return json({ok:true});
  } catch (_) { return json({ok:false}); }
  finally { lock.releaseLock(); }
}
