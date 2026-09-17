import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

process.env.HOME = mkdtempSync(tmpdir() + "/pbu-");
const { setAgentTarget, getAgentTarget, clearAgentTarget } = await import("/Users/albert/.pi/agent/git/github.com/longweekendprojects/pi-browser-use/helpers.mjs");

test("one session's tab is invisible to another session", () => {
  process.env.PI_BROWSER_USE_SESSION = "session-a";
  setAgentTarget("tab-a", "adopted", "b1");
  assert.equal(getAgentTarget().id, "tab-a");

  process.env.PI_BROWSER_USE_SESSION = "session-b";
  assert.equal(getAgentTarget(), null);
  setAgentTarget("tab-b", "created", "b1");

  process.env.PI_BROWSER_USE_SESSION = "session-a";
  assert.equal(getAgentTarget().id, "tab-a");
  clearAgentTarget();
  assert.equal(getAgentTarget(), null);

  process.env.PI_BROWSER_USE_SESSION = "session-b";
  assert.equal(getAgentTarget().id, "tab-b");
});
