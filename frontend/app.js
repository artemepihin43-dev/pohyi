const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

const API_URL = 'https://plastic-deer-62.loca.lt';

// Все запросы к туннелю требуют этот заголовок — иначе localtunnel показывает HTML-заглушку
function apiFetch(url, options = {}) {
  options.headers = { 'bypass-tunnel-reminder': 'true', ...options.headers };
  return fetch(url, options);
}

let currentUser = null;

// Показываем вкладку Админ
const ADMIN_TG_ID = 6807012532;
function tryShowAdminTab() {
  const uid = tg.initDataUnsafe?.user?.id;
  if (Number(uid) === ADMIN_TG_ID) {
    const tab = document.getElementById('tab-btn-admin');
    if (tab) { tab.style.display = ''; tab.style.removeProperty('display'); tab.removeAttribute('style'); tab.style.display = 'flex'; }
    return true;
  }
  return false;
}
tryShowAdminTab();
setTimeout(tryShowAdminTab, 300);

// ─── ТАБЫ ──────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'mykeys') loadOrders();
    if (btn.dataset.tab === 'referral') loadReferralPage();
    if (btn.dataset.tab === 'admin') loadAdminPanel();
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
    const res = await apiFetch(`${API_URL}/api/me`, { headers: { 'x-init-data': initData() } });
    if (!res.ok) return;
    currentUser = await res.json();
    const bal = currentUser.balance || 0;
    document.getElementById('balance-amount').textContent = fmt(bal) + ' ₽';
    document.getElementById('hero-balance').textContent = fmt(bal) + ' ₽';
    const earned = (currentUser.referral_count || 0) * 6900;
    document.getElementById('referral-stat').textContent =
      `Купили: ${currentUser.referral_count || 0} · Ждут: ${currentUser.referral_pending || 0} · +${fmt(earned)} ₽`;
    if (currentUser.is_admin) {
      document.getElementById('tab-btn-admin').style.display = '';
    }
  } catch {}
}

// ─── TON ПОПОЛНЕНИЕ ────────────────────────────
let tonRate = 0;
let tonPollTimer = null;

document.getElementById('topup-ton-btn').addEventListener('click', openTonModal);

async function openTonModal() {
  const modal = document.getElementById('modal');
  const content = document.getElementById('modal-content');

  content.innerHTML = '<div class="loader" style="padding:40px 0"><div class="spin"></div></div>';
  modal.classList.remove('hidden');

  try {
    const res = await apiFetch(`${API_URL}/api/topup/ton/rate`);
    const data = await res.json();
    tonRate = data.rate || 0;
  } catch {}

  renderTonStep1();

  document.querySelector('.modal-backdrop').addEventListener('click', closeTonModal);
}

function closeTonModal() {
  clearInterval(tonPollTimer);
  tonPollTimer = null;
  closeModal();
}

