// AliceLand — API каталогу + віддача фото (Netlify Function v2).
//
// Де лежать дані: у Netlify Blobs, а не в репозиторії. Тому новий костюм
// з'являється на сайті одразу і не запускає перебудову сайту (а кожна
// перебудова на безкоштовному плані коштує 15 із 300 кредитів на місяць).
//
// Публічні адреси:
//   GET  /api/products                 — каталог для сайту (в наявності + резерв) і список хештегів
//   GET  /img/<id>                     — фото (id із 16 символів, з літерою "s" — мініатюра)
// Адреси адмінки (потрібен заголовок x-admin-key = змінна ADMIN_PASSWORD у Netlify, закодована через encodeURIComponent):
//   GET    /api/admin/products         — усі лоти з усіма статусами і список хештегів
//   POST /api/order                    — замовлення з сайту (зберігається в адмінці й іде в Telegram)
//   GET    /api/admin/orders           — журнал замовлень; PATCH /api/admin/order/<ключ> — змінити статус
//   PUT    /api/admin/tags             — зберегти хештеги й колекції (окремі блоки на сайті)
//   POST   /api/admin/import           — розібрати сторінку товару на Shafa в чернетку (за посиланням або з вставленого коду)
//   GET    /api/admin/import-img?id=…  — віддати фото з Shafa браузеру адмінки (він його стисне й завантажить)
//   PUT    /api/admin/img/<id>         — завантажити фото (JPEG)
//   POST   /api/admin/product          — створити лот
//   PATCH  /api/admin/product/<ALC-1>  — змінити лот (будь-які поля, у тому числі статус)
//   DELETE /api/admin/product/<ALC-1>  — видалити лот разом із фото

import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { DEFAULT_SITE, sanitizeSite, deriveSite } from "./lib/site.mjs";
import { clientIp, ipKey, createLimiter } from "./lib/limits.mjs";
import { validateOrder, newOrderKey, orderPrefixes, orderNumber, telegramText, ORDER_STATUSES, ORDER_KEY_RE } from "./lib/orders.mjs";

const AUDIENCE = ["girls", "boys"];
// Хештеги можна міняти в адмінці. Ці — початковий набір, поки нічого не збережено.
export const DEFAULT_TAGS = [
  { key: "halloween", label: "хелловін", title: "Костюми на Хелловін", collection: false },
  { key: "newyear", label: "новорічні", title: "Новорічні костюми", collection: true },
  { key: "heroes", label: "супергерої", title: "", collection: false },
  { key: "princess", label: "принцеси", title: "", collection: false },
  { key: "fairy", label: "феї й янголи", title: "", collection: false },
  { key: "animals", label: "тварини", title: "", collection: false },
  { key: "disney", label: "disney", title: "", collection: false },
  { key: "accessories", label: "аксесуари", title: "", collection: false },
];
const CONDITIONS = ["Новий", "Ідеальний", "Дуже хороший", "Хороший", "Задовільний"];
const STATUSES = ["available", "reserved", "sold", "hidden"];
const EDITABLE = ["name", "audience", "tags", "size", "condition", "price", "oldPrice", "desc", "status", "images", "ageFrom", "ageTo", "length", "lengthKind", "srcPhotos"];
const MAX_IMAGES = 10;
const MAX_FULL_BYTES = 2.5 * 1024 * 1024;
const MAX_SMALL_BYTES = 400 * 1024;
const SRC_RE = /^shafa:\d{5,12}$/;
const FULL_ID = /^[a-f0-9]{16}$/;
const LENGTH_KINDS = ["tag", "shoulder", "height", "length"];   // від бірки до низу, від плеча, висота, довжина
// «62 см», «62–65 см» → єдиний вигляд; усе інше відкидаємо
function normLength(v) {
  const m = String(v ?? "").replace(",", ".").match(/(\d{2,3})(?:\.\d)?\s*(?:[–—-]\s*(\d{2,3})(?:\.\d)?)?/);
  if (!m) return "";
  const a = Number(m[1]), b = m[2] ? Number(m[2]) : null;
  if (a < 15 || a > 250 || (b !== null && (b < a || b > 250))) return "";
  return b !== null && b !== a ? `${a}–${b} см` : `${a} см`;
}
const ANY_ID = /^[a-f0-9]{16}s?$/;
const ART_ID = /^ALC-\d{3,}$/;

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Публічні відповіді кешує CDN Netlify: тисячі відвідувачів не будять функцію щоразу
const PUBLIC_CACHE = (s, swr) => ({ "cache-control": "public, max-age=0, must-revalidate", "netlify-cdn-cache-control": `public, s-maxage=${s}, stale-while-revalidate=${swr}` });
const ADMIN_LOCK = { windowMs: 15 * 60e3, max: 10 };      // 10 невдалих входів = пауза на 15 хвилин
const ORDER_LIMIT = { windowMs: 10 * 60e3, max: 6 };       // не більше 6 замовлень за 10 хвилин з однієї адреси
const artNumber = (id) => parseInt(String(id).replace(/\D/g, ""), 10) || 0;
const formatId = (n) => "ALC-" + String(n).padStart(3, "0");

