# Central domain API

The runtime imports `createCentralManager` from `index.js`. It requires Node 24.13.0 with built-in `node:sqlite`; there are no third-party runtime dependencies. This first implementation uses JavaScript ESM, matching the existing repository, rather than introducing an unverified TypeScript build chain.

```js
const manager = createCentralManager({ databasePath, now: Date.now, monotonicNow: () => performance.now() });
manager.execute('message.create', { name: 'Notice', body: 'Hello' });
const unsubscribe = manager.subscribe(event => publish(event));
manager.tick(); // runtime calls regularly (well below 15 seconds)
manager.close();
```

All methods are synchronous. `CentralError` has `code`, `message`, and HTTP-like `status`. Mutations either commit their state and events together or roll back; callbacks run only after a successful commit. A storage failure blocks later mutations until the manager is reopened. The runtime owns single-process discovery, authentication, HTTP/SSE, Native Messaging, notifications, and timer lifecycle.

## Persistence and safety

The database path must live in a dedicated application data directory. The core sets that directory to `0700`, creates/chmods the database to `0600` before enabling WAL, and sets existing/new WAL and SHM sidecars to `0600` on POSIX. SQLite stores the versioned domain aggregate and a separate indexed event outbox in one `BEGIN IMMEDIATE` transaction, using WAL and synchronous FULL. A compare-and-swap aggregate version detects accidental concurrent writers. This avoids a second dependency and keeps entity invariants atomic. Aggregate serialization costs grow with retained state; high-volume production workloads need profiling before promising large-log throughput. Retention removes old finalized detail, while immutable replay tombstones, active attempts, unresolved incidents, and unapplied commands survive.

Existing corrupt or newer-schema databases fail closed: the core throws and does not initialize a replacement database. The surrounding runtime must present recovery guidance. Schema 1 currently has no upgrade migration. Future migrations must add an explicit backup and transactional migration path.

A restart disconnects observations, invalidates execution sessions, supersedes queued transport messages, and preserves all unresolved attempts as unknown. No attempt is automatically retried. Groups require an explicit start/resume; the service returns to ready automatically. Group and account delays use monotonic deadlines, with conservative full waits after resume. Clock discontinuity or an event-loop gap over 15 seconds blocks new permits.

A group owns both its logical Discord channel and each account/channel resource. A prepared attempt is not authorization to press Enter. Only the durable `COMMIT_PERMIT` command grants that authority. A stop receipt or control applied ACK does not establish that an issued permit was unsent. Fresh submitted attempts may finish with `confirmationBasis:composer_cleared` when the same verified composer is observed empty immediately after submission, under the submitted-composer criterion. Failure observations remain diagnostic and do not override a verified empty submitted composer. This advances the scheduler without a Discord message ID. `message_observed` keeps the observed message-ID contract. Composer clearance is recorded separately from observed posting; historical unknown attempts cannot be resolved from an empty composer alone. Manual unsent resolution requires prior executor evidence that the old attempt cannot still execute.

## Public methods

| Method | Result |
| --- | --- |
| `execute(action, payload)` | Updated entity or action result; actions below |
| `snapshot()` | Safe UI state, latest 200 attempts/commands, latest 100 events, analytics |
| `bridge(message, instanceId)` | Native executor response; HELLO establishes an instance/session |
| `commands(instanceId, {pendingOnly=true})` | Current-session native command envelopes; no mutation on retrieval |
| `tick()` | Advances eligible groups, detects disconnects/clock gaps, runs retention |
| `events({after,limit,from,to,type,groupId,instanceId,attemptId,level})` | Ascending durable event IDs, at most 1,000 rows |
| `analytics({from,to,groupId,instanceId,accountId,channelId})` | Unique-attempt outcomes, confirmation buckets/timings, wait and connection intervals |
| `exportBackup()` / `importBackup(backup)` | Configuration-only backup / stopped, unverified restore |
| `subscribe(listener)` | Returns unsubscribe callback; events publish after commit |
| `close()` | Closes SQLite and subscribers; does not claim pending attempts were unsent |

