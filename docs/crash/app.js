/* ════════════════════════════════════════════════════════
   CrashGame Frontend — GitHub Pages version
   API URL passed via ?api=https://... query param
   ════════════════════════════════════════════════════════ */

const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const tgUser = tg?.initDataUnsafe?.user || {};
const MY_ID = String(tgUser.id || 'demo_' + Math.random().toString(36).slice(2, 8));
const MY_NAME = tgUser.first_name || 'Player';
const MY_USERNAME = tgUser.username || '';

// ─── API base: read from ?api= param ─────────────────────────
const _params = new URLSearchParams(window.location.search);
const BASE = (_params.get('api') || '').replace(/\/$/, '');
const WS_URL = BASE.replace(/^http/, 'ws');

// Bypass localtunnel reminder header
const EXTRA_HEADERS = { 'bypass-tunnel-reminder': 'true' };

if (!BASE) {
  document.body.innerHTML = '<div style="color:#ff4757;padding:40px;text-align:center;font-size:18px">❌ Ошибка: не указан API URL.<br>Открой через бота.</div>';
  throw new Error('No API URL');
}

// ─── State ───────────────────────────────────────────────────
let balance = 0;
let gameState = 'WAITING';
let currentMultiplier = 1.00;
let myBet = null;
let currentHash = '';
let ws = null;
let countdownInterval = null;
let countdownEnd = 0;
let points = [];
let crashedAt = null;

// ─── Canvas ──────────────────────────────────────────────────
const canvas = document.getElementById('crashCanvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * devicePixelRatio;
  canvas.height = rect.height * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  drawCanvas();
}

function drawCanvas() {
  const W = canvas.width / devicePixelRatio;
  const H = canvas.height / devicePixelRatio;
  ctx.clearRect(0, 0, W, H);
  drawGrid(W, H);
  if (gameState === 'WAITING' || points.length < 2) return;

  const maxMult = Math.max(currentMultiplier * 1.1, 2);
  const padL = 10, padR = 10, padT = 10, padB = 10;
  const gW = W - padL - padR, gH = H - padT - padB;
  const toX = i => padL + (i / (points.length - 1)) * gW;
  const toY = m => padT + gH - ((m - 1) / (maxMult - 1)) * gH;

  const grad = ctx.createLinearGradient(0, 0, 0, H);
  const isRed = gameState === 'CRASHED';
  grad.addColorStop(0, isRed ? 'rgba(255,71,87,0.3)' : 'rgba(0,200,150,0.3)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');

  ctx.beginPath();
  ctx.moveTo(toX(0), toY(points[0]));
  for (let i = 1; i < points.length; i++) ctx.lineTo(toX(i), toY(points[i]));
  ctx.lineTo(toX(points.length - 1), H - padB);
  ctx.lineTo(toX(0), H - padB);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(toX(0), toY(points[0]));
  for (let i = 1; i < points.length; i++) ctx.lineTo(toX(i), toY(points[i]));
  ctx.strokeStyle = isRed ? '#ff4757' : '#00c896';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  const tipX = toX(points.length - 1), tipY = toY(points[points.length - 1]);
  ctx.beginPath();
  ctx.arc(tipX, tipY, 5, 0, Math.PI * 2);
  ctx.fillStyle = isRed ? '#ff4757' : '#00c896';
  ctx.fill();
  if (gameState === 'RUNNING') { ctx.font = '18px serif'; ctx.fillText('🚀', tipX - 9, tipY - 8); }
}

function drawGrid(W, H) {
  ctx.strokeStyle = 'rgba(42,42,64,0.5)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) { ctx.beginPath(); ctx.moveTo((W/5)*i,0); ctx.lineTo((W/5)*i,H); ctx.stroke(); }
  for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(0,(H/4)*i); ctx.lineTo(W,(H/4)*i); ctx.stroke(); }
}

// ─── WebSocket + polling fallback ────────────────────────────
let wsConnected = false;
let pollInterval = null;
let wsReconnectTimer = null;
let lastPollState = null;
let lastPollRoundId = null;

function connectWS() {
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  try { ws = new WebSocket(WS_URL); } catch(e) { startPolling(); return; }

  const timeout = setTimeout(() => {
    if (!wsConnected) { ws.close(); startPolling(); }
  }, 5000);

  ws.onopen = () => { wsConnected = true; clearTimeout(timeout); stopPolling(); };
  ws.onmessage = ev => { try { handleMessage(JSON.parse(ev.data)); } catch(e) {} };
  ws.onclose = () => { wsConnected = false; wsReconnectTimer = setTimeout(connectWS, 3000); startPolling(); };
  ws.onerror = () => { wsConnected = false; };
  setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type:'PING'})); }, 20000);
}

