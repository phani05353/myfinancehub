// Worker peer watch — the finance worker's half of "any live worker alerts on
// the dead" (home-lab-utils dashboard/worker-watch.js holds the other half).
//
// On a timer (NOT a Temporal schedule: a schedule needs a live worker on its
// queue, which is exactly what may be missing), ask Temporal which pollers are
// attached to EVERY watched task queue — finance-tq included — and POST the raw
// answer to the homelab dashboard's /api/workers/report. The dashboard dedupes
// every watcher's view into one PWA push per outage (and one on recovery), and
// replies with the queue list, so no homelab queue names live here.
//
// Off unless NOTIFY_HUB_URL + NOTIFY_INGEST_TOKEN are set (the token must equal
// home-lab-utils' NOTIFY_INGEST_TOKEN secret). Never throws.
//
// Hub-down fallback: the push channel IS the dashboard, so the one outage it
// can't announce is its own. After HUB_DOWN_ALERT_AFTER (default 5) failed
// reports in a row we EMAIL via Resend (RESEND_API_KEY / REPORT_EMAIL_FROM /
// REPORT_EMAIL_TO — the monthly report's vars and recipient fallback; only a
// missing RESEND_API_KEY disables it, logged once), once per outage plus once
// on recovery (retried until it goes out). HUB_DOWN_EMAIL_ENABLED=
// false turns it off. The home-lab python + ts workers do the same
// (homelab/hub_fallback.py, src/hub-fallback.ts — keep the three in step), so
// the email carries a Resend Idempotency-Key from the outage kind + its start
// floored to a 30-min UTC bucket: the three converge on ONE email (Resend keeps
// keys 24h; a reused key with a different payload → 409 = "a peer sent it").
// Residuals: two emails when first failures straddle a bucket boundary; state
// is in-memory, so a restart mid-outage may resend once.

const { Connection } = require('@temporalio/client');

const WATCHER = 'finance-worker';
const TASK_QUEUE_TYPE_WORKFLOW = 1;
const TASK_QUEUE_TYPE_ACTIVITY = 2;
const RPC_TIMEOUT_MS = 4000;

// ── Hub-down fallback (pure decision logic; unit-tested) ─────────────────────
const UNREACHABLE = 'unreachable'; // network error / timeout / 5xx
const TOKEN = 'token'; // 401/403: hub up, rejects NOTIFY_INGEST_TOKEN
const BUCKET_MS = 30 * 60 * 1000;

// Report outcome → outage kind. null status = no HTTP answer. 2xx / other 4xx → null (not counted).
function classify(status) {
  if (status == null || status >= 500) return UNREACHABLE;
  if (status === 401 || status === 403) return TOKEN;
  return null;
}

