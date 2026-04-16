const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

const API_URL = 'https://292a1b359850bb.lhr.life';

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
function formatPrice(kopeks) {
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

function initData() {
  return tg.initData || '';
}

// ─── ЗАГРУЗКА ПРОФИЛЯ ───────────────────────────
async function loadProfile() {
  try {
    const res = await fetch(`${API_URL}/api/me`, {
      headers: { 'x-init-data': initData() }
    });
    if (!res.ok) return;
    currentUser = await res.json();

    const balance = currentUser.balance || 0;

    // Шапка
    document.getElementById('balance-amount').textContent = formatPrice(balance) + ' ₽';

    // Hero блок
    document.getElementById('hero-balance').textContent = formatPrice(balance) + ' ₽';
    const earned = (currentUser.referral_count || 0) * 6900;
    document.getElementById('referral-stat').textContent =
      `Купили: ${currentUser.referral_count} · Ждут: ${currentUser.referral_pending} · +${formatPrice(earned)} ₽`;

  } catch {}
}

// ─── КНОПКА "ПРИГЛАСИТЬ" ────────────────────────
document.getElementById('ref-btn').addEventListener('click', () => {
  if (!currentUser) return showToast('⚠ Открой через Telegram');
  shareRefLink();
});

function shareRefLink() {
  if (!currentUser) return;
  const link = currentUser.referral_link;
  if (navigator.share) {
    navigator.share({ title: 'XYLIVPN', text: '🔐 Получи доступ к XYLIVPN!', url: link }).catch(() => {});
  } else {
    navigator.clipboard.writeText(link).then(() => showToast('✅ Ссылка скопирована'));
  }
}

// ─── ТАРИФЫ ────────────────────────────────────
async function loadPlans() {
  const container = document.getElementById('plans-list');
  try {
    const res = await fetch(`${API_URL}/api/plans`);
    const plans = await res.json();

    if (!plans.length) {
      container.innerHTML = '<div class="empty-state"><span class="empty-icon">⬡</span><h3>НЕТ ТАРИФОВ</h3><p>Скоро появятся новые тарифы</p></div>';
      return;
    }

    container.innerHTML = '';
    plans.forEach((plan, i) => {
      const card = document.createElement('div');
      card.className = 'plan-card' + (i === 1 ? ' popular' : '') + (!plan.in_stock ? ' out-of-stock' : '');
      card.innerHTML = `
        <div class="plan-header">
          <div class="plan-name">${plan.name}</div>
          <div class="plan-price">
            <span class="amount">${formatPrice(plan.price)}</span>
            <span class="currency"> ₽</span>
          </div>
        </div>
        <p class="plan-desc">${plan.description}</p>
        <button class="plan-buy-btn" ${!plan.in_stock ? 'disabled' : ''} data-plan-id="${plan.id}">
          ${plan.in_stock ? '[ КУПИТЬ ]' : '[ НЕТ В НАЛИЧИИ ]'}
        </button>
      `;
      card.querySelector('.plan-buy-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (plan.in_stock) openConfirmModal(plan);
      });
      container.appendChild(card);
    });
  } catch {
    container.innerHTML = `<div class="empty-state"><span class="empty-icon">⚠</span><h3>ОШИБКА СВЯЗИ</h3><p>Попробуй чуть позже</p></div>`;
  }
}

