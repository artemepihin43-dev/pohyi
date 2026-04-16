# VPN Keys Shop — Telegram Web App

Telegram Web App для продажи ключей доступа к VPN-серверу.

## Структура проекта

```
├── backend/         — Node.js сервер + Telegram бот
│   ├── server.js    — Express API
│   ├── bot.js       — Telegram Bot логика
│   ├── database.js  — SQLite БД (схема + seed)
│   ├── keys.js      — Генерация и управление ключами
│   └── .env.example — Пример переменных окружения
└── frontend/        — Telegram Web App (HTML/CSS/JS)
    ├── index.html
    ├── styles.css
    └── app.js
```

## Быстрый старт

### 1. Создай бота

1. Напиши [@BotFather](https://t.me/BotFather) в Telegram
2. Создай нового бота `/newbot`
3. Скопируй токен
4. Подключи платёжный провайдер: `/mybots → Payments`

### 2. Настрой backend

```bash
cd backend
npm install
cp .env.example .env
# Заполни .env своими данными
node server.js
```

### 3. Переменные окружения (`.env`)

| Переменная | Описание |
|---|---|
| `BOT_TOKEN` | Токен бота от @BotFather |
| `PAYMENT_PROVIDER_TOKEN` | Токен платёжной системы (Yukassa, etc.) |
| `ADMIN_TELEGRAM_ID` | Твой Telegram ID (для /admin) |
| `ADMIN_API_KEY` | Секретный ключ для API |
| `WEB_APP_URL` | URL где задеплоен frontend |
| `PORT` | Порт сервера (default: 3000) |

### 4. Задеплой frontend

Загрузи папку `frontend/` на любой хостинг (Vercel, Netlify, GitHub Pages).

В `frontend/app.js` замени `API_URL` на адрес своего backend.

### 5. Зарегистрируй Web App

У [@BotFather](https://t.me/BotFather): `/mybots → Bot Settings → Menu Button → Configure menu button`

Или через `/newapp` — создай Web App и укажи URL frontend.

## API

### Публичные

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/plans` | Список тарифов |
| POST | `/api/create-invoice` | Создать счёт на оплату |
| GET | `/api/orders` | Заказы пользователя |

### Админские (заголовок `x-admin-key`)

| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/admin/keys` | Добавить ключи |
| GET | `/api/admin/stats` | Статистика |

### Добавить ключи через API

```bash
curl -X POST https://your-backend.com/api/admin/keys \
  -H "Content-Type: application/json" \
  -H "x-admin-key: YOUR_ADMIN_KEY" \
  -d '{"planId": 1, "count": 20}'
```

Или загрузить готовые ключи:

```bash
curl -X POST https://your-backend.com/api/admin/keys \
  -H "Content-Type: application/json" \
  -H "x-admin-key: YOUR_ADMIN_KEY" \
  -d '{"planId": 1, "keys": ["KEY-AABB-CCDD", "KEY-EEFF-1122"]}'
```

## Команды бота

| Команда | Описание |
|---|---|
| `/start` | Открыть магазин |
| `/mykeys` | Мои купленные ключи |
| `/admin` | Панель администратора |

## Деплой на сервер (пример с PM2)

```bash
npm install -g pm2
cd backend
pm2 start server.js --name vpn-shop
pm2 save
```
