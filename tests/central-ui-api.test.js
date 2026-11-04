import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiError,requestErrorMessage as errorMessage} from '../central/ui/src/api.ts';
// 기존 상세 복구 절차는 개발자 모드의 계약으로만 검증합니다.
const requestErrorMessage=error=>errorMessage(error,true);

test('version conflicts keep stale-edit guidance distinct from connection recovery',()=>{
  const stale=new ApiError('This item changed.',409,'VERSION_CONFLICT');
  const blocked=new ApiError('Connect this browser before starting.',409,'CONNECTION_LOST');
  assert.match(requestErrorMessage(stale),/다른 화면에서 변경/);
  assert.match(requestErrorMessage(blocked),/브라우저.*다시 연결/);
  assert.doesNotMatch(requestErrorMessage(blocked),/다른 화면에서 변경/);
});

test('unverified account/channel errors explain registration does not complete channel verification',()=>{
  const result=requestErrorMessage(new ApiError('Verify the account and channel in this browser.',409,'ACCOUNT_UNVERIFIED'));
  assert.match(result,/채널 연결.*검증/);
  assert.match(result,/채널 설정/);
  assert.match(result,/계정.*등록/);
  assert.doesNotMatch(result,/Verify the account/);
});

test('pending execution errors give a next step without implying safe resend',()=>{
  assert.match(requestErrorMessage(new ApiError('Resolve attempt.',409,'ATTEMPT_UNRESOLVED')),/실제 Discord 게시 내역/);
  assert.match(requestErrorMessage(new ApiError('Wait for ACK.',409,'CONTROL_PENDING')),/중지.*확인 응답/);
  assert.match(requestErrorMessage(new ApiError('Apply messages.',409,'PLAYLIST_EMPTY')),/메시지.*적용/);
});

test('retry rejection guidance distinguishes missing execution proof from stale and terminal attempts',()=>{
  assert.match(requestErrorMessage(new ApiError('Proof pending.',409,'EXECUTION_UNCERTAIN')),/실행 차단.*확인되지/);
  assert.match(requestErrorMessage(new ApiError('Group changed.',409,'STALE_ATTEMPT')),/그룹이나 최근 발송 시도.*변경/);
  assert.match(requestErrorMessage(new ApiError('Confirmed.',409,'ATTEMPT_STATE')),/미확인 또는 미발송 상태가 아닙니다/);
});

test('unknown errors preserve server detail and do not invent a cause',()=>{
  assert.equal(requestErrorMessage(new ApiError('새로운 서버 진단',409,'NEW_ERROR')),'새로운 서버 진단');
  assert.equal(requestErrorMessage(new Error('연결 실패')),'연결 실패');
  assert.match(requestErrorMessage(null),/요청을 처리하지 못/);
});

 test('일반 화면의 오류가 숨겨진 로그 메뉴나 수동 게시 판정을 요구하지 않는다',()=>{
  for(const code of ['ATTEMPT_UNRESOLVED','EXECUTION_UNCERTAIN','CONTROL_PENDING','CONNECTION_LOST','ACCOUNT_UNVERIFIED','STALE_SESSION','REMOVAL_BLOCKED','NEW_ERROR']){
   const result=errorMessage(new ApiError('실제 Discord 내역을 확인한 뒤 실행 기록에서 직접 처리하세요.',409,code));
   assert.doesNotMatch(result,/직접|확인하세요|처리하세요|실행 기록|로그|진단 자료/);
  }
 });
