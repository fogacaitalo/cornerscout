const https = require('https');

// Rate limiter (shared across functions via module scope)
const rl = new Map();
function rateOk(ip) {
  const now = Date.now();
  const r = rl.get(ip);
  if (!r || now - r.t > 60000) { rl.set(ip, { t: now, c: 1 }); return true; }
  return ++r.c <= 12;
}
function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
}

function proxyRequest(hostname, path, headers, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers, timeout }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ json: JSON.parse(data), headers: res.headers }); }
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

  const API_KEY = process.env.API_FOOTBALL_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'API_FOOTBALL_KEY not configured' });

  const params = { ...req.query };
  delete params.endpoint;
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const path = `/${endpoint}${qs ? '?' + qs : ''}`;

  try {
    const { json, headers } = await proxyRequest(
      'v3.football.api-sports.io', path,
      { 'x-apisports-key': API_KEY }
    );
    ['x-ratelimit-requests-limit', 'x-ratelimit-requests-remaining'].forEach(h => {
      if (headers[h]) res.setHeader(h, headers[h]);
    });
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    res.status(200).json(json);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
