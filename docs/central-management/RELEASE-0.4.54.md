# DICO 0.4.54 초안 검사 실패 진단

발송 허가 전 초안 검사 실패의 세부 코드를 명령 기록과 자동 제보에 남긴다. 기존 재시도와 차례 전환 정책은 유지한다.

- `TARGET_MISMATCH`, `ACCOUNT_UNVERIFIED`, `ACCOUNT_UNREADABLE`은 대상 채널이나 로그인 계정 확인 문제다.
- `EDITOR_LOADING`, `EDITOR_AMBIGUOUS`는 확인 가능한 입력창이 없거나 여러 개인 경우다.
- `TAB_REQUEST_FAILED`는 탭 요청 예외, `DRAFT_RESPONSE_INVALID`는 응답 없음 또는 형식 불일치다. 기존 조회 시간 초과 코드는 별도로 유지한다.

허용 목록의 코드만 전달하며 초안, 메시지 본문, 브라우저 오류 원문은 이 필드에 저장하지 않는다. 기존 기록에는 세부 코드가 없으므로 이 버전 적용 후 발생하는 실패부터 확인할 수 있다.
