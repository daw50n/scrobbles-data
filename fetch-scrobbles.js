// fetch-scrobbles.js — runs in GitHub Actions, writes JSON data files
// Usage: node fetch-scrobbles.js
// Env vars: LFM_USER, LFM_API_KEY

const fs   = require('fs');
const path = require('path');
const https = require('https');

const USER    = process.env.LFM_USER;
const API_KEY = process.env.LFM_API_KEY;
const BASE    = 'https://ws.audioscrobbler.com/2.0/';
const OUT_DIR = path.join(__dirname, 'data');

if (!USER || !API_KEY) {
  console.error('Missing LFM_USER or LFM_API_KEY');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

function lfm(params) {
  const p = new URLSearchParams({ user: USER, api_key: API_KEY, format: 'json', ...params });
  const url = BASE + '?' + p.toString();
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ScrobblesPage/1.0 (+https://techonify.com/scrobbles/)' } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0,200)}`));
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('Bad JSON: ' + body.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

function write(filename, data) {
  const file = path.join(OUT_DIR, filename);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log('Wrote', filename);
}

function fromTs(view) {
  const now = Math.floor(Date.now() / 1000);
  if (view === '7day')  return now - 7 * 86400;
  if (view === 'month') {
    const d = new Date(); d.setDate(1); d.setHours(0,0,0,0);
    return Math.floor(d.getTime() / 1000);
  }
  if (view === 'year') {
    return Math.floor(new Date(new Date().getFullYear(), 0, 1).getTime() / 1000);
  }
  return null;
}

async function main() {
  // ── Recent tracks (page 1, includes now-playing) ──────────────────────────
  console.log('Fetching recent tracks...');
  const recent = await lfm({ method: 'user.getrecenttracks', limit: 50, page: 1 });
  write('recenttracks.json', recent);

  // ── Stats per view ────────────────────────────────────────────────────────
  for (const view of ['7day', 'month', 'year', 'all']) {
    console.log(`Fetching stats: ${view}...`);
    try {
    const fts = fromTs(view);

    // Play count (calendar-accurate via from=)
    const rtParams = { method: 'user.getrecenttracks', limit: 1 };
    if (fts) rtParams.from = fts;
    const rt = await lfm(rtParams);
    const plays = parseInt(rt?.recenttracks?.['@attr']?.total || 0, 10);

    let top_artist = null;
    let artists = 0;

    if (view === '7day') {
      const [ta, wc] = await Promise.all([
        lfm({ method: 'user.gettopartists', limit: 1, period: '7day' }),
        lfm({ method: 'user.getweeklyartistchart' }),
      ]);
      let taList = ta?.topartists?.artist || [];
      if (!Array.isArray(taList)) taList = [taList];
      top_artist = taList[0]?.name || null;
      const wcList = wc?.weeklyartistchart?.artist || [];
      artists = Array.isArray(wcList) ? wcList.length : 0;

    } else if (view === 'all') {
      const ta = await lfm({ method: 'user.gettopartists', limit: 1, period: 'overall' });
      let taList = ta?.topartists?.artist || [];
      if (!Array.isArray(taList)) taList = [taList];
      top_artist = taList[0]?.name || null;
      artists = parseInt(ta?.topartists?.['@attr']?.total || 0, 10);

    } else {
      // month / year: use period param (rolling, fast)
      const period = view === 'year' ? '12month' : '1month';
      const ta = await lfm({ method: 'user.gettopartists', limit: 1, period });
      let taList = ta?.topartists?.artist || [];
      if (!Array.isArray(taList)) taList = [taList];
      top_artist = taList[0]?.name || null;
      artists = parseInt(ta?.topartists?.['@attr']?.total || 0, 10);
    }

    write(`stats-${view}.json`, {
      plays,
      artists,
      top_artist,
      generated: new Date().toISOString(),
    });
    } catch (err) {
      console.warn(`Warning: skipping stats-${view}.json — ${err.message}`);
    }
  }

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
