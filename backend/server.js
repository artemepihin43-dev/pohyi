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

// Webhook для Telegram бота
app.post(`/webhook/${process.env.BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

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
    referral_pending: pendingReferrals,
    is_admin: tgUser.id === parseInt(process.env.ADMIN_TELEGRAM_ID)
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

function adminTgAuth(req, res, next) {
  const initData = req.headers['x-init-data'];
  const tgUser = verifyTelegramData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  if (tgUser.id !== parseInt(process.env.ADMIN_TELEGRAM_ID)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  req.tgUser = tgUser;
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

// ─── ADMIN TG (авторизация через Telegram initData) ───────────────────────

// GET /api/admin/tg/users — список пользователей
app.get('/api/admin/tg/users', adminTgAuth, (req, res) => {
  const users = db.get('users').value();
  const result = users.map(u => ({
    telegram_id: u.telegram_id,
    username: u.username,
    first_name: u.first_name,
    last_name: u.last_name,
    balance: u.balance,
    created_at: u.created_at,
    paid_orders: db.get('orders').filter({ telegram_user_id: u.telegram_id, status: 'paid' }).size().value()
  }));
  res.json(result);
});

// GET /api/admin/tg/plans — тарифы с количеством ключей
app.get('/api/admin/tg/plans', adminTgAuth, (req, res) => {
  const plans = db.get('plans').value();
  const result = plans.map(p => ({
    ...p,
    available: db.get('vpn_keys').filter({ plan_id: p.id, status: 'available' }).size().value(),
    used:      db.get('vpn_keys').filter({ plan_id: p.id, status: 'used' }).size().value()
  }));
  res.json(result);
});

// POST /api/admin/tg/keys — загрузить серверы/ключи для тарифа
app.post('/api/admin/tg/keys', adminTgAuth, (req, res) => {
  const { plan_id, keys } = req.body;
  if (!plan_id || !Array.isArray(keys) || !keys.length) {
    return res.status(400).json({ error: 'Нужны plan_id и массив ключей' });
  }
  const plan = db.get('plans').find({ id: plan_id }).value();
  if (!plan) return res.status(404).json({ error: 'Тариф не найден' });

  const clean = keys.map(k => k.trim()).filter(Boolean);
  clean.forEach((k, i) => {
    db.get('vpn_keys').push({
      id: Date.now() + i,
      key_value: k,
      plan_id,
      status: 'available',
      created_at: new Date().toISOString()
    }).write();
  });
  addLog('admin', req.tgUser.id, req.tgUser.username, 'add_keys',
    `plan: ${plan.name}, +${clean.length} ключей`);
  res.json({ ok: true, added: clean.length });
});

// GET /api/admin/tg/keys-list — список ключей тарифа
app.get('/api/admin/tg/keys-list', adminTgAuth, (req, res) => {
  const planId = req.query.plan_id ? parseInt(req.query.plan_id) : null;
  const keys = planId
    ? db.get('vpn_keys').filter({ plan_id: planId }).value()
    : db.get('vpn_keys').value();
  res.json(keys.slice().reverse());
});

// DELETE /api/admin/tg/keys/:id — удалить ключ
app.delete('/api/admin/tg/keys/:id', adminTgAuth, (req, res) => {
  const id = parseFloat(req.params.id);
  const key = db.get('vpn_keys').find({ id }).value();
  if (!key) return res.status(404).json({ error: 'Ключ не найден' });
  db.get('vpn_keys').remove({ id }).write();
  addLog('admin', req.tgUser.id, req.tgUser.username, 'delete_key', `key: ${key.key_value}`);
  res.json({ ok: true });
});

// POST /api/admin/tg/topup — пополнить баланс пользователя
app.post('/api/admin/tg/topup', adminTgAuth, (req, res) => {
  const { telegram_id, amount } = req.body;
  if (!telegram_id || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'Нужны telegram_id и amount (рублей)' });
  }
  const user = db.get('users').find({ telegram_id }).value();
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const kopeks = Math.round(amount * 100);
  const newBalance = user.balance + kopeks;
  db.get('users').find({ telegram_id }).assign({ balance: newBalance }).write();
  addLog('admin', req.tgUser.id, req.tgUser.username, 'topup_balance',
    `user: ${telegram_id}, +${kopeks} коп. → итого: ${newBalance} коп.`);

  const rubles = (newBalance / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2 });
  bot.sendMessage(telegram_id,
    `💰 *Баланс пополнен!*\n\nЗачислено: *+${amount} ₽*\nВаш баланс: *${rubles} ₽*`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});

  res.json({ ok: true, new_balance: newBalance });
});

// ─── TON PAYMENTS ────────────────────────────────────────

let tonRateRub = 0;
let tonRateUpdatedAt = 0;

function httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = require('https').request({ hostname, path, method: 'GET' }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchTonRate() {
  try {
    const json = await httpsGet(
      'api.coingecko.com',
      '/api/v3/simple/price?ids=the-open-network&vs_currencies=rub'
    );
    const rate = json['the-open-network']?.rub;
    if (rate > 0) {
      tonRateRub = rate;
      tonRateUpdatedAt = Date.now();
      console.log(`💎 TON/RUB = ${rate}`);
    }
  } catch (e) { console.error('TON rate error:', e.message); }
}

async function checkTonTransactions() {
  const walletAddress = process.env.TON_WALLET_ADDRESS;
  const apiKey = process.env.TON_API_KEY;
  if (!walletAddress || walletAddress.includes('YOUR_TON') || !apiKey) return;

  const pending = db.get('ton_payments').filter({ status: 'pending' }).value();
  if (!pending.length) return;

  try {
    const json = await httpsGet(
      'toncenter.com',
      `/api/v2/getTransactions?address=${encodeURIComponent(walletAddress)}&limit=50&api_key=${apiKey}`
    );
    if (!json.ok || !Array.isArray(json.result)) return;

    for (const tx of json.result) {
      const comment = tx.in_msg?.message || '';
      const valueNano = parseInt(tx.in_msg?.value || '0');
      const utime = (tx.utime || 0) * 1000;
      if (!comment || valueNano <= 0) continue;

      const payment = pending.find(p =>
        p.comment === comment &&
        p.status === 'pending' &&
        utime >= new Date(p.created_at).getTime() - 5 * 60 * 1000
      );
      if (!payment) continue;

      // Проверяем что прислали >= 97% ожидаемой суммы
      const expectedNano = Math.floor(payment.amount_ton * 1e9);
      if (valueNano < Math.floor(expectedNano * 0.97)) continue;

      const user = db.get('users').find({ telegram_id: payment.telegram_id }).value();
      if (!user) continue;

      const kopeks = Math.round(payment.amount_rub * 100);
      const newBalance = (user.balance || 0) + kopeks;
      db.get('users').find({ telegram_id: payment.telegram_id }).assign({ balance: newBalance }).write();
      db.get('ton_payments').find({ id: payment.id }).assign({
        status: 'paid',
        paid_at: new Date().toISOString(),
        tx_hash: tx.transaction_id?.hash || null
      }).write();

      addLog('payment', payment.telegram_id, null, 'ton_topup',
        `+${payment.amount_rub} RUB / ${payment.amount_ton} TON`);

      const rubles = (newBalance / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2 });
      bot.sendMessage(payment.telegram_id,
        `💎 *TON-платёж подтверждён!*\n\n` +
        `Зачислено: *+${payment.amount_rub} ₽*\n` +
        `Баланс: *${rubles} ₽*`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
  } catch (e) { console.error('TON check error:', e.message); }
}

// Курс — раз в час, проверка транзакций — раз в минуту
fetchTonRate();
setInterval(fetchTonRate, 60 * 60 * 1000);
setInterval(checkTonTransactions, 60 * 1000);

// GET /api/topup/ton/rate
app.get('/api/topup/ton/rate', (req, res) => {
  res.json({ rate: tonRateRub, updated_at: tonRateUpdatedAt });
});

// POST /api/topup/ton/create
app.post('/api/topup/ton/create', (req, res) => {
  const initData = req.headers['x-init-data'];
  const tgUser = verifyTelegramData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  if (!tonRateRub) return res.status(503).json({ error: 'Курс TON недоступен, попробуй позже' });

  const walletAddress = process.env.TON_WALLET_ADDRESS;
  if (!walletAddress || walletAddress.includes('YOUR_TON')) {
    return res.status(503).json({ error: 'Кошелёк не настроен' });
  }

  const amount_rub = Number(req.body.amount_rub);
  if (!amount_rub || amount_rub < 50) return res.status(400).json({ error: 'Минимум 50 ₽' });

  const amount_ton = parseFloat((amount_rub / tonRateRub).toFixed(4));
  const comment = `XYLI${tgUser.id}`;

  const existing = db.get('ton_payments').find({ telegram_id: tgUser.id, status: 'pending' }).value();
  if (existing) {
    db.get('ton_payments').find({ id: existing.id }).assign({
      amount_rub, amount_ton, created_at: new Date().toISOString()
    }).write();
  } else {
    db.get('ton_payments').push({
      id: Date.now(), telegram_id: tgUser.id,
      amount_rub, amount_ton, comment, status: 'pending',
      created_at: new Date().toISOString(), paid_at: null, tx_hash: null
    }).write();
  }

  res.json({ ok: true, wallet: walletAddress, amount_ton, amount_rub, comment, rate: tonRateRub });
});

// GET /api/topup/ton/status
app.get('/api/topup/ton/status', (req, res) => {
  const initData = req.headers['x-init-data'];
  const tgUser = verifyTelegramData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

  const payments = db.get('ton_payments').filter({ telegram_id: tgUser.id }).value();
  const payment = payments.sort((a, b) => b.id - a.id)[0];
  if (!payment) return res.json({ status: 'none' });

  if (payment.status === 'pending') {
    const age = Date.now() - new Date(payment.created_at).getTime();
    if (age > 30 * 60 * 1000) {
      db.get('ton_payments').find({ id: payment.id }).assign({ status: 'expired' }).write();
      return res.json({ status: 'expired' });
    }
  }
  res.json({ status: payment.status, payment });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);

  // Если Railway — устанавливаем webhook
  const railwayUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : process.env.WEBHOOK_URL;

  if (railwayUrl && process.env.BOT_TOKEN) {
    const webhookUrl = `${railwayUrl}/webhook/${process.env.BOT_TOKEN}`;
    try {
      await bot.setWebHook(webhookUrl);
      console.log(`🔗 Webhook установлен: ${webhookUrl}`);
    } catch (e) {
      console.error('Webhook error:', e.message);
    }
  } else {
    console.log(`🤖 Бот запущен (polling)`);
  }

  // Кнопка меню рядом со строкой ввода — используем bot._request через его соединение
  const webAppUrl = process.env.WEB_APP_URL;
  if (webAppUrl) {
    bot._request('setChatMenuButton', {
      qs: { menu_button: JSON.stringify({ type: 'web_app', text: '🛒 Открыть', web_app: { url: webAppUrl } }) }
    }).then(() => console.log('🔘 Кнопка меню установлена'))
      .catch(e => console.error('Menu button error:', e.message));
  }
});

module.exports = { REFERRAL_BONUS };
