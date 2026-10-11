import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 10000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const BASE = 'https://fctoolshub.com';
const FC27_DATASET_URL = 'https://raw.githubusercontent.com/LakshmiKanth11/EA_FC_ANALYSIS/main/EA_FC_PLAYERS_DATASET_AND_%20DASHBOARD/data/players_search.json';
const FC27_SNAPSHOT_DATE = '2026-09-12';
let fc27Players = null;

const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
}) : null;

let dbReady = false;

async function initDb() {
  if (!pool) return false;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS career_state (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS player_cache (
      cache_key TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS fc27_dataset (
      id TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      player_count INTEGER NOT NULL DEFAULT 0,
      snapshot_date DATE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  dbReady = true;
  return true;
}

async function readCached(key, maxAgeSeconds) {
  if (!dbReady) return null;
  const r = await pool.query(
    'SELECT payload, updated_at FROM player_cache WHERE cache_key = $1',
    [key]
  );
  if (!r.rowCount) return null;
  const age = (Date.now() - new Date(r.rows[0].updated_at).getTime()) / 1000;
  return age <= maxAgeSeconds ? r.rows[0].payload : null;
}

async function writeCache(key, payload) {
  if (!dbReady) return;
  await pool.query(
    `INSERT INTO player_cache(cache_key,payload,updated_at)
     VALUES($1,$2::jsonb,NOW())
     ON CONFLICT(cache_key) DO UPDATE SET payload=EXCLUDED.payload, updated_at=NOW()`,
    [key, JSON.stringify(payload)]
  );
}

async function readBody(req) {
  return await new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(new Error('Payload massa gran'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('JSON no vàlid')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, body, cache='no-store') {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cache,
    'access-control-allow-origin': '*'
  });
  res.end(JSON.stringify(body));
}

function clean(text='') {
  return String(text)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchHtml(url) {
  const r = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; DeporCareerDirector/1.0)',
      'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    redirect: 'follow'
  });
  if (!r.ok) throw new Error('FC Tools Hub returned ' + r.status);
  return await r.text();
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter(x => {
    const k = keyFn(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function scoreMatch(name, q) {
  const n = String(name || '').toLowerCase();
  const s = String(q || '').toLowerCase().trim();
  if (!n || !s) return 0;
  if (n === s) return 100;
  if (n.startsWith(s)) return 85;
  if (n.includes(s)) return 70;
  return s.split(/\s+/).filter(Boolean).reduce((a,p)=>a+(n.includes(p)?10:0),0);
}

function parseSearchResults(html, q) {
  const out = [];
  const re = /<a[^>]+href=["']([^"']*\/database\/fc27\/players\/(\d+)-([^"'#?]+))[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1].startsWith('http') ? m[1] : BASE + m[1];
    const id = m[2];
    const slug = m[3];
    let name = clean(m[4]);
    if (!name || name.length > 90) {
      name = slug.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
    }
    out.push({ id, slug, name, url: href, score: scoreMatch(name, q) });
  }
  return uniqBy(out, x=>x.id).sort((a,b)=>b.score-a.score).slice(0,12);
}

function pickNumber(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return Number(String(m[1]).replace(',', '.'));
  }
  return null;
}

function pickText(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return clean(m[1]);
  }
  return '';
}

function moneyToNumber(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/\s/g,'').replace(/€/g,'').replace(/,/g,'.').toUpperCase();
  const m = s.match(/([\d.]+)([KMB])?/);
  if (!m) return null;
  const mult = m[2] === 'B' ? 1e9 : m[2] === 'M' ? 1e6 : m[2] === 'K' ? 1e3 : 1;
  return Number(m[1]) * mult;
}

function parseDetails(html, fallback={}) {
  const text = clean(html);
  const title = (html.match(/<title>([^<]+)<\/title>/i)||[])[1] || '';
  const name =
    pickText(text, [/(?:Player|Jugador)\s*[:\-]?\s*([A-Za-zÀ-ÿ' .-]{3,60})\s+(?:FC|EA|OVR|Overall|Edad|Age)/i]) ||
    clean(title.split('|')[0]).replace(/EA SPORTS FC 27/ig,'').replace(/FC 27/ig,'').trim() ||
    fallback.name || '';

  const overall = pickNumber(text, [/(?:OVR|Overall|Valoración)\s*[:\-]?\s*(\d{2})/i, /\b(\d{2})\s*OVR\b/i]);
  const potential = pickNumber(text, [/(?:POT|Potential|Potencial)\s*[:\-]?\s*(\d{2})/i]);
  const age = pickNumber(text, [/(?:Age|Edad)\s*[:\-]?\s*(\d{1,2})/i]);
  const position = pickText(text, [/(?:Position|Posición)\s*[:\-]?\s*([A-Z]{2,3}(?:\s*[,\/\-]\s*[A-Z]{2,3})*)/i]);
  const club = pickText(text, [/(?:Club|Equipo)\s*[:\-]?\s*([^|•]{2,60}?)(?=\s+(?:League|Liga|Position|Posición|Value|Valor|Wage|Salario|Contract|Contrato)\b)/i]);
  const nationality = pickText(text, [/(?:Nationality|Nacionalidad)\s*[:\-]?\s*([^|•]{2,45}?)(?=\s+(?:Club|Equipo|League|Liga|Age|Edad)\b)/i]);
  const contract = pickText(text, [/(?:Contract|Contrato)\s*[:\-]?\s*([^|•]{3,45}?)(?=\s+(?:Value|Valor|Wage|Salario|Overall|OVR|Potential|POT)\b|$)/i]);
  const valueRaw = pickText(text, [/(?:Value|Valor)\s*[:\-]?\s*(€?\s*[\d.,]+\s*[KMB]?)/i]);
  const wageRaw = pickText(text, [/(?:Wage|Salario)\s*[:\-]?\s*(€?\s*[\d.,]+\s*[KMB]?)/i]);

  return {
    id: fallback.id || '',
    slug: fallback.slug || '',
    url: fallback.url || '',
    name,
    overall,
    potential,
    age,
    position,
    club,
    nationality,
    contract,
    value: moneyToNumber(valueRaw),
    wage: moneyToNumber(wageRaw),
    source: 'FC Tools Hub'
  };
}

async function ensureFc27Dataset() {
  if (fc27Players?.length) return fc27Players;

  if (dbReady) {
    const stored = await pool.query('SELECT payload FROM fc27_dataset WHERE id = $1', ['ea-fc27']);
    if (stored.rowCount && Array.isArray(stored.rows[0].payload) && stored.rows[0].payload.length) {
      fc27Players = stored.rows[0].payload;
      console.log('FC27 dataset loaded from Postgres:', fc27Players.length);
      return fc27Players;
    }
  }

  console.log('Downloading FC27 dataset...');
  const r = await fetch(FC27_DATASET_URL, {
    headers: {
      'user-agent': 'DeporCareerDirector/1.0',
      'accept': 'application/json'
    },
    redirect: 'follow'
  });
  if (!r.ok) throw new Error('FC27 dataset download failed: ' + r.status);
  const players = await r.json();
  if (!Array.isArray(players) || !players.length) throw new Error('FC27 dataset is empty or invalid');

  fc27Players = players;

  if (dbReady) {
    await pool.query(
      `INSERT INTO fc27_dataset(id,payload,player_count,snapshot_date,updated_at)
       VALUES($1,$2::jsonb,$3,$4,NOW())
       ON CONFLICT(id) DO UPDATE SET
         payload=EXCLUDED.payload,
         player_count=EXCLUDED.player_count,
         snapshot_date=EXCLUDED.snapshot_date,
         updated_at=NOW()`,
      ['ea-fc27', JSON.stringify(players), players.length, FC27_SNAPSHOT_DATE]
    );
    console.log('FC27 dataset saved to Postgres:', players.length);
  }
  return players;
}

function playerDisplayName(p) {
  return String(p?.name || '').trim();
}

function fc27SearchScore(p, q) {
  const name = playerDisplayName(p).toLowerCase();
  const club = String(p?.club || '').toLowerCase();
  const nat = String(p?.nat || '').toLowerCase();
  const term = q.toLowerCase().trim();
  if (!term) return 0;
  if (name === term) return 1000;
  if (name.startsWith(term)) return 800;
  if (name.includes(term)) return 600;
  const parts = term.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const part of parts) {
    if (name.includes(part)) score += 120;
    if (club.includes(part)) score += 20;
    if (nat.includes(part)) score += 10;
  }
  return score;
}

async function searchFc27Players(q) {
  const players = await ensureFc27Dataset();
  return players
    .filter(p => p.gender !== 'Women')
    .map(p => ({ p, score: fc27SearchScore(p, q) }))
    .filter(x => x.score > 0)
    .sort((a,b) => (b.score - a.score) || (Number(b.p.ovr||0) - Number(a.p.ovr||0)))
    .slice(0, 12)
    .map(({p}) => ({
      id: String(p.id),
      slug: String(p.id),
      name: p.name,
      overall: Number(p.ovr || 0) || null,
      position: p.pos || '',
      club: p.club || '',
      league: p.league || '',
      nationality: p.nat || '',
      foot: p.foot || '',
      gender: p.gender || 'Men',
      playstyles: p.ps || '',
      source: 'EA FC27 dataset'
    }));
}

async function getFc27Player(id) {
  const players = await ensureFc27Dataset();
  const p = players.find(x => String(x.id) === String(id));
  if (!p) return null;
  return {
    id: String(p.id),
    name: p.name || '',
    overall: Number(p.ovr || 0) || null,
    potential: null,
    age: null,
    position: p.pos || '',
    alternatePositions: '',
    club: p.club || '',
    league: p.league || '',
    nationality: p.nat || '',
    preferredFoot: p.foot || '',
    skillMoves: Number(p.sm || 0) || null,
    weakFoot: Number(p.wf || 0) || null,
    playstyles: p.ps || '',
    pace: Number(p.pac || 0) || null,
    shooting: Number(p.sho || 0) || null,
    passing: Number(p.pas || 0) || null,
    dribbling: Number(p.dri || 0) || null,
    defending: Number(p.def || 0) || null,
    physicality: Number(p.phy || 0) || null,
    value: null,
    wage: null,
    contract: '',
    snapshotDate: FC27_SNAPSHOT_DATE,
    source: 'EA public ratings dataset'
  };
}

async function searchPlayers(q) {
  const query = encodeURIComponent(q.trim());
  const candidates = [
    BASE + '/es/database/fc27/players?search=' + query,
    BASE + '/es/database/fc27/players?name=' + query,
    BASE + '/es/database/fc27/players?query=' + query,
    BASE + '/es/database/fc27/players?filter_name=' + query
  ];
  let lastError;
  for (const url of candidates) {
    try {
      const html = await fetchHtml(url);
      const results = parseSearchResults(html, q);
      if (results.length) return results;
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError) throw lastError;
  return [];
}

function serveIndex(res) {
  fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err, data) => {
    if (err) return json(res, 500, {error:'No s’ha pogut carregar la interfície.'});
    res.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'no-cache'});
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');

    if (u.pathname === '/health') {
      return json(res, 200, {
        ok:true,
        service:'depor-career-director',
        database: dbReady ? 'connected' : (pool ? 'initializing' : 'not_configured'),
        fc27Dataset: fc27Players?.length || 0
      });
    }

    if (u.pathname === '/api/state' && req.method === 'GET') {
      if (!dbReady) return json(res, 503, {error:'Base de dades no configurada.'});
      const r = await pool.query('SELECT data, updated_at FROM career_state WHERE id = $1', ['main']);
      if (!r.rowCount) return json(res, 200, {state:null});
      return json(res, 200, {state:r.rows[0].data, updatedAt:r.rows[0].updated_at}, 'no-store');
    }

    if (u.pathname === '/api/state' && req.method === 'POST') {
      if (!dbReady) return json(res, 503, {error:'Base de dades no configurada.'});
      const body = await readBody(req);
      if (!body || typeof body.state !== 'object') return json(res, 400, {error:'Estat no vàlid.'});
      await pool.query(
        `INSERT INTO career_state(id,data,updated_at)
         VALUES($1,$2::jsonb,NOW())
         ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`,
        ['main', JSON.stringify(body.state)]
      );
      return json(res, 200, {ok:true});
    }

    if (u.pathname === '/api/players/search') {
      const q = String(u.searchParams.get('q') || '').trim();
      if (q.length < 2) return json(res, 400, {error:'Escriu almenys 2 caràcters.'});
      const cacheKey = 'fc27-search:' + q.toLowerCase();
      const cached = await readCached(cacheKey, 86400);
      if (cached) return json(res, 200, {...cached, cached:true}, 'public, max-age=3600');
      const players = await searchFc27Players(q);
      const payload = {players, source:'EA FC27 dataset', snapshotDate:FC27_SNAPSHOT_DATE};
      await writeCache(cacheKey, payload);
      return json(res, 200, payload, 'public, max-age=3600');
    }

    if (u.pathname === '/api/players/detail') {
      const id = String(u.searchParams.get('id') || '');
      const slug = String(u.searchParams.get('slug') || '');
      const url = String(u.searchParams.get('url') || '');
      const name = String(u.searchParams.get('name') || '');
      if (!url && (!id || !slug)) {
        return json(res, 400, {error:'Falta la referència del jugador.'});
      }
      const cacheKey = 'fc27-player:' + id;
      const cached = await readCached(cacheKey, 604800);
      if (cached) return json(res, 200, {...cached, cached:true}, 'public, max-age=86400');
      const player = await getFc27Player(id);
      if (!player) return json(res, 404, {error:'Jugador no trobat a la base FC27.'});
      const payload = {player};
      await writeCache(cacheKey, payload);
      return json(res, 200, payload, 'public, max-age=86400');
    }

    return serveIndex(res);
  } catch (e) {
    return json(res, 502, {
      error:'No s’ha pogut completar la consulta.',
      detail:e.message
    });
  }
});

initDb()
  .then(ok => console.log(ok ? 'Postgres connected' : 'Postgres not configured'))
  .catch(err => console.error('Postgres init failed:', err.message))
  .finally(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log('Dépor Career Director listening on ' + PORT);
    });
  });
