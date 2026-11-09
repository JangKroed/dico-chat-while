import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const descriptions={delivery_unknown:'게시 여부를 확인하지 못한 발송이 있습니다.',connection_lost:'실행 중인 브라우저 연결이 끊겼습니다.',account_mismatch:'로그인 계정을 다시 확인해야 합니다.',command_rejected:'실행 명령이 적용되지 않았습니다.',storage_failure:'상태를 저장하지 못해 새 발송을 차단했습니다.',permit_delay:'실행 가능한 발송의 허가가 지연되고 있습니다.'};
export function inQuietHours(q,date=new Date()) {
  if(!q?.enabled)return false;
  const minutes=s=>Number(s.split(':')[0])*60+Number(s.split(':')[1]);
  const current=date.getHours()*60+date.getMinutes(),start=minutes(q.start),end=minutes(q.end);
  return start===end || (start<end?current>=start&&current<end:current>=start||current<end);
}
export function createNotificationDispatcher({notify=notifyDesktop,load=async()=>undefined,save=async()=>{},now=Date.now}={}) {
  let ledger,queue=Promise.resolve(),lastStatus={status:'idle'};
  const run=fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
  return {
    process:snapshot=>run(async()=>{
      ledger??=await load() || {version:1,incidents:{},roots:{}};
      if(ledger.version!==1 || !ledger.incidents || !ledger.roots)throw Error('알림 이력 복구가 필요합니다.');
      const settings=snapshot.settings || {};
      if(!settings.notificationsEnabled || inQuietHours(settings.quietHours,new Date(now())))return;
      const incidents=[...(snapshot.incidents || [])];
      if(snapshot.service?.status==='storage_failure')incidents.push({id:'service-storage-failure',code:'storage_failure',status:'open'});
      for(const incident of incidents) {
        if(incident.status!=='open' || ledger.incidents[incident.id] || (Array.isArray(settings.notificationTypes) && !settings.notificationTypes.includes(incident.code)))continue;
        const root=[incident.code,incident.instanceId || incident.groupId || 'service'].join(':');
        const cooldown=Math.max(300000,settings.cooldownMs || 300000);
        if(ledger.roots[root]!==undefined && now()-ledger.roots[root]<cooldown)continue;
        // Record before OS dispatch: an unknown crash boundary is never blindly
        // replayed. The durable on-page incident remains visible either way.
        const next=structuredClone(ledger);next.incidents[incident.id]={at:now(),status:'requested'};next.roots[root]=now();
        await save(next);ledger=next;
        const packet={id:incident.id,title:'DICO · 확인할 문제',body:descriptions[incident.code] || '관리 화면에서 진행 상태를 확인하세요.',route:`/logs?incident=${encodeURIComponent(incident.id)}`};
        if(settings.hideNotificationNames===false) {
          const name=snapshot.groups?.find(g=>g.id===incident.groupId)?.name || snapshot.instances?.find(i=>i.id===incident.instanceId)?.name;
          if(name)packet.title=`DICO · ${String(name).replace(/[\r\n]/g,' ').slice(0,80)}`;
        }
        try{lastStatus=await notify(packet) || {status:'requested'};}catch{lastStatus={status:'failed'};}
      }
    }),
    update:(snapshot,update)=>run(async()=>{
      const settings=snapshot.settings||{};
      if(!settings.notificationsEnabled||inQuietHours(settings.quietHours,new Date(now()))||update?.state!=='available')return;
      const version=update.latestVersion;
      if(typeof version!=='string'||!/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version))return;
      ledger??=await load()||{version:1,incidents:{},roots:{}};
      if(ledger.version!==1||!ledger.incidents||!ledger.roots)throw Error('알림 이력 복구가 필요합니다.');
      if(ledger.updates?.[version])return;
      // 재시작 경계에서 같은 알림이 반복되지 않도록 OS 요청 전에 기록합니다.
      // OS에서 표시를 막더라도 관리 화면의 업데이트 배너는 별도로 유지됩니다.
      const next=structuredClone(ledger);next.updates??={};next.updates[version]={at:now(),status:'requested'};
      await save(next);ledger=next;
      try{lastStatus=await notify({id:'update:'+version,title:'DICO · 새 업데이트',body:`새 버전 ${version}이 준비되었습니다. 관리 화면의 설정에서 업데이트할 수 있습니다.`,route:'/settings'})||{status:'requested'};}
      catch{lastStatus={status:'failed'};}
    }),
    test:()=>run(async()=>{try{return lastStatus=await notify({id:'dico-test',title:'DICO 테스트 알림',body:'알림 연결을 시험했습니다. Discord 메시지는 보내지 않았습니다.',route:'/settings'}) || {status:'requested'};}catch{return lastStatus={status:'failed'};}}),
    status:()=>({...lastStatus}),
  };
}
export async function notifyDesktop({title,body},{platform=process.platform,execute=exec}={}) {
  const safe=s=>JSON.stringify(String(s).replace(/[\r\n]/g,' ').slice(0,240));
  if(platform==='darwin') {
    await execute('/usr/bin/osascript',['-e',`display notification ${safe(body)} with title ${safe(title)}`],{timeout:10000});
    return {status:'requested',method:'macos-notification',clickSupported:false};
  }
  if(platform==='win32') {
    // A system tray balloon needs no unverifiable AppUserModelID registration.
    // OS policy can suppress it; successful submission is not proof of display.
    const encode=s=>Buffer.from(String(s),'utf8').toString('base64');
    const script=`Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.Text='DICO'; $n.Visible=$true; $n.BalloonTipTitle=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(title)}')); $n.BalloonTipText=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(body)}')); $n.ShowBalloonTip(10000); $c=New-Object System.Windows.Forms.ApplicationContext; $t=New-Object System.Windows.Forms.Timer; $t.Interval=12000; $t.Add_Tick({$t.Stop();$n.Visible=$false;$n.Dispose();$c.ExitThread()}); $t.Start(); [System.Windows.Forms.Application]::Run($c)`;
    await execute('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:20000,windowsHide:true});
    return {status:'requested',method:'windows-tray-notification',clickSupported:false};
  }
  return {status:'unavailable',method:'unsupported-platform'};
}
