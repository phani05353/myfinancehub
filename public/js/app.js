// ── Shared utilities ────────────────────────────────────────────────────────

function fmt(amount) {
  if (amount === null || amount === undefined) return '—';
  const n = parseFloat(amount);
  const cls = n >= 0 ? 'amount-positive' : 'amount-negative';
  const str = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(n));
  return `<span class="${cls}">${n >= 0 ? '+' : '-'}${str}</span>`;
}

function fmtCur(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${m}/${day}/${y}`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body && typeof opts.body === 'object' ? JSON.stringify(opts.body) : opts.body
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

function openModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('modal-content').innerHTML = '';
  document.body.style.overflow = '';
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});
document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  const isMobile = window.innerWidth <= 768;
  el.style.cssText = `
    position:fixed; z-index:9999;
    ${isMobile ? 'bottom:20px;left:16px;right:16px;' : 'bottom:24px;right:24px;max-width:320px;'}
    background:var(--surface); border:1px solid var(--${type === 'error' ? 'danger' : 'success'});
    color:var(--${type === 'error' ? 'danger' : 'success'});
    padding:14px 18px; border-radius:10px; font-size:14px; font-weight:600;
    box-shadow:0 4px 24px rgba(0,0,0,0.5);
  `;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Sidebar / Hamburger ──────────────────────────────────────────────────────

const hamburger = document.getElementById('hamburger');
const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('sidebar-overlay');

function openSidebar() {
  sidebar.classList.add('open');
  overlay.classList.add('visible');
  hamburger.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeSidebar() {
  sidebar.classList.remove('open');
  overlay.classList.remove('visible');
  hamburger.classList.remove('open');
  document.body.style.overflow = '';
}

hamburger.addEventListener('click', () => {
  sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
});
overlay.addEventListener('click', closeSidebar);

// Close sidebar on nav link tap (mobile)
document.querySelectorAll('.nav-link').forEach(a => {
  a.addEventListener('click', () => {
    if (window.innerWidth <= 768) closeSidebar();
  });
});

// ── Router ───────────────────────────────────────────────────────────────────

const routes = {
  '#/dashboard':     () => dashboardModule.init(),
  '#/transactions':  () => transactionsModule.init(),
  '#/subscriptions': () => subscriptionsModule.init(),
  '#/reminders':     () => remindersModule.init(),
  '#/charts':        () => chartsModule.init(),
  '#/import':        () => importModule.init(),
};

function route() {
  const hash = location.hash || '#/dashboard';
  const handler = routes[hash];
  document.querySelectorAll('.nav-link').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === hash);
  });
  // Scroll content to top on navigation
  window.scrollTo(0, 0);
  if (handler) handler();
  else document.getElementById('view').innerHTML =
    '<div class="empty-state"><div class="empty-icon">404</div><p>Page not found</p></div>';
}

window.addEventListener('hashchange', route);
window.addEventListener('load', route);

// ── Dashboard ────────────────────────────────────────────────────────────────

const dashboardModule = {
  async init() {
    const view = document.getElementById('view');
    view.innerHTML = '<h1>Dashboard</h1><p style="color:var(--text-muted)">Loading...</p>';

    const today = new Date();
    const currentMonth = today.toISOString().slice(0, 7);
    const todayStr = today.toISOString().slice(0, 10);

    const [summary, reminders, subs, trend] = await Promise.all([
      api(`/api/transactions/summary?month=${currentMonth}`),
      api('/api/reminders?paid=0&upcoming_days=30'),
      api('/api/subscriptions?active=1'),
      api('/api/charts/spending-trend?months=6')
    ]);

    const overdueReminders = reminders.filter(r => r.due_date < todayStr);

    // Update overdue badge in sidebar
    const badge = document.getElementById('overdue-badge');
    const mobileDot = document.getElementById('mobile-overdue-dot');
    if (overdueReminders.length > 0) {
      badge.textContent = `${overdueReminders.length} overdue bill${overdueReminders.length > 1 ? 's' : ''}`;
      badge.classList.remove('hidden');
      if (mobileDot) mobileDot.style.display = 'block';
    } else {
      badge.classList.add('hidden');
      if (mobileDot) mobileDot.style.display = 'none';
    }

    const monthName = today.toLocaleString('default', { month: 'long', year: 'numeric' });
    const subTotal = subs.reduce((a, s) => {
      if (s.billing_cycle === 'monthly') return a + Math.abs(s.amount);
      if (s.billing_cycle === 'yearly') return a + Math.abs(s.amount) / 12;
      if (s.billing_cycle === 'weekly') return a + Math.abs(s.amount) * 4.33;
      return a;
    }, 0);

    view.innerHTML = `
      <h1>Dashboard — ${monthName}</h1>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="label">Income</div>
          <div class="value income">${fmtCur(summary.income)}</div>
        </div>
        <div class="stat-card">
          <div class="label">Expenses</div>
          <div class="value expense">${fmtCur(Math.abs(summary.expenses))}</div>
        </div>
        <div class="stat-card">
          <div class="label">Net</div>
          <div class="value ${summary.net >= 0 ? 'income' : 'expense'}">${fmtCur(summary.net)}</div>
        </div>
        <div class="stat-card">
          <div class="label">Subscriptions/mo</div>
          <div class="value neutral">${fmtCur(subTotal)}</div>
        </div>
      </div>

      <div class="dash-grid">
        <div class="card">
          <h2>Upcoming Bills</h2>
          ${reminders.length === 0
            ? '<p style="color:var(--text-muted);font-size:13px">No upcoming bills in next 30 days.</p>'
            : `<div class="table-wrap"><table>
                <thead><tr><th>Bill</th><th>Due</th><th>Amount</th><th>Status</th></tr></thead>
                <tbody>
                ${reminders.slice(0, 8).map(r => {
                  const overdue = r.due_date < todayStr;
                  return `<tr class="${overdue ? 'overdue' : ''}">
                    <td>${escHtml(r.title)}</td>
                    <td style="white-space:nowrap">${fmtDate(r.due_date)}</td>
                    <td style="white-space:nowrap">${r.amount ? fmt(-Math.abs(r.amount)) : '—'}</td>
                    <td><span class="badge ${overdue ? 'badge-red' : 'badge-yellow'}">${overdue ? 'Overdue' : 'Due'}</span></td>
                  </tr>`;
                }).join('')}
                </tbody>
              </table></div>`
          }
        </div>
        <div class="card">
          <h2>Active Subscriptions</h2>
          ${subs.length === 0
            ? '<p style="color:var(--text-muted);font-size:13px">No subscriptions tracked.</p>'
            : `<div class="table-wrap"><table>
                <thead><tr><th>Name</th><th>Amount</th><th>Next Due</th></tr></thead>
                <tbody>
                ${subs.slice(0, 8).map(s => `<tr>
                  <td>${escHtml(s.name)}</td>
                  <td style="white-space:nowrap">${fmt(-Math.abs(s.amount))}<span style="color:var(--text-muted);font-size:11px">/${s.billing_cycle === 'monthly' ? 'mo' : s.billing_cycle === 'yearly' ? 'yr' : 'wk'}</span></td>
                  <td style="white-space:nowrap">${fmtDate(s.next_due_date)}</td>
                </tr>`).join('')}
                </tbody>
              </table></div>`
          }
        </div>
      </div>

      <div class="card">
        <h2>6-Month Trend</h2>
        <div class="chart-container"><canvas id="trend-chart"></canvas></div>
      </div>
    `;

    if (trend.length > 0) {
      new Chart(document.getElementById('trend-chart'), {
        type: 'bar',
        data: {
          labels: trend.map(t => t.month),
          datasets: [
            { label: 'Income',   data: trend.map(t => t.income),   backgroundColor: 'rgba(52,211,153,0.5)',  borderColor: '#34d399', borderWidth: 2, borderRadius: 4 },
            { label: 'Expenses', data: trend.map(t => t.expenses), backgroundColor: 'rgba(248,113,113,0.5)', borderColor: '#f87171', borderWidth: 2, borderRadius: 4 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { color: '#8892a4', boxWidth: 12 } } },
          scales: {
            x: { ticks: { color: '#8892a4', maxRotation: 45 }, grid: { color: '#2e3350' } },
            y: { ticks: { color: '#8892a4', callback: v => '$' + v.toLocaleString() }, grid: { color: '#2e3350' } }
          }
        }
      });
    }
  }
};
