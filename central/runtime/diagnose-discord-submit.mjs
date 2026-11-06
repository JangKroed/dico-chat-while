import {DatabaseSync} from 'node:sqlite';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {dataDirectory} from '../host/paths.mjs';

const expectedBrowsers=['Chrome','Brave'];
const thresholdMs=5000;
const minimumSamples=3;
const median=values=>{
 const sorted=values.toSorted((a,b)=>a-b),half=Math.floor(sorted.length/2);
 return sorted.length%2?sorted[half]:Math.round((sorted[half-1]+sorted[half])/2);
};

/**
 * 원문 식별자를 출력하지 않고, 동일 계정·채널·문구와 비슷한 대기 조건을 비교합니다.
 * 교차 표본이 없으면 브라우저/계정 원인을 단정하지 않습니다.
 */
export function compareSubmitTraces(state,events,{since=0}={}) {
 const browsers=new Map(state.instances.map(i=>[i.id,i.browser]));
 const traces=new Map();
 for(const event of events){
  const {attemptId,stage,data}=event;
  if(!['before-enter','slowmode-wait','network-start','network-result'].includes(stage))continue;
  let trace=traces.get(attemptId);
  if(!trace){trace={starts:0,successes:0};traces.set(attemptId,trace);}
  if(stage==='before-enter'&&data?.retryCount===0&&(!trace.enter||event.observedAt<trace.enter.observedAt))trace.enter=event;
  if(stage==='slowmode-wait'&&data?.cooldownMs>0)trace.visibleWait=true;
  if(stage==='network-start'){trace.starts++;trace.post=event;}
  if(stage==='network-result'&&data?.httpStatus>=200&&data.httpStatus<300){trace.successes++;trace.response=event;}
 }
 const previous=new Map(),arms=new Map(),matched=new Map();
 for(const a of state.attempts.filter(a=>a.status==='confirmed'&&Number.isFinite(a.finalizedAt)).toSorted((a,b)=>a.finalizedAt-b.finalizedAt)){
  const accountChannel=JSON.stringify([a.accountId,a.guildId,a.channelId]);
  const prior=previous.get(accountChannel);
  previous.set(accountChannel,a.finalizedAt);
  const browser=browsers.get(a.instanceId),trace=traces.get(a.id);
  if(a.finalizedAt<since||a.manual||!expectedBrowsers.includes(browser)||!trace?.enter||trace.starts!==1||trace.successes!==1)continue;
  const {enter,post}=trace, delay=post.observedAt-enter.observedAt;
  if(!Number.isFinite(delay)||delay<0||enter.data.networkObserverReady!==true||
    post.data?.networkOrdinal!==trace.response.data?.networkOrdinal||trace.response.observedAt<post.observedAt)continue;
  const arm=arms.get(browser)||{values:[],gateSamples:0,hiddenCooldown:0,visibleCooldown:0,editorRestricted:0,submitDisabled:0};
  arms.set(browser,arm);
  arm.values.push(delay);
  arm.gateSamples+=Number(typeof enter.data.hiddenCooldownIndicator==='boolean'&&typeof enter.data.editorAriaDisabled==='boolean');
  arm.hiddenCooldown+=Number(enter.data.hiddenCooldownIndicator===true);
  arm.visibleCooldown+=Number(trace.visibleWait===true||enter.data.slowmodeDetected===true);
  arm.editorRestricted+=Number(enter.data.editorAriaDisabled===true||enter.data.editorAriaReadonly===true);
  arm.submitDisabled+=Number(enter.data.submitControlDisabled===true);
  if(!prior||!a.accountId||!a.guildId||!a.channelId||!a.revisionId||typeof enter.data.pageHidden!=='boolean'||typeof enter.data.documentFocused!=='boolean')continue;
  const age=enter.observedAt-prior;
  if(age<0||age>300000||enter.data.cooldownKnown!==true||!Number.isFinite(enter.data.cooldownMs))continue;
  const condition=JSON.stringify([accountChannel,a.revisionId,Math.round(age/5000),enter.data.pageHidden,enter.data.documentFocused,enter.data.cooldownMs,enter.data.slowmodeDetected===true]);
  const strata=matched.get(condition)||{Chrome:[],Brave:[]};
  strata[browser].push(delay);
  matched.set(condition,strata);
 }
 const pairs=[];
 for(const v of matched.values()){
  if(expectedBrowsers.some(b=>v[b].length<minimumSamples))continue;
  const compared=Object.fromEntries(expectedBrowsers.map(b=>[b,{samples:v[b].length,medianMs:median(v[b]),delayed:v[b].filter(ms=>ms>=thresholdMs).length}]));
  const [chrome,brave]=expectedBrowsers.map(b=>compared[b]);
  const pattern=chrome.delayed===0&&brave.delayed===brave.samples?'brave_only':
    brave.delayed===0&&chrome.delayed===chrome.samples?'chrome_only':
    brave.delayed===brave.samples&&chrome.delayed===chrome.samples?'both':
    brave.delayed===0&&chrome.delayed===0?'neither':'mixed';
  pairs.push({...compared,pattern});
 }
 return {
  observations:Object.fromEntries([...arms].map(([browser,{values,...signals}])=>[browser,{samples:values.length,medianMs:median(values),delayed:values.filter(ms=>ms>=thresholdMs).length,...signals}])),
  comparison:pairs.length?'matched_samples_available':'needs_same_account_channel_samples',
  sameAccountChannelComparisons:pairs,
 };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const since=Date.now()-86400000;
 const db=new DatabaseSync(process.argv[2]||join(dataDirectory(),'central.sqlite'),{readOnly:true});
 try{
  db.exec('BEGIN');
  const state=JSON.parse(db.prepare('SELECT data FROM central_state WHERE singleton=1').get().data);
  const events=db.prepare("SELECT data FROM events WHERE at>=? AND type='delivery.trace' AND json_extract(data,'$.stage') IN ('before-enter','slowmode-wait','network-start','network-result')").iterate(since);
  console.log(JSON.stringify(compareSubmitTraces(state,(function*(){for(const row of events)yield JSON.parse(row.data);})(),{since}),null,2));
 }finally{db.close();}
}
