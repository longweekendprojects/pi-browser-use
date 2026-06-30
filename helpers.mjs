// Shared low-level helpers for pi-browser-use. Imported by both the primitive
// engine and the shortcut library so there is no circular dependency.

import { chromium } from "playwright-core";
import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const PORT = process.env.BROWSER_CDP_PORT || "9222";
export const ORIGIN = process.env.BROWSER_CDP_ORIGIN || "http://127.0.0.1";
export const CDP = `http://127.0.0.1:${PORT}`;

// Run a command to completion, capturing output (never rejects).
export function sh(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) =>
      resolve({ code: err?.code ?? 0, stdout: stdout || "", stderr: stderr || "" }),
    );
  });
}

// Spawn a long-running command without blocking. Returns the child plus a
// promise that resolves with the first regex match seen on stdout/stderr, and
// a promise that resolves on exit. Used for `aws sso login`, which blocks until
// the browser flow completes while printing the authorization URL up front.
export function spawnCapture(cmd, args, matchRe, matchTimeout = 15000) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let resolveMatch;
  const matched = new Promise((res) => (resolveMatch = res));
  const onData = (d) => {
    out += d.toString();
    if (matchRe) {
      const m = out.match(matchRe);
      if (m) resolveMatch(m[0]);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const matchWithTimeout = Promise.race([
    matched,
    new Promise((res) => setTimeout(() => res(null), matchTimeout)),
  ]);
  const exited = new Promise((res) => child.on("exit", (code) => res(code ?? 0)));
  return { child, match: matchWithTimeout, exited, getOutput: () => out };
}

export async function cdpUp() {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 2000);
    const r = await fetch(`${CDP}/json/version`, { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

// Guarantee Arc is running with the CDP port. No-op when already up. Relaunch
// needs a quit+reopen (tabs/logins persist); gate it behind `confirm`.
export async function ensureArc({ confirm } = {}) {
  if (await cdpUp()) return { ok: true, relaunched: false };
  const ps = await sh("pgrep", ["-x", "Arc"]);
  if (ps.stdout.trim()) {
    const ok = confirm
      ? await confirm(
          "Arc is running without the debug port. Quit and relaunch Arc to enable browser control? Your tabs, spaces, and logins are restored.",
        )
      : true;
    if (!ok) return { ok: false, error: "User declined Arc relaunch" };
    await sh("osascript", ["-e", 'quit app "Arc"']);
    await new Promise((r) => setTimeout(r, 2500));
  }
  await sh("open", ["-na", "Arc", "--args", `--remote-debugging-port=${PORT}`, `--remote-allow-origins=${ORIGIN}`]);
  for (let i = 0; i < 15; i++) {
    if (await cdpUp()) return { ok: true, relaunched: true };
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false, error: `Arc did not expose CDP on ${PORT}` };
}

export async function connect() {
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0] || (await browser.newContext());
  return { browser, ctx };
}

// Connect, run fn against the live context, always detach (never closes the
// user's browser).
export async function withConnect(fn) {
  const { browser, ctx } = await connect();
  try {
    return await fn(ctx, browser);
  } finally {
    await browser.close();
  }
}

// --- Dedicated agent tab -------------------------------------------------
// The agent only ever acts on a tab it owns, identified by a stable CDP
// target id persisted across tool calls. It never reuses a tab the user
// opened. The user hands over one of their tabs explicitly via the `tab`
// action, which is the only path that repoints ownership.

const STATE_FILE = join(homedir(), ".pi", "state", "pi-browser-use.json");

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function writeState(s) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s));
  } catch {
    /* best effort */
  }
}

export async function targetIdOf(ctx, page) {
  try {
    const s = await ctx.newCDPSession(page);
    const info = await s.send("Target.getTargetInfo");
    await s.detach().catch(() => {});
    return info.targetInfo.targetId;
  } catch {
    return null;
  }
}

// Return the agent-owned page, or null if it does not exist (closed, or never
// created). Never falls back to a user tab.
export async function findAgentPage(ctx) {
  const id = readState().agentTargetId;
  if (!id) return null;
  for (const p of ctx.pages()) {
    if (p.url().startsWith("devtools://")) continue;
    if ((await targetIdOf(ctx, p)) === id) return p;
  }
  return null;
}

// Point agent ownership at a specific page (explicit user takeover).
export async function adoptPage(ctx, page) {
  const id = await targetIdOf(ctx, page);
  writeState({ agentTargetId: id });
  return id;
}

// Run fn against the agent's own tab. With create=true, opens a fresh tab when
// none is owned (used by navigate) so the agent never grabs a user tab. With
// create=false, returns an instructive error when no agent tab exists.
export async function withAgentPage(fn, { create = false } = {}) {
  return await withConnect(async (ctx, browser) => {
    let page = await findAgentPage(ctx);
    if (!page) {
      if (!create)
        return {
          text: "No agent tab yet. The agent never reuses tabs you opened. Use `navigate` to open the agent's own tab, or `tab` to explicitly hand over one of your tabs.",
          details: { noAgentTab: true },
          isError: true,
        };
      page = await ctx.newPage();
      await adoptPage(ctx, page);
    }
    return await fn(page, ctx, browser);
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keep obvious secrets out of model-visible output and session logs.
const REDACTIONS = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]"],
  [/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|xox[baprs])[-_][A-Za-z0-9_]{12,}\b/g, "[REDACTED_TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, "Bearer [REDACTED]"],
];
export function redact(s) {
  if (!s) return s;
  let out = String(s);
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

// Best-effort accept of a cookie-consent banner that may live in shadow DOM.
export async function acceptCookieBanner(page) {
  try {
    return await page.evaluate(() => {
      const walk = (root) => {
        for (const b of root.querySelectorAll("button,[role=button],a")) {
          const t = (b.innerText || b.getAttribute("aria-label") || "").trim();
          if (/^(accept|accept all|allow all)$/i.test(t)) {
            b.click();
            return t;
          }
        }
        for (const e of root.querySelectorAll("*")) if (e.shadowRoot && walk(e.shadowRoot)) return true;
        return false;
      };
      return walk(document) || null;
    });
  } catch {
    return null;
  }
}

// Config: global file, optional env override. Account choice and default
// profile live here so nothing is hardcoded in the shortcut.
//   ~/.pi/config/pi-browser-use/config.json
//   PI_BROWSER_USE_CONFIG=/path/to/config.json
export function loadConfig() {
  const paths = [
    process.env.PI_BROWSER_USE_CONFIG,
    join(homedir(), ".pi", "config", "pi-browser-use", "config.json"),
  ].filter(Boolean);
  for (const p of paths) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      /* try next */
    }
  }
  return {};
}
