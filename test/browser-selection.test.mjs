import test from "node:test";
import assert from "node:assert/strict";

import { chooseBrowser, isProfileLocked, BROWSERS } from "../helpers.mjs";

const arc = { key: "arc", label: "Arc", realProfile: true, drivable: true, profileLocked: false };
const chrome = { key: "chrome", label: "Google Chrome", major: 151, realProfile: false, drivable: false, profileLocked: true };
const chromeOptedIn = { ...chrome, drivable: true };

test("the system default browser wins when it can be driven in the user's own profile", () => {
  const r = chooseBrowser({ configured: null, systemDefault: "arc", installed: [arc], userDataDir: null });
  assert.equal(r.key, "arc");
});

test("an undrivable default browser falls back to an installed Chromium and says why", () => {
  const r = chooseBrowser({ configured: null, systemDefault: "safari", installed: [arc], userDataDir: null });
  assert.equal(r.key, "arc");
  assert.match(r.note, /Safari is your default browser but cannot be driven/);
});

test("a Chromium 136+ default browser is skipped for one that keeps the user's session", () => {
  const r = chooseBrowser({ configured: null, systemDefault: "chrome", installed: [arc, chrome], userDataDir: null });
  assert.equal(r.key, "arc");
  assert.match(r.note, /throwaway profile/);
});

test("a profile-locked browser is used only once the user opts into a separate profile", () => {
  const locked = chooseBrowser({ configured: null, systemDefault: "chrome", installed: [chrome], userDataDir: null });
  assert.equal(locked.ok, false);
  assert.match(locked.error, /Chromium 136 removed that/);

  const optedIn = chooseBrowser({ configured: null, systemDefault: "chrome", installed: [chromeOptedIn], userDataDir: "/tmp/p" });
  assert.equal(optedIn.key, "chrome");
});

test("configuration overrides detection, and names what is wrong when it cannot be honored", () => {
  assert.equal(chooseBrowser({ configured: "chrome", systemDefault: "arc", installed: [arc, chromeOptedIn], userDataDir: "/tmp/p" }).key, "chrome");
  assert.match(chooseBrowser({ configured: "safari", systemDefault: "arc", installed: [arc] }).error, /does not speak the Chrome DevTools Protocol/);
  assert.match(chooseBrowser({ configured: "netscape", systemDefault: "arc", installed: [arc] }).error, /Unknown browser/);
  assert.match(chooseBrowser({ configured: "edge", systemDefault: "arc", installed: [arc] }).error, /not installed/);
});

test("a browser counts as locked unless its version proves the build predates the restriction", () => {
  assert.equal(isProfileLocked(BROWSERS.chrome, 135), false);
  assert.equal(isProfileLocked(BROWSERS.chrome, 136), true);
  assert.equal(isProfileLocked(BROWSERS.chrome, null), true, "an unreadable version must not be treated as drivable");
  assert.equal(isProfileLocked(BROWSERS.brave, 1), true, "Brave 1.x is a marketing version, not a Chromium version");
  assert.equal(isProfileLocked(BROWSERS.arc, null), false);
});

test("a machine with no Chromium browser reports why Safari cannot stand in", () => {
  const r = chooseBrowser({ configured: null, systemDefault: "safari", installed: [], userDataDir: null });
  assert.equal(r.ok, false);
  assert.match(r.error, /Safari does not speak the Chrome DevTools Protocol/);
});

test("an unreadable default-browser setting is reported as unknown, not as Safari", () => {
  const r = chooseBrowser({ configured: null, systemDefault: null, installed: [arc], userDataDir: null });
  assert.equal(r.key, "arc");
  assert.match(r.note, /could not be determined/);
});
