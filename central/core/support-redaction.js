/** 제보 자유 텍스트의 명시적인 인증정보 표기를 제거한다. 임의의 비밀 문자열 탐지를 보장하지 않는다. */
export function redactSupportText(value){
 // 키 이름은 트리 검증의 200자 범위 안에서만 탐색해 긴 입력의 백트래킹을 제한한다.
 return value
  .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g,'[REDACTED PRIVATE KEY]')
  .replace(/\b(?:set-cookie|cookie)\s*:\s*[^\r\n]*/gi,'Cookie: [REDACTED]')
  .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.~-]+/gi,'[REDACTED AUTH]')
  .replace(/(^|[^\w-])((?:[\w-]{0,200}(?:token|secret|password|authorization|cookie|session|credential|csrf)[\w-]{0,200})["']?\s*[:=]\s*)(?:\[REDACTED(?: AUTH)?\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)/gi,'$1$2[REDACTED]')
  .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,'$1[REDACTED]@');
}
