const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'vpn_keys.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    duration_days INTEGER NOT NULL,
    price INTEGER NOT NULL,
    currency TEXT DEFAULT 'RUB',
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS vpn_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_value TEXT NOT NULL UNIQUE,
    plan_id INTEGER,
    status TEXT DEFAULT 'available',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (plan_id) REFERENCES plans(id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id INTEGER NOT NULL,
    telegram_username TEXT,
    plan_id INTEGER NOT NULL,
    vpn_key_id INTEGER,
    status TEXT DEFAULT 'pending',
    payment_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    paid_at TEXT,
    FOREIGN KEY (plan_id) REFERENCES plans(id),
    FOREIGN KEY (vpn_key_id) REFERENCES vpn_keys(id)
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL UNIQUE,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed default plans if empty
const plansCount = db.prepare('SELECT COUNT(*) as cnt FROM plans').get();
if (plansCount.cnt === 0) {
  const insert = db.prepare(
    'INSERT INTO plans (name, description, duration_days, price) VALUES (?, ?, ?, ?)'
  );
  insert.run('1 месяц', '30 дней доступа к VPN. Безлимитный трафик.', 30, 29900);
  insert.run('3 месяца', '90 дней доступа к VPN. Безлимитный трафик. Скидка 20%.', 90, 71700);
  insert.run('1 год', '365 дней доступа к VPN. Безлимитный трафик. Лучшая цена!', 365, 239900);
}

module.exports = db;
