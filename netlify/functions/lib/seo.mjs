// Сторінки для пошуковиків і соцмереж: головна з налаштуваннями, сторінка товару, sitemap.xml, robots.txt
import { getStore } from "@netlify/blobs";
import { DEFAULT_SITE, sanitizeSite, renderHome, renderProductPage, renderNotFound, renderSitemap, renderRobots } from "./site.mjs";
import { HOME_TEMPLATE, FONT_CSS } from "./home-template.mjs";

const html = (body, status = 200, cache = "public, max-age=0, must-revalidate") => new Response(body, {
  status,
  headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": cache,
    ...(status === 200 ? { "netlify-cdn-cache-control": "public, s-maxage=60, stale-while-revalidate=300" } : {}),
  },
});

export function createSeoHandler({ getStore: makeStore = getStore, template = HOME_TEMPLATE, fontCss = FONT_CSS } = {}) {
  const db = () => makeStore({ name: "aliceland", consistency: "strong" });

  async function loadSite() {
    try {
      const raw = await db().get("site", { type: "json" });
      const s = raw ? sanitizeSite(raw) : null;
      return s && s.value ? s.value : structuredClone(DEFAULT_SITE);
    } catch { return structuredClone(DEFAULT_SITE); }       // збій сховища не має ламати сторінку
  }
  let memo = { etag: null, items: [] };              // розібраний каталог, доки він не змінився (перевіряємо за дешевою міткою версії)
  async function loadItems() {
    const md = await db().getMetadata("products");
    if (md && md.etag && memo.etag === md.etag) return memo.items;
    const d = await db().get("products", { type: "json" });
    const items = d && Array.isArray(d.items) ? d.items : [];
    memo = { etag: md && md.etag ? md.etag : null, items };
    return items;
  }
  const norm = (p) => ({ ...p, audience: p.audience || [], tags: p.tags || [], images: p.images || [], size: p.size || "", condition: p.condition || "", desc: p.desc || "" });

  return async function handle(req) {
    const url = new URL(req.url);
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
    const proto = (req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "")).split(",")[0].trim();
    const reqOrigin = `${proto === "http" && !/^(localhost|127\.)/.test(host) ? "https" : proto}://${host}`;
    const kind = url.searchParams.get("kind") || "home";
    try {
      if (kind === "home") return html(renderHome(template, await loadSite(), reqOrigin));
      if (kind === "robots") return new Response(renderRobots(await loadSite(), reqOrigin), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
      if (kind === "sitemap") {
        const [site, items] = await Promise.all([loadSite(), loadItems()]);
        return new Response(renderSitemap(site, items, reqOrigin), { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate", "netlify-cdn-cache-control": "public, s-maxage=600, stale-while-revalidate=3600" } });
      }
      if (kind === "product") {
        const id = String(url.searchParams.get("id") || "").toUpperCase();
        const site = await loadSite();
        const p = /^ALC-\d{1,6}$/.test(id) ? (await loadItems()).find((x) => x.id === id) : null;
        if (!p || p.status === "hidden") return html(renderNotFound(site, { reqOrigin, fontCss }), 404, "no-store");
        return html(renderProductPage(site, norm(p), { reqOrigin, fontCss }));
      }
      return html(renderNotFound(await loadSite(), { reqOrigin, fontCss }), 404, "no-store");
    } catch (e) {
      if (kind === "home") return html(renderHome(template, structuredClone(DEFAULT_SITE), reqOrigin), 200, "no-store");
      return new Response("Тимчасова помилка. Спробуйте за хвилину.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
  };
}
