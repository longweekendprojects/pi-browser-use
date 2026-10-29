// Holds Firefox's one WebDriver BiDi session open and shares it with every
// pi-browser-use call over a Unix socket.
//
// Why a separate process: Firefox allows a single automation session, forgets
// every tab id when that session ends, and never ends a session whose websocket
// simply closed. A connection per tool call would therefore lose track of the
// agent's own tab between calls, and a call that died mid-flight would lock
// Firefox until it restarts. One long-lived holder keeps tab ids stable for the
// life of the browser and lets parallel pi sessions share the browser.
//
//   node bidi-broker.mjs <port> <socketPath>
//
// Prints one line, "ready" or "error: <reason>", then never writes to stdout
// again, so the parent can drop the pipe. Exits when Firefox closes the
// connection (the browser quit) or on SIGTERM/SIGINT.
//
// Wire format on the socket, one JSON object per line:
//   broker -> client, first line: {"hello": {"processId", "sessionId"}}
//   client -> broker:             {"id", "method", "params"}
//   broker -> client:             Firefox's reply with the client's id restored

import { createServer } from "node:net";
import { chmodSync, unlinkSync, statSync } from "node:fs";

const [port, sockPath] = process.argv.slice(2);
process.umask(0o077); // the socket drives the user's logged-in browser: owner only
// The parent drops the stdout pipe after the status line, or on its own timeout.
// A late write would then raise EPIPE as an unhandled error and kill the broker
// while it holds the session, so swallow it.
process.stdout.on("error", () => {});
let ws;
let nextId = 0;
const routes = new Map(); // broker id -> { client, id }
let hello = null;
let socketIno = null; // our socket file, so a late exit never deletes a newer broker's

function say(line) {
  try {
    process.stdout.write(line + "\n");
  } catch {
    /* parent already gone */
  }
}

function shutdown(code) {
  try {
    if (socketIno != null && statSync(sockPath).ino === socketIno) unlinkSync(sockPath);
  } catch {
    /* already gone */
  }
  process.exit(code);
}

// Release the session on a deliberate stop. A session left open would block every
// later automation client until Firefox restarts.
async function endSession() {
  if (hello && ws?.readyState === WebSocket.OPEN) {
    const ended = new Promise((res) => {
      ws.onmessage = res;
      setTimeout(res, 1000);
    });
    sendToFirefox("session.end", {});
    await ended;
  }
}

async function stop() {
  await endSession();
  shutdown(0);
}

function sendToFirefox(method, params) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return id;
}

async function start() {
  ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error(`Firefox automation port ${port} is not reachable`));
  });
  const created = new Promise((res, rej) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id !== 1) return;
      if (m.type === "error") rej(new Error(`${m.error}: ${m.message}`));
      else res(m.result);
    };
  });
  // "ignore" leaves alerts and confirm dialogs to the user. The default handler
  // would dismiss them in every tab for as long as this session is open.
  sendToFirefox("session.new", { capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: "ignore" } } } });
  const r = await created;
  hello = { processId: r.capabilities?.["moz:processID"] ?? null, sessionId: r.sessionId };

  ws.onmessage = (e) => {
    let m;
    try {
      m = JSON.parse(String(e.data));
    } catch {
      return;
    }
    const route = m.id != null && routes.get(m.id);
    if (!route) return; // events are not subscribed to; nothing else to route
    routes.delete(m.id);
    if (!route.client.destroyed) route.client.write(JSON.stringify({ ...m, id: route.id }) + "\n");
  };
  ws.onclose = () => shutdown(0);

  try {
    unlinkSync(sockPath);
  } catch {
    /* no stale socket */
  }
  const server = createServer((client) => {
    client.write(JSON.stringify({ hello }) + "\n");
    let buf = "";
    client.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        // The session belongs to every client; none of them may end it.
        if (msg.method === "session.end" || msg.method === "session.new") {
          client.write(JSON.stringify({ id: msg.id, type: "error", error: "unsupported operation", message: "the shared session is managed by the broker" }) + "\n");
          continue;
        }
        const id = sendToFirefox(msg.method, msg.params || {});
        routes.set(id, { client, id: msg.id });
      }
    });
    client.on("error", () => {});
  });
  await new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(sockPath, res);
  });
  socketIno = statSync(sockPath).ino;
  chmodSync(sockPath, 0o600);
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);

start().then(
  () => say("ready"),
  async (e) => {
    say(`error: ${e.message}`);
    // A session created before the failure would lock Firefox until it restarts.
    await endSession();
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    shutdown(1);
  },
);