function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(async () => {
    if (wsConnected) { stopPolling(); return; }
    try {
      const s = await apiFetch('/api/state');
      const prevState = lastPollState, prevRound = lastPollRoundId;
      lastPollState = s.state; lastPollRoundId = s.roundId;
      if (prevRound && s.roundId !== prevRound && s.state === 'WAITING') { handleMessage({type:'WAITING',...s}); return; }
      if (s.state === 'RUNNING' && prevState !== 'RUNNING') handleMessage({type:'START',...s});
      if (s.state === 'CRASHED' && prevState === 'RUNNING') { handleMessage({type:'CRASHED',crashPoint:s.multiplier,...s}); return; }
      handleMessage({type:'STATE',...s});
    } catch(e) {}
  }, 500);
}
function stopPolling() { if (pollInterval) { clearInterval(pollInterval); pollInterval = null; } }

// ─── Message handler ──────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'STATE':
      gameState = msg.state; currentMultiplier = msg.multiplier || 1;
      if (msg.history) updateHistoryStrip(msg.history);
      if (msg.hash) { currentHash = msg.hash; updateHashDisplay(); }
      updateBetsTable(msg.bets || []);
      if (gameState === 'WAITING') setWaitingUI();
      else if (gameState === 'RUNNING') { setRunningUI(); if (!points.length) points = [1]; }
      else if (gameState === 'CRASHED') setCrashedUI(currentMultiplier);
      break;
    case 'WAITING':
      gameState = 'WAITING'; points = []; crashedAt = null;
      currentHash = msg.hash || ''; updateHashDisplay();
      if (msg.history) updateHistoryStrip(msg.history);
      setWaitingUI(msg.timeLeft); updateBetsTable([]); break;
    case 'START':
      gameState = 'RUNNING'; currentMultiplier = 1; points = [1];
      clearCountdown(); setRunningUI(); updateBetsTable(msg.bets || []); break;
    case 'TICK':
      currentMultiplier = msg.multiplier; points.push(currentMultiplier);
      updateMultiplierDisplay(); updateBetsTable(msg.bets || []); drawCanvas(); break;
    case 'CRASHED':
      gameState = 'CRASHED'; crashedAt = msg.crashPoint; points.push(msg.crashPoint);
      setCrashedUI(msg.crashPoint); updateBetsTable(msg.bets || []); drawCanvas();
      if (myBet && !myBet.cashedOut) { showToast(`💥 Краш ${msg.crashPoint}x — ставка сгорела`, 'red'); myBet = null; updateBetButton(); }
      break;
    case 'BET_PLACED': case 'BET_CANCELLED': updateBetsTable(msg.bets || []); break;
    case 'CASHOUT':
      updateBetsTable(msg.bets || []);
      if (String(msg.userId) === MY_ID) {
        showToast(`✅ Выведено ${msg.winAmount} × ${msg.multiplier}x`, 'green');
        myBet = { ...myBet, cashedOut: true }; updateBetButton(); refreshBalance();
      }
      break;
  }
}

// ─── UI ───────────────────────────────────────────────────────
function setWaitingUI(timeLeftMs) {
  const m = document.getElementById('multiplier-value');
  m.textContent = '🕐'; m.className = 'multiplier-value waiting';
  m.style.color = ''; m.style.textShadow = '';
  document.getElementById('multiplier-label').textContent = 'Принимаем ставки...';
  if (timeLeftMs) { countdownEnd = Date.now() + timeLeftMs; startCountdown(); }
  updateBetButton(); drawCanvas();
}

function setRunningUI() {
  document.getElementById('multiplier-value').className = 'multiplier-value';
  document.getElementById('multiplier-label').textContent = 'В ПОЛЁТЕ';
  document.getElementById('countdown-overlay').style.display = 'none';
  updateBetButton(); updateMultiplierDisplay();
}

function setCrashedUI(cp) {
  const m = document.getElementById('multiplier-value');
  m.textContent = `${cp}x`; m.className = 'multiplier-value crashed';
  m.style.color = ''; m.style.textShadow = '';
  document.getElementById('multiplier-label').textContent = '💥 КРАШ!';
  document.getElementById('countdown-overlay').style.display = 'none';
  updateBetButton();
}

