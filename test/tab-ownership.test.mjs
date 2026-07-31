import test from "node:test";
import assert from "node:assert/strict";

import { canCloseAgentTarget } from "../helpers.mjs";

test("only agent-created tabs may be closed", () => {
  assert.equal(canCloseAgentTarget({ id: "created", ownership: "created" }), true);
  assert.equal(canCloseAgentTarget({ id: "adopted", ownership: "adopted" }), false);
  assert.equal(canCloseAgentTarget({ id: "legacy", ownership: "unknown" }), false);
  assert.equal(canCloseAgentTarget(null), false);
});
