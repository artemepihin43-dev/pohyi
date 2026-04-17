const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

const API_URL = 'https://great-ape-88.loca.lt';

let currentUser = null;

// ─── ТАБЫ ──────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'mykeys') loadOrders();
    if (btn.dataset.tab === 'referral') loadReferralPage();
  });
});

// ─── ХЕЛПЕРЫ ───────────────────────────────────
function fmt(kopeks) {
  return (kopeks / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2 });
}

function showToast(msg) {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

function initData() { return tg.initData || ''; }

const checkSvg = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none">
  <path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// ─── ПРОФИЛЬ ───────────────────────────────────
async function loadProfile() {
  try {
    const res = await fetch(`${API_URL}/api/me`, { headers: { 'x-init-data': initData() } });
    if (!res.ok) return;
    currentUser = await res.json();
    const bal = currentUser.balance || 0;
    document.getElementById('balance-amount').textContent = fmt(bal) + ' ₽';
    document.getElementById('hero-balance').textContent = fmt(bal) + ' ₽';
    const earned = (currentUser.referral_count || 0) * 6900;
    document.getElementById('referral-stat').textContent =
      `Купили: ${currentUser.referral_count || 0} · Ждут: ${currentUser.referral_pending || 0} · +${fmt(earned)} ₽`;
  } catch {}
}

// ─── ПРИГЛАСИТЬ ────────────────────────────────
document.getElementById('ref-btn').addEventListener('click', () => {
  if (!currentUser) return showToast('Открой через Telegram');
  const link = currentUser.referral_link;
  if (navigator.share) {
    navigator.share({ title: 'XYLIVPN', text: '🔐 Получи доступ к XYLIVPN!', url: link }).catch(() => {});
  } else {
    navigator.clipboard.writeText(link).then(() => showToast('Ссылка скопирована'));
  }
});

// ─── ТАРИФЫ ────────────────────────────────────
const FEATURES = [
  'Мгновенная выдача ключа',
  'Безлимитный трафик',
  'Все серверы включены',
  'Любое устройство'
];

async function loadPlans() {
  const container = document.getElementById('plans-list');
  try {
    const res = await fetch(`${API_URL}/api/plans`);
    const plans = await res.json();

    if (!plans.length) {
      container.innerHTML = emptyState('📦', 'Тарифов пока нет', 'Скоро появятся новые планы');
      return;
    }

    container.innerHTML = '';
    plans.forEach((plan, i) => {
      const isPopular = i === 1;
      const card = document.createElement('div');
      card.className = 'plan-card' + (isPopular ? ' popular' : '') + (!plan.in_stock ? ' out-of-stock' : '');

      card.innerHTML = `
        ${isPopular ? '<div class="plan-badge">Популярное</div>' : ''}
        <div class="plan-header">
          <div class="plan-name">${plan.name}</div>
          <div class="plan-price">
            <span class="amount">${fmt(plan.price)}</span>
            <span class="currency"> ₽</span>
          </div>
        </div>
        <p class="plan-desc">${plan.description}</p>
        <div class="plan-divider"></div>
        <div class="plan-features">
          ${FEATURES.map(f => `
            <div class="plan-feature">
              <div class="plan-feature-dot">${checkSvg}</div>
              <span>${f}</span>
            </div>
          `).join('')}
        </div>
        <button class="plan-buy-btn" ${!plan.in_stock ? 'disabled' : ''} data-plan-id="${plan.id}">
          ${plan.in_stock ? 'Получить доступ' : 'Нет в наличии'}
        </button>
      `;

      card.querySelector('.plan-buy-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (plan.in_stock) openConfirmModal(plan);
      });
      container.appendChild(card);
    });
  } catch {
    container.innerHTML = emptyState('⚠️', 'Ошибка соединения', 'Попробуй обновить страницу');
  }
}

// ─── МОДАЛКА ───────────────────────────────────
function openConfirmModal(plan) {
  const modal = document.getElementById('modal');
  const content = document.getElementById('modal-content');
  const balance = currentUser?.balance || 0;
  const canPay = balance >= plan.price;

  content.innerHTML = `
    <div class="m-plan-name">${plan.name}</div>
    <div class="m-plan-desc">${plan.description}</div>
    <div class="m-price-block">
      <span class="m-price-label">К оплате</span>
      <span class="m-price-value">${fmt(plan.price)} ₽</span>
    </div>
    ${balance > 0 ? `
    <div class="m-balance-block">
      <span class="left">Баланс: ${fmt(balance)} ₽</span>
      <span class="right">${canPay ? '✓ Хватает' : 'Не хватает'}</span>
    </div>` : ''}
    <button class="m-confirm-btn" id="confirm-pay">
      ${canPay ? 'Оплатить с баланса' : 'Перейти к оплате'}
    </button>
    <button class="m-cancel-btn" id="cancel-modal">Отмена</button>
  `;

  modal.classList.remove('hidden');
  document.getElementById('confirm-pay').addEventListener('click', () => { closeModal(); createInvoice(plan.id); });
  document.getElementById('cancel-modal').addEventListener('click', closeModal);
  document.querySelector('.modal-backdrop').addEventListener('click', closeModal);
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}

