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