Snapshot removes session IDs, permit IDs, and attempt/command bodies. The message library intentionally contains the user's authored content. Native command payloads include the exact immutable body required for execution; never send native envelopes to unauthenticated UI clients. Events contain allowlisted structured fields, not raw native payloads, credentials, or message text.

## Actions

Existing editable entities require `expectedVersion`; control actions use current domain gates rather than blindly overwriting configuration.

| Action | Payload |
| --- | --- |
| `message.create` | `{name,body,tags?}` |
| `message.update` | `{id,expectedVersion,name?,body?,tags?}` |
| `message.archive` | `{id,expectedVersion,archived?}` |
| `message.delete` | `{id,expectedVersion}`; rejects referenced content |
| `message.duplicate` | `{id,name?}` |
| `instance.update` | `{id,expectedVersion,name}` |
| `instance.delete` / `account.delete` / `target.delete` / `channel.delete` | `{id,expectedVersion}`; removes the selected scope, retains history, queues exact managed-tab closure |
| `target.update` | `{id,expectedVersion,name}`; preserves the explicit channel alias |
| `channel.update` | `{id,expectedVersion,name?,intervalMs?}` |
| `channel.applyPlaylist` | `{id,expectedVersion,items:[{messageId,revisionId?}]}`; 1–50 items |
| `group.create` | `{name,members:[bindingId],intervalMs?}` |
| `group.update` | `{id,expectedVersion,name?,members?,intervalMs?}`; stopped/paused only |
| `group.delete` | `{id,expectedVersion}`; stopped only |
| `group.start/resume/pause/stop` | `{id}` |
| `service.stopAll/resume` | `{}` |
| `attempt.resolve` | `{id,outcome:'confirmed',messageId}` or `{id,outcome:'not_sent'}` |
| `attempt.retryNotSent` | `{id,confirmation:'CONFIRM_NOT_SENT'}` — explicitly confirm non-delivery and continue the current group/account |
| `incident.read` | `{id,read?}`; does not resolve the incident |
| `settings.update` | Notification booleans/types, cooldownMs, quietHours, retentionDays, onboardingStep |
| `maintenance.prune` | `{}`; preserves unsafe and deduplication state |
| `backup.import` | `{backup}` |
| `legacy.import` | `{backup,sourceId?}` for `dico-settings` version 1 |

Legacy import uses independent message IDs, preserves A/B position, and never imports keys or active execution state. A matching observed account/guild/channel can bind an unverified placeholder after the executor reports the legacy freeze gate. A separate extension's execution cannot be proven stopped by this core; the runtime/extension must distinguish the user's migration declaration from automatically verified evidence. Empty legacy drafts are not converted into invented text. When the old file has no account/channel binding, its nonempty messages remain available for manual channel assignment.

## Native protocol 1

Commands have `{id,type,instanceId,sessionId,status,createdAt,payload}`. Delivery can repeat; the executor must durably deduplicate both commands and attempts.

- `HELLO`: `{protocolVersion:1,instanceId?,name?,browser?,extensionVersion?}` returns `{instanceId,sessionId,protocolVersion,commands}`. Each HELLO fences the preceding session.
- `OBSERVATION`: `{sessionId,legacyFrozen:true,legacyPending:false,channels:[{accountId,guildId,channelId,name?,tabId,verified,slowmodeMs?}]}`. Each observed binding needs its own dedicated tab.
- `HEARTBEAT`: `{sessionId,knownAttemptIds?:string[]}` returns current commands and requested same-instance `terminalAttempts:[{attemptId,status,messageId?}]`. Reconcile terminal local records without performing Enter.
- `ACK`: `{sessionId,commandId,status:'received'|'applied'|'rejected',executionBlocked?,attemptId?}`. Applied configuration and control state are distinct from receipt. A blocked preparing attempt may become cancelled; an issued permit still needs a result.
- `PREPARED`: `{sessionId,attemptId,accountId,channelId,configVersion,draftClear:true}`. A successful response is not itself the transport command: consume the queued `COMMIT_PERMIT`.
- `AUTHORIZE_ENTER`: `{sessionId,attemptId,runId,configVersion}` returns `{allowed:boolean}`. The executor must request this immediately before Enter and treat any error or false response as denial. Only a current permitted attempt in the same running group/session/run/config and verified execution tab is eligible. The check independently detects clock/sleep gaps; a gap queues run-bound pause controls, supersedes pending execution transport, and retains issued permits as unknown until resolved. This does not claim that an Enter already dispatched can be recalled.
- `DELIVERY_RESULT`: `{sessionId,attemptId,outcome:'confirmed'|'not_sent'|'unknown',messageId?,confirmationBasis?:'composer_cleared'|'message_observed',deliveryEvidence?,executionBlocked?,confirmationMs?}`.
- `DISCONNECT` and `EMERGENCY_STOP`: `{sessionId}`.

