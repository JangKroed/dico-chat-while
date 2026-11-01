import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCentralManager} from '../central/core/index.js';
import {createSettingsDraft,syncSettingsDraft,editSettingsDraft,settingsPayload} from '../central/ui/src/settings-draft.ts';

const saved={retentionDays:180,notificationsEnabled:true,hideNotificationNames:false};
test('settings initialize from the saved snapshot without presenting defaults',()=>{
  assert.deepEqual(createSettingsDraft(saved).values,saved);
  assert.equal(createSettingsDraft(undefined),null);
  assert.deepEqual(syncSettingsDraft(null,saved).values,saved);
  assert.equal(settingsPayload(null,'notifications'),null);
});
test('saving notifications preserves an unsaved retention edit and follows other saved fields',()=>{
  let draft=editSettingsDraft(createSettingsDraft(saved),'retentionDays',30);
  draft=editSettingsDraft(draft,'notificationsEnabled',false);
  assert.deepEqual(settingsPayload(draft,'notifications'),{notificationsEnabled:false});
  draft=syncSettingsDraft(draft,{...saved,notificationsEnabled:false,hideNotificationNames:true});
  assert.deepEqual(draft.values,{retentionDays:30,notificationsEnabled:false,hideNotificationNames:true});
  assert.deepEqual(settingsPayload(draft,'notifications'),{});
  assert.deepEqual(settingsPayload(draft,'retention'),{retentionDays:30});
});
test('retention save and reconnect snapshots preserve dirty notification fields',()=>{
  let draft=editSettingsDraft(createSettingsDraft(saved),'hideNotificationNames',true);
  draft=syncSettingsDraft(draft,{...saved,retentionDays:30});
  assert.equal(draft.values.hideNotificationNames,true);
  assert.equal(draft.values.retentionDays,30);
  assert.equal(syncSettingsDraft(draft,undefined),draft);
  assert.deepEqual(settingsPayload(draft,'notifications'),{hideNotificationNames:true});
  draft=syncSettingsDraft(draft,{...saved,retentionDays:30,hideNotificationNames:true});
  assert.deepEqual(settingsPayload(draft,'notifications'),{});
});
test('notification and retention preferences survive partial saves and a disk reopen',()=>{
  const directory=mkdtempSync(join(tmpdir(),'dico-settings-persist-'));
  let manager;
  try{
    const databasePath=join(directory,'central.sqlite');
    manager=createCentralManager({databasePath});
    manager.execute('settings.update',saved);
    manager.execute('settings.update',{hideNotificationNames:true});
    manager.close();manager=createCentralManager({databasePath});
    const actual=manager.snapshot().settings;
    assert.equal(actual.retentionDays,180);assert.equal(actual.notificationsEnabled,true);assert.equal(actual.hideNotificationNames,true);
  }finally{manager?.close();rmSync(directory,{recursive:true,force:true});}
});
