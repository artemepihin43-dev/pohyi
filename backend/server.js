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

// GET /api/plans — list available plans
app.get('/api/plans', (req, res) => {
  const plans = db.prepare('SELECT * FROM plans WHERE active = 1').all();
  const plansWithStock = plans.map(plan => {
    const stock = db.prepare(
      "SELECT COUNT(*) as cnt FROM vpn_keys WHERE plan_id = ? AND status = 'available'"
    ).get(plan.id);
    return { ...plan, in_stock: stock.cnt > 0 };
  });
  res.json(plansWithStock);
});

// POST /api/create-invoice — create Telegram payment invoice
app.post('/api/create-invoice', (req, res) => {
  const { initData, planId } = req.body;
  const user = verifyTelegramData(initData);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND active = 1').get(planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const stock = db.prepare(
    "SELECT COUNT(*) as cnt FROM vpn_keys WHERE plan_id = ? AND status = 'available'"
  ).get(planId);
  if (stock.cnt === 0) return res.status(400).json({ error: 'Out of stock' });

  // Create pending order
  db.prepare(`
    INSERT INTO orders (telegram_user_id, telegram_username, plan_id)
    VALUES (?, ?, ?)
  `).run(user.id, user.username || null, planId);

  // Send invoice via bot
  bot.sendInvoice(
    user.id,
    `VPN доступ — ${plan.name}`,
    plan.description,
    `plan_${plan.id}`,
    process.env.PAYMENT_PROVIDER_TOKEN,
    'RUB',
    [{ label: plan.name, amount: plan.price }],
    {
      photo_url: 'https://i.imgur.com/7H8JLEC.png',
      need_name: false,
      need_email: false,
      need_phone_number: false,
    }
  ).then(() => {
    res.json({ ok: true, message: 'Счёт отправлен в Telegram' });
  }).catch(err => {
    console.error('Invoice error:', err);
    res.status(500).json({ error: 'Failed to send invoice' });
  });
});

// GET /api/orders — get user orders
app.get('/api/orders', (req, res) => {
  const initData = req.headers['x-init-data'];
  const user = verifyTelegramData(initData);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const orders = db.prepare(`
    SELECT o.id, o.status, o.created_at, o.paid_at,
           p.name as plan_name, p.duration_days,
           k.key_value
    FROM orders o
    JOIN plans p ON p.id = o.plan_id
    LEFT JOIN vpn_keys k ON k.id = o.vpn_key_id
    WHERE o.telegram_user_id = ?
    ORDER BY o.created_at DESC
    LIMIT 20
  `).all(user.id);

  res.json(orders);
});

// POST /api/admin/keys — add keys (admin only)
app.post('/api/admin/keys', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { planId, count = 10, keys } = req.body;
  if (!planId) return res.status(400).json({ error: 'planId required' });

  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  let added;
  if (keys && Array.isArray(keys)) {
    const insert = db.prepare('INSERT OR IGNORE INTO vpn_keys (key_value, plan_id) VALUES (?, ?)');
    keys.forEach(k => insert.run(k, planId));
    added = keys.length;
  } else {
    const generated = addBulkKeys(planId, count);
    added = generated.length;
  }

  res.json({ ok: true, added, plan: plan.name });
});

// GET /api/admin/stats — stats (admin only)
app.get('/api/admin/stats', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const plans = db.prepare('SELECT * FROM plans').all();
  const stats = plans.map(p => {
    const available = db.prepare("SELECT COUNT(*) as cnt FROM vpn_keys WHERE plan_id = ? AND status = 'available'").get(p.id);
    const used = db.prepare("SELECT COUNT(*) as cnt FROM vpn_keys WHERE plan_id = ? AND status = 'used'").get(p.id);
    return { plan: p.name, available: available.cnt, used: used.cnt };
  });

  const totalOrders = db.prepare("SELECT COUNT(*) as cnt FROM orders WHERE status = 'paid'").get();
  const revenue = db.prepare("SELECT SUM(p.price) as total FROM orders o JOIN plans p ON p.id = o.plan_id WHERE o.status = 'paid'").get();
  const totalUsers = db.prepare('SELECT COUNT(*) as cnt FROM users').get();

  res.json({ stats, totalOrders: totalOrders.cnt, revenue: revenue.total || 0, totalUsers: totalUsers.cnt });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🤖 Bot started`);
});
