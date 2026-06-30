// pi-browser-use dispatcher. Routes a single `run()` call to either a primitive
// verb (navigate, snapshot, click, ...) or a named shortcut (aws-sso-login,
// wait-for, ...). Shared by the pi tool (index.ts) and the test harness.

// Hot-reload: propagate the cache-busting token (carried in this module's own
// URL query) to every local import, so one fresh load reloads the whole engine
// graph instead of serving stale modules from Node's ESM cache.
const Q = new URL(import.meta.url).search;
const imp = (rel) => import(new URL(rel, import.meta.url).href + Q);

const { PRIMITIVES, runPrimitive } = await imp("./primitives.mjs");
const { SHORTCUT_NAMES, runShortcut, shortcutCatalog } = await imp("./shortcuts/index.mjs");

export { PRIMITIVES, SHORTCUT_NAMES, shortcutCatalog };
export const ACTIONS = [...PRIMITIVES, ...SHORTCUT_NAMES];

export async function run(params, opts = {}) {
  const { action } = params;
  if (SHORTCUT_NAMES.includes(action)) return await runShortcut(action, params, opts);
  if (PRIMITIVES.includes(action)) return await runPrimitive(params, opts);
  return { text: `ERROR: unknown action ${action}. Known: ${[...PRIMITIVES, ...SHORTCUT_NAMES].join(", ")}`, isError: true };
}
