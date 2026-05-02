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
    // Generate last 24 months for period dropdown
    const monthOptions = ['<option value="">All time</option>'];
    const d = new Date();
    for (let i = 0; i < 24; i++) {
      const val   = d.toISOString().slice(0, 7);
      const label = d.toLocaleString('default', { month: 'long', year: 'numeric' });
      monthOptions.push(`<option value="${val}" ${i === 0 ? 'selected' : ''}>${label}</option>`);
      d.setMonth(d.getMonth() - 1);
    }

    document.getElementById('view').innerHTML = `
      <h1 style="margin-bottom:16px">Transactions</h1>

      <div class="card tx-search-card">
        <!-- Search + filter icon row -->
        <div class="tx-searchbar-row">
          <div class="tx-search-wrap">
            <svg class="tx-search-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="8.5" cy="8.5" r="5.5"/><path d="M15 15l-3-3"/>
            </svg>
            <input type="text" id="filter-search" class="tx-search-input"
              placeholder="Search payee or notes…" autocomplete="off" autocorrect="off">
            <button id="filter-clear-x" class="tx-clear-x" style="display:none"
              onclick="transactionsModule.clearFilters()" title="Clear">✕</button>
          </div>
          <button id="filter-toggle-btn" class="tx-filter-toggle" onclick="transactionsModule.toggleFilterPanel()" title="Filter by period">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 5h14M6 10h8M9 15h2"/>
            </svg>
            <span class="tx-filter-dot" id="filter-dot" style="display:none"></span>
          </button>
        </div>

        <!-- Collapsible filter panel -->
        <div class="tx-filter-panel" id="filter-panel" style="display:none">
          <div class="tx-filter-panel-inner">
            <div>
              <label class="tx-filter-label">Period</label>
              <select id="filter-month" class="tx-filter-select-panel">
                ${monthOptions.join('')}
              </select>
            </div>
            <button class="btn btn-ghost btn-sm" onclick="transactionsModule.clearFilters()">Clear filters</button>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:12px">
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

    document.getElementById('filter-month').addEventListener('change', () => this.applyFilters());

    let searchTimer;
    document.getElementById('filter-search').addEventListener('input', e => {
      document.getElementById('filter-clear-x').style.display = e.target.value ? 'flex' : 'none';
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => this.applyFilters(), 300);
    });

    await this.applyFilters();
  },

  toggleFilterPanel() {
    const panel = document.getElementById('filter-panel');
    const btn   = document.getElementById('filter-toggle-btn');
    const open  = panel.style.display === 'none';
    panel.style.display = open ? 'block' : 'none';
    btn.classList.toggle('tx-filter-toggle--active', open);
  },

  async applyFilters() {
    this.page = 0;
    const month  = document.getElementById('filter-month')?.value || '';
    const search = document.getElementById('filter-search')?.value.trim() || '';
    this.filters = {};
    if (month)  this.filters.month  = month;
    if (search) this.filters.search = search;

    // Show dot on filter icon when period is not default (current month)
    const dot = document.getElementById('filter-dot');
    if (dot) dot.style.display = (month && month !== new Date().toISOString().slice(0, 7)) ? 'block' : 'none';

    await this.loadRows();
  },

  async clearFilters() {
    this.page = 0;
    this.filters = {};
    const today = new Date().toISOString().slice(0, 7);
    const fm = document.getElementById('filter-month');
    const fs = document.getElementById('filter-search');
    const cx = document.getElementById('filter-clear-x');
    const dot = document.getElementById('filter-dot');
    if (fm)  fm.value = today;
    if (fs)  fs.value = '';
    if (cx)  cx.style.display = 'none';
    if (dot) dot.style.display = 'none';
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

    const tbody = document.getElementById('tx-body');
    if (!tbody) return;
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state" style="padding:32px"><div class="empty-icon">📭</div><p>No transactions found</p></div></td></tr>`;
    } else {
      tbody.innerHTML = rows.map(r => `
        <tr>
          <td data-label="Date" style="white-space:nowrap">${fmtDate(r.date)}</td>
          <td data-label="Payee"><span class="payee-cell">${payeeLogoHtml(r.payee, r.amount)}${escHtml(r.payee)}</span></td>
          <td data-label="Category">${r.category ? `<span class="badge badge-blue">${escHtml(r.category)}</span>` : '<span class="badge badge-gray">—</span>'}</td>
          <td data-label="Amount" style="text-align:right">${fmt(r.amount)}</td>
          <td data-label="Notes" style="color:var(--text-muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(r.notes || '')}</td>
          <td data-label="Actions" style="white-space:nowrap">
            ${r.receipt_path ? `<button class="btn btn-ghost btn-sm" onclick="viewReceipt('${escHtml(r.receipt_path)}')" title="View receipt">📎</button>` : ''}
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

  async openAddModal() {
    const today = new Date().toISOString().slice(0, 10);
    const categories = await api('/api/categories').catch(() => []);
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
            <label style="display:flex;justify-content:space-between;align-items:center">
              Category
              <button type="button" class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:11px" onclick="manageCategoriesModal()">Manage ✏</button>
            </label>
            ${buildCategorySelect(categories, '')}
          </div>
        </div>
        <div class="form-group" style="margin-bottom:16px">
          <label>Notes</label>
          <textarea id="tx-notes" placeholder="Optional notes…"></textarea>
        </div>
        <div class="form-group" style="margin-bottom:20px">
          <label>Receipt (optional)</label>
          <input type="file" id="tx-receipt" accept="image/*,.pdf">
          <p style="font-size:11px;color:var(--text-muted);margin-top:6px">JPG, PNG, WebP or PDF · max 10 MB</p>
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
      category: getTxCategory(),
      notes: document.getElementById('tx-notes').value || null
    };
    try {
      const newTx = await api('/api/transactions', { method: 'POST', body });

      // Upload receipt if one was selected
      const receiptFile = document.getElementById('tx-receipt')?.files[0];
      if (receiptFile && newTx?.id) {
        const formData = new FormData();
        formData.append('receipt', receiptFile);
        await fetch(`/api/transactions/${newTx.id}/receipt`, { method: 'POST', body: formData });
      }

      closeModal();
      toast('Transaction added');
      if (document.getElementById('tx-body')) await this.loadRows();
      else refreshCurrentView();
    } catch (e) { toast(e.message, 'error'); }
  },

  async openEditModal(id) {
    const [row, categories] = await Promise.all([
      api(`/api/transactions/${id}`).catch(() => null),
      api('/api/categories').catch(() => [])
    ]);
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
            <label style="display:flex;justify-content:space-between;align-items:center">
              Category
              <button type="button" class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:11px" onclick="manageCategoriesModal()">Manage ✏</button>
            </label>
            ${buildCategorySelect(categories, row.category || '')}
          </div>
        </div>
        <div class="form-group" style="margin-bottom:16px">
          <label>Notes</label>
          <textarea id="tx-notes">${escHtml(row.notes || '')}</textarea>
        </div>
        <div class="form-group" style="margin-bottom:20px">
          <label>Receipt (optional)</label>
          <div id="receipt-section">${buildReceiptSection(id, row.receipt_path)}</div>
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
      category: getTxCategory(),
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

// Payee logo helpers
const LOGO_COLORS = ['#6c8ef5','#a78bfa','#34d399','#fbbf24','#f87171','#60a5fa','#f472b6','#fb923c','#4ade80','#c084fc'];

// Curated payee → domain map. `null` means skip the favicon lookup and use the initial badge.
const PAYEE_ALIASES = {
  'send india': 'remitly.com',
  'irs refund': null,
  'income': null,
  'paycheck': null,
  'salary': null,
  'jimmy johns': 'jimmyjohns.com',
  'jimmyjohns': 'jimmyjohns.com',
  'five guys': 'fiveguys.com',
  'fiveguys': 'fiveguys.com',
  'remitly': 'remitly.com',
  'ollies': 'ollies.us',
  "ollie's": 'ollies.us',
  'meijer': 'meijer.com',
  'costco': 'costco.com',
  'dominos': 'dominos.com',
  "domino's": 'dominos.com',
  'grand indian cuisine': null,
  'amazon': 'amazon.com',
  'walmart': 'walmart.com',
  'target': 'target.com',
  'kroger': 'kroger.com',
  'aldi': 'aldi.us',
  'trader joes': 'traderjoes.com',
  "trader joe's": 'traderjoes.com',
  'whole foods': 'wholefoodsmarket.com',
  'starbucks': 'starbucks.com',
  'mcdonalds': 'mcdonalds.com',
  "mcdonald's": 'mcdonalds.com',
  'chick fil a': 'chick-fil-a.com',
  'chickfila': 'chick-fil-a.com',
  'chipotle': 'chipotle.com',
  'taco bell': 'tacobell.com',
  'subway': 'subway.com',
  'wendys': 'wendys.com',
  "wendy's": 'wendys.com',
  'panera': 'panerabread.com',
  'shell': 'shell.us',
  'bp': 'bp.com',
  'speedway': 'speedway.com',
  'exxon': 'exxon.com',
  'chevron': 'chevron.com',
  'netflix': 'netflix.com',
  'spotify': 'spotify.com',
  'disney plus': 'disneyplus.com',
  'disney+': 'disneyplus.com',
  'hulu': 'hulu.com',
  'youtube': 'youtube.com',
  'apple': 'apple.com',
  'apple.com/bill': 'apple.com',
  'icloud': 'icloud.com',
  'google': 'google.com',
  'uber': 'uber.com',
  'uber eats': 'ubereats.com',
  'lyft': 'lyft.com',
  'doordash': 'doordash.com',
  'grubhub': 'grubhub.com',
  'instacart': 'instacart.com',
  'venmo': 'venmo.com',
  'paypal': 'paypal.com',
  'cash app': 'cash.app',
  'zelle': 'zellepay.com',
  'water bill': 'gainestownship.org'
};

function payeeColor(name) {
  let h = 0;
  for (const c of String(name)) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return LOGO_COLORS[Math.abs(h) % LOGO_COLORS.length];
}
function payeeDomain(name) {
  const lower = name.toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(PAYEE_ALIASES, lower)) {
    return PAYEE_ALIASES[lower];
  }
  return lower.replace(/[^a-z0-9]/g, '') + '.com';
}
function payeeLogoHtml(payee, amount) {
  if (!payee) return '';
  // Income transactions get a fixed $ badge instead of a favicon lookup
  if (amount > 0) {
    return `<span class="payee-logo-wrap">
      <span class="payee-initial" style="background:#34d399;display:flex">$</span>
    </span>`;
  }
  const domain  = payeeDomain(payee);
  const initial = payee.trim()[0].toUpperCase();
  const color   = payeeColor(payee);
  const uid     = Math.random().toString(36).slice(2);

  // Aliased to null OR no domain inferable → render initial directly
  if (!domain) {
    return `<span class="payee-logo-wrap">
      <span class="payee-initial" style="background:${color};display:flex">${initial}</span>
    </span>`;
  }

  // Google's favicon service has wider merchant coverage than DDG's ip3.
  // naturalWidth check catches the generic globe placeholder Google serves for unknown domains.
  return `<span class="payee-logo-wrap">
    <img class="payee-logo"
      src="https://www.google.com/s2/favicons?domain=${domain}&sz=64"
      alt="" loading="lazy" referrerpolicy="no-referrer"
      onload="if(this.naturalWidth&lt;=16){this.onerror=null;this.src='https://icons.duckduckgo.com/ip3/${domain}.ico'}"
      onerror="this.style.display='none';var f=document.getElementById('pi-${uid}');if(f)f.style.display='flex'">
    <span class="payee-initial" id="pi-${uid}" style="background:${color}">${initial}</span>
  </span>`;
}

function setTxType(type) {
  document.getElementById('type-expense').classList.toggle('active', type === 'expense');
  document.getElementById('type-income').classList.toggle('active', type === 'income');
}

function buildCategorySelect(categories, selected) {
  const opts = categories.map(c =>
    `<option value="${escHtml(c)}" ${c === selected ? 'selected' : ''}>${escHtml(c)}</option>`
  ).join('');
  return `
    <select id="tx-category" onchange="onCategoryChange()">
      <option value="">— No category —</option>
      ${opts}
      <option value="__new__">＋ New category…</option>
    </select>
    <input type="text" id="tx-category-new" placeholder="Type new category name…"
      style="display:none;margin-top:8px" oninput="this.value=this.value">
  `;
}

function onCategoryChange() {
  const sel = document.getElementById('tx-category');
  const inp = document.getElementById('tx-category-new');
  if (!inp) return;
  inp.style.display = sel.value === '__new__' ? 'block' : 'none';
  if (sel.value === '__new__') inp.focus();
}

function getTxCategory() {
  const sel = document.getElementById('tx-category');
  if (!sel) return null;
  if (sel.value === '__new__') {
    return document.getElementById('tx-category-new')?.value?.trim() || null;
  }
  return sel.value || null;
}

async function manageCategoriesModal() {
  const categories = await api('/api/categories').catch(() => []);

  const renderList = (cats) => cats.length === 0
    ? '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">No categories yet.</p>'
    : cats.map(c => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
          <span style="font-size:14px">${escHtml(c)}</span>
          <button class="btn btn-danger btn-sm" onclick="deleteCategory('${escHtml(c)}')">Remove</button>
        </div>`).join('');

  openModal(`
    <h2>Manage Categories</h2>
    <div style="margin:16px 0 20px">
      <div style="display:flex;gap:8px">
        <input type="text" id="new-cat-input" placeholder="New category name…" style="flex:1"
          onkeydown="if(event.key==='Enter'){event.preventDefault();addCategory()}">
        <button class="btn btn-primary" onclick="addCategory()">Add</button>
      </div>
    </div>
    <div id="cat-list">${renderList(categories)}</div>
  `);
}

