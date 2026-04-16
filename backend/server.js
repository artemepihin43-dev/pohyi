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

// Verify Telegram Web App init data
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

// GET /api/plans
app.get('/api/plans', (req, res) => {
  const plans = db.get('plans').filter({ active: true }).value();
  const result = plans.map(plan => {
    const inStock = db.get('vpn_keys').filter({ plan_id: plan.id, status: 'available' }).size().value() > 0;
    return { ...plan, in_stock: inStock };
  });
  res.json(result);
});

// POST /api/create-invoice
app.post('/api/create-invoice', (req, res) => {
  const { initData, planId } = req.body;
  const user = verifyTelegramData(initData);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const plan = db.get('plans').find({ id: planId, active: true }).value();
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const inStock = db.get('vpn_keys').filter({ plan_id: planId, status: 'available' }).size().value() > 0;
  if (!inStock) return res.status(400).json({ error: 'Out of stock' });

  db.get('orders').push({
    id: Date.now(),
    telegram_user_id: user.id,
    telegram_username: user.username || null,
    plan_id: planId,
    vpn_key_id: null,
    status: 'pending',
    payment_id: null,
    created_at: new Date().toISOString(),
    paid_at: null
  }).write();

  bot.sendInvoice(
    user.id,
    `VPN доступ — ${plan.name}`,
    plan.description,
    `plan_${plan.id}`,
    process.env.PAYMENT_PROVIDER_TOKEN,
    'RUB',
    [{ label: plan.name, amount: plan.price }],
    {
      need_name: false,
      need_email: false,
      need_phone_number: false,
    }
  ).then(() => {
    res.json({ ok: true, message: 'Счёт отправлен в Telegram' });
  }).catch(err => {
    console.error('Invoice error:', err.message);
    res.status(500).json({ error: 'Failed to send invoice' });
  });
});

// GET /api/orders
app.get('/api/orders', (req, res) => {
  const initData = req.headers['x-init-data'];
  const user = verifyTelegramData(initData);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const orders = db.get('orders').filter({ telegram_user_id: user.id }).value();
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
  if (!planId) return res.status(400).json({ error: 'planId required' });

  const plan = db.get('plans').find({ id: planId }).value();
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  let added;
  if (keys && Array.isArray(keys)) {
    keys.forEach((k, i) => {
      db.get('vpn_keys').push({ id: Date.now() + i, key_value: k, plan_id: planId, status: 'available', created_at: new Date().toISOString() }).write();
    });
    added = keys.length;
  } else {
    const generated = addBulkKeys(planId, count);
    added = generated.length;
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
    totalUsers: db.get('users').size().value()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🤖 Bot started`);
});
