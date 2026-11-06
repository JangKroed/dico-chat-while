# 운영 UI 검토

Jakub Krehel의 [디자인 스킬](https://jakub.kr/skills) 중 `better-writing`, `interface-review`, `state-machine`을 운영 화면에 사용한다. 원본 검토 기준은 `jakubkrehel/skills@60bf140e43c98b248e6594487384ec967e89d98a`다.

| 상황 | 검토 방법 |
| --- | --- |
| 발송·연결 상태 문구 변경 | `better-writing`으로 그룹과 계정이 동일한 상태를 같은 용어로 표시하는지 확인한다. |
| UI PR 검토 | `interface-review`로 변경된 화면의 키보드 접근, 읽기 순서, 상태 문구를 검토한다. |
| 드물게 나타나는 복구 상태 | `state-machine`으로 실제 컴포넌트에 모의 상태를 주입해 점검한다. 운영 계정이나 Discord 발송은 사용하지 않는다. |

첫 적용에서는 Enter 전 슬로우모드가 그룹 화면에선 제한 해제 대기, 계정 화면에선 발송 확인으로 표시되던 차이를 수정했다. 두 화면이 같은 문구를 표시하며, 다음 계정은 차례 대기, 슬로우 해제 뒤 결과 대기는 발송 확인으로 구분한다.
