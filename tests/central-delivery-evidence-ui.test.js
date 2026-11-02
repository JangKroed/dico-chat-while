import test from 'node:test';
import assert from 'node:assert/strict';
import {unknownDeliveryCause,enterEvidenceText,evidenceFlags,deliveryReasonLabel,attemptResultLabel,confirmationBasisText} from '../central/ui/src/delivery-evidence.ts';
test('retained draft explains uncertainty without treating it as proof of no delivery',()=>{
  assert.match(unknownDeliveryCause('draft-retained'),/입력창에 문구가 남아/);
  assert.match(unknownDeliveryCause('draft-retained'),/미발송으로 판단할 수 없습니다/);
});
test('an Enter request is distinct from Discord processing or confirmed posting',()=>{
  assert.match(enterEvidenceText({enterAttempted:true}),/게시했다는 뜻은 아닙니다/);
  assert.match(enterEvidenceText({enterAttempted:false}),/미발송을 확정할 수는 없습니다/);
  assert.match(enterEvidenceText(),/추정하지 않습니다/);
});
test('diagnostic display accepts only the agreed observation flags',()=>{
  assert.deepEqual(evidenceFlags.map(x=>x.key),['enterDefaultPrevented','keyupDefaultPrevented','documentHidden','documentFocused','composerRetained','composerCleared','newMessage','matchingMessage','sendingSeen','failedSeen','authorMismatch','authorUnknown','timeMismatch']);
  assert.match(unknownDeliveryCause('reconcile_inconclusive'),/재확인했지만/);
});
test('key event and document observations have labels, and method stays separate from posting',()=>{
  const labels=Object.fromEntries(evidenceFlags.map(x=>[x.key,x.label]));
  for(const key of ['enterDefaultPrevented','keyupDefaultPrevented','documentHidden','documentFocused'])assert.ok(labels[key],key);
  assert.match(enterEvidenceText({enterAttempted:true,submitMethod:'keyboard'}),/키보드/);
  assert.match(enterEvidenceText({enterAttempted:true,submitMethod:'button'}),/버튼/);
  assert.match(enterEvidenceText({enterAttempted:true,submitMethod:'button'}),/게시했다는 뜻은 아닙니다/);
});
test('fixed content codes have Korean causes while preserving delivery uncertainty',()=>{
  assert.equal(unknownDeliveryCause('DELIVERY_DRAFT_RETAINED'),unknownDeliveryCause('draft-retained'));
  assert.equal(unknownDeliveryCause('DELIVERY_CONFIRMATION_TIMEOUT'),unknownDeliveryCause('uncertain'));
  for(const code of ['COMMIT_EDITOR_UNSTABLE','PREPARE_EDITOR_UNSTABLE','CONTENT_EXCEPTION_AFTER_ENTER','CONTENT_EXCEPTION_BEFORE_ENTER','COOLDOWN_UNVERIFIED','PREPARE_WAIT_TIMEOUT']){
    assert.ok(deliveryReasonLabel(code));assert.doesNotMatch(unknownDeliveryCause(code),/자동 진행이 멈췄습니다/);
  }
  assert.match(unknownDeliveryCause('CONTENT_EXCEPTION_AFTER_ENTER'),/실제 게시를 확정할 수 없습니다/);
});

test('composer-clear completion has its own label and does not claim an observed Discord post',()=>{
 assert.equal(attemptResultLabel({status:'confirmed',confirmationBasis:'composer_cleared'}),'발송 처리');
 assert.equal(attemptResultLabel({status:'confirmed',confirmationBasis:'message_observed'}),'게시 확인');
 assert.equal(attemptResultLabel({status:'confirmed',messageId:'123'}),'게시 확인');
 assert.equal(attemptResultLabel({status:'unknown'}),undefined);
 assert.match(confirmationBasisText({status:'confirmed',confirmationBasis:'composer_cleared'}),/입력창이 비워/);
 assert.match(confirmationBasisText({status:'confirmed',confirmationBasis:'composer_cleared'}),/다음 차례/);
 assert.match(confirmationBasisText({status:'confirmed',confirmationBasis:'message_observed'}),/메시지/);
 assert.equal(confirmationBasisText({status:'unknown'}),undefined);
});

test('legacy timeout and fresh composer failures have actionable input-state labels',()=>{
 assert.doesNotMatch(deliveryReasonLabel('DELIVERY_CONFIRMATION_TIMEOUT'),/대기 시간 초과/);
 for(const code of ['DISCORD_SEND_FAILED','COMPOSER_EDITOR_MISSING','COMPOSER_EDITOR_CHANGED','COMPOSER_DRAFT_CHANGED','COMPOSER_STATE_UNREADABLE']){
  assert.ok(deliveryReasonLabel(code));assert.doesNotMatch(unknownDeliveryCause(code),/증거가 충분하지/);
 }
});