function renderTonStep1() {
  const content = document.getElementById('modal-content');
  const rateStr = tonRate ? tonRate.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) : '—';
  const updMins = tonRate ? Math.round((Date.now() - (window._tonRateUpdatedAt || 0)) / 60000) : null;

  content.innerHTML = `
    <div class="m-plan-name">💎 Пополнить через TON</div>
    <div class="ton-rate-row">
      <span class="ton-rate-val">1 TON ≈ ${rateStr} ₽</span>
      <span class="ton-rate-hint">обновляется каждый час</span>
    </div>

    <div class="admin-amount-wrap" style="margin-bottom:14px">
      <input class="admin-amount-input" id="ton-amount-input" type="number"
        inputmode="decimal" placeholder="Сумма в рублях" min="50" step="10" autocomplete="off"/>
      <div class="admin-amount-presets">
        ${[100,200,500,1000].map(v => `<button class="amount-preset" data-val="${v}">${v} ₽</button>`).join('')}
      </div>
    </div>

    <div class="ton-calc-row" id="ton-calc-row" style="display:none">
      <span class="ton-calc-label">К оплате</span>
      <span class="ton-calc-val" id="ton-calc-val">— TON</span>
    </div>

    <button class="m-confirm-btn" id="ton-next-btn">Создать платёж</button>
    <button class="m-cancel-btn" id="cancel-modal">Отмена</button>
  `;

  document.getElementById('cancel-modal').addEventListener('click', closeTonModal);

  const amountInput = document.getElementById('ton-amount-input');
  const calcRow = document.getElementById('ton-calc-row');
  const calcVal = document.getElementById('ton-calc-val');

  amountInput.addEventListener('input', () => {
    const rub = parseFloat(amountInput.value);
    if (rub >= 50 && tonRate) {
      const ton = (rub / tonRate).toFixed(4);
      calcVal.textContent = `${ton} TON`;
      calcRow.style.display = '';
    } else {
      calcRow.style.display = 'none';
    }
  });

  content.querySelectorAll('.amount-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      amountInput.value = btn.dataset.val;
      amountInput.dispatchEvent(new Event('input'));
      content.querySelectorAll('.amount-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  document.getElementById('ton-next-btn').addEventListener('click', async () => {
    const amount_rub = parseFloat(amountInput.value);
    if (!amount_rub || amount_rub < 50) { showToast('Минимум 50 ₽'); return; }
    if (!initData()) { showToast('Открой через Telegram'); return; }

    const btn = document.getElementById('ton-next-btn');
    btn.disabled = true; btn.textContent = 'Создаю…';

    try {
      const res = await apiFetch(`${API_URL}/api/topup/ton/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData() },
        body: JSON.stringify({ amount_rub })
      });
      const json = await res.json();
      if (json.ok) renderTonStep2(json);
      else { showToast(json.error || 'Ошибка'); btn.disabled = false; btn.textContent = 'Создать платёж'; }
    } catch {
      showToast('Ошибка соединения');
      btn.disabled = false; btn.textContent = 'Создать платёж';
    }
  });
}

function renderTonStep2(payment) {
  const content = document.getElementById('modal-content');
  content.innerHTML = `
    <div class="m-plan-name">💎 Отправь TON</div>
    <div class="m-plan-desc">Переведи точную сумму на кошелёк с указанным комментарием. Баланс зачислится автоматически.</div>

    <div class="ton-pay-field">
      <div class="ton-pay-label">Адрес кошелька</div>
      <div class="ton-pay-row">
        <div class="ton-pay-val" id="ton-wallet-val">${payment.wallet}</div>
        <button class="copy-btn" data-copy="${payment.wallet}">Копировать</button>
      </div>
    </div>

    <div class="ton-pay-field">
      <div class="ton-pay-label">Сумма</div>
      <div class="ton-pay-row">
        <div class="ton-pay-val ton-amount-big">${payment.amount_ton} TON</div>
        <button class="copy-btn" data-copy="${payment.amount_ton}">Копировать</button>
      </div>
    </div>

    <div class="ton-pay-field ton-pay-comment">
      <div class="ton-pay-label">Комментарий <span class="ton-required">обязателен!</span></div>
      <div class="ton-pay-row">
        <div class="ton-pay-val">${payment.comment}</div>
        <button class="copy-btn" data-copy="${payment.comment}">Копировать</button>
      </div>
    </div>

    <div class="ton-status-row" id="ton-status-row">
      <div class="spin" style="width:16px;height:16px;border-width:2px"></div>
      <span>Жду оплату…</span>
    </div>

    <div class="ton-expire-hint">Платёж действителен 30 минут · ${payment.amount_rub} ₽</div>

    <button class="m-cancel-btn" id="cancel-modal" style="margin-top:8px">Закрыть</button>
  `;

  // Copy buttons
  content.querySelectorAll('.copy-btn[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.copy).then(() => {
        const old = btn.textContent;
        btn.textContent = 'Скопировано';
        setTimeout(() => btn.textContent = old, 1500);
      });
    });
  });

  document.getElementById('cancel-modal').addEventListener('click', closeTonModal);

  // Polling каждые 5 секунд
  tonPollTimer = setInterval(async () => {
    try {
      const res = await apiFetch(`${API_URL}/api/topup/ton/status`, {
        headers: { 'x-init-data': initData() }
      });
      const json = await res.json();
      if (json.status === 'paid') {
        clearInterval(tonPollTimer);
        renderTonSuccess(json.payment);
        loadProfile();
      } else if (json.status === 'expired') {
        clearInterval(tonPollTimer);
        const row = document.getElementById('ton-status-row');
        if (row) row.innerHTML = '<span style="color:var(--amber)">⏰ Время вышло</span>';
      }
    } catch {}
  }, 5000);
}

function renderTonSuccess(payment) {
  const content = document.getElementById('modal-content');
  content.innerHTML = `
    <div style="text-align:center;padding:20px 0 10px">
      <div style="font-size:52px;margin-bottom:12px">✅</div>
      <div class="m-plan-name">Оплачено!</div>
      <div style="font-size:13px;color:var(--muted);margin:8px 0 20px">
        +${payment.amount_rub} ₽ зачислено на баланс
      </div>
      <button class="m-confirm-btn" id="cancel-modal">Отлично</button>
    </div>
  `;
  document.getElementById('cancel-modal').addEventListener('click', closeTonModal);
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
    const res = await apiFetch(`${API_URL}/api/plans`);
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
    const res = await apiFetch(`${API_URL}/api/create-invoice`, {
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
    const res = await apiFetch(`${API_URL}/api/orders`, { headers: { 'x-init-data': initData() } });
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

// ─── АДМИН ПАНЕЛЬ ──────────────────────────────
let adminUsers = [];
let adminSection = 'users'; // 'users' | 'servers'

async function loadAdminPanel() {
  const container = document.getElementById('admin-panel');
  container.innerHTML = '<div class="loader"><div class="spin"></div></div>';

  if (!initData()) {
    container.innerHTML = emptyState('🔒', 'Только в Telegram', 'Открой приложение через бота');
    return;
  }

  try {
    const res = await apiFetch(`${API_URL}/api/admin/tg/users`, {
      headers: { 'x-init-data': initData() }
    });
    if (!res.ok) { container.innerHTML = emptyState('⛔', 'Нет доступа', 'Только для администратора'); return; }
    adminUsers = await res.json();
    renderAdminShell();
    if (adminSection === 'users') renderUsersSection();
    else renderServersSection();
  } catch {
    container.innerHTML = emptyState('⚠️', 'Ошибка загрузки', 'Попробуй позже');
  }
}

function renderAdminShell() {
  const container = document.getElementById('admin-panel');
  const totalBalance = adminUsers.reduce((s, u) => s + (u.balance || 0), 0);

  container.innerHTML = `
    <div class="admin-stats-row">
      <div class="admin-stat-card">
        <div class="admin-stat-label">Пользователей</div>
        <div class="admin-stat-val">${adminUsers.length}</div>
      </div>
      <div class="admin-stat-card">
        <div class="admin-stat-label">Балансов всего</div>
        <div class="admin-stat-val green">${fmt(totalBalance)} ₽</div>
      </div>
    </div>

    <div class="admin-seg">
      <button class="admin-seg-btn ${adminSection === 'users' ? 'active' : ''}" data-sec="users">Пользователи</button>
      <button class="admin-seg-btn ${adminSection === 'servers' ? 'active' : ''}" data-sec="servers">Сервера</button>
    </div>

    <div id="admin-section-body"></div>
  `;

  container.querySelectorAll('.admin-seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      adminSection = btn.dataset.sec;
      container.querySelectorAll('.admin-seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (adminSection === 'users') renderUsersSection();
      else renderServersSection();
    });
  });
}

function renderUsersSection() {
  const body = document.getElementById('admin-section-body');
  body.innerHTML = `
    <div class="admin-search-wrap">
      <input class="admin-search" id="admin-search" type="text" placeholder="Поиск по имени или @username…" autocomplete="off"/>
    </div>
    <div id="admin-users-list" class="admin-users-list"></div>
  `;
  renderUserCards(adminUsers);
  document.getElementById('admin-search').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    const filtered = q
      ? adminUsers.filter(u =>
          (u.first_name || '').toLowerCase().includes(q) ||
          (u.last_name || '').toLowerCase().includes(q) ||
          (u.username || '').toLowerCase().includes(q) ||
          String(u.telegram_id).includes(q)
        )
      : adminUsers;
    renderUserCards(filtered);
  });
}

async function renderServersSection() {
  const body = document.getElementById('admin-section-body');
  body.innerHTML = '<div class="loader"><div class="spin"></div></div>';

  try {
    const res = await apiFetch(`${API_URL}/api/admin/tg/plans`, {
      headers: { 'x-init-data': initData() }
    });
    const plans = await res.json();
    renderServersForm(plans);
  } catch {
    body.innerHTML = emptyState('⚠️', 'Ошибка загрузки', 'Попробуй позже');
  }
}

function renderServersForm(plans) {
  const body = document.getElementById('admin-section-body');
  const activePlans = plans.filter(p => p.active);
  const selectedId = activePlans[0]?.id;

  body.innerHTML = `
    <div class="servers-plans-grid" id="servers-plans-grid">
      ${plans.map(p => `
        <div class="srv-plan-pill ${p.id === selectedId ? 'active' : ''}" data-id="${p.id}">
          <div class="srv-plan-name">${p.name}</div>
          <div class="srv-plan-count">${p.available} шт.</div>
        </div>
      `).join('')}
    </div>

    <input type="hidden" id="selected-plan-id" value="${selectedId || ''}"/>

    <div class="servers-keys-block">
      <div class="servers-keys-header">
        <span class="servers-keys-label">Ключи / конфиги</span>
        <span class="servers-keys-hint">Каждый на новой строке</span>
      </div>
      <textarea class="servers-textarea" id="servers-textarea"
        placeholder="vless://abc123...&#10;vless://def456...&#10;ss://..." rows="6"></textarea>
      <button class="servers-add-btn" id="servers-add-btn">Добавить серверы</button>
    </div>

    <div class="servers-existing-wrap">
      <div class="servers-existing-label">Доступные ключи</div>
      <div id="servers-existing-list">
        <div class="loader"><div class="spin"></div></div>
      </div>
    </div>
  `;

  // Переключение тарифа
  body.querySelectorAll('.srv-plan-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      body.querySelectorAll('.srv-plan-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      document.getElementById('selected-plan-id').value = pill.dataset.id;
      loadExistingKeys(parseInt(pill.dataset.id), plans);
    });
  });

  // Добавление ключей
  document.getElementById('servers-add-btn').addEventListener('click', async () => {
    const planId = parseInt(document.getElementById('selected-plan-id').value);
    const raw = document.getElementById('servers-textarea').value;
    const keys = raw.split('\n').map(k => k.trim()).filter(Boolean);
    if (!keys.length) { showToast('Введи хотя бы один ключ'); return; }

    const btn = document.getElementById('servers-add-btn');
    btn.disabled = true; btn.textContent = 'Загрузка…';

    try {
      const res = await apiFetch(`${API_URL}/api/admin/tg/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData() },
        body: JSON.stringify({ plan_id: planId, keys })
      });
      const json = await res.json();
      if (json.ok) {
        showToast(`✅ Добавлено ${json.added} ключей`);
        document.getElementById('servers-textarea').value = '';
        // обновим счётчики
        const plansRes = await apiFetch(`${API_URL}/api/admin/tg/plans`, { headers: { 'x-init-data': initData() } });
        const updatedPlans = await plansRes.json();
        // обновить пилюли
        updatedPlans.forEach(p => {
          const pill = body.querySelector(`.srv-plan-pill[data-id="${p.id}"]`);
          if (pill) pill.querySelector('.srv-plan-count').textContent = p.available + ' шт.';
        });
        loadExistingKeys(planId, updatedPlans);
      } else {
        showToast(json.error || 'Ошибка');
      }
    } catch { showToast('Ошибка соединения'); }

    btn.disabled = false; btn.textContent = 'Добавить серверы';
  });

  if (selectedId) loadExistingKeys(selectedId, plans);
}

