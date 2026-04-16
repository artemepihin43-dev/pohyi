const TelegramBot = require('node-telegram-bot-api');
const db = require('./database');
const { getAvailableKey, markKeyUsed } = require('./keys');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const WEB_APP_URL = process.env.WEB_APP_URL || 'https://your-domain.com';
const REFERRAL_BONUS = 6900; // 69 рублей в копейках

function getOrCreateUser(tgUser) {
  let user = db.get('users').find({ telegram_id: tgUser.id }).value();
  if (!user) {
    user = {
      id: Date.now(),
      telegram_id: tgUser.id,
      username: tgUser.username || null,
      first_name: tgUser.first_name || null,
      last_name: tgUser.last_name || null,
      balance: 0,
      ref_code: 'ref' + tgUser.id,
      created_at: new Date().toISOString()
    };
    db.get('users').push(user).write();
  } else {
    db.get('users').find({ telegram_id: tgUser.id }).assign({
      username: tgUser.username || null,
      first_name: tgUser.first_name || null,
      last_name: tgUser.last_name || null
    }).write();
  }
  return db.get('users').find({ telegram_id: tgUser.id }).value();
}

// /start — с поддержкой реферального кода
bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const tgUser = msg.from;
  const refCode = match && match[1] ? match[1].trim() : null;

  const isNew = !db.get('users').find({ telegram_id: tgUser.id }).value();
  const user = getOrCreateUser(tgUser);

  // Начислить реферальный бонус
  if (isNew && refCode && refCode.startsWith('ref')) {
    const referrerId = parseInt(refCode.replace('ref', ''));
    const referrer = db.get('users').find({ telegram_id: referrerId }).value();

    if (referrer && referrerId !== tgUser.id) {
      // Проверяем что этот пользователь ещё не был реферален
      const alreadyReferred = db.get('referrals').find({ referred_id: tgUser.id }).value();
      if (!alreadyReferred) {
        db.get('referrals').push({
          id: Date.now(),
          referrer_id: referrerId,
          referred_id: tgUser.id,
          bonus: REFERRAL_BONUS,
          created_at: new Date().toISOString()
        }).write();

        db.get('users').find({ telegram_id: referrerId }).assign({
          balance: (referrer.balance || 0) + REFERRAL_BONUS
        }).write();

        // Уведомить реферера
        bot.sendMessage(referrerId,
          `🎉 *+69 ₽ на баланс!*\n\n` +
          `По твоей реферальной ссылке зарегистрировался новый пользователь.\n` +
          `Бонус зачислен на твой счёт. 🔥`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }
    }
  }

  bot.sendMessage(chatId,
    `👾 *Добро пожаловать в VPN.CYBER*\n\n` +
    `Привет, *${tgUser.first_name || 'stranger'}*!\n\n` +
    `⚡ Обходи блокировки\n` +
    `🔒 Защита трафика\n` +
    `♾️ Безлимитный трафик\n` +
    `📱 Любое устройство\n` +
    `⚙️ Мгновенная выдача ключа\n\n` +
    `💰 Баланс: *${((user.balance || 0) / 100).toFixed(2)} ₽*\n\n` +
    `👇 Открой магазин:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🛒 Открыть магазин', web_app: { url: WEB_APP_URL } }],
          [
            { text: '🔑 Мои ключи', callback_data: 'my_keys' },
            { text: '👥 Рефералы', callback_data: 'referrals' }
          ],
          [{ text: '❓ Помощь', callback_data: 'help' }]
        ]
      }
    }
  );
});

// /mykeys
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
    text += `📅 ${o.paid_at?.slice(0, 10)}\n\n`;
  });

  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

// /balance
bot.onText(/\/balance/, (msg) => {
  const user = db.get('users').find({ telegram_id: msg.from.id }).value();
  const balance = user?.balance || 0;
  bot.sendMessage(msg.chat.id,
    `💰 *Твой баланс:* ${(balance / 100).toFixed(2)} ₽`,
    { parse_mode: 'Markdown' }
  );
});

// /ref
bot.onText(/\/ref/, (msg) => {
  const user = getOrCreateUser(msg.from);
  const refLink = `https://t.me/${process.env.BOT_USERNAME || 'your_bot'}?start=${user.ref_code}`;
  const refCount = db.get('referrals').filter({ referrer_id: msg.from.id }).size().value();
  const earned = refCount * REFERRAL_BONUS;

  bot.sendMessage(msg.chat.id,
    `👥 *Реферальная программа*\n\n` +
    `За каждого приглашённого друга ты получаешь *+69 ₽* на баланс.\n\n` +
    `📊 Приглашено: *${refCount}* чел.\n` +
    `💰 Заработано: *${(earned / 100).toFixed(2)} ₽*\n\n` +
    `🔗 Твоя ссылка:\n\`${refLink}\``,
    { parse_mode: 'Markdown' }
  );
});

