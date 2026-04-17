/**
 * Туннель через localtunnel.me с фиксированным поддоменом.
 * URL всегда: https://xylivpnbot.loca.lt
 * Если поддомен занят — ждём и retry каждые 30с.
 * Git push больше не нужен — URL не меняется.
 */
const net   = require('net');
const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

const LOCAL_PORT = 3000;
const SUBDOMAIN  = 'xylivpnbot';
const TARGET_URL = `https://${SUBDOMAIN}.loca.lt`;
const LT_HOST    = 'localtunnel.me';

function getProxyUrl() {
  return process.env.HTTPS_PROXY || process.env.HTTP_PROXY
      || process.env.https_proxy  || process.env.http_proxy || null;
}

async function register() {
  // Попытка 1: прямой запрос (node-fetch игнорирует HTTPS_PROXY)
  try {
    const res = await fetch(`https://${LT_HOST}/${SUBDOMAIN}`, { timeout: 8000 });
    const info = await res.json();
    if (info.url && info.port) return { info, viaProxy: false };
  } catch (_) {}

  // Попытка 2: через прокси
  const proxyUrl = getProxyUrl();
  if (proxyUrl) {
    try {
      const agent = new HttpsProxyAgent(proxyUrl);
      const res = await fetch(`https://${LT_HOST}/${SUBDOMAIN}`, { agent, timeout: 12000 });
      const info = await res.json();
      if (info.url && info.port) return { info, viaProxy: true };
    } catch (_) {}
  }

  throw new Error('Не удалось зарегистрировать туннель');
}

function connectViaProxy(proxyUrl, targetHost, targetPort) {
  const p = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: p.hostname, port: parseInt(p.port) || 1080 });
    let done = false, buf = '';
    socket.once('connect', () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });
    socket.on('data', chunk => {
      if (done) return;
      buf += chunk.toString('ascii');
      if (buf.includes('\r\n\r\n')) {
        done = true;
        socket.removeAllListeners('data');
        buf.split('\r\n')[0].includes('200')
          ? resolve(socket)
          : (socket.destroy(), reject(new Error('Proxy CONNECT failed')));
      }
    });
    socket.once('error', reject);
    socket.once('close', () => { if (!done) reject(new Error('proxy closed')); });
    setTimeout(() => { if (!done) { socket.destroy(); reject(new Error('proxy timeout')); } }, 8000);
  });
}

// ─── состояние ────────────────────────────────────────
let currentPort   = null;
let currentHost   = LT_HOST;
let viaProxy      = false;
let sessionEverConnected = false;
let workerFails   = 0;
let maxConn       = 2;
let renewTimer    = null;
let retryTimer    = null;
let isStarting    = false;

function clearTimers() {
  if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}

// ─── воркер ───────────────────────────────────────────
function openWorker(id) {
  if (currentPort === null) return;
  const port = currentPort;

  let dead = false;
  function die(econnrefused = false) {
    if (dead) return;
    dead = true;
    if (econnrefused) {
      workerFails++;
      if (workerFails >= maxConn) {
        console.log('[tunnel] Все воркеры ECONNREFUSED → перерегистрация');
        currentPort = null;
        startTunnel();
        return;
      }
    }
    if (currentPort === port) setTimeout(() => openWorker(id), 500);
  }

  let remotePromise;
  if (viaProxy) {
    const proxyUrl = getProxyUrl();
    remotePromise = connectViaProxy(proxyUrl, LT_HOST, port)
      .catch(() => { die(true); return null; });
  } else {
    remotePromise = Promise.resolve(net.connect({ host: currentHost, port }));
  }

  remotePromise.then(remote => {
    if (!remote || dead) return;
    remote.setKeepAlive(true);
    remote.pause();

    if (viaProxy) {
      setupPipes(remote);
    } else {
      remote.once('connect', () => {
        sessionEverConnected = true;
        workerFails = 0;
        setupPipes(remote);
      });
      remote.once('error', err => die(err.code === 'ECONNREFUSED'));
    }
  });

  function setupPipes(remote) {
    if (dead) { remote.destroy(); return; }
    const local = net.connect({ host: '127.0.0.1', port: LOCAL_PORT });
    const onRemoteClose = () => { local.destroy(); die(); };
    remote.once('close', onRemoteClose);
    remote.once('error', () => { local.destroy(); die(); });
    local.once('error', err => {
      local.destroy();
      remote.removeListener('close', onRemoteClose);
      if (err.code === 'ECONNREFUSED') {
        if (!dead) setTimeout(() => setupPipes(remote), 1000);
      } else { remote.destroy(); die(); }
    });
    local.once('connect', () => {
      remote.pipe(local);
      local.pipe(remote);
      remote.resume();
      local.once('close', () => die());
    });
  }
}

function spawnWorkers() {
  sessionEverConnected = false;
  workerFails = 0;
  console.log(`[tunnel] Спавним ${maxConn} воркеров → ${currentHost}:${currentPort}`);
  for (let i = 0; i < maxConn; i++) openWorker(i);
}

// ─── регистрация ──────────────────────────────────────
let failCount = 0;

async function startTunnel() {
  if (isStarting) return;
  isStarting = true;
  clearTimers();
  console.log('[tunnel] Регистрация...');

  try {
    const { info, viaProxy: usedProxy } = await register();

    if (info.url !== TARGET_URL) {
      // Получили чужой поддомен — ждём пока наш освободится
      console.log(`[tunnel] Получен ${info.url} вместо ${TARGET_URL} — retry через 30с`);
      isStarting = false;
      failCount++;
      retryTimer = setTimeout(startTunnel, 30000);
      return;
    }

    // Нужный поддомен получен
    failCount = 0;
    isStarting = false;
    viaProxy = usedProxy;
    maxConn = info.max_conn_count || 2;
    console.log(`[tunnel] ✅ ${info.url}  port:${info.port}  workers:${maxConn}  proxy:${viaProxy}`);

    currentPort = null; // сбрасываем старых воркеров
    currentPort = info.port;
    spawnWorkers();

    // Плановая перерегистрация раз в 8 минут (сессия живёт ~10 мин)
    renewTimer = setTimeout(() => {
      console.log('[tunnel] Плановая перерегистрация');
      currentPort = null;
      startTunnel();
    }, 8 * 60 * 1000);

  } catch (e) {
    isStarting = false;
    failCount++;
    const ms = Math.min(10000 * failCount, 60000);
    console.error(`[tunnel] Ошибка: ${e.message?.slice(0, 100)} — retry ${Math.round(ms/1000)}с`);
    retryTimer = setTimeout(startTunnel, ms);
  }
}

startTunnel();