async function loadExistingKeys(planId, plans) {
  const list = document.getElementById('servers-existing-list');
  if (!list) return;
  list.innerHTML = '<div class="loader" style="padding:20px 0"><div class="spin"></div></div>';

  try {
    const keysRes = await apiFetch(`${API_URL}/api/admin/tg/keys-list?plan_id=${planId}`, {
      headers: { 'x-init-data': initData() }
    });
    if (!keysRes.ok) { list.innerHTML = ''; return; }
    const keys = await keysRes.json();

    if (!keys.length) {
      list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:12px 0;text-align:center">Ключей нет</div>';
      return;
    }

    list.innerHTML = '';
    keys.slice(0, 30).forEach(k => {
      const row = document.createElement('div');
      row.className = 'srv-key-row';
      row.dataset.id = k.id;
      row.innerHTML = `
        <div class="srv-key-val">${k.key_value}</div>
        <div class="srv-key-status ${k.status === 'available' ? 'avail' : 'used'}">${k.status === 'available' ? 'свободен' : 'выдан'}</div>
        ${k.status === 'available' ? `<button class="srv-key-del" data-id="${k.id}">✕</button>` : ''}
      `;
      const delBtn = row.querySelector('.srv-key-del');
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          delBtn.disabled = true;
          try {
            const r = await apiFetch(`${API_URL}/api/admin/tg/keys/${k.id}`, {
              method: 'DELETE',
              headers: { 'x-init-data': initData() }
            });
            if ((await r.json()).ok) {
              row.remove();
              showToast('Ключ удалён');
              // обновить счётчик
              const pill = document.querySelector(`.srv-plan-pill[data-id="${planId}"]`);
              if (pill) {
                const cnt = pill.querySelector('.srv-plan-count');
                const cur = parseInt(cnt.textContent) || 0;
                cnt.textContent = Math.max(0, cur - 1) + ' шт.';
              }
            }
          } catch { showToast('Ошибка'); delBtn.disabled = false; }
        });
      }
      list.appendChild(row);
    });
    if (keys.length > 30) {
      const more = document.createElement('div');
      more.style.cssText = 'color:var(--muted);font-size:12px;text-align:center;padding:8px 0';
      more.textContent = `Показаны 30 из ${keys.length}`;
      list.appendChild(more);
    }
  } catch { list.innerHTML = ''; }
}

