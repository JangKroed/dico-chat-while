import test from 'node:test';
import assert from 'node:assert/strict';
import {planDraftPreparation,recordDraftBackup} from '../central/extension/draft-ledger.js';

const attempt={attemptId:'next',bindingId:'binding',accountId:'111',guildId:'222',channelId:'333',tabId:7,runId:'run',configVersion:1,body:'A'};
const inspection=(draftText,draftMatches=false)=>({ok:true,draftText,draftMatches,unsupported:false,attachmentOrReply:false});

test('matching composer drafts reuse content without a replacement or backup',()=>{
  assert.deepEqual(planDraftPreparation({attempt,attempts:{},inspection:inspection('A',true)}),{action:'reuse'});
  assert.deepEqual(planDraftPreparation({attempt,attempts:{},inspection:inspection('')}),{action:'empty'});
});
test('foreign plain draft requires an exact preserved backup before replacement',()=>{
  assert.deepEqual(planDraftPreparation({attempt,attempts:{},inspection:inspection('personal\n draft')}),{action:'replace',backupText:'personal\n draft',replaceExpectedDraft:'personal\n draft'});
});
test('earlier confirmed matching text does not suppress a legitimate later playlist turn',()=>{
  const prior={...attempt,attemptId:'previous',phase:'confirmed',result:{outcome:'confirmed',messageId:'12345678901234567'}};
  assert.equal(planDraftPreparation({attempt,attempts:{previous:prior},inspection:inspection('A',true)}).action,'reuse');
});
test('same attempt receipt prevents another preparation and unresolved prior delivery blocks replacement',()=>{
  const confirmed={...attempt,phase:'confirmed',result:{outcome:'confirmed',messageId:'12345678901234567'}};
  assert.deepEqual(planDraftPreparation({attempt,attempts:{next:confirmed},inspection:inspection('A',true)}),{action:'confirmed',messageId:'12345678901234567'});
  for(const phase of ['preparing','prepared','executing','unknown']){
    const prior={...attempt,attemptId:'prior',phase};
    assert.equal(planDraftPreparation({attempt,attempts:{prior},inspection:inspection('foreign')}).reasonCode,'ATTEMPT_UNRESOLVED');
  }
});
test('attachments unsupported composer content and incomplete inspection cannot authorize replacement',()=>{
  for(const seen of [{...inspection('foreign'),unsupported:true},{...inspection('foreign'),attachmentOrReply:true},{ok:true,draftMatches:false},{...inspection('foreign'),ok:false}]){
    assert.equal(planDraftPreparation({attempt,attempts:{},inspection:seen}).action,'blocked');
  }
});
test('backup is exact local state and idempotent for the same attempt and draft',()=>{
  const state={};const first=recordDraftBackup(state,attempt,'private\n draft',123);
  assert.equal(first.text,'private\n draft');assert.equal(first.createdAt,123);assert.equal(first.attemptId,attempt.attemptId);
  assert.equal(recordDraftBackup(state,attempt,'private\n draft',456).id,first.id);assert.equal(state.draftBackups.length,1);
  assert.equal(recordDraftBackup(state,attempt,'changed draft',456).text,'changed draft');assert.equal(state.draftBackups.length,2);
});
test('backup capacity blocks replacement instead of discarding older drafts',()=>{
  const state={};for(let n=0;n<50;n++)recordDraftBackup(state,{...attempt,attemptId:String(n)},'draft '+n,n);
  assert.throws(()=>recordDraftBackup(state,attempt,'new draft',999),{code:'DRAFT_BACKUP_FULL'});assert.equal(state.draftBackups.length,50);
});
