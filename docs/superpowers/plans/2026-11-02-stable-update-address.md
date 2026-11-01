# Stable Update Address Implementation Plan

> Use executing-plans for this user-authorized change.

**Goal:** 설치별 주소와 기존 인증 탭을 업데이트 뒤에도 유지한다.
**Architecture:** 사설 endpoint/session 상태를 저장하고 업데이트는 브라우저를 열지 않는다. UI는 같은 origin으로 재연결한다.
**Tech Stack:** Node HTTP/SQLite, native host, React/TypeScript.
**Spec:** docs/superpowers/specs/2026-11-02-stable-update-address-design.md

## Global Constraints
- 기본 신규port43127, 기존port재사용, 충돌 시 임의fallback 금지.
- 실제 운영파일 변경·발송 금지. Origin/CSRF 검증 보존.
- 명시port0인 테스트와 기존데이터/확장코드 보존.

## Review Focus
- 종료 뒤에도 유효세션 복구, 만료/다른origin/개인파일오염 거부.
- EADDRINUSE 또는 시작 실패 시 기존 인증 파일 덮어쓰기 방지.
- 반복poll/SSE 재시도 중복과 자동 새탭 생성 방지.
- 다른페이지의 미저장 초안 보존, 설정페이지 동일탭 버전갱신.
- 최초 구버전 이전과 일반업데이트 동작을 구분.

## Tasks
- [x] runtime 저장주소·사설세션·업데이트재시작 회귀부터 구현.
- [x] UI 같은탭 복구/버전갱신과 재시도 검사.
- [x] 기존테스트 임시포트 격리, 버전/설명 문서 정리.
- [x] 전체 빌드·테스트·독립검토 후 게시.
