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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

// --- Browser selection ------------------------------------------------------
// The engine speaks Chrome DevTools Protocol, so it drives any Chromium-family
// browser; only launching is browser-specific. Arc is the browser this tool was
// built against, but a machine whose everyday browser is Chrome, Edge, or Brave
// should be driven there instead of having Arc relaunched under the user.
//
// `profileLock` records the Chromium 136 change that made --remote-debugging-port
// a no-op on the default profile: from that version a browser can only be driven
// with a separate --user-data-dir, which is a fresh profile without the user's
// logins. Such a browser cannot honor this tool's premise (act inside the user's
// real session), so it is chosen only when nothing better is installed and only
// with an explicit userDataDir opt-in.
//
// `chromiumVersioned` says whether the app's own version number is the Chromium
// version. Chrome, Edge, and Chromium version in lockstep with Chromium, so a
// build older than 136 can be proven unlocked. Brave (1.x), Vivaldi (7.x), and
// Opera number on their own tracks, so their version proves nothing and they are
// assumed locked rather than promised to the user as drivable.

export const BROWSERS = {
  arc: { label: "Arc", app: "Arc", proc: "Arc", bundleId: "company.thebrowser.browser" },
  dia: { label: "Dia", app: "Dia", proc: "Dia", bundleId: "company.thebrowser.dia" },
  chrome: { label: "Google Chrome", app: "Google Chrome", proc: "Google Chrome", bundleId: "com.google.chrome", profileLock: { since: 136, chromiumVersioned: true } },
  edge: { label: "Microsoft Edge", app: "Microsoft Edge", proc: "Microsoft Edge", bundleId: "com.microsoft.edgemac", profileLock: { since: 136, chromiumVersioned: true } },
  chromium: { label: "Chromium", app: "Chromium", proc: "Chromium", bundleId: "org.chromium.chromium", profileLock: { since: 136, chromiumVersioned: true } },
  brave: { label: "Brave Browser", app: "Brave Browser", proc: "Brave Browser", bundleId: "com.brave.browser", profileLock: { since: 136, chromiumVersioned: false } },
  vivaldi: { label: "Vivaldi", app: "Vivaldi", proc: "Vivaldi", bundleId: "com.vivaldi.vivaldi", profileLock: { since: 136, chromiumVersioned: false } },
  opera: { label: "Opera", app: "Opera", proc: "Opera", bundleId: "com.operasoftware.opera", profileLock: { since: 136, chromiumVersioned: false } },
};

// Browsers that exist on macOS but cannot be driven by this tool at all, with
// the reason the user needs to hear instead of a generic connection timeout.
export const UNDRIVABLE_BROWSERS = {
  safari: {
    label: "Safari",
    bundleId: "com.apple.safari",
    reason:
      "Safari does not speak the Chrome DevTools Protocol. Its WebDriver and MCP automation run an isolated session that does not carry your cookies or logins, which is the whole point of this tool, so Safari is not supported.",
  },
  firefox: {
    label: "Firefox",
    bundleId: "org.mozilla.firefox",
    reason: "Firefox does not expose the Chrome DevTools Protocol endpoint this tool drives, so it is not supported.",
  },
};

// Order used when neither config nor the system default settles it. Browsers
// that can still be driven on the user's real profile come first.
const PREFERENCE = ["arc", "dia", "chrome", "edge", "brave", "vivaldi", "chromium", "opera"];

const APP_DIRS = ["/Applications", join(homedir(), "Applications"), "/System/Applications"];

function appPath(spec) {
  for (const d of APP_DIRS) {
    const p = join(d, `${spec.app}.app`);
    if (existsSync(p)) return p;
  }
  return null;
}

