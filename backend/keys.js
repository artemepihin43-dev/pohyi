const crypto = require('crypto');
const db = require('./database');

// Generate a VPN key in WireGuard-style format
function generateVpnKey() {
  const prefix = 'VPN';
  const random = crypto.randomBytes(16).toString('hex').toUpperCase();
  const parts = random.match(/.{1,4}/g).join('-');
  return `${prefix}-${parts}`;
}

function addKey(planId, keyValue = null) {
  const key = keyValue || generateVpnKey();
  const stmt = db.prepare('INSERT INTO vpn_keys (key_value, plan_id) VALUES (?, ?)');
  stmt.run(key, planId);
  return key;
}

function addBulkKeys(planId, count) {
  const keys = [];
  const insert = db.prepare('INSERT OR IGNORE INTO vpn_keys (key_value, plan_id) VALUES (?, ?)');
  for (let i = 0; i < count; i++) {
    const key = generateVpnKey();
    insert.run(key, planId);
    keys.push(key);
  }
  return keys;
}

function getAvailableKey(planId) {
  return db.prepare(
    "SELECT * FROM vpn_keys WHERE plan_id = ? AND status = 'available' LIMIT 1"
  ).get(planId);
}

function markKeyUsed(keyId) {
  db.prepare("UPDATE vpn_keys SET status = 'used' WHERE id = ?").run(keyId);
}

function getKeyStats() {
  return db.prepare(`
    SELECT p.name,
           COUNT(CASE WHEN k.status = 'available' THEN 1 END) as available,
           COUNT(CASE WHEN k.status = 'used' THEN 1 END) as used
    FROM plans p
    LEFT JOIN vpn_keys k ON k.plan_id = p.id
    GROUP BY p.id, p.name
  `).all();
}

module.exports = { addKey, addBulkKeys, getAvailableKey, markKeyUsed, getKeyStats };
