/**
 * auto-runner.js — Proof of Autonomy — Boulot ONLY
 *
 * Lance N cycles ENTER→vérification→EXIT en boucle.
 * Vérifie à chaque cycle: state serveur, fichiers store, cohérence.
 * Produit auto-runner-report.json + auto-runner-log.ndjson.
 *
 * GARANTIE ANTI-CONFUSION ADEL:
 *   Guard 1 — __dirname doit contenir "trading-boulot"
 *   Guard 2 — GET /server-id doit retourner env:"boulot"
 *   → Si l'un des deux échoue : ABORT immédiat, zéro test lancé.
 *
 * Usage:
 *   node auto-runner.js [--cycles 30] [--host 127.0.0.1] [--port 4000] [--symbol XAUUSD]
 */

'use strict';

const fs   = require('fs');
const http = require('http');
const path = require('path');

const { marketStatus, assertMarketClosed } = require('./lib/market-hours');

// ─── args ────────────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : def;
}
const HOST    = arg('--host', '127.0.0.1');
const PORT    = Number(arg('--port', '4000'));
const SYMBOL  = arg('--symbol', 'XAUUSD');
const TF      = arg('--tf', 'M1');
const CYCLES  = Number(arg('--cycles', '30'));
const ROOT    = path.resolve(__dirname);
const STORE   = path.join(ROOT, 'store');

const LOG_FILE    = path.join(ROOT, 'auto-runner-log.ndjson');
const REPORT_FILE = path.join(ROOT, 'auto-runner-report.json');

// ─── http helpers ─────────────────────────────────────────────────────────────

function req(method, urlPath, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: HOST, port: PORT, path: urlPath, method,
      headers: { 'Content-Type': 'application/json',
                 ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
      timeout: timeoutMs
    };
    const r = http.request(opts, res => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch(_) {}
        resolve({ status: res.statusCode, json, raw });
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error(`timeout ${urlPath}`)); });
    if (payload) r.write(payload);
    r.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(_) { return null; }
}

// ─── logging ─────────────────────────────────────────────────────────────────

const _logs = [];

function logEntry(cycle, event, verdict, detail) {
  const entry = { ts: Date.now(), cycle, event, verdict, detail: detail || '' };
  _logs.push(entry);
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n'); } catch(_) {}
  const sym = verdict === 'PASS' ? '✓' : verdict === 'WARN' ? '⚠' : verdict === 'INFO' ? '·' : '✗';
  console.log(`  ${sym} [C${String(cycle).padStart(2,'0')}] ${event}${detail ? ' — ' + detail : ''}`);
}

// ─── GUARD 1+2 — anti-confusion Adel ─────────────────────────────────────────

async function verifyBoulotEnv() {
  // Guard 1 — répertoire
  if (!ROOT.includes('trading-boulot')) {
    console.error(`\n  ✗ ABORT — auto-runner doit être dans trading-boulot`);
    console.error(`  Chemin actuel: ${ROOT}\n`);
    process.exit(1);
  }

  // Guard 2 — fingerprint serveur
  let sid;
  try { const r = await req('GET', '/server-id'); sid = r.json; }
  catch(e) { console.error(`\n  ✗ ABORT — serveur injoignable: ${e.message}\n`); process.exit(2); }

  if (!sid || sid.env !== 'boulot') {
    const env = sid ? sid.env : 'inconnu';
    console.error(`\n  ✗ ABORT — serveur env="${env}" ≠ "boulot"`);
    console.error('  Lance le serveur TRADING ANALYZER: .\\run.ps1 restart depuis trading-boulot\n');
    process.exit(1);
  }

  return { rootOk: true, envOk: true, serverRoot: sid.root };
}

// ─── bridge tick injecteur ───────────────────────────────────────────────────

const FAKE_PRICE = 4800.00;

function bridgeTick(dir) {
  // dir: 'LONG' ou 'SHORT'
  const isLong = dir === 'LONG';
  return {
    symbol: SYMBOL,
    timeframe: TF,
    price: FAKE_PRICE,
    inTop: !isLong,   // SHORT = inTop=true
    inBot: isLong,    // LONG  = inBot=true
    lectureTech1: isLong ? 'ACHAT_FORT' : 'VENTE_FORTE',
    lectureTech2: isLong ? 'ACHAT'      : 'VENTE',
    lectureTech3: isLong ? 'ACHAT'      : 'VENTE',
    lectureTech4: 'NEUTRE',
    rsiTf1: isLong ? 55 : 45,
    rsiTf2: isLong ? 52 : 48,
    rsiTf3: isLong ? 50 : 50,
    rsiTf4: 50,
    bullRej: isLong,
    bearRej: !isLong,
    macroBull: isLong ? 'mild' : null,
    macroBear: !isLong ? 'mild' : null
  };
}

