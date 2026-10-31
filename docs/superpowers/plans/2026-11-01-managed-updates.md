# Managed Updates Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task.

**Goal:** 중앙 UI에서 안전한 업데이트를 실행하고 확장 관리 화면의 반복 재로드를 없앤다.
**Architecture:** 사설 외부 updater가 격리 체크아웃·빌드 후 JS 디렉터리를 교체한다. 확장은 실제 설치 해시와 실행 빌드 ID를 비교하고 유휴 상태에서만 자체 재로드한다.
**Tech Stack:** Node 24, native messaging, Chromium runtime API, React.
**Spec:** docs/superpowers/specs/2026-11-01-managed-updates-design.md

## Global Constraints
- 고정 저장소만 사용하고 기존 클론·DB를 덮어쓰지 않는다.
- 실제 사용자 설치·전역 설정·발송은 이번 개발 검증에서 변경하지 않는다.
- macOS/Windows 바이너리는 유지한다. 그룹 자동 재개와 초안 삭제 금지.

## Review Focus
- 미확인 시도·중지 ACK 대기·새 실행과 적용 사이 경합은 업데이트를 차단한다.
- 잘못된 확장 로드 경로는 무한 재시작 대신 수동 이전 안내로 종료한다.
- 다운로드·빌드 실패 시 기존 설치가 그대로 실행된다.
- 확장 재시작 중 구버전 콘텐츠·진행 중 작업은 잘못된 발송을 허용하지 않는다.
- CSRF·세션·사설 작업 토큰 없는 적용 요청을 거부한다.

## Tasks
- [x] Runtime: updates API와 외부 worker, 상태·중복·실패·유휴 검증 테스트부터 작성한다. 빌드 후 사설 적용 요청, 단계별 복구와 재시작 구현.
- [x] Extension: build ID 생성, 설치 해시 검증, 안전 재로드와 재시도 제한 테스트부터 작성한다. 콘텐츠 수명·버전 handshake와 재연결 구현.
- [x] UI: 업데이트 카드, 진행·오류·사용 브라우저 버전 표시, 중지 조건·첫 전환 안내 구현. 타입 검사.
- [x] 통합: 전체 테스트·build/check·별도 임시 UI 검사, 독립 검토 후 문서와 함께 배포.
