const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');

const adapter = new FileSync(path.join(__dirname, 'db.json'));
const db = low(adapter);

db.defaults({
  plans: [
    { id: 1, name: '1 месяц',  description: '30 дней доступа к VPN. Безлимитный трафик.',                      duration_days: 30,  price: 29900, active: true },
    { id: 2, name: '3 месяца', description: '90 дней доступа к VPN. Безлимитный трафик. Скидка 20%.',          duration_days: 90,  price: 71700, active: true },
    { id: 3, name: '1 год',    description: '365 дней доступа к VPN. Безлимитный трафик. Лучшая цена!',       duration_days: 365, price: 239900, active: true }
  ],
  vpn_keys: [],
  orders:   [],
  users:    []
}).write();

module.exports = db;
