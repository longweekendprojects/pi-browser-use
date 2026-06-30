# pi-browser-use

A native pi tool that drives your real, logged-in Arc browser over the Chrome DevTools Protocol, reusing your tabs, cookies, and logins. It exposes one `browser` tool with two layers: primitive verbs and a growing library of named shortcuts that codify multi-step flows.

Unlike headless or vision-based automation, the agent reads the page's live HTML and gets a plain-English list of interactive elements (for example `@e5 button "Sign in"`), then decides what to click or type from that structure, never from a screenshot.

## Requirements

- macOS with the Arc browser installed
- Node.js 18+
- pi (this is a pi extension)
- AWS CLI v2, only if you use the `aws-sso-login` shortcut

## Install

```bash
pi install git:github.com/longweekendprojects/pi-browser-use
```

pi installs the package and its dependencies (Playwright's CDP client), then the `browser` tool is available in every session. To develop locally instead, clone into `~/.pi/agent/extensions/pi-browser-use` and run `npm install` there; edits load on `/reload` (see ARCHITECTURE.md > Hot-reload).

## Quick start

Ask in plain English ("refresh my AWS SSO login", "check my Sentry alerts", "find my latest infra PR") and the agent calls the `browser` tool directly.

Arc must run with the debug port. The tool's `ensure` action (and every shortcut) handles this: it is a no-op when the port is up, and asks before quitting/relaunching Arc when it is not. Your tabs, spaces, and logins persist across the relaunch.

## Documentation

- `ARCHITECTURE.md` explains how it works and the design.
- `AGENTS.md` is the guide for extending it (how to add a shortcut, the verification discipline, the hot-reload constraints).

## The two layers

**Primitives** are the raw verbs the agent composes:

| Action | Purpose |
|---|---|
| `ensure` | Guarantee Arc is running with CDP on port 9222 |
| `navigate` | Open a URL in the active tab |
| `snapshot` | List visible interactive elements with stable `@eN` refs |
| `read` | Active tab URL, title, and visible text (secrets redacted) |
| `click` | Click by `ref`, `selector`, or visible `text` |
| `fill` | Type into a `ref` or `selector` |
| `eval` | Run JavaScript in the page |
| `screenshot` | Save a PNG of the active tab |
| `tabs` | List open tabs, marking the agent's own tab |
| `tab` | Explicitly hand the agent one of your tabs, by `index` or `url` |

**Shortcuts** are hardened, named sequences captured from a real, debugged run, so the messy parts (redirect chains, shadow-DOM cookie banners, which tab to drive, which account to pick) are baked in rather than rediscovered:

| Shortcut | What it does |
|---|---|
| `aws-sso-login` | Refresh expired AWS SSO credentials end to end, including driving the identity-provider account chooser. Idempotent: skips if the token is still valid. |
| `wait-for` | Block until the active tab matches a URL substring, visible text, or selector. Replaces blind sleeps. |

A shortcut earns its place only after a real flow proves it is needed and has run green. No speculative recipes.

## Tab safety guarantee

The agent acts only on its own dedicated tab, tracked by a stable CDP target id that persists across calls. `navigate` opens that tab if it does not exist; it never reuses a tab you opened. Read and action verbs refuse to run when no agent tab exists rather than grabbing one of yours. The single way the agent touches a tab you opened is when you explicitly hand it over with `tab` (by `index` or `url`). Tabs you have open stay at the URLs you left them.

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

Override the file path with `PI_BROWSER_USE_CONFIG`. For `aws-sso-login`, the account resolves from `account` param, then config `aws.ssoAccountEmail`; if neither is set and the chooser offers multiple accounts, the shortcut lists them and asks instead of guessing.

## Architecture

```
browser tool (index.ts)
  └─ run() dispatcher (core.mjs)
       ├─ primitives.mjs   raw verbs
       └─ shortcuts/       named multi-step flows
            ├─ aws-sso-login.mjs
            └─ wait-for.mjs
  helpers.mjs   shared: Arc launcher, CDP connect, redaction, config, spawn
```

`test-harness.mjs` runs the exact dispatcher the tool uses, for verifying primitives and shortcuts without a pi reload: `node test-harness.mjs <action> key=value ...`.

## Adding a shortcut

1. Solve the flow for real using the primitives, debugging the obstacles.
2. Capture the working sequence in `shortcuts/<name>.mjs`, exporting `meta` (name, summary, params) and `run(params, opts)`.
3. Register it in `shortcuts/index.mjs`.
4. Verify green through `test-harness.mjs`, then `/reload`.

## Security

The debug port lets any local process drive your browser with your logged-in sessions. It binds to `127.0.0.1` and `--remote-allow-origins=http://127.0.0.1`, which blocks malicious websites (DNS-rebinding) but not other local processes. Quitting and reopening Arc normally turns the port off.
