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
window.addEventListener('load', async () => {
  route();
  // Load logged-in username into sidebar
  try {
    const me = await api('/api/auth/me');
    const el = document.getElementById('sidebar-username');
    if (el && me.username) el.textContent = me.username;
  } catch (_) {}
});

function changePasswordModal() {
  openModal(`
    <h2>Change Password</h2>
    <form id="cp-form" style="margin-top:16px">
      <div class="form-group" style="margin-bottom:12px">
        <label>Current Password</label>
        <input type="password" id="cp-current" autocomplete="current-password" required>
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label>New Password</label>
        <input type="password" id="cp-new" autocomplete="new-password" required minlength="8">
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">At least 8 characters</div>
      </div>
      <div class="form-group" style="margin-bottom:20px">
        <label>Confirm New Password</label>
        <input type="password" id="cp-confirm" autocomplete="new-password" required>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Change Password</button>
      </div>
    </form>
  `);
  document.getElementById('cp-form').onsubmit = async e => {
    e.preventDefault();
    const current    = document.getElementById('cp-current').value;
    const newPassword = document.getElementById('cp-new').value;
    const confirm    = document.getElementById('cp-confirm').value;
    if (newPassword !== confirm) { toast('Passwords do not match', 'error'); return; }
    try {
      await api('/auth/change-password', { method: 'POST', body: { current, newPassword } });
      closeModal();
      toast('Password changed successfully');
    } catch (e) { toast(e.message, 'error'); }
  };
}

// ── Dashboard ────────────────────────────────────────────────────────────────

const dashboardModule = {
  async init() {
    const view = document.getElementById('view');
    view.innerHTML = '<h1>Dashboard</h1><p style="color:var(--text-muted)">Loading...</p>';

    const today = new Date();
    const currentMonth = today.toISOString().slice(0, 7);
    const todayStr = today.toISOString().slice(0, 10);

    const [summary, reminders, subs, trend, byCategory, recentTx] = await Promise.all([
      api(`/api/transactions/summary?month=${currentMonth}`),
      api('/api/reminders?paid=0&upcoming_days=30'),
      api('/api/subscriptions?active=1'),
      api('/api/charts/spending-trend?months=6'),
      api(`/api/charts/category-breakdown?month=${currentMonth}`),
      api(`/api/transactions?limit=5&month=${currentMonth}`)
    ]);

    const overdueReminders = reminders.filter(r => r.due_date < todayStr);

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

    // Savings rate
    const savingsRate = summary.income > 0
      ? Math.min(100, Math.max(0, (summary.net / summary.income) * 100))
      : 0;
    const spentPct = summary.income > 0
      ? Math.min(100, (Math.abs(summary.expenses) / summary.income * 100))
      : 100;
    const savedPct = Math.max(0, savingsRate);
    const savingsColor = savingsRate >= 20 ? 'var(--success)' : savingsRate >= 0 ? 'var(--warning)' : 'var(--danger)';

    const savingsBar = summary.income > 0 ? `
      <div class="card" style="margin-bottom:16px;padding:14px 18px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="font-size:11px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.05em">Savings Rate — ${monthName}</span>
          <span style="font-weight:700;font-size:15px;color:${savingsColor}">${savingsRate.toFixed(1)}%</span>
        </div>
        <div style="height:8px;background:var(--surface2);border-radius:4px;overflow:hidden;position:relative">
          <div style="position:absolute;left:0;top:0;bottom:0;width:${spentPct.toFixed(1)}%;background:var(--danger);border-radius:4px 0 0 4px"></div>
          <div style="position:absolute;left:${spentPct.toFixed(1)}%;top:0;bottom:0;width:${savedPct.toFixed(1)}%;background:var(--success);border-radius:0 4px 4px 0"></div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:11px;color:var(--text-muted)">
          <span>Spent ${fmtCur(Math.abs(summary.expenses))}</span>
          <span>Saved ${fmtCur(Math.max(0, summary.net))}</span>
        </div>
      </div>` : '';

    // Top categories list — API returns ABS totals (positive) for expenses only
    const catTotal = byCategory.reduce((s, c) => s + c.total, 0);
    const catList = byCategory.length === 0
      ? '<p style="color:var(--text-muted);font-size:13px">No expense data this month.</p>'
      : byCategory.slice(0, 6).map(c => {
          const pct = catTotal > 0 ? (c.total / catTotal * 100).toFixed(1) : 0;
          return `<div style="margin-bottom:11px">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px">
              <span style="font-size:13px;font-weight:500">${escHtml(c.category || 'Uncategorized')}</span>
              <span style="font-size:13px;font-weight:600;color:var(--danger)">${fmtCur(c.total)}</span>
            </div>
            <div style="height:5px;background:var(--surface2);border-radius:3px;overflow:hidden">
              <div style="width:${pct}%;height:100%;background:var(--accent);border-radius:3px"></div>
            </div>
          </div>`;
        }).join('');

    // Recent transactions
    const txRows = (recentTx.rows || []);
    const recentList = txRows.length === 0
      ? '<p style="color:var(--text-muted);font-size:13px">No transactions this month.</p>'
      : txRows.map(r => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
            <div>
              <div style="font-size:13px;font-weight:600">${escHtml(r.payee)}</div>
              <div style="font-size:11px;color:var(--text-muted)">${fmtDate(r.date)}${r.category ? ' · ' + escHtml(r.category) : ''}</div>
            </div>
            <div style="font-size:14px">${fmt(r.amount)}</div>
          </div>`).join('');

    view.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:10px">
        <h1 style="margin-bottom:0">Dashboard — ${monthName}</h1>
        <div style="display:flex;gap:8px">
          <a href="#/transactions" class="btn btn-primary btn-sm">+ Transaction</a>
          <a href="#/reminders" class="btn btn-ghost btn-sm">+ Bill Reminder</a>
        </div>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="label">📈 Income</div>
          <div class="value income">${fmtCur(summary.income)}</div>
        </div>
        <div class="stat-card">
          <div class="label">📉 Expenses</div>
          <div class="value expense">${fmtCur(Math.abs(summary.expenses))}</div>
        </div>
        <div class="stat-card">
          <div class="label">💰 Net</div>
          <div class="value ${summary.net >= 0 ? 'income' : 'expense'}">${fmtCur(summary.net)}</div>
          <div class="sublabel">${summary.net >= 0 ? 'Surplus' : 'Deficit'} this month</div>
        </div>
        <div class="stat-card">
          <div class="label">🔁 Subscriptions/mo</div>
          <div class="value neutral">${fmtCur(subTotal)}</div>
          <div class="sublabel">${subs.length} active</div>
        </div>
      </div>

      ${savingsBar}

      <div class="dash-grid">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
            <h2 style="margin-bottom:0">Upcoming Bills</h2>
            ${overdueReminders.length > 0 ? `<span class="badge badge-red">${overdueReminders.length} overdue</span>` : ''}
          </div>
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
          <h2>Top Spending This Month</h2>
          ${catList}
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <h2 style="margin-bottom:0">Recent Transactions</h2>
          <a href="#/transactions" style="font-size:12px;color:var(--accent);text-decoration:none;font-weight:600">View all →</a>
        </div>
        ${recentList}
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
