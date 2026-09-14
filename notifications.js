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
    await api.notifications.create(`dico-error:${channel.id}`, {
      type: 'basic', iconUrl: api.runtime.getURL('notification-icon.png'),
      title: `DICO · ${channel.name || '채널'} 오류`,
      message: String(channel.error).slice(0, 300),
    });
  }
}
