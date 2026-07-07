# AliceLand — Карнавальні костюми

## Структура проекту
```
aliceland/
├── index.html          ← публічний сайт
├── products.json       ← каталог товарів (редагується через Netlify CMS)
├── admin/
│   ├── index.html      ← вхід в Netlify CMS
│   └── config.yml      ← конфіг категорій та полів
├── images/             ← фото костюмів (завантажуються через CMS)
├── netlify.toml        ← налаштування хостингу
└── README.md
```

## Деплой: покрокова інструкція

### 1. GitHub
1. github.com → New repository → назва: `aliceland`
2. Завантаж всі файли (Upload files)
3. Commit changes

### 2. Netlify
1. netlify.com → Add new site → Import from GitHub
2. Обери репозиторій `aliceland`
3. Build command: (залишити порожнім)
4. Publish directory: `.`
5. Deploy site

### 3. Підключити GitHub до Netlify CMS
1. В Netlify: Site settings → Identity → Enable Identity
2. Services → Git Gateway → Enable Git Gateway
3. Identity → Registration → Invite only
4. Invite users → введи свій email

### 4. Telegram бот
1. Відкрий @BotFather в Telegram
2. /newbot → дай назву → отримай TOKEN
3. Напиши боту будь-яке повідомлення
4. Відкрий: https://api.telegram.org/bot<TOKEN>/getUpdates
5. Знайди "chat":{"id": XXXXXX} — це твій CHAT_ID
6. В index.html замінити:
   - TG_BOT_TOKEN = 'ТВІЙ_BOT_TOKEN'
   - TG_CHAT_ID   = 'ТВІЙ_CHAT_ID'

### 5. Адмінка
Адреса: https://твій-сайт.netlify.app/admin
Увійти через email (отримаєш запрошення від Netlify)

## Як додати товар
1. Відкрий /admin
2. "Костюми" → New Костюм
3. Заповни поля, встанови артикул (ALC-017, ALC-018...)
4. Завантаж фото
5. Publish → сайт оновиться за ~30 секунд

## Артикули
Формат: ALC-001, ALC-002... 
Наступний вільний: ALC-017
НІКОЛИ не змінювати артикул після створення!