// ─── МОДАЛКА ПОКУПКИ ───────────────────────────
function openConfirmModal(plan) {
  const modal = document.getElementById('modal');
  const content = document.getElementById('modal-content');
  const balance = currentUser?.balance || 0;
  const canPayWithBalance = balance >= plan.price;

  content.innerHTML = `
    <div class="modal-title">${plan.name}</div>
    <div class="modal-desc">${plan.description}</div>
    <div class="modal-price-row">
      <span class="modal-price-label">// К ОПЛАТЕ</span>
      <span class="modal-price-value">${formatPrice(plan.price)} ₽</span>
    </div>
    ${balance > 0 ? `
    <div class="modal-balance-row">
      <span class="modal-balance-label">⚡ МОЙ БАЛАНС: ${formatPrice(balance)} ₽</span>
      <span class="modal-balance-value">${canPayWithBalance ? 'ХВАТАЕТ' : 'НЕ ХВАТАЕТ'}</span>
    </div>` : ''}
    <button class="modal-confirm-btn" id="confirm-pay">
      ${canPayWithBalance ? '[ ОПЛАТИТЬ С БАЛАНСА ]' : '[ ПЕРЕЙТИ К ОПЛАТЕ ]'}
    </button>
    <button class="modal-cancel-btn" id="cancel-modal">// ОТМЕНА</button>
  `;

  modal.classList.remove('hidden');

  document.getElementById('confirm-pay').addEventListener('click', () => {
    closeModal();
    createInvoice(plan.id);
  });
  document.getElementById('cancel-modal').addEventListener('click', closeModal);
  document.querySelector('.modal-overlay').addEventListener('click', closeModal);
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}

// ─── СОЗДАТЬ СЧЁТ ──────────────────────────────
async function createInvoice(planId) {
  const data = initData();
  if (!data) {
    showToast('⚠ Открой приложение через Telegram');
    return;
  }

  const btn = document.querySelector(`[data-plan-id="${planId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '[ ОБРАБОТКА... ]'; }


  try {
    const res = await fetch(`${API_URL}/api/create-invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: data, planId })
    });
    const json = await res.json();

    if (json.ok) {
      if (json.paid_with_balance) {
        showToast('✅ Успешно оплачено с баланса');
        await loadProfile();
      } else {
        showToast('✅ Счёт отправлен в Telegram');
        tg.close();
      }
    } else {
      showToast('✘ ' + (json.error || 'ОШИБКА'));
      if (btn) { btn.disabled = false; btn.textContent = '[ КУПИТЬ ]'; }
    }
  } catch {
    showToast('✘ Ошибка соединения');
    if (btn) { btn.disabled = false; btn.textContent = '[ КУПИТЬ ]'; }
  }
}

