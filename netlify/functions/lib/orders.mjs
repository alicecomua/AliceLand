// Замовлення з сайту: перевірка, збереження, текст для Telegram
export const ORDER_STATUSES = ["new", "work", "done", "cancel"];
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
export const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
export const ORDER_KEY_RE = /^o-\d{6}-\d{13}-[a-f0-9]{4}$/;

// Повертає { silent: true } для ботів (їм вдаємо успіх), { error, status } або { order }
export function validateOrder(body, product) {
  if (!body || typeof body !== "object") return { error: "Некоректні дані", status: 400 };
  if (String(body.hp || "").trim()) return { silent: true };                         // приманка для ботів заповнена
  if (body.t !== undefined && Number.isFinite(Number(body.t)) && Number(body.t) < 300) return { error: "Занадто швидко. Спробуй ще раз", status: 400 };   // швидше, ніж встигає людина; живий покупець просто повторить
  const name = clean(body.name, 60), phone = clean(body.phone, 30), comment = clean(body.comment, 300);
  if (name.length < 2) return { error: "Впиши своє ім'я", status: 400 };
  const d = phone.replace(/\D/g, "");
  if (d.length < 9 || d.length > 13) return { error: "Впиши номер телефону, щоб ми могли зв'язатися", status: 400 };
  if (!product) return { error: "Такого костюма немає. Онови сторінку", status: 404 };
  if (product.status !== "available" && product.status !== "reserved") return { error: "Цей костюм уже продано. Подивись інші в каталозі", status: 409 };
  const size = /^\d/.test(product.size) && !/см/i.test(product.size) ? product.size + " см" : product.size;
  return { order: { productId: product.id, productName: product.name, size, price: product.price, name, phone, comment } };
}

export function newOrderKey(now = Date.now(), rand = Math.random()) {
  const d = new Date(now);
  const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return `o-${ym}-${String(now).padStart(13, "0")}-${Math.floor(rand * 0xffff).toString(16).padStart(4, "0")}`;
}
export function orderPrefixes(now = Date.now(), months = 2) {
  const out = [];
  const d = new Date(now);
  for (let i = 0; i < months; i++) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(`o-${x.getUTCFullYear()}${String(x.getUTCMonth() + 1).padStart(2, "0")}-`);
  }
  return out;
}
export const orderNumber = (key) => parseInt(key.slice(9, 22), 10).toString(36).slice(-5).toUpperCase();

export function telegramText(o, origin = "") {
  const L = [`🛍 <b>Нове замовлення № ${esc(o.number)}</b>`, `<b>${esc(o.productName)}</b> (${esc(o.productId)})`, `Розмір: ${esc(o.size)}, ${esc(o.price)} грн`, `👤 ${esc(o.name)}`, `📞 ${esc(o.phone)}`];
  if (o.comment) L.push(`💬 ${esc(o.comment)}`);
  if (origin) L.push(`🔗 ${esc(origin)}/p/${esc(o.productId)}`);
  return L.join("\n");
}
