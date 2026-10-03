// Unit tests for the peer-watch hub-down fallback — when the homelab dashboard
// (the push hub) stops taking reports, the finance worker emails instead. Run:
//   node --test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  classify, idempotencyKey, HubOutageTracker, hubEmail, HubWatch, UNREACHABLE, TOKEN,
} = require('../temporal/peer-watch');

const T0 = Date.UTC(2026, 9, 3, 1, 41, 7); // 2026-10-03 01:41:07Z

test('classify: network/5xx unreachable, 401/403 token, others ignored', () => {
  assert.equal(classify(null), UNREACHABLE);
  assert.equal(classify(500), UNREACHABLE);
  assert.equal(classify(401), TOKEN);
  assert.equal(classify(403), TOKEN);
  assert.equal(classify(200), null);
  assert.equal(classify(404), null);
});

test('threshold, then one email per outage', () => {
  const t = new HubOutageTracker(5);
  for (let i = 0; i < 4; i++) assert.equal(t.failure(UNREACHABLE, 'refused', T0 + i * 60e3), null);
  const a = t.failure(UNREACHABLE, 'refused', T0 + 240e3);
  assert.equal(a.phase, 'down');
  assert.equal(a.since, T0);
  for (let i = 0; i < 20; i++) assert.equal(t.failure(UNREACHABLE, 'refused', T0 + 300e3 + i * 60e3), null);
});

test('recovery email only after an emailed outage', () => {
  const t = new HubOutageTracker(5);
  for (let i = 0; i < 3; i++) t.failure(UNREACHABLE, 'x', T0 + i * 60e3);
  assert.equal(t.success(T0 + 200e3), null);
  for (let i = 0; i < 5; i++) t.failure(UNREACHABLE, 'x', T0 + 300e3 + i * 60e3);
  const back = t.success(T0 + 300e3 + 720e3);
  assert.equal(back.phase, 'back');
  assert.equal(back.durationMs, 720e3);
  assert.equal(t.success(T0 + 2e6), null);
});

test('idempotency key: 30-min UTC bucket of the outage start', () => {
  assert.equal(idempotencyKey('down', UNREACHABLE, T0), 'hub-down-unreachable-202610030130');
  assert.equal(
    idempotencyKey('down', UNREACHABLE, Date.UTC(2026, 9, 3, 1, 30, 0)),
    idempotencyKey('down', UNREACHABLE, Date.UTC(2026, 9, 3, 1, 59, 59))
  );
  assert.notEqual(
    idempotencyKey('down', UNREACHABLE, Date.UTC(2026, 9, 3, 1, 59, 59)),
    idempotencyKey('down', UNREACHABLE, Date.UTC(2026, 9, 3, 2, 0, 0))
  );
  assert.equal(idempotencyKey('back', TOKEN, T0), 'hub-back-token-202610030130');
});

test('401 vs unreachable wording', () => {
  const e1 = hubEmail(new HubOutageTracker(1).failure(TOKEN, 'HTTP 401', T0), 'finance-worker', 'http://homelab-dashboard:8095');
  assert.match(e1.subject, /token/);
  assert.match(e1.html, /NOTIFY_INGEST_TOKEN/);
  assert.match(e1.html, /redeploy/);
  const t = new HubOutageTracker(1);
  const e2 = hubEmail(t.failure(UNREACHABLE, 'fetch failed <x>', T0), 'finance-worker', 'http://h');
  assert.match(e2.subject, /unreachable/);
  assert.match(e2.html, /Portainer/);
  assert.match(e2.html, /&lt;x&gt;/);
  assert.equal(hubEmail(t.success(T0 + 12 * 60e3), 'w', 'h').subject, '✅ Homelab dashboard reachable again (down 12m)');
});

test('HubWatch: one down + one back, 409 = deduped, failed send retries same key, never throws', async () => {
  const keys = [];
  const hub = new HubWatch({
    threshold: 2, enabled: true, missing: '', hubUrl: 'h', watcher: 'finance-worker', log: () => {},
    send: async (_s, _h, key) => {
      keys.push(key);
      if (keys.length === 1) throw new Error('resend timeout');
      if (keys.length === 3) throw Object.assign(new Error('Resend 409'), { status: 409 });
    },
  });
  for (let i = 0; i < 6; i++) await hub.failed(UNREACHABLE, 'refused');
  await hub.ok();
  await hub.ok();
  assert.equal(keys.length, 3);
  assert.equal(keys[0], keys[1]);
  assert.match(keys[0], /^hub-down-unreachable-/);
  assert.match(keys[2], /^hub-back-unreachable-/);
});

test('HubWatch: disabled / missing recipient never sends', async () => {
  let calls = 0;
  const send = async () => { calls++; };
  for (const o of [{ enabled: false, missing: '' }, { enabled: true, missing: 'REPORT_EMAIL_TO' }]) {
    const hub = new HubWatch({ threshold: 1, hubUrl: 'h', watcher: 'w', send, log: () => {}, ...o });
    await hub.failed(UNREACHABLE, 'x');
    await hub.failed(UNREACHABLE, 'x');
    await hub.ok();
  }
  assert.equal(calls, 0);
});
