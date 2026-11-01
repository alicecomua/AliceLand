// Двічі на добу (05:00 і 17:00 за UTC, це 07–08 ранку й 19–20 вечора в Києві) запускає перевірку Shafa.
// Сама перевірка може тривати довше за 30 секунд, тому ця функція лише запускає фонову (до 15 хвилин).
import { sync, syncKey } from "./api.mjs";

export default async (req, context) => {
  const origin = context?.site?.url || globalThis.Netlify?.env?.get?.("URL") || process.env.URL;
  let started = false;
  if (origin) {
    try {
      const r = await fetch(origin.replace(/\/+$/, "") + "/.netlify/functions/sync-background", { method: "POST", headers: { "x-sync-key": syncKey() } });
      started = r.ok || r.status === 202;
    } catch { /* пробуємо нижче */ }
  }
  if (!started) await sync.run({ budgetMs: 24000 });   // запасний шлях: хоч частина перевірки
};

export const config = { schedule: "0 5,17 * * *" };
