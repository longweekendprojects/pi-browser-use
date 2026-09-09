// The quit-and-relaunch consent gate. A yes/no prompt in the middle of a task
// stops an agent, so the user can grant that consent once, up front. These tests
// pin both directions: the standing grant is honored, and its absence still
// means the tool asks (or refuses) rather than closing the user's browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { browserSettings } = await import("../helpers.mjs");

function withConfig(cfg, env, fn) {
  const dir = mkdtempSync(join(tmpdir(), "pi-browser-use-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(cfg));
  const saved = { ...process.env };
  process.env.PI_BROWSER_USE_CONFIG = path;
  delete process.env.PI_BROWSER_USE_ASSUME_YES;
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test("the relaunch prompt is skipped once the user pre-approves it in config", () => {
  const s = withConfig({ autoApproveRelaunch: true }, {}, () => browserSettings({}));
  assert.equal(s.assumeYes, true);
});

test("consent is withheld by default, so the tool still asks before quitting the browser", () => {
  const s = withConfig({}, {}, () => browserSettings({}));
  assert.equal(s.assumeYes, false);
});

test("only a true value grants consent, never a truthy-looking string", () => {
  const s = withConfig({ autoApproveRelaunch: "no" }, {}, () => browserSettings({}));
  assert.equal(s.assumeYes, false);
});

test("the environment variable grants consent for a single shell", () => {
  const s = withConfig({}, { PI_BROWSER_USE_ASSUME_YES: "1" }, () => browserSettings({}));
  assert.equal(s.assumeYes, true);
});

test("the environment variable can also withdraw consent the config granted", () => {
  const s = withConfig({ autoApproveRelaunch: true }, { PI_BROWSER_USE_ASSUME_YES: "0" }, () => browserSettings({}));
  assert.equal(s.assumeYes, false);
});
