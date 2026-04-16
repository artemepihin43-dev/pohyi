const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

const API_URL = 'https://your-backend-domain.com'; // Replace with your backend URL

// Tabs
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'mykeys') loadOrders();
  });
});

// Format price: kopeks → rubles
function formatPrice(kopeks) {
  return (kopeks / 100).toLocaleString('ru-RU');
}

// Show toast
function showToast(msg) {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// Load plans
async function loadPlans() {
  const container = document.getElementById('plans-list');
  try {
    const res = await fetch(`${API_URL}/api/plans`);
    const plans = await res.json();
    if (!plans.length) {
      container.innerHTML = '<div class="empty-state"><span class="empty-icon">😔</span><h3>Нет доступных тарифов</h3></div>';
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
            <span class="currency">₽</span>
          </div>
        </div>
        <p class="plan-desc">${plan.description}</p>
        <button class="plan-buy-btn" ${!plan.in_stock ? 'disabled' : ''} data-plan-id="${plan.id}">
          ${plan.in_stock ? '💳 Купить' : '❌ Нет в наличии'}
        </button>
      `;
      card.querySelector('.plan-buy-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (plan.in_stock) openConfirmModal(plan);
      });
      container.appendChild(card);
    });
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><span class="empty-icon">⚠️</span><h3>Ошибка загрузки</h3><p>Попробуй позже</p></div>`;
  }
}

// Open confirm modal
function openConfirmModal(plan) {
  const modal = document.getElementById('modal');
  const content = document.getElementById('modal-content');

  content.innerHTML = `
    <div class="modal-title">${plan.name}</div>
    <div class="modal-desc">${plan.description}</div>
    <div class="modal-price-row">
      <span class="modal-price-label">К оплате:</span>
      <span class="modal-price-value">${formatPrice(plan.price)} ₽</span>
    </div>
    <button class="modal-confirm-btn" id="confirm-pay">💳 Перейти к оплате</button>
    <button class="modal-cancel-btn" id="cancel-modal">Отмена</button>
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

// Create invoice
async function createInvoice(planId) {
  const initData = tg.initData;
  if (!initData) {
    showToast('⚠️ Открой через Telegram');
    return;
  }

  const btn = document.querySelector(`[data-plan-id="${planId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Обработка...'; }

  try {
    const res = await fetch(`${API_URL}/api/create-invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData, planId })
    });
    const data = await res.json();

    if (data.ok) {
      showToast('✅ Счёт отправлен в Telegram');
      tg.close();
    } else {
      showToast('❌ ' + (data.error || 'Ошибка'));
      if (btn) { btn.disabled = false; btn.textContent = '💳 Купить'; }
    }
  } catch {
    showToast('❌ Ошибка соединения');
    if (btn) { btn.disabled = false; btn.textContent = '💳 Купить'; }
  }
}

// Load orders
async function loadOrders() {
  const container = document.getElementById('orders-list');
  container.innerHTML = '<div class="loading"><div class="spinner"></div><p>Загрузка...</p></div>';

  const initData = tg.initData;
  if (!initData) {
    container.innerHTML = '<div class="empty-state"><span class="empty-icon">🔒</span><h3>Открой через Telegram</h3></div>';
    return;
  }

  try {
    const res = await fetch(`${API_URL}/api/orders`, {
      headers: { 'x-init-data': initData }
    });
    const orders = await res.json();

    if (!orders.length) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">🔑</span>
          <h3>Ключей пока нет</h3>
          <p>Купи тариф в разделе<br>«Магазин» чтобы получить ключ</p>
        </div>`;
      return;
    }

    container.innerHTML = '';
    orders.forEach(order => {
      const card = document.createElement('div');
      card.className = 'order-card';
      const date = order.paid_at
        ? new Date(order.paid_at).toLocaleDateString('ru-RU')
        : new Date(order.created_at).toLocaleDateString('ru-RU');

      card.innerHTML = `
        <div class="order-header">
          <div class="order-plan">${order.plan_name}</div>
          <div class="order-status ${order.status === 'paid' ? 'status-paid' : 'status-pending'}">
            ${order.status === 'paid' ? '✅ Оплачено' : '⏳ Ожидание'}
          </div>
        </div>
        ${order.key_value ? `
          <div class="order-key">
            <div class="key-value">${order.key_value}</div>
            <button class="copy-btn" data-key="${order.key_value}" title="Копировать">📋</button>
          </div>
        ` : ''}
        <div class="order-date">📅 ${date}</div>
      `;

      const copyBtn = card.querySelector('.copy-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(copyBtn.dataset.key).then(() => {
            showToast('✅ Ключ скопирован');
            copyBtn.textContent = '✅';
            setTimeout(() => { copyBtn.textContent = '📋'; }, 1500);
          });
        });
      }

      container.appendChild(card);
    });
  } catch {
    container.innerHTML = '<div class="empty-state"><span class="empty-icon">⚠️</span><h3>Ошибка загрузки</h3><p>Попробуй позже</p></div>';
  }
}

// Init
loadPlans();