function defaultEnv(name) {
  try {
    const v = globalThis.Netlify?.env?.get?.(name);
    if (v !== undefined && v !== null) return v;
  } catch {
    /* не у Netlify — беремо зі змінних процесу */
  }
  return process.env[name];
}

// Приводимо дані з форми до єдиного вигляду і перевіряємо обов'язкові поля.
export function normalize(raw, tagKeys = DEFAULT_TAGS.map((t) => t.key)) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const text = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const num = (v) => {
    const x = Math.round(Number(String(v ?? "").replace(",", ".").replace(/\s/g, "")));
    return Number.isFinite(x) ? x : 0;
  };

  const name = text(raw.name, 80);
  const size = text(raw.size, 40);
  const audience = AUDIENCE.filter((a) => arr(raw.audience).includes(a));
  const tags = tagKeys.filter((t) => arr(raw.tags).includes(t));
  const condition = CONDITIONS.includes(raw.condition) ? raw.condition : null;
  const price = num(raw.price);
  let oldPrice = raw.oldPrice === null || raw.oldPrice === undefined || raw.oldPrice === "" ? null : num(raw.oldPrice);
  if (!oldPrice || oldPrice <= price) oldPrice = null;
  const desc = String(raw.desc ?? "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 800);
  const status = STATUSES.includes(raw.status) ? raw.status : "available";
  const images = [...new Set(arr(raw.images).filter((x) => FULL_ID.test(x)))].slice(0, MAX_IMAGES);
  const ageNum = (v) => { if (v === "" || v === null || v === undefined) return null; const x = Math.round(Number(v)); return Number.isFinite(x) && x >= 0 && x <= 18 ? x : null; };
  let ageFrom = ageNum(raw.ageFrom), ageTo = ageNum(raw.ageTo);
  if (ageFrom === null) ageFrom = ageTo;
  if (ageTo === null) ageTo = ageFrom;
  if (ageFrom !== null && ageFrom > ageTo) [ageFrom, ageTo] = [ageTo, ageFrom];
  const length = normLength(raw.length);
  const lengthKind = length ? (LENGTH_KINDS.includes(raw.lengthKind) ? raw.lengthKind : "length") : "";

  if (name.length < 2) return { error: "Впиши назву костюма" };
  if (!audience.length) return { error: "Обери, для кого костюм: дівчатка, хлопчики чи універсальний" };
  if (!size) return { error: "Вкажи розмір або зріст" };
  if (!condition) return { error: "Обери стан костюма" };
  if (price > 100000 || (price < 1 && !(status === "hidden" && price === 0))) return { error: "Вкажи ціну в гривнях" };
  if ((status === "available" || status === "reserved") && !images.length) {
    return { error: "Додай хоча б одне фото" };
  }
  const value = { name, audience, tags, size, condition, price, oldPrice, desc, status, images };
  if (ageFrom !== null) { value.ageFrom = ageFrom; value.ageTo = ageTo; }
  if (length) { value.length = length; value.lengthKind = lengthKind; }
  if (typeof raw.src === "string" && SRC_RE.test(raw.src)) value.src = raw.src;
  if (typeof raw.srcUrl === "string" && /^https:\/\/(www\.)?shafa\.ua\/\S{3,280}$/.test(raw.srcUrl)) value.srcUrl = raw.srcUrl;
  const srcPhotos = [...new Set(arr(raw.srcPhotos).map(String).filter((x) => /^\d{6,14}$/.test(x)))].slice(0, MAX_IMAGES);
  if (srcPhotos.length) value.srcPhotos = srcPhotos;      // фото на Shafa, ще не збережені на сайті (чернетка, знайдена автоматично)
  const sp = Math.round(Number(raw.srcPrice));
  if (Number.isFinite(sp) && sp > 0 && sp <= 1000000) value.srcPrice = sp;
  return { value };
}

