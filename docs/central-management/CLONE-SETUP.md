# 기존 확장 사용자용: Git 클론으로 중앙관리 0.4 설치하기

대상: 기존 Dico While 확장이 설치된 Chrome·Brave 사용자. macOS / Windows에서 한 PC의 여러 브라우저·프로필을 관리합니다. 기준: 2026-10-31, 중앙관리 0.4 개발판.

이 문서는 **기존 확장을 중지·보존하고 새 중앙관리 전용 확장으로 전환하는 절차**입니다. 저장소 루트의 기존 확장을 새로고침하는 것만으로 중앙관리로 바뀌지 않습니다. 스토어 등록이나 유료 개발자 계정은 필요하지 않습니다. 미서명 개발판이며 Windows·Intel Mac 실기기 검증과 브라우저 GUI 검증은 아직 완료되지 않았습니다.

## 1. 설치 구조와 준비물

| 구분 | 역할 | 처리 |
| --- | --- | --- |
| 기존 확장 | 기존 A/B 예약 발송 | 백업 후 모든 프로필에서 비활성화 |
| 기존 DICO Updater | 기존 확장 정식 릴리즈 자동 적용 | 기존 확장 안에서 자동 적용 끄기 |
| 클론 폴더 | 소스·빌드 결과·새 확장 원본 | 고정 경로에 유지 |
| 중앙관리 프로그램 | 메시지·순서·로그 관리 | 현재 OS 사용자에게 설치 |
| 새 전용 확장 | 브라우저와 로컬 관리 프로그램 연결 | 각 브라우저·프로필에 별도 등록 |

새 확장의 고정 ID는 `ibkkihhaihlpjcahglnoiphcddcjipgh`입니다. 기존 확장의 ID를 바꾸거나 기존 폴더를 덮어쓰지 마세요. 새 확장은 `central/extension/`이며 저장소 루트가 아닙니다.

준비물:

- Git와 의존성 다운로드용 인터넷. **Node.js를 미리 설치하지 않아도 됩니다.** 아래 `setup.command` / `setup.ps1`이 호환되는 Node가 없으면 공식 Node.js 24.13.0을 저장소의 `.dico-tools/`에 받아 사용합니다. 시스템 Node·PATH를 전역 변경하지 않습니다.
- Chrome 또는 Brave. 그 밖의 Chromium 브라우저는 네이티브 호스트 자동 등록 대상에 포함되지 않습니다.
- 저장소가 비공개라면 GitHub 계정의 읽기 권한. 비밀번호나 토큰을 clone URL에 넣지 말고 Git 자격증명 관리자의 인증 절차를 사용하세요.
- Windows에서 소스로 패키지를 만들려면 무료 Visual Studio Build Tools의 **Desktop development with C++ / MSVC 및 Windows SDK**가 필요합니다. 설치 방법은 4-1을 따릅니다. 설정 스크립트는 이미 설치된 컴파일러 환경을 찾지만 Build Tools 자체를 자동 설치하지 않습니다. 이미 만든 Windows 배포본을 전달받은 경우에는 Build Tools가 필요 없습니다.

설정 스크립트는 **의존성 설치 → 빌드 → 검사·테스트 → 패키징 → 현재 사용자에게 설치 → 중앙 페이지 열기**를 순서대로 실행하며 오류가 나면 멈춥니다. 설치된 프로그램의 포함 Node로 서비스를 터미널에서 계속 실행하므로 터미널을 유지하고 종료할 때 Ctrl+C를 누릅니다. 브라우저 확장 등록과 기존 데이터 이전은 5장에서 직접 진행합니다. 자동 절차와 아래 수동 절차는 **둘 중 하나만** 사용하세요.

각 기기는 독립 작업 공간입니다. 같은 저장소를 클론해도 메시지·설정·로그는 동기화되지 않습니다. 같은 Discord 계정을 여러 PC에서 동시에 자동 실행하지 마세요. PC 사이의 발송 순서는 조정하지 않습니다.

### 현재 PC 설치와 향후 여러 기기 역할

이 문서와 설정 스크립트가 설치하는 0.4는 **한 PC 안의 로컬 중앙관리**입니다. 여러 PC를 설치해도 서로 독립적으로 동작하며 전역 발송 순서를 공유하지 않습니다.

향후 LAN 구성에서는 중앙 허브 PC가 여러 실행 PC를 관리하고 Android 브라우저는 제어·상태 확인 화면을 맡도록 계획합니다. 현재 설치본에 LAN 제어가 구현되었다는 뜻은 아닙니다. Android에는 이 문서의 Git·Node·브라우저 확장 설치를 진행하지 마세요. [여러 기기 역할과 확장 계획](MULTI-DEVICE.md)을 참고하세요.

