# 중앙 코어 중지·복구 정합성 검증 — 2026-11-03

대상: 0.4.32 작업 트리의 `central/core/index.js`. 실제 Discord 발송, 운영 데이터 변경, 커밋은 수행하지 않았다. 모든 결과는 메모리/임시 저장소와 가상 시계를 사용하는 프로토콜 회귀 검증이다.

## 재현한 결함과 수정

### 자동 중지 복구 소진 뒤 재접속해도 완료되지 않음

1. `group.stop` 또는 `group.pause` 요청을 거절한다.
2. 최초 명령 이후 자동 복구 3회를 모두 거절한다.
3. 같은 브라우저가 `HELLO`로 새 세션을 만든다.
4. 새 세션에 재발급된 `CONTROL`이 `applied`를 보고한다.

수정 전에는 이전 세션의 마지막 `rejected CONTROL`이 남아 있었다. `controlComplete`는 같은 세대의 대체되지 않은 모든 제어 명령이 `applied`여야 완료하므로, 복구 횟수까지 소진된 그룹이 `stop_pending`/`pause_pending`에서 영구 대기했다. 신규 회귀 2건에서 예상 `stopped`/`paused`, 실제 `stop_pending`/`pause_pending`의 실패를 확인한 뒤 수정했다.

`HELLO`의 세션 교체 시 이전 `rejected CONTROL`도 `superseded`로 전환한다. 기존 명령 ID, 거절 코드, 사건 기록은 남긴다. 새 세션의 제어 명령 적용 ACK가 도착하기 전에는 완료하지 않는다. 자동 복구 횟수를 무한 초기화하거나 발송을 재개하지 않는다.

### 명령 ID가 바뀌는 재발의 상관관계 누락

기존 사건 키는 명령 ID를 기준으로 하므로 같은 장애의 자동 재시도 실패가 모두 독립 사건으로만 기록됐다. 기존 사건별 상태는 그대로 유지하면서 다음 진단 필드를 추가했다.

| 필드 | 의미 |
| --- | --- |
| `recurrenceKey` | 장애 코드·브라우저·그룹·연결/계정/채널·명령 종류·작업·기록된 원인으로 만든 비교 키 |
| `previousIncidentId` | 보존된 이전 동일 대상·작업·원인 사건 |
| `occurrenceNumber` | 연결된 발생 순번; 기존 사건의 반복 관찰 횟수 `count`와 별개 |
| `firstOccurredAt` | 연결된 첫 발생 시각 |

이 필드는 사건과 `incident.opened` 이벤트에 함께 저장된다. 메시지 본문, 초안, 원시 오류 내용, 세션/발송 허가 자격은 포함하지 않는다. 같은 키라는 것은 기록된 대상·작업·원인이 같다는 의미이며, 내부 원인이 입증됐다는 의미는 아니다. 보존 기간 밖에서 이미 삭제된 과거 사건까지 복원하지 않는다.

회귀 검증에서 수정 전 `previousIncidentId`가 없음을 확인했다. 수정 후 같은 원인 재시도는 연결되고 다른 그룹/다른 거절 원인은 분리된다. 해결 후 재발은 읽지 않은 새 미해결 사건으로 남는다. 이전 사건의 해결 상태를 복사하거나 알림을 숨기지 않는다.

### 자동 중지 해결 근거 누락

`controlComplete`가 실제 적용을 확인한 뒤 해결한 사건에는 `resolutionReason`이 없었다. 회귀에서 `undefined`를 재현한 뒤 `control_applied`를 사건과 해결 이벤트에 보존하도록 변경했다. 해결 조건 자체는 변경하지 않았다.

## 지켜지는 안전 조건

