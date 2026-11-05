# 발송 복구 상태 단순화 구현 계획

**Goal:** 0.4.42 main의 확정 결과·읽기 전용 조회·입력 권한을 구분해 자동 복구의 순환 대기를 제거한다.

**Architecture:** 중앙의 시도·명령과 확장의 로컬 실행 기록은 각각 저장 책임이 있어 유지한다. 읽기 전용 RECONCILE의 발급 조건과 검증된 결과 이후 재개 조건만 단순화한다. 입력/Enter 승인은 기존 세션·계정·채널·초안·중지 검사에 남긴다.

**Tech Stack:** Node.js 24, JavaScript ES modules, SQLite, node:test, Chromium extension.

**Spec:** 사용자의 2026-11-05 요청 및 `docs/central-management/STOP-DISCONNECT-RECOVERY-2026-11-04.md`.

## 제약과 리뷰 초점

- 계정·채널 연결, 그룹·문구 순서, 최소 간격, 중복 방지, 사용자 stop/pause를 유지한다.
- unknown을 임의로 not_sent/confirmed로 바꾸지 않는다. 새 탭의 빈 입력창은 과거 성공 근거가 아니다.
- 운영 설치·Discord 입력 없이 격리 검증한다. 제보 분석과 PR #2 업데이트 변경은 범위에서 제외한다.
- 늦은 완료와 재조회 순서, 사용자 중지, 세션 교체, 연결 분리 이력, 준비 오류 반복을 회귀 검증한다.

## 작업

- [x] 실제 코어+실행기의 늦은 완료 보고와 차단 근거 없는 unknown 자동 조회를 실패 테스트로 재현한다.
- [x] `central/core/index.js`: 읽기 전용 조회에서 입력 차단 선행 조건을 제거하고 detached 이력을 제외한다. 결과 근거 검증은 유지한다.
- [x] `central/extension/executor.js`: 저장된 확정 완료는 실행 종료 근거를 함께 보고해 현재 RECONCILE의 영수증 검사를 충족한다. DICO_DELIVER는 다시 실행하지 않는다.
- [x] `central/core/index.js`: 검증된 자동 완료 후 재개는 대기열에 조회 명령이 있는지가 아니라 같은 run의 보존된 실행 의도로 결정한다.
- [x] 준비 단계의 초안 조회 통신 실패가 일반 콘텐츠 통신 실패와 다른 수동 중단으로 분기되는지 실패 테스트로 확인하고 동일 복구 정책으로 합친다.
- [x] 관련 회귀·전체 기존 테스트·TypeScript·프로덕션 빌드·check를 수행한다.
- [x] 실제 실행 경로, 유지/단순화/보류 판단과 검증 한계를 문서화하고 main 기준 독립 PR 설명을 준비한다.

검증 결과: 신규 9개 포함 전체 1,278개 통과. 리뷰 중 queued 조회 누적을 재현해 received 시점부터 만료하도록 수정했다. TypeScript·프로덕션 UI/확장 빌드·central:check·check·diff 검사 통과. 운영 브라우저와 실제 Discord 발송은 미검증.
