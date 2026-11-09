# 0.4.59 통합 검증

## 기준

- GitHub main `74a01499d587f57994b887b9600d3f7d6dfb06f7`, 중앙 0.4.58 기준.
- 모든 기준 파일의 Git blob SHA를 검증한 별도 작업본에 변경을 통합했다.
- 0.4.58의 슬로우모드 텍스트 판독, 전용 창 prepare 처리, 초안 검사 세부 코드, 실행 차단 ACK, 연결 단절 원인 기록은 유지한다.
- 변경 경로: core/index.js, extension/executor.js, extension/managed-windows.js 및 대응 회귀 테스트, 버전·빌드 메타데이터·문서·PR CI 설정.

## 로컬 검증

- 전체 1,368개 중 1,343개 통과, 24개는 loopback 포트 bind의 EPERM으로 실패, 1개 건너뜀. 이전 실행 환경과 동일한 포트 제한이다.
- TypeScript/Vite/UI 사전 빌드 봉인/확장 빌드 및 central:check 통과.
- 루트 문법·manifest·CSP 검사와 레거시 확장 ZIP 빌드 통과.
- 별도 PR의 GitHub Actions에서 동일 소스로 전체 통합 검증 후 main에 반영한다. 실제 실행 결과와 로그는 해당 PR의 Checks를 기준으로 한다.

## 검증 경계

테스트는 중앙 코어·실행기·실제 loopback 런타임·SQLite·업데이트 교체/롤백·슬로우모드·중지·재연결·완료 근거를 포함한다. 실제 Discord에 시험 메시지를 보내는 검증은 포함하지 않는다. 사용자 운영 DB·기존 설치·실행 상태는 이번 통합본 생성 과정에서 변경하지 않는다.

main 반영 후 기존 관리 화면의 설정 → 업데이트에서 0.4.59를 받을 수 있다. 중앙 패키지·확장 manifest·생성 콘텐츠 버전이 일치해야 한다. 빌드 식별자는 생성 코드의 해시로 검증한다.

## CI 실행 결과와 실행 환경 수정

- PR #21의 최초 검증 커밋 `e4cf1b0`: GitHub Linux에서 전체 테스트 **1,368개 통과, 실패·건너뜀 0개**, 빌드와 검사 통과. Windows 업데이터 빌드 통과.
- macOS 14 CI는 작업 시작 전 취소됐다. 공식 종료 공지에 따라 runner를 macos-15로 갱신했다: https://github.blog/changelog/2026-10-01-github-actions-macos-14-runner-image-retirement/
- 로컬 macOS에서 업데이터의 교체·백업·해시·위험한 압축·권한·개발 폴더 보호 테스트 및 arm64/x86_64 universal 앱 빌드가 통과했다.
- 별도 리뷰에서 핵심 변경과 기존 0.4.58 기능 보존을 확인하고, 도메인·과거 영수증·연결 해제·중지 관련 177개 테스트를 독립 실행해 모두 통과했다.
- 변경된 CI runner를 포함한 최종 검증 결과는 PR #21의 최종 커밋 Checks에서 확인한다.
