# Setup automation implementation and verification

**Goal:** 기존 확장 사용자가 도구 준비부터 로컬 중앙관리 설치까지 재현할 수 있도록 자동 설정과 프로그램 내 진단을 제공한다.

**Architecture:** OS별 진입 스크립트가 지원 런타임을 선택하고 Node CLI가 기존 빌드·검사·패키저·설치기를 순차 재사용한다. 인증된 읽기 전용 진단 API를 설정 화면에 연결한다.

**Constraints:** 실제 사용자 기기의 도구 설치·네이티브 호스트 등록·발송은 개발 중 실행하지 않는다. OS 권한·전역 PATH·브라우저 프로필을 변경하지 않는다. Android는 향후 웹 컨트롤러이며 서버는 PC이다.

- [x] 지원 Node 판정, 무변경 계획, 실행 중 서비스 보호, 실패 시 중단과 실제 destination 설치를 테스트한다.
- [x] macOS/Windows 진입 스크립트와 프로젝트 내부 Node 준비·체크섬 검증을 구현한다.
- [x] portable Node가 모든 자식 프로세스에 적용되도록 프로세스 PATH를 구성하고 빈 PATH 회귀를 검사한다.
- [x] 세션 인증된 설치 진단과 UI 재검사·오류 상태를 구현한다.
- [x] 기존 사용자 도구 설치·전환·업데이트 문서와 LAN/Android 역할 설계를 기록한다.
- [x] 독립 검토로 Windows 5.1 인수 전달 및 UTF-8 BOM 문제를 확인하고 수정한다.
- [x] 전체 319개 테스트, UI 빌드, 전용·기존 확장 검사와 실제 loopback HTTP 진단을 검증한다.

**Limitations:** Windows PowerShell/MSVC 및 신규 Node 다운로드·설치 흐름을 실제 사용자 OS에서 실행하지 않았다. 브라우저 GUI 검증은 남아 있다. LAN 다기기·Android 접속은 설계 단계이며 현재 0.4에서 활성화하지 않는다. 자세한 범위는 `docs/central-management/MULTI-DEVICE.md`를 따른다.