// hub-down-unreachable-202610030130 — start floored to 30 min UTC.
function idempotencyKey(phase, kind, sinceMs) {
  const d = new Date(Math.floor(sinceMs / BUCKET_MS) * BUCKET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `hub-${phase}-${kind}-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

// - failure(): counts; returns the "down" alert once the threshold is hit. A
//   different kind after an emailed outage (unreachable → 401) is a NEW outage:
//   the count restarts so it gets its own email (new key), and no "back" is
//   sent for the old one (the hub isn't healthy).
// - success(): ends the streak; after an emailed outage it returns the "back"
//   alert and parks it in pendingBack until backDone() (retried on later ticks
//   if the send fails). A new outage getting emailed drops it.
// - neutral(): a response that is neither (404/400…) breaks an un-emailed
//   streak; once an outage was emailed it changes nothing.
class HubOutageTracker {
  constructor(threshold) {
    this.threshold = Math.max(1, threshold);
    this.failures = 0;
    this.since = null;
    this.error = '';
    this.alerted = null; // kind we emailed about, this outage
    this.pendingBack = null; // "back" email not sent yet
  }
  _reset() {
    this.failures = 0;
    this.since = null;
    this.error = '';
    this.alerted = null;
  }
  failure(kind, error, now) {
    if (this.alerted != null && kind !== this.alerted) this._reset(); // a different problem: its own outage + email
    this.failures += 1;
    if (this.since == null) this.since = now;
    this.error = error;
    if (this.alerted == null && this.failures >= this.threshold) {
      this.alerted = kind;
      this.pendingBack = null; // superseded by the new outage
      return { phase: 'down', kind, since: this.since, error, failures: this.failures, key: idempotencyKey('down', kind, this.since), durationMs: 0 };
    }
    return null;
  }
  success(now) {
    let alert = null;
    if (this.alerted != null && this.since != null) {
      alert = {
        phase: 'back', kind: this.alerted, since: this.since, error: this.error, failures: this.failures,
        key: idempotencyKey('back', this.alerted, this.since), durationMs: now - this.since,
      };
      this.pendingBack = alert;
    }
    this._reset();
    return alert;
  }
  neutral() { if (this.alerted == null) this._reset(); }
  unsent() { this.alerted = null; } // the down email didn't go out — retry on the next failure
  backDone() { this.pendingBack = null; }
}

// HUB_DOWN_ALERT_AFTER: empty / non-integer → 5, then clamp to ≥ 1 (same as python + ts).
function parseAlertAfter(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const n = /^[+-]?\d+$/.test(s) ? Number(s) : 5;
  return Math.max(1, n);
}

const DEFAULT_REPORT_EMAIL_TO = 'maruthi.phanikumar@yahoo.com'; // = activities.js monthly report

function fmtDuration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return '<1m';
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function hubEmail(alert, watcher, hubUrl) {
  const since = new Date(alert.since).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  if (alert.phase === 'back') {
    const what = alert.kind === TOKEN ? 'accepts the ingest token again' : 'is answering again';
    return {
      subject: `✅ Homelab dashboard reachable again (down ${fmtDuration(alert.durationMs)})`,
      html: `<p>Peer watch on <b>${esc(watcher)}</b> reports the dashboard hub ${what}. ` +
        `It was out since ${since} (${fmtDuration(alert.durationMs)}).</p>` +
        '<p>PWA push alerts — including worker-down alerts — are flowing again.</p>',
    };
  }
  const token = alert.kind === TOKEN;
  const subject = token
    ? "⚠️ Homelab dashboard rejects the workers' token — push alerts are offline"
    : '⚠️ Homelab dashboard unreachable — push alerts are offline';
  const check = token
    ? "the dashboard is up but answers 401/403, so the workers' NOTIFY_INGEST_TOKEN no longer matches its own. " +
      'Re-set the NOTIFY_INGEST_TOKEN secret to the same value in BOTH home-lab-utils and myfinancehub, then redeploy both.'
    : 'the homelab-dashboard container in Portainer / Dozzle (crashed? restart loop?) and the latest home-lab-utils deploy run.';
  return {
    subject,
    html: `<p>Peer watch on <b>${esc(watcher)}</b> could not report to the dashboard hub ` +
      `(<code>${esc(hubUrl)}</code>) ${alert.failures} times in a row, since ${since}.</p>` +
      `<p>Last error: <code>${esc(String(alert.error).slice(0, 300))}</code></p>` +
      '<p>What this means: no PWA push notifications — including worker-down alerts — until it is back. ' +
      "You'll get one more email when it recovers.</p>" +
      `<p>First things to check: ${check}</p>`,
  };
}

// Resend send (same vars as activities.js's monthly report) + Idempotency-Key.
// Throws on non-2xx with err.status (409 = key already used by a peer).
async function resendEmail(subject, html, key) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify({
      from: process.env.REPORT_EMAIL_FROM || 'onboarding@resend.dev',
      to: process.env.REPORT_EMAIL_TO || DEFAULT_REPORT_EMAIL_TO,
      subject,
      html,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error(`Resend ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
  }
}

// Wires the tracker to report outcomes and to the sender. Never throws.
// opts: { threshold, enabled, missing ('' or what's absent), hubUrl, watcher, send, log?, now? }
class HubWatch {
  constructor(opts) {
    this.o = opts;
    this.tracker = new HubOutageTracker(opts.threshold);
    this.log = opts.log || ((m) => console.warn(m));
    this.now = opts.now || Date.now;
    this.skipLogged = false;
  }
  async ok() {
    this.tracker.success(this.now());
    await this._retryBack();
  }
  async neutral() {
    this.tracker.neutral();
    await this._retryBack();
  }
  async failed(kind, error) {
    const alert = this.tracker.failure(kind, error, this.now());
    if (alert) {
      if (!(await this._send(alert))) this.tracker.unsent();
    } else await this._retryBack();
  }
  // Send (or re-send, same key) a pending "back" email.
  async _retryBack() {
    const back = this.tracker.pendingBack;
    if (back && (await this._send(back))) this.tracker.backDone();
  }
  // true = sent, deduped by a peer, or deliberately skipped (no retry).
  async _send(alert) {
    if (!this.o.enabled || this.o.missing) {
      if (!this.skipLogged) {
        this.log(`peer-watch: hub ${alert.phase}, but no fallback email (${!this.o.enabled ? 'HUB_DOWN_EMAIL_ENABLED=false' : `needs ${this.o.missing}`})`);
        this.skipLogged = true;
      }
      return true;
    }
    const { subject, html } = hubEmail(alert, this.o.watcher, this.o.hubUrl);
    try {
      await this.o.send(subject, html, alert.key);
      this.log(`peer-watch: hub-${alert.phase} email sent (${alert.key})`);
      return true;
    } catch (err) {
      if (err && err.status === 409) {
        this.log(`peer-watch: hub-${alert.phase} email already sent by a peer (${alert.key})`);
        return true;
      }
      this.log(`peer-watch: hub-${alert.phase} email failed (${(err && err.message) || err})`);
      return false;
    }
  }
}

