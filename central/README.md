# DICO 중앙관리 0.4 개발판

PC 한 대의 여러 Chrome·Brave 프로필을 중앙 페이지에서 관리합니다. 메시지 보관함, 채널별 문구 목록, 계정 순환, 실시간 로그·그래프와 PC 알림을 제공합니다. 데이터는 현재 OS 사용자에게 따로 저장됩니다.

## 현재 설치 범위와 여러 기기 계획

현재 0.4와 아래 설정 스크립트는 **PC 한 대 안의 로컬 중앙관리**를 설치합니다. 각 PC의 데이터·실행 순서는 독립적이며 PC 사이의 전역 발송 순서를 조정하지 않습니다.

계획 중인 LAN 구성은 중앙 허브 PC가 여러 실행 PC를 관리하고 Android에서는 브라우저로 제어·상태 확인을 하는 역할입니다. Android에 Git·Node·브라우저 확장을 설치하는 절차는 아닙니다. 이 LAN 기능은 아직 현재 설치본에 구현된 기능으로 안내하지 않습니다. [여러 기기 역할과 확장 계획](../docs/central-management/MULTI-DEVICE.md)을 참고하세요.

## 기존 확장 사용자: 클론으로 설치·전환

[Git 클론 설치·백업·전환·업데이트 상세 안내](../docs/central-management/CLONE-SETUP.md)를 먼저 확인하세요. macOS·Windows 명령, 기존 자동 업데이트 중지, 전용 확장 등록, 기기 이동과 되돌리기를 설명합니다.

## 클론 후 자동 설정