`CONFIG_SYNC` payload contains binding, account/guild/channel/tab, `configVersion`, `intervalMs`, and `items:[{messageId,revisionId,name,body}]`. `PREPARE` includes the same target identifiers plus `attemptId`, `groupId`, `body`, and `revisionId`. `COMMIT_PERMIT` adds `permitId`. `RECONCILE` refers to the original attempt and never authorizes Enter. `CONTROL` contains `{action:'stop'|'pause',groupId,runId,controlGeneration,attemptId}`. Each explicit start/resume creates a fresh `runId`; attempts and all attempt command payloads retain it. The executor must preserve stopped-run tombstones so delayed commands from a stopped run cannot clear its execution gate.

## Bulk controls and configuration reset

- `service.startAll {}` starts all non-running groups in one durable transaction. Existing running groups retain their run and active attempt. A stopped service may be resumed by this explicit action. Any failed eligibility/resource/control/attempt check rolls back the entire request. Returns `{started,alreadyRunning}`; an empty group list is rejected.
- `settings.reset {confirmation:'RESET_ALL_SETTINGS',expectedConfiguration}` requires all groups fully stopped with no control intent and no preparing/permitted/unknown attempts. Compare `expectedConfiguration` to `snapshot().configurationToken`, a digest of user configuration entity identities/versions and preferences; idle ticks do not invalidate it. Removes messages/channels/groups/instances/import dedup references, restores preference defaults, readies the service and supersedes outstanding commands. A durable reset epoch fences previous executor registrations, including disconnected browsers and in-flight observations. Extensions clear saved account/channel/configuration state on the next HELLO. Keeps historical terminal attempts, events, command history and duplicate protection. Old executor sessions are rejected. No Discord/OS/profile deletion occurs.

- `attempt.resolveMany {ids,outcome:'not_sent',confirmation:'CONFIRM_NOT_SENT'}` requires 1–200 unique explicit IDs, all still unknown with executor blocking evidence, and resolves them atomically as manually checked not-sent. A changed/ineligible entry rejects the whole request.
- CONTROL attempt references belong only to the target executor; other group members receive null. Unknown attempts without any issued permit can be finalized not-sent after the owning executor acknowledges execution blocked. An issued permit always preserves uncertainty until actual reconciliation/manual confirmation.
- Rejected ACKs may carry a bounded uppercase `rejectionCode`. Valid codes are included in command events and attempt reason codes; raw errors and message bodies are not copied into diagnostic events.

## Independent identity and destination catalog (0.4.1)

Snapshots expose `accounts` (internal id, instanceId, Discord accountId, name, version, verified/connected, lastVerifiedAt) and `targets` (id, guildId, channelId, canonical URL, name, version) separately from per-account execution channel bindings. Existing bindings derive catalog records on load without losing saved messages or groups.

- Bridge `ACCOUNT_OBSERVATION {accountId,verified,legacyFrozen?,legacyPending?}` registers or revokes current identity without requiring a server channel. Session fencing and independent 15-second identity freshness apply; switching identities cannot take over old bindings.
- `account.update {id,expectedVersion,name}` changes a local alias.
- `target.create {url,name?}` stores one logical server channel independently of account registration. URLs are canonical Discord numeric server/channel paths.
- `channel.connect {accountId:<internal account entity id>,targetId}` requires a current verified identity and `open-channel-v1` executor capability when opening a new binding. Queues an idempotent `OPEN_CHANNEL` command; it never creates a send attempt or starts a group. Verified observations complete the request. Queued/received/applied-unverified opens are superseded on session change/revocation.
- Backup version1 adds optional safe account/target arrays. Unbound targets and account aliases roundtrip; restored identity remains unverified. Old backups derive the catalogs from bindings. Reset clears both catalogs.
- Rejection incidents include validated command type, attempt routing and reason code. Terminal attempt resolution clears related non-control incidents; CONTROL incidents require actual full control acknowledgment to clear. Reading an incident never resolves it.

