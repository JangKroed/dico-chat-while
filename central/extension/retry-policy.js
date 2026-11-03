/**
 * 중앙·확장이 함께 사용하는 유한 재시도 정책입니다.
 * 횟수는 최초 실행 이후의 추가 시도이며 0은 자동 재시도를 하지 않는다는 뜻입니다.
 * 과거 null(무제한), 누락, 비정상 값은 기본값으로 바꿉니다. 이미 설정한
 * 유효한 횟수는 보존하되 상한을 넘는 과거 설정은 상한까지만 허용합니다.
 * 이 정규화는 결과를 성공/미발송으로 바꾸거나 실행을 다시 시작하지 않습니다.
 */
export const DEFAULT_SEND_RETRIES=3;
export const MAX_SEND_RETRIES=10;
export const validSendRetries=value=>Number.isSafeInteger(value)&&value>=0&&value<=MAX_SEND_RETRIES;
export const normalizeSendRetries=value=>Number.isSafeInteger(value)&&value>=0?Math.min(value,MAX_SEND_RETRIES):DEFAULT_SEND_RETRIES;
