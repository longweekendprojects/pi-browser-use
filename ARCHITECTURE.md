# Architecture

This explains how pi-browser-use is built and how to extend it. Read the outer sections to understand the design, the inner sections to add features.

## What it is

A pi extension that exposes one native `browser` tool. The tool drives the user's real, logged-in Chromium browser (Arc, Chrome, Edge, Brave, Vivaldi, Chromium, Opera) over the Chrome DevTools Protocol, so agents act inside the user's existing session (tabs, cookies, logins) instead of a fresh headless browser. The tool has two layers: primitive verbs and a library of named shortcuts.

## How an agent reaches it

`index.ts` registers the tool with `pi.registerTool`. Three fields make agents aware of it the same way they know built-in tools:

- `description` carries the full instructions the model reads, including the live shortcut catalog.
- `promptSnippet` adds a one-line entry to the system prompt's "Available tools" section every session.
- `promptGuidelines` adds usage bullets to the Guidelines section when the tool is active (the open then snapshot then act loop, the tab-safety rule, the AWS SSO refresh hint).

Because the extension lives in a global location (`~/.pi/agent/extensions/`), it loads for every pi session, so any agent can invoke `browser` without setup.

## The browser model

Every Chromium-family browser speaks the Chrome DevTools Protocol when launched with a debug port, so the transport, the page model, and every verb are browser-agnostic; only launching is browser-specific. The engine attaches over that port and drives the page. It never closes the user's browser; it only detaches when a call finishes. These browsers enforce a single instance, so the debug port can only be enabled by launching the browser as the sole instance; `ensureBrowser` handles this and asks for consent before relaunching, since a relaunch interrupts the user's running browser.

## Browser selection

The tool drives the browser the user actually lives in, which is not always the one it was developed against. `helpers.mjs` holds a registry of Chromium-family browsers (app name, process name, bundle id) and resolves the choice in this order: whatever already answers on the debug port, then the browser named in config or `PI_BROWSER_USE_BROWSER`, then the macOS default browser read from LaunchServices, then the first installed Chromium browser. The live port comes first because it is a single machine-wide resource that only its holder can release; when the holder is not the configured browser, the result says so instead of leaving the user to infer it. `chooseBrowser` is a pure function over the detected machine state, so the ordering is testable without a browser, and the `browsers` action reports the live port holder alongside that decision, so the diagnostic cannot contradict what `ensure` will do.

Detection fails closed, because every wrong answer here costs the user the browser they were working in. An unreadable app version, or a browser numbering on its own track (Brave, Vivaldi, Opera), counts as needing the separate profile rather than being promised as drivable; an unreadable LaunchServices file returns an unknown default rather than naming Safari; a missing consent channel is a refusal, not an approval (`PI_BROWSER_USE_ASSUME_YES` opts unattended runs back in); and the quit and relaunch check their exit status, so a browser that refused to quit is reported as such rather than as a debug-port timeout.

Two real limits drive that ordering, and each returns a specific explanation instead of a connection timeout:

- **Safari and Firefox are undrivable, not merely unsupported.** Safari has no CDP endpoint, and both `safaridriver` WebDriver sessions and the Safari MCP server run an isolated profile carrying none of the user's cookies or logins, which is the premise this tool is built on. A Safari default browser therefore falls back to an installed Chromium browser, with the reason stated.
- **Chromium 136 removed default-profile debugging.** Chrome, Edge, Brave, Vivaldi, and Opera at version 136 or later silently ignore `--remote-debugging-port` unless a separate `--user-data-dir` is passed, and that separate profile is signed into nothing. The registry records this as `lockedFrom`, selection prefers a browser that keeps the user's real session, and a locked browser is driven only when the user opts into a `userDataDir` automation profile.

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
                    browser registry/selection/launcher, dedicated-agent-tab
                    machinery, secret redaction, config, process spawning.
shortcuts/
  index.mjs         Shortcut registry and catalog.
  aws-sso-login.mjs Refresh expired AWS SSO credentials end to end.
  wait-for.mjs      Block until a URL/text/selector appears.
test-harness.mjs    Runs the dispatcher in a fresh process for verification.
```

## Two layers

**Primitives** are the raw verbs an agent composes: `navigate`, `snapshot` (lists interactive elements with stable `@eN` refs), `read`, `click`, `fill`, `eval`, `screenshot`, `tabs`, `tab`, `close`, `ensure`, `browsers` (which browser would be driven, and why). They read the page's structured HTML, so the agent decides what to do from element data and text, never from a screenshot.

**Shortcuts** are hardened, named sequences captured from a real, debugged run. They bake in the messy parts (redirect chains, shadow-DOM cookie banners, which tab to drive, which account to pick) so an agent calls one verb instead of rediscovering the flow. A shortcut earns its place only after a real flow proves it is needed and has run green. No speculative recipes.

## Tab-safety guarantee

The agent acts only on its own dedicated tab, identified by a stable CDP target id and ownership marker persisted in `~/.pi/state/pi-browser-use.json`. `navigate` records new tabs as agent-created; explicit `tab` handovers are recorded as adopted. `close` closes only agent-created tabs and refuses adopted or legacy targets whose ownership is unknown. Read and action verbs refuse to run when no agent tab exists rather than grabbing one of the user's tabs. Tabs the user has open stay where they left them.

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

See `config.example.json`. It holds the browser to drive (`browser`), the separate automation profile for browsers that refuse debugging on the normal profile (`userDataDir`), and the AWS default profile and SSO account email for `aws-sso-login`. `PI_BROWSER_USE_BROWSER` and `PI_BROWSER_USE_USER_DATA_DIR` override the first two.

## Security

The debug port lets any local process drive the browser with the user's logged-in sessions. It binds to `127.0.0.1` with `--remote-allow-origins=http://127.0.0.1`, which blocks malicious websites (DNS-rebinding) but not other local processes. Secrets (JWTs, common token formats, AWS keys, Bearer headers) are redacted from model-visible output. Quitting and reopening the browser normally turns the port off.
