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

    document.getElementById('view').innerHTML = `
      <div class="page-title-row" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <h1 style="margin-bottom:0">Charts</h1>
        <div style="display:flex;gap:8px;align-items:center">
          <label style="color:var(--text-muted);font-size:13px">Month:</label>
          <select id="chart-month" style="width:150px">
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
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <h2>Income vs Expenses Trend</h2>
          <select id="trend-months" style="width:140px">
            <option value="3">Last 3 months</option>
            <option value="6" selected>Last 6 months</option>
            <option value="12">Last 12 months</option>
          </select>
        </div>
        <div class="chart-container" style="height:260px"><canvas id="trend-chart"></canvas></div>
      </div>

      <div class="card" style="margin-top:20px">
        <h2>Top Payees — Details</h2>
        <div id="payee-table"></div>
      </div>
    `;

    document.getElementById('chart-month').addEventListener('change', () => this.loadCharts());
    document.getElementById('trend-months').addEventListener('change', () => this.loadTrend());

    await this.loadCharts();
    await this.loadTrend();
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
            borderColor: '#1a1d27',
            borderWidth: 3
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
            <table>
              <thead><tr><th>Payee</th><th style="text-align:right">Transactions</th><th style="text-align:right">Total Spent</th><th>Share</th></tr></thead>
              <tbody>
                ${byPayee.map(p => {
                  const pct = total > 0 ? (Math.abs(p.total) / total * 100).toFixed(1) : 0;
                  return `<tr>
                    <td>${escHtml(p.payee)}</td>
                    <td style="text-align:right;color:var(--text-muted)">${p.count}</td>
                    <td style="text-align:right"><span class="amount-negative">$${Math.abs(p.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span></td>
                    <td>
                      <div style="display:flex;align-items:center;gap:8px">
                        <div style="flex:1;height:6px;background:var(--surface2);border-radius:3px;overflow:hidden">
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
