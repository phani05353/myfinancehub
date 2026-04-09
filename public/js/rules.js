const rulesModule = {
  async init() {
    document.getElementById('view').innerHTML = `
      <div class="page-title-row" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:10px">
        <div>
          <h1 style="margin-bottom:2px">⚡ Rules Engine</h1>
          <p style="color:var(--text-muted);font-size:13px">Automatically categorise transactions as they're added or imported</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-ghost" onclick="rulesModule.applyAll()">▶ Apply to Existing</button>
          <button class="btn btn-primary" onclick="rulesModule.openAddModal()">+ Add Rule</button>
        </div>
      </div>
      <div id="rules-list"></div>
    `;
    await this.load();
  },

  async load() {
    const rules = await api('/api/rules').catch(() => []);
    this.render(rules);
  },

  render(rules) {
    const el = document.getElementById('rules-list');
    if (!el) return;

    if (rules.length === 0) {
      el.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">⚡</div>
          <p>No rules yet.</p>
          <p style="margin-top:8px;color:var(--text-muted);font-size:13px">Rules automatically set categories when transactions are added or imported.</p>
          <p style="margin-top:16px"><button class="btn btn-primary" onclick="rulesModule.openAddModal()">Add your first rule</button></p>
        </div>`;
      return;
    }

    el.innerHTML = `
      <div class="card" style="padding:0;overflow:hidden">
        <div style="padding:12px 18px;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:center">
          <span style="font-size:12px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em">
            ${rules.length} rule${rules.length !== 1 ? 's' : ''} · processed top to bottom, last match wins
          </span>
        </div>
        ${rules.map((r, i) => this.rowHtml(r, i, rules.length)).join('')}
      </div>
    `;
  },

  rowHtml(r, i, total) {
    const fieldLabel = { payee: 'Payee', notes: 'Notes', amount: 'Amount' }[r.condition_field] || r.condition_field;
    const opLabel = {
      contains: 'contains', equals: 'equals', starts_with: 'starts with', ends_with: 'ends with',
      gt: '>', lt: '<', gte: '≥', lte: '≤', eq: '='
    }[r.condition_op] || r.condition_op;
    const actionLabel = r.action_type === 'set_category' ? 'Set category →' : r.action_type;

    return `
      <div class="rule-row ${r.enabled ? '' : 'rule-row--disabled'}" style="border-bottom:${i < total - 1 ? '1px solid var(--border)' : 'none'}">
        <div class="rule-toggle">
          <label class="toggle-switch" title="${r.enabled ? 'Disable rule' : 'Enable rule'}">
            <input type="checkbox" ${r.enabled ? 'checked' : ''} onchange="rulesModule.toggleEnabled(${r.id}, this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="rule-body">
          <div class="rule-name">${escHtml(r.name)}</div>
          <div class="rule-desc">
            <span class="rule-pill rule-pill--condition">IF</span>
            <span class="rule-cond"><strong>${fieldLabel}</strong> ${opLabel} <strong>"${escHtml(r.condition_value)}"</strong></span>
            <span class="rule-pill rule-pill--action">THEN</span>
            <span class="rule-action">${actionLabel} <strong>${escHtml(r.action_value)}</strong></span>
          </div>
        </div>
        <div class="rule-actions">
          <button class="btn btn-ghost btn-sm" onclick="rulesModule.openEditModal(${r.id})">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="rulesModule.deleteRule(${r.id})">✕</button>
        </div>
      </div>
    `;
  },

  async toggleEnabled(id, enabled) {
    try {
      await api(`/api/rules/${id}`, { method: 'PUT', body: { enabled } });
      await this.load();
    } catch (e) { toast(e.message, 'error'); }
  },

  async applyAll() {
    if (!confirm('Apply all enabled rules to every existing transaction? Categories will be updated where rules match.')) return;
    try {
      const { updated } = await api('/api/rules/apply', { method: 'POST' });
      toast(updated > 0 ? `Updated ${updated} transaction${updated !== 1 ? 's' : ''}` : 'No transactions matched any rules');
    } catch (e) { toast(e.message, 'error'); }
  },

  async openAddModal() {
    const categories = await api('/api/categories').catch(() => []);
    openModal(`
      <h2 style="margin-bottom:16px">Add Rule</h2>
      ${this.formHtml(null, categories)}
    `);
    document.getElementById('rule-form').onsubmit = e => { e.preventDefault(); this.submitSave(null); };
    this.updateOpOptions();
  },

  async openEditModal(id) {
    const [rules, categories] = await Promise.all([
      api('/api/rules'),
      api('/api/categories').catch(() => [])
    ]);
    const rule = rules.find(r => r.id === id);
    if (!rule) return;
    openModal(`
      <h2 style="margin-bottom:16px">Edit Rule</h2>
      ${this.formHtml(rule, categories)}
    `);
    document.getElementById('rule-form').onsubmit = e => { e.preventDefault(); this.submitSave(id); };
    this.updateOpOptions();
  },

  formHtml(rule, categories) {
    const textOps = [
      { v: 'contains',    l: 'contains' },
      { v: 'equals',      l: 'equals (exact)' },
      { v: 'starts_with', l: 'starts with' },
      { v: 'ends_with',   l: 'ends with' },
    ];
    const amtOps = [
      { v: 'gt',  l: '> greater than' },
      { v: 'lt',  l: '< less than' },
      { v: 'gte', l: '≥ at least' },
      { v: 'lte', l: '≤ at most' },
      { v: 'eq',  l: '= exactly' },
    ];
    const allOps = [...textOps, ...amtOps];

    return `
      <form id="rule-form">
        <div class="form-group" style="margin-bottom:14px">
          <label>Rule Name *</label>
          <input type="text" id="rule-name" placeholder="e.g. Tag Uber as Transport"
            value="${rule ? escHtml(rule.name) : ''}" required>
        </div>

        <div style="background:var(--surface2);border-radius:8px;padding:14px;margin-bottom:14px">
          <div style="font-size:11px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">IF condition</div>
          <div class="form-row" style="margin-bottom:10px">
            <div class="form-group" style="margin-bottom:0">
              <label>Field</label>
              <select id="rule-field" onchange="rulesModule.updateOpOptions()" required>
                <option value="payee"  ${!rule || rule.condition_field === 'payee'  ? 'selected' : ''}>Payee</option>
                <option value="notes"  ${rule?.condition_field === 'notes'  ? 'selected' : ''}>Notes</option>
                <option value="amount" ${rule?.condition_field === 'amount' ? 'selected' : ''}>Amount</option>
              </select>
            </div>
            <div class="form-group" style="margin-bottom:0">
              <label>Operator</label>
              <select id="rule-op" required>
                ${allOps.map(o => `<option value="${o.v}" ${rule?.condition_op === o.v ? 'selected' : ''}>${o.l}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label>Value *</label>
            <input type="text" id="rule-cond-value"
              placeholder="e.g. Uber" value="${rule ? escHtml(rule.condition_value) : ''}" required>
          </div>
        </div>

        <div style="background:var(--surface2);border-radius:8px;padding:14px;margin-bottom:20px">
          <div style="font-size:11px;font-weight:700;color:var(--success);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">THEN action</div>
          <div class="form-group" style="margin-bottom:0">
            <label>Set Category to</label>
            <select id="rule-action-value" required>
              <option value="">— Select category —</option>
              ${categories.map(c => `<option value="${escHtml(c)}" ${rule?.action_value === c ? 'selected' : ''}>${escHtml(c)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Rule</button>
        </div>
      </form>
    `;
  },

  updateOpOptions() {
    const field = document.getElementById('rule-field')?.value;
    const opSel = document.getElementById('rule-op');
    if (!field || !opSel) return;

    const isAmount = field === 'amount';
    const textOps  = ['contains','equals','starts_with','ends_with'];
    const amtOps   = ['gt','lt','gte','lte','eq'];

    Array.from(opSel.options).forEach(opt => {
      const isAmtOp = amtOps.includes(opt.value);
      opt.hidden = isAmount ? !isAmtOp : isAmtOp;
    });

    // Reset to first visible option if current is hidden
    if (opSel.options[opSel.selectedIndex]?.hidden) {
      const first = Array.from(opSel.options).find(o => !o.hidden);
      if (first) opSel.value = first.value;
    }

    const placeholder = document.getElementById('rule-cond-value');
    if (placeholder) placeholder.placeholder = isAmount ? 'e.g. 50' : 'e.g. Uber';
  },

  async submitSave(id) {
    const name            = document.getElementById('rule-name').value.trim();
    const condition_field = document.getElementById('rule-field').value;
    const condition_op    = document.getElementById('rule-op').value;
    const condition_value = document.getElementById('rule-cond-value').value.trim();
    const action_value    = document.getElementById('rule-action-value').value;

    if (!name || !condition_value || !action_value) {
      toast('Please fill in all fields', 'error'); return;
    }

    const body = { name, condition_field, condition_op, condition_value, action_type: 'set_category', action_value };

    try {
      if (id) {
        await api(`/api/rules/${id}`, { method: 'PUT', body });
        toast('Rule updated');
      } else {
        await api('/api/rules', { method: 'POST', body });
        toast('Rule added');
      }
      closeModal();
      await this.load();
    } catch (e) { toast(e.message, 'error'); }
  },

  async deleteRule(id) {
    if (!confirm('Delete this rule?')) return;
    try {
      await api(`/api/rules/${id}`, { method: 'DELETE' });
      toast('Rule deleted');
      await this.load();
    } catch (e) { toast(e.message, 'error'); }
  }
};
