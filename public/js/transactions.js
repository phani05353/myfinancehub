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
      <div class="tx-page-head" style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px">
        <h1 style="margin:0">Transactions</h1>
        <button class="btn btn-ghost btn-sm" onclick="transactionsModule.scanReceiptAI()"
          title="Photograph a receipt — the AI extracts it and adds a transaction for you to review">
          📸 Scan &amp; auto-add
        </button>
      </div>
      <input type="file" id="ingest-file" accept="image/*" capture="environment" style="display:none">

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

      <div class="card" style="margin-top:12px;padding:8px">
        <div id="tx-body" style="display:flex;flex-direction:column;gap:6px">
          <div style="text-align:center;padding:32px;color:var(--text-muted)">Loading…</div>
        </div>
        <div class="pagination" id="tx-pagination" style="padding:12px 8px 4px"></div>
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
      tbody.innerHTML = `<div class="empty-state" style="padding:32px"><div class="empty-icon">📭</div><p>No transactions found</p></div>`;
    } else {
      tbody.innerHTML = rows.map(r => {
        const isIncome  = r.amount > 0;
        const amtClass  = isIncome ? 'amount-positive' : 'amount-negative';
        const amtColor  = isIncome ? 'var(--success)' : 'var(--danger)';
        const catBadge  = r.category
          ? `<span class="badge badge-blue">${escHtml(r.category)}</span>`
          : `<span class="badge badge-gray">—</span>`;
        const reviewBadge = r.needs_review
          ? ` <span class="badge badge-yellow" title="AI-extracted from a receipt — confirm the details">Review</span>`
          : '';
        const notes = r.notes
          ? ` <span style="color:var(--text-muted)">· ${escHtml(r.notes)}</span>`
          : '';
        return `
        <div class="list-row">
          ${payeeLogoHtml(r.payee, r.amount)}
          <div class="list-row-main">
            <div class="list-row-title">${escHtml(r.payee)}${reviewBadge}</div>
            <div class="list-row-sub">${catBadge} <span style="color:var(--text-muted)">${fmtDate(r.date)}</span>${notes}</div>
          </div>
          <div class="list-row-trail">
            <div class="list-row-amount ${amtClass}" style="color:${amtColor}">${fmt(r.amount)}</div>
            <div class="list-row-actions" style="white-space:nowrap">
              ${r.needs_review ? `<button class="btn btn-ghost btn-sm" onclick="transactionsModule.confirmReview(${r.id})" title="Confirm — looks right" style="color:var(--success)">✓</button>` : ''}
              ${r.receipt_path ? `<button class="btn btn-ghost btn-sm" onclick="viewReceipt('${escHtml(r.receipt_path)}')" title="View receipt">📎</button>` : ''}
              <button class="btn btn-ghost btn-sm" onclick="transactionsModule.openEditModal(${r.id})">Edit</button>
              <button class="btn btn-danger btn-sm" onclick="transactionsModule.deleteRow(${r.id})">Del</button>
            </div>
          </div>
        </div>`;
      }).join('');
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
    const [categories, payees] = await Promise.all([
      api('/api/categories').catch(() => []),
      api('/api/payees').catch(() => [])
    ]);
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
            <input type="text" id="tx-payee" placeholder="e.g. Grocery Store" list="payee-list"
              autocomplete="off" required>
            ${buildPayeeDatalist(payees)}
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

    // Receipt OCR: when an image is attached, try to pre-fill payee + amount
    document.getElementById('tx-receipt')?.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file || !file.type.startsWith('image/')) return; // skip PDFs
      const payeeEl = document.getElementById('tx-payee');
      const amountEl = document.getElementById('tx-amount');
      // Don't overwrite anything the user already typed
      if (payeeEl?.value && amountEl?.value) return;
      toast('Reading receipt…');
      try {
        const fd = new FormData();
        fd.append('receipt', file);
        const r = await fetch('/api/receipts/ocr', { method: 'POST', body: fd });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'OCR failed');
        const { payee, amount } = await r.json();
        let filled = [];
        if (payee && payeeEl && !payeeEl.value) { payeeEl.value = payee; filled.push('payee'); }
        if (amount && amountEl && !amountEl.value) { amountEl.value = amount.toFixed(2); filled.push('amount'); }
        toast(filled.length ? `Scanned: ${filled.join(' + ')} — review before saving` : 'Receipt scanned (nothing matched)');
      } catch (err) {
        toast('Receipt scan failed: ' + err.message, 'error');
      }
    });

    // Smart category suggester: auto-fill on payee blur if category not yet picked
    document.getElementById('tx-payee')?.addEventListener('blur', async e => {
      const payee = e.target.value.trim();
      if (!payee) return;
      const sel = document.getElementById('tx-category');
      if (!sel || sel.value) return; // user already picked one
      try {
        const { category } = await api(`/api/payees/suggest-category?payee=${encodeURIComponent(payee)}`);
        if (!category) return;
        // Match against existing options (case-insensitive)
        const match = Array.from(sel.options).find(o => o.value.toLowerCase() === category.toLowerCase());
        if (match && !sel.value) {
          sel.value = match.value;
          // Tiny visual cue that we filled it for them
          sel.style.transition = 'box-shadow 0.4s';
          sel.style.boxShadow = '0 0 0 2px var(--accent)';
          setTimeout(() => { sel.style.boxShadow = ''; }, 800);
        }
      } catch (_) {}
    });
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
      // Include this device's push endpoint so the server can skip notifying us
      const myEndpoint = await getCurrentPushEndpoint();
      const headers = myEndpoint ? { 'X-Push-Endpoint': myEndpoint } : {};
      const newTx = await api('/api/transactions', { method: 'POST', body, headers });

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

  // 📸 Scan & auto-add: photograph/upload a receipt and hand it to the local-LLM
  // ingest workflow. Fire-and-forget — the server returns 202 immediately and a
  // push notification arrives once the (needs-review) transaction is created.
  scanReceiptAI() {
    const input = document.getElementById('ingest-file');
    if (!input) return;
    input.value = '';
    input.onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) { toast('Pick an image (JPG, PNG or WebP)', 'error'); return; }
      toast('Reading receipt with AI…');
      try {
        const fd = new FormData();
        fd.append('receipt', file);
        const r = await fetch('/api/receipts/ingest', { method: 'POST', body: fd });
        if (r.status === 202) {
          toast("Scanning — you'll get a notification when it's added for review");
        } else {
          throw new Error((await r.json().catch(() => ({}))).error || 'Upload failed');
        }
      } catch (err) {
        toast('Receipt scan failed: ' + err.message, 'error');
      }
    };
    input.click();
  },

  // One-tap confirm: clear the needs_review flag on an AI-extracted transaction.
  async confirmReview(id) {
    try {
      await api(`/api/transactions/${id}/confirm`, { method: 'POST' });
      toast('Confirmed');
      await this.loadRows();
    } catch (e) { toast(e.message, 'error'); }
  },

  async openEditModal(id) {
    const [row, categories, payees] = await Promise.all([
      api(`/api/transactions/${id}`).catch(() => null),
      api('/api/categories').catch(() => []),
      api('/api/payees').catch(() => [])
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
            <input type="text" id="tx-payee" value="${escHtml(row.payee)}" list="payee-list"
              autocomplete="off" required>
            ${buildPayeeDatalist(payees)}
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

// Payee logo helpers
const LOGO_COLORS = ['#6366f1','#a78bfa','#22d3ee','#fbbf24','#fb7185','#60a5fa','#f472b6','#fb923c','#34d399','#c084fc'];

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
      <span class="payee-initial" style="background:var(--success);display:flex">$</span>
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

function buildPayeeDatalist(payees) {
  const opts = (payees || [])
    .filter(Boolean)
    .map(p => `<option value="${escHtml(p)}"></option>`)
    .join('');
  return `<datalist id="payee-list">${opts}</datalist>`;
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
  const safePath = receiptPath ? escHtml(receiptPath) : '';

  const existing = receiptPath ? `
    <div class="receipt-preview" id="receipt-preview">
      ${isImage
        ? `<img src="/receipts/${safePath}" alt="Receipt" data-receipt-preview="${safePath}" style="max-width:100%;max-height:160px;border-radius:6px;border:1px solid var(--border);cursor:zoom-in">`
        : isPdf
          ? `<button type="button" class="btn btn-ghost btn-sm" data-receipt-preview="${safePath}">📄 View PDF Receipt</button>`
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
  const src = '/receipts/' + encodeURIComponent(filename);
  const isPdf = /\.pdf$/i.test(filename);

  if (isPdf) {
    openModal(`<div class="receipt-modal receipt-modal--pdf">
      <iframe src="${src}#toolbar=0&navpanes=0" title="Receipt PDF"></iframe>
    </div>`);
  } else {
    openModal(`<div class="receipt-modal receipt-modal--img">
      <img src="${src}" alt="Receipt">
    </div>`);
  }
  document.getElementById('modal-box')?.classList.add('modal-box--receipt');
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
