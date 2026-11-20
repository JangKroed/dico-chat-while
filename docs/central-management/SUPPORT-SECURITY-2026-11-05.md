# 공개 이메일 제출 키 보안 점검

## 결론 및 확인 범위

2026-11-05 KST에 GitGuardian 알림과 탐지 커밋 `66f7df42aa8440786291caca83f28251f1c0ab46`, 최신 `main` `cf18098e12368dd87d83960f333a14b365e6b3a3`(0.4.42)을 대조했다.

- 탐지 알림: 2026-11-03 13:57 KST, Generic High Entropy Secret 1건, 커밋 `66f7df4`.
- 해당 커밋과 main의 공개 제출 키는 동일하며 길이는 64자다. 값·일부 접두사·해시는 기록하지 않았다. 연결 파일과 `mail-relay/Central.gs`, 이메일 문서도 그 사이 변경되지 않았다.
- 중앙 전송·보고서 모듈은 이후 자동 제보 개인정보 축소·재시도 및 영속성 보강이 있었다. 현재 동작을 기준으로 검증했으며, 이후 수정 전 상태를 다시 구현하지 않았다.
- 공개 키가 허용하는 것은 고정 수신함에 진단 메일을 제출하는 일이다. 앱을 소유하지 않아도 공개 소스에서 얻은 값으로 호출할 수 있다. 실제 스크립트를 실행한 오프라인 합성 시험에서 위조 보고서 접수가 가능함을 확인했다.
- 이 값이 Google 계정 비밀번호·OAuth 자격증명이라는 증거는 없다. 두 커밋 트리에서 개인키 헤더, Google access/refresh token 및 GitHub PAT 형태를 검사한 결과 일치 항목은 없었다. 이 검사는 모든 과거 커밋·모든 종류의 비밀·운영 Script Properties를 포괄하는 비밀 부재 증명이 아니다.
- `reporterToken`이라는 이름과 무작위 문자열이 Generic High Entropy 탐지 조건에 맞는 것으로 판단한다. GitGuardian 화면에서 실제 탐지 위치·매칭 값을 대조하지 못했으므로 탐지 값의 최종 동일성은 미확인이다. Google 비밀정보 누출로 단정할 근거도, 남용 위험까지 없는 무해한 오탐으로 종결할 근거도 없다.

## 권한과 위험

| 대상 | 가능한 일 | 불가능하거나 별도 권한이 필요한 일 |
| --- | --- | --- |
| 공개 receiverUrl + reporterToken | 보고서 위조, 고정 수신함에 첨부 메일 요청, 공유 할당량 소진 | 수신자 변경, Gmail 읽기, Google 계정 로그인, Apps Script 코드·속성 변경 |
| 중앙관리 로컬 receiverToken | 별도로 수신을 활성화한 중앙관리 `/api/support/receive` 접수 | 공개 이메일 키와 별개의 무작위 자격증명. 공개 키로 로컬 관리 인증을 통과하지 않음 |
| Apps Script 실행 계정 | 승인된 범위 안에서 MailApp 실행 | 실제 승인 범위·프로젝트 내 추가 코드 확인은 필요. 저장소 코드만으로 운영 권한을 증명하지 않음 |

원래 코드의 고정 수신자·스크립트 락·하루 20회·90일 영수증·발송 전 미확정 예약은 유지할 가치가 있다. 그러나 보고서 ID는 공격자가 새로 만들 수 있고 공개 키가 정상 사용자 여부를 보장하지 않는다. 원래 코드에는 단기 발송 제한이 없었고 문자 수 크기 검사 및 첨부 원문 통과가 존재했다.

이번 수정은 UTF-8 크기/구조 검사, 60초당 3회·일일 첨부 32MiB 제한, 저장 여유 검사, 긴급 차단, 민감 필드·일부 원문 제거, 불신 자료 안내를 추가했다. 계정별 인증·IP/WAF 요청 제한은 구현하지 않았다. 공격자는 여전히 전역 20회 한도를 소진하여 정상 제보를 지연시킬 수 있다. UTC 자정 전후에는 서로 다른 날짜의 예산이 적용되므로 하루 한도는 이동 24시간 한도가 아니다.

## 인증정보·로그 점검

- 제출 키는 HTTPS POST 본문에서만 사용하고 URL 쿼리에 넣지 않는다. Google 콘텐츠 응답 리다이렉트는 정확한 HTTPS 호스트·경로로만 GET 요청하며 키·보고서를 재전송하지 않는다. 다른 중계는 리다이렉트를 거절한다.
- 로컬 자격증명 파일은 분리 저장하며 POSIX에서 0600, 디렉터리는 0700이다. 사용자 상태 API는 키의 유무만 반환한다. Windows ACL 실기 검증은 이번 범위가 아니다.
- 현재 자동 제보는 본문·이름·자유 텍스트 오류를 제외한다. 수동 공유 동의와 별도로 적용되며 동의 철회 시 대기 보고서도 축소한다. 기존 관련 회귀도 전체 테스트에 포함됐다.
- 중계는 요청/키/보고서를 console 또는 Logger에 기록하지 않는다. 발송 공급자 예외 원문도 응답하지 않는다. 앱은 허용된 오류 코드만 고정 문구로 표시하며 새 RATE_LIMIT/DISABLED/STORAGE_LIMIT도 같은 규칙을 따른다.
- 새 중계 정화는 자격증명 필드·알려진 제출 키·흔한 헤더/할당·개인키 PEM을 제거한다. 임의의 자유 문자열에 숨겨진 모든 비밀 검출은 보장하지 않는다. 실제 Cloud Logging·과거 수신함·사용자 로컬 로그 전체를 열람하지 않았으므로 과거 자료 노출이 없었다고 단정하지 않는다.

