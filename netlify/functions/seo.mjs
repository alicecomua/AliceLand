// Віддає головну сторінку з налаштуваннями, сторінки товарів /p/ALC-001, sitemap.xml і robots.txt.
// Адреси спрямовує файл public/_redirects (параметр kind каже, що саме показати).
import { createSeoHandler } from "./lib/seo.mjs";

const handle = createSeoHandler();
export default async (req) => handle(req);