async function addCategory() {
  const inp = document.getElementById('new-cat-input');
  const name = inp?.value?.trim();
  if (!name) return;
  try {
    await api('/api/categories', { method: 'POST', body: { name } });
    inp.value = '';
    const cats = await api('/api/categories');
    document.getElementById('cat-list').innerHTML = cats.length === 0
      ? '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">No categories yet.</p>'
      : cats.map(c => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
            <span style="font-size:14px">${escHtml(c)}</span>
            <button class="btn btn-danger btn-sm" onclick="deleteCategory('${escHtml(c)}')">Remove</button>
          </div>`).join('');
    toast(`"${name}" added`);
  } catch (e) { toast(e.message, 'error'); }
}

// ── Receipt helpers ──────────────────────────────────────────────────────────

function buildReceiptSection(txId, receiptPath) {
  const isImage = receiptPath && /\.(jpg|jpeg|png|webp)$/i.test(receiptPath);
  const isPdf   = receiptPath && /\.pdf$/i.test(receiptPath);

  const existing = receiptPath ? `
    <div class="receipt-preview" id="receipt-preview">
      ${isImage
        ? `<a href="/receipts/${receiptPath}" target="_blank">
             <img src="/receipts/${receiptPath}" alt="Receipt" style="max-width:100%;max-height:160px;border-radius:6px;border:1px solid var(--border)">
           </a>`
        : isPdf
          ? `<a href="/receipts/${receiptPath}" target="_blank" class="btn btn-ghost btn-sm">📄 View PDF Receipt</a>`
          : ''
      }
      <div style="margin-top:8px">
        <button type="button" class="btn btn-danger btn-sm" onclick="removeReceipt(${txId})">Remove Receipt</button>
      </div>
    </div>` : '';

  return `
    ${existing}
    <div id="receipt-upload" style="margin-top:${receiptPath ? '12px' : '0'}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="file" id="receipt-file" accept="image/*,.pdf" style="flex:1;min-width:0">
        <button type="button" class="btn btn-ghost btn-sm" onclick="uploadReceipt(${txId})">Upload</button>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin-top:6px">JPG, PNG, WebP or PDF · max 10 MB</p>
    </div>
  `;
}

async function uploadReceipt(txId) {
  const fileInput = document.getElementById('receipt-file');
  const file = fileInput?.files[0];
  if (!file) { toast('Select a file first', 'error'); return; }

  const formData = new FormData();
  formData.append('receipt', file);

  try {
    const res = await fetch(`/api/transactions/${txId}/receipt`, { method: 'POST', body: formData });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Upload failed'); }
    const data = await res.json();
    document.getElementById('receipt-section').innerHTML = buildReceiptSection(txId, data.receipt_path);
    toast('Receipt uploaded');
  } catch (e) { toast(e.message, 'error'); }
}

async function removeReceipt(txId) {
  if (!confirm('Remove this receipt?')) return;
  try {
    await api(`/api/transactions/${txId}/receipt`, { method: 'DELETE' });
    document.getElementById('receipt-section').innerHTML = buildReceiptSection(txId, null);
    toast('Receipt removed');
  } catch (e) { toast(e.message, 'error'); }
}

function viewReceipt(filename) {
  const isImage = /\.(jpg|jpeg|png|webp)$/i.test(filename);
  if (isImage) {
    openModal(`
      <div style="text-align:center">
        <img src="/receipts/${filename}" alt="Receipt"
          style="max-width:100%;max-height:70vh;border-radius:8px;object-fit:contain">
        <div style="margin-top:12px">
          <a href="/receipts/${filename}" target="_blank" class="btn btn-ghost btn-sm">Open full size ↗</a>
        </div>
      </div>
    `);
  } else {
    window.open(`/receipts/${filename}`, '_blank');
  }
}

async function deleteCategory(name) {
  if (!confirm(`Remove category "${name}"? This won't change existing transactions.`)) return;
  try {
    await api(`/api/categories/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const cats = await api('/api/categories');
    document.getElementById('cat-list').innerHTML = cats.length === 0
      ? '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">No categories yet.</p>'
      : cats.map(c => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
            <span style="font-size:14px">${escHtml(c)}</span>
            <button class="btn btn-danger btn-sm" onclick="deleteCategory('${escHtml(c)}')">Remove</button>
          </div>`).join('');
    toast(`"${name}" removed`);
  } catch (e) { toast(e.message, 'error'); }
}