function toMillis(ts) {
  if (!ts) return null;
  if (ts instanceof Date) return ts.getTime();
  if (ts.seconds == null) return null;
  const secs = Number(String(ts.seconds));
  return Number.isFinite(secs) ? secs * 1000 + Math.round(Number(ts.nanos || 0) / 1e6) : null;
}

async function checkQueue(conn, namespace, queue) {
  const describe = (taskQueueType) =>
    conn.withDeadline(Date.now() + RPC_TIMEOUT_MS, () =>
      conn.workflowService.describeTaskQueue({ namespace, taskQueue: { name: queue }, taskQueueType })
    );
  try {
    const [wf, act] = await Promise.all([
      describe(TASK_QUEUE_TYPE_WORKFLOW),
      describe(TASK_QUEUE_TYPE_ACTIVITY).catch(() => null),
    ]);
    // One entry per worker identity, freshest poll wins.
    const latest = new Map();
    for (const p of [...(wf.pollers || []), ...((act && act.pollers) || [])]) {
      const id = String(p.identity || 'unknown');
      const ms = toMillis(p.lastAccessTime);
      if (!latest.has(id) || (ms != null && ms > (latest.get(id) ?? -Infinity))) latest.set(id, ms);
    }
    const times = [...latest.values()].filter((m) => m != null);
    return {
      queue,
      pollers: latest.size,
      lastPollSeconds: times.length ? Math.max(0, Math.round((Date.now() - Math.max(...times)) / 1000)) : null,
    };
  } catch (err) {
    return { queue, error: String(err.message || err).slice(0, 200) };
  }
}

function startPeerWatch({ address, namespace }) {
  const hub = String(process.env.NOTIFY_HUB_URL || '').replace(/\/+$/, '');
  const token = process.env.NOTIFY_INGEST_TOKEN || '';
  if (/^(0|false|no|off)$/i.test(process.env.PEER_WATCH_ENABLED || '') || !hub || !token) {
    console.log('peer-watch: off (needs NOTIFY_HUB_URL + NOTIFY_INGEST_TOKEN)');
    return;
  }
  const intervalMs = Math.max(15, Number(process.env.PEER_WATCH_INTERVAL_SECONDS) || 60) * 1000;
  const fallback = new HubWatch({
    threshold: parseAlertAfter(process.env.HUB_DOWN_ALERT_AFTER),
    enabled: !/^(0|false|no|off)$/i.test(process.env.HUB_DOWN_EMAIL_ENABLED || ''),
    missing: process.env.RESEND_API_KEY ? '' : 'RESEND_API_KEY', // recipient falls back like the monthly report
    hubUrl: hub,
    watcher: WATCHER,
    send: resendEmail,
  });

  async function report(results) {
    let res;
    try {
      res = await fetch(`${hub}/api/workers/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ watcher: WATCHER, results }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      const code = err && err.cause && err.cause.code;
      await fallback.failed(UNREACHABLE, `${err.message}${code ? ` (${code})` : ''}`.slice(0, 300));
      throw err;
    }
    if (res.ok) await fallback.ok();
    else {
      const kind = classify(res.status);
      if (kind) await fallback.failed(kind, `HTTP ${res.status}`);
      else await fallback.neutral(); // 404/400…: the hub answered — breaks an un-emailed streak
    }
    if (!res.ok) throw new Error(`hub ${res.status}`);
    return (await res.json()).queues || [];
  }

  let conn = null;
  let queues = [];
  let busy = false;
  let warned = false;
  async function tick() {
    if (busy) return; // a slow tick must not stack up behind itself
    busy = true;
    try {
      // First tick (or the hub was down): an empty report fetches the list.
      if (!queues.length) queues = await report([]);
      if (!queues.length) return;
      let results;
      try {
        if (!conn) conn = await Connection.connect({ address, connectTimeout: '3s' });
        const c = conn;
        results = await Promise.all(queues.map((q) => checkQueue(c, namespace, q.queue)));
      } catch (err) {
        results = queues.map((q) => ({ queue: q.queue, error: String(err.message || err) }));
      }
      // Every lookup failing = the channel is dead; redial next tick.
      if (results.every((r) => r.error) && conn) {
        conn.close().catch(() => {});
        conn = null;
      }
      const next = await report(results);
      if (next.length) queues = next;
      warned = false;
    } catch (err) {
      if (!warned) console.warn(`peer-watch: report failed (${err.message}) — will retry`);
      warned = true;
    } finally {
      busy = false;
    }
  }

  setInterval(tick, intervalMs).unref();
  tick();
  console.log(`peer-watch: watching all worker queues every ${intervalMs / 1000}s`);
}

module.exports = {
  startPeerWatch,
  // exported for test/peer-watch.test.js
  classify, idempotencyKey, HubOutageTracker, hubEmail, HubWatch, parseAlertAfter, UNREACHABLE, TOKEN,
};
