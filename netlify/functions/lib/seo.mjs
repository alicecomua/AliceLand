// Сторінки для пошуковиків і соцмереж: головна з налаштуваннями, сторінка товару, sitemap.xml, robots.txt
import { getStore } from "@netlify/blobs";
import { DEFAULT_SITE, sanitizeSite, renderHome, renderProductPage, renderNotFound, renderSitemap, renderRobots } from "./site.mjs";
import { HOME_TEMPLATE, FONT_CSS } from "./home-template.mjs";

// Доповнення для головної сторінки: результати фільтра йдуть першими, а фото в картці товару вміщується в екран
const ADDON = `<style>
#collections[hidden]{display:none}
.pm-gal{padding:12px 12px 4px}
.pm-main{aspect-ratio:auto;height:min(70vh,620px);background:#e8eaf6;border-radius:18px;box-shadow:inset 0 0 0 1px rgba(27,37,82,.12)}
.pm-main img{object-fit:contain}
.pm-count{position:absolute;left:12px;bottom:12px;z-index:3;padding:4px 12px;border-radius:999px;background:rgba(27,37,82,.82);color:#fff;font:700 14px/1.4 system-ui,sans-serif}
@media(max-width:760px){.pm-gal{padding:56px 10px 2px}.pm-main{height:min(54vh,460px)}}
@media(max-height:560px){.pm-main{height:calc(100vh - 150px);min-height:200px}}
</style><script>(function(){
var c=document.getElementById('collections'),r=document.getElementById('resetAll');
if(c&&r){var s=function(){c.hidden=!r.hidden;};new MutationObserver(s).observe(r,{attributes:true,attributeFilter:['hidden']});s();}
var b=document.getElementById('pmBody');
if(b){new MutationObserver(function(){var m=b.querySelector('.pm-main'),t=b.querySelectorAll('.pm-thumb');if(!m||t.length<2)return;var i=0;for(var k=0;k<t.length;k++)if(t[k].getAttribute('aria-current')==='true')i=k;var e=m.querySelector('.pm-count');if(!e){e=document.createElement('span');e.className='pm-count';m.appendChild(e);}var x=(i+1)+' / '+t.length;if(e.textContent!==x)e.textContent=x;}).observe(b,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-current']});}
})();</script>`;
// Правки сайту «на льоту»: ручне введення зросту й віку (діапазон «від – до»).
// Кожна правка: [що знайти, на що замінити]. Якщо хоч одну не знайдено рівно один раз, не застосовується жодна.
const SITE_PATCHES = [
  [`.hp{position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden}
`,
`.hp{position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden}

.manual{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;margin:0 0 14px;color:var(--muted);font-weight:700;font-size:16px;white-space:nowrap}
.manual input{flex:1 1 0;width:auto;min-width:0;max-width:100px;min-height:46px;padding:0 12px;border:1.5px solid var(--line);border-radius:12px;background:#fff;font:700 17.5px var(--f-body);color:var(--ink);-moz-appearance:textfield}
.manual input::-webkit-outer-spin-button,.manual input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.manual input:focus{outline:0;border-color:var(--night-3);box-shadow:0 0 0 3px rgba(58,74,163,.18)}
`],
  [`        <button type="button" data-h="170" aria-pressed="false">170</button>
      </div>`,
`        <button type="button" data-h="170" aria-pressed="false">170</button>
      </div>
      <div class="manual" role="group" aria-label="Зріст вручну">
        <span>вручну:</span>
        <input id="hFrom" type="number" inputmode="numeric" min="40" max="220" placeholder="від" aria-label="Зріст від, см">
        <span aria-hidden="true">–</span>
        <input id="hTo" type="number" inputmode="numeric" min="40" max="220" placeholder="до" aria-label="Зріст до, см">
        <span>см</span>
      </div>`],
  [`        <button type="button" data-age="7" aria-pressed="false">15+</button>`,
`        <button type="button" data-age="7" aria-pressed="false">15+</button>
      </div>
      <div class="manual" role="group" aria-label="Вік вручну">
        <span>вручну:</span>
        <input id="aFrom" type="number" inputmode="numeric" min="0" max="18" placeholder="від" aria-label="Вік від, років">
        <span aria-hidden="true">–</span>
        <input id="aTo" type="number" inputmode="numeric" min="0" max="18" placeholder="до" aria-label="Вік до, років">
        <span>років</span>`],
  [`var ageSel = null;    // обрані вікові пари: { i, j } (індекси в AGE_BUCKETS)`,
`var ageSel = null;    // обраний вік: { lo, hi } у роках
var typing = '';      // яку групу полів зараз вводить людина (h або a): їх не переписуємо`],
  [`function lengthLabel(p) { return p.lengthKind === 'tag' ? 'Довжина від бірки до низу' : (p.lengthKind === 'height' ? 'Висота' : 'Довжина'); }`,
`function lengthLabel(p) { return p.lengthKind === 'tag' ? 'Довжина від бірки до низу' : (p.lengthKind === 'shoulder' ? 'Довжина від плеча' : (p.lengthKind === 'height' ? 'Висота' : 'Довжина')); }`],
  [`  return r.any ? true : (AGE_BUCKETS[sel.j][1] >= r.lo && AGE_BUCKETS[sel.i][0] <= r.hi);`,
`  return r.any ? true : (sel.hi >= r.lo && sel.lo <= r.hi);`],
  [`  if (!ageSel) ageSel = { i: i, j: i };
  else if (ageSel.i === ageSel.j) ageSel = ageSel.i === i ? null : { i: Math.min(ageSel.i, i), j: Math.max(ageSel.i, i) };
  else ageSel = { i: i, j: i };`,
`  var b = AGE_BUCKETS[i], single = -1, k;
  if (ageSel) for (k = 0; k < AGE_BUCKETS.length; k++) if (AGE_BUCKETS[k][0] === ageSel.lo && AGE_BUCKETS[k][1] === ageSel.hi) single = k;
  if (!ageSel) ageSel = { lo: b[0], hi: b[1] };
  else if (single >= 0) ageSel = single === i ? null : { lo: Math.min(ageSel.lo, b[0]), hi: Math.max(ageSel.hi, b[1]) };
  else ageSel = { lo: b[0], hi: b[1] };
}
function readRange(idA, idB, min, max) {
  var x = parseFloat($(idA).value), y = parseFloat($(idB).value);
  x = isFinite(x) ? Math.min(max, Math.max(min, x)) : null;
  y = isFinite(y) ? Math.min(max, Math.max(min, y)) : null;
  if (x === null && y === null) return null;
  if (x === null) x = y;
  if (y === null) y = x;
  return { lo: Math.min(x, y), hi: Math.max(x, y) };`],
  [`  for (i = 0; i < ag.length; i++) { var av = Number(ag[i].getAttribute('data-age')); ag[i].setAttribute('aria-pressed', String(!!ageSel && av >= ageSel.i && av <= ageSel.j)); }`,
`  for (i = 0; i < ag.length; i++) { var bk = AGE_BUCKETS[Number(ag[i].getAttribute('data-age'))]; ag[i].setAttribute('aria-pressed', String(!!ageSel && bk[0] >= ageSel.lo && bk[1] <= ageSel.hi)); }
  var box = [['hFrom', height && height.lo], ['hTo', height && height.hi], ['aFrom', ageSel && ageSel.lo], ['aTo', ageSel && ageSel.hi]];
  for (i = 0; i < box.length; i++) { el = $(box[i][0]); if (el && typing !== box[i][0].charAt(0) && document.activeElement !== el) el.value = box[i][1] == null || box[i][1] === false ? '' : String(box[i][1]); }`],
  [`    render();
  });`,
`    render();
  });
  finder.addEventListener('input', function (e) {
    var id = e.target.id;
    if (id === 'hFrom' || id === 'hTo') height = readRange('hFrom', 'hTo', 40, 220);
    else if (id === 'aFrom' || id === 'aTo') ageSel = readRange('aFrom', 'aTo', 0, 18);
    else return;
    typing = id.charAt(0);
    limit = PAGE;
    render();
    typing = '';
  });`],
];
export function patchSite(page) {
  let out = page;
  for (const [from, to] of SITE_PATCHES) {
    const i = out.indexOf(from);
    if (i < 0 || out.indexOf(from, i + 1) >= 0) return page;     // сторінка інша: нічого не чіпаємо
    out = out.slice(0, i) + to + out.slice(i + from.length);
  }
  return out;
}

export const withAddon = (page) => patchSite(page).replace("</body>", ADDON + "</body>");

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
      if (kind === "home") return html(withAddon(renderHome(template, await loadSite(), reqOrigin)));
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
      if (kind === "home") return html(withAddon(renderHome(template, structuredClone(DEFAULT_SITE), reqOrigin)), 200, "no-store");
      return new Response("Тимчасова помилка. Спробуйте за хвилину.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
  };
}
