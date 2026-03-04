const https = require('https');

// Rate limiter per IP
const rl = new Map();
function rateOk(ip) {
  const now = Date.now();
  const r = rl.get(ip);
  if (!r || now - r.t > 60000) { rl.set(ip, { t: now, c: 1 }); return true; }
  return ++r.c <= 15;
}
function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
}

// ======= MULTI-KEY ROTATION =======
const keyState = new Map();

function getKeys() {
  const keys = [];
  // Method 1: comma-separated
  if (process.env.API_FOOTBALL_KEYS) {
    process.env.API_FOOTBALL_KEYS.split(',').forEach(k => {
      const t = k.trim();
      if (t) keys.push(t);
    });
  }
  // Method 2: numbered env vars (always check these)
  if (process.env.API_FOOTBALL_KEY) keys.push(process.env.API_FOOTBALL_KEY);
  for (let i = 2; i <= 10; i++) {
    const k = process.env[`API_FOOTBALL_KEY_${i}`];
    if (k) keys.push(k);
  }
  return [...new Set(keys)];
}

function pickKey(keys) {
  const now = Date.now();
  let best = null, bestRem = -1;
  for (const k of keys) {
    const st = keyState.get(k);
    if (!st || now - st.resetAt > 86400000) {
      keyState.set(k, { remaining: 100, resetAt: now, exhausted: false });
      return k;
    }
    if (st.exhausted) continue;
    if (st.remaining > bestRem) { bestRem = st.remaining; best = k; }
  }
  if (!best) {
    for (const k of keys) {
      const st = keyState.get(k);
      if (!st) return k;
      if (st.remaining > bestRem) { bestRem = st.remaining; best = k; }
    }
  }
  return best || keys[0];
}

function updateKeyState(key, headers) {
  const remaining = parseInt(headers['x-ratelimit-requests-remaining']);
  const st = keyState.get(key) || { remaining: 100, resetAt: Date.now(), exhausted: false };
  if (!isNaN(remaining)) {
    st.remaining = remaining;
    st.exhausted = remaining <= 1;
  }
  keyState.set(key, st);
}

function getTotalRemaining(keys) {
  let total = 0;
  for (const k of keys) {
    const st = keyState.get(k);
    total += st ? st.remaining : 100;
  }
  return { remaining: total, limit: keys.length * 100, keys: keys.length };
}

function proxyRequest(hostname, path, headers, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers, timeout }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ json: JSON.parse(data), headers: res.headers, status: res.statusCode }); }
        catch (e) { reject(new Error('Parse error')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!rateOk(getIP(req))) return res.status(429).json({ error: 'Too many requests' });

  const endpoint = req.query.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });

  const allowed = [
    'fixtures', 'fixtures/statistics', 'fixtures/events',
    'fixtures/headtohead', 'teams/statistics', 'odds',
    'odds/live', 'predictions'
  ];
  if (!allowed.some(e => endpoint.startsWith(e)))
    return res.status(403).json({ error: 'Endpoint not allowed' });

  const keys = getKeys();
  if (!keys.length) return res.status(500).json({ error: 'No API keys configured' });

  const params = { ...req.query };
  delete params.endpoint;
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const path = `/${endpoint}${qs ? '?' + qs : ''}`;

  let lastError = null;
  const tried = new Set();

  for (let attempt = 0; attempt < Math.min(keys.length, 3); attempt++) {
    const available = keys.filter(k => !tried.has(k));
    if (!available.length) break;
    const key = pickKey(available);
    if (!key || tried.has(key)) break;
    tried.add(key);

    try {
      const { json, headers, status } = await proxyRequest(
        'v3.football.api-sports.io', path,
        { 'x-apisports-key': key }
      );
      updateKeyState(key, headers);

      // Any API error? (suspended, rate limit, invalid token, etc.) Try next key
      if (status === 429 || (json.errors && Object.keys(json.errors).length > 0)) {
        const st = keyState.get(key);
        if (st) { st.exhausted = true; st.remaining = 0; }
        lastError = JSON.stringify(json.errors);
        continue;
      }

      const totals = getTotalRemaining(keys);
      res.setHeader('x-ratelimit-requests-remaining', String(totals.remaining));
      res.setHeader('x-ratelimit-requests-limit', String(totals.limit));
      res.setHeader('x-ratelimit-keys-count', String(totals.keys));
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
      return res.status(200).json(json);
    } catch (e) {
      lastError = e.message;
      continue;
    }
  }

  res.status(502).json({ error: lastError || 'All API keys exhausted' });
};
