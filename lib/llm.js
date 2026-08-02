// Shared local-LLM client — oMLX (https://github.com/jundot/omlx).
//
// Replaced Ollama (2026-07-29). oMLX is OpenAI-compatible, NOT Ollama-compatible,
// so this is the one place that knows the wire format:
//   Ollama  POST /api/generate  { prompt, format:"json", images:[b64] } → { response }
//   oMLX    POST /v1/chat/completions { messages, response_format, image_url }
//                                     → { choices:[{ message:{ content } }] }
// Both callers (the "Ask" NL→SQL endpoint in server.js and receipt extraction in
// temporal/activities.js) go through here so the translation lives once.
//
// Differences that have no request-level equivalent in oMLX and are simply gone:
//   - keep_alive → per-model TTL, set in the oMLX admin panel
//   - num_ctx    → server-side (settings.json sampling.max_context_window)

// oMLX runs on the Mac mini that used to host Ollama — same LAN IP, new port
// (11434 → 8000) and an /v1 base path. It must bind 0.0.0.0 (settings.json
// server.host) or nothing off-box can reach it; loopback is the default.
const DEFAULT_BASE_URL = 'http://192.168.50.141:8000/v1';

// Accept whatever shape the env var holds and return a clean `.../v1` base:
// a legacy Ollama full endpoint, a bare host:port, or an already-correct base.
// Legacy values still carry Ollama's port, which oMLX does not serve — warn
// rather than silently failing with a connection error later.
function normalizeBaseUrl(raw) {
  let url = String(raw || '').trim().replace(/\/+$/, '');
  if (!url) return DEFAULT_BASE_URL;

  if (/\/api\/(generate|chat|tags)$/.test(url)) {
    url = url.replace(/\/api\/(generate|chat|tags)$/, '');
    console.warn(
      `[llm] "${raw}" looks like a legacy Ollama endpoint. oMLX serves ` +
      `/v1/chat/completions on port 8000 — update the LLM_BASE_URL variable.`
    );
  }
  if (/:11434(\/|$)/.test(url)) {
    console.warn(`[llm] "${raw}" uses Ollama's port 11434; oMLX defaults to 8000.`);
  }
  return /\/v\d+$/.test(url) ? url : `${url}/v1`;
}

// First non-empty wins, so a new var can shadow the legacy one it replaced.
function pickBaseUrl(...candidates) {
  const found = candidates.find(v => String(v || '').trim());
  return normalizeBaseUrl(found || DEFAULT_BASE_URL);
}

// oMLX requires an API key by default (Ollama had no auth at all). Sent as a
// Bearer token; skipped when unset so a keyless dev instance still works.
function authHeaders(apiKey) {
  const key = String(apiKey || '').trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

// Base64 image → data URI. Ollama took bare base64 and sniffed the type itself;
// the OpenAI image_url form needs an explicit mime, so sniff the magic bytes.
function dataUri(b64) {
  const s = String(b64 || '');
  if (s.startsWith('data:')) return s;                 // already a data URI
  const mime =
    s.startsWith('iVBORw0KGgo') ? 'image/png'  :
    s.startsWith('R0lGOD')      ? 'image/gif'  :
    s.startsWith('UklGR')       ? 'image/webp' :
    'image/jpeg';                                       // /9j/ and anything else
  return `data:${mime};base64,${s}`;
}

// One /v1/chat/completions call. Returns the assistant's raw text content.
// Throws on timeout / non-2xx / network error so callers keep their own
// retry-and-degrade behaviour.
async function chat({
  baseUrl,
  apiKey,
  model,
  prompt,
  images,
  json = false,
  temperature = 0,
  maxTokens,
  timeoutMs = 30000,
}) {
  // A vision request puts the text and each image in one multi-part content
  // array; text-only stays a plain string.
  const content = (images && images.length)
    ? [
        { type: 'text', text: prompt },
        ...images.map(img => ({ type: 'image_url', image_url: { url: dataUri(img) } })),
      ]
    : prompt;

  const body = {
    model,
    messages: [{ role: 'user', content }],
    stream: false,
    temperature,
  };
  if (json) body.response_format = { type: 'json_object' };
  if (maxTokens) body.max_tokens = maxTokens;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`oMLX ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

// Same as chat(), coerced to a JSON object. Keeps the salvage path: json_object
// mode holds when the prompt names its keys, but small models still occasionally
// wrap output in prose or ``` fences.
async function chatJson(opts) {
  const raw = await chat({ ...opts, json: true });
  try { return JSON.parse(raw); }
  catch (_) {
    const fenced = raw.match(/```[a-zA-Z0-9]*\s*\n([\s\S]*?)```/);
    if (fenced) { try { return JSON.parse(fenced[1]); } catch (_) {} }
    const braced = raw.match(/\{[\s\S]*\}/);
    if (braced) { try { return JSON.parse(braced[0]); } catch (_) {} }
    throw new Error('LLM response was not valid JSON');
  }
}

module.exports = { chat, chatJson, pickBaseUrl, normalizeBaseUrl, DEFAULT_BASE_URL };