## 2. 먼저 기존 확장을 백업하고 중지하기

이 단계는 Chrome A, Brave B, 다른 Chrome 프로필 C 등 **사용 중인 모든 프로필에서 반복**합니다.

1. 기존 확장의 자동 적용 항목이 있다면 **새 버전이 있으면 안전한 상태에서 자동 적용**을 끕니다. 기존 보조 프로그램은 새 중앙관리 업데이트에 사용하지 않습니다.
2. 기존 확장에서 모든 채널의 발송을 중지합니다. 진행 중이거나 미확인인 발송은 Discord 실제 게시 결과와 대조합니다. 성공인지 모르는 시도를 다시 보내서 확인하지 마세요.
3. 기존 확장 팝업의 **설정 백업**으로 JSON을 저장합니다. 파일명에 `Chrome-계정A`, `Brave-계정B`처럼 출처를 덧붙여 별도 보관합니다. JSON 내용은 수정하지 않습니다.
4. 문구 A/B, 다음 차례, 채널, 발송 주기를 기록합니다. 백업에 로그인 계정 정보·연결 비밀·운영 로그 전체가 들어가는 것은 아닙니다.
5. 기존 전송용 창에 남은 초안을 확인하고 창을 닫습니다. 실제 게시된 메시지를 삭제하라는 뜻이 아닙니다.
6. Chrome은 `chrome://extensions`, Brave는 `brave://extensions`에서 **기존 Dico While 확장의 스위치를 끕니다.** 아직 삭제하지 않습니다.
7. 기존 조정기(coordinator)를 별도로 실행했다면 해당 터미널에서 Ctrl+C로 종료합니다. 다른 PC에서도 동일 계정이 실행 중이지 않은지 확인합니다.

백업 JSON에는 개인 메시지가 포함될 수 있습니다. 저장소 안에 두거나 GitHub에 올리지 마세요. 새 확장은 다른 확장의 중지 여부를 자동으로 증명하지 못하므로 사용자가 직접 확인해야 합니다.

## 3. macOS: 클론·빌드·설치

### 3-1. Git 설치와 고정 폴더에 클론

터미널에서 먼저 확인합니다.

```sh
git --version
```

Git가 없거나 개발자 도구 설치 안내가 나오면 다음 명령을 실행합니다.

```sh
xcode-select --install
```

