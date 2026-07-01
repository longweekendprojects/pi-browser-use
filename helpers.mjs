// Shared low-level helpers for pi-browser-use.
//
// Transport: raw Chrome DevTools Protocol over a WebSocket, attaching to a
// single tab. This is deliberate. Playwright's connectOverCDP attaches to the
// whole browser (every page, iframe, worker, and service worker) on every
// call, which hangs indefinitely against a busy real browser with dozens of
// targets. Attaching to just the target tab over raw CDP is instant and
// unaffected by how many other tabs are open. No third-party dependency.
//
// Requires Node 22+ (global WebSocket and fetch).

import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const PORT = process.env.BROWSER_CDP_PORT || "9222";
export const ORIGIN = process.env.BROWSER_CDP_ORIGIN || "http://127.0.0.1";
export const CDP = `http://127.0.0.1:${PORT}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sh(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) =>
      resolve({ code: err?.code ?? 0, stdout: stdout || "", stderr: stderr || "" }),
    );
  });
}

// Spawn a long-running command without blocking. Returns the child, a promise
// that resolves with the first regex match on stdout/stderr, and an exit
// promise. Used for `aws sso login`, which blocks until the browser flow
// completes while printing the authorization URL up front.
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
  const match = Promise.race([matched, new Promise((res) => setTimeout(() => res(null), matchTimeout))]);
  const exited = new Promise((res) => child.on("exit", (code) => res(code ?? 0)));
  return { child, match, exited, getOutput: () => out };
}

async function httpJson(path, timeoutMs = 3000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(`${CDP}${path}`, { signal: c.signal });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function cdpUp() {
  return (await httpJson("/json/version", 2000)) != null;
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
    await sleep(2500);
  }
  await sh("open", ["-na", "Arc", "--args", `--remote-debugging-port=${PORT}`, `--remote-allow-origins=${ORIGIN}`]);
  for (let i = 0; i < 15; i++) {
    if (await cdpUp()) return { ok: true, relaunched: true };
    await sleep(1000);
  }
  return { ok: false, error: `Arc did not expose CDP on ${PORT}` };
}

// --- Raw CDP connection over the browser websocket --------------------------

class CDPConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.onmessage = (e) => this._onMessage(typeof e.data === "string" ? e.data : e.data.toString());
  }

  static async open() {
    const ver = await httpJson("/json/version", 3000);
    if (!ver?.webSocketDebuggerUrl) throw new Error(`CDP not reachable on ${PORT}`);
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error("CDP websocket error"));
    });
    return new CDPConnection(ws);
  }

  _onMessage(data) {
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (m.id != null && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message || JSON.stringify(m.error)));
      else p.res(m.result);
      return;
    }
    if (m.method) {
      const key = m.sessionId ? `${m.sessionId}:${m.method}` : m.method;
      const set = this.listeners.get(key);
      if (set) for (const fn of [...set]) fn(m.params);
    }
  }

  send(method, params = {}, sessionId, timeout = 30000) {
    const id = ++this.nextId;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      const t = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP timeout: ${method}`));
        }
      }, timeout);
      const done = (fn) => (v) => {
        clearTimeout(t);
        fn(v);
      };
      this.pending.set(id, { res: done(res), rej: done(rej) });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method, sessionId, fn) {
    const key = sessionId ? `${sessionId}:${method}` : method;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(fn);
    return () => this.listeners.get(key)?.delete(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// A session attached to exactly one page target. Exposes the small surface the
// engine needs, with trusted input (real CDP mouse/keyboard events).
class PageSession {
  constructor(cdp, targetId, sessionId) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }
  s(method, params, timeout) {
    return this.cdp.send(method, params, this.sessionId, timeout);
  }
  async enable() {
    await this.s("Page.enable").catch(() => {});
    await this.s("Runtime.enable").catch(() => {});
  }
  async navigate(url, timeout = 20000) {
    await this.s("Page.navigate", { url });
    const deadline = Date.now() + timeout;
    await sleep(250); // let the new navigation begin before polling
    while (Date.now() < deadline) {
      const rs = await this.evaluate("document.readyState").catch(() => null);
      if (rs === "complete") break;
      await sleep(150);
    }
    await sleep(100);
    return this.url();
  }
  async evaluate(exprOrFn, arg) {
    let expression;
    if (typeof exprOrFn === "function") {
      expression = arg === undefined ? `(${exprOrFn})()` : `(${exprOrFn})(${JSON.stringify(arg)})`;
    } else {
      expression = exprOrFn;
    }
    const r = await this.s("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "evaluate error");
    }
    return r.result?.value;
  }
  url() {
    return this.evaluate("location.href");
  }
  title() {
    return this.evaluate("document.title");
  }
  innerText() {
    return this.evaluate("document.body ? document.body.innerText : ''");
  }
  // Compute the click point of the element returned by a JS expression, after
  // scrolling it into view. Returns null if not found or not visible.
  async _point(elExpr) {
    const expr = `(() => { const el = ${elExpr}; if (!el) return null; el.scrollIntoView({block:'center',inline:'center'}); const r = el.getBoundingClientRect(); if (r.width<=0||r.height<=0) return null; return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`;
    return this.evaluate(expr);
  }
  async _clickAt(x, y) {
    await this.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.s("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.s("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 1, clickCount: 1 });
  }
  async clickSelector(selector) {
    const pt = await this._point(`document.querySelector(${JSON.stringify(selector)})`);
    if (!pt) throw new Error(`click: element not found or not visible: ${selector}`);
    await this._clickAt(pt.x, pt.y);
    return selector;
  }
  async clickRef(ref) {
    return this.clickSelector(`[data-pbu-ref="${ref}"]`);
  }
  async clickText(text) {
    // Pick the smallest visible element containing the text (most specific),
    // matching Playwright getByText semantics; the click bubbles to handlers.
    const finder = `(() => {
      const t = ${JSON.stringify(text)};
      const els = [...document.querySelectorAll('a,button,[role=button],[role=link],[role=menuitem],[role=tab],input,label,div,span,li')];
      const m = els.filter(e => ((e.innerText||e.value||(e.getAttribute&&e.getAttribute('aria-label'))||'').includes(t)) && e.getBoundingClientRect().width>0 && e.getBoundingClientRect().height>0);
      if (!m.length) return null;
      m.sort((a,b) => { const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect(); return (ra.width*ra.height)-(rb.width*rb.height); });
      return m[0];
    })()`;
    const pt = await this._point(finder);
    if (!pt) throw new Error(`click: visible text not found: ${text}`);
    await this._clickAt(pt.x, pt.y);
    return `text:${text}`;
  }
  // Trusted click on the first button/link/element whose visible text matches a
  // regex source string (case-insensitive).
  async clickTextRegex(reSource) {
    const finder = `(() => { const re = new RegExp(${JSON.stringify(reSource)}, 'i'); const els = [...document.querySelectorAll('button,[role=button],a')]; const el = els.find(e => re.test((e.innerText||e.getAttribute('aria-label')||'').trim()) && e.getBoundingClientRect().width>0); return el || null; })()`;
    const pt = await this._point(finder);
    if (!pt) return null;
    await this._clickAt(pt.x, pt.y);
    return true;
  }
  async fill(selector, value) {
    const focused = await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); if ('value' in el) el.value=''; return true; })()`,
    );
    if (!focused) throw new Error(`fill: element not found: ${selector}`);
    await this.s("Input.insertText", { text: String(value) });
    await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) { el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } })()`,
    );
    return selector;
  }
  async screenshot(path) {
    const r = await this.s("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(path, Buffer.from(r.data, "base64"));
    return path;
  }
}

