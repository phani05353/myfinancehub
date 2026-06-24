// Declares savingsModule — manage forward-looking savings goals: add/edit/
// delete goals and log contributions. Mirrors the budget/subscriptions module
// pattern (renderX / openModal / toast). Shared dashboard helpers (progress
// bar, pace line) are exposed on the module so the dashboard card can reuse them.
const savingsModule = {
  async init() {
    document.getElementById('view').innerHTML = `
      <div class="dash-card-head" style="margin-bottom:20px;flex-wrap:wrap;gap:12px">
        <h1 style="margin-bottom:0;flex:1">🎯 Savings Goals</h1>
        <button class="btn btn-primary" onclick="savingsModule.openAddModal()">+ New Goal</button>
      </div>
      <div id="savings-summary"></div>
      <div id="savings-grid"></div>
    `;
    await this.load();
  },

  async load() {
    const goals = await api('/api/savings-goals').catch(() => []);
    this.renderCards(goals);
  },

  // Pace helper — given a goal with a target_date, returns a short status string
  // and a tone ('good' | 'warn' | 'neutral'). Returns null when no target_date.
  pace(goal) {
    if (!goal.target_date) return null;
    const remaining = Math.max(0, goal.target_amount - goal.saved_amount);
    if (remaining <= 0) return { label: 'Goal reached 🎉', tone: 'good' };

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const target = new Date(goal.target_date + 'T00:00:00');
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysLeft = Math.round((target - today) / msPerDay);

    if (daysLeft < 0) return { label: `Past due · ${fmtCur(remaining)} short`, tone: 'warn' };
    if (daysLeft === 0) return { label: `Due today · ${fmtCur(remaining)} to go`, tone: 'warn' };

    const monthsLeft = Math.max(1, daysLeft / 30.44);
    const perMonth = remaining / monthsLeft;
    return {
      label: `${fmtCur(perMonth)}/mo for ${daysLeft} day${daysLeft > 1 ? 's' : ''}`,
      tone: daysLeft < 14 ? 'warn' : 'neutral'
    };
  },

  renderCards(goals) {
    const grid    = document.getElementById('savings-grid');
    const summary = document.getElementById('savings-summary');
    if (summary) summary.innerHTML = '';

    if (!goals || goals.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🎯</div>
          <p>No savings goals yet.</p>
          <p style="margin-top:8px">
            <button class="btn btn-primary" onclick="savingsModule.openAddModal()">Create your first goal</button>
          </p>
        </div>`;
      return;
    }

    if (summary) summary.innerHTML = this.summaryHtml(goals);
    grid.innerHTML = `<div class="card" style="padding:18px 20px">${goals.map(g => this.barHtml(g)).join('')}</div>`;
  },

  // KPI summary across all goals — Maple kpi-card row.
  summaryHtml(goals) {
    const active     = goals.filter(g => g.active);
    const totalSaved = goals.reduce((s, g) => s + Number(g.saved_amount || 0), 0);
    const totalTarget = goals.reduce((s, g) => s + Number(g.target_amount || 0), 0);
    const reachedCount = goals.filter(g => g.saved_amount >= g.target_amount).length;
    const pct = totalTarget > 0 ? (totalSaved / totalTarget) * 100 : 0;

    return `
      <div class="kpi-grid" style="margin-bottom:20px">
        <div class="kpi-card kpi-card--feature">
          <div class="kpi-label">Total saved</div>
          <div class="kpi-value">${fmtCur(totalSaved)}</div>
          <span class="kpi-badge kpi-badge--muted">${pct.toFixed(0)}% of ${fmtCur(totalTarget)}</span>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Active goals</div>
          <div class="kpi-value">${active.length}</div>
          <span class="kpi-badge kpi-badge--muted">${goals.length} total</span>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Goals reached</div>
          <div class="kpi-value">${reachedCount}</div>
          <span class="kpi-badge kpi-badge--muted">${goals.length ? Math.round((reachedCount / goals.length) * 100) : 0}% complete</span>
        </div>
      </div>`;
  },

  // One goal rendered as a Maple cat-bar progress row.
  barHtml(g) {
    const pct       = g.target_amount > 0 ? (g.saved_amount / g.target_amount) * 100 : 0;
    const barPct    = Math.min(100, Math.max(0, pct));
    const reached   = g.saved_amount >= g.target_amount;
    const remaining = Math.max(0, g.target_amount - g.saved_amount);
    const barColor  = reached ? 'var(--success)' : pct >= 75 ? 'var(--accent)' : pct >= 40 ? 'var(--accent2)' : 'var(--warning)';
    const pace      = this.pace(g);
    const inactive  = !g.active;

    const paceLine = pace
      ? `<span style="color:${pace.tone === 'good' ? 'var(--success)' : pace.tone === 'warn' ? 'var(--warning)' : 'var(--text-muted)'};font-weight:600">${escHtml(pace.label)}</span>`
      : (reached ? '<span style="color:var(--success);font-weight:600">🎉 Goal reached</span>' : `<span style="color:var(--text-muted)">${fmtCur(remaining)} to go</span>`);

    const badgeClass = reached ? 'badge-green' : pct >= 75 ? 'badge-blue' : 'badge-yellow';
    const nameJs = escHtml(g.name).replace(/'/g, "\\'");
    return `
      <div class="cat-bar-row" style="${inactive ? 'opacity:.6;' : ''}">
        <div class="cat-bar-head" style="align-items:center;gap:10px;flex-wrap:wrap">
          <span style="display:flex;align-items:center;gap:8px;min-width:0">
            ${reached ? '🎉 ' : ''}${escHtml(g.name)}
            ${inactive ? '<span class="badge badge-gray">archived</span>' : ''}
            <span class="badge ${badgeClass}">${pct.toFixed(0)}%</span>
          </span>
          <span style="display:flex;gap:6px;flex-shrink:0">
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();savingsModule.openContributeModal(${g.id},'${nameJs}')">+ Add</button>
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();savingsModule.openEditModal(${g.id})">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();savingsModule.deleteGoal(${g.id})">✕</button>
          </span>
        </div>

        <div onclick="savingsModule.openContributeModal(${g.id},'${nameJs}')" style="cursor:pointer">
          <div class="cat-bar-head" style="margin-bottom:7px">
            <span style="font-weight:700;color:${barColor}">${fmtCur(g.saved_amount)}</span>
            <span class="cat-bar-amt">of ${fmtCur(g.target_amount)}</span>
          </div>

          <div class="cat-bar-track">
            <div class="cat-bar-fill" style="width:${barPct.toFixed(1)}%;background:${barColor}"></div>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;margin-top:7px">
            ${paceLine}
          </div>
          ${g.notes ? `<div style="margin-top:8px;font-size:12px;color:var(--text-muted);white-space:pre-wrap">${escHtml(g.notes)}</div>` : ''}
        </div>
      </div>
    `;
  },

  openAddModal() {
    const today = new Date().toISOString().slice(0, 10);
    openModal(`
      <h2>New Savings Goal</h2>
      <form id="savings-form" style="margin-top:16px">
        <div class="form-group" style="margin-bottom:14px">
          <label>Name *</label>
          <input type="text" id="goal-name" placeholder="e.g. Emergency Fund" required>
        </div>
        <div class="form-group" style="margin-bottom:14px">
          <label>Target Amount *</label>
          <input type="number" id="goal-target" step="0.01" min="0.01" placeholder="e.g. 5000.00" required>
        </div>
        <div class="form-group" style="margin-bottom:14px">
          <label>Already Saved</label>
          <input type="number" id="goal-saved" step="0.01" min="0" placeholder="0.00">
        </div>
        <div class="form-group" style="margin-bottom:14px">
          <label>Target Date</label>
          <input type="date" id="goal-date" min="${today}">
        </div>
        <div class="form-group" style="margin-bottom:20px">
          <label>Notes</label>
          <textarea id="goal-notes" rows="2" placeholder="Optional"></textarea>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Create Goal</button>
        </div>
      </form>
    `);
    document.getElementById('savings-form').onsubmit = e => { e.preventDefault(); this.submitNew(); };
  },

  async submitNew() {
    const body = {
      name: document.getElementById('goal-name').value,
      target_amount: document.getElementById('goal-target').value,
      saved_amount: document.getElementById('goal-saved').value || 0,
      target_date: document.getElementById('goal-date').value || null,
      notes: document.getElementById('goal-notes').value || null
    };
    if (!body.name?.trim()) { toast('Name is required', 'error'); return; }
    try {
      await api('/api/savings-goals', { method: 'POST', body });
      closeModal();
      toast('Goal created');
      await this.load();
    } catch (e) { toast(e.message, 'error'); }
  },

  async openEditModal(id) {
    let g;
    try { g = await api(`/api/savings-goals/${id}`); } catch (e) { toast(e.message, 'error'); return; }
    openModal(`
      <h2>Edit Goal</h2>
      <form id="savings-form" style="margin-top:16px">
        <div class="form-group" style="margin-bottom:14px">
          <label>Name *</label>
          <input type="text" id="goal-name" value="${escHtml(g.name)}" required>
        </div>
        <div class="form-group" style="margin-bottom:14px">
          <label>Target Amount *</label>
          <input type="number" id="goal-target" step="0.01" min="0.01" value="${g.target_amount}" required>
        </div>
        <div class="form-group" style="margin-bottom:14px">
          <label>Saved Amount</label>
          <input type="number" id="goal-saved" step="0.01" min="0" value="${g.saved_amount}">
        </div>
        <div class="form-group" style="margin-bottom:14px">
          <label>Target Date</label>
          <input type="date" id="goal-date" value="${g.target_date || ''}">
        </div>
        <div class="form-group" style="margin-bottom:14px">
          <label>Notes</label>
          <textarea id="goal-notes" rows="2">${escHtml(g.notes || '')}</textarea>
        </div>
        <div class="form-group" style="margin-bottom:20px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="goal-active" ${g.active ? 'checked' : ''} style="width:auto">
            Active (uncheck to archive)
          </label>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Changes</button>
        </div>
      </form>
    `);
    document.getElementById('savings-form').onsubmit = e => { e.preventDefault(); this.submitEdit(id); };
  },

  async submitEdit(id) {
    const body = {
      name: document.getElementById('goal-name').value,
      target_amount: document.getElementById('goal-target').value,
      saved_amount: document.getElementById('goal-saved').value,
      target_date: document.getElementById('goal-date').value || null,
      notes: document.getElementById('goal-notes').value || null,
      active: document.getElementById('goal-active').checked ? 1 : 0
    };
    if (!body.name?.trim()) { toast('Name is required', 'error'); return; }
    try {
      await api(`/api/savings-goals/${id}`, { method: 'PUT', body });
      closeModal();
      toast('Goal updated');
      await this.load();
    } catch (e) { toast(e.message, 'error'); }
  },

  openContributeModal(id, name) {
    openModal(`
      <h2 style="margin-bottom:2px">Add Contribution</h2>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">${escHtml(name)}</p>
      <form id="contribute-form">
        <div class="form-group" style="margin-bottom:20px">
          <label>Amount *</label>
          <input type="number" id="contribute-amount" step="0.01" placeholder="e.g. 100.00" required autofocus>
          <p style="font-size:11px;color:var(--text-muted);margin-top:6px">Use a negative amount to correct an over-entry.</p>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Add</button>
        </div>
      </form>
    `);
    document.getElementById('contribute-form').onsubmit = e => { e.preventDefault(); this.submitContribution(id); };
  },

  async submitContribution(id) {
    const amount = document.getElementById('contribute-amount').value;
    if (!amount || parseFloat(amount) === 0) { toast('Enter a non-zero amount', 'error'); return; }
    try {
      const { reached } = await api(`/api/savings-goals/${id}/contribute`, { method: 'POST', body: { amount } });
      closeModal();
      toast(reached ? '🎉 Goal reached!' : 'Contribution added');
      await this.load();
    } catch (e) { toast(e.message, 'error'); }
  },

  async deleteGoal(id) {
    if (!confirm('Delete this savings goal?')) return;
    try {
      await api(`/api/savings-goals/${id}`, { method: 'DELETE' });
      toast('Goal deleted');
      await this.load();
    } catch (e) { toast(e.message, 'error'); }
  }
};
