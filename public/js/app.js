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
  '#/budget':        () => budgetModule.init(),
  '#/subscriptions': () => subscriptionsModule.init(),
  '#/reminders':     () => remindersModule.init(),
  '#/charts':        () => chartsModule.init(),
  '#/import':        () => importModule.init(),
  '#/year-review':   () => yearReviewModule.init(),
  '#/rules':         () => rulesModule.init(),
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
  try {
    const me = await api('/api/auth/me');
    const el = document.getElementById('sidebar-username');
    if (el && me.username) el.textContent = me.username;
    if (me.role === 'admin') {
      const btn = document.getElementById('manage-users-btn');
      if (btn) btn.style.display = '';
    }
  } catch (_) {}
});

async function manageUsersModal() {
  openModal('<h2>👥 Manage Users</h2><p style="color:var(--text-muted);margin-top:8px">Loading…</p>');
  const users = await api('/api/users').catch(() => []);

  const rows = users.map(u => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
      <div>
        <span style="font-weight:600">${escHtml(u.username)}</span>
        <span style="margin-left:8px;font-size:11px;font-weight:600;padding:2px 7px;border-radius:20px;
          background:${u.role === 'admin' ? 'rgba(108,142,245,0.15)' : 'rgba(136,146,164,0.15)'};
          color:${u.role === 'admin' ? 'var(--accent)' : 'var(--text-muted)'}">${u.role}</span>
      </div>
      ${u.role !== 'admin' ? `<button class="btn btn-danger btn-sm" onclick="removeUser(${u.id},'${escHtml(u.username)}')">Remove</button>` : ''}
    </div>
  `).join('');

  document.getElementById('modal-content').innerHTML = `
    <h2 style="margin-bottom:16px">👥 Manage Users</h2>
    <div style="margin-bottom:20px">${rows}</div>
    <div style="background:var(--surface2);border-radius:10px;padding:16px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">Invite someone</div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">
        Generate a one-time link (expires in 7 days). Share it with whoever you'd like to invite.
      </p>
      <div id="invite-result" style="display:none;margin-bottom:12px">
        <input id="invite-url" type="text" readonly
          style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:6px;
                 padding:8px 10px;color:var(--text);font-size:12px;font-family:monospace"
          onclick="this.select()">
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Click to select, then copy. Link expires in 7 days.</div>
      </div>
      <button class="btn btn-primary" id="gen-invite-btn" onclick="generateInvite()" style="width:auto;padding:10px 20px">
        Generate Invite Link
      </button>
    </div>
  `;
}

async function removeUser(id, username) {
  if (!confirm(`Remove "${username}"? They will lose access immediately.`)) return;
  try {
    await api(`/api/users/${id}`, { method: 'DELETE' });
    toast(`${username} removed`);
    manageUsersModal();
  } catch (e) { toast(e.message, 'error'); }
}

async function generateInvite() {
  const btn = document.getElementById('gen-invite-btn');
  btn.disabled = true;
  btn.textContent = 'Generating…';
  try {
    const { url } = await api('/api/invites', { method: 'POST' });
    const result = document.getElementById('invite-result');
    document.getElementById('invite-url').value = url;
    result.style.display = 'block';
    btn.textContent = 'Generate New Link';
    btn.disabled = false;
    // Auto-select the URL
    document.getElementById('invite-url').select();
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Generate Invite Link';
  }
}

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

    // Top categories — radial dials
    const catTotal = byCategory.reduce((s, c) => s + c.total, 0);
    const CAT_PALETTE = ['#6c8ef5','#a78bfa','#34d399','#fbbf24','#f87171','#60a5fa'];
    const R = 32, CIRC = 2 * Math.PI * R;
    const catList = byCategory.length === 0
      ? '<p style="color:var(--text-muted);font-size:13px">No expense data this month.</p>'
      : `<div class="cat-dials">` + byCategory.slice(0, 6).map((c, i) => {
          const pct     = catTotal > 0 ? (c.total / catTotal * 100) : 0;
          const offset  = CIRC * (1 - pct / 100);
          const color   = CAT_PALETTE[i % CAT_PALETTE.length];
          const name    = (c.category || 'Uncategorized');
          const short   = name.length > 11 ? name.slice(0, 10) + '…' : name;
          return `
            <div class="cat-dial-item">
              <div class="cat-dial-ring">
                <svg viewBox="0 0 80 80" width="80" height="80">
                  <circle cx="40" cy="40" r="${R}" fill="none" stroke="var(--surface2)" stroke-width="7"/>
                  <circle cx="40" cy="40" r="${R}" fill="none" stroke="${color}" stroke-width="7"
                    stroke-linecap="round"
                    stroke-dasharray="${CIRC.toFixed(2)}"
                    stroke-dashoffset="${offset.toFixed(2)}"
                    transform="rotate(-90 40 40)"
                    style="transition:stroke-dashoffset 0.6s ease"/>
                  <text x="40" y="44" text-anchor="middle"
                    style="fill:${color};font-size:13px;font-weight:800;font-family:system-ui">
                    ${pct.toFixed(0)}%
                  </text>
                </svg>
              </div>
              <div class="cat-dial-label" title="${escHtml(name)}">${escHtml(short)}</div>
              <div class="cat-dial-amount" style="color:${color}">${fmtCur(c.total)}</div>
            </div>`;
        }).join('') + `</div>`;

    // Recent transactions
    const txRows = (recentTx.rows || []);
    const recentList = txRows.length === 0
      ? '<p style="color:var(--text-muted);font-size:13px">No transactions this month.</p>'
      : txRows.map(r => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:1px solid var(--border)">
            <div style="display:flex;align-items:center;gap:10px;min-width:0">
              ${typeof payeeLogoHtml === 'function' ? payeeLogoHtml(r.payee, r.amount) : ''}
              <div style="min-width:0">
                <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(r.payee)}</div>
                <div style="font-size:11px;color:var(--text-muted)">${fmtDate(r.date)}${r.category ? ' · ' + escHtml(r.category) : ''}</div>
              </div>
            </div>
            <div style="font-size:14px;white-space:nowrap;margin-left:12px">${fmt(r.amount)}</div>
          </div>`).join('');

    // Greeting
    const hour = today.getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const dateLabel = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    // Net hero colour + label
    const netPositive = summary.net >= 0;
    const netColor    = netPositive ? 'var(--success)' : 'var(--danger)';
    const netLabel    = netPositive ? 'surplus' : 'deficit';

    view.innerHTML = `
      <!-- Greeting bar -->
      <div class="dash-greeting">
        <div>
          <div class="dash-greeting-text">${greeting} 👋</div>
          <div class="dash-greeting-sub">${dateLabel} · ${monthName}</div>
        </div>
      </div>

      <!-- Hero net card -->
      <div class="dash-hero">
        <div class="dash-hero-left">
          <div class="dash-hero-label">Net this month</div>
          <div class="dash-hero-amount" style="color:${netColor}">${netPositive ? '+' : '−'}${fmtCur(Math.abs(summary.net))}</div>
          <div class="dash-hero-sub">${netLabel} · ${monthName}</div>
        </div>
        <div class="dash-hero-right">
          <div class="dash-hero-stat">
            <span class="dash-hero-stat-label">Income</span>
            <span class="dash-hero-stat-val income-text">${fmtCur(summary.income)}</span>
          </div>
          <div class="dash-hero-divider"></div>
          <div class="dash-hero-stat">
            <span class="dash-hero-stat-label">Spent</span>
            <span class="dash-hero-stat-val expense-text">${fmtCur(Math.abs(summary.expenses))}</span>
          </div>
          <div class="dash-hero-divider"></div>
          <div class="dash-hero-stat">
            <span class="dash-hero-stat-label">Subscriptions</span>
            <span class="dash-hero-stat-val">${fmtCur(subTotal)}<span style="font-size:11px;color:var(--text-muted)">/mo</span></span>
          </div>
        </div>
      </div>

      <!-- Savings rate -->
      ${savingsBar}

      <!-- Bills + Top Spending -->
      <div class="dash-grid">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
            <h2 style="margin-bottom:0">Upcoming Bills</h2>
            ${overdueReminders.length > 0
              ? `<span class="badge badge-red">⚠ ${overdueReminders.length} overdue</span>`
              : '<span style="font-size:12px;color:var(--success);font-weight:600">✓ All clear</span>'}
          </div>
          ${reminders.length === 0
            ? '<p style="color:var(--text-muted);font-size:13px">No upcoming bills in the next 30 days.</p>'
            : reminders.slice(0, 6).map(r => {
                const overdue = r.due_date < todayStr;
                const daysUntil = Math.round((new Date(r.due_date) - new Date(todayStr)) / 86400000);
                const dueLabel = overdue ? `${Math.abs(daysUntil)}d overdue` : daysUntil === 0 ? 'Due today' : `in ${daysUntil}d`;
                return `
                  <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
                    <div style="display:flex;align-items:center;gap:10px">
                      <div style="width:8px;height:8px;border-radius:50%;background:${overdue ? 'var(--danger)' : daysUntil <= 3 ? 'var(--warning)' : 'var(--success)'};flex-shrink:0"></div>
                      <div>
                        <div style="font-size:13px;font-weight:600">${escHtml(r.title)}</div>
                        <div style="font-size:11px;color:${overdue ? 'var(--danger)' : 'var(--text-muted)'};font-weight:${overdue ? '600' : '400'}">${dueLabel}</div>
                      </div>
                    </div>
                    <div style="font-size:13px;font-weight:600;color:var(--text-muted)">${r.amount ? fmtCur(Math.abs(r.amount)) : '—'}</div>
                  </div>`;
              }).join('')
          }
          ${reminders.length > 6 ? `<div style="margin-top:12px"><a href="#/reminders" style="font-size:12px;color:var(--accent);text-decoration:none;font-weight:600">View all ${reminders.length} →</a></div>` : ''}
        </div>

        <div class="card">
          <h2 style="margin-bottom:16px">Top Spending This Month</h2>
          ${catList}
          ${byCategory.length > 0 ? `<div style="margin-top:14px"><a href="#/charts" style="font-size:12px;color:var(--accent);text-decoration:none;font-weight:600">Full breakdown →</a></div>` : ''}
        </div>
      </div>

      <!-- Recent transactions -->
      <div class="card" style="margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <h2 style="margin-bottom:0">Recent Transactions</h2>
          <a href="#/transactions" style="font-size:12px;color:var(--accent);text-decoration:none;font-weight:600">View all →</a>
        </div>
        ${recentList}
      </div>

      <!-- 6-month trend chart -->
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <h2 style="margin-bottom:0">6-Month Trend</h2>
          <a href="#/charts" style="font-size:12px;color:var(--accent);text-decoration:none;font-weight:600">Full charts →</a>
        </div>
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