// /admin
bot.onText(/\/admin/, (msg) => {
  if (String(msg.from.id) !== String(process.env.ADMIN_TELEGRAM_ID)) {
    return bot.sendMessage(msg.chat.id, '❌ Нет доступа.');
  }

  const plans = db.get('plans').filter({ active: true }).value();
  const stats = plans.map(p => {
    const available = db.get('vpn_keys').filter({ plan_id: p.id, status: 'available' }).size().value();
    const used = db.get('vpn_keys').filter({ plan_id: p.id, status: 'used' }).size().value();
    return `*${p.name}*: 🟢 ${available} / 🔴 ${used}`;
  }).join('\n');

  const paidOrders = db.get('orders').filter({ status: 'paid' }).value();
  const revenue = paidOrders.reduce((sum, o) => {
    const plan = db.get('plans').find({ id: o.plan_id }).value();
    return sum + (plan?.price || 0);
  }, 0);

  bot.sendMessage(msg.chat.id,
    `📊 *Статистика*\n\n` +
    `*Ключи (свободно/использовано):*\n${stats}\n\n` +
    `💳 Продаж: *${paidOrders.length}*\n` +
    `💰 Выручка: *${(revenue / 100).toFixed(2)} ₽*\n` +
    `👥 Пользователей: *${db.get('users').size().value()}*\n` +
    `🔗 Рефералов: *${db.get('referrals').size().value()}*`,
    { parse_mode: 'Markdown' }
  );
});

// Callback кнопки
bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;

  if (query.data === 'my_keys') {
    bot.answerCallbackQuery(query.id);
    const orders = db.get('orders').filter({ telegram_user_id: query.from.id, status: 'paid' }).value();

    if (!orders.length) {
      return bot.sendMessage(chatId,
        '🔑 У тебя пока нет ключей.',
        { reply_markup: { inline_keyboard: [[{ text: '🛒 В магазин', web_app: { url: WEB_APP_URL } }]] } }
      );
    }

    let text = '🔑 *Твои VPN ключи:*\n\n';
    orders.slice(-10).reverse().forEach((o, i) => {
      const key = db.get('vpn_keys').find({ id: o.vpn_key_id }).value();
      const plan = db.get('plans').find({ id: o.plan_id }).value();
      text += `*${i + 1}. ${plan?.name || '—'}*\n\`${key?.key_value || '—'}\`\n📅 ${o.paid_at?.slice(0, 10)}\n\n`;
    });
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  }

  if (query.data === 'referrals') {
    bot.answerCallbackQuery(query.id);
    const user = getOrCreateUser(query.from);
    const refLink = `https://t.me/${process.env.BOT_USERNAME || 'your_bot'}?start=${user.ref_code}`;
    const refCount = db.get('referrals').filter({ referrer_id: query.from.id }).size().value();
    const earned = refCount * REFERRAL_BONUS;

    bot.sendMessage(chatId,
      `👥 *Реферальная программа*\n\n` +
      `За каждого друга — *+69 ₽* на баланс.\n\n` +
      `📊 Приглашено: *${refCount}* чел.\n` +
      `💰 Заработано: *${(earned / 100).toFixed(2)} ₽*\n\n` +
      `🔗 Твоя ссылка:\n\`${refLink}\``,
      { parse_mode: 'Markdown' }
    );
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
      `/mykeys — мои ключи\n` +
      `/balance — баланс\n` +
      `/ref — реферальная ссылка\n\n` +
      `*Проблемы?* Напиши нам!`,
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
    bot.sendMessage(msg.chat.id, '⚠️ Оплата получена, но ключи временно закончились. Мы свяжемся с тобой.');
    return;
  }

  markKeyUsed(key.id);

  const order = db.get('orders').find({ telegram_user_id: userId, plan_id: planId, status: 'pending' }).value();
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
    `✅ *Оплата прошла!*\n\n` +
    `📦 Тариф: *${plan?.name}*\n\n` +
    `🔑 *Твой VPN ключ:*\n\`${key.key_value}\`\n\n` +
    `📋 Сохрани ключ — он нужен для подключения.`,
    { parse_mode: 'Markdown' }
  );
});

module.exports = bot;