### incident.recheck({id?})

열린 알림 전체 또는 특정 id 하나의 현재 해결 근거를 다시 검사한다. 반환은 `{resolved, remaining, blocked:[{id,reasonCode,message,page}]}`이고 remaining은 검사 대상 안의 미해결 개수다. 터미널 발송 결과, 안전하게 삭제된 그룹의 지난 요청, 현재 세대의 전체 CONTROL 적용 응답만 해결 근거로 사용한다. 결과·그룹·명령을 강제로 변경하지 않는다. 해결 기록의 resolutionReason은 terminal_attempt/obsolete_group/control_applied이며 읽음과 구분한다.

### 로컬 업데이트 API

GET `/api/updates`는 인증된 UI 세션에 `{phase,message,startedAt?,updatedAt?,version?}`를 반환한다. POST `/api/updates` `{}`는 Origin·CSRF를 검사하고 격리 준비를 시작하여 202와 같은 상태 객체를 반환한다. 사설 POST `/api/bridge/update/apply`는 네이티브 Bearer와 현재 작업의 jobToken, 준비 상태와 최신 실행 유휴 상태를 검증한다. 브라우저가 다운로드 URL·명령·설치 경로를 지정할 수 없다.

네이티브 전용 EXTENSION_STATUS는 설치된 확장의 실제 해시와 중앙의 reloadSafe를 반환한다. 브라우저 메시지에 자격증명·로컬 경로를 노출하지 않는다. 동일 빌드에는 reload가 필요하지 않으며 다른 폴더로 로드된 확장의 재시작 루프를 제한한다.

### 계정·채널 주기 (0.4.3)

Channel DTO: `intervalMode: auto|custom`, `minimumIntervalMs`, 실제 `intervalMs`, 선택 `customIntervalMs`, `pendingIntervalSync`. 자동 주기는 마지막 관측 슬로우 모드+3000ms이다. 관측 없음은 0초 확인과 다르며 UI에서 감지 대기로 표시한다.

`channel.update`의 `intervalMode: auto`는 자동으로 전환한다. custom은 `intervalMs`를 입력하며 현재 minimumIntervalMs 미만이면 서버가 거부한다. 오래된 클라이언트가 intervalMs만 보내면 직접 설정 의도로 처리한다. 느려진 제한에 따라 실제 주기를 올려도 원래 customIntervalMs는 보존한다. 진행·미확인 시도가 있으면 구성 동기화를 결과 확정 이후로 미룬다.

`incident.recheck`는 OPEN_CHANNEL 명령의 전체 라우팅 ID와 현재 verified 세션, 최신 heartbeat, 마지막 거절 이후 관측 증거를 확인하면 `connection_reverified`로 과거 알림을 해결한다. 연결 복구를 발송 결과 확정으로 사용하지 않는다.


### Retry after user-confirmed non-delivery (0.4.10)

`attempt.retryNotSent` accepts only the latest unknown or not-sent attempt of an unchanged group/run/cursor with `executionBlocked:true`. It records manual non-delivery and starts a fresh run of that group without advancing its account or playlist cursor. Other groups remain stopped. Eligibility or readiness failures roll back the outcome, locks and service state together. A duplicate request returns `already_started` while the same retry run is still current; a stale click cannot restart a newer or explicitly stopped run.

The result is `{status:'started'|'already_started',attemptId,groupId,runId}` or `{status:'waiting',reasonCode:'CONTROL_PENDING',attemptId,groupId}`. Waiting records the non-delivery outcome but does **not** schedule a restart. After outstanding stop acknowledgements arrive, a fresh explicit request may continue the same latest not-sent attempt.

The executor reports unknown-result blocking proof only after a final commit observation response has returned with `enterAttempted:true`. This revokes future execution without claiming the earlier Enter did not post. Before a retry PREPARE, authenticated HEARTBEAT terminal reconciliation durably updates prior nonterminal local records; session and stop checks run again after this asynchronous boundary.

