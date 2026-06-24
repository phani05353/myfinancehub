const budgetModule = {
  currentMonth: new Date().toISOString().slice(0, 7),

  async init() {
    this.currentMonth = new Date().toISOString().slice(0, 7);
    document.getElementById('view').innerHTML = `
      <div class="budget-title-row" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px">
        <h1 style="margin-bottom:0;flex:1">💰 Budget</h1>
        <div class="budget-toolbar" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input type="month" id="budget-month" value="${this.currentMonth}"
            style="width:160px" onchange="budgetModule.changeMonth(this.value)">
          <button class="btn btn-primary" onclick="budgetModule.openAddModal()">+ Set Budget</button>
        </div>
      </div>
      <div id="budget-summary"></div>
      <div id="budget-grid"></div>
    `;
    await this.load();
  },

  async changeMonth(month) {
    this.currentMonth = month;
    await this.load();
  },

  async load() {
    const [status, categories] = await Promise.all([
      api(`/api/budgets/status?month=${this.currentMonth}`),
      api('/api/categories')
    ]);
    this.renderSummary(status);
    this.renderCards(status, categories);
  },

  renderSummary(status) {
    if (status.length === 0) {
      document.getElementById('budget-summary').innerHTML = '';
      return;
    }
    const totalBudget = status.reduce((s, b) => s + b.budget, 0);
    const totalSpent  = status.reduce((s, b) => s + b.spent,  0);
    const remaining   = totalBudget - totalSpent;
    const overCount   = status.filter(b => b.spent > b.budget).length;
    const overallPct  = totalBudget > 0 ? Math.min(100, totalSpent / totalBudget * 100) : 0;
    const barColor    = overallPct > 100 ? 'var(--danger)' : overallPct >= 100 ? 'var(--warning)' : overallPct >= 80 ? 'var(--warning)' : 'var(--success)';

    document.getElementById('budget-summary').innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Total Budget</div>
          <div class="kpi-value">${fmtCur(totalBudget)}</div>
          <span class="kpi-badge kpi-badge--muted">${status.length} categories</span>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Total Spent</div>
          <div class="kpi-value" style="color:${totalSpent > totalBudget ? 'var(--danger)' : 'var(--text)'}">${fmtCur(totalSpent)}</div>
          <span class="kpi-badge ${totalSpent > totalBudget ? 'kpi-badge--danger' : 'kpi-badge--muted'}">${overallPct.toFixed(1)}% of budget</span>
        </div>
        <div class="kpi-card kpi-card--feature">
          <div class="kpi-label">${remaining >= 0 ? 'Remaining' : 'Over Budget'}</div>
          <div class="kpi-value" style="color:${remaining >= 0 ? 'var(--success)' : 'var(--danger)'}">${fmtCur(Math.abs(remaining))}</div>
          <span class="kpi-badge ${overCount > 0 ? 'kpi-badge--danger' : 'kpi-badge--muted'}">${overCount > 0 ? `${overCount} category${overCount > 1 ? 's' : ''} over limit` : 'All within budget'}</span>
        </div>
      </div>
      <div class="card" style="margin-bottom:20px;padding:16px 18px">
        <div class="cat-bar-row">
          <div class="cat-bar-head">
            <span>Overall Budget Usage</span>
            <span class="cat-bar-amt" style="color:${barColor};font-weight:700">${overallPct.toFixed(1)}%</span>
          </div>
          <div class="cat-bar-track">
            <div class="cat-bar-fill" style="width:${overallPct.toFixed(1)}%;background:${barColor}"></div>
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:12px;color:var(--text-muted)">
            <span>Spent ${fmtCur(totalSpent)}</span>
            <span>Budget ${fmtCur(totalBudget)}</span>
          </div>
        </div>
      </div>
    `;
  },

  renderCards(status, categories) {
    const grid = document.getElementById('budget-grid');
    if (status.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">💰</div>
          <p>No budgets set yet.</p>
          <p style="margin-top:8px">
            <button class="btn btn-primary" onclick="budgetModule.openAddModal()">Set your first budget</button>
          </p>
        </div>`;
      return;
    }

    // Sort: over-budget first, then by % used descending
    const sorted = [...status].sort((a, b) => {
      const pctA = a.budget > 0 ? a.spent / a.budget : 0;
      const pctB = b.budget > 0 ? b.spent / b.budget : 0;
      return pctB - pctA;
    });

    grid.innerHTML = `
      <div class="card" style="padding:18px 20px">
        <div class="dash-card-head">
          <h3>Category Budgets</h3>
          <span class="badge badge-gray">${sorted.length} ${sorted.length === 1 ? 'category' : 'categories'}</span>
        </div>
        <div class="cat-grid">${sorted.map(b => this.cardHtml(b)).join('')}</div>
      </div>`;
  },

  cardHtml(b) {
    const pct       = b.budget > 0 ? b.spent / b.budget * 100 : 0;
    const over      = b.spent > b.budget;
    const remaining = b.budget - b.spent;
    const barPct    = Math.min(100, pct);
    const barColor  = pct > 100 ? 'var(--danger)' : pct >= 100 ? 'var(--warning)' : pct >= 80 ? 'var(--warning)' : 'var(--success)';
    const pctLabel  = pct.toFixed(1) + '%';

    const catJs = escHtml(b.category).replace(/'/g, "\\'");
    const attn = over ? ' over' : pct >= 80 ? ' warn' : '';
    return `
      <div class="cat-bar-row${attn}">
        <div class="cat-bar-head">
          <span style="cursor:pointer" onclick="budgetModule.openTxModal('${catJs}','${this.currentMonth}')">${escHtml(b.category)} →</span>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="cat-bar-amt"><span style="color:${barColor};font-weight:700">${fmtCur(b.spent)}</span> of ${fmtCur(b.budget)}</span>
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();budgetModule.openEditModal(${b.id},'${escHtml(b.category)}',${b.budget})">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();budgetModule.deleteBudget(${b.id})">✕</button>
          </div>
        </div>

        <div class="cat-bar-track" style="cursor:pointer" onclick="budgetModule.openTxModal('${catJs}','${this.currentMonth}')">
          <div class="cat-bar-fill" style="width:${barPct.toFixed(1)}%;background:${barColor}"></div>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;margin-top:7px">
          <span style="color:${over ? 'var(--danger)' : 'var(--text-muted)'};font-weight:600">
            ${over
              ? `⚠ ${fmtCur(Math.abs(remaining))} over budget`
              : `${fmtCur(remaining)} remaining`}
          </span>
          <span class="badge ${pct > 100 ? 'badge-red' : pct >= 80 ? 'badge-yellow' : 'badge-green'}">${pctLabel}</span>
        </div>
      </div>
    `;
  },

  async openAddModal() {
    const categories = await api('/api/categories').catch(() => []);
    openModal(`
      <h2>Set Budget</h2>
      <form id="budget-form" style="margin-top:16px">
        <div class="form-group" style="margin-bottom:14px">
          <label>Category *</label>
          <select id="budget-cat" required>
            <option value="">— Select category —</option>
            ${categories.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="margin-bottom:20px">
          <label>Monthly Budget *</label>
          <input type="number" id="budget-amount" step="0.01" min="0.01" placeholder="e.g. 500.00" required>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Budget</button>
        </div>
      </form>
    `);
    document.getElementById('budget-form').onsubmit = e => { e.preventDefault(); this.submitSave(); };
  },

  openEditModal(id, category, amount) {
    openModal(`
      <h2>Edit Budget</h2>
      <form id="budget-form" style="margin-top:16px">
        <div class="form-group" style="margin-bottom:14px">
          <label>Category</label>
          <input type="text" value="${escHtml(category)}" disabled style="opacity:.6;cursor:not-allowed">
        </div>
        <div class="form-group" style="margin-bottom:20px">
          <label>Monthly Budget *</label>
          <input type="number" id="budget-amount" step="0.01" min="0.01" value="${amount}" required>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Changes</button>
        </div>
      </form>
    `);
    document.getElementById('budget-form').onsubmit = e => { e.preventDefault(); this.submitSave(category); };
  },

  async submitSave(category) {
    const cat    = category || document.getElementById('budget-cat')?.value;
    const amount = document.getElementById('budget-amount').value;
    if (!cat) { toast('Select a category', 'error'); return; }
    try {
      await api('/api/budgets', { method: 'POST', body: { category: cat, amount } });
      closeModal();
      toast('Budget saved');
      await this.load();
    } catch (e) { toast(e.message, 'error'); }
  },

  async deleteBudget(id) {
    if (!confirm('Remove this budget?')) return;
    try {
      await api(`/api/budgets/${id}`, { method: 'DELETE' });
      toast('Budget removed');
      await this.load();
    } catch (e) { toast(e.message, 'error'); }
  },

  async openTxModal(category, month) {
    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const [y, m] = month.split('-');
    const label = `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;

    openModal(`
      <h2 style="margin-bottom:2px">${escHtml(category)}</h2>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">${label}</p>
      <div id="budget-tx-list" style="color:var(--text-muted)">Loading…</div>
    `);

    try {
      const { rows } = await api(`/api/transactions?category=${encodeURIComponent(category)}&month=${month}&limit=100`);

      if (!rows || rows.length === 0) {
        document.getElementById('budget-tx-list').innerHTML =
          '<p style="color:var(--text-muted);text-align:center;padding:24px 0">No transactions this month.</p>';
        return;
      }

      const total = rows.reduce((s, t) => s + t.amount, 0);
      document.getElementById('budget-tx-list').innerHTML = `
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Payee</th>
                <th style="text-align:right">Amount</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(t => `
                <tr>
                  <td style="white-space:nowrap;color:var(--text-muted)">${fmtDate(t.date)}</td>
                  <td>${escHtml(t.payee)}</td>
                  <td style="text-align:right">${fmt(t.amount)}</td>
                  <td style="color:var(--text-muted);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(t.notes || '')}</td>
                </tr>
              `).join('')}
            </tbody>
            <tfoot>
              <tr style="border-top:2px solid var(--border)">
                <td colspan="2" style="font-weight:600;padding-top:8px">Total spent</td>
                <td style="text-align:right;font-weight:700;padding-top:8px">${fmtCur(Math.abs(total))}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      `;
    } catch (e) { toast(e.message, 'error'); }
  }
};
