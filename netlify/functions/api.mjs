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
export function createSync({
  getStore: makeStore = getStore, env = defaultEnv,
  shafaFetch = (...a) => globalThis.fetch(...a), tgFetch = (...a) => globalThis.fetch(...a),
  now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const db = () => makeStore({ name: "aliceland", consistency: "strong" });
  const getJSON = (k) => db().get(k, { type: "json" });
  const loadCfg = async () => sanitizeSyncConfig((await getJSON("syncconfig")) || {});
  const loadState = async () => (await getJSON("syncstate")) || { cycle: null, last: null };
  const saveState = (st) => db().setJSON("syncstate", st);
  const loadProducts = async () => { const d = await getJSON("products"); return d && Array.isArray(d.items) ? d : { items: [], next: 1 }; };

  async function getHtml(url) {
    try {
      const res = await shafaFetch(url, { headers: { "user-agent": UA, "accept-language": "uk,en;q=0.5", accept: "text/html" }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) return { status: res.status };
      return { status: 200, html: await res.text(), url: res.url || url };
    } catch { return { status: 0 }; }
  }

  async function notify(text) {
    const token = env("TG_BOT_TOKEN"), chat = env("TG_CHAT_ID");
    if (!token || !chat) return false;
    try {
      const r = await tgFetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: text.slice(0, 3500) }) });
      return r.ok;
    } catch { return false; }
  }

  async function phaseList(c, cfg, st, deadline) {
    while (c.page <= 40 && now() < deadline && !c.listDone) {
      const url = c.page === 1 ? cfg.profileUrl : `${cfg.profileUrl}?page=${c.page}`;
      const r = await getHtml(url);
      if (r.status !== 200) {
        if (c.page === 1) throw userErr(`Не вдалося відкрити профіль на Shafa (${r.status ? "код " + r.status : "немає відповіді"})`);
        c.listDone = true; break;
      }
      let added = 0;
      for (const [id, u] of extractItemLinks(r.html)) if (!(id in c.found)) { c.found[id] = u; added++; }
      if (c.page === 1 && !added) throw userErr("На сторінці профілю не знайдено товарів. Можливо, Shafa змінила верстку або віддала порожню сторінку");
      if (!added) c.listDone = true; else c.page++;
      await saveState(st);
      await sleep(600);
    }
    if (c.page > 40) c.listDone = true;
    if (!c.listDone) return;                                          // продовжимо наступним запуском
    const { items } = await loadProducts();
    c.queue = items.filter((p) => p.src && (p.status === "available" || p.status === "reserved")).map((p) => p.id);
    c.phase = "check"; c.idx = 0;
  }

  async function phaseCheck(c, cfg, st, deadline) {
    const data = await loadProducts();
    while (c.idx < c.queue.length && now() < deadline) {
      const p = data.items.find((x) => x.id === c.queue[c.idx]);
      c.idx++;
      if (!p) continue;
      const sid = p.src.slice(6);
      const r = await getHtml(c.found[sid] || p.srcUrl || `https://shafa.ua/uk/item/${sid}`);
      c.checked++;
      if (r.status === 404 || r.status === 410) { c.consecutiveErrors = 0; c.changes.push({ id: p.id, kind: "sold", why: "сторінки на Shafa більше немає" }); }
      else if (r.status !== 200) {
        c.errors++; c.consecutiveErrors++;
        if (c.consecutiveErrors >= 6) throw userErr("Shafa не віддає сторінки товарів (забагато збоїв поспіль)");
      } else {
        c.consecutiveErrors = 0;
        const cl = classifyItem(r.html, r.url, sid);
        if (cl.kind === "unparsed") c.errors++;
        else if (cl.kind === "gone") c.changes.push({ id: p.id, kind: "sold", why: "адреса на Shafa веде на інший товар" });
        else if (cl.kind === "sold") c.changes.push({ id: p.id, kind: "sold", why: "позначено проданим на Shafa" });
        else if (cl.price) {
          if (!p.srcPrice) c.baselines.push({ id: p.id, price: cl.price });
          else if (cl.price !== p.srcPrice) c.changes.push({ id: p.id, kind: "price", from: p.srcPrice, to: cl.price, siteDiffers: p.price !== p.srcPrice });
        }
      }
      if (c.idx % 5 === 0) await saveState(st);
      await sleep(500);
    }
    if (c.idx >= c.queue.length) c.phase = cfg.findNew ? "import" : "finish";
  }

  // Нові костюми з профілю Shafa потрапляють у чернетки самі; фото підтягнеться, коли власниця додасть чернетку на сайт
  async function phaseImport(c, cfg, st, deadline) {
    if (!c.iq) {
      const data = await loadProducts();
      const known = new Set(data.items.map((p) => (p.src || "").slice(6)).filter(Boolean));
      const ignored = new Set((await getJSON("ignored")) || []);
      c.iq = Object.entries(c.found).filter(([id]) => !known.has(id) && !ignored.has(id)).map(([, u]) => u).slice(0, 40);
      c.ii = 0; c.imported = []; c.skipped = 0; c.ierr = 0;
    }
    if (c.ii < c.iq.length && now() < deadline) {
      const cfgTags = await getJSON("config");
      const tags = cfgTags && Array.isArray(cfgTags.tags) ? sanitizeTags(cfgTags.tags) : DEFAULT_TAGS;
      while (c.ii < c.iq.length && now() < deadline) {
        const r = await getHtml(c.iq[c.ii++]);
        await sleep(500);
        if (r.status !== 200) { c.ierr++; continue; }
        const d = parseShafaHtml(r.html, tags, r.url);
        if (!d.name || !d.src || !isCarnival(r.html) || detectSold(r.html)) { c.skipped++; continue; }
        const data = await loadProducts();                                 // свіжий каталог: не затираємо правки власниці
        if (data.items.some((p) => p.src === d.src)) continue;
        const parsed = normalize({
          name: d.name, audience: d.audience, tags: d.tags, size: d.size, condition: d.condition, price: d.price || 0, desc: d.desc, status: "hidden", images: [],
          src: d.src, srcUrl: d.url, srcPrice: d.price || undefined, srcPhotos: d.photos,
          ageFrom: d.ageFrom ?? undefined, ageTo: d.ageTo ?? undefined, length: d.length || undefined, lengthKind: d.lengthKind || undefined,
        }, tags.map((t) => t.key));
        if (parsed.error) { c.skipped++; continue; }
        const id = formatId(Math.max(Number(data.next) || 1, data.items.reduce((m, p) => Math.max(m, artNumber(p.id)), 0) + 1));
        const stamp = new Date(now()).toISOString();
        data.items.unshift({ ...parsed.value, id, createdAt: stamp, updatedAt: stamp, auto: true });
        data.next = artNumber(id) + 1;
        await db().setJSON("products", data);
        c.imported.push({ id, name: d.name });
      }
    }
    if (c.ii >= c.iq.length) c.phase = "finish";
  }

  async function finish(c, cfg, st) {
    const data = await loadProducts();
    const byId = new Map(data.items.map((p) => [p.id, p]));
    const notes = [];
    const soldCh = c.changes.filter((x) => x.kind === "sold");
    const soldBlocked = soldCh.length > Math.max(3, Math.ceil(0.25 * c.checked));
    if (soldBlocked) notes.push(`Забагато проданих за раз (${soldCh.length} з ${c.checked}). Схоже на збій, тому нічого не знято`);
    const tooManyErrors = c.checked >= 4 && c.errors / c.checked > 0.5;
    if (tooManyErrors) notes.push("Забагато помилок читання сторінок, зміни не застосовано");
    let applied = 0, touched = false;
    for (const b of c.baselines) { const p = byId.get(b.id); if (p && !p.srcPrice) { p.srcPrice = b.price; touched = true; } }
    if (cfg.apply && !tooManyErrors) {
      const stamp = new Date(now()).toISOString();
      for (const ch of c.changes) {
        const p = byId.get(ch.id);
        if (!p) continue;
        if (ch.kind === "price" && cfg.prices) {
          const ratio = ch.to / ch.from;
          if (ratio < 0.3 || ratio > 3) { ch.skipped = "різниця надто велика"; continue; }
          if (ch.siteDiffers) { ch.skipped = "на сайті ціна відрізняється від Shafa, не чіпаю"; p.srcPrice = ch.to; touched = true; continue; }
          p.price = ch.to; p.srcPrice = ch.to; p.updatedAt = stamp;
          if (p.oldPrice && p.oldPrice <= p.price) p.oldPrice = null;
          ch.applied = true; applied++; touched = true;
        } else if (ch.kind === "sold" && cfg.sold && !soldBlocked && (p.status === "available" || p.status === "reserved")) {
          p.status = "sold"; p.soldAt = stamp; p.updatedAt = stamp; ch.applied = true; applied++; touched = true;
        }
      }
    }
    if (touched) await db().setJSON("products", data);
    const known = new Set(data.items.map((p) => (p.src || "").slice(6)).filter(Boolean));
    const newLinks = cfg.findNew && !c.iq ? Object.entries(c.found).filter(([id]) => !known.has(id)).map(([, u]) => u).slice(0, 60) : [];
    const report = {
      at: now(), startedAt: c.startedAt, ok: true, listed: Object.keys(c.found).length, checked: c.checked, errors: c.errors,
      applied, mode: cfg.apply ? "apply" : "report", notes, newLinks,
      imported: c.imported || [], skippedNew: c.skipped || 0, importErrors: c.ierr || 0,
      changes: c.changes.map((x) => ({ ...x, name: byId.get(x.id)?.name || "" })).slice(0, 100),
    };
    report.sig = JSON.stringify([report.changes.map((x) => [x.id, x.kind, x.to ?? 0, x.applied ? 1 : 0]), newLinks.length, notes.length, applied, report.mode]);
    const same = st.last?.sig === report.sig;
    st.last = report; st.cycle = null;
    await saveState(st);
    if (((report.changes.length || newLinks.length || notes.length) && !same) || report.imported.length) await notify(buildMessage(report));
    return report;
  }

  function buildMessage(r) {
    const price = r.changes.filter((x) => x.kind === "price"), sold = r.changes.filter((x) => x.kind === "sold");
    const L = ["🔄 Перевірка Shafa завершена"];
    if (price.length) L.push(`💰 Змінилась ціна: ${price.length}` + price.slice(0, 5).map((x) => `\n  ${x.name || x.id}: ${x.from} → ${x.to} грн${x.applied ? " (оновлено)" : x.skipped ? ` (${x.skipped})` : ""}`).join(""));
    if (sold.length) L.push(`🚫 Продано або знято на Shafa: ${sold.length}` + sold.slice(0, 5).map((x) => `\n  ${x.name || x.id}${x.applied ? " (знято з сайту)" : ""}`).join(""));
    if (r.newLinks.length) L.push(`🆕 Нових товарів на Shafa: ${r.newLinks.length}. Адмінка → Додати → Імпорт`);
    if (r.imported?.length) L.push(`📝 Нових костюмів у чернетках: ${r.imported.length}` + r.imported.slice(0, 5).map((x) => `\n  ${x.name}`).join("") + "\nАдмінка → Каталог → Чернетки: познач, які додати на сайт");
    for (const n of r.notes) L.push("⚠️ " + n);
    L.push(r.mode === "apply" ? "Зміни застосовано автоматично." : "Режим «лише повідомляти»: на сайті нічого не змінено.");
    return L.join("\n");
  }

  async function abort(st, message) {
    const at = now();
    st.last = { at, startedAt: st.cycle?.startedAt || at, ok: false, error: message, listed: 0, checked: st.cycle?.checked || 0, errors: st.cycle?.errors || 0, applied: 0, mode: "report", notes: [], newLinks: [], changes: [], sig: "err:" + message };
    const same = st.last.sig === (st.prevSig || "");
    st.prevSig = st.last.sig;
    st.cycle = null;
    await saveState(st);
    if (!same) await notify("⚠️ Перевірка Shafa не вдалася: " + message);
  }

  // Один запуск: працює, доки не вийде бюджет часу, і лишає стан для продовження
  async function run({ budgetMs = 24000, force = false } = {}) {
    const cfg = await loadCfg();
    if (!cfg.enabled && !force) return { skipped: "disabled" };
    const st = await loadState();
    if (!st.cycle) {
      if (!force && st.last && now() - st.last.at < SYNC_MIN_GAP_MS) return { skipped: "recent" };
      st.cycle = { startedAt: now(), phase: "list", page: 1, found: {}, listDone: false, queue: [], idx: 0, checked: 0, errors: 0, consecutiveErrors: 0, changes: [], baselines: [], lockUntil: 0 };
    }
    const c = st.cycle;
    if (c.lockUntil > now()) return { skipped: "busy" };
    c.lockUntil = now() + budgetMs + 20000;
    await saveState(st);
    const deadline = now() + budgetMs;
    try {
      if (c.phase === "list") await phaseList(c, cfg, st, deadline);
      if (c.phase === "check") await phaseCheck(c, cfg, st, deadline);
      if (c.phase === "import") await phaseImport(c, cfg, st, deadline);
      if (c.phase === "finish") { await finish(c, cfg, st); return { done: true, report: st.last }; }
      c.lockUntil = 0;
      await saveState(st);
      return { done: false, progress: progressOf(c) };
    } catch (e) {
      await abort(st, e.userMessage || "Збій перевірки: " + (e.message || e));
      return { done: true, report: st.last };
    }
  }

  const progressOf = (c) => ({ phase: c.phase, page: c.page, found: Object.keys(c.found).length, idx: c.idx, total: c.queue.length, startedAt: c.startedAt });
  async function status() {
    const [config, st] = await Promise.all([loadCfg(), loadState()]);
    return { config, running: !!st.cycle, progress: st.cycle ? progressOf(st.cycle) : null, last: st.last || null };
  }
  const saveConfig = (cfg) => db().setJSON("syncconfig", cfg);
  return { run, status, saveConfig, loadCfg };
}

