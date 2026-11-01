// Довга частина перевірки Shafa: працює до 15 хвилин у фоні (відповідь клієнту не потрібна).
import { sync, syncKey } from "./api.mjs";

export default async (req) => {
  if (req.headers.get("x-sync-key") !== syncKey()) return new Response("Заборонено", { status: 401 });
  await sync.run({ budgetMs: 13 * 60 * 1000, force: req.headers.get("x-sync-force") === "1" });
  return new Response("ok");
};

export const config = { background: true };