// ─── МОИ КЛЮЧИ ─────────────────────────────────
async function loadOrders() {
  const container = document.getElementById('orders-list');
  container.innerHTML = '<div class="loading"><div class="cyber-spinner"></div><p class="loading-text">ЗАГРУЗКА_ДАННЫХ...</p></div>';

  const data = initData();
  if (!data) {
    container.innerHTML = '<div class="empty-state"><span class="empty-icon">🔒</span><h3>ОТКРОЙ ЧЕРЕЗ TELEGRAM</h3><p>Приложение работает только внутри Telegram</p></div>';
    return;
  }

  try {
    const res = await fetch(`${API_URL}/api/orders`, { headers: { 'x-init-data': data } });
    const orders = await res.json();

    if (!orders.length) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">⬡</span>
          <h3>КЛЮЧЕЙ НЕТ</h3>
          <p>Перейди в раздел «Магазин»<br>чтобы получить ключ доступа</p>
        </div>`;
      return;
    }

    container.innerHTML = '';
    orders.forEach(order => {
      const card = document.createElement('div');
      card.className = 'order-card';
      const date = (order.paid_at || order.created_at)?.slice(0, 10) || '—';

      card.innerHTML = `
        <div class="order-header">
          <div class="order-plan">${order.plan_name}</div>
          <div class="order-status ${order.status === 'paid' ? 'status-paid' : 'status-pending'}">
            ${order.status === 'paid' ? '● АКТИВЕН' : '○ ОЖИДАЕТ ОПЛАТЫ'}
          </div>
        </div>
        ${order.key_value ? `
          <div class="order-key">
            <div class="key-value">${order.key_value}</div>
            <button class="copy-btn" data-key="${order.key_value}" title="Скопировать ключ">⧉</button>
          </div>
        ` : ''}
        <div class="order-date">// Дата: ${date}</div>
      `;

      const copyBtn = card.querySelector('.copy-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(copyBtn.dataset.key).then(() => {
            showToast('✅ Ключ скопирован');
            copyBtn.textContent = '✓';
            setTimeout(() => { copyBtn.textContent = '⧉'; }, 1500);
          });
        });
      }

      container.appendChild(card);
    });
  } catch {
    container.innerHTML = '<div class="empty-state"><span class="empty-icon">⚠</span><h3>ОШИБКА СВЯЗИ</h3><p>Не удалось загрузить данные. Попробуй позже</p></div>';
  }
}

// ─── СТРАНИЦА РЕФЕРАЛОВ ─────────────────────────
function loadReferralPage() {
  const container = document.getElementById('referral-page');
  if (!currentUser) {
    container.innerHTML = '<div class="empty-state"><span class="empty-icon">🔒</span><h3>ОТКРОЙ ЧЕРЕЗ TELEGRAM</h3><p>Приложение работает только внутри Telegram</p></div>';
    return;
  }

  const { referral_count, referral_pending, referral_link } = currentUser;
  const earned = (referral_count || 0) * 6900;

  container.innerHTML = `
    <div class="ref-hero">
      <span class="ref-hero-icon">👥</span>
      <div class="ref-hero-title">РЕФЕРАЛЬНАЯ ПРОГРАММА</div>
      <div class="ref-hero-sub">Приглашай друзей — получай бонусы на баланс</div>
      <div class="ref-bonus-badge">+69 ₽ за друга</div>
      <div class="ref-hero-sub">Бонус зачисляется после того, как друг <b>оформит подписку</b></div>
    </div>

    <div class="ref-stats-row">
      <div class="ref-stat-card">
        <div class="ref-stat-label">// ОФОРМИЛИ ПОДПИСКУ</div>
        <div class="ref-stat-value cyan">${referral_count || 0}</div>
      </div>
      <div class="ref-stat-card">
        <div class="ref-stat-label">// ЕЩЁ НЕ КУПИЛИ</div>
        <div class="ref-stat-value" style="color:var(--yellow)">${referral_pending || 0}</div>
      </div>
    </div>
    <div class="ref-stats-row" style="margin-top:10px">
      <div class="ref-stat-card" style="grid-column:1/-1">
        <div class="ref-stat-label">// ИТОГО ЗАРАБОТАНО</div>
        <div class="ref-stat-value green">${formatPrice(earned)} ₽</div>
      </div>
    </div>

    <div class="ref-link-block">
      <div class="ref-link-label">// ТВОЯ РЕФЕРАЛЬНАЯ ССЫЛКА</div>
      <div class="ref-link-box">${referral_link}</div>
      <button class="ref-copy-btn" id="copy-ref-link">[ СКОПИРОВАТЬ ССЫЛКУ ]</button>
    </div>

    <div class="ref-how-list">
      <div class="ref-how-title">// КАК ЭТО РАБОТАЕТ</div>
      <div class="ref-how-item">
        <div class="ref-how-num">1</div>
        <div class="ref-how-text">Скопируй свою реферальную ссылку и отправь другу</div>
      </div>
      <div class="ref-how-item">
        <div class="ref-how-num">2</div>
        <div class="ref-how-text">Друг переходит по ссылке и запускает бота</div>
      </div>
      <div class="ref-how-item">
        <div class="ref-how-num">3</div>
        <div class="ref-how-text">Как только друг оформит подписку — тебе начислится +69 ₽</div>
      </div>
      <div class="ref-how-item">
        <div class="ref-how-num">4</div>
        <div class="ref-how-text">Используй накопленный баланс для оплаты своих ключей</div>
      </div>
    </div>
  `;

  document.getElementById('copy-ref-link').addEventListener('click', () => {
    navigator.clipboard.writeText(referral_link).then(() => {
      showToast('✅ Ссылка скопирована');
    });
  });
}

// ─── ИНИЦИАЛИЗАЦИЯ ──────────────────────────────
async function init() {
  await loadProfile();
  loadPlans();
}

init();
