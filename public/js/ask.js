// Natural-language "Ask" view. Type a plain-English question; the server asks the
// local Ollama model to translate it to a read-only SELECT, runs it, and returns
// { sql, columns, rows, summary }. We render the answer, a results table, and —
// when the shape is chartable (category/amount or date/amount) — a Chart.js chart
// reusing the same library + lifecycle (destroy/recreate) as chartsModule.
const askModule = {
  charts: [],
  enabled: null,

  destroyAll() {
    this.charts.forEach(c => c.destroy());
    this.charts = [];
  },

  async init() {
    this.destroyAll();

    const examples = [
      'How much did I spend on coffee since March?',
      'Top 5 categories this year',
      'Total spending per month over the last 6 months',
      'Which payees did I spend the most at last month?'
    ];

    document.getElementById('view').innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px">
        <h1 style="margin-bottom:0;flex:1">Ask</h1>
      </div>

      <div class="card">
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:14px">
          Ask a question about your finances in plain English. A local AI model turns it into
          a read-only query — your data never leaves the homelab.
        </p>
        <form id="ask-form" style="display:flex;gap:8px;flex-wrap:wrap">
          <input id="ask-input" type="text" class="tx-filter-select-panel" autocomplete="off"
            placeholder="e.g. how much on coffee since March?"
            style="flex:1;min-width:220px" maxlength="500">
          <button type="submit" id="ask-submit" class="btn btn-primary">Ask</button>
        </form>
        <div id="ask-examples" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
          ${examples.map(q => `<button type="button" class="btn btn-ghost btn-sm ask-example" data-q="${escHtml(q)}">${escHtml(q)}</button>`).join('')}
        </div>
      </div>

      <div id="ask-result" style="margin-top:20px"></div>
    `;

    document.getElementById('ask-form').addEventListener('submit', e => {
      e.preventDefault();
      const q = document.getElementById('ask-input').value.trim();
      if (q) this.ask(q);
    });
    document.querySelectorAll('.ask-example').forEach(btn => {
      btn.addEventListener('click', () => {
        const q = btn.dataset.q;
        document.getElementById('ask-input').value = q;
        this.ask(q);
      });
    });

    // Surface a disabled/unreachable model up front so the UI degrades gracefully.
    try {
      const status = await api('/api/query/status');
      this.enabled = status.enabled;
      if (!status.enabled) {
        document.getElementById('ask-result').innerHTML =
          `<div class="card"><p style="color:var(--text-muted)">Natural-language query is disabled on this server.</p></div>`;
        document.getElementById('ask-submit').disabled = true;
      }
    } catch (_) { /* status is best-effort; let the ask attempt surface errors */ }
  },

  async ask(question) {
    this.destroyAll();
    const resultEl = document.getElementById('ask-result');
    const submitBtn = document.getElementById('ask-submit');
    submitBtn.disabled = true;
    resultEl.innerHTML = `<div class="card"><p style="color:var(--text-muted)">🤔 Thinking… asking the local model.</p></div>`;

    let data;
    try {
      data = await api('/api/query', { method: 'POST', body: { question } });
    } catch (err) {
      resultEl.innerHTML = `<div class="card"><p style="color:var(--danger)">${escHtml(err.message)}</p>${
        // If the server returned a rejected SQL, show it for transparency.
        ''
      }</div>`;
      toast(err.message, 'error');
      return;
    } finally {
      submitBtn.disabled = false;
    }

    this.render(data);
  },

  render(data) {
    const resultEl = document.getElementById('ask-result');
    const { sql, columns = [], rows = [], summary } = data;

    const summaryHtml = summary
      ? `<div class="card" style="margin-bottom:16px">
           <div style="font-size:15px;line-height:1.5">${escHtml(summary)}</div>
         </div>`
      : '';

    const sqlHtml = sql
      ? `<details class="card" style="margin-top:16px">
           <summary style="cursor:pointer;color:var(--text-muted);font-size:13px">Show generated SQL</summary>
           <pre style="overflow:auto;margin-top:12px;font-size:12px;color:var(--text);white-space:pre-wrap;word-break:break-word">${escHtml(sql)}</pre>
         </details>`
      : '';

    if (!rows.length) {
      resultEl.innerHTML = `${summaryHtml}
        <div class="card"><div class="empty-state"><div class="empty-icon">∅</div><p>No results for that question.</p></div></div>
        ${sqlHtml}`;
      return;
    }

    // Build a table.
    const fmtCell = (col, val) => {
      if (val === null || val === undefined) return '—';
      if (typeof val === 'number' && this.looksLikeMoney(col)) return fmtCur(val);
      if (typeof val === 'number') return val.toLocaleString('en-US');
      return escHtml(String(val));
    };
    const tableHtml = `
      <div class="card">
        <div class="table-wrap">
          <table class="payee-detail-table">
            <thead><tr>${columns.map(c => `<th>${escHtml(c)}</th>`).join('')}</tr></thead>
            <tbody>
              ${rows.map(r => `<tr>${columns.map(c => `<td data-label="${escHtml(c)}">${fmtCell(c, r[c])}</td>`).join('')}</tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;

    resultEl.innerHTML = `${summaryHtml}${tableHtml}<div id="ask-chart-wrap"></div>${sqlHtml}`;

    this.maybeRenderChart(columns, rows);
  },

  looksLikeMoney(col) {
    return /amount|total|spent|spend|income|net|sum|cost|balance|avg|budget/i.test(col);
  },

  // Render a chart when the result has a label column + a single numeric column.
  // Date/month labels → line chart; categorical labels → bar chart. Reuses the
  // same Chart.js setup + dataset colors as chartsModule (no new library).
  maybeRenderChart(columns, rows) {
    if (rows.length < 2 || columns.length < 2) return;

    // Pick a numeric value column and a non-numeric label column.
    const numericCols = columns.filter(c => rows.every(r => r[c] === null || typeof r[c] === 'number'));
    const valueCol = numericCols.find(c => rows.some(r => typeof r[c] === 'number'));
    const labelCol = columns.find(c => c !== valueCol && rows.every(r => typeof r[c] !== 'number' || r[c] === null));
    if (!valueCol || !labelCol) return;

    const labels = rows.map(r => String(r[labelCol] ?? '—'));
    const values = rows.map(r => Math.abs(Number(r[valueCol]) || 0));

    const isTimeSeries = rows.every(r =>
      r[labelCol] != null && /^\d{4}(-\d{2}){0,2}$/.test(String(r[labelCol]))
    );

    const wrap = document.getElementById('ask-chart-wrap');
    if (!wrap) return;
    wrap.innerHTML = `
      <div class="card" style="margin-top:16px">
        <h2>Chart</h2>
        <div class="chart-container chart-container--tall"><canvas id="ask-chart"></canvas></div>
      </div>`;

    const canvas = document.getElementById('ask-chart');
    if (!canvas) return;

    const palette = ['#34d399','#a78bfa','#2dd4bf','#fbbf24','#f87171','#60a5fa','#f472b6','#4ade80','#fb923c','#c084fc'];
    const isMoney = this.looksLikeMoney(valueCol);
    const fmtTick = v => (isMoney ? '$' + v.toLocaleString() : v.toLocaleString());
    const fmtVal  = v => (isMoney ? fmtCur(v) : v.toLocaleString('en-US'));

    const chart = new Chart(canvas, {
      type: isTimeSeries ? 'line' : 'bar',
      data: {
        labels,
        datasets: [{
          label: valueCol,
          data: values,
          backgroundColor: isTimeSeries ? 'rgba(52,211,153,0.15)' : values.map((_, i) => palette[i % palette.length]),
          borderColor: '#34d399',
          borderWidth: 2,
          borderRadius: isTimeSeries ? 0 : 4,
          fill: isTimeSeries,
          tension: 0.3,
          pointRadius: isTimeSeries ? 0 : undefined,
          pointHoverRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => ` ${fmtVal(ctx.raw)}` } }
        },
        scales: {
          x: { ticks: { color: '#8892a4', maxTicksLimit: 16 }, grid: { color: '#2e3350' } },
          y: { beginAtZero: true, ticks: { color: '#8892a4', callback: fmtTick }, grid: { color: '#2e3350' } }
        }
      }
    });
    this.charts.push(chart);
  }
};