function updateMultiplierDisplay() {
  const m = document.getElementById('multiplier-value');
  m.textContent = `${currentMultiplier.toFixed(2)}x`;
  if (currentMultiplier >= 10) { m.style.color = '#a78bfa'; m.style.textShadow = '0 0 30px rgba(167,139,250,0.6)'; }
  else if (currentMultiplier >= 3) { m.style.color = '#ffd700'; m.style.textShadow = '0 0 30px rgba(255,215,0,0.5)'; }
  else { m.style.color = '#00c896'; m.style.textShadow = '0 0 30px rgba(0,200,150,0.5)'; }
}

function startCountdown() {
  clearCountdown();
  document.getElementById('countdown-overlay').style.display = 'flex';
  const val = document.getElementById('countdown-value');
  countdownInterval = setInterval(() => {
    const left = Math.max(0, Math.ceil((countdownEnd - Date.now()) / 1000));
    val.textContent = left;
    if (left <= 0) clearCountdown();
  }, 200);
}
function clearCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  document.getElementById('countdown-overlay').style.display = 'none';
}

function updateHistoryStrip(history) {
  document.getElementById('history-strip').innerHTML = history.map(r => {
    const v = parseFloat(r.crashPoint);
    return `<span class="hist-chip ${v<1.5?'low':v<5?'mid':'high'}">${v.toFixed(2)}x</span>`;
  }).join('');
}

function updateBetsTable(bets) {
  document.getElementById('bets-count').textContent = bets.length;
  document.getElementById('bets-tbody').innerHTML = bets.map(b => {
    const cls = b.cashedOut ? 'cashed-out' : (gameState === 'CRASHED' ? 'lost' : '');
    const co = b.cashedOut ? `${b.cashoutMultiplier.toFixed(2)}x` : '—';
    const pr = b.cashedOut ? `+${b.profit}` : '—';
    const name = b.username ? `@${b.username}` : b.firstName;
    return `<tr class="${cls}"><td>${name}${String(b.userId)===MY_ID?' ★':''}</td><td>${b.amount}</td><td>${co}</td><td>${pr}</td></tr>`;
  }).join('');
}

function updateBetButton() {
  const btn = document.getElementById('btn-bet');
  const txt = document.getElementById('btn-bet-text');
  btn.className = 'btn-bet';
  if (gameState === 'WAITING') {
    if (myBet) { txt.textContent = '❌ Отменить ставку'; btn.classList.add('cancel'); }
    else txt.textContent = '🎯 Поставить';
  } else if (gameState === 'RUNNING' && myBet && !myBet.cashedOut) {
    txt.textContent = `💸 Вывести (${currentMultiplier.toFixed(2)}x)`; btn.classList.add('cashout');
  } else {
    txt.textContent = '⏳ Ждите следующего раунда'; btn.classList.add('disabled');
  }
}

async function handleBetButton() {
  if (gameState === 'WAITING') { myBet ? await cancelBet() : await placeBet(); }
  else if (gameState === 'RUNNING' && myBet && !myBet.cashedOut) await cashOut();
}

async function placeBet() {
  const amount = parseFloat(document.getElementById('bet-amount').value);
  const check = document.getElementById('auto-cashout-check').checked;
  const autoCashout = check ? parseFloat(document.getElementById('auto-cashout-value').value) : null;
  if (!amount || amount <= 0) { showToast('Введите сумму ставки', 'red'); return; }
  try {
    const res = await apiPost('/api/bet', { userId: MY_ID, amount, autoCashout, username: MY_USERNAME, firstName: MY_NAME });
    if (res.success) { myBet = { amount, autoCashout, cashedOut: false }; balance = res.balance; updateBalanceDisplay(); updateBetButton(); showToast(`✅ Ставка ${amount} принята`, 'green'); }
    else showToast(res.error || 'Ошибка', 'red');
  } catch(e) { showToast('Ошибка сети', 'red'); }
}

async function cashOut() {
  try {
    const res = await apiPost('/api/cashout', { userId: MY_ID });
    if (res.success) { balance = res.balance; myBet = {...myBet, cashedOut: true}; updateBalanceDisplay(); updateBetButton(); }
    else showToast(res.error || 'Ошибка', 'red');
  } catch(e) { showToast('Ошибка сети', 'red'); }
}