## 회귀 검증

MailApp의 실제 전송 경계만 시험 대역으로 교체하고 저장소의 Central.gs 전체를 Node VM에서 실행했다. 합성 키·보고서·시간만 사용했다. 운영 중계에 POST하지 않았고 실제 이메일·Discord 메시지는 0건이다.

- 기존 코드에서 새 보안 요구 7건 실패·2건 기존 보호 통과를 확인한 뒤 구현했다.
- 새 중계 코드 표시 테스트에서 RATE_LIMIT이 UNKNOWN으로 취급되는 실패를 재현한 뒤 클라이언트 고정 문구를 추가했다.
- 리뷰에서 별칭 자격증명 필드와 문자열 원문/속성 이름 경로를 추가로 재현·수정했다. 잘린 개인키 PEM의 반복 탐색도 실패 회귀로 재현해 문자열 끝까지 한 번에 정화하도록 고쳤다.
- 위조 제출 가능/수신자 고정, 재시작·ID 변경 단기 제한, 날짜별 20회, 일일 바이트 예산, 한글 UTF-8/첨부 크기, 비밀 필드·이름·본문 정화, 잠금 경쟁, 공급자 불확실 실패, 새/구형 영수증, 90일 보관량/저장 부족, 긴급 차단을 검증했다.
- 최종 후보만 포함한 격리 사본에서 전체 **1,286/1,286 통과**, 실패·스킵 0건을 확인했다. 이메일 관련 23건(신규 보안 회귀 17건 포함)도 통과했다. `central:build`(기존 UI 산출물 검증·확장 빌드), `central:check`, `check`, TypeScript와 diff 검사를 통과했다. 초기 Linux 사본의 전체 실행은 중앙 UI 의존성이 없어 39건 실패했다. 최종 전체 검증은 저장소 고정 버전 의존성(React 19.2.4, TypeScript 5.9.3, Vite 7.3.1)이 있는 macOS 별도 사본에서 수행했다. 다른 작업 사본의 병행 보안 수정은 포함하지 않았다.

## 배포·탐지 처리 상태

**이 문서는 운영 적용 완료 증거가 아니다.** Apps Script 관리 화면은 로그인된 프로젝트 대신 공개 안내 페이지를 반환했다. GitGuardian 대시보드는 로그인 화면이며 경고의 현재 상태를 읽거나 변경하지 않았다. Gmail에는 해당 알림만 확인되었으며, 후속 메일 부재는 해결 여부를 증명하지 않는다.

따라서 실제 배포 버전·REPORT_KEY 일치·MailApp 권한 범위·운영 한도·Cloud Logging 상태와 GitGuardian 최종 상태는 미확인이다. 원래 구현 문서의 11월 3일 실메일 성공은 과거 기록이며 현재 코드/배포 일치의 증거로 사용하지 않았다. 키 회전·경고 ignore/resolved 처리·운영 코드 배포도 수행하지 않았다.

공개 키는 현재 배포와 기존 설치의 연결을 유지하기 위해 변경하지 않았다. 실제 비밀정보가 추가로 확인되는 경우에만 해당 권한을 폐기·교체한다. 탐지 예외가 필요하면 실제 매칭 위치와 제출 전용 권한을 확인한 후 해당 사건만 근거와 함께 분류해야 하며, 전체 저장소나 Generic High Entropy 검사를 일괄 제외하지 않는다.

업데이트 PR #2(`fix/atomic-update-recovery`, 0.4.43)는 별도로 열려 있다. 이번 변경은 버전 번호·업데이트 실행기·발송 코어·확장 코드를 바꾸지 않는다. Apps Script는 GitHub 병합 후 별도 배포가 필요하다. 적용·중단·이행 절차는 [EMAIL-SUPPORT.md](EMAIL-SUPPORT.md#운영-적용과-사고-대응)를 따른다.

## 근거

- [탐지 커밋](https://github.com/JangKroed/dico-chat-while/commit/66f7df42aa8440786291caca83f28251f1c0ab46)
- [검토 기준 main](https://github.com/JangKroed/dico-chat-while/commit/cf18098e12368dd87d83960f333a14b365e6b3a3)
- [GitGuardian Generic High Entropy detector](https://docs.gitguardian.com/secrets-detection/secrets-detection-engine/detectors/generics/generic_high_entropy_secret): 이름·문자열 특성 기반 탐지이며 특정 Google 권한 검증 결과가 아님.
- [Google Web apps](https://developers.google.com/apps-script/guides/web): 실행 주체와 doPost 이벤트 필드.
- [MailApp](https://developers.google.com/apps-script/reference/mail/mail-app): send_mail 범위, 전송 API. Gmail 읽기 API가 아님.
- [Quotas](https://developers.google.com/apps-script/guides/services/quotas): 공급자 할당량·동시 실행·속성 9KB/값·500KB/저장소. 공급자 한도는 변경 가능하며 코드의 더 작은 예산을 대체하지 않음.
- [Logging](https://developers.google.com/apps-script/guides/logging): 실행 로그·Cloud Logging·Error Reporting은 별도의 운영 확인 대상.
