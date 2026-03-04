const https = require('https');

// Rate limiter
const rl = new Map();
function rateOk(ip) {
  const now = Date.now();
  const r = rl.get(ip);
  if (!r || now - r.t > 60000) { rl.set(ip, { t: now, c: 1 }); return true; }
  return ++r.c <= 6; // tighter limit — 500 req/month budget
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

  const API_KEY = process.env.ODDS_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'ODDS_API_KEY not configured' });

  // Allowed sport keys for football/soccer
  const sport = req.query.sport || 'soccer_epl';
  const allowedSports = [
    'soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a',
    'soccer_germany_bundesliga', 'soccer_france_ligue_one',
    'soccer_brazil_campeonato', 'soccer_uefa_champs_league',
    'soccer_uefa_europa_league', 'soccer_portugal_primeira_liga',
    'soccer_netherlands_eredivisie', 'soccer_turkey_super_league',
    'soccer_belgium_first_div', 'soccer_argentina_primera_division',
    'soccer_mexico_ligamx', 'soccer_usa_mls', 'soccer_japan_j_league',
    'soccer_korea_kleague1', 'soccer_china_superleague',
    'soccer_conmebol_copa_libertadores'
  ];

  if (!allowedSports.some(s => sport.startsWith('soccer'))) {
    return res.status(403).json({ error: 'Only soccer sports allowed' });
  }

  // Markets: h2h, totals, or specific like totals_first_half
  const markets = req.query.markets || 'totals';
  const regions = req.query.regions || 'eu,uk';

  const path = `/v4/sports/${encodeURIComponent(sport)}/odds?apiKey=${API_KEY}&regions=${regions}&markets=${encodeURIComponent(markets)}&oddsFormat=decimal`;

  return new Promise((resolve) => {
    const apiReq = https.request({
      hostname: 'api.the-odds-api.com',
      path,
      method: 'GET',
      timeout: 10000
    }, (apiRes) => {
      let data = '';
      apiRes.on('data', c => data += c);
      apiRes.on('end', () => {
        try {
          const json = JSON.parse(data);
          // Forward remaining usage headers
          if (apiRes.headers['x-requests-remaining'])
            res.setHeader('x-odds-remaining', apiRes.headers['x-requests-remaining']);
          if (apiRes.headers['x-requests-used'])
            res.setHeader('x-odds-used', apiRes.headers['x-requests-used']);
          // Cache aggressively — odds don't need second-level freshness for free tier
          res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=120');
          res.status(200).json(json);
        } catch (e) {
          res.status(502).json({ error: 'Odds API parse error' });
        }
        resolve();
      });
    });
    apiReq.on('timeout', () => { apiReq.destroy(); res.status(504).json({ error: 'Odds API timeout' }); resolve(); });
    apiReq.on('error', (e) => { res.status(502).json({ error: e.message }); resolve(); });
    apiReq.end();
  });
};
