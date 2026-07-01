// Shortcut: wait-for
// Poll the active tab until a condition holds, instead of blind sleeps. The
// condition is any of: URL substring, visible text, or a CSS selector.

const Q = new URL(import.meta.url).search;
const imp = (rel) => import(new URL(rel, import.meta.url).href + Q);
const { withAgentPage, sleep } = await imp("../helpers.mjs");

export const meta = {
  name: "wait-for",
  summary: "Wait until the active tab matches a URL substring, visible text, or selector (no blind sleeps).",
  params: "url? | text? | selector? | timeoutMs?(=15000) | intervalMs?(=500)",
};

export async function run(params) {
  const timeoutMs = Number(params.timeoutMs) || 15000;
  const intervalMs = Number(params.intervalMs) || 500;
  const want = { url: params.url, text: params.text, selector: params.selector };
  if (!want.url && !want.text && !want.selector)
    return { text: "ERROR: wait-for needs one of url, text, selector", isError: true };

  const deadline = Date.now() + timeoutMs;
  return await withAgentPage(async (page) => {
    while (Date.now() < deadline) {
      const hit = await page
        .evaluate(
          (w) => {
            if (w.url && location.href.includes(w.url)) return `url~=${w.url}`;
            if (w.text && (document.body?.innerText || "").includes(w.text)) return `text~=${w.text}`;
            if (w.selector) {
              const el = document.querySelector(w.selector);
              if (el) {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return `selector=${w.selector}`;
              }
            }
            return null;
          },
          want,
        )
        .catch(() => null);
      if (hit) {
        const u = await page.url();
        return { text: `MATCHED ${hit} at ${u}`, details: { matched: hit, url: u } };
      }
      await sleep(intervalMs);
    }
    return { text: `TIMEOUT after ${timeoutMs}ms waiting for ${JSON.stringify(want)}`, details: { timedOut: true }, isError: true };
  });
}
