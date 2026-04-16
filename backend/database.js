const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');

const adapter = new FileSync(path.join(__dirname, 'db.json'));
const db = low(adapter);

db.defaults({
  plans: [
    { id: 1, name: '1 МЕСЯЦ',  description: '30 дней. Безлимитный трафик. Все серверы.',   duration_days: 30,  price: 29900, active: true },
    { id: 2, name: '3 МЕСЯЦА', description: '90 дней. Безлимит. Скидка 20%. Все серверы.', duration_days: 90,  price: 71700, active: true },
    { id: 3, name: '1 ГОД',    description: '365 дней. Безлимит. Лучшая цена!',            duration_days: 365, price: 239900, active: true }
  ],
  vpn_keys:  [],
  orders:    [],
  users:     [],
  referrals: []
}).write();

module.exports = db;
