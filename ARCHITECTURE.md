# Architecture

This explains how pi-browser-use is built and how to extend it. Read the outer sections to understand the design, the inner sections to add features.

## What it is

A pi extension that exposes one native `browser` tool. The tool drives the user's real, logged-in browser, their macOS default unless configured otherwise: Firefox over WebDriver BiDi, and Chromium browsers (Arc, Chrome, Edge, Brave, Vivaldi, Chromium, Opera) over the Chrome DevTools Protocol. Agents act inside the user's existing session (tabs, cookies, logins) instead of a fresh headless browser. The tool has two layers: primitive verbs and a library of named shortcuts.

## How an agent reaches it

`index.ts` registers the tool with `pi.registerTool`. Three fields make agents aware of it the same way they know built-in tools:

- `description` carries the full instructions the model reads, including the live shortcut catalog.
- `promptSnippet` adds a one-line entry to the system prompt's "Available tools" section every session.
- `promptGuidelines` adds usage bullets to the Guidelines section when the tool is active (the open then snapshot then act loop, the tab-safety rule, the AWS SSO refresh hint).

Because the extension lives in a global location (`~/.pi/agent/extensions/`), it loads for every pi session, so any agent can invoke `browser` without setup.

## The browser model

Every Chromium-family browser speaks the Chrome DevTools Protocol when launched with a debug port, and Firefox speaks WebDriver BiDi on the same flag. Both transports expose one small surface (list, create, attach, and close tabs; evaluate, navigate, click, type, screenshot), so the page model and every verb are browser-agnostic; only the transport and launching are browser-specific. The engine attaches over that port and drives the page. It never closes the user's browser; it only detaches when a call finishes. These browsers enforce a single instance, so the debug port can only be enabled by launching the browser as the sole instance; `ensureBrowser` handles this and asks for consent before relaunching, since a relaunch interrupts the user's running browser.

## Browser selection

The tool drives the browser the user actually lives in, which is not always the one it was developed against. `helpers.mjs` holds a registry of supported browsers (app name, process name, bundle id, protocol) and picks one in this order: the browser named in config or `PI_BROWSER_USE_BROWSER`, then the macOS default browser read from LaunchServices, then the first installed browser that keeps the user's session. Chromium browsers use debug port 9222 and Firefox uses 9223, so a Chromium browser left holding its port never blocks Firefox. A port is still one machine-wide resource that only its holder can release: when another browser of the same protocol already holds the chosen browser's port, the tool drives that holder and says how to switch. When nothing can be selected, a browser already listening on either port is driven. `chooseBrowser` is a pure function over the detected machine state, so the ordering is testable without a browser. `planBrowser` combines that choice with the live port holder, and both `ensure` and the `browsers` diagnostic act on its result, so the diagnostic cannot contradict what `ensure` will do.

Detection fails closed, because every wrong answer here costs the user the browser they were working in. An unreadable app version, or a browser numbering on its own track (Brave, Vivaldi, Opera), counts as needing the separate profile rather than being promised as drivable; an unreadable LaunchServices file returns an unknown default rather than naming Safari; a missing consent channel is a refusal, not an approval (`autoApproveRelaunch` in config, or `PI_BROWSER_USE_ASSUME_YES`, is the user granting that consent ahead of time, which also skips the interactive prompt that would otherwise stall an agent); and the quit and relaunch check their exit status, so a browser that refused to quit is reported as such rather than as a debug-port timeout.

Two real limits drive that ordering, and each returns a specific explanation instead of a connection timeout:

- **Safari is undrivable, not merely unsupported.** Safari has no CDP or BiDi endpoint, and both `safaridriver` WebDriver sessions and the Safari MCP server run an isolated profile carrying none of the user's cookies or logins, which is the premise this tool is built on. A Safari default browser therefore falls back to another installed browser, with the reason stated.
- **Chromium 136 removed default-profile debugging.** Chrome, Edge, Brave, Vivaldi, and Opera at version 136 or later silently ignore `--remote-debugging-port` unless a separate `--user-data-dir` is passed, and that separate profile is signed into nothing. The registry records this as `lockedFrom`, selection prefers a browser that keeps the user's real session, and a locked browser is driven only when the user opts into a `userDataDir` automation profile.

## Transport: raw CDP or BiDi, single tab

