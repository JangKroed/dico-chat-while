# Connection Recheck and Interval Defaults Implementation Plan

> Use executing-plans for this user-authorized change.

**Goal:** 정상 복구 연결의 알림을 정리하고 슬로우모드+3초를 기본/최소 주기로 적용한다.
**Architecture:** 코어의 재검사 증거 판정 및 주기·구성 버전을 확장하고 UI는 auto/custom 의도를 전송한다.
**Tech Stack:** Node SQLite domain, React/TypeScript.
**Spec:** docs/superpowers/specs/2026-11-02-connection-recheck-intervals-design.md

## Global Constraints
- 실제 발송·운영 DB 수정 금지. 확장 코드/버전 유지.
- 과거 전송 결과를 연결 복구로 바꾸지 않는다.
- 주기 변경은 진행 중 허가의 구성 버전을 덮어쓰지 않는다.

## Review Focus
- 다른 브라우저·계정·채널/과거 세션의 연결 증거 거부.
- 미감지·슬로우모드0초·상승·하락을 구분.
- 사용자 custom 의도 보존과 기존 데이터 이전.
- active/unknown 시 동기화 보류와 terminal 이후 적용.
- 앱/확장 버전이 다를 때 업데이트 완료 버전 정확성.

## Tasks
- [x] 코어 회귀 테스트 후 OPEN_CHANNEL 재검사와 intervalMode/floor 구현.
- [x] UI 최소값·자동/직접 설정 및 저장 검증 테스트/타입검사.
- [x] 업데이트 표시 버전 및 그룹 기본값 보정.
- [x] 통합 테스트·빌드·구문검사와 독립 리뷰, 문서·푸시.