// ─── ОПЛАТА ────────────────────────────────────
async function createInvoice(planId) {
  const data = initData();
  if (!data) { showToast('Открой через Telegram'); return; }

  const btn = document.querySelector(`[data-plan-id="${planId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Обработка...'; }

  try {
    const res = await fetch(`${API_URL}/api/create-invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: data, planId })
    });
    const json = await res.json();

    if (json.ok) {
      if (json.paid_with_balance) {
        showToast('✅ Оплачено с баланса!');
        await loadProfile();
      } else {
        showToast('✅ Счёт отправлен в Telegram');
        tg.close();
      }
    } else {
      showToast(json.error || 'Ошибка');
      if (btn) { btn.disabled = false; btn.textContent = 'Получить доступ'; }
    }
  } catch {
    showToast('Ошибка соединения');
    if (btn) { btn.disabled = false; btn.textContent = 'Получить доступ'; }
  }
}

// ─── МОИ КЛЮЧИ ─────────────────────────────────
async function loadOrders() {
  const container = document.getElementById('orders-list');
  container.innerHTML = '<div class="loader"><div class="spin"></div></div>';

  if (!initData()) {
    container.innerHTML = emptyState('🔒', 'Только в Telegram', 'Открой приложение через бота');
    return;
  }

  try {
    const res = await fetch(`${API_URL}/api/orders`, { headers: { 'x-init-data': initData() } });
    const orders = await res.json();

    if (!orders.length) {
      container.innerHTML = emptyState('🗝', 'Ключей пока нет', 'Перейди в Магазин чтобы купить доступ');
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'orders-list';
    orders.forEach(o => {
      const date = (o.paid_at || o.created_at)?.slice(0, 10) || '—';
      const card = document.createElement('div');
      card.className = 'order-card';
      card.innerHTML = `
        <div class="order-header">
          <div class="order-plan">${o.plan_name}</div>
          <div class="status-badge ${o.status === 'paid' ? 'status-paid' : 'status-pending'}">
            ${o.status === 'paid' ? 'Активен' : 'Ожидает'}
          </div>
        </div>
        ${o.key_value ? `
          <div class="order-key">
            <div class="key-value">${o.key_value}</div>
            <button class="copy-btn" data-key="${o.key_value}">Копировать</button>
          </div>
        ` : ''}
        <div class="order-date">${date}</div>
      `;
      const copyBtn = card.querySelector('.copy-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(copyBtn.dataset.key).then(() => {
            showToast('Ключ скопирован');
            copyBtn.textContent = 'Скопировано';
            setTimeout(() => { copyBtn.textContent = 'Копировать'; }, 1500);
          });
        });
      }
      wrap.appendChild(card);
    });
    container.innerHTML = '';
    container.appendChild(wrap);
  } catch {
    container.innerHTML = emptyState('⚠️', 'Ошибка загрузки', 'Попробуй позже');
  }
}

// ─── РЕФЕРАЛЫ ──────────────────────────────────
function loadReferralPage() {
  const container = document.getElementById('referral-page');
  if (!currentUser) {
    container.innerHTML = emptyState('🔒', 'Только в Telegram', 'Открой приложение через бота');
    return;
  }

  const { referral_count = 0, referral_pending = 0, referral_link } = currentUser;
  const earned = referral_count * 6900;

  container.innerHTML = `
    <div class="ref-hero-card">
      <span class="ref-emoji">👥</span>
      <div class="ref-title">Реферальная программа</div>
      <div class="ref-subtitle">Приглашай друзей и получай бонусы на баланс за каждую их подписку</div>
      <div class="ref-bonus-pill">+69 ₽ за друга</div>
    </div>

    <div class="ref-stats-grid">
      <div class="ref-stat">
        <div class="ref-stat-label">Купили</div>
        <div class="ref-stat-val purple">${referral_count}</div>
      </div>
      <div class="ref-stat">
        <div class="ref-stat-label">Ожидают</div>
        <div class="ref-stat-val amber">${referral_pending}</div>
      </div>
      <div class="ref-stat full">
        <div class="ref-stat-label">Заработано</div>
        <div class="ref-stat-val green">${fmt(earned)} ₽</div>
      </div>
    </div>

    <div class="ref-link-card">
      <div class="ref-link-label">Твоя ссылка</div>
      <div class="ref-link-value">${referral_link}</div>
      <button class="ref-copy-btn" id="copy-ref">Скопировать ссылку</button>
    </div>

    <div class="how-card">
      <div class="how-title">Как это работает</div>
      ${[
        'Скопируй реферальную ссылку и отправь другу',
        'Друг переходит по ссылке и запускает бота',
        'После оформления подписки тебе приходит +69 ₽',
        'Трать баланс на оплату своих ключей'
      ].map((t, i) => `
        <div class="how-item">
          <div class="how-num">${i + 1}</div>
          <div class="how-text">${t}</div>
        </div>
      `).join('')}
    </div>
  `;

  document.getElementById('copy-ref').addEventListener('click', () => {
    navigator.clipboard.writeText(referral_link).then(() => showToast('Ссылка скопирована'));
  });
}

// ─── EMPTY STATE ───────────────────────────────
function emptyState(icon, title, sub) {
  return `<div class="empty-state">
    <span class="empty-icon">${icon}</span>
    <div class="empty-title">${title}</div>
    <div class="empty-sub">${sub}</div>
  </div>`;
}

// ─── INIT ───────────────────────────────────────
async function init() {
  await loadProfile();
  loadPlans();
}

init();
