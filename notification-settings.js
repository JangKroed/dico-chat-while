const toggle = document.querySelector('#error-notifications-enabled');
const status = document.querySelector('#notification-status');
const testButton = document.querySelector('#test-notification');
async function refresh() {
  try {
    const preferences = await chrome.storage.local.get('errorNotificationsEnabled');
    toggle.checked = preferences.errorNotificationsEnabled !== false;
    const permission = await chrome.notifications.getPermissionLevel();
    status.textContent = permission === 'granted'
      ? '오류 발생 시 이 기기에 알립니다. 알림을 누르면 사용 가이드가 열립니다.'
      : 'Chrome 알림이 차단되어 있습니다. 운영체제의 알림 설정에서 Chrome을 허용하세요.';
  } catch (error) { status.textContent = `알림 설정을 확인하지 못했습니다: ${error.message}`; }
}
toggle.addEventListener('change', async () => {
  toggle.disabled = true;
  try { await chrome.storage.local.set({errorNotificationsEnabled: toggle.checked}); }
  catch (error) { toggle.checked = !toggle.checked; status.textContent = `저장 실패: ${error.message}`; }
  finally { toggle.disabled = false; }
});
testButton.addEventListener('click', async () => {
  testButton.disabled = true;
  try {
    if (await chrome.notifications.getPermissionLevel() !== 'granted') throw new Error('운영체제 알림 설정에서 Chrome 알림을 허용하세요.');
    await chrome.notifications.create('dico-error:test', {
      type: 'basic', iconUrl: chrome.runtime.getURL('notification-icon.png'),
      title: 'DICO · 테스트 알림', message: '오류 알림 테스트입니다. 이 알림을 누르면 사용 가이드가 열립니다.',
    });
    status.textContent = '테스트 알림을 요청했습니다. 보이지 않으면 Chrome 알림 허용 및 방해금지 모드를 확인하세요.';
  } catch (error) { status.textContent = `알림 실패: ${error.message}`; }
  finally { testButton.disabled = false; }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.errorNotificationsEnabled) void refresh();
});
void refresh();
