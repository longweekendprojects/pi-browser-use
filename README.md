# pi-browser-use

A native pi tool that drives your real, logged-in Chromium browser (Arc, Chrome, Edge, Brave, Vivaldi, Chromium, Opera) over the Chrome DevTools Protocol, reusing your tabs, cookies, and logins. It exposes one `browser` tool with two layers: primitive verbs and a growing library of named shortcuts that codify multi-step flows.

Unlike headless or vision-based automation, the agent reads the page's live HTML and gets a plain-English list of interactive elements (for example `@e5 button "Sign in"`), then decides what to click or type from that structure, never from a screenshot.

## Requirements

- macOS with a Chromium-family browser installed (Arc, Chrome, Edge, Brave, Vivaldi, Chromium, or Opera). Safari and Firefox cannot be driven; see [Which browser gets driven](#which-browser-gets-driven).
- Node.js 22+ (uses the built-in `WebSocket` to talk to the browser; no third-party dependencies)
- pi (this is a pi extension)
- AWS CLI v2, only if you use the `aws-sso-login` shortcut

## Install

```bash
pi install git:github.com/longweekendprojects/pi-browser-use
```

pi installs the package and its dependencies (Playwright's CDP client), then the `browser` tool is available in every session. To develop locally instead, clone into `~/.pi/agent/extensions/pi-browser-use` and run `npm install` there; edits load on `/reload` (see ARCHITECTURE.md > Hot-reload).

## Quick start

Ask in plain English ("refresh my AWS SSO login", "check my Sentry alerts", "find my latest infra PR") and the agent calls the `browser` tool directly.

The browser must run with the debug port. The tool's `ensure` action (and every shortcut) handles this: it is a no-op when the port is up, and asks before quitting and relaunching the browser when it is not. Your tabs, spaces, and logins persist across the relaunch.

## Which browser gets driven

The tool picks the browser you actually use, and tells you when it cannot. Run `browsers` to see the decision for your machine: it reports your default browser, the Chromium browsers installed, and which one would be driven.

Selection order:

1. Whatever already answers on the debug port, because that port is a single machine-wide resource. When it is not the browser you pinned in config, the tool says so and tells you to quit that browser to switch.
2. The browser named in config (`"browser": "chrome"`) or in `PI_BROWSER_USE_BROWSER`.
3. Your macOS default browser, when it can be driven inside your logged-in profile.
4. Otherwise the first installed Chromium browser that can, with a note explaining why your default was passed over.

Enabling the debug port on an already-running browser means quitting and reopening it, so the tool asks first. When there is no way to ask (a non-interactive session), it refuses and explains rather than closing the window you are working in.

That one-time yes/no prompt stops an agent mid-task, so you can grant the consent in advance: set `"autoApproveRelaunch": true` in `~/.pi/config/pi-browser-use/config.json` (or `PI_BROWSER_USE_ASSUME_YES=1` for a single shell) and the tool quits and relaunches the browser on its own, in interactive and unattended sessions alike. Your tabs and logins are still restored; the only case where they are not is the separate automation profile, which you opt into by setting `userDataDir`. `browsers` reports which mode is in effect.

Two browser limits shape that order, and both produce a specific message rather than a connection timeout:

- **Safari and Firefox cannot be driven.** Safari does not speak the Chrome DevTools Protocol, and its WebDriver and MCP automation run an isolated session without your cookies or logins, which defeats the purpose of this tool. If Safari is your default browser, the tool falls back to an installed Chromium browser and says so.
- **Chrome, Edge, Brave, Vivaldi, and Opera version 136 and later ignore `--remote-debugging-port` on your normal profile.** They can only be driven in a separate `--user-data-dir` profile, which starts out signed into nothing. The tool therefore prefers a browser that keeps your session, and drives such a browser only when you set `userDataDir` in config, opting into an automation profile you sign into once. Chrome, Edge, and Chromium report the Chromium version directly, so an older build is recognized as still drivable; Brave, Vivaldi, and Opera number their releases on their own tracks, so they are assumed to need the separate profile rather than promised a session they may not deliver.

## Documentation

- `ARCHITECTURE.md` explains how it works and the design.
- `AGENTS.md` is the guide for extending it (how to add a shortcut, the verification discipline, the hot-reload constraints).

## The two layers

**Primitives** are the raw verbs the agent composes:

| Action | Purpose |
|---|---|
| `ensure` | Guarantee the chosen browser is running with CDP on port 9222 |
| `browsers` | Report the default browser, the installed Chromium browsers, and which one would be driven |
| `navigate` | Open a URL in the active tab |
| `snapshot` | List visible interactive elements with stable `@eN` refs |
| `read` | Active tab URL, title, and visible text (secrets redacted) |
| `click` | Click by `ref`, `selector`, or visible `text` |
| `fill` | Type into a `ref` or `selector` |
| `eval` | Run JavaScript in the page |
| `screenshot` | Save a PNG of the active tab |
| `tabs` | List open tabs, marking the agent's own tab |
| `tab` | Explicitly hand the agent one of your tabs, by `index` or `url` |
| `close` | Close the agent-created tab; refuses tabs handed over with `tab` |

**Shortcuts** are hardened, named sequences captured from a real, debugged run, so the messy parts (redirect chains, shadow-DOM cookie banners, which tab to drive, which account to pick) are baked in rather than rediscovered:

| Shortcut | What it does |
|---|---|
| `aws-sso-login` | Refresh expired AWS SSO credentials end to end, including driving the identity-provider account chooser. Idempotent: skips if the token is still valid. |
| `wait-for` | Block until the active tab matches a URL substring, visible text, or selector. Replaces blind sleeps. |

A shortcut earns its place only after a real flow proves it is needed and has run green. No speculative recipes.

## Tab safety guarantee

The agent acts only on its own dedicated tab, tracked by a stable CDP target id that persists across calls. `navigate` opens that tab if it does not exist; it never reuses a tab you opened. Read and action verbs refuse to run when no agent tab exists rather than grabbing one of yours. The single way the agent touches a tab you opened is when you explicitly hand it over with `tab` (by `index` or `url`). `close` closes only a tab recorded as agent-created and refuses user tabs adopted through `tab`. Tabs you have open stay at the URLs you left them.

## Configuration

Account choice and defaults live in config, never hardcoded:

`~/.pi/config/pi-browser-use/config.json`
```json
{
  "aws": {
    "defaultProfile": "default",
    "ssoAccountEmail": "you@example.com"
  }
}
```

Two optional keys control the browser, and browser detection works without either:

- `"browser"` pins which browser to drive (`arc`, `dia`, `chrome`, `edge`, `brave`, `vivaldi`, `chromium`, `opera`). Omit it to follow your default browser.
- `"userDataDir"` (for example `"~/.pi/state/pi-browser-use/profile"`) is the separate automation profile used for browsers that refuse debugging on the normal profile, and is ignored for browsers that do not need it.

Both have environment overrides (`PI_BROWSER_USE_BROWSER`, `PI_BROWSER_USE_USER_DATA_DIR`), and the file path itself is overridable with `PI_BROWSER_USE_CONFIG`. For `aws-sso-login`, the account resolves from `account` param, then config `aws.ssoAccountEmail`; if neither is set and the chooser offers multiple accounts, the shortcut lists them and asks instead of guessing.

## Architecture

```
browser tool (index.ts)
  └─ run() dispatcher (core.mjs)
       ├─ primitives.mjs   raw verbs
       └─ shortcuts/       named multi-step flows
            ├─ aws-sso-login.mjs
            └─ wait-for.mjs
  helpers.mjs   shared: browser selection and launch, CDP connect,
                redaction, config, spawn
```

`test-harness.mjs` runs the exact dispatcher the tool uses, for verifying primitives and shortcuts without a pi reload: `node test-harness.mjs <action> key=value ...`.

## Adding a shortcut

1. Solve the flow for real using the primitives, debugging the obstacles.
2. Capture the working sequence in `shortcuts/<name>.mjs`, exporting `meta` (name, summary, params) and `run(params, opts)`.
3. Register it in `shortcuts/index.mjs`.
4. Verify green through `test-harness.mjs`, then `/reload`.

## Security

The debug port lets any local process drive your browser with your logged-in sessions. It binds to `127.0.0.1` and `--remote-allow-origins=http://127.0.0.1`, which blocks malicious websites (DNS-rebinding) but not other local processes. Quitting and reopening the browser normally turns the port off.
