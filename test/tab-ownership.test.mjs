import test from "node:test";
import assert from "node:assert/strict";

import { canCloseAgentTarget } from "../helpers.mjs";

test("only agent-created tabs may be closed", () => {
  assert.equal(canCloseAgentTarget({ id: "created", ownership: "created" }), true);
  assert.equal(canCloseAgentTarget({ id: "adopted", ownership: "adopted" }), false);
  assert.equal(canCloseAgentTarget({ id: "legacy", ownership: "unknown" }), false);
  assert.equal(canCloseAgentTarget(null), false);
});

import { agentTargetIsUsable } from "../helpers.mjs";

const tabs = [{ id: "mine" }, { id: "users" }];

test("a tab recorded by this session in this browser is used", () => {
  assert.equal(agentTargetIsUsable({ id: "mine", ownership: "created", browserId: "b1" }, tabs, "b1"), true);
});

test("a record from a previous browser launch is discarded, so a reused id cannot hit a user tab", () => {
  assert.equal(agentTargetIsUsable({ id: "mine", ownership: "created", browserId: "b0" }, tabs, "b1"), false);
  assert.equal(agentTargetIsUsable({ id: "mine", ownership: "created", browserId: null }, tabs, "b1"), false);
});

test("a tab of unknown ownership is never acted on", () => {
  assert.equal(agentTargetIsUsable({ id: "mine", ownership: "unknown", browserId: "b1" }, tabs, "b1"), false);
});

test("a closed tab is gone rather than resolved to whatever is open", () => {
  assert.equal(agentTargetIsUsable({ id: "closed", ownership: "created", browserId: "b1" }, tabs, "b1"), false);
  assert.equal(agentTargetIsUsable(null, tabs, "b1"), false);
});
