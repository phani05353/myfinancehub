// Calculate the next due date based on last transaction date and frequency
function nextDueFrom(lastDate, monthsSeen) {
  const d = new Date(lastDate + 'T00:00:00');
  if (monthsSeen >= 2) {
    d.setMonth(d.getMonth() + 1); // monthly
  } else {
    d.setFullYear(d.getFullYear() + 1); // assume yearly if only seen once
  }
  return d.toISOString().slice(0, 10);
}

const subscriptionsModule = {
  async init() {
    await this.render();
  },

  async render() {
    const subs = await api('/api/subscriptions');
    const active = subs.filter(s => s.active);
    const paused = subs.filter(s => !s.active);

    const monthlyTotal = active.reduce((a, s) => {
      if (s.billing_cycle === 'monthly') return a + Math.abs(s.amount);
      if (s.billing_cycle === 'yearly') return a + Math.abs(s.amount) / 12;
      if (s.billing_cycle === 'weekly') return a + Math.abs(s.amount) * 4.33;
      return a;
    }, 0);

    const yearlyTotal = monthlyTotal * 12;

    document.getElementById('view').innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px">
        <h1 style="margin-bottom:0;flex:1">Subscriptions</h1>
        <div style="display:flex;gap:8px;flex-shrink:0">
          <button class="btn btn-ghost" onclick="subscriptionsModule.openDetectModal()">⟳ Sync</button>
          <button class="btn btn-primary" onclick="subscriptionsModule.openAddModal()">+ Add</button>
        </div>
      </div>

      <div class="stats-grid" style="margin-bottom:24px">
        <div class="stat-card">
          <div class="label">Monthly Cost</div>
          <div class="value expense" style="font-size:22px">${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(monthlyTotal)}<span style="font-size:13px;color:var(--text-muted);font-weight:400">/mo</span></div>
        </div>
        <div class="stat-card">
          <div class="label">Annual Cost</div>
          <div class="value expense" style="font-size:22px">${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(yearlyTotal)}<span style="font-size:13px;color:var(--text-muted);font-weight:400">/yr</span></div>
        </div>
        <div class="stat-card">
          <div class="label">Active</div>
          <div class="value neutral" style="font-size:22px">${active.length}</div>
        </div>
        <div class="stat-card">
          <div class="label">Paused</div>
          <div class="value neutral" style="font-size:22px;color:var(--text-muted)">${paused.length}</div>
        </div>
      </div>

      <div class="card">
        <h2>Active Subscriptions</h2>
        ${this.renderTable(active, true)}
      </div>

      ${paused.length > 0 ? `
      <div class="card" style="margin-top:20px">
        <h2 style="color:var(--text-muted)">Paused Subscriptions</h2>
        ${this.renderTable(paused, false)}
      </div>` : ''}
    `;
  },

  renderTable(subs, isActive) {
    if (subs.length === 0) {
      return `<div class="empty-state" style="padding:32px"><div class="empty-icon">📋</div><p>No ${isActive ? 'active' : 'paused'} subscriptions</p></div>`;
    }
    const today = new Date().toISOString().slice(0, 10);
    return `
      <div class="table-wrap">
        <table class="sub-table">
          <thead>
            <tr><th>Name</th><th>Payee</th><th>Amount</th><th>Billing</th><th>Next Due</th><th>Category</th><th>Actions</th></tr>
          </thead>
          <tbody>
            ${subs.map(s => {
              const isDueSoon = s.next_due_date <= new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
              const isOverdue = s.next_due_date < today;
              return `<tr class="${isOverdue ? 'overdue' : isDueSoon ? 'due-soon' : ''}">
                <td data-label="Name"><strong>${escHtml(s.name)}</strong></td>
                <td data-label="Payee">${escHtml(s.payee || '—')}</td>
                <td data-label="Amount">${fmt(-Math.abs(s.amount))}</td>
                <td data-label="Billing"><span class="badge badge-blue">${s.billing_cycle}</span></td>
                <td data-label="Next Due">${fmtDate(s.next_due_date)} ${isOverdue ? '<span class="badge badge-red">Overdue</span>' : isDueSoon ? '<span class="badge badge-yellow">Soon</span>' : ''}</td>
                <td data-label="Category">${s.category ? `<span class="badge badge-gray">${escHtml(s.category)}</span>` : '—'}</td>
                <td data-label="Actions">
                  <button class="btn btn-ghost btn-sm" onclick="subscriptionsModule.openEditModal(${s.id})">Edit</button>
                  <button class="btn btn-ghost btn-sm" onclick="subscriptionsModule.toggleActive(${s.id}, ${s.active ? 0 : 1})">${s.active ? 'Pause' : 'Resume'}</button>
                  <button class="btn btn-danger btn-sm" onclick="subscriptionsModule.deleteRow(${s.id})">Del</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  },

  async openDetectModal() {
    openModal('<h2>Detecting from Transactions…</h2><p style="color:var(--text-muted);margin-top:12px">Scanning for payees tagged with Subscriptions category…</p>');

    let suggestions;
    try {
      suggestions = await api('/api/subscriptions/detect');
    } catch (e) {
      toast(e.message, 'error');
      closeModal();
      return;
    }

    if (suggestions.length === 0) {
      openModal(`
        <h2>No New Subscriptions Found</h2>
        <p style="color:var(--text-muted);margin-top:12px">
          All payees with a <strong>Subscriptions</strong> category are already tracked,
          or no transactions with that category exist yet.
        </p>
        <p style="color:var(--text-muted);margin-top:8px;font-size:12px">
          In Actual Budget, tag subscription transactions with a category containing "Subscription"
          (e.g. "Subscriptions", "Streaming Subscriptions") to auto-detect them here.
        </p>
        <div style="margin-top:20px;text-align:right">
          <button class="btn btn-ghost" onclick="closeModal()">Close</button>
        </div>
      `);
      return;
    }

    openModal(`
      <h2>Detected Subscriptions (${suggestions.length})</h2>
      <p style="color:var(--text-muted);margin:8px 0 16px;font-size:13px">
        Found from transactions tagged with <strong>Subscriptions</strong> category.
        Select which ones to track:
      </p>
      <form id="detect-sub-form">
        <div style="max-height:360px;overflow-y:auto;margin-bottom:16px">
          ${suggestions.map((s, i) => `
            <div style="display:flex;align-items:flex-start;gap:12px;padding:12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px">
              <input type="checkbox" id="ds-check-${i}" checked style="width:auto;margin-top:3px;flex-shrink:0">
              <div style="flex:1;min-width:0">
                <div style="font-weight:600;margin-bottom:4px">${escHtml(s.payee)}</div>
                <div style="display:flex;gap:12px;flex-wrap:wrap">
                  <span style="color:var(--text-muted);font-size:12px">
                    Avg: <strong style="color:var(--danger)">$${s.avg_amount.toFixed(2)}</strong>
                  </span>
                  <span style="color:var(--text-muted);font-size:12px">
                    Seen: <strong>${s.months_seen} month${s.months_seen !== 1 ? 's' : ''}</strong>
                  </span>
                  <span style="color:var(--text-muted);font-size:12px">
                    Last: <strong>${fmtDate(s.last_date)}</strong>
                  </span>
                  <span class="badge badge-blue" style="font-size:11px">${escHtml(s.category || '')}</span>
                </div>
                <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
                  <div style="display:flex;flex-direction:column;gap:4px">
                    <label style="font-size:11px;color:var(--text-muted)">Amount ($)</label>
                    <input type="number" id="ds-amt-${i}" step="0.01" value="${s.avg_amount.toFixed(2)}"
                      style="width:100px;padding:4px 8px;font-size:12px">
                  </div>
                  <div style="display:flex;flex-direction:column;gap:4px">
                    <label style="font-size:11px;color:var(--text-muted)">Billing Cycle</label>
                    <select id="ds-cycle-${i}" style="padding:4px 8px;font-size:12px">
                      <option value="monthly" ${s.months_seen >= 2 ? 'selected' : ''}>Monthly</option>
                      <option value="yearly" ${s.months_seen < 2 ? 'selected' : ''}>Yearly</option>
                      <option value="weekly">Weekly</option>
                    </select>
                  </div>
                  <div style="display:flex;flex-direction:column;gap:4px">
                    <label style="font-size:11px;color:var(--text-muted)">Next Due</label>
                    <input type="date" id="ds-due-${i}" value="${nextDueFrom(s.last_date, s.months_seen)}"
                      style="padding:4px 8px;font-size:12px">
                  </div>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Add Selected (${suggestions.length})</button>
        </div>
      </form>
    `);

    document.getElementById('detect-sub-form').onsubmit = async e => {
      e.preventDefault();
      let added = 0;
      for (let i = 0; i < suggestions.length; i++) {
        const checked = document.getElementById(`ds-check-${i}`)?.checked;
        if (!checked) continue;
        try {
          await api('/api/subscriptions', {
            method: 'POST',
            body: {
              name: suggestions[i].payee,
              payee: suggestions[i].payee,
              amount: parseFloat(document.getElementById(`ds-amt-${i}`).value),
              billing_cycle: document.getElementById(`ds-cycle-${i}`).value,
              next_due_date: document.getElementById(`ds-due-${i}`).value,
              category: suggestions[i].category || null
            }
          });
          added++;
        } catch (_) {}
      }
      closeModal();
      toast(`Added ${added} subscription${added !== 1 ? 's' : ''}`);
      await this.render();
    };
  },

  openAddModal() {
    const today = new Date().toISOString().slice(0, 10);
    openModal(`
      <h2>Add Subscription</h2>
      <form id="sub-form" style="margin-top:16px">
        <div class="form-row">
          <div class="form-group">
            <label>Name *</label>
            <input type="text" id="sub-name" placeholder="e.g. Netflix" required>
          </div>
          <div class="form-group">
            <label>Payee</label>
            <input type="text" id="sub-payee" placeholder="e.g. Netflix Inc.">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Amount *</label>
            <input type="number" id="sub-amount" step="0.01" placeholder="15.99" required>
          </div>
          <div class="form-group">
            <label>Billing Cycle *</label>
            <select id="sub-cycle">
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Next Due Date *</label>
            <input type="date" id="sub-due" value="${today}" required>
          </div>
          <div class="form-group">
            <label>Category</label>
            <input type="text" id="sub-category" placeholder="e.g. Entertainment">
          </div>
        </div>
        <div class="form-group" style="margin-bottom:16px">
          <label>Notes</label>
          <textarea id="sub-notes" placeholder="Optional notes…"></textarea>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Add Subscription</button>
        </div>
      </form>
    `);
    document.getElementById('sub-form').onsubmit = e => { e.preventDefault(); this.submitAdd(); };
  },

  async submitAdd() {
    const body = {
      name: document.getElementById('sub-name').value,
      payee: document.getElementById('sub-payee').value || null,
      amount: document.getElementById('sub-amount').value,
      billing_cycle: document.getElementById('sub-cycle').value,
      next_due_date: document.getElementById('sub-due').value,
      category: document.getElementById('sub-category').value || null,
      notes: document.getElementById('sub-notes').value || null
    };
    try {
      await api('/api/subscriptions', { method: 'POST', body });
      closeModal();
      toast('Subscription added');
      await this.render();
    } catch (e) { toast(e.message, 'error'); }
  },

  async openEditModal(id) {
    const s = await api(`/api/subscriptions/${id}`).catch(() => null);
    if (!s) return;

    openModal(`
      <h2>Edit Subscription</h2>
      <form id="sub-edit-form" style="margin-top:16px">
        <div class="form-row">
          <div class="form-group">
            <label>Name *</label>
            <input type="text" id="sub-name" value="${escHtml(s.name)}" required>
          </div>
          <div class="form-group">
            <label>Payee</label>
            <input type="text" id="sub-payee" value="${escHtml(s.payee || '')}">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Amount *</label>
            <input type="number" id="sub-amount" step="0.01" value="${Math.abs(s.amount)}" required>
          </div>
          <div class="form-group">
            <label>Billing Cycle *</label>
            <select id="sub-cycle">
              <option value="monthly" ${s.billing_cycle === 'monthly' ? 'selected' : ''}>Monthly</option>
              <option value="yearly" ${s.billing_cycle === 'yearly' ? 'selected' : ''}>Yearly</option>
              <option value="weekly" ${s.billing_cycle === 'weekly' ? 'selected' : ''}>Weekly</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Next Due Date *</label>
            <input type="date" id="sub-due" value="${s.next_due_date}" required>
          </div>
          <div class="form-group">
            <label>Category</label>
            <input type="text" id="sub-category" value="${escHtml(s.category || '')}">
          </div>
        </div>
        <div class="form-group" style="margin-bottom:16px">
          <label>Notes</label>
          <textarea id="sub-notes">${escHtml(s.notes || '')}</textarea>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Changes</button>
        </div>
      </form>
    `);
    document.getElementById('sub-edit-form').onsubmit = e => { e.preventDefault(); this.submitEdit(id); };
  },

  async submitEdit(id) {
    const body = {
      name: document.getElementById('sub-name').value,
      payee: document.getElementById('sub-payee').value || null,
      amount: parseFloat(document.getElementById('sub-amount').value),
      billing_cycle: document.getElementById('sub-cycle').value,
      next_due_date: document.getElementById('sub-due').value,
      category: document.getElementById('sub-category').value || null,
      notes: document.getElementById('sub-notes').value || null
    };
    try {
      await api(`/api/subscriptions/${id}`, { method: 'PUT', body });
      closeModal();
      toast('Subscription updated');
      await this.render();
    } catch (e) { toast(e.message, 'error'); }
  },

  async toggleActive(id, newActive) {
    try {
      await api(`/api/subscriptions/${id}`, { method: 'PUT', body: { active: newActive } });
      toast(newActive ? 'Subscription resumed' : 'Subscription paused');
      await this.render();
    } catch (e) { toast(e.message, 'error'); }
  },

  async deleteRow(id) {
    if (!confirm('Delete this subscription?')) return;
    try {
      await api(`/api/subscriptions/${id}`, { method: 'DELETE' });
      toast('Subscription deleted');
      await this.render();
    } catch (e) { toast(e.message, 'error'); }
  }
};
