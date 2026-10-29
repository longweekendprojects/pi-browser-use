// The prefs that keep the user's Firefox intact (and the -profile launch flag)
// must land on the profile the launched app actually runs, never a sibling.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { firefoxProfile } from "../helpers.mjs";

test("the profile last run by the launched app is chosen, and an unknown app gets none", () => {
  const root = mkdtempSync(join(tmpdir(), "pbu-ff-"));
  const profile = (rel, app) => {
    mkdirSync(join(root, rel), { recursive: true });
    writeFileSync(join(root, rel, "compatibility.ini"), `[Compatibility]\nLastPlatformDir=${app}/Contents/Resources\n`);
  };
  profile("Profiles/a.default-release", "/Applications/Firefox.app");
  profile("Profiles/b.default-release-1", "/Applications/Nightly.app");
  writeFileSync(
    join(root, "profiles.ini"),
    "[Install1]\nDefault=Profiles/a.default-release\n\n[Profile0]\nPath=Profiles/a.default-release\n\n[Install2]\nDefault=Profiles/b.default-release-1\n\n[Profile1]\nPath=Profiles/b.default-release-1\n",
  );
  assert.equal(firefoxProfile("/Applications/Nightly.app", root), join(root, "Profiles/b.default-release-1"));
  assert.equal(firefoxProfile("/Applications/Firefox.app", root), join(root, "Profiles/a.default-release"));
  assert.equal(firefoxProfile("/Applications/Other.app", root), null);
});
