// WebDriver BiDi transport for Firefox.
//
// Firefox removed its Chrome DevTools Protocol endpoint, so it is driven over
// WebDriver BiDi, the protocol it serves on --remote-debugging-port. This module
// gives BiDi the same small surface the CDP transport in helpers.mjs has: a
// connection that lists, creates, attaches, and closes tabs, and a page session
// with evaluate, navigation, trusted input, and screenshots. Callers do not need
// to know which protocol is underneath.
//
// Calls do not talk to Firefox directly. Firefox allows one automation session
// and renumbers every tab when it ends, so bidi-broker.mjs holds that session for
// the life of the browser and each call connects to the broker instead.

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function socketPath(port) {
  return join(homedir(), ".pi", "state", `pi-browser-use-bidi-${port}.sock`);
}

function connectSocket(path) {
  return new Promise((res, rej) => {
    const sock = createConnection(path);
    sock.once("connect", () => res(sock));
    sock.once("error", rej);
  });
}

// Start the broker and wait for its one status line. Named interpreter, never
// process.execPath: inside pi that path is the agent binary, not node.
function startBroker(port, path) {
  mkdirSync(join(homedir(), ".pi", "state"), { recursive: true });
  const script = fileURLToPath(new URL("./bidi-broker.mjs", import.meta.url));
  const child = spawn("node", [script, String(port), path], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((res) => {
    let out = "";
    const done = (line) => {
      clearTimeout(t);
      child.stdout.destroy();
      child.unref();
      res(line);
    };
    const t = setTimeout(() => done("error: the Firefox session broker did not start within 10s"), 10000);
    child.on("error", (e) => done(`error: could not start node for the Firefox session broker (${e.message})`));
    child.on("exit", (code) => done(out.trim() || `error: the Firefox session broker exited with code ${code}`));
    child.stdout.on("data", (d) => {
      out += d.toString();
      if (out.includes("\n")) done(out.split("\n")[0].trim());
    });
  });
}

export class BiDiConnection {
  constructor(sock, hello) {
    this.sock = sock;
    this.hello = hello;
    this.nextId = 0;
    this.pending = new Map();
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this._onMessage(line);
      }
    });
    sock.on("close", () => {
      for (const p of this.pending.values()) p.rej(new Error("The Firefox automation connection closed"));
      this.pending.clear();
    });
    sock.on("error", () => {});
  }

  static async open(port) {
    const path = socketPath(port);
    let sock = await connectSocket(path).catch(() => null);
    if (!sock) {
      const status = await startBroker(port, path);
      // A broker another call started a moment earlier wins the session; give it
      // time to start listening before calling the session foreign.
      for (let i = 0; !sock && i < 10; i++) {
        sock = await connectSocket(path).catch(() => null);
        if (!sock && (status === "ready" || !/Maximum number of active sessions/.test(status))) break;
        if (!sock) await sleep(300);
      }
      if (!sock) {
        if (/Maximum number of active sessions/.test(status)) {
          throw new Error(
            "Firefox already has an automation session that this tool does not own, usually one left behind by a process that crashed. Quit and reopen Firefox (or run the browser ensure action after quitting it) to clear it.",
          );
        }
        throw new Error(status.replace(/^error:\s*/, "") || "the Firefox session broker is not reachable");
      }
    }
    const hello = await new Promise((res, rej) => {
      let buf = "";
      const onData = (d) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        sock.off("data", onData);
        clearTimeout(t);
        try {
          res(JSON.parse(buf.slice(0, nl)).hello);
        } catch (e) {
          rej(e);
        }
      };
      const t = setTimeout(() => rej(new Error("the Firefox session broker did not answer")), 5000);
      sock.on("data", onData);
    });
    return new BiDiConnection(sock, hello);
  }

  _onMessage(data) {
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (m.id == null || !this.pending.has(m.id)) return;
    const p = this.pending.get(m.id);
    this.pending.delete(m.id);
    if (m.type === "error") p.rej(new Error(`${m.error}: ${m.message}`));
    else p.res(m.result);
  }

  send(method, params = {}, timeout = 30000) {
    const id = ++this.nextId;
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error(`BiDi timeout: ${method}`));
      }, timeout);
      const done = (fn) => (v) => {
        clearTimeout(t);
        fn(v);
      };
      this.pending.set(id, { res: done(res), rej: done(rej) });
      this.sock.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  // Top-level tabs. BiDi does not report titles; reading each one would mean
  // running script in every tab the user has open, so tabs are listed by URL.
  async listTargets() {
    const { contexts } = await this.send("browsingContext.getTree", { maxDepth: 0 });
    return contexts.map((c) => ({ id: c.context, url: c.url, title: "" }));
  }

  // Tab ids are valid for one Firefox process and one session, so both name the
  // instance a recorded tab belongs to, the way the CDP browser GUID does.
  async instanceId() {
    return this.hello?.sessionId ? `firefox-${this.hello.processId}-${this.hello.sessionId}` : null;
  }

  async createTarget(url = "about:blank") {
    const { context } = await this.send("browsingContext.create", { type: "tab" });
    if (url && url !== "about:blank") await this.send("browsingContext.navigate", { context, url, wait: "none" });
    return context;
  }

  async attach(targetId) {
    return new BiDiPage(this, targetId);
  }

  async closeTarget(targetId) {
    await this.send("browsingContext.close", { context: targetId });
    return { success: true };
  }

  async close() {
    // Leave the shared session open for the next call; only this client goes.
    this.sock.end();
  }
}

