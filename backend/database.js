const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');

// На облаке (Railway/Render) ставь DATA_DIR=/data для persistent volume
// Локально пишет в backend/db.json как раньше
const dataDir = process.env.DATA_DIR || __dirname;
const adapter = new FileSync(path.join(dataDir, 'db.json'));
const db = low(adapter);

db.defaults({
  plans: [
    { id: 4, name: '1 неделя', description: '7 дней. Безлимитный трафик.',                  duration_days: 7,   price: 6000,   active: true },
    { id: 1, name: '1 месяц',  description: '30 дней. Безлимитный трафик. Все серверы.',    duration_days: 30,  price: 19900,  active: true },
    { id: 2, name: '3 месяца', description: '90 дней. Безлимит. Скидка 20%. Все серверы.',  duration_days: 90,  price: 71700,  active: true },
    { id: 3, name: '1 год',    description: '365 дней. Безлимит. Лучшая цена!',             duration_days: 365, price: 239900, active: true }
  ],
  vpn_keys:  [],
  orders:    [],
  users:     [],
  referrals: [],
  logs:      []
}).write();

module.exports = db;
