import { DEFAULT_TRACK, sanitizeTrack, trackerHead, trackEventScript } from "./track.mjs";

// Налаштування сайту (контакти й SEO) і все, що з них будується на сервері:
// «шапка» сторінок для пошуковиків, сторінки товарів, sitemap.xml, robots.txt.
// Чистий код без залежностей, тож його легко перевіряти.

export const DEFAULT_SITE = {
  contacts: {
    phone: "097 862 40 66", phone2: "", viber: "", telegram: "", instagram: "",
    shafa: "https://shafa.ua/uk/member/alice_lenskaya", city: "Хмельницький", address: "", hours: "",
  },
  seo: {
    title: "AliceLand — Карнавальні костюми Хмельницький",
    description: "Вживані карнавальні костюми для дівчаток і хлопчиків: принцеси, супергерої, феї, тварини, Хелловін. Живі фото, зріст і чесний стан у кожної картки.",
    keywords: "карнавальні костюми, вживані карнавальні костюми, дитячі карнавальні костюми, костюм на Хелловін, новорічні костюми, Хмельницький",
    siteUrl: "", gsc: "", gaId: "",
  },
  track: { ...DEFAULT_TRACK },
};

/* ---------- Очищення того, що ввела власниця ---------- */
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const digits = (s) => String(s ?? "").replace(/\D/g, "");

export function phoneTel(phone) {
  const d = digits(phone);
  if (/^0\d{9}$/.test(d)) return "+38" + d;
  if (/^380\d{9}$/.test(d)) return "+" + d;
  return d ? "+" + d : "";
}
function onlyHost(url, hostRe) {
  try {
    const u = new URL(String(url).trim());
    return u.protocol === "https:" && hostRe.test(u.hostname) ? u : null;
  } catch { return null; }
}
function socialUser(v, hostRe, re) {
  const s = clean(v, 200);
  if (!s) return "";
  const u = onlyHost(/^https?:/i.test(s) ? s : "https://" + s.replace(/^@/, "x.invalid/"), hostRe);
  const name = u ? u.pathname.split("/").filter(Boolean)[0] : s.replace(/^@/, "");
  return name && re.test(name) ? name : null;
}

