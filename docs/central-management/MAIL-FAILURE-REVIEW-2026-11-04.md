# 2026-11-04 메일 제보 재검토

## 확인한 증거와 한계

원격 `/tmp/dico-mail-review/1a1a246e26177a75.json` 및 `1a1a246a8d2f1b72.json`을 읽기 전용으로 분석했다. 본문과 전체 로그는 복사하지 않았다.

- 실제 실행 버전은 앱·확장·content 모두 0.4.35이고 확장 build ID는 `d68e4a2f69352994666e209c206dd372df92b8c7f9372f7145ce1c967040ad16`이다.
- 동일 Chrome 연결·채널에서 PREPARE 4회가 `MANAGED_DELAY_UNAVAILABLE`로 끝났다. 마지막 시도는 `43d8c722-a0bb-46d2-b103-36143ab2477b`다.
- 마지막 content trace는 수신 +8ms, 승인 요청 +9ms, 승인 응답 +12ms, 예외 +15ms다. 입력창은 하나이고 대상 경로가 일치하며 초안 길이는 0이다. PREPARE 실패로 중앙은 `not_sent`를 기록했다.
- 마지막 실패 시각은 1793723852370, `connection_lost`는 1793723863898이다. 연결 끊김은 약 11.5초 뒤이므로 앞선 대기 거절의 직접 원인으로 단정할 수 없다.
- 재연결 1793723885587 뒤 동일 binding의 CONFIG_SYNC가 1793723887873에 `CONFIG_SYNC_FAILED`로 거절됐다.
- 현재 원격 소스와 로컬에는 이미 현재 시도의 tabId로 대기를 허용하는 fallback이 있다. 기존 제보에는 worker의 세부 거절 사유·당시 로컬 binding/attempt/tab 상태가 없어 **4회 PREPARE의 정확한 worker 거절 원인은 미확정**이다. 소스 파일 존재만으로 당시 설치 빌드의 내용을 확정하지 않았다.

## 재현한 결함과 수정

### 재연결 설정 동기화가 종료된 준비 실패 기록에 막힘

PREPARE 거절을 ACK해도 확장 로컬 시도는 `preparing`에 남을 수 있다. 다음 PREPARE는 중앙의 종료 기록을 조회하지만 CONFIG_SYNC는 조회 없이 로컬 미완료 기록을 차단했다. 실제 실행기를 사용하는 회귀 테스트에서 같은 상태를 재현했다.

CONFIG_SYNC도 중앙 HEARTBEAT의 terminalAttempts를 먼저 대조한다. 중앙이 종료를 확인한 기록만 반영하고 미확인·응답 유실·세션 변경은 설정 적용을 계속 차단한다. 초안 삭제나 Enter 재실행은 하지 않는다. 이는 코드상 확인된 결함이며, 제보 당시 확장 저장소가 없어 해당 제보의 CONFIG_SYNC 원인을 최종 확정한 것은 아니다.

### 재승인 대기 시간과 worker 계약 불일치

content는 승인 재시도 응답에서 최대 5000ms를 받지만 worker는 한 요청을 1000ms로 제한한다. 기존 테스트의 가짜 worker가 이 제한을 누락했다. 실제 managedPageDelay를 연결하자 1500ms 재승인 테스트가 `confirmed` 대신 `blocked`로 실패했다.

대기를 1000ms 이하로 나누고 매 응답 뒤 취소 여부를 확인하도록 수정했다. 요청된 총 대기 시간을 보존하며 대기 완료 후에도 별도 발송 승인이 필요하다. 이는 commit 재승인 경로의 재현된 결함으로, 이번 PREPARE 4회 실패의 원인이라고 주장하지 않는다.

### 다음 자동 제보의 진단 보강

worker는 발신자·시간 범위·등록 탭·경로·세션·실행 문맥 거절을 `DELAY_*` 고정 코드로 구분한다. content 예외 trace에 기존 `MANAGED_DELAY_UNAVAILABLE`와 세부 reasonCode를 함께 남긴다. 메시지 본문·계정 ID·탭 ID·원문 예외는 추가하지 않는다. 확장 tracer와 trace 필터, 제보 내보내기를 통과한 코드 보존을 테스트했다.

기존 탭 재사용과 일치하도록 managed delay와 실행기의 URL 검사에서 마지막 슬래시 한 개를 정규화한다. 다른 채널·다른 출처는 계속 차단한다.

## 검증

수정 전 재현 실패와 수정 후 성공을 확인했다. 다음 4개 파일의 185개 테스트가 통과했다.

- `tests/central-executor.test.js`
- `tests/central-managed-delay.test.js`
- `tests/two-phase-content.test.js`
- `tests/central-support-report.test.js`

로컬 전체 테스트는 HTTP listen 권한 제한(EPERM)이 있어 전체 통과 판정에 사용하지 않는다. 실제 브라우저에서 새 진단 코드가 담긴 다음 제보를 확인해야 기존 PREPARE 거절의 원인을 더 좁힐 수 있다. 

## 통합 검증

0.4.37 원격 통합 환경에서 전체 테스트 1,204개 통과(실패·건너뜀 0). 컴파일과 확장 생성물을 확인하고 기존 프로그램 내 업데이트 경로에 반영한다. 실제 사용자 Discord 계정으로 메시지를 보내는 검증은 수행하지 않았다.
