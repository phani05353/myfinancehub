const transactionsModule = {
  page: 0,
  pageSize: 50,
  filters: {},
  total: 0,

  async init() {
    this.page = 0;
    this.filters = {};
    await this.render();
  },

  async render() {
    const [categories, payees] = await Promise.all([
      api('/api/categories'),
      api('/api/payees')
    ]);

    const today = new Date().toISOString().slice(0, 7);

    document.getElementById('view').innerHTML = `
      <div class="page-title-row" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <h1 style="margin-bottom:0">Transactions</h1>
        <button class="btn btn-primary" onclick="transactionsModule.openAddModal()">+ Add</button>
      </div>

      <div class="card" style="margin-bottom:20px">
        <div class="toolbar">
          <div class="form-group" style="flex:0 0 160px">
            <label>Month</label>
            <input type="month" id="filter-month" value="${today}">
          </div>
          <div class="form-group" style="flex:1;min-width:140px">
            <label>Search</label>
            <input type="text" id="filter-search" placeholder="Payee, notes, category…">
          </div>
          <div class="form-group" style="flex:0 0 160px">
            <label>Category</label>
            <select id="filter-category">
              <option value="">All Categories</option>
              ${categories.map(c => `<option>${c}</option>`).join('')}
            </select>
          </div>
          <div style="display:flex;gap:8px;align-self:flex-end">
            <button class="btn btn-primary" onclick="transactionsModule.applyFilters()">Filter</button>
            <button class="btn btn-ghost" onclick="transactionsModule.clearFilters()">Clear</button>
          </div>
        </div>
      </div>

      <div id="summary-row" style="margin-bottom:16px"></div>

      <div class="card">
        <div class="table-wrap">
          <table class="tx-table">
            <thead>
              <tr>
                <th>Date</th><th>Payee</th><th>Category</th>
                <th style="text-align:right">Amount</th><th>Notes</th><th>Actions</th>
              </tr>
            </thead>
            <tbody id="tx-body">
              <tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-muted)">Loading…</td></tr>
            </tbody>
          </table>
        </div>
        <div class="pagination" id="tx-pagination"></div>
      </div>
    `;

    document.getElementById('filter-month').addEventListener('keydown', e => { if (e.key === 'Enter') this.applyFilters(); });
    document.getElementById('filter-search').addEventListener('keydown', e => { if (e.key === 'Enter') this.applyFilters(); });

    await this.loadRows();
  },

  async applyFilters() {
    this.page = 0;
    this.filters = {
      month: document.getElementById('filter-month')?.value || '',
      search: document.getElementById('filter-search')?.value || '',
      category: document.getElementById('filter-category')?.value || ''
    };
    await this.loadRows();
  },

  async clearFilters() {
    this.page = 0;
    this.filters = {};
    const today = new Date().toISOString().slice(0, 7);
    document.getElementById('filter-month').value = today;
    document.getElementById('filter-search').value = '';
    document.getElementById('filter-category').value = '';
    await this.loadRows();
  },

  async loadRows() {
    const params = new URLSearchParams({
      limit: this.pageSize,
      offset: this.page * this.pageSize,
      ...this.filters
    });
    const { rows, total } = await api(`/api/transactions?${params}`);
    this.total = total;

    const month = this.filters.month || new Date().toISOString().slice(0, 7);
    const summary = await api(`/api/transactions/summary?month=${month}`);

    const sumEl = document.getElementById('summary-row');
    if (sumEl) {
      sumEl.innerHTML = `
        <div class="stats-grid" style="margin-bottom:0">
          <div class="stat-card" style="padding:14px 18px">
            <div class="label">Income</div>
            <div class="value income" style="font-size:20px">${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(summary.income)}</div>
          </div>
          <div class="stat-card" style="padding:14px 18px">
            <div class="label">Expenses</div>
            <div class="value expense" style="font-size:20px">${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(summary.expenses))}</div>
          </div>
          <div class="stat-card" style="padding:14px 18px">
            <div class="label">Net</div>
            <div class="value ${summary.net >= 0 ? 'income' : 'expense'}" style="font-size:20px">${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(summary.net)}</div>
          </div>
          <div class="stat-card" style="padding:14px 18px">
            <div class="label">Transactions</div>
            <div class="value neutral" style="font-size:20px">${total}</div>
          </div>
        </div>
      `;
    }

    const tbody = document.getElementById('tx-body');
    if (!tbody) return;
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state" style="padding:32px"><div class="empty-icon">📭</div><p>No transactions found</p></div></td></tr>`;
    } else {
      tbody.innerHTML = rows.map(r => `
        <tr>
          <td data-label="Date" style="white-space:nowrap">${fmtDate(r.date)}</td>
          <td data-label="Payee">${escHtml(r.payee)}</td>
          <td data-label="Category">${r.category ? `<span class="badge badge-blue">${escHtml(r.category)}</span>` : '<span class="badge badge-gray">—</span>'}</td>
          <td data-label="Amount" style="text-align:right">${fmt(r.amount)}</td>
          <td data-label="Notes" style="color:var(--text-muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(r.notes || '')}</td>
          <td data-label="Actions" style="white-space:nowrap">
            <button class="btn btn-ghost btn-sm" onclick="transactionsModule.openEditModal(${r.id})">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="transactionsModule.deleteRow(${r.id})">Del</button>
          </td>
        </tr>
      `).join('');
    }

    const pag = document.getElementById('tx-pagination');
    if (pag) {
      const pages = Math.ceil(total / this.pageSize);
      pag.innerHTML = `
        <span>${total} records · Page ${this.page + 1} of ${Math.max(1, pages)}</span>
        <button class="btn btn-ghost btn-sm" onclick="transactionsModule.prevPage()" ${this.page === 0 ? 'disabled' : ''}>← Prev</button>
        <button class="btn btn-ghost btn-sm" onclick="transactionsModule.nextPage()" ${(this.page + 1) * this.pageSize >= total ? 'disabled' : ''}>Next →</button>
      `;
    }
  },

  async prevPage() { if (this.page > 0) { this.page--; await this.loadRows(); } },
  async nextPage() { if ((this.page + 1) * this.pageSize < this.total) { this.page++; await this.loadRows(); } },

  openAddModal() {
    const today = new Date().toISOString().slice(0, 10);
    openModal(`
      <h2>Add Transaction</h2>
      <form id="tx-form" style="margin-top:16px">
        <div class="form-group" style="margin-bottom:16px">
          <label>Type *</label>
          <div class="tx-type-toggle">
            <button type="button" class="toggle-opt toggle-expense active" id="type-expense" onclick="setTxType('expense')">− Expense</button>
            <button type="button" class="toggle-opt toggle-income" id="type-income" onclick="setTxType('income')">+ Income</button>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Date *</label>
            <input type="date" id="tx-date" value="${today}" required>
          </div>
          <div class="form-group">
            <label>Payee *</label>
            <input type="text" id="tx-payee" placeholder="e.g. Grocery Store" required>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Amount *</label>
            <input type="number" id="tx-amount" step="0.01" min="0.01" placeholder="42.50" required>
          </div>
          <div class="form-group">
            <label>Category</label>
            <input type="text" id="tx-category" placeholder="e.g. Groceries">
          </div>
        </div>
        <div class="form-group" style="margin-bottom:16px">
          <label>Notes</label>
          <textarea id="tx-notes" placeholder="Optional notes…"></textarea>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Add Transaction</button>
        </div>
      </form>
    `);
    document.getElementById('tx-form').onsubmit = e => { e.preventDefault(); this.submitAdd(); };
  },

  async submitAdd() {
    const isExpense = document.getElementById('type-expense').classList.contains('active');
    const rawAmount = parseFloat(document.getElementById('tx-amount').value);
    const body = {
      date: document.getElementById('tx-date').value,
      payee: document.getElementById('tx-payee').value,
      amount: isExpense ? -Math.abs(rawAmount) : Math.abs(rawAmount),
      category: document.getElementById('tx-category').value || null,
      notes: document.getElementById('tx-notes').value || null
    };
    try {
      await api('/api/transactions', { method: 'POST', body });
      closeModal();
      toast('Transaction added');
      await this.loadRows();
    } catch (e) { toast(e.message, 'error'); }
  },

  async openEditModal(id) {
    const row = await api(`/api/transactions/${id}`).catch(() => null);
    if (!row) return;

    const isIncome = row.amount >= 0;
    openModal(`
      <h2>Edit Transaction</h2>
      <form id="tx-edit-form" style="margin-top:16px">
        <div class="form-group" style="margin-bottom:16px">
          <label>Type *</label>
          <div class="tx-type-toggle">
            <button type="button" class="toggle-opt toggle-expense${isIncome ? '' : ' active'}" id="type-expense" onclick="setTxType('expense')">− Expense</button>
            <button type="button" class="toggle-opt toggle-income${isIncome ? ' active' : ''}" id="type-income" onclick="setTxType('income')">+ Income</button>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Date *</label>
            <input type="date" id="tx-date" value="${row.date}" required>
          </div>
          <div class="form-group">
            <label>Payee *</label>
            <input type="text" id="tx-payee" value="${escHtml(row.payee)}" required>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Amount *</label>
            <input type="number" id="tx-amount" step="0.01" min="0.01" value="${Math.abs(row.amount)}" required>
          </div>
          <div class="form-group">
            <label>Category</label>
            <input type="text" id="tx-category" value="${escHtml(row.category || '')}">
          </div>
        </div>
        <div class="form-group" style="margin-bottom:16px">
          <label>Notes</label>
          <textarea id="tx-notes">${escHtml(row.notes || '')}</textarea>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Changes</button>
        </div>
      </form>
    `);
    document.getElementById('tx-edit-form').onsubmit = e => { e.preventDefault(); this.submitEdit(id); };
  },

  async submitEdit(id) {
    const isExpense = document.getElementById('type-expense').classList.contains('active');
    const rawAmount = parseFloat(document.getElementById('tx-amount').value);
    const body = {
      date: document.getElementById('tx-date').value,
      payee: document.getElementById('tx-payee').value,
      amount: isExpense ? -Math.abs(rawAmount) : Math.abs(rawAmount),
      category: document.getElementById('tx-category').value || null,
      notes: document.getElementById('tx-notes').value || null
    };
    try {
      await api(`/api/transactions/${id}`, { method: 'PUT', body });
      closeModal();
      toast('Transaction updated');
      await this.loadRows();
    } catch (e) { toast(e.message, 'error'); }
  },

  async deleteRow(id) {
    if (!confirm('Delete this transaction?')) return;
    try {
      await api(`/api/transactions/${id}`, { method: 'DELETE' });
      toast('Transaction deleted');
      await this.loadRows();
    } catch (e) { toast(e.message, 'error'); }
  }
};

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setTxType(type) {
  document.getElementById('type-expense').classList.toggle('active', type === 'expense');
  document.getElementById('type-income').classList.toggle('active', type === 'income');
}
