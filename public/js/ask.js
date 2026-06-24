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
        <span class="badge badge-blue">AI</span>
      </div>

      <div class="card">
        <div class="dash-card-head" style="margin-bottom:14px">
          <div>
            <h2 style="margin:0">Ask your finances</h2>
            <p style="color:var(--text-muted);font-size:13px;margin:4px 0 0">
              Plain English in, a read-only query out — your data never leaves the homelab.
            </p>
          </div>
        </div>
        <form id="ask-form" style="display:flex;gap:8px;flex-wrap:wrap">
          <input id="ask-input" type="text" class="tx-filter-select-panel" autocomplete="off"
            placeholder="e.g. how much on coffee since March?"
            style="flex:1;min-width:220px" maxlength="500">
          <button type="submit" id="ask-submit" class="btn btn-primary">Ask</button>
        </form>
        <div id="ask-examples" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
          <span style="color:var(--text-muted);font-size:12px;align-self:center">Try:</span>
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
          `<div class="card"><div class="empty-state"><div class="empty-icon">⏻</div><p style="color:var(--text-muted)">Natural-language query is disabled on this server.</p></div></div>`;
        document.getElementById('ask-submit').disabled = true;
      }
    } catch (_) { /* status is best-effort; let the ask attempt surface errors */ }
  },

  async ask(question) {
    this.destroyAll();
    const resultEl = document.getElementById('ask-result');
    const submitBtn = document.getElementById('ask-submit');
    submitBtn.disabled = true;
    resultEl.innerHTML = `<div class="card"><div style="display:flex;align-items:center;gap:10px;color:var(--text-muted)"><span class="badge badge-blue">AI</span><span>Thinking… asking the local model.</span></div></div>`;

    let data;
    try {
      data = await api('/api/query', { method: 'POST', body: { question } });
    } catch (err) {
      resultEl.innerHTML = `<div class="card"><div style="display:flex;align-items:flex-start;gap:10px"><span class="badge badge-danger">Error</span><p style="color:var(--danger);margin:0">${escHtml(err.message)}</p></div>${
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
      ? `<div class="card" style="margin-bottom:16px;border-left:3px solid var(--accent)">
           <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
             <span class="badge badge-blue">Answer</span>
           </div>
           <div style="font-size:15px;line-height:1.5;color:var(--text)">${escHtml(summary)}</div>
         </div>`
      : '';

    const sqlHtml = sql
      ? `<details class="card" style="margin-top:16px">
           <summary style="cursor:pointer;color:var(--text-muted);font-size:13px;font-weight:500">Show generated SQL</summary>
           <pre style="overflow:auto;margin-top:12px;padding:12px;font-size:12px;color:var(--text);background:var(--surface2);border-radius:var(--radius-sm);white-space:pre-wrap;word-break:break-word">${escHtml(sql)}</pre>
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
        <div class="dash-card-head">
          <h2 style="margin:0">Results</h2>
          <span class="badge badge-muted">${rows.length} row${rows.length === 1 ? '' : 's'}</span>
        </div>
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
        <div class="dash-card-head"><h2 style="margin:0">Chart</h2></div>
        <div class="chart-container chart-container--tall"><canvas id="ask-chart"></canvas></div>
      </div>`;

    const canvas = document.getElementById('ask-chart');
    if (!canvas) return;

    // Resolve Maple CSS tokens to concrete colors (Chart.js can't parse var()).
    const css = getComputedStyle(document.documentElement);
    const tok = (name, fallback) => (css.getPropertyValue(name).trim() || fallback);
    const accent  = tok('--accent', '#5e8bff');
    const muted    = tok('--text-muted', '#9b938a');
    const palette = [
      accent,
      tok('--success', '#57cf8e'),
      tok('--warning', '#ffb15e'),
      tok('--danger', '#ff8c6b'),
      tok('--accent', '#5e8bff')
    ];
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
          backgroundColor: isTimeSeries ? 'rgba(94,139,255,0.15)' : values.map((_, i) => palette[i % palette.length]),
          borderColor: accent,
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
          x: { ticks: { color: muted, maxTicksLimit: 16 }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { beginAtZero: true, ticks: { color: muted, callback: fmtTick }, grid: { color: 'rgba(255,255,255,0.05)' } }
        }
      }
    });
    this.charts.push(chart);
  }
};
