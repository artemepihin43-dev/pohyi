require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const db = require('./database');
const { addBulkKeys, getAvailableKey, markKeyUsed } = require('./keys');
const { bot, tryPayReferralBonus, addLog } = require('./bot');

const app = express();
app.use(cors());
app.use(express.json());

// Health check (Railway/Render используют для проверки)
app.get('/', (req, res) => res.json({ ok: true, service: 'xylivpn-backend' }));

// Отдаём admin панель
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

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
  const allReferrals = db.get('referrals').filter({ referrer_id: user.telegram_id }).value();
  const paidReferrals   = allReferrals.filter(r => r.status === 'paid').length;
  const pendingReferrals = allReferrals.filter(r => r.status === 'pending').length;
  const referralLink = `https://t.me/${process.env.BOT_USERNAME || 'vpnxyliBot'}?start=${user.ref_code}`;

  res.json({
    first_name: user.first_name,
    username: user.username,
    balance: user.balance,
    ref_code: user.ref_code,
    referral_link: referralLink,
    referral_count: paidReferrals,
    referral_pending: pendingReferrals
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
  addLog('api', tgUser.id, tgUser.username, 'create-invoice', `plan_id: ${planId}`);

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

    // Начисляем бонус рефереру если это первая покупка
    tryPayReferralBonus(tgUser.id);

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

function adminAuth(req, res, next) {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// GET /api/admin/users
app.get('/api/admin/users', adminAuth, (req, res) => {
  const users = db.get('users').value();
  const result = users.map(u => {
    const orders = db.get('orders').filter({ telegram_user_id: u.telegram_id, status: 'paid' }).size().value();
    const referrals = db.get('referrals').filter({ referrer_id: u.telegram_id, status: 'paid' }).size().value();
    return { ...u, paid_orders: orders, paid_referrals: referrals };
  });
  res.json(result);
});

// PUT /api/admin/users/:id/balance
app.put('/api/admin/users/:id/balance', adminAuth, (req, res) => {
  const telegramId = parseInt(req.params.id);
  const { balance } = req.body;
  if (typeof balance !== 'number') return res.status(400).json({ error: 'balance must be number (kopeks)' });
  const user = db.get('users').find({ telegram_id: telegramId }).value();
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.get('users').find({ telegram_id: telegramId }).assign({ balance }).write();
  addLog('admin', null, 'admin', 'edit_balance', `user: ${telegramId}, balance: ${balance}`);
  res.json({ ok: true });
});

// GET /api/admin/orders
app.get('/api/admin/orders', adminAuth, (req, res) => {
  const orders = db.get('orders').value().slice().reverse();
  const result = orders.map(o => {
    const plan = db.get('plans').find({ id: o.plan_id }).value();
    const key = o.vpn_key_id ? db.get('vpn_keys').find({ id: o.vpn_key_id }).value() : null;
    const user = db.get('users').find({ telegram_id: o.telegram_user_id }).value();
    return {
      ...o,
      plan_name: plan?.name || '—',
      key_value: key?.key_value || null,
      first_name: user?.first_name || null
    };
  });
  res.json(result);
});

// GET /api/admin/keys-list
app.get('/api/admin/keys-list', adminAuth, (req, res) => {
  const planId = req.query.planId ? parseInt(req.query.planId) : null;
  let keys = planId
    ? db.get('vpn_keys').filter({ plan_id: planId }).value()
    : db.get('vpn_keys').value();
  res.json(keys.slice().reverse());
});

// DELETE /api/admin/keys/:id
app.delete('/api/admin/keys/:id', adminAuth, (req, res) => {
  const id = parseFloat(req.params.id);
  const key = db.get('vpn_keys').find({ id }).value();
  if (!key) return res.status(404).json({ error: 'Key not found' });
  db.get('vpn_keys').remove({ id }).write();
  addLog('admin', null, 'admin', 'delete_key', `key: ${key.key_value}`);
  res.json({ ok: true });
});

// GET /api/admin/plans
app.get('/api/admin/plans', adminAuth, (req, res) => {
  res.json(db.get('plans').value());
});

// PUT /api/admin/plans/:id
app.put('/api/admin/plans/:id', adminAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const { name, description, duration_days, price, active } = req.body;
  const plan = db.get('plans').find({ id }).value();
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  const upd = {};
  if (name !== undefined) upd.name = name;
  if (description !== undefined) upd.description = description;
  if (duration_days !== undefined) upd.duration_days = duration_days;
  if (price !== undefined) upd.price = price;
  if (active !== undefined) upd.active = active;
  db.get('plans').find({ id }).assign(upd).write();
  addLog('admin', null, 'admin', 'edit_plan', `plan: ${id}`);
  res.json({ ok: true });
});

// POST /api/admin/plans
app.post('/api/admin/plans', adminAuth, (req, res) => {
  const { name, description, duration_days, price } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'name and price required' });
  const plan = { id: Date.now(), name, description: description || '', duration_days: duration_days || 30, price, active: true };
  db.get('plans').push(plan).write();
  addLog('admin', null, 'admin', 'create_plan', `plan: ${name}`);
  res.json({ ok: true, plan });
});

// GET /api/admin/logs
app.get('/api/admin/logs', adminAuth, (req, res) => {
  const type = req.query.type;
  let logs = db.get('logs').value().slice().reverse();
  if (type) logs = logs.filter(l => l.type === type);
  res.json(logs.slice(0, 500));
});

// POST /api/admin/broadcast
app.post('/api/admin/broadcast', adminAuth, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const users = db.get('users').value();
  let sent = 0, failed = 0;
  for (const u of users) {
    try {
      await bot.sendMessage(u.telegram_id, message, { parse_mode: 'Markdown' });
      sent++;
    } catch (e) { failed++; }
  }
  addLog('admin', null, 'admin', 'broadcast', `sent: ${sent}, failed: ${failed}`);
  res.json({ ok: true, sent, failed });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  console.log(`🤖 Бот запущен`);
});

module.exports = { REFERRAL_BONUS };
