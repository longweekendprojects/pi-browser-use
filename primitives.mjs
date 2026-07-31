// Primitive browser actions: the raw verbs the agent composes. Shortcuts build
// on these. Acting verbs run ONLY on the agent's own dedicated tab, over raw
// CDP (attaches to that one tab, never the whole browser), so they stay fast
// and reliable no matter how many other tabs the user has open. `navigate`
// opens the agent tab if needed; `tab` is the explicit handover of a user tab.

const Q = new URL(import.meta.url).search;
const imp = (rel) => import(new URL(rel, import.meta.url).href + Q);
const {
  withAgentPage,
  withConnection,
  listTargets,
  getAgentTarget,
  canCloseAgentTarget,
  setAgentTarget,
  clearAgentTarget,
  closeTarget,
  cdpUp,
  ensureArc,
  redact,
  PORT,
} = await imp("./helpers.mjs");

export const PRIMITIVES = [
  "ensure",
  "navigate",
  "snapshot",
  "read",
  "click",
  "fill",
  "eval",
  "screenshot",
  "tabs",
  "tab",
  "close",
];

// Runs in the page: tag visible interactive elements with stable refs and
// return a compact list the agent can act on. Passed to evaluate as a function.
export function snapshotFn() {
  const sel = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea",
    "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]",
    "[role=checkbox]", "[role=combobox]", "[contenteditable='']", "[contenteditable=true]",
  ].join(",");
  const els = Array.from(document.querySelectorAll(sel));
  const out = [];
  let i = 0;
  for (const el of els) {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) continue;
    const ref = "e" + ++i;
    el.setAttribute("data-pbu-ref", ref);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || tag;
    const type = el.getAttribute("type") || undefined;
    let name = "";
    if (tag === "input" || tag === "textarea" || tag === "select") {
      name = type === "password" ? "(password field)"
        : el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || type || tag;
    } else {
      name = el.getAttribute("aria-label") || (el.innerText || "").trim() || el.getAttribute("title") || "";
    }
    name = String(name).replace(/\s+/g, " ").trim().slice(0, 90);
    out.push({ ref, role, type, name });
    if (out.length >= 150) break;
  }
  return out;
}

export async function runPrimitive(params, opts = {}) {
  const { action } = params;

  if (action === "ensure") {
    const r = await ensureArc(opts);
    return { text: r.ok ? `Arc CDP ready on ${PORT}${r.relaunched ? " (relaunched)" : ""}` : `ERROR: ${r.error}`, details: r, isError: !r.ok };
  }

  if (action === "close") {
    const saved = getAgentTarget();
    if (!saved) return { text: "No agent tab to close.", details: { noAgentTab: true } };
    if (!canCloseAgentTarget(saved)) {
      return {
        text: "REFUSED: this tab was not recorded as agent-created, so it will not be closed.",
        details: { ownership: saved.ownership },
        isError: true,
      };
    }
    if (!(await cdpUp())) {
      return {
        text: "ERROR: Arc browser control is not connected. The tab was left open; `close` will not relaunch Arc.",
        details: { cdpUnavailable: true },
        isError: true,
      };
    }
    try {
      return await withConnection(async (cdp) => {
        const targets = await listTargets();
        if (targets.some((t) => t.id === saved.id)) {
          const result = await closeTarget(cdp, saved.id);
          if (result?.success === false) throw new Error("Arc refused to close the agent-created tab");
        }
        clearAgentTarget();
        return { text: "CLOSED agent-created tab.", details: { targetId: saved.id } };
      });
    } catch (e) {
      return { text: `ERROR: ${e.message}`, details: {}, isError: true };
    }
  }

  const ens = await ensureArc(opts);
  if (!ens.ok) return { text: `ERROR: ${ens.error}`, details: ens, isError: true };

  try {
    switch (action) {
      case "navigate":
        return await withAgentPage(async (page) => {
          const url = await page.navigate(params.url);
          return { text: `OK ${url}`, details: { url } };
        }, { create: true });
      case "read":
        return await withAgentPage(async (page) => {
          const url = await page.url();
          const title = await page.title();
          const body = redact((await page.innerText()).trim());
          return { text: `URL: ${url}\nTITLE: ${title}\n---\n${body.slice(0, params.limit || 4000)}`, details: { url, title } };
        });
      case "snapshot":
        return await withAgentPage(async (page) => {
          const url = await page.url();
          const els = (await page.evaluate(snapshotFn)) || [];
          const lines = els.map((e) => `@${e.ref} ${e.role}${e.type ? `[${e.type}]` : ""} ${JSON.stringify(redact(e.name))}`);
          return { text: `${url}\n${els.length} interactive elements:\n${lines.join("\n")}`, details: { url, elements: els } };
        });
      case "click":
        return await withAgentPage(async (page) => {
          let t;
          if (params.ref) t = await page.clickRef(params.ref);
          else if (params.selector) t = await page.clickSelector(params.selector);
          else if (params.text) t = await page.clickText(params.text);
          else throw new Error("click requires one of: ref, selector, text");
          return { text: `CLICKED ${t}`, details: { target: t } };
        });
      case "fill":
        return await withAgentPage(async (page) => {
          const sel = params.ref ? `[data-pbu-ref="${params.ref}"]` : params.selector;
          if (!sel) throw new Error("fill requires ref or selector");
          await page.fill(sel, params.value ?? params.text ?? "");
          return { text: `FILLED ${sel}`, details: { selector: sel } };
        });
      case "eval":
        return await withAgentPage(async (page) => {
          const r = await page.evaluate(params.js);
          return { text: redact(JSON.stringify(r, null, 2) ?? "null"), details: {} };
        });
      case "screenshot":
        return await withAgentPage(async (page) => {
          await page.screenshot(params.path);
          return { text: `SAVED ${params.path}`, details: { path: params.path } };
        });
      case "tabs":
        return await withConnection(async () => {
          const targets = await listTargets();
          const saved = getAgentTarget();
          const lines = targets.map((t, i) => {
            const label = saved?.ownership === "created" ? "agent tab" : saved?.ownership === "adopted" ? "adopted tab" : "legacy tab (ownership unknown)";
            const marker = t.id === saved?.id ? `  <- ${label}` : "";
            return `[${i}] ${t.title || ""}  ${t.url}${marker}`;
          });
          return { text: lines.join("\n"), details: { count: targets.length } };
        });
      case "tab":
        return await withConnection(async () => {
          const targets = await listTargets();
          let target = null;
          if (params.index != null && params.index !== "") target = targets[Number(params.index)];
          else if (params.url) target = targets.find((t) => String(t.url).includes(params.url));
          if (!target) return { text: `No tab matched ${params.index ?? params.url ?? "(nothing given)"}. Use action=tabs to list them.`, details: {}, isError: true };
          setAgentTarget(target.id, "adopted");
          return { text: `Agent now controls: ${target.title || ""}  ${target.url}`, details: { url: target.url } };
        });
      default:
        return { text: `ERROR: unknown primitive ${action}`, isError: true };
    }
  } catch (e) {
    return { text: `ERROR: ${e.message}`, details: {}, isError: true };
  }
}
