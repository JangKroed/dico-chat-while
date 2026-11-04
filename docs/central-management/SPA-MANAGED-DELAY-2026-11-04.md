# SPA 채널 이동 뒤 관리 대기 거절 재현

## 실제 브라우저 증거

2026-11-04 Chrome for Testing 156.0.8078.4에서 임시 프로필·시험 확장을 실행했다. Discord DNS를 차단하고 CDP로 빈 HTML 문서를 공급했으며 실제 로그인·계정·메시지는 사용하지 않았다.

`scripts/central-managed-delay-browser-check.mjs`는 현재 저장소의 `managed-delay.js`를 시험 확장에 복사해 직접 호출한다.

| 값 | 최초 로드 | history.pushState 이동 후 |
| --- | --- | --- |
| 현재 경로 | /channels/111/222 | /channels/111/333 |
| sender.url | /channels/111/222 | /channels/111/222 |
| sender.tab.url | /channels/111/222 | /channels/111/333 |
| chrome.tabs.get().url | /channels/111/222 | /channels/111/333 |
| sender.documentId | 동일 문서 A | 동일 문서 A |
| sender.frameId | 0 | 0 |
| 기존 managedPageDelay 결과 | ok:true | DELAY_ROUTE_MISMATCH |

`sender.url`은 SPA 이동 뒤에도 content script가 시작된 문서 URL을 유지한다. 따라서 이 값을 현재 Discord 채널로 해석하는 검사가 잘못되었다. 실제 Chrome과 운영 함수의 조합으로 해당 결함을 확정했다.

기존 메일의 PREPARE 즉시 실패와 부합하지만, 과거 제보에는 sender.url과 sender.tab.url이 없어 그 특정 4회 시도의 상태를 소급해 입증한 것은 아니다. 현재 사용자 설치가 0.4.35에 남아 있다는 점과 수정 코드의 배포 여부도 별도로 확인해야 한다.

## 수정과 안전 조건

평상시 경로가 일치하는 요청은 기존 경량 대기를 유지한다. `sender.url`과 `sender.tab.url`이 다를 때만 기존 scripting 권한으로 **발신 documentId를 지정**하여 현재 location.href를 읽는다. 반환된 documentId·frameId=0·Discord origin을 확인하고 대기 전후에 동일 검사를 반복한다. 문서를 찾지 못하거나 비활성 lifecycle이면 거절한다. 대기 도중 세션 변경도 거절한다.

이 조회는 location만 읽으며 페이지 입력·초안 수정·전송을 수행하지 않는다. 대기 자체는 발송 허가가 아니므로 기존 계정·채널·초안·세션 승인 절차는 별도로 유지한다. 새로운 확장 권한은 추가하지 않았다.

실제 Chrome 재실행에서 SPA 이동 뒤 `ok:true`를 확인했다. 단위/통합 테스트는 다른 경로·다른 출처·문서 부재·문서 교체·비활성 문서·조회 오류·세션 변경 거절을 확인한다. 담당 테스트 명령은 다음과 같다.

```
node --test tests/central-managed-delay.test.js tests/two-phase-content.test.js tests/central-content-lifecycle.test.js
```

108개 테스트가 통과했다. 브라우저 재현은 `DICO_BROWSER_BINARY`에 Chrome for Testing 실행 경로를 지정한 뒤 `node scripts/central-managed-delay-browser-check.mjs`로 실행한다.

브라우저 fixture의 최종 추가 검증도 통과했다. 동일 문서 SPA 이동은 `ok:true`, 대기 중 세션 교체는 `DELAY_SESSION_MISMATCH`, 전체 페이지 이동 뒤 이전 documentId로 요청하면 `DELAY_DOCUMENT_UNAVAILABLE`이다. 기존 함수의 실패 재현과 수정 후 성공·차단 검증을 같은 Chrome 버전에서 수행했다.
