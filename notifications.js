// Compare persisted state, so worker restarts and unrelated saves do not re-alert.
export function newChannelErrors(previous, current) {
  if (!previous?.channels) return [];
  return (current?.channels || []).filter(channel => {
    const before = previous.channels.find(item => item.id === channel.id);
    return channel.error && (!before || before.error !== channel.error);
  });
}

export async function notifyChannelErrors(api, previous, current) {
  const errors = newChannelErrors(previous, current);
  if (!errors.length) return;
  const preferences = await api.storage.local.get('errorNotificationsEnabled');
  if (preferences.errorNotificationsEnabled === false) return;
  for (const channel of errors) {
    await createDiagnosticNotification(api, `dico-error:${channel.id}`, {
      type: 'basic', iconUrl: api.runtime.getURL('notification-icon.png'),
      title: `DICO · ${channel.name || '채널'} 오류`,
      message: String(channel.error).slice(0, 300),
    });
  }
}

// API acceptance and OS banner visibility are different. Persist only notification
// metadata (never announcement text), so a missing banner can be investigated.
export async function createDiagnosticNotification(api, id, options) {
  const diagnostic={at:new Date().toISOString(),version:api.runtime.getManifest().version,id,stage:'permission'};
  const save=()=>{ try { void api.storage.local.set({lastNotificationDiagnostic:{...diagnostic}}).catch(()=>{}); } catch {} };
  save();
  try {
    diagnostic.permission=await api.notifications.getPermissionLevel();
    if(diagnostic.permission!=='granted')throw new Error('운영체제 알림 설정에서 사용 중인 Chrome 또는 Brave의 알림을 허용하세요.');
    diagnostic.stage='create';save();
    await api.notifications.clear(id);
    diagnostic.returnedId=await api.notifications.create(id,options);
    diagnostic.stage='accepted';save();
    const active=await api.notifications.getAll();
    diagnostic.registered=Object.hasOwn(active,id);
    diagnostic.stage='checked';save();
    return diagnostic;
  } catch(error) {
    diagnostic.failedStage=diagnostic.stage;diagnostic.stage='failed';diagnostic.error=String(error.message);save();throw error;
  }
}
