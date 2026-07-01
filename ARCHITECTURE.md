# Architecture

This explains how pi-browser-use is built and how to extend it. Read the outer sections to understand the design, the inner sections to add features.

## What it is

A pi extension that exposes one native `browser` tool. The tool drives the user's real, logged-in Arc browser over the Chrome DevTools Protocol, so agents act inside the user's existing session (tabs, cookies, logins) instead of a fresh headless browser. The tool has two layers: primitive verbs and a library of named shortcuts.

## How an agent reaches it

`index.ts` registers the tool with `pi.registerTool`. Three fields make agents aware of it the same way they know built-in tools:

- `description` carries the full instructions the model reads, including the live shortcut catalog.
- `promptSnippet` adds a one-line entry to the system prompt's "Available tools" section every session.
- `promptGuidelines` adds usage bullets to the Guidelines section when the tool is active (the open then snapshot then act loop, the tab-safety rule, the AWS SSO refresh hint).

Because the extension lives in a global location (`~/.pi/agent/extensions/`), it loads for every pi session, so any agent can invoke `browser` without setup.

## The browser model

Arc is Chromium, so it speaks the Chrome DevTools Protocol when launched with a debug port. The engine attaches over that port and drives the page. It never closes the user's browser; it only detaches when a call finishes. Arc enforces a single instance, so the debug port can only be enabled by launching Arc as the sole instance; `ensureArc` handles this and asks for consent before relaunching, since a relaunch interrupts the user's running browser.

## Transport: raw CDP, single tab

The engine talks raw Chrome DevTools Protocol over a WebSocket (Node's built-in `WebSocket`) and attaches to exactly one tab at a time. This is a deliberate design choice, not an incidental one. A full browser-automation library like Playwright attaches to the whole browser on connect, every page, iframe, worker, and service worker, which hangs indefinitely against a real daily-driver browser that has dozens of heavy targets open. Attaching to a single target over raw CDP is instant and unaffected by how many other tabs exist, so the tool stays reliable exactly when the user's browser is busy (the normal case). It also means the extension has no third-party dependencies. Trusted input (real mouse and keyboard events via CDP `Input.*`) is used for clicks and typing, which some sign-in flows require.

## File map

```
index.ts            Registers the browser tool. Loads the engine with a
                    hot-reload-safe native import (see Hot-reload below).
core.mjs            Dispatcher: routes an action to a primitive or a shortcut.
primitives.mjs      The raw verbs: navigate, snapshot, read, click, fill,
                    eval, screenshot, tabs, tab, ensure.
helpers.mjs         Raw-CDP transport (connection + single-tab PageSession),
                    Arc launcher, dedicated-agent-tab machinery, secret
                    redaction, config, process spawning.
shortcuts/
  index.mjs         Shortcut registry and catalog.
  aws-sso-login.mjs Refresh expired AWS SSO credentials end to end.
  wait-for.mjs      Block until a URL/text/selector appears.
test-harness.mjs    Runs the dispatcher in a fresh process for verification.
```

## Two layers

**Primitives** are the raw verbs an agent composes: `navigate`, `snapshot` (lists interactive elements with stable `@eN` refs), `read`, `click`, `fill`, `eval`, `screenshot`, `tabs`, `tab`, `ensure`. They read the page's structured HTML, so the agent decides what to do from element data and text, never from a screenshot.

**Shortcuts** are hardened, named sequences captured from a real, debugged run. They bake in the messy parts (redirect chains, shadow-DOM cookie banners, which tab to drive, which account to pick) so an agent calls one verb instead of rediscovering the flow. A shortcut earns its place only after a real flow proves it is needed and has run green. No speculative recipes.

## Tab-safety guarantee

The agent acts only on its own dedicated tab, identified by a stable CDP target id persisted in `~/.pi/state/pi-browser-use.json`. `navigate` opens that tab if it does not exist and never reuses a tab the user opened. Read and action verbs refuse to run when no agent tab exists rather than grabbing one of the user's tabs. The only way the agent touches a user tab is the explicit `tab` action (by index or url). Tabs the user has open stay where they left them.

## Hot-reload

Editing engine files should take effect on a plain pi `/reload`, no full restart. This required defeating three caches, each a real trap:

1. Node's native ESM cache holds `.mjs` across reloads. A per-load token in the import URL (`?v=Date.now()`) busts it, and every engine module propagates the token to its own local imports.
2. jiti (pi's loader) compiles the extension entry to a `data:` URL, so `import.meta.url` is unusable for locating sibling files. The entry anchors on `__dirname`, which jiti injects as the real directory.
3. jiti rewrites a literal `import()` into its own cached loader, which ignores the `?v=` query. The entry builds the import at runtime (`Function("u","return import(u)")`) so a true native dynamic import runs and the token actually busts the cache.

The net effect: `index.ts` loads `core.mjs?v=<token>` natively, and the token flows through the whole graph, so one `/reload` reloads everything.

## Configuration

User settings live outside the repo so nothing is hardcoded:

```
~/.pi/config/pi-browser-use/config.json    (or PI_BROWSER_USE_CONFIG=/path)
```

See `config.example.json`. Today it holds the AWS default profile and the SSO account email for `aws-sso-login`.

## Security

The debug port lets any local process drive the browser with the user's logged-in sessions. It binds to `127.0.0.1` with `--remote-allow-origins=http://127.0.0.1`, which blocks malicious websites (DNS-rebinding) but not other local processes. Secrets (JWTs, common token formats, AWS keys, Bearer headers) are redacted from model-visible output. Quitting and reopening Arc normally turns the port off.