// Turn a BiDi RemoteValue into a plain value, matching what CDP returns with
// returnByValue: DOM nodes and other handles come back as empty objects.
export function fromRemote(v) {
  if (!v || typeof v !== "object") return v;
  switch (v.type) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "string":
    case "boolean":
      return v.value;
    case "number":
      return typeof v.value === "number" ? v.value : Number(v.value);
    case "bigint":
      return Number(v.value);
    case "array":
    case "set":
      return (v.value || []).map(fromRemote);
    case "object":
    case "map": {
      const out = {};
      for (const [k, val] of v.value || []) out[typeof k === "string" ? k : String(fromRemote(k))] = fromRemote(val);
      return out;
    }
    case "date":
      return v.value;
    case "regexp":
      return {};
    default:
      return {};
  }
}

// One tab, with the same methods as the CDP PageSession in helpers.mjs.
class BiDiPage {
  constructor(conn, targetId) {
    this.conn = conn;
    this.targetId = targetId;
  }
  async navigate(url, timeout = 20000) {
    // Start the navigation and poll readyState, as the CDP session does. Waiting on
    // the protocol's own load signal fails a navigation that a script redirect
    // replaces, which sign-in flows do routinely.
    await this.conn.send("browsingContext.navigate", { context: this.targetId, url, wait: "none" });
    const deadline = Date.now() + timeout;
    await sleep(250);
    while (Date.now() < deadline) {
      const rs = await this._eval("document.readyState", 3000).catch(() => null);
      if (rs === "complete") break;
      await sleep(150);
    }
    await sleep(100);
    return this.url();
  }
  async _eval(expression, timeout) {
    const r = await this.conn.send(
      "script.evaluate",
      { expression, target: { context: this.targetId }, awaitPromise: true, resultOwnership: "none" },
      timeout,
    );
    if (r.type === "exception") throw new Error(r.exceptionDetails?.text || "evaluate error");
    return fromRemote(r.result);
  }
  async evaluate(exprOrFn, arg) {
    const expression =
      typeof exprOrFn === "function" ? (arg === undefined ? `(${exprOrFn})()` : `(${exprOrFn})(${JSON.stringify(arg)})`) : exprOrFn;
    return this._eval(expression);
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
  async _point(elExpr) {
    const expr = `(() => { const el = ${elExpr}; if (!el) return null; el.scrollIntoView({block:'center',inline:'center'}); const r = el.getBoundingClientRect(); if (r.width<=0||r.height<=0) return null; return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`;
    return this.evaluate(expr);
  }
  async _clickAt(x, y) {
    await this.conn.send("input.performActions", {
      context: this.targetId,
      actions: [
        {
          type: "pointer",
          id: "pbu-mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", x: Math.round(x), y: Math.round(y) },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
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
    // Real key events, one per character, so the page sees trusted typing.
    const keys = [];
    for (const ch of String(value)) keys.push({ type: "keyDown", value: ch }, { type: "keyUp", value: ch });
    if (keys.length) {
      await this.conn.send("input.performActions", { context: this.targetId, actions: [{ type: "key", id: "pbu-keyboard", actions: keys }] });
    }
    await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) { el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } })()`,
    );
    return selector;
  }
  async screenshot(path) {
    const r = await this.conn.send("browsingContext.captureScreenshot", { context: this.targetId });
    writeFileSync(path, Buffer.from(r.data, "base64"));
    return path;
  }
}
