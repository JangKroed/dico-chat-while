const element = document.querySelector('#recovery-status');
const prefix = 'loadingRecoveryStatus:';
const values = await chrome.storage.local.get(null);
function render() {
  const active = Object.entries(values).filter(([key, value]) => key.startsWith(prefix) && value).map(([, value]) => value);
  element.hidden = active.length === 0;
  element.textContent = active.length ? `로딩 자동 복구 중 · ${active.length}개 채널 (${active.map(value => `${value.attempt}/10회`).join(', ')}). 각 전송용 탭을 새로고침하고 있습니다. 중지 버튼으로 취소할 수 있습니다.` : '';
}
render();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [key, change] of Object.entries(changes)) if (key.startsWith(prefix)) values[key] = change.newValue;
  render();
});
