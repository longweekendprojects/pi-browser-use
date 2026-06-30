// pi-browser-use: a native pi tool that drives the user's real, logged-in Arc
// browser over CDP. Two layers: primitive verbs and a library of named
// shortcuts that codify multi-step flows. Engine lives in core.mjs.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join } from "node:path";

// jiti injects __dirname (the real extension directory) into the module
// wrapper. Type-only declaration; erased at compile, resolved at runtime.
declare const __dirname: string | undefined;

export default async function (pi: ExtensionAPI) {
  // Hot-reload: load the engine fresh on every /reload so engine edits take
  // effect without a full pi restart. A per-load token busts Node's ESM cache,
  // and each engine module propagates the token to its own imports, so the
  // whole graph reloads (not just this entry).
  //
  // Anchor on __dirname, never import.meta.url: under jiti the entry's
  // import.meta.url can be a data: URL, which is not a usable base for locating
  // sibling engine files (it yielded an ENAMETOOLONG path).
  const token = "?v=" + Date.now();
  let dir: string | undefined = typeof __dirname === "string" && __dirname ? __dirname : undefined;
  if (!dir) {
    const rawBase = (import.meta as unknown as { url?: string }).url;
    if (rawBase && rawBase.startsWith("file:")) dir = fileURLToPath(rawBase).replace(/\/[^/]*$/, "");
  }
  if (!dir) throw new Error("pi-browser-use: cannot resolve extension directory");
  const coreSpec = pathToFileURL(join(dir, "core.mjs")).href + token;
  // jiti rewrites a literal import() into its own cached loader, which ignores
  // the ?v= cache-busting query, so engine edits would not load on /reload.
  // Build the import at runtime so jiti never transforms it: this runs a true
  // native dynamic import, and the per-load token busts Node's ESM cache, so
  // the whole engine graph reloads. Verified against jiti 2.7.0.
  const nativeImport = Function("u", "return import(u)") as (u: string) => Promise<unknown>;
  const { run, ACTIONS, shortcutCatalog } = (await nativeImport(coreSpec)) as {
    run: (params: Record<string, unknown>, opts: unknown) => Promise<{ text: string; details?: unknown; isError?: boolean }>;
    ACTIONS: string[];
    shortcutCatalog: () => string[];
  };
  const catalog: string[] = shortcutCatalog();

  pi.registerTool({
    name: "browser",
    label: "Browser",
    description:
      "Drive the user's real, logged-in Arc browser over the Chrome DevTools Protocol, reusing their tabs, cookies, and logins. " +
      "It only ever acts on its own dedicated tab and never reuses a tab the user opened; `tab` is the explicit handover of one of the user's tabs. " +
      "Primitives: ensure (start Arc with the debug port), navigate (opens the agent's own tab), snapshot (list interactive elements with @eN refs), read (page text), click (ref/selector/text), fill (ref/selector + value), eval (JS), screenshot, tabs (list, marks the agent tab), tab (take over a user tab by index/url). " +
      "Shortcuts (hardened multi-step flows): " + catalog.join(" | "),
    promptSnippet:
      "Control the user's logged-in Arc browser: primitives (navigate/snapshot/click/fill/read) plus shortcuts (aws-sso-login, wait-for)",
    promptGuidelines: [
      "Use the browser tool to drive the user's real Arc session for web tasks on sites they are already signed into.",
      "browser primitive workflow: navigate, then snapshot to get @eN refs, then click/fill by ref; use read for page text, wait-for instead of sleeping, and eval for anything the page model cannot express.",
      "Prefer a browser shortcut when one fits the task: aws-sso-login refreshes expired AWS SSO credentials end to end; wait-for blocks until a URL/text/selector appears.",
      "The browser tool never navigates or alters a tab the user already opened; it works in its own tab. Only use `tab` to adopt one of the user's tabs when the user explicitly asks you to operate on it.",
      "When AWS commands fail with expired/missing SSO token, call browser with action aws-sso-login to refresh before retrying.",
    ],
    parameters: Type.Object({
      action: StringEnum(ACTIONS as [string, ...string[]]),
      url: Type.Optional(Type.String({ description: "URL for navigate, or substring for wait-for" })),
      ref: Type.Optional(Type.String({ description: "Element ref from snapshot, e.g. e12" })),
      selector: Type.Optional(Type.String({ description: "CSS selector for click/fill/wait-for" })),
      text: Type.Optional(Type.String({ description: "Visible text to click, or to wait for" })),
      value: Type.Optional(Type.String({ description: "Value to type for fill" })),
      js: Type.Optional(Type.String({ description: "JavaScript expression for eval" })),
      path: Type.Optional(Type.String({ description: "Output path for screenshot" })),
      limit: Type.Optional(Type.Number({ description: "Max chars for read (default 4000)" })),
      index: Type.Optional(Type.Number({ description: "Tab index for the tab action (from action=tabs)" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout for wait-for (default 15000)" })),
      profile: Type.Optional(Type.String({ description: "AWS profile for aws-sso-login (default from config)" })),
      account: Type.Optional(Type.String({ description: "IdP account email for aws-sso-login (default from config)" })),
      force: Type.Optional(Type.Boolean({ description: "Force aws-sso-login even if the token is still valid" })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const confirm =
        ctx?.hasUI && ctx.ui?.confirm ? (m: string) => ctx.ui.confirm("pi-browser-use", m) : undefined;
      const r = await run(params as Record<string, unknown>, { confirm, onUpdate });
      return {
        content: [{ type: "text", text: r.text }],
        details: r.details ?? {},
        isError: r.isError ?? false,
      };
    },
  });
}
