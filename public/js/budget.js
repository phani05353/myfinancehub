const budgetModule = {
  currentMonth: new Date().toISOString().slice(0, 7),

  async init() {
    this.currentMonth = new Date().toISOString().slice(0, 7);
    document.getElementById('view').innerHTML = `
      <div class="page-title-row" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:10px">
        <h1 style="margin-bottom:0">💰 Budget</h1>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
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
      <div class="stats-grid" style="margin-bottom:16px">
        <div class="stat-card">
          <div class="label">Total Budget</div>
          <div class="value neutral">${fmtCur(totalBudget)}</div>
          <div class="sublabel">${status.length} categories</div>
        </div>
        <div class="stat-card">
          <div class="label">Total Spent</div>
          <div class="value ${totalSpent > totalBudget ? 'expense' : 'income'}">${fmtCur(totalSpent)}</div>
          <div class="sublabel">${overallPct.toFixed(1)}% of budget</div>
        </div>
        <div class="stat-card">
          <div class="label">${remaining >= 0 ? 'Remaining' : 'Over Budget'}</div>
          <div class="value ${remaining >= 0 ? 'income' : 'expense'}">${fmtCur(Math.abs(remaining))}</div>
          <div class="sublabel">${overCount > 0 ? `${overCount} category${overCount > 1 ? 's' : ''} over limit` : 'All within budget'}</div>
        </div>
      </div>
      <div class="card" style="margin-bottom:20px;padding:14px 18px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em">Overall Budget Usage</span>
          <span style="font-weight:700;font-size:14px;color:${barColor}">${overallPct.toFixed(1)}%</span>
        </div>
        <div class="budget-bar-track">
          <div class="budget-bar-fill" style="width:${overallPct.toFixed(1)}%;background:${barColor}"></div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:11px;color:var(--text-muted)">
          <span>Spent ${fmtCur(totalSpent)}</span>
          <span>Budget ${fmtCur(totalBudget)}</span>
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

    grid.innerHTML = `<div class="budget-cards">${sorted.map(b => this.cardHtml(b)).join('')}</div>`;
  },

  cardHtml(b) {
    const pct       = b.budget > 0 ? b.spent / b.budget * 100 : 0;
    const over      = b.spent > b.budget;
    const remaining = b.budget - b.spent;
    const barPct    = Math.min(100, pct);
    const barColor  = pct > 100 ? 'var(--danger)' : pct >= 100 ? 'var(--warning)' : pct >= 80 ? 'var(--warning)' : 'var(--success)';
    const pctLabel  = pct.toFixed(1) + '%';

    const catJs = escHtml(b.category).replace(/'/g, "\\'");
    return `
      <div class="budget-card ${over ? 'budget-card--over' : ''}">
        <div class="budget-card-header">
          <span class="budget-cat">${escHtml(b.category)}</span>
          <div style="display:flex;gap:6px">
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();budgetModule.openEditModal(${b.id},'${escHtml(b.category)}',${b.budget})">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();budgetModule.deleteBudget(${b.id})">✕</button>
          </div>
        </div>

        <div class="budget-card-body" onclick="budgetModule.openTxModal('${catJs}','${this.currentMonth}')">
          <div class="budget-amounts">
            <span style="font-size:22px;font-weight:700;color:${barColor}">${fmtCur(b.spent)}</span>
            <span style="color:var(--text-muted);font-size:13px">of ${fmtCur(b.budget)}</span>
          </div>

          <div class="budget-bar-track" style="margin:10px 0 6px">
            <div class="budget-bar-fill" style="width:${barPct.toFixed(1)}%;background:${barColor}"></div>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px">
            <span style="color:${over ? 'var(--danger)' : 'var(--success)'};font-weight:600">
              ${over
                ? `⚠ ${fmtCur(Math.abs(remaining))} over budget`
                : `${fmtCur(remaining)} remaining`}
            </span>
            <span class="budget-pct-badge" style="background:${barColor}20;color:${barColor}">${pctLabel} · View →</span>
          </div>
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
