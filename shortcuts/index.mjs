// Shortcut registry. Each shortcut is a hardened, named sequence of primitives
// captured from a real, debugged run. Add an entry only after a flow proves it
// is needed and has run green.

const Q = new URL(import.meta.url).search;
const imp = (rel) => import(new URL(rel, import.meta.url).href + Q);
const awsSsoLogin = await imp("./aws-sso-login.mjs");
const waitFor = await imp("./wait-for.mjs");

export const SHORTCUTS = {
  [awsSsoLogin.meta.name]: awsSsoLogin,
  [waitFor.meta.name]: waitFor,
};

export const SHORTCUT_NAMES = Object.keys(SHORTCUTS);

export function shortcutCatalog() {
  return SHORTCUT_NAMES.map((n) => `${n}: ${SHORTCUTS[n].meta.summary} [params: ${SHORTCUTS[n].meta.params}]`);
}

export async function runShortcut(name, params, opts) {
  const s = SHORTCUTS[name];
  if (!s) return { text: `ERROR: unknown shortcut ${name}`, isError: true };
  return await s.run(params, opts);
}