Git 설치부터 필요한 경우 위 상세 안내의 macOS 3-1 / Windows 4-1을 따르세요. macOS는 `xcode-select --install`의 설치 창을 끝낸 뒤 `git --version`을 확인합니다. Windows는 `winget install --id Git.Git -e --source winget`으로 설치할 수 있으며, winget이 없으면 Microsoft Store의 **앱 설치 관리자**가 필요합니다. [공식 winget 안내](https://learn.microsoft.com/windows/package-manager/winget/)와 [Git 설치 안내](https://git-scm.com/install/windows)를 참고하세요.

저장소를 고정 경로에 클론한 뒤 루트 폴더에서 **자신의 OS에 맞는 명령 하나**를 실행합니다. 기존 서비스와 발송은 먼저 정상 종료합니다.

macOS:

```sh
bash ./setup.command
```

Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

Node 사전 설치는 필요하지 않습니다. 호환되는 시스템 Node 24.13 이상인 24.x를 사용하고, 없으면 공식 Node.js 24.13.0을 macOS에서는 CPU에 맞게, Windows에서는 win-x64 ZIP으로 내려받아 SHA-256 확인 후 `.dico-tools/`에 풉니다. Windows 설정 스크립트는 x64 PC만 지원하며 Windows ARM은 지원·검증 대상이 아닙니다. 전역 Node나 PATH는 변경하지 않습니다. Windows의 `-ExecutionPolicy Bypass`는 해당 프로세스에만 적용되며 영구 실행 정책 변경은 필요하지 않습니다.

Windows 소스 패키징에는 MSVC와 Windows SDK가 필요합니다. 스크립트는 `vswhere`로 설치된 Build Tools를 찾아 `VsDevCmd`의 x64 컴파일러 환경을 사용합니다. 미설치 상태에서는 안내 후 중단하며 Build Tools를 자동 설치하지 않습니다. 필요하면 사용자가 직접 다음 명령을 실행하고 설치 완료·재부팅 요청을 처리합니다.

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --source winget --override '--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
```

[공식 C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)의 GUI 설치와 [Node.js 24.13.0 수동 다운로드](https://nodejs.org/dist/v24.13.0/)도 사용할 수 있습니다. 전체 수동 빌드·설치 명령은 상세 안내에 있습니다.

자동 설정은 의존성 설치·빌드·검사·테스트·패키징·현재 사용자 설치를 진행한 뒤 설치된 포함 Node로 서비스를 실행하고 페이지를 엽니다. 해당 터미널을 유지하고 Ctrl+C로 종료합니다. 성공하면 상세 안내의 **5장: 새 확장 등록과 설정 이전**을 진행하세요. 아래 배포 파일 설치나 수동 빌드를 중복 실행하지 않습니다. 설정 스크립트는 `git pull`을 자동으로 실행하지 않습니다.

읽기 전용 상태·계획 확인에는 macOS 명령 뒤에 `--doctor` 또는 `--dry-run`, Windows PowerShell 명령 뒤에는 `-Doctor` 또는 `-DryRun`을 붙입니다. 이 모드는 Node 다운로드나 파일·설정 변경을 하지 않습니다. Node가 있으면 `--dry-run` / `-DryRun`으로 설치·페이지 열기를 포함한 전체 계획을 확인할 수 있습니다. Node가 없으면 준비가 필요하다고 알리고 종료 코드 1로 끝납니다. Node가 이미 있다면 직접 CLI도 사용할 수 있습니다.

```sh
node scripts/setup-central.mjs --doctor
node scripts/setup-central.mjs --dry-run
node scripts/setup-central.mjs --install --open
```

직접 CLI를 옵션 없이 실행하면 빌드·검사·테스트·패키징까지만 진행하고 현재 사용자 설치는 하지 않습니다. 실제 설정은 실행 중 서비스가 있으면 생성 파일 변경 전에 중지를 요구합니다. 중앙 페이지의 **설정 · 도움말 → 설치 · 연결 진단 → 다시 확인**은 상태만 다시 읽으며 설치나 업데이트를 실행하지 않습니다.

## 배포 파일 사용

1. 자신의 OS·CPU용 배포 폴더를 압축 해제합니다. macOS는 `install.command`, Windows는 Windows에서 빌드한 배포본의 `install.cmd`를 실행합니다. 포함된 Node 런타임을 사용하므로 Node.js 별도 설치는 필요 없습니다.
2. 설치 후 중앙 페이지가 열립니다. Chrome·Brave의 확장 관리 화면에서 개발자 모드를 켜고 배포 폴더의 `extension/`을 로드합니다. 이 개발판은 스토어 자동 설치본이 아닙니다.
3. 확장 팝업에서 기존 실행기 사용 여부를 확인합니다. 기존 Dico While 0.3.0은 먼저 중지·비활성화하고 미확인 발송을 해소해야 합니다. 새 확장은 별도 ID이므로 구형 확장의 종료나 데이터를 자동으로 확인했다고 주장하지 않습니다.
4. 각 브라우저에서 Discord 채널을 열고 팝업의 `현재 Discord 채널 연결`을 누릅니다. 전송용 창이 따로 생깁니다. 프로필 이미지에서 계정 ID가 확인되지 않는 경우에는 연결을 차단합니다.
5. 중앙 페이지에서 메시지를 작성하고 채널에 선택·적용합니다. 확장 적용 완료 후 같은 채널의 계정들을 그룹에 넣고 순서와 간격을 설정합니다.
6. 요약을 확인하고 시작합니다. 페이지를 닫아도 서비스가 켜져 있으면 동작하지만, PC 절전·브라우저/서비스 재시작 뒤에는 확인 후 재개해야 합니다.

IP·포트·토큰은 입력하지 않습니다. 설치 프로그램은 현재 OS 사용자에게만 네이티브 호스트를 등록합니다. 로그인 시 자동 시작은 설치 명령에 `--autostart`를 추가한 경우에만 등록합니다. 이 개발판의 설정 화면에서 OS 자동 시작 등록을 직접 변경하지는 않습니다.

이미 실행 중인 관리 프로그램이 있으면 설치·제거를 거부합니다. 진행 중 발송을 해소하고 프로그램을 종료한 뒤 진행하세요. 제거는 메시지·설정·기록 데이터 폴더를 삭제하지 않습니다. 명시적으로 종료한 프로그램을 확장의 자동 재연결이 다시 켜지 않도록 종료 표식을 유지합니다.

현재 macOS Apple Silicon 개발 배포본은 서명·공증되지 않았습니다. Windows 배포 스크립트·네이티브 런처 소스는 포함했지만 Windows 실기기에서 빌드·실행한 결과는 별도로 확인해야 합니다. macOS Intel도 해당 CPU에서 패키징·검증이 필요합니다.

## 알림과 기록

설정에서 PC 알림을 켜고 테스트할 수 있습니다. 실제 Discord 테스트 메시지를 보내는 버튼이 아닙니다. 기본 알림은 미확인 발송·연결 문제 등 필요한 사건만 대상으로 하며 본문은 알림에 넣지 않습니다. OS 집중 모드·권한에 따라 표시가 제한될 수 있습니다.

현재 어댑터는 macOS 알림과 Windows 시스템 트레이 알림 요청을 지원합니다. OS 알림 클릭의 상세 페이지 연결, OS별 권한 상태 자동 판정, 별도 서비스 감시기·휴대폰 푸시는 아직 제공하지 않습니다. 미해결 문제는 중앙 알림 센터에서 계속 확인할 수 있습니다. 서비스 전체가 종료된 동안에는 즉시 알림을 보장하지 않습니다.

실행 기록의 `미확인`은 성공이 아닙니다. 결과 확인은 실제 게시 ID나 실행 차단 근거를 사용합니다. 같은 시도를 다시 보내지 않고 기존 결과를 재확인합니다. 로그·통계에는 중앙 관측과 게시 근거의 차이, 표본 부족·보존 범위의 한계를 표시합니다.

## 기존 설정과 백업

설정에서 새 중앙 백업 또는 기존 `dico-settings` v1 JSON을 가져올 수 있습니다. 기존 A/B 문구는 별도 메시지로 가져오며 다음 문구 B의 위치를 보존합니다. 복원된 계정·채널은 재연결해야 하고 그룹은 정지 상태로 생성됩니다. 같은 기존 자료의 반복 가져오기는 원본 ID 기준으로 중복을 막습니다.

같은 OS 사용자 권한을 가진 다른 프로그램까지 격리하는 도구는 아닙니다. 사용자 폴더·DB·WAL·SHM과 연결 descriptor는 제한된 권한으로 생성합니다. 연결 비밀은 UI·Discord 탭·백업에 전달하지 않습니다.

## 저장소에서 개발·검증

기존 0.3.0 확장과 새 중앙 실행기는 별개입니다. 새 서비스는 내장 SQLite를 위해 Node.js 24.13 이상을 사용하며 현재 패키징은 Node 24 계열을 요구합니다. 사용자를 위한 패키징에는 런타임을 포함합니다.

```sh
npm --prefix central/ui ci
npm run central:build
npm run central:check
npm test
npm run central:dev
```

브라우저에서 개발용 전용 실행기를 로드할 때는 `central/extension/`을 선택합니다. `central:build`가 root의 검증된 content·emoji 파일을 준비합니다. 실행 서비스의 기본 데이터 폴더는 macOS `~/Library/Application Support/DICO`, Windows `%LOCALAPPDATA%\DICO`입니다. 개발 시험은 다음처럼 별도 경로를 지정할 수 있습니다.

```sh
node central/runtime/main.mjs --data-dir /tmp/dico-development --open
```

패키지는 대상 OS에서 만듭니다. Windows는 실제 네이티브 런처 빌드를 위해 MSVC `cl.exe`가 준비돼 있어야 합니다.

```sh
npm run central:package
node scripts/central-ui-browser-check.mjs
```

브라우저 검증 스크립트는 임시 프로필과 테스트 데이터만 사용합니다. 현재 작업 환경에서는 Chrome·Brave 헤드리스 프로세스가 SIGABRT로 종료되어 화면 검증을 완료하지 못했습니다. 실제 Discord 발송, 사용자 OS에 호스트 등록, 자동 시작 설치는 개발 중 실행하지 않았습니다.

## 설계 문서

[제품·UI/UX·기술·로그 기획](../docs/central-management/README.md)과 [구현 계획](../docs/superpowers/plans/2026-10-30-central-implementation.md)을 참고하세요. 기획 전체와 이번 개발판의 제공 범위가 다를 수 있으므로 이 문서의 제한과 실제 검증 결과를 함께 확인합니다.
