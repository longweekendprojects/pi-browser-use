// Primitive browser actions: the raw verbs the agent composes. Shortcuts build
// on these. Acting verbs run ONLY on the agent's own dedicated tab; they never
// touch a tab the user opened. `navigate` opens the agent tab if needed; `tab`
// is the explicit handover of one of the user's tabs.

const Q = new URL(import.meta.url).search;
const imp = (rel) => import(new URL(rel, import.meta.url).href + Q);
const { withAgentPage, withConnect, adoptPage, findAgentPage, targetIdOf, ensureArc, redact, PORT } = await imp("./helpers.mjs");

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
];

// Runs in the page: tag visible interactive elements with stable refs and
// return a compact list the agent can act on.
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

async function doClick(page, p) {
  if (p.ref) { await page.click(`[data-pbu-ref="${p.ref}"]`, { timeout: 10000 }); return `@${p.ref}`; }
  if (p.selector) { await page.click(p.selector, { timeout: 10000 }); return p.selector; }
  if (p.text) { await page.getByText(p.text, { exact: false }).first().click({ timeout: 10000 }); return `text:${p.text}`; }
  throw new Error("click requires one of: ref, selector, text");
}

export async function runPrimitive(params, opts = {}) {
  const { action } = params;

  if (action === "ensure") {
    const r = await ensureArc(opts);
    return { text: r.ok ? `Arc CDP ready on ${PORT}${r.relaunched ? " (relaunched)" : ""}` : `ERROR: ${r.error}`, details: r, isError: !r.ok };
  }

  const ens = await ensureArc(opts);
  if (!ens.ok) return { text: `ERROR: ${ens.error}`, details: ens, isError: true };

  try {
    switch (action) {
      case "navigate":
        // Opens the agent's own tab if it does not exist; never reuses a user tab.
        return await withAgentPage(async (page) => {
          await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: 30000 });
          return { text: `OK ${page.url()}`, details: { url: page.url() } };
        }, { create: true });
      case "read":
        return await withAgentPage(async (page) => {
          const title = await page.title();
          const body = redact((await page.evaluate(() => document.body?.innerText || "")).trim());
          return { text: `URL: ${page.url()}\nTITLE: ${title}\n---\n${body.slice(0, params.limit || 4000)}`, details: { url: page.url(), title } };
        });
      case "snapshot":
        return await withAgentPage(async (page) => {
          const els = await page.evaluate(snapshotFn);
          const lines = els.map((e) => `@${e.ref} ${e.role}${e.type ? `[${e.type}]` : ""} ${JSON.stringify(redact(e.name))}`);
          return { text: `${page.url()}\n${els.length} interactive elements:\n${lines.join("\n")}`, details: { url: page.url(), elements: els } };
        });
      case "click":
        return await withAgentPage(async (page) => {
          const t = await doClick(page, params);
          return { text: `CLICKED ${t}`, details: { target: t } };
        });
      case "fill":
        return await withAgentPage(async (page) => {
          const sel = params.ref ? `[data-pbu-ref="${params.ref}"]` : params.selector;
          if (!sel) throw new Error("fill requires ref or selector");
          await page.fill(sel, params.value ?? params.text ?? "", { timeout: 10000 });
          return { text: `FILLED ${sel}`, details: { selector: sel } };
        });
      case "eval":
        return await withAgentPage(async (page) => {
          const r = await page.evaluate(params.js);
          return { text: redact(JSON.stringify(r, null, 2) ?? "null"), details: {} };
        });
      case "screenshot":
        return await withAgentPage(async (page) => {
          await page.screenshot({ path: params.path, fullPage: !!params.fullPage });
          return { text: `SAVED ${params.path}`, details: { path: params.path } };
        });
      case "tabs":
        // Read-only: lists every tab and marks the one the agent owns.
        return await withConnect(async (ctx) => {
          const agent = await findAgentPage(ctx);
          const agentId = agent ? await targetIdOf(ctx, agent) : null;
          const lines = [];
          for (const [i, pg] of ctx.pages().entries()) {
            if (pg.url().startsWith("devtools://")) continue;
            const mine = (await targetIdOf(ctx, pg)) === agentId ? "  <- agent tab" : "";
            lines.push(`[${i}] ${await pg.title()}  ${pg.url()}${mine}`);
          }
          return { text: lines.join("\n"), details: { count: ctx.pages().length } };
        });
      case "tab":
        // Explicit handover: the user points the agent at an existing tab.
        return await withConnect(async (ctx) => {
          const pages = ctx.pages().filter((p) => !p.url().startsWith("devtools://"));
          let target = null;
          if (params.index != null && params.index !== "") target = pages[Number(params.index)];
          else if (params.url) target = pages.find((p) => p.url().includes(params.url));
          if (!target) return { text: `No tab matched ${params.index ?? params.url ?? "(nothing given)"}. Use action=tabs to list them.`, details: {}, isError: true };
          await adoptPage(ctx, target);
          return { text: `Agent now controls: ${await target.title()}  ${target.url()}`, details: { url: target.url() } };
        });
      default:
        return { text: `ERROR: unknown primitive ${action}`, isError: true };
    }
  } catch (e) {
    return { text: `ERROR: ${e.message}`, details: {}, isError: true };
  }
}