async function cancelBet() {
  try {
    const res = await apiPost('/api/cancel', { userId: MY_ID });
    if (res.success) { myBet = null; balance = res.balance; updateBalanceDisplay(); updateBetButton(); showToast('Ставка отменена'); }
    else showToast(res.error || 'Ошибка', 'red');
  } catch(e) { showToast('Ошибка сети', 'red'); }
}

function openTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${name}`));
  if (name === 'history') loadHistory();
  if (name === 'leaderboard') loadLeaderboard();
  if (name === 'profile') updateProfile();
}

async function loadHistory() {
  try {
    const rounds = await apiFetch('/api/history');
    const el = document.getElementById('history-list');
    if (!rounds.length) { el.innerHTML = '<div style="text-align:center;color:var(--text2);padding:20px">Нет истории</div>'; return; }
    el.innerHTML = rounds.map(r => {
      const v = parseFloat(r.crashPoint);
      const time = new Date(r.timestamp).toLocaleTimeString('ru', {hour:'2-digit',minute:'2-digit'});
      return `<div class="history-item"><div class="history-multiplier ${v<1.5?'low':v<5?'mid':'high'}">${v.toFixed(2)}x</div><div><div class="history-meta">${time}</div><div class="history-hash">${r.hash?r.hash.slice(0,16)+'...':''}</div></div></div>`;
    }).join('');
  } catch(e) {}
}

async function loadLeaderboard() {
  try {
    const leaders = await apiFetch('/api/leaderboard');
    const el = document.getElementById('leaderboard-list');
    const medals = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
    if (!leaders.length) { el.innerHTML = '<div style="text-align:center;color:var(--text2);padding:20px">Нет данных</div>'; return; }
    el.innerHTML = leaders.map((u,i) => {
      const name = u.username ? `@${u.username}` : u.firstName;
      return `<div class="leader-item"><div class="leader-rank">${medals[i]||i+1}</div><div class="leader-info"><div class="leader-name">${name}</div><div class="leader-games">${u.gamesPlayed} игр</div></div><div class="leader-won">${u.totalWon} 💰</div></div>`;
    }).join('');
  } catch(e) {}
}

function updateProfile() {
  document.getElementById('profile-name').textContent = MY_NAME;
  document.getElementById('profile-username').textContent = MY_USERNAME ? `@${MY_USERNAME}` : '';
  document.getElementById('profile-avatar').textContent = MY_NAME.charAt(0).toUpperCase();
  apiFetch(`/api/user/${MY_ID}`).then(u => {
    if (!u) return;
    document.getElementById('stat-won').textContent = u.totalWon;
    document.getElementById('stat-lost').textContent = u.totalLost;
    document.getElementById('stat-games').textContent = u.gamesPlayed;
    document.getElementById('stat-balance').textContent = u.balance;
  }).catch(()=>{});
}

function updateHashDisplay() { const e = document.getElementById('current-hash'); if (e) e.textContent = currentHash || 'Ожидание...'; }
function updateBalanceDisplay() { document.getElementById('balance-amount').textContent = Math.floor(balance); }
async function refreshBalance() { try { const u = await apiFetch(`/api/user/${MY_ID}`); balance = u.balance; updateBalanceDisplay(); } catch(e) {} }

function setQuickBet(v) { document.getElementById('bet-amount').value = v; }
function halveBet() { const e = document.getElementById('bet-amount'); e.value = Math.max(10, Math.floor(parseFloat(e.value)/2)); }
function doubleBet() { const e = document.getElementById('bet-amount'); e.value = Math.min(10000, Math.floor(parseFloat(e.value)*2)); }
function toggleAutoCashout() { document.getElementById('auto-cashout-value').disabled = !document.getElementById('auto-cashout-check').checked; }

async function apiPost(path, body) {
  const res = await fetch(BASE + path, { method:'POST', headers:{'Content-Type':'application/json', ...EXTRA_HEADERS}, body: JSON.stringify(body) });
  return res.json();
}
async function apiFetch(path) {
  const res = await fetch(BASE + path, { headers: EXTRA_HEADERS });
  return res.json();
}

let toastTimer = null;
function showToast(msg, type='') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = `toast show ${type}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2500);
}

async function init() {
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  try {
    const user = await apiPost('/api/user', { userId: MY_ID, username: MY_USERNAME, firstName: MY_NAME });
    balance = user.balance; updateBalanceDisplay();
  } catch(e) { console.error('[Init]', e); }
  connectWS();
}

init();
