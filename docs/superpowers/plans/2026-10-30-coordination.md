# 브라우저 간 순환 발송 Implementation Plan

**Goal:** 독립 브라우저의 A → B → C 발송 순서를 중앙에서 관리한다.
**Architecture:** durable HTTP coordinator + optional extension client + existing controller intent/receipt lifecycle.
**Tech Stack:** Node.js >=20, Chrome extension MV3, node:test.
**Spec:** docs/superpowers/specs/2026-10-30-coordination-design.md

## Global Constraints
- 자동 허가 만료 없음. 전송 미확인은 차례를 막는다.
- 로컬 pending 저장 → 중앙 허가 → 발송 → 중앙 완료 → 로컬 완료 순서.
- 기존 단독 모드, 게시 확인, 슬로우 모드 보존.
- 비밀 토큰과 브라우저 ID는 백업/진단에 노출하지 않는다.

## Review Focus
- 허가와 완료 요청의 응답 유실 및 재시작.
- 같은 멤버를 여러 브라우저/채널 설정에서 실행.
- 이미 닫힌 발송 ID 재사용, 오래된 허가, 잘못된 채널.
- 저장 실패와 동시 요청의 원자성.
- 초안/슬로우 모드 재시도와 수동 미발송 확인.

## Tasks
- [x] 1. coordinator/core.js 상태 머신, server.js 영속 HTTP 서비스: 실패 테스트 → 구현 → 순환/동시성/영속/인증 테스트.
- [x] 2. coordination.js와 controller/channel-manager/background 연결: 실패 테스트 → 구현 → 허가 없이 발송 불가, 결과 유실/수동 확인 테스트.
- [x] 3. 사이드패널 설정, 서버 origin 권한, 백업 보호, 패키징 및 실행 안내: 설정 회귀 테스트 → 구현 → 전체 테스트/check/build.
- [x] 4. 전체 변경 검토 및 실제 실행 범위/미검증 사항 보고.

## Execution notes
사용자의 진행 요청에 따라 현재 작업 폴더에서 직접 구현한다. 파일 저장 방식은 설치 부담을 줄이기 위한 구현 결정이다. 외부 배포와 실제 Discord 메시지 발송은 수행하지 않는다.

## Verification
- npm test: 228 tests, 227 passed, 0 failed, 1 skipped (loopback listen EPERM). HTTP handler, client and durable storage integration passed without sockets.
- npm run check: JavaScript syntax, manifest references and HTML CSP passed.
- npm run build: dist/dico-while-0.3.0.zip created; archive bytes verified against runtime allowlist by build script.
- Independent review: no critical/important findings. Actual Discord, browser host permission prompts and running coordinator listener remain unverified.
- Ruling: persistent state defaults outside the extension installation so native auto-update directory swaps cannot reset permits.
- Ruling: repeated wait/status requests do not rewrite unchanged durable state, reducing disk writes during long runs.
