exports.handler = async function(event) {
  // Тільки POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Токен і chat_id — з Netlify Environment Variables (не в коді!)
  const BOT_TOKEN = process.env.TG_BOT_TOKEN;
  const CHAT_ID   = process.env.TG_CHAT_ID;

  if (!BOT_TOKEN || !CHAT_ID) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Telegram credentials not configured' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { productId, productName, size, price, condition, name, phone, comment, orderNum } = body;

  // Валідація
  if (!name || !phone || !productId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  // Формуємо повідомлення
  const num = String(orderNum || Math.floor(Math.random() * 9000) + 1000).padStart(4, '0');
  const date = new Date().toLocaleString('uk-UA', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Kiev'
  });

  const text =
    `🎭 НОВЕ ЗАМОВЛЕННЯ #${num}\n\n` +
    `📦 ${productName}\n` +
    `🔖 Артикул: ${productId}\n` +
    `📐 Розмір: ${size || '—'}\n` +
    `💰 Ціна: ${price} грн\n` +
    `♻️ Стан: ${condition}\n\n` +
    `👤 Ім'я: ${name}\n` +
    `📞 Телефон: ${phone}` +
    (comment ? `\n💬 Коментар: ${comment}` : '') +
    `\n\n⏰ ${date}`;

  // Відправляємо в Telegram
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' })
      }
    );
    const data = await res.json();

    if (!data.ok) {
      throw new Error(data.description || 'Telegram error');
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, orderNum: num })
    };

  } catch (err) {
    console.error('Telegram send error:', err);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Failed to send to Telegram', detail: err.message })
    };
  }
};