export const sync = createSync();
export const syncKey = () => createHash("sha256").update("sync:" + String(defaultEnv("ADMIN_PASSWORD") || "")).digest("hex");


export function createHandler({
  getStore: makeStore = getStore, env = defaultEnv,
  fetchImpl = (...a) => globalThis.fetch(...a), selfFetch = (...a) => globalThis.fetch(...a), tgFetch = (...a) => globalThis.fetch(...a),
  now = () => Date.now(), sleep: sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const syncEngine = createSync({ getStore: makeStore, env, shafaFetch: fetchImpl, tgFetch, now, sleep: sleepImpl });
  const keyForSync = () => createHash("sha256").update("sync:" + String(env("ADMIN_PASSWORD") || "")).digest("hex");
  // Каталог читаємо з "сильною" узгодженістю, щоб після збереження одразу бачити зміни.
  const db = () => makeStore({ name: "aliceland", consistency: "strong" });
  const img = () => makeStore({ name: "aliceland-img" });

  async function load() {
    const data = await db().get("products", { type: "json" });
    if (data && Array.isArray(data.items)) return data;
    return { items: [], next: 1 };
  }

  let pubCache = null;                      // готовий JSON каталогу для сайту: не розбираємо й не збираємо 500 лотів на кожного відвідувача
  const invalidate = () => { pubCache = null; };
  const save = (data) => { invalidate(); return db().setJSON("products", data); };

  async function loadTags() {
    const cfg = await db().get("config", { type: "json" });
    return cfg && Array.isArray(cfg.tags) ? sanitizeTags(cfg.tags) : DEFAULT_TAGS;
  }
  const ordersDb = () => makeStore({ name: "aliceland-orders", consistency: "strong" });
  const limiter = createLimiter(db, now);
  async function notifyTelegram(text) {
    const token = env("TG_BOT_TOKEN"), chat = env("TG_CHAT_ID");
    if (!token || !chat) return false;
    try {
      const r = await tgFetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }), signal: AbortSignal.timeout(6000) });
      return r.ok;
    } catch { return false; }
  }
  async function loadOrders(limit) {
    const st = ordersDb(), keys = [];
    for (const prefix of orderPrefixes(now())) {
      const r = st.list({ prefix, paginate: true });
      if (r && typeof r[Symbol.asyncIterator] === "function") { for await (const page of r) for (const b of page.blobs) keys.push(b.key); }
      else { const page = await r; for (const b of (page && page.blobs) || []) keys.push(b.key); }
    }
    keys.sort().reverse();
    return (await Promise.all(keys.slice(0, limit).map((k) => st.get(k, { type: "json" })))).filter(Boolean);
  }
  async function loadSite() {
    const raw = await db().get("site", { type: "json" });
    const s = raw ? sanitizeSite(raw) : null;
    return s && s.value ? s.value : structuredClone(DEFAULT_SITE);
  }
  const pubTags = (tags) => tags.map(({ key, label, title, collection }) => ({ key, label, title, collection }));

  // Сторінку товару Shafa тягнемо лише з shafa.ua і лише за посиланням, яке вставила власниця
  async function fetchShafaPage(raw) {
    let u;
    try { u = new URL(String(raw || "").trim()); } catch { return { status: 400, error: { error: "Це не схоже на посилання" } }; }
    if (u.protocol !== "https:" || !/^(www\.)?shafa\.ua$/i.test(u.hostname)) return { status: 400, error: { error: "Потрібне посилання на товар із shafa.ua" } };
    if (!/\d{5,12}-[^/]*\/?$/.test(u.pathname)) return { status: 400, error: { error: "Це не сторінка товару. Посилання має бути на кшталт shafa.ua/uk/item/…" } };
    let res;
    try {
      res = await fetchImpl(u.href, { headers: { "user-agent": UA, "accept-language": "uk,en;q=0.5", accept: "text/html" }, signal: AbortSignal.timeout(15000) });
    } catch {
      return { status: 504, error: { error: "Shafa не відповіла. Спробуй за хвилину", code: "timeout" } };
    }
    if (res.status === 404) return { status: 404, error: { error: "Сторінку не знайдено на Shafa. Товар могли видалити", code: "notfound" } };
    if (!res.ok) return { status: 502, error: { error: `Shafa не віддала сторінку серверу (код ${res.status}). Відкрий товар на Shafa, натисни Ctrl+U, скопіюй весь код і встав у поле нижче`, code: "blocked" } };
    let host = "";
    try { host = new URL(res.url || u.href).hostname; } catch { /* лишаємо порожнім */ }
    if (!/(^|\.)shafa\.ua$/i.test(host)) return { status: 502, error: { error: "Shafa перенаправила на іншу адресу", code: "redirect" } };
    const html = await res.text();
    if (html.length > 3_000_000) return { status: 413, error: { error: "Сторінка завелика" } };
    return { html, url: res.url || u.href };
  }

  function nextId(data) {
    const maxUsed = data.items.reduce((m, p) => Math.max(m, artNumber(p.id)), 0);
    return formatId(Math.max(Number(data.next) || 1, maxUsed + 1));
  }

  async function ignoreSrc(src) {
    const sid = String(src).slice(6);
    const cur = (await db().get("ignored", { type: "json" })) || [];
    if (!cur.includes(sid)) { cur.push(sid); await db().setJSON("ignored", cur.slice(-3000)); }
  }

  async function firstMissingImage(ids) {
    for (let i = 0; i < ids.length; i++) {
      const meta = await img().getMetadata(ids[i]);
      if (!meta) return i;
    }
    return -1;
  }

  async function removeImages(ids) {
    await Promise.allSettled(ids.flatMap((id) => [img().delete(id), img().delete(id + "s")]));
  }

  function authorize(req) {
    const expected = env("ADMIN_PASSWORD");
    if (!expected) return "not-configured";
    // Браузер надсилає пароль закодованим: у заголовках не можна кирилицю й емодзі
    let given = req.headers.get("x-admin-key") || "";
    try { given = decodeURIComponent(given); } catch { /* лишаємо як є */ }
    const a = createHash("sha256").update(given).digest();
    const b = createHash("sha256").update(String(expected)).digest();
    return timingSafeEqual(a, b) ? "ok" : "bad";
  }

  const counts = (items) =>
    STATUSES.reduce((acc, s) => ({ ...acc, [s]: items.filter((p) => p.status === s).length }), {});

  async function readBody(req) {
    try {
      const body = await req.json();
      return body && typeof body === "object" ? body : null;
    } catch {
      return null;
    }
  }

  async function route(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();

    // ---------- Публічне ----------
    if (method === "GET" && path === "/api/site") return json(deriveSite(await loadSite()), 200, PUBLIC_CACHE(60, 300));

    if (method === "GET" && path === "/api/products") {
      const t = now();
      if (!pubCache || t - pubCache.at > 5000) {
        const data = await load();
        const items = data.items.filter((p) => p.status === "available" || p.status === "reserved").map(toPublic);
        pubCache = { at: t, body: JSON.stringify({ items, total: items.length, tags: pubTags(await loadTags()) }) };
      }
      return new Response(pubCache.body, { status: 200, headers: { "content-type": "application/json; charset=utf-8", ...PUBLIC_CACHE(30, 120) } });
    }

    if (method === "POST" && path === "/api/order") {
      const body = await readBody(req);
      const ip = clientIp(req);
      if (!(await limiter.hit("order", ip, ORDER_LIMIT)).ok) return json({ error: "Забагато спроб поспіль. Зателефонуй нам, будь ласка", code: "rate" }, 429);
      const pid = String(body?.productId || "").toUpperCase();
      const product = ART_ID.test(pid) ? (await load()).items.find((p) => p.id === pid) || null : null;
      const v = validateOrder(body, product);
      if (v.silent) return json({ ok: true });
      if (v.error) return json({ error: v.error }, v.status);
      const t = now();
      const key = newOrderKey(t, Math.random());
      const rec = { key, number: orderNumber(key), createdAt: new Date(t).toISOString(), status: "new", ...v.order, ipHash: ipKey(ip) };
      await ordersDb().setJSON(key, rec);
      await notifyTelegram(telegramText(rec, (await loadSite()).seo.siteUrl || url.origin));    // збій Telegram не втрачає замовлення
      return json({ ok: true, number: rec.number });
    }

    const imgMatch = path.match(/^\/img\/([a-f0-9]{16}s?)$/);
    if ((method === "GET" || method === "HEAD") && imgMatch) {
      const bytes = await img().get(imgMatch[1], { type: "arrayBuffer" });
      if (!bytes) return new Response("Не знайдено", { status: 404, headers: { "cache-control": "no-store" } });
      return new Response(method === "HEAD" ? null : bytes, {
        headers: {
          "content-type": "image/jpeg",
          "cache-control": "public, max-age=31536000, immutable",
          "netlify-cdn-cache-control": "public, max-age=31536000, immutable, durable",
          "x-content-type-options": "nosniff",
        },
      });
    }

    // ---------- Адмінка ----------
    if (path.startsWith("/api/admin/")) {
      const ip = clientIp(req);
      const lockState = await limiter.state("admin", ip);
      if (lockState && now() - lockState.first <= ADMIN_LOCK.windowMs && lockState.count >= ADMIN_LOCK.max) {
        return json({ error: "Забагато невдалих спроб. Спробуй за 15 хвилин", code: "locked" }, 429);
      }
      const auth = authorize(req);
      if (auth === "not-configured") {
        return json({ error: "У Netlify ще не задано змінну ADMIN_PASSWORD", code: "no_password" }, 503);
      }
      if (auth === "bad") {
        await limiter.hit("admin", ip, ADMIN_LOCK);
        await sleepImpl(800); // гальмуємо підбір пароля
        return json({ error: "Невірний пароль", code: "bad_password" }, 401);
      }

      if (lockState) await limiter.clear("admin", ip);       // правильний пароль знімає лічильник невдач

      if (method === "GET" && path === "/api/admin/products") {
        const data = await load();
        return json({ items: data.items, counts: counts(data.items), nextId: nextId(data), tags: pubTags(await loadTags()), apiVersion: 7 });
      }

      if (method === "GET" && path === "/api/admin/orders") {
        const items = await loadOrders(100);
        const c = { new: 0, work: 0, done: 0, cancel: 0 };
        for (const o of items) if (o.status in c) c[o.status]++;
        return json({ items, counts: c });
      }

      const om = path.match(/^\/api\/admin\/order\/([\w-]+)$/);
      if (om && method === "PATCH") {
        if (!ORDER_KEY_RE.test(om[1])) return json({ error: "Некоректний номер замовлення" }, 400);
        const body = await readBody(req);
        if (!body || !ORDER_STATUSES.includes(body.status)) return json({ error: "Некоректний статус" }, 400);
        const rec = await ordersDb().get(om[1], { type: "json" });
        if (!rec) return json({ error: "Замовлення не знайдено" }, 404);
        rec.status = body.status;
        rec.updatedAt = new Date(now()).toISOString();
        await ordersDb().setJSON(om[1], rec);
        return json({ item: rec });
      }

      if (method === "GET" && path === "/api/admin/site") {
        return json({ site: await loadSite(), defaults: DEFAULT_SITE, origin: url.origin });
      }

      if (method === "PUT" && path === "/api/admin/site") {
        const body = await readBody(req);
        if (!body) return json({ error: "Некоректні дані" }, 400);
        const parsed = sanitizeSite(body);
        if (parsed.error) return json({ error: parsed.error }, 400);
        await db().setJSON("site", parsed.value);
        return json({ site: parsed.value });
      }

      if (method === "GET" && path === "/api/admin/sync") return json(await syncEngine.status());

      if (method === "PUT" && path === "/api/admin/sync") {
        const body = await readBody(req);
        if (!body) return json({ error: "Некоректні дані" }, 400);
        const config = sanitizeSyncConfig(body);
        await syncEngine.saveConfig(config);
        return json({ config });
      }

      if (method === "POST" && path === "/api/admin/sync/run") {
        if (url.searchParams.get("slice") !== "1") {
          try {
            const r = await selfFetch(url.origin + "/.netlify/functions/sync-background", { method: "POST", headers: { "x-sync-key": keyForSync(), "x-sync-force": "1" } });
            if (r.ok || r.status === 202) return json({ mode: "background" }, 202);
          } catch { /* фонова функція недоступна: працюємо частинами */ }
        }
        const r = await syncEngine.run({ budgetMs: 20000, force: true });
        return json({ mode: "slice", ...r });
      }

      if (method === "PUT" && path === "/api/admin/tags") {
        const body = await readBody(req);
        if (!body || !Array.isArray(body.tags)) return json({ error: "Некоректні дані" }, 400);
        const tags = sanitizeTags(body.tags);
        await db().setJSON("config", { tags });
        invalidate();
        return json({ tags: pubTags(tags) });
      }

      if (method === "POST" && path === "/api/admin/import") {
        const body = await readBody(req);
        if (!body) return json({ error: "Некоректні дані" }, 400);
        let html = typeof body.html === "string" ? body.html : "";
        let pageUrl = typeof body.url === "string" ? body.url.trim() : "";
        if (!html) {
          const r = await fetchShafaPage(pageUrl);
          if (r.error) return json(r.error, r.status);
          html = r.html;
          pageUrl = r.url;
        } else if (html.length > 3_000_000) {
          return json({ error: "Код сторінки завеликий" }, 413);
        }
        const draft = parseShafaHtml(html, await loadTags(), pageUrl);
        if (!draft.name) return json({ error: "Не вдалося розпізнати сторінку. Це точно товар на Shafa?", code: "unparsed" }, 422);
        return json({ draft });
      }

      if (method === "GET" && path === "/api/admin/import-img") {
        const id = url.searchParams.get("id") || "";
        if (!/^\d{6,14}$/.test(id)) return json({ error: "Некоректний номер фото" }, 400);
        let r;
        try {
          r = await fetchImpl(`https://images.shafastatic.net/${id}`, { headers: { "user-agent": UA, accept: "image/jpeg,image/png,image/webp,image/*;q=0.8" }, signal: AbortSignal.timeout(20000) });
        } catch {
          return json({ error: "Фото не завантажилось із Shafa" }, 504);
        }
        if (!r.ok) return json({ error: `Фото недоступне на Shafa (код ${r.status})` }, 502);
        const buf = await r.arrayBuffer();
        if (buf.byteLength > 12 * 1024 * 1024) return json({ error: "Фото завелике" }, 413);
        return new Response(buf, { headers: { "content-type": r.headers.get("content-type") || "image/jpeg", "cache-control": "no-store" } });
      }

      const putImg = path.match(/^\/api\/admin\/img\/([a-f0-9]{16}s?)$/);
      if (method === "PUT" && putImg) {
        const id = putImg[1];
        const bytes = await req.arrayBuffer();
        const head = new Uint8Array(bytes.slice(0, 3));
        const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
        if (!isJpeg) return json({ error: "Це не JPEG-фото" }, 400);
        const limit = id.endsWith("s") ? MAX_SMALL_BYTES : MAX_FULL_BYTES;
        if (bytes.byteLength > limit) return json({ error: "Фото завелике" }, 413);
        await img().set(id, bytes, { metadata: { type: "image/jpeg" } });
        return json({ ok: true, id });
      }

      if (method === "POST" && path === "/api/admin/product") {
        const body = await readBody(req);
        if (!body) return json({ error: "Некоректні дані" }, 400);
        const tagKeys = (await loadTags()).map((t) => t.key);
        const parsed = normalize(body, tagKeys);
        if (parsed.error) return json({ error: parsed.error }, 400);
        const missing = await firstMissingImage(parsed.value.images);
        if (missing >= 0) return json({ error: `Фото №${missing + 1} не завантажилось. Додай його ще раз` }, 400);

        const data = await load();
        if (parsed.value.src) {
          const twin = data.items.find((p) => p.src === parsed.value.src);
          if (twin) return json({ error: `Цей товар уже імпортовано (${twin.id})`, code: "dup", id: twin.id }, 409);
        }
        const id = nextId(data);
        const now = new Date().toISOString();
        const item = { ...parsed.value, id, createdAt: now, updatedAt: now };
        if (item.status === "sold") item.soldAt = now;
        data.items.unshift(item);
        data.next = artNumber(id) + 1;
        await save(data);
        return json({ item }, 201);
      }

      const one = path.match(/^\/api\/admin\/product\/([^/]+)$/);
      if (one && ART_ID.test(one[1])) {
        const id = one[1];
        const data = await load();
        const idx = data.items.findIndex((p) => p.id === id);
        if (idx < 0) return json({ error: "Лот не знайдено" }, 404);
        const existing = data.items[idx];

        if (method === "PATCH") {
          const body = await readBody(req);
          if (!body) return json({ error: "Некоректні дані" }, 400);
          const patch = {};
          for (const key of EDITABLE) if (key in body) patch[key] = body[key];
          const parsed = normalize({ ...existing, ...patch }, (await loadTags()).map((t) => t.key));
          if (parsed.error) return json({ error: parsed.error }, 400);

          const added = parsed.value.images.filter((x) => !existing.images.includes(x));
          const missing = await firstMissingImage(added);
          if (missing >= 0) return json({ error: "Нове фото не завантажилось. Додай його ще раз" }, 400);

          const now = new Date().toISOString();
          const item = { ...existing, ...parsed.value, updatedAt: now };
          for (const k of ["ageFrom", "ageTo", "length", "lengthKind", "srcPhotos"]) if (!(k in parsed.value)) delete item[k];   // порожнє поле = прибрати
          if (item.status === "sold") item.soldAt = existing.status === "sold" ? existing.soldAt || now : now;
          else delete item.soldAt;
          data.items[idx] = item;
          await save(data);
          await removeImages(existing.images.filter((x) => !item.images.includes(x)));
          return json({ item });
        }

        if (method === "DELETE") {
          data.items.splice(idx, 1);
          await save(data);
          if (existing.src) await ignoreSrc(existing.src);       // видалений лот автоперевірка більше не пропонує
          await removeImages(existing.images);
          return json({ ok: true });
        }
      }

      return json({ error: "Невідома адреса" }, 404);
    }

    return json({ error: "Невідома адреса" }, 404);
  }

  return async function handler(req) {
    try {
      return await route(req);
    } catch (err) {
      console.error("api error:", err);
      return json({ error: "Помилка сервера. Спробуй ще раз за хвилину" }, 500);
    }
  };
}

export default createHandler();

export const config = { path: ["/api/*", "/img/*"] };
const kyiv = (ms) => new Date(ms).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
