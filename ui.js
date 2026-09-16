import { draftMatchesBase, normalizeRootState, selectExistingChannel, settingsBase } from "./ui-state.js";

const isPopup = document.body.dataset.page === "popup";
const elements = {
  notice: document.querySelector("#notice"),
  conflictCard: document.querySelector("#conflict-card"),
  conflictMessage: document.querySelector("#conflict-message"),
  reloadButton: document.querySelector("#reload-button"),
  runBadge: document.querySelector("#run-badge"),
  channelList: document.querySelector("#channel-list"),
  addChannelButton: document.querySelector("#add-channel-button"),
  removeChannelButton: document.querySelector("#remove-channel-button"),
  startAllButton: document.querySelector("#start-all-button"),
  stopAllButton: document.querySelector("#stop-all-button"),
  targetSummary: document.querySelector("#target-summary"),
  targetTabSelect: document.querySelector("#target-tab-select"),
  refreshTabsButton: document.querySelector("#refresh-tabs-button"),
  pendingCard: document.querySelector("#pending-card"),
  pendingSummary: document.querySelector("#pending-summary"),
  nextMessageChip: document.querySelector("#next-message-chip"),
  form: document.querySelector("#settings-form"),
  channelName: document.querySelector("#channel-name"),
  channelNameError: document.querySelector("#channel-name-error"),
  messageA: document.querySelector("#message-a"),
  messageB: document.querySelector("#message-b"),
  messageACount: document.querySelector("#message-a-count"),
  messageBCount: document.querySelector("#message-b-count"),
  messageAError: document.querySelector("#message-a-error"),
  messageBError: document.querySelector("#message-b-error"),
  interval: document.querySelector("#interval-seconds"),
  intervalError: document.querySelector("#interval-error"),
  ownUserId: document.querySelector("#own-user-id"),
  ownUserIdError: document.querySelector("#own-user-id-error"),
  saveButton: document.querySelector("#save-button"),
  bindButton: document.querySelector("#bind-button"),
  startButton: document.querySelector("#start-button"),
  stopButton: document.querySelector("#stop-button"),
  resolveSentButton: document.querySelector("#resolve-sent-button"),
  resolveNotSentButton: document.querySelector("#resolve-not-sent-button"),
  openOptionsButton: document.querySelector("#open-options-button"),
  scheduleLabel: document.querySelector("#schedule-label"),
  scheduleDetail: document.querySelector("#schedule-detail"),
  historyList: document.querySelector("#history-list"),
};

let rootState = normalizeRootState();
let selectedId = null;
let loadedBase = null;
let conflict = false;
let pendingSelectionId = null;
let busy = 0;
let localNotice = null;
let stateRequestSequence = 0;
let tabsRequestSequence = 0;
let refreshTimer = null;

function sendMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, response => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) reject(new Error(runtimeError.message));
      else resolve(response);
    });
  });
}

function selectedChannel() {
  return rootState.channels.find(channel => channel.id === selectedId) || null;
}

function getDraft() {
  return {
    name: elements.channelName.value,
    messages: [elements.messageA.value, elements.messageB.value],
    intervalText: elements.interval.value,
    ownUserId: elements.ownUserId.value,
  };
}

function isDirty() {
  return Boolean(loadedBase) && !draftMatchesBase(getDraft(), loadedBase);
}

function setFormValues(channel) {
  if (!channel) {
    elements.channelName.value = "";
    elements.messageA.value = "";
    elements.messageB.value = "";
    elements.interval.value = "300";
    elements.ownUserId.value = "";
    loadedBase = null;
    return;
  }
  elements.channelName.value = channel.name;
  elements.messageA.value = channel.messages[0];
  elements.messageB.value = channel.messages[1];
  elements.interval.value = String(channel.intervalSeconds);
  elements.ownUserId.value = channel.ownUserId;
  loadedBase = settingsBase(channel);
  conflict = false;
  pendingSelectionId = null;
}