- 재접속 그 자체, 단순 명령 수신, 경고 읽음은 중지 완료 근거가 아니다.
- 새 제어 ACK는 모든 그룹 소유 브라우저에 대한 적용 검사를 통과해야 한다.
- 허가된 발송이 미확인 상태라면 중지 적용은 실행 차단만 확정한다.
- `unknown` 결과, 활성 시도 ID, 자원 잠금, `delivery_unknown` 사건을 보존한다.
- 미확인 결과가 남으면 `group.resume`는 `ATTEMPT_UNRESOLVED`, 같은 자원 경쟁 그룹은 `RESOURCE_BUSY`로 거절한다.
- 중지 복구/재발 기록 때문에 새 `PREPARE`나 추가 발송 시도를 만들지 않는다.
- 기존 자동 재검사의 동일 연결·세션·설정 적용 근거 조건을 완화하지 않는다.

## 최종 검증

```sh
node --test tests/central-core-integrity.test.js \
  tests/central-control-completion.test.js \
  tests/central-domain.test.js \
  tests/central-reverify-review.test.js \
  tests/central-window-recheck.test.js \
  tests/central-retry-not-sent.test.js \
  tests/central-resume-deadlines.test.js
```

**164개 통과, 실패 0개.** 신규 정합성 회귀 5개가 포함된다. 도메인 검증은 중복 결과/ACK, 순환 순서, 재시작, 허가·자원 잠금, 보존기간, 실제 적용 전 재개 차단도 포함한다.

별도 확장 복구 검증 `central-recovery-review.test.js`는 담당 변경 반영 후 2개 통과했다. 더 넓은 실행 중 `central-session-restart.test.js`의 소켓을 여는 3건은 환경의 `listen EPERM 127.0.0.1` 제한으로 수행할 수 없었다. 이를 코어 회귀 성공이나 운영 검증으로 간주하지 않는다. 실브라우저/실제 네트워크 경계는 이 문서의 검증 범위 밖이다.

## 추가 요구 반영: 유한 재시도

기존 기본값 `null`과 `5 → null` 이행 정책은 반복 실패를 끝내지 않았다. 실제 프로토콜로 입력 준비를 4회 거절하는 회귀를 먼저 추가했고, 기대 `paused`에 대해 실제 `running` 실패를 재현했다.

공유 정책 `central/extension/retry-policy.js`를 추가했다.

- 기본 **추가 재시도 3회**, 설정 허용 범위 **정수 0~10회**. 최초 실행은 추가 재시도 횟수에 포함하지 않는다.
- 신규 설정 API는 `null`, 음수, 비정수, 10 초과를 거절한다.
- 기존 DB·백업의 `null`/누락/비정상 값은 3으로 바꾸고, 과도한 과거 정수는 10으로 축소한다. 기존 0~10 선택은 그대로 보존하며 5를 무제한으로 바꾸지 않는다.
- 새 시도와 명령 payload는 유한 횟수를 갖는다. `AUTHORIZE_ENTER`, `DELIVERY_WAIT`, 준비 실패 복구가 동일 정규화 상한을 사용한다.
- 이전 활성 시도의 `maxSendRetries:null`도 유한 값으로 이행하지만, 누적 횟수를 0으로 되돌리지 않고 결과·허가 이력·잠금을 보존한다. 재시작의 기존 차단 절차로 미확인 결과는 `unknown`이며, 이행이 재발송을 허가하지 않는다.
- 기본 입력 준비 실패는 최초+추가3회 후 `paused/preparation_failed`로 끝나며 마지막 실제 원인의 미해결 사건을 남긴다. 허가 전이므로 미발송 근거가 있으며 문구·계정 순서를 넘기지 않는다.
- 과거 수집된 진단 `maxSendRetries:null`은 역사적 근거이므로 원문 진단 기록에서 유한 값으로 위조하지 않는다.

기존 ‘무제한이어야 한다’ 테스트는 현재 유한 요구로 변경했다. 장시간 Discord 제한을 기다리는 동안 동일 차례를 보존하는 기존 검증은 유지하고, 4번째 추가 Enter/대기 요청은 거절됨을 검사한다.

최종 코어 검증은 위 7개 파일에 `tests/central-retry-migration.test.js`를 추가한 **8개 파일, 169개 통과, 실패 0개**이다. 구문 검사도 통과했다. 이 결과는 최초 164개 검증 뒤 유한 정책 변경까지 반영한 최종 수치다.