async function appMajorVersion(path) {
  const r = await sh("defaults", ["read", join(path, "Contents", "Info.plist"), "CFBundleShortVersionString"], 5000);
  const m = r.stdout.trim().match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

function expandHome(p) {
  return p?.startsWith("~") ? join(homedir(), p.slice(1)) : p || null;
}

// The browser macOS opens links in, as a registry key ('chrome'), an undrivable
// key ('safari'), or a raw bundle id when it is something we do not know. Returns
// null when LaunchServices could not be read: an unreadable preference file is not
// evidence that the user browses in Safari, and saying so would send them looking
// in the wrong place.
export async function systemDefaultBrowser() {
  const plist = join(homedir(), "Library", "Preferences", "com.apple.LaunchServices", "com.apple.launchservices.secure.plist");
  const r = await sh("plutil", ["-convert", "json", "-o", "-", plist], 5000);
  let id;
  try {
    const handlers = JSON.parse(r.stdout)?.LSHandlers || [];
    const https = handlers.find((h) => h.LSHandlerURLScheme === "https") || handlers.find((h) => h.LSHandlerURLScheme === "http");
    // A parsed file with no https handler means the user never changed the handler,
    // which is macOS shipping Safari as the default.
    id = String(https?.LSHandlerRoleAll || "com.apple.safari");
  } catch {
    return null;
  }
  id = id.toLowerCase();
  for (const [key, spec] of Object.entries(BROWSERS)) if (spec.bundleId === id) return key;
  for (const [key, spec] of Object.entries(UNDRIVABLE_BROWSERS)) if (spec.bundleId === id) return key;
  return id;
}

// What is installed, at which version, and whether it can be driven on the
// user's own profile. Used for selection and for the `browsers` action.
export async function detectBrowsers({ userDataDir } = {}) {
  const found = [];
  for (const key of PREFERENCE) {
    const spec = BROWSERS[key];
    const path = appPath(spec);
    if (!path) continue;
    const lock = spec.profileLock;
    const major = lock?.chromiumVersioned ? await appMajorVersion(path) : null;
    const profileLocked = isProfileLocked(spec, major);
    found.push({
      key,
      label: spec.label,
      path,
      major,
      versionUnknown: Boolean(lock?.chromiumVersioned && major == null),
      profileLocked,
      realProfile: !profileLocked,
      drivable: !profileLocked || Boolean(userDataDir),
    });
  }
  return found;
}

// Fail closed: a profile lock is lifted only by a version that proves the build
// predates it. An unreadable version, or a browser whose numbering does not track
// Chromium, counts as locked, because promising the user their logged-in profile
// and then failing to open the port costs them the browser they were working in.
export function isProfileLocked(spec, major) {
  const lock = spec?.profileLock;
  if (!lock) return false;
  return !(lock.chromiumVersioned && major != null && major < lock.since);
}

// Pure choice given what the machine looks like, so the ordering is testable
// without a browser. Returns { ok, key?, note?, error? }.
export function chooseBrowser({ configured, systemDefault, installed, userDataDir }) {
  const byKey = (k) => installed.find((b) => b.key === k);

  if (configured) {
    const key = String(configured).toLowerCase();
    if (UNDRIVABLE_BROWSERS[key]) return { ok: false, error: `Configured browser "${key}" cannot be driven. ${UNDRIVABLE_BROWSERS[key].reason}` };
    if (!BROWSERS[key]) return { ok: false, error: `Unknown browser "${configured}". Known: ${Object.keys(BROWSERS).join(", ")}.` };
    const b = byKey(key);
    if (!b) return { ok: false, error: `Configured browser ${BROWSERS[key].label} is not installed.` };
    if (!b.drivable) return { ok: false, error: profileLockError(b) };
    return { ok: true, key, note: `configured browser` };
  }

  const def = byKey(systemDefault);
  if (def?.realProfile) return { ok: true, key: def.key, note: "your default browser" };

  const best = installed.find((b) => b.realProfile);
  if (best) {
    const why = UNDRIVABLE_BROWSERS[systemDefault]
      ? `${UNDRIVABLE_BROWSERS[systemDefault].label} is your default browser but cannot be driven`
      : def
        ? `${def.label} is your default browser but only exposes debugging on a throwaway profile`
        : systemDefault
          ? "your default browser is not a supported Chromium browser"
          : "your default browser could not be determined";
    return { ok: true, key: best.key, note: `${why}, so ${best.label} is used instead` };
  }

  const fallback = (def?.drivable && def) || installed.find((b) => b.drivable);
  if (fallback) return { ok: true, key: fallback.key, note: `using the separate automation profile at ${userDataDir}` };

  const locked = installed.filter((b) => b.profileLocked);
  if (locked.length) return { ok: false, error: profileLockError(locked[0]) };
  return {
    ok: false,
    error: `No supported browser found. This tool drives Chromium-family browsers (${Object.keys(BROWSERS).join(", ")}). ${UNDRIVABLE_BROWSERS[systemDefault]?.reason || ""}`.trim(),
  };
}

function profileLockError(b) {
  const version = b.versionUnknown ? " (version could not be read, so it is assumed current)" : b.major ? ` ${b.major}` : "";
  return `${b.label}${version} does not expose the debug port on your normal profile (Chromium 136 removed that), so it cannot be driven inside your logged-in session. Install or configure another Chromium browser ("browser" in ~/.pi/config/pi-browser-use/config.json), or set "userDataDir" there to drive ${b.label} in a separate automation profile you sign into once.`;
}

// Which browser is answering on the debug port, or null when nothing is. Identify
// it from the process that owns the listening socket: with several Chromium
// browsers running, the port holder is the only honest answer.
export async function connectedBrowser() {
  if (!(await cdpUp())) return null;
  const pids = await sh("lsof", ["-ti", `tcp:${PORT}`, "-sTCP:LISTEN"], 5000);
  const pid = pids.stdout.trim().split("\n")[0];
  if (pid) {
    const ps = await sh("ps", ["-p", pid, "-o", "comm="], 5000);
    const cmd = ps.stdout.trim();
    for (const [key, spec] of Object.entries(BROWSERS)) {
      if (cmd.includes(`/${spec.app}.app/`) || cmd.endsWith(`/${spec.proc}`)) return { key, label: spec.label };
    }
    if (cmd) return { key: null, label: cmd.split("/").pop() };
  }
  const ver = await httpJson("/json/version", 2000);
  return { key: null, label: String(ver?.Browser || "a Chromium browser") };
}

// Config and environment inputs for selection, shared by ensureBrowser and the
// `browsers` diagnostic so the two can never disagree about what was asked for.
export function browserSettings({ browser } = {}) {
  const cfg = loadConfig();
  const configured = browser || process.env.PI_BROWSER_USE_BROWSER || cfg.browser || null;
  return {
    configured,
    configuredKey: configured ? String(configured).toLowerCase() : null,
    userDataDir: expandHome(process.env.PI_BROWSER_USE_USER_DATA_DIR || cfg.userDataDir),
    // Standing consent for the quit-and-relaunch, so an agent is not stopped by a
    // yes/no prompt mid-task. Env wins over config; config is the durable opt-in.
    assumeYes: process.env.PI_BROWSER_USE_ASSUME_YES
      ? /^(1|true|yes)$/i.test(process.env.PI_BROWSER_USE_ASSUME_YES)
      : cfg.autoApproveRelaunch === true,
  };
}

// Guarantee a drivable browser is running with the CDP port. No-op when the
// port is already up. Enabling the port needs a quit+reopen (tabs and logins
// persist); gate that behind `confirm`.
export async function ensureBrowser({ confirm, browser } = {}) {
  const { configured, configuredKey, userDataDir, assumeYes } = browserSettings({ browser });

  // The debug port is one machine-wide resource, so whoever already holds it is what
  // can be driven; config cannot outrank it without quitting the browser the user is
  // in. Name the disagreement rather than leaving it to be inferred.
  const holder = await connectedBrowser();
  if (holder) {
    const mismatch = configuredKey && BROWSERS[configuredKey] && holder.key !== configuredKey;
    return {
      ok: true,
      relaunched: false,
      browser: holder.label,
      note: mismatch
        ? `${BROWSERS[configuredKey].label} is configured, but ${holder.label} already holds the debug port; quit ${holder.label} and retry to switch`
        : undefined,
    };
  }

  const [systemDefault, installed] = await Promise.all([systemDefaultBrowser(), detectBrowsers({ userDataDir })]);
  const choice = chooseBrowser({ configured, systemDefault, installed, userDataDir });
  if (!choice.ok) return { ok: false, error: choice.error, systemDefault, installed: installed.map((b) => b.key) };

  const picked = installed.find((b) => b.key === choice.key);
  const spec = BROWSERS[choice.key];
  const separateProfile = Boolean(picked?.profileLocked && userDataDir);
  const ps = await sh("pgrep", ["-x", spec.proc]);
  if (ps.stdout.trim()) {
    const prompt = separateProfile
      ? `${spec.label} can only be driven in a separate automation profile. Quit ${spec.label} and reopen it in the profile at ${userDataDir}? That profile has its own tabs and sign-ins, so your current tabs and logins are not carried over.`
      : `${spec.label} is running without the debug port. Quit and relaunch ${spec.label} to enable browser control? Your tabs${choice.key === "arc" ? ", spaces," : ""} and logins are restored.`;
    if (assumeYes) {
      // Consent was given ahead of time, so do not stop to ask again.
    } else if (confirm) {
      if (!(await confirm(prompt))) return { ok: false, error: `User declined the ${spec.label} relaunch` };
    } else {
      // No way to ask means no consent. Quitting the window the user is working in is
      // not something to do on silence.
      return {
        ok: false,
        error: `${spec.label} is running without the debug port, and there is no way to ask for your confirmation here. Run the browser "ensure" action in an interactive session, quit ${spec.label} yourself, or start it with --remote-debugging-port=${PORT}. Set "autoApproveRelaunch": true in ~/.pi/config/pi-browser-use/config.json (or PI_BROWSER_USE_ASSUME_YES=1) to allow unattended relaunches.`,
        browser: spec.label,
      };
    }
    const quit = await sh("osascript", ["-e", `quit app "${spec.app}"`]);
    await sleep(2500);
    const still = await sh("pgrep", ["-x", spec.proc]);
    if (still.stdout.trim()) {
      const why = quit.stderr.trim() || (quit.code ? `osascript exited ${quit.code}` : "it is still running");
      return { ok: false, error: `${spec.label} did not quit (${why}), so the debug port could not be enabled. These browsers drop the flag when an instance is already running: close ${spec.label} manually and retry.`, browser: spec.label };
    }
  }

  const args = [`--remote-debugging-port=${PORT}`, `--remote-allow-origins=${ORIGIN}`];
  if (separateProfile) args.push(`--user-data-dir=${userDataDir}`);
  const opened = await sh("open", ["-na", spec.app, "--args", ...args]);
  if (opened.code) {
    return { ok: false, error: `Could not launch ${spec.label}: ${opened.stderr.trim() || `open exited ${opened.code}`}`, browser: spec.label };
  }
  for (let i = 0; i < 15; i++) {
    if (await cdpUp()) return { ok: true, relaunched: true, browser: spec.label, note: choice.note };
    await sleep(1000);
  }
  // The browser launched but never opened the port, so the build enforces a
  // restriction the registry does not know about yet.
  const hint = userDataDir
    ? ""
    : ` If this build is Chromium 136 or later, it only allows debugging in a separate profile: set "userDataDir" in ~/.pi/config/pi-browser-use/config.json.`;
  return { ok: false, error: `${spec.label} started but did not expose CDP on ${PORT}.${hint}`, browser: spec.label };
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

export function setAgentTarget(id, ownership) {
  writeState({ agentTargetId: id, agentTargetOwnership: ownership });
}
export function clearAgentTarget() {
  writeState({});
}
export function getAgentTarget() {
  const state = readState();
  if (!state.agentTargetId) return null;
  const ownership = state.agentTargetOwnership === "created" || state.agentTargetOwnership === "adopted"
    ? state.agentTargetOwnership
    : "unknown";
  return { id: state.agentTargetId, ownership };
}
export function getAgentTargetId() {
  return getAgentTarget()?.id || null;
}
export function canCloseAgentTarget(target) {
  return target?.ownership === "created";
}

// Run fn against the agent's own tab. With create=true, opens a fresh tab when
// none is owned (used by navigate) so the agent never grabs a user tab. With
// create=false, returns an instructive error when no agent tab exists.
export async function withAgentPage(fn, { create = false } = {}) {
  return withConnection(async (cdp) => {
    const targets = await listTargets();
    const saved = getAgentTarget();
    let targetId = saved?.id && targets.some((t) => t.id === saved.id) ? saved.id : null;
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
      setAgentTarget(targetId, "created");
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
  return cdp.send("Target.closeTarget", { targetId });
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
