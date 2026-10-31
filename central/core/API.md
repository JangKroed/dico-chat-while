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

A restart disconnects observations, invalidates execution sessions, supersedes queued transport messages, and preserves all unresolved attempts as unknown. No attempt is automatically retried. Groups and the service require manual resume. Group and account delays use monotonic deadlines, with conservative full waits after resume. Clock discontinuity or an event-loop gap over 15 seconds blocks new permits.

A group owns both its logical Discord channel and each account/channel resource. A prepared attempt is not authorization to press Enter. Only the durable `COMMIT_PERMIT` command grants that authority. A stop receipt or control applied ACK does not establish that an issued permit was unsent. Confirmation requires an observed Discord message ID; manual unsent resolution requires prior executor evidence that the old attempt cannot still execute.

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
| `channel.update` | `{id,expectedVersion,name?,intervalMs?}` |
| `channel.applyPlaylist` | `{id,expectedVersion,items:[{messageId,revisionId?}]}`; 1–50 items |
| `group.create` | `{name,members:[bindingId],intervalMs?}` |
| `group.update` | `{id,expectedVersion,name?,members?,intervalMs?}`; stopped/paused only |
| `group.delete` | `{id,expectedVersion}`; stopped only |
| `group.start/resume/pause/stop` | `{id}` |
| `service.stopAll/resume` | `{}` |
| `attempt.resolve` | `{id,outcome:'confirmed',messageId}` or `{id,outcome:'not_sent'}` |
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
- `DELIVERY_RESULT`: `{sessionId,attemptId,outcome:'confirmed'|'not_sent'|'unknown',messageId?,executionBlocked?,confirmationMs?}`.
- `DISCONNECT` and `EMERGENCY_STOP`: `{sessionId}`.

`CONFIG_SYNC` payload contains binding, account/guild/channel/tab, `configVersion`, `intervalMs`, and `items:[{messageId,revisionId,name,body}]`. `PREPARE` includes the same target identifiers plus `attemptId`, `groupId`, `body`, and `revisionId`. `COMMIT_PERMIT` adds `permitId`. `RECONCILE` refers to the original attempt and never authorizes Enter. `CONTROL` contains `{action:'stop'|'pause',groupId,runId,controlGeneration,attemptId}`. Each explicit start/resume creates a fresh `runId`; attempts and all attempt command payloads retain it. The executor must preserve stopped-run tombstones so delayed commands from a stopped run cannot clear its execution gate.

## Bulk controls and configuration reset

- `service.startAll {}` starts all non-running groups in one durable transaction. Existing running groups retain their run and active attempt. A stopped service may be resumed by this explicit action. Any failed eligibility/resource/control/attempt check rolls back the entire request. Returns `{started,alreadyRunning}`; an empty group list is rejected.
- `settings.reset {confirmation:'RESET_ALL_SETTINGS',expectedConfiguration}` requires all groups fully stopped with no control intent and no preparing/permitted/unknown attempts. Compare `expectedConfiguration` to `snapshot().configurationToken`, a digest of user configuration entity identities/versions and preferences; idle ticks do not invalidate it. Removes messages/channels/groups/instances/import dedup references, restores preference defaults, stops the service and supersedes outstanding commands. Keeps historical terminal attempts, events, command history and duplicate protection. Old executor sessions are rejected. No Discord/OS/profile deletion occurs.
