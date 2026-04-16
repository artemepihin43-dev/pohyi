const TelegramBot = require('node-telegram-bot-api');
const db = require('./database');
const { getAvailableKey, markKeyUsed } = require('./keys');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const WEB_APP_URL = process.env.WEB_APP_URL || 'https://your-domain.com';

// /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from;

  // Save/update user
  db.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name
  `).run(user.id, user.username || null, user.first_name || null, user.last_name || null);

  bot.sendMessage(chatId,
    `👋 Привет, ${user.first_name || 'друг'}!\n\n` +
    `🔐 *VPN Shop* — купи ключ доступа к нашему VPN-серверу.\n\n` +
    `✅ Стабильное соединение\n` +
    `✅ Безлимитный трафик\n` +
    `✅ Работает везде\n` +
    `✅ Мгновенная выдача ключа\n\n` +
    `Нажми кнопку ниже, чтобы открыть магазин:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          {
            text: '🛒 Открыть магазин',
            web_app: { url: WEB_APP_URL }
          }
        ]]
      }
    }
  );
});

// /mykeys command
bot.onText(/\/mykeys/, (msg) => {
  const chatId = msg.chat.id;
  const orders = db.prepare(`
    SELECT o.*, k.key_value, p.name as plan_name, p.duration_days
    FROM orders o
    LEFT JOIN vpn_keys k ON k.id = o.vpn_key_id
    LEFT JOIN plans p ON p.id = o.plan_id
    WHERE o.telegram_user_id = ? AND o.status = 'paid'
    ORDER BY o.paid_at DESC
    LIMIT 10
  `).all(msg.from.id);

  if (!orders.length) {
    return bot.sendMessage(chatId, '❌ У тебя пока нет купленных ключей.\n\nНажми /start чтобы открыть магазин.');
  }

  let text = '🔑 *Твои ключи VPN:*\n\n';
  orders.forEach((o, i) => {
    text += `*${i + 1}. ${o.plan_name}*\n`;
    text += `\`${o.key_value}\`\n`;
    text += `📅 Куплено: ${o.paid_at?.slice(0, 10)}\n\n`;
  });

  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

// /admin command
bot.onText(/\/admin/, (msg) => {
  if (String(msg.from.id) !== String(process.env.ADMIN_TELEGRAM_ID)) {
    return bot.sendMessage(msg.chat.id, '❌ Нет доступа.');
  }

  const plans = db.prepare('SELECT * FROM plans WHERE active = 1').all();
  const stats = plans.map(p => {
    const available = db.prepare("SELECT COUNT(*) as cnt FROM vpn_keys WHERE plan_id = ? AND status = 'available'").get(p.id);
    const used = db.prepare("SELECT COUNT(*) as cnt FROM vpn_keys WHERE plan_id = ? AND status = 'used'").get(p.id);
    return `*${p.name}*: 🟢 ${available.cnt} свободно / 🔴 ${used.cnt} использовано`;
  }).join('\n');

  const totalOrders = db.prepare("SELECT COUNT(*) as cnt FROM orders WHERE status = 'paid'").get();
  const revenue = db.prepare("SELECT SUM(p.price) as total FROM orders o JOIN plans p ON p.id = o.plan_id WHERE o.status = 'paid'").get();

  bot.sendMessage(msg.chat.id,
    `📊 *Статистика магазина*\n\n` +
    `*Ключи по тарифам:*\n${stats}\n\n` +
    `*Всего продаж:* ${totalOrders.cnt}\n` +
    `*Выручка:* ${((revenue.total || 0) / 100).toFixed(2)} руб.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '➕ Добавить ключи', callback_data: 'admin_add_keys' }
        ]]
      }
    }
  );
});

bot.on('callback_query', (query) => {
  if (String(query.from.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return;
  if (query.data === 'admin_add_keys') {
    bot.answerCallbackQuery(query.id);
    bot.sendMessage(query.message.chat.id,
      'Используй API эндпоинт для добавления ключей:\n\n' +
      '`POST /api/admin/keys`\n' +
      '```json\n{"planId": 1, "count": 10}\n```\n' +
      'Заголовок: `x-admin-key: YOUR_ADMIN_KEY`',
      { parse_mode: 'Markdown' }
    );
  }
});

// Handle successful payment from Telegram
bot.on('pre_checkout_query', (query) => {
  bot.answerPreCheckoutQuery(query.id, true);
});

bot.on('successful_payment', (msg) => {
  const payment = msg.successful_payment;
  const planId = parseInt(payment.invoice_payload.replace('plan_', ''));
  const userId = msg.from.id;

  const key = getAvailableKey(planId);
  if (!key) {
    bot.sendMessage(msg.chat.id, '⚠️ Оплата получена, но ключи временно закончились. Мы свяжемся с тобой в ближайшее время.');
    return;
  }

  markKeyUsed(key.id);

  // Update order
  db.prepare(`
    UPDATE orders SET status = 'paid', vpn_key_id = ?, paid_at = datetime('now'), payment_id = ?
    WHERE telegram_user_id = ? AND plan_id = ? AND status = 'pending'
    ORDER BY created_at DESC LIMIT 1
  `).run(key.id, payment.telegram_payment_charge_id, userId, planId);

  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);

  bot.sendMessage(msg.chat.id,
    `✅ *Оплата прошла успешно!*\n\n` +
    `📦 Тариф: *${plan.name}*\n\n` +
    `🔑 *Твой VPN ключ:*\n\`${key.key_value}\`\n\n` +
    `📋 Сохрани этот ключ — он понадобится для подключения к серверу.\n\n` +
    `❓ По вопросам: /help`,
    { parse_mode: 'Markdown' }
  );
});

module.exports = bot;
