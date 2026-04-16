const crypto = require('crypto');
const db = require('./database');

function generateVpnKey() {
  const prefix = 'VPN';
  const random = crypto.randomBytes(16).toString('hex').toUpperCase();
  const parts = random.match(/.{1,4}/g).join('-');
  return `${prefix}-${parts}`;
}

function addKey(planId, keyValue = null) {
  const key = keyValue || generateVpnKey();
  const id = Date.now();
  db.get('vpn_keys').push({ id, key_value: key, plan_id: planId, status: 'available', created_at: new Date().toISOString() }).write();
  return key;
}

function addBulkKeys(planId, count) {
  const keys = [];
  for (let i = 0; i < count; i++) {
    const key = generateVpnKey();
    const id = Date.now() + i;
    db.get('vpn_keys').push({ id, key_value: key, plan_id: planId, status: 'available', created_at: new Date().toISOString() }).write();
    keys.push(key);
  }
  return keys;
}

function getAvailableKey(planId) {
  return db.get('vpn_keys').find({ plan_id: planId, status: 'available' }).value();
}

function markKeyUsed(keyId) {
  db.get('vpn_keys').find({ id: keyId }).assign({ status: 'used' }).write();
}

module.exports = { addKey, addBulkKeys, getAvailableKey, markKeyUsed };