### Bounded same-attempt retries (0.4.12)

`settings.update {maxSendRetries}` accepts nonnegative safe integers or null (unlimited), default null. Each PREPARE snapshots this value on the attempt and carries it through COMMIT_PERMIT; changing settings does not expand an in-flight attempt's budget.

The executor sends `DELIVERY_WAIT {retryPhase:true,retryCount,cooldownMs,elapsedMs,attemptId,runId,configVersion}` for same-attempt retry progress. The count stays unchanged for cooldown heartbeats and advances one step for a subsequent retry; it cannot skip, rewind, or exceed the snapshotted budget. `AUTHORIZE_ENTER` includes that count and remains idempotent for repeated current-count preflight checks. Session, group/run, config, service, stop and live channel gates still apply.

Retry progress keeps the current attempt alive without advancing either cursor. Only confirmed posting starts the next group's spacing and advances the account/playlist. A retained-draft retry uses a continuous message-observation baseline so a late post or sending indicator stops further retries. Final evidence includes the retry count and optional bounded key-event/page-state diagnostics; none proves delivery by itself.


### Post-send cooldown calibration (0.4.13)

Authenticated `COOLDOWN_SAMPLE {attemptId,runId,configVersion,sample}` carries bounded scalar durations from the confirmed attempt's content clock. Central calibration accepts fresh positive samples `{status:'remaining',elapsedMs,remainingMs,maxGapMs,slowmodeMs}` within 17 seconds after confirmation. The legacy final-unlock `observed` probe may still run in content, but is not used to alter the central schedule. No client wall-clock timestamp is used as network latency. The latest confirmed binding/configuration/session owns the sample; stale or ambiguous observations are ignored.

Channel DTOs expose nominal `minimumIntervalMs`, `correctedBaseIntervalMs`, `cooldownCorrectionMs`, `customExtraMs`, `effectiveIntervalMs`, and optional `cooldownCalibratedAt`. User excess is measured above the nominal floor, then added to the corrected base. Calibration updates schedule metadata without emitting CONFIG_SYNC or changing the account cursor. The estimated Enter anchor avoids counting confirmation delay twice and is reconstructed conservatively on restart.

## Removing configuration and managed tabs (0.4.20)

Removal actions reject affected running/active/unresolved scopes with `REMOVAL_BLOCKED` and relevant group names. Stopped group membership is trimmed while preserving the next surviving account; empty groups are removed. Unrelated accounts, channel targets, and historical attempts remain. Persistent scope tombstones reject stale periodic observations. Explicit account registration (`explicitRegistration:true`), browser reconnect (`explicitReconnect:true`), and channel connection are the re-add paths.

`CLOSE_CHANNEL` carries `{removalId,bindingId?,accountId,guildId,channelId,tabId?}`. Only the exact saved managed target can be closed; a navigated page is preserved. Pending requests survive restart/offline periods, and an applied ACK removes the pending request. Rejected closes retry with new command IDs at bounded intervals. `snapshot().pendingTabCloses` exposes the remaining operations even after the binding has disappeared. Reconnection before a previous close finishes rejects with `CLOSE_PENDING`.

Managed channel pages share one dedicated window per browser profile. New channel tabs are inactive; safe recovery consolidates existing managed pages while preserving tab IDs and drafts. General windows/tabs are not reused as dedicated sending windows. Closing a binding closes only its target tab; Chromium closes the dedicated window when its last tab closes.

## Remote controller links and retained record pages (0.4.21)

Authenticated UI clients can POST `/api/remote-access-link` with the existing CSRF token. It issues a separate single-use bootstrap URL valid for 120 seconds; it never returns the native bridge credential. The runtime still binds to loopback and validates the exact Host/Origin. SSH forwarding must use the same port on both PCs. This grants the same workspace's full controller session and does not add remote Discord executors.

Stored records follow retentionDays, not a count limit. Summary snapshots remain bounded for live updates. Authenticated paged history/log routes expose older retained records; a page-size limit does not limit the total number of retained records. Active/unresolved attempts are included even when older than the live summary window.

