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
  const existing = db.get('users').find({ telegram_id: user.id }).value();
  if (existing) {
    db.get('users').find({ telegram_id: user.id }).assign({
      username: user.username || null,
      first_name: user.first_name || null,
      last_name: user.last_name || null
    }).write();
  } else {
    db.get('users').push({
      id: Date.now(),
      telegram_id: user.id,
      username: user.username || null,
      first_name: user.first_name || null,
      last_name: user.last_name || null,
      created_at: new Date().toISOString()
    }).write();
  }

  bot.sendMessage(chatId,
    `👋 Привет, *${user.first_name || 'друг'}*!\n\n` +
    `Добро пожаловать в *VPN Shop* — твой личный доступ к защищённому интернету.\n\n` +
    `🌐 Обходи блокировки\n` +
    `🔒 Защита трафика\n` +
    `⚡ Высокая скорость\n` +
    `♾️ Безлимитный трафик\n` +
    `📱 Работает на любом устройстве\n` +
    `⚙️ Мгновенная выдача ключа после оплаты\n\n` +
    `👇 Нажми кнопку ниже чтобы выбрать тариф:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🛒 Открыть магазин',
              web_app: { url: WEB_APP_URL }
            }
          ],
          [
            { text: '🔑 Мои ключи', callback_data: 'my_keys' },
            { text: '❓ Помощь', callback_data: 'help' }
          ]
        ]
      }
    }
  );
});

// /mykeys command
bot.onText(/\/mykeys/, (msg) => {
  const chatId = msg.chat.id;
  const orders = db.get('orders').filter({ telegram_user_id: msg.from.id, status: 'paid' }).value();

  if (!orders.length) {
    return bot.sendMessage(chatId, '❌ У тебя пока нет купленных ключей.\n\nНажми /start чтобы открыть магазин.');
  }

  let text = '🔑 *Твои ключи VPN:*\n\n';
  orders.slice(-10).reverse().forEach((o, i) => {
    const key = db.get('vpn_keys').find({ id: o.vpn_key_id }).value();
    const plan = db.get('plans').find({ id: o.plan_id }).value();
    text += `*${i + 1}. ${plan?.name || '—'}*\n`;
    text += `\`${key?.key_value || '—'}\`\n`;
    text += `📅 Куплено: ${o.paid_at?.slice(0, 10)}\n\n`;
  });

  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

// /admin command
bot.onText(/\/admin/, (msg) => {
  if (String(msg.from.id) !== String(process.env.ADMIN_TELEGRAM_ID)) {
    return bot.sendMessage(msg.chat.id, '❌ Нет доступа.');
  }

  const plans = db.get('plans').filter({ active: true }).value();
  const stats = plans.map(p => {
    const available = db.get('vpn_keys').filter({ plan_id: p.id, status: 'available' }).size().value();
    const used = db.get('vpn_keys').filter({ plan_id: p.id, status: 'used' }).size().value();
    return `*${p.name}*: 🟢 ${available} свободно / 🔴 ${used} использовано`;
  }).join('\n');

  const totalOrders = db.get('orders').filter({ status: 'paid' }).size().value();
  const paidOrders = db.get('orders').filter({ status: 'paid' }).value();
  const revenue = paidOrders.reduce((sum, o) => {
    const plan = db.get('plans').find({ id: o.plan_id }).value();
    return sum + (plan?.price || 0);
  }, 0);
  const totalUsers = db.get('users').size().value();

  bot.sendMessage(msg.chat.id,
    `📊 *Статистика магазина*\n\n` +
    `*Ключи по тарифам:*\n${stats}\n\n` +
    `*Всего продаж:* ${totalOrders}\n` +
    `*Выручка:* ${(revenue / 100).toFixed(2)} руб.\n` +
    `*Пользователей:* ${totalUsers}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '➕ Как добавить ключи', callback_data: 'admin_add_keys' }
        ]]
      }
    }
  );
});

// Callback buttons
bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;

  if (query.data === 'my_keys') {
    bot.answerCallbackQuery(query.id);
    const orders = db.get('orders').filter({ telegram_user_id: query.from.id, status: 'paid' }).value();

    if (!orders.length) {
      return bot.sendMessage(chatId,
        '🔑 У тебя пока нет купленных ключей.\n\nОткрой магазин чтобы выбрать тариф.',
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '🛒 В магазин', web_app: { url: WEB_APP_URL } }
            ]]
          }
        }
      );
    }

    let text = '🔑 *Твои VPN ключи:*\n\n';
    orders.slice(-10).reverse().forEach((o, i) => {
      const key = db.get('vpn_keys').find({ id: o.vpn_key_id }).value();
      const plan = db.get('plans').find({ id: o.plan_id }).value();
      text += `*${i + 1}. ${plan?.name || '—'}*\n`;
      text += `\`${key?.key_value || '—'}\`\n`;
      text += `📅 ${o.paid_at?.slice(0, 10)}\n\n`;
    });
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  }

  if (query.data === 'help') {
    bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId,
      `❓ *Помощь*\n\n` +
      `*Как подключиться к VPN?*\n` +
      `1. Купи ключ в магазине\n` +
      `2. Получи ключ в этом чате\n` +
      `3. Введи ключ в VPN-клиент\n\n` +
      `*Команды:*\n` +
      `/start — главное меню\n` +
      `/mykeys — мои ключи\n\n` +
      `*Проблемы с ключом?*\n` +
      `Напиши нам — разберёмся!`,
      { parse_mode: 'Markdown' }
    );
  }

  if (query.data === 'admin_add_keys') {
    if (String(query.from.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return;
    bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId,
      'Используй API эндпоинт для добавления ключей:\n\n' +
      '`POST /api/admin/keys`\n' +
      '```json\n{"planId": 1, "count": 10}\n```\n' +
      'Заголовок: `x-admin-key: YOUR_ADMIN_KEY`',
      { parse_mode: 'Markdown' }
    );
  }
});

// Telegram Payments
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

  const order = db.get('orders')
    .find({ telegram_user_id: userId, plan_id: planId, status: 'pending' })
    .value();

  if (order) {
    db.get('orders').find({ id: order.id }).assign({
      status: 'paid',
      vpn_key_id: key.id,
      paid_at: new Date().toISOString(),
      payment_id: payment.telegram_payment_charge_id
    }).write();
  }

  const plan = db.get('plans').find({ id: planId }).value();

  bot.sendMessage(msg.chat.id,
    `✅ *Оплата прошла успешно!*\n\n` +
    `📦 Тариф: *${plan?.name}*\n\n` +
    `🔑 *Твой VPN ключ:*\n\`${key.key_value}\`\n\n` +
    `📋 Сохрани этот ключ — он понадобится для подключения к серверу.\n\n` +
    `❓ По вопросам напиши /start`,
    { parse_mode: 'Markdown' }
  );
});

module.exports = bot;
