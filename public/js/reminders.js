const remindersModule = {
  async init() {
    await this.render();
  },

  async render() {
    const [upcoming, paid] = await Promise.all([
      api('/api/reminders?paid=0'),
      api('/api/reminders?paid=1')
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const overdue = upcoming.filter(r => r.due_date < today);
    const dueSoon = upcoming.filter(r => r.due_date >= today && r.due_date <= new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));

    document.getElementById('view').innerHTML = `
      <div class="page-title-row" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <h1 style="margin-bottom:0">Bill Reminders</h1>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-ghost" onclick="remindersModule.openDetectModal()">⟳ Detect</button>
          <button class="btn btn-primary" onclick="remindersModule.openAddModal()">+ Add</button>
        </div>
      </div>

      ${overdue.length > 0 ? `
      <div class="card" style="border-color:var(--danger);margin-bottom:20px">
        <h2 style="color:var(--danger)">Overdue (${overdue.length})</h2>
        ${this.renderTable(overdue, true)}
      </div>` : ''}

      ${dueSoon.length > 0 ? `
      <div class="card" style="border-color:var(--warning);margin-bottom:20px">
        <h2 style="color:var(--warning)">Due This Week (${dueSoon.length})</h2>
        ${this.renderTable(dueSoon, true)}
      </div>` : ''}

      <div class="card" style="margin-bottom:20px">
        <h2>Upcoming Bills</h2>
        ${upcoming.filter(r => !overdue.includes(r) && !dueSoon.includes(r)).length === 0 && overdue.length === 0 && dueSoon.length === 0
          ? `<div class="empty-state" style="padding:32px"><div class="empty-icon">✅</div><p>No upcoming bills</p></div>`
          : this.renderTable(upcoming.filter(r => !overdue.includes(r) && !dueSoon.includes(r)), true)}
      </div>

      <div class="card">
        <details>
          <summary style="cursor:pointer;padding:4px 0;color:var(--text-muted);font-size:13px">
            Paid History (${paid.length} items)
          </summary>
          <div style="margin-top:16px">${this.renderTable(paid.slice(0, 50), false)}</div>
        </details>
      </div>
    `;
  },

  renderTable(reminders, showPayBtn) {
    if (reminders.length === 0) return '<p style="color:var(--text-muted);padding:12px 0">None</p>';
    const today = new Date().toISOString().slice(0, 10);
    return `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Title</th><th>Due Date</th><th>Amount</th><th>Recurring</th>
              ${showPayBtn ? '<th>Status</th>' : '<th>Paid On</th>'}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${reminders.map(r => {
              const isOverdue = r.due_date < today && !r.paid;
              return `<tr class="${isOverdue ? 'overdue' : ''}">
                <td><strong>${escHtml(r.title)}</strong>${r.notes ? `<br><span style="color:var(--text-muted);font-size:11px">${escHtml(r.notes)}</span>` : ''}</td>
                <td>${fmtDate(r.due_date)}</td>
                <td>${r.amount ? fmt(-Math.abs(r.amount)) : '—'}</td>
                <td>${r.recurring ? `<span class="badge badge-blue">Every ${r.recur_days}d</span>` : '<span class="badge badge-gray">Once</span>'}</td>
                ${showPayBtn
                  ? `<td><span class="badge ${isOverdue ? 'badge-red' : 'badge-yellow'}">${isOverdue ? 'Overdue' : 'Pending'}</span></td>`
                  : `<td style="color:var(--text-muted)">${fmtDate(r.paid_date)}</td>`
                }
                <td style="white-space:nowrap">
                  ${showPayBtn ? `<button class="btn btn-success btn-sm" onclick="remindersModule.markPaid(${r.id})">✓ Paid</button>` : ''}
                  <button class="btn btn-ghost btn-sm" onclick="remindersModule.openEditModal(${r.id})">Edit</button>
                  <button class="btn btn-danger btn-sm" onclick="remindersModule.deleteRow(${r.id})">Del</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  },

  async openDetectModal() {
    openModal('<h2>Scanning Last Month…</h2><p style="color:var(--text-muted);margin-top:12px">Looking for bills in your transaction history…</p>');

    let result;
    try {
      result = await api('/api/reminders/detect');
    } catch (e) {
      toast(e.message, 'error');
      closeModal();
      return;
    }

    const { suggestions, prev_month } = result;

    if (suggestions.length === 0) {
      openModal(`
        <h2>No New Bills Detected</h2>
        <p style="color:var(--text-muted);margin-top:12px">
          No bill-like transactions found in <strong>${prev_month}</strong>, or they're already tracked as reminders.
        </p>
        <p style="color:var(--text-muted);margin-top:8px;font-size:12px">
          Bills are detected from categories like: Utilities, Mortgage, HOA, Internet, Phone, Insurance, Subscriptions, etc.
        </p>
        <div style="margin-top:20px;text-align:right">
          <button class="btn btn-ghost" onclick="closeModal()">Close</button>
        </div>
      `);
      return;
    }

    openModal(`
      <h2>Bills Detected from ${prev_month} (${suggestions.length})</h2>
      <p style="color:var(--text-muted);margin:8px 0 16px;font-size:13px">
        These payees look like recurring bills. Select which ones to create reminders for:
      </p>
      <form id="detect-rem-form">
        <div style="max-height:380px;overflow-y:auto;margin-bottom:16px">
          ${suggestions.map((s, i) => `
            <div style="display:flex;align-items:flex-start;gap:12px;padding:12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px">
              <input type="checkbox" id="dr-check-${i}" checked style="width:auto;margin-top:3px;flex-shrink:0">
              <div style="flex:1;min-width:0">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                  <strong>${escHtml(s.payee)}</strong>
                  <span class="badge badge-blue" style="font-size:11px">${escHtml(s.category || '')}</span>
                </div>
                <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px">
                  <span style="color:var(--text-muted);font-size:12px">
                    Avg: <strong style="color:var(--danger)">$${s.avg_amount.toFixed(2)}</strong>
                  </span>
                  <span style="color:var(--text-muted);font-size:12px">
                    Last paid: <strong>${fmtDate(s.last_date)}</strong>
                  </span>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  <div style="display:flex;flex-direction:column;gap:4px">
                    <label style="font-size:11px;color:var(--text-muted)">Expected Amount ($)</label>
                    <input type="number" id="dr-amt-${i}" step="0.01" value="${s.avg_amount.toFixed(2)}"
                      style="width:110px;padding:4px 8px;font-size:12px">
                  </div>
                  <div style="display:flex;flex-direction:column;gap:4px">
                    <label style="font-size:11px;color:var(--text-muted)">Due Date</label>
                    <input type="date" id="dr-due-${i}" value="${s.suggested_due}"
                      style="padding:4px 8px;font-size:12px">
                  </div>
                  <div style="display:flex;align-items:flex-end;gap:6px;padding-bottom:2px">
                    <input type="checkbox" id="dr-rec-${i}" checked style="width:auto;margin:0">
                    <label for="dr-rec-${i}" style="font-size:12px;margin:0;cursor:pointer">Recurring monthly</label>
                  </div>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Create Selected (${suggestions.length})</button>
        </div>
      </form>
    `);

    document.getElementById('detect-rem-form').onsubmit = async e => {
      e.preventDefault();
      let added = 0;
      for (let i = 0; i < suggestions.length; i++) {
        const checked = document.getElementById(`dr-check-${i}`)?.checked;
        if (!checked) continue;
        const recurring = document.getElementById(`dr-rec-${i}`)?.checked;
        try {
          await api('/api/reminders', {
            method: 'POST',
            body: {
              title: suggestions[i].payee,
              due_date: document.getElementById(`dr-due-${i}`).value,
              amount: parseFloat(document.getElementById(`dr-amt-${i}`).value),
              category: suggestions[i].category || null,
              recurring: recurring ? 1 : 0,
              recur_days: recurring ? 30 : null
            }
          });
          added++;
        } catch (_) {}
      }
      closeModal();
      toast(`Created ${added} bill reminder${added !== 1 ? 's' : ''}`);
      await this.render();
    };
  },

  openAddModal() {
    const today = new Date().toISOString().slice(0, 10);
    openModal(`
      <h2>Add Bill Reminder</h2>
      <form id="rem-form" style="margin-top:16px">
        <div class="form-row">
          <div class="form-group">
            <label>Title *</label>
            <input type="text" id="rem-title" placeholder="e.g. Electric Bill" required>
          </div>
          <div class="form-group">
            <label>Due Date *</label>
            <input type="date" id="rem-due" value="${today}" required>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Amount (optional)</label>
            <input type="number" id="rem-amount" step="0.01" placeholder="e.g. 120.00">
          </div>
          <div class="form-group">
            <label>Category</label>
            <input type="text" id="rem-category" placeholder="e.g. Utilities">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group" style="flex-direction:row;align-items:center;gap:10px;padding-top:20px">
            <input type="checkbox" id="rem-recurring" style="width:auto;margin:0">
            <label for="rem-recurring" style="margin:0;cursor:pointer">Recurring</label>
          </div>
          <div class="form-group" id="recur-days-group" style="display:none">
            <label>Repeat every (days)</label>
            <input type="number" id="rem-recur-days" placeholder="30" min="1">
          </div>
        </div>
        <div class="form-group" style="margin-bottom:16px">
          <label>Notes</label>
          <textarea id="rem-notes" placeholder="Optional notes…"></textarea>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Add Reminder</button>
        </div>
      </form>
    `);
    document.getElementById('rem-recurring').addEventListener('change', e => {
      document.getElementById('recur-days-group').style.display = e.target.checked ? 'flex' : 'none';
    });
    document.getElementById('rem-form').onsubmit = e => { e.preventDefault(); this.submitAdd(); };
  },

  async submitAdd() {
    const recurring = document.getElementById('rem-recurring').checked;
    const body = {
      title: document.getElementById('rem-title').value,
      due_date: document.getElementById('rem-due').value,
      amount: document.getElementById('rem-amount').value || null,
      category: document.getElementById('rem-category').value || null,
      recurring: recurring ? 1 : 0,
      recur_days: recurring ? parseInt(document.getElementById('rem-recur-days').value) || null : null,
      notes: document.getElementById('rem-notes').value || null
    };
    try {
      await api('/api/reminders', { method: 'POST', body });
      closeModal();
      toast('Reminder added');
      await this.render();
    } catch (e) { toast(e.message, 'error'); }
  },

  async openEditModal(id) {
    const r = await api(`/api/reminders/${id}`).catch(() => null);
    if (!r) return;

    openModal(`
      <h2>Edit Reminder</h2>
      <form id="rem-edit-form" style="margin-top:16px">
        <div class="form-row">
          <div class="form-group">
            <label>Title *</label>
            <input type="text" id="rem-title" value="${escHtml(r.title)}" required>
          </div>
          <div class="form-group">
            <label>Due Date *</label>
            <input type="date" id="rem-due" value="${r.due_date}" required>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Amount</label>
            <input type="number" id="rem-amount" step="0.01" value="${r.amount || ''}">
          </div>
          <div class="form-group">
            <label>Category</label>
            <input type="text" id="rem-category" value="${escHtml(r.category || '')}">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group" style="flex-direction:row;align-items:center;gap:10px;padding-top:20px">
            <input type="checkbox" id="rem-recurring" style="width:auto;margin:0" ${r.recurring ? 'checked' : ''}>
            <label for="rem-recurring" style="margin:0;cursor:pointer">Recurring</label>
          </div>
          <div class="form-group" id="recur-days-group" style="${r.recurring ? 'display:flex' : 'display:none'}">
            <label>Repeat every (days)</label>
            <input type="number" id="rem-recur-days" value="${r.recur_days || ''}" min="1">
          </div>
        </div>
        <div class="form-group" style="margin-bottom:16px">
          <label>Notes</label>
          <textarea id="rem-notes">${escHtml(r.notes || '')}</textarea>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Changes</button>
        </div>
      </form>
    `);
    document.getElementById('rem-recurring').addEventListener('change', e => {
      document.getElementById('recur-days-group').style.display = e.target.checked ? 'flex' : 'none';
    });
    document.getElementById('rem-edit-form').onsubmit = e => { e.preventDefault(); this.submitEdit(id); };
  },

  async submitEdit(id) {
    const recurring = document.getElementById('rem-recurring').checked;
    const body = {
      title: document.getElementById('rem-title').value,
      due_date: document.getElementById('rem-due').value,
      amount: document.getElementById('rem-amount').value || null,
      category: document.getElementById('rem-category').value || null,
      recurring: recurring ? 1 : 0,
      recur_days: recurring ? parseInt(document.getElementById('rem-recur-days').value) || null : null,
      notes: document.getElementById('rem-notes').value || null
    };
    try {
      await api(`/api/reminders/${id}`, { method: 'PUT', body });
      closeModal();
      toast('Reminder updated');
      await this.render();
    } catch (e) { toast(e.message, 'error'); }
  },

  async markPaid(id) {
    try {
      const result = await api(`/api/reminders/${id}/pay`, { method: 'POST', body: {} });
      const msg = result.next
        ? `Marked paid! Next due: ${fmtDate(result.next.due_date)}`
        : 'Marked as paid';
      toast(msg);
      await this.render();
    } catch (e) { toast(e.message, 'error'); }
  },

  async deleteRow(id) {
    if (!confirm('Delete this reminder?')) return;
    try {
      await api(`/api/reminders/${id}`, { method: 'DELETE' });
      toast('Reminder deleted');
      await this.render();
    } catch (e) { toast(e.message, 'error'); }
  }
};
