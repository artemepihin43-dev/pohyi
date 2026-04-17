/**
 * Кастомный туннель через localtunnel.me
 * Использует node-fetch для регистрации (работает при DNS-проблемах на Windows)
 * и net.Socket для TCP-проксирования трафика.
 */
const net    = require('net');
const fs     = require('fs');
const path   = require('path');
const fetch  = require('node-fetch');

const LOCAL_PORT  = 3000;
const SUBDOMAIN   = 'xylivpnbot';
const LT_HOST     = 'localtunnel.me';
const FRONTEND    = path.join(__dirname, '..', 'frontend', 'app.js');
const DOCS        = path.join(__dirname, '..', 'docs',     'app.js');

let activeSockets = [];

function updateApiUrl(newUrl) {
  [FRONTEND, DOCS].forEach(file => {
    if (!fs.existsSync(file)) return;
    let c = fs.readFileSync(file, 'utf8');
    c = c.replace(/const API_URL = '.*?';/, `const API_URL = '${newUrl}';`);
    fs.writeFileSync(file, c, 'utf8');
  });
  console.log(`[tunnel] API_URL → ${newUrl}`);
  try {
    const { execSync } = require('child_process');
    const root = path.join(__dirname, '..');
    execSync('git add frontend/app.js docs/app.js', { cwd: root, stdio: 'pipe' });
    execSync(`git commit -m "tunnel: update API_URL to ${newUrl}"`, { cwd: root, stdio: 'pipe' });
    execSync('git push origin main', { cwd: root, stdio: 'pipe' });
    console.log('[tunnel] GitHub Pages обновлён');
  } catch (e) {
    if (!e.stderr?.toString().includes('nothing to commit')) {
      console.error('[tunnel] git push:', e.stderr?.toString().slice(0,120) || e.message);
    }
  }
}

// Открываем N постоянных TCP-соединений к серверу туннеля
function openWorker(remoteHost, remotePort, connId) {
  const remote = net.createConnection({ host: remoteHost, port: remotePort });
  remote.on('connect', () => {
    const local = net.createConnection({ host: '127.0.0.1', port: LOCAL_PORT });
    remote.pipe(local);
    local.pipe(remote);
    local.on('error', () => remote.destroy());
    remote.on('error', () => local.destroy());
    local.on('close', () => remote.destroy());
    remote.on('close', () => {
      local.destroy();
      // Открываем новое соединение взамен закрытого
      setTimeout(() => openWorker(remoteHost, remotePort, connId), 1000);
    });
  });
  remote.on('error', () => {
    setTimeout(() => openWorker(remoteHost, remotePort, connId), 2000);
  });
  activeSockets.push(remote);
}

async function startTunnel() {
  console.log(`[tunnel] Регистрация subdomain "${SUBDOMAIN}"...`);
  try {
    const res  = await fetch(`https://${LT_HOST}/${SUBDOMAIN}`, { timeout: 10000 });
    const info = await res.json();
    if (!info.url || !info.port) throw new Error('Некорректный ответ: ' + JSON.stringify(info));

    console.log(`[tunnel] ✅ ${info.url}  (remote port: ${info.port})`);
    updateApiUrl(info.url);

    // Закрываем старые соединения
    activeSockets.forEach(s => s.destroy());
    activeSockets = [];

    const maxConn = info.max_conn_count || 10;
    for (let i = 0; i < maxConn; i++) {
      openWorker(LT_HOST, info.port, i);
    }

    // Перерегистрируемся каждые 90 минут (на случай истечения сессии)
    setTimeout(startTunnel, 90 * 60 * 1000);

  } catch (e) {
    console.error('[tunnel] Ошибка:', e.message, '— retry через 10 сек');
    setTimeout(startTunnel, 10000);
  }
}

startTunnel();
