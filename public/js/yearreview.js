const yearReviewModule = {
  charts: [],
  currentYear: String(new Date().getFullYear()),

  destroyAll() {
    this.charts.forEach(c => c.destroy());
    this.charts = [];
  },

  async init() {
    this.destroyAll();
    this.currentYear = String(new Date().getFullYear());

    document.getElementById('view').innerHTML = `
      <div class="page-title-row" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:10px">
        <h1 style="margin-bottom:0">📅 Year in Review</h1>
        <select id="yr-year-picker" style="width:120px" onchange="yearReviewModule.changeYear(this.value)">
          <option value="${this.currentYear}">${this.currentYear}</option>
        </select>
      </div>
      <div id="yr-body"><div class="empty-state"><div class="empty-icon">📅</div><p>Loading…</p></div></div>
    `;

    await this.load();
  },

  async changeYear(year) {
    this.currentYear = year;
    this.destroyAll();
    await this.load();
  },

  async load() {
    const data = await api(`/api/year-review/${this.currentYear}`);

    // Populate year picker with all available years
    const picker = document.getElementById('yr-year-picker');
    if (picker && data.available_years.length) {
      picker.innerHTML = data.available_years
        .map(y => `<option value="${y}" ${y === this.currentYear ? 'selected' : ''}>${y}</option>`)
        .join('');
    }

    this.renderAll(data);
  },

  // Fill gaps so we always have all 12 months
  fullYear(monthly) {
    const map = {};
    for (const m of monthly) map[m.month] = m;
    return Array.from({ length: 12 }, (_, i) => {
      const mm = String(i + 1).padStart(2, '0');
      return map[mm] || { month: mm, income: 0, expenses: 0 };
    });
  },

  renderAll(data) {
    const months = this.fullYear(data.monthly);
    const hasData = data.summary.tx_count > 0;

    document.getElementById('yr-body').innerHTML = `
      ${this.summaryHtml(data.summary)}
      ${hasData ? `
        <div class="yr-charts-grid">
          <div class="card">
            <div class="dash-card-head"><h3>Monthly Income vs Expenses</h3></div>
            <div class="chart-container chart-container--tall"><canvas id="yr-monthly-chart"></canvas></div>
          </div>
          <div class="card">
            <div class="dash-card-head"><h3>Spending by Category</h3></div>
            <div class="chart-container chart-container--tall"><canvas id="yr-cat-chart"></canvas></div>
          </div>
        </div>
        <div class="card" style="margin-top:20px">
          <div class="dash-card-head"><h3>Month-by-Month Breakdown</h3></div>
          ${this.monthTableHtml(months)}
        </div>
        <div class="yr-bottom-grid">
          <div class="card">
            <div class="dash-card-head"><h3>Top 5 Expenses</h3></div>
            ${this.topExpensesHtml(data.top_expenses)}
          </div>
          <div class="card">
            <div class="dash-card-head"><h3>Insights</h3></div>
            ${this.insightsHtml(months, data.summary)}
          </div>
        </div>
      ` : ''}
    `;

    if (hasData) {
      this.renderMonthlyChart(months);
      this.renderCategoryChart(data.categories);
    }
  },

  summaryHtml(s) {
    const savingsRate = s.total_income > 0
      ? ((s.net / s.total_income) * 100).toFixed(1)
      : '—';
    const positive = s.net >= 0;
    const netColor = positive ? 'var(--success)' : 'var(--danger)';
    const rateBadge = positive ? 'kpi-badge' : 'kpi-badge kpi-badge--danger';

    return `
      <div class="kpi-grid" style="margin-bottom:20px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
        <div class="kpi-card">
          <div class="kpi-label">Total Income</div>
          <div class="kpi-value" style="color:var(--success)">${fmtCur(s.total_income)}</div>
          <span class="kpi-badge kpi-badge--muted">${s.tx_count} transactions</span>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Total Expenses</div>
          <div class="kpi-value" style="color:var(--danger)">${fmtCur(s.total_expenses)}</div>
          <span class="kpi-badge kpi-badge--muted">across the year</span>
        </div>
        <div class="kpi-card kpi-card--feature">
          <div class="kpi-label">${positive ? 'Net Savings' : 'Net Loss'}</div>
          <div class="kpi-value" style="color:${netColor}">${fmtCur(Math.abs(s.net))}</div>
          <span class="${rateBadge}">${positive ? 'saved this year' : 'over this year'}</span>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Savings Rate</div>
          <div class="kpi-value" style="color:${netColor}">${savingsRate}${savingsRate !== '—' ? '%' : ''}</div>
          <span class="${rateBadge}">of income saved</span>
        </div>
      </div>
    `;
  },

  monthTableHtml(months) {
    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const rows = months.map((m, i) => {
      const net = m.income - m.expenses;
      const isEmpty = m.income === 0 && m.expenses === 0;
      return `
        <tr style="${isEmpty ? 'opacity:.35' : ''}">
          <td>${MONTH_NAMES[i]}</td>
          <td style="text-align:right" class="amount-positive">${m.income > 0 ? fmtCur(m.income) : '—'}</td>
          <td style="text-align:right" class="amount-negative">${m.expenses > 0 ? fmtCur(m.expenses) : '—'}</td>
          <td style="text-align:right;font-weight:600;color:${net >= 0 ? 'var(--success)' : 'var(--danger)'}">${isEmpty ? '—' : fmtCur(Math.abs(net))}</td>
          <td style="text-align:right">${isEmpty ? '' : `<span class="badge ${net >= 0 ? 'badge-green' : 'badge-red'}">${net >= 0 ? '▲ saved' : '▼ over'}</span>`}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="table-wrap yr-month-table-wrap">
        <table style="min-width:320px">
          <thead>
            <tr>
              <th>Month</th>
              <th style="text-align:right">Income</th>
              <th style="text-align:right">Expenses</th>
              <th style="text-align:right">Net</th>
              <th style="text-align:right"></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  },

  topExpensesHtml(expenses) {
    if (!expenses.length) return '<p style="color:var(--text-muted)">No expense data.</p>';
    return expenses.map((t, i) => `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:10px 0;${i < expenses.length - 1 ? 'border-bottom:1px solid var(--border)' : ''}">
        <div>
          <div style="font-weight:600;font-size:14px">${escHtml(t.payee)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${t.date}${t.category ? ' · ' + escHtml(t.category) : ''}</div>
        </div>
        <div class="amount-negative" style="font-weight:700;font-size:16px;white-space:nowrap;margin-left:12px">${fmtCur(Math.abs(t.amount))}</div>
      </div>
    `).join('');
  },

  insightsHtml(months, summary) {
    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const active = months.filter(m => m.income > 0 || m.expenses > 0);
    if (!active.length) return '<p style="color:var(--text-muted)">No data yet.</p>';

    const bestSavings = [...active].sort((a, b) => (b.income - b.expenses) - (a.income - a.expenses))[0];
    const worstMonth  = [...active].sort((a, b) => b.expenses - a.expenses)[0];
    const avgIncome   = active.reduce((s, m) => s + m.income,   0) / active.length;
    const avgExpenses = active.reduce((s, m) => s + m.expenses, 0) / active.length;
    const activeCount = active.length;

    const bestIdx  = parseInt(bestSavings.month, 10) - 1;
    const worstIdx = parseInt(worstMonth.month,  10) - 1;

    return `
      <div class="yr-insight-row">
        <div class="yr-insight-icon">🏆</div>
        <div>
          <div class="yr-insight-label">Best savings month</div>
          <div class="yr-insight-value">${MONTH_NAMES[bestIdx]} — saved ${fmtCur(bestSavings.income - bestSavings.expenses)}</div>
        </div>
      </div>
      <div class="yr-insight-row">
        <div class="yr-insight-icon">🔥</div>
        <div>
          <div class="yr-insight-label">Highest spending month</div>
          <div class="yr-insight-value">${MONTH_NAMES[worstIdx]} — spent ${fmtCur(worstMonth.expenses)}</div>
        </div>
      </div>
      <div class="yr-insight-row">
        <div class="yr-insight-icon">📊</div>
        <div>
          <div class="yr-insight-label">Avg monthly income</div>
          <div class="yr-insight-value">${fmtCur(avgIncome)} <span style="color:var(--text-muted);font-size:12px">over ${activeCount} months</span></div>
        </div>
      </div>
      <div class="yr-insight-row">
        <div class="yr-insight-icon">💸</div>
        <div>
          <div class="yr-insight-label">Avg monthly expenses</div>
          <div class="yr-insight-value">${fmtCur(avgExpenses)} <span style="color:var(--text-muted);font-size:12px">per month</span></div>
        </div>
      </div>
      <div class="yr-insight-row" style="border-bottom:none">
        <div class="yr-insight-icon">💰</div>
        <div>
          <div class="yr-insight-label">Annual savings rate</div>
          <div class="yr-insight-value" style="color:${summary.net >= 0 ? 'var(--success)' : 'var(--danger)'}">
            ${summary.total_income > 0 ? ((summary.net / summary.total_income) * 100).toFixed(1) + '%' : '—'}
          </div>
        </div>
      </div>
    `;
  },

  renderMonthlyChart(months) {
    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const ctx = document.getElementById('yr-monthly-chart');
    if (!ctx) return;
    const year = this.currentYear;
    const chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: MONTH_NAMES,
        datasets: [
          {
            label: 'Income',
            data: months.map(m => m.income),
            backgroundColor: 'rgba(52,211,153,0.65)',
            borderColor: '#34d399',
            borderWidth: 2,
            borderRadius: 4
          },
          {
            label: 'Expenses',
            data: months.map(m => m.expenses),
            backgroundColor: 'rgba(248,113,113,0.65)',
            borderColor: '#f87171',
            borderWidth: 2,
            borderRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onClick: (evt, els) => {
          if (!els.length) return;
          const idx = els[0].index;
          const month = `${year}-${String(idx + 1).padStart(2, '0')}`;
          showFilteredTransactions({
            month,
            title: `${MONTH_NAMES[idx]} ${year}`,
            subtitle: 'All transactions this month'
          });
        },
        plugins: {
          legend: { labels: { color: '#8892a4' } },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.dataset.label}: $${ctx.raw.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
            }
          }
        },
        scales: {
          x: { ticks: { color: '#8892a4' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: '#8892a4', callback: v => '$' + v.toLocaleString() }, grid: { color: 'rgba(255,255,255,0.05)' } }
        }
      }
    });
    ctx.style.cursor = 'pointer';
    this.charts.push(chart);
  },

  renderCategoryChart(categories) {
    const ctx = document.getElementById('yr-cat-chart');
    if (!ctx || !categories.length) return;
    const year = this.currentYear;
    const palette = ['#6366f1','#a78bfa','#22d3ee','#fbbf24','#fb7185','#60a5fa','#f472b6','#34d399','#fb923c','#c084fc'];
    const chart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: categories.map(c => c.category),
        datasets: [{
          data: categories.map(c => c.total),
          backgroundColor: categories.map((_, i) => palette[i % palette.length]),
          borderWidth: 0,
          borderRadius: 4,
          spacing: 2,
          hoverOffset: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        onClick: (evt, els) => {
          if (!els.length) return;
          const c = categories[els[0].index];
          showFilteredTransactions({
            category: c.category, year,
            title: c.category || 'Uncategorized',
            subtitle: `Transactions in ${year}`
          });
        },
        plugins: {
          legend: { position: 'right', labels: { color: '#8892a4', font: { size: 11 }, padding: 12 } },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.label}: $${ctx.raw.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
            }
          }
        }
      }
    });
    ctx.style.cursor = 'pointer';
    this.charts.push(chart);
  }
};
