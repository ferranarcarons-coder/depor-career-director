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
        database: dbReady ? 'connected' : (pool ? 'initializing' : 'not_configured')
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
      const cacheKey = 'search:' + q.toLowerCase();
      const cached = await readCached(cacheKey, 86400);
      if (cached) return json(res, 200, {...cached, cached:true}, 'public, max-age=3600');
      const players = await searchPlayers(q);
      const payload = {players, source:'FC Tools Hub'};
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
      const target = url || BASE + '/es/database/fc27/players/' + id + '-' + slug;
      const cacheKey = 'player:' + (id || target);
      const cached = await readCached(cacheKey, 604800);
      if (cached) return json(res, 200, {...cached, cached:true}, 'public, max-age=86400');
      const html = await fetchHtml(target);
      const player = parseDetails(html, {id, slug, url:target, name});
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
