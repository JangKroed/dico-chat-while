#!/bin/bash
set -euo pipefail
DICO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$DICO_ROOT"
DICO_READ_ONLY=0
for arg in "$@"; do
  case "$arg" in --doctor|--dry-run) DICO_READ_ONLY=1;; --install|--open) ;; *) echo "지원하지 않는 옵션: $arg" >&2; exit 1;; esac
done
if [ "$(uname -s)" != Darwin ]; then echo 'macOS 전용입니다. Windows는 setup.ps1을 사용하세요.' >&2; exit 1; fi
DICO_NODE=''
if command -v node >/dev/null 2>&1 && node -e 'process.exit(/^24\.(?:1[3-9]|[2-9][0-9])\./.test(process.versions.node)?0:1)' 2>/dev/null; then
  DICO_NODE="$(command -v node)"
fi
DICO_ARCH="$(uname -m)"
case "$DICO_ARCH" in arm64) ;; x86_64) DICO_ARCH=x64;; *) echo '지원하지 않는 Mac CPU입니다.' >&2; exit 1;; esac
DICO_DIST="node-v24.13.0-darwin-$DICO_ARCH"
DICO_CACHE="$DICO_ROOT/.dico-tools/$DICO_DIST"
if [ -z "$DICO_NODE" ] && [ -x "$DICO_CACHE/bin/node" ]; then DICO_NODE="$DICO_CACHE/bin/node"; fi
if [ -z "$DICO_NODE" ]; then
  if [ "$DICO_READ_ONLY" = 1 ]; then echo 'Node 24.13.x가 없습니다. 진단/미리보기에서는 다운로드하지 않습니다. setup.command를 옵션 없이 실행하면 로컬 도구를 준비합니다.' >&2; exit 1; fi
  echo '공식 Node 24.13.0을 이 프로젝트의 .dico-tools에 준비합니다. 전역 Node 설정은 바꾸지 않습니다.'
  mkdir -p "$DICO_ROOT/.dico-tools"
  DICO_TEMP="$(mktemp -d "$DICO_ROOT/.dico-tools/download.XXXXXX")"
  trap 'rm -rf "$DICO_TEMP"' EXIT
  DICO_ARCHIVE="$DICO_DIST.tar.gz"
  /usr/bin/curl --fail --location --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 15 --max-time 600 "https://nodejs.org/dist/v24.13.0/$DICO_ARCHIVE" -o "$DICO_TEMP/$DICO_ARCHIVE"
  /usr/bin/curl --fail --location --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 15 --max-time 60 https://nodejs.org/dist/v24.13.0/SHASUMS256.txt -o "$DICO_TEMP/SHASUMS256.txt"
  DICO_SHA="$(awk -v file="$DICO_ARCHIVE" '$2==file {print $1}' "$DICO_TEMP/SHASUMS256.txt")"
  if ! [[ "$DICO_SHA" =~ ^[a-f0-9]{64}$ ]]; then echo '공식 체크섬을 확인하지 못했습니다.' >&2; exit 1; fi
  (cd "$DICO_TEMP"; printf '%s  %s\n' "$DICO_SHA" "$DICO_ARCHIVE" | /usr/bin/shasum -a 256 -c -)
  /usr/bin/tar -xzf "$DICO_TEMP/$DICO_ARCHIVE" -C "$DICO_TEMP"
  # A parallel setup must not silently merge two runtime directories.
  if [ -e "$DICO_CACHE" ]; then echo '도구 폴더가 이미 생겼습니다. 다른 설정 작업을 종료하고 다시 실행하세요.' >&2; exit 1; fi
  mv "$DICO_TEMP/$DICO_DIST" "$DICO_CACHE"
  DICO_NODE="$DICO_CACHE/bin/node"
fi
"$DICO_NODE" -e 'process.exit(/^24\.(?:1[3-9]|[2-9][0-9])\./.test(process.versions.node)?0:1)'
export PATH="$(dirname -- "$DICO_NODE"):$PATH"
# Preserve the explicit read-only mode; default execution installs and opens.
for arg in "$@"; do
  if [ "$arg" = --doctor ]; then exec "$DICO_NODE" "$DICO_ROOT/scripts/setup-central.mjs" --doctor; fi
done
exec "$DICO_NODE" "$DICO_ROOT/scripts/setup-central.mjs" --install --open "$@"