The engine talks raw Chrome DevTools Protocol over a WebSocket (Node's built-in `WebSocket`) and attaches to exactly one tab at a time. This is a deliberate design choice, not an incidental one. A full browser-automation library like Playwright attaches to the whole browser on connect, every page, iframe, worker, and service worker, which hangs indefinitely against a real daily-driver browser that has dozens of heavy targets open. Attaching to a single target over raw CDP is instant and unaffected by how many other tabs exist, so the tool stays reliable exactly when the user's browser is busy (the normal case). It also means the extension has no third-party dependencies. Trusted input (real mouse and keyboard events via CDP `Input.*`) is used for clicks and typing, which some sign-in flows require.

Firefox removed CDP, so it is driven over WebDriver BiDi (`bidi.mjs`), with the same single-tab model and trusted input through `input.performActions`. Three Firefox behaviors shape that transport:

- **One session, renumbered tabs.** Firefox allows a single automation session, and it assigns fresh tab ids to every new session. A session per tool call would lose the agent's own tab between calls. `bidi-broker.mjs` therefore holds the session for the life of the browser and shares it with every call over a Unix socket at `~/.pi/state/pi-browser-use-bidi-<port>.sock` (owner-only). The first call starts the broker with `node`; the broker exits when Firefox quits. A session left by a crashed broker cannot be ended or rejoined, so the tool reports it and asks for a Firefox restart.
- **Automation prefs.** With the debug port on, Firefox applies its test-automation prefs for the whole run unless `remote.prefs.recommended` is false. Those prefs turn off Safe Browsing, tracking protection, password saving, and add-on updates. Before launching Firefox, `ensureBrowser` writes `remote.prefs.recommended=false` into the profile's `prefs.js`, and `browser.sessionstore.resume_session_once=true` when it quit a running Firefox, so the open tabs come back even if Firefox is not set to restore sessions. The profile is the one whose `compatibility.ini` names the app being launched; when none matches, the tool refuses rather than guess.
- **`navigator.webdriver` is true** in every tab while the debug port is on. Google sign-in still accepted account selection in the AWS SSO flow with it set.

## File map

```
index.ts            Registers the browser tool. Loads the engine with a
                    hot-reload-safe native import (see Hot-reload below).
core.mjs            Dispatcher: routes an action to a primitive or a shortcut.
primitives.mjs      The raw verbs: navigate, snapshot, read, click, fill,
                    eval, screenshot, tabs, tab, ensure.
helpers.mjs         Raw-CDP transport (connection + single-tab PageSession),
                    browser registry/selection/launcher, Firefox profile prefs,
                    dedicated-agent-tab machinery, secret redaction, config,
                    process spawning.
bidi.mjs            WebDriver BiDi transport for Firefox, same surface as CDP.
bidi-broker.mjs     Background process holding Firefox's one BiDi session.
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

The agent acts only on its own dedicated tab, identified by a stable target id (the CDP target id, or the Firefox tab id the broker keeps stable) and ownership marker persisted in `~/.pi/state/pi-browser-use.json`. `navigate` records new tabs as agent-created; explicit `tab` handovers are recorded as adopted. `close` closes only agent-created tabs and refuses adopted or legacy targets whose ownership is unknown. Read and action verbs refuse to run when no agent tab exists rather than grabbing one of the user's tabs. Tabs the user has open stay where they left them.

## Hot-reload

Editing engine files should take effect on a plain pi `/reload`, no full restart. This required defeating four caches, each a real trap:

1. Node's native ESM cache holds `.mjs` across reloads. A per-load token in the import URL (`?v=Date.now()`) busts it, and every engine module propagates the token to its own local imports.
2. jiti (pi's loader) compiles the extension entry to a `data:` URL, so `import.meta.url` is unusable for locating sibling files. The entry anchors on `__dirname`, which jiti injects as the real directory.
3. jiti rewrites a literal `import()` into its own cached loader, which ignores the `?v=` query. The entry builds the import at runtime (`Function("u","return import(u)")`) so a true native dynamic import runs and the token actually busts the cache.
4. Bun, which runs compiled pi builds such as Pi-Bolt, keys its module cache by file path and ignores the `?v=` query. Before importing, the entry deletes this extension's `.mjs` files from the shared `require.cache`, which Bun honors for ES modules. Under Node that cache holds no ES modules, so the step does nothing there.

The net effect: `index.ts` loads `core.mjs?v=<token>` natively, and the token flows through the whole graph, so one `/reload` reloads everything.

## Configuration

User settings live outside the repo so nothing is hardcoded:

```
~/.pi/config/pi-browser-use/config.json    (or PI_BROWSER_USE_CONFIG=/path)
```

See `config.example.json`. It holds the browser to drive (`browser`), the separate automation profile for browsers that refuse debugging on the normal profile (`userDataDir`), and the AWS default profile and SSO account email for `aws-sso-login`. `PI_BROWSER_USE_BROWSER` and `PI_BROWSER_USE_USER_DATA_DIR` override the first two.

## Security

The debug port lets any local process drive the browser with the user's logged-in sessions. Chromium browsers bind it to `127.0.0.1` with `--remote-allow-origins=http://127.0.0.1`. Firefox binds to localhost and rejects any request that carries an `Origin` header. Both block malicious websites (DNS-rebinding) but not other local processes; the Firefox broker's socket is readable by the user only. Secrets (JWTs, common token formats, AWS keys, Bearer headers) are redacted from model-visible output. Quitting and reopening the browser normally turns the port off.
