"""Render Korean release notes from the reviewed, versioned README history."""
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parent.parent
version = json.loads((root / 'manifest.json').read_text())['version']
readme = (root / 'README.md').read_text()
sections = re.findall(r'^## (\d+\.\d+\.\d+[^\n]*)\n(.*?)(?=^## |\Z)', readme, re.M | re.S)
if not sections or not sections[0][0].startswith(version + ':'):
    raise SystemExit('현재 버전의 업데이트 내역이 필요합니다.')
print(f'''## 다운로드 및 적용

아래 **Assets → dico-while-{version}.zip**을 받으세요. **Source code** 파일은 설치용이 아닙니다.

모두 중지 → ZIP 압축 해제 → 기존 설치 폴더에 덮어쓰기 → 확장 프로그램 새로고침 → 기존 전용 Discord 창을 닫고 다시 시작하세요. 같은 설치 폴더를 유지하면 설정이 보존됩니다. 업데이트 전에 설정 백업을 권장합니다.

## 자동 업데이트 최초 연결

이번 버전은 한 번만 기존 확장 폴더에 적용하고 새로고침하세요. 이후 아래 Assets에서 Mac은 **dico-updater-macos.zip**, Windows는 **dico-updater-windows.zip**을 받아 보조 설치 프로그램을 한 번 실행합니다. 확장 ID와 기존 설치 폴더를 연결한 뒤 사이드패널의 **보조 프로그램 연결 / 자동 적용 켜기**를 누르세요.

[상세 설치·해제·복구 안내](https://github.com/JangKroed/dico-chat-while/blob/v{version}/updater/SETUP.md)

실행·미확인 전송·남은 초안이 있으면 기다리며, 정리 후 자동 파일 교체와 확장 새로고침을 처리합니다. 채널을 임의로 다시 시작하지 않습니다. 보조 설치 앱은 개발자 서명/공증되지 않아 최초 실행 시 OS 확인이 필요할 수 있습니다.

## 이번 업데이트

### {sections[0][0]}
{sections[0][1].strip()}

<details>
<summary>이전 업데이트 내역 전체 보기</summary>

아래는 이전 버전의 변경 기록입니다. 제한과 검증 결과는 당시 기준이며, 과거 설치 ZIP의 재배포는 아닙니다.
''')
for title, body in sections[1:]:
    print(f'### {title}\n\n{body.strip()}\n')
print('</details>')
