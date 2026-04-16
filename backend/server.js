require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const db = require('./database');
const { addBulkKeys, getAvailableKey, markKeyUsed } = require('./keys');
const bot = require('./bot');

const app = express();
app.use(cors());
app.use(express.json());

const REFERRAL_BONUS = 6900; // 69 рублей в копейках

function verifyTelegramData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData')
    .update(process.env.BOT_TOKEN)
    .digest();

  const expectedHash = crypto.createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (expectedHash !== hash) return null;

  const userParam = params.get('user');
  if (!userParam) return null;
  return JSON.parse(decodeURIComponent(userParam));
}

function getOrCreateUser(telegramUser) {
  let user = db.get('users').find({ telegram_id: telegramUser.id }).value();
  if (!user) {
    user = {
      id: Date.now(),
      telegram_id: telegramUser.id,
      username: telegramUser.username || null,
      first_name: telegramUser.first_name || null,
      last_name: telegramUser.last_name || null,
      balance: 0,
      ref_code: 'ref' + telegramUser.id,
      created_at: new Date().toISOString()
    };
    db.get('users').push(user).write();
  }
  return user;
}

// GET /api/me — профиль пользователя
app.get('/api/me', (req, res) => {
  const initData = req.headers['x-init-data'];
  const tgUser = verifyTelegramData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

  const user = getOrCreateUser(tgUser);
  const referralCount = db.get('referrals').filter({ referrer_id: user.telegram_id }).size().value();
  const referralLink = `https://t.me/${process.env.BOT_USERNAME || 'your_bot'}?start=${user.ref_code}`;

  res.json({
    first_name: user.first_name,
    username: user.username,
    balance: user.balance,
    ref_code: user.ref_code,
    referral_link: referralLink,
    referral_count: referralCount
  });
});

// GET /api/plans
app.get('/api/plans', (req, res) => {
  const plans = db.get('plans').filter({ active: true }).value();
  const result = plans.map(plan => ({
    ...plan,
    in_stock: db.get('vpn_keys').filter({ plan_id: plan.id, status: 'available' }).size().value() > 0
  }));
  res.json(result);
});

// POST /api/create-invoice
app.post('/api/create-invoice', (req, res) => {
  const { initData, planId } = req.body;
  const tgUser = verifyTelegramData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

  const plan = db.get('plans').find({ id: planId, active: true }).value();
  if (!plan) return res.status(404).json({ error: 'Тариф не найден' });

  const inStock = db.get('vpn_keys').filter({ plan_id: planId, status: 'available' }).size().value() > 0;
  if (!inStock) return res.status(400).json({ error: 'Ключи закончились' });

  const user = getOrCreateUser(tgUser);

  // Списываем баланс если хватает
  let finalPrice = plan.price;
  let balanceUsed = 0;
  if (user.balance >= plan.price) {
    // Полная оплата балансом
    balanceUsed = plan.price;
    finalPrice = 0;
    db.get('users').find({ telegram_id: tgUser.id }).assign({ balance: user.balance - balanceUsed }).write();

    const key = getAvailableKey(planId);
    if (!key) return res.status(400).json({ error: 'Ключи закончились' });
    markKeyUsed(key.id);

    const orderId = Date.now();
    db.get('orders').push({
      id: orderId,
      telegram_user_id: tgUser.id,
      telegram_username: tgUser.username || null,
      plan_id: planId,
      vpn_key_id: key.id,
      status: 'paid',
      payment_id: 'balance_' + orderId,
      created_at: new Date().toISOString(),
      paid_at: new Date().toISOString()
    }).write();

    bot.sendMessage(tgUser.id,
      `✅ *Оплачено с баланса!*\n\n` +
      `📦 Тариф: *${plan.name}*\n\n` +
      `🔑 *Твой VPN ключ:*\n\`${key.key_value}\`\n\n` +
      `📋 Сохрани ключ — он нужен для подключения к серверу.`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});

    return res.json({ ok: true, paid_with_balance: true });
  }

  db.get('orders').push({
    id: Date.now(),
    telegram_user_id: tgUser.id,
    telegram_username: tgUser.username || null,
    plan_id: planId,
    vpn_key_id: null,
    status: 'pending',
    payment_id: null,
    created_at: new Date().toISOString(),
    paid_at: null
  }).write();

  bot.sendInvoice(
    tgUser.id,
    `VPN доступ — ${plan.name}`,
    plan.description,
    `plan_${plan.id}`,
    process.env.PAYMENT_PROVIDER_TOKEN,
    'RUB',
    [{ label: plan.name, amount: plan.price }],
    { need_name: false, need_email: false, need_phone_number: false }
  ).then(() => {
    res.json({ ok: true, message: 'Счёт отправлен в Telegram' });
  }).catch(err => {
    console.error('Invoice error:', err.message);
    res.status(500).json({ error: 'Не удалось создать счёт' });
  });
});

// GET /api/orders
app.get('/api/orders', (req, res) => {
  const initData = req.headers['x-init-data'];
  const tgUser = verifyTelegramData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

  const orders = db.get('orders').filter({ telegram_user_id: tgUser.id }).value();
  const result = orders.slice(-20).reverse().map(o => {
    const plan = db.get('plans').find({ id: o.plan_id }).value();
    const key = o.vpn_key_id ? db.get('vpn_keys').find({ id: o.vpn_key_id }).value() : null;
    return {
      id: o.id,
      status: o.status,
      created_at: o.created_at,
      paid_at: o.paid_at,
      plan_name: plan?.name,
      duration_days: plan?.duration_days,
      key_value: key?.key_value || null
    };
  });

  res.json(result);
});

// POST /api/admin/keys
app.post('/api/admin/keys', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { planId, count = 10, keys } = req.body;
  if (!planId) return res.status(400).json({ error: 'planId обязателен' });

  const plan = db.get('plans').find({ id: planId }).value();
  if (!plan) return res.status(404).json({ error: 'Тариф не найден' });

  let added;
  if (keys && Array.isArray(keys)) {
    keys.forEach((k, i) => {
      db.get('vpn_keys').push({ id: Date.now() + i, key_value: k, plan_id: planId, status: 'available', created_at: new Date().toISOString() }).write();
    });
    added = keys.length;
  } else {
    added = addBulkKeys(planId, count).length;
  }

  res.json({ ok: true, added, plan: plan.name });
});

// GET /api/admin/stats
app.get('/api/admin/stats', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const plans = db.get('plans').value();
  const stats = plans.map(p => ({
    plan: p.name,
    available: db.get('vpn_keys').filter({ plan_id: p.id, status: 'available' }).size().value(),
    used: db.get('vpn_keys').filter({ plan_id: p.id, status: 'used' }).size().value()
  }));

  const paidOrders = db.get('orders').filter({ status: 'paid' }).value();
  const revenue = paidOrders.reduce((sum, o) => {
    const plan = db.get('plans').find({ id: o.plan_id }).value();
    return sum + (plan?.price || 0);
  }, 0);

  res.json({
    stats,
    totalOrders: paidOrders.length,
    revenue,
    totalUsers: db.get('users').size().value(),
    totalReferrals: db.get('referrals').size().value()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  console.log(`🤖 Бот запущен`);
});

module.exports = { REFERRAL_BONUS };
