// AliceLand — API каталогу + віддача фото (Netlify Function v2).
//
// Де лежать дані: у Netlify Blobs, а не в репозиторії. Тому новий костюм
// з'являється на сайті одразу і не запускає перебудову сайту (а кожна
// перебудова на безкоштовному плані коштує 15 із 300 кредитів на місяць).
//
// Публічні адреси:
//   GET  /api/products                 — каталог для сайту (в наявності + резерв)
//   GET  /img/<id>                     — фото (id із 16 символів, з літерою "s" — мініатюра)
// Адреси адмінки (потрібен заголовок x-admin-key = змінна ADMIN_PASSWORD у Netlify, закодована через encodeURIComponent):
//   GET    /api/admin/products         — усі лоти з усіма статусами
//   PUT    /api/admin/img/<id>         — завантажити фото (JPEG)
//   POST   /api/admin/product          — створити лот
//   PATCH  /api/admin/product/<ALC-1>  — змінити лот (будь-які поля, у тому числі статус)
//   DELETE /api/admin/product/<ALC-1>  — видалити лот разом із фото

import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

const AUDIENCE = ["girls", "boys"];
const TAGS = ["halloween", "heroes", "princess", "fairy", "animals", "disney", "accessories"];
const CONDITIONS = ["Ідеальний", "Дуже хороший", "Хороший"];
const STATUSES = ["available", "reserved", "sold", "hidden"];
const EDITABLE = ["name", "audience", "tags", "size", "condition", "price", "oldPrice", "desc", "status", "images"];
const MAX_IMAGES = 10;
const MAX_FULL_BYTES = 2.5 * 1024 * 1024;
const MAX_SMALL_BYTES = 400 * 1024;
const FULL_ID = /^[a-f0-9]{16}$/;
const ANY_ID = /^[a-f0-9]{16}s?$/;
const ART_ID = /^ALC-\d{3,}$/;

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
export function normalize(raw) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const text = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const num = (v) => {
    const x = Math.round(Number(String(v ?? "").replace(",", ".").replace(/\s/g, "")));
    return Number.isFinite(x) ? x : 0;
  };

  const name = text(raw.name, 80);
  const size = text(raw.size, 40);
  const audience = AUDIENCE.filter((a) => arr(raw.audience).includes(a));
  const tags = TAGS.filter((t) => arr(raw.tags).includes(t));
  const condition = CONDITIONS.includes(raw.condition) ? raw.condition : null;
  const price = num(raw.price);
  let oldPrice = raw.oldPrice === null || raw.oldPrice === undefined || raw.oldPrice === "" ? null : num(raw.oldPrice);
  if (!oldPrice || oldPrice <= price) oldPrice = null;
  const desc = String(raw.desc ?? "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 800);
  const status = STATUSES.includes(raw.status) ? raw.status : "available";
  const images = [...new Set(arr(raw.images).filter((x) => FULL_ID.test(x)))].slice(0, MAX_IMAGES);

  if (name.length < 2) return { error: "Впиши назву костюма" };
  if (!audience.length) return { error: "Обери, для кого костюм: дівчатка, хлопчики або обоє" };
  if (!size) return { error: "Вкажи розмір або зріст" };
  if (!condition) return { error: "Обери стан костюма" };
  if (price < 1 || price > 100000) return { error: "Вкажи ціну в гривнях" };
  if ((status === "available" || status === "reserved") && !images.length) {
    return { error: "Додай хоча б одне фото" };
  }
  return { value: { name, audience, tags, size, condition, price, oldPrice, desc, status, images } };
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
});

export function createHandler({ getStore: makeStore = getStore, env = defaultEnv } = {}) {
  // Каталог читаємо з "сильною" узгодженістю, щоб після збереження одразу бачити зміни.
  const db = () => makeStore({ name: "aliceland", consistency: "strong" });
  const img = () => makeStore({ name: "aliceland-img" });

  async function load() {
    const data = await db().get("products", { type: "json" });
    if (data && Array.isArray(data.items)) return data;
    return { items: [], next: 1 };
  }

  const save = (data) => db().setJSON("products", data);

  function nextId(data) {
    const maxUsed = data.items.reduce((m, p) => Math.max(m, artNumber(p.id)), 0);
    return formatId(Math.max(Number(data.next) || 1, maxUsed + 1));
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
    if (method === "GET" && path === "/api/products") {
      const data = await load();
      const items = data.items
        .filter((p) => p.status === "available" || p.status === "reserved")
        .map(toPublic);
      return json({ items, total: items.length });
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
      const auth = authorize(req);
      if (auth === "not-configured") {
        return json({ error: "У Netlify ще не задано змінну ADMIN_PASSWORD", code: "no_password" }, 503);
      }
      if (auth === "bad") {
        await sleep(800); // гальмуємо підбір пароля
        return json({ error: "Невірний пароль", code: "bad_password" }, 401);
      }

      if (method === "GET" && path === "/api/admin/products") {
        const data = await load();
        return json({ items: data.items, counts: counts(data.items), nextId: nextId(data) });
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
        const parsed = normalize(body);
        if (parsed.error) return json({ error: parsed.error }, 400);
        const missing = await firstMissingImage(parsed.value.images);
        if (missing >= 0) return json({ error: `Фото №${missing + 1} не завантажилось. Додай його ще раз` }, 400);

        const data = await load();
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
          const parsed = normalize({ ...existing, ...patch });
          if (parsed.error) return json({ error: parsed.error }, 400);

          const added = parsed.value.images.filter((x) => !existing.images.includes(x));
          const missing = await firstMissingImage(added);
          if (missing >= 0) return json({ error: "Нове фото не завантажилось. Додай його ще раз" }, 400);

          const now = new Date().toISOString();
          const item = { ...existing, ...parsed.value, updatedAt: now };
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
