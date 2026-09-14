import test from "node:test";
import assert from "node:assert/strict";
import { draftMatchesBase, normalizeRootState, selectExistingChannel, settingsBase } from "../ui-state.js";

const channel = {
  id: "channel-1",
  name: "공지",
  settingsRevision: 3,
  messages: ["A", "B"],
  intervalSeconds: 60,
  ownUserId: "12345678901234567",
};

test("root state and channel settings are normalized", () => {
  const state = normalizeRootState({ version: 2, channels: [channel] });
  assert.equal(state.channels[0].id, "channel-1");
  assert.deepEqual(state.channels[0].messages, ["A", "B"]);
  assert.equal(state.channels[0].enabled, false);
  assert.equal(state.channels[0].settingsRevision, 3);
});

test("dirty state follows actual field values and clears after undo", () => {
  const base = settingsBase(channel);
  const draft = {
    name: "공지",
    messages: ["A", "B"],
    intervalText: "60",
    ownUserId: "12345678901234567",
  };
  assert.equal(draftMatchesBase(draft, base), true);
  draft.messages[0] = "바뀐 A";
  assert.equal(draftMatchesBase(draft, base), false);
  draft.messages[0] = "A";
  assert.equal(draftMatchesBase(draft, base), true);
});

test("selected channel stays local while it exists", () => {
  const channels = [channel, { ...channel, id: "channel-2" }];
  assert.equal(selectExistingChannel(channels, "channel-2"), "channel-2");
  assert.equal(selectExistingChannel(channels, "missing"), "channel-1");
});