function applyRootState(nextState, { forceDraft = false } = {}) {
  const next = normalizeRootState(nextState);
  if (next.revision < rootState.revision) return;
  const dirtyBefore = isDirty();
  const previousSelectedId = selectedId;
  rootState = next;

  if (!selectedId) selectedId = selectExistingChannel(rootState.channels, null);
  const incomingSelected = selectedChannel();

  if (!incomingSelected && previousSelectedId && dirtyBefore && !forceDraft) {
    conflict = true;
    render();
    return;
  }

  if (!incomingSelected) selectedId = selectExistingChannel(rootState.channels, selectedId);
  const channel = selectedChannel();
  if (forceDraft || !loadedBase || loadedBase.channelId !== selectedId || !dirtyBefore) {
    setFormValues(channel);
  } else if (channel && channel.settingsRevision !== loadedBase.settingsRevision) {
    conflict = true;
  }
  render();
}

function setNotice(message, tone = "info") {
  localNotice = message ? { message: String(message), tone } : null;
  renderNotice();
}

function renderNotice() {
  const channel = selectedChannel();
  const notice = channel?.error ? { message: channel.error, tone: "error" } : localNotice;
  elements.notice.hidden = !notice;
  elements.notice.textContent = notice?.message || "";
  elements.notice.dataset.tone = notice?.tone || "info";

  const selectionBlocked = Boolean(pendingSelectionId);
  elements.conflictCard.hidden = !conflict && !selectionBlocked;
  if (selectionBlocked) {
    elements.conflictMessage.textContent = "저장하지 않은 변경 내용이 있습니다. 저장하거나 변경 내용을 버린 뒤 다른 채널로 이동하세요.";
    elements.reloadButton.textContent = "변경 내용 버리고 채널 이동";
  } else if (conflict) {
    elements.conflictMessage.textContent = selectedChannel()
      ? "다른 화면에서 이 채널의 설정이 변경되었습니다. 현재 초안은 보존했습니다. 최신 설정을 불러오기 전에는 저장하거나 시작할 수 없습니다."
      : "편집하던 채널이 다른 화면에서 삭제되었습니다. 최신 상태를 불러오면 현재 초안은 사라집니다.";
    elements.reloadButton.textContent = "최신 설정 불러오기";
  }
}

function showFieldError(field, errorElement, message) {
  field.setAttribute("aria-invalid", message ? "true" : "false");
  errorElement.hidden = !message;
  errorElement.textContent = message;
}

function validateDraft({ showErrors = true } = {}) {
  const name = elements.channelName.value;
  const nameError = !name.trim() ? "설정 이름을 입력하세요." : name.length > 80 ? "설정 이름은 80자까지 입력할 수 있습니다." : "";
  const messageErrors = [elements.messageA.value, elements.messageB.value].map(value => {
    if (!value.trim()) return "공백이 아닌 내용을 1자 이상 입력하세요.";
    if (value.length > 2000) return "메시지는 2,000자까지 입력할 수 있습니다.";
    if (/@everyone|@here|<@&\d+>/i.test(value)) return "전체·역할 멘션(@everyone, @here, 역할 태그)은 사용할 수 없습니다.";
    return "";
  });
  const intervalText = elements.interval.value;
  const intervalNumber = Number(intervalText);
  const intervalError = !/^\d+$/.test(intervalText) || !Number.isInteger(intervalNumber)
    ? "간격은 정수로 입력하세요."
    : intervalNumber < 30 || intervalNumber > 86400
      ? "30초 이상 86,400초 이하로 입력하세요."
      : "";
  const ownUserId = elements.ownUserId.value.trim();
  const ownUserIdError = ownUserId && !/^\d{17,20}$/.test(ownUserId) ? "Discord 사용자 ID는 숫자 17~20자리로 입력하세요." : "";

  if (showErrors) {
    showFieldError(elements.channelName, elements.channelNameError, nameError);
    showFieldError(elements.messageA, elements.messageAError, messageErrors[0]);
    showFieldError(elements.messageB, elements.messageBError, messageErrors[1]);
    showFieldError(elements.interval, elements.intervalError, intervalError);
    showFieldError(elements.ownUserId, elements.ownUserIdError, ownUserIdError);
  }
  return { valid: !nameError && !messageErrors[0] && !messageErrors[1] && !intervalError && !ownUserIdError };
}

function getSettingsPayload() {
  return {
    name: elements.channelName.value.trim(),
    messages: [elements.messageA.value, elements.messageB.value],
    intervalSeconds: Number(elements.interval.value),
    ownUserId: elements.ownUserId.value.trim(),
  };
}

