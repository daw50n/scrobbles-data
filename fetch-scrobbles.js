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

// ── Scrobble history helpers ─────────────────────────────────────────────────

function loadHistory() {
  const file = path.join(OUT_DIR, 'scrobbles.json');
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return [];
  }
}

function saveHistory(scrobbles) {
  write('scrobbles.json', scrobbles);
}

// Fetch all pages from Last.fm starting at `fromTs` (unix seconds, optional)
async function fetchScrobblesSince(fromTs) {
  const all = [];
  let page = 1;
  while (true) {
    const params = { method: 'user.getrecenttracks', limit: 200, page };
    if (fromTs) params.from = fromTs;
    const res = await lfm(params);
    const tracks = res?.recenttracks?.track ?? [];
    const trackArr = Array.isArray(tracks) ? tracks : [tracks];
    const filtered = trackArr
      .filter(t => !t['@attr']?.nowplaying && t.date?.uts)
      .map(t => ({
        ts:     parseInt(t.date.uts, 10),
        track:  t.name,
        artist: t.artist?.['#text'] || t.artist?.name || '',
        album:  t.album?.['#text'] || '',
      }));
    all.push(...filtered);
    const totalPages = parseInt(res?.recenttracks?.['@attr']?.totalPages ?? 1, 10);
    console.log(`  page ${page}/${totalPages} (${filtered.length} tracks)`);
    if (page >= totalPages) break;
    page++;
  }
  return all;
}

// ── Stats computed from local scrobble history ───────────────────────────────

function tsFrom(view) {
  const now = Math.floor(Date.now() / 1000);
  if (view === '7day')  return now - 7 * 86400;
  if (view === 'month') {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }
  if (view === 'year') {
    return Math.floor(new Date(new Date().getFullYear(), 0, 1).getTime() / 1000);
  }
  return null; // all time
}

function computeStats(scrobbles, view) {
  const from = tsFrom(view);
  const subset = from ? scrobbles.filter(s => s.ts >= from) : scrobbles;

  const plays = subset.length;

  // Count by artist
  const artistCounts = {};
  for (const s of subset) {
    artistCounts[s.artist] = (artistCounts[s.artist] || 0) + 1;
  }
  const artists = Object.keys(artistCounts).length;
  const top_artist = artists > 0
    ? Object.entries(artistCounts).sort((a, b) => b[1] - a[1])[0][0]
    : null;

  // Count by track+artist
  const trackCounts = {};
  for (const s of subset) {
    const key = `${s.track}|||${s.artist}`;
    trackCounts[key] = (trackCounts[key] || 0) + 1;
  }
  const topTrackKey = Object.keys(trackCounts).length > 0
    ? Object.entries(trackCounts).sort((a, b) => b[1] - a[1])[0][0]
    : null;
  const top_track = topTrackKey
    ? topTrackKey.replace('|||', ' – ')
    : null;

  return { plays, artists, top_artist, top_track, generated: new Date().toISOString() };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Load existing history and work out what to fetch
  const history = loadHistory();
  const lastTs = history.length > 0 ? Math.max(...history.map(s => s.ts)) : null;

  if (lastTs) {
    console.log(`History has ${history.length} scrobbles. Fetching new ones since ${new Date(lastTs * 1000).toISOString()}...`);
  } else {
    console.log('No history found. Fetching full scrobble history...');
  }

  // Fetch from 1 second after the last known scrobble (or everything)
  const newScrobbles = await fetchScrobblesSince(lastTs ? lastTs + 1 : null);
  console.log(`Fetched ${newScrobbles.length} new scrobbles.`);

  // Merge, deduplicate by ts, sort oldest-first
  const merged = [...history, ...newScrobbles];
  const seen = new Set();
  const deduped = merged.filter(s => {
    if (seen.has(s.ts)) return false;
    seen.add(s.ts);
    return true;
  });
  deduped.sort((a, b) => a.ts - b.ts);

  saveHistory(deduped);
  console.log(`Total scrobbles stored: ${deduped.length}`);

  // 2. Recent tracks feed (latest 200 for the page) — fetch from API to get image URLs
  console.log('Fetching recenttracks from API for album art...');
  let recentFeed = [];
  try {
    const res = await lfm({ method: 'user.getrecenttracks', limit: 200, page: 1 });
    const tracks = res?.recenttracks?.track ?? [];
    recentFeed = (Array.isArray(tracks) ? tracks : [tracks])
      .filter(t => !t['@attr']?.nowplaying);
  } catch (e) {
    console.warn('Could not fetch recenttracks from API, falling back to history:', e.message);
    recentFeed = deduped.slice(-200).reverse().map(s => ({
      name: s.track,
      artist: { '#text': s.artist },
      album:  { '#text': s.album },
      date:   { uts: String(s.ts), '#text': new Date(s.ts * 1000).toUTCString() },
      image:  [],
    }));
  }
  write('recenttracks.json', {
    recenttracks: {
      track: recentFeed,
      '@attr': { total: String(deduped.length) },
    }
  });

  // 3. 7-day history for Mastodon weekly wrap
  console.log('Writing recenttracks-7day.json from history...');
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
  const week = deduped
    .filter(s => s.ts >= sevenDaysAgo)
    .map(s => ({
      name: s.track,
      artist: { '#text': s.artist },
      album:  { '#text': s.album },
      date:   { uts: String(s.ts), '#text': new Date(s.ts * 1000).toUTCString() },
    }));
  write('recenttracks-7day.json', { tracks: week, generated: new Date().toISOString() });

  // 4. Stats for each view — computed locally, no API calls needed
  for (const view of ['7day', 'month', 'year', 'all']) {
    const stats = computeStats(deduped, view);
    write(`stats-${view}.json`, stats);
    console.log(`  ${view}: ${stats.plays} plays, top artist: ${stats.top_artist}, top track: ${stats.top_track}`);
  }

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