// List real page targets (fast HTTP, no attach). id is the CDP targetId.
export async function listTargets() {
  const list = (await httpJson("/json/list", 4000)) || [];
  return list.filter((t) => t.type === "page" && !String(t.url).startsWith("devtools://"));
}

export async function withConnection(fn) {
  const cdp = await CDPConnection.open();
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

async function attach(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const ps = new PageSession(cdp, targetId, sessionId);
  await ps.enable();
  return ps;
}

// --- Dedicated agent tab ----------------------------------------------------
// The agent only ever acts on a tab it owns, identified by a stable CDP target
// id persisted across calls. It never reuses a tab the user opened. The user
// hands over one of their tabs explicitly via the `tab` action.

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

export function setAgentTargetId(id) {
  writeState({ agentTargetId: id });
}
export function getAgentTargetId() {
  return readState().agentTargetId || null;
}

// Run fn against the agent's own tab. With create=true, opens a fresh tab when
// none is owned (used by navigate) so the agent never grabs a user tab. With
// create=false, returns an instructive error when no agent tab exists.
export async function withAgentPage(fn, { create = false } = {}) {
  return withConnection(async (cdp) => {
    const targets = await listTargets();
    const owned = getAgentTargetId();
    let targetId = owned && targets.some((t) => t.id === owned) ? owned : null;
    if (!targetId) {
      if (!create) {
        return {
          text: "No agent tab yet. The agent never reuses tabs you opened. Use `navigate` to open the agent's own tab, or `tab` to explicitly hand over one of your tabs.",
          details: { noAgentTab: true },
          isError: true,
        };
      }
      const { targetId: newId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      targetId = newId;
      setAgentTargetId(targetId);
      await sleep(150);
    }
    const page = await attach(cdp, targetId);
    return fn(page, cdp);
  });
}

// Attach directly to a target id (used by shortcuts that manage their own tab).
export async function attachTarget(cdp, targetId) {
  return attach(cdp, targetId);
}
export async function createPage(cdp, url = "about:blank") {
  const { targetId } = await cdp.send("Target.createTarget", { url });
  await sleep(150);
  return attach(cdp, targetId);
}
export async function closeTarget(cdp, targetId) {
  await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
}

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
    return await page.evaluate(`(() => {
      const walk = (root) => {
        for (const b of root.querySelectorAll("button,[role=button],a")) {
          const t = (b.innerText || b.getAttribute("aria-label") || "").trim();
          if (/^(accept|accept all|allow all)$/i.test(t)) { b.click(); return t; }
        }
        for (const e of root.querySelectorAll("*")) if (e.shadowRoot && walk(e.shadowRoot)) return true;
        return false;
      };
      return walk(document) || null;
    })()`);
  } catch {
    return null;
  }
}

// Config: global file, optional env override.
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
