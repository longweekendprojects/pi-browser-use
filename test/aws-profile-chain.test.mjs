import test from "node:test";
import assert from "node:assert/strict";

import { parseAwsConfig, resolveSsoProfile } from "../helpers.mjs";

const config = parseAwsConfig(`
[sso-session recora-default]
sso_start_url = https://example.awsapps.com/start
sso_region = us-east-1

[default]
sso_session = recora-default
sso_account_id = 387496244796

[profile worldbuilder-agent]
role_arn = arn:aws:iam::387496244796:role/worldbuilder-agent-readonly-dev
source_profile = default  # inherits the operator's SSO session

[profile orphan]
role_arn = arn:aws:iam::1:role/nowhere
source_profile = missing

[profile standalone]
region = us-east-2
`);

test("sso-session blocks are not mistaken for profiles", () => {
  assert.deepEqual(Object.keys(config).sort(), ["default", "orphan", "standalone", "worldbuilder-agent"]);
  assert.equal(config["worldbuilder-agent"].source_profile, "default");
});

test("a profile with its own SSO session logs in as itself", () => {
  assert.equal(resolveSsoProfile("default", config).profile, "default");
});

test("a role-assumption profile logs in through the profile it chains from", () => {
  const r = resolveSsoProfile("worldbuilder-agent", config);
  assert.equal(r.profile, "default");
  assert.deepEqual(r.chain, ["worldbuilder-agent", "default"]);
});

test("a chain that leads nowhere says so instead of calling aws sso login", () => {
  assert.match(resolveSsoProfile("orphan", config).error, /not defined in the AWS config/);
  assert.match(resolveSsoProfile("standalone", config).error, /no SSO configuration/);
});

test("an unknown profile is still handed to the AWS CLI to judge", () => {
  const r = resolveSsoProfile("not-in-config", config);
  assert.equal(r.ok, true);
  assert.equal(r.unverified, true);
});

test("a looping source_profile chain terminates", () => {
  const loop = parseAwsConfig(`
[profile a]
source_profile = b
[profile b]
source_profile = a
`);
  assert.match(resolveSsoProfile("a", loop).error, /loops back on itself/);
});
