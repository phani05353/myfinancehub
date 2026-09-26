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

const { Connection } = require('@temporalio/client');

const WATCHER = 'finance-worker';
const TASK_QUEUE_TYPE_WORKFLOW = 1;
const TASK_QUEUE_TYPE_ACTIVITY = 2;
const RPC_TIMEOUT_MS = 4000;

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

  async function report(results) {
    const res = await fetch(`${hub}/api/workers/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ watcher: WATCHER, results }),
      signal: AbortSignal.timeout(8000),
    });
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

module.exports = { startPeerWatch };
