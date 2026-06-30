// Shortcut: aws-sso-login
// Refresh expired AWS SSO credentials end to end, driving the browser through
// the identity-provider account chooser. Encodes the hard-won recipe:
//   1. short-circuit if the token is already valid (idempotent)
//   2. start `aws sso login --no-browser` and capture the authorization URL,
//      so the agent controls which browser handles it
//   3. drive a dedicated new tab through the redirect chain (never touches the
//      user's other tabs), accepting cookie banners that block the SPA
//   4. on the IdP account chooser, pick the configured account (never hardcoded)
//   5. confirm the CLI callback fired and verify with get-caller-identity
//
// The account is chosen from params.account or config.aws.ssoAccountEmail. If
// neither is set, the shortcut returns the accounts it found and asks rather
// than guessing.

const Q = new URL(import.meta.url).search;
const imp = (rel) => import(new URL(rel, import.meta.url).href + Q);
const { sh, spawnCapture, ensureArc, connect, acceptCookieBanner, loadConfig, sleep } = await imp("../helpers.mjs");

export const meta = {
  name: "aws-sso-login",
  summary: "Refresh expired AWS SSO credentials by driving the browser login and IdP account selection.",
  params: "profile?(=config default|'default') | account?(=config aws.ssoAccountEmail) | force?(=false)",
};

async function callerIdentity(profile) {
  const r = await sh("aws", ["sts", "get-caller-identity", "--profile", profile, "--output", "json"], 15000);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

// Returns the email addresses offered on a Google/SAML account chooser.
async function listAccounts(page) {
  return await page
    .evaluate(() => {
      const out = new Set();
      for (const el of document.querySelectorAll("a,[data-identifier],[role=link],li")) {
        const id = el.getAttribute && el.getAttribute("data-identifier");
        if (id && id.includes("@")) out.add(id);
        const m = (el.innerText || "").match(/[\w.+-]+@[\w.-]+\.\w+/);
        if (m) out.add(m[0]);
      }
      return [...out];
    })
    .catch(() => []);
}

// Trusted Playwright click on the account row. A synthetic DOM .click() is not
// enough: Google's chooser only navigates on a real user-style click.
async function clickAccount(page, email) {
  try {
    const loc = page.getByText(email, { exact: false }).first();
    await loc.waitFor({ state: "visible", timeout: 5000 });
    await loc.click({ timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// Trusted click on the first button/link whose visible text matches `re`.
async function clickButtonByText(page, re) {
  try {
    const items = page.locator("button, [role=button], a");
    const n = Math.min(await items.count(), 40);
    for (let i = 0; i < n; i++) {
      const b = items.nth(i);
      const t = ((await b.innerText().catch(() => "")) || "").trim();
      if (t && re.test(t)) {
        await b.click({ timeout: 4000 }).catch(() => {});
        return t;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function run(params, opts = {}) {
  const cfg = loadConfig();
  const profile = params.profile || cfg.aws?.defaultProfile || "default";
  const account = params.account || cfg.aws?.ssoAccountEmail || null;
  const onUpdate = opts.onUpdate || (() => {});
  const note = (t) => onUpdate({ content: [{ type: "text", text: t }] });

  // 1. Idempotent: already valid?
  if (!params.force) {
    const who = await callerIdentity(profile);
    if (who) return { text: `Already authenticated as ${who.Arn} (profile ${profile}).`, details: { profile, arn: who.Arn, skipped: true } };
  }

  // 2. Arc must be up with the debug port.
  const ens = await ensureArc(opts);
  if (!ens.ok) return { text: `ERROR: ${ens.error}`, details: ens, isError: true };

  // 3. Start login, capture the authorization URL.
  note(`Starting aws sso login (profile ${profile})...`);
  const login = spawnCapture("aws", ["sso", "login", "--profile", profile, "--no-browser"], /https:\/\/oidc[^\s]+/, 15000);
  const url = await login.match;
  if (!url) {
    login.child.kill();
    return { text: "ERROR: did not receive an authorization URL from aws sso login", details: { output: login.getOutput().slice(0, 500) }, isError: true };
  }

  // 4. Drive a dedicated tab through the redirect chain.
  const { browser, ctx } = await connect();
  const page = await ctx.newPage();
  let result;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    const deadline = Date.now() + 120000;
    let selected = false;
    let selectedAt = 0;
    let needPassword = false;
    while (Date.now() < deadline) {
      // CLI callback received -> login finished.
      const exitCode = await Promise.race([login.exited, Promise.resolve("pending")]);
      if (exitCode !== "pending") break;

      const cur = page.url();

      if (cur.includes("127.0.0.1") && cur.includes("callback")) {
        await Promise.race([login.exited, sleep(5000)]);
        break;
      }

      if (cur.includes("accounts.google.com")) {
        if (/accountchooser|identifier|selectaccount/i.test(cur) && !selected) {
          if (!account) {
            const found = await listAccounts(page);
            result = { text: `Account choice needed. Available: ${found.join(", ") || "(none detected)"}. Set config aws.ssoAccountEmail or pass account=, then retry.`, details: { accounts: found, needsAccount: true }, isError: true };
            break;
          }
          note(`Selecting account ${account}...`);
          const ok = await clickAccount(page, account);
          if (ok) {
            selected = true;
            selectedAt = Date.now();
          } else {
            const found = await listAccounts(page);
            if (found.length) {
              result = { text: `Configured account ${account} not offered. Available: ${found.join(", ")}.`, details: { accounts: found, configured: account }, isError: true };
              break;
            }
          }
        } else if (/signin\/v2|pwd|challenge|password|rejected/i.test(cur)) {
          if (!needPassword) {
            needPassword = true;
            note("Google is asking for a password or 2FA. Please complete it in Arc; I'll keep watching for the callback.");
          }
        } else if (selected) {
          // Post-selection consent/continue interstitial, if any.
          await clickButtonByText(page, /^(continue|allow|confirm|next)$/i);
          // If we bounced back to the chooser, the click did not take; retry once.
          if (/accountchooser|selectaccount/i.test(page.url()) && Date.now() - selectedAt > 6000) selected = false;
        }
      } else if (cur.includes("awsapps.com")) {
        await acceptCookieBanner(page);
        await clickButtonByText(page, /^(allow access|allow|confirm and continue|approve|continue)$/i);
      }

      await sleep(2000);
    }

    if (!result) {
      const code = await Promise.race([login.exited, sleep(8000).then(() => "timeout")]);
      const who = await callerIdentity(profile);
      if (who) {
        result = { text: `Logged in. ${who.Arn} (profile ${profile}).`, details: { profile, arn: who.Arn, account } };
      } else {
        result = { text: `Login did not complete (exit ${code}). The browser may need a password or 2FA; complete it in Arc and retry.`, details: { profile, exit: code, output: login.getOutput().slice(-400) }, isError: true };
      }
    }
  } catch (e) {
    result = { text: `ERROR: ${e.message}`, details: {}, isError: true };
  } finally {
    await page.close().catch(() => {}); // close only the tab we created
    await browser.close().catch(() => {}); // detach CDP; user's browser stays open
    if (login.child.exitCode === null) login.child.kill();
  }
  return result;
}