export function sanitizeTags(list) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(list) ? list : []) {
    if (!t || typeof t !== "object") continue;
    const label = String(t.label ?? "").trim().replace(/^#+\s*/, "").replace(/\s+/g, " ").trim().slice(0, 30).toLowerCase();
    if (!label) continue;
    let key = String(t.key ?? "").toLowerCase();
    while (!/^[a-z0-9]{2,16}$/.test(key) || seen.has(key)) key = "x" + randomBytes(3).toString("hex");
    seen.add(key);
    out.push({ key, label, title: String(t.title ?? "").replace(/\s+/g, " ").trim().slice(0, 50), collection: !!t.collection });
    if (out.length >= 40) break;
  }
  return out;
}

const toPublic = (p) => ({
  id: p.id,
  name: p.name,
  audience: p.audience,
  tags: p.tags,
  size: p.size,
  condition: p.condition,
  price: p.price,
  oldPrice: p.oldPrice ?? null,
  desc: p.desc || "",
  status: p.status,
  images: p.images,
  createdAt: p.createdAt,
  ageFrom: p.ageFrom ?? null,
  ageTo: p.ageTo ?? null,
  length: p.length || "",
  lengthKind: p.lengthKind || "",
});


/* ---------- Розбір сторінки товару на Shafa ---------- */
// Ідея: не покладатися на назви класів у верстці Shafa, а брати те, що не змінюється:
// мета-теги (og:…), напис «Опис»/«Характеристики»/«Стан:», alt фото, що починається з назви товару.
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}
function attrsOf(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = decode(m[2] ?? m[3]);
  return out;
}
function metaMap(html) {
  const out = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    const k = (a.property || a.name || "").toLowerCase();
    if (k && a.content !== undefined && !(k in out)) out[k] = a.content;
  }
  return out;
}
function toLines(html) {
  const s = html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|section|article|tr|dt|dd|header|footer|nav|button|label|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decode(s).split(/\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}
const WB = "(?<![а-яіїєґa-z])"; // початок слова (\b не працює з кирилицею)
const STEMS = {
  halloween: ["хеллов", "halloween", "геловін", "хелоу", "хеллоу"],
  newyear: ["новорічн", "новий рік", "нового року", "новогодн", "ялинк", "сніговик", "снігурк", "дід мороз", "санта", "різдвян", "олень", "оленя"],
  heroes: ["супергеро", "людина-павук", "людина павук", "спайдермен", "spider", "бетмен", "batman", "супермен", "superman", "marvel", "марвел", "месник", "капітан америка", "залізна людина", "халк", "флеш", "wonder woman", "диво-жінк"],
  princess: ["принцес", "ельз", "аврор", "білосніжк", "попелюшк", "рапунцел", "жасмін"],
  fairy: ["фея", "феї", "фею", "ангел", "янгол", "чарівниц"],
  animals: ["тварин", "кіт ", "кішк", "котик", "собак", "песик", "лев ", "лева", "зайч", "зайк", "лис ", "лисиц", "ведмід", "дракон", "динозавр", "мишк", "павучок", "жук", "бджіл", "метелик", "зебр", "пінгвін", "леопард", "тигр", "слон", "мавп"],
  disney: ["disney", "дісней", "холодне серце", "frozen", "moana", "ваяна", "мікі", "міккі", "міні маус", "тачки"],
  accessories: ["аксесуар", "корона", "маска", "капелюх", "обруч", "перука", "жезл", "паличка", "рукавич"],
};
const STEM_RE = Object.fromEntries(Object.entries(STEMS).map(([k, v]) => [k, new RegExp(WB + "(?:" + v.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "i")]));
function guessTags(text, tags) {
  const hay = " " + text.toLowerCase() + " ";
  const out = [];
  for (const t of tags) {
    const re = STEM_RE[t.key] ?? new RegExp(WB + t.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (re.test(hay)) out.push(t.key);
  }
  return out;
}
const COND_MAP = { "новий": "Новий", "ідеальний": "Ідеальний", "дуже хороший": "Дуже хороший", "хороший": "Хороший", "задовільний": "Задовільний" };
function formatSize(list) {
  const items = list.map((x) => String(x).trim()).filter(Boolean);
  if (!items.length) return "";
  if (items.some((x) => /one\s*size/i.test(x))) return "One size";
  const nums = items.filter((x) => /^\d{2,3}$/.test(x)).map(Number).sort((a, b) => a - b);
  if (nums.length === 1) return `${nums[0]} см`;
  if (nums.length >= 2) return nums[nums.length - 1] - nums[0] <= 12 ? `${nums[0]}–${nums[nums.length - 1]} см` : `${nums.join(", ")} см`;
  const letters = items.filter((x) => /^(xxs|xs|s|m|l|xl|xxl|xxxl)$/i.test(x));
  return letters.join(", ").toUpperCase();
}
// Вік у реальних оголошеннях: «на 6-7 рочків», «3-4р.», «на 1.5-2 роки», «9-12 місяців», «для дівчинки 7р»
export function extractAge(text) {
  const t = String(text || "").toLowerCase().replace(/\u00a0/g, " ");
  const N = "(\\d{1,2}(?:[.,]5)?)", L = "(?![а-яіїєґa-z])", BEFORE = "(?<![\\d.,])", SEP = "\\s*(?:[–—-]|до|по)\\s*";
  const YR = "(?:рочків|рочки|рочок|років|роки|року|рік|рр\\.?|р\\.|р)" + L, YRW = "(?:рочків|рочки|рочок|років|роки|року|рік)" + L, MO = "(?:місяців|місяці|місяць|міс\\.?)" + L;
  const n = (x) => parseFloat(String(x).replace(",", "."));
  let m = t.match(new RegExp(BEFORE + N + SEP + N + "\\s*" + MO));
  if (m) { const a = n(m[1]), b = n(m[2]); return a < b && b <= 36 ? { ageFrom: Math.floor(a / 12), ageTo: Math.max(1, Math.ceil(b / 12)) } : null; }
  m = t.match(new RegExp(BEFORE + N + SEP + N + "\\s*" + YR));
  if (m) { const a = n(m[1]), b = n(m[2]); return a >= 0 && a < b && b <= 18 ? { ageFrom: Math.floor(a), ageTo: Math.ceil(b) } : null; }   // «10–3 роки» чи «20–30 років» не вік
  m = t.match(new RegExp("(?:на|для|вік(?:ом)?|від)\\s+(?:[а-яіїєґ'’]+\\s+){0,2}" + N + "\\s*" + YR));
  if (m) { const a = n(m[1]); if (a >= 1 && a <= 18) return { ageFrom: Math.floor(a), ageTo: Math.ceil(a) }; }
  m = t.match(new RegExp(BEFORE + N + "\\s*" + YRW));
  if (m) { const a = n(m[1]); if (a >= 1 && a <= 18) return { ageFrom: Math.floor(a), ageTo: Math.ceil(a) }; }
  return null;
}
// «Довжина від бірки до низу 62 см», «довжина від плеча — 73 см», «Висота 85 см», «62 см (від бірки до низу)»
export function extractLength(text) {
  const t = String(text || "").replace(/\u00a0/g, " ");
  const num = "(\\d{2,3}(?:[.,]\\d)?)(?:\\s*[–—-]\\s*(\\d{2,3}(?:[.,]\\d)?))?";
  const sep = "[\\s:=\\-–—~≈•]*(?:приблизно|близько|біля)?\\s*";
  const tagRe = "від\\s+б[іи]рк[иі]\\s+до\\s+низу";
  const tries = [
    ["tag", new RegExp(tagRe + sep + num, "i")],
    ["tag", new RegExp(num + "\\s*(?:см|cm)?\\s*[(,\\-–—]?\\s*" + tagRe, "i")],
    ["shoulder", new RegExp("(?:довжина\\s+)?від\\s+плеч[аі]" + sep + num, "i")],
    ["height", new RegExp("висота(?:\\s+(?:виробу|костюма|сукні|плаття|комбінезона))?" + sep + num, "i")],
    ["length", new RegExp("довжина(?:\\s+(?:виробу|костюма|сукні|плаття|спідниці))?" + sep + num, "i")],
  ];
  for (const [kind, re] of tries) {
    const m = t.match(re);
    if (!m) continue;
    const value = normLength(m[2] ? `${m[1]}-${m[2]}` : m[1]);
    if (!value) continue;
    const near = t.slice(m.index, m.index + m[0].length + 40);
    return { length: value, lengthKind: kind !== "tag" && new RegExp(tagRe, "i").test(near) ? "tag" : kind };
  }
  return null;
}

export function parseShafaHtml(html, tags = DEFAULT_TAGS, pageUrl = "") {
  const warnings = [];
  const meta = metaMap(html);
  const lines = toLines(html);
  const idFrom = (u) => (String(u || "").match(/(\d{5,12})-[^/?#]*\/?(?:[?#].*)?$/) || [])[1];
  const shafaId = idFrom(meta["og:url"]) || idFrom(pageUrl) || idFrom((html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i) || [""])[0].match(/href=["']([^"']+)/)?.[1]);

  // назва
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  let name = h1 ? toLines(h1[1]).join(" ") : "";
  if (!name && meta["og:title"]) name = meta["og:title"].replace(/\s+за\s+[\d\s]+грн\s*\|\s*Шафа\s*$/i, "").trim();
  name = name.slice(0, 80);

  // ціна
  let price = 0;
  const pm = (meta["og:description"] || "").match(/Ціна:\s*([\d\s]+)\s*грн/i);
  if (pm) price = parseInt(pm[1].replace(/\s/g, ""), 10);
  if (!price) {
    const at = Math.max(0, lines.findIndex((l) => l === name));
    const pl = lines.slice(at, at + 8).map((l) => l.match(/^([\d\s]{2,8})\s*грн$/)).find(Boolean);
    if (pl) price = parseInt(pl[1].replace(/\s/g, ""), 10);
  }
  if (!price) warnings.push("Ціну не знайдено, впиши її вручну");

  // розмір: спершу мета-опис («Розміри: 98, 104.»), потім список у характеристиках
  let sizes = [];
  const sm = (meta["og:description"] || meta.description || "").match(/Розміри?:\s*([^.✓]+)/i);
  if (sm) sizes = sm[1].split(",").map((x) => x.trim()).filter(Boolean);
  if (!sizes.length) {
    const i = lines.findIndex((l) => /^Розмір:?$/i.test(l));
    if (i >= 0) for (const l of lines.slice(i + 1)) { if (/:$/.test(l) || /^(Категорії|Тематика|Тип|Бренд)/i.test(l)) break; sizes.push(l); }
  }
  let size = formatSize(sizes.filter((x) => !/^інший$/i.test(x)));
  if (!size) { size = "уточнити"; warnings.push("Розмір не вказано в числах, вкажи його вручну"); }

  // стан
  let condition = "Дуже хороший";
  const ci = lines.findIndex((l) => /^Стан:?/i.test(l));
  if (ci >= 0) {
    const raw = (lines[ci].replace(/^Стан:?\s*/i, "") || lines[ci + 1] || "").trim().toLowerCase();
    if (COND_MAP[raw]) condition = COND_MAP[raw];
    else warnings.push("Стан не розпізнано, перевір його");
  } else warnings.push("Стан не знайдено, перевір його");

  // опис
  let desc = "";
  const di = lines.findIndex((l) => /^Опис(\s+товару)?$/i.test(l));
  if (di >= 0) {
    const end = lines.findIndex((l, i) => i > di && /^Характеристики$/i.test(l));
    desc = lines.slice(di + 1, end > di ? end : di + 25).join("\n").trim();
  }
  const scanText = name + "\n" + desc;                       // вік і довжину шукаємо в повному тексті, ще до скорочення
  if (desc.length > 780) {
    const cut = desc.slice(0, 780);
    desc = cut.slice(0, Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "), cut.lastIndexOf(" "))).trim() + "…";
    warnings.push("Опис скорочено до 800 символів");
  }

  // для кого: з «хлібних крихт» (Дитячий одяг → Для хлопчиків/Для дівчаток)
  let audience = [];
  const bi = lines.findIndex((l, i) => /^Дитячий одяг$/i.test(l) && /^Для (хлопчиків|дівчаток|малюків)$/i.test(lines[i + 1] || ""));
  if (bi >= 0) {
    const g = lines[bi + 1].toLowerCase();
    if (g.includes("хлопчик")) audience = ["boys"];
    else if (g.includes("дівчат")) audience = ["girls"];
  }
  if (!audience.length) { audience = ["girls", "boys"]; warnings.push("Для кого костюм, не визначено: поставлено «обоє»"); }

  // хештеги: з теми, брендів, назви й опису
  const ti = lines.findIndex((l) => /^Тематика$/i.test(l));
  const themeText = ti >= 0 ? lines.slice(ti + 1, ti + 4).join(" ") : "";
  const tagKeys = guessTags([name, desc, themeText].join(" "), tags);

  // фото: ті, чий alt починається з назви (так ми не чіпаємо «Схожі товари»), головне фото першим
  const photos = [];
  const addPhoto = (id) => { if (id && !photos.includes(id) && photos.length < 10) photos.push(id); };
  if (name) {
    for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
      const a = attrsOf(m[0]);
      if (!(a.alt || "").trim().startsWith(name)) continue;
      const src = a["data-src"] || a.src || (a.srcset || "").split(",")[0].trim().split(" ")[0] || "";
      addPhoto((src.match(/shafastatic\.net\/(\d{6,14})/) || [])[1]);
    }
  }
  const mainId = ((meta["og:image"] || "").match(/shafastatic\.net\/(\d{6,14})/) || [])[1];
  if (mainId) { const i = photos.indexOf(mainId); if (i > 0) photos.splice(i, 1); if (i !== 0) photos.unshift(mainId); }
  if (!photos.length) warnings.push("Фото не знайдено на сторінці");

  const age = extractAge(scanText), len = extractLength(scanText);
  return { name, price, size, condition, desc, audience, tags: tagKeys, photos, ageFrom: age?.ageFrom ?? null, ageTo: age?.ageTo ?? null, length: len?.length ?? "", lengthKind: len?.lengthKind ?? "", src: shafaId ? `shafa:${shafaId}` : "", url: pageUrl || meta["og:url"] || "", warnings };
}

const UA = "Mozilla/5.0 (compatible; AliceLandImport/1.0)";

/* ---------- Автоперевірка Shafa (двічі на добу) ---------- */
// Що робить: відкриває профіль на Shafa, збирає посилання на товари, перевіряє на Shafa кожен
// імпортований лот (ціна, продано чи видалено) і, якщо дозволено, оновлює сайт.
// Нові товари на Shafa лише знаходить: фото для них стискає браузер адмінки, тому їх додають кнопкою «Імпортувати нові».
// Стан зберігається в Blobs, тож перевірку можна продовжити з місця зупинки (ліміт часу однієї функції обмежений).
const SYNC_DEFAULTS = { enabled: true, apply: false, prices: true, sold: true, findNew: true, profileUrl: "https://shafa.ua/uk/member/alice_lenskaya" };
const SYNC_MIN_GAP_MS = 6 * 3600e3;
const userErr = (msg) => Object.assign(new Error(msg), { userMessage: msg });

export function sanitizeSyncConfig(raw) {
  const bool = (v, d) => (typeof v === "boolean" ? v : d);
  let profileUrl = SYNC_DEFAULTS.profileUrl;
  try {
    const u = new URL(String(raw?.profileUrl ?? "").trim());
    if (u.protocol === "https:" && /^(www\.)?shafa\.ua$/i.test(u.hostname) && /\/member\/[^/]+/.test(u.pathname)) profileUrl = u.origin + u.pathname.replace(/\/+$/, "");
  } catch { /* лишаємо типове посилання */ }
  return {
    enabled: bool(raw?.enabled, SYNC_DEFAULTS.enabled), apply: bool(raw?.apply, SYNC_DEFAULTS.apply),
    prices: bool(raw?.prices, SYNC_DEFAULTS.prices), sold: bool(raw?.sold, SYNC_DEFAULTS.sold),
    findNew: bool(raw?.findNew, SYNC_DEFAULTS.findNew), profileUrl,
  };
}

// Усі посилання на товари зі сторінки списку: /uk/item/222163643-назва або /uk/kids/…/62850767-назва
export function extractItemLinks(html, base = "https://shafa.ua") {
  const out = new Map();
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attrsOf(m[0]).href;
    if (!href) continue;
    let u;
    try { u = new URL(href, base); } catch { continue; }
    if (!/^(www\.)?shafa\.ua$/i.test(u.hostname) || /\/(member|blog|shop|brand)\//.test(u.pathname)) continue;
    const id = (u.pathname.match(/\/(\d{6,12})-[^/]+\/?$/) || [])[1];
    if (id && !out.has(id)) out.set(id, u.origin + u.pathname);
  }
  return out;
}

// Чи позначено товар проданим або недоступним (шукаємо лише біля заголовка, щоб не плутати зі статистикою продавця)
export function detectSold(html) {
  const meta = metaMap(html);
  const av = String(meta["og:availability"] || meta["product:availability"] || meta.availability || "").toLowerCase();
  if (/out\s*of\s*stock|outofstock|oos|sold|немає|продан/.test(av)) return true;
  if (/in\s*stock|instock|в наявності/.test(av)) return false;
  const lines = toLines(html);
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const title = h1 ? toLines(h1[1]).join(" ") : "";
  const at = Math.max(0, lines.findIndex((l) => l === title));
  return lines.slice(Math.max(0, at - 4), at + 30).some((l) => /^(товар продано|продано|оголошення неактуальне|товар недоступний|немає в наявності|знято з продажу|товар більше не продається)$/i.test(l));
}

// Лише карнавальні костюми: у «Категоріях» товару має бути «Карнавальні» (в профілі є й інший одяг)
export function isCarnival(html) {
  const lines = toLines(html);
  const i = lines.findIndex((l) => /^Категорії:?/i.test(l));
  if (i < 0) return false;
  const block = [lines[i].replace(/^Категорії:?/i, "")];
  for (const l of lines.slice(i + 1, i + 8)) { if (/^(Тематика|Тип|Бренд|Продавець|Колір|Розмір|Стан)/i.test(l)) break; block.push(l); }
  return /карнавальн/i.test(block.join(" "));
}

function classifyItem(html, finalUrl, sid) {
  const d = parseShafaHtml(html, [], finalUrl);
  if (!d.name) return { kind: "unparsed" };
  if (d.src && d.src !== `shafa:${sid}`) return { kind: "gone" };          // адреса веде на інший товар
  return { kind: detectSold(html) ? "sold" : "ok", price: d.price };
}

const kyiv = (ms) => new Date(ms).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