## Direct LAN controllers (0.4.22)

The primary runtime/native bridge stays on its existing `127.0.0.1` origin. A separate optional listener binds one discovered RFC1918/CGNAT IPv4 interface and a persisted independent port. `lan-access.json` lives in the private data directory, outside replaced application files. Startup defaults to disabled. An unavailable IP can follow a changed private address on the same saved interface, never another interface. Network configuration failure does not enable a public/wildcard listener.

Local authenticated UI endpoints are `GET /api/lan-access`, `POST /api/lan-access {enabled,address?,port?}`, and `POST /api/lan-access/pair {}`. Mutations require the existing local CSRF token. Pairing returns `{code,expiresAt,url}`; the 48-bit code is single-use, expires after two minutes, and has a bounded attempt count.

`GET /api/access-mode` exposes only `{mode:'local'|'lan'}` before login. LAN `POST /api/session {pairingCode}` creates a separate `dico_lan_session` HttpOnly/SameSite cookie plus CSRF token. LAN sessions are memory-only and reset when the listener stops or the program restarts. SSE revalidates sessions on pushes and heartbeats, including idle expiry. LAN requests to native bridge, LAN configuration, and the legacy SSH link issuer are rejected. A direct LAN controller otherwise controls the current owner's workspace; it does not register a remote Discord executor.

## Administrator support packages and immutable message logs (0.4.23)

Authenticated `GET /api/support/report` accepts optional attemptId/from/to and includeBodies/includeNames flags. `download=true` returns a named JSON attachment. Reports include immutable attempt text, runtime/build versions, configuration/order/cooldown/retry state, related retained events, safe diagnostics and checks. Bodies and names can be omitted. Current message revisions never replace a missing historical attempt body. Native credentials, session/cookie/CSRF/permit secrets and draft backups are excluded.

`POST /api/support/inspect {report}` requires UI authentication/CSRF and validates a maximum16MiB report without evaluating content. Other request bodies retain the existing1MiB limit. Imported reports are unverified diagnostic data and cannot change configuration or delivery state. There is no configured external recipient; users download the file and deliver it through their chosen channel.

`DELIVERY_TRACE` binds a monotonically increasing sequence, stage, observedAt and allowlisted scalar data to the exact instance/session/attempt. It grants no send authority, drops textContext/body/credentials and samples repeated stage telemetry. The native bridge accepts this type in addition to existing delivery messages.


### 0.4.24 automatic support delivery

Local UI auth+CSRF protects POST `/api/support/automatic` (consent, autoSend, receiverUrl, write-only reporterToken, inclusion flags, receiverEnabled, retentionDays), POST `/api/support/send`, and POST `/api/support/receiver-key`. GET `/api/support/automatic` returns sanitized configuration and outbox/inbox status. GET `/api/support/inbox` and `/api/support/inbox/:receiptId` return administrator receipt summaries and the inspected report. These administrator operations are unavailable from LAN controller sessions.

POST `/api/support/receive` accepts a raw bounded support report using a separate per-install bearer credential and explicit receiver opt-in; it never accepts UI cookies/native bridge credentials as substitutes. It can be reached through the enabled LAN listener or an explicitly configured HTTPS proxy. It returns a report-linked receipt; lost ACK retry is idempotent by reportId.

DELIVERY_WAIT `{observationPhase:true,retryCount,cooldownMs:0,elapsedMs}` refreshes a current, scoped permitted attempt without granting Enter or consuming a retry. AUTHORIZE_ENTER denials preserve `{code,retryable,retryAfterMs?}`; valid scoped requests refresh liveness even when a transient condition prevents Enter.

## 선택 실행 및 활성 설정
- `group.setEnabled {id,expectedVersion,enabled}`: 활성 여부 저장. 비활성화 시 자동 재개를 취소하고 기존 중지 절차를 요청한다. 활성화만으로 시작하지 않는다.
- `service.startAll {groupIds?}`: 생략 시 활성 그룹만, 명시 시 지정 그룹만 원자적으로 검증하여 시작한다. 빈 선택·존재하지 않는 ID·비활성 대상은 거절한다. 기존 `enabled` 미지정 그룹은 활성으로 취급한다.
