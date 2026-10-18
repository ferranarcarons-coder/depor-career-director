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
  initialBudget:163.5,
  budgetSource:'FC 27 · pressupost inicial Barça 2026/27',
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
      finance.initialBudget = CLUB_CONFIG.initialBudget;
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
          initialWeeklyWages:4800000,
          initialWageByPlayer:{},
          baselineLocked:true,
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

  // One-time Barça wage/value baseline enrichment.
  try{
    const stateRow=await pool.query('SELECT data FROM career_state WHERE id=$1',['main']);
    const st=stateRow.rows[0]?.data||{};
    const source=st.finance?.wageBaselineSource||'';
    const squadRows=await pool.query('SELECT data FROM squad_players');
    const nonZeroWages=squadRows.rows.filter(r=>Number(r.data?.wage||0)>0).length;
    if(!source || nonZeroWages < Math.max(10,Math.floor(squadRows.rowCount*.6))){
      await enrichBarcaSquadFinancials();
    }
  }catch(e){
    console.warn('[BARCA_FINANCE_ENRICH_ERROR]',e.message);
  }

  // BARCA_AGGREGATE_WAGE_BASELINE: authoritative FC27 team wage total.
  try{
    const sr=await pool.query('SELECT data FROM career_state WHERE id=$1',['main']);
    if(sr.rowCount){
      const d=sr.rows[0].data||{};
      d.finance={...(d.finance||{}),initialWeeklyWages:4800000};
      if(!d.finance.wageBaselineSource || String(d.finance.wageBaselineSource).includes('FC Tools Hub')){
        d.finance.wageBaselineSource='FAFIFA · FC Barcelona FC27 · 7 Oct 2026';
      }
      await pool.query('UPDATE career_state SET data=$2::jsonb,updated_at=NOW() WHERE id=$1',['main',JSON.stringify(d)]);
    }
  }catch(e){console.warn('[BARCA_WAGE_BASELINE_ERROR]',e.message);}

  // Manual FC27 squad snapshot supplied by the user: goalkeepers, 18 Oct 2026.
  try{
    const normalizeSnapshotName=(v)=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
    const goalkeeperSnapshot=[
      {match:['joan garcia','joan garcia pons'],patch:{pos:'POR',age:25,baseOvr:86,currentOvr:86,potential:89,value:55,wage:120000,ownership:'Propietat',parentClub:'',destinationClub:'',contractYears:5,loanYears:0,realClub:'FC Barcelona'}},
      {match:['wojciech szczesny','wojciech tomasz szczesny'],patch:{pos:'POR',age:36,baseOvr:80,currentOvr:80,potential:87,value:0.55,wage:53000,ownership:'Propietat',parentClub:'',destinationClub:'',contractYears:1,loanYears:0,realClub:'FC Barcelona'}},
      {match:['diego kochen'],patch:{pos:'POR',age:20,baseOvr:62,currentOvr:62,potential:79,value:0.35,wage:8000,ownership:'Cedit fora',parentClub:'FC Barcelona',destinationClub:'Lyngby Boldklub',loanYears:1,realClub:'Lyngby Boldklub'}},
      {match:['aron yaakobishvili'],patch:{pos:'POR',age:20,baseOvr:69,currentOvr:69,potential:85,value:1.2,wage:18000,ownership:'Cedit fora',parentClub:'FC Barcelona',destinationClub:'UD Almeria',loanYears:1,realClub:'UD Almería'}},
      {match:['marc andre ter stegen','marc andre terstegen'],patch:{pos:'POR',age:34,baseOvr:82,currentOvr:82,potential:90,value:5,wage:321000,ownership:'Cedit fora',parentClub:'FC Barcelona',destinationClub:'Ajax',loanYears:1,realClub:'Ajax'}}
    ];
    const rows=await pool.query('SELECT player_id,data FROM squad_players');
    let updated=0;
    for(const row of rows.rows){
      const current=row.data||{};
      const name=normalizeSnapshotName(current.name);
      const snap=goalkeeperSnapshot.find(x=>x.match.some(m=>name.includes(m)));
      if(!snap)continue;
      const next={...current,...snap.patch,ovrUpdatedAt:'18/10/2026',manualSnapshotSource:'SoFIFA FC27 · user screenshots · 18/10/2026'};
      await pool.query('UPDATE squad_players SET data=$2::jsonb,updated_at=NOW() WHERE player_id=$1',[row.player_id,JSON.stringify(next)]);
      updated++;
    }
    console.log('[MANUAL_SQUAD_SNAPSHOT_GK]',JSON.stringify({updated,total:goalkeeperSnapshot.length}));
  }catch(e){console.warn('[MANUAL_SQUAD_SNAPSHOT_GK_ERROR]',e.message);}

  // Manual FC27 squad snapshot supplied by the user: full-backs / defenders, 18 Oct 2026.
  try{
    const normalizeSnapshotName=(v)=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
    const defenderSnapshot=[
      {match:['eric garcia','eric garcia martret'],patch:{
        pos:'DFC',alternatePositions:'LD MCD MC',age:25,baseOvr:85,currentOvr:85,potential:86,
        value:52,wage:154000,ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:5,loanYears:0,realClub:'FC Barcelona'
      }},
      {match:['joao cancelo','joao pedro cavaco cancelo'],patch:{
        pos:'LI',alternatePositions:'LD MD MI',age:32,baseOvr:83,currentOvr:83,potential:88,
        value:25,wage:339000,ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:3,loanYears:0,realClub:'FC Barcelona'
      }},
      {match:['jules kounde','jules olivier kounde'],patch:{
        pos:'LD',alternatePositions:'DFC MD',age:27,baseOvr:85,currentOvr:85,potential:87,
        value:52,wage:301000,ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:4,loanYears:0,realClub:'FC Barcelona'
      }},
      {match:['xavi espart','xavi espart font'],patch:{
        pos:'LD',alternatePositions:'LI MC',age:19,baseOvr:71,currentOvr:71,potential:85,
        value:1.9,wage:44000,ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:2,loanYears:0,realClub:'FC Barcelona'
      }},
      {match:['alejandro balde','alejandro balde martinez'],patch:{
        pos:'LI',alternatePositions:'MI',age:22,baseOvr:82,currentOvr:82,potential:85,
        value:33,wage:32000,ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:2,loanYears:0,realClub:'FC Barcelona'
      }}
    ];
    const rows=await pool.query('SELECT player_id,data FROM squad_players');
    let updated=0;
    for(const row of rows.rows){
      const current=row.data||{};
      const name=normalizeSnapshotName(current.name);
      const snap=defenderSnapshot.find(x=>x.match.some(m=>name.includes(m)));
      if(!snap)continue;
      const next={...current,...snap.patch,ovrUpdatedAt:'18/10/2026',manualSnapshotSource:'SoFIFA FC27 · user screenshots · 18/10/2026'};
      await pool.query('UPDATE squad_players SET data=$2::jsonb,updated_at=NOW() WHERE player_id=$1',[row.player_id,JSON.stringify(next)]);
      updated++;
    }
    console.log('[MANUAL_SQUAD_SNAPSHOT_DEF]',JSON.stringify({updated,total:defenderSnapshot.length}));
  }catch(e){console.warn('[MANUAL_SQUAD_SNAPSHOT_DEF_ERROR]',e.message);}

  // Manual FC27 squad snapshot supplied by the user: centre-backs, 18 Oct 2026.
  try{
    const normalizeSnapshotName=(v)=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
    const centreBackSnapshot=[
      {match:['pau cubarsi','pau cubarsi paredes'],patch:{
        pos:'DFC',alternatePositions:'',age:19,baseOvr:86,currentOvr:86,potential:91,
        value:64.5,wage:77000,ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:3,loanYears:0,realClub:'FC Barcelona'
      }},
      {match:['gerard martin','gerard martin langreo'],patch:{
        pos:'DFC',alternatePositions:'LI MI',age:24,baseOvr:79,currentOvr:79,potential:84,
        value:17.5,wage:105000,ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:2,loanYears:0,realClub:'FC Barcelona'
      }},
      {match:['andreas christensen','andreas bodtker christensen'],patch:{
        pos:'DFC',alternatePositions:'MC MCD',age:30,baseOvr:79,currentOvr:79,potential:83,
        value:14.5,wage:130000,ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:2,loanYears:0,realClub:'FC Barcelona'
      }},
      {match:['ronald araujo','ronald federico araujo da silva'],patch:{
        pos:'DFC',alternatePositions:'LD',age:27,baseOvr:80,currentOvr:80,potential:86,
        value:19.5,wage:130000,ownership:'Cedit fora',parentClub:'FC Barcelona',
        destinationClub:'Liverpool FC',loanYears:1,realClub:'Liverpool FC'
      }}
    ];
    const rows=await pool.query('SELECT player_id,data FROM squad_players');
    let updated=0;
    for(const row of rows.rows){
      const current=row.data||{};
      const name=normalizeSnapshotName(current.name);
      const snap=centreBackSnapshot.find(x=>x.match.some(m=>name.includes(m)));
      if(!snap)continue;
      const next={...current,...snap.patch,ovrUpdatedAt:'18/10/2026',manualSnapshotSource:'SoFIFA FC27 · user screenshots · 18/10/2026'};
      await pool.query('UPDATE squad_players SET data=$2::jsonb,updated_at=NOW() WHERE player_id=$1',[row.player_id,JSON.stringify(next)]);
      updated++;
    }
    console.log('[MANUAL_SQUAD_SNAPSHOT_CB]',JSON.stringify({updated,total:centreBackSnapshot.length}));
  }catch(e){console.warn('[MANUAL_SQUAD_SNAPSHOT_CB_ERROR]',e.message);}

  // Ensure Barça-owned players currently loaned out exist in the squad table.
  // The FC27 bootstrap only imports players whose current club is FC Barcelona,
  // so loaned-out players must be added explicitly.
  try{
    const normalizeSnapshotName=(v)=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
    const loanedOutSnapshot=[
      {
        playerId:'manual-loan-ter-stegen',
        match:['marc andre ter stegen','marc andre terstegen'],
        data:{
          name:'Marc-André ter Stegen',pos:'POR',alternatePositions:'',age:34,
          baseOvr:82,currentOvr:82,potential:90,value:5,wage:321000,
          role:'Importante',ownership:'Cedit fora',parentClub:'FC Barcelona',
          destinationClub:'Ajax',loanYears:1,contractYears:0,
          purchaseOptionType:'Sense opció',purchaseOptionValue:0,
          wageShareDepor:0,wageShareManual:false,
          minutes:0,goals:0,assists:0,realClub:'Ajax'
        }
      },
      {
        playerId:'manual-loan-diego-kochen',
        match:['diego kochen'],
        data:{
          name:'Diego Kochen',pos:'POR',alternatePositions:'',age:20,
          baseOvr:62,currentOvr:62,potential:79,value:0.35,wage:8000,
          role:'Promesa',ownership:'Cedit fora',parentClub:'FC Barcelona',
          destinationClub:'Lyngby Boldklub',loanYears:1,contractYears:0,
          purchaseOptionType:'Sense opció',purchaseOptionValue:0,
          wageShareDepor:0,wageShareManual:false,
          minutes:0,goals:0,assists:0,realClub:'Lyngby Boldklub'
        }
      },
      {
        playerId:'manual-loan-aron-yaakobishvili',
        match:['aron yaakobishvili'],
        data:{
          name:'Áron Yaakobishvili',pos:'POR',alternatePositions:'',age:20,
          baseOvr:69,currentOvr:69,potential:85,value:1.2,wage:18000,
          role:'Promesa',ownership:'Cedit fora',parentClub:'FC Barcelona',
          destinationClub:'UD Almería',loanYears:1,contractYears:0,
          purchaseOptionType:'Sense opció',purchaseOptionValue:0,
          wageShareDepor:0,wageShareManual:false,
          minutes:0,goals:0,assists:0,realClub:'UD Almería'
        }
      },
      {
        playerId:'manual-loan-ronald-araujo',
        match:['ronald araujo','ronald federico araujo da silva'],
        data:{
          name:'Ronald Araújo',pos:'DFC',alternatePositions:'LD',age:27,
          baseOvr:80,currentOvr:80,potential:86,value:19.5,wage:130000,
          role:'Importante',ownership:'Cedit fora',parentClub:'FC Barcelona',
          destinationClub:'Liverpool FC',loanYears:1,contractYears:0,
          purchaseOptionType:'Sense opció',purchaseOptionValue:0,
          wageShareDepor:0,wageShareManual:false,
          minutes:0,goals:0,assists:0,realClub:'Liverpool FC'
        }
      }
    ];

    const rows=await pool.query('SELECT player_id,data FROM squad_players');
    let inserted=0,updated=0;
    for(const snap of loanedOutSnapshot){
      const existing=rows.rows.find(r=>{
        const n=normalizeSnapshotName(r.data?.name);
        return snap.match.some(m=>n.includes(m));
      });
      const finalData={
        ...(existing?.data||{}),
        ...snap.data,
        playerId:existing?.data?.playerId||snap.playerId,
        ovrUpdatedAt:'18/10/2026',
        manualSnapshotSource:'SoFIFA FC27 · user screenshots · 18/10/2026'
      };
      if(existing){
        await pool.query('UPDATE squad_players SET data=$2::jsonb,updated_at=NOW() WHERE player_id=$1',
          [existing.player_id,JSON.stringify(finalData)]);
        updated++;
      }else{
        await pool.query(
          `INSERT INTO squad_players(player_id,data,updated_at)
           VALUES($1,$2::jsonb,NOW())
           ON CONFLICT(player_id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()`,
          [snap.playerId,JSON.stringify(finalData)]
        );
        inserted++;
      }
    }
    console.log('[ENSURE_LOANED_OUT]',JSON.stringify({inserted,updated,total:loanedOutSnapshot.length}));
  }catch(e){console.warn('[ENSURE_LOANED_OUT_ERROR]',e.message);}

  // Manual FC27 squad snapshot supplied by the user: defensive/central midfielders, 18 Oct 2026.
  try{
    const normalizeSnapshotName=(v)=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
    const midfieldSnapshot=[
      {id:'manual-mid-rodri',match:['rodrigo hernandez','rodrigo hernandez cascante','rodri'],data:{
        name:'Rodrigo Hernández Cascante',pos:'MCD',alternatePositions:'MC',age:30,
        baseOvr:90,currentOvr:90,potential:91,value:100,wage:258000,
        role:'Clave',ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:4,loanYears:0,purchaseOptionType:'Sense opció',purchaseOptionValue:0,
        wageShareDepor:100,wageShareManual:false,realClub:'FC Barcelona'
      }},
      {id:'manual-mid-marc-bernal',match:['marc bernal','marc bernal casas'],data:{
        name:'Marc Bernal Casas',pos:'MCD',alternatePositions:'MC',age:19,
        baseOvr:78,currentOvr:78,potential:88,value:13.5,wage:24000,
        role:'Rotación',ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:3,loanYears:0,purchaseOptionType:'Sense opció',purchaseOptionValue:0,
        wageShareDepor:100,wageShareManual:false,realClub:'FC Barcelona'
      }},
      {id:'manual-loan-marc-casado',match:['marc casado','marc casado torras'],data:{
        name:'Marc Casadó Torras',pos:'MCD',alternatePositions:'MC',age:22,
        baseOvr:78,currentOvr:78,potential:83,value:15,wage:95000,
        role:'Rotación',ownership:'Cedit fora',parentClub:'FC Barcelona',
        destinationClub:'RC Deportivo A Coruña',contractYears:0,loanYears:1,
        purchaseOptionType:'Sense opció',purchaseOptionValue:0,
        wageShareDepor:0,wageShareManual:false,realClub:'RC Deportivo A Coruña'
      }},
      {id:'manual-mid-frenkie',match:['frenkie de jong'],data:{
        name:'Frenkie de Jong',pos:'MC',alternatePositions:'MCD MCO',age:29,
        baseOvr:86,currentOvr:86,potential:87,value:66,wage:250000,
        role:'Clave',ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:3,loanYears:0,purchaseOptionType:'Sense opció',purchaseOptionValue:0,
        wageShareDepor:100,wageShareManual:false,realClub:'FC Barcelona'
      }},
      {id:'manual-mid-brian-farinas',match:['brian farinas','brian farinas perez'],data:{
        name:'Brian Fariñas Pérez',pos:'MC',alternatePositions:'MCD MCO',age:20,
        baseOvr:65,currentOvr:65,potential:81,value:0.825,wage:22000,
        role:'Promesa',ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:2,loanYears:0,purchaseOptionType:'Sense opció',purchaseOptionValue:0,
        wageShareDepor:100,wageShareManual:false,realClub:'FC Barcelona'
      }}
    ];
    const rows=await pool.query('SELECT player_id,data FROM squad_players');
    let inserted=0,updated=0;
    for(const snap of midfieldSnapshot){
      const existing=rows.rows.find(r=>{
        const n=normalizeSnapshotName(r.data?.name);
        return snap.match.some(m=>n.includes(m));
      });
      const finalData={
        ...(existing?.data||{}),...snap.data,
        playerId:existing?.data?.playerId||snap.id,
        ovrUpdatedAt:'18/10/2026',
        manualSnapshotSource:'SoFIFA FC27 · user screenshots · 18/10/2026'
      };
      if(existing){
        await pool.query('UPDATE squad_players SET data=$2::jsonb,updated_at=NOW() WHERE player_id=$1',
          [existing.player_id,JSON.stringify(finalData)]);
        updated++;
      }else{
        await pool.query(
          `INSERT INTO squad_players(player_id,data,updated_at)
           VALUES($1,$2::jsonb,NOW())
           ON CONFLICT(player_id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()`,
          [snap.id,JSON.stringify(finalData)]
        );
        inserted++;
      }
    }
    console.log('[MANUAL_SQUAD_SNAPSHOT_MID]',JSON.stringify({inserted,updated,total:midfieldSnapshot.length}));
  }catch(e){console.warn('[MANUAL_SQUAD_SNAPSHOT_MID_ERROR]',e.message);}

  // Manual FC27 squad snapshot supplied by the user: attacking/central midfielders, 18 Oct 2026.
  try{
    const normalizeSnapshotName=(v)=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
    const attackingMidSnapshot=[
      {id:'manual-mid-pedri',match:['pedro gonzalez lopez','pedri'],data:{
        name:'Pedro González López',pos:'MC',alternatePositions:'MCD MCO',age:23,
        baseOvr:90,currentOvr:90,potential:93,value:136.5,wage:240000,
        role:'Clave',ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:4,loanYears:0,purchaseOptionType:'Sense opció',purchaseOptionValue:0,
        wageShareDepor:100,wageShareManual:false,realClub:'FC Barcelona'
      }},
      {id:'manual-mid-fermin',match:['fermin lopez','fermin lopez marin'],data:{
        name:'Fermín López Marín',pos:'MCO',alternatePositions:'MC MI',age:23,
        baseOvr:85,currentOvr:85,potential:88,value:62,wage:180000,
        role:'Importante',ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:5,loanYears:0,purchaseOptionType:'Sense opció',purchaseOptionValue:0,
        wageShareDepor:100,wageShareManual:false,realClub:'FC Barcelona'
      }},
      {id:'manual-mid-dani-olmo',match:['daniel olmo carvajal','dani olmo'],data:{
        name:'Daniel Olmo Carvajal',pos:'MCO',alternatePositions:'MC MI EI',age:28,
        baseOvr:84,currentOvr:84,potential:85,value:42.5,wage:240000,
        role:'Importante',ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:4,loanYears:0,purchaseOptionType:'Sense opció',purchaseOptionValue:0,
        wageShareDepor:100,wageShareManual:false,realClub:'FC Barcelona'
      }},
      {id:'manual-mid-gavi',match:['pablo martin paez gavira','gavi'],data:{
        name:'Pablo Martín Páez Gavira',pos:'MC',alternatePositions:'MCD MI MCO EI',age:21,
        baseOvr:82,currentOvr:82,potential:85,value:35.5,wage:180000,
        role:'Importante',ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:4,loanYears:0,purchaseOptionType:'Sense opció',purchaseOptionValue:0,
        wageShareDepor:100,wageShareManual:false,realClub:'FC Barcelona'
      }}
    ];
    const rows=await pool.query('SELECT player_id,data FROM squad_players');
    let inserted=0,updated=0;
    for(const snap of attackingMidSnapshot){
      const existing=rows.rows.find(r=>{
        const n=normalizeSnapshotName(r.data?.name);
        return snap.match.some(m=>n.includes(m));
      });
      const finalData={
        ...(existing?.data||{}),...snap.data,
        playerId:existing?.data?.playerId||snap.id,
        ovrUpdatedAt:'18/10/2026',
        manualSnapshotSource:'SoFIFA FC27 · user screenshots · 18/10/2026'
      };
      if(existing){
        await pool.query('UPDATE squad_players SET data=$2::jsonb,updated_at=NOW() WHERE player_id=$1',
          [existing.player_id,JSON.stringify(finalData)]);
        updated++;
      }else{
        await pool.query(
          `INSERT INTO squad_players(player_id,data,updated_at)
           VALUES($1,$2::jsonb,NOW())
           ON CONFLICT(player_id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()`,
          [snap.id,JSON.stringify(finalData)]
        );
        inserted++;
      }
    }
    console.log('[MANUAL_SQUAD_SNAPSHOT_AM]',JSON.stringify({inserted,updated,total:attackingMidSnapshot.length}));
  }catch(e){console.warn('[MANUAL_SQUAD_SNAPSHOT_AM_ERROR]',e.message);}

  // Manual FC27 squad snapshot supplied by the user: Dominik Livakovic, 18 Oct 2026.
  try{
    const normalizeSnapshotName=(v)=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
    const snap={
      id:'manual-gk-livakovic',
      match:['dominik livakovic'],
      data:{
        name:'Dominik Livaković',pos:'POR',alternatePositions:'',age:31,
        baseOvr:78,currentOvr:78,potential:82,value:7.5,wage:76000,
        role:'Rotación',ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:4,loanYears:0,purchaseOptionType:'Sense opció',purchaseOptionValue:0,
        wageShareDepor:100,wageShareManual:false,realClub:'FC Barcelona'
      }
    };
    const rows=await pool.query('SELECT player_id,data FROM squad_players');
    const existing=rows.rows.find(r=>{
      const n=normalizeSnapshotName(r.data?.name);
      return snap.match.some(m=>n.includes(m));
    });
    const finalData={
      ...(existing?.data||{}),...snap.data,
      playerId:existing?.data?.playerId||snap.id,
      ovrUpdatedAt:'18/10/2026',
      manualSnapshotSource:'SoFIFA FC27 · user screenshot · 18/10/2026'
    };
    if(existing){
      await pool.query('UPDATE squad_players SET data=$2::jsonb,updated_at=NOW() WHERE player_id=$1',
        [existing.player_id,JSON.stringify(finalData)]);
      console.log('[MANUAL_SQUAD_SNAPSHOT_LIVAKOVIC]',JSON.stringify({updated:1,inserted:0}));
    }else{
      await pool.query(
        `INSERT INTO squad_players(player_id,data,updated_at)
         VALUES($1,$2::jsonb,NOW())
         ON CONFLICT(player_id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()`,
        [snap.id,JSON.stringify(finalData)]
      );
      console.log('[MANUAL_SQUAD_SNAPSHOT_LIVAKOVIC]',JSON.stringify({updated:0,inserted:1}));
    }
  }catch(e){console.warn('[MANUAL_SQUAD_SNAPSHOT_LIVAKOVIC_ERROR]',e.message);}

  // Manual FC27 squad snapshot supplied by the user: wingers / forwards, 18 Oct 2026.
  try{
    const normalizeSnapshotName=(v)=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
    const forwardSnapshot=[
      {id:'manual-fw-lamine',match:['lamine yamal','lamine yamal nasraoui ebana'],data:{
        name:'Lamine Yamal Nasraoui Ebana',pos:'ED',alternatePositions:'MD',age:18,
        baseOvr:90,currentOvr:90,potential:95,value:124.5,wage:401000,
        role:'Clave',ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:5,loanYears:0,purchaseOptionType:'Sense opció',purchaseOptionValue:0,
        wageShareDepor:100,wageShareManual:false,realClub:'FC Barcelona'
      }},
      {id:'manual-fw-raphinha',match:['raphael dias belloli','raphinha'],data:{
        name:'Raphael Dias Belloli',pos:'EI',alternatePositions:'ED MCO MI MD DC',age:29,
        baseOvr:89,currentOvr:89,potential:90,value:101,wage:321000,
        role:'Clave',ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:2,loanYears:0,purchaseOptionType:'Sense opció',purchaseOptionValue:0,
        wageShareDepor:100,wageShareManual:false,realClub:'FC Barcelona'
      }},
      {id:'manual-fw-anthony-gordon',match:['anthony michael gordon','anthony gordon'],data:{
        name:'Anthony Michael Gordon',pos:'EI',alternatePositions:'DC MI',age:25,
        baseOvr:82,currentOvr:82,potential:85,value:34,wage:231000,
        role:'Importante',ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:5,loanYears:0,purchaseOptionType:'Sense opció',purchaseOptionValue:0,
        wageShareDepor:100,wageShareManual:false,realClub:'FC Barcelona'
      }},
      {id:'manual-fw-adeyemi',match:['karim david adeyemi','karim adeyemi'],data:{
        name:'Karim-David Adeyemi',pos:'EI',alternatePositions:'ED MCO MI MD DC',age:24,
        baseOvr:82,currentOvr:82,potential:85,value:35,wage:240000,
        role:'Importante',ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:5,loanYears:0,purchaseOptionType:'Sense opció',purchaseOptionValue:0,
        wageShareDepor:100,wageShareManual:false,realClub:'FC Barcelona'
      }},
      {id:'manual-fw-gabriel-jesus',match:['gabriel fernando de jesus','gabriel jesus'],data:{
        name:'Gabriel Fernando de Jesus',pos:'DC',alternatePositions:'MCO',age:29,
        baseOvr:79,currentOvr:79,potential:84,value:17.5,wage:145000,
        role:'Rotación',ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:3,loanYears:0,purchaseOptionType:'Sense opció',purchaseOptionValue:0,
        wageShareDepor:100,wageShareManual:false,realClub:'FC Barcelona'
      }},
      {id:'manual-fw-bisiwu',match:['jesse eugen bisiwu','jesse bisiwu'],data:{
        name:'Jesse Eugen Bisiwu',pos:'EI',alternatePositions:'ED DC MI MD',age:18,
        baseOvr:67,currentOvr:67,potential:85,value:1.1,wage:30000,
        role:'Promesa',ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:5,loanYears:0,purchaseOptionType:'Sense opció',purchaseOptionValue:0,
        wageShareDepor:100,wageShareManual:false,realClub:'FC Barcelona'
      }},
      {id:'manual-fw-hamza',match:['hamza mohamed abdelkarim selim','hamza abdelkarim'],data:{
        name:'Hamza Mohamed Abdelkarim Selim',pos:'DC',alternatePositions:'',age:18,
        baseOvr:65,currentOvr:65,potential:84,value:0.775,wage:22000,
        role:'Promesa',ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:4,loanYears:0,purchaseOptionType:'Sense opció',purchaseOptionValue:0,
        wageShareDepor:100,wageShareManual:false,realClub:'FC Barcelona'
      }},
      {id:'manual-fw-bardghji',match:['roony bardghji'],data:{
        name:'Roony Bardghji',pos:'ED',alternatePositions:'MD',age:20,
        baseOvr:74,currentOvr:74,potential:85,value:4.8,wage:20000,
        role:'Rotación',ownership:'Propietat',parentClub:'',destinationClub:'',
        contractYears:3,loanYears:0,purchaseOptionType:'Sense opció',purchaseOptionValue:0,
        wageShareDepor:100,wageShareManual:false,realClub:'FC Barcelona'
      }},
      {id:'manual-loan-antonio-fernandez',match:['antonio fernandez casino','antonio fernandez'],data:{
        name:'Antonio Fernández Casino',pos:'ED',alternatePositions:'MD',age:17,
        baseOvr:65,currentOvr:65,potential:84,value:0.725,wage:17000,
        role:'Promesa',ownership:'Cedit fora',parentClub:'FC Barcelona',
        destinationClub:'Venezia FC',contractYears:0,loanYears:1,
        purchaseOptionType:'Sense opció',purchaseOptionValue:0,
        wageShareDepor:0,wageShareManual:false,realClub:'Venezia FC'
      }}
    ];
    const rows=await pool.query('SELECT player_id,data FROM squad_players');
    let inserted=0,updated=0;
    for(const snap of forwardSnapshot){
      const existing=rows.rows.find(r=>{
        const n=normalizeSnapshotName(r.data?.name);
        return snap.match.some(m=>n.includes(m));
      });
      const finalData={
        ...(existing?.data||{}),...snap.data,
        playerId:existing?.data?.playerId||snap.id,
        ovrUpdatedAt:'18/10/2026',
        manualSnapshotSource:'SoFIFA FC27 · user screenshots · 18/10/2026'
      };
      if(existing){
        await pool.query('UPDATE squad_players SET data=$2::jsonb,updated_at=NOW() WHERE player_id=$1',
          [existing.player_id,JSON.stringify(finalData)]);
        updated++;
      }else{
        await pool.query(
          `INSERT INTO squad_players(player_id,data,updated_at)
           VALUES($1,$2::jsonb,NOW())
           ON CONFLICT(player_id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()`,
          [snap.id,JSON.stringify(finalData)]
        );
        inserted++;
      }
    }
    console.log('[MANUAL_SQUAD_SNAPSHOT_FW]',JSON.stringify({inserted,updated,total:forwardSnapshot.length}));
  }catch(e){console.warn('[MANUAL_SQUAD_SNAPSHOT_FW_ERROR]',e.message);}

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

