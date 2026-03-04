const https = require('https');

// Rate limiter — football-data.org allows 10 req/min on free tier
const rl = new Map();
function rateOk(ip) {
  const now = Date.now();
  const r = rl.get(ip);
  if (!r || now - r.t > 60000) { rl.set(ip, { t: now, c: 1 }); return true; }
  return ++r.c <= 6;
}
function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!rateOk(getIP(req))) return res.status(429).json({ error: 'Too many requests' });

  const API_KEY = process.env.FOOTBALL_DATA_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'FOOTBALL_DATA_KEY not configured' });

  const endpoint = req.query.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });

  // Whitelist: only allow specific safe endpoints
  const allowed = ['matches', 'teams', 'competitions', 'persons'];
  const base = endpoint.split('/')[0];
  if (!allowed.includes(base))
    return res.status(403).json({ error: 'Endpoint not allowed' });

  // Build query params
  const params = { ...req.query };
  delete params.endpoint;
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const path = `/v4/${endpoint}${qs ? '?' + qs : ''}`;

  return new Promise((resolve) => {
    const apiReq = https.request({
      hostname: 'api.football-data.org',
      path,
      method: 'GET',
      headers: { 'X-Auth-Token': API_KEY },
      timeout: 10000
    }, (apiRes) => {
      let data = '';
      apiRes.on('data', c => data += c);
      apiRes.on('end', () => {
        try {
          const json = JSON.parse(data);
          // Cache historical data longer — it doesn't change
          res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
          res.status(200).json(json);
        } catch (e) {
          res.status(502).json({ error: 'Football-Data parse error' });
        }
        resolve();
      });
    });
    apiReq.on('timeout', () => { apiReq.destroy(); res.status(504).json({ error: 'Football-Data timeout' }); resolve(); });
    apiReq.on('error', (e) => { res.status(502).json({ error: e.message }); resolve(); });
    apiReq.end();
  });
};
