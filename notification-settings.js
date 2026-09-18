const toggle = document.querySelector('#error-notifications-enabled');
const status = document.querySelector('#notification-status');
const testButton = document.querySelector('#test-notification');
let feedbackRevision = 0;
// Browser APIs can resolve without an OS banner. Report acceptance, not visibility.
function withNotificationTimeout(request) {
  let timer;
  return Promise.race([request,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('8초 동안 브라우저가 응답하지 않았습니다. 확장 프로그램을 새로고침한 뒤 다시 시도하세요.')),8000);})]).finally(()=>clearTimeout(timer));
}
async function refresh() {
  const revision=feedbackRevision;
  try {
    const preferences = await chrome.storage.local.get('errorNotificationsEnabled');
    toggle.checked = preferences.errorNotificationsEnabled !== false;
    const permission = await chrome.notifications.getPermissionLevel();
    if(revision!==feedbackRevision)return;
    status.textContent = permission === 'granted'
      ? '오류 발생 시 이 기기에 알립니다. 알림을 누르면 사용 가이드가 열립니다.'
      : '브라우저 알림이 차단되어 있습니다. 아래 알림 사용 안내에서 Chrome 또는 Brave 알림 설정을 확인하세요.';
  } catch (error) { if(revision===feedbackRevision)status.textContent = `알림 설정을 확인하지 못했습니다: ${error.message}`; }
}
toggle.addEventListener('change', async () => {
  toggle.disabled = true;
  try { await chrome.storage.local.set({errorNotificationsEnabled: toggle.checked}); }
  catch (error) { toggle.checked = !toggle.checked; status.textContent = `저장 실패: ${error.message}`; }
  finally { toggle.disabled = false; }
});
testButton.addEventListener('click', async () => {
  feedbackRevision++;
  testButton.disabled = true;
  status.textContent = '테스트 알림을 요청하는 중입니다…';
  try {
    if (await withNotificationTimeout(chrome.notifications.getPermissionLevel()) !== 'granted') throw new Error('운영체제 알림 설정에서 사용 중인 Chrome 또는 Brave의 알림을 허용하세요.');
    // Remove the previous test notification so a repeat click creates a new one.
    await withNotificationTimeout(chrome.notifications.clear('dico-error:test'));
    await withNotificationTimeout(chrome.notifications.create('dico-error:test', {
      type: 'basic', iconUrl: chrome.runtime.getURL('notification-icon.png'),
      title: 'DICO · 테스트 알림', message: '오류 알림 테스트입니다. 이 알림을 누르면 사용 가이드가 열립니다.',
    }));
    status.textContent = '브라우저가 테스트 알림 요청을 받았습니다. 화면에 보이지 않으면 알림 센터, Chrome/Brave 알림 허용, 집중 모드·방해금지 설정을 확인하세요. Discord 채팅으로 보내는 알림은 아닙니다.';
  } catch (error) { status.textContent = `알림 실패: ${error.message}`; }
  finally { testButton.disabled = false; }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.errorNotificationsEnabled) void refresh();
});
void refresh();