// Повертає { value } або { error }. Порожнє необов'язкове поле дозволене
export function sanitizeSite(raw) {
  const rc = raw?.contacts || {}, rs = raw?.seo || {};
  const c = { ...DEFAULT_SITE.contacts }, s = { ...DEFAULT_SITE.seo };

  const phone = clean(rc.phone ?? c.phone, 30);
  if (digits(phone).length < 9 || digits(phone).length > 13) return { error: "Телефон: має бути щонайменше 9 цифр" };
  c.phone = phone;
  const phone2 = clean(rc.phone2, 30);
  if (phone2 && (digits(phone2).length < 9 || digits(phone2).length > 13)) return { error: "Другий телефон: має бути щонайменше 9 цифр" };
  c.phone2 = phone2;
  const viber = clean(rc.viber, 30);
  if (viber && digits(viber).length < 9) return { error: "Viber: має бути щонайменше 9 цифр" };
  c.viber = viber;

  const tg = socialUser(rc.telegram, /^(www\.)?(t\.me|telegram\.me)$/i, /^[A-Za-z0-9_]{5,32}$/);
  if (tg === null) return { error: "Telegram: вкажи @імʼя користувача (5–32 символи) або посилання t.me" };
  c.telegram = tg ? "https://t.me/" + tg : "";
  const ig = socialUser(rc.instagram, /^(www\.)?instagram\.com$/i, /^[A-Za-z0-9._]{1,30}$/);
  if (ig === null) return { error: "Instagram: вкажи @імʼя або посилання на профіль" };
  c.instagram = ig ? `https://www.instagram.com/${ig}/` : "";

  const shafaRaw = rc.shafa === undefined ? c.shafa : clean(rc.shafa, 300);   // немає поля = лишаємо стандартне, порожнє = прибрати
  if (shafaRaw) {
    const u = onlyHost(shafaRaw, /^(www\.)?shafa\.ua$/i);
    if (!u) return { error: "Shafa: потрібне посилання на твій магазин (https://shafa.ua/…)" };
    c.shafa = u.origin + u.pathname.replace(/\/+$/, "");
  } else c.shafa = "";
  c.city = clean(rc.city ?? c.city, 60);
  c.address = clean(rc.address, 120);
  c.hours = clean(rc.hours, 120);

  s.title = clean(rs.title ?? s.title, 90) || DEFAULT_SITE.seo.title;
  s.description = clean(rs.description ?? s.description, 300) || DEFAULT_SITE.seo.description;
  s.keywords = (rs.keywords === undefined ? s.keywords : clean(rs.keywords, 300)).split(/\s*[,;]\s*/).filter(Boolean).join(", ");
  const urlRaw = clean(rs.siteUrl, 200);
  if (urlRaw) {
    let u = null;
    try { u = new URL(/^https?:/i.test(urlRaw) ? urlRaw : "https://" + urlRaw); } catch { /* нижче помилка */ }
    if (!u || !/^https:$|^http:$/.test(u.protocol) || (u.protocol === "http:" && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return { error: "Адреса сайту: потрібна повна адреса з https://, наприклад https://aliceland.netlify.app" };
    s.siteUrl = u.origin;
  } else s.siteUrl = "";
  let gsc = clean(rs.gsc, 300);
  const m = gsc.match(/content\s*=\s*["']([^"']+)["']/i);
  if (m) gsc = m[1];
  if (gsc && !/^[A-Za-z0-9_-]{20,100}$/.test(gsc)) return { error: "Код Google Search Console: встав лише код підтвердження або весь мета-тег" };
  s.gsc = gsc;
  const ga = clean(rs.gaId, 30).toUpperCase();
  if (ga && !/^G-[A-Z0-9]{4,14}$/.test(ga)) return { error: "Google Analytics: ідентифікатор має вигляд G-XXXXXXXXXX" };
  s.gaId = ga;
  const tr = sanitizeTrack(raw?.track);
  if (tr.error) return { error: tr.error };
  return { value: { contacts: c, seo: s, track: tr.value } };
}

// Лише те, що потрібно сторінкам і не є таємницею
export function deriveSite(site) {
  const c = site.contacts;
  const tel = phoneTel(c.phone), tel2 = phoneTel(c.phone2);
  const viberTel = phoneTel(c.viber) || tel;
  return {
    phone_view: c.phone, phone_tel: tel, phone2_view: c.phone2, phone2_tel: tel2,
    viber_url: viberTel ? `viber://chat?number=${encodeURIComponent(viberTel)}` : "",
    telegram_url: c.telegram, instagram_url: c.instagram, shafa_url: c.shafa,
    city: c.city, address: c.address, hours: c.hours,
  };
}

/* ---------- Шаблони ---------- */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const jsonSafe = (o) => JSON.stringify(o).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

// {{ключ}} з екрануванням, {{{ключ}}} як є, {{#ключ}}…{{/ключ}} лише якщо значення не порожнє
export function renderTemplate(tpl, vars) {
  let out = tpl, prev;
  do {                                                       // вкладені блоки розкриваємо за кілька проходів
    prev = out;
    out = out.replace(/\{\{#([a-z0-9_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (m, k, body) => (vars[k] ? body : ""));
  } while (out !== prev);
  out = out.replace(/\{\{\{([a-z0-9_]+)\}\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return out.replace(/\{\{([a-z0-9_]+)\}\}/g, (m, k) => (k in vars ? esc(vars[k]) : m));
}

export const sizeText = (s) => (/^\d/.test(s) && !/см/i.test(s) ? s + " см" : s);
const yearsWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? "рік" : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "роки" : "років"));
export const ageText = (p) => (p.ageFrom == null ? "" : (p.ageTo === p.ageFrom ? `${p.ageFrom} ${yearsWord(p.ageFrom)}` : `${p.ageFrom}–${p.ageTo} ${yearsWord(p.ageTo)}`));
export const lengthLabel = (p) => (p.lengthKind === "tag" ? "Довжина від бірки до низу" : (p.lengthKind === "height" ? "Висота" : "Довжина"));
export const conditionText = (p) => (p.condition === "Новий" ? "новий" : `${String(p.condition || "").toLowerCase()}, вживаний`);

const origin = (site, reqOrigin) => (site.seo.siteUrl || reqOrigin || "").replace(/\/+$/, "");

function storeJsonLd(site, o) {
  const c = site.contacts, d = deriveSite(site);
  const ld = { "@context": "https://schema.org", "@type": "Store", name: "AliceLand", description: site.seo.description, url: o + "/", image: o + "/logo.jpg", priceRange: "₴" };
  if (d.phone_tel) ld.telephone = d.phone_tel;
  const addr = { "@type": "PostalAddress", addressCountry: "UA" };
  if (c.city) addr.addressLocality = c.city;
  if (c.address) addr.streetAddress = c.address;
  if (c.city || c.address) ld.address = addr;
  const same = [c.instagram, c.shafa, c.telegram].filter(Boolean);
  if (same.length) ld.sameAs = same;
  return ld;
}
function productJsonLd(site, p, o) {
  const ld = {
    "@context": "https://schema.org", "@type": "Product", name: p.name, sku: p.id,
    description: [`${sizeText(p.size)}.`, `Стан: ${conditionText(p)}.`, p.desc].filter(Boolean).join(" ").slice(0, 500),
    image: p.images.slice(0, 6).map((id) => `${o}/img/${id}`),
    itemCondition: p.condition === "Новий" ? "https://schema.org/NewCondition" : "https://schema.org/UsedCondition",
    offers: {
      "@type": "Offer", url: `${o}/p/${p.id}`, priceCurrency: "UAH", price: String(p.price),
      availability: p.status === "available" ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      seller: { "@type": "Organization", name: "AliceLand" },
    },
  };
  return ld;
}

// Усе, що йде в <head>: заголовок, опис, ключові слова, canonical, соцмережі, розмітка, підтвердження й аналітика
export function buildHead(site, { reqOrigin = "", path = "/", title, description, image, type = "website", jsonLd = [], noindex = false } = {}) {
  const o = origin(site, reqOrigin);
  const t = title || site.seo.title, desc = description || site.seo.description;
  const img = image ? (/^https?:/.test(image) ? image : o + image) : (o ? o + "/logo.jpg" : "/logo.jpg");
  const L = [`<title>${esc(t)}</title>`, `<meta name="description" content="${esc(desc)}">`];
  if (site.seo.keywords) L.push(`<meta name="keywords" content="${esc(site.seo.keywords)}">`);
  if (noindex) L.push('<meta name="robots" content="noindex,follow">');
  if (o) L.push(`<link rel="canonical" href="${esc(o + path)}">`);
  L.push(`<meta property="og:type" content="${esc(type)}">`, '<meta property="og:site_name" content="AliceLand">', '<meta property="og:locale" content="uk_UA">',
    `<meta property="og:title" content="${esc(t)}">`, `<meta property="og:description" content="${esc(desc)}">`, `<meta property="og:image" content="${esc(img)}">`);
  if (o) L.push(`<meta property="og:url" content="${esc(o + path)}">`);
  L.push('<meta name="twitter:card" content="summary_large_image">', `<meta name="twitter:title" content="${esc(t)}">`, `<meta name="twitter:description" content="${esc(desc)}">`, `<meta name="twitter:image" content="${esc(img)}">`);
  if (site.seo.gsc) L.push(`<meta name="google-site-verification" content="${esc(site.seo.gsc)}">`);
  for (const ld of jsonLd) L.push(`<script type="application/ld+json">${jsonSafe(ld)}</script>`);
  const trk = trackerHead(site);
  if (trk) L.push(trk);
  return L.join("\n");
}

export function homeVars(site, reqOrigin) {
  const d = deriveSite(site);
  const o = origin(site, reqOrigin);
  return { ...d, seo_head: buildHead(site, { reqOrigin, path: "/", jsonLd: o ? [storeJsonLd(site, o)] : [] }), site_json: jsonSafe(d) };
}
export const renderHome = (template, site, reqOrigin) => renderTemplate(template, homeVars(site, reqOrigin));

/* ---------- Сторінка товару ---------- */
const PRODUCT_CSS = `
:root{--night:#1b2552;--night-3:#3a4aa3;--paper:#f3f4fa;--ink:#1b2046;--muted:#5d648c;--line:#dfe2f1;--gold:#f1c75b;--f-display:"Unbounded","Trebuchet MS",system-ui,sans-serif;--f-body:"Nunito","Segoe UI",system-ui,sans-serif}
*,*::before,*::after{box-sizing:border-box}*{margin:0}html{-webkit-text-size-adjust:100%}
body{font:400 17.5px/1.55 var(--f-body);color:var(--ink);background:var(--paper)}
a{color:inherit}img{max-width:100%;display:block}
.top{background:var(--night);color:#eef0ff}.top .wrap{display:flex;align-items:center;gap:14px;height:64px}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none;font:700 18px var(--f-display)}.brand img{width:40px;height:40px;border-radius:50%;box-shadow:0 0 0 2px var(--gold)}
.call{margin-left:auto;display:inline-flex;align-items:center;min-height:44px;padding:0 18px;border-radius:999px;background:var(--gold);color:var(--ink);font-weight:800;text-decoration:none;white-space:nowrap}
.wrap{max-width:1000px;margin:0 auto;padding:0 20px}
.crumbs{margin:18px 0 14px;font-size:15.5px;color:var(--muted)}.crumbs a{color:var(--night-3);font-weight:800}
.prod{display:grid;gap:18px;padding-bottom:36px;grid-template-areas:"top" "gal" "rest"}
.p-top{grid-area:top}.gal{grid-area:gal}.p-rest{grid-area:rest}
.gal{display:grid;gap:10px;align-content:start}.gal img{width:100%;border-radius:20px;background:#e8eaf6;aspect-ratio:4/5;object-fit:cover}
h1{font:700 clamp(22px,4.4vw,32px)/1.15 var(--f-display);letter-spacing:-.015em;text-wrap:balance}
.price{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin:14px 0}.price b{font:700 34px/1 var(--f-display)}.price s{color:#8a91b5}
.facts{display:grid;grid-template-columns:auto 1fr;gap:6px 18px;margin:0 0 16px;font-size:16.5px}.facts dt{color:var(--muted)}.facts dd{margin:0;font-weight:800}
.desc{color:var(--muted);margin-bottom:18px}.desc p+p{margin-top:8px}
.cta{display:flex;flex-wrap:wrap;gap:12px}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:52px;padding:0 28px;border-radius:14px;background:var(--night);color:#fff;font-weight:800;text-decoration:none}
.btn.ghost{background:#fff;color:var(--night);box-shadow:inset 0 0 0 1.5px var(--night)}
.note{padding:12px 14px;border-radius:14px;background:#fff6dc;color:#6b4c00;margin:12px 0}
footer{background:var(--night);color:#b9c0ea;padding:26px 0 32px;font-size:16px}footer a{color:#eef0ff}footer ul{list-style:none;padding:0;display:flex;gap:8px 22px;flex-wrap:wrap;margin-top:8px}
@media(min-width:800px){.prod{grid-template-columns:1.05fr 1fr;grid-template-rows:auto 1fr;gap:20px 36px;grid-template-areas:"gal top" "gal rest"}}
`;

function shell(site, { head, bodyHtml, fontCss, reqOrigin, tail = "" }) {
  const d = deriveSite(site);
  const contacts = [
    `<li><a href="tel:${esc(d.phone_tel)}">${esc(d.phone_view)}</a></li>`,
    d.phone2_view ? `<li><a href="tel:${esc(d.phone2_tel)}">${esc(d.phone2_view)}</a></li>` : "",
    d.viber_url ? `<li><a href="${esc(d.viber_url)}">Viber</a></li>` : "",
    d.telegram_url ? `<li><a href="${esc(d.telegram_url)}" rel="noopener">Telegram</a></li>` : "",
    d.instagram_url ? `<li><a href="${esc(d.instagram_url)}" rel="noopener">Instagram</a></li>` : "",
    d.shafa_url ? `<li><a href="${esc(d.shafa_url)}" rel="noopener">Shafa</a></li>` : "",
    `<li>${esc([d.city, d.address].filter(Boolean).join(", "))}</li>`,
    d.hours ? `<li>${esc(d.hours)}</li>` : "",
  ].join("");
  return `<!DOCTYPE html>
<html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#1b2552">
${head}
<link rel="icon" href="/logo.jpg">
<style>${fontCss || ""}${PRODUCT_CSS}</style></head><body>
<header class="top"><div class="wrap"><a class="brand" href="/"><img src="/logo.jpg" alt="" width="40" height="40"><span>AliceLand</span></a><a class="call" href="tel:${esc(d.phone_tel)}">${esc(d.phone_view)}</a></div></header>
${bodyHtml}
${tail}
<footer><div class="wrap"><strong>AliceLand</strong>, вживані карнавальні костюми<ul>${contacts}</ul></div></footer>
</body></html>`;
}

export function productTitle(p) { return `${p.name}, ${sizeText(p.size)}, ${p.price} грн | AliceLand`; }
export function productDescription(p) {
  const base = `${p.name}. ${sizeText(p.size)}. Стан: ${conditionText(p)}. Ціна ${p.price} грн.`;
  const tail = (p.desc || "").replace(/\s+/g, " ").trim();
  const s = tail ? `${base} ${tail}` : base;
  return s.length > 158 ? s.slice(0, 155).replace(/\s+\S*$/, "") + "…" : s;
}

export function renderProductPage(site, p, { reqOrigin = "", fontCss = "" } = {}) {
  const o = origin(site, reqOrigin);
  const sold = p.status === "sold";
  const head = buildHead(site, {
    reqOrigin, path: `/p/${p.id}`, title: productTitle(p), description: productDescription(p),
    image: p.images[0] ? `/img/${p.images[0]}` : "", type: "product", jsonLd: o ? [productJsonLd(site, p, o)] : [], noindex: sold,
  });
  const d = deriveSite(site);
  const facts = [["Розмір", sizeText(p.size)], p.ageFrom != null ? ["Вік", ageText(p)] : null, p.length ? [lengthLabel(p), p.length] : null, ["Стан", p.condition + (p.condition === "Новий" ? "" : ", вживаний")], ["Артикул", p.id]]
    .filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  const imgs = p.images.slice(0, 8).map((id, i) => `<img src="/img/${esc(id)}" alt="${esc(p.name)}${i ? ", фото " + (i + 1) : ""}" ${i ? 'loading="lazy"' : 'fetchpriority="high"'} width="800" height="1000">`).join("");
  const desc = (p.desc || "").split(/\n+/).filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join("");
  const note = sold ? '<p class="note">Цей костюм уже продано. <a href="/#catalog">Дивитись інші костюми</a></p>' : (p.status === "reserved" ? '<p class="note">Зараз цей костюм у резерві. Зателефонуй, щоб дізнатись, чи він ще доступний.</p>' : "");
  const price = `<div class="price"><b>${esc(p.price)} грн</b>${p.oldPrice ? `<s>${esc(p.oldPrice)} грн</s>` : ""}</div>`;
  const cta = sold ? "" : `<div class="cta">${p.status === "available" ? `<a class="btn" href="/?art=${esc(p.id)}&amp;order=1">Замовити</a>` : ""}<a class="btn ghost" href="tel:${esc(d.phone_tel)}">Зателефонувати</a></div>`;
  const body = `<main class="wrap"><nav class="crumbs" aria-label="Навігація"><a href="/#catalog">Каталог</a> / ${esc(p.name)}</nav>
<article class="prod"><div class="p-top"><h1>${esc(p.name)}</h1>${price}${note}${cta}</div><div class="gal">${imgs}</div><div class="p-rest"><dl class="facts">${facts}</dl>${desc ? `<div class="desc">${desc}</div>` : ""}</div></article></main>`;
  return shell(site, { head, bodyHtml: body, fontCss, reqOrigin, tail: trackEventScript({ id: p.id, name: p.name, price: p.price }) });
}

export function renderNotFound(site, { reqOrigin = "", fontCss = "" } = {}) {
  const head = buildHead(site, { reqOrigin, path: "/", title: "Сторінку не знайдено | AliceLand", noindex: true });
  const body = '<main class="wrap"><h1 style="margin:40px 0 12px">Такого костюма немає</h1><p style="margin-bottom:20px">Можливо, його вже продано. Подивись інші в каталозі.</p><a class="btn" href="/#catalog">До каталогу</a></main>';
  return shell(site, { head, bodyHtml: body, fontCss, reqOrigin });
}

/* ---------- sitemap.xml і robots.txt ---------- */
const xml = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch]));
export function renderSitemap(site, items, reqOrigin) {
  const o = origin(site, reqOrigin);
  const day = (p) => String(p.updatedAt || p.createdAt || "").slice(0, 10);
  const urls = [`<url><loc>${xml(o + "/")}</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`]
    .concat(items.filter((p) => p.status === "available" || p.status === "reserved").map((p) => `<url><loc>${xml(`${o}/p/${p.id}`)}</loc>${/^\d{4}-\d{2}-\d{2}$/.test(day(p)) ? `<lastmod>${day(p)}</lastmod>` : ""}<changefreq>weekly</changefreq><priority>0.8</priority></url>`));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
export function renderRobots(site, reqOrigin) {
  const o = origin(site, reqOrigin);
  return `User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\n\nSitemap: ${o}/sitemap.xml\n`;
}