function renderUserCards(users) {
  const list = document.getElementById('admin-users-list');
  if (!users.length) {
    list.innerHTML = emptyState('🔍', 'Не найдено', 'Попробуй другой запрос');
    return;
  }
  list.innerHTML = '';
  users.forEach(u => {
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || '—';
    const uname = u.username ? `@${u.username}` : `ID: ${u.telegram_id}`;
    const card = document.createElement('div');
    card.className = 'admin-user-card';
    card.innerHTML = `
      <div class="auc-left">
        <div class="auc-avatar">${(u.first_name || '?')[0].toUpperCase()}</div>
        <div class="auc-info">
          <div class="auc-name">${name}</div>
          <div class="auc-handle">${uname}</div>
          <div class="auc-meta">${u.paid_orders} покупок</div>
        </div>
      </div>
      <div class="auc-right">
        <div class="auc-balance">${fmt(u.balance || 0)} ₽</div>
        <button class="auc-topup-btn" data-id="${u.telegram_id}" data-name="${name}">Пополнить</button>
      </div>
    `;
    card.querySelector('.auc-topup-btn').addEventListener('click', () => openTopupModal(u));
    list.appendChild(card);
  });
}

function openTopupModal(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || String(user.telegram_id);
  const modal = document.getElementById('modal');
  const content = document.getElementById('modal-content');

  content.innerHTML = `
    <div class="m-plan-name">Пополнение баланса</div>
    <div class="m-plan-desc">${name}${user.username ? ' · @' + user.username : ''}</div>
    <div class="m-price-block" style="margin-bottom:16px">
      <span class="m-price-label">Текущий баланс</span>
      <span class="m-price-value">${fmt(user.balance || 0)} ₽</span>
    </div>
    <div class="admin-amount-wrap">
      <input class="admin-amount-input" id="topup-amount" type="number" inputmode="decimal" placeholder="Сумма в рублях" min="1" step="1" autocomplete="off"/>
      <div class="admin-amount-presets">
        ${[50, 100, 200, 500].map(v => `<button class="amount-preset" data-val="${v}">${v} ₽</button>`).join('')}
      </div>
    </div>
    <button class="m-confirm-btn" id="topup-confirm">Пополнить</button>
    <button class="m-cancel-btn" id="cancel-modal">Отмена</button>
  `;

  modal.classList.remove('hidden');

  content.querySelectorAll('.amount-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('topup-amount').value = btn.dataset.val;
      content.querySelectorAll('.amount-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  document.getElementById('topup-confirm').addEventListener('click', async () => {
    const amountStr = document.getElementById('topup-amount').value.trim();
    const amount = parseFloat(amountStr);
    if (!amount || amount <= 0) { showToast('Введи сумму'); return; }

    const confirmBtn = document.getElementById('topup-confirm');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Отправка…';

    try {
      const res = await apiFetch(`${API_URL}/api/admin/tg/topup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData() },
        body: JSON.stringify({ telegram_id: user.telegram_id, amount })
      });
      const json = await res.json();
      if (json.ok) {
        closeModal();
        showToast(`✅ +${amount} ₽ зачислено`);
        // обновляем локальный список
        const idx = adminUsers.findIndex(u => u.telegram_id === user.telegram_id);
        if (idx !== -1) adminUsers[idx].balance = json.new_balance;
        renderUserCards(adminUsers);
        // восстановить поиск если был
        const q = document.getElementById('admin-search')?.value.trim().toLowerCase();
        if (q) {
          const filtered = adminUsers.filter(u =>
            (u.first_name || '').toLowerCase().includes(q) ||
            (u.last_name || '').toLowerCase().includes(q) ||
            (u.username || '').toLowerCase().includes(q) ||
            String(u.telegram_id).includes(q)
          );
          renderUserCards(filtered);
        }
      } else {
        showToast(json.error || 'Ошибка');
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Пополнить';
      }
    } catch {
      showToast('Ошибка соединения');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Пополнить';
    }
  });

  document.getElementById('cancel-modal').addEventListener('click', closeModal);
  document.querySelector('.modal-backdrop').addEventListener('click', closeModal);
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
