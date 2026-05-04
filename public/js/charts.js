const chartsModule = {
  charts: [],

  destroyAll() {
    this.charts.forEach(c => c.destroy());
    this.charts = [];
  },

  async init() {
    this.destroyAll();
    const months = await api('/api/charts/available-months');
    const currentMonth = months[0] || new Date().toISOString().slice(0, 7);
    const years = [...new Set(months.map(m => m.slice(0, 4)))];
    const currentYear = years[0] || String(new Date().getFullYear());

    document.getElementById('view').innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px">
        <h1 style="margin-bottom:0;flex:1">Charts</h1>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <label style="color:var(--text-muted);font-size:13px;white-space:nowrap">Month:</label>
          <select id="chart-month" class="tx-filter-select-panel">
            ${months.map(m => `<option value="${m}" ${m === currentMonth ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="charts-grid">
        <div class="card">
          <h2>Spending by Payee</h2>
          <div class="chart-container"><canvas id="payee-chart"></canvas></div>
        </div>
        <div class="card">
          <h2>Category Breakdown</h2>
          <div class="chart-container"><canvas id="category-chart"></canvas></div>
        </div>
      </div>

      <div class="card" style="margin-top:20px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px">
          <h2 style="margin-bottom:0">Income vs Expenses Trend</h2>
          <select id="trend-months" class="tx-filter-select-panel">
            <option value="3">Last 3 months</option>
            <option value="6" selected>Last 6 months</option>
            <option value="12">Last 12 months</option>
          </select>
        </div>
        <div class="chart-container chart-container--tall"><canvas id="trend-chart"></canvas></div>
      </div>

      <div class="card" style="margin-top:20px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px">
          <h2 style="margin-bottom:0">Spending Heatmap</h2>
          <select id="heatmap-year" class="tx-filter-select-panel" style="width:auto">
            ${years.map(y => `<option value="${y}" ${y === currentYear ? 'selected' : ''}>${y}</option>`).join('')}
          </select>
        </div>
        <div id="heatmap-container"></div>
      </div>

      <div class="card" style="margin-top:20px">
        <h2>Top Payees — Details</h2>
        <div id="payee-table"></div>
      </div>
    `;

    document.getElementById('chart-month').addEventListener('change', () => this.loadCharts());
    document.getElementById('trend-months').addEventListener('change', () => this.loadTrend());
    document.getElementById('heatmap-year').addEventListener('change', () => this.loadHeatmap());

    await this.loadCharts();
    await this.loadTrend();
    await this.loadHeatmap();
  },

  async loadCharts() {
    const month = document.getElementById('chart-month')?.value;
    if (!month) return;

    const [byPayee, byCategory] = await Promise.all([
      api(`/api/charts/monthly-by-payee?month=${month}`),
      api(`/api/charts/category-breakdown?month=${month}`)
    ]);

    // Payee bar chart
    const payeeCtx = document.getElementById('payee-chart');
    if (payeeCtx) {
      const existing = this.charts.find(c => c.canvas.id === 'payee-chart');
      if (existing) { existing.destroy(); this.charts = this.charts.filter(c => c !== existing); }

      const labels = byPayee.map(p => p.payee.length > 20 ? p.payee.slice(0, 20) + '…' : p.payee);
      const data = byPayee.map(p => Math.abs(p.total));
      const colors = data.map((_, i) => `hsl(${220 + i * 18}, 70%, 60%)`);

      const chart = new Chart(payeeCtx, {
        type: 'bar',
        data: {
          labels,
          datasets: [{ label: 'Spending ($)', data, backgroundColor: colors, borderRadius: 4 }]
        },
        options: {
          indexAxis: 'y',
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: ctx => ' $' + ctx.raw.toLocaleString('en-US', { minimumFractionDigits: 2 }) } }
          },
          scales: {
            x: { ticks: { color: '#8892a4', callback: v => '$' + v.toLocaleString() }, grid: { color: '#2e3350' } },
            y: { ticks: { color: '#e2e8f0', font: { size: 11 } }, grid: { display: false } }
          }
        }
      });
      this.charts.push(chart);
    }

    // Category donut chart
    const catCtx = document.getElementById('category-chart');
    if (catCtx) {
      const existing = this.charts.find(c => c.canvas.id === 'category-chart');
      if (existing) { existing.destroy(); this.charts = this.charts.filter(c => c !== existing); }

      const palette = ['#6c8ef5','#a78bfa','#34d399','#fbbf24','#f87171','#60a5fa','#f472b6','#4ade80','#fb923c','#c084fc'];
      const chart = new Chart(catCtx, {
        type: 'doughnut',
        data: {
          labels: byCategory.map(c => c.category),
          datasets: [{
            data: byCategory.map(c => c.total),
            backgroundColor: byCategory.map((_, i) => palette[i % palette.length]),
            borderWidth: 0
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { position: 'right', labels: { color: '#8892a4', font: { size: 11 }, padding: 12 } },
            tooltip: { callbacks: { label: ctx => ` ${ctx.label}: $${ctx.raw.toLocaleString('en-US', { minimumFractionDigits: 2 })}` } }
          }
        }
      });
      this.charts.push(chart);
    }

    // Payee table
    const tbl = document.getElementById('payee-table');
    if (tbl) {
      if (byPayee.length === 0) {
        tbl.innerHTML = '<p style="color:var(--text-muted)">No expense data for this month.</p>';
      } else {
        const total = byPayee.reduce((s, p) => s + Math.abs(p.total), 0);
        tbl.innerHTML = `
          <div class="table-wrap">
            <table class="payee-detail-table">
              <thead><tr><th>Payee</th><th style="text-align:right">Txns</th><th style="text-align:right">Total</th><th class="hide-mobile">Share</th></tr></thead>
              <tbody>
                ${byPayee.map(p => {
                  const pct = total > 0 ? (Math.abs(p.total) / total * 100).toFixed(1) : 0;
                  return `<tr>
                    <td data-label="Payee">${escHtml(p.payee)}</td>
                    <td data-label="Txns" style="text-align:right;color:var(--text-muted)">${p.count}</td>
                    <td data-label="Total" style="text-align:right"><span class="amount-negative">$${Math.abs(p.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span></td>
                    <td data-label="Share" class="hide-mobile">
                      <div style="display:flex;align-items:center;gap:8px">
                        <div style="flex:1;height:6px;background:var(--surface2);border-radius:3px;overflow:hidden;min-width:60px">
                          <div style="width:${pct}%;height:100%;background:var(--accent);border-radius:3px"></div>
                        </div>
                        <span style="color:var(--text-muted);font-size:11px;min-width:36px">${pct}%</span>
                      </div>
                    </td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        `;
      }
    }
  },

  async loadHeatmap() {
    const year = document.getElementById('heatmap-year')?.value || new Date().getFullYear();
    const data = await api(`/api/charts/spending-heatmap?year=${year}`);
    const container = document.getElementById('heatmap-container');
    if (!container) return;

    const dayMap = {};
    data.forEach(r => { dayMap[r.date] = +r.total; });

    const amounts = Object.values(dayMap);

    // Percentile thresholds so one big outlier doesn't compress all other days
    const sorted = [...amounts].sort((a, b) => a - b);
    const pct = p => sorted[Math.max(0, Math.floor(sorted.length * p) - 1)] ?? 0;
    const thresholds = [pct(0.4), pct(0.6), pct(0.75), pct(0.9)];

    // Light red → dark red: more spending = darker
    const palette = ['#fecaca', '#f87171', '#ef4444', '#dc2626', '#7f1d1d'];
    const getColor = amount => {
      if (!amount) return null;
      if (amount <= thresholds[0]) return palette[0];
      if (amount <= thresholds[1]) return palette[1];
      if (amount <= thresholds[2]) return palette[2];
      if (amount <= thresholds[3]) return palette[3];
      return palette[4];
    };

    const pad2 = n => String(n).padStart(2, '0');
    const toDateStr = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;

    // Start grid from the Sunday on or before Jan 1
    const jan1 = new Date(+year, 0, 1);
    const dec31 = new Date(+year, 11, 31);
    const gridStart = new Date(jan1);
    gridStart.setDate(gridStart.getDate() - gridStart.getDay());

    const weeks = [];
    let cur = new Date(gridStart);
    while (cur <= dec31) {
      const week = [];
      for (let d = 0; d < 7; d++) { week.push(new Date(cur)); cur.setDate(cur.getDate() + 1); }
      weeks.push(week);
    }

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    const monthLabels = weeks.map((week, wi) => {
      const inYear = week.find(d => d.getFullYear() === +year);
      if (!inYear) return '';
      if (wi === 0) return MONTHS[inYear.getMonth()];
      const prev = weeks[wi-1].find(d => d.getFullYear() === +year);
      return (!prev || inYear.getMonth() !== prev.getMonth()) ? MONTHS[inYear.getMonth()] : '';
    });

    let html = '<div class="heatmap-scroll"><table class="heatmap-table"><thead><tr><th style="width:28px"></th>';
    weeks.forEach((_, wi) => { html += `<th class="heatmap-month-label">${monthLabels[wi]}</th>`; });
    html += '</tr></thead><tbody>';

    for (let di = 0; di < 7; di++) {
      const showLabel = di === 1 || di === 3 || di === 5;
      html += `<tr><td class="heatmap-day-label">${showLabel ? DAYS[di] : ''}</td>`;
      weeks.forEach(week => {
        const date = week[di];
        const inYear = date.getFullYear() === +year;
        const ds = toDateStr(date);
        const amt = dayMap[ds] || 0;
        const bg = inYear ? (getColor(amt) || 'var(--surface2)') : 'transparent';
        const attrs = inYear ? `data-date="${ds}" data-amount="${amt.toFixed(2)}"` : '';
        html += `<td><div class="heatmap-cell${inYear ? ' heatmap-cell--active' : ''}" style="background:${bg}" ${attrs}></div></td>`;
      });
      html += '</tr>';
    }

    html += '</tbody></table></div>';
    html += `<div class="heatmap-legend">
      <span class="heatmap-legend-label">Less</span>
      <div class="heatmap-cell" style="background:var(--surface2)"></div>
      ${palette.map(c => `<div class="heatmap-cell" style="background:${c}"></div>`).join('')}
      <span class="heatmap-legend-label">More</span>
    </div>`;

    container.innerHTML = html;

    // Floating tooltip
    let tip = document.getElementById('heatmap-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'heatmap-tip';
      tip.className = 'heatmap-tooltip-fixed';
      document.body.appendChild(tip);
    }

    container.addEventListener('mouseover', e => {
      const cell = e.target.closest('.heatmap-cell--active');
      if (!cell) { tip.style.display = 'none'; return; }
      const amt = parseFloat(cell.dataset.amount);
      const [yr, mo, dy] = cell.dataset.date.split('-').map(Number);
      const label = new Date(yr, mo-1, dy).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      tip.textContent = `${label} — ${amt > 0 ? '$' + amt.toFixed(2) : 'No spending'}`;
      tip.style.display = 'block';
    });
    container.addEventListener('mousemove', e => {
      tip.style.left = (e.clientX + 14) + 'px';
      tip.style.top  = (e.clientY - 38) + 'px';
    });
    container.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  },

  async loadTrend() {
    const months = document.getElementById('trend-months')?.value || 6;
    const trend = await api(`/api/charts/spending-trend?months=${months}`);

    const trendCtx = document.getElementById('trend-chart');
    if (!trendCtx) return;
    const existing = this.charts.find(c => c.canvas.id === 'trend-chart');
    if (existing) { existing.destroy(); this.charts = this.charts.filter(c => c !== existing); }

    const chart = new Chart(trendCtx, {
      type: 'bar',
      data: {
        labels: trend.map(t => t.month),
        datasets: [
          { label: 'Income', data: trend.map(t => t.income), backgroundColor: 'rgba(52,211,153,0.6)', borderColor: '#34d399', borderWidth: 2, borderRadius: 4 },
          { label: 'Expenses', data: trend.map(t => t.expenses), backgroundColor: 'rgba(248,113,113,0.6)', borderColor: '#f87171', borderWidth: 2, borderRadius: 4 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#8892a4' } },
          tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: $${ctx.raw.toLocaleString('en-US', { minimumFractionDigits: 2 })}` } }
        },
        scales: {
          x: { ticks: { color: '#8892a4' }, grid: { color: '#2e3350' } },
          y: { ticks: { color: '#8892a4', callback: v => '$' + v.toLocaleString() }, grid: { color: '#2e3350' } }
        }
      }
    });
    this.charts.push(chart);
  }
};
