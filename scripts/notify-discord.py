"""Send one build notification. Never print the webhook URL or HTTP exception text."""
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

GUILD = '1486776649650540555'
CHANNEL = '1550141520282255452'

def payload(version, ref, sha, run_url, release_url=None):
    lines = [f'✅ DICO {version} 빌드 완료', f'브랜치/태그: {ref}', f'커밋: {sha[:7]}', f'빌드 결과·ZIP 다운로드: {run_url}']
    if release_url:
        lines.append(f'정식 배포: {release_url}')
    else:
        lines.append('빌드 페이지 하단 Artifacts → extension-zip에서 다운로드하세요. GitHub 로그인이 필요할 수 있습니다.')
    return {'content': '\n'.join(lines), 'allowed_mentions': {'parse': []}}

def main():
    webhook = os.environ.get('DISCORD_BUILD_WEBHOOK', '')
    parsed = urlparse(webhook)
    if parsed.scheme != 'https' or parsed.hostname != 'discord.com' or not parsed.path.startswith('/api/webhooks/'):
        raise RuntimeError('DISCORD_BUILD_WEBHOOK 설정을 확인하세요.')
    # Check the destination before posting; a mistakenly copied webhook must not
    # announce private build details in a different channel.
    headers = {'Content-Type': 'application/json', 'User-Agent': 'DicoBuildNotifier/1.0'}
    with urlopen(Request(webhook, headers=headers), timeout=15) as response:
        info = json.load(response)
    if info.get('guild_id') != GUILD or info.get('channel_id') != CHANNEL:
        raise RuntimeError('웹훅 대상이 지정된 서버·채널과 다릅니다.')
    version = json.loads(Path('manifest.json').read_text())['version']
    base = f"https://github.com/{os.environ['GITHUB_REPOSITORY']}"
    ref = os.environ['GITHUB_REF_NAME']
    release = f'{base}/releases/tag/{ref}' if os.environ.get('GITHUB_REF_TYPE') == 'tag' else None
    body = payload(version, ref, os.environ['GITHUB_SHA'], f"{base}/actions/runs/{os.environ['GITHUB_RUN_ID']}", release)
    # wait=true verifies Discord accepted a message. Do not automatically retry
    # ambiguous transport failures, which could otherwise duplicate a notification.
    target = webhook.split('?')[0] + '?wait=true'
    with urlopen(Request(target, data=json.dumps(body).encode(), headers=headers, method='POST'), timeout=20) as response:
        message = json.load(response)
    if message.get('channel_id') != CHANNEL or not message.get('id'):
        raise RuntimeError('Discord 응답에서 메시지 전송을 확인하지 못했습니다.')
    print(f"Discord build notification confirmed: channel={CHANNEL}, message={message['id']}")

if __name__ == '__main__':
    try:
        main()
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('Discord 알림 요청 실패. 웹훅 설정과 Discord 연결 상태를 확인하세요. 중복 방지를 위해 자동 재전송하지 않습니다.', file=sys.stderr)
        sys.exit(1)
