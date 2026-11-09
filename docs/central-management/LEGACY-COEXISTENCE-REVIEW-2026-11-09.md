# 구형 확장 동시 활성화 충돌 검토

범위: 저장소의 단독 확장 0.3.0 코드와 중앙관리 실행기 코드. 사용자 첨부 화면의 정확한 설치 빌드·발송 시간별 로그는 미확인. 구형 코드와 운영 상태는 변경하지 않음.

## 결론

설치·활성화만으로 오류가 반드시 발생하는 것은 아니다. 하지만 둘 다 동일 계정·채널에서 자동 발송을 실행하면 입력/초안/발송 시점 충돌 가능성이 있다. 현재 중앙관리에는 별도 확장의 실행 상태를 강제로 확인하는 상호 배제 장치가 없다. 실제 첨부 사례의 오류 원인으로 확정할 근거는 없다.

## 근거

- 단독 manifest.json과 중앙 central/extension/manifest.json 모두 Discord 페이지에 content script를 주입한다. 중앙은 고정 key를 사용하며 별도 ID의 구형 확장과 함께 존재할 수 있다.
- content.js의 __dicoWhileLoaded, busy, seenDeliveries는 콘텐츠 스크립트의 JavaScript 상태다. Chrome 공식 문서상 각 확장은 isolated world를 사용하므로 별도 확장의 변수는 공유되지 않는다. 이 잠금은 두 확장의 전역 실행 잠금이 아니다.
- content.js의 paste/keydown/keyup는 같은 페이지의 입력창 DOM에 적용된다. 같은 탭이면 한쪽의 준비된 초안을 다른 쪽이 바꾸거나 Enter 시점이 겹칠 수 있다. 별도 탭이어도 동일 계정·채널이면 Discord 슬로우모드와 전체 발송 간격은 함께 영향을 받는다.
- background.js의 DICO_CAN_SEND는 단독 확장 자신의 enabled/pending/scheduledAt를 검증한다. 중앙관리 허가와 공유하지 않는다. 중앙의 그룹 30초 보장은 구형 확장이 발송한 시각을 자동으로 포함하지 않는다.
- central/extension/background.js connect의 chrome.storage.local.get('state')는 현재 확장 자신의 저장소 확인이다. 동일 ID 업그레이드의 기존 상태는 감지할 수 있지만 별도 ID 구형 확장의 저장소를 읽는 검사가 아니다.
- publishObservation의 legacyFrozen:Boolean(executor.state.legacyDeclaration), legacyPending:false는 declareLegacy로 저장한 사용자 확인을 바탕으로 한다. 다른 확장이 이후 다시 실행되면 자동으로 감지된다고 볼 수 없다.
- 중앙에서 채널 탭을 재사용할 때 DICO_CONTENT_STATUS로 조회하는 busy 역시 자기 확장 콘텐츠의 상태다. 다른 확장의 busy까지 확인하는 장치가 아니다.
- composer_cleared는 입력창 비움 근거이며 서버 게시 직접 조회가 아니다. 다른 실행기가 같은 편집기를 건드리는 환경에서 결과 해석이 더 어려워질 수 있다. 이 사례에서 실제 오판했다는 증거는 확보되지 않았다.

## 조건별 판정

| 조건 | 판단 |
| --- | --- |
| 구형 확장이 설치·활성화됐지만 모든 예약/발송이 중지됨 | 활성화 자체만으로 발송 충돌이 확정되지는 않음 |
| 같은 탭에서 양쪽 자동 발송 실행 | 초안·Enter·완료 관찰 경쟁 가능 |
| 다른 탭, 같은 계정·채널에서 실행 | 공유 슬로우모드·발송 간격·중복 공지 가능 |
| 다른 계정·채널에서 실행 | 직접 입력 충돌 가능성은 낮지만 중앙이 구형 실행을 통제하지 못함 |
| 중앙관리에서만 중지 | 별도 구형 실행기까지 중지됐다는 의미가 아님 |

안정적인 중앙관리 동작을 평가하려면 구형 발송 예약이 중지된 상태와 동시 실행 상태를 구분해야 한다. 본 작업에서 사용자의 구형 확장을 임의 중지·삭제·비활성화하지 않았다.

## 확인 한계

연결된 Mac의 Chrome Default/Profile 2 및 Brave Default Preferences에서 중앙 실행기 0.4.64 등록 메타데이터를 확인했다. 이 제한된 조회에서 구형 이름의 항목은 발견하지 못했으며 이것이 구형 미설치/미실행의 완전한 증명은 아니다. 화면에 나온 다른 PC의 실시간 상태는 확인하지 못했다. 격리 브라우저 테스트는 SIGABRT로 시작하지 못해 실제 두 확장의 동시 발송 재현은 수행하지 않았다.

공식 문서: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