async function enrichBarcaSquadFinancials(){
  if(!pool) return {updated:0,failed:0,total:0};
  const rows=await pool.query('SELECT player_id,data FROM squad_players ORDER BY updated_at ASC');
  const squad=rows.rows.map(r=>({playerId:r.player_id,data:r.data||{}}));
  if(!squad.length) return {updated:0,failed:0,total:0};

  let updated=0,failed=0;
  const work=squad.filter(x=>!Number(x.data.wage||0) || !Number(x.data.value||0));

  // Keep concurrency deliberately low: this is a one-time financial enrichment,
  // not a scraper that should hammer the upstream source.
  const queue=[...work];
  const workers=Array.from({length:4},async()=>{
    while(queue.length){
      const item=queue.shift();
      if(!item)break;
      const p=item.data;
      try{
        const results=await searchPlayers(p.name||'');
        let detail=null;
        for(const ref of results.slice(0,3)){
          try{
            const html=await fetchHtml(ref.url);
            const parsed=parseDetails(html,ref);
            const n1=String(parsed.name||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
            const n2=String(p.name||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
            if(n1===n2 || n1.includes(n2) || n2.includes(n1)){
              detail=parsed;break;
            }
          }catch(e){}
        }
        if(detail && (Number(detail.wage||0)>0 || Number(detail.value||0)>0)){
          const next={...p};
          if(Number(detail.wage||0)>0)next.wage=Number(detail.wage);
          if(Number(detail.value||0)>0)next.value=Number(detail.value)/1e6;
          next.financeSource='FC Tools Hub';
          next.financeUpdatedAt=new Date().toISOString();
          await pool.query(
            'UPDATE squad_players SET data=$2::jsonb,updated_at=NOW() WHERE player_id=$1',
            [item.playerId,JSON.stringify(next)]
          );
          updated++;
        }else failed++;
      }catch(e){
        failed++;
      }
    }
  });
  await Promise.all(workers);

  const fresh=await pool.query('SELECT player_id,data FROM squad_players ORDER BY updated_at ASC');
  const initialWageByPlayer={};
  for(const row of fresh.rows){
    const p=row.data||{};
    const wage=Number(p.wage||0);
    let share=100;
    if(p.ownership==='Cedit fora')share=Math.max(0,Math.min(100,Number(p.wageShareDepor||0)));
    else if(p.ownership==='Cedit al Barça')share=Math.max(0,Math.min(100,Number(p.wageShareDepor||100)));
    initialWageByPlayer[row.player_id]=wage*(share/100);
  }
  const totalInitialWages=Object.values(initialWageByPlayer).reduce((a,v)=>a+Number(v||0),0);

  if(totalInitialWages>0){
    const stateRow=await pool.query('SELECT data FROM career_state WHERE id=$1',['main']);
    const stateData=stateRow.rows[0]?.data&&typeof stateRow.rows[0].data==='object'?{...stateRow.rows[0].data}:{};
    stateData.finance={
      ...(stateData.finance||{}),
      initialBudget:CLUB_CONFIG.initialBudget,
      budgetSource:CLUB_CONFIG.budgetSource,
      budgetBaselineSeason:'2026/27',
      initialWageByPlayer,
      baselineLocked:true,
      initialWageCapturedAt:new Date().toISOString(),
      wageBaselineSource:'FC Tools Hub · FC27 player wages',
      initialWeeklyWages:totalInitialWages
    };
    stateData._clientUpdatedAt=Date.now();
    await pool.query(
      `INSERT INTO career_state(id,data,updated_at)
       VALUES($1,$2::jsonb,NOW())
       ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()`,
      ['main',JSON.stringify(stateData)]
    );
  }

  console.log('[BARCA_FINANCE_ENRICH]',JSON.stringify({updated,failed,total:squad.length,totalInitialWages}));
  return {updated,failed,total:squad.length,totalInitialWages};
}


async function buildDirectorAiContext(){
  const stateRow=await pool.query('SELECT data FROM career_state WHERE id=$1',['main']);
  const state=stateRow.rows[0]?.data||{};
  const rawSquad=await readDedicatedSquad();
  const squad=rawSquad.filter(p=>!(p?.ownership==='Cedit fora'||String(p?.destinationClub||'').trim()));
  const loanedOut=rawSquad.filter(p=>(p?.ownership==='Cedit fora'||String(p?.destinationClub||'').trim()));
  const finance=state.finance||{};
  const transfers=Array.isArray(state.transfers)?state.transfers:[];
  const matches=Array.isArray(state.matches)?state.matches:[];
  const lineup=state.lineup||{starters:{},bench:[]};

  const players=squad.map(p=>({
    name:p.name,pos:positionEs(p.pos),age:Number(p.age||0),role:p.role||'',
    ovr:Number(p.currentOvr||p.ovr||p.baseOvr||0),
    minutes:Number(p.minutes||0),goals:Number(p.goals||0),assists:Number(p.assists||0),
    contractYears:Number(p.contractYears||0),wage:Number(p.wage||0),value:Number(p.value||0),
    ownership:p.ownership||'Propietat'
  }));

  const expenseTypes=new Set(['Compra','Cessió entrada','Agent lliure']);
  const incomeTypes=new Set(['Venda','Cessió sortida']);
  const transferSpend=transfers.filter(t=>expenseTypes.has(t.type)).reduce((a,t)=>a+Number(t.amount||0),0);
  const transferIncome=transfers.filter(t=>incomeTypes.has(t.type)).reduce((a,t)=>a+Number(t.amount||0),0);
  const availableBudget=Number(CLUB_CONFIG.initialBudget)+(transferIncome*.70)-transferSpend;

  const positionDepth={};
  for(const p of players){
    const key=String(p.pos||'Sense posició');
    positionDepth[key]=(positionDepth[key]||0)+1;
  }

  const keyRoles=new Set(['Clau','Important','Crucial','Key','Important player']);
  const corePlayers=players
    .filter(p=>keyRoles.has(String(p.role||''))||p.ovr>=84)
    .sort((a,b)=>b.ovr-a.ovr)
    .slice(0,12)
    .map(p=>({name:p.name,pos:positionEs(p.pos),ovr:p.ovr,role:p.role,minutes:p.minutes}));

  const youngPlayers=players
    .filter(p=>p.age>0&&p.age<=21)
    .sort((a,b)=>b.ovr-a.ovr)
    .slice(0,10)
    .map(p=>({name:p.name,pos:positionEs(p.pos),age:p.age,ovr:p.ovr,role:p.role,minutes:p.minutes}));

  const formationMap={
    '4-3-3':['GK','LB','CB','CB','RB','CM','CM','CAM','RW','LW','ST'],
    '4-2-3-1':['GK','RB','CB','CB','LB','CDM','CDM','CAM','RW','LW','ST'],
    '4-4-2':['GK','RB','CB','CB','LB','RM','CM','CM','LM','ST','ST'],
    '3-4-3':['GK','CB','CB','CB','RM','CM','CM','LM','RW','LW','ST'],
    '3-5-2':['GK','CB','CB','CB','RM','CM','CDM','CM','LM','ST','ST'],
    '4-1-4-1':['GK','RB','CB','CB','LB','CDM','RM','CM','CM','LM','ST'],
    '4-3-2-1':['GK','RB','CB','CB','LB','CM','CDM','CM','CAM','CAM','ST'],
    '5-3-2':['GK','RB','CB','CB','CB','LB','CM','CDM','CM','ST','ST']
  };
  const tactic=state.tactic||'4-3-3';
  const slots=formationMap[tactic]||formationMap['4-3-3'];
  const counts={};
  const slotKeys=slots.map(slot=>{
    counts[slot]=(counts[slot]||0)+1;
    return slot+'-'+counts[slot];
  });
  const playerById=new Map(squad.map(p=>[p.playerId,p]));
  const starterIds=new Set(Object.values(lineup.starters||{}).filter(Boolean));
  const benchIds=new Set((lineup.bench||[]).filter(Boolean));
  const startingXI=slotKeys.map((key,i)=>{
    const p=playerById.get(lineup.starters?.[key]);
    return p?{
      slot:positionEs(slots[i]),name:p.name,pos:positionEs(p.pos),ovr:Number(p.currentOvr||p.ovr||p.baseOvr||0),
      role:p.role||'',age:Number(p.age||0),minutes:Number(p.minutes||0)
    }:{slot:positionEs(slots[i]),name:null};
  });
  const benchPlayers=(lineup.bench||[]).map(id=>playerById.get(id)).filter(Boolean).map(p=>({
    name:p.name,pos:positionEs(p.pos),ovr:Number(p.currentOvr||p.ovr||p.baseOvr||0),
    role:p.role||'',age:Number(p.age||0),minutes:Number(p.minutes||0)
  }));
  const outsideRotation=squad.filter(p=>!starterIds.has(p.playerId)&&!benchIds.has(p.playerId)).map(p=>({
    name:p.name,pos:positionEs(p.pos),ovr:Number(p.currentOvr||p.ovr||p.baseOvr||0),
    role:p.role||'',age:Number(p.age||0),minutes:Number(p.minutes||0)
  }));
  const lineupDefined=startingXI.filter(x=>x.name).length;

  const played=matches.length;
  const points=matches.reduce((sum,m)=>{
    const gf=Number(m.goalsFor??m.gf??m.homeGoals??0);
    const ga=Number(m.goalsAgainst??m.ga??m.awayGoals??0);
    return sum+(gf>ga?3:gf===ga?1:0);
  },0);

  return {
    club:CLUB_CONFIG.name,
    season:state.season||'2026/27',
    target:state.target||CLUB_CONFIG.target,
    projectStage:state.projectStage||CLUB_CONFIG.projectStage,
    tactic,
    clubStatus:state.clubStatus||CLUB_CONFIG.clubStatus,
    squadSize:players.length,
    loanedOut:loanedOut.map(p=>({
      name:p.name,pos:positionEs(p.pos),age:Number(p.age||0),ovr:Number(p.currentOvr||p.ovr||p.baseOvr||0),
      destinationClub:p.destinationClub||'',loanYears:Number(p.loanYears||0)
    })),
    rotation:{
      lineupDefined,
      startingXI,
      bench:benchPlayers,
      outsideRotation
    },
    finance:{
      openingBudgetM:Number(CLUB_CONFIG.initialBudget),
      transferSpendM:transferSpend,
      transferIncomeM:transferIncome,
      reinvestmentRate:0.70,
      availableBudgetM:Number(availableBudget.toFixed(2)),
      weeklyWageBaseline:Number(finance.initialWeeklyWages||4800000)
    },
    sporting:{
      matchesPlayed:played,
      points,
      pointsPerGame:played?Number((points/played).toFixed(2)):0,
      currentPosition:state.position||null
    },
    lineupRaw:lineup,
    positionDepth,
    corePlayers,
    youngPlayers,
    players,
    recentTransfers:transfers.slice(-12),
    recentMatches:matches.slice(-8),
    rules:Array.isArray(state.rules)?state.rules.slice(0,20):[]
  };
}

function directorPrompt(context){
  return `Ets el Director Esportiu del FC Barcelona en un mode carrera realista de FC27. La teva feina no és agradar a l'usuari: és ajudar-lo a guanyar mantenint una plantilla coherent i sostenible.

PERSONALITAT I CRITERI
- Parla sempre en català, de forma natural, directa i professional.
- Les posicions s'han d'anomenar sempre amb les abreviatures del joc en espanyol: POR, LD, DFC, LI, CAD, CAI, MCD, MC, MCO, MD, MI, ED, EI, SD i DC. No utilitzis GK, RB, CB, LB, CDM, CM, CAM, RM, LM, RW, LW, CF o ST en les respostes.
- Actua com un director esportiu experimentat en una reunió interna, no com un chatbot.
- Pren partit. Si una idea de l'usuari és dolenta, digues-ho clarament i proposa una alternativa millor.
- Evita respostes neutres del tipus "depèn" quan hi ha prou informació per decidir.
- Prioritza guanyar LaLiga i competir al màxim nivell europeu, sense perdre coherència de plantilla.
- Separa una bona oportunitat de mercat d'una necessitat real. No fitxis per fitxar.

COM HAS DE DECIDIR
- Valora conjuntament OVR actual, rol, minuts, edat, contracte, profunditat de posició, salari, valor, propietat, pressupost i equilibri de vestidor.
- L'alineació manual és una dada prioritària de jerarquia. Si rotation.lineupDefined és alt, tracta rotation.startingXI com el pla titular actual, rotation.bench com la rotació immediata i rotation.outsideRotation com els jugadors que ara mateix tenen menys espai.
- Els jugadors de loanedOut estan cedits fora: NO formen part de la plantilla activa, NO poden ocupar alineació o rotació actual, i només els has de valorar com a actius cedits que poden tornar en el futur.
- No ignoris l'alineació quan recomanis vendes, cessions o fitxatges: abans de dir que sobra o falta un perfil, comprova qui ocupa aquell lloc al XI i qui hi ha a la banqueta.
- Si un jugador és titular a rotation.startingXI, parteix de la hipòtesi que és important per al projecte encara que tingui pocs minuts registrats. Si és a la banqueta, considera'l rotació abans de proposar una cessió.
- La jerarquia esportiva pesa més que els minuts si la temporada tot just comença.
- No recomanis cedir o vendre una estrella, titular o jugador clau només perquè encara té pocs minuts.
- Per a joves, diferencia entre: quedar-se a rotació, cessió amb minuts garantits o venda. No assumeixis que "jove = cedir".
- Per a veterans, diferencia entre rendiment immediat, salari, rol i risc de bloquejar minuts.
- En renovacions, protegeix la jerarquia salarial i no premiïs automàticament qualsevol exigència.
- En vendes, dona una decisió clara: vendre / escoltar ofertes / quedar-se / intocable. Si és possible, fixa una xifra mínima o rang.
- En fitxatges, primer identifica si hi ha una necessitat real per posició; després defineix el perfil. Si l'usuari proposa un jugador concret, jutja l'encaix, no el prestigi.
- En cessions, només recomana una sortida si el jugador no té un camí creïble de minuts i la cessió té sentit esportiu.
- En negociacions, dona una línia vermella concreta quan les dades ho permetin.
- Si hi ha diverses opcions bones, ordena-les i escull-ne una com a primera opció.

DISCIPLINA DE DADES
- No utilitzis potencial ocult, wonderkid lists ni informació externa que no aparegui al context.
- No inventis salaris, contractes, ofertes, minuts, lesions o dades financeres.
- Si una dada falta però no és determinant, decideix amb la resta i no omplis la resposta de disclaimers.
- Si una dada absent és decisiva, demana només aquella dada concreta.

FORMAT
- Respostes habituals de 1 a 3 paràgrafs.
- Comença per la decisió, no per un resum de dades.
- Pots fer una llista curta si compares diversos jugadors.
- Evita repetir números innecessàriament.
- Mantén continuïtat amb la conversa recent i recorda decisions ja discutides dins de l'historial.
- No utilitzis HTML.

CONTEXT ACTUAL DE LA CARRERA:
${JSON.stringify(context)}`;
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
function positionEs(pos){
  const key=String(pos||'').trim().toUpperCase().replace(/\s+/g,'');
  const map={GK:'POR',POR:'POR',RB:'LD',LD:'LD',RWB:'CAD',CAD:'CAD',LB:'LI',LI:'LI',LWB:'CAI',CAI:'CAI',
    CB:'DFC',DFC:'DFC',CDM:'MCD',MCD:'MCD',CM:'MC',MC:'MC',CAM:'MCO',MCO:'MCO',
    RM:'MD',MD:'MD',LM:'MI',MI:'MI',RW:'ED',ED:'ED',LW:'EI',EI:'EI',CF:'SD',SD:'SD',ST:'DC',DC:'DC'};
  return map[key]||pos||'—';
}
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
  return '<tr data-server-row="1"><td><strong>'+escHtml(p.name||'')+'</strong></td><td>'+escHtml(positionEs(p.pos))+'</td><td>'+escHtml(p.age||'—')+'</td><td>'+escHtml(p.role||'—')+'</td><td>'+escHtml(link)+'</td><td>'+escHtml(duration)+'</td><td>'+(base||'—')+'</td><td><strong>'+(cur||'—')+'</strong></td><td>'+(delta>0?'+':'')+delta+'</td><td>'+escHtml(p.ovrUpdatedAt||'—')+'</td><td>'+value+'</td><td>'+wage+'</td><td>'+(own==='Cedit al Barça'?'—':escHtml(duration))+'</td><td><button class="ghost-btn" onclick="editSquadPlayer('+i+')">Fitxa</button> <button class="ghost-btn" onclick="updatePlayerOvr('+i+')">OVR</button></td></tr>';
}
function serverLoanRow(p,i){
  const cur=n(p.currentOvr||p.ovr||p.baseOvr);
  const value=n(p.value),wage=n(p.wage)/1000;
  return '<tr data-server-row="1"><td><strong>'+escHtml(p.name||'')+'</strong></td><td>'+escHtml(positionEs(p.pos))+'</td><td>'+escHtml(p.age||'—')+'</td><td>'+escHtml(p.destinationClub||'—')+'</td><td>'+(n(p.loanYears)?n(p.loanYears)+' anys':'—')+'</td><td>'+(cur||'—')+'</td><td>'+value+'</td><td>'+wage+'</td><td>'+n(p.wageShareDepor)+'%</td><td>'+(p.purchaseOptionType==='Opció de compra'&&n(p.purchaseOptionValue)?n(p.purchaseOptionValue)+' M€':'—')+'</td><td><button class="ghost-btn" onclick="returnLoanedPlayer('+i+')">Retorna</button> <button class="ghost-btn" onclick="editSquadPlayer('+i+')">Fitxa</button></td></tr>';
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

    const rawCurrentWages = dedicatedSquad.reduce((sum,p)=>sum+wageContribution(p),0);
    const initialMap = finance.initialWageByPlayer && typeof finance.initialWageByPlayer === 'object'
      ? finance.initialWageByPlayer : {};
    const mappedInitialWages = Object.values(initialMap).reduce((sum,v)=>sum+Number(v||0),0);
    let initialWages = Number(finance.initialWeeklyWages||0) || mappedInitialWages || 4800000;
    const hasUsableInitialPlayerWagesSSR = mappedInitialWages > initialWages*.5;
    const knownPostStartDeltaSSR = dedicatedSquad.reduce((sum,p)=>{
      const now=wageContribution(p);
      if(!(p.playerId in initialMap))return sum+now;
      const before=Number(initialMap[p.playerId]||0);
      if(before>0)return sum+(now-before);
      return sum;
    },0);
    let currentWages = hasUsableInitialPlayerWagesSSR ? rawCurrentWages : initialWages + knownPostStartDeltaSSR;

    if (!Number(finance.initialWeeklyWages||0) && !Object.values(initialMap).some(v=>Number(v||0)>0) && dedicatedSquad.length >= 18) {
      const snap = {};
      dedicatedSquad.forEach(p => { if (p.playerId) snap[p.playerId] = wageContribution(p); });
      finance.initialWageByPlayer = snap;
      finance.baselineLocked = true;
      finance.initialWageCapturedAt = finance.initialWageCapturedAt || new Date().toISOString();
      initialWages = currentWages;
      currentWages = rawCurrentWages > 0 ? rawCurrentWages : initialWages;
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
      return json(res,200,{build:'2026-10-17-barca-finance',commit:'wage-baseline-v1'});
    }

    if (u.pathname === '/health') {
      return json(res, 200, {
        ok:true,
        service:'barca-career-director',
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

    if (u.pathname === '/api/director/chat' && req.method === 'POST') {
      console.log('[DIRECTOR_AI_REQUEST]', JSON.stringify({
        configured:Boolean(process.env.GROQ_API_KEY),
        model:process.env.DIRECTOR_AI_MODEL||'openai/gpt-oss-120b'
      }));
      if (!dbReady) return json(res,503,{error:'Base de dades no configurada.'});
      const body=await readBody(req);
      const message=String(body?.message||'').trim();
      const history=Array.isArray(body?.history)?body.history.slice(-12):[];
      if(!message)return json(res,400,{error:'Falta el missatge.'});

      if(!process.env.GROQ_API_KEY){
        return json(res,503,{error:'Director AI conversacional no configurat.',code:'AI_NOT_CONFIGURED'});
      }

      const context=await buildDirectorAiContext();
      const input=[
        ...history.map(x=>({role:x.role==='assistant'?'assistant':'user',content:String(x.content||'').slice(0,3000)})),
        {role:'user',content:message}
      ];

      const rr=await fetch('https://api.groq.com/openai/v1/chat/completions',{
        method:'POST',
        headers:{
          'authorization':'Bearer '+process.env.GROQ_API_KEY,
          'content-type':'application/json'
        },
        body:JSON.stringify({
          model:process.env.DIRECTOR_AI_MODEL||'openai/gpt-oss-120b',
          messages:[{role:'system',content:directorPrompt(context)},...input],
          temperature:0.65,
          max_completion_tokens:700
        })
      });

      const data=await rr.json();
      if(!rr.ok){
        console.error('[DIRECTOR_AI_ERROR]',JSON.stringify({
          status:rr.status,
          model:process.env.DIRECTOR_AI_MODEL||'openai/gpt-oss-120b',
          error:data?.error?.message||data?.error||data
        }));
        return json(res,502,{error:'El Director AI no ha pogut respondre.'});
      }
      console.log('[DIRECTOR_AI_OK]',JSON.stringify({
        model:data.model||process.env.DIRECTOR_AI_MODEL||'openai/gpt-oss-120b',
        chars:String(data?.choices?.[0]?.message?.content||'').length
      }));
      const answer=String(data?.choices?.[0]?.message?.content||'').trim()||'No he pogut construir una resposta útil.';
      return json(res,200,{answer,model:data.model||process.env.DIRECTOR_AI_MODEL||'openai/gpt-oss-120b'},'no-store');
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
      const rawCurrentWages=squad.reduce((a,p)=>a+wageContribution(p),0);
      const baseline=finance.initialWageByPlayer&&typeof finance.initialWageByPlayer==='object'?finance.initialWageByPlayer:{};
      const mappedInitial=Object.values(baseline).reduce((a,v)=>a+Number(v||0),0);
      const initialWages=Number(finance.initialWeeklyWages||0)||mappedInitial||4800000;
      const hasUsableInitialPlayerWages=mappedInitial>initialWages*.5;
      const knownPostStartDelta=squad.reduce((sum,p)=>{
        const now=wageContribution(p);
        if(!(p.playerId in baseline)) return sum+now;
        const before=Number(baseline[p.playerId]||0);
        if(before>0) return sum+(now-before);
        return sum;
      },0);
      const currentWages=hasUsableInitialPlayerWages?rawCurrentWages:initialWages+knownPostStartDelta;
      const transfers=Array.isArray(stateData.transfers)?stateData.transfers:[];
      const expenseTypes=new Set(['Compra','Cessió entrada','Agent lliure']);
      const incomeTypes=new Set(['Venda','Cessió sortida']);
      const transferSpend=transfers.filter(t=>expenseTypes.has(t.type)).reduce((a,t)=>a+Number(t.amount||0),0);
      const transferIncome=transfers.filter(t=>incomeTypes.has(t.type)).reduce((a,t)=>a+Number(t.amount||0),0);
      const initialBudget=CLUB_CONFIG.initialBudget;
      const available=initialBudget+(transferIncome*.70)-transferSpend;
      const wageGrowth=initialWages?(currentWages-initialWages)/initialWages:0;
      const ownedWages=hasUsableInitialPlayerWages
        ?squad.filter(p=>(p.ownership||'Propietat')==='Propietat').reduce((a,p)=>a+wageContribution(p),0)
        :currentWages;
      const incomingLoanWages=hasUsableInitialPlayerWages?squad.filter(p=>p.ownership==='Cedit al Barça').reduce((a,p)=>a+wageContribution(p),0):0;
      const outgoingLoanWages=hasUsableInitialPlayerWages?squad.filter(p=>p.ownership==='Cedit fora').reduce((a,p)=>a+wageContribution(p),0):0;
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
      stateToSave.finance={
        ...(stateToSave.finance||{}),
        initialBudget:CLUB_CONFIG.initialBudget,
        initialWeeklyWages:Number(currentState.finance?.initialWeeklyWages||4800000),
        wageBaselineSource:currentState.finance?.wageBaselineSource||'FAFIFA · FC Barcelona FC27 · 7 Oct 2026',
        initialWageByPlayer:currentState.finance?.initialWageByPlayer||stateToSave.finance?.initialWageByPlayer||{},
        baselineLocked:true
      };
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
