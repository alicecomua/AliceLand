// Прості обмеження частоти запитів: записуємо лічильник у сховищі за хешем адреси відвідувача
import { createHash } from "node:crypto";

export const clientIp = (req) => (req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown").slice(0, 64);
export const ipKey = (ip) => createHash("sha256").update("alc:" + ip).digest("hex").slice(0, 16);

export function createLimiter(db, now = () => Date.now()) {
  const read = async (k) => { try { return (await db().get(k, { type: "json" })) || null; } catch { return null; } };
  return {
    // Рахує звернення; ok=false, коли за вікно часу їх більше за max
    async hit(name, ip, { windowMs, max }) {
      const k = `rl/${name}/${ipKey(ip)}`, t = now();
      let r = await read(k);
      if (!r || t - r.first > windowMs) r = { first: t, count: 0 };
      r.count++;
      try { await db().setJSON(k, r); } catch { /* ліміт не має ламати запит */ }
      return { ok: r.count <= max, count: r.count };
    },
    async state(name, ip) { return read(`rl/${name}/${ipKey(ip)}`); },
    async locked(name, ip, { windowMs, max }) {
      const r = await read(`rl/${name}/${ipKey(ip)}`);
      return !!r && now() - r.first <= windowMs && r.count >= max;
    },
    async clear(name, ip) { try { await db().delete(`rl/${name}/${ipKey(ip)}`); } catch { /* нічого */ } },
  };
}
