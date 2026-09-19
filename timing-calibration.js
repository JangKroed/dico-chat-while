// Measurements use durations from a monotonic clock. Discord snowflake times
// are retained as evidence, never subtracted from the PC clock as network RTT.
export function receiptMeasurement(receipt, now) {
  const sample=receipt?.timing;
  if (!sample || !Number.isFinite(sample.confirmationMs) || sample.confirmationMs<0 || sample.confirmationMs>30000 ||
      !Number.isFinite(sample.enterAt) || !Number.isFinite(sample.confirmedAt) ||
      Math.abs(sample.confirmedAt-sample.enterAt-sample.confirmationMs)>1000 ||
      Math.abs(now-sample.confirmedAt)>10000) return null;
  return {enterAt:sample.enterAt,confirmedAt:sample.confirmedAt,confirmationMs:sample.confirmationMs,
    serverCreatedAt:/^\d{17,20}$/.test(receipt.messageId || '') ? Number((BigInt(receipt.messageId)>>22n)+1420070400000n) : null,
    cooldownMs:Number.isFinite(sample.cooldownMs)?Math.max(0,Math.min(21600000,sample.cooldownMs)):0};
}

export function cooldownMeasurement(sample, slowmodeSeconds) {
  if (!sample || !['observed','inconclusive'].includes(sample.status)) return null;
  const fields=['elapsedMs','maxGapMs','enterAt','observedAt'];
  if(fields.some(key=>!Number.isFinite(sample[key]) || sample[key]<0))return null;
  if(sample.elapsedMs>21720000 || sample.maxGapMs>21720000)return null;
  // A tab asleep for seconds can only report a late observation, not an unlock
  // time. Keep it visible in diagnostics but do not turn it into a new minimum.
  const reliable=sample.status==='observed' && sample.maxGapMs<=2000 &&
    Math.abs(sample.observedAt-sample.enterAt-sample.elapsedMs)<=1000;
  const seconds=Number.isInteger(slowmodeSeconds)&&slowmodeSeconds>0?slowmodeSeconds:null;
  return {status:reliable?'observed':'inconclusive',...Object.fromEntries(fields.map(key=>[key,sample[key]])),
    extraSeconds:reliable&&seconds!==null?Math.max(0,Math.ceil(sample.elapsedMs/1000)-seconds):null};
}