function formatDateTime(value) {
  if (!Number.isFinite(value)) return null;
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function formatHistoryTime(value) {
  if (!Number.isFinite(value)) return "시간 없음";
  return new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatRemaining(value) {
  if (!Number.isFinite(value)) return null;
  const seconds = Math.max(0, Math.ceil((value - Date.now()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours) return `${hours}시간 ${minutes}분 ${rest}초 후`;
  if (minutes) return `${minutes}분 ${rest}초 후`;
  return `${rest}초 후`;
}

function channelTone(channel) {
  if (channel.pending && !channel.enabled) return { label: "확인 필요", tone: "warning" };
  if (channel.enabled) return { label: "실행 중", tone: "active" };
  if (channel.error) return { label: "오류", tone: "error" };
  return { label: "중지", tone: "idle" };
}

function renderChannelList() {
  elements.channelList.replaceChildren();
  if (!rootState.channels.length) {
    const empty = document.createElement("p");
    empty.className = "channel-empty";
    empty.textContent = "등록된 채널이 없습니다. 채널을 추가해 주세요.";
    elements.channelList.append(empty);
    return;
  }

  for (const channel of rootState.channels) {
    const row = document.createElement("div");
    row.className = "channel-row";
    row.dataset.channelId = channel.id;
    row.dataset.selected = String(channel.id === selectedId);
    row.setAttribute("role", "listitem");

    const select = document.createElement("button");
    select.type = "button";
    select.className = "channel-select";
    select.dataset.action = "select";
    select.setAttribute("aria-pressed", String(channel.id === selectedId));
    const name = document.createElement("strong");
    name.textContent = channel.name;
    const detail = document.createElement("span");
    detail.textContent = channel.target?.title || "Discord 탭 미연결";
    select.append(name, detail);

    const status = channelTone(channel);
    const badge = document.createElement("span");
    badge.className = "status-dot-label";
    badge.dataset.tone = status.tone;
    badge.textContent = status.label;

    const action = document.createElement("button");
    action.type = "button";
    action.className = `button button-small ${channel.enabled ? "button-danger" : "button-secondary"}`;
    action.dataset.action = channel.enabled ? "stop" : "start";
    action.textContent = channel.enabled ? "중지" : "시작";
    action.disabled = channel.enabled
      ? false
      : Boolean(busy) || Boolean(channel.pending) || !channel.target ||
        (channel.id === selectedId && (isDirty() || conflict));
    row.append(select, badge, action);
    elements.channelList.append(row);
  }
}

function renderTarget() {
  const channel = selectedChannel();
  elements.targetSummary.replaceChildren();
  if (!channel?.target) {
    elements.targetSummary.classList.add("muted");
    elements.targetSummary.textContent = "연결된 Discord 채널이 없습니다.";
    return;
  }
  elements.targetSummary.classList.remove("muted");
  const title = document.createElement("strong");
  title.textContent = channel.target.title || channel.name;
  const detail = document.createElement("span");
  detail.textContent = channel.target.channelId ? `채널 ${channel.target.channelId}` : channel.target.url || `탭 ${channel.target.tabId}`;
  elements.targetSummary.append(title, detail);
}

function renderPending() {
  const channel = selectedChannel();
  const shouldShow = Boolean(channel?.pending) && !channel.enabled;
  elements.pendingCard.hidden = !shouldShow;
  elements.pendingSummary.textContent = shouldShow
    ? `메시지 ${channel.pending.index === 1 ? "B" : "A"}${formatDateTime(channel.pending.startedAt) ? ` · ${formatDateTime(channel.pending.startedAt)}` : ""}\n${String(channel.pending.text || "")}`
    : "";
}

function renderSchedule() {
  const channel = selectedChannel();
  if (!channel) {
    elements.scheduleLabel.textContent = "선택한 채널이 없습니다";
    elements.scheduleDetail.textContent = "채널을 추가해 주세요.";
  } else if (channel.pending && !channel.enabled) {
    elements.scheduleLabel.textContent = "전송 결과 확인 대기 중";
    elements.scheduleDetail.textContent = "확인 결과를 선택해야 다시 시작할 수 있어요.";
  } else if (channel.pending) {
    elements.scheduleLabel.textContent = `메시지 ${channel.pending.index === 1 ? "B" : "A"} 입력·전송 확인 중`;
    elements.scheduleDetail.textContent = "전송 확인 후 다음 타이머가 시작됩니다.";
  } else if (!channel.enabled) {
    elements.scheduleLabel.textContent = "일정이 중지되어 있습니다";
    elements.scheduleDetail.textContent = conflict ? "최신 설정을 먼저 불러오세요." : isDirty() ? "변경한 설정을 먼저 저장하세요." : "다음 차례를 유지한 채 시작할 수 있어요.";
  } else {
    elements.scheduleLabel.textContent = `${channel.slowmodeUntil ? "슬로우 모드 대기 · " : ""}다음 메시지 ${channel.nextIndex === 1 ? "B" : "A"}`;
    const remaining = formatRemaining(channel.nextRunAt);
    const exact = formatDateTime(channel.nextRunAt);
    elements.scheduleDetail.textContent = remaining && exact ? `${remaining} · ${exact}` : "다음 실행 시간을 계산하고 있어요.";
  }
}

const historyLabels = { info: "안내", success: "전송", sent: "전송", start: "시작", started: "시작", stop: "중지", stopped: "중지", error: "오류", bind: "채널", bound: "채널", save: "저장", saved: "저장", resolved: "확인" };

function renderHistory() {
  elements.historyList.replaceChildren();
  const history = selectedChannel()?.history.slice(0, 30) || [];
  if (!history.length) {
    const empty = document.createElement("li");
    empty.className = "history-empty";
    empty.textContent = "아직 기록이 없습니다.";
    elements.historyList.append(empty);
    return;
  }
  for (const entry of history) {
    const item = document.createElement("li");
    item.className = "history-item";
    const time = document.createElement("time");
    time.dateTime = Number.isFinite(entry?.at) ? new Date(entry.at).toISOString() : "";
    time.textContent = formatHistoryTime(entry?.at);
    const description = document.createElement("p");
    const kind = document.createElement("span");
    kind.className = "history-kind";
    kind.textContent = historyLabels[entry?.kind] || String(entry?.kind || "기록");
    description.append(kind, document.createTextNode(String(entry?.text || "")));
    item.append(time, description);
    elements.historyList.append(item);
  }
}

function renderControls() {
  const channel = selectedChannel();
  const dirty = isDirty();
  const validation = validateDraft({ showErrors: dirty });
  const editable = Boolean(channel) && !channel.enabled && !channel.pending;
  for (const field of [elements.channelName, elements.messageA, elements.messageB, elements.interval, elements.ownUserId]) {
    field.disabled = !editable || busy;
  }
  elements.saveButton.disabled = !editable || busy || conflict || !dirty || !validation.valid;
  elements.bindButton.disabled = !editable || Boolean(busy) || dirty || conflict || (!isPopup && !elements.targetTabSelect.value);
  elements.targetTabSelect.disabled = !editable || busy;
  elements.refreshTabsButton.disabled = busy;
  elements.removeChannelButton.disabled = busy || !channel || rootState.channels.length <= 1 || channel.enabled || Boolean(channel.pending);
  elements.addChannelButton.disabled = busy;
  elements.startButton.hidden = Boolean(channel?.enabled);
  elements.startButton.disabled = busy || !channel || Boolean(channel.enabled) || Boolean(channel.pending) || dirty || conflict || !validation.valid || !channel.target;
  elements.stopButton.hidden = !channel?.enabled;
  elements.stopButton.disabled = !channel?.enabled;
  const waitingForOtherAction = Boolean(busy) && Boolean(channel?.pending) && !channel.enabled;
  elements.resolveSentButton.textContent = waitingForOtherAction ? '다른 작업 완료 대기 중' : '전송됨';
  elements.resolveSentButton.disabled = busy;
  elements.resolveNotSentButton.disabled = busy;
  elements.startAllButton.disabled = busy || conflict || dirty || !rootState.channels.some(item => !item.enabled && !item.pending);
  elements.stopAllButton.disabled = !rootState.channels.some(item => item.enabled);
}

function render() {
  const runningCount = rootState.channels.filter(channel => channel.enabled).length;
  const pendingCount = rootState.channels.filter(channel => channel.pending && !channel.enabled).length;
  elements.runBadge.textContent = pendingCount ? `${pendingCount}개 확인 필요` : runningCount ? `${runningCount}개 실행 중` : "모두 중지";
  elements.runBadge.dataset.tone = pendingCount ? "warning" : runningCount ? "active" : "idle";
  elements.nextMessageChip.textContent = `다음 ${selectedChannel()?.nextIndex === 1 ? "B" : "A"}`;
  elements.messageACount.textContent = `${elements.messageA.value.length} / 2000`;
  elements.messageBCount.textContent = `${elements.messageB.value.length} / 2000`;
  renderNotice();
  renderChannelList();
  renderTarget();
  renderPending();
  renderSchedule();
  renderHistory();
  renderControls();
}

async function refreshState({ forceDraft = false } = {}) {
  const sequence = ++stateRequestSequence;
  try {
    const response = await sendMessage("DICO_GET");
    if (sequence !== stateRequestSequence) return;
    if (!response?.ok) throw new Error(response?.error || "상태를 불러오지 못했습니다.");
    applyRootState(response.state, { forceDraft });
  } catch (error) {
    if (sequence === stateRequestSequence) setNotice(error.message || "상태를 불러오지 못했습니다.", "error");
  }
}

async function performAction(type, payload = {}, successMessage = "요청을 처리했습니다.", { forceDraft = false } = {}) {
  busy += 1;
  localNotice = null;
  ++stateRequestSequence;
  render();
  try {
    const response = await sendMessage(type, payload);
    if (response?.state) applyRootState(response.state, { forceDraft: forceDraft && response.ok });
    if (!response?.ok) throw new Error(response?.error || "요청을 처리하지 못했습니다.");
    setNotice(successMessage, "success");
    return response;
  } catch (error) {
    setNotice(error.message || "요청을 처리하지 못했습니다.", "error");
    return null;
  } finally {
    busy = Math.max(0, busy - 1);
    render();
  }
}

async function refreshTabs() {
  const sequence = ++tabsRequestSequence;
  elements.refreshTabsButton.disabled = true;
  try {
    const response = await sendMessage("DICO_TABS");
    if (sequence !== tabsRequestSequence) return;
    if (!response?.ok) throw new Error(response?.error || "Discord 탭 목록을 불러오지 못했습니다.");
    const selectedValue = elements.targetTabSelect.value;
    elements.targetTabSelect.replaceChildren(new Option("열린 Discord 채널 탭 선택", ""));
    for (const tab of Array.isArray(response.tabs) ? response.tabs : []) {
      elements.targetTabSelect.append(new Option(tab.title || tab.url || `탭 ${tab.id}`, String(tab.id)));
    }
    if ([...elements.targetTabSelect.options].some(option => option.value === selectedValue)) elements.targetTabSelect.value = selectedValue;
  } catch (error) {
    setNotice(error.message || "Discord 탭 목록을 불러오지 못했습니다.", "error");
  } finally {
    elements.refreshTabsButton.disabled = false;
    renderControls();
  }
}

function chooseChannel(channelId) {
  if (channelId === selectedId) return;
  if (isDirty() || conflict) {
    pendingSelectionId = channelId;
    renderNotice();
    return;
  }
  selectedId = channelId;
  setFormValues(selectedChannel());
  localNotice = null;
  render();
}

for (const input of [elements.channelName, elements.messageA, elements.messageB, elements.interval, elements.ownUserId]) {
  input.addEventListener("input", () => {
    localNotice = null;
    render();
  });
}

elements.form.addEventListener("submit", async event => {
  event.preventDefault();
  if (conflict) return setNotice("최신 설정을 불러온 뒤 다시 저장하세요.", "error");
  if (!validateDraft().valid) return setNotice("입력한 설정을 확인해 주세요.", "error");
  await performAction("DICO_SAVE", {
    channelId: selectedId,
    settings: getSettingsPayload(),
    expectedRevision: loadedBase?.settingsRevision,
  }, "이 채널의 설정을 저장했습니다.", { forceDraft: true });
});

elements.channelList.addEventListener("click", async event => {
  const button = event.target.closest("button[data-action]");
  const row = button?.closest("[data-channel-id]");
  if (!button || !row) return;
  const channelId = row.dataset.channelId;
  if (button.dataset.action === "select") return chooseChannel(channelId);
  const type = button.dataset.action === "start" ? "DICO_START" : "DICO_STOP";
  await performAction(type, { channelId }, button.dataset.action === "start" ? "채널 일정을 시작했습니다." : "채널 일정을 중지했습니다.");
});

elements.addChannelButton.addEventListener("click", async () => {
  if (isDirty() || conflict) {
    setNotice("현재 채널의 변경 내용을 저장하거나 최신 설정을 불러온 뒤 채널을 추가하세요.", "error");
    return;
  }
  const before = new Set(rootState.channels.map(channel => channel.id));
  const response = await performAction("DICO_ADD", {}, "빈 채널 설정을 추가했습니다.");
  if (!response) return;
  const added = rootState.channels.find(channel => !before.has(channel.id));
  if (added) {
    selectedId = added.id;
    setFormValues(added);
    render();
  }
});

elements.removeChannelButton.addEventListener("click", async () => {
  const channel = selectedChannel();
  if (!channel) return;
  if (isDirty()) {
    setNotice("삭제하기 전에 변경 내용을 저장하거나 최신 설정을 다시 불러오세요.", "error");
    return;
  }
  if (!window.confirm(`‘${channel.name}’ 설정을 삭제할까요?`)) return;
  const removedId = channel.id;
  const response = await performAction("DICO_REMOVE", { channelId: removedId }, "채널 설정을 삭제했습니다.");
  if (response && selectedId === removedId) {
    selectedId = selectExistingChannel(rootState.channels, null);
    setFormValues(selectedChannel());
    render();
  }
});

elements.reloadButton.addEventListener("click", () => {
  if (pendingSelectionId && rootState.channels.some(channel => channel.id === pendingSelectionId)) selectedId = pendingSelectionId;
  else selectedId = selectExistingChannel(rootState.channels, selectedId);
  setFormValues(selectedChannel());
  localNotice = null;
  render();
});

elements.bindButton.addEventListener("click", async () => {
  if (conflict || isDirty()) return setNotice("입력 중인 설정을 먼저 저장하거나 최신 설정을 불러오세요.", "error");
  const value = elements.targetTabSelect.value;
  if (!isPopup && !value) return setNotice("연결할 Discord 탭을 선택하세요.", "error");
  const payload = { channelId: selectedId };
  if (value) payload.tabId = Number(value);
  await performAction("DICO_BIND", payload, "선택한 설정에 Discord 채널을 연결했습니다.");
});

elements.refreshTabsButton.addEventListener("click", refreshTabs);
elements.targetTabSelect.addEventListener("change", renderControls);
elements.startButton.addEventListener("click", async () => {
  if (conflict) return setNotice("최신 설정을 불러온 뒤 시작하세요.", "error");
  if (isDirty()) return setNotice("변경한 설정을 저장한 뒤 시작하세요.", "error");
  await performAction("DICO_START", { channelId: selectedId }, "다음 메시지를 바로 전송했고, 선택한 채널의 반복 일정을 시작했습니다.");
});
elements.stopButton.addEventListener("click", () => performAction("DICO_STOP", { channelId: selectedId }, "선택한 채널의 일정을 중지했습니다."));
elements.startAllButton.addEventListener("click", () => performAction("DICO_START_ALL", {}, "시작할 수 있는 모든 채널에 시작을 요청했습니다."));
elements.stopAllButton.addEventListener("click", () => performAction("DICO_STOP_ALL", {}, "실행 중인 모든 채널을 중지했습니다."));
elements.resolveSentButton.addEventListener("click", () => performAction("DICO_RESOLVE", { channelId: selectedId, resolution: "sent" }, "전송된 것으로 기록했습니다."));
elements.resolveNotSentButton.addEventListener("click", () => performAction("DICO_RESOLVE", { channelId: selectedId, resolution: "not-sent" }, "전송되지 않은 것으로 기록했습니다."));
elements.openOptionsButton?.addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener(changes => {
  window.clearTimeout(refreshTimer);
  if (changes.state?.newValue?.channels) {
    ++stateRequestSequence;
    applyRootState(changes.state.newValue);
    return;
  }
  refreshTimer = window.setTimeout(() => refreshState(), 80);
});

window.setInterval(() => {
  if (rootState.channels.some(channel => channel.enabled)) renderSchedule();
}, 1000);

await Promise.all([refreshState({ forceDraft: true }), refreshTabs()]);
