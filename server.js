import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import crypto from 'node:crypto';
import { parse as parseCsv } from 'csv-parse/sync';
const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 10000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const BASE = 'https://fctoolshub.com';
const FC27_DATASET_URL = 'https://raw.githubusercontent.com/LakshmiKanth11/EA_FC_ANALYSIS/main/EA_FC_PLAYERS_DATASET_AND_%20DASHBOARD/data/players_search.json';
const FC27_SNAPSHOT_DATE = '2026-09-12';
const CLUB_CONFIG = {
  id:'barcelona',
  name:'FC Barcelona',
  shortName:'Barça',
  datasetClub:'FC Barcelona',
  initialBudget:150.4,
  budgetSource:'FC 27 update 4 · 7 Oct 2026',
  clubStatus:9.2,
  target:'Guanyar LaLiga',
  projectStage:'Fase 1 · Competir per tots els títols'
};
const FC27_CSV_URL = 'https://raw.githubusercontent.com/LakshmiKanth11/EA_FC_ANALYSIS/main/EA_FC_PLAYERS_DATASET_AND_%20DASHBOARD/data/players.csv';
let fc27Players = null;
let fc27FullById = null;

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
    CREATE TABLE IF NOT EXISTS career_state_history (
      version_id BIGSERIAL PRIMARY KEY,
      state_id TEXT NOT NULL,
      data JSONB NOT NULL,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS squad_players (
      player_id TEXT PRIMARY KEY,
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
  // One-time migration: recover any legacy squad still present inside career_state.
  const squadCount = await pool.query('SELECT COUNT(*)::int AS n FROM squad_players');
  if (Number(squadCount.rows[0]?.n || 0) === 0) {
    const legacy = await pool.query("SELECT data->'squad' AS squad FROM career_state WHERE id=$1", ['main']);
    const players = Array.isArray(legacy.rows[0]?.squad) ? legacy.rows[0].squad : [];
    for (const raw of players) {
      const player = {...raw, playerId: raw.playerId || crypto.randomUUID()};
      await pool.query(
        `INSERT INTO squad_players(player_id,data,updated_at)
         VALUES($1,$2::jsonb,NOW())
         ON CONFLICT(player_id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`,
        [player.playerId, JSON.stringify(player)]
      );
    }
  }
  // 2026/27 finance baseline: EA already shows the spendable transfer budget.
  const financeState = await pool.query('SELECT data FROM career_state WHERE id=$1', ['main']);
  if (financeState.rowCount) {
    const data = financeState.rows[0].data || {};
    const finance = {...(data.finance || {})};
    if (finance.budgetBaselineSeason !== '2026/27') {
      finance.initialBudget = 11.304769;
      finance.budgetSource = CLUB_CONFIG.budgetSource;
      finance.budgetBaselineSeason = '2026/27';
      data.finance = finance;
      await pool.query(
        'UPDATE career_state SET data=$2::jsonb, updated_at=NOW() WHERE id=$1',
        ['main', JSON.stringify(data)]
      );
    }
  }
  try {
    const squadDiag = await pool.query('SELECT data FROM squad_players');
    const stateDiag = await pool.query('SELECT data FROM career_state WHERE id=$1',['main']);
    const squadRows = squadDiag.rows.map(r=>r.data||{});
    const wageSum = squadRows.reduce((a,p)=>a+Number(p.wage||0),0);
    const wageNonZero = squadRows.filter(p=>Number(p.wage||0)>0).length;
    const st = stateDiag.rows[0]?.data || {};
    const fin = st.finance || {};
    console.log('[FINANCE_DIAG]', JSON.stringify({
      squadCount:squadRows.length,
      wageNonZero,
      wageSum,
      sampleWages:squadRows.slice(0,5).map(p=>({name:p.name,wage:p.wage,ownership:p.ownership,wageShareDepor:p.wageShareDepor})),
      transferCount:Array.isArray(st.transfers)?st.transfers.length:0,
      finance:fin
    }));
  } catch (e) {
    console.log('[FINANCE_DIAG_ERROR]', e.message);
  }
  // One-time club switch: archive the Dépor career and start a clean Barça 2026/27 save.
  try {
    const currentClub = await pool.query('SELECT data FROM career_state WHERE id=$1',['main']);
    const existing = currentClub.rows[0]?.data || {};
    if (existing.clubId !== CLUB_CONFIG.id) {
      if (currentClub.rowCount) {
        await pool.query(
          'INSERT INTO career_state_history(state_id,data,saved_at) VALUES($1,$2::jsonb,NOW())',
          ['main', JSON.stringify(existing)]
        );
      }
      const cleanState = {
        clubId: CLUB_CONFIG.id,
        clubName: CLUB_CONFIG.name,
        season:'2026/27',
        position:'—',
        target:CLUB_CONFIG.target,
        clubStatus:CLUB_CONFIG.clubStatus,
        projectStage:CLUB_CONFIG.projectStage,
        tactic:'4-3-3',
        lineup:{starters:{},bench:[]},
        points:0,
        matches:[],
        nextMatch:{opponent:'',competition:'',date:'',venue:'Casa'},
        standings:[],
        decisions:[],
        reviews:[],
        setup:{squad:true,finances:true,board:false,hierarchy:false,needs:false,rules:true},
        shortlist:[],
        latestAssessment:null,
        finance:{
          initialBudget:CLUB_CONFIG.initialBudget,
          initialWageByPlayer:{},
          baselineLocked:false,
          budgetSource:CLUB_CONFIG.budgetSource,
          budgetBaselineSeason:'2026/27'
        },
        transfers:[],
        youth:[],
        history:[],
        directorChat:[],
        _clientUpdatedAt:Date.now()
      };
      await pool.query('BEGIN');
      try {
        await pool.query(
          `INSERT INTO career_state(id,data,updated_at)
           VALUES($1,$2::jsonb,NOW())
           ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()`,
          ['main',JSON.stringify(cleanState)]
        );
        await pool.query('DELETE FROM squad_players');
        await pool.query('COMMIT');
      } catch (e) {
        await pool.query('ROLLBACK');
        throw e;
      }

      // Bootstrap the current Barça squad from the FC27 dataset.
      try {
        const players = await ensureFc27Dataset();
        const fullMap = await ensureFc27FullDataset();
        const barca = players.filter(p => p.gender !== 'Women' && String(p.club||'').toLowerCase() === CLUB_CONFIG.datasetClub.toLowerCase());
        for (const raw of barca) {
          const full = fullMap.get(String(raw.id)) || {};
          const ovr = Number(raw.ovr||0) || 0;
          const player = {
            playerId:'fc27-'+String(raw.id),
            fc27Id:String(raw.id),
            fc27Matched:true,
            name:raw.name||'Jugador',
            pos:raw.pos||'',
            age:ageFromBirthdate(full.birthdate),
            role:ovr>=84?'Clave':ovr>=80?'Importante':ovr>=76?'Rotación':'Promesa',
            ownership:'Propietat',
            parentClub:'',
            destinationClub:'',
            wage:0,
            wageShareDepor:100,
            wageShareManual:false,
            contractYears:0,
            loanYears:0,
            purchaseOptionType:'Sense opció',
            purchaseOptionValue:0,
            baseOvr:ovr,
            currentOvr:ovr,
            value:0,
            minutes:0,
            goals:0,
            assists:0,
            nationality:raw.nat||'',
            realClub:raw.club||CLUB_CONFIG.name,
            realLeague:raw.league||'',
            preferredFoot:raw.foot||'',
            alternatePositions:full.alternate_positions||'',
            birthdate:full.birthdate||'',
            ovrUpdatedAt:''
          };
          await pool.query(
            `INSERT INTO squad_players(player_id,data,updated_at)
             VALUES($1,$2::jsonb,NOW())
             ON CONFLICT(player_id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()`,
            [player.playerId,JSON.stringify(player)]
          );
        }
        console.log('[CLUB_SWITCH] Barça career initialized with', barca.length, 'FC27 players');
      } catch (e) {
        console.warn('[CLUB_SWITCH] Barça squad bootstrap failed:', e.message);
      }
    }
  } catch (e) {
    console.warn('[CLUB_SWITCH] Migration skipped:', e.message);
  }

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

async function ensureFc27FullDataset() {
  if (fc27FullById) return fc27FullById;
  try {
    const r = await fetch(FC27_CSV_URL, {
      headers: {'user-agent':'DeporCareerDirector/1.0','accept':'text/csv,*/*'},
      redirect:'follow'
    });
    if (!r.ok) throw new Error('FC27 CSV download failed: ' + r.status);
    const csv = await r.text();
    const rows = parseCsv(csv, { columns:true, skip_empty_lines:true, relax_quotes:true });
    fc27FullById = new Map(rows.map(x => [String(x.player_id), x]));
    console.log('FC27 full dataset loaded:', fc27FullById.size);
  } catch (e) {
    console.warn('FC27 full dataset unavailable:', e.message);
    fc27FullById = new Map();
  }
  return fc27FullById;
}

function ageFromBirthdate(birthdate) {
  if (!birthdate) return null;
  const b = new Date(birthdate);
  if (Number.isNaN(b.getTime())) return null;
  const at = new Date('2026-07-01T00:00:00Z');
  let age = at.getUTCFullYear() - b.getUTCFullYear();
  const md = at.getUTCMonth() - b.getUTCMonth();
  if (md < 0 || (md === 0 && at.getUTCDate() < b.getUTCDate())) age--;
  return age;
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

function overallToClubLevelServer(ovr) {
  const n=Number(ovr||0);
  if(!n)return 0;
  if(n>=90)return 9.5;
  if(n>=87)return 8.8;
  if(n>=84)return 8.0;
  if(n>=81)return 7.2;
  if(n>=78)return 6.4;
  if(n>=75)return 5.6;
  if(n>=72)return 4.9;
  if(n>=69)return 4.2;
  return 3.6;
}

function inferMarketServer(nat) {
  const n=String(nat||'').toLowerCase();
  if(n.includes('spain')||n.includes('españa'))return 'Espanya';
  if(n.includes('portugal'))return 'Portugal';
  const ibero=['argentina','uruguay','paraguay','chile','peru','perú','bolivia','ecuador','colombia','venezuela','mexico','méxico','costa rica','panama','panamá','guatemala','honduras','el salvador','nicaragua','dominican','república dominicana','cuba','brazil','brasil'];
  if(ibero.some(x=>n.includes(x)))return 'Iberoamèrica';
  return 'Altres';
}

function inferOriginLevelServer(club, league, ovr) {
  const l=String(league||'').toLowerCase();
  const c=String(club||'').toLowerCase();
  let v=5.0;
  if(/premier league|laliga|serie a|bundesliga|ligue 1/.test(l))v=7.0;
  else if(/liga portugal|eredivisie/.test(l))v=6.2;
  else if(/mls|major league soccer|saudi/.test(l))v=5.8;
  else if(/segunda|laliga hypermotion|championship|serie b|2\. bundesliga/.test(l))v=4.8;
  const elite=['real madrid','barcelona','manchester city','liverpool','arsenal','bayern','paris saint','psg','inter milan','juventus','atlético','atletico'];
  if(elite.some(x=>c.includes(x)))v=Math.max(v,8.5);
  if(Number(ovr)>=86)v=Math.max(v,6.5);
  return Number(v.toFixed(1));
}

function scoutingRealismScore(p, full, clubStatus=CLUB_CONFIG.clubStatus) {
  const ovr=Number(p.ovr||0);
  const age=ageFromBirthdate(full?.birthdate);
  const level=overallToClubLevelServer(ovr);
  const origin=inferOriginLevelServer(p.club,p.league,ovr);
  const market=inferMarketServer(p.nat);
  let score=100;
  const reasons=[];
  const hit=(pts,msg)=>{score-=pts;reasons.push(msg)};
  const boost=(pts,msg)=>{score+=pts;reasons.push(msg)};
  const gap=level-clubStatus;

  if(gap>2.4)hit(28,'Nivell molt per sobre del projecte actual');
  else if(gap>1.7)hit(18,'Salt esportiu exigent');
  else if(gap>1.0)hit(9,'Per sobre del mercat natural');

  if(ovr>=88)hit(24,'Estatus de superestrella');
  else if(ovr>=85)hit(15,'Estatus internacional molt alt');
  else if(ovr>=82)hit(7,'Reputació elevada');

  if(origin-clubStatus>3)hit(10,'Club d’origen molt superior');
  else if(origin-clubStatus>2)hit(6,'Club d’origen superior');

  if(market==='Espanya')boost(8,'Mercat prioritari');
  else if(market==='Portugal')boost(7,'Mercat prioritari');
  else if(market==='Iberoamèrica')boost(5,'Mercat coherent');
  else hit(4,'Fora dels mercats prioritaris');

  if(age){
    if(age<=20 && ovr>=80)hit(8,'Talent jove amb alta competència');
    else if(age>=29 && age<=33)boost(2,'Edat compatible amb una oportunitat de mercat');
    else if(age>=34 && ovr>=82)boost(3,'Final de carrera pot obrir una finestra');
  }

  if(ovr>=88 && clubStatus<5.5)score=Math.min(score,49);
  else if(ovr>=85 && clubStatus<5.0)score=Math.min(score,59);

  score=Math.max(0,Math.min(100,Math.round(score)));
  return {score,reasons:reasons.slice(0,3),age,level,origin,market};
}

async function recommendFc27Players(position, clubStatus=CLUB_CONFIG.clubStatus, limit=12) {
  const players=await ensureFc27Dataset();
  const fullMap=await ensureFc27FullDataset();
  const target=String(position||'').toUpperCase();
  const matches=players.filter(p=>{
    if(p.gender==='Women')return false;
    const full=fullMap.get(String(p.id))||{};
    const positions=[String(p.pos||'').toUpperCase(), ...String(full.alternate_positions||'').toUpperCase().split(/[ ,/]+/).filter(Boolean)];
    return positions.includes(target);
  });
  return matches.map(p=>{
    const full=fullMap.get(String(p.id))||{};
    const fit=scoutingRealismScore(p,full,clubStatus);
    return {
      id:String(p.id),name:p.name,overall:Number(p.ovr||0)||null,position:p.pos||'',
      alternatePositions:full.alternate_positions||'',club:p.club||'',league:p.league||'',
      nationality:p.nat||'',age:fit.age,market:fit.market,playerLevel:fit.level,
      originLevel:fit.origin,scoutingScore:fit.score,reasons:fit.reasons
    };
  }).sort((a,b)=>b.scoutingScore-a.scoutingScore || (b.overall||0)-(a.overall||0)).slice(0,limit);
}

async function getFc27Player(id) {
  const players = await ensureFc27Dataset();
  const p = players.find(x => String(x.id) === String(id));
  if (!p) return null;
  const full = (await ensureFc27FullDataset()).get(String(id)) || {};
  return {
    id: String(p.id),
    name: p.name || '',
    overall: Number(p.ovr || 0) || null,
    potential: null,
    age: ageFromBirthdate(full.birthdate),
    birthdate: full.birthdate || '',
    position: p.pos || '',
    alternatePositions: full.alternate_positions || '',
    club: p.club || '',
    league: p.league || '',
    nationality: p.nat || '',
    preferredFoot: p.foot || '',
    skillMoves: Number(p.sm || 0) || null,
    weakFoot: Number(p.wf || 0) || null,
    heightCm: Number(full.height_cm || 0) || null,
    weightKg: Number(full.weight_kg || 0) || null,
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

async function readDedicatedSquad(){
  if(!dbReady) return [];
  const r=await pool.query('SELECT data FROM squad_players ORDER BY updated_at ASC, player_id ASC');
  return r.rows.map(x=>x.data);
}

function escHtml(v='') {
  return String(v??'').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function n(v){const x=Number(v||0);return Number.isFinite(x)?x:0}
function serverPlayerRow(p,i){
  const own=p.ownership||'Propietat';
  const base=n(p.baseOvr||p.ovr||p.currentOvr);
  const cur=n(p.currentOvr||p.ovr||p.baseOvr);
  const delta=cur&&base?cur-base:0;
  const value=n(p.value);
  const wage=n(p.wage)/1000;
  const duration=own==='Cedit al Barça'
    ? (n(p.loanYears)?n(p.loanYears)+' anys':'Pendent')
    : (n(p.contractYears)?n(p.contractYears)+' anys':'Pendent');
  const link=own==='Cedit al Barça'?'CESSIÓ ENTRANT':'PROPI';
  return '<tr data-server-row="1"><td><strong>'+escHtml(p.name||'')+'</strong></td><td>'+escHtml(p.pos||'—')+'</td><td>'+escHtml(p.age||'—')+'</td><td>'+escHtml(p.role||'—')+'</td><td>'+escHtml(link)+'</td><td>'+escHtml(duration)+'</td><td>'+(base||'—')+'</td><td><strong>'+(cur||'—')+'</strong></td><td>'+(delta>0?'+':'')+delta+'</td><td>'+escHtml(p.ovrUpdatedAt||'—')+'</td><td>'+value+'</td><td>'+wage+'</td><td>'+(own==='Cedit al Barça'?'—':escHtml(duration))+'</td><td><button class="ghost-btn" onclick="editSquadPlayer('+i+')">Fitxa</button> <button class="ghost-btn" onclick="updatePlayerOvr('+i+')">OVR</button></td></tr>';
}
function serverLoanRow(p,i){
  const cur=n(p.currentOvr||p.ovr||p.baseOvr);
  const value=n(p.value),wage=n(p.wage)/1000;
  return '<tr data-server-row="1"><td><strong>'+escHtml(p.name||'')+'</strong></td><td>'+escHtml(p.pos||'—')+'</td><td>'+escHtml(p.age||'—')+'</td><td>'+escHtml(p.destinationClub||'—')+'</td><td>'+(n(p.loanYears)?n(p.loanYears)+' anys':'—')+'</td><td>'+(cur||'—')+'</td><td>'+value+'</td><td>'+wage+'</td><td>'+n(p.wageShareDepor)+'%</td><td>'+(p.purchaseOptionType==='Opció de compra'&&n(p.purchaseOptionValue)?n(p.purchaseOptionValue)+' M€':'—')+'</td><td><button class="ghost-btn" onclick="returnLoanedPlayer('+i+')">Retorna</button> <button class="ghost-btn" onclick="editSquadPlayer('+i+')">Fitxa</button></td></tr>';
}
async function serveIndex(res) {
  try {
    let html = await fs.promises.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    // Compatibility shim: the legacy client script still binds #addTransferBtn.
    // The visible Market UI now uses separate purchase/sale/loan buttons, but
    // keeping a hidden legacy target prevents the old binding from aborting
    // the rest of app initialization (including squad rendering).
    html = html.replace('<body>', '<body><button id="addTransferBtn" type="button" style="display:none" aria-hidden="true" tabindex="-1"></button>');
    let initialState = null;
    let dedicatedSquad = [];
    if (dbReady) {
      try {
        const r = await pool.query('SELECT data FROM career_state WHERE id = $1', ['main']);
        if (r.rowCount) initialState = r.rows[0].data;
        dedicatedSquad = await readDedicatedSquad();
      } catch (e) {}
    }
    initialState = {...(initialState||{}), squad:dedicatedSquad};

    // Authoritative finance snapshot rendered on the server so Dashboard/Finances
    // do not depend on the large client-side render chain.
    const finance = {...(initialState.finance || {})};
    finance.initialBudget = CLUB_CONFIG.initialBudget;
    finance.budgetSource = CLUB_CONFIG.budgetSource;

    const normLoanNameSSR=(v)=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
    const loanPresetSSR=(p)=>{
      const n=normLoanNameSSR(p?.name||'');
      const own=p?.ownership||'Propietat';
      const presets=[
        {keys:['jose maria gimenez','josema gimenez','jose gimenez'],ownership:'Cedit al Barça',deporShare:30},
        {keys:['marc casado'],ownership:'Cedit al Barça',deporShare:50},
        {keys:['angelino','jose angel esmoris tasende'],ownership:'Cedit al Barça',deporShare:60},
        {keys:['charlie patino'],ownership:'Cedit fora',deporShare:25}
      ];
      return presets.find(x=>x.ownership===own&&x.keys.includes(n))||null;
    };
    const effectiveLoanShareSSR=(p)=>{
      const own=p?.ownership||'Propietat';
      if(own==='Propietat')return 100;
      if(p?.wageShareManual===true)return Math.max(0,Math.min(100,Number(p?.wageShareDepor||0)));
      const preset=loanPresetSSR(p); if(preset)return preset.deporShare;
      const stored=Number(p?.wageShareDepor||0);
      if(stored>0)return Math.max(0,Math.min(100,stored));
      return own==='Cedit al Barça'?100:0;
    };
    const wageContribution = (p) => {
      const wage = Number(p?.wage || 0);
      if (!wage) return 0;
      return wage*(effectiveLoanShareSSR(p)/100);
    };

    const currentWages = dedicatedSquad.reduce((sum,p)=>sum+wageContribution(p),0);
    const initialMap = finance.initialWageByPlayer && typeof finance.initialWageByPlayer === 'object'
      ? finance.initialWageByPlayer : {};
    let initialWages = Object.values(initialMap).reduce((sum,v)=>sum+Number(v||0),0);

    if (!initialWages && dedicatedSquad.length >= 18) {
      const snap = {};
      dedicatedSquad.forEach(p => { if (p.playerId) snap[p.playerId] = wageContribution(p); });
      finance.initialWageByPlayer = snap;
      finance.baselineLocked = true;
      finance.initialWageCapturedAt = finance.initialWageCapturedAt || new Date().toISOString();
      initialWages = currentWages;
      initialState.finance = finance;
      try {
        await pool.query(
          'UPDATE career_state SET data = jsonb_set(COALESCE(data,\'{}\'::jsonb), \'{finance}\', $2::jsonb, true), updated_at=NOW() WHERE id=$1',
          ['main', JSON.stringify(finance)]
        );
      } catch (e) {}
    } else {
      initialState.finance = finance;
    }

    const transfers = Array.isArray(initialState.transfers) ? initialState.transfers : [];
    const expenseTypes = new Set(['Compra','Cessió entrada','Agent lliure']);
    const incomeTypes = new Set(['Venda','Cessió sortida']);
    const transferSpend = transfers.filter(t=>expenseTypes.has(t.type)).reduce((a,t)=>a+Number(t.amount||0),0);
    const transferIncome = transfers.filter(t=>incomeTypes.has(t.type)).reduce((a,t)=>a+Number(t.amount||0),0);
    const availableBudget = CLUB_CONFIG.initialBudget + transferIncome * 0.70 - transferSpend;
    const wageGrowth = initialWages ? (currentWages-initialWages)/initialWages : 0;

    const euroM = v => new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR',maximumFractionDigits:2}).format(Number(v||0)*1000000);
    const wageK = v => (Number(v||0)/1000).toLocaleString('es-ES',{minimumFractionDigits:1,maximumFractionDigits:1});

    const safeState = JSON.stringify(initialState).replace(/</g, '\\u003c');
    html = html.replace('<script>', '<script>window.__SERVER_STATE__='+safeState+';<\/script><script>');

    // Server-render the finance values as a fallback and first paint.
    html = html.replace('id="finInitialBudget" type="text" value="11.613.983 €" readonly',
      'id="finInitialBudget" type="text" value="11.613.983 €" readonly');
    html = html.replace('<input id="finOperationalOpening" type="text" readonly>',
      '<input id="finOperationalOpening" type="text" value="'+euroM(CLUB_CONFIG.initialBudget)+'" readonly>');
    html = html.replace('<input id="finBudget" type="text" readonly>',
      '<input id="finBudget" type="text" value="'+euroM(availableBudget)+'" readonly>');
    html = html.replace('<input id="finInitialWages" type="text" readonly>',
      '<input id="finInitialWages" type="text" value="'+wageK(initialWages)+' k€/set." readonly>');
    html = html.replace('<input id="finWages" type="text" readonly>',
      '<input id="finWages" type="text" value="'+wageK(currentWages)+' k€/set." readonly>');
    html = html.replace('<input id="finWageGrowth" type="text" readonly>',
      '<input id="finWageGrowth" type="text" value="'+(wageGrowth>=0?'+':'')+(wageGrowth*100).toFixed(1)+'%" readonly>');

    html = html.replace('<strong id="budgetKpi">€12.0M</strong>',
      '<strong id="budgetKpi">'+euroM(availableBudget)+'</strong>');
    html = html.replace('<small id="budgetDelta">Disponible</small>',
      '<small id="budgetDelta">'+euroM(CLUB_CONFIG.initialBudget)+' pressupost inicial</small>');
    html = html.replace('<strong id="wageGrowthKpi">—</strong>',
      '<strong id="wageGrowthKpi">'+wageK(currentWages)+' k€/set.</strong>');
    html = html.replace('<small id="wageGrowthLabel">vs inici</small>',
      '<small id="wageGrowthLabel">'+(initialWages?((wageGrowth>=0?'+':'')+(wageGrowth*100).toFixed(1)+'% vs inici'):'Base salarial actual')+'</small>');

    html = html.replace('<div id="financeSummary"></div>',
      '<div id="financeSummary"><div class="summary-grid">'+
      '<div class="summary-box"><small>Pressupost inicial EA</small><strong>'+euroM(CLUB_CONFIG.initialBudget)+'</strong></div>'+
      '<div class="summary-box"><small>Despesa mercat</small><strong>'+euroM(transferSpend)+'</strong></div>'+
      '<div class="summary-box"><small>Ingressos mercat</small><strong>'+euroM(transferIncome)+'</strong></div>'+
      '<div class="summary-box"><small>Reinversió vendes (70%)</small><strong>'+euroM(transferIncome*.70)+'</strong></div>'+
      '<div class="summary-box"><small>Disponible ara</small><strong>'+euroM(availableBudget)+'</strong></div>'+
      '<div class="summary-box"><small>Massa salarial inicial</small><strong>'+wageK(initialWages)+' k€/set.</strong></div>'+
      '<div class="summary-box"><small>Massa salarial actual</small><strong>'+wageK(currentWages)+' k€/set.</strong></div>'+
      '<div class="summary-box"><small>Variació salarial</small><strong>'+(wageGrowth>=0?'+':'')+(wageGrowth*100).toFixed(1)+'%</strong></div>'+
      '</div></div>');

    // Server-render the saved squad so it is visible even before any client-side sync/render runs.
    const squad=dedicatedSquad;
    const activeRows=squad.map((p,i)=>({p,i})).filter(x=>x.p.ownership!=='Cedit fora').map(x=>serverPlayerRow(x.p,x.i)).join('');
    const loanRows=squad.map((p,i)=>({p,i})).filter(x=>x.p.ownership==='Cedit fora').map(x=>serverLoanRow(x.p,x.i)).join('');
    html=html.replace('<tbody id="squadTable"></tbody>','<tbody id="squadTable">'+activeRows+'</tbody>');
    html=html.replace('<tbody id="loanedOutTable"></tbody>','<tbody id="loanedOutTable">'+(loanRows||'<tr><td colspan="11">No hi ha jugadors del Barça cedits fora.</td></tr>')+'</tbody>');
    const activeCount=squad.filter(p=>p.ownership!=='Cedit fora').length;
    const loanCount=squad.filter(p=>p.ownership==='Cedit fora').length;
    html=html.replace('<div id="squadHydrationStatus" class="sync-banner">Preparant plantilla…</div>',
      '<div id="squadHydrationStatus" class="sync-banner ok">Plantilla servidor · '+activeCount+' actius · '+loanCount+' cedits fora</div>');

    res.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'no-store, no-cache, must-revalidate'});
    res.end(html);
  } catch (err) {
    return json(res, 500, {error:'No s’ha pogut carregar la interfície.'});
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');

    if (u.pathname === '/version') {
      return json(res,200,{build:'2026-10-12-1119',commit:'d589799d0f8d19b64dec5ae20d00b0e5a86c52eb'});
    }

    if (u.pathname === '/health') {
      return json(res, 200, {
        ok:true,
        service:'depor-career-director',
        database: dbReady ? 'connected' : (pool ? 'initializing' : 'not_configured'),
        fc27Dataset: fc27Players?.length || 0
      });
    }

    if (u.pathname === '/api/squad' && req.method === 'GET') {
      if (!dbReady) return json(res, 503, {error:'Base de dades no configurada.'});
      const squad=await readDedicatedSquad();
      return json(res, 200, {squad}, 'no-store');
    }

    if (u.pathname === '/api/squad' && req.method === 'PUT') {
      if (!dbReady) return json(res, 503, {error:'Base de dades no configurada.'});
      const body=await readBody(req);
      if(!body || !Array.isArray(body.squad)) return json(res,400,{error:'Plantilla no vàlida.'});
      const incoming=body.squad.map(raw=>({...raw,playerId:raw.playerId||crypto.randomUUID()}));
      const current=await pool.query('SELECT COUNT(*)::int AS n FROM squad_players');
      if(Number(current.rows[0]?.n||0)>0 && incoming.length===0){
        return json(res,409,{error:'Protecció activa: una plantilla existent no es pot buidar amb una sincronització.'});
      }
      await pool.query('BEGIN');
      try{
        const ids=[];
        for(const player of incoming){
          ids.push(player.playerId);
          await pool.query(
            `INSERT INTO squad_players(player_id,data,updated_at)
             VALUES($1,$2::jsonb,NOW())
             ON CONFLICT(player_id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`,
            [player.playerId,JSON.stringify(player)]
          );
        }
        if(ids.length){
          await pool.query('DELETE FROM squad_players WHERE NOT (player_id = ANY($1::text[]))',[ids]);
        }
        await pool.query('COMMIT');
      }catch(e){
        await pool.query('ROLLBACK');
        throw e;
      }
      return json(res,200,{ok:true,squad:incoming});
    }

    if (u.pathname === '/api/transfers/history' && req.method === 'GET') {
      if (!dbReady) return json(res,503,{error:'Base de dades no configurada.'});
      const current=await pool.query('SELECT data FROM career_state WHERE id=$1',['main']);
      const stateData=current.rows[0]?.data&&typeof current.rows[0].data==='object'?current.rows[0].data:{};
      const transfers=Array.isArray(stateData.transfers)?stateData.transfers:[];
      return json(res,200,{transfers},'no-store');
    }

    if (u.pathname === '/api/transfers/loan-in' && req.method === 'POST') {
      if (!dbReady) return json(res,503,{error:'Base de dades no configurada.'});
      const body=await readBody(req);
      if(!String(body?.player||'').trim() || !String(body?.club||'').trim()) return json(res,400,{error:'Falten jugador o club propietari.'});
      const current=await pool.query('SELECT data FROM career_state WHERE id=$1',['main']);
      const stateData=current.rows[0]?.data&&typeof current.rows[0].data==='object'?{...current.rows[0].data}:{};
      const transfers=Array.isArray(stateData.transfers)?[...stateData.transfers]:[];
      const playerId=crypto.randomUUID();
      const loan={
        operationId:crypto.randomUUID(),
        player:String(body.player).trim(),
        playerId,
        type:'Cessió entrada',
        window:String(body.window||'Estiu'),
        club:String(body.club).trim(),
        amount:Number(body.amount||0),
        wage:Number(body.wage||0),
        age:Number(body.age||0),
        role:String(body.role||'Rotació'),
        reason:'Cessió entrant',
        createdAt:new Date().toISOString()
      };
      const squadPlayer={
        playerId,
        name:String(body.player).trim(),
        ownership:'Cedit al Barça',
        parentClub:String(body.club).trim(),
        destinationClub:'',
        wage:Number(body.wage||0),
        wageShareDepor:Number(body.wageShareDepor||100),
        wageShareManual:true,
        loanYears:Number(body.loanYears||1),
        purchaseOptionType:String(body.purchaseOptionType||'Sense opció'),
        purchaseOptionValue:Number(body.purchaseOptionValue||0),
        age:Number(body.age||0),
        currentOvr:Number(body.currentOvr||0),
        baseOvr:Number(body.currentOvr||0),
        role:String(body.role||'Rotació'),
        minutes:0,goals:0,assists:0
      };
      transfers.push(loan);
      stateData.transfers=transfers;
      stateData._clientUpdatedAt=Date.now();

      await pool.query('BEGIN');
      try{
        await pool.query('INSERT INTO career_state_history(state_id,data,saved_at) VALUES($1,$2::jsonb,NOW())',['main',JSON.stringify(stateData)]);
        await pool.query('UPDATE career_state SET data=$2::jsonb,updated_at=NOW() WHERE id=$1',['main',JSON.stringify(stateData)]);
        await pool.query('INSERT INTO squad_players(player_id,data,updated_at) VALUES($1,$2::jsonb,NOW())',[playerId,JSON.stringify(squadPlayer)]);
        await pool.query('COMMIT');
      }catch(e){await pool.query('ROLLBACK');throw e;}
      return json(res,200,{ok:true,transfer:loan,player:squadPlayer});
    }

    if (u.pathname === '/api/transfers/loan-out' && req.method === 'POST') {
      if (!dbReady) return json(res,503,{error:'Base de dades no configurada.'});
      const body=await readBody(req);
      const playerId=String(body?.playerId||'').trim();
      if(!playerId) return json(res,400,{error:'Selecciona un jugador.'});
      const playerRow=await pool.query('SELECT data FROM squad_players WHERE player_id=$1',[playerId]);
      if(!playerRow.rowCount) return json(res,404,{error:'Jugador no trobat a la plantilla.'});
      const p=playerRow.rows[0].data||{};
      const current=await pool.query('SELECT data FROM career_state WHERE id=$1',['main']);
      const stateData=current.rows[0]?.data&&typeof current.rows[0].data==='object'?{...current.rows[0].data}:{};
      const transfers=Array.isArray(stateData.transfers)?[...stateData.transfers]:[];
      const loan={
        operationId:crypto.randomUUID(),
        player:p.name||'Jugador',
        playerId,
        type:'Cessió sortida',
        window:String(body.window||'Estiu'),
        club:String(body.club||'').trim(),
        amount:Number(body.amount||0),
        wage:Number(p.wage||0),
        age:Number(p.age||0),
        role:p.role||'No aplica',
        reason:'Cessió sortint',
        createdAt:new Date().toISOString()
      };
      const updatedPlayer={...p,
        ownership:'Cedit fora',
        destinationClub:String(body.club||'').trim(),
        wageShareDepor:Number(body.wageShareDepor||0),
        wageShareManual:true,
        loanYears:Number(body.loanYears||1),
        purchaseOptionType:String(body.purchaseOptionType||'Sense opció'),
        purchaseOptionValue:Number(body.purchaseOptionValue||0)
      };
      transfers.push(loan);
      stateData.transfers=transfers;
      stateData._clientUpdatedAt=Date.now();

      await pool.query('BEGIN');
      try{
        await pool.query('INSERT INTO career_state_history(state_id,data,saved_at) VALUES($1,$2::jsonb,NOW())',['main',JSON.stringify(stateData)]);
        await pool.query('UPDATE career_state SET data=$2::jsonb,updated_at=NOW() WHERE id=$1',['main',JSON.stringify(stateData)]);
        await pool.query('UPDATE squad_players SET data=$2::jsonb,updated_at=NOW() WHERE player_id=$1',[playerId,JSON.stringify(updatedPlayer)]);
        await pool.query('COMMIT');
      }catch(e){await pool.query('ROLLBACK');throw e;}
      return json(res,200,{ok:true,transfer:loan,player:updatedPlayer});
    }

    if (u.pathname === '/api/transfers/sale' && req.method === 'POST') {
      if (!dbReady) return json(res,503,{error:'Base de dades no configurada.'});
      const body=await readBody(req);
      const playerId=String(body?.playerId||'').trim();
      if(!playerId) return json(res,400,{error:'Selecciona un jugador de la plantilla.'});

      const playerRow=await pool.query('SELECT data FROM squad_players WHERE player_id=$1',[playerId]);
      if(!playerRow.rowCount) return json(res,404,{error:'Aquest jugador ja no és a la plantilla.'});
      const p=playerRow.rows[0].data||{};
      const amount=Number(body?.amount||0);
      if(!Number.isFinite(amount)||amount<0) return json(res,400,{error:'Import de venda no vàlid.'});

      const current=await pool.query('SELECT data FROM career_state WHERE id=$1',['main']);
      const stateData=current.rows[0]?.data&&typeof current.rows[0].data==='object'?{...current.rows[0].data}:{};
      const transfers=Array.isArray(stateData.transfers)?[...stateData.transfers]:[];
      const sale={
        operationId:crypto.randomUUID(),
        player:p.name||'Jugador',
        playerId,
        type:'Venda',
        window:String(body?.window||'Estiu'),
        club:String(body?.club||'').trim(),
        amount,
        playerValue:Number(p.value||0),
        wage:Number(p.wage||0),
        age:Number(p.age||0),
        role:p.role||'No aplica',
        buyerLevel:Number(body?.buyerLevel||0),
        contractYears:Number(body?.contractYears||p.contractYears||0),
        reason:String(body?.reason||'').trim(),
        createdAt:new Date().toISOString()
      };
      transfers.push(sale);
      stateData.transfers=transfers;
      stateData._clientUpdatedAt=Date.now();

      await pool.query('BEGIN');
      try{
        await pool.query('INSERT INTO career_state_history(state_id,data,saved_at) VALUES($1,$2::jsonb,NOW())',['main',JSON.stringify(stateData)]);
        await pool.query('UPDATE career_state SET data=$2::jsonb,updated_at=NOW() WHERE id=$1',['main',JSON.stringify(stateData)]);
        await pool.query('DELETE FROM squad_players WHERE player_id=$1',[playerId]);
        await pool.query('COMMIT');
      }catch(e){
        await pool.query('ROLLBACK');
        throw e;
      }
      return json(res,200,{ok:true,sale,removedPlayerId:playerId,count:transfers.length});
    }

    if (u.pathname === '/api/transfers' && req.method === 'POST') {
      if (!dbReady) return json(res,503,{error:'Base de dades no configurada.'});
      const body=await readBody(req);
      const t=body?.transfer;
      if(!t || !String(t.player||'').trim() || !String(t.type||'').trim()) return json(res,400,{error:'Falten jugador o tipus d’operació.'});
      const current=await pool.query('SELECT data FROM career_state WHERE id=$1',['main']);
      const stateData=current.rows[0]?.data&&typeof current.rows[0].data==='object'?{...current.rows[0].data}:{};
      const transfers=Array.isArray(stateData.transfers)?[...stateData.transfers]:[];
      const normalized={...t,
        operationId:String(t.operationId||crypto.randomUUID()),
        player:String(t.player||'').trim(),
        type:String(t.type||'').trim(),
        amount:Number(t.amount||0),
        playerValue:Number(t.playerValue||0),
        wage:Number(t.wage||0),
        age:Number(t.age||0),
        createdAt:new Date().toISOString()
      };
      transfers.push(normalized);
      stateData.transfers=transfers;
      stateData._clientUpdatedAt=Date.now();
      await pool.query('BEGIN');
      try{
        await pool.query('INSERT INTO career_state_history(state_id,data,saved_at) VALUES($1,$2::jsonb,NOW())',['main',JSON.stringify(stateData)]);
        await pool.query('UPDATE career_state SET data=$2::jsonb,updated_at=NOW() WHERE id=$1',['main',JSON.stringify(stateData)]);
        await pool.query('COMMIT');
      }catch(e){
        await pool.query('ROLLBACK');
        throw e;
      }
      return json(res,200,{ok:true,transfer:normalized,count:transfers.length});
    }

    if (u.pathname === '/api/finance/snapshot' && req.method === 'GET') {
      if (!dbReady) return json(res,503,{error:'Base de dades no configurada.'});
      const stateRow=await pool.query('SELECT data FROM career_state WHERE id=$1',['main']);
      const stateData=stateRow.rows[0]?.data||{};
      const squad=await readDedicatedSquad();
      const finance={...(stateData.finance||{})};
      const normLoanName=(v)=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
      const loanPreset=(p)=>{
        const n=normLoanName(p?.name||'');
        const own=p?.ownership||'Propietat';
        const presets=[
          {keys:['jose maria gimenez','josema gimenez','jose gimenez'],ownership:'Cedit al Barça',deporShare:30},
          {keys:['marc casado'],ownership:'Cedit al Barça',deporShare:50},
          {keys:['angelino','jose angel esmoris tasende'],ownership:'Cedit al Barça',deporShare:60},
          {keys:['charlie patino','charlie patino'],ownership:'Cedit fora',deporShare:25}
        ];
        return presets.find(x=>x.ownership===own&&x.keys.includes(n))||null;
      };
      const effectiveLoanShare=(p)=>{
        const own=p?.ownership||'Propietat';
        if(own==='Propietat')return 100;
        if(p?.wageShareManual===true){
          return Math.max(0,Math.min(100,Number(p?.wageShareDepor||0)));
        }
        const preset=loanPreset(p);
        if(preset)return preset.deporShare;
        const stored=Number(p?.wageShareDepor||0);
        if(stored>0)return Math.max(0,Math.min(100,stored));
        return own==='Cedit al Barça'?100:0;
      };
      const wageContribution=(p)=>{
        const wage=Number(p?.wage||0);
        if(!wage)return 0;
        return wage*(effectiveLoanShare(p)/100);
      };
      const currentWages=squad.reduce((a,p)=>a+wageContribution(p),0);
      const baseline=finance.initialWageByPlayer&&typeof finance.initialWageByPlayer==='object'?finance.initialWageByPlayer:{};
      const initialWages=Object.values(baseline).reduce((a,v)=>a+Number(v||0),0);
      const transfers=Array.isArray(stateData.transfers)?stateData.transfers:[];
      const expenseTypes=new Set(['Compra','Cessió entrada','Agent lliure']);
      const incomeTypes=new Set(['Venda','Cessió sortida']);
      const transferSpend=transfers.filter(t=>expenseTypes.has(t.type)).reduce((a,t)=>a+Number(t.amount||0),0);
      const transferIncome=transfers.filter(t=>incomeTypes.has(t.type)).reduce((a,t)=>a+Number(t.amount||0),0);
      const initialBudget=CLUB_CONFIG.initialBudget;
      const available=initialBudget+(transferIncome*.70)-transferSpend;
      const wageGrowth=initialWages?(currentWages-initialWages)/initialWages:0;
      const ownedWages=squad.filter(p=>(p.ownership||'Propietat')==='Propietat').reduce((a,p)=>a+wageContribution(p),0);
      const incomingLoanWages=squad.filter(p=>p.ownership==='Cedit al Barça').reduce((a,p)=>a+wageContribution(p),0);
      const outgoingLoanWages=squad.filter(p=>p.ownership==='Cedit fora').reduce((a,p)=>a+wageContribution(p),0);
      const loanShares=squad.filter(p=>['Cedit al Barça','Cedit fora'].includes(p.ownership)).map(p=>({name:p.name,ownership:p.ownership,share:effectiveLoanShare(p),wage:Number(p.wage||0),cost:wageContribution(p)}));
      return json(res,200,{initialBudget,available,transferSpend,transferIncome,reinvestableIncome:transferIncome*.70,initialWages,currentWages,wageGrowth,ownedWages,incomingLoanWages,outgoingLoanWages,squadCount:squad.length,loanShares},'no-store');
    }

    if (u.pathname === '/api/finance/budget' && req.method === 'POST') {
      if (!dbReady) return json(res, 503, {error:'Base de dades no configurada.'});
      const body=await readBody(req);
      const rawBudget=Number(String(body?.initialBudget ?? '').replace(',','.'));
      const initialBudget=rawBudget>100000?rawBudget/1000000:rawBudget;
      if(!Number.isFinite(initialBudget) || initialBudget<=0) return json(res,400,{error:'Pressupost inicial no vàlid.'});

      const current=await pool.query('SELECT data FROM career_state WHERE id=$1',['main']);
      const stateData=current.rows[0]?.data&&typeof current.rows[0].data==='object'?{...current.rows[0].data}:{};
      const updatedAt=Date.now();
      stateData.finance={...(stateData.finance||{}),initialBudget,budgetSource:'EA available transfer budget'};
      stateData._clientUpdatedAt=updatedAt;

      await pool.query('BEGIN');
      try{
        await pool.query(
          'INSERT INTO career_state_history(state_id,data,saved_at) VALUES($1,$2::jsonb,NOW())',
          ['main',JSON.stringify(stateData)]
        );
        await pool.query(
          `INSERT INTO career_state(id,data,updated_at)
           VALUES($1,$2::jsonb,NOW())
           ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()`,
          ['main',JSON.stringify(stateData)]
        );
        await pool.query('COMMIT');
      }catch(e){
        await pool.query('ROLLBACK');
        throw e;
      }
      return json(res,200,{ok:true,initialBudget,openingOperational:initialBudget,updatedAt});
    }

    if (u.pathname === '/api/state' && req.method === 'GET') {
      if (!dbReady) return json(res, 503, {error:'Base de dades no configurada.'});
      const r = await pool.query('SELECT data, updated_at FROM career_state WHERE id = $1', ['main']);
      if (!r.rowCount) return json(res, 200, {state:null});
      const stateData={...(r.rows[0].data||{})};
      delete stateData.squad;
      return json(res, 200, {state:stateData, updatedAt:r.rows[0].updated_at}, 'no-store');
    }

    if (u.pathname === '/api/state' && req.method === 'POST') {
      if (!dbReady) return json(res, 503, {error:'Base de dades no configurada.'});
      const body = await readBody(req);
      if (!body || typeof body.state !== 'object') return json(res, 400, {error:'Estat no vàlid.'});
      const stateToSave={...body.state};
      delete stateToSave.squad;

      // Transfer operations are append-only business records. A delayed/stale
      // client autosave must never erase a sale/loan already committed by its
      // dedicated endpoint.
      const currentStateRow=await pool.query('SELECT data FROM career_state WHERE id=$1',['main']);
      const currentState=currentStateRow.rows[0]?.data&&typeof currentStateRow.rows[0].data==='object'
        ? currentStateRow.rows[0].data : {};
      const serverTransfers=Array.isArray(currentState.transfers)?currentState.transfers:[];
      const incomingTransfers=Array.isArray(stateToSave.transfers)?stateToSave.transfers:[];
      const transferKey=(t)=>{
        if(t?.operationId)return 'id:'+String(t.operationId);
        return [
          String(t?.type||''),String(t?.playerId||''),String(t?.player||''),
          String(t?.club||''),String(t?.amount??''),String(t?.createdAt||'')
        ].join('|');
      };
      const mergedTransfers=[];
      const seenTransfers=new Set();
      for(const t of [...serverTransfers,...incomingTransfers]){
        const key=transferKey(t);
        if(seenTransfers.has(key))continue;
        seenTransfers.add(key);
        mergedTransfers.push(t);
      }
      stateToSave.transfers=mergedTransfers;

      await pool.query('BEGIN');
      try {
        await pool.query(
          'INSERT INTO career_state_history(state_id,data,saved_at) VALUES($1,$2::jsonb,NOW())',
          ['main', JSON.stringify(stateToSave)]
        );
        await pool.query(
          `INSERT INTO career_state(id,data,updated_at)
           VALUES($1,$2::jsonb,NOW())
           ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`,
          ['main', JSON.stringify(stateToSave)]
        );
        await pool.query(
          `DELETE FROM career_state_history
           WHERE state_id=$1 AND version_id NOT IN (
             SELECT version_id FROM career_state_history WHERE state_id=$1 ORDER BY version_id DESC LIMIT 50
           )`,
          ['main']
        );
        await pool.query('COMMIT');
      } catch (e) {
        await pool.query('ROLLBACK');
        throw e;
      }
      return json(res, 200, {ok:true});
    }

    if (u.pathname === '/api/state/history' && req.method === 'GET') {
      if (!dbReady) return json(res, 503, {error:'Base de dades no configurada.'});
      const r = await pool.query(
        `SELECT version_id, saved_at,
                jsonb_array_length(COALESCE(data->'squad','[]'::jsonb)) AS squad_count
         FROM career_state_history
         WHERE state_id=$1
         ORDER BY version_id DESC
         LIMIT 20`,
        ['main']
      );
      return json(res, 200, {versions:r.rows}, 'no-store');
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

    if (u.pathname === '/api/players/recommend') {
      const position=String(u.searchParams.get('position')||'').trim().toUpperCase();
      const clubStatus=Number(u.searchParams.get('clubStatus')||CLUB_CONFIG.clubStatus);
      const limit=Math.max(1,Math.min(20,Number(u.searchParams.get('limit')||12)));
      if(!position) return json(res,400,{error:'Falta la posició.'});
      const players=await recommendFc27Players(position,clubStatus,limit);
      return json(res,200,{players,source:'EA FC27 dataset',snapshotDate:FC27_SNAPSHOT_DATE},'public, max-age=3600');
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

    if (u.pathname === '/latest') {
      try {
        let html = await fs.promises.readFile(path.join(PUBLIC_DIR,'index.html'),'utf8');
        html = html.replace('<body>','<body><div style="position:sticky;top:0;z-index:99999;background:#0f2747;color:white;padding:8px 12px;font:700 12px Arial;text-align:center">BUILD ACTUAL · FINANCES + CANTERA · d589799</div>');
        res.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'no-store, no-cache, must-revalidate, max-age=0','pragma':'no-cache','expires':'0'});
        return res.end(html);
      } catch (e) {
        return json(res,500,{error:'No s’ha pogut carregar /latest'});
      }
    }

    return await serveIndex(res);
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
      console.log('Barça Career Director listening on ' + PORT);
    });
  });
