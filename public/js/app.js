// ── Shared utilities ────────────────────────────────────────────────────────

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

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

// ── Top nav more dropdown ────────────────────────────────────────────────────

function toggleTopNavMore() {
  document.getElementById('top-nav-dropdown')?.classList.toggle('hidden');
}

document.addEventListener('click', e => {
  const dd = document.getElementById('top-nav-dropdown');
  const btn = document.getElementById('top-nav-more-btn');
  if (dd && btn && !dd.classList.contains('hidden')) {
    if (!btn.contains(e.target) && !dd.contains(e.target)) {
      dd.classList.add('hidden');
    }
  }
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
  document.querySelectorAll('.bn-tab[data-route]').forEach(a => {
    a.classList.toggle('active', a.getAttribute('data-route') === hash);
  });
  document.querySelectorAll('.nav-pill[data-route]').forEach(a => {
    a.classList.toggle('active', a.getAttribute('data-route') === hash);
  });
  document.querySelectorAll('.top-nav-drop-item[data-route]').forEach(a => {
    a.classList.toggle('active', a.getAttribute('data-route') === hash);
  });
  // Scroll content to top on navigation
  window.scrollTo(0, 0);
  if (handler) handler();
  else document.getElementById('view').innerHTML =
    '<div class="empty-state"><div class="empty-icon">404</div><p>Page not found</p></div>';
}

function refreshCurrentView() {
  const hash = location.hash || '#/dashboard';
  const handler = routes[hash];
  if (handler) handler();
}

window.addEventListener('hashchange', route);
window.addEventListener('load', async () => {
  route();
  try {
    const me = await api('/api/auth/me');
    const el = document.getElementById('sidebar-username');
    if (el && me.username) el.textContent = me.username;
    const avatar = document.getElementById('top-nav-avatar');
    if (avatar && me.username) {
      avatar.textContent = me.username.slice(0, 2).toUpperCase();
      avatar.title = `Signed in as ${me.username}`;
    }
    if (me.role === 'admin') {
      const btn = document.getElementById('manage-users-btn');
      if (btn) btn.style.display = '';
      const topBtn = document.getElementById('manage-users-top-btn');
      if (topBtn) topBtn.style.display = '';
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
          color:${u.role === 'admin' ? 'var(--accent)' : 'var(--text-muted)'}">${escHtml(u.role)}</span>
      </div>
      ${u.role !== 'admin' ? `<button class="btn btn-danger btn-sm" data-uid="${u.id}" data-uname="${escHtml(u.username)}">Remove</button>` : ''}
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

  document.querySelectorAll('[data-uid]').forEach(btn => {
    btn.addEventListener('click', () => removeUser(parseInt(btn.dataset.uid), btn.dataset.uname));
  });
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

    const [summary, reminders, subs, byCategory, allMonthTx, budgetStatus, trend, catMonthly] = await Promise.all([
      api(`/api/transactions/summary?month=${currentMonth}`),
      api('/api/reminders?paid=0&upcoming_days=30'),
      api('/api/subscriptions?active=1'),
      api(`/api/charts/category-breakdown?month=${currentMonth}`),
      api(`/api/transactions?limit=500&month=${currentMonth}`),
      api(`/api/budgets/status?month=${currentMonth}`).catch(() => []),
      api('/api/charts/spending-trend?months=6').catch(() => []),
      api('/api/charts/category-monthly?months=6').catch(() => [])
    ]);
    const recentTx = { rows: (allMonthTx.rows || []).slice(0, 5) };

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

    // Expense Categories — donut + legend (top 5 + "N Others")
    const CAT_PALETTE = ['#b45c32','#7fc68a','#f4a055','#ec85b5','#e26b6b','#8a6bd6','#5cb3f2','#d99b4a'];
    const catTotal = byCategory.reduce((s, c) => s + c.total, 0);
    const catTop = byCategory.slice(0, 5);
    const catOthers = byCategory.slice(5);
    const othersSum = catOthers.reduce((s, c) => s + c.total, 0);
    const donutSegments = catTop.map((c, i) => ({
      name: c.category || 'Uncategorized',
      total: c.total,
      color: CAT_PALETTE[i % CAT_PALETTE.length]
    }));
    if (othersSum > 0) {
      donutSegments.push({
        name: `${catOthers.length} Other${catOthers.length > 1 ? 's' : ''}`,
        total: othersSum,
        color: CAT_PALETTE[5]
      });
    }
    // Build per-category 6-month series for sparklines
    const monthsSeq = (() => {
      const out = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
      }
      return out;
    })();
    const catSeries = {}; // { categoryName: [m0, m1, ..., m5] }
    (Array.isArray(catMonthly) ? catMonthly : []).forEach(r => {
      if (!catSeries[r.category]) catSeries[r.category] = new Array(6).fill(0);
      const idx = monthsSeq.indexOf(r.month);
      if (idx >= 0) catSeries[r.category][idx] = Number(r.total) || 0;
    });

    const sparklineSvg = (data, color) => {
      if (!data || data.length < 2) return '';
      const w = 56, h = 18, padY = 2;
      const max = Math.max(...data, 1);
      const min = Math.min(...data);
      const range = max - min || 1;
      const stepX = w / (data.length - 1);
      const points = data.map((v, i) => {
        const x = i * stepX;
        const y = h - padY - ((v - min) / range) * (h - padY * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      const last = data[data.length - 1];
      const prev = data[data.length - 2];
      const trendColor = last > prev ? '#ff7a8a' : last < prev ? '#5be0a0' : color;
      const areaPoints = `0,${h} ${points.join(' ')} ${w},${h}`;
      return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
        <polygon points="${areaPoints}" fill="${color}" fill-opacity="0.12"/>
        <polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${(w).toFixed(1)}" cy="${points[points.length - 1].split(',')[1]}" r="2" fill="${trendColor}"/>
      </svg>`;
    };

    const donutLegendHtml = donutSegments.map(s => {
      const pct = catTotal > 0 ? (s.total / catTotal * 100) : 0;
      // For aggregated "N Others" row, sum the underlying series
      let series;
      if (s.name.endsWith(' Others') || s.name.endsWith(' Other')) {
        series = new Array(6).fill(0);
        catOthers.forEach(c => {
          const sr = catSeries[c.category || 'Uncategorized'];
          if (sr) sr.forEach((v, i) => series[i] += v);
        });
      } else {
        series = catSeries[s.name] || [];
      }
      return `
        <li class="donut-legend-row">
          <span class="donut-legend-dot" style="background:${s.color}"></span>
          <span class="donut-legend-name">${escHtml(s.name)}</span>
          <span class="donut-legend-spark">${sparklineSvg(series, s.color)}</span>
          <span class="donut-legend-amt">${fmtCur(s.total).replace('.00', '')}</span>
          <span class="donut-legend-pct">${pct.toFixed(0)}%</span>
        </li>`;
    }).join('');
    const catDonutBlock = byCategory.length === 0
      ? '<p style="color:var(--text-muted);font-size:13px">No expense data this month.</p>'
      : `
        <div class="donut-wrap">
          <div class="donut-canvas-wrap">
            <canvas id="dash-category-donut"></canvas>
            <div class="donut-center">
              <div class="donut-center-amt">${fmtCur(catTotal).replace('.00', '')}</div>
              <div class="donut-center-label">This Month</div>
            </div>
          </div>
          <ul class="donut-legend">${donutLegendHtml}</ul>
        </div>`;

    // ── Sankey: income sources → Income → expense categories ───────────────
    const sankeyData = (() => {
      const incomeByPayee = {};
      allMonthTx.rows?.forEach(r => {
        if (r.amount > 0) {
          const key = r.payee || 'Unknown';
          incomeByPayee[key] = (incomeByPayee[key] || 0) + r.amount;
        }
      });
      const incomeList = Object.entries(incomeByPayee)
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value);

      const expenseList = byCategory.slice().sort((a, b) => b.total - a.total)
        .map(c => ({ name: c.category || 'Uncategorized', value: c.total }));

      const totalIn  = incomeList.reduce((s, n) => s + n.value, 0);
      const totalOut = expenseList.reduce((s, n) => s + n.value, 0);
      return { incomeList, expenseList, totalIn, totalOut };
    })();

    const buildSankeySvg = () => {
      const { incomeList, expenseList, totalIn, totalOut } = sankeyData;
      if (totalIn === 0 && totalOut === 0) {
        return '<div class="sankey-empty">No cash flow data this month.</div>';
      }

      const SOURCE_COLORS = ['#5cb3f2','#4a7dd4','#6c8ef5','#8a6bd6','#a78bfa','#7fc68a','#d99b4a'];
      const MAX_SRC = 5, MAX_CAT = 8;
      let sources = incomeList.slice(0, MAX_SRC);
      if (incomeList.length > MAX_SRC) {
        const rest = incomeList.slice(MAX_SRC).reduce((s, n) => s + n.value, 0);
        if (rest > 0) sources.push({ name: `${incomeList.length - MAX_SRC} Other`, value: rest });
      }
      sources = sources.map((s, i) => ({ ...s, color: SOURCE_COLORS[i % SOURCE_COLORS.length] }));

      let cats = expenseList.slice(0, MAX_CAT).map((c, i) => ({
        ...c, color: CAT_PALETTE[i % CAT_PALETTE.length]
      }));
      if (expenseList.length > MAX_CAT) {
        const rest = expenseList.slice(MAX_CAT).reduce((s, n) => s + n.value, 0);
        if (rest > 0) cats.push({ name: `${expenseList.length - MAX_CAT} Other`, value: rest, color: CAT_PALETTE[6] });
      }

      // Balance sides: add Savings on right if surplus, Deficit on left if shortfall
      const savings = Math.max(0, totalIn - totalOut);
      const deficit = Math.max(0, totalOut - totalIn);
      const rightNodes = [
        ...cats,
        ...(savings > 0 ? [{ name: 'Savings', value: savings, color: '#7fc68a' }] : [])
      ];
      if (deficit > 0) sources.push({ name: 'Deficit', value: deficit, color: '#e26b6b' });

      // Handle case where only one side has data
      if (sources.length === 0) sources = [{ name: 'No income', value: rightNodes.reduce((s, n) => s + n.value, 0) || 1, color: '#6c8ef5' }];
      if (rightNodes.length === 0) return '<div class="sankey-empty">No expenses this month.</div>';

      const leftTotal  = sources.reduce((s, n) => s + n.value, 0);
      const rightTotal = rightNodes.reduce((s, n) => s + n.value, 0);
      const grandTotal = Math.max(leftTotal, rightTotal);

      const W = 820, H = 440;
      const padTop = 18, padBot = 18;
      const availH = H - padTop - padBot;
      const gap = 4;
      const nodeW = 12;

      // Unified scale — nodes + ribbons on both columns use the same px-per-$
      const gapsMax = Math.max((sources.length - 1), (rightNodes.length - 1)) * gap;
      const scale = grandTotal > 0 ? (availH - gapsMax) / grandTotal : 0;

      const leftX  = 150;
      const midX   = W / 2 - nodeW / 2;
      const rightX = W - 150 - nodeW;

      let ly = padTop;
      sources.forEach(n => { n.height = n.value * scale; n.y = ly; ly += n.height + gap; });

      const midHeight = grandTotal * scale;
      const midY = padTop;

      let ry = padTop;
      rightNodes.forEach(n => { n.height = n.value * scale; n.y = ry; ry += n.height + gap; });

      // Stack sub-flows inside the middle node (no gaps on middle — flows pool together)
      let mlc = midY;
      sources.forEach(s => { s.midH = s.height; s.midY = mlc; mlc += s.midH; });
      let mrc = midY;
      rightNodes.forEach(n => { n.midH = n.height; n.midY = mrc; mrc += n.midH; });

      const flowPath = (x1, yTop1, yBot1, x2, yTop2, yBot2) => {
        const cx = (x1 + x2) / 2;
        return `M ${x1} ${yTop1} C ${cx} ${yTop1} ${cx} ${yTop2} ${x2} ${yTop2} L ${x2} ${yBot2} C ${cx} ${yBot2} ${cx} ${yBot1} ${x1} ${yBot1} Z`;
      };

      const leftFlows = sources.map(s => `
        <path class="sankey-flow" fill="${s.color}" d="${flowPath(leftX + nodeW, s.y, s.y + s.height, midX, s.midY, s.midY + s.midH)}">
          <title>${escHtml(s.name)}: ${fmtCur(s.value)}</title>
        </path>`).join('');

      const rightFlows = rightNodes.map(n => `
        <path class="sankey-flow" fill="${n.color}" d="${flowPath(midX + nodeW, n.midY, n.midY + n.midH, rightX, n.y, n.y + n.height)}">
          <title>${escHtml(n.name)}: ${fmtCur(n.value)}</title>
        </path>`).join('');

      const labelFor = (node, side, total) => {
        const pct = total > 0 ? (node.value / total * 100).toFixed(1) : '0';
        const amt = fmtCur(node.value).replace('.00', '');
        const cy  = node.y + node.height / 2;
        const tx  = side === 'left' ? leftX - 10 : rightX + nodeW + 10;
        const anchor = side === 'left' ? 'end' : 'start';
        return `
          <text class="sankey-node-label" x="${tx}" y="${(cy - 4).toFixed(1)}" text-anchor="${anchor}">${escHtml(node.name)}</text>
          <text class="sankey-node-label sankey-node-label--amt" x="${tx}" y="${(cy + 10).toFixed(1)}" text-anchor="${anchor}">${amt} (${pct}%)</text>`;
      };

      const leftNodesSvg = sources.map(n => `
        <rect class="sankey-node" x="${leftX}" y="${n.y}" width="${nodeW}" height="${n.height}" fill="${n.color}" rx="2"/>
        ${labelFor(n, 'left', totalIn)}`).join('');

      const midLabel = `
        <text class="sankey-node-label" x="${midX + nodeW / 2}" y="${midY + midHeight / 2 - 4}" text-anchor="middle">Income</text>
        <text class="sankey-node-label sankey-node-label--amt" x="${midX + nodeW / 2}" y="${midY + midHeight / 2 + 10}" text-anchor="middle">${fmtCur(totalIn).replace('.00', '')} (100%)</text>`;
      const midNodeSvg = `
        <rect class="sankey-node" x="${midX}" y="${midY}" width="${nodeW}" height="${midHeight}" fill="#5cb3f2" rx="2"/>
        ${midLabel}`;

      const rightNodesSvg = rightNodes.map(n => `
        <rect class="sankey-node" x="${rightX}" y="${n.y}" width="${nodeW}" height="${n.height}" fill="${n.color}" rx="2"/>
        ${labelFor(n, 'right', rightTotal)}`).join('');

      return `<svg class="sankey-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
        ${leftFlows}
        ${rightFlows}
        ${leftNodesSvg}
        ${midNodeSvg}
        ${rightNodesSvg}
      </svg>`;
    };

    // ── Mobile (vertical) sankey: top=sources, middle=Income bar, bottom=categories
    const buildSankeyMobile = () => {
      const { incomeList, expenseList, totalIn, totalOut } = sankeyData;
      if (totalIn === 0 && totalOut === 0) {
        return '<div class="sankey-empty">No cash flow data this month.</div>';
      }
      const SOURCE_COLORS = ['#5cb3f2','#4a7dd4','#6c8ef5','#8a6bd6','#a78bfa','#7fc68a','#d99b4a'];
      const MAX_SRC = 4, MAX_CAT = 6;
      let sources = incomeList.slice(0, MAX_SRC);
      if (incomeList.length > MAX_SRC) {
        const rest = incomeList.slice(MAX_SRC).reduce((s, n) => s + n.value, 0);
        if (rest > 0) sources.push({ name: `${incomeList.length - MAX_SRC} Other`, value: rest });
      }
      sources = sources.map((s, i) => ({ ...s, color: SOURCE_COLORS[i % SOURCE_COLORS.length] }));

      let cats = expenseList.slice(0, MAX_CAT).map((c, i) => ({ ...c, color: CAT_PALETTE[i % CAT_PALETTE.length] }));
      if (expenseList.length > MAX_CAT) {
        const rest = expenseList.slice(MAX_CAT).reduce((s, n) => s + n.value, 0);
        if (rest > 0) cats.push({ name: `${expenseList.length - MAX_CAT} Other`, value: rest, color: CAT_PALETTE[6] });
      }

      const savings = Math.max(0, totalIn - totalOut);
      const deficit = Math.max(0, totalOut - totalIn);
      const rightNodes = [
        ...cats,
        ...(savings > 0 ? [{ name: 'Savings', value: savings, color: '#7fc68a' }] : [])
      ];
      if (deficit > 0) sources.push({ name: 'Deficit', value: deficit, color: '#e26b6b' });
      if (sources.length === 0) sources = [{ name: 'No income', value: rightNodes.reduce((s, n) => s + n.value, 0) || 1, color: '#6c8ef5' }];
      if (rightNodes.length === 0) return '<div class="sankey-empty">No expenses this month.</div>';

      const leftTotal  = sources.reduce((s, n) => s + n.value, 0);
      const rightTotal = rightNodes.reduce((s, n) => s + n.value, 0);
      const grandTotal = Math.max(leftTotal, rightTotal);

      const W = 360, H = 280;
      const padX = 12;
      const availW = W - 2 * padX;
      const gap = 3;
      const nodeH = 10;
      const topY = 16;
      const midY = H / 2 - nodeH / 2;
      const botY = H - 16 - nodeH;

      const gapsMax = Math.max(sources.length - 1, rightNodes.length - 1) * gap;
      const scale = grandTotal > 0 ? (availW - gapsMax) / grandTotal : 0;

      let lx = padX;
      sources.forEach(n => { n.width = n.value * scale; n.x = lx; lx += n.width + gap; });
      let rx = padX;
      rightNodes.forEach(n => { n.width = n.value * scale; n.x = rx; rx += n.width + gap; });

      const midWidth = grandTotal * scale;
      const midX = padX;

      let mlc = midX;
      sources.forEach(s => { s.midW = s.width; s.midX = mlc; mlc += s.midW; });
      let mrc = midX;
      rightNodes.forEach(n => { n.midW = n.width; n.midX = mrc; mrc += n.midW; });

      // Vertical flow ribbon: top edge from xL1→xL2, bottom edge from xR2→xR1
      const flowPath = (xL1, xR1, y1, xL2, xR2, y2) => {
        const cy = (y1 + y2) / 2;
        return `M ${xL1} ${y1} C ${xL1} ${cy} ${xL2} ${cy} ${xL2} ${y2} L ${xR2} ${y2} C ${xR2} ${cy} ${xR1} ${cy} ${xR1} ${y1} Z`;
      };

      const topFlows = sources.map(s => `
        <path class="sankey-flow" fill="${s.color}" d="${flowPath(s.x, s.x + s.width, topY + nodeH, s.midX, s.midX + s.midW, midY)}">
          <title>${escHtml(s.name)}: ${fmtCur(s.value)}</title>
        </path>`).join('');

      const botFlows = rightNodes.map(n => `
        <path class="sankey-flow" fill="${n.color}" d="${flowPath(n.midX, n.midX + n.midW, midY + nodeH, n.x, n.x + n.width, botY)}">
          <title>${escHtml(n.name)}: ${fmtCur(n.value)}</title>
        </path>`).join('');

      const sourceBars = sources.map(s => `
        <rect class="sankey-node" x="${s.x}" y="${topY}" width="${s.width}" height="${nodeH}" fill="${s.color}" rx="2"/>`).join('');
      const middleBar  = `<rect class="sankey-node" x="${midX}" y="${midY}" width="${midWidth}" height="${nodeH}" fill="#5cb3f2" rx="2"/>
        <text class="sankey-node-label" x="${W/2}" y="${midY - 4}" text-anchor="middle">Income · ${fmtCur(totalIn).replace('.00','')}</text>`;
      const catBars   = rightNodes.map(n => `
        <rect class="sankey-node" x="${n.x}" y="${botY}" width="${n.width}" height="${nodeH}" fill="${n.color}" rx="2"/>`).join('');

      // Compact legend rows shown below the SVG
      const legendItem = (n, total) => {
        const pct = total > 0 ? (n.value / total * 100).toFixed(0) : '0';
        return `<li class="sankey-leg-row">
          <span class="sankey-leg-dot" style="background:${n.color}"></span>
          <span class="sankey-leg-name">${escHtml(n.name)}</span>
          <span class="sankey-leg-amt">${fmtCur(n.value).replace('.00','')}</span>
          <span class="sankey-leg-pct">${pct}%</span>
        </li>`;
      };

      const svg = `<svg class="sankey-svg sankey-svg--mobile" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
        ${topFlows}
        ${botFlows}
        ${sourceBars}
        ${middleBar}
        ${catBars}
      </svg>`;

      return `${svg}
        <div class="sankey-legend-grid">
          <div class="sankey-leg-col">
            <div class="sankey-leg-head">Income</div>
            <ul class="sankey-leg-list">${sources.map(n => legendItem(n, leftTotal)).join('')}</ul>
          </div>
          <div class="sankey-leg-col">
            <div class="sankey-leg-head">Out</div>
            <ul class="sankey-leg-list">${rightNodes.map(n => legendItem(n, rightTotal)).join('')}</ul>
          </div>
        </div>`;
    };

    const sankeySvgHtml = buildSankeySvg();
    const sankeyMobileHtml = buildSankeyMobile();
    const sankeyRangeLabel = monthName.toUpperCase();

    // Cash Flow (6-month trend)
    const trendRows = Array.isArray(trend) ? trend : [];
    const flowIncome  = trendRows.map(r => Number(r.income) || 0);
    const flowExpense = trendRows.map(r => Number(r.expenses) || 0);
    const flowNet     = flowIncome.map((v, i) => v - flowExpense[i]);
    const totalIncome   = flowIncome.reduce((a, b) => a + b, 0);
    const totalExpenses = flowExpense.reduce((a, b) => a + b, 0);
    const netCashFlow   = totalIncome - totalExpenses;
    const cashPerMonth  = trendRows.length > 0 ? netCashFlow / trendRows.length : 0;
    const flowLabels = trendRows.map(r => {
      const [y, m] = r.month.split('-');
      return new Date(Number(y), Number(m) - 1, 1).toLocaleString('default', { month: 'short' });
    });
    const flowRangeLabel = trendRows.length > 0
      ? `${flowLabels[0]} – Current`
      : '—';

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

    // Budget overview — colored icon rows
    const BUDGET_ICONS = {
      food:         { emoji: '🍽', bg: '#f2994a' },
      groceries:    { emoji: '🛒', bg: '#f2994a' },
      dining:       { emoji: '🍽', bg: '#f2994a' },
      transport:    { emoji: '🚗', bg: '#e26b6b' },
      auto:         { emoji: '🚗', bg: '#e26b6b' },
      gas:          { emoji: '⛽', bg: '#e26b6b' },
      household:    { emoji: '🏠', bg: '#b45c32' },
      home:         { emoji: '🏠', bg: '#b45c32' },
      rent:         { emoji: '🏠', bg: '#b45c32' },
      health:       { emoji: '⚕', bg: '#ec85b5' },
      medical:      { emoji: '⚕', bg: '#ec85b5' },
      entertainment:{ emoji: '🎬', bg: '#7fc68a' },
      shopping:     { emoji: '🛍', bg: '#a78bfa' },
      travel:       { emoji: '✈', bg: '#60a5fa' },
      utilities:    { emoji: '⚡', bg: '#fbbf24' },
      subscriptions:{ emoji: '🔁', bg: '#a78bfa' },
      drinks:       { emoji: '🍺', bg: '#f2994a' }
    };
    const pickBudgetIcon = (name) => {
      const lower = (name || '').toLowerCase();
      for (const key of Object.keys(BUDGET_ICONS)) {
        if (lower.includes(key)) return BUDGET_ICONS[key];
      }
      return { emoji: (name || '?').trim().charAt(0).toUpperCase(), bg: '#6c8ef5' };
    };
    const budgetSection = budgetStatus.length === 0 ? '' : (() => {
      const sorted = [...budgetStatus].sort((a, b) => (b.spent / b.budget) - (a.spent / a.budget));
      const totalBudget = budgetStatus.reduce((s, b) => s + b.budget, 0);
      const totalSpent  = budgetStatus.reduce((s, b) => s + b.spent, 0);
      const totalPct    = totalBudget > 0 ? (totalSpent / totalBudget) * 100 : 0;
      const rows = sorted.slice(0, 6).map(b => {
        const pct    = b.budget > 0 ? b.spent / b.budget * 100 : 0;
        const barPct = Math.min(100, pct);
        const over   = b.spent > b.budget;
        const icon   = pickBudgetIcon(b.category);
        const fillColor = over ? '#e26b6b' : pct >= 80 ? '#f4a055' : icon.bg;
        return `
          <div class="bdg-row">
            <div class="bdg-icon" style="background:${icon.bg}">${icon.emoji}</div>
            <div class="bdg-body">
              <div class="bdg-top">
                <span class="bdg-name">${escHtml(b.category)}</span>
                <span class="bdg-pct" style="color:${over ? '#e26b6b' : 'var(--text-muted)'}">${pct.toFixed(1)}%</span>
              </div>
              <div class="bdg-bar"><div class="bdg-bar-fill" style="width:${barPct.toFixed(1)}%;background:${fillColor}"></div></div>
              <div class="bdg-meta">${fmtCur(b.spent)} of ${fmtCur(b.budget)}</div>
            </div>
          </div>`;
      }).join('');
      const overCount = budgetStatus.filter(b => b.spent > b.budget).length;
      return `
        <div class="card bdg-card" style="margin-bottom:16px">
          <div class="bdg-head">
            <h2 style="margin-bottom:0">Budget</h2>
            ${overCount > 0
              ? `<span class="badge badge-red">⚠ ${overCount} over limit</span>`
              : '<a href="#/budget" style="font-size:12px;color:var(--accent);text-decoration:none;font-weight:600">Manage →</a>'}
          </div>
          <div class="bdg-total">
            <div class="bdg-total-top">
              <span class="bdg-total-label">Total Budget</span>
              <span class="bdg-total-amounts">${fmtCur(totalSpent)} <span style="color:var(--text-muted)">of ${fmtCur(totalBudget)}</span></span>
            </div>
            <div class="bdg-bar bdg-bar--total"><div class="bdg-bar-fill" style="width:${Math.min(100, totalPct).toFixed(1)}%;background:linear-gradient(90deg,#8a6bd6,#a78bfa)"></div></div>
            <div class="bdg-total-pct">${totalPct.toFixed(1)}%</div>
          </div>
          <div class="bdg-grid">${rows}</div>
          ${budgetStatus.length > 6 ? `<div style="margin-top:14px"><a href="#/budget" style="font-size:12px;color:var(--accent);text-decoration:none;font-weight:600">View all ${budgetStatus.length} →</a></div>` : ''}
        </div>`;
    })();

    const allRows    = allMonthTx.rows || [];
    const dayOfMonth = today.getDate();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

    // ── Largest Transactions (top 5 expenses this month) ─────────────────────
    const largest = allRows
      .filter(r => r.amount < 0)
      .sort((a, b) => a.amount - b.amount)
      .slice(0, 5);
    const largestHtml = largest.length === 0
      ? '<p style="color:var(--text-muted);font-size:13px">No expenses this month.</p>'
      : largest.map(r => `
          <div class="largest-row">
            <div class="largest-left">
              ${typeof payeeLogoHtml === 'function' ? payeeLogoHtml(r.payee, r.amount) : ''}
              <div class="largest-body">
                <div class="largest-name">${escHtml(r.payee)}</div>
                <div class="largest-meta">${fmtDate(r.date)}${r.category ? ' · ' + escHtml(r.category) : ''}</div>
              </div>
            </div>
            <div class="largest-amt expense-text">${fmtCur(Math.abs(r.amount))}</div>
          </div>`).join('');

    // ── Spending by Day of Week ──────────────────────────────────────────────
    const dowNames  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dowTotals = new Array(7).fill(0);
    const dowCounts = new Array(7).fill(0);
    allRows.forEach(r => {
      if (r.amount >= 0) return;
      // Parse date as local to avoid UTC offset bumping Sun→Sat etc.
      const [y, m, d] = r.date.split('-').map(Number);
      const dow = new Date(y, m - 1, d).getDay();
      dowTotals[dow] += Math.abs(r.amount);
      dowCounts[dow] += 1;
    });
    const dowMax = Math.max(...dowTotals, 1);
    const dowPeakIdx = dowTotals.indexOf(Math.max(...dowTotals));
    const dowHtml = dowTotals.every(t => t === 0)
      ? '<p style="color:var(--text-muted);font-size:13px">No expenses this month.</p>'
      : `<div class="dow-grid">
          ${dowNames.map((name, i) => {
            const h = (dowTotals[i] / dowMax) * 100;
            const isPeak = i === dowPeakIdx && dowTotals[i] > 0;
            return `
              <div class="dow-col${isPeak ? ' dow-col--peak' : ''}" title="${name}: ${fmtCur(dowTotals[i])} across ${dowCounts[i]} tx">
                <div class="dow-amt">${dowTotals[i] > 0 ? fmtCur(dowTotals[i]).replace('.00', '') : ''}</div>
                <div class="dow-bar-wrap"><div class="dow-bar" style="height:${Math.max(h, 2).toFixed(1)}%"></div></div>
                <div class="dow-label">${name}</div>
              </div>`;
          }).join('')}
        </div>`;

    // ── Cumulative spending for current month (from transaction list) ──────────
    const dailyExpenseMap = {};
    (allMonthTx.rows || []).forEach(r => {
      if (r.amount < 0) {
        const day = parseInt(r.date.slice(8, 10));
        dailyExpenseMap[day] = (dailyExpenseMap[day] || 0) + Math.abs(r.amount);
      }
    });
    const cumulData = [];
    let runningCumul = 0;
    for (let d = 1; d <= dayOfMonth; d++) {
      runningCumul += dailyExpenseMap[d] || 0;
      cumulData.push(parseFloat(runningCumul.toFixed(2)));
    }
    const lastMonthLabel = new Date(today.getFullYear(), today.getMonth() - 1, 1)
      .toLocaleString('default', { month: 'short' });
    const prevMonthTrendRow = trendRows.length >= 2 ? trendRows[trendRows.length - 2] : null;
    let prevPaceLine = null;
    if (prevMonthTrendRow) {
      const prevExp = prevMonthTrendRow.expenses || 0;
      const prevDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const daysInPrevMonth = new Date(prevDate.getFullYear(), prevDate.getMonth() + 1, 0).getDate();
      const dailyPace = prevExp / daysInPrevMonth;
      prevPaceLine = Array.from({ length: dayOfMonth }, (_, i) =>
        parseFloat(((i + 1) * dailyPace).toFixed(2))
      );
    }

    // ── Bills list for duo grid ──────────────────────────────────────────────
    const billsListHtml = reminders.length === 0
      ? '<p style="color:var(--text-muted);font-size:13px">No upcoming bills.</p>'
      : reminders.slice(0, 5).map(r => {
          const overdue = r.due_date < todayStr;
          const daysUntil = Math.round((new Date(r.due_date) - new Date(todayStr)) / 86400000);
          const dueLabel = overdue
            ? `${Math.abs(daysUntil)}d overdue`
            : daysUntil === 0 ? 'Due today' : `in ${daysUntil}d`;
          return `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--border)">
              <div style="display:flex;align-items:center;gap:9px">
                <div style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${overdue ? 'var(--danger)' : daysUntil <= 3 ? 'var(--warning)' : 'var(--success)'}"></div>
                <div>
                  <div style="font-size:13px;font-weight:600">${escHtml(r.title)}</div>
                  <div style="font-size:11px;color:${overdue ? 'var(--danger)' : 'var(--text-muted)'};font-weight:${overdue ? '600' : '400'}">${dueLabel}</div>
                </div>
              </div>
              <div style="font-size:13px;font-weight:600;color:var(--text-muted)">${r.amount ? fmtCur(Math.abs(r.amount)) : '—'}</div>
            </div>`;
        }).join('');

    // ── Stacked donut for right panel ────────────────────────────────────────
    const catDonutBlockStack = byCategory.length === 0
      ? '<p style="color:var(--text-muted);font-size:13px">No expense data this month.</p>'
      : `<div class="donut-wrap--stacked">
          <div class="donut-canvas-wrap" style="width:160px;height:160px">
            <canvas id="dash-category-donut"></canvas>
            <div class="donut-center">
              <div class="donut-center-amt" style="font-size:19px">${fmtCur(catTotal).replace('.00', '')}</div>
              <div class="donut-center-label">Total</div>
            </div>
          </div>
          <ul class="donut-legend" style="width:100%">${donutLegendHtml}</ul>
        </div>`;

    // ── Savings bar inner (no card wrapper) ──────────────────────────────────
    const savingsBarInner = summary.income > 0 ? `
      <div style="margin-top:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px">
          <span style="font-size:11px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.05em">Savings Rate</span>
          <span style="font-weight:700;font-size:14px;color:${savingsColor}">${savingsRate.toFixed(1)}%</span>
        </div>
        <div style="height:7px;background:var(--surface2);border-radius:4px;overflow:hidden;position:relative">
          <div style="position:absolute;left:0;top:0;bottom:0;width:${spentPct.toFixed(1)}%;background:var(--danger);border-radius:4px 0 0 4px"></div>
          <div style="position:absolute;left:${spentPct.toFixed(1)}%;top:0;bottom:0;width:${savedPct.toFixed(1)}%;background:var(--success);border-radius:0 4px 4px 0"></div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:5px;font-size:11px;color:var(--text-muted)">
          <span>Spent ${fmtCur(Math.abs(summary.expenses))}</span>
          <span>Saved ${fmtCur(Math.max(0, summary.net))}</span>
        </div>
      </div>` : '';

    // Greeting
    const hour = today.getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const dateLabel = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    // Net hero colour + label
    const netPositive = summary.net >= 0;
    const netLabel    = netPositive ? 'surplus' : 'deficit';
    const netClass    = netPositive ? 'positive' : 'negative';

    // Month progress (day N of M)
    const monthProgress = (dayOfMonth / daysInMonth) * 100;
    const ringRadius = 18;
    const ringCirc = 2 * Math.PI * ringRadius;
    const ringOffset = ringCirc * (1 - monthProgress / 100);

    view.innerHTML = `
    <div class="dash-enter">
      <!-- Greeting bar -->
      <div class="dash-greeting">
        <div>
          <div class="dash-greeting-text">${greeting} <span class="wave">👋</span></div>
          <div class="dash-greeting-sub">${dateLabel} · ${monthName}</div>
        </div>
        <div class="dash-month-ring" title="Day ${dayOfMonth} of ${daysInMonth}">
          <svg viewBox="0 0 48 48" width="48" height="48">
            <circle cx="24" cy="24" r="${ringRadius}" fill="none" stroke="var(--surface2)" stroke-width="4"/>
            <circle cx="24" cy="24" r="${ringRadius}" fill="none" stroke="url(#ringGrad)" stroke-width="4"
              stroke-linecap="round"
              stroke-dasharray="${ringCirc.toFixed(2)}"
              stroke-dashoffset="${ringOffset.toFixed(2)}"
              transform="rotate(-90 24 24)"/>
            <defs>
              <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#6c8ef5"/>
                <stop offset="100%" stop-color="#a78bfa"/>
              </linearGradient>
            </defs>
            <text x="24" y="28" text-anchor="middle" style="fill:var(--text);font-size:12px;font-weight:700;font-family:system-ui">${dayOfMonth}</text>
          </svg>
          <div class="dash-month-ring-sub">of ${daysInMonth}</div>
        </div>
      </div>

      <!-- 2-column layout -->
      <div class="dash-layout">

        <!-- ── MAIN COLUMN ── -->
        <div class="dash-main-col">

          <!-- Spending chart -->
          <div class="card dash-spend-card">
            <div class="dash-spend-hdr">
              <div>
                <div class="dash-spend-label">Spent This Month</div>
                <div class="dash-spend-amount">${fmtCur(Math.abs(summary.expenses))}</div>
                <div class="dash-spend-sub">
                  <span style="color:var(--accent)">•</span> ${monthName}
                  ${prevPaceLine ? `<span class="dash-vs-label">— vs ${lastMonthLabel}</span>` : ''}
                </div>
              </div>
              <div class="dash-spend-right-stats">
                <div class="dash-mini-stat">
                  <div class="dash-mini-stat-l">Income</div>
                  <div class="dash-mini-stat-v income-text">${fmtCur(summary.income)}</div>
                </div>
                <div class="dash-mini-stat">
                  <div class="dash-mini-stat-l">Net</div>
                  <div class="dash-mini-stat-v ${netPositive ? 'income-text' : 'expense-text'}">${netPositive ? '+' : ''}${fmtCur(summary.net)}</div>
                </div>
                <div class="dash-mini-stat">
                  <div class="dash-mini-stat-l">Subs</div>
                  <div class="dash-mini-stat-v">${fmtCur(subTotal)}<span style="font-size:10px;color:var(--text-muted)">/mo</span></div>
                </div>
              </div>
            </div>
            <div class="dash-spend-chart-wrap">
              <canvas id="dash-cumulative-chart"></canvas>
            </div>
          </div>

          <!-- Latest Tx + Upcoming Bills -->
          <div class="dash-duo-grid">
            <div class="card">
              <div class="dash-card-head">
                <h2 style="margin-bottom:0">Latest Transactions</h2>
                <a href="#/transactions" class="dash-see-more">See all →</a>
              </div>
              ${recentList}
            </div>
            <div class="card">
              <div class="dash-card-head">
                <h2 style="margin-bottom:0">Upcoming Bills</h2>
                ${overdueReminders.length > 0
                  ? `<span class="badge badge-red">⚠ ${overdueReminders.length} overdue</span>`
                  : '<span style="font-size:12px;color:var(--success);font-weight:600">✓ All clear</span>'}
              </div>
              ${billsListHtml}
              ${reminders.length > 5 ? `<div style="margin-top:10px"><a href="#/reminders" class="dash-see-more">View all ${reminders.length} →</a></div>` : ''}
            </div>
          </div>

          <!-- Cash Flow (pill bars) -->
          <div class="card dash-flow-card">
            <div class="dash-card-head">
              <h2 style="margin-bottom:0">Cash Flow</h2>
              <span class="dash-flow-range">${flowRangeLabel}</span>
            </div>
            ${trendRows.length === 0
              ? '<p style="color:var(--text-muted);font-size:13px">No trend data yet.</p>'
              : `<div class="flow-chart"><canvas id="dash-cash-flow"></canvas></div>
                 <div class="flow-stats">
                   <div class="flow-stat"><span class="flow-stat-label">Total Income</span><span class="flow-stat-val">${fmtCur(totalIncome).replace('.00','')}</span></div>
                   <div class="flow-stat"><span class="flow-stat-label">Total Expenses</span><span class="flow-stat-val">${fmtCur(totalExpenses).replace('.00','')}</span></div>
                   <div class="flow-stat"><span class="flow-stat-label">Net Cash Flow</span><span class="flow-stat-val ${netCashFlow >= 0 ? 'flow-stat-pos' : 'flow-stat-neg'}">${fmtCur(netCashFlow).replace('.00','')}</span></div>
                   <div class="flow-stat"><span class="flow-stat-label">Cash Flow / Mo</span><span class="flow-stat-val">${fmtCur(cashPerMonth).replace('.00','')}</span></div>
                 </div>`
            }
          </div>

          <!-- Where Money Flows (Sankey) -->
          <div class="card sankey-card" style="margin-bottom:16px">
            <div class="dash-card-head">
              <h2 style="margin-bottom:0">Where Money Flows</h2>
              <span class="sankey-range">${sankeyRangeLabel}</span>
            </div>
            <div class="sankey-wrap sankey-wrap--desktop">${sankeySvgHtml}</div>
            <div class="sankey-wrap sankey-wrap--mobile">${sankeyMobileHtml}</div>
          </div>

          <!-- Budget -->
          ${budgetSection}

        </div>

        <!-- ── RIGHT PANEL ── -->
        <div class="dash-right-panel">

          <!-- Category Breakdown -->
          <div class="card" style="margin-bottom:16px">
            <div class="dash-card-head">
              <h2 style="margin-bottom:0">Category Breakdown</h2>
            </div>
            ${catDonutBlockStack}
          </div>

          <!-- Income + Savings Rate -->
          <div class="card" style="margin-bottom:16px">
            <h2>Income This Month</h2>
            <div class="dash-income-big">${fmtCur(summary.income)}</div>
            ${savingsBarInner}
          </div>

          <!-- Largest Expenses -->
          <div class="card">
            <div class="dash-card-head">
              <h2 style="margin-bottom:0">Largest Expenses</h2>
              <a href="#/transactions" class="dash-see-more">All →</a>
            </div>
            <div class="largest-list">${largestHtml}</div>
          </div>

        </div>

      </div>
    </div>
    `;

    // Expense Categories donut
    const donutCanvas = document.getElementById('dash-category-donut');
    if (donutCanvas && typeof Chart !== 'undefined' && donutSegments.length > 0) {
      if (this._donutChart) this._donutChart.destroy();
      this._donutChart = new Chart(donutCanvas, {
        type: 'doughnut',
        data: {
          labels: donutSegments.map(s => s.name),
          datasets: [{
            data: donutSegments.map(s => s.total),
            backgroundColor: donutSegments.map(s => s.color),
            borderColor: 'rgba(0,0,0,0)',
            borderWidth: 0,
            hoverOffset: 6,
            spacing: 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '72%',
          layout: { padding: 4 },
          plugins: {
            legend: { display: false },
            tooltip: { enabled: false }
          }
        }
      });
    }

    // Cumulative spending chart (filled area + last month pace dashed line)
    const cumulCanvas = document.getElementById('dash-cumulative-chart');
    if (cumulCanvas && typeof Chart !== 'undefined' && cumulData.length > 0) {
      if (this._cumulChart) this._cumulChart.destroy();
      const dayLabels = Array.from({ length: dayOfMonth }, (_, i) => String(i + 1));
      const datasets = [
        {
          label: `${monthName} (actual)`,
          data: cumulData,
          borderColor: 'rgba(93,155,235,0.95)',
          backgroundColor: ctx => {
            const { chart } = ctx;
            const { ctx: c, chartArea } = chart;
            if (!chartArea) return 'rgba(93,155,235,0.15)';
            const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
            g.addColorStop(0, 'rgba(93,155,235,0.40)');
            g.addColorStop(1, 'rgba(93,155,235,0.00)');
            return g;
          },
          borderWidth: 2.5,
          tension: 0.4,
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: '#5d9beb'
        }
      ];
      if (prevPaceLine) {
        datasets.push({
          label: `${lastMonthLabel} (pace)`,
          data: prevPaceLine,
          borderColor: 'rgba(200,220,255,0.22)',
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          borderDash: [6, 4],
          tension: 0.4,
          fill: false,
          pointRadius: 0
        });
      }
      this._cumulChart = new Chart(cumulCanvas, {
        type: 'line',
        data: { labels: dayLabels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: ctx => ` ${ctx.dataset.label}: ${fmtCur(ctx.raw)}`
              }
            }
          },
          scales: {
            x: {
              ticks: { color: '#8aa0bf', font: { size: 10 }, maxTicksLimit: 10 },
              grid: { display: false }
            },
            y: {
              ticks: {
                color: '#8aa0bf',
                font: { size: 10 },
                callback: v => '$' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v))
              },
              grid: { color: 'rgba(120,168,220,0.07)', drawTicks: false }
            }
          }
        }
      });
    }

    // Cash Flow chart — pill-shaped stacked bars (income above 0, expenses below) + dashed net line
    const flowCanvas = document.getElementById('dash-cash-flow');
    if (flowCanvas && typeof Chart !== 'undefined' && trendRows.length > 0) {
      if (this._flowChart) this._flowChart.destroy();
      this._flowChart = new Chart(flowCanvas, {
        data: {
          labels: flowLabels,
          datasets: [
            {
              type: 'bar',
              label: 'Income',
              data: flowIncome,
              backgroundColor: 'rgba(136,178,240,0.92)',
              borderRadius: { topLeft: 14, topRight: 14, bottomLeft: 0, bottomRight: 0 },
              borderSkipped: false,
              maxBarThickness: 26,
              stack: 'flow',
              order: 2
            },
            {
              type: 'bar',
              label: 'Expenses',
              data: flowExpense.map(e => -e),
              backgroundColor: 'rgba(58,92,189,0.92)',
              borderRadius: { topLeft: 0, topRight: 0, bottomLeft: 14, bottomRight: 14 },
              borderSkipped: false,
              maxBarThickness: 26,
              stack: 'flow',
              order: 2
            },
            {
              type: 'line',
              label: 'Net',
              data: flowNet,
              borderColor: 'rgba(234,242,255,0.7)',
              backgroundColor: 'rgba(234,242,255,0.05)',
              borderDash: [5, 5],
              borderWidth: 1.5,
              tension: 0.35,
              pointRadius: 4,
              pointHoverRadius: 6,
              pointBackgroundColor: '#fff',
              pointBorderColor: ctx => (ctx.raw >= 0 ? '#5be0a0' : '#ff7a8a'),
              pointBorderWidth: 2,
              order: 1
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: ctx => {
                  const v = Math.abs(Number(ctx.raw));
                  return ` ${ctx.dataset.label}: $${v.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
                }
              }
            }
          },
          scales: {
            x: {
              stacked: true,
              ticks: { color: '#8aa0bf', font: { size: 11, weight: '600' } },
              grid: { display: false }
            },
            y: {
              stacked: true,
              ticks: {
                color: '#8aa0bf', font: { size: 10 },
                callback: v => v === 0 ? '0' : '$' + (Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(1) + 'k' : Math.abs(v))
              },
              grid: { color: 'rgba(120,168,220,0.10)', drawTicks: false, borderDash: [3, 3] }
            }
          }
        }
      });
    }
  }
};
