# DICO 중앙관리 구현 계획

**Goal:** 승인된 로컬 중앙관리·메시지·그룹·실시간 로그·알림 기능을 실행 가능한 관리 프로그램과 전용 확장으로 구현한다.
**Spec:** `docs/central-management/PRODUCT.md`, `UX.md`, `ARCHITECTURE.md`, `OBSERVABILITY.md`.
**Architecture:** SQLite 영속 상태/예약 엔진, loopback 인증 HTTP/SSE, Native Messaging 브리지, 중앙 React UI, 브라우저 전용 실행기.
**Tech Stack:** Node.js 24.13 이상 내장 SQLite/HTTP/crypto, React·TypeScript·Vite. 패키지에는 Node 런타임 포함.

## Constraints and decisions
- 현재 0.3.0 변경과 사용자 데이터를 보존하고 새 구현은 `central/`에 격리한다. 기존 root 확장 ID를 바꾸지 않는다.
- 새 전용 확장은 별도 고정 ID를 사용한다. 기존 확장 데이터는 자동으로 읽었다고 주장하지 않으며 구형 실행기 중지와 명시적 가져오기가 필요하다.
- Node 20에는 내장 SQLite가 없어 새 관리 프로그램은 번들 Node24를 사용한다. 기존 0.3.0의 Node20 지원은 유지한다.
- 서비스 코어는 기존 ESM 실행·테스트 환경과 설치 의존성을 고려해 JS/JSDoc, UI는 TypeScript를 사용한다.
- 단일 서비스와 OS 사용자 전용 descriptor로 자동 발견한다. 내부망 스캔·IP/토큰 수동 입력 없음. descriptor는 private 권한이며 브리지 자격은 페이지/Discord 탭으로 보내지 않는다.
- 코드·아티팩트 작성만 수행한다. 실제 OS 호스트 등록·환경변수·권한 변경·Discord 발송·외부 게시를 실행하지 않는다.
- 독립 보조 작업 최대3: Astra/high 코어·판정, Sol/high UI, Sol/high 호스트/패키징. 메인 세션은 런타임·확장 통합 담당.

## Review focus
- 허가/응답/ACK 유실과 재시작 시 중복 발송·허위 완료 차단.
- UI 세션·CSRF·Host/Origin 검증, native 자격 비노출.
- CONFIG 수신과 적용의 구분, 구형 실행과의 충돌·미확인 보존.
- 메시지 버전·그룹 순서·슬로우 모드·시간 변경·다중 전용 탭 소유권.
- 중복 이벤트 집계·반복 알림·서비스 의도 종료·플랫폼별 실제 검증 한계.

## Tasks
- [x] 1. `central/core/` SQLite 도메인/메시지/그룹/발송/명령/이벤트/지표. `tests/central-domain*.test.js` 실패→구현→검증.
- [x] 2. `central/runtime/` HTTP 세션·SSE·UI 제공·알림·서비스 lifecycle. `tests/central-runtime*.test.js` 실패→구현→검증.
- [x] 3. `central/host/` stdio 브리지·OS별 설치 계획·런타임 패키징. `tests/central-host*.test.js` 실패→구현→검증; 사용자 시스템에 설치는 실행하지 않음.
- [x] 4. `central/extension/` 네이티브 연결·계정/채널 관측·구성 ACK·발송/중지 게이트. 가상 Chrome 테스트로 실제 content 발송 경로 연결 검증.
- [x] 5. `central/ui/` 대시보드/메시지/채널/그룹/기록/로그/설정/튜토리얼. offline 의존성 설치·프로덕션 빌드·컴포넌트/상태 테스트.
- [x] 6. 전체 통합·정식 검토·기존 테스트/check·플랫폼 패키징 확인. 실제 수행·미검증·제약 기록.

## Shared contracts
코어 `createCentralManager({databasePath,now,monotonicNow})`는 execute/snapshot/bridge/tick/subscribe/events/commands/analytics/close를 제공한다. UI는 `/api/session`, `/api/snapshot`, `/api/command`, `/api/events`, `/api/analytics`, `/api/notification-test`를 사용한다. 브리지는 private descriptor를 읽고 Bearer 인증으로 `/api/bridge*`만 사용한다. 네이티브 packet은 requestId가 있는 RESPONSE와 별도 COMMAND를 구분한다.

## Execution ledger
- 2026-10-30: 승인 범위·기존 변경 확인, 구현 담당과 파일 소유권 분리. 의존성은 npm offline cache에서 설치하고 캐시 쓰기는 작업 경로로 격리한다.


## Completion evidence
- `npm test`: 304 tests, 304 pass, 0 fail, 0 skipped. Includes root0.3 regressions, SQLite failure/restart, core rotations, three-executor integration, real loopback HTTP/native bridge, notifications, stale UI drafts and delayed Enter authorization.
- `npm run central:build`: TypeScript check + Vite production UI + dedicated content/emoji copy passed.
- `npm run central:check` and `npm run check`: syntax, manifests and HTML CSP passed.
- Independent Astra/high review found sleep/permit, SQLite WAL privacy and live uninstall hazards; source and regression tests were corrected. Buffered authorization response is bounded both in worker and content immediately before Enter.
- UI browser check: actual local Chrome and Brave aborted with SIGABRT before DevTools startup. No sandbox escalation or user browser profile access was attempted. Actual browser GUI remains unverified; HTTP UI assets and authenticated commands passed.
- Host installation/uninstallation: dry-run only, no user NativeMessagingHosts/registry/autostart configuration changed. Actual Discord messages: none.
- macOS arm64 bundle: dist/central-packages/dico-manager-darwin-arm64-node-24.13.0.zip, 38,185,584 bytes; SHA256 e7498f873fc15e6afa52cdaa3306cde7e92cc322c6ed9645f41699f42aa08c70. ZIP integrity, source parity, required assets, absent userdata/secrets verified.
- Windows native launcher source and target-platform packaging scripts provided; Windows/MSVC build and real OS verification remain pending. macOS bundle unsigned/unnotarized. See docs/central-management/IMPLEMENTATION.md for scope/deferred release items.