macOS 설치 창에서 동의·설치를 끝낸 뒤 새 터미널에서 `git --version`이 버전을 출력하는지 확인합니다. 명령을 실행한 것만으로 설치가 끝난 것은 아닙니다. 전체 Xcode 앱은 필요하지 않습니다. 다른 설치 방법은 [Git 공식 macOS 안내](https://git-scm.com/install/mac)를 참고하세요.

Git가 준비되면 클론합니다.

```sh
git --version
mkdir -p "$HOME/Applications"
cd "$HOME/Applications"
git clone https://github.com/JangKroed/dico-chat-while.git
cd dico-chat-while
git branch --show-current
git rev-parse --short HEAD
```

브랜치는 `main`인지 확인합니다. 이미 이 경로에 클론했다면 다시 클론하지 말고 [업데이트 절차](#7-이후-업데이트)를 사용하세요. 기존 확장이 사용하는 폴더와 같은 경로에 클론하지 마세요.

### 3-2. 권장: 자동 설정

클론 폴더에서 실행합니다. 실행 권한을 별도로 바꿀 필요가 없습니다.

```sh
bash ./setup.command
```

호환되는 시스템 Node **24.13 이상인 24.x**가 있으면 사용합니다. 없으면 Mac CPU에 맞는 공식 Node.js **24.13.0 darwin-arm64 또는 darwin-x64** 아카이브와 `SHASUMS256.txt`를 내려받고 SHA-256을 확인한 뒤 `.dico-tools/`에 풉니다. 이후 `node scripts/setup-central.mjs --install --open`을 실행합니다. M 계열 Mac에서 수동 Node를 사용하는 경우 `node -p process.arch`가 `arm64`인지 확인하세요.

다운로드·설치 없이 상태 또는 실행 계획만 보려면 아래 중 하나를 사용합니다. Node가 있으면 `--dry-run`은 설치·페이지 열기를 포함한 전체 실행 계획을 표시합니다. 이 모드들은 파일·설정·OS 설치 상태를 변경하지 않으며, Node가 없으면 먼저 Node 준비가 필요하다고 알리고 종료 코드 1로 끝납니다.

```sh
bash ./setup.command --doctor
bash ./setup.command --dry-run
```

성공하여 중앙 페이지가 열리면 아래 수동 절차를 반복하지 말고 **5장으로 이동**합니다. 실행 중인 서비스가 있다면 파일 생성·설치에 앞서 중지하도록 안내합니다. 전체 중지 버튼만으로 서비스 프로세스가 종료되지는 않으므로 6장의 종료 순서를 따르세요.

### 3-3. 수동 대안: Node 준비·의존성 설치와 빌드

자동 설정을 사용했다면 이 절차는 생략합니다. Node를 직접 관리하려면 [공식 Node.js 24.13.0 다운로드](https://nodejs.org/dist/v24.13.0/)에서 자신의 Mac CPU용 파일을 받습니다. 설치 파일을 사용했다면 새 터미널을 열고 확인합니다.

```sh
node --version
npm --version
node -p process.arch
```

Node는 **24.13 이상인 24.x**가 필요합니다. 루트 package.json의 Node 20 조건은 구형 확장 기준입니다. 패키징이 Node 24 계열을 검사하므로 Node 22 또는 25 이상으로 대체하지 마세요.

```sh
npm --prefix central/ui ci
npm run central:build
npm run central:check
npm run check
npm test
npm run central:package
```

각 명령이 성공한 뒤 다음 단계로 진행합니다. `central:build`는 UI와 새 확장에 필요한 content·emoji 파일을 준비합니다. 클론 직후에는 생성 파일이 없으므로 이 단계를 생략할 수 없습니다. UI만 개발 서버로 띄우는 `npm --prefix central/ui run dev`는 중앙관리 설치를 대신하지 않습니다.

패키징 마지막 JSON의 `destination`이 생성 폴더입니다. 예를 들어 M 계열 Mac + Node 24.13.0은 다음 경로입니다.

```text
dist/central-packages/dico-manager-darwin-arm64-node-24.13.0/
```

Intel Mac이면 `arm64` 대신 `x64`가 됩니다. **현재 터미널에서 실행되는 Node의 CPU 아키텍처**를 기준으로 생성하므로 M 계열 Mac은 네이티브 ARM64 Node를 사용하세요. `node -p process.arch`로 확인합니다. Intel 패키지는 해당 기기에서 별도 검증해야 합니다.

### 3-4. 수동 대안: 설치 후 관리 프로그램을 터미널에서 실행

아래 예시는 Apple Silicon / Node 24.13.0 기준입니다. 실제 destination과 다르면 `DICO_PACKAGE` 값만 바꾸세요.

```sh
DICO_PACKAGE="$PWD/dist/central-packages/dico-manager-darwin-arm64-node-24.13.0"
"$DICO_PACKAGE/runtime/node" "$DICO_PACKAGE/central/host/install.mjs" install --dry-run
"$DICO_PACKAGE/runtime/node" "$DICO_PACKAGE/central/host/install.mjs" install
"$HOME/Library/Application Support/DICO/app/runtime/node" "$HOME/Library/Application Support/DICO/app/central/runtime/main.mjs" --open
```

첫 명령은 설치 계획만 표시합니다. 두 번째는 현재 OS 사용자에게 프로그램을 복사하고 Chrome·Brave 네이티브 호스트를 등록합니다. 관리자 권한/sudo는 필요하지 않습니다. 세 번째는 중앙 페이지를 열고 **터미널에서 서비스를 계속 실행**합니다. 최초 테스트는 이 방식으로 진행하면 Ctrl+C로 정상 종료하기 쉽습니다. 해당 터미널을 유지하세요.

단순히 `node central/host/install.mjs install`을 소스 폴더에서 실행하면 안 됩니다. 생성 패키지에 있는 런처와 allowed_extensions.json이 필요합니다.

Finder에서 생성 폴더의 `install.command`를 실행하는 방식도 있지만, 이 방식은 서비스를 백그라운드로 엽니다. 이 문서의 최초 설치 절차와 중복 실행하지 마세요. 미서명 파일의 실행이 차단되면 출처를 확인하고 OS에서 허용 가능한지 확인합니다. 보안 기능을 전역으로 해제하는 명령은 사용하지 않습니다.

## 4. Windows: 클론·빌드·설치

**아직 Windows 실기기 검증을 완료하지 않은 개발 절차입니다.** macOS ZIP을 Windows에서 실행할 수 없습니다.

### 4-1. Git·Build Tools 설치와 클론

PowerShell에서 Git와 Windows 패키지 관리자를 확인합니다.

```powershell
git --version
winget --version
```

Git가 없다면 다음 명령으로 설치합니다.

```powershell
winget install --id Git.Git -e --source winget
```

`winget` 자체가 없으면 Microsoft Store에서 Microsoft의 **앱 설치 관리자(App Installer)**를 설치·업데이트한 뒤 새 PowerShell을 엽니다. [Microsoft 공식 winget 설치 안내](https://learn.microsoft.com/windows/package-manager/winget/)를 참고하세요. winget을 사용할 수 없는 환경에서는 [Git 공식 Windows 설치 프로그램](https://git-scm.com/install/windows)을 사용합니다. Git 설치 후 새 PowerShell에서 `git --version`을 다시 확인하세요.

소스 패키징용 컴파일러가 없다면 아래 명령을 **사용자가 직접 실행**합니다. 설정 스크립트가 이 설치 명령을 대신 실행하지는 않습니다.

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --source winget --override '--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
```

관리자 권한 동의나 재부팅을 요청할 수 있습니다. 설치가 끝날 때까지 기다린 뒤 필요한 경우 재부팅하고 새 PowerShell을 여세요. GUI로 설치하려면 [공식 Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)에서 **Desktop development with C++**, MSVC 및 Windows SDK를 선택합니다.

이제 고정 폴더에 클론합니다. Node 사전 설치는 필요하지 않습니다. 아래 명령은 한 줄씩 실행하고 오류가 나면 멈춥니다. PowerShell은 앞 명령이 실패해도 다음 명령을 실행할 수 있습니다.

```powershell
git --version
New-Item -ItemType Directory -Force "$HOME\Applications" | Out-Null
Set-Location "$HOME\Applications"
git clone https://github.com/JangKroed/dico-chat-while.git
Set-Location dico-chat-while
git branch --show-current
git rev-parse --short HEAD
```

브랜치가 `main`인지 확인합니다. 이미 클론한 폴더가 있으면 다시 클론하지 말고 7장의 업데이트를 따릅니다.

### 4-2. 권장: 자동 설정

클론 폴더의 PowerShell에서 실행합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

이 명령의 실행 정책 우회는 **해당 PowerShell 프로세스에만** 적용됩니다. 시스템·사용자 실행 정책을 영구 변경하는 `Set-ExecutionPolicy`는 필요하지 않습니다.

호환되는 시스템 Node **24.13 이상인 24.x**가 있으면 사용하고, 없으면 공식 Node.js **24.13.0 win-x64 ZIP**과 `SHASUMS256.txt`를 받아 SHA-256을 확인한 뒤 `.dico-tools/`에 풉니다. 전역 Node 설치나 PATH 변경은 하지 않습니다. `cl.exe`가 현재 환경에 없으면 `vswhere`로 설치된 Visual Studio Build Tools를 찾아 `VsDevCmd`의 x64 컴파일러 환경을 현재 프로세스에서 사용합니다. Build Tools가 없으면 4-1의 설치 명령을 안내하고 중단합니다.

그다음 `node scripts/setup-central.mjs --install --open`으로 빌드·검사·테스트·패키징·현재 사용자 설치를 진행합니다. 중앙 페이지가 열리면 터미널을 유지하고 **5장으로 이동**합니다. 수동 절차를 중복 실행하지 마세요. Windows 설정 스크립트는 **x64 PC만 지원**합니다. Windows ARM은 지원·검증 대상이 아닙니다.

읽기 전용 진단과 계획 확인:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -Doctor
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -DryRun
```

두 모드는 Node 다운로드나 파일·설정 변경을 하지 않습니다. Node가 있으면 `-DryRun`은 설치·페이지 열기를 포함한 전체 실행 계획을 표시합니다. Node가 없으면 준비가 필요하다고 알리고 종료 코드 1로 끝납니다. 실행 중 서비스가 있으면 실제 설정은 파일 생성·설치에 앞서 중지를 요구합니다.

### 4-3. 수동 대안: Node와 개발자 터미널 준비

자동 설정을 사용했다면 이 절차는 생략합니다. [공식 Node.js 24.13.0 다운로드](https://nodejs.org/dist/v24.13.0/)에서 Windows CPU에 맞는 설치 프로그램 또는 ZIP을 선택합니다. 설치 후 새 터미널을 엽니다. Node는 **24.13 이상인 24.x**여야 합니다.

**x64 Native Tools Command Prompt for VS**를 열고 `powershell -NoProfile`을 실행하면 MSVC 환경을 상속한 PowerShell에서 수동 빌드할 수 있습니다. 관리자 터미널은 필요하지 않습니다.

```powershell
node --version
npm.cmd --version
where.exe cl.exe
node -p process.arch
Set-Location "$HOME\Applications\dico-chat-while"
```

`cl.exe` 경로가 보여야 하며 일반적인 Intel·AMD PC의 Node 아키텍처는 `x64`입니다. `npm.cmd`를 사용하면 npm.ps1 실행 정책 문제를 피할 수 있습니다. 실행 정책 자체를 변경하지 않습니다.

### 4-4. 수동 대안: 빌드와 설치

```powershell
npm.cmd --prefix central/ui ci
npm.cmd run central:build
npm.cmd run central:check
npm.cmd run check
npm.cmd test
npm.cmd run central:package
```

`npm.cmd`를 사용하면 npm.ps1 실행 정책 문제를 피할 수 있습니다. 실행 정책 자체를 변경하지 않습니다. zip 명령이 없으면 압축 파일 없이 **폴더 패키지**가 생성될 수 있으며 설치는 그 폴더에서 진행하면 됩니다. `cl.exe`가 없으면 실제 런처가 만들어지지 않으므로 설치를 진행하지 마세요.

Node 24.13.0 / x64 기준:

```powershell
$DicoPackage = Join-Path (Get-Location) 'dist\central-packages\dico-manager-win32-x64-node-24.13.0'
& "$DicoPackage\runtime\node.exe" "$DicoPackage\central\host\install.mjs" install --dry-run
& "$DicoPackage\runtime\node.exe" "$DicoPackage\central\host\install.mjs" install
& "$env:LOCALAPPDATA\DICO\app\runtime\node.exe" "$env:LOCALAPPDATA\DICO\app\central\runtime\main.mjs" --open
```

destination이 다르면 `$DicoPackage`를 조정합니다. 설치는 HKCU의 Chrome·Brave 네이티브 호스트를 등록합니다. 중앙 페이지가 열리고 터미널에서 서비스가 실행됩니다. Ctrl+C로 정상 종료할 수 있도록 터미널을 유지하세요.

## 5. 모든 브라우저에 새 확장 등록과 설정 이전

### 5-1. 새 확장 등록

1. Chrome의 `chrome://extensions` 또는 Brave의 `brave://extensions`를 엽니다.
2. **기존 확장은 꺼진 상태**로 유지합니다.
3. 개발자 모드를 켜고 **압축해제된 확장 프로그램을 로드합니다**를 선택합니다.
4. 클론한 저장소 안의 **`central/extension` 폴더**를 선택합니다. `manifest.json`이 그 폴더에 있어야 합니다.
5. 새 항목의 ID가 `ibkkihhaihlpjcahglnoiphcddcjipgh`인지 확인합니다. 새 확장의 이름은 **DICO 중앙관리 실행기**입니다.
6. 각 브라우저·프로필에서 반복합니다. 이번 중앙 확장은 같은 빌드 폴더를 여러 프로필이 읽을 수 있지만, 업데이트할 때는 연결된 모든 프로필을 함께 중지해야 합니다. 기존 Updater의 공유 폴더 제한과 혼동하지 마세요.

클론 폴더를 이동·삭제하면 새 확장 경로가 끊깁니다. 기존 Updater에 이 폴더를 등록하지 마세요. 새 확장과 중앙 프로그램은 이 문서의 수동 업데이트로 같이 갱신합니다.

### 5-2. 기존 백업 가져오기와 채널 연결

1. 중앙 페이지의 **설정 · 도움말 → 데이터 · 백업 → 백업 파일 선택**에서 기존 JSON을 선택합니다.
2. 형식이 **기존 A/B 설정**으로 표시되면 **기존 설정 가져오기**를 누릅니다. 프로필별 백업을 차례로 가져옵니다. 실행·미확인 시도가 있으면 가져오기가 차단됩니다.
3. 각 브라우저의 새 확장 팝업에서 **기존 실행기 중지·비활성화 및 미확인 결과 해소 완료 → 확인 상태 저장**을 선택합니다. 기존 사용자이므로 ‘새 설정’을 선택해서 넘어가지 않습니다.
4. 필요하면 **관리 프로그램 다시 연결**을 누릅니다.
5. 기존에 사용하던 계정으로 Discord 웹에 로그인하고 대상 서버·채널을 엽니다.
6. **현재 Discord 채널 연결**을 누릅니다. 새 전용 창이 생기면 그 창을 유지합니다.
7. 중앙 페이지에서 브라우저 이름을 `Chrome-계정A`, `Brave-계정B`처럼 구별하고 가져온 문구·채널·주기를 대조합니다.

기존 A/B는 메시지로 가져오고 다음 차례 B인 위치도 보존합니다. 다만 실행 중 상태를 이어받지는 않습니다. 동일 백업 반복 가져오기는 중복 방지를 적용하지만 내용을 바꾼 파일까지 동일하다고 보장하지 않으므로 원본을 한 번씩 가져오세요.

이전 백업에 계정 ID가 있고 실제 계정·서버·채널이 정확히 맞으면 연결 대상을 다시 결합할 수 있습니다. 계정 ID가 없거나 일치하지 않아 ‘연결 필요’ 항목이 남으면 **새로 검증된 채널에 가져온 메시지를 직접 적용하고 그룹을 다시 구성**하세요. 미검증 항목을 실행 대상으로 사용하지 마세요. 기본 아바타 등으로 실제 계정 ID를 확인할 수 없으면 연결이 차단될 수 있습니다.

### 5-3. 실행 전 확인

- 메시지 보관함에서 본문을 확인하고, 채널마다 사용할 메시지와 순서를 선택하여 적용합니다.
- **설정 수신**과 **적용 완료**는 다릅니다. 채널의 적용 완료를 확인합니다.
- 같은 목적 채널에 보내는 계정을 그룹에 A → B → C 순서로 구성하고 최소 간격을 확인합니다. 계정/채널 제한이나 브라우저 지연 때문에 실제 간격은 더 길어질 수 있습니다.
- 처음에는 적은 채널로 짧게 실행하고 실제 게시 순서와 실행 기록을 대조합니다. 그룹 시작은 실제 Discord 발송을 발생시킵니다. 설치·백업 복원 자체는 시험 메시지를 보내지 않습니다.
- ‘미확인’은 성공이나 미발송이 아닙니다. 실제 게시 근거로 확인하며 임의로 다음 차례를 강행하지 않습니다.

## 6. 다음 날 실행·중지하기

macOS:

```sh
"$HOME/Library/Application Support/DICO/app/runtime/node" "$HOME/Library/Application Support/DICO/app/central/runtime/main.mjs" --open
```

Windows PowerShell:

```powershell
& "$env:LOCALAPPDATA\DICO\app\runtime\node.exe" "$env:LOCALAPPDATA\DICO\app\central\runtime\main.mjs" --open
```

IP·포트·토큰을 입력하지 않습니다. 새 확장의 **중앙관리 페이지 열기**로도 접근할 수 있습니다. 페이지를 닫는 것은 서비스 종료가 아닙니다. 절전·재연결·서비스 재시작 후에는 상태와 미확인 결과를 확인하고 수동 재개합니다.

종료할 때는 **전체 중지 → 진행 중/미확인 확인 → 새 확장 비활성화 또는 연결된 모든 브라우저 완전 종료 → 서비스를 실행한 터미널 Ctrl+C** 순서로 진행합니다. 창만 닫고 브라우저가 백그라운드에 남아 있을 수 있으므로 macOS는 앱 종료, Windows는 백그라운드 프로세스도 확인합니다. 최초 안내에서는 로그인 자동 시작을 등록하지 않습니다.

이미 서비스가 실행 중이면 `--open` 명령은 페이지를 열고 바로 끝납니다. 그 터미널은 기존 서비스의 소유 터미널이 아니므로 Ctrl+C로 기존 서비스를 종료할 수 없습니다. 가능한 한 최초 실행 터미널을 유지하세요. 백그라운드 서비스로 이미 실행했다면 작업 관리자/활성 상태 보기에서 **설치 경로와 일치하는 DICO Node 프로세스만** 확인해야 합니다. 다른 Node 프로세스를 일괄 종료하지 마세요. 강제 종료했다면 다음 실행 시 미확인 발송 확인이 필요합니다.

## 7. 이후 업데이트

업데이트는 **연결된 모든 브라우저·프로필을 함께 중지한 뒤** 진행합니다. 기존 확장용 정식 Release ZIP과 중앙관리 빌드를 섞지 마세요.

1. 중앙의 **설정 · 도움말 → 백업 다운로드**로 구성 백업을 저장합니다. 이 백업은 메시지·구성용이며 운영 로그 전체 백업이 아닙니다.
2. 전체 중지 후 진행 중/미확인 발송을 해소합니다.
3. 모든 새 확장을 비활성화하거나 모든 연결 브라우저를 완전히 종료하고, 관리 프로그램을 실행한 터미널에서 Ctrl+C로 종료합니다.
4. 클론 폴더에서 아래 명령을 실행합니다.

macOS:

```sh
cd "$HOME/Applications/dico-chat-while"
git status --short
git pull --ff-only origin main
bash ./setup.command
```

Windows PowerShell:

```powershell
Set-Location "$HOME\Applications\dico-chat-while"
git status --short
git pull --ff-only origin main
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

`git status`에 변경이 있다면 **pull과 설정 전에** 내용을 확인하고 보존합니다. 오류가 난 상태에서 다음 명령으로 넘어가지 마세요. `git reset --hard`나 `git clean`으로 변경을 지우지 마세요. 설정 스크립트는 `git pull`을 자동 실행하지 않습니다.

5. 설정 스크립트가 새 버전을 빌드·패키징·재설치하고 실행합니다. 실행 중 재설치는 거부되므로 기존 서비스는 먼저 정상 종료해야 합니다. 데이터 폴더는 삭제하지 않습니다. 수동으로 진행하려면 macOS 3-3~3-4, Windows 4-3~4-4를 새 destination에 맞게 반복합니다. 자동·수동 절차를 중복 실행하지 마세요.
6. 브라우저에서 새 확장을 다시 활성화하고 확장 관리 화면의 새로고침 버튼을 누릅니다. 삭제·재등록하지 않고 같은 폴더와 ID를 유지합니다. 이전 Discord 탭의 스크립트가 남지 않도록 대상 탭도 새로고침하고 필요하면 전용 창을 다시 연결합니다.
7. 연결·설정 적용·다음 차례를 확인하고 그룹을 수동 재개합니다. 업데이트로 자동 재개하지 않습니다.

코드만 pull하면 설치된 중앙 프로그램은 그대로입니다. **빌드 → 패키징 → 재설치 → 확장 새로고침**까지 해야 프로그램과 확장의 버전이 맞습니다. 패키징은 같은 destination의 생성 폴더를 다시 만들므로 사용 중인 상태에서 실행하지 마세요.

## 8. 데이터 위치·기기 이동·되돌리기

| OS | 사용자 데이터 | 설치 프로그램 |
| --- | --- | --- |
| macOS | `~/Library/Application Support/DICO` | 해당 폴더 아래 `app` |
| Windows | `%LOCALAPPDATA%\DICO` | 해당 폴더 아래 `app` |

중앙 구성 백업에는 운영 로그 전체·연결 자격정보가 포함되지 않습니다. 전체 데이터를 별도 보관하려면 **서비스를 정상 종료한 상태에서** DICO 사용자 데이터 폴더 전체를 개인 저장소에 복사합니다. 실행 중 SQLite 파일 하나만 복사하지 마세요. 이 폴더는 비밀 연결정보를 포함할 수 있으므로 Git·공유 문서에 넣지 않습니다. 다른 PC에는 설치 후 구성 JSON을 가져오고 계정·채널을 다시 연결하는 방식을 사용하세요. 다른 OS의 `app` 폴더나 runtime.json을 이식하지 않습니다.

구형 확장으로 되돌릴 때:

1. 새 중앙관리 전체 중지와 미확인 결과 해소를 완료합니다.
2. 모든 프로필의 새 확장을 비활성화하고 새 관리 서비스를 종료합니다.
3. 기존 확장을 다시 켜고 문구·다음 차례·채널·주기를 대조합니다. 기존 자동 적용은 필요에 따라 별도 판단합니다.
4. 필요한 경우 기존 백업으로 복원하고 수동 시작합니다. 새 버전에서 발생한 실제 발송이 구형 차례에 자동 반영되지는 않습니다.

새 중앙 확장이 안정적으로 동작한 것을 확인한 뒤 기존 확장을 삭제하세요. 제거하면 구형 브라우저 저장 데이터가 사라질 수 있으므로 백업을 먼저 보관합니다. 새 관리 프로그램 제거는 생성 패키지의 `uninstall.command` / `uninstall.cmd`를 서비스 종료 후 실행하며, 사용자 DB·설정은 보존합니다. 구형 Updater 제거는 [별도 안내](../../updater/SETUP.md)를 따릅니다.

## 9. 막힐 때 확인할 내용

Node가 준비된 환경에서는 `node scripts/setup-central.mjs --doctor`로 설치 상태를 읽기 전용 진단하고, `node scripts/setup-central.mjs --dry-run`으로 실행 계획을 확인할 수 있습니다. 중앙 페이지의 **설정 · 도움말 → 설치 · 연결 진단 → 다시 확인**도 현재 상태만 다시 읽습니다. 이 버튼은 설치·다운로드·Git 업데이트를 실행하지 않습니다.

직접 CLI를 사용할 때 `node scripts/setup-central.mjs --install --open`은 설치와 페이지 열기까지 진행합니다. 아무 옵션 없이 실행하면 의존성·빌드·검사·테스트·패키징까지만 진행하고 OS 사용자 설치는 하지 않습니다. 모든 방식에서 브라우저 확장 등록은 5장을 따릅니다.


| 증상 | 확인·조치 |
| --- | --- |
| clone 권한 오류 | 저장소 읽기 권한과 Git 인증 확인. 토큰을 문서·URL·스크린샷에 넣지 않기 |
| Node/SQLite 오류 | 자동 설정의 Node 선택 결과 또는 `node --version`이 24.13 이상인 24.x인지 확인. 수동 설치했다면 새 터미널에서 다시 확인 |
| npm 다운로드 실패 | 인터넷/프록시와 오류 확인 후 `npm --prefix central/ui ci` 재시도. lockfile 삭제로 우회하지 않기 |
| 확장에 content.js가 없다고 나옴 | `central:build` 성공 여부와 `central/extension` 선택 여부 확인 |
| native host not found | 패키지 설치 여부, 현재 OS 사용자, Chrome·Brave 사용 여부, 새 확장 ID 확인. 브라우저 완전 종료 후 재실행 |
| 관리 프로그램이 명시적으로 종료됨 | 6장의 수동 실행 명령으로 시작한 뒤 확장에서 다시 연결 |
| 이미 실행 중 / 설치 거부 | 전체 중지만으로 프로세스가 종료되지는 않음. 서비스 소유 터미널에서 정상 종료 후 재시도. runtime.json/잠금 파일 임의 삭제 금지 |
| 페이지 인증 만료 / Unauthorized | 주소를 복사·공유하지 말고 확장의 중앙관리 페이지 열기 또는 수동 실행 `--open` 사용 |
| 계정 확인 실패 | 실제 로그인 계정과 프로필 이미지에서 ID 관측 가능한지 확인. 다른 계정 ID를 임의 입력하여 우회하지 않기 |
| 가져온 채널이 연결 필요 | 5-2의 계정 ID 일치 조건 확인. 검증된 새 연결에 문구와 그룹을 직접 적용 |
| 절전·재시작 후 멈춤 | 로그·문제 목록과 실제 게시 결과를 확인한 뒤 수동 재개. 자동 재발송하지 않음 |
| Windows cl.exe 오류 | 4-1의 Build Tools 설치 완료·MSVC/SDK 확인. 자동 설정 재실행 또는 수동 x64 Native Tools 환경 사용. Mac 패키지로 대체 불가 |
| winget을 찾을 수 없음 | Microsoft Store의 Microsoft 앱 설치 관리자 설치·업데이트 후 새 PowerShell 사용. 공식 Git·Build Tools 설치 프로그램도 가능 |
| Node 다운로드·체크섬 오류 | 인터넷·프록시·다운로드 출처 확인 후 재시도. SHA-256 검사를 생략하지 말고 필요하면 공식 Node 수동 설치 사용 |
| PC 알림이 안 보임 | 중앙 설정의 알림 토글과 OS 알림/집중 모드 확인. ‘테스트 요청’은 Discord 메시지를 보내지 않음 |

## 10. 설치 완료 확인표

- [ ] 기존 브라우저·프로필별 JSON 백업을 따로 저장했다.
- [ ] 기존 자동 적용과 발송을 중지했고 구형 확장은 모두 비활성화했다.
- [ ] 미확인 발송과 남은 초안을 확인했다.
- [ ] 새 UI 빌드·검사·테스트·패키징이 성공했다.
- [ ] 새 관리 프로그램을 현재 OS 사용자에게 설치했다.
- [ ] 모든 대상 프로필에 `central/extension`을 등록하고 고정 ID를 확인했다.
- [ ] 실제 계정·채널 연결과 설정 적용 완료를 확인했다.
- [ ] 메시지·다음 차례·그룹 순서·간격을 대조했다.
- [ ] 중지·정상 종료·다음 실행과 수동 재개 방법을 확인했다.
- [ ] 별도 테스트 기기에서 검증하기 전 다른 사용자에게 안정판이라고 안내하지 않았다.

## 11. 공유·배포 범위

저장소 주소와 이 문서를 전달하면 받는 사람이 클론해서 빌드할 수 있습니다. 비공개 저장소는 상대방의 GitHub 계정에 접근 권한이 필요합니다. 다른 사람을 저장소에 초대하거나 공개로 전환하는 작업은 이 문서 작성에 포함되지 않습니다.

이번 방식은 소스에서 설정하는 개발판 설치입니다. 설정 스크립트가 빌드·설치를 묶어서 실행하지만 브라우저 전환과 발송 재개는 사용자가 확인합니다. 기존 정식 Release/Updater의 자동 업데이트 대상으로 중앙관리 ZIP을 오인하지 마세요. 기존 루트 manifest는 0.3.0이고 새 전용 확장은 0.4.0입니다. 중앙관리용 버전 태그나 스토어 게시를 대신하지 않습니다.

관련 문서: [중앙관리 실행 안내](../../central/README.md), [구현 범위와 제한](IMPLEMENTATION.md), [기존 Updater 연결·해제](../../updater/SETUP.md).
