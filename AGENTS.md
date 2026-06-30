# Working in this repo (for agents and contributors)

This file tells an agent how to extend pi-browser-use safely. Read `ARCHITECTURE.md` first for the design; this file is the how-to for changes.

## The core discipline

A shortcut graduates into the library only after you have run the real flow with the primitives, hit its actual obstacles, and made it pass end to end. Do not write speculative shortcuts from imagination. The value of the library is that each entry encodes a flow someone actually debugged.

## Add a shortcut

1. Solve the flow by hand first, using the primitives (`navigate`, `snapshot`, `click`, `read`, `eval`, ...), until it works against the real site.
2. Create `shortcuts/<name>.mjs` exporting:
   - `meta` = `{ name, summary, params }` (summary and params show up in the tool description the model reads).
   - `run(params, opts)` returning `{ text, details?, isError? }`. `opts` carries `confirm` (consent prompt) and `onUpdate` (progress notes).
   - Import shared helpers with the token-propagating pattern at the top of the file so hot-reload works:
     ```js
     const Q = new URL(import.meta.url).search;
     const imp = (rel) => import(new URL(rel, import.meta.url).href + Q);
     const { withAgentPage, sleep } = await imp("../helpers.mjs");
     ```
3. Register it in `shortcuts/index.mjs`.
4. Verify green with the harness (below), then `/reload` and confirm through the live tool.

## Add or change a primitive

Edit `primitives.mjs`. Keep acting verbs on the agent's own tab: use `withAgentPage(...)` (which refuses when no agent tab exists) rather than grabbing whatever tab is frontmost. Use `withConnect(...)` only for read-only, whole-context actions like listing tabs. Never navigate or mutate a tab the user opened; `tab` is the only adoption path.

## Verification discipline (important)

`test-harness.mjs` runs the dispatcher in a fresh node process:

```
node test-harness.mjs <action> key=value ...
node test-harness.mjs navigate url=https://example.com
node test-harness.mjs snapshot
```

A fresh process always loads current code, so the harness is great for logic but **cannot** reveal reload-staleness. Bugs where `/reload` serves old engine code only show through the live `browser` tool after an actual `/reload`. When you change how modules load, verify through the live tool, not just the harness.

## Hot-reload constraints (do not regress these)

If you touch `index.ts` module loading, preserve all three:

1. Per-load token (`?v=Date.now()`) on the engine import, propagated by every engine module to its own local imports.
2. Anchor on `__dirname` for the extension directory, never `import.meta.url` (jiti makes it a `data:` URL).
3. Load the engine with a runtime-built native import (`Function("u","return import(u)")`), because jiti rewrites a literal `import()` into a cache that ignores the token.

Reproduce jiti behavior with `createJiti` from pi's own `node_modules`, not a bare node process, or you will not see the caching that bites in production.

## Keep it honest

- Nothing user-specific in the repo. Account email and profile live in `~/.pi/config/pi-browser-use/config.json`; ship a generic `config.example.json`.
- Redact secrets from any new model-visible output (extend the table in `helpers.mjs`).
- Anything that quits or relaunches the user's browser must go through the `confirm` consent gate.