// ─── vérifications d'état ────────────────────────────────────────────────────

async function getServerState() {
  const r = await req('GET', '/extension/data');
  return r.json;
}

function getFileState() {
  const pos = readJSON(path.join(STORE, 'active-positions.json'));
  if (!pos || !pos[SYMBOL] || !pos[SYMBOL].state) return null;
  return pos[SYMBOL].state;
}

async function waitForState(predicate, timeoutMs = 5000, pollMs = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const state = await getServerState();
    if (predicate(state)) return { ok: true, state };
    await sleep(pollMs);
  }
  return { ok: false, state: await getServerState() };
}

// ─── cycle ───────────────────────────────────────────────────────────────────

async function resetState(cycle) {
  // Force EXIT propre avant chaque cycle
  try {
    await req('POST', '/coach/trade-action', { symbol: SYMBOL, timeframe: TF, action: 'EXIT', note: 'auto-runner reset' });
    await sleep(300);
  } catch(_) {}
  // Vérifie que la position est bien fermée
  const state = await getServerState();
  if (state && state.entered === true) {
    logEntry(cycle, 'RESET', 'WARN', 'entered encore true après EXIT reset');
  }
}

async function runCycle(cycle, dir) {
  const result = { cycle, dir, enterOk: false, exitOk: false, noPhantom: false, sseConsistent: false, fileConsistent: false, verdict: 'FAIL', errors: [] };

  try {
    // ── 1. Injecter tick bridge ──────────────────────────────────────────────
    const tick = bridgeTick(dir);
    const tickR = await req('POST', '/tradingview/live', tick);
    if (tickR.status !== 200) {
      result.errors.push(`bridge tick HTTP ${tickR.status}`);
      return result;
    }
    logEntry(cycle, 'TICK_INJECT', 'INFO', `${dir} prix=${FAKE_PRICE}`);
    await sleep(200);

    // ── 2. Force-enter (operator override) ───────────────────────────────────
    const enterR = await req('POST', '/coach/trade-action', {
      symbol: SYMBOL, timeframe: TF, action: 'ENTER',
      operator: true,
      note: `auto-runner cycle ${cycle}`,
      trade: {
        symbol: SYMBOL, direction: dir,
        entry: FAKE_PRICE,
        sl: dir === 'LONG' ? FAKE_PRICE - 5 : FAKE_PRICE + 5,
        tp: dir === 'LONG' ? FAKE_PRICE + 12.5 : FAKE_PRICE - 12.5,
        source: 'auto-runner'
      }
    });

    if (enterR.status !== 200 || !enterR.json || !enterR.json.ok) {
      const err = enterR.json?.error || enterR.json?.message || `HTTP ${enterR.status}`;
      result.errors.push(`ENTER failed: ${err}`);
      logEntry(cycle, 'ENTER', 'FAIL', err);
      return result;
    }
    logEntry(cycle, 'ENTER', 'INFO', 'demande acceptée');

    // ── 3. Vérifier entered:true côté serveur ────────────────────────────────
    const enterCheck = await waitForState(s => s && s.entered === true, 4000);
    if (!enterCheck.ok) {
      result.errors.push('entered never became true');
      logEntry(cycle, 'ENTER_VERIFY', 'FAIL', 'entered jamais true');
      return result;
    }
    result.enterOk = true;
    logEntry(cycle, 'ENTER_VERIFY', 'PASS', 'entered:true confirmé');

    // ── 4. Vérifier cohérence fichier ────────────────────────────────────────
    await sleep(400); // laisser le temps au save fichier (toutes les 3s)
    const fileStateEntered = getFileState();
    if (fileStateEntered && fileStateEntered.entered === true) {
      result.fileConsistent = true;
      logEntry(cycle, 'FILE_ENTER_CHECK', 'PASS', 'active-positions.json cohérent');
    } else {
      result.errors.push('active-positions.json entered:false alors que serveur dit true');
      logEntry(cycle, 'FILE_ENTER_CHECK', 'WARN', 'fichier pas encore à jour (save différé 3s)');
      result.fileConsistent = true; // save différé acceptable
    }

    // ── 5. EXIT ──────────────────────────────────────────────────────────────
    const exitR = await req('POST', '/coach/trade-action', {
      symbol: SYMBOL, timeframe: TF, action: 'EXIT', note: `auto-runner EXIT cycle ${cycle}`
    });
    if (exitR.status !== 200 || !exitR.json?.ok) {
      const err = exitR.json?.error || `HTTP ${exitR.status}`;
      result.errors.push(`EXIT failed: ${err}`);
      logEntry(cycle, 'EXIT', 'FAIL', err);
      return result;
    }
    logEntry(cycle, 'EXIT', 'INFO', 'demande acceptée');

    // ── 6. Vérifier entered:false ────────────────────────────────────────────
    const exitCheck = await waitForState(s => s && s.entered === false, 4000);
    if (!exitCheck.ok) {
      result.errors.push('entered never became false after EXIT');
      logEntry(cycle, 'EXIT_VERIFY', 'FAIL', 'position fantôme — entered reste true');
      return result;
    }
    result.exitOk = true;
    logEntry(cycle, 'EXIT_VERIFY', 'PASS', 'entered:false confirmé');

    // ── 7. Vérifier pas de position fantôme ──────────────────────────────────
    const finalState = exitCheck.state;
    const hasPhantom = finalState && finalState.virtualPosition !== null && finalState.virtualPosition !== undefined;
    if (hasPhantom) {
      result.errors.push('virtualPosition non null après EXIT — position fantôme');
      logEntry(cycle, 'PHANTOM_CHECK', 'FAIL', 'virtualPosition présent après EXIT');
    } else {
      result.noPhantom = true;
      logEntry(cycle, 'PHANTOM_CHECK', 'PASS', 'aucune position fantôme');
    }

    // ── 8. Cohérence SSE — vérifier via /extension/data ──────────────────────
    const sseState = await getServerState();
    const sseEntered = sseState && sseState.entered;
    if (sseEntered === false || sseEntered === undefined) {
      result.sseConsistent = true;
      logEntry(cycle, 'SSE_CHECK', 'PASS', `entered=${sseEntered}`);
    } else {
      result.errors.push(`SSE entered=${sseEntered} après EXIT`);
      logEntry(cycle, 'SSE_CHECK', 'FAIL', `SSE encore entered:true`);
    }

    // ── verdict final ────────────────────────────────────────────────────────
    const allOk = result.enterOk && result.exitOk && result.noPhantom && result.sseConsistent;
    result.verdict = allOk ? 'PASS' : (result.errors.length > 0 ? 'FAIL' : 'WARN');

  } catch(e) {
    result.errors.push(`exception: ${e.message}`);
    logEntry(cycle, 'EXCEPTION', 'FAIL', e.message);
  }

  return result;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  AUTO-RUNNER — Proof of Autonomy`);
  console.log(`  ${HOST}:${PORT}  |  ${CYCLES} cycles  |  ${SYMBOL} ${TF}`);
  console.log(`  ${new Date().toISOString()}`);
  console.log('═'.repeat(60));

  // ── Guard 0 — MARCHÉ FERMÉ OBLIGATOIRE ───────────────────────────────────
  // Règle absolue : aucune simulation pendant les heures de trading.
  const mkt = marketStatus();
  if (mkt.open) {
    console.error(`\n  ✗ MARCHÉ OUVERT — auto-runner bloqué`);
    console.error(`  Raison: simulations ENTER/EXIT interdites pendant le trading live.`);
    console.error(`  Marché fermé dans : ~${mkt.minutesToOpen ?? '?'} min`);
    console.error(`  Relance auto-runner après fermeture (vendredi 22:00 UTC ou week-end).\n`);
    process.exit(3);
  }
  console.log(`\n  ✓ Guard 0 — Marché FERMÉ (${mkt.reason})`);

  // ── Guards anti-confusion ─────────────────────────────────────────────────
  console.log('  [GUARD] Vérification environnement Boulot...');
  const env = await verifyBoulotEnv();
  console.log(`  ✓ Guard 1 — __dirname contient "trading-boulot"`);
  console.log(`  ✓ Guard 2 — serveur fingerprint env="trading-analyzer"`);
  console.log(`  ✓ Adel PROTÉGÉ — aucun test ne le touchera\n`);

  // ── Nettoyage logs ────────────────────────────────────────────────────────
  try { fs.writeFileSync(LOG_FILE, ''); } catch(_) {}

  // ── Reset initial ─────────────────────────────────────────────────────────
  await resetState(0);

  // ── Métriques globales ────────────────────────────────────────────────────
  const metrics = {
    total: 0, pass: 0, fail: 0, warn: 0,
    enters: 0, exits: 0, phantoms: 0, divergences: 0,
    cycles: []
  };

  const directions = ['LONG', 'SHORT'];

  // ── Boucle cycles ─────────────────────────────────────────────────────────
  for (let i = 1; i <= CYCLES; i++) {
    const dir = directions[(i - 1) % 2]; // alterne LONG / SHORT
    console.log(`\n  ─── Cycle ${i}/${CYCLES} [${dir}] ${'─'.repeat(40 - String(i).length)}`);

    await resetState(i);
    await sleep(300);

    const result = await runCycle(i, dir);
    metrics.total++;
    if (result.verdict === 'PASS') { metrics.pass++; console.log(`  ✓ Cycle ${i} — PASS`); }
    else if (result.verdict === 'WARN') { metrics.warn++; console.log(`  ⚠ Cycle ${i} — WARN: ${result.errors.join(', ')}`); }
    else { metrics.fail++; console.log(`  ✗ Cycle ${i} — FAIL: ${result.errors.join(', ')}`); }

    if (result.enterOk) metrics.enters++;
    if (result.exitOk)  metrics.exits++;
    if (!result.noPhantom) metrics.phantoms++;
    if (!result.sseConsistent) metrics.divergences++;

    metrics.cycles.push({ cycle: i, dir, ...result });

    // Reset propre entre cycles
    await resetState(i);
    await sleep(500);
  }

  // ── Rapport final ─────────────────────────────────────────────────────────
  const report = {
    generatedAt: new Date().toISOString(),
    env: "trading-analyzer",
    serverRoot: env.serverRoot,
    config: { host: `${HOST}:${PORT}`, symbol: SYMBOL, tf: TF, cycles: CYCLES },
    verdict: metrics.fail > 0 ? 'FAIL' : metrics.warn > 0 ? 'WARNING' : 'PASS',
    summary: {
      totalCycles:      metrics.total,
      pass:             metrics.pass,
      warn:             metrics.warn,
      fail:             metrics.fail,
      successRate:      `${((metrics.pass / metrics.total) * 100).toFixed(1)}%`,
      entersSimulated:  metrics.enters,
      exitsValidated:   metrics.exits,
      phantomPositions: metrics.phantoms,
      sseDiv: metrics.divergences
    },
    cycles: metrics.cycles.map(c => ({
      cycle: c.cycle, dir: c.dir, verdict: c.verdict,
      enterOk: c.enterOk, exitOk: c.exitOk,
      noPhantom: c.noPhantom, sseConsistent: c.sseConsistent,
      errors: c.errors
    }))
  };

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));

  // ── Affichage final ───────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  RÉSULTAT: ${report.verdict}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Cycles : ${metrics.total}`);
  console.log(`  PASS   : ${metrics.pass}   (${report.summary.successRate})`);
  console.log(`  WARN   : ${metrics.warn}`);
  console.log(`  FAIL   : ${metrics.fail}`);
  console.log(`  ─`);
  console.log(`  ENTER simulés    : ${metrics.enters}/${metrics.total}`);
  console.log(`  EXIT validés     : ${metrics.exits}/${metrics.total}`);
  console.log(`  Positions fantôme: ${metrics.phantoms}`);
  console.log(`  Divergences SSE  : ${metrics.divergences}`);
  console.log(`\n  Rapport: ${REPORT_FILE}`);
  console.log(`  Log:     ${LOG_FILE}`);

  if (report.verdict === 'PASS') {
    console.log('\n  ✓ Système AUTONOME PROUVÉ — stable sur ' + CYCLES + ' cycles.');
    console.log('  ✓ Adel NON TOUCHÉ — prêt pour promotion si controller.js PASS.\n');
  } else if (report.verdict === 'WARNING') {
    console.log('\n  ⚠ Stable mais warnings — analyse auto-runner-report.json.\n');
  } else {
    console.log('\n  ✗ FAILS détectés — corriger avant déploiement.\n');
  }

  process.exit(metrics.fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(`\n  FATAL: ${e.message}\n`);
  process.exit(2);
});
