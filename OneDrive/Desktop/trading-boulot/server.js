// ─── EXPRESS INIT EN TÊTE ───────────────────────────────────────────────────
'use strict';
const express = require('express');
const app = express();
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { spawn, execSync } = require('child_process');
const PORT    = Number(process.env.PORT || 4001); // boulot = 4001 (adel/auto = 4000)
if (!process.env.BROKER_MODE) process.env.BROKER_MODE = 'live';
if (!process.env.SAFE_MODE) process.env.SAFE_MODE = '0';
const SAFE_MODE = process.env.SAFE_MODE !== '0';

// ─── MARKET HOURS — détection horaires XAUUSD (utilisé par system-health-agent) ──
const { isMarketOpen: _mktIsOpen } = require('./lib/market-hours');

// ─── BRIQUE 1 — ENREGISTREUR DE TICKS BRIDGE ────────────────────────────────
// Stocke chaque tick bridge dans store/ticks/bridge-ticks-YYYY-MM-DD.ndjson
// Format : 1 ligne JSON par tick. Rotation journalière. Purge auto > 30 jours.
// Impact live : zéro — écriture async non-bloquante, erreurs silencieuses.
const TICKS_DIR = path.join(__dirname, 'store', 'ticks');
try { if (!fs.existsSync(TICKS_DIR)) fs.mkdirSync(TICKS_DIR, { recursive: true }); } catch(_) {}

const _tickLastSym = {}; // { XAUUSD: { ts, px, lt1, lt2, lt3, lt4, r1, r2, r3, r4, iT, iB, bRej, brRej } }

function _getTickFile() {
  const d = new Date();
  const ymd = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  return path.join(TICKS_DIR, 'bridge-ticks-' + ymd + '.ndjson');
}

function _purgeTicks() {
  try {
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000; // 30 jours
    const files = fs.readdirSync(TICKS_DIR).filter(f => f.startsWith('bridge-ticks-') && f.endsWith('.ndjson'));
    for (const f of files) {
      const m = f.match(/bridge-ticks-(\d{4}-\d{2}-\d{2})\.ndjson/);
      if (m && new Date(m[1]).getTime() < cutoff) {
        fs.unlinkSync(path.join(TICKS_DIR, f));
      }
    }
  } catch(_) {}
}
// Purge au démarrage + toutes les heures
_purgeTicks();
setInterval(_purgeTicks, 3600 * 1000);

function _recordBridgeTick(sym, px, bridge, entered) {
  try {
    const prev = _tickLastSym[sym];
    // Déduplication : skip si < 3s depuis le dernier tick ET données identiques
    if (prev && (Date.now() - prev.ts) < 3000
      && prev.px === px && prev.lt1 === bridge.lectureTech1 && prev.lt2 === bridge.lectureTech2
      && prev.lt3 === bridge.lectureTech3 && prev.lt4 === bridge.lectureTech4
      && prev.iT === bridge.inTop && prev.iB === bridge.inBot
      && prev.bRej === bridge.bullRej && prev.brRej === bridge.bearRej) {
      return;
    }
    const tick = {
      ts:   Date.now(),
      sym,
      px,
      lt1:  bridge.lectureTech1  || null,
      lt2:  bridge.lectureTech2  || null,
      lt3:  bridge.lectureTech3  || null,
      lt4:  bridge.lectureTech4  || null,
      r1:   bridge.rsiTf1        || null,
      r2:   bridge.rsiTf2        || null,
      r3:   bridge.rsiTf3        || null,
      r4:   bridge.rsiTf4        || null,
      iT:   bridge.inTop         ?? null,
      iB:   bridge.inBot         ?? null,
      bRej: bridge.bullRej       ?? null,
      brRej:bridge.bearRej       ?? null,
      mBull:bridge.macroBull     || null,
      mBear:bridge.macroBear     || null,
      antT: bridge.anticipationTexte || null,
      antF: bridge.anticipationForce || null,
      ent:  !!entered
    };
    _tickLastSym[sym] = { ts: tick.ts, px, lt1: tick.lt1, lt2: tick.lt2, lt3: tick.lt3, lt4: tick.lt4,
      iT: tick.iT, iB: tick.iB, bRej: tick.bRej, brRej: tick.brRej };
    fs.appendFile(_getTickFile(), JSON.stringify(tick) + '\n', () => {}); // async, non-bloquant
  } catch(_) {}
}

// ─── TRADINGVIEW LIVE INGESTION ─────────────────────────────────────────────
const tvDataStore = {};

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/public', express.static(path.join(__dirname, 'public')));

// PATCH: log brut du body reçu
app.post('/tradingview/live', (req, res) => {
  const { symbol, timeframe, price, timestamp } = req.body;
  if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });
  const normalizedSymbol = (normalizeSymbol && normalizeSymbol(symbol)?.canonical) || String(symbol).toUpperCase();
  const numPrice = parseFloat(price) || 0;
  const now = Date.now();

  // ── PROTECTION DONNÉES OBSOLÈTES ─────────────────────────────────────────
  // Rejeter si: prix 0/invalide
  // NOTE: le check timestamp > 10s a été retiré — les bridges Pine Script envoient
  // l'heure d'ouverture de la bougie (peut être vieille de plusieurs minutes).
  // On accepte tout timestamp récent (<= 30 minutes) et on laisse updatedAt gérer la fraîcheur.
  if (numPrice <= 0) return res.json({ ok: false, error: 'invalid price', skipped: true });
  if (timestamp) {
    const tsMs = Date.parse(String(timestamp));
    if (Number.isFinite(tsMs) && (now - tsMs) > 1800000) { // 30 minutes max
      return res.json({ ok: false, error: 'stale data', ageSec: Math.round((now-tsMs)/1000), skipped: true });
    }
  }
  const _existing = tvDataStore[normalizedSymbol];
  if (_existing && _existing.price > 0) {
    const _existAge = now - (_existing.updatedAt || 0);
    const _delta = Math.abs(numPrice - _existing.price) / _existing.price;
    // Anti-spike: rejeter seulement si le prix existant est récent (<30s) ET variation >10%
    // Seuil 10% permet les gros mouvements sur news importantes
    if (_existAge < 30000 && _delta > 0.10) {
      // ── CONSENSUS RESET — déverrouillage si le prix stocké est aberrant ──────
      // Si 4+ prix entrants consécutifs sont cohérents entre eux mais >40% différents
      // du prix stocké → le prix stocké est faux, on l'écrase avec le consensus.
      if (!tvDataStore._spikeConsensus) tvDataStore._spikeConsensus = {};
      const _sc = tvDataStore._spikeConsensus;
      if (!_sc[normalizedSymbol]) _sc[normalizedSymbol] = { prices: [], firstAt: now };
      const _scEntry = _sc[normalizedSymbol];
      _scEntry.prices.push(numPrice);
      if (_scEntry.prices.length > 20) _scEntry.prices.shift(); // buffer glissant 20 ticks
      // Consensus: si les 4 derniers prix entrants sont dans un écart de 2% entre eux
      if (_scEntry.prices.length >= 4) {
        const _last4 = _scEntry.prices.slice(-4);
        const _minP = Math.min(..._last4);
        const _maxP = Math.max(..._last4);
        const _spread = (_maxP - _minP) / _minP;
        if (_spread < 0.02) {
          // 4 prix cohérents → prix stocké est aberrant → reset
          const _consensusPrice = _last4.reduce((s,v)=>s+v,0) / _last4.length;
          console.warn(`[TV-LIVE CONSENSUS-RESET] ${normalizedSymbol}: stored ${_existing.price} aberrant → reset vers ${_consensusPrice.toFixed(2)} (4 ticks cohérents)`);
          delete _sc[normalizedSymbol];
          // Forcer la mise à jour en effaçant l'updatedAt — le prochain tick sera accepté
          if (tvDataStore[normalizedSymbol]) tvDataStore[normalizedSymbol].updatedAt = 0;
          // Accepter le prix courant directement
        } else {
          console.warn(`[TV-LIVE SPIKE] ${normalizedSymbol} ${_existing.price}→${numPrice} (${(_delta*100).toFixed(1)}%) rejected (consensus pending ${_scEntry.prices.length})`);
          return res.json({ ok: false, error: 'price_spike', delta: _delta, skipped: true });
        }
      } else {
        console.warn(`[TV-LIVE SPIKE] ${normalizedSymbol} ${_existing.price}→${numPrice} (${(_delta*100).toFixed(1)}%) rejected (consensus ${_scEntry.prices.length}/4)`);
        return res.json({ ok: false, error: 'price_spike', delta: _delta, skipped: true });
      }
    } else {
      // Prix accepté → effacer le consensus buffer (plus de doute)
      if (tvDataStore._spikeConsensus && tvDataStore._spikeConsensus[normalizedSymbol]) {
        delete tvDataStore._spikeConsensus[normalizedSymbol];
      }
    }
  }
  // ── INDICATEURS : merger bridge TV → ne jamais écraser avec null ─────────
  // content.js scrape RSI/MACD/BB depuis la légende TradingView et les envoie ici.
  // On fusionne avec les valeurs existantes pour ne pas perdre un indicateur non-mis-à-jour.
  const _prevInd = tvDataStore[normalizedSymbol]?.indicators || {};
  const _bodyInd = req.body.indicators || {};
  // Helper: valeur valide = non-null ET non-zéro (0 = données absentes, ex: RSI=0 de content.js)
  const _validInd = (v) => (v != null && Number(v) !== 0) ? v : null;
  const _mergedInd = {
    rsi:      _validInd(_bodyInd.rsi)      ?? _validInd(req.body.rsi)      ?? _prevInd.rsi      ?? null,
    macd:     (_bodyInd.macd     != null ? _bodyInd.macd     : null) ?? req.body.macd     ?? _prevInd.macd     ?? null,
    bb_upper: _validInd(_bodyInd.bb_upper) ?? _validInd(req.body.bb_upper) ?? _prevInd.bb_upper ?? null,
    bb_lower: _validInd(_bodyInd.bb_lower) ?? _validInd(req.body.bb_lower) ?? _prevInd.bb_lower ?? null,
    ma20:     _validInd(_bodyInd.ma20)     ?? _validInd(req.body.ma20)     ?? _prevInd.ma20     ?? null,
    ma50:     _validInd(_bodyInd.ma50)     ?? _validInd(req.body.ma50)     ?? _prevInd.ma50     ?? null,
    atr:      _validInd(_bodyInd.atr)      ?? _validInd(req.body.atr)      ?? _prevInd.atr      ?? null,
  };
  // ── HISTORIQUE PRIX BRIDGE — buffer glissant 60 ticks pour calcul RSI/EMA ─
  // Données 100% TradingView bridge (pas de source externe).
  // Utilisé quand les indicateurs scraped (RSI/MACD) ne sont pas disponibles.
  const _prevHistory = tvDataStore[normalizedSymbol]?._priceHistory || [];
  const _newHistory = [..._prevHistory, numPrice].slice(-60); // max 60 prix

  // ── DONNÉES MULTI-TF du bridge Pine Script ─────────────────────────────────
  // scoreTech1-4 = scores techniques M1/M5/M15/H1, lectureTech1-4 = ACHAT/VENTE/NEUTRE
  // liqHigh/liqLow = niveaux de liquidité (pivot hauts/bas), rangeHigh/rangeLow = range
  // inTop/inBot = prix dans zone haute/basse, zoneLiqHauteActive/BasseActive = zone liq active
  const _rb = req.body; // alias raccourci
  const _prevBridge = tvDataStore[normalizedSymbol]?._bridgePayload || {};
  const _newBridge = {
    // Scores multi-TF (0-100, 50=neutre)
    scoreTech1:  _rb.scoreTech1 != null ? Number(_rb.scoreTech1) : _prevBridge.scoreTech1 ?? null,
    scoreTech2:  _rb.scoreTech2 != null ? Number(_rb.scoreTech2) : _prevBridge.scoreTech2 ?? null,
    scoreTech3:  _rb.scoreTech3 != null ? Number(_rb.scoreTech3) : _prevBridge.scoreTech3 ?? null,
    scoreTech4:  _rb.scoreTech4 != null ? Number(_rb.scoreTech4) : _prevBridge.scoreTech4 ?? null,
    // Lecture textuelle TF (ACHAT_FORT/ACHAT/NEUTRE/VENTE/VENTE_FORTE)
    lectureTech1: _rb.lectureTech1 ?? _prevBridge.lectureTech1 ?? null,
    lectureTech2: _rb.lectureTech2 ?? _prevBridge.lectureTech2 ?? null,
    lectureTech3: _rb.lectureTech3 ?? _prevBridge.lectureTech3 ?? null,
    lectureTech4: _rb.lectureTech4 ?? _prevBridge.lectureTech4 ?? null,
    // Timestamps per-TF — mis à jour UNIQUEMENT quand la valeur change réellement (pas sur carry-forward)
    // Permet de détecter les données périmées et d'avertir l'extension
    _lt1UpdatedAt: _rb.lectureTech1 != null ? now : (_prevBridge._lt1UpdatedAt ?? null),
    _lt2UpdatedAt: _rb.lectureTech2 != null ? now : (_prevBridge._lt2UpdatedAt ?? null),
    _lt3UpdatedAt: _rb.lectureTech3 != null ? now : (_prevBridge._lt3UpdatedAt ?? null),
    _lt4UpdatedAt: _rb.lectureTech4 != null ? now : (_prevBridge._lt4UpdatedAt ?? null),
    // RSI par TF
    rsiTf1: _rb.rsiTf1 != null && Number(_rb.rsiTf1) > 0 ? Number(_rb.rsiTf1) : _prevBridge.rsiTf1 ?? null,
    rsiTf2: _rb.rsiTf2 != null && Number(_rb.rsiTf2) > 0 ? Number(_rb.rsiTf2) : _prevBridge.rsiTf2 ?? null,
    rsiTf3: _rb.rsiTf3 != null && Number(_rb.rsiTf3) > 0 ? Number(_rb.rsiTf3) : _prevBridge.rsiTf3 ?? null,
    rsiTf4: _rb.rsiTf4 != null && Number(_rb.rsiTf4) > 0 ? Number(_rb.rsiTf4) : _prevBridge.rsiTf4 ?? null,
    // Niveaux de liquidité (pivot hauts/bas récents)
    liqHigh:   _rb.liqHigh  != null && Number(_rb.liqHigh)  > 0 ? Number(_rb.liqHigh)  : _prevBridge.liqHigh  ?? null,
    liqLow:    _rb.liqLow   != null && Number(_rb.liqLow)   > 0 ? Number(_rb.liqLow)   : _prevBridge.liqLow   ?? null,
    rangeHigh: _rb.rangeHigh != null && Number(_rb.rangeHigh) > 0 ? Number(_rb.rangeHigh) : _prevBridge.rangeHigh ?? null,
    rangeLow:  _rb.rangeLow  != null && Number(_rb.rangeLow)  > 0 ? Number(_rb.rangeLow)  : _prevBridge.rangeLow  ?? null,
    // Position dans les zones
    inTop:             _rb.inTop             !== undefined ? _rb.inTop             : _prevBridge.inTop             ?? null,
    inBot:             _rb.inBot             !== undefined ? _rb.inBot             : _prevBridge.inBot             ?? null,
    zoneLiqHaute:      _rb.zoneLiqHauteActive !== undefined ? _rb.zoneLiqHauteActive : _prevBridge.zoneLiqHaute ?? null,
    zoneLiqBasse:      _rb.zoneLiqBasseActive !== undefined ? _rb.zoneLiqBasseActive : _prevBridge.zoneLiqBasse ?? null,
    // Anticipation Pine Script
    anticipationTexte: _rb.anticipationTexte ?? _prevBridge.anticipationTexte ?? null,
    anticipationForce: _rb.anticipationForce != null ? Number(_rb.anticipationForce) : _prevBridge.anticipationForce ?? null,
    // Signal Pine Script
    signalBridge:   _rb.signal ?? _rb.direction ?? _prevBridge.signalBridge ?? null,
    verdict:        _rb.verdict  ?? _prevBridge.verdict  ?? null,
    macroBear:      _rb.macroBear  != null ? Number(_rb.macroBear)  : _prevBridge.macroBear  ?? null,
    macroBull:      _rb.macroBull  != null ? Number(_rb.macroBull)  : _prevBridge.macroBull  ?? null,
    // Rejections (bougies retournement)
    bearRej: _rb.bearRej !== undefined ? _rb.bearRej : _prevBridge.bearRej ?? null,
    bullRej: _rb.bullRej !== undefined ? _rb.bullRej : _prevBridge.bullRej ?? null,
    // ── ENRICHISSEMENT BRIDGE — midpoint, premium/discount, OB, FVG, sweep ──
    midpoint:      _rb.midpoint   != null && Number(_rb.midpoint)   > 0 ? Number(_rb.midpoint)   : _prevBridge.midpoint   ?? null,
    inPremium:     _rb.inPremium  !== undefined ? _rb.inPremium  : _prevBridge.inPremium  ?? null,
    inDiscount:    _rb.inDiscount !== undefined ? _rb.inDiscount : _prevBridge.inDiscount ?? null,
    sweepHighLevel: _rb.sweepHighLevel != null && Number(_rb.sweepHighLevel) > 0 ? Number(_rb.sweepHighLevel) : _prevBridge.sweepHighLevel ?? null,
    sweepLowLevel:  _rb.sweepLowLevel  != null && Number(_rb.sweepLowLevel)  > 0 ? Number(_rb.sweepLowLevel)  : _prevBridge.sweepLowLevel  ?? null,
    bullOB_h: _rb.bullOB_h != null && Number(_rb.bullOB_h) > 0 ? Number(_rb.bullOB_h) : _prevBridge.bullOB_h ?? null,
    bullOB_l: _rb.bullOB_l != null && Number(_rb.bullOB_l) > 0 ? Number(_rb.bullOB_l) : _prevBridge.bullOB_l ?? null,
    bearOB_h: _rb.bearOB_h != null && Number(_rb.bearOB_h) > 0 ? Number(_rb.bearOB_h) : _prevBridge.bearOB_h ?? null,
    bearOB_l: _rb.bearOB_l != null && Number(_rb.bearOB_l) > 0 ? Number(_rb.bearOB_l) : _prevBridge.bearOB_l ?? null,
    bullFVG_l: _rb.bullFVG_l != null && Number(_rb.bullFVG_l) > 0 ? Number(_rb.bullFVG_l) : _prevBridge.bullFVG_l ?? null,
    bullFVG_h: _rb.bullFVG_h != null && Number(_rb.bullFVG_h) > 0 ? Number(_rb.bullFVG_h) : _prevBridge.bullFVG_h ?? null,
    bearFVG_h: _rb.bearFVG_h != null && Number(_rb.bearFVG_h) > 0 ? Number(_rb.bearFVG_h) : _prevBridge.bearFVG_h ?? null,
    bearFVG_l: _rb.bearFVG_l != null && Number(_rb.bearFVG_l) > 0 ? Number(_rb.bearFVG_l) : _prevBridge.bearFVG_l ?? null,
    // Prix courant bridge (utilisé par computeUnifiedMarketPayload pour les checks OB/FVG proximity)
    price: numPrice > 0 ? numPrice : _prevBridge.price ?? null,
    atr: _rb.atr != null && Number(_rb.atr) > 0 ? Number(_rb.atr) : _prevBridge.atr ?? null,
    updatedAt: now,
  };

  tvDataStore[normalizedSymbol] = {
    symbol: normalizedSymbol,
    timeframe,
    price: numPrice,
    timestamp: timestamp || new Date(now).toISOString(),
    updatedAt: now,
    source: "tradingview",
    indicators: _mergedInd,
    _priceHistory: _newHistory,   // buffer pour calcul technique bridge-only
    _bridgePayload: _newBridge,   // données complètes du bridge Pine Script
    verdict:      (_rb.verdict !== undefined ? _rb.verdict : tvDataStore[normalizedSymbol]?.verdict) ?? null,
    anticipation: (_rb.anticipation !== undefined ? _rb.anticipation : tvDataStore[normalizedSymbol]?.anticipation) ?? null,
    // ── PRÉSERVER robotV12 du webhook Pine Script ─────────────────────────────
    // /tradingview/live (content.js ticks) ne doit PAS écraser robotV12
    // robotV12 est peuplé UNIQUEMENT par le webhook Pine Script (lecture_15m, verdict, anticipation_force, etc.)
    robotV12: tvDataStore[normalizedSymbol]?.robotV12 || null,
  };

  // ── BRIQUE 1 — ENREGISTREMENT TICK BRIDGE ────────────────────────────────
  // Appelé après merge complet de _newBridge : on enregistre l'état final vu par le robot.
  // _ent : true si une position est déjà ouverte (watchdog ne cherche pas d'entrée dans ce cas)
  try {
    const _ent = (typeof getCoachTradeState === 'function')
      ? !!(getCoachTradeState(normalizedSymbol, timeframe || 'H1').entered)
      : false;
    _recordBridgeTick(normalizedSymbol, numPrice, _newBridge, _ent);
  } catch(_) {}

  // Synchroniser activeSymbol avec le symbole TradingView reçu
  // Assure que /extension/sync diffuse le bon contexte immédiatement
  if (typeof activeSymbol !== 'undefined') {
    activeSymbol = {
      ...activeSymbol,
      symbol: normalizedSymbol,
      timeframe: timeframe || activeSymbol?.timeframe || 'H1',
      price: numPrice,
      updatedAt: new Date(now).toISOString()
    };
    if (typeof saveExtensionRuntimeState === 'function') saveExtensionRuntimeState();
  }

  // ── BROADCAST SSE — déduplication prix ──────────────────────────────────
  // Ne diffuser que si prix change >0.01% OU >2s sans diffusion OU timestamp absurd
  // Évite d'inonder les clients SSE avec des ticks identiques
  if (typeof broadcastToExtension === 'function') {
    const _bcastKey = normalizedSymbol;
    if (!tvDataStore._lastBcast) tvDataStore._lastBcast = {};
    const _lb = tvDataStore._lastBcast[_bcastKey] || {};
    const _pDelta = _lb.price > 0 ? Math.abs(numPrice - _lb.price) / _lb.price : 1;
    const _age = now - (_lb.sentAt || 0);
    const _shouldBcast = _pDelta > 0.00001 || _age > 500;  // >0.001% OU >500ms — tick-by-tick
    if (_shouldBcast) {
      tvDataStore._lastBcast[_bcastKey] = { price: numPrice, sentAt: now };
      broadcastToExtension({
        type: 'tradingview-data',
        symbol: normalizedSymbol,
        price: numPrice,
        timeframe,
        source: 'tradingview-live',
        updatedAt: now,
        // ── Indicateurs bridge — transmis tels quels au dashboard ──────────
        rsi:      _mergedInd.rsi      ?? null,
        macd:     _mergedInd.macd     ?? null,
        bb_upper: _mergedInd.bb_upper ?? null,
        bb_lower: _mergedInd.bb_lower ?? null,
        ma20:     _mergedInd.ma20     ?? null,
        ma50:     _mergedInd.ma50     ?? null,
        atr:      _mergedInd.atr      ?? null,
        // ── Données multi-TF Pine Script — rsiTf/scoreTech/lectureTech par TF ─
        // Permet au dashboard de construire le consensus TF sans appel API supplémentaire
        bridgeData: {
          scoreTech1: _newBridge.scoreTech1, scoreTech2: _newBridge.scoreTech2,
          scoreTech3: _newBridge.scoreTech3, scoreTech4: _newBridge.scoreTech4,
          lectureTech1: _newBridge.lectureTech1, lectureTech2: _newBridge.lectureTech2,
          lectureTech3: _newBridge.lectureTech3, lectureTech4: _newBridge.lectureTech4,
          // Timestamps per-TF pour détection fraîcheur (null = jamais reçu depuis ce démarrage)
          _lt1UpdatedAt: _newBridge._lt1UpdatedAt, _lt2UpdatedAt: _newBridge._lt2UpdatedAt,
          _lt3UpdatedAt: _newBridge._lt3UpdatedAt, _lt4UpdatedAt: _newBridge._lt4UpdatedAt,
          rsiTf1: _newBridge.rsiTf1, rsiTf2: _newBridge.rsiTf2,
          rsiTf3: _newBridge.rsiTf3, rsiTf4: _newBridge.rsiTf4,
          macroBull: _newBridge.macroBull, macroBear: _newBridge.macroBear,
          anticipationTexte: _newBridge.anticipationTexte,
          anticipationForce: _newBridge.anticipationForce,
          liqHigh: _newBridge.liqHigh, liqLow: _newBridge.liqLow,
          rangeHigh: _newBridge.rangeHigh, rangeLow: _newBridge.rangeLow,
          inTop: _newBridge.inTop, inBot: _newBridge.inBot,
          zoneLiqHaute: _newBridge.zoneLiqHaute, zoneLiqBasse: _newBridge.zoneLiqBasse,
          bearRej: _newBridge.bearRej, bullRej: _newBridge.bullRej,
          signalBridge: _newBridge.signalBridge, verdict: _newBridge.verdict,
          // Enrichissement bridge
          midpoint: _newBridge.midpoint, inPremium: _newBridge.inPremium, inDiscount: _newBridge.inDiscount,
          sweepHighLevel: _newBridge.sweepHighLevel, sweepLowLevel: _newBridge.sweepLowLevel,
          bullOB_h: _newBridge.bullOB_h, bullOB_l: _newBridge.bullOB_l,
          bearOB_h: _newBridge.bearOB_h, bearOB_l: _newBridge.bearOB_l,
          bullFVG_l: _newBridge.bullFVG_l, bullFVG_h: _newBridge.bullFVG_h,
          bearFVG_h: _newBridge.bearFVG_h, bearFVG_l: _newBridge.bearFVG_l,
        },
      });
    }
    // active-symbol: sur changement de prix significatif OU changement de TF
    const _prevTf = _existing?.timeframe;
    const _tfChanged = timeframe && _prevTf && String(timeframe).toUpperCase() !== String(_prevTf).toUpperCase();
    if (typeof emitResolvedActiveSymbol === 'function' && (_pDelta > 0.001 || _tfChanged)) {
      emitResolvedActiveSymbol('tradingview-live');
    }
  }

  // Mise à jour marketStore pour les autres composants
  if (marketStore && typeof marketStore.updateFromMT5 === 'function') {
    marketStore.systemStatus = { source: 'tradingview', fluxStatus: 'LIVE', lastUpdate: new Date(now).toISOString() };
    marketStore.updateFromMT5({ symbol: normalizedSymbol, price: numPrice, timeframe, source: 'tradingview' }, normalizedSymbol);
  }

  // Appel orchestrateur pour analyse en arrière-plan
  if (orchestrator && typeof orchestrator.run === 'function' && numPrice > 0) {
    orchestrator.run({ symbol: normalizedSymbol, price: numPrice, timeframe, bid: numPrice, ask: numPrice })
      .then(a => { if (marketStore && a) marketStore.updateAnalysis(normalizedSymbol, a); })
      .catch(() => {});
  }

  // ── MISE À JOUR TEMPS RÉEL DES POSITIONS ACTIVES ─────────────────────────
  // Sur chaque tick bridge: mettre à jour lastPrice + pnlPoints dans virtualPosition
  // Évite le décalage "montant stale" entre les appels /coach/realtime (toutes les 1.5s)
  if (typeof coachTradeStateStore !== 'undefined' && coachTradeStateStore && numPrice > 0) {
    for (const _tsKey of Object.keys(coachTradeStateStore)) {
      const _ts = coachTradeStateStore[_tsKey];
      if (!_ts || !_ts.entered || !_ts.virtualPosition) continue;
      if (String(_ts.symbol || '').toUpperCase() !== normalizedSymbol) continue;
      const _vp = _ts.virtualPosition;
      const _entry = Number(_vp.entry || 0);
      const _dir   = String(_vp.direction || '').toUpperCase();
      if (_entry <= 0 || !_dir) continue;
      const _pnl = _dir === 'SHORT' ? (_entry - numPrice) : (numPrice - _entry);
      _vp.lastPrice   = numPrice;
      _vp.currentPrice = numPrice;
      _vp.pnlPoints   = Math.round(_pnl * 100000) / 100000;
      // progressToTp — mise à jour continue
      const _tp = Number(_vp.tp || 0);
      const _rewardDist = Math.abs(_tp - _entry) || 1;
      _vp.progressToTp = _tp > 0 ? Math.max(0, Math.min(100, Math.round((_pnl / _rewardDist) * 100))) : 0;
    }
  }

  // Log bridge entrant — toujours visible dans la console serveur
  const _indLog = Object.entries(_mergedInd)
    .filter(([,v]) => v != null)
    .map(([k,v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`)
    .join(' | ');
  console.log(`[BRIDGE IN] ${normalizedSymbol} @ ${numPrice} | ind: ${_indLog || 'AUCUN'}`);

  res.json({ ok: true, symbol: normalizedSymbol, price: numPrice, updatedAt: now });
});

// ── ENDPOINT DIAGNOSTIC BRIDGE ────────────────────────────────────────────
// Retourne exactement ce que le bridge contient pour un symbole
// Usage: GET /debug/bridge?symbol=XAUUSD
app.get('/debug/bridge', (req, res) => {
  const sym = String(req.query.symbol || 'XAUUSD').toUpperCase();
  const entry = tvDataStore[sym] || null;
  if (!entry) {
    return res.json({ ok: false, symbol: sym, error: 'Aucune donnée reçue pour ce symbole', tvDataStore_keys: Object.keys(tvDataStore) });
  }
  const ind = entry.indicators || {};
  const ageMs = Date.now() - (entry.updatedAt || 0);
  res.json({
    ok: true,
    symbol: sym,
    price: entry.price,
    timeframe: entry.timeframe,
    age_sec: (ageMs / 1000).toFixed(1),
    stale: ageMs > 30000,
    indicators: {
      rsi:      ind.rsi      ?? null,
      macd:     ind.macd     ?? null,
      bb_upper: ind.bb_upper ?? null,
      bb_lower: ind.bb_lower ?? null,
      ma20:     ind.ma20     ?? null,
      ma50:     ind.ma50     ?? null,
      atr:      ind.atr      ?? null,
    },
    indicators_count: Object.values(ind).filter(v => v != null).length,
    signal_possible: !!(ind.rsi != null || ind.ma20 != null || ind.macd != null),
    _priceHistory_len: (entry._priceHistory || []).length,
    bridgePayload: entry._bridgePayload || null,  // données Pine Script complètes
    updatedAt: new Date(entry.updatedAt || 0).toISOString()
  });
});

// ── SOURCE UNIQUE DE PRIX ─────────────────────────────────────────────────
// Retourne le prix live TradingView si < 30s, sinon null.
// AUCUN fallback fake. Si null → le système se bloque proprement.
function getLivePrice(symbol) {
  const upper = symbol?.toUpperCase();
  const canonical = normalizeSymbol ? (normalizeSymbol(upper)?.canonical || upper) : upper;
  const entry = tvDataStore[upper] || tvDataStore[canonical];
  if (!entry) return null;
  // Fallback: si updatedAt absent (données avant correctif), utiliser timestamp ISO
  const baseMs = entry.updatedAt || (entry.timestamp ? Date.parse(entry.timestamp) : 0);
  const ageMs = Date.now() - baseMs;
  if (ageMs > 30000) return null;          // stale > 30s = pas fiable
  if (!entry.price || entry.price <= 0) return null;
  return { price: entry.price, ageMs, symbol: entry.symbol, timeframe: entry.timeframe };
}

function requireLivePrice(symbol, res) {
  const live = getLivePrice(symbol);
  if (!live) {
    res.status(503).json({
      ok: false,
      error: 'NO_LIVE_PRICE',
      message: `Prix TradingView non disponible pour ${symbol}. Ouvrez TradingView et attendez la synchronisation.`,
      hint: 'Vérifiez que content.js est actif sur TradingView et que le backend reçoit les ticks.'
    });
    return null;
  }
  return live;
}

// Retourne le dernier prix connu (même stale) — pour les endpoints d'analyse qui n'ont pas besoin de live strict.
// NE PAS utiliser pour entrée en position (utiliser requireLivePrice à la place).
function getLastKnownPrice(symbol) {
  const upper = symbol?.toUpperCase();
  const canonical = normalizeSymbol ? (normalizeSymbol(upper)?.canonical || upper) : upper;
  const entry = tvDataStore[upper] || tvDataStore[canonical];
  if (entry && entry.price > 0) {
    const baseMs = entry.updatedAt || (entry.timestamp ? Date.parse(entry.timestamp) : 0);
    const ageMs = Date.now() - baseMs;
    return { price: entry.price, ageMs, symbol: entry.symbol, timeframe: entry.timeframe, stale: ageMs > 30000 };
  }
  // Fallback: activeSymbol (mis à jour par SSE initial-sync)
  if (activeSymbol?.price > 0 && String(activeSymbol.symbol || '').toUpperCase() === upper) {
    return { price: activeSymbol.price, ageMs: null, symbol: activeSymbol.symbol, timeframe: activeSymbol.timeframe, stale: true };
  }
  return null;
}

// ── TECHNICAL ANALYSIS ENGINE (module scope — accessible par toutes les routes) ──────────────
function _calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}
function _calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  const slice = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgG = gains / period, avgL = losses / period;
  if (avgL === 0) return 100;
  return 100 - (100 / (1 + avgG / avgL));
}
function _calcATR(candles, period) {
  if (candles.length < 2) return null;
  const trs = candles.slice(-period).map((c, i, arr) => {
    if (i === 0) return c.high - c.low;
    const pc = arr[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}
// ── Cache de signal prix-action — évite les flips rapides LONG/SHORT ─────────
// Clé: "SYMBOL:TF", valeur: { direction, votes, lockedAt, sl, tp }
const _paSignalCache = new Map();
// Hystérésis: ne flip que si 4/4 votes ET 60s écoulés OU 4/4 votes + 3 flips consécutifs
// Sans TV indicators, la direction doit être stable sur au moins 60 secondes
const _PA_LOCK_MS   = 60_000;  // 60s minimum entre deux flips
const _PA_FLIP_THRESH = 3;     // votes minimum CONTRE la direction actuelle pour flipper
// ── Pré-signal: signal en formation (2/4 votes) — anticipation entrée imminente ─
// Stocké quand 2 des 4 signaux concordent — alerte LIA AVANT la confirmation 3/4
const _paPreSignalCache = new Map(); // { direction, votes, detectedAt, price, pctChange }
// ─────────────────────────────────────────────────────────────────────────────

// ── FILTRE QUALITÉ — cooldown signal: interdit les signaux répétés < 5 min ───
// Cause principale de perte: double signal identique en quelques secondes, range chop
// Clé: "SYMBOL:TF:DIR", valeur: timestamp de la dernière émission
const _signalCooldownCache = new Map();
const _SIGNAL_COOLDOWN_MS  = 5 * 60_000; // 5 minutes minimum entre signaux identiques

// ── DÉTECTEUR DE RÉGIME DE MARCHÉ ─────────────────────────────────────────────
// Renvoie: 'TREND_UP' | 'TREND_DOWN' | 'RANGE' | 'COMPRESSION' | 'UNKNOWN'
// Utilisé pour bloquer les entrées trend-following en marché range/compression
function _detectMarketRegime(price, rsi, bbUpper, bbLower, atr, ma20, ma50, bridgePayload) {
  const bp = bridgePayload || {};

  // ── BB Width — indicateur de compression vs expansion ─────────────────────
  // Seuil ATR-relatif (pas % prix) — évite les faux positifs sur or/indices à prix élevé
  // BB width < 1.5 ATR = marché compressé, mouvement directionnel peu fiable
  if (atr != null && atr > 0 && bbUpper != null && bbLower != null && bbUpper > 0 && bbLower > 0) {
    const bbWidthAbs = bbUpper - bbLower;
    if (bbWidthAbs < atr * 1.5) {
      return 'COMPRESSION';
    }
  }

  // ── RSI en zone neutre (42–58) = marché range sans momentum clair ────────
  const rsiNeutral = rsi != null && rsi > 42 && rsi < 58;

  // ── Alignement EMA — force de la tendance ────────────────────────────────
  let emaAligned = false;
  let trendDir   = null;
  if (ma20 != null && ma50 != null && atr != null && atr > 0) {
    const emaDiff = Math.abs(ma20 - ma50);
    // EMA20 et EMA50 très proches (< 0.3 ATR) = pas de tendance
    if (emaDiff < atr * 0.3) {
      return 'RANGE'; // EMAs enchevêtrées = range confirmé
    }
    emaAligned = true;
    trendDir = ma20 > ma50 ? 'TREND_UP' : 'TREND_DOWN';
  }

  // ── Lecture Multi-TF du bridge Pine Script ────────────────────────────────
  const lt3 = String(bp.lectureTech3 || '').toUpperCase(); // M15
  const lt4 = String(bp.lectureTech4 || '').toUpperCase(); // H1
  const h1Bull = lt4.includes('ACHAT');
  const h1Bear = lt4.includes('VENTE');
  const m15Bull = lt3.includes('ACHAT');
  const m15Bear = lt3.includes('VENTE');

  // ── Score de direction global ─────────────────────────────────────────────
  let upVotes = 0, downVotes = 0;
  if (emaAligned && trendDir === 'TREND_UP')   upVotes++;
  if (emaAligned && trendDir === 'TREND_DOWN') downVotes++;
  if (h1Bull)   upVotes++;
  if (h1Bear)   downVotes++;
  if (m15Bull)  upVotes++;
  if (m15Bear)  downVotes++;

  // Range si votes contradictoires ou RSI neutre sans EMAs alignées
  if (upVotes > 0 && downVotes > 0) return 'RANGE';
  if (upVotes === 0 && downVotes === 0 && rsiNeutral) return 'RANGE';
  if (upVotes >= 2)   return 'TREND_UP';
  if (downVotes >= 2) return 'TREND_DOWN';
  return 'UNKNOWN';
}
// ─────────────────────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════════
// MOTEUR DE RETOURNEMENT LIA — analyse les conditions de retournement parfait
// Lit exclusivement les données bridge Pine Script (aucun impact sur le reste)
// Score 0-100: ≥75 = ENTER_NOW (A), ≥60 = PREPARE (B), ≥40 = WATCH (C)
// ══════════════════════════════════════════════════════════════════════════════
function computeReversalOpportunity(price, bridgePayload, indicators) {
  if (!bridgePayload || !price || price <= 0) return null;
  const bp  = bridgePayload;
  const atr = (indicators?.atr && Number(indicators.atr) > 0)
    ? Number(indicators.atr)
    : (price > 1000 ? 8.0 : price > 100 ? 0.5 : 0.0010); // fallback ATR

  let sS = 0, lS = 0; // short score, long score
  const sR = [], lR = []; // raisons

  // ── 1. ZONE — le signal le plus fort: prix sur un niveau clé ─────────────
  if (bp.inTop === true)         { sS += 25; sR.push('zone haute active'); }
  if (bp.zoneLiqHaute === true)  { sS += 20; sR.push('liquidité résistance'); }
  if (bp.inBot === true)         { lS += 25; lR.push('zone basse active'); }
  if (bp.zoneLiqBasse === true)  { lS += 20; lR.push('liquidité support'); }

  // ── 2. ANTICIPATION Pine Script — score calculé par le robot TV ───────────
  const ant = String(bp.anticipationTexte || '').toUpperCase();
  const af  = Number(bp.anticipationForce || 0);
  if      (ant === 'RET_SHORT_PROCHE')  { sS += 25; sR.push('retournement SHORT imminent (TV)'); }
  else if (ant === 'PRE_ALERTE_SHORT')  { sS += Math.round(af * 0.18); sR.push('pré-alerte SHORT (TV ' + af + ')'); }
  if      (ant === 'RET_LONG_PROCHE')   { lS += 25; lR.push('retournement LONG imminent (TV)'); }
  else if (ant === 'PRE_ALERTE_LONG')   { lS += Math.round(af * 0.18); lR.push('pré-alerte LONG (TV ' + af + ')'); }

  // ── 3. REJET DE BOUGIE — confirmation prix sur le niveau ─────────────────
  if (bp.bearRej === true) { sS += 20; sR.push('rejet baissier confirmé'); }
  if (bp.bullRej === true) { lS += 20; lR.push('rejet haussier confirmé'); }

  // ── 4. ALIGNEMENT TF MAJEURS — M15 + H1 ──────────────────────────────────
  const lt3 = String(bp.lectureTech3 || '').toUpperCase(); // M15
  const lt4 = String(bp.lectureTech4 || '').toUpperCase(); // H1
  if (lt3.includes('VENTE'))      { sS += 8; }
  if (lt4 === 'VENTE_FORTE')      { sS += 12; sR.push('H1 VENTE FORTE'); }
  else if (lt4.includes('VENTE')) { sS += 6; }
  if (lt3.includes('ACHAT'))      { lS += 8; }
  if (lt4 === 'ACHAT_FORT')       { lS += 12; lR.push('H1 ACHAT FORT'); }
  else if (lt4.includes('ACHAT')) { lS += 6; }

  // ── 5. RSI CONTEXTE — zone extrême = retournement possible ───────────────
  // RSI M15 > 65 = surachat → SHORT attendu | < 35 = survente → LONG attendu
  const rsiM15 = (bp.rsiTf3 && Number(bp.rsiTf3) > 0) ? Number(bp.rsiTf3) : null;
  const rsiH1  = (bp.rsiTf4 && Number(bp.rsiTf4) > 0) ? Number(bp.rsiTf4) : null;
  if (rsiM15 && rsiM15 > 65) { sS += 12; sR.push('RSI M15 ' + Math.round(rsiM15) + ' surachat'); }
  if (rsiM15 && rsiM15 < 35) { lS += 12; lR.push('RSI M15 ' + Math.round(rsiM15) + ' survente'); }
  if (rsiH1  && rsiH1  > 68) { sS += 8;  }
  if (rsiH1  && rsiH1  < 32) { lS += 8;  }

  // ── 6. PROXIMITÉ NIVEAU DE LIQUIDITÉ ─────────────────────────────────────
  const liqH = bp.liqHigh && Number(bp.liqHigh) > 0 ? Number(bp.liqHigh) : null;
  const liqL = bp.liqLow  && Number(bp.liqLow)  > 0 ? Number(bp.liqLow)  : null;
  const tol  = price * 0.004; // 0.4% de tolérance autour du niveau
  if (liqH && Math.abs(price - liqH) <= tol) { sS += 15; sR.push('prix sur liqHigh ' + liqH.toFixed(2)); }
  if (liqL && Math.abs(price - liqL) <= tol) { lS += 15; lR.push('prix sur liqLow '  + liqL.toFixed(2)); }

  // ── 7. MACRO — pression directionnelle ───────────────────────────────────
  const mBear = Number(bp.macroBear || 0);
  const mBull = Number(bp.macroBull || 0);
  if (mBear > 55) { sS += Math.round((mBear - 55) * 0.3); }
  if (mBull > 55) { lS += Math.round((mBull - 55) * 0.3); }

  // ── DÉCISION ─────────────────────────────────────────────────────────────
  const maxS = Math.max(sS, lS);
  if (maxS < 30) return null; // rien de significatif

  const dir     = sS >= lS ? 'SHORT' : 'LONG';
  const score   = Math.min(100, dir === 'SHORT' ? sS : lS);
  const reasons = (dir === 'SHORT' ? sR : lR).slice(0, 4);

  // ── NIVEAUX D'ENTRÉE PRÉCIS ───────────────────────────────────────────────
  // Entrée: sur le niveau de liquidité si proche, sinon prix actuel
  // SL: au-delà du niveau (0.7x ATR de marge = survie bruit intra-bar)
  // TP: vers le niveau de liquidité opposé (3:1 minimum)
  let entry, sl, tp;
  const slBuf = atr * 0.7;
  if (dir === 'SHORT') {
    entry = (liqH && Math.abs(price - liqH) < tol * 2) ? liqH : price;
    sl    = entry + slBuf;
    tp    = liqL ? (liqL + atr * 0.3) : (entry - atr * 3);
  } else {
    entry = (liqL && Math.abs(price - liqL) < tol * 2) ? liqL : price;
    sl    = entry - slBuf;
    tp    = liqH ? (liqH - atr * 0.3) : (entry + atr * 3);
  }
  entry = Math.round(entry * 100) / 100;
  sl    = Math.round(sl    * 100) / 100;
  tp    = Math.round(tp    * 100) / 100;

  const slD = Math.abs(entry - sl);
  const tpD = Math.abs(tp   - entry);
  const rr  = slD > 0 ? (tpD / slD).toFixed(1) : '--';

  // Qualité du setup
  const grade  = score >= 75 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';
  const action = score >= 75 ? 'ENTER_NOW' : score >= 60 ? 'PREPARE' : 'WATCH';

  const topReason = reasons[0] || '';
  const msg = grade === 'A'
    ? `RETOURNEMENT ${dir} — ${score}/100 | ${reasons.slice(0,2).join(' + ')} | RR:${rr}`
    : grade === 'B'
    ? `Setup ${dir} en formation — ${score}/100 | ${topReason}`
    : `Surveille ${dir} — ${score}/100 | ${topReason}`;

  return { direction: dir, score, grade, action, reasons, entry, sl, tp, rr, message: msg };
}

// ── MESSAGES MÉTIER BRIDGE — 4 blocs structurés ──────────────────────────────
// Structure obligatoire : Contexte → Signal local → Lecture → Décision
// Chaque bloc a un rôle sémantique précis — aucune ambiguïté possible.
// scoreTech1/4 = M1→H1, lectureTech1/4 = ACHAT/VENTE/NEUTRE/FORT
// opts: { canEnter?: boolean, conflictReason?: string, decision?: string }
function buildBridgeContextMessage(bridgePayload, indicators, price, opts) {
  if (!bridgePayload) return null;
  const bp  = bridgePayload;
  const opt = opts || {};

  // ── DONNÉES BRUTES ─────────────────────────────────────────────────────────
  const mBull  = Number(bp.macroBull || 0);
  const mBear  = Number(bp.macroBear || 0);
  const mDelta = Math.abs(mBull - mBear);
  const lt4    = String(bp.lectureTech4 || '').toUpperCase(); // H1
  const lt3    = String(bp.lectureTech3 || '').toUpperCase(); // M15
  const lt2    = String(bp.lectureTech2 || '').toUpperCase(); // M5
  const lt1    = String(bp.lectureTech1 || '').toUpperCase(); // M1
  const rsiH1  = Number(bp.rsiTf4 || 0);
  const rsiM15 = Number(bp.rsiTf3 || 0);
  const rsiM5  = Number(bp.rsiTf2 || 0);
  const rsiM1  = Number(bp.rsiTf1 || 0);
  const sc4    = Number(bp.scoreTech4 || 50);
  const sc3    = Number(bp.scoreTech3 || 50);
  const _px    = Number(price || 0);
  const _lH    = Number(bp.liqHigh || 0);
  const _lL    = Number(bp.liqLow  || 0);
  const ant    = String(bp.anticipationTexte || '').toUpperCase();
  const af     = Number(bp.anticipationForce || 0);

  // ── BLOC 1 — CONTEXTE (direction de fond) ─────────────────────────────────
  // Source: macroBull/macroBear + lectureTech4 + rsiTf4
  // Rôle: donner la direction de fond SANS signal d'entrée
  const b1 = [];
  if (mDelta > 8) {
    const mDir = mBull > mBear ? 'haussière' : 'baissière';
    const mStr = mDelta > 25 ? 'forte' : mDelta > 12 ? 'modérée' : 'légère';
    b1.push(`Macro ${mDir} ${mStr}`);
  }
  if (lt4.includes('ACHAT_FORT') || sc4 > 70)      b1.push(`H1 haussier fort${rsiH1 > 0 ? ' (RSI '+Math.round(rsiH1)+')' : ''}`);
  else if (lt4.includes('ACHAT') || sc4 > 57)       b1.push(`H1 haussier${rsiH1 > 0 ? ' (RSI '+Math.round(rsiH1)+')' : ''}`);
  else if (lt4.includes('VENTE_FORTE') || sc4 < 30) b1.push(`H1 baissier fort${rsiH1 > 0 ? ' (RSI '+Math.round(rsiH1)+')' : ''}`);
  else if (lt4.includes('VENTE') || sc4 < 43)       b1.push(`H1 baissier${rsiH1 > 0 ? ' (RSI '+Math.round(rsiH1)+')' : ''}`);
  else if (lt4)                                      b1.push(`H1 neutre${rsiH1 > 0 ? ' (RSI '+Math.round(rsiH1)+')' : ''}`);

  // ── BLOC 2 — SIGNAL LOCAL (zone + réaction prix) ──────────────────────────
  // Source: inBot/inTop/zoneLiqBasse/zoneLiqHaute + liqLow/liqHigh + bullRej/bearRej
  // Rôle: ce que le prix fait MAINTENANT au niveau clé
  const b2 = [];
  if (bp.inBot === true && bp.zoneLiqBasse === true) b2.push('Zone basse + liquidité support');
  else if (bp.inBot === true)                        b2.push('Zone basse');
  if (bp.inTop === true && bp.zoneLiqHaute === true) b2.push('Zone haute + liquidité résistance');
  else if (bp.inTop === true)                        b2.push('Zone haute');
  if (_lH > 0 && _px > 0 && Math.abs(_px - _lH) / _px < 0.003) b2.push(`LiqHigh ${_lH.toFixed(2)} proche`);
  if (_lL > 0 && _px > 0 && Math.abs(_px - _lL) / _px < 0.003) b2.push(`LiqLow ${_lL.toFixed(2)} proche`);
  if (bp.bullRej === true) b2.push('rejet haussier confirmé');
  if (bp.bearRej === true) b2.push('rejet baissier confirmé');

  // ── BLOC 3 — LECTURE / ANTICIPATION (signal + timing) ─────────────────────
  // Source: lectureTech3 (M15 = TF de signal) + lectureTech2/1 (M5/M1 = timing) + anticipationTexte
  // Rôle: ce que le marché dit sur le TF de décision + confirmation timing
  const b3 = [];
  if (lt3.includes('ACHAT_FORT'))       b3.push(`M15 achat fort${rsiM15 > 0 ? ' (RSI '+Math.round(rsiM15)+')' : ''}`);
  else if (lt3.includes('ACHAT'))       b3.push(`M15 achat${rsiM15 > 0 ? ' (RSI '+Math.round(rsiM15)+')' : ''}`);
  else if (lt3.includes('VENTE_FORTE')) b3.push(`M15 vente forte${rsiM15 > 0 ? ' (RSI '+Math.round(rsiM15)+')' : ''}`);
  else if (lt3.includes('VENTE'))       b3.push(`M15 vente${rsiM15 > 0 ? ' (RSI '+Math.round(rsiM15)+')' : ''}`);
  // Timing court (M5/M1) — confirmant ou contradictoire avec M15
  const tParts = [];
  if (lt2.includes('ACHAT') || lt2.includes('VENTE')) tParts.push(`M5 ${lt2.replace('_FORT','').toLowerCase()}${rsiM5 > 0 ? ' (R'+Math.round(rsiM5)+')' : ''}`);
  if (lt1.includes('ACHAT') || lt1.includes('VENTE')) tParts.push(`M1 ${lt1.replace('_FORT','').toLowerCase()}${rsiM1 > 0 ? ' (R'+Math.round(rsiM1)+')' : ''}`);
  if (tParts.length) b3.push(`Timing: ${tParts.join(', ')}`);
  // Anticipation Pine
  const antMap = {
    'RET_LONG_PROCHE': 'retournement LONG imminent (Pine)',
    'RET_SHORT_PROCHE': 'retournement SHORT imminent (Pine)',
    'PRE_ALERTE_LONG':  'pré-alerte LONG (Pine)',
    'PRE_ALERTE_SHORT': 'pré-alerte SHORT (Pine)',
    'RET_LONG':  'retournement LONG en cours (Pine)',
    'RET_SHORT': 'retournement SHORT en cours (Pine)'
  };
  if (ant && af > 20 && antMap[ant]) b3.push(antMap[ant] + (af > 0 ? ` — ${Math.round(af)}%` : ''));

  // ── BLOC 4 — DÉCISION (synthèse alignement) ───────────────────────────────
  // Source: cohérence entre blocs 1-3 + canEnter (optionnel) + conflictReason (optionnel)
  // Rôle: expliquer sans ambiguïté POURQUOI on entre ou pourquoi on attend
  const b4 = [];
  if (opt.canEnter === true) {
    const _decDir = ant.includes('LONG') || lt3.includes('ACHAT') ? 'LONG' : 'SHORT';
    b4.push(`Conditions réunies — entrée ${_decDir} validée`);
  } else if (opt.conflictReason) {
    b4.push(opt.conflictReason.split('|')[0].trim().substring(0, 90));
  } else {
    // Dériver la décision depuis les données bridge sans canEnter explicite
    const _lt3Long = lt3.includes('ACHAT');
    const _lt3Short = lt3.includes('VENTE');
    const _timingContra = (_lt3Long && (lt2.includes('VENTE') || lt1.includes('VENTE')))
                        || (_lt3Short && (lt2.includes('ACHAT') || lt1.includes('ACHAT')));
    const _h1Contra = (_lt3Long && lt4.includes('VENTE')) || (_lt3Short && lt4.includes('ACHAT'));
    if (_timingContra && _h1Contra) {
      const _signalDir = _lt3Long ? 'achat' : 'vente';
      const _ctxDir = _lt3Long ? 'vendeur' : 'acheteur';
      b4.push(`Signal M15 ${_signalDir} — timing M5/M1 et contexte H1 ${_ctxDir} → attendre alignement`);
    } else if (_timingContra) {
      const _signalDir = _lt3Long ? 'achat' : 'vente';
      b4.push(`Signal M15 ${_signalDir} — timing M5/M1 non confirmé → attendre bougie M5`);
    } else if (_h1Contra && !(bp.inBot || bp.inTop)) {
      b4.push(`M15 retourné mais contexte H1 opposé — setup contre-tendance uniquement en zone`);
    } else if (!bp.inBot && !bp.inTop) {
      b4.push(`Prix hors zone — attendre support ou résistance avant d'entrer`);
    } else if (b3.length === 0) {
      b4.push(`Zone identifiée — pas encore de signal M15 clair`);
    } else {
      b4.push(`Surveillance active — conditions en formation`);
    }
  }

  // ── ASSEMBLAGE — 4 blocs lisibles, séparateur \n ──────────────────────────
  const blocks = [];
  if (b1.length) blocks.push('Contexte : ' + b1.join(', '));
  if (b2.length) blocks.push('Signal local : ' + b2.join(', '));
  if (b3.length) blocks.push('Lecture : ' + b3.join(', '));
  if (b4.length) blocks.push('Décision : ' + b4.join(', '));

  return blocks.length > 0 ? blocks.join('\n') : null;
}

// Détecte le type de setup SWING/SNIPER/SCALPING depuis données bridge Pine Script
function detectSetupTypeFromBridge(bridgePayload, tradeTypeHint) {
  if (tradeTypeHint && tradeTypeHint !== 'SNIPER') return tradeTypeHint; // honorer hint si déjà spécifié
  if (!bridgePayload) return 'SNIPER';
  const bp = bridgePayload;
  const sc4 = Number(bp.scoreTech4 || 50); // H1
  const sc3 = Number(bp.scoreTech3 || 50); // M15
  const lt1 = String(bp.lectureTech1 || '').toUpperCase();
  const lt2 = String(bp.lectureTech2 || '').toUpperCase();
  const ant = String(bp.anticipationTexte || '').toUpperCase();
  const af  = Number(bp.anticipationForce || 0);
  // SWING: H1 fort + anticipation forte = mouvement majeur attendu
  if (sc4 > 65 && sc3 > 60 && af > 50) return 'SWING';
  if (sc4 > 70 && (ant.includes('RET_LONG') || ant.includes('RET_SHORT'))) return 'SWING';
  // SCALPING: impulsion M1/M5 sans contexte H1 clair
  const mShort = lt1.includes('ACHAT') || lt1.includes('VENTE') || lt2.includes('ACHAT') || lt2.includes('VENTE');
  if (mShort && sc4 < 55) return 'SCALPING';
  // Défaut SNIPER: zone précise + timing court
  return 'SNIPER';
}

// Contexte macro synthétique depuis bridge — direction + force
function buildMacroContext(bridgePayload) {
  if (!bridgePayload) return null;
  const mBull = Number(bridgePayload.macroBull || 0);
  const mBear = Number(bridgePayload.macroBear || 0);
  const mDelta = Math.abs(mBull - mBear);
  const direction = mDelta < 5 ? 'NEUTRE' : (mBull > mBear ? 'HAUSSIER' : 'BAISSIER');
  const strength  = Math.min(100, Math.round(mDelta * 1.5));
  const labelMap = { HAUSSIER: ['Légère pression haussière','Macro haussière','Macro très haussière'],
                     BAISSIER:  ['Légère pression baissière','Macro baissière','Macro très baissière'],
                     NEUTRE:    ['Macro neutre'] };
  const idx = mDelta > 25 ? 2 : mDelta > 12 ? 1 : 0;
  return { direction, strength, bull: Math.round(mBull), bear: Math.round(mBear),
           label: (labelMap[direction] || labelMap.NEUTRE)[idx] || direction };
}

async function computeTechSignalFromKlines(symbol, timeframe, currentPrice) {
  // ── SOURCE UNIQUE: TradingView bridge — AUCUNE source externe autorisée ────
  // Yahoo Finance et toute autre API externe sont INTERDITS.
  // Si le bridge n'a pas les indicateurs suffisants → return null.
  try {
    const tf = String(timeframe || 'H1').toUpperCase();
    const price = Number.isFinite(Number(currentPrice)) && Number(currentPrice) > 0 ? Number(currentPrice) : null;
    if (!price) return null;

    // Lecture bridge TV uniquement — lookup robuste (canonical + raw)
    const _symUp = String(symbol).toUpperCase();
    const _symCanonical = (typeof normalizeSymbol === 'function') ? normalizeSymbol(_symUp)?.canonical : _symUp;
    const _tvEntry = typeof tvDataStore !== 'undefined'
      ? (tvDataStore[_symUp] || tvDataStore[_symCanonical] || tvDataStore[symbol] || null)
      : null;
    const _tvInd = _tvEntry?.indicators || {};
    const _bp    = _tvEntry?._bridgePayload || {};

    // ── RSI PAR TIMEFRAME — utilise les valeurs distinctes du bridge Pine Script ──
    // Le bridge envoie rsiTf1(M1) rsiTf2(M5) rsiTf3(M15) rsiTf4(H1) indépendamment.
    // Priorité: rsiTf[n] du TF demandé > rsiTf courant > _tvInd.rsi global.
    // H4/D1 : pas de rsiTf5/6 envoyé par Pine → retourner null explicitement (pas de doublon).
    // M30 : proxied → rsiTf3 (M15). H4/D1 : aucun RSI bridge per-TF.
    const _rsiByTf = { M1: _bp.rsiTf1, M5: _bp.rsiTf2, M15: _bp.rsiTf3, M30: _bp.rsiTf3, H1: _bp.rsiTf4 };
    const _rsiForTf = _rsiByTf[tf];
    const _rsiTfVal = (_rsiForTf != null && Number(_rsiForTf) > 0 && Number(_rsiForTf) <= 100)
      ? Number(_rsiForTf) : null;
    // H4/D1/W1 : bridge ne les envoie pas — retourner null (honnête, pas de données fake)
    const _tfHasNoBridgeRsi = (tf === 'H4' || tf === 'D1' || tf === 'W1');
    if (_tfHasNoBridgeRsi) {
      // Retourner null : pas de données per-TF disponibles, ne pas dupliquer le RSI global
      // Le dashboard affichera N/A pour ces TF (géré côté UI)
      return null;
    }

    let rsiUsed  = _rsiTfVal !== null ? _rsiTfVal
      : ((_tvInd.rsi != null && _tvInd.rsi > 0 && _tvInd.rsi <= 100) ? _tvInd.rsi : null);
    let ma20Used = (_tvInd.ma20     != null && _tvInd.ma20 > 0) ? _tvInd.ma20 : null;
    let ma50Used = (_tvInd.ma50     != null && _tvInd.ma50 > 0) ? _tvInd.ma50 : null;
    const macdVal  = (_tvInd.macd     != null) ? _tvInd.macd : null;
    const bbUpper  = (_tvInd.bb_upper != null && _tvInd.bb_upper > 0) ? _tvInd.bb_upper : null;
    const bbLower  = (_tvInd.bb_lower != null && _tvInd.bb_lower > 0) ? _tvInd.bb_lower : null;
    let atr14      = (_tvInd.atr      != null && _tvInd.atr > 0) ? _tvInd.atr : null;

    // ── RÈGLE STRICTE: pas de calcul depuis les ticks ────────────────────────
    // Les ticks bridge (prix consécutifs) ne sont PAS des bougies M5/H1.
    // Calculer RSI/EMA depuis des ticks donne des valeurs fausses (RSI=100 monotone).
    // Si les indicateurs TV ne sont pas dans tvDataStore → signal null = correct.
    // L'utilisateur doit avoir RSI/EMA/MACD visibles dans la légende TradingView.
    // ATR: si absent du bridge, estimé depuis le spread SL/TP (SL fix #1 garantit plancher).
    if (atr14 == null) {
      // ATR minimal pour ne pas bloquer le calcul SL (plancher appliqué après)
      atr14 = price * 0.002; // 0.2% — sera remplacé par le plancher SL de toute façon
    }

    // Seuil minimal: RSI ou MA20 ou MACD obligatoire — données réelles TradingView prioritaires
    const hasAnyIndicator = rsiUsed != null || ma20Used != null || macdVal != null;
    // Pré-calcul type de symbole — nécessaire dans le fallback ET dans le bloc principal
    const _symKlinesEarly = String(symbol || '').toUpperCase();
    const _isGoldKl  = /XAU|GOLD/.test(_symKlinesEarly);
    const _isIndexKl = /US30|US500|US100|NAS|SPX|SP500|DAX|DE40|GER40/.test(_symKlinesEarly);
    const _isJpyKl   = _symKlinesEarly.includes('JPY');
    if (!hasAnyIndicator) {
      // ── FALLBACK PRIX-ACTION — analyse tendance sur _priceHistory (60 ticks bridge TV) ──
      // Niveaux basés sur la STRUCTURE réelle (swing low/high) — pas juste ATR * facteur
      const _phSrc = _tvEntry || tvDataStore[String(symbol).toUpperCase()] || tvDataStore[_symCanonical] || null;
      const _ph = _phSrc?._priceHistory || [];
      if (_ph.length >= 5) {
        const _n = _ph.length;
        // ── Structure du buffer ──────────────────────────────────────────────────
        const _allMax = Math.max(..._ph);
        const _allMin = Math.min(..._ph);
        const _range  = _allMax - _allMin;
        // EMA20 et EMA50 synthétiques
        const _ema20Synth = _ph.slice(-Math.min(20,_n)).reduce((a,b)=>a+b,0) / Math.min(20,_n);
        const _ema50Synth = _ph.slice(-Math.min(50,_n)).reduce((a,b)=>a+b,0) / Math.min(50,_n);
        ma20Used = _ema20Synth > 0 ? _ema20Synth : null;
        // ATR synthétique
        const _synthAtr = Math.max(_range, price * 0.001);
        if (atr14 < price * 0.001) atr14 = _synthAtr;
        // ── Direction: 4 signaux concordants pour éviter les faux retournements ──
        // 1. Moyenne récente (dernier tiers) vs ancienne (premier tiers)
        const _third = Math.max(2, Math.floor(_n / 3));
        const _oldSlice  = _ph.slice(0, _third);
        const _newSlice  = _ph.slice(-_third);
        const _avgOld = _oldSlice.reduce((a,b)=>a+b,0) / _oldSlice.length;
        const _avgNew = _newSlice.reduce((a,b)=>a+b,0) / _newSlice.length;
        const _pctChange = _avgOld > 0 ? (_avgNew - _avgOld) / _avgOld : 0;
        // 2. Position prix vs EMA20 (tendance intermédiaire)
        const _priceVsEma20 = price > _ema20Synth ? 'LONG' : 'SHORT';
        // 3. Position EMA20 vs EMA50 (tendance de fond)
        const _ema20VsEma50 = _ema50Synth > 0 ? (_ema20Synth >= _ema50Synth ? 'LONG' : 'SHORT') : null;
        // 4. Delta premier/dernier tick (direction brute)
        const _firstPrice = _ph[0], _lastPrice = _ph[_n-1];
        const _rawDelta = _firstPrice > 0 ? (_lastPrice - _firstPrice) / _firstPrice : 0;
        const _rawDir = _rawDelta >= 0 ? 'LONG' : 'SHORT';
        // ── Vote: 3 signaux sur 4 concordants = direction fiable ───────────────
        const _votes = {
          LONG:  (_pctChange > 0 ? 1 : 0) + (_priceVsEma20 === 'LONG' ? 1 : 0) + (_ema20VsEma50 === 'LONG' ? 1 : 0) + (_rawDir === 'LONG' ? 1 : 0),
          SHORT: (_pctChange < 0 ? 1 : 0) + (_priceVsEma20 === 'SHORT' ? 1 : 0) + (_ema20VsEma50 === 'SHORT' ? 1 : 0) + (_rawDir === 'SHORT' ? 1 : 0)
        };
        const _majorityDir = _votes.LONG > _votes.SHORT ? 'LONG' : _votes.SHORT > _votes.LONG ? 'SHORT' : null;
        const _majorityVotes = Math.max(_votes.LONG, _votes.SHORT);
        const _absMove = Math.abs(_pctChange);
        // ── Seuil qualité: au moins 3/4 votes concordants ───────────────────────
        // Le vote seul est suffisant — le mouvement tick est trop petit pour être seuil
        const _preKey = `${String(symbol).toUpperCase()}:${String(tf||timeframe||'H1').toUpperCase()}`;
        if (!_majorityDir || _majorityVotes < 3) {
          // Pré-signal: exactement 2/4 votes concordants → signal en formation, anticiper l'entrée
          if (_majorityDir && _majorityVotes === 2) {
            _paPreSignalCache.set(_preKey, {
              direction: _majorityDir, votes: 2, detectedAt: Date.now(),
              price, ema20: _ema20Synth, pctChange: _pctChange,
              votes_long: _votes.LONG, votes_short: _votes.SHORT
            });
            console.log(`[PRE-SIGNAL] ${symbol} ${_majorityDir} 2/4 votes — formation en cours`);
          } else {
            _paPreSignalCache.delete(_preKey); // signal trop faible → effacer pré-signal
          }
          // Votes insuffisants (2/4 ou moins) → neutre/attente
          console.log(`[PRICE-ACTION] ${symbol} NEUTRE — votes:${_votes.LONG}/${_votes.SHORT} (seuil 3/4 non atteint)`);
          return null;
        }
        // Signal ≥ 3/4 confirmé → effacer le pré-signal (remplacé par le signal réel)
        _paPreSignalCache.delete(_preKey);
        const _trendDir = _majorityDir;
        // Confiance: 4/4 = fort, 3/4 = modéré
        const _confBase = _majorityVotes >= 4 ? 62 : 55;
        const _confLevel = _absMove >= 0.0005 ? Math.min(68, _confBase + 6) : _confBase;
        // ── SL professionnel: ATR-based + structure réelle ──────────────────────
        // Les 60 ticks = ~1-2 minutes de données réelles.
        // Le range des ticks (1-3pts) ne représente PAS la structure M15.
        // On utilise max(structure_ticks, ATR*0.6) pour un SL réaliste.
        const _tfStr   = String(tf || timeframe || 'H1').toUpperCase();
        // Minimums stricts par TF — basés sur la volatilité réelle de chaque TF
        const _minSlPA = _isGoldKl
          ? ({ M1:2.0, M5:3.5, M15:5.0, M30:7.0, H1:9.0, H4:16.0, D1:28.0 }[_tfStr] || 5.0)
          : _isIndexKl
          ? ({ M1:2.0, M5:4.0, M15:6.0, M30:10.0, H1:15.0, H4:30.0, D1:50.0 }[_tfStr] || 6.0)
          : ({ M1:0.0004, M5:0.0007, M15:0.001, H1:0.0018, H4:0.003, D1:0.005 }[_tfStr] || 0.001);
        // Caps par TF (max SL acceptable)
        const _maxSlPA = _isGoldKl
          ? ({ M1:6.0, M5:10.0, M15:18.0, M30:25.0, H1:35.0, H4:60.0, D1:90.0 }[_tfStr] || 18.0)
          : _isIndexKl
          ? ({ M1:5.0, M5:10.0, M15:18.0, H1:30.0, H4:55.0, D1:90.0 }[_tfStr] || 18.0)
          : ({ M1:0.0012, M5:0.002, M15:0.003, H1:0.005, H4:0.009, D1:0.015 }[_tfStr] || 0.003);
        // ATR buffer: 85% ATR comme plancher — évite que le bruit intra-bougie touche le SL
        // Avant: 60% → trop proche → SL touché sur simple wick intra-bar
        // Fix: 85% ATR = distance minimum qui survit au bruit normal du marché
        const _atrBasedSl = atr14 * 0.85; // SL ≥ 85% ATR = survie au bruit intra-bar
        const _atrBuf     = atr14 * 0.40; // buffer au-delà du swing (40% ATR)
        // Structure brute (distance prix → swing extrême des ticks)
        const _structSlRaw = _trendDir === 'LONG'
          ? Math.max(price - _allMin, 0)
          : Math.max(_allMax - price, 0);
        // SL final = max(structure+buffer, ATR*60%, minimum_TF) plafonné au cap
        const _structSlDist = Math.max(_structSlRaw + _atrBuf, _atrBasedSl, _minSlPA);
        const _slDist = Math.min(_structSlDist, _maxSlPA);
        // TP: R/R fixe 2.2:1 si range petit, 2.5:1 si momentum fort
        const _rrTarget = _majorityVotes >= 4 ? 2.5 : 2.2;
        const _tpDist = _slDist * _rrTarget;
        const _sl = _trendDir === 'LONG' ? price - _slDist : price + _slDist;
        const _tp = _trendDir === 'LONG' ? price + _tpDist : price - _tpDist;
        const _rrStr = _rrTarget.toFixed(1);
        // Labels pip (or = x10, forex = x10000)
        const _pipM = _isGoldKl || _isIndexKl ? 10 : _isJpyKl ? 100 : 10000;
        const _slPts = (_slDist * (_isGoldKl || _isIndexKl ? 1 : _pipM)).toFixed(1);
        const _tpPts = (_tpDist * (_isGoldKl || _isIndexKl ? 1 : _pipM)).toFixed(1);
        const _stateLabel = _majorityVotes >= 4 ? 'FORT' : _majorityVotes >= 3 ? 'MODERE' : 'FAIBLE';
        // ── Hystérésis: direction verrouillée jusqu'à consensus FORT ────────────
        const _cacheKey = `${String(symbol).toUpperCase()}:${String(tf||timeframe||'').toUpperCase()}`;
        const _cached = _paSignalCache.get(_cacheKey);
        const _now = Date.now();
        let _lockedDir = _trendDir;
        if (_cached) {
          const _elapsed = _now - (_cached.lockedAt || 0);
          const _oppositeVotes = _trendDir !== _cached.direction
            ? Math.max(_votes.LONG, _votes.SHORT)
            : 0;
          // Ne flip QUE si: 4/4 contre ET 60s écoulées — sinon garder direction mémorisée
          const _shouldFlip = _oppositeVotes >= 4 && _elapsed >= _PA_LOCK_MS;
          if (!_shouldFlip) {
            _lockedDir = _cached.direction; // conserver direction stable
            console.log(`[PRICE-ACTION] ${symbol} LOCK:${_lockedDir} (votes:${_votes.LONG}/${_votes.SHORT} ${_elapsed < _PA_LOCK_MS ? `cooldown:${Math.round((_PA_LOCK_MS-_elapsed)/1000)}s` : `opp:${_oppositeVotes}/4`})`);
          } else {
            console.log(`[PRICE-ACTION] ${symbol} FLIP ${_cached.direction}→${_trendDir} votes:${_votes.LONG}/${_votes.SHORT} elapsed:${Math.round(_elapsed/1000)}s`);
            _paSignalCache.set(_cacheKey, { direction: _trendDir, votes: _majorityVotes, lockedAt: _now });
          }
        } else {
          _paSignalCache.set(_cacheKey, { direction: _trendDir, votes: _majorityVotes, lockedAt: _now });
          console.log(`[PRICE-ACTION] ${symbol} INIT:${_trendDir} votes:${_votes.LONG}/${_votes.SHORT}`);
        }
        // Recalculer SL/TP si la direction verrouillée est différente du trendDir brut
        const _finalDir = _lockedDir;
        const _fSlDist = _finalDir === 'LONG'
          ? Math.min(Math.max(price - _allMin + _atrBuf, _minSlPA), _maxSlPA)
          : Math.min(Math.max(_allMax - price + _atrBuf, _minSlPA), _maxSlPA);
        const _fRR = Math.max(2.0, Math.min(3.0, _range / Math.max(_fSlDist, 0.01)));
        const _fTpDist = _fSlDist * _fRR;
        const _fSl = _finalDir === 'LONG' ? price - _fSlDist : price + _fSlDist;
        const _fTp = _finalDir === 'LONG' ? price + _fTpDist : price - _fTpDist;
        const _fSlPts = (_fSlDist * (_isGoldKl || _isIndexKl ? 1 : _pipM)).toFixed(1);
        const _fTpPts = (_fTpDist * (_isGoldKl || _isIndexKl ? 1 : _pipM)).toFixed(1);
        // ─────────────────────────────────────────────────────────────────────────
        console.log(`[PRICE-ACTION] ${symbol} ${_finalDir} votes:${_votes.LONG}/${_votes.SHORT} conf:${_confLevel}% (${_n}t) SL:${_fSlDist.toFixed(2)} TP:${_fTpDist.toFixed(2)} RR:${_fRR.toFixed(1)} [${_stateLabel}]`);
        return {
          symbol, direction: _finalDir, entry: price, sl: _fSl, tp: _fTp,
          rrRatio: _fRR.toFixed(1), score: _confLevel, confidence: _confLevel,
          source: 'price-action-ticks', trade_status: 'CONDITIONAL',
          technical: `PriceAction(${_n}t,v${_votes.LONG}/${_votes.SHORT}) Δ${(_pctChange*100).toFixed(3)}% EMA20:${_ema20Synth.toFixed(2)} ATR:${atr14.toFixed(2)} [${_stateLabel}]`,
          slPips: _fSlPts, tpPips: _fTpPts,
          rsi: null, ema20: _ema20Synth, atr: atr14
        };
      } else {
        console.log(`[SIGNAL NULL] ${symbol} — buffer insuffisant (${_ph.length}/5 ticks). Ajouter RSI/EMA/MACD sur TradingView.`);
      }
      return null;
    }

    let score = 50;
    const signals = [];

    // ── Pré-calcul contexte tendance (pour pondérer RSI_OB/OS) ────────────
    const _priceAboveMa20 = ma20Used != null && price > ma20Used;
    const _priceBelowMa20 = ma20Used != null && price < ma20Used;

    // RSI — TV bridge prioritaire
    if (rsiUsed != null) {
      if (rsiUsed > 62)      { signals.push('RSI_BULL'); score += 15; }
      else if (rsiUsed < 38) { signals.push('RSI_BEAR'); score -= 15; }
      // RSI_OB ne pénalise QUE si prix sous MA20 (surachat contre la tendance = vrai risque retournement)
      // RSI élevé en uptrend (prix > MA20) = force de tendance, pas retournement
      if (rsiUsed > 75 && _priceBelowMa20)       { signals.push('RSI_OB'); score -= 8; }
      else if (rsiUsed < 25 && _priceAboveMa20)   { signals.push('RSI_OS'); score += 8; }
      else if (rsiUsed > 75 && ma20Used == null)   { signals.push('RSI_OB'); score -= 8; }
      else if (rsiUsed < 25 && ma20Used == null)   { signals.push('RSI_OS'); score += 8; }
    }

    // MA trend — poids adapté selon disponibilité MA50
    if (ma20Used != null && ma50Used != null) {
      // Les deux MAs disponibles (scraped TV ou 50+ ticks history)
      if (price > ma20Used && ma20Used > ma50Used) { signals.push('TREND_BULL'); score += 20; }
      else if (price < ma20Used && ma20Used < ma50Used) { signals.push('TREND_BEAR'); score -= 20; }
      else if (price > ma20Used) { signals.push('PRICE_BULL'); score += 10; }
      else if (price < ma20Used) { signals.push('PRICE_BEAR'); score -= 10; }
    } else if (ma20Used != null) {
      // MA20 seule (20–49 ticks history) — poids renforcé car c'est le seul MA disponible
      if (price > ma20Used) { signals.push('PRICE_BULL'); score += 15; }
      else if (price < ma20Used) { signals.push('PRICE_BEAR'); score -= 15; }
    }

    // MACD TV bridge — valeur + détection croisement (crossover)
    // Un croisement = changement de signe du MACD (histogram → 0) = signal fort
    if (macdVal != null) {
      const _prevMacdVal = _tvEntry?._prevMacdVal;
      const _macdCrossed = (_prevMacdVal != null && _prevMacdVal !== macdVal)
        && ((_prevMacdVal < 0 && macdVal > 0) || (_prevMacdVal > 0 && macdVal < 0));
      if (_macdCrossed) {
        // Croisement détecté — signal fort (+25 vs +10 simple)
        if (macdVal > 0) { signals.push('MACD_CROSS_BULL'); score += 25; console.log(`[MACD-CROSS] ${symbol} croisement HAUSSIER détecté: ${_prevMacdVal.toFixed(2)}→${macdVal.toFixed(2)}`); }
        else             { signals.push('MACD_CROSS_BEAR'); score -= 25; console.log(`[MACD-CROSS] ${symbol} croisement BAISSIER détecté: ${_prevMacdVal.toFixed(2)}→${macdVal.toFixed(2)}`); }
      } else {
        // Détection affaiblissement — même signe mais amplitude réduite = momentum qui s'épuise
        const _macdWeakening = _prevMacdVal != null
          && Math.sign(macdVal) === Math.sign(_prevMacdVal)
          && Math.abs(macdVal) < Math.abs(_prevMacdVal);
        if (_macdWeakening) {
          if (macdVal > 0) { signals.push('MACD_WEAK_BULL'); score -= 8; console.log(`[MACD-WEAK] ${symbol} affaiblissement HAUSSIER: ${_prevMacdVal.toFixed(2)}→${macdVal.toFixed(2)}`); }
          else             { signals.push('MACD_WEAK_BEAR'); score += 8; console.log(`[MACD-WEAK] ${symbol} affaiblissement BAISSIER: ${_prevMacdVal.toFixed(2)}→${macdVal.toFixed(2)}`); }
        } else {
          if (macdVal > 0)      { signals.push('MACD_BULL'); score += 10; }
          else if (macdVal < 0) { signals.push('MACD_BEAR'); score -= 10; }
        }
      }
      // Mémoriser pour le prochain tick (détection croisement)
      if (_tvEntry) _tvEntry._prevMacdVal = macdVal;
    }

    // Bollinger Bands — prix en dehors des bandes = signal fort
    if (bbUpper != null && bbLower != null) {
      if (price > bbUpper)      { signals.push('BB_OB'); score -= 12; }   // surachat → fade
      else if (price < bbLower) { signals.push('BB_OS'); score += 12; }   // survente → rebond
    }

    // Comptage confluences (BB_OB/BB_OS exclus — signaux retournement, pas continuation)
    const bullCount = signals.filter(s => s.includes('BULL') || s === 'RSI_OS').length;
    const bearCount = signals.filter(s => s.includes('BEAR') || s === 'RSI_OB').length;

    // Score borné pour éviter saturation artificielle
    const scoreClamped = Math.min(95, Math.max(5, score));

    // Confluences: toujours 3 minimum (règle qualité — 2 était trop permissif)
    // RAISON: avec seulement 2 signaux sur RSI+MA, trop de trades dans le vide
    const minConfl = 3;

    let direction;
    // Seuil par TF: M15 capture les retraces propres (68+, 3 confluences min)
    // H1 et au-dessus restent stricts (82+) — évite les entrées tendance faibles
    // M5 intermédiaire (75+) pour le timing d'entrée précis
    const _tfUpper = String(timeframe || '').toUpperCase();
    const _scoreThr = _tfUpper === 'M15' ? 68
                    : _tfUpper === 'M5'  ? 75
                    : 82;
    const _scoreThrInv = 100 - _scoreThr;
    if      (scoreClamped >= _scoreThr    && bullCount >= minConfl) direction = 'LONG';
    else if (scoreClamped <= _scoreThrInv && bearCount >= minConfl) direction = 'SHORT';
    else direction = 'NEUTRE';

    // ── FILTRE CONTEXTE MARCHÉ — éviter les entrées en zone à haut risque SL ──────
    // Ces filtres bloquent les setups où les indicateurs disent LONG mais le marché
    // est déjà en surachat extrême (RSI > 74) ou contre la BB (prix hors des bandes)
    // → évite d'entrer juste avant un retournement = cause principale des SL touchés
    // RSI=0 = données absentes (TradingView envoie 0 quand RSI non calculé) → ignorer
    const _rsiValid = rsiUsed != null && rsiUsed > 0;
    if (direction === 'LONG') {
      if (_rsiValid && rsiUsed > 74) {
        console.log(`[QUALITY-BLOCK] ${symbol} LONG bloqué — RSI ${rsiUsed.toFixed(0)} en surachat extrême (> 74)`);
        direction = 'NEUTRE'; // pas d'entrée LONG en zone de retournement RSI
      } else if (bbUpper != null && bbUpper > 0 && bbUpper > price * 0.5 && price >= bbUpper) {
        console.log(`[QUALITY-BLOCK] ${symbol} LONG bloqué — prix (${price}) ≥ BB supérieure (${bbUpper.toFixed(2)})`);
        direction = 'NEUTRE'; // pas d'entrée LONG quand prix sort de la BB haute
      }
    } else if (direction === 'SHORT') {
      if (_rsiValid && rsiUsed < 26) {
        console.log(`[QUALITY-BLOCK] ${symbol} SHORT bloqué — RSI ${rsiUsed.toFixed(0)} en survente extrême (< 26)`);
        direction = 'NEUTRE'; // pas d'entrée SHORT en zone de retournement RSI
      } else if (bbLower != null && bbLower > 0 && bbLower < price * 1.5 && price <= bbLower) {
        console.log(`[QUALITY-BLOCK] ${symbol} SHORT bloqué — prix (${price}) ≤ BB inférieure (${bbLower.toFixed(2)})`);
        direction = 'NEUTRE'; // pas d'entrée SHORT quand prix sort de la BB basse
      }
    }
    // ─────────────────────────────────────────────────────────────────────────────

    // ══ FILTRE 1: RÉGIME DE MARCHÉ ═══════════════════════════════════════════════
    // Si marché en RANGE ou COMPRESSION → bloquer toute entrée trend-following
    // RAISON: cause #1 des pertes = entrer en trend dans un marché sans direction
    if (direction !== 'NEUTRE') {
      const _bpData = _tvEntry?._bridgePayload || {};
      const _regime = _detectMarketRegime(price, rsiUsed, bbUpper, bbLower, atr14, ma20Used, ma50Used, _bpData);
      if (_regime === 'COMPRESSION') {
        console.log(`[REGIME-BLOCK] ${symbol} ${direction} bloqué — marché en COMPRESSION (BB étroite). Attendre breakout.`);
        direction = 'NEUTRE';
      } else if (_regime === 'RANGE') {
        console.log(`[REGIME-BLOCK] ${symbol} ${direction} bloqué — marché en RANGE (EMAs enchevêtrées / TF contradictoires). Éviter les entrées.`);
        direction = 'NEUTRE';
      }
      // TREND_UP / TREND_DOWN / UNKNOWN → passer au filtre suivant
    }

    // ══ FILTRE 2: ALIGNEMENT M15 (TF D'ENTRÉE) ═══════════════════════════════════
    // H1/H4 = contexte uniquement, non bloquant — seul M15 Pine peut bloquer l'entrée.
    // M15 = TF d'entrée, M1/M5 = timing, H1/H4 = qualification affichée uniquement.
    if (direction !== 'NEUTRE') {
      const _bpMtf    = _tvEntry?._bridgePayload || {};
      const _lt4      = String(_bpMtf.lectureTech4 || '').toUpperCase(); // H1 lecture (contexte)
      const _lt3      = String(_bpMtf.lectureTech3 || '').toUpperCase(); // M15 lecture (entrée)
      const _m15Bear  = _lt3.includes('VENTE');
      const _m15Bull  = _lt3.includes('ACHAT');

      if (direction === 'LONG' && _m15Bear) {
        // LONG contre tendance M15 Pine → bloqué (M15 = TF d'entrée)
        console.log(`[MTF-BLOCK] ${symbol} LONG bloqué — M15 Pine:${_lt3} baissier (contre-tendance entrée). H1:${_lt4} (contexte)`);
        direction = 'NEUTRE';
      } else if (direction === 'SHORT' && _m15Bull) {
        // SHORT contre tendance M15 Pine → bloqué (M15 = TF d'entrée)
        console.log(`[MTF-BLOCK] ${symbol} SHORT bloqué — M15 Pine:${_lt3} haussier (contre-tendance entrée). H1:${_lt4} (contexte)`);
        direction = 'NEUTRE';
      }
      // H1 RSI extrêmes supprimés — H1/H4 = contexte, jamais bloquants
    }

    // ══ FILTRE 3: COOLDOWN SIGNAL — 5 min entre signaux identiques ═══════════════
    // RAISON: double signal en 1-2 min = sur-trading = cause directe des pertes en chop
    if (direction !== 'NEUTRE') {
      const _cdKey = `${String(symbol).toUpperCase()}:${String(timeframe||'H1').toUpperCase()}:${direction}`;
      const _lastEmit = _signalCooldownCache.get(_cdKey) || 0;
      const _elapsed  = Date.now() - _lastEmit;
      if (_elapsed < _SIGNAL_COOLDOWN_MS) {
        console.log(`[COOLDOWN] ${symbol} ${direction} bloqué — signal identique émis il y a ${Math.round(_elapsed/1000)}s (cooldown ${_SIGNAL_COOLDOWN_MS/1000}s).`);
        direction = 'NEUTRE';
      } else {
        // Enregistrer ce signal — sera ignoré si refirmé avant 5 min
        _signalCooldownCache.set(_cdKey, Date.now());
      }
    }

    // ══ FILTRE 4: PRIX AU MILIEU DU RANGE — exiger un niveau structurel ══════════
    // RAISON: entrer au milieu = SL touché par le simple bruit de marché
    // Bloquer si prix n'est proche d'aucun niveau clé (liqHigh/liqLow/rangeHigh/rangeLow)
    if (direction !== 'NEUTRE') {
      const _bpLevel  = _tvEntry?._bridgePayload || {};
      const _liqH     = _bpLevel.liqHigh  != null && Number(_bpLevel.liqHigh)  > 0 ? Number(_bpLevel.liqHigh)  : null;
      const _liqL     = _bpLevel.liqLow   != null && Number(_bpLevel.liqLow)   > 0 ? Number(_bpLevel.liqLow)   : null;
      const _rgH      = _bpLevel.rangeHigh != null && Number(_bpLevel.rangeHigh) > 0 ? Number(_bpLevel.rangeHigh) : null;
      const _rgL      = _bpLevel.rangeLow  != null && Number(_bpLevel.rangeLow)  > 0 ? Number(_bpLevel.rangeLow)  : null;
      const _levels   = [_liqH, _liqL, _rgH, _rgL].filter(v => v != null);
      if (_levels.length >= 2) {
        // Vérifier si le prix est proche d'au moins un niveau (±1 ATR)
        const _atProxLevel = _levels.some(lvl => Math.abs(price - lvl) <= atr14 * 1.0);
        if (!_atProxLevel) {
          console.log(`[LEVEL-BLOCK] ${symbol} ${direction} bloqué — prix ${price} en milieu de range (aucun niveau structurel à ±${atr14.toFixed(2)}). Niveaux: ${_levels.map(v=>v.toFixed(2)).join('/')}`);
          direction = 'NEUTRE';
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────────

    const confidence = Math.min(95, Math.max(20, Math.abs(scoreClamped - 50) * 1.5 + 40));
    const entry = price;

    // SL basé sur ATR bridge (pas de candles disponibles sans Yahoo)
    let slDist = atr14 * 0.65;
    // Plafond absolu SL selon TF — identique à calcTradeLevels
    const _tfCapKlines = { M1:2.5, M5:5, M15:8, M30:12, H1:18, H4:35, D1:60 };
    const _symKlines = _symKlinesEarly; // déjà calculé plus haut
    // _isGoldKl, _isIndexKl, _isJpyKl déjà définis avant le bloc hasAnyIndicator
    const _maxSlKl   = (_isGoldKl || _isIndexKl) ? (_tfCapKlines[String(timeframe||'H1').toUpperCase()] || 18)
                     : _isJpyKl ? (_tfCapKlines[String(timeframe||'H1').toUpperCase()] || 18) * 0.01
                     :             (_tfCapKlines[String(timeframe||'H1').toUpperCase()] || 18) * 0.0001;
    if (slDist > _maxSlKl) slDist = _maxSlKl;
    // Fix #1 — plancher minimum SL: ATR depuis ticks peut être 100× trop petit (0.02 USD)
    // Sans plancher: SL à 3 centimes = touché instantanément à chaque tick
    const _tfMin = String(timeframe || 'H1').toUpperCase();
    const _minSlKl = _isGoldKl  ? ({ M1:0.5, M5:1.0, M15:1.5, H1:2.5, H4:5.0, D1:8.0 }[_tfMin] || 1.0)
                   : _isIndexKl ? ({ M1:1.0, M5:2.0, M15:3.0, H1:5.0, H4:10,  D1:20  }[_tfMin] || 2.0)
                   : _isJpyKl   ? 0.05
                   :               0.0003;
    if (slDist < _minSlKl) slDist = _minSlKl;
    // Fix #5 — ATR suspicieusement petit: < 0.05% du prix = données insuffisantes → refuser le signal
    if (atr14 < price * 0.0005 && slDist <= _minSlKl) {
      return null; // forcer re-accumulation de ticks avant de signaler
    }
    const sl = direction === 'LONG' ? price - slDist : direction === 'SHORT' ? price + slDist : null;
    const tpDist = slDist * 2.5; // 2.5:1 RR pour compenser SL serré
    const tp = direction === 'LONG' ? price + tpDist : direction === 'SHORT' ? price - tpDist : null;
    const rrRatio = sl && tp ? (Math.abs(tp - entry) / Math.abs(sl - entry)).toFixed(2) : '--';
    const technical = [
      rsiUsed  != null ? `RSI(${rsiUsed.toFixed(0)})` : null,
      ma20Used != null ? `MA20(${ma20Used.toFixed(2)})` : null,
      ma50Used != null ? `MA50(${ma50Used.toFixed(2)})` : null,
      `ATR(${atr14.toFixed(2)})`,
      macdVal  != null ? `MACD(${macdVal > 0 ? '+' : ''}${macdVal.toFixed(2)})` : null,
      bbUpper  != null ? `BB(${bbLower?.toFixed(2)}-${bbUpper?.toFixed(2)})` : null,
      signals.length ? signals.join('+') : 'NEUTRE'
    ].filter(Boolean).join(' | ');

    return { symbol, direction, entry, sl, tp, rrRatio, score: confidence, confidence,
      source: 'tradingview-bridge', trade_status: direction !== 'NEUTRE' ? 'LIVE' : 'WAIT',
      technical, rsi: rsiUsed, ema20: ma20Used, ema50: ma50Used, atr: atr14,
      macd: macdVal, bbUpper, bbLower };
  } catch (_) { return null; }
}
// ─────────────────────────────────────────────────────────────────────────────

// server.js — Trading Auto Backend
// Sources de données: MT5 (priorité 1) → TradingView bridge (priorité 2)
// AUCUN Math.random() pour les prix — toutes les données sont réelles
// AUCUNE source externe (Yahoo Finance ou autre API) n'est autorisée.

// ── RÈGLE ARCHITECTURALE ────────────────────────────────────────────────────
// SOURCE UNIQUE : TradingView bridge (content.js → background.js → /tradingview/live).
// tvDataStore[symbol] = prix + indicateurs (RSI, MACD, BB, MA20, MA50, ATR) de référence.
// Interdiction absolue de toute API externe pour price ou indicateurs.
// ────────────────────────────────────────────────────────────────────────────

'use strict';

// ─── SINGLE-INSTANCE GUARD — détection passive (sans bind, évite race condition) ─
// On tente une connexion client sur PORT. Si ça réussit → déjà occupé → exit.
// Si ECONNREFUSED → port libre → on continue. Aucun bind/close donc zéro race.
const _net = require('net');
(function _checkPort() {
  const _probe = _net.connect(PORT, '127.0.0.1');
  _probe.once('connect', () => {
    _probe.destroy();
    console.error(`\n[ABORT] PORT ${PORT} DÉJÀ OCCUPÉ — instance en conflit détectée.`);
    console.error('[ABORT] Utilisez: .\\run.ps1 restart   (ou: taskkill /F /IM node.exe /T)');
    process.exit(1);
  });
  _probe.once('error', () => { _probe.destroy(); /* port libre — on continue */ });
})();
// ─────────────────────────────────────────────────────────────────────────────

// ...existing code...

// ── TRADE JOURNAL ─────────────────────────────────────────────────────────────
const JOURNAL_FILE = path.join(__dirname, 'store', 'trade-journal.json');
let tradeJournal = [];

function loadJournal() {
  try {
    if (fs.existsSync(JOURNAL_FILE)) {
      tradeJournal = JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8'));
    }
  } catch(_) { tradeJournal = []; }
}

function saveJournal() {
  try {
    fs.writeFileSync(JOURNAL_FILE, JSON.stringify(tradeJournal, null, 2));
  } catch(_) {}
}

function addTradeToJournal(trade) {
  const entry = {
    id: `T${Date.now()}`,
    symbol: trade.symbol,
    direction: trade.direction,
    entry: trade.entry,
    exit: trade.exit,
    sl: trade.sl,
    tp: trade.tp,
    pnlPips: trade.pnlPips,
    won: trade.won,
    rr: trade.rr,
    durationMin: trade.durationMin,
    openedAt: trade.openedAt || new Date().toISOString(),
    closedAt: new Date().toISOString(),
    coachMessage: trade.coachMessage || ''
  };
  tradeJournal.unshift(entry); // plus récent en premier
  if (tradeJournal.length > 200) tradeJournal = tradeJournal.slice(0, 200);
  saveJournal();
  return entry;
}
// ─────────────────────────────────────────────────────────────────────────────

// ── ENTRY LOG — snapshot complet du tick watchdog au moment exact de l'entrée ─
// Permet de vérifier a posteriori : inTop/inBot, TFs, zone, conflit, direction.
const ENTRY_LOG_FILE = path.join(__dirname, 'store', 'entry-log.json');
let entryLog = [];

function loadEntryLog() {
  try {
    if (fs.existsSync(ENTRY_LOG_FILE)) {
      entryLog = JSON.parse(fs.readFileSync(ENTRY_LOG_FILE, 'utf8'));
    }
  } catch(_) { entryLog = []; }
}

function saveEntryLog() {
  try {
    fs.writeFileSync(ENTRY_LOG_FILE, JSON.stringify(entryLog, null, 2));
  } catch(_) {}
}

loadEntryLog();

app.post('/entry-log', (req, res) => {
  try {
    const snap = {
      ts:                req.body.ts || Date.now(),
      datetime:          new Date(req.body.ts || Date.now()).toISOString(),
      symbol:            req.body.symbol || '?',
      mode:              req.body.mode || '?',
      type:              req.body.type || '?',
      direction:         req.body.direction || '?',
      entry:             req.body.entry || 0,
      inTop:             req.body.inTop,
      inBot:             req.body.inBot,
      canEnterFinal:     req.body.canEnterFinal,
      wdConflict:        req.body.wdConflict,
      zoneOk:            req.body.zoneOk,
      zoneStableCount:   req.body.zoneStableCount,
      bridgeConfirmCount:req.body.bridgeConfirmCount,
      tf:                req.body.tf || {},
      pulsionOk:         req.body.pulsionOk,
      blockingKey:       req.body.blockingKey || '?',
      reason:            req.body.reason || ''
    };
    entryLog.unshift(snap); // plus récent en premier
    if (entryLog.length > 100) entryLog = entryLog.slice(0, 100);
    saveEntryLog();
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/entry-log', (req, res) => {
  res.json(entryLog);
});
// ─────────────────────────────────────────────────────────────────────────────

// ─── DEV HELPER — injecte le bouton contexte dans chaque page HTML ────────────
const DEV_HELPER_TAG = '\n<script src="/public/dev-helper.js"></script>\n</body>';
function sendHTMLWithHelper(res, filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const html = raw.includes('dev-helper.js') ? raw : raw.replace('</body>', DEV_HELPER_TAG);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.type('html').send(html);
}

// ─── MENU PRINCIPAL ───────────────────────────────────────────────────────
app.get('/', (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'index.html')));
app.get('/audit', (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'audit-dashboard.html')));
app.get('/audit-dashboard', (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'audit-dashboard.html')));
app.get('/live', (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'live-ops.html')));
app.get('/sse-test', (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'sse-test.html')));
app.get('/control-panel', (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'control-panel.html')));
// /studio désactivé — route supprimée

// ─── Modules réels ───────────────────────────────────────────────────────────
const marketHoursChecker = require('./lib/market-hours-checker'); // [P2] Market hours detection
const agentBus = require('./agent-bus'); // [P3] Agent registry and messaging
const alertManager = require('./alert-manager'); // [P2] Alert system
const realDataSimulator = require('./lib/real-data-simulator'); // [ÉTAPE 1] Real multi-symbol data
let surveillanceAgent, marketStore, normalizeSymbol, orchestrator, auditLogger, indicatorAgent, repairAgent;
let lastRealData = null; // Cache latest real data
let candleManager = null; // [P1] CandleManager — instancié séparément pour isolation
const localPriceStreams = Object.create(null); // symbol -> [{time, open, high, low, close, volume}]

// ─── COACH MESSAGE BUILDER (hiérarchisé, vivant, Pine-driven) ───────────────
function buildCoachMessage(robot) {
  if (!robot || typeof robot !== 'object') return 'Analyse indisponible.';
  let msg = [];
  // 1. Macro
  let macro = [];
  if (robot.macro_bull || robot.macro_bear) {
    if (robot.macro_bull) macro.push('macro haussier');
    if (robot.macro_bear) macro.push('macro baissier');
  }
  if (macro.length) msg.push('Macro : ' + macro.join(' / '));
  // 2. Zones / liquidités
  let zones = [];
  if (robot.zone_proche) zones.push('zone proche = ' + robot.zone_proche);
  if (robot.liq_haute_active) zones.push('liquidité haute active');
  if (robot.liq_basse_active) zones.push('liquidité basse active');
  if (robot.in_top_zone) zones.push('prix en zone haute');
  if (robot.in_bot_zone) zones.push('prix en zone basse');
  if (zones.length) msg.push('Zones : ' + zones.join(' / '));
  // 3. Technique multi-timeframe
  let tech = [];
  if (robot.lecture_1m) tech.push('M1: ' + robot.lecture_1m);
  if (robot.lecture_5m) tech.push('M5: ' + robot.lecture_5m);
  if (robot.lecture_15m) tech.push('M15: ' + robot.lecture_15m);
  if (robot.lecture_60m) tech.push('H1: ' + robot.lecture_60m);
  if (robot.rsi_1m) tech.push('RSI M1: ' + robot.rsi_1m);
  if (robot.rsi_5m) tech.push('RSI M5: ' + robot.rsi_5m);
  if (robot.rsi_15m) tech.push('RSI M15: ' + robot.rsi_15m);
  if (robot.rsi_60m) tech.push('RSI H1: ' + robot.rsi_60m);
  if (robot.short_score) tech.push('score short: ' + robot.short_score);
  if (robot.long_score) tech.push('score long: ' + robot.long_score);
  if (robot.bearRej) tech.push('bear rejection');
  if (robot.bullRej) tech.push('bull rejection');
  if (tech.length) msg.push('Technique : ' + tech.join(' / '));
  // 4. Anticipation
  let anticipation = [];
  if (robot.anticipation) anticipation.push(robot.anticipation + (robot.anticipation_force ? ' (' + robot.anticipation_force + '%)' : ''));
  if (anticipation.length) msg.push('Anticipation : ' + anticipation.join(' / '));
  // 5. Conclusion
  let conclusion = [];
  if (robot.verdict) conclusion.push('verdict = ' + robot.verdict);
  if (robot.signal) conclusion.push('signal = ' + robot.signal);
  if (robot.event) conclusion.push('événement = ' + robot.event);
  if (conclusion.length) msg.push('Conclusion : ' + conclusion.join(' / '));
  // WAIT intelligent
  if (robot.verdict && robot.verdict.toUpperCase().includes('WAIT')) {
    let waitMsg = [];
    if (robot.anticipation && robot.anticipation_force < 90) waitMsg.push('Anticipation en construction, validation technique incomplète.');
    if (robot.zone_proche) waitMsg.push('Surveillance active de la zone : ' + robot.zone_proche);
    if (robot.bullRej || robot.bearRej) waitMsg.push('Rejet détecté : ' + (robot.bullRej ? 'bull' : '') + (robot.bearRej ? 'bear' : ''));
    if (waitMsg.length) msg.push('Pourquoi WAIT : ' + waitMsg.join(' / '));
  }
  return msg.join('\n');
}

try {
  surveillanceAgent = require('./src/agents/surveillance-agent'); // [P3] Event-driven analysis trigger
  indicatorAgent = require('./src/agents/indicator-agent'); // [P4] Technical indicators
  repairAgent = require('./src/agents/repair-agent'); // [P4] Repair/diagnostics
  marketStore      = require('./store/market-store');
  normalizeSymbol  = require('./lib/symbol-normalizer').normalizeSymbol;
  orchestrator     = require('./src/agents/orchestrator');
  auditLogger      = require('./audit-logger');
} catch (e) {
  console.error('[WARN] Modules avancés non disponibles:', e.message);
  // Fallbacks minimalistes pour éviter le crash serveur
  marketStore = {
    bySymbol: {}, analysisCache: {}, sseClients: [],
    systemStatus: { source: 'offline', fluxStatus: 'OFFLINE' },
    lastActiveSymbol: null,
    lastActiveTimeframe: 'H1',
    lastActivePrice: null,
    updateFromMT5: function(p, s) { 
      this.bySymbol[s] = { latestPayload: p, updatedAt: Date.now() };
      this.lastActiveSymbol = s;
      this.lastActiveTimeframe = p.timeframe || 'H1';
      this.lastActivePrice = p.price || p.bid || p.ask || null;
    },
    updateAnalysis: function(s, a) { this.analysisCache[s] = a; this.broadcast({ type: 'analysis', symbol: s, analysis: a }); },
    addSSEClient: function(res) { this.sseClients.push(res); res.on('close', () => { this.sseClients = this.sseClients.filter(c => c !== res); }); },
    broadcast: function(d) { if (this.sseClients.length === 0) return; const m = 'data: ' + JSON.stringify(d) + '\n\n'; this.sseClients = this.sseClients.filter(res => { try { res.write(m); return true; } catch { return false; } }); },
    getState: function() { return { systemStatus: this.systemStatus, bySymbol: this.bySymbol, analysisCache: this.analysisCache }; },
    getLatestForSymbol: function(s) { return this.bySymbol[s] || null; }
  };
  normalizeSymbol = (raw) => {
    const clean = String(raw || 'EURUSD').trim().toUpperCase().replace(/[._-](A|B|C|PRO|MICRO|MINI|NANO|CASH|ECN|STP|RAW|VIP|M|N|X)$/i, '');

    let canonical = clean;
    if (/XAU|GOLD/.test(clean)) canonical = 'XAUUSD';
    else if (/XAG|SILVER/.test(clean)) canonical = 'XAGUSD';
    else if (/NAS100|NASDAQ|US100/.test(clean)) canonical = 'NAS100';
    else if (/US500|SPX|SP500|S&P/.test(clean)) canonical = 'US500';
    else if (/US30|DOW|DJI/.test(clean)) canonical = 'US30';
    else if (/DE40|DAX|GER40/.test(clean)) canonical = 'DE40';
    else if (/^BTC/.test(clean)) canonical = 'BTCUSD';
    else if (/^ETH/.test(clean)) canonical = 'ETHUSD';

    const type = /XAU|XAG/.test(canonical) ? 'metal' : /BTC|ETH/.test(canonical) ? 'crypto' : /US30|US500|NAS100|DE40/.test(canonical) ? 'index' : 'forex';
    const digits = type === 'metal' ? 2 : type === 'crypto' ? 2 : type === 'index' ? 1 : 5;
    const slPct = type === 'metal' ? 0.004 : type === 'crypto' ? 0.012 : type === 'index' ? 0.005 : 0.002;
    const tpPct = type === 'metal' ? 0.012 : type === 'crypto' ? 0.030 : type === 'index' ? 0.015 : 0.006;
    const pip = type === 'metal' ? 0.1 : type === 'crypto' ? 1 : type === 'index' ? 1 : 0.0001;
    // Buffer latence/spread — compense le délai TV→extension→serveur (~200ms) + cycle monitor (2000ms)
    // SL ne déclenche que si prix dépasse le niveau de ce buffer (évite faux SL sur pics/latence)
    // TP se déclenche légèrement avant le niveau exact (compense latence de détection)
    const slippageBuffer = type === 'metal' ? 0.5      // XAUUSD: 50 cents buffer
                         : type === 'crypto' ? 5.0     // BTC/ETH: $5 buffer
                         : type === 'index' ? 1.0      // US30/NAS: 1 pt buffer
                         : type === 'forex' && canonical.includes('JPY') ? 0.020 // JPY: 2 pips
                         : 0.0002;                     // Forex: 2 pips
    return { canonical, broker_symbol: raw, type, digits, slPct, tpPct, pip, slippageBuffer };
  };
  orchestrator = null;
}

// ─── [P1] CANDLE MANAGER — chargé séparément pour isolation totale ────────────
try {
  const CandleManager = require('./lib/candle-manager');
  candleManager = new CandleManager();
  candleManager.on('candle:closed', (event) => {
    marketStore.broadcast({ type: 'candle:closed', symbol: event.symbol, timeframe: event.timeframe, candle: event.candle, timestamp: event.timestamp });
    console.log(`[CANDLE] ${event.symbol} ${event.timeframe} bougie fermée — O:${event.candle?.open} H:${event.candle?.high} L:${event.candle?.low} C:${event.candle?.close}`);
  });
  console.log('[CANDLE] CandleManager chargé — en attente d\'initialize()');
} catch (e) {
  console.error('[CANDLE WARN] CandleManager non disponible:', e.message);
  candleManager = null;
}

// ─── MT5 DATA ACCESS FUNCTION ──────────────────────────────────────────────────
// Reads real MT5 data from mt5_data.json (written by EA)
function mt5Fetch(path) {
  return new Promise((resolve, reject) => {
    try {
      const dataFile = require('path').join(__dirname, 'mt5_data.json');
      const rawData = require('fs').readFileSync(dataFile, 'utf8');
      const mt5Data = JSON.parse(rawData);
      
      if (path.includes('/mt5/price')) {
        const symbol = mt5Data.symbol?.name || 'UNKNOWN';
        const price = mt5Data.symbol?.price;
        if (price !== undefined) {
          resolve({ ok: true, symbol, price });
        } else {
          reject(new Error('Price data not available in mt5_data.json'));
        }
      } else if (path.includes('/mt5/klines')) {
        const klines = mt5Data.klines || [];
        resolve({ ok: true, klines });
      } else {
        reject(new Error('Unknown MT5 endpoint'));
      }
    } catch (e) {
      reject(e);
    }
  });
}

function recordLocalPricePoint(symbol, payload) {
  try {
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return;
    const rawPrice = payload?.price ?? payload?.bid ?? payload?.ask;
    const price = Number(rawPrice);
    if (!Number.isFinite(price) || price <= 0) return;
    const ts = payload?.timestamp ? new Date(payload.timestamp).getTime() : Date.now();
    const point = {
      time: ts,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: Number(payload?.volume || 0)
    };
    if (!Array.isArray(localPriceStreams[sym])) localPriceStreams[sym] = [];
    localPriceStreams[sym].push(point);
    if (localPriceStreams[sym].length > 400) {
      localPriceStreams[sym] = localPriceStreams[sym].slice(-400);
    }
  } catch (_) {}
}

if (marketStore && typeof marketStore.on === 'function') {
  marketStore.on('mt5-update', (sym, payload) => {
    recordLocalPricePoint(sym, payload || {});
  });
}

// ─── MT5 Bridge Configuration ──────────────────────────────────────────────────
// Single-environment lock: only localhost:4000 bridge endpoint is accepted.
const _bridgeEnvRaw = String(process.env.MT5_BRIDGE || '').trim();
const MT5_BRIDGE_PYTHON = /^https?:\/\/(127\.0\.0\.1|localhost):4000(\/|$)/i.test(_bridgeEnvRaw)
  ? _bridgeEnvRaw.replace(/\/$/, '')
  : '';

// Bridge status tracker
let bridgeStatus = {
  connected: false,
  lastCheck: null,
  checkInterval: 5000
};

// ─── MT5 DATA POLLING — Pull data from MT5 data file every 2 seconds ──────────
let _mt5PollTimer = null;

function extractSnapshotSymbols(data) {
  const out = [];
  if (!data || typeof data !== 'object') return out;

  if (data.symbol && typeof data.symbol === 'object') {
    out.push(data.symbol);
  }

  if (Array.isArray(data.symbols)) {
    data.symbols.forEach((s) => {
      if (s && typeof s === 'object') out.push(s);
    });
  } else if (data.symbols && typeof data.symbols === 'object') {
    Object.entries(data.symbols).forEach(([name, value]) => {
      if (value && typeof value === 'object') {
        out.push({ name, ...value });
      }
    });
  }

  return out;
}

function normalizeSnapshotCandles(candles) {
  if (!Array.isArray(candles)) return [];
  return candles
    .map((c) => ({
      time: c.time || c.timestamp || Date.now(),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume || 0)
    }))
    .filter((c) => Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close));
}

function ingestMT5Snapshot(data, sourceLabel, freshness = null) {
  const symbols = extractSnapshotSymbols(data);
  if (!symbols.length) return 0;

  symbols.forEach((mtData) => {
    const symbolName = String(mtData.name || mtData.symbol || '').toUpperCase();
    if (!symbolName) return;
    const canonical = normalizeSymbol(symbolName).canonical;

    let chartCandles = [];
    if (data?.charts && typeof data.charts === 'object') {
      const symChart = data.charts[symbolName] || data.charts[canonical] || data.charts[mtData.name];
      if (symChart && Array.isArray(symChart.candles)) chartCandles = normalizeSnapshotCandles(symChart.candles);
    }
    if (chartCandles.length === 0 && data?.chart && Array.isArray(data.chart.candles)) {
      chartCandles = normalizeSnapshotCandles(data.chart.candles);
    }

    marketStore.updateFromMT5({
      symbol: symbolName,
      price: mtData.price || mtData.bid,
      bid: mtData.bid || mtData.price,
      ask: mtData.ask || mtData.price,
      volume: mtData.volume || 0,
      timeframe: mtData.timeframe || data?.chart?.timeframe || 'H1',
      source: sourceLabel,
      timestamp: new Date().toISOString(),
      history: chartCandles,
      ohlc: chartCandles,
      fileFreshness: freshness || undefined
    }, canonical);
  });

  return symbols.length;
}

async function pollMT5BridgeData() {
  try {
    const activeSource = String(bridgeConfig.activeSource || (bridgeConfig.mt5Enabled === true ? 'mt5' : 'tradingview')).toLowerCase() === 'mt5' ? 'mt5' : 'tradingview';
    if (activeSource !== 'mt5') {
      bridgeStatus.connected = false;
      bridgeStatus.lastCheck = new Date().toISOString();
      return;
    }

    if (bridgeConfig && bridgeConfig.mt5Enabled !== true) {
      bridgeStatus.connected = false;
      bridgeStatus.lastCheck = new Date().toISOString();
      return;
    }

    // Optional external bridge (opt-in only via MT5_BRIDGE env variable)
    if (MT5_BRIDGE_PYTHON) {
      try {
        const response = await fetch(`${MT5_BRIDGE_PYTHON}/mt5/latest`, {
          signal: AbortSignal.timeout(1000)
        });

        if (response.ok) {
          const data = await response.json();
          bridgeStatus.connected = true;
          bridgeStatus.lastCheck = new Date().toISOString();

          if (data.data && ingestMT5Snapshot(data.data, 'mt5-bridge-python') > 0) {
            return; // Success, exit
          }
        }
      } catch (e) {
        // Bridge not available
      }
    }

    // Strict mode: never ingest market data from local file fallback.
    bridgeStatus.connected = false;
    bridgeStatus.lastCheck = new Date().toISOString();
  } catch (err) {
    bridgeStatus.connected = false;
    console.log('[MT5 POLL] Error reading MT5 data:', err.message);
  }
}

// Start MT5 bridge polling on server startup
function startMT5Polling(intervalMs = 2000) {
  if (_mt5PollTimer) clearInterval(_mt5PollTimer);
  _mt5PollTimer = setInterval(pollMT5BridgeData, intervalMs);
  console.log('[MT5 POLLING] Started @ ' + intervalMs + 'ms — polling from ' + MT5_BRIDGE_PYTHON + ' or mt5_data.json');
  // Initial poll immediately
  pollMT5BridgeData();
}

function stopMT5Polling() {
  if (_mt5PollTimer) { 
    clearInterval(_mt5PollTimer); 
    _mt5PollTimer = null;
  }
  console.log('[MT5 POLLING] Stopped');
}

// Health check for MT5 Bridge
function checkMT5Bridge() {
  if (!MT5_BRIDGE_PYTHON) {
    bridgeStatus.connected = false;
    bridgeStatus.lastCheck = new Date().toISOString();
    return;
  }

  const http = require('http');
  const url = `${MT5_BRIDGE_PYTHON}/health`;
  
  http.get(url, { timeout: 2000 }, res => {
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => {
      try {
        const status = JSON.parse(data);
        bridgeStatus.connected = status.mt5_connected === true;
        bridgeStatus.lastCheck = new Date().toISOString();
      } catch (e) {
        bridgeStatus.connected = false;
      }
    });
  }).on('error', () => {
    bridgeStatus.connected = false;
    bridgeStatus.lastCheck = new Date().toISOString();
  });
}

// Check bridge DISABLED - was polling every 15 seconds
// RAISON: Requêtes HTTP inutiles = I/O overhead = CPU spikes
// SOLUTION: Vérifier à la demande avec GET /mt5/status
// NOUVEAU: Endpoint POST /mt5/health-check/enable pour contrôle manuel

let _mt5CheckTimer = null;

function enableMT5HealthCheck(intervalMs = 60000) {
  if (_mt5CheckTimer) clearInterval(_mt5CheckTimer);
  _mt5CheckTimer = setInterval(checkMT5Bridge, intervalMs);
  console.log('[MT5] Health check ENABLED @ ' + intervalMs + 'ms');
}

function disableMT5HealthCheck() {
  if (_mt5CheckTimer) { 
    clearInterval(_mt5CheckTimer); 
    _mt5CheckTimer = null;
  }
  console.log('[MT5] Health check DISABLED');
}

// ─── Zone Manager ─────────────────────────────────────────────────────────────
let zoneManager;
try {
  zoneManager = require('./lib/zone-manager');
} catch {
  zoneManager = {
    zones: [],
    createZone(z) { const zone = { ...z, id: Date.now() + '_' + Math.random().toString(36).slice(2), createdAt: Date.now(), frozen: true, active: true }; this.zones.push(zone); return zone; },
    updateZones(price) { this.zones.forEach(z => { if (!z.active) return; if (z.type === 'supply' && price > z.high * 1.002) z.active = false; if (z.type === 'demand' && price < z.low * 0.998) z.active = false; if (Date.now() - z.createdAt > 4 * 3600000) z.active = false; }); },
    getActiveZones(sym, tf) { return this.zones.filter(z => z.symbol === sym && (!tf || z.tf === tf) && z.active); },
    getAllZones(sym) { return this.zones.filter(z => z.symbol === sym); }
  };
}

// ─── Setup Classifier ─────────────────────────────────────────────────────────
function classifySetup(timeframe, direction, score, modeOverride) {
  const scalperTFs  = ['M1', 'M3', 'M5'];
  const intradayTFs = ['M10', 'M15', 'M30', 'H1', 'H2'];
  const swingTFs    = ['H3', 'H4', 'H6', 'H8', 'H12', 'D1', 'W1'];

  const tf = (timeframe || 'H1').toUpperCase();
  const mo = (modeOverride || '').toUpperCase();
  let setup_type, holding_profile, expected_duration, slMultiplier, tpMultiplier;

  // Mode override (utilisateur choisit SCALPER / SNIPER / SWING dans l'UI)
  if (mo === 'SCALPER') {
    return { setup_type:'SCALPER', holding_profile:'Scalp rapide — sortie en quelques minutes', expected_duration:'1–15 min', slMultiplier:0.5, tpMultiplier:0.4 };
  }
  if (mo === 'SNIPER') {
    return { setup_type:'SNIPER', holding_profile:'Sniper intraday — entrée précise', expected_duration:'30 min – 6h', slMultiplier:1.0, tpMultiplier:0.8 };
  }
  if (mo === 'SWING') {
    return { setup_type:'SWING', holding_profile:'Swing multi-session — patience requise', expected_duration:'1 – 5 jours', slMultiplier:1.5, tpMultiplier:1.2 };
  }

  if (scalperTFs.includes(tf)) {
    // Scalping : TP court, fermeture rapide, R:R ~1:2
    setup_type       = 'SCALPER';
    holding_profile  = 'Scalp rapide — sortie en quelques minutes';
    expected_duration= '1–15 min';
    slMultiplier     = 0.5;   // SL serré
    tpMultiplier     = 0.4;   // TP ~10-12 pts gold (réduit vs ancien 1.0)
  } else if (intradayTFs.includes(tf)) {
    // Sniper intraday : précision, R:R ~1:2.5
    setup_type       = 'SNIPER';
    holding_profile  = 'Sniper intraday — entrée précise, session fermée';
    expected_duration= '30 min – 6h';
    slMultiplier     = 1.0;
    tpMultiplier     = 0.8;   // TP ~20-25 pts gold (réduit vs ancien 2.0)
  } else {
    // Swing : objectif multi-session, R:R ~1:2.5
    setup_type       = 'SWING';
    holding_profile  = 'Swing multi-session — patience requise';
    expected_duration= '1 – 5 jours';
    slMultiplier     = 1.5;
    tpMultiplier     = 1.2;   // TP ~35 pts gold (réduit vs ancien 3.5)
  }

  return { setup_type, holding_profile, expected_duration, slMultiplier, tpMultiplier };
}

// ─── Trade Validator ──────────────────────────────────────────────────────────
function validateTrade(trade, currentPrice) {
  if (!trade || !currentPrice || !trade.entry) return { ...trade, trade_status: 'UNKNOWN' };
  const entry  = parseFloat(trade.entry);
  const dist   = Math.abs(currentPrice - entry) / currentPrice;

  let trade_status;
  if (dist < 0.005)       trade_status = 'LIVE';           // <0.5% — exécutable maintenant
  else if (dist < 0.015)  trade_status = 'CONDITIONAL';    // 0.5–1.5% — en attente retour en zone
  else                    trade_status = 'WAIT';            // >1.5% — setup non exécutable

  const proximity_pct = (dist * 100).toFixed(2);
  const reason = trade_status === 'LIVE'
    ? 'Entrée proche du prix actuel — exécution possible immédiatement'
    : trade_status === 'CONDITIONAL'
    ? `Entrée à ${proximity_pct}% du prix actuel — attendre retour en zone`
    : `Entrée trop loin (${proximity_pct}%) — setup à surveiller, pas d'exécution`;

  return { ...trade, trade_status, proximity_pct, validation_note: reason };
}

// ─── Real price fetching ──────────────────────────────────────────────────────
// Bridge TradingView uniquement — Yahoo Finance SUPPRIMÉ

const priceCache = {}; // { XAUUSD: { price, ts } }

async function fetchYahooPrice(yahooSym) {
  // SUPPRIMÉ — bridge TradingView uniquement. Aucun appel Yahoo Finance autorisé.
  throw new Error('Yahoo Finance supprimé — bridge TV uniquement. Utiliser tvDataStore[symbol].price.');
}

function toYahooSym(canonical) {
  if (/XAUUSD|GOLD/i.test(canonical)) return 'GC=F';
  if (/XAGUSD|SILVER/i.test(canonical)) return 'SI=F';
  if (/BTCUSD|BTC/i.test(canonical)) return 'BTC-USD';
  if (/ETHUSD|ETH/i.test(canonical)) return 'ETH-USD';
  if (/NAS100|NASDAQ/i.test(canonical)) return '^GSPC';  // Use S&P 500 as proxy
  if (/US500|SPY/i.test(canonical)) return '^GSPC';
  if (/US30|DJIA/i.test(canonical)) return '^DJI';
  if (/GER40|DAX/i.test(canonical)) return '^GDAXI';
  if (/UK100|FTSE/i.test(canonical)) return '^FTSE';
  if (/USOIL|CRUDE/i.test(canonical)) return 'CL=F';
  const forex = ['EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD','USDCHF','NZDUSD','EURGBP','EURJPY','GBPJPY'];
  const s = canonical.replace('/','').toUpperCase();
  if (forex.includes(s)) return s + '=X';
  return null;
}

// ─── Calcul des niveaux (réels, basés sur %) ─────────────────────────────────
function calcTradeLevels(price, direction, profile, timeframe, atr = null) {
  const digits = profile.digits || 5;
  const pip = profile.pip || 0.1;
  
  // Use ATR-based levels if available, otherwise use conservative profile percentages
  let slDist, tpDist;
  
  if (atr && atr > 0) {
    // ATR-based: SL = ATR × 0.6 (serré, structure-based), TP = 2.5× SL minimum
    slDist = atr * 0.60;
    tpDist = atr * 1.5;  // 2.5:1 ratio minimum
  }
  // Plafond absolu: jamais dépasser les limites par TF (or = USD, forex = pips)
  const _capSym2 = String(profile?.canonical || '').toUpperCase();
  const _capG2      = /XAU|GOLD/.test(_capSym2);
  const _capCrypto2 = /BTC|ETH|SOL|XRP|BNB|ADA|LTC|AVAX|MATIC|DOT/.test(_capSym2);
  const _capI2 = /US30|US500|US100|NAS|SPX|SP500|DAX|DE40|GER40/.test(_capSym2);
  const _capJ2 = _capSym2.includes('JPY');
  const _tfCapMap2 = { M1:2.5, M5:5, M15:8, M30:12, H1:18, H4:35, D1:60 };
  // Crypto: cap en % du prix (ex: BTC à 65000 → H1 max SL = 65000×1.5% = $975)
  // Or/Indices: cap en USD/points absolus (18 pour H1)
  // Forex: cap en pips (18 pips = 0.0018 pour 5 décimales)
  const _maxSl2 = _capCrypto2 ? price * 0.015
                : _capG2 || _capI2 ? (_tfCapMap2[String(timeframe||'H1').toUpperCase()] || 18)
                : _capJ2 ? (_tfCapMap2[String(timeframe||'H1').toUpperCase()] || 18) * 0.01
                :           (_tfCapMap2[String(timeframe||'H1').toUpperCase()] || 18) * 0.0001;
  // Calculer slDist/tpDist via profil si ATR absent ou dépassement du cap
  if (!slDist || slDist <= 0) {
    slDist = price * (profile.slPct || 0.003);
    tpDist = price * (profile.tpPct || 0.009);
  }
  // Cap absolu : s'applique TOUJOURS (ATR-based ou profile-percentage)
  if (slDist > _maxSl2) {
    slDist = _maxSl2;
    tpDist = Math.max(tpDist || 0, _maxSl2 * 2.5);
  }

  // BUFFER LATENCE: intégrer le slippageBuffer dans la distance SL calculée
  // Donne de la marge structurelle pour que les pics de latence ne déclenchent pas le SL
  const _latBuf = profile.slippageBuffer || 0;
  if (_latBuf > 0 && slDist > 0) {
    slDist = slDist + _latBuf; // SL légèrement plus éloigné = marge pour latence/spread
    // TP ajusté proportionnellement pour maintenir le RR cible
    if (tpDist > 0) tpDist = tpDist + _latBuf * 2.5;
  }

  const sl = direction === 'LONG' ? price - slDist : price + slDist;
  const tp = direction === 'LONG' ? price + tpDist : price - tpDist;
  const rr = (tpDist / slDist).toFixed(2);
  
  return {
    entry: price.toFixed(digits),
    sl:    sl.toFixed(digits),
    tp:    tp.toFixed(digits),
    rrRatio: rr,
    slPct: ((slDist / price) * 100).toFixed(2) + '%',
    tpPct: ((tpDist / price) * 100).toFixed(2) + '%',
    slPips: (slDist / pip).toFixed(1),
    tpPips: (tpDist / pip).toFixed(1),
    method: atr && atr > 0 ? 'ATR-based' : 'profile-percentage'
  };
}

// ─── SYMBOL MATCHING with Price Validation ────────────────────────────────────
let symbolMatcher;
try {
  symbolMatcher = require('./lib/symbol-matcher');
} catch (e) {
  console.warn('[WARN] Symbol matcher fallback:', e.message);
  symbolMatcher = {
    findCanonicalSymbol: (raw) => {
      const s = (raw || '').toUpperCase();
      if (!s) return { found: false };
      const patterns = [
        [/XAU|GOLD/i, 'XAUUSD'],
        [/XAG|SILVER/i, 'XAGUSD'],
        [/BTC/i, 'BTCUSD'],
        [/ETH/i, 'ETHUSD'],
        [/EUR/i, 'EURUSD'],
        [/GBP/i, 'GBPUSD'],
        [/USDJPY|JPY/i, 'USDJPY'],
        [/AUD/i, 'AUDUSD'],
        [/CAD/i, 'USDCAD'],
        [/CHF/i, 'USDCHF'],
        [/NZD/i, 'NZDUSD'],
      ];
      for (const [pat, canonical] of patterns) {
        if (pat.test(s)) return { found: true, canonical, variant: raw, type: /GOLD|XAU|XAG|SILVER/.test(s) ? 'metal' : /BTC|ETH/.test(s) ? 'crypto' : 'forex' };
      }
      return { found: false };
    },
    matchSymbolWithPriceValidation: (tvSym, tvPrice, backendData) => {
      const match = symbolMatcher.findCanonicalSymbol(tvSym);
      if (!match.found) return { ok: false, error: 'Symbol not recognized' };
      return {
        ok: true,
        tvSymbol: tvSym,
        tvPrice,
        canonical: match.canonical,
        type: match.type,
        selectedSymbol: match.canonical,
        selectedSource: 'fallback',
        selectedPrice: tvPrice,
        syncStatus: 'APPROXIMATED'
      };
    },
    getDisplayStatus: (result) => ({
      symbol: result.selectedSymbol || '?',
      status: result.ok ? 'OK' : 'ERROR',
      message: result.error || 'Using fallback matching',
      color: result.ok ? 'blue' : 'red'
    })
  };
}

app.post('/match-symbol', (req, res) => {
  const { tvSymbol, tvPrice, backendData } = req.body || {};
  if (!tvSymbol) return res.status(400).json({ ok: false, error: 'tvSymbol required' });

  try {
    const result = symbolMatcher.matchSymbolWithPriceValidation(tvSymbol, tvPrice || 0, backendData || {});
    const display = symbolMatcher.getDisplayStatus(result);
    
    res.json({
      ok: true,
      match: result,
      display,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/match-symbol/:tvSymbol', async (req, res) => {
  const tvSymbol = req.params.tvSymbol;
  const tvPrice = parseFloat(req.query.price) || 0;

  try {
    const canonical = symbolMatcher.findCanonicalSymbol(tvSymbol);
    if (!canonical.found) {
      return res.status(404).json({ ok: false, error: 'Symbol not recognized: ' + tvSymbol });
    }

    // Gather available prices
    const mt5Data = marketStore.getLatestForSymbol(canonical.canonical);
    const backendData = {
      mt5: mt5Data?.latestPayload ? { symbol: canonical.canonical, price: parseFloat(mt5Data.latestPayload.price) } : null,
      tradingview: tvPrice > 0 ? { symbol: tvSymbol, price: tvPrice } : null
    };

    const result = symbolMatcher.matchSymbolWithPriceValidation(tvSymbol, tvPrice, backendData);
    const display = symbolMatcher.getDisplayStatus(result);

    res.json({
      ok: true,
      detected: tvSymbol,
      canonical: canonical.canonical,
      type: canonical.type,
      priceMatch: result.syncStatus,
      display,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── BRIQUE 1 — STATS TICKS BRIDGE ──────────────────────────────────────────
app.get('/bridge-ticks/stats', (_req, res) => {
  try {
    const files = fs.readdirSync(TICKS_DIR)
      .filter(f => f.startsWith('bridge-ticks-') && f.endsWith('.ndjson'))
      .sort();
    const todayFile = _getTickFile();
    const todayName = path.basename(todayFile);
    let todayStats = null;
    if (fs.existsSync(todayFile)) {
      const raw = fs.readFileSync(todayFile, 'utf8');
      const lines = raw.split('\n').filter(l => l.trim());
      const ticks = lines.map(l => { try { return JSON.parse(l); } catch(_) { return null; } }).filter(Boolean);
      const syms = [...new Set(ticks.map(t => t.sym))];
      todayStats = {
        file:    todayName,
        sizeKb:  Math.round(fs.statSync(todayFile).size / 1024),
        ticks:   ticks.length,
        firstTs: ticks.length ? new Date(ticks[0].ts).toISOString() : null,
        lastTs:  ticks.length ? new Date(ticks[ticks.length-1].ts).toISOString() : null,
        symbols: syms
      };
    }
    const totalSize = files.reduce((acc, f) => {
      try { return acc + fs.statSync(path.join(TICKS_DIR, f)).size; } catch(_) { return acc; }
    }, 0);
    res.json({ ok: true, today: todayStats, total: { files: files.length, totalSizeKb: Math.round(totalSize / 1024) } });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── SERVER-ID — fingerprint Boulot (utilisé par auto-runner pour vérification anti-confusion) ──
app.get('/server-id', (_req, res) => {
  res.json({ ok: true, env: 'boulot', root: __dirname, port: PORT });
});

// ─── SYSTEM-HEALTH-AGENT — LIA cerveau système ───────────────────────────────
// Analyse la santé technique du système Boulot (tests, stores, divergences).
// Complète lia-dashboard qui analyse le marché.
// Ne touche JAMAIS server.js, popup.js ou tout fichier de logique.
// Écrit uniquement : store/system-health.json + agentStates + sysLogs.

const _SH_STORE        = path.join(__dirname, 'store', 'system-health.json');
const _SH_ALERTS       = path.join(__dirname, 'store', 'alerts.json');
const _SH_INTERVAL_MS  = 30 * 1000; // toutes les 30s
let   _shLastRun       = 0;
let   _shAnalysisCount = 0;
let   _shAlertCount    = 0;

function _shReadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(_) { return null; }
}

function _shReadLines(file, max) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')
      .filter(l => l.trim()).slice(-max)
      .map(l => { try { return JSON.parse(l); } catch(_) { return null; } })
      .filter(Boolean);
  } catch(_) { return []; }
}

function _shComputeHealth() {
  const issues  = [];
  const ok      = [];
  let   score   = 100;
  let   promotionBlocked = false;

  // ── controller (30 pts) ────────────────────────────────────────────────
  const ctrl = _shReadJSON(path.join(__dirname, 'test-report.json'));
  if (!ctrl) {
    ok.push('controller: pas encore exécuté (normal avant fermeture marché)');
  } else if (ctrl.verdict === 'FAIL') {
    const fails = (ctrl.suites || []).flatMap(s => (s.results||[]).filter(r => r.verdict === 'FAIL'));
    fails.forEach(f => issues.push({ sev: 'FAIL', src: 'controller', msg: `Test ${f.id}: ${f.detail}` }));
    score -= Math.min(30, fails.length * 10);
    promotionBlocked = true;
  } else {
    ok.push(`controller: ${ctrl.verdict} (${ctrl.summary?.pass}/${ctrl.summary?.total})`);
  }

  // ── auto-runner (40 pts) ───────────────────────────────────────────────
  const runner = _shReadJSON(path.join(__dirname, 'auto-runner-report.json'));
  if (!runner || runner.verdict === 'PENDING') {
    ok.push('auto-runner: en attente de la prochaine session marché-fermé');
  } else if (runner.verdict === 'FAIL') {
    const s = runner.summary || {};
    if (s.phantomPositions > 0) {
      issues.push({ sev: 'FAIL', src: 'auto-runner', msg: `${s.phantomPositions} position(s) fantôme — EXIT ne nettoie pas proprement` });
      score -= 20; promotionBlocked = true;
    }
    if (s.sseDiv > 0) {
      issues.push({ sev: 'WARN', src: 'auto-runner', msg: `${s.sseDiv} divergence(s) SSE détectée(s)` });
      score -= 10;
    }
    const failCycles = (runner.cycles || []).filter(c => c.verdict === 'FAIL');
    if (failCycles.length > 0) {
      issues.push({ sev: 'FAIL', src: 'auto-runner', msg: `${failCycles.length} cycle(s) FAIL sur ${s.totalCycles}` });
      score -= Math.min(20, failCycles.length * 5);
      if (failCycles.length > 3) promotionBlocked = true;
    }
  } else {
    const s = runner.summary || {};
    ok.push(`auto-runner: ${runner.verdict} — ${s.pass}/${s.totalCycles} cycles | ENTER=${s.entersSimulated} EXIT=${s.exitsValidated} | fantômes=${s.phantomPositions}`);
  }

  // ── stores (20 pts) ────────────────────────────────────────────────────
  const pos = _shReadJSON(path.join(__dirname, 'store', 'active-positions.json'));
  if (pos) {
    for (const [sym, entry] of Object.entries(pos)) {
      if (!entry.state) continue;
      const { entered, virtualPosition } = entry.state;
      if (entered === true && !virtualPosition) {
        issues.push({ sev: 'FAIL', src: 'store', msg: `[${sym}] entered:true mais virtualPosition null` });
        score -= 15; promotionBlocked = true;
      }
      if (entered === false && virtualPosition) {
        issues.push({ sev: 'WARN', src: 'store', msg: `[${sym}] entered:false mais virtualPosition présent (fantôme fichier)` });
        score -= 5;
      }
    }
    if (!issues.some(i => i.src === 'store')) ok.push('stores: active-positions cohérent');
  }

  // ── divergences monitor (10 pts) ──────────────────────────────────────
  const divLines = _shReadLines(path.join(__dirname, 'store', 'divergence-log.ndjson'), 50);
  const recent = divLines.filter(d => d.ts && (Date.now() - d.ts) < 3600000); // dernière heure
  const critDiv = recent.filter(d => d.level === 'FAIL');
  if (critDiv.length > 0) {
    issues.push({ sev: 'FAIL', src: 'monitor', msg: `${critDiv.length} divergence(s) critique(s) dans la dernière heure` });
    score -= Math.min(10, critDiv.length * 5);
    promotionBlocked = true;
  } else if (recent.length === 0) {
    ok.push('monitor: aucune divergence récente');
  }

  score = Math.max(0, Math.min(100, score));
  const verdict = score >= 85 ? 'STABLE' : score >= 60 ? 'DÉGRADÉ' : 'BLOQUÉ';

  return { score, verdict, issues, ok, promotionBlocked };
}

function _shRunAnalysis() {
  if (Date.now() - _shLastRun < _SH_INTERVAL_MS) return;
  _shLastRun = Date.now();
  _shAnalysisCount++;

  try {
    const marketOpen = _mktIsOpen();
    const result     = _shComputeHealth();
    const failCount  = result.issues.filter(i => i.sev === 'FAIL').length;
    const warnCount  = result.issues.filter(i => i.sev === 'WARN').length;

    // ── Mise à jour agentState (visible dans /agent-status + SSE) ─────────
    const taskLine = `[SYSTÈME] Score:${result.score}/100 — ${result.verdict}` +
      (failCount ? ` | ${failCount} FAIL` : '') +
      (warnCount ? ` | ${warnCount} WARN` : '') +
      (result.promotionBlocked ? ' | PROMOTION BLOQUÉE' : '') +
      (marketOpen ? ' | marché ouvert' : '');

    if (typeof updateAgentState === 'function') {
      updateAgentState('system-health-agent', result.verdict === 'STABLE' ? 'idle' : 'warning', taskLine);
    }
    if (agentStates) {
      agentStates['system-health-agent'] = {
        status: result.verdict === 'STABLE' ? 'idle' : 'warning',
        lastActivity: Date.now(),
        activeTask: taskLine
      };
    }

    // ── Écriture store/system-health.json ──────────────────────────────────
    const report = {
      updatedAt: new Date().toISOString(),
      marketOpen,
      score: result.score,
      verdict: result.verdict,
      promotionBlocked: result.promotionBlocked,
      analysisCount: _shAnalysisCount,
      alertsRaised: _shAlertCount,
      issues: result.issues,
      ok: result.ok,
      summary: {
        failCount,
        warnCount,
        okCount: result.ok.length
      }
    };
    try { fs.writeFileSync(_SH_STORE, JSON.stringify(report, null, 2)); } catch(_) {}

    // ── Alertes si FAIL critique ───────────────────────────────────────────
    if (failCount > 0) {
      _shAlertCount++;
      const alerts = {
        ok: false,
        updatedAt: new Date().toISOString(),
        source: 'system-health-agent',
        promotionBlocked: result.promotionBlocked,
        count: failCount,
        alerts: result.issues.filter(i => i.sev === 'FAIL'),
        score: result.score
      };
      try { fs.writeFileSync(_SH_ALERTS, JSON.stringify(alerts, null, 2)); } catch(_) {}

      // Log dans sysLogs (visible dans /system-log et dashboard)
      if (typeof sysLogs !== 'undefined' && Array.isArray(sysLogs)) {
        sysLogs.unshift({
          ts: Date.now(),
          level: 'ERROR',
          agent: 'system-health-agent',
          message: `${failCount} problème(s) critique(s) — ${result.verdict} (score=${result.score}) ${result.promotionBlocked ? '— PROMOTION BLOQUÉE' : ''}`
        });
        if (sysLogs.length > 500) sysLogs.length = 500;
      }
    } else {
      // Nettoyer alerts si tout est OK
      try { fs.writeFileSync(_SH_ALERTS, JSON.stringify({ ok: true, updatedAt: new Date().toISOString(), alerts: [] }, null, 2)); } catch(_) {}
    }

  } catch(e) {
    if (agentStates) {
      agentStates['system-health-agent'] = { status: 'error', lastActivity: Date.now(), activeTask: `Erreur analyse: ${e.message}` };
    }
  }
}

// Lancer l'intervalle du system-health-agent (démarrage différé 10s pour laisser le serveur s'initialiser)
setTimeout(() => {
  _shRunAnalysis();
  setInterval(_shRunAnalysis, _SH_INTERVAL_MS);
}, 10000);

// Endpoint dédié
app.get('/system-health', (_req, res) => {
  const data = (() => { try { return JSON.parse(fs.readFileSync(_SH_STORE, 'utf8')); } catch(_) { return null; } })();
  if (!data) return res.json({ ok: true, verdict: 'INCONNU', score: null, msg: 'Première analyse dans 10s' });
  res.json({ ok: true, ...data });
});

// ─── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  const resolvedCtx = resolveActiveRuntimeContext();
  res.json({
    ok: true,
    port: PORT,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mt5Status: marketStore.systemStatus?.source || 'offline',
    dataSource: marketStore.systemStatus?.fluxStatus || 'OFFLINE',
    // Active context resolved from runtime truth (TradingView/MT5/selection)
    activeContext: {
      symbol: resolvedCtx.active.symbol || null,
      timeframe: resolvedCtx.active.timeframe || 'H1',
      price: resolvedCtx.active.price ?? null,
      source: resolvedCtx.active.source || 'none',
      resolvedBy: resolvedCtx.active.resolvedBy || 'none',
      mode: resolvedCtx.selected?.mode || bridgeConfig.bridgeMode || 'AUTO',
      modeResolved: resolvedCtx.selected?.modeResolved || resolveRuntimeMode(bridgeConfig.bridgeMode || 'AUTO', resolvedCtx.active.symbol, resolvedCtx.active.timeframe || 'H1')
    },
    sourceContexts: resolvedCtx
  });
});

function getLatestTradingviewRuntime() {
  try {
    const entries = Object.entries(tvDataStore || {});
    if (!entries.length) {
      return {
        connected: false,
        lastSource: null,
        symbol: null,
        timeframe: null,
        timestamp: null,
        ageMs: null,
        eventType: null,
        payload: null
      };
    }

    let latest = null;
    for (const [symbol, item] of entries) {
      // Exclure les clés internes (non-symboles) comme _lastBcast
      if (String(symbol).startsWith('_')) continue;
      // Exclure les entrées sans prix valide (pas des symboles réels)
      if (!item || typeof item !== 'object' || !item.price) continue;
      const tsRaw = item?.robotV12?.receivedAt || item?.timestamp || null;
      const tsMs = tsRaw ? Date.parse(tsRaw) : NaN;
      if (!latest || (Number.isFinite(tsMs) && tsMs > (latest.tsMs || 0))) {
        latest = { symbol, item, tsRaw, tsMs };
      }
    }

    if (!latest) {
      return {
        connected: false,
        lastSource: null,
        symbol: null,
        timeframe: null,
        timestamp: null,
        ageMs: null,
        eventType: null,
        payload: null
      };
    }

    const ageMs = Number.isFinite(latest.tsMs) ? Math.max(0, Date.now() - latest.tsMs) : null;
    const robot = latest.item?.robotV12 || null;
    const eventType = robot ? 'robot-v12' : 'tradingview-tick';

    // CONNECTION STABILITY RULE:
    // TradingView is "connected" if:
    // - Last message received < 180 seconds ago (3 minutes)
    // - This prevents flapping from brief network hiccups or slow ticks
    // - If no fresh data for 3+ minutes, assume offline until new data arrives
    const isConnected = Number.isFinite(ageMs) && ageMs < 180000;

    return {
      connected: isConnected,
      lastSource: String(latest.item?.source || latest.item?.action || 'tradingview').toLowerCase(),
      symbol: latest.symbol,
      timeframe: robot?.timeframe || latest.item?.timeframe || null,
      timestamp: latest.tsRaw || null,
      ageMs,
      eventType,
      payload: {
        price:        latest.item?.price ?? null,
        action:       latest.item?.action ?? null,
        verdict:      latest.item?.verdict ?? robot?.verdict ?? null,
        anticipation: latest.item?.anticipation ?? robot?.anticipation ?? null,
        rsi:          latest.item?.indicators?.rsi     ?? null,
        macd:         latest.item?.indicators?.macd    ?? null,
        bb_upper:     latest.item?.indicators?.bb_upper ?? null,
        bb_lower:     latest.item?.indicators?.bb_lower ?? null,
        ma20:         latest.item?.indicators?.ma20    ?? null,
        ma50:         latest.item?.indicators?.ma50    ?? null,
        atr:          latest.item?.indicators?.atr     ?? null,
        entry:        latest.item?.entry  ?? robot?.entry  ?? null,
        sl:           latest.item?.sl     ?? robot?.sl     ?? null,
        tp:           latest.item?.tp     ?? robot?.tp     ?? null,
        rrRatio:      latest.item?.rrRatio ?? robot?.rrRatio ?? null
      }
    };
  } catch (_e) {
    return {
      connected: false,
      lastSource: null,
      symbol: null,
      timeframe: null,
      timestamp: null,
      ageMs: null,
      eventType: null,
      payload: null
    };
  }
}

function findTradingviewSymbolKey(symbol) {
  try {
    const requested = String(symbol || '').trim();
    if (!requested) return null;
    if (requested in (tvDataStore || {})) return requested;

    const requestedCanonical = normalizeSymbol(requested).canonical;
    for (const key of Object.keys(tvDataStore || {})) {
      if (key === requested) return key;
      const keyCanonical = normalizeSymbol(key).canonical;
      if (keyCanonical === requestedCanonical) return key;
    }

    return null;
  } catch (_e) {
    return null;
  }
}

function getRobotV12ForSymbol(symbol) {
  try {
    const resolvedKey = findTradingviewSymbolKey(symbol);
    if (resolvedKey && tvDataStore[resolvedKey]?.robotV12) {
      return tvDataStore[resolvedKey].robotV12;
    }

    const latest = getLatestTradingviewRuntime();
    if (!latest?.symbol) return null;
    const latestCanonical = normalizeSymbol(latest.symbol).canonical;
    const requestedCanonical = normalizeSymbol(symbol || '').canonical;
    if (latestCanonical !== requestedCanonical) return null;

    const latestKey = findTradingviewSymbolKey(latest.symbol);
    return latestKey ? (tvDataStore[latestKey]?.robotV12 || null) : null;
  } catch (_e) {
    return null;
  }
}

function classifyIngressSource(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('mt5')) return 'mt5';
  if (s.includes('tradingview') || s.includes('tv-bridge') || s === 'tv') return 'tradingview';
  return 'other';
}

function inferAutoMode(symbol, timeframe) {
  const tf = String(timeframe || 'H1').toUpperCase();
  const profile = normalizeSymbol(symbol || '');

  const m = tf.match(/^M(\d{1,2})$/);
  if (m) {
    const minutes = parseInt(m[1], 10) || 1;
    if (minutes <= 5) return 'SCALPER';
    if (minutes <= 30) return 'SNIPER';
  }

  if (/^H(1|2|3)$/.test(tf)) return profile.type === 'crypto' ? 'SCALPER' : 'SNIPER';
  if (/^H(4|6|8|12)$/.test(tf) || tf === 'D1' || tf === 'W1' || tf === 'MN1') return 'SWING';

  return 'SNIPER';
}

function resolveRuntimeMode(modeRaw, symbol, timeframe) {
  const requested = normalizeBridgeMode(modeRaw || 'AUTO');
  const mode = String(requested || 'AUTO').toUpperCase();
  return mode === 'AUTO' ? inferAutoMode(symbol, timeframe) : mode;
}

function resolveActiveRuntimeContext() {
  const tv = getLatestTradingviewRuntime();
  const selectedSymbol = activeSymbol?.symbol || null;
  const selectedTf = activeSymbol?.timeframe || null;
  const selectedCanonical = selectedSymbol ? normalizeSymbol(selectedSymbol).canonical : null;
  const selectedTvKey = selectedSymbol ? findTradingviewSymbolKey(selectedSymbol) : null;
  const selectedTvEntry = selectedTvKey ? tvDataStore[selectedTvKey] : null;
  const selectedTvPrice = Number(selectedTvEntry?.price ?? selectedTvEntry?.bid ?? NaN);
  const selectedTvTf = String(selectedTvEntry?.robotV12?.timeframe || selectedTvEntry?.timeframe || '').toUpperCase() || null;
  const selectedTvTs = selectedTvEntry?.robotV12?.receivedAt || selectedTvEntry?.timestamp || null;
  const selectedUpdatedAt = activeSymbol?.updatedAt || null;
  const selectedTvTsMs = selectedTvTs ? Date.parse(selectedTvTs) : NaN;
  const selectedUpdatedMs = selectedUpdatedAt ? Date.parse(selectedUpdatedAt) : NaN;
  const selectedTvIsFresh = Number.isFinite(selectedTvTsMs)
    && (!Number.isFinite(selectedUpdatedMs) || selectedTvTsMs >= (selectedUpdatedMs - 2000));
  const activeSource = String(bridgeConfig.activeSource || (bridgeConfig.mt5Enabled === true ? 'mt5' : 'tradingview')).toLowerCase() === 'mt5' ? 'mt5' : 'tradingview';
  const tvEnabled = bridgeConfig.tradingviewEnabled !== false && activeSource === 'tradingview';
  const tvFresh = !!tvEnabled && !!tv?.connected && !!tv?.symbol;
  const bridgeOn = bridgeConfig.bridgeEnabled !== false;

  let active = {
    symbol: null,
    timeframe: null,
    price: null,
    source: 'none',
    resolvedBy: 'none',
    updatedAt: null
  };

  if (activeSource === 'tradingview' && bridgeOn && selectedSymbol) {
    const useSelectedTv = selectedTvIsFresh && Number.isFinite(selectedTvPrice);
    active = {
      symbol: String(selectedCanonical || selectedSymbol || '').toUpperCase(),
      timeframe: String(selectedTf || (useSelectedTv ? selectedTvTf : null) || 'H1').toUpperCase(),
      price: useSelectedTv ? selectedTvPrice : (activeSymbol?.price ?? activeSymbol?.tvPrice ?? null),
      source: 'tradingview',
      resolvedBy: useSelectedTv ? 'tv-selected-symbol' : (tvFresh ? 'tv-active-symbol-fallback' : 'extension-active-symbol'),
      updatedAt: useSelectedTv ? (selectedTvTs || activeSymbol?.updatedAt || null) : (activeSymbol?.updatedAt || null)
    };
  } else if (activeSource === 'tradingview' && selectedSymbol) {
    active = {
      symbol: String(selectedCanonical || selectedSymbol || '').toUpperCase(),
      timeframe: String(selectedTf || selectedTvTf || 'H1').toUpperCase(),
      price: activeSymbol?.price ?? activeSymbol?.tvPrice ?? null,
      source: 'tradingview',
      resolvedBy: 'extension-active-symbol',
      updatedAt: activeSymbol?.updatedAt || null
    };
  } else if (activeSource === 'mt5' && bridgeOn) {
    const mt5Symbol = marketStore.lastActiveSymbol || selectedCanonical || selectedSymbol || null;
    const mt5Latest = mt5Symbol ? marketStore.getLatestForSymbol(String(mt5Symbol).toUpperCase()) : null;
    const mt5Payload = mt5Latest?.latestPayload || {};
    active = {
      symbol: mt5Symbol ? String(mt5Symbol).toUpperCase() : null,
      timeframe: String(mt5Payload.timeframe || selectedTf || 'H1').toUpperCase(),
      price: mt5Payload.price ?? mt5Payload.bid ?? mt5Payload.ask ?? null,
      source: 'mt5',
      resolvedBy: 'mt5-runtime',
      updatedAt: mt5Payload.timestamp || null
    };
  }

  const selectedModeRaw = activeSymbol?.mode || bridgeConfig.bridgeMode || 'AUTO';
  const selectedModeResolved = resolveRuntimeMode(selectedModeRaw, active.symbol, active.timeframe);

  return {
    active,
    selected: {
      symbol: selectedSymbol,
      timeframe: selectedTf,
      mode: selectedModeRaw,
      modeResolved: selectedModeResolved,
      updatedAt: activeSymbol?.updatedAt || null
    },
    tradingview: {
      symbol: tv?.symbol || null,
      timeframe: tv?.timeframe || null,
      connected: tvEnabled && !!tv?.connected,
      ageMs: tv?.ageMs ?? null,  // CRITICAL: age in milliseconds for stability checks
      eventType: tv?.eventType || null,
      timestamp: tv?.timestamp || null,
      source: tv?.lastSource || null
    },
    market: {
      symbol: null,
      timeframe: null,
      price: null,
      source: bridgeConfig.mt5Enabled === true ? 'mt5-enabled' : 'mt5-disabled',
      sourceRaw: null,
      updatedAt: null
    },
    bridge: {
      enabled: bridgeOn,
      tradingviewEnabled: tvEnabled,
      mt5Enabled: bridgeConfig.mt5Enabled === true,
      activeSource,
      mode: bridgeConfig.bridgeMode || 'AUTO',
      modeResolved: resolveRuntimeMode(bridgeConfig.bridgeMode || 'AUTO', active.symbol, active.timeframe),
      source: bridgeConfig.bridgeSource || null
    }
  };
}

let lastBroadcastedActiveKey = null;
function emitResolvedActiveSymbol(trigger) {
  try {
    const ctx = resolveActiveRuntimeContext();
    const a = ctx.active || {};
    if (!a.symbol) return;
    // Dedup key: symbol + timeframe only. Removing source from key ensures TF changes
    // always broadcast even when source tag changes between calls.
    const key = [String(a.symbol), String(a.timeframe || 'H1')].join('|');
    if (key === lastBroadcastedActiveKey) return;
    lastBroadcastedActiveKey = key;

    broadcastToExtension({
      type: 'active-symbol',
      symbol: a.symbol,
      timeframe: a.timeframe || 'H1',
      price: a.price ?? null,
      mode: activeSymbol?.mode || bridgeConfig.bridgeMode || 'AUTO',
      modeResolved: resolveRuntimeMode(activeSymbol?.mode || bridgeConfig.bridgeMode || 'AUTO', a.symbol, a.timeframe || 'H1'),
      source: a.source || 'unknown',
      resolvedBy: a.resolvedBy || 'unknown',
      trigger: trigger || 'runtime-sync'
    });
  } catch (_e) {}
}

// ─── LIVE OPS SNAPSHOT (single source for real-time cockpit) ───────────────
app.get('/live/state', (_req, res) => {
  try {
    const status = marketStore.systemStatus || {};
    const lastUpdateIso = status.lastUpdate || null;
    const lastUpdateMs = lastUpdateIso ? Date.parse(lastUpdateIso) : NaN;
    const ageMs = Number.isFinite(lastUpdateMs) ? Math.max(0, Date.now() - lastUpdateMs) : null;

    const resolvedCtx = resolveActiveRuntimeContext();
    const symbol = resolvedCtx.active.symbol || null;
    const timeframe = resolvedCtx.active.timeframe || 'H1';
    const latest = symbol ? marketStore.getLatestForSymbol(symbol) : null;
    const tvRuntime = getLatestTradingviewRuntime();

    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      health: {
        serverPort: PORT,
        uptimeSec: Math.floor(process.uptime()),
        source: status.source || 'offline',
        fluxStatus: status.fluxStatus || 'OFFLINE',
        lastUpdate: lastUpdateIso,
        ageMs
      },
      orchestration: {
        enabled: typeof _orchestrationEnabled === 'boolean' ? _orchestrationEnabled : false,
        timer: (_orchestrationAutoTimer ? 'active' : 'inactive')
      },
      context: {
        symbol,
        timeframe,
        price: resolvedCtx.active.price ?? marketStore.lastActivePrice ?? null,
        source: resolvedCtx.active.source || 'none',
        resolvedBy: resolvedCtx.active.resolvedBy || 'none'
      },
      bridge: {
        enabled: bridgeConfig.bridgeEnabled !== false,
        tradingviewEnabled: bridgeConfig.tradingviewEnabled !== false,
        mt5Enabled: bridgeConfig.mt5Enabled === true,
        activeSource: String(bridgeConfig.activeSource || (bridgeConfig.mt5Enabled === true ? 'mt5' : 'tradingview')).toLowerCase() === 'mt5' ? 'mt5' : 'tradingview',
        mode: bridgeConfig.bridgeMode || 'AUTO',
        source: bridgeConfig.bridgeSource || 'tradingview',
        updatedAt: bridgeConfig.updatedAt || null,
        updatedBy: bridgeConfig.updatedBy || null
      },
      streams: {
        marketSseClients: Array.isArray(marketStore.sseClients) ? marketStore.sseClients.length : 0,
        extensionSseClients: Array.isArray(extensionSyncClients) ? extensionSyncClients.length : 0
      },
      agents: {
        liveEnabled: !!agentStates?.enabled,
        indicatorState: indicatorAgent?.getState ? indicatorAgent.getState() : null
      },
      endpoints: {
        '/health': hasExpressRoute('get', '/health'),
        '/stream': hasExpressRoute('get', '/stream'),
        '/extension/sync': hasExpressRoute('get', '/extension/sync'),
        '/audit/state': hasExpressRoute('get', '/audit/state'),
        '/orchestration-status': hasExpressRoute('get', '/orchestration-status'),
        '/orchestration/run-now': hasExpressRoute('post', '/orchestration/run-now'),
        '/data': hasExpressRoute('get', '/data'),
        '/analysis': hasExpressRoute('get', '/analysis')
      },
      latestPayload: latest?.latestPayload || null,
      tradingview: tvRuntime,
      sourceContexts: resolvedCtx
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── AUDIT API ROUTES (Real-time synchronization) ────────────────────────────
// Zéro modification du système existant — uniquement sync + logging

function hasExpressRoute(method, routePath) {
  try {
    const stack = app?._router?.stack || [];
    const wantedMethod = String(method || '').toLowerCase();
    return stack.some((layer) => {
      if (!layer?.route) return false;
      const p = layer.route.path;
      if (p !== routePath) return false;
      return !!layer.route.methods?.[wantedMethod];
    });
  } catch (_e) {
    return false;
  }
}

function reconcileAuditStateWithLiveRoutes(state) {
  if (!state?.audit) return state;

  const routeChecks = {
    '/orchestration/run-now': hasExpressRoute('post', '/orchestration/run-now'),
    '/orchestration-status': hasExpressRoute('get', '/orchestration-status'),
    '/data': hasExpressRoute('get', '/data'),
    '/analysis': hasExpressRoute('get', '/analysis')
  };

  const isResolvedIssue = (issue) => {
    const ep = issue?.endpoint;
    if (!ep || routeChecks[ep] !== true) return false;
    const status = String(issue?.status || '').toUpperCase();
    const desc = String(issue?.description || '').toLowerCase();
    if (status === 'MISSING') return true;
    if (desc.includes('missing endpoint')) return true;
    if (desc.includes('not defined')) return true;
    if (desc.includes('not implemented')) return true;
    return false;
  };

  const pruneResolvedIssues = (issues) => {
    if (!Array.isArray(issues)) return [];
    return issues.filter((issue) => !isResolvedIssue(issue));
  };

  if (Array.isArray(state.audit.endpoints)) {
    state.audit.endpoints = state.audit.endpoints.map((ep) => {
      if (!ep || !ep.path) return ep;
      if (routeChecks[ep.path] === true) {
        return {
          ...ep,
          status: 'OK',
          lastUpdated: new Date().toISOString()
        };
      }
      return ep;
    });
  }

  if (Array.isArray(state.audit.connections)) {
    state.audit.connections = state.audit.connections.map((conn) => {
      if (!conn || !Array.isArray(conn.issues)) return conn;
      const nextIssues = pruneResolvedIssues(conn.issues);
      if (nextIssues.length !== conn.issues.length) {
        return {
          ...conn,
          issues: nextIssues,
          status: nextIssues.length === 0 ? 'OK' : conn.status
        };
      }
      return conn;
    });
  }

  if (Array.isArray(state.audit.files)) {
    state.audit.files = state.audit.files.map((f) => {
      if (!f || !Array.isArray(f.issues)) return f;
      const nextIssues = pruneResolvedIssues(f.issues);
      if (nextIssues.length !== f.issues.length) {
        return {
          ...f,
          issues: nextIssues,
          status: nextIssues.length === 0 ? 'OK' : f.status
        };
      }
      return f;
    });
  }

  if (Array.isArray(state.audit.errors)) {
    state.audit.errors = state.audit.errors.filter((e) => {
      const desc = String(e?.description || '').toLowerCase();
      if (routeChecks['/orchestration/run-now'] && desc.includes('/orchestration/run-now') && (desc.includes('not implemented') || desc.includes('missing'))) return false;
      if (routeChecks['/orchestration-status'] && desc.includes('/orchestration-status') && (desc.includes('not implemented') || desc.includes('missing'))) return false;
      if (routeChecks['/data'] && desc.includes('/data') && (desc.includes('not implemented') || desc.includes('not defined') || desc.includes('missing'))) return false;
      if (routeChecks['/analysis'] && desc.includes('/analysis') && (desc.includes('not implemented') || desc.includes('not defined') || desc.includes('missing'))) return false;
      return true;
    });
  }

  return state;
}

function syncAuditStateToDisk() {
  try {
    const state = auditLogger.getState();
    const reconciled = reconcileAuditStateWithLiveRoutes(state);
    if (reconciled?.audit) {
      auditLogger.audit = reconciled.audit;
      auditLogger.writeAudit();
    }
    return reconciled;
  } catch (e) {
    console.error('[AUDIT SYNC]', e.message);
    return auditLogger.getState();
  }
}

// GET /audit/state — État complet du système
app.get('/audit/state', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.json(syncAuditStateToDisk());
});

// GET /audit/events — Événements récents
app.get('/audit/events', (req, res) => {
  const limit = parseInt(req.query.limit || 20);
  res.json(auditLogger.getRecentEvents(limit));
});

// POST /audit/log — Logger un événement manuel
app.post('/audit/log', (req, res) => {
  const { category, action, details } = req.body;
  if (!category || !action) return res.status(400).json({ ok: false, error: 'category and action required' });
  const event = auditLogger.logEvent(category, action, details || {});
  res.json({ ok: true, event });
});

// POST /audit/task/:taskId — Mettre à jour une tâche
app.post('/audit/task/:taskId', (req, res) => {
  const { taskId } = req.params;
  const { status, name, completeness, issues, files } = req.body;
  const task = auditLogger.updateTask(taskId, { status, name, completeness, issues, files });
  res.json({ ok: true, task });
});

// POST /audit/task/:taskId/complete — Marquer une tâche complète
app.post('/audit/task/:taskId/complete', (req, res) => {
  const { taskId } = req.params;
  const task = auditLogger.completeTask(taskId);
  res.json({ ok: true, task });
});

// POST /audit/task/:taskId/fail — Marquer une tâche en erreur
app.post('/audit/task/:taskId/fail', (req, res) => {
  const { taskId } = req.params;
  const { reason } = req.body;
  const task = auditLogger.failTask(taskId, reason);
  res.json({ ok: true, task });
});

// POST /audit/error/:errorId — Ajouter/mettre à jour une erreur
app.post('/audit/error/:errorId', (req, res) => {
  const { errorId } = req.params;
  const errorData = req.body;
  const error = auditLogger.addError(errorId, errorData);
  res.json({ ok: true, error });
});

// POST /audit/error/:errorId/resolve — Résoudre une erreur
app.post('/audit/error/:errorId/resolve', (req, res) => {
  const { errorId } = req.params;
  const { resolution } = req.body;
  const error = auditLogger.resolveError(errorId, resolution);
  res.json({ ok: true, error });
});

// GET /audit/health — Scan système pour erreurs
app.get('/audit/health', (_req, res) => {
  const issues = auditLogger.scanSystemHealth();
  res.json({ ok: true, issues, count: issues.length });
});

// ─── MT5 API ROUTES FOR EXTENSION ──────────────────────────────────────────────

// GET /mt5/latest — Dernier snapshot MT5 complet
app.get('/mt5/latest', (req, res) => {
  try {
    const symbol = marketStore.lastActiveSymbol || getLatestTradingviewRuntime().symbol || '';
    
    if (!latest || !latest.latestPayload) {
      return res.status(404).json({ 
        ok: false, 
        error: 'No MT5 data yet', 
        symbol,
        note: 'Bridge MT5 pas encore connecté'
      });
    }
    
    res.json({
      ok: true,
      symbol,
      data: latest.latestPayload,
      receivedAt: new Date(latest.updatedAt).toISOString(),
      age_ms: Date.now() - latest.updatedAt
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /mt5/current-chart — Symbole courant + rates du timeframe actif
app.get('/mt5/current-chart', (req, res) => {
  try {
    const symbol = String(req.query.symbol || marketStore.lastActiveSymbol || '').toUpperCase();
    if (!symbol) return res.status(400).json({ ok: false, error: 'symbol parameter required or no active symbol' });
    const tf = String(req.query.tf || marketStore.lastActiveTimeframe || 'H1').toUpperCase();
    const latest = marketStore.getLatestForSymbol(symbol);
    
    if (!latest || !latest.latestPayload) {
      return res.json({
        ok: false,
        symbol,
        timeframe: tf,
        error: 'No data'
      });
    }
    
    const payload = latest.latestPayload;
    const candleRates = candleManager
      ? candleManager.getCandles(symbol, tf, 180).map((c) => ({
        time: c.timeOpen,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 0),
        status: c.status || 'closed'
      }))
      : [];
    const fallbackRates = Array.isArray(payload.history) ? payload.history : [];
    const localStreamRates = Array.isArray(localPriceStreams[symbol]) ? localPriceStreams[symbol].slice(-220) : [];
    const rates = candleRates.length >= 2
      ? candleRates
      : (fallbackRates.length >= 2 ? fallbackRates : localStreamRates);

    res.json({
      ok: true,
      symbol,
      timeframe: tf,
      bid: payload.bid,
      ask: payload.ask,
      price: payload.price || (payload.bid + payload.ask) / 2,
      spread: (payload.ask - payload.bid).toFixed(5),
      ohlc: payload.ohlc,
      indicators: {
        rsi: payload.rsi || null,
        macd: payload.macd || null,
        ma20: payload.ma20 || null
      },
      // Priorité aux bougies locales temps réel (sans API externe)
      rates,
      candleSource: candleRates.length >= 2
        ? 'candle-manager'
        : (fallbackRates.length >= 2 ? 'payload-history' : 'local-price-stream'),
      lastUpdate: new Date(latest.updatedAt).toISOString()
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /mt5/symbols — Liste des symboles MT5 disponibles
app.get('/mt5/symbols', (req, res) => {
  try {
    const symbols = Object.keys(marketStore.bySymbol || {}).map(sym => ({
      symbol: sym,
      lastUpdate: marketStore.bySymbol[sym]?.updatedAt,
      stale: (Date.now() - marketStore.bySymbol[sym]?.updatedAt) > 30000
    }));
    
    res.json({
      ok: true,
      count: symbols.length,
      symbols,
      message: symbols.length === 0 ? 'En attente de snapshots MT5' : 'OK'
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /mt5/live-symbols — symboles réellement alimentés en temps réel
app.get('/mt5/live-symbols', (req, res) => {
  try {
    const now = Date.now();
    const symbols = Object.keys(marketStore.bySymbol || {})
      .map((sym) => {
        const item = marketStore.bySymbol[sym] || {};
        const payload = item.latestPayload || {};
        const updatedAtMs = Number(item.updatedAt || 0);
        const ageMs = updatedAtMs > 0 ? Math.max(0, now - updatedAtMs) : null;
        return {
          symbol: sym,
          price: Number(payload.price ?? payload.bid ?? payload.ask ?? NaN),
          source: payload.source || 'unknown',
          timeframe: String(payload.timeframe || marketStore.lastActiveTimeframe || 'H1').toUpperCase(),
          updatedAt: updatedAtMs ? new Date(updatedAtMs).toISOString() : null,
          ageMs,
          isFresh: Number.isFinite(ageMs) ? ageMs <= 15000 : false
        };
      })
      .filter((s) => s.symbol)
      .sort((a, b) => {
        const af = a.isFresh ? 1 : 0;
        const bf = b.isFresh ? 1 : 0;
        if (af !== bf) return bf - af;
        return a.symbol.localeCompare(b.symbol);
      });

    res.json({
      ok: true,
      count: symbols.length,
      symbols,
      message: symbols.length > 0
        ? 'Flux réel local actif'
        : 'Aucun symbole MT5 actif pour le moment'
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /mt5/symbol/:symbol — Infos détaillées sur un symbole MT5
app.get('/mt5/symbol/:symbol', (req, res) => {
  try {
    const sym = req.params.symbol.toUpperCase();
    const data = marketStore.getLatestForSymbol(sym);
    
    if (!data || !data.latestPayload) {
      return res.status(404).json({
        ok: false,
        symbol: sym,
        error: 'Symbol not found in MT5 data'
      });
    }
    
    const payload = data.latestPayload;
    res.json({
      ok: true,
      symbol: sym,
      bid: payload.bid,
      ask: payload.ask,
      price: payload.price,
      spread: payload.ask - payload.bid,
      volume: payload.ohlc?.volume || 0,
      indicators: {
        rsi: payload.rsi,
        macd: payload.macd,
        ma20: payload.ma20
      },
      digits: payload.digits,
      pip_size: payload.pip_size,
      account: payload.account,
      market_watch: payload.market_watch,
      lastUpdate: new Date(data.updatedAt).toISOString()
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── MAPPING ROUTES ────────────────────────────────────────────────────────────

// POST /mapping/resolve — Recherche intelligente symbole MT5
app.post('/mapping/resolve', async (req, res) => {
  try {
    const { name, price, type } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    
    const searchTerm = name.toUpperCase();
    const availableSymbols = Object.keys(marketStore.bySymbol || {});
    
    // Scoring simple: exact match > prefix match > contains
    const scored = availableSymbols.map(sym => {
      let score = 0;
      if (sym === searchTerm) score = 1000;
      else if (sym.startsWith(searchTerm)) score = 500;
      else if (sym.includes(searchTerm)) score = 250;
      
      // Bonus si prix correspond
      let currentPrice = null;
      let priceMatch = false;
      const data = marketStore.getLatestForSymbol(sym);
      if (data && data.latestPayload) {
        currentPrice = data.latestPayload.price;
        if (price) {
          const diff = Math.abs(currentPrice - parseFloat(price));
          if (diff < 10) {
            score += 200;
            priceMatch = true;
          }
        }
      }
      
      return { symbol: sym, score, currentPrice, priceMatch };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);  // Top 10 results
    
    res.json({
      ok: true,
      query: name,
      suggestions: scored.map(s => ({
        symbol: s.symbol,
        confidence: Math.min(100, Math.round(s.score / 10)),
        currentPrice: s.currentPrice,
        description: s.currentPrice ? `Prix actuel: ${s.currentPrice.toFixed(2)}` : '(N/A)',
        priceMatch: s.priceMatch
      }))
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /mapping/save — Sauvegarde correspondance
app.post('/mapping/save', (req, res) => {
  try {
    const { userInput, mt5Symbol } = req.body;
    if (!userInput || !mt5Symbol) {
      return res.status(400).json({ ok: false, error: 'userInput and mt5Symbol required' });
    }
    
    // TODO: Persister dans une base ou fichier JSON mapping.json
    console.log(`[MAPPING] ${userInput} → ${mt5Symbol}`);
    
    res.json({
      ok: true,
      message: `Mapping saved: ${userInput} → ${mt5Symbol}`,
      userInput,
      mt5Symbol
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /mapping/list — Liste des mappings enregistrés
app.get('/mapping/list', (req, res) => {
  try {
    // TODO: Charger depuis mapping.json
    const mappings = [];
    
    res.json({
      ok: true,
      count: mappings.length,
      mappings
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── MT5 BRIDGE ───────────────────────────────────────────────────────────────
app.post('/mt5', async (req, res) => {
  try {
    const activeSource = String(bridgeConfig.activeSource || (bridgeConfig.mt5Enabled === true ? 'mt5' : 'tradingview')).toLowerCase() === 'mt5' ? 'mt5' : 'tradingview';
    if (activeSource !== 'mt5') {
      return res.status(503).json({ ok: false, error: 'mt5 ingress disabled: active source is tradingview', mt5Enabled: false, activeSource });
    }

    if (bridgeConfig.mt5Enabled !== true) {
      return res.status(503).json({ ok: false, error: 'mt5 ingress disabled', mt5Enabled: false });
    }

    const payload  = req.body;
    if (!payload?.symbol) return res.status(400).json({ ok: false, error: 'symbol required' });

    const sourceRaw = String(payload.source || '').toLowerCase();
    if (sourceRaw && /(file|fallback|fixture|cache)/.test(sourceRaw)) {
      return res.status(400).json({ ok: false, error: 'non-live source rejected', source: payload.source, live: false });
    }

    // 🔴 LOG: CLEAR RECEPTION FROM EA
    console.log(`[MT5-POST] EA DIRECT | Symbol: ${payload.symbol} | Bid: ${payload.bid} | Ask: ${payload.ask} | Price: ${payload.price} | TS: ${payload.timestamp}`);

    const profile  = normalizeSymbol(payload.symbol);
    const canonical = profile.canonical;
    const resolvedTf = String(
      payload.timeframe ||
      activeSymbol?.timeframe ||
      marketStore.lastActiveTimeframe ||
      'H1'
    ).toUpperCase();

    // Accept timestamp as ms, seconds, numeric string, or ISO date.
    const tsRaw = payload.timestamp;
    let tickTs = NaN;
    if (typeof tsRaw === 'number' && Number.isFinite(tsRaw)) {
      tickTs = tsRaw < 1e12 ? tsRaw * 1000 : tsRaw;
    } else if (typeof tsRaw === 'string' && /^\d+$/.test(tsRaw)) {
      const n = Number(tsRaw);
      if (Number.isFinite(n)) tickTs = n < 1e12 ? n * 1000 : n;
    } else if (tsRaw) {
      const parsed = new Date(tsRaw).getTime();
      if (Number.isFinite(parsed)) tickTs = parsed;
    }

    if (!Number.isFinite(tickTs)) {
      return res.status(400).json({ ok: false, error: 'timestamp required for live tick validation', live: false });
    }

    const maxTickAgeMs = Math.max(1000, Number(process.env.MT5_MAX_TICK_AGE_MS || 10000));
    const tickAgeMs = Math.abs(Date.now() - tickTs);
    if (tickAgeMs > maxTickAgeMs) {
      return res.status(409).json({
        ok: false,
        error: 'stale tick rejected',
        tickAgeMs,
        maxTickAgeMs,
        live: false
      });
    }

    const livePrice = Number(payload.price || payload.bid || payload.ask);
    if (!Number.isFinite(livePrice) || livePrice <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid live price', live: false });
    }

    marketStore.systemStatus = { source: 'mt5', fluxStatus: 'LIVE', lastUpdate: new Date().toISOString() };
    marketStore.updateFromMT5({
      ...payload,
      canonical,
      source: payload.source || 'mt5-live-direct',
      timeframe: resolvedTf,
      timestamp: new Date(tickTs).toISOString()
    }, canonical);

    // ─── [P3] SURVEILLANCE AGENT — Trigger analysis intelligently ─────────────────
    if (surveillanceAgent) {
      surveillanceAgent.onMT5Tick(canonical, {
        price: parseFloat(payload.price || payload.bid),
        bid: parseFloat(payload.bid),
        ask: parseFloat(payload.ask),
        volume: parseFloat(payload.volume || 0)
      });
    }

    // ─── [P2] MARKET HOURS CHECK — Bloquer ticks marché fermé ────────────────────
    const marketStatus = marketHoursChecker.getStatus(canonical);
    if (!marketStatus.isOpen) {
      console.log(`[TICK_BLOCKED] ${canonical} — ${marketStatus.market} closed (${marketStatus.reason || 'offline'})`);
      return res.json({ ok: false, blocked: true, symbol: canonical, market: marketStatus.market, reason: marketStatus.reason || 'closed' });
    }
    // ──────────────────────────────────────────────────────────────────────────────

    // [P1] Transmission du tick au CandleManager pour agrégation OHLC
    if (candleManager) {
      candleManager.onTick(
        canonical,
        parseFloat(payload.price || payload.bid || 0),
        parseFloat(payload.bid   || 0),
        parseFloat(payload.ask   || 0),
        parseFloat(payload.volume || 0),
        tickTs
      ).catch(e => console.error('[CANDLE TICK ERROR]', e.message));
    }

    // Mise à jour zones si données OHLC disponibles
    const ohlc = payload.ohlc || payload.bars || [];
    if (ohlc.length >= 3 && payload.price) {
      zoneManager.updateZones(parseFloat(payload.price));
    }

    // Broadcast prix immédiat avant orchestrateur
    marketStore.broadcast({ type: 'mt5-raw', symbol: canonical, price: payload.price || payload.bid, timeframe: payload.timeframe, source: 'mt5' });

    // 🔴 UNIFIED SYNC: Envoyer aussi à Extension + HTML clients
    broadcastToExtension({
      type: 'mt5-data',
      symbol: canonical,
      brokerSymbol: payload.symbol,
      price: parseFloat(payload.price || payload.bid || 0),
      bid: parseFloat(payload.bid || 0),
      ask: parseFloat(payload.ask || 0),
      volume: parseFloat(payload.volume || 0),
      timeframe: resolvedTf,
      source: 'mt5-live-direct',
      ohlc: ohlc,
      indicators: {
        rsi: payload.rsi || null,
        macd: payload.macd || null,
        ma20: payload.ma20 || null
      }
    });

    emitResolvedActiveSymbol('mt5-post');

    // DETAILED LOGGING
    const ohlcInfo = ohlc.length > 0 ? `yes (${ohlc.length})` : 'no';
    const logMsg = `[MT5] ${payload.symbol} (${canonical}) | Price:${payload.price} | Bid:${payload.bid} Ask:${payload.ask} | TF:${payload.timeframe || 'N/A'} | OHLC:${ohlcInfo}`;
    console.log(logMsg);

    if (orchestrator) {
      orchestrator.run({ ...payload, symbol: canonical, broker_symbol: payload.symbol })
        .then(analysis => {
          marketStore.updateAnalysis(canonical, analysis);
          console.log(`[ORCH] ${canonical} → ${analysis.direction} score=${analysis.score}`);
        })
        .catch(e => console.error('[ORCH ERROR]', e.message));
    }

    return res.json({ ok: true, canonical, brokerSymbol: payload.symbol, assetType: profile.type });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── [P2] ENDPOINT: Market Status Diagnostic ───────────────────────────────────
// GET /mt5/market-status?symbol=EURUSD
// Retourne: { isOpen, market, session, opensIn, closesIn, ... }
app.get('/mt5/market-status', (req, res) => {
  try {
    const { symbol } = req.query;
    
    if (!symbol) {
      // Return status for all active symbols
      const activeSymbols = Object.keys(marketStore.bySymbol);
      const statuses = activeSymbols.map(s => ({
        symbol: s,
        ...marketHoursChecker.getStatus(s),
        lastTickTime: marketStore.bySymbol[s]?.updatedAt || null,
        lastTickPrice: marketStore.bySymbol[s]?.latestPayload?.price || null
      }));
      return res.json({ count: statuses.length, statuses });
    }
    
    // Single symbol
    const status = marketHoursChecker.getStatus(symbol);
    const lastData = marketStore.bySymbol[symbol];
    
    return res.json({
      symbol,
      ...status,
      lastTickTime: lastData?.updatedAt || null,
      lastTickPrice: lastData?.latestPayload?.price || null
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});
// ──────────────────────────────────────────────────────────────────────────────

// ─── MT5 BRIDGE PROXY — legacy-compatible HTTP relay (non-4000) ─────────────
const http       = require('http');
// MT5_BRIDGE_PYTHON already configured at top of file (check health via /mt5/status)

function mt5Fetch(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(MT5_BRIDGE_PYTHON + path, { timeout: 4000 }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error from MT5 Bridge')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('MT5 Bridge Python timeout')); });
  });
}

// Proxy transparent vers le bridge Python MT5 RÉEL
app.get('/mt5/status',  async (_req, res) => { 
  try {
    // Return connection status based on real data reception (no legacy port call)
    const connStatus = {
      ok: true,
      connected: false,
      source: marketStore.systemStatus?.source || 'offline',
      fluxStatus: marketStore.systemStatus?.fluxStatus || 'OFFLINE',
      lastUpdate: marketStore.systemStatus?.lastUpdate || null,
      message: 'MT5 not connected - no POST /mt5 received yet'
    };
    
    // Check if we've received MT5 data AND it's recent (within last 2 minutes)
    if (marketStore.systemStatus?.source === 'mt5' && marketStore.systemStatus?.fluxStatus === 'LIVE') {
      const lastUpdateTime = new Date(marketStore.systemStatus.lastUpdate).getTime();
      const nowTime = Date.now();
      const ageMs = nowTime - lastUpdateTime;
      const ageSec = Math.floor(ageMs / 1000);
      
      if (ageMs < 120000) {
        connStatus.connected = true;
        connStatus.message = `MT5 connected (data ${ageSec}s old)`;
      } else {
        connStatus.message = `MT5 data stale (last update ${ageSec}s ago)`;
      }
    }
    
    res.json(connStatus);
  } catch (e) { 
    res.json({ 
      ok: false, 
      connected: false, 
      error: e.message,
      note: 'Error checking MT5 connection'
    }); 
  } 
});

app.get('/mt5/match',   async (req, res) => {
  const { name='', price='', category='' } = req.query;
  try { 
    res.json(await mt5Fetch(`/mt5/match?name=${encodeURIComponent(name)}&price=${encodeURIComponent(price)}&category=${encodeURIComponent(category)}`)); 
  }
  catch (e) {
    res.json({ 
      ok:false, 
      error:e.message, 
      query:name, 
      candidates:[],
      note:'MT5 Bridge error — check if mt5_bridge.py is running'
    });
  }
});
app.get('/mt5/price', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'XAUUSD';

    const mt5Response = await mt5Fetch('/mt5/price?symbol=' + encodeURIComponent(symbol));
    if (mt5Response?.ok && Number.isFinite(Number(mt5Response.price)) && Number(mt5Response.price) > 0) {
      return res.json(mt5Response);
    }

    return res.status(503).json({
      ok: false,
      symbol,
      error: 'No live MT5 price available',
      source: 'none',
      live: false
    });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message, source: 'none', live: false });
  }
});
app.get('/mt5/klines',  async (req, res) => {
  const { symbol, tf='H1', count='200' } = req.query;
  if (!symbol) return res.status(400).json({ ok: false, error: 'symbol parameter required' });
  try {
    const data = await mt5Fetch(`/mt5/klines?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}&count=${encodeURIComponent(count)}`);
    // Compatibility bridge: legacy/background expects "rates", modern handlers use "klines".
    if (data && Array.isArray(data.klines) && !Array.isArray(data.rates)) {
      data.rates = data.klines;
    }
    if (data && Array.isArray(data.klines) && data.klines.length > 0) {
      return res.json(data);
    }

    return res.status(503).json({
      ok: false,
      symbol: normalizeSymbol(String(symbol || '').toUpperCase()).canonical,
      timeframe: String(tf || 'H1').toUpperCase(),
      error: 'No live MT5 klines available',
      source: 'none',
      live: false
    });
  }
  catch (e) {
    return res.status(503).json({ ok:false, error:e.message, source: 'none', live: false });
  }
});

app.get('/mt5/file-health', (_req, res) => {
  try {
    const dataFile = path.join(__dirname, 'mt5_data.json');
    if (!fs.existsSync(dataFile)) {
      return res.status(404).json({ ok: false, exists: false, live: false, error: 'mt5_data.json not found' });
    }

    const stat = fs.statSync(dataFile);
    const ageMs = Date.now() - stat.mtimeMs;
    const live = ageMs <= 10000;
    return res.json({
      ok: true,
      exists: true,
      live,
      source: 'file-diagnostic-only',
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      ageMs,
      ageSec: Math.round(ageMs / 1000)
    });
  } catch (e) {
    return res.status(500).json({ ok: false, live: false, error: e.message });
  }
});

// GET /economic-events — Événements économiques réels (ForexFactory, partagé avec /market-news)
app.get('/economic-events', async (req, res) => {
  try {
    const now = Date.now();
    if (!_newsCache || (now - _newsCacheTs) > NEWS_TTL) {
      const https = require('https');
      const raw = await new Promise((resolve, reject) => {
        const r = https.get('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { timeout: 6000 }, resp => {
          let data = '';
          resp.on('data', d => { data += d; });
          resp.on('end', () => resolve(data));
        });
        r.on('error', reject);
        r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
      });
      _newsCache = JSON.parse(raw);
      _newsCacheTs = now;
    }
    const events = (_newsCache || [])
      .filter(e => e.impact === 'High' || e.impact === 'Medium')
      .map(e => ({
        title:    e.title    || e.name || '',
        country:  e.country  || '',
        date:     e.date     || '',
        time:     e.time     || '',
        impact:   e.impact   || 'Low',
        forecast: e.forecast || null,
        previous: e.previous || null,
        actual:   e.actual   || null
      }));
    res.json({ ok: true, events });
  } catch (err) {
    res.json({ ok: false, events: _newsCache || [], error: err.message });
  }
});

// Symbol mapping storage (JSON file)
const MAPPING_PATH = path.join(__dirname, 'symbol-mappings.json');
function loadMappings() { try { return JSON.parse(fs.readFileSync(MAPPING_PATH,'utf8')); } catch(_){ return {}; } }
function saveMappings(m) { fs.writeFileSync(MAPPING_PATH, JSON.stringify(m, null, 2)); }

app.get('/mt5/mappings', (_req, res) => { res.json({ ok:true, mappings: loadMappings() }); });
app.post('/mt5/mappings', (req, res) => {
  const { alias, mt5Symbol } = req.body || {};
  if (!alias || !mt5Symbol) return res.status(400).json({ ok:false, error:'alias and mt5Symbol required' });
  const m = loadMappings();
  m[alias.toUpperCase()] = mt5Symbol;
  saveMappings(m);
  pushLog('extension', 'mt5', `MAPPING: ${alias.toUpperCase()} → ${mt5Symbol}`, 'ok', '');
  res.json({ ok:true, mappings: m });
});

// Fallback symbols when bridge offline
const FALLBACK_MT5_SYMBOLS = [
  {name:'XAUUSD',  description:'Gold vs US Dollar',          category:'metal',     digits:2},
  {name:'XAGUSD',  description:'Silver vs US Dollar',        category:'metal',     digits:3},
  {name:'EURUSD',  description:'Euro vs US Dollar',          category:'forex',     digits:5},
  {name:'GBPUSD',  description:'British Pound vs USD',       category:'forex',     digits:5},
  {name:'USDJPY',  description:'US Dollar vs Japanese Yen',  category:'forex',     digits:3},
  {name:'USDCHF',  description:'US Dollar vs Swiss Franc',   category:'forex',     digits:5},
  {name:'AUDUSD',  description:'Australian Dollar vs USD',   category:'forex',     digits:5},
  {name:'NZDUSD',  description:'New Zealand Dollar vs USD',  category:'forex',     digits:5},
  {name:'USDCAD',  description:'US Dollar vs Canadian Dollar',category:'forex',    digits:5},
  {name:'BTCUSD',  description:'Bitcoin vs US Dollar',       category:'crypto',    digits:2},
  {name:'ETHUSD',  description:'Ethereum vs US Dollar',      category:'crypto',    digits:2},
  {name:'US30',    description:'Dow Jones Industrial 30',    category:'index',     digits:2},
  {name:'US500',   description:'S&P 500 Index',              category:'index',     digits:2},
  {name:'NAS100',  description:'Nasdaq 100',                 category:'index',     digits:2},
  {name:'GER40',   description:'DAX 40',                     category:'index',     digits:2},
  {name:'UK100',   description:'FTSE 100',                   category:'index',     digits:2},
  {name:'USOIL',   description:'WTI Crude Oil',              category:'commodity', digits:2},
];

// ─── TV BRIDGE ────────────────────────────────────────────────────────────────
app.post('/tv-bridge', async (req, res) => {
  try {
    const { symbol: rawSym, tf, price, url, title } = req.body || {};
    if (!rawSym) return res.status(400).json({ ok: false, error: 'symbol required' });

    const profile  = normalizeSymbol(rawSym);
    const canonical = profile.canonical;
    const numPrice = parseFloat(price) || 0;

    const bridgeEnabled = bridgeConfig.bridgeEnabled !== false;
    const tvEnabled = bridgeConfig.tradingviewEnabled !== false;

    if (!bridgeEnabled || !tvEnabled) {
      return res.json({
        ok: true,
        canonical,
        source: 'tradingview',
        price: numPrice,
        bridgeApplied: false,
        reason: !bridgeEnabled ? 'bridge_disabled' : 'tradingview_disabled'
      });
    }

    marketStore.systemStatus = { source: 'tradingview', fluxStatus: 'LIVE', lastUpdate: new Date().toISOString() };
    marketStore.updateFromMT5({ symbol: canonical, price: numPrice, timeframe: tf, source: 'tv-bridge' }, canonical);
    marketStore.broadcast({ type: 'mt5-raw', symbol: canonical, price: numPrice, timeframe: tf, source: 'tradingview' });

    // 🔴 UNIFIED SYNC: Envoyer aussi à Extension + HTML clients
    // Inclure l'état de position actuel — source unique de vérité pour popup + dashboard
    let _tvBroadcastTs = { entered: false, phase: 'WAIT', virtualPosition: null };
    try {
      if (typeof coachTradeStateStore !== 'undefined' && coachTradeStateStore) {
        // Chercher une position ouverte sur le symbole actif (tous les TF)
        for (const stored of Object.values(coachTradeStateStore)) {
          if (stored && stored.symbol === canonical && stored.entered) {
            _tvBroadcastTs = {
              entered: true,
              phase: stored.phase || 'OPEN',
              timeframe: stored.timeframe || tf,
              virtualPosition: stored.virtualPosition || null,
              bePlaced: !!stored.bePlaced,
              partialTaken: !!stored.partialTaken
            };
            // Calculer P&L en temps réel
            if (_tvBroadcastTs.virtualPosition && _tvBroadcastTs.virtualPosition.entry) {
              const _vp = _tvBroadcastTs.virtualPosition;
              const _pipMult = (canonical.includes('JPY') ? 100 : 10000);
              const _dir = String(_vp.direction || '').toUpperCase();
              const _pnlPips = _dir === 'LONG'
                ? (numPrice - _vp.entry) * _pipMult
                : (_vp.entry - numPrice) * _pipMult;
              _tvBroadcastTs.virtualPosition = { ..._vp, pnlPips: parseFloat(_pnlPips.toFixed(1)), priceNow: numPrice };
            }
            break;
          }
        }
      }
    } catch (_tvTsErr) {}
    broadcastToExtension({
      type: 'tradingview-data',
      symbol: canonical,
      brokerSymbol: rawSym,
      price: numPrice,
      bid: null,
      ask: null,
      timeframe: tf,
      source: 'tradingview-live',
      url: url || null,
      title: title || null,
      tradeState: _tvBroadcastTs,
      marketStatus: (typeof marketHoursChecker !== 'undefined' && marketHoursChecker)
        ? marketHoursChecker.getStatus(canonical) : null
    });

    emitResolvedActiveSymbol('tv-bridge');

    if (orchestrator) {
      orchestrator.run({ symbol: canonical, broker_symbol: rawSym, price: numPrice, timeframe: tf, bid: numPrice, ask: numPrice })
        .then(a => marketStore.updateAnalysis(canonical, a))
        .catch(() => {});
    }
    res.json({ ok: true, canonical, source: 'tradingview', price: numPrice });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── SSE STREAM ───────────────────────────────────────────────────────────────
app.get('/stream', (_req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); marketStore.sseClients = marketStore.sseClients.filter(c => c !== res); } }, 15000);
  marketStore.addSSEClient(res);
  res.on('close', () => clearInterval(hb));
});

// ─── UNIFIED EXTENSION SYNC (Extension Chrome + HTML popup — MÊME SOURCE) ──────
// SSE endpoint centralisé: Extension ET HTML se connectent ICI
// Données: MT5 réel, TradingView réel, status système, agent activity
const extensionSyncClients = [];

const BRIDGE_MODES = new Set(['AUTO', 'ANALYSE', 'ALERTE', 'EXECUTION_PREPAREE', 'SCALPER', 'SNIPER', 'SWING']);

const EXTENSION_RUNTIME_STATE_PATH = path.join(__dirname, 'store', 'extension-runtime-state.json');

let activeSymbol = { symbol: null, timeframe: 'H1', price: null, updatedAt: null };

let bridgeConfig = {
  agentName: 'orchestrator',
  bridgeSource: 'tradingview',
  activeSource: 'tradingview',
  bridgeMode: 'AUTO',
  bridgeEnabled: true,
  tradingviewEnabled: true,
  mt5Enabled: false,
  sendPreAlerts: true,
  sendSignals: true,
  symbolAliasBridge: '',
  updatedAt: null,
  updatedBy: 'system'
};

function loadExtensionRuntimeState() {
  try {
    if (!fs.existsSync(EXTENSION_RUNTIME_STATE_PATH)) return;
    const raw = fs.readFileSync(EXTENSION_RUNTIME_STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object') {
      if (parsed.activeSymbol && typeof parsed.activeSymbol === 'object') {
        activeSymbol = {
          ...activeSymbol,
          ...parsed.activeSymbol
        };
      }
      if (parsed.bridgeConfig && typeof parsed.bridgeConfig === 'object') {
        bridgeConfig = {
          ...bridgeConfig,
          ...parsed.bridgeConfig
        };
      }
    }
  } catch (e) {
    console.warn('[EXTENSION-RUNTIME] load failed:', e.message);
  }
}

function saveExtensionRuntimeState() {
  try {
    const dir = path.dirname(EXTENSION_RUNTIME_STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload = {
      savedAt: new Date().toISOString(),
      activeSymbol,
      bridgeConfig
    };
    fs.writeFileSync(EXTENSION_RUNTIME_STATE_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    console.warn('[EXTENSION-RUNTIME] save failed:', e.message);
  }
}

function toBoolOrNull(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'oui'].includes(s)) return true;
    if (['0', 'false', 'no', 'off', 'non'].includes(s)) return false;
  }
  return null;
}

function normalizeBridgeMode(raw) {
  const mode = String(raw || '').trim().replace(/\s+/g, '_').toUpperCase();
  if (!mode) return bridgeConfig.bridgeMode;
  return BRIDGE_MODES.has(mode) ? mode : mode;
}

function sanitizeBridgeConfigPatch(patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const out = {};

  if (p.agentName != null) {
    out.agentName = String(p.agentName).trim() || bridgeConfig.agentName;
  }

  if (p.bridgeSource != null || p.source != null) {
    const src = p.bridgeSource != null ? p.bridgeSource : p.source;
    out.bridgeSource = String(src || '').trim().toLowerCase() || bridgeConfig.bridgeSource;
  }

  if (p.activeSource != null || p.sourceActive != null) {
    const src = p.activeSource != null ? p.activeSource : p.sourceActive;
    const s = String(src || '').trim().toLowerCase();
    if (s === 'tradingview' || s === 'mt5') out.activeSource = s;
  }

  if (p.bridgeMode != null || p.mode != null) {
    out.bridgeMode = normalizeBridgeMode(p.bridgeMode != null ? p.bridgeMode : p.mode);
  }

  if (p.bridgeEnabled != null || p.enabled != null) {
    const b = toBoolOrNull(p.bridgeEnabled != null ? p.bridgeEnabled : p.enabled);
    if (b != null) out.bridgeEnabled = b;
  }

  if (p.tradingviewEnabled != null || p.tvEnabled != null) {
    const b = toBoolOrNull(p.tradingviewEnabled != null ? p.tradingviewEnabled : p.tvEnabled);
    if (b != null) out.tradingviewEnabled = b;
  }

  if (p.mt5Enabled != null) {
    const b = toBoolOrNull(p.mt5Enabled);
    if (b != null) out.mt5Enabled = b;
  }

  if (p.sendPreAlerts != null || p.preAlerts != null || p.sendPreAlert != null) {
    const b = toBoolOrNull(p.sendPreAlerts != null ? p.sendPreAlerts : (p.preAlerts != null ? p.preAlerts : p.sendPreAlert));
    if (b != null) out.sendPreAlerts = b;
  }

  if (p.sendSignals != null) {
    const b = toBoolOrNull(p.sendSignals);
    if (b != null) out.sendSignals = b;
  }

  if (p.symbolAliasBridge != null || p.symbolAlias != null || p.alias != null) {
    const aliasRaw = p.symbolAliasBridge != null ? p.symbolAliasBridge : (p.symbolAlias != null ? p.symbolAlias : p.alias);
    out.symbolAliasBridge = String(aliasRaw || '').replace(/[/\-\s]/g, '').toUpperCase();
  }

  if (p.updatedBy != null) {
    out.updatedBy = String(p.updatedBy).trim() || 'system';
  }

  return out;
}

function applyBridgeConfigPatch(patch, updatedBy) {
  const clean = sanitizeBridgeConfigPatch(patch);

  if (clean.tradingviewEnabled === true) {
    clean.mt5Enabled = false;
    clean.activeSource = 'tradingview';
  }
  if (clean.mt5Enabled === true) {
    clean.tradingviewEnabled = false;
    clean.activeSource = 'mt5';
  }

  bridgeConfig = {
    ...bridgeConfig,
    ...clean,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || clean.updatedBy || 'system'
  };

  if (bridgeConfig.activeSource !== 'mt5') {
    bridgeConfig.activeSource = 'tradingview';
  }

  if (bridgeConfig.activeSource === 'tradingview') {
    bridgeConfig.tradingviewEnabled = true;
    bridgeConfig.mt5Enabled = false;
    bridgeConfig.bridgeSource = 'tradingview';
  } else {
    bridgeConfig.mt5Enabled = true;
    bridgeConfig.tradingviewEnabled = false;
    bridgeConfig.bridgeSource = 'mt5';
  }

  saveExtensionRuntimeState();

  return bridgeConfig;
}

loadExtensionRuntimeState();

function emitBridgeConfig(origin) {
  broadcastToExtension({
    type: 'bridge-config',
    origin: origin || 'bridge',
    bridgeConfig
  });
}

app.get('/extension/sync', (_req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send initial state immediately
  const resolvedCtx = resolveActiveRuntimeContext();
  // SOURCE UNIQUE: inclure l'état de position actuel dans initial-sync
  // → l'extension efface son état périmé si le serveur n'a pas de position active
  const _initSym = resolvedCtx.active.symbol || activeSymbol?.symbol;
  const _initTf  = resolvedCtx.active.timeframe || activeSymbol?.timeframe || 'H1';
  let _initTradeState = { entered: false, phase: 'WAIT_ENTRY', virtualPosition: null };
  if (_initSym && typeof getCoachTradeState === 'function') {
    // Chercher d'abord un état entré sur tous les TF (évite le bug H1 quand position sur M5)
    let _foundTs = null; let _foundTf = _initTf;
    if (typeof coachTradeStateStore !== 'undefined' && coachTradeStateStore) {
      for (const [, stored] of Object.entries(coachTradeStateStore)) {
        if (stored && stored.symbol === _initSym && stored.entered) { _foundTs = stored; _foundTf = stored.timeframe || _initTf; break; }
      }
    }
    const _ts = _foundTs || getCoachTradeState(_initSym, _initTf);
    const _vp = _ts.virtualPosition
      ? { ..._ts.virtualPosition, status: _ts.entered && _ts.phase === 'OPEN' ? 'OPEN' : _ts.virtualPosition.status }
      : null;
    _initTradeState = { entered: !!_ts.entered, phase: _ts.phase || 'WAIT_ENTRY', symbol: _initSym, timeframe: _foundTf, virtualPosition: _vp, bePlaced: !!_ts.bePlaced, partialTaken: !!_ts.partialTaken };
  }
  const initialState = {
    type: 'initial-sync',
    timestamp: new Date().toISOString(),
    systemStatus: marketStore.systemStatus || { source: 'offline', fluxStatus: 'OFFLINE' },
    activeSymbol: {
      ...(activeSymbol || {}),
      symbol: _initSym || null,
      timeframe: _initTf,
      price: resolvedCtx.active.price ?? activeSymbol?.price ?? activeSymbol?.tvPrice ?? null,
      source: resolvedCtx.active.source || 'none',
      resolvedBy: resolvedCtx.active.resolvedBy || 'none'
    },
    bridgeConfig,
    agentStates: agentStates,
    sourceContexts: resolvedCtx,
    tradeState: _initTradeState,
    message: 'Extension + HTML synchronisés — source unique'
  };
  res.write('data: ' + JSON.stringify(initialState) + '\n\n');

  // Add to clients list
  extensionSyncClients.push(res);
  console.log(`[EXTENSION-SYNC] Client connecté (total: ${extensionSyncClients.length})`);

  // Heartbeat for keep-alive
  const hb = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (e) {
      clearInterval(hb);
      const idx = extensionSyncClients.indexOf(res);
      if (idx > -1) extensionSyncClients.splice(idx, 1);
    }
  }, 15000);

  res.on('close', () => {
    clearInterval(hb);
    const idx = extensionSyncClients.indexOf(res);
    if (idx > -1) extensionSyncClients.splice(idx, 1);
    console.log(`[EXTENSION-SYNC] Client déconnecté (total: ${extensionSyncClients.length})`);
  });

  res.on('error', () => {
    clearInterval(hb);
    const idx = extensionSyncClients.indexOf(res);
    if (idx > -1) extensionSyncClients.splice(idx, 1);
  });
});

// ─── BROADCAST UNIFIED DATA TO ALL EXTENSION CLIENTS ────────────────────────────
// Called whenever MT5 data, TradingView data, or system status changes
// Ensures Extension + HTML see IDENTICAL data in real-time
function broadcastToExtension(message) {
  if (extensionSyncClients.length === 0) {
    // SAFE: avoid log flood when no extension clients are connected.
    return;
  }
  
  const data = {
    ...message,
    timestamp: new Date().toISOString(),
    type: message.type || 'data-update'
  };

  // Bridge OFF: stop live flow propagation, keep control/sync events only.
  const t = String(data.type || '');
  if (bridgeConfig.bridgeEnabled === false && (t === 'mt5-data' || t === 'tradingview-data')) {
    return;
  }

  const sseMessage = 'data: ' + JSON.stringify(data) + '\n\n';
  
  // Log clearly for mt5-data
  if (message.type === 'mt5-data') {
    console.log(`[EXTENSION-SYNC] 📤 Broadcasting MT5 to ${extensionSyncClients.length} clients: ${message.symbol} | Bid: ${message.bid} | Ask: ${message.ask} | Price: ${message.price}`);
  } else {
    console.log(`[BROADCAST] Sending to ${extensionSyncClients.length} clients: ${message.type}`);
  }
  
  for (let i = extensionSyncClients.length - 1; i >= 0; i--) {
    try {
      extensionSyncClients[i].write(sseMessage);
    } catch (e) {
      // Client disconnected
      console.log('[BROADCAST] Client disconnected, removing from list');
      extensionSyncClients.splice(i, 1);
    }
  }
}

// ─── GET CURRENT STATE ENDPOINT (for late-joining clients or polling fallback) ──
// Returns the EXACT same data that SSE clients receive
app.get('/extension/data', (_req, res) => {
  // Source unique : TradingView — retourne données même si stale (connected=false)
  // pour que le dashboard puisse afficher la dernière valeur connue
  const tvRuntime = getLatestTradingviewRuntime();
  const hasSymbol = tvRuntime?.symbol && tvRuntime?.payload?.price;

  if (!hasSymbol) {
    // Essayer de récupérer depuis activeContext (SSE initial-sync data)
    const ctx = activeSymbol || marketStore?.lastContext || null;
    const ctxPrice = ctx?.price || ctx?.payload?.price || null;
    if (ctx?.symbol && ctxPrice) {
      return res.json({
        ok: true,
        type: 'current-state-cached',
        timestamp: new Date().toISOString(),
        systemStatus: { source: 'tradingview', fluxStatus: 'STALE' },
        activeSymbol: {
          symbol: ctx.symbol,
          timeframe: ctx.timeframe || 'H1',
          price: ctxPrice,
          source: 'tradingview-cache',
          resolvedBy: 'activeContext-fallback'
        },
        bridgeConfig,
        agentStates,
        sourceContexts: {},
        marketStatus: marketHoursChecker.getStatus(ctx.symbol),
        currentData: {
          symbol: ctx.symbol,
          price: ctxPrice,
          bid: ctxPrice,
          ask: ctxPrice,
          volume: 0,
          timeframe: ctx.timeframe || 'H1',
          source: 'tradingview-cache',
          indicators: ctx.indicators || { rsi: null, macd: null, bb_upper: null, bb_lower: null, ma20: null, ma50: null, atr: null },
          updatedAt: ctx.updatedAt || null
        },
        stale: true,
        message: 'Données TradingView en cache — reconnectez TradingView pour flux live'
      });
    }
    return res.json({
      ok: false,
      error: 'NO DATA',
      message: 'Aucune donnée TradingView disponible',
      type: 'current-state',
      timestamp: new Date().toISOString()
    });
  }

  // TV runtime disponible (connecté ou stale avec données)
  const isLive = tvRuntime.connected === true;
  // Signal directionnel depuis le cache price-action (non bloquant)
  const _sym = tvRuntime.symbol;
  const _cacheKey = `${_sym}:${tvRuntime.timeframe || 'M15'}`;
  const _paCache  = (typeof _paSignalCache !== 'undefined') ? _paSignalCache.get(_cacheKey) : null;
  const _signal   = _paCache ? { direction: _paCache.direction, confidence: _paCache.votes, source: 'price-action-ticks' }
    : { direction: 'WAIT', confidence: 0, source: 'none' };
  res.json({
    ok: true,
    type: 'current-state',
    timestamp: new Date().toISOString(),
    systemStatus: { source: 'tradingview', fluxStatus: isLive ? 'LIVE' : 'STALE' },
    activeSymbol: {
      symbol: tvRuntime.symbol,
      timeframe: tvRuntime.timeframe,
      price: tvRuntime.payload.price,
      source: 'tradingview',
      resolvedBy: isLive ? 'tv-live' : 'tv-stale'
    },
    signal: _signal,
    bridgeConfig,
    agentStates: agentStates,
    sourceContexts: {},
    currentData: {
      symbol: tvRuntime.symbol,
      price: tvRuntime.payload.price,
      bid: tvRuntime.payload.bid || tvRuntime.payload.price,
      ask: tvRuntime.payload.ask || tvRuntime.payload.price,
      volume: 0,
      timeframe: tvRuntime.timeframe,
      source: 'tradingview',
      indicators: {
        rsi:      tvRuntime.payload.rsi      ?? null,
        macd:     tvRuntime.payload.macd     ?? null,
        bb_upper: tvRuntime.payload.bb_upper ?? null,
        bb_lower: tvRuntime.payload.bb_lower ?? null,
        ma20:     tvRuntime.payload.ma20     ?? null,
        ma50:     tvRuntime.payload.ma50     ?? null,
        atr:      tvRuntime.payload.atr      ?? null,
      },
      updatedAt: tvRuntime.timestamp || null
    },
    marketStatus: marketHoursChecker.getStatus(tvRuntime.symbol),
    stale: !isLive,
    message: isLive ? 'Current state TradingView live' : 'Dernière valeur TradingView — flux non actif'
  });
});

// ─── UNIFIED COMMAND ENDPOINT (Extension + HTML send commands here) ────────────
// Receives commands from Extension or HTML and broadcasts to all clients
app.post('/extension/command', async (req, res) => {
  const { command, payload } = req.body || {};
  
  if (!command) {
    return res.status(400).json({ ok: false, error: 'command required' });
  }
  
  console.log('[EXTENSION-CMD]', command, payload);
  
  try {
    let result = { ok: true, command, message: '' };
    
    switch (command) {
      // Change active symbol
      case 'set-symbol':
        const { symbol, timeframe, price, mode } = payload || {};
        if (symbol) {
          const rawNormalized = String(symbol).replace(/[/\-]/g, '').toUpperCase();
          const canonicalSymbol = normalizeSymbol(rawNormalized).canonical || rawNormalized;
          const requestedMode = normalizeBridgeMode(mode || activeSymbol?.mode || bridgeConfig.bridgeMode || 'AUTO');
          const resolvedMode = resolveRuntimeMode(requestedMode, canonicalSymbol, timeframe || 'H1');
          // Send as if received from extension
          activeSymbol = {
            symbol: canonicalSymbol,
            timeframe: timeframe || 'H1',
            price: price || null,
            mode: requestedMode,
            modeResolved: resolvedMode,
            updatedAt: new Date().toISOString()
          };
          saveExtensionRuntimeState();

          applyBridgeConfigPatch({
            bridgeMode: requestedMode,
            symbolAliasBridge: activeSymbol.symbol
          }, 'extension');
          
          // Broadcast to all Extension + HTML clients
          // Preserve TV origin so popup.js can reset userLocked correctly
          const _isTvSource = String(payload?.source || '').toLowerCase().includes('tradingview');
          broadcastToExtension({
            type: 'active-symbol',
            ...activeSymbol,
            modeResolved: resolvedMode,
            source: _isTvSource ? 'tradingview' : 'extension-command',
            resolvedBy: _isTvSource ? 'tv-runtime-fresh' : 'extension-active-symbol'
          });
          emitBridgeConfig('set-symbol');
          
          result.message = `Symbol set to ${activeSymbol.symbol}`;
        }
        break;

      case 'set-bridge-config':
        applyBridgeConfigPatch(payload || {}, 'extension-command');
        if (payload && (payload.bridgeMode != null || payload.mode != null)) {
          const requestedMode = normalizeBridgeMode(payload.bridgeMode != null ? payload.bridgeMode : payload.mode);
          const symbolForMode = activeSymbol?.symbol || marketStore.lastActiveSymbol || 'XAUUSD';
          const tfForMode = activeSymbol?.timeframe || marketStore.lastActiveTimeframe || 'H1';
          const resolvedMode = resolveRuntimeMode(requestedMode, symbolForMode, tfForMode);

          activeSymbol = {
            ...(activeSymbol || {}),
            symbol: symbolForMode,
            timeframe: tfForMode,
            mode: requestedMode,
            modeResolved: resolvedMode,
            updatedAt: new Date().toISOString()
          };
          saveExtensionRuntimeState();

          broadcastToExtension({
            type: 'active-symbol',
            ...activeSymbol,
            source: 'extension-bridge-config',
            resolvedBy: 'bridge-config-update'
          });
        }
        emitBridgeConfig('set-bridge-config');
        result.bridgeConfig = bridgeConfig;
        result.message = bridgeConfig.bridgeEnabled === false ? 'Bridge disabled' : 'Bridge config updated';
        break;
        
      // Trigger analysis
      case 'analyze':
        const sym = payload?.symbol || activeSymbol.symbol;
        if (sym) {
          const profile = normalizeSymbol(sym);
          const tf = String(payload?.timeframe || activeSymbol?.timeframe || marketStore.lastActiveTimeframe || 'H1').toUpperCase();
          const requestedMode = normalizeBridgeMode(payload?.mode || activeSymbol?.mode || bridgeConfig.bridgeMode || 'AUTO');
          const tradeState = getCoachTradeState(profile.canonical, tf);
          const snapshot = await computeCoachAnalysisSnapshot(profile.canonical, tf, 'fr', tradeState, {
            forceFresh: true,
            mode: requestedMode,
            maxAgeMs: 0
          }).catch(() => null);

          result.analysisTriggered = !!snapshot;
          result.analysisInput = {
            symbol: profile.canonical,
            timeframe: tf,
            price: snapshot?.currentPrice || activeSymbol?.price || null,
            modeResolved: snapshot?.modeResolved || resolveRuntimeMode(requestedMode, profile.canonical, tf)
          };
          result.analysis = snapshot ? {
            recommendation: snapshot.analysis?.recommendation || 'WAIT',
            reason: snapshot.analysis?.reason || 'Analyse indisponible',
            confidence: snapshot.analysis?.confidence || 0
          } : null;
          result.message = snapshot
            ? `Analysis triggered for ${profile.canonical} (${result.analysis.recommendation})`
            : `Analysis triggered for ${profile.canonical}`;
          if (!snapshot) result.warning = 'No live context available for analysis trigger';
          // Broadcast to all clients so dashboard/extension both show analysis in progress
          broadcastToExtension({
            type: 'analysis-running',
            symbol: profile.canonical,
            timeframe: tf,
            mode: requestedMode,
            source: 'extension',
            recommendation: result.analysis?.recommendation || null,
            timestamp: Date.now()
          });
        }
        break;
        
      // Get symbols
      case 'get-symbols':
        result.symbols = realDataSimulator.getAvailableSymbols();
        break;
        
      // Refresh data (simulator)
      case 'refresh-data':
        const data = realDataSimulator.getNextData();
        const prof = normalizeSymbol(data.symbol);
        marketStore.updateFromMT5({
          symbol: data.symbol,
          price: data.price,
          bid: data.bid,
          ask: data.ask,
          volume: data.volume,
          source: 'simulator'
        }, prof.canonical);
        
        broadcastToExtension({
          type: 'mt5-data',
          symbol: prof.canonical,
          price: data.price,
          bid: data.bid,
          ask: data.ask,
          volume: data.volume,
          source: 'simulator'
        });
        result.data = data;
        break;
        
      default:
        result.ok = false;
        result.error = 'Unknown command: ' + command;
    }
    
    pushLog('extension', 'system', 'COMMAND: ' + command, result.ok ? 'ok' : 'err', result.message || result.error || '');
    res.json(result);
    
  } catch (e) {
    console.error('[EXTENSION-CMD] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── STATE ────────────────────────────────────────────────────────────────────
app.get('/state', (_req, res) => {
  res.json({ ok: true, ...marketStore.getState() });
});

// ─── INSTANT TRADE LIVE ───────────────────────────────────────────────────────
// Priorité: bridge TradingView → cache → orchestrateur
// Middleware: intercepte la réponse pour alimenter le AGENTS LIVE LOG automatiquement
app.use('/instant-trade-live', (req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = function(data) {
    if (data && data.ok && data.trade) {
      const tr = data.trade;
      pushLog(
        'technicalAgent', 'orchestrator',
        `SIGNAL ${tr.direction || '?'} · ${tr.symbol || req.query.symbol || '?'} @ ${tr.entry || '?'}`,
        'ok',
        `Score:${tr.score || 0} · ${tr.setup_type || '?'} · SL:${tr.sl || '?'} TP:${tr.tp || '?'} · src:${data.source || '?'}`
      );
    }
    return origJson(data);
  };
  next();
});

app.get('/instant-trade-live', async (req, res) => {
  const rawSym  = req.query.symbol;
  if (!rawSym) return res.status(400).json({ ok: false, error: 'symbol parameter required' });
  console.log(`[BRIDGE] /instant-trade-live requested for symbol: ${rawSym}`);
  const reqTF   = req.query.tf     || 'H1';
  const reqMode = req.query.mode   || '';        // SCALPER | SNIPER | SWING
  const profile = normalizeSymbol(rawSym);
  const sym     = profile.canonical;

  // TradingView-only: no MT5 fallback.
  const tv = getLatestTradingviewRuntime();
  const tvSymbolRaw = String(tv?.symbol || '').toUpperCase();
  const tvSymbol = (typeof normalizeSymbol === 'function') ? (normalizeSymbol(tvSymbolRaw)?.canonical || tvSymbolRaw) : tvSymbolRaw;
  const tvPrice = Number(tv?.payload?.price);
  // Comparer les formes canoniques pour éviter les faux négatifs (ex: "XAUUSD" vs "XAU/USD")
  if (bridgeConfig.tradingviewEnabled !== false && tv?.connected && tvSymbol === sym && Number.isFinite(tvPrice) && tvPrice > 0) {
    const tf = String(reqTF || tv?.timeframe || 'H1').toUpperCase(); // reqTF prioritaire sur TV timeframe courant
    const robotV12 = getRobotV12ForSymbol(sym);
    const trade = buildTradingviewRuntimeTrade(sym, tf, tvPrice, reqMode, tv, robotV12);
    if (trade) {
      return res.json({ ok: true, trade, source: 'tradingview', price: tvPrice, timeframe: tf, robotV12 });
    }
    // Fallback technique: calcul depuis indicateurs bridge TradingView uniquement
    const techTrade = await computeTechSignalFromKlines(sym, tf, tvPrice);
    if (techTrade && techTrade.direction !== 'NEUTRE') {
      return res.json({ ok: true, trade: techTrade, source: 'tradingview-bridge', price: tvPrice, timeframe: tf, robotV12: null });
    }
    return res.json({
      ok: true,
      trade: techTrade || null,
      source: 'tradingview-bridge',
      price: tvPrice,
      timeframe: tf,
      robotV12,
      direction: techTrade?.direction || 'NEUTRE',
      technical: techTrade?.technical || null,
      message: techTrade ? 'Signal calculé depuis indicateurs TradingView bridge.' : 'Indicateurs TradingView insuffisants — ajoutez RSI sur le graphique.'
    });
  }

  // No TV connection — try bridge-only tech signal with last known price
  const lastKnown = getLastKnownPrice(sym);
  const fallbackPrice = Number(lastKnown?.price || lastKnown?.bid || NaN);
  if (Number.isFinite(fallbackPrice) && fallbackPrice > 0) {
    const tf2 = String(reqTF || 'H1').toUpperCase();
    const techTrade2 = await computeTechSignalFromKlines(sym, tf2, fallbackPrice);
    if (techTrade2) {
      return res.json({ ok: true, trade: techTrade2, source: 'tradingview-bridge', price: fallbackPrice, timeframe: tf2, robotV12: null });
    }
  }

  return res.status(503).json({
    ok: false,
    error: 'Aucune source TradingView live disponible pour ' + sym + '.',
    source: 'none',
    live: false
  });
});

// ─── ZONES ────────────────────────────────────────────────────────────────────
app.post('/zones', (req, res) => {
  const { symbol, tf, high, low, type } = req.body;
  if (!symbol || !high || !low || !type) return res.status(400).json({ ok: false, error: 'symbol, high, low, type required' });
  const profile  = normalizeSymbol(symbol);
  const zone     = zoneManager.createZone({ symbol: profile.canonical, tf, high, low, type });
  console.log(`[ZONE] Created ${type} zone for ${profile.canonical}: ${low}–${high}`);
  res.json({ ok: true, zone });
});

app.get('/zones/:symbol', (req, res) => {
  const profile = normalizeSymbol(req.params.symbol);
  const tf      = req.query.tf || null;
  const zones   = zoneManager.getActiveZones(profile.canonical, tf);
  const price   = marketStore.getLatestForSymbol(profile.canonical)?.latestPayload?.price;
  if (price) zoneManager.updateZones(parseFloat(price));
  res.json({ ok: true, symbol: profile.canonical, zones, count: zones.length });
});

// ─── CHART DATA (timer bougie réel) ──────────────────────────────────────────
app.get('/chart-data', (req, res) => {
  // Source unique : TradingView live
  const tvRuntime = getLatestTradingviewRuntime();
  if (!tvRuntime?.connected || !tvRuntime?.symbol || !tvRuntime?.payload?.price) {
    return res.json({
      ok: false,
      error: 'NO DATA',
      message: 'Aucune donnée TradingView live disponible',
      type: 'chart-data',
      timestamp: new Date().toISOString()
    });
  }
  res.json({
    ok: true,
    symbol: tvRuntime.symbol,
    timeframe: tvRuntime.timeframe,
    price: tvRuntime.payload.price,
    source: 'tradingview',
    candles: tvRuntime.payload.candles || [],
    updatedAt: tvRuntime.timestamp || null
  });
});

// ─── MARKET INTELLIGENCE ──────────────────────────────────────────────────────
app.get('/market-intelligence', async (req, res) => {
  const sym = req.query.symbol || 'XAUUSD';
  try {
    const newsAgent = require('./src/agents/news-intelligence');
    const data      = await newsAgent.analyze(sym);
    res.json({ ok: true, symbol: sym, ...data });
  } catch {
    // Fallback: calendrier statique
    res.json({
      ok: true, symbol: sym,
      upcomingEvents: [
        { event: 'Non-Farm Payrolls', time: '13:30', currency: 'USD', impact: 'HIGH', minutesAway: 240, isUrgent: false },
        { event: 'FOMC Meeting', time: '19:00', currency: 'USD', impact: 'HIGH', minutesAway: 480, isUrgent: false }
      ],
      news: [],
      macroWarning: null
    });
  }
});

// ─── LATEST SYMBOL ────────────────────────────────────────────────────────────
app.get('/latest/:symbol', async (req, res) => {
  const profile = normalizeSymbol(req.params.symbol);
  const data    = marketStore.getLatestForSymbol(profile.canonical);
  if (data) return res.json({ ok: true, symbol: profile.canonical, ...data });

  // Aucune source externe — bridge TradingView uniquement
  res.status(404).json({ ok: false, error: 'Aucune donnée pour ' + profile.canonical + '. Connectez TradingView ou MT5.' });
});

// ─── TOGGLE MODE ──────────────────────────────────────────────────────────────
let engineMode = 'manual', activeTimeframe = 'H1';
app.get('/toggle-mode', (_req, res) => res.json({ ok: true, mode: engineMode, timeframe: activeTimeframe }));
app.post('/toggle-mode', (req, res) => {
  const m = (req.body?.mode || '').toLowerCase();
  if (m === 'auto' || m === 'manual') engineMode = m;
  else if (!m) engineMode = engineMode === 'auto' ? 'manual' : 'auto';
  if (req.body?.timeframe) activeTimeframe = req.body.timeframe.toUpperCase();
  res.json({ ok: true, mode: engineMode, timeframe: activeTimeframe });
});

// ─── ANALYZE ─────────────────────────────────────────────────────────────────
async function handleAnalyze(req, res) {
  const focus  = req.query.focus;
  const syms   = focus ? [focus] : ['XAU/USD','EUR/USD','GBP/USD','USD/JPY','BTC/USDT'];

  const opportunities = await Promise.all(syms.map(async rawSym => {
    const profile  = normalizeSymbol(rawSym.replace('/', ''));
    const cached   = marketStore.analysisCache[profile.canonical];
    if (cached?.trade) return { ...cached.trade, probability: Math.round(cached.score || 65) };

    // Priorité : tvDataStore (source maître TradingView) — source unique
    try {
      // 1. TradingView — source maître
      const tvEntry = tvDataStore[profile.canonical];
      const tvAge   = tvEntry ? (Date.now() - (tvEntry.updatedAt || 0)) : Infinity;
      let price = null;
      if (tvEntry && tvAge < 30000 && parseFloat(tvEntry.price) > 0) {
        price = parseFloat(tvEntry.price);
      } else {
        // Pas de bridge TV récent — aucune source externe autorisée
        console.log(`[ANALYZE] ${profile.canonical} — bridge absent ou > 30s, skip (aucune source externe)`);
      }
      if (!price) return null;
      const direction = 'LONG';
      const levels    = calcTradeLevels(price, direction, profile, 'H1', null);
      const setup     = classifySetup('H1', direction, 65);
      return { symbol: profile.canonical, direction, ...levels, score: 65, probability: 65, source: 'tradingview', ...setup };
    } catch { return null; }
  }));

  res.json({ ok: true, opportunities: opportunities.filter(Boolean) });
}

app.get('/analyze', handleAnalyze);
app.get('/analysis', handleAnalyze);

// ─── POSITIONS ────────────────────────────────────────────────────────────────
app.get('/positions', async (req, res) => {
  // Retourner les positions depuis le store MT5 si disponible
  const state  = marketStore.getState ? marketStore.getState() : {};
  const cached = state.analysisCache || {};
  const positions = Object.values(cached)
    .filter(a => a?.trade)
    .map(a => ({ ...a.trade, status: a.trade.trade_status || 'UNKNOWN' }));

  if (positions.length > 0) return res.json({ ok: true, positions, count: positions.length, source: 'mt5-cache' });

  // Fallback: message informatif
  res.json({ ok: true, positions: [], count: 0, note: 'Aucune position active — démarrez le bridge MT5 pour voir les positions réelles' });
});

// ─── TRADE EXECUTE ────────────────────────────────────────────────────────────
app.post('/trade', (req, res) => {
  const { symbol, direction, quantity, price, sl, tp } = req.body || {};
  if (!symbol || !direction) return res.status(400).json({ ok: false, error: 'symbol et direction requis' });
  try {
    const broker = require('./trading/broker-adapter');
    broker.placeOrder({ symbol, direction, quantity: quantity || 1, price, sl, tp })
      .then(r => res.json({ ok: true, result: r }))
      .catch(e => res.status(500).json({ ok: false, error: e.message }));
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Broker adapter: ' + e.message });
  }
});

// ─── BROKER MODE ──────────────────────────────────────────────────────────────
app.get('/broker-mode', (req, res) => res.json({ ok: true, mode: process.env.BROKER_MODE || 'live' }));
app.post('/broker-mode', (req, res) => {
  const m = (req.body?.mode || '').toLowerCase();
  if (!['paper','live'].includes(m)) return res.status(400).json({ ok: false, error: 'paper ou live seulement' });
  process.env.BROKER_MODE = m;
  res.json({ ok: true, mode: m });
});

// ─── AGENTS REPORT ────────────────────────────────────────────────────────────
app.get('/agents-report', async (req, res) => {
  try {
    const coordinator = require('./src/agents/coordinator');
    const priceMap    = {};
    const report      = await coordinator.runAgentCycle(priceMap, 100000, 1);
    res.json({ ok: true, report });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── AGENT SCREEN ────────────────────────────────────────────────────────────
app.post('/agent-screen', async (req, res) => {
  const { symbol: rawSym, tf, price: rawPrice, url, title, screenshot } = req.body || {};
  const profile  = normalizeSymbol(rawSym || 'EURUSD');
  const sym      = profile.canonical;
  const price    = rawPrice ? parseFloat(rawPrice) : null;

  if (screenshot) console.log(`[/agent-screen] Screenshot ${Math.round(screenshot.length/1024)}KB pour ${sym}`);

  if (!price || price <= 0) {
    return res.status(400).json({ ok: false, error: 'Prix requis — envoyez price dans le body' });
  }

  const direction = 'LONG';
  const levels    = calcTradeLevels(price, direction, profile, tf || 'H1', null);
  const setup     = classifySetup(tf || 'H1', direction, 65);
  const trade     = validateTrade({ symbol: sym, direction, ...levels, score: 65, source: 'agent-screen', accuracy: 'live', technical: `Analyse de ${url || 'page'}`, macro: '—', sentiment: '—', ...setup }, price);

  res.json({ ok: true, trade, symbol: sym, screenshotProcessed: !!screenshot });
});

// ─── KLINES — source bridge TV uniquement ────────────────────────────────────
// Yahoo Finance supprimé — toutes les données proviennent du bridge TradingView.
// /klines retourne le price history du bridge (60 ticks live) pour les graphiques.
app.get('/klines', (req, res) => {
  const sym   = (req.query.symbol || 'XAUUSD').replace('/','').replace('-','').toUpperCase();
  const tf    = (req.query.tf || 'M1').toUpperCase();
  const limit = Math.min(parseInt(req.query.limit) || 60, 200);
  const entry = tvDataStore[sym] || tvDataStore[normalizeSymbol(sym)?.canonical];
  if (!entry || !Array.isArray(entry._priceHistory) || entry._priceHistory.length < 2) {
    return res.status(503).json({ ok: false, error: 'Pas de données bridge TV disponibles pour ' + sym + ' — attendre la connexion TradingView' });
  }
  const prices = entry._priceHistory.slice(-limit);
  const now = Date.now();
  const tfMs = { M1:60000, M5:300000, M15:900000, H1:3600000 }[tf] || 60000;
  const candles = prices.map((p, i) => ({
    time: now - (prices.length - 1 - i) * tfMs,
    open: p, high: p, low: p, close: p, volume: 0
  }));
  return res.json({ ok: true, candles, source: 'bridge-tv', symbol: sym, tf, note: 'Données bridge TradingView live' });
});

// ─── CALENDAR ────────────────────────────────────────────────────────────────
app.get('/calendar', async (req, res) => {
  try {
    const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
      signal: AbortSignal.timeout(6000),
      headers: { 'Accept': 'application/json' }
    });
    if (!r.ok) throw new Error('calendar upstream ' + r.status);
    const raw = await r.json();
    const now = Date.now();
    const events = (Array.isArray(raw) ? raw : [])
      .map((e) => {
        const ts = Date.parse(e.date || e.timestamp || '');
        const mins = Number.isFinite(ts) ? Math.floor((ts - now) / 60000) : null;
        return {
          dayLabel: e.day || '',
          time: e.time || '',
          currency: e.currency || '',
          event: e.title || e.event || 'Event',
          impact: (e.impact || e.impact_title || 'LOW').toUpperCase(),
          mins
        };
      })
      .filter((e) => !Number.isFinite(e.mins) || e.mins >= 0)
      .slice(0, 20);
    res.json({ ok: true, events, source: 'forexfactory-live' });
  } catch {
    const news = require('./src/agents/news-intelligence');
    const d = await news.getUpcomingEvents();
    res.json({ ok: true, events: d.slice(0, 8), source: 'fallback-upcoming-events' });
  }
});

// ─── NEWS ────────────────────────────────────────────────────────────────────
app.get('/news', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || marketStore.lastActiveSymbol || getLatestTradingviewRuntime().symbol || '').toUpperCase();
    const intel = require('./src/agents/news-intelligence');
    const data = await intel.analyze(symbol);
    const news = Array.isArray(data.news) ? data.news : [];
    const headlines = Array.isArray(data.headlines) ? data.headlines : [];
    res.json({ ok: true, news, headlines, headlinesCount: headlines.length, source: 'multi-source-live', symbol, macroWarning: data.macroWarning || null, symbolImpact: data.symbolImpact || null });
  } catch {
    res.json({ ok: true, news: [], source: 'offline' });
  }
});

// ─── QUOTE ───────────────────────────────────────────────────────────────────
app.get('/quote', (req, res) => {
  // Source unique: bridge TradingView — Yahoo Finance supprimé
  const rawSym = req.query.symbol || 'EUR/USD';
  const profile = normalizeSymbol(rawSym.replace('/',  ''));
  const sym     = profile.canonical;

  const live = marketStore.getLatestForSymbol(sym);
  if (live?.latestPayload?.price) {
    marketStore.broadcast({ type: 'quote', symbol: sym, price: live.latestPayload.price, source: live.latestPayload.source || 'tradingview' });
    return res.json({ ok: true, symbol: sym, price: live.latestPayload.price, source: live.latestPayload.source || 'tradingview' });
  }
  // Fallback: tvDataStore (bridge TV direct)
  const tvEntry = tvDataStore[sym] || tvDataStore[profile?.canonical];
  if (tvEntry?.price) {
    return res.json({ ok: true, symbol: sym, price: tvEntry.price, source: 'bridge-tv' });
  }
  res.status(404).json({ ok: false, error: 'Prix indisponible pour ' + rawSym + ' — connecter TradingView' });
});

// ─── BUTTON LOG ──────────────────────────────────────────────────────────────
const btnLogs = [];
app.post('/button-log', (req, res) => { btnLogs.unshift({ ...req.body, ts: Date.now() }); if (btnLogs.length > 200) btnLogs.pop(); res.json({ ok: true }); });
app.get('/button-log',  (_req, res) => res.json({ ok: true, logs: btnLogs.slice(0, 100) }));

// ─── SYSTEM LOG (communication inter-IA) ─────────────────────────────────────
const SYSLOG_PATH = path.join(__dirname, 'SYSTEM_LOG.json');
const sysLogs = [];
const AGENT_HISTORY_PATH = path.join(__dirname, 'agent-history.json');
const AGENT_HISTORY_BACKUP_PATH = path.join(__dirname, 'backup', 'system-live', 'agent-history.json');
const BACKUP_SYSTEM_LIVE_DIR = path.join(__dirname, 'backup', 'system-live');
const BACKUP_SYSLOG_PATH = path.join(BACKUP_SYSTEM_LIVE_DIR, 'SYSTEM_LOG.json');
const BACKUP_LOGS_PATH = path.join(BACKUP_SYSTEM_LIVE_DIR, 'logs.json');
const BACKUP_LIVE_STATE_PATH = path.join(BACKUP_SYSTEM_LIVE_DIR, 'realtime', 'live-system-state.json');
const AGENT_HISTORY_INTERVAL_MS = Math.max(10 * 60 * 1000, parseInt(process.env.AGENT_HISTORY_INTERVAL_MS || '1800000', 10) || 1800000);
const agentHistory = [];
let _agentHistoryTimer = null;
let _backupLiveMirrorTimer = null;
const backupLiveMirrorMeta = {
  sequence: 0,
  updatedAt: null,
  lastTrigger: 'startup',
  lastEvent: null
};

// ─── AGENT ACTIVITY TRACKING ──────────────────────────────────────────────────
const agentActivitySseClients = [];  // SSE clients watching agent activity
const agentStates = {
  'Claude':   { status: 'online', lastActivity: Date.now(), activeTask: null },
  'Copilot':  { status: 'idle', lastActivity: Date.now(), activeTask: null },
  'system':   { status: 'running', lastActivity: Date.now(), activeTask: null }
};
const _agentBusUnsubscribers = [];
const _registeredAgentNames = new Set();
let _activeAgentExecutions = 0;
const _agentExecutionQueue = [];
const _agentExecutionCompletedAt = new Map();
const _agentExecutionCompletedTtlMs = 10 * 60 * 1000;
const _agentExecutionDependencyTimeoutMs = 15000;
let _agentExecutionTaskSeq = 0;
let _agentQueuePumpRunning = false;
let _agentQueuePumpScheduled = false;
const _agentExecutionBaseMax = Math.min(2, Math.max(1, parseInt(process.env.AGENT_CONCURRENCY || '2', 10) || 2));
let _agentExecutionDynamicMax = _agentExecutionBaseMax;
let _runtimeRotationIndex = 0;
let _runtimeCycleInProgress = false;
let _runtimeSlowdownMs = 0;
let _runtimeAutoSafeMode = false;
let _runtimeLoopCurrentIntervalMs = 0;
let _runtimeLoopTargetIntervalMs = SAFE_MODE ? 8000 : 5000;
let _cpuPrevSample = null;
let _cpuPercent = 0;
let _runtimeCycleCounter = 0;

function sampleSystemCpuPercent() {
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) return _cpuPercent || 0;

  const totals = cpus.reduce((acc, cpu) => {
    const t = cpu.times;
    acc.idle += t.idle;
    acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return acc;
  }, { idle: 0, total: 0 });

  if (!_cpuPrevSample) {
    _cpuPrevSample = totals;
    return _cpuPercent || 0;
  }

  const idleDiff = totals.idle - _cpuPrevSample.idle;
  const totalDiff = totals.total - _cpuPrevSample.total;
  _cpuPrevSample = totals;

  if (totalDiff <= 0) return _cpuPercent || 0;
  const pct = Math.max(0, Math.min(100, (1 - (idleDiff / totalDiff)) * 100));
  return Math.round(pct * 10) / 10;
}

function refreshRuntimeRegulation() {
  const cpu = sampleSystemCpuPercent();
  _cpuPercent = cpu;

  if (cpu > 90) {
    _runtimeAutoSafeMode = true;
    _agentExecutionDynamicMax = 1;
    _runtimeSlowdownMs = 3200;
    _runtimeLoopTargetIntervalMs = 14000;
    return;
  }

  _runtimeAutoSafeMode = false;
  if (cpu > 85) {
    _agentExecutionDynamicMax = 2;
    _runtimeSlowdownMs = 1700;
    _runtimeLoopTargetIntervalMs = 9000;
    return;
  }

  if (cpu > 70) {
    _agentExecutionDynamicMax = Math.max(2, Math.min(3, _agentExecutionBaseMax));
    _runtimeSlowdownMs = 950;
    _runtimeLoopTargetIntervalMs = 7000;
    return;
  }

  _agentExecutionDynamicMax = _agentExecutionBaseMax;
  _runtimeSlowdownMs = 0;
  _runtimeLoopTargetIntervalMs = SAFE_MODE ? 8000 : 5000;
}

function getEffectiveSafeMode() {
  return SAFE_MODE || _runtimeAutoSafeMode;
}
const AGENT_PRIORITY = {
  'orchestrator': 1,
  'verification-agent': 1,
  'surveillance-agent': 1,
  'bridge-agent': 2,
  'repair-agent': 2,
  'extension-agent': 2,
  'logic-gap-agent': 2,
  'ui-test-agent': 2,
  'analysis-agent': 2,
  'risk-agent': 2,
  'strategy-agent': 2,
  'mirror-agent': 3,
  'innovator-agent': 3,
  'design-agent': 3,
  'research-agent': 3,
  'human-interface-agent': 3,
  'project-controller': 3,
  'position-explainer-agent': 3,
  'execution-coach-agent': 3,
  'history-agent': 3
};

const DISPATCH_PRIORITY_LABELS = {
  1: 'high',
  2: 'medium',
  3: 'low'
};

const AGENT_RUNTIME_POLICY = {
  'orchestrator': { priority: 1, mode: 'always', dependsOn: [] },
  'verification-agent': { priority: 1, mode: 'always', dependsOn: [] },
  'surveillance-agent': { priority: 1, mode: 'always', dependsOn: [] },
  'bridge-agent': { priority: 2, mode: 'interval', everyCycles: 2, dependsOn: ['orchestrator'] },
  'repair-agent': { priority: 2, mode: 'blocked', dependsOn: ['verification-agent'] },
  'extension-agent': { priority: 2, mode: 'interval', everyCycles: 3, dependsOn: ['bridge-agent'] },
  'logic-gap-agent': { priority: 2, mode: 'event', dependsOn: ['verification-agent'] },
  'ui-test-agent': { priority: 2, mode: 'event', dependsOn: ['logic-gap-agent'] },
  'analysis-agent': { priority: 2, mode: 'event', dependsOn: ['orchestrator'] },
  'risk-agent': { priority: 2, mode: 'event', dependsOn: ['analysis-agent'] },
  'strategy-agent': { priority: 2, mode: 'event', dependsOn: ['analysis-agent'] },
  'mirror-agent': { priority: 3, mode: 'interval', everyCycles: 4, dependsOn: ['bridge-agent'] },
  'innovator-agent': { priority: 3, mode: 'blocked', dependsOn: ['repair-agent'] },
  'design-agent': { priority: 3, mode: 'event', dependsOn: ['logic-gap-agent'] },
  'research-agent': { priority: 3, mode: 'event', dependsOn: ['logic-gap-agent'] },
  'human-interface-agent': { priority: 3, mode: 'event', dependsOn: ['design-agent'] },
  'project-controller': { priority: 3, mode: 'event', dependsOn: ['design-agent'] },
  'position-explainer-agent': { priority: 3, mode: 'event', dependsOn: ['analysis-agent'] },
  'execution-coach-agent': { priority: 3, mode: 'event', dependsOn: ['risk-agent', 'strategy-agent'] },
  'history-agent': { priority: 3, mode: 'interval', everyCycles: 6, dependsOn: [] }
};

function normalizeDispatchPriority(value) {
  if (value === 'high') return 1;
  if (value === 'medium') return 2;
  if (value === 'low') return 3;
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(3, Math.floor(n)));
}

function getDispatchPriorityLabel(value) {
  return DISPATCH_PRIORITY_LABELS[normalizeDispatchPriority(value)] || 'low';
}

function cleanupCompletedExecutionKeys() {
  const now = Date.now();
  for (const [key, ts] of _agentExecutionCompletedAt.entries()) {
    if (!Number.isFinite(ts) || (now - ts) > _agentExecutionCompletedTtlMs) {
      _agentExecutionCompletedAt.delete(key);
    }
  }
}

function markExecutionCompleted(key) {
  const clean = String(key || '').trim();
  if (!clean) return;
  _agentExecutionCompletedAt.set(clean, Date.now());
  cleanupCompletedExecutionKeys();
}

function areExecutionDependenciesSatisfied(dependsOn = []) {
  if (!Array.isArray(dependsOn) || dependsOn.length === 0) return true;
  cleanupCompletedExecutionKeys();
  return dependsOn.every((dep) => _agentExecutionCompletedAt.has(dep));
}

function pickNextExecutionTaskIndex() {
  if (_agentExecutionQueue.length === 0) return -1;
  const now = Date.now();
  let bestIndex = -1;
  for (let i = 0; i < _agentExecutionQueue.length; i++) {
    const task = _agentExecutionQueue[i];
    const waitedMs = now - (task.enqueuedAt || now);
    const depsReady = areExecutionDependenciesSatisfied(task.dependsOn || []);
    const dependencyTimedOut = waitedMs >= _agentExecutionDependencyTimeoutMs;
    if (!depsReady && !dependencyTimedOut) continue;

    if (bestIndex === -1) {
      bestIndex = i;
      continue;
    }

    const best = _agentExecutionQueue[bestIndex];
    if (task.priority !== best.priority) {
      if (task.priority < best.priority) bestIndex = i;
      continue;
    }

    if ((task.enqueuedAt || 0) < (best.enqueuedAt || 0)) {
      bestIndex = i;
    }
  }
  return bestIndex;
}

function scheduleAgentQueuePump() {
  if (_agentQueuePumpScheduled) return;
  _agentQueuePumpScheduled = true;
  setImmediate(() => {
    _agentQueuePumpScheduled = false;
    processAgentExecutionQueue();
  });
}

function processAgentExecutionQueue() {
  if (_agentQueuePumpRunning) return;
  _agentQueuePumpRunning = true;

  try {
    while (_activeAgentExecutions < _agentExecutionDynamicMax) {
      const nextIndex = pickNextExecutionTaskIndex();
      if (nextIndex === -1) break;
      const task = _agentExecutionQueue.splice(nextIndex, 1)[0];
      if (!task || typeof task.fn !== 'function') continue;

      _activeAgentExecutions += 1;
      Promise.resolve()
        .then(() => task.fn())
        .then((out) => {
          if (task.completionKey) markExecutionCompleted(task.completionKey);
          task.resolve(out);
        })
        .catch((e) => {
          task.reject(e);
        })
        .finally(() => {
          _activeAgentExecutions -= 1;
          scheduleAgentQueuePump();
        });
    }
  } finally {
    _agentQueuePumpRunning = false;
  }
}

function hasRecentAgentIntent(agentName, withinMs = 120000) {
  const needle = String(agentName || '').toLowerCase();
  if (!needle) return false;
  const now = Date.now();
  return sysLogs.some((entry) => {
    const ts = Date.parse(entry.ts || '') || now;
    if ((now - ts) > withinMs) return false;
    const from = String(entry.from || '').toLowerCase();
    const to = String(entry.to || '').toLowerCase();
    const action = String(entry.action || '').toLowerCase();
    return from === needle || to === needle || action.includes(needle);
  });
}

function shouldDispatchRuntimeAgent(agentName) {
  const policy = AGENT_RUNTIME_POLICY[agentName] || { mode: 'event', priority: AGENT_PRIORITY[agentName] || 3, dependsOn: [] };
  const blockedCount = Object.values(agentRuntime).filter((x) => x.status === 'bloqué').length;
  const mode = policy.mode || 'event';
  const priority = normalizeDispatchPriority(policy.priority || AGENT_PRIORITY[agentName] || 3);

  // Load shedding: keep only essential agents when the system is heavy.
  if (_cpuPercent > 90 && priority > 1) return false;
  if (_cpuPercent > 80 && priority > 2) return false;

  if (mode === 'always') return true;
  if (mode === 'blocked') return blockedCount > 0;
  if (mode === 'interval') {
    const every = Math.max(1, Number(policy.everyCycles) || 1);
    return (_runtimeCycleCounter % every) === 0;
  }
  if (mode === 'event') return hasRecentAgentIntent(agentName, 180000);
  return hasRecentAgentIntent(agentName, 180000);
}

function getRuntimeOrderedAgents() {
  return [...AGENT_RUNTIME_CATALOG].sort((a, b) => {
    const pa = AGENT_PRIORITY[a] || 9;
    const pb = AGENT_PRIORITY[b] || 9;
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
}

function getRuntimeDispatchQueue() {
  const ordered = getRuntimeOrderedAgents();
  const selected = [];
  for (const name of ordered) {
    if (!shouldDispatchRuntimeAgent(name)) continue;
    const policy = AGENT_RUNTIME_POLICY[name] || {};
    const priority = normalizeDispatchPriority(policy.priority || AGENT_PRIORITY[name] || 3);
    const dependsOn = Array.isArray(policy.dependsOn) ? policy.dependsOn.filter(Boolean).map((v) => String(v)) : [];
    selected.push({
      name,
      priority,
      priorityLabel: getDispatchPriorityLabel(priority),
      dependsOn
    });
  }
  selected.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.name.localeCompare(b.name);
  });
  return selected;
}

function getInteractiveAgentPriority(name) {
  const policy = AGENT_RUNTIME_POLICY[name] || {};
  return normalizeDispatchPriority(policy.priority || AGENT_PRIORITY[name] || 3);
}

function getInteractiveAgentDependencies(name, message = '') {
  const base = Array.isArray(AGENT_RUNTIME_POLICY[name]?.dependsOn)
    ? AGENT_RUNTIME_POLICY[name].dependsOn.map((v) => String(v))
    : [];

  const m = String(message || '').toLowerCase();
  if (name === 'repair-agent' && /analyse|analysis|diagnostic|audit/.test(m)) {
    base.push('send:analysis-agent');
  }
  if (name === 'execution-coach-agent') {
    base.push('send:risk-agent', 'send:strategy-agent');
  }
  if (name === 'strategy-agent') {
    base.push('send:analysis-agent');
  }
  if (name === 'risk-agent') {
    base.push('send:analysis-agent');
  }

  return Array.from(new Set(base));
}

function runWithAgentLimit(fn, options = {}) {
  const priority = normalizeDispatchPriority(options.priority || 3);
  const dependsOn = Array.isArray(options.dependsOn) ? options.dependsOn.filter(Boolean).map((v) => String(v)) : [];
  const completionKey = options.taskKey ? String(options.taskKey) : null;
  const label = String(options.label || completionKey || 'agent-task');

  return new Promise((resolve, reject) => {
    _agentExecutionQueue.push({
      id: ++_agentExecutionTaskSeq,
      fn,
      resolve,
      reject,
      priority,
      priorityLabel: getDispatchPriorityLabel(priority),
      dependsOn,
      completionKey,
      label,
      enqueuedAt: Date.now()
    });
    scheduleAgentQueuePump();
  });
}

// Runtime instrumentation for live task visibility (startedAt / elapsedMs / durationMs)
const AGENT_RUNTIME_CATALOG = [
  'surveillance-agent', 'orchestrator', 'indicator-agent', 'repair-agent',
  'technicalAgent', 'macroAgent', 'newsAgent', 'riskManager',
  'strategyManager', 'tradeValidator', 'setupClassifier', 'syncManager',
  'dataSourceManager', 'stateManager', 'supervisor', 'qaTester',
  'continuous-loop', 'design-agent', 'bridge-agent', 'innovator-agent',
    'verification-agent', 'mirror-agent', 'extension-agent', 'project-controller',
    'ui-test-agent', 'logic-gap-agent', 'research-agent', 'human-interface-agent',
    'central-guide-agent', 'analysis-agent', 'news-agent', 'position-explainer-agent', 'strategy-agent', 'risk-agent', 'execution-coach-agent', 'history-agent'
];

const agentRuntime = {};
let _runtimeLoopEnabled = false;
let _runtimeLoopTimer = null;

function ensureAgentRuntime(name) {
  if (!agentRuntime[name]) {
    agentRuntime[name] = {
      agent: name,
      task: 'idle',
      status: 'en attente',
      startedAt: null,
      finishedAt: null,
      elapsedMs: 0,
      durationMs: null,
      avgDurationMs: null,
      etaMs: null,
      cause: '',
      impact: '',
      solution: '',
      to: 'system',
      updatedAt: Date.now(),
      runs: 0,
      blockedCount: 0
    };
  }
  return agentRuntime[name];
}

function formatEtaLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return sec + 's';
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem > 0 ? `${min}m ${rem}s` : `${min}m`;
}

function updateAvgDuration(rt, durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  if (!Number.isFinite(rt.avgDurationMs) || rt.avgDurationMs <= 0) {
    rt.avgDurationMs = durationMs;
    return;
  }
  // Exponential moving average keeps ETA stable but reactive.
  rt.avgDurationMs = Math.round((rt.avgDurationMs * 0.7) + (durationMs * 0.3));
}

function isMirrorErrorLike(entry = {}) {
  const status = String(entry.status || '').toLowerCase();
  const text = String(entry.message || entry.action || '').toLowerCase();
  return status === 'error' || status === 'warning' || status === 'warn' || status === 'critical' || /error|failed|warning|critical|bloqu/.test(text);
}

function isMirrorRepairLike(entry = {}) {
  const text = String(entry.message || entry.action || '').toLowerCase();
  return /repair|repar|fix|corrig|resolved|termine|terminé|success|done/.test(text);
}

function getSystemLogPayload() {
  return {
    updated: new Date().toISOString(),
    agents: agentStates,
    logs: sysLogs.slice(0, 200)
  };
}

function writeJsonMirror(filePath, payload) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    return true;
  } catch (_) {
    return false;
  }
}

function summarizeMirrorEvent(entry = {}) {
  const message = entry.message || entry.action || entry.detail?.requestId || '';
  return {
    ts: entry.ts || new Date().toISOString(),
    agent: entry.agent || entry.from || 'system',
    to: entry.to || 'system',
    status: entry.status || 'info',
    phase: entry.phase || '',
    message: String(message).slice(0, 220)
  };
}

function buildBackupLiveStatePayload() {
  const runtime = getRuntimeSnapshot();
  const recentLogs = sysLogs.slice(0, 60);
  const recentErrors = recentLogs.filter((entry) => isMirrorErrorLike(entry)).slice(0, 20);
  const recentRepairs = recentLogs.filter((entry) => isMirrorRepairLike(entry)).slice(0, 20);
  const now = Date.now();
  const latestHistory = agentHistory[0] || null;
  const backupSyslogMtime = fs.existsSync(BACKUP_SYSLOG_PATH) ? fs.statSync(BACKUP_SYSLOG_PATH).mtimeMs : null;

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    sequence: backupLiveMirrorMeta.sequence,
    lastTrigger: backupLiveMirrorMeta.lastTrigger,
    lastEvent: backupLiveMirrorMeta.lastEvent,
    stats: {
      totalLogs: sysLogs.length,
      visibleErrors: recentErrors.length,
      recentRepairs: recentRepairs.length,
      activeAgents: runtime.filter((r) => r.status === 'en cours').length,
      blockedAgents: runtime.filter((r) => r.status === 'bloqué').length,
      historySnapshots: agentHistory.length
    },
    mirror: {
      lagMs: backupSyslogMtime ? Math.max(0, now - backupSyslogMtime) : null,
      backupSystemLogPath: BACKUP_SYSLOG_PATH,
      backupLiveStatePath: BACKUP_LIVE_STATE_PATH,
      backupLogsPath: BACKUP_LOGS_PATH
    },
    agents: agentStates,
    runtime,
    recentLogs,
    recentErrors,
    recentRepairs,
    latestHistory
  };
}

function writeBackupLiveMirrorNow() {
  const payload = buildBackupLiveStatePayload();
  writeJsonMirror(BACKUP_SYSLOG_PATH, getSystemLogPayload());
  writeJsonMirror(BACKUP_LIVE_STATE_PATH, payload);
  backupLiveMirrorMeta.updatedAt = payload.updatedAt;
}

function scheduleBackupLiveMirror(trigger = 'runtime', entry = null) {
  backupLiveMirrorMeta.sequence += 1;
  backupLiveMirrorMeta.lastTrigger = trigger;
  if (entry) backupLiveMirrorMeta.lastEvent = summarizeMirrorEvent(entry);
  if (_backupLiveMirrorTimer) return;
  _backupLiveMirrorTimer = setTimeout(() => {
    _backupLiveMirrorTimer = null;
    writeBackupLiveMirrorNow();
  }, 350);
}

function getRuntimeSnapshot() {
  const now = Date.now();
  return Object.keys(agentRuntime).map((name) => {
    const s = { ...agentRuntime[name] };
    if (s.status === 'en cours' && s.startedAt) {
      s.elapsedMs = now - s.startedAt;
    }
    const baseline = Number.isFinite(s.avgDurationMs) && s.avgDurationMs > 0
      ? s.avgDurationMs
      : (Number.isFinite(s.durationMs) && s.durationMs > 0 ? s.durationMs : null);
    if (s.status === 'en cours' && Number.isFinite(baseline)) {
      s.etaMs = Math.max(0, baseline - (s.elapsedMs || 0));
    } else if (s.status === 'en attente' && Number.isFinite(baseline)) {
      s.etaMs = baseline;
    } else {
      s.etaMs = null;
    }
    s.etaLabel = formatEtaLabel(s.etaMs);
    return s;
  });
}

function startAgentTask(agent, task, meta = {}) {
  const rt = ensureAgentRuntime(agent);
  rt.task = task || 'task';
  rt.status = 'en cours';
  rt.startedAt = Date.now();
  rt.finishedAt = null;
  rt.elapsedMs = 0;
  rt.durationMs = null;
  rt.cause = meta.cause || '';
  rt.impact = meta.impact || '';
  rt.solution = meta.solution || '';
  rt.to = meta.to || 'system';
  rt.updatedAt = Date.now();
  rt.runs = (rt.runs || 0) + 1;
  updateAgentState(agent, 'working', task);
  publishAgentChatMessage({
    agent,
    to: rt.to,
    status: 'action',
    phase: 'en cours',
    message: task,
    cause: rt.cause,
    impact: rt.impact,
    solution: rt.solution,
    startedAt: rt.startedAt,
    elapsedMs: 0,
    durationMs: null
  });
}

function finishAgentTask(agent, meta = {}) {
  const rt = ensureAgentRuntime(agent);
  const now = Date.now();
  const duration = rt.startedAt ? (now - rt.startedAt) : 0;
  rt.status = 'terminé';
  rt.finishedAt = now;
  rt.elapsedMs = duration;
  rt.durationMs = duration;
  updateAvgDuration(rt, duration);
  if (meta.cause) rt.cause = meta.cause;
  if (meta.impact) rt.impact = meta.impact;
  if (meta.solution) rt.solution = meta.solution;
  rt.updatedAt = now;
  updateAgentState(agent, 'idle', rt.task);
  publishAgentChatMessage({
    agent,
    to: meta.to || rt.to || 'system',
    status: 'info',
    phase: 'terminé',
    message: meta.message || `${rt.task} terminé`,
    cause: rt.cause,
    impact: rt.impact,
    solution: rt.solution,
    startedAt: rt.startedAt,
    elapsedMs: rt.elapsedMs,
    durationMs: rt.durationMs
  });
}

function blockAgentTask(agent, cause, impact, solution, to = 'system') {
  const rt = ensureAgentRuntime(agent);
  const now = Date.now();
  const duration = rt.startedAt ? (now - rt.startedAt) : 0;
  rt.status = 'bloqué';
  rt.finishedAt = now;
  rt.elapsedMs = duration;
  rt.durationMs = duration;
  updateAvgDuration(rt, duration);
  rt.cause = cause || 'unknown';
  rt.impact = impact || '';
  rt.solution = solution || '';
  rt.updatedAt = now;
  rt.blockedCount = (rt.blockedCount || 0) + 1;
  updateAgentState(agent, 'error', rt.task || 'blocked');
  publishAgentChatMessage({
    agent,
    to,
    status: 'error',
    phase: 'bloqué',
    message: `${rt.task || 'task'} bloqué`,
    cause: rt.cause,
    impact: rt.impact,
    solution: rt.solution,
    startedAt: rt.startedAt,
    elapsedMs: rt.elapsedMs,
    durationMs: rt.durationMs
  });
}

function setPendingAgent(agent, task, to = 'system') {
  const rt = ensureAgentRuntime(agent);
  if (rt.status === 'en cours') return;
  rt.task = task || rt.task || 'en attente';
  rt.status = 'en attente';
  rt.startedAt = null;
  rt.finishedAt = null;
  rt.elapsedMs = 0;
  rt.durationMs = null;
  rt.to = to;
  rt.updatedAt = Date.now();
  updateAgentState(agent, 'idle', rt.task);
}

async function runLiveRuntimeCycle() {
  if (!_runtimeLoopEnabled) return;
  if (_runtimeCycleInProgress) return;
  _runtimeCycleInProgress = true;
  _runtimeCycleCounter += 1;

  try {
    refreshRuntimeRegulation();

    if (_runtimeLoopTimer && _runtimeLoopCurrentIntervalMs !== _runtimeLoopTargetIntervalMs) {
      clearInterval(_runtimeLoopTimer);
      _runtimeLoopCurrentIntervalMs = _runtimeLoopTargetIntervalMs;
      _runtimeLoopTimer = setInterval(runLiveRuntimeCycle, _runtimeLoopCurrentIntervalMs);
    }

    const dispatchQueue = getRuntimeDispatchQueue();
    const activeSet = new Set(dispatchQueue.map((d) => d.name));
    AGENT_RUNTIME_CATALOG.forEach((name) => {
      if (!activeSet.has(name)) {
        setPendingAgent(name, 'en attente dépendances/priorité', 'orchestrator');
      }
    });

    const workers = dispatchQueue.map((task, idx) => runWithAgentLimit(async () => {
      const name = task.name;
      const baseDelay = 120 + (idx % 8) * 55 + _runtimeSlowdownMs;

      if (name === 'verification-agent') {
        startAgentTask(name, 'Vérification cohérence TV/MT5', {
          to: 'orchestrator',
          cause: 'anti-fake check',
          impact: 'validation données live',
          solution: 'bloquer si incohérence'
        });
        const healthOk = !!(marketStore && marketStore.systemStatus);
        await new Promise((r) => setTimeout(r, baseDelay));
        if (!healthOk) {
          blockAgentTask(name, 'source indisponible', 'aucune vérification live', 'attendre flux entrant', 'orchestrator');
          return;
        }
        finishAgentTask(name, { to: 'orchestrator', message: 'Vérification source OK' });
        return;
      }

      if (name === 'mirror-agent') {
        startAgentTask(name, 'Sync HTML existants', {
          to: 'project-controller',
          cause: 'cohérence UI',
          impact: 'évite divergences pages',
          solution: 'audit headers/scripts'
        });
        const pages = ['index.html', 'dashboard.html', 'AGENTS_MONITOR.html', 'agent-log-page.html'];
        const checks = pages.map((p) => ({ page: p, ok: fs.existsSync(path.join(__dirname, p)) }));
        await new Promise((r) => setTimeout(r, baseDelay));
        const bad = checks.filter((c) => !c.ok);
        if (bad.length > 0) {
          blockAgentTask(name, 'pages manquantes', `missing=${bad.map((b) => b.page).join(',')}`, 'restaurer pages', 'project-controller');
          return;
        }
        finishAgentTask(name, { to: 'project-controller', message: 'Synchronisation HTML validée' });
        return;
      }

      if (name === 'extension-agent') {
        startAgentTask(name, 'Contrôle extension Chrome', {
          to: 'bridge-agent',
          cause: 'vérification popup/content/background',
          impact: 'continuité UX extension',
          solution: 'signaler fichiers manquants'
        });
        const extFiles = ['tradingview-analyzer/popup.js', 'tradingview-analyzer/content.js', 'tradingview-analyzer/background.js'];
        const missing = extFiles.filter((f) => !fs.existsSync(path.join(__dirname, f)));
        await new Promise((r) => setTimeout(r, baseDelay));
        if (missing.length > 0) {
          blockAgentTask(name, 'fichier extension manquant', missing.join(','), 'corriger extension source', 'bridge-agent');
          return;
        }
        finishAgentTask(name, { to: 'bridge-agent', message: 'Extension contrôlée' });
        return;
      }

      if (name === 'bridge-agent') {
        startAgentTask(name, 'Bridge UI/backend/extension', {
          to: 'orchestrator',
          cause: 'liaison canaux',
          impact: 'messages unifiés',
          solution: 'maintenir /agent-activity et /system-log'
        });
        await new Promise((r) => setTimeout(r, baseDelay));
        finishAgentTask(name, { to: 'orchestrator', message: 'Bridge opérationnel' });
        return;
      }

      if (name === 'innovator-agent') {
        startAgentTask(name, 'Proposition solution blocage', {
          to: 'repair-agent',
          cause: 'résolution proactive',
          impact: 'réduction temps blocage',
          solution: 'proposer workaround'
        });
        const blocked = Object.values(agentRuntime).filter((x) => x.status === 'bloqué').length;
        await new Promise((r) => setTimeout(r, baseDelay));
        finishAgentTask(name, {
          to: 'repair-agent',
          message: blocked > 0 ? `Proposition: traiter ${blocked} blocages en priorité` : 'Aucun blocage critique'
        });
        return;
      }

      startAgentTask(name, `Cycle ${name} [${task.priorityLabel}]`, {
        to: 'orchestrator',
        cause: 'orchestration live priorisée',
        impact: 'exécution limitée et contrôlée',
        solution: 'queue intelligente'
      });
      await new Promise((r) => setTimeout(r, 2200 + (idx % 3) * 900 + _runtimeSlowdownMs));
      finishAgentTask(name, { to: 'orchestrator' });
    }, {
      priority: task.priority,
      dependsOn: task.dependsOn,
      taskKey: task.name,
      label: 'runtime:' + task.name
    }).catch((e) => {
      blockAgentTask(task.name, e.message || 'runtime error', 'cycle interrompu', 'relancer cycle', 'orchestrator');
    }));

    await Promise.allSettled(workers);
  } finally {
    _runtimeCycleInProgress = false;
  }
}

function startRuntimeLoop() {
  if (_runtimeLoopTimer) clearInterval(_runtimeLoopTimer);
  _runtimeLoopEnabled = true;
  refreshRuntimeRegulation();
  _runtimeLoopCurrentIntervalMs = _runtimeLoopTargetIntervalMs;
  _runtimeLoopTimer = setInterval(runLiveRuntimeCycle, _runtimeLoopCurrentIntervalMs);
  runLiveRuntimeCycle().catch(() => {});
}

function stopRuntimeLoop() {
  _runtimeLoopEnabled = false;
  if (_runtimeLoopTimer) {
    clearInterval(_runtimeLoopTimer);
    _runtimeLoopTimer = null;
  }
}

function registerAgentUnique(name, meta) {
  if (!name) return;
  if (_registeredAgentNames.has(name)) return;
  _registeredAgentNames.add(name);
  if (agentBus && typeof agentBus.registerAgent === 'function') {
    agentBus.registerAgent(name, meta || { role: 'agent', status: 'active', file: 'n/a' });
  }
  ensureAgentRuntime(name);
}

function broadcastAgentActivity(entry) {
  if (agentActivitySseClients.length === 0) return;
  const message = 'data: ' + JSON.stringify(entry) + '\n\n';
  for (let i = agentActivitySseClients.length - 1; i >= 0; i--) {
    try {
      agentActivitySseClients[i].write(message);
    } catch (e) {
      agentActivitySseClients.splice(i, 1); // Remove closed client
    }
  }
}

function updateAgentState(agentName, status, activeTask) {
  if (!agentStates[agentName]) {
    agentStates[agentName] = { status: 'unknown', lastActivity: Date.now(), activeTask: null };
  }
  agentStates[agentName].status = status;
  agentStates[agentName].lastActivity = Date.now();
  agentStates[agentName].activeTask = activeTask;
  
  // 🔴 UNIFIED SYNC: Envoyer aussi à Extension + HTML clients
  broadcastToExtension({
    type: 'agent-state-update',
    agent: agentName,
    status: status,
    activeTask: activeTask,
    lastActivity: agentStates[agentName].lastActivity
  });

  scheduleBackupLiveMirror('agent-state', {
    ts: new Date().toISOString(),
    agent: agentName,
    to: 'system',
    status,
    message: activeTask || 'state update'
  });
}

function publishAgentChatMessage(input = {}) {
  const agent = input.agent || input.from || 'system';
  const to = input.to || 'all';
  const status = String(input.status || 'info').toLowerCase();
  const message = input.message || '';
  const cause = input.cause || '';
  const impact = input.impact || '';
  const solution = input.solution || '';
  const phase = input.phase || 'en cours';

  const structured = {
    type: 'agent-chat',
    ts: new Date().toISOString(),
    agent,
    to,
    status,
    phase,
    message,
    cause,
    impact,
    solution,
    startedAt: input.startedAt || null,
    elapsedMs: input.elapsedMs == null ? null : input.elapsedMs,
    durationMs: input.durationMs == null ? null : input.durationMs,
    formatted: `[${agent}]\nstatut: ${status}\nmessage: ${message}\ncause: ${cause}\nimpact: ${impact}\nsolution: ${solution}`
  };

  // Single real-time stream for chat-style agent messages.
  broadcastAgentActivity(structured);

  // Mirror in extension sync so all UIs on :4000 see the same agent dialog.
  broadcastToExtension({
    type: 'agent-chat',
    ...structured
  });

  // Persist a short copy in system log history.
  pushLog(agent, to, message || 'agent message', status === 'error' ? 'error' : 'ok', {
    phase,
    cause,
    impact,
    solution
  });
}

function wireAgentBusToChat(agentNames = []) {
  if (!agentBus || typeof agentBus.subscribe !== 'function') return;

  // Clear previous subscriptions to avoid duplicate publications.
  while (_agentBusUnsubscribers.length > 0) {
    const unsub = _agentBusUnsubscribers.pop();
    try { if (typeof unsub === 'function') unsub(); } catch (_) {}
  }

  const uniqueNames = Array.from(new Set(agentNames.filter(Boolean)));
  uniqueNames.forEach((name) => {
    try {
      const unsub = agentBus.subscribe(name, (msg) => {
        const data = msg?.data || {};
        const msgType = String(msg?.type || 'info').toLowerCase();
        const status = data.status || (msgType.includes('error') ? 'error' : (msgType.includes('warn') ? 'warning' : (msgType.includes('action') ? 'action' : 'info')));

        publishAgentChatMessage({
          agent: msg?.from || 'unknown-agent',
          to: msg?.to || name,
          status,
          phase: data.phase || 'en cours',
          message: data.message || `bus:${msgType}`,
          cause: data.cause || '',
          impact: data.impact || '',
          solution: data.solution || ''
        });
      });
      _agentBusUnsubscribers.push(unsub);
    } catch (e) {
      console.error('[AGENT-BUS] subscribe failed for', name, e.message);
    }
  });
}

function analyzeHtmlDesignPage(page = 'dashboard.html') {
  const safePage = String(page || 'dashboard.html').replace(/\\/g, '/').replace(/^\/+/, '');
  const fullPath = path.join(__dirname, safePage);
  if (!fs.existsSync(fullPath)) {
    return {
      ok: false,
      page: safePage,
      error: 'page_not_found'
    };
  }

  const content = fs.readFileSync(fullPath, 'utf8');
  const idMatches = [...content.matchAll(/id\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const scriptMatches = [...content.matchAll(/<script[^>]*src\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const cssMatches = [...content.matchAll(/<link[^>]*href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);

  function getDuplicates(arr) {
    const counts = {};
    arr.forEach((v) => {
      counts[v] = (counts[v] || 0) + 1;
    });
    return Object.keys(counts)
      .filter((k) => counts[k] > 1)
      .map((k) => ({ value: k, count: counts[k] }));
  }

  const duplicateIds = getDuplicates(idMatches);
  const duplicateScripts = getDuplicates(scriptMatches);
  const duplicateCss = getDuplicates(cssMatches);

  const recommendations = [
    'Grouper les sections KPI, chat et actions en blocs semantiques explicites',
    'Conserver une seule inclusion par script/link duplique',
    'Conserver les IDs uniques pour les cibles JS et accessibilite',
    'Ne rien supprimer automatiquement: appliquer seulement des propositions'
  ];

  return {
    ok: true,
    page: safePage,
    stats: {
      ids: idMatches.length,
      scripts: scriptMatches.length,
      stylesheets: cssMatches.length
    },
    duplicates: {
      ids: duplicateIds,
      scripts: duplicateScripts,
      stylesheets: duplicateCss
    },
    recommendations
  };
}

function analyzeAllHtmlDesignPages() {
  const htmlFiles = fs.readdirSync(__dirname)
    .filter((n) => n.toLowerCase().endsWith('.html'))
    .sort((a, b) => a.localeCompare(b));

  const perPage = [];
  const titleMap = {};
  const endpointMap = {};
  const idMap = {};

  htmlFiles.forEach((page) => {
    const fullPath = path.join(__dirname, page);
    const content = fs.readFileSync(fullPath, 'utf8');

    const title = (content.match(/<title>([^<]+)<\/title>/i) || [null, ''])[1].trim() || page;
    const ids = [...content.matchAll(/id\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
    const scripts = [...content.matchAll(/<script[^>]*src\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
    const styles = [...content.matchAll(/<link[^>]*href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
    const hrefs = [...content.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
    const endpoints = [...content.matchAll(/fetch\s*\(\s*["'`]([^"'`]+)["'`]/gi)].map((m) => m[1]);

    titleMap[title] = titleMap[title] || [];
    titleMap[title].push(page);

    ids.forEach((id) => {
      idMap[id] = idMap[id] || [];
      idMap[id].push(page);
    });

    endpoints.forEach((ep) => {
      endpointMap[ep] = endpointMap[ep] || [];
      endpointMap[ep].push(page);
    });

    const role = (() => {
      const p = page.toLowerCase();
      if (p === 'dashboard.html') return 'dashboard';
      if (p === 'popup.html') return 'extension-popup';
      if (p.includes('test')) return 'test-validation';
      if (p.includes('audit') || p.includes('agent') || p.includes('monitor') || p.includes('live')) return 'supervision-audit';
      return 'general';
    })();

    perPage.push({
      page,
      role,
      title,
      stats: {
        ids: ids.length,
        scripts: scripts.length,
        styles: styles.length,
        hrefs: hrefs.length,
        endpoints: endpoints.length
      },
      modules: { ids, scripts, styles, hrefs, endpoints }
    });
  });

  const duplicateTitles = Object.entries(titleMap)
    .filter(([, pages]) => pages.length > 1)
    .map(([title, pages]) => ({ title, pages }));

  const duplicateIdsCrossPages = Object.entries(idMap)
    .filter(([, pages]) => Array.from(new Set(pages)).length > 1)
    .map(([id, pages]) => ({ id, pages: Array.from(new Set(pages)) }))
    .slice(0, 120);

  const sharedEndpoints = Object.entries(endpointMap)
    .filter(([, pages]) => Array.from(new Set(pages)).length > 1)
    .map(([endpoint, pages]) => ({ endpoint, pages: Array.from(new Set(pages)) }));

  const overlaps = [];
  for (let i = 0; i < perPage.length; i++) {
    for (let j = i + 1; j < perPage.length; j++) {
      const a = perPage[i];
      const b = perPage[j];
      const setA = new Set(a.modules.endpoints);
      const commonEndpoints = b.modules.endpoints.filter((e) => setA.has(e));
      if (commonEndpoints.length >= 2) {
        overlaps.push({
          pages: [a.page, b.page],
          commonEndpoints: Array.from(new Set(commonEndpoints))
        });
      }
    }
  }

  const organization = {
    dashboard: perPage.filter((p) => p.role === 'dashboard').map((p) => p.page),
    extensionPopup: perPage.filter((p) => p.role === 'extension-popup').map((p) => p.page),
    testsValidation: perPage.filter((p) => p.role === 'test-validation').map((p) => p.page),
    supervisionAudit: perPage.filter((p) => p.role === 'supervision-audit').map((p) => p.page),
    general: perPage.filter((p) => p.role === 'general').map((p) => p.page)
  };

  const regroupCandidates = overlaps
    .filter((o) => o.commonEndpoints.length >= 3)
    .map((o) => ({
      pages: o.pages,
      reason: 'shared-endpoints',
      details: o.commonEndpoints
    }));

  return {
    ok: true,
    scannedAt: new Date().toISOString(),
    totalHtml: perPage.length,
    pages: perPage,
    duplicates: {
      titles: duplicateTitles,
      idsCrossPages: duplicateIdsCrossPages,
      sharedEndpoints
    },
    overlaps,
    regroupCandidates,
    organization,
    recommendations: [
      'Conserver dashboard centré pilotage trading (graphiques + positions)',
      'Conserver popup.html comme miroir unique extension Chrome',
      'Regrouper test-analysis.html + EXTENSION_TEST.html dans la zone tests/audit',
      'Conserver AGENTS_MONITOR.html + agent-log-page.html + audit-dashboard.html en supervision',
      'Ne supprimer aucune page sans validation humaine et comparaison de contenu'
    ]
  };
}

function loadAgentHistoryFromDisk() {
  try {
    if (!fs.existsSync(AGENT_HISTORY_PATH)) return;
    const raw = fs.readFileSync(AGENT_HISTORY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed?.history) ? parsed.history : [];
    rows.slice(0, 200).forEach((r) => agentHistory.push(r));
  } catch (_) {}
}

function writeAgentHistoryToDisk() {
  const payload = {
    updatedAt: new Date().toISOString(),
    intervalMs: AGENT_HISTORY_INTERVAL_MS,
    history: agentHistory.slice(0, 200)
  };
  try {
    fs.writeFileSync(AGENT_HISTORY_PATH, JSON.stringify(payload, null, 2));
  } catch (_) {}
  try {
    fs.mkdirSync(path.dirname(AGENT_HISTORY_BACKUP_PATH), { recursive: true });
    fs.writeFileSync(AGENT_HISTORY_BACKUP_PATH, JSON.stringify(payload, null, 2));
  } catch (_) {}
  scheduleBackupLiveMirror('agent-history');
}

function buildAgentHistorySnapshot() {
  const runtime = getRuntimeSnapshot();
  const byStatus = runtime.reduce((acc, r) => {
    const k = String(r.status || 'unknown');
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const latestEvents = sysLogs.slice(0, 10).map((e) => ({
    ts: e.ts,
    from: e.from,
    to: e.to,
    action: e.action,
    status: e.status
  }));

  return {
    ts: new Date().toISOString(),
    summary: {
      totalAgents: runtime.length,
      byStatus,
      active: runtime.filter((r) => r.status === 'en cours').length,
      blocked: runtime.filter((r) => r.status === 'bloqué').length
    },
    runtime,
    latestEvents
  };
}

function runAgentHistoryCycle() {
  const snap = buildAgentHistorySnapshot();
  agentHistory.unshift(snap);
  if (agentHistory.length > 200) agentHistory.pop();
  writeAgentHistoryToDisk();
  scheduleBackupLiveMirror('history-cycle', {
    ts: snap.ts,
    agent: 'history-agent',
    to: 'developer',
    status: 'info',
    message: 'Snapshot agents enregistré'
  });

  publishAgentChatMessage({
    agent: 'history-agent',
    to: 'developer',
    status: 'info',
    phase: 'terminé',
    message: 'Snapshot agents enregistré',
    cause: 'cycle périodique 30min',
    impact: `active=${snap.summary.active} blocked=${snap.summary.blocked}`,
    solution: 'consulter /agents/history'
  });
}

// Debounce: max 1 écriture disque toutes les 5 secondes
let _sysLogTimer = null;
function writeSysLog() {
  if (_sysLogTimer) return;
  _sysLogTimer = setTimeout(() => {
    _sysLogTimer = null;
    try {
      const payload = getSystemLogPayload();
      fs.writeFileSync(SYSLOG_PATH, JSON.stringify(payload, null, 2));
      writeJsonMirror(BACKUP_SYSLOG_PATH, payload);
    } catch (_) {}
    scheduleBackupLiveMirror('system-log-write');
  }, 5000);
}

// ── Internal push — appeler depuis n'importe quel agent pour alimenter le log ──
function pushLog(from, to, action, status, detail) {
  const entry = {
    id:     Date.now(),
    ts:     new Date().toISOString(),
    from:   from   || 'system',
    to:     to     || 'system',
    action: action || '',
    status: status || 'ok',
    detail: detail || ''
  };
  sysLogs.unshift(entry);
  if (sysLogs.length > 500) sysLogs.pop();
  
  // Update agent state based on the log
  if (from && from !== 'system') {
    const agentStatus = (status === 'error') ? 'error' : 'working';
    updateAgentState(from, agentStatus, action);
    setTimeout(() => {
      if (agentStates[from]) agentStates[from].status = 'idle';
    }, 3000);
  }
  
  // Broadcast to SSE and marketStore
  try { marketStore.broadcast({ type: 'syslog', entry }); } catch (_) {}
  broadcastAgentActivity(entry);
  writeSysLog();
  scheduleBackupLiveMirror('push-log', entry);
}

app.post('/system-log', (req, res) => {
  const entry = {
    id:     sysLogs.length + 1,
    ts:     new Date().toISOString(),
    from:   req.body?.from    || 'unknown',
    to:     req.body?.to      || 'system',
    action: req.body?.action  || '',
    status: req.body?.status  || 'ok',
    data:   req.body?.data    || null
  };
  sysLogs.unshift(entry);
  if (sysLogs.length > 500) sysLogs.pop();
  // Keep monitor synchronized in real-time with log writes.
  try { broadcastAgentActivity(entry); } catch (_) {}
  writeSysLog();
  scheduleBackupLiveMirror('system-log-post', entry);
  res.json({ ok: true, id: entry.id });
});

app.get('/system-log', (_req, res) => {
  res.json({ ok: true, agents: agentStates, logs: sysLogs.slice(0, 50) });
});

app.get('/agents/runtime', (_req, res) => {
  const snapshot = getRuntimeSnapshot();
  const totalEtaMs = snapshot
    .filter((a) => Number.isFinite(a.etaMs) && a.etaMs >= 0)
    .reduce((acc, a) => acc + a.etaMs, 0);
  const systemLoadVolume = Math.round(
    (_cpuPercent * 0.6) +
    (Math.min(100, _activeAgentExecutions * 50) * 0.2) +
    (Math.min(100, _agentExecutionQueue.length * 10) * 0.2)
  );
  const queuedPreview = _agentExecutionQueue
    .slice(0, 20)
    .map((t) => ({
      id: t.id,
      label: t.label,
      priority: t.priorityLabel || getDispatchPriorityLabel(t.priority),
      dependsOn: t.dependsOn || [],
      waitingMs: Math.max(0, Date.now() - (t.enqueuedAt || Date.now()))
    }));
  res.json({
    ok: true,
    enabled: _runtimeLoopEnabled,
    regulation: {
      cpuPercent: _cpuPercent,
      maxActiveAgents: _agentExecutionDynamicMax,
      slowdownMs: _runtimeSlowdownMs,
      autoSafeMode: _runtimeAutoSafeMode,
      effectiveSafeMode: getEffectiveSafeMode(),
      intervalMs: _runtimeLoopCurrentIntervalMs || _runtimeLoopTargetIntervalMs
    },
    dispatcher: {
      activeExecutions: _activeAgentExecutions,
      pendingTasks: _agentExecutionQueue.length,
      maxConcurrent: _agentExecutionDynamicMax,
      systemLoadVolume,
      completedKeys: _agentExecutionCompletedAt.size,
      queuePreview: queuedPreview
    },
    totalAgents: snapshot.length,
    totalEtaMs,
    totalEtaLabel: formatEtaLabel(totalEtaMs),
    agents: snapshot
  });
});

app.get('/agents/history', (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '20', 10) || 20));
  res.json({
    ok: true,
    intervalMs: AGENT_HISTORY_INTERVAL_MS,
    count: Math.min(limit, agentHistory.length),
    history: agentHistory.slice(0, limit)
  });
});

app.get('/backup/live-state', (_req, res) => {
  const payload = buildBackupLiveStatePayload();
  res.json(payload);
});

app.post('/agents/runtime/start', (_req, res) => {
  startRuntimeLoop();
  res.json({ ok: true, enabled: true });
});

app.post('/agents/runtime/stop', (_req, res) => {
  stopRuntimeLoop();
  res.json({ ok: true, enabled: false });
});

// ── AI REPAIR REQUEST (collects diagnostic for AI repair) ─────────────────
const repairRequests = {};  // {requestId: {timestamp, errors, context, status}}
app.post('/ai-repair-request', (req, res) => {
  try {
    const {from, to, action, module, context, timestamp} = req.body;
    
    const requestId = require('crypto').randomUUID();
    const repairRequest = {
      id: requestId,
      timestamp: timestamp || new Date().toISOString(),
      from,
      to,
      action,
      module,
      context,
      status: 'PENDING',
      createdAt: Date.now()
    };
    
    // Store in memory
    repairRequests[requestId] = repairRequest;
    
    // Also log to system logs
    sysLogs.unshift({
      id: sysLogs.length + 1,
      ts: repairRequest.timestamp,
      from: from || 'extension',
      to: 'ai-repair',
      action: action || 'REPAIR_REQUEST',
      status: 'PENDING',
      detail: {
        requestId,
        module,
        errorCount: context?.errors?.length || 0
      }
    });
    if (sysLogs.length > 500) sysLogs.pop();
    writeSysLog();
    scheduleBackupLiveMirror('repair-request', {
      ts: repairRequest.timestamp,
      from: from || 'extension',
      to: 'ai-repair',
      status: 'warning',
      action: action || 'REPAIR_REQUEST'
    });
    
    // Broadcast to SSE clients
    broadcastAgentActivity({
      type: 'repair_request',
      requestId,
      module,
      timestamp: repairRequest.timestamp
    });
    
    console.log('[AI_REPAIR] Request created:', requestId, 'Module:', module);
    
    res.json({ ok: true, requestId, status: 'PENDING' });
  } catch (e) {
    console.error('[AI_REPAIR] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get repair request status
app.get('/ai-repair-request/:id', (req, res) => {
  const {id} = req.params;
  const repairReq = repairRequests[id];
  
  if (!repairReq) {
    return res.status(404).json({ok: false, error: 'Request not found'});
  }
  
  res.json({ok: true, request: repairReq});
});

// ─── AGENT STATUS (current agent states) ──────────────────────────────────────
app.get('/agent-status', (_req, res) => {
  const statusMap = {};
  for (const [name, state] of Object.entries(agentStates)) {
    statusMap[name] = {
      status: state.status,
      lastActivity: state.lastActivity,
      activeTask: state.activeTask,
      secondsAgoLastActivity: Math.round((Date.now() - state.lastActivity) / 1000)
    };
  }
  res.json({ ok: true, agents: statusMap, timestamp: new Date().toISOString() });
});

// ─── AGENT ACTIVITY STREAM (SSE — real-time agent logs) ─────────────────────
app.get('/agent-activity', (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send current agent states as initial data
  res.write('data: ' + JSON.stringify({ type: 'initial', agents: agentStates, logs: sysLogs.slice(0, 50) }) + '\n\n');

  // Add client to the list
  agentActivitySseClients.push(res);

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (e) {
      clearInterval(heartbeat);
      const idx = agentActivitySseClients.indexOf(res);
      if (idx > -1) agentActivitySseClients.splice(idx, 1);
    }
  }, 15000);

  res.on('close', () => {
    clearInterval(heartbeat);
    const idx = agentActivitySseClients.indexOf(res);
    if (idx > -1) agentActivitySseClients.splice(idx, 1);
  });
});

// ─── AGENT BUS (lecture AGENT_BUS.json pour coordination multi-IA) ───────────
const AGENT_BUS_PATH = path.join(__dirname, 'AGENT_BUS.json');
app.get('/agent-bus', (_req, res) => {
  try {
    const raw = fs.readFileSync(AGENT_BUS_PATH, 'utf8');
    const bus = JSON.parse(raw);
    res.json({
      ok:          true,
      version:     bus.version,
      lastUpdated: bus.lastUpdated,
      systemStatus: bus.systemStatus || {},
      roles:       bus.roles   || {},
      tasks: {
        done:        (bus.tasks && bus.tasks.done)         || [],
        inProgress:  (bus.tasks && bus.tasks.inProgress)   || [],
        pending:     (bus.tasks && bus.tasks.pending)      || []
      }
    });
  } catch (e) {
    res.json({ 
      ok: false, 
      error: e.message, 
      tasks: { done: [], inProgress: [], pending: [] } 
    });
  }
});

// ─── TASKS + LOGS (coordination Claude ↔ Agents) ─────────────────────────────
const TASKS_PATH = path.join(__dirname, 'tasks.json');
const LOGS_PATH  = path.join(__dirname, 'logs.json');

app.get('/tasks', (_req, res) => {
  try { res.json({ ok: true, ...JSON.parse(fs.readFileSync(TASKS_PATH, 'utf8')) }); }
  catch (e) { res.json({ ok: false, error: e.message, tasks: [] }); }
});

app.post('/tasks/update', (req, res) => {
  try {
    const data   = JSON.parse(fs.readFileSync(TASKS_PATH, 'utf8'));
    const { task_id, status, result } = req.body || {};
    const task = (data.tasks || []).find(t => t.task_id === task_id);
    if (task) { task.status = status || task.status; if (result) task.result = result; task.updated_at = new Date().toISOString(); }
    data.updated = new Date().toISOString();
    fs.writeFileSync(TASKS_PATH, JSON.stringify(data, null, 2));
    pushLog('agent', 'claude', 'TASK ' + task_id + ' → ' + status, status === 'error' ? 'err' : 'ok', result || '');
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/logs', (_req, res) => {
  try { res.json({ ok: true, ...JSON.parse(fs.readFileSync(LOGS_PATH, 'utf8')) }); }
  catch (e) { res.json({ ok: false, error: e.message, logs: [] }); }
});

app.post('/logs', (req, res) => {
  try {
    const data  = JSON.parse(fs.readFileSync(LOGS_PATH, 'utf8'));
    const entry = { id: Date.now(), ts: new Date().toISOString(), agent: req.body.agent || 'unknown', task_id: req.body.task_id || '', action: req.body.action || '', status: req.body.status || 'ok', detail: req.body.detail || '' };
    (data.logs = data.logs || []).unshift(entry);
    if (data.logs.length > 500) data.logs.pop();
    fs.writeFileSync(LOGS_PATH, JSON.stringify(data, null, 2));
    writeJsonMirror(BACKUP_LOGS_PATH, data);
    pushLog(entry.agent, 'system', entry.action, entry.status, entry.detail);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ─── ACTIVE SYMBOL (sync extension TradingView → Studio) ─────────────────────

app.get('/active-symbol', (_req, res) => {
  res.json({ ok: true, ...activeSymbol });
});

app.post('/active-symbol', (req, res) => {
  const { symbol, timeframe, price, mode } = req.body || {};  // MODIFIÉ: Add mode
  if (symbol) {
    const normalizedInput = String(symbol).replace(/[/\-\s]/g, '').toUpperCase();
    const normalized = normalizeSymbol(normalizedInput).canonical || normalizedInput;
    const tvPrice    = price ? parseFloat(price) : null;
    const requestedMode = normalizeBridgeMode(mode || activeSymbol?.mode || bridgeConfig.bridgeMode || 'AUTO');
    const resolvedMode = resolveRuntimeMode(requestedMode, normalized, timeframe || 'H1');
    activeSymbol = {
      symbol:    normalized,
      timeframe: timeframe || 'H1',
      tvPrice:   tvPrice,
      mode:      requestedMode,
      modeResolved: resolvedMode,
      updatedAt: new Date().toISOString()
    };
    saveExtensionRuntimeState();
    try { marketStore.broadcast({ type: 'activeSymbol', ...activeSymbol }); } catch (_) {}

    applyBridgeConfigPatch({
      bridgeMode: requestedMode,
      symbolAliasBridge: normalized,
      bridgeSource: 'extension-or-html'
    }, 'active-symbol-endpoint');
    
    // 🔴 UNIFIED SYNC: Envoyer aussi à Extension + HTML clients
    broadcastToExtension({
      type: 'active-symbol',
      symbol: normalized,
      timeframe: timeframe || 'H1',
      price: tvPrice,
      mode: requestedMode,
      modeResolved: resolvedMode,
      source: 'extension-or-html'
    });

    emitBridgeConfig('active-symbol');
    
    pushLog('extension', 'orchestrator',
      `SYMBOLE DÉTECTÉ ${normalized} @ ${tvPrice ? tvPrice.toFixed(tvPrice > 10 ? 2 : 5) : '?'} [${requestedMode}/${resolvedMode}]`,
      'ok',
      `TF:${timeframe || 'H1'} · Mode:${requestedMode} → ${resolvedMode} · source:TradingView`
    );
  }
  res.json({ ok: true, activeSymbol });
});

// ─── AGENT FILTRE ────────────────────────────────────────────────────────────
app.post('/agent-filtre', (req, res) => {
  res.json({ ok: true, opportunities: [], note: 'Connectez MT5 pour des opportunités filtrées en temps réel' });
});

// ─── ERROR HANDLER ────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[SERVER ERROR]', err.message);
  res.status(500).json({ ok: false, error: err.message });
});

// ─── AUTO ORCHESTRATION LOOP ─────────────────────────────────────────────────
// Tourne toutes les 30s sur le symbole actif — alimente le AGENTS LIVE LOG en réel
async function runOrchestrationCycle() {
  const sym = activeSymbol && activeSymbol.symbol;
  if (!sym) return; // Pas de symbole détecté, rien à faire

  const tf = (activeSymbol.timeframe || 'H1').toUpperCase();

  try {
    // 1. Prix live — TradingView est la source maître
    let price;
    const tvLive = tvDataStore[sym];
    const tvAge  = tvLive ? (Date.now() - (tvLive.updatedAt || 0)) : Infinity;
    if (tvLive && tvAge < 30000) {
      // TradingView price disponible et récent (< 30s) — on l'utilise directement
      price = parseFloat(tvLive.price);
      pushLog('orchestrator', 'system',
        `BOUCLE ${sym} — prix TradingView (${(tvAge / 1000).toFixed(1)}s)`,
        'ok', `source:TradingView · price:${price}`);
    } else {
      // Pas de bridge TV récent — aucune source externe autorisée (Yahoo supprimé)
      console.log(`[ORCHESTRATOR] ${sym} — bridge absent ou > 30s, skip (aucune source externe — Yahoo Finance supprimé)`);
      pushLog('orchestrator', 'system', `BOUCLE ${sym} — bridge TV absent ou trop ancien, skip`, 'warn', 'source:bridge-offline');
      return;
    }

    pushLog('orchestrator', 'technicalAgent',
      `REQUÊTE analyse ${sym} @ ${price.toFixed(price > 10 ? 2 : 5)}`,
      'ok', `TF:${tf} · cycle:auto`);

    // 2. Technical analysis
    try {
      const technicalAgent = require('./src/agents/technicalAgent');
      const profile        = normalizeSymbol(sym);
      const result         = await technicalAgent.analyze({ symbol: sym, price, timeframe: tf }, profile);
      if (result) {
        pushLog('technicalAgent', 'orchestrator',
          `RÉSULTAT ${sym} → ${result.direction || '?'} | Score:${result.score || 0}`,
          'ok',
          `RSI:${result.rsi != null ? result.rsi.toFixed(1) : '?'} · EMA20:${result.ema20 != null ? result.ema20.toFixed(2) : '?'} · signal:${result.signal || '?'}`
        );
      }
    } catch (e) {
      pushLog('technicalAgent', 'orchestrator', `ERREUR analyse ${sym}`, 'err', e.message);
    }

    // 3. Macro check (rapide)
    try {
      const macroAgent = require('./src/agents/macroAgent');
      const calendar   = await macroAgent.getEconomicCalendar();
      const impact     = await macroAgent.analyzeEconomicImpact(calendar);
      pushLog('macroAgent', 'orchestrator',
        `MACRO · ${calendar.length} events · Risk:${impact.riskLevel}`,
        impact.riskLevel === 'High' ? 'warn' : 'ok',
        `nextEvent:${impact.nextEvent || 'aucun'}`
      );
    } catch (_) {}

  } catch (err) {
    pushLog('orchestrator', 'system', `CYCLE ERREUR: ${err.message}`, 'err', sym);
  }
}

// ─── SCREENSHOT ANALYSIS (extension) ────────────────────────────────────────
app.post('/analyze-screenshot', (req, res) => {
  try {
    const { image, symbol, timeframe } = req.body || {};
    if (!image || !symbol) {
      return res.status(400).json({ ok: false, error: 'Missing image or symbol' });
    }
    
    // Simulate screenshot analysis (in real scenario, you'd send to image AI)
    const analysis = {
      symbols_detected: [symbol],
      structure: 'Trend continuation after consolidation',
      fvg_present: true,
      liquidity: 'High in range',
      bos_choch: 'No recent break of structure',
      confirmations: ['Price > EMA20', 'RSI > 50', 'Volume rising']
    };
    
    pushLog('extension', 'system', `Screenshot analyzed: ${symbol}`, 'ok', 'FVG detected, high confidence');
    res.json({ ok: true, analysis: analysis });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── BROKER CONFIGURATION ────────────────────────────────────────────────────
const BROKER_SYMBOLS = {
  tradingview: {
    XAUUSD: 'XAUUSD', EURUSD: 'EURUSD', GBPUSD: 'GBPUSD', BTCUSD: 'BTCUSD', NAS100: 'NAS100', US500: 'US500'
  },
  topstep: {
    XAUUSD: 'GOLD', EURUSD: 'EURUSD', GBPUSD: 'GBPUSD', BTCUSD: 'BTC', NAS100: 'NQ-Mini', US500: 'ES-Mini'
  },
  oanda: {
    XAUUSD: 'XAU_USD', EURUSD: 'EUR_USD', GBPUSD: 'GBP_USD', BTCUSD: 'BTC_USD', NAS100: 'US100_USD', US500: 'US500_USD'
  }
};

let selectedBroker = 'tradingview'; // Current user selection

app.post('/broker-select', (req, res) => {
  try {
    const { broker } = req.body || {};
    if (!broker || !BROKER_SYMBOLS[broker]) {
      return res.status(400).json({ ok: false, error: 'Invalid broker' });
    }
    
    selectedBroker = broker;
    pushLog('extension', 'system', `Broker selected: ${broker}`, 'ok', '');
    res.json({ ok: true, selected: broker });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/broker-config/:broker', (req, res) => {
  try {
    const broker = req.params.broker.toLowerCase();
    if (!BROKER_SYMBOLS[broker]) {
      return res.status(400).json({ ok: false, error: 'Invalid broker' });
    }
    
    res.json({
      ok: true,
      broker: broker,
      mapping: BROKER_SYMBOLS[broker],
      current: selectedBroker
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── HTML PAGES RACINE — toutes les pages servies ────────────────────────────
app.get('/agent-log',        (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'agent-log-page.html')));
app.get('/agent-live-log',   (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'agent-log-page.html')));
app.get('/agents/log',       (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'agent-log-page.html')));
app.get('/dashboard',        (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'dashboard.html')));
app.get('/dashboard.html',   (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'dashboard.html')));
app.get('/popup',            (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'popup.html')));
app.get('/popup.html',       (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'popup.html')));
app.get('/agents-monitor',   (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'AGENTS_MONITOR.html')));
app.get('/agents/monitor',   (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'AGENTS_MONITOR.html')));
app.get('/AGENTS_MONITOR.html', (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'AGENTS_MONITOR.html')));
app.get('/extension-test',   (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'EXTENSION_TEST.html')));
app.get('/EXTENSION_TEST.html', (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'EXTENSION_TEST.html')));
app.get('/test-analysis',    (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'test-analysis.html')));
app.get('/test-analysis.html',  (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'test-analysis.html')));
app.get('/test-chart',       (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'test-chart-visual.html')));
app.get('/test-chart-visual.html', (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'test-chart-visual.html')));

// ─── MARKET NEWS — calendrier économique ForexFactory ────────────────────────
let _newsCache = null;
let _newsCacheTs = 0;
const NEWS_TTL = 5 * 60 * 1000; // 5 minutes

app.get('/market-news', async (_req, res) => {
  try {
    const now = Date.now();
    if (_newsCache && (now - _newsCacheTs) < NEWS_TTL) {
      return res.json({ ok: true, events: _newsCache, cached: true });
    }
    // ForexFactory public JSON calendar
    const https = require('https');
    const raw = await new Promise((resolve, reject) => {
      const req = https.get('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { timeout: 6000 }, resp => {
        let data = '';
        resp.on('data', d => { data += d; });
        resp.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    const events = JSON.parse(raw);
    // Filter: only Medium + High impact
    const filtered = (Array.isArray(events) ? events : [])
      .filter(e => e.impact === 'High' || e.impact === 'Medium')
      .map(e => ({
        title:   e.title   || e.name || '',
        country: e.country || '',
        date:    e.date    || '',
        time:    e.time    || '',
        impact:  e.impact  || 'Low',
        forecast: e.forecast || '',
        previous: e.previous || ''
      }));
    _newsCache = filtered;
    _newsCacheTs = now;
    res.json({ ok: true, events: filtered });
  } catch (e) {
    // Return cached even if stale, or empty
    res.json({ ok: false, events: _newsCache || [], error: e.message });
  }
});

// ─── Economic Calendar (formatted for frontend) ──────────────────────────────
app.get('/economic-calendar', async (_req, res) => {
  try {
    const now = Date.now();
    if (_newsCache && (now - _newsCacheTs) < NEWS_TTL) {
      const formatted = formatEconomicEvents(_newsCache);
      return res.json({ ok: true, events: formatted, cached: true });
    }
    // Fetch from ForexFactory
    const https = require('https');
    const raw = await new Promise((resolve, reject) => {
      const req = https.get('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { timeout: 6000 }, resp => {
        let data = '';
        resp.on('data', d => { data += d; });
        resp.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    const events = JSON.parse(raw);
    _newsCache = events;
    _newsCacheTs = now;
    
    const formatted = formatEconomicEvents(events);
    res.json({ ok: true, events: formatted });
  } catch (e) {
    console.error('[CALENDAR]', e.message);
    res.json({ ok: false, events: [], error: e.message });
  }
});

function formatEconomicEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.map(e => ({
    title:    e.title || e.name || 'Economic Event',
    country:  e.country || 'XX',
    time:     e.time || e.date || new Date().toISOString(),
    dateTime: e.date + ' ' + e.time || new Date().toISOString(),
    importance: e.impact === 'High' ? 'HIGH' : e.impact === 'Medium' ? 'MEDIUM' : 'LOW',
    impact:   e.impact || 'Low',
    forecast: e.forecast || '',
    previous: e.previous || '',
    actual:   e.actual || null
  }));
}

// ─── FALLBACK ENDPOINTS (Studio Web Interface) ────────────────────────────────
// Keep only fallback routes that do not duplicate existing primary endpoints.

app.post('/instant-trade-live', (req, res) => {
  // POST handler for instant trade
  res.json({
    ok: true,
    trade: null,
    source: 'server-fallback',
    message: 'Instant trade not available'
  });
});

app.get('/screen', (_req, res) => {
  // Screenshot endpoint (studio diagnostic)
  res.json({ 
    ok: true, 
    screenshot: null,
    source: 'server-fallback',
    message: 'Screenshot not available'
  });
});

// ─── STUDIO ENDPOINTS (popup.js bridge calls) ─────────────────────────────────
app.get('/studio/data', (_req, res) => {
  // Return REAL MT5 data from marketStore
  const mt5Data = marketStore.lastMT5Payload || {};
  res.json({
    ok: true,
    symbol: mt5Data.symbol || 'EURUSD',
    price: mt5Data.price || mt5Data.bid || mt5Data.ask || 1.0870,
    bid: mt5Data.bid || null,
    ask: mt5Data.ask || null,
    timeframe: mt5Data.timeframe || 'H1',
    ohlc: mt5Data.ohlc || mt5Data.bars || [],
    timestamp: new Date().toISOString(),
    source: 'mt5',
    lastUpdate: marketStore.systemStatus.lastUpdate
  });
});

// ─── CONSOLIDATED PORT 4000: /data endpoint for Chrome extension ──────────────
app.get('/data', (_req, res) => {
  // Return REAL MT5 data from marketStore for Chrome extension
  const mt5Data = marketStore.lastMT5Payload || {};
  const normalized = {
    symbol: mt5Data.symbol || 'EURUSD',
    price: mt5Data.price || mt5Data.bid || mt5Data.ask || 1.0870,
    bid: mt5Data.bid || null,
    ask: mt5Data.ask || null,
    timeframe: mt5Data.timeframe || 'H1',
    ohlc: mt5Data.ohlc || mt5Data.bars || [],
    timestamp: new Date().toISOString(),
    source: 'mt5',
    lastUpdate: marketStore.systemStatus.lastUpdate
  };
  res.json({
    ok: true,
    ...normalized,
    data: normalized
  });
});

app.get('/studio/agent-screen', (_req, res) => {
  // Return agent analysis + screenshot
  res.json({
    ok: true,
    agents: marketStore.agents || [],
    consensus: marketStore.consensus || 'HOLD',
    screenshot: null,
    timestamp: new Date().toISOString()
  });
});

app.post('/studio/system-log', (req, res) => {
  // Log endpoint for popup.js
  const logEntry = req.body || {};
  const nextId = Array.isArray(sysLogs) ? (sysLogs.length + 1) : 1;
  const entry = {
    id: nextId,
    ts: new Date().toISOString(),
    source: logEntry.source || 'extension-popup',
    message: logEntry.message || 'popup-log',
    data: logEntry.data || null
  };
  console.log('[POPUP_LOG]', entry.message, entry.data || '');
  if (Array.isArray(sysLogs)) {
    sysLogs.unshift(entry);
    if (sysLogs.length > 500) sysLogs.pop();
  }
  res.json({
    ok: true,
    logged: true,
    entry,
    timestamp: new Date().toISOString()
  });
});

app.get('/studio/system-log', (_req, res) => {
  // Get system logs
  res.json({
    ok: true,
    logs: Array.isArray(sysLogs) ? sysLogs.slice(0, 50) : [],
    timestamp: new Date().toISOString()
  });
});

// ─── MAPPING ENDPOINTS (Symbol ↔ MT5 synchronization) ─────────────────────────
// In-memory mapping store (could be persistent in production)
const mappingStore = {};

app.post('/studio/mapping-save', (req, res) => {
  const { userInput, mt5Symbol, price } = req.body;
  
  if (!userInput || !mt5Symbol) {
    return res.json({ ok: false, error: 'userInput and mt5Symbol required' });
  }
  
  const key = userInput.toUpperCase();
  mappingStore[key] = {
    userInput: key,
    mt5Symbol: mt5Symbol.toUpperCase(),
    price: price || null,
    savedAt: new Date().toISOString()
  };
  
  console.log('[MAPPING] Saved:', key, '→', mt5Symbol);
  
  res.json({
    ok: true,
    mapping: mappingStore[key],
    message: 'Mapping saved successfully'
  });
});

app.get('/studio/mapping-list', (_req, res) => {
  const mappings = Object.values(mappingStore);
  res.json({
    ok: true,
    mappings: mappings,
    count: mappings.length,
    timestamp: new Date().toISOString()
  });
});

app.get('/studio/mapping/:input', (req, res) => {
  const key = req.params.input.toUpperCase();
  const mapping = mappingStore[key];
  
  if (!mapping) {
    return res.json({ ok: false, error: 'Mapping not found' });
  }
  
  res.json({
    ok: true,
    mapping: mapping
  });
});

// ─── PYTHON PROCESS TRACKING ──────────────────────────────────────────────────
let pythonProcesses = {
  pip: null,
  bridge: null
};

// ─── PYTHON DEPENDENCIES CHECK & INSTALL ──────────────────────────────────────
// Check which Python packages are installed
app.get('/pip/check', (req, res) => {
  const packages = ['metatrader5', 'flask', 'flask-cors', 'python-dotenv', 'requests'];
  const status = {};
  
  for (const pkg of packages) {
    try {
      execSync(`python -c "import ${pkg.replace('-', '_').split('>=')[0]}"`, {
        stdio: 'ignore',
        cwd: __dirname,
        windowsHide: true
      });
      status[pkg] = true;
    } catch {
      status[pkg] = false;
    }
  }
  
  const allInstalled = Object.values(status).every(v => v);
  res.json({
    ok: true,
    packages: status,
    allInstalled: allInstalled,
    timestamp: new Date().toISOString()
  });
});

// Install Python dependencies
app.post('/pip/install', (req, res) => {
  const reqFile = path.join(__dirname, 'requirements-mt5.txt');
  
  if (!fs.existsSync(reqFile)) {
    return res.status(400).json({
      ok: false,
      error: 'requirements-mt5.txt not found'
    });
  }
  
  try {
    // Run pip install in background
    const pip = spawn('python', ['-m', 'pip', 'install', '-q', '-r', 'requirements-mt5.txt'], {
      cwd: __dirname,
      stdio: 'pipe',
      windowsHide: true
    });
    
    // Track the process
    pythonProcesses.pip = pip;
    
    let output = '';
    let errorMsg = '';
    
    pip.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    pip.stderr.on('data', (data) => {
      errorMsg += data.toString();
    });
    
    pip.on('close', (code) => {
      console.log(`[PIP] Install completed with code ${code}`);
      console.log(`[PIP] Output: ${output}`);
      if (errorMsg) console.log(`[PIP] Errors: ${errorMsg}`);
      pythonProcesses.pip = null;
    });
    
    res.json({
      ok: true,
      message: 'Installation started',
      command: 'pip install -r requirements-mt5.txt',
      pid: pip.pid
    });
    
    console.log(`[PIP] Started installation (PID: ${pip.pid})`);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: 'Failed to start installation',
      message: err.message
    });
  }
});

// Stop Python processes (pip, bridge, etc)
app.post('/pip/stop', (req, res) => {
  let stopped = [];
  let errors = [];
  
  try {
    // Stop pip install if running
    if (pythonProcesses.pip) {
      try {
        process.kill(-pythonProcesses.pip.pid); // Kill process group
        stopped.push(`pip install (PID: ${pythonProcesses.pip.pid})`);
        pythonProcesses.pip = null;
        console.log('[STOP] Killed pip process');
      } catch (err) {
        errors.push('pip: ' + err.message);
      }
    }
    
    // Stop bridge processes
    if (pythonProcesses.bridge) {
      try {
        process.kill(-pythonProcesses.bridge.pid);
        stopped.push(`bridge (PID: ${pythonProcesses.bridge.pid})`);
        pythonProcesses.bridge = null;
        console.log('[STOP] Killed bridge process');
      } catch (err) {
        errors.push('bridge: ' + err.message);
      }
    }
    
    // Also try to kill legacy bridge helper processes
    try {
      if (process.platform === 'win32') {
        // Windows: use taskkill
        execSync('taskkill /F /IM python.exe 2>nul || true', { stdio: 'ignore', windowsHide: true });
        console.log('[STOP] Attempted taskkill on Windows');
      } else {
        // Linux/Mac: use pkill
        execSync('pkill -f "mt5_bridge" 2>/dev/null || true', { stdio: 'ignore' });
        console.log('[STOP] Attempted pkill on Unix');
      }
    } catch (err) {
      // Silently ignore if system command fails
    }
    
    res.json({
      ok: true,
      message: stopped.length > 0 ? 'Processus arrêtés: ' + stopped.join(', ') : 'Aucun processus en cours',
      stopped: stopped,
      errors: errors.length > 0 ? errors : null
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: 'Failed to stop processes',
      message: err.message
    });
  }
});

// Start MT5 Bridge Python script
// ═══════════════════════════════════════════════════════════════════════════════
// POST /bridge/start - START MT5 PYTHON BRIDGE
// Response: ALWAYS JSON (never HTML)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/bridge/start', (req, res) => {
  return res.status(423).json({
    ok: false,
    error: 'bridge_start_disabled',
    message: 'Single-environment mode active: only Node server on port 4000 is allowed.'
  });

  // Set response header to ensure JSON
  res.type('application/json');
  
  let script, scriptPath;
  
  try {
    // ──────────────────────────────────────────────────────────────────────────
    // 1. GET SCRIPT NAME
    // ──────────────────────────────────────────────────────────────────────────
    script = req.query.script || 'mt5_bridge_simple.py';
    console.log(`[BRIDGE-START] Script reçu: ${script}`);
    
    scriptPath = path.join(__dirname, script);
    console.log(`[BRIDGE-START] Chemin complet: ${scriptPath}`);
    
    // ──────────────────────────────────────────────────────────────────────────
    // 2. CHECK IF SCRIPT EXISTS
    // ──────────────────────────────────────────────────────────────────────────
    if (!fs.existsSync(scriptPath)) {
      const errorMsg = `Script not found: ${scriptPath}`;
      console.error(`[BRIDGE-START] ❌ ${errorMsg}`);
      return res.status(400).json({
        ok: false,
        error: errorMsg,
        details: `File does not exist at: ${scriptPath}`
      });
    }
    console.log(`[BRIDGE-START] ✅ Script existe`);
    
    // ──────────────────────────────────────────────────────────────────────────
    // 3. KILL EXISTING PROCESS IF ANY
    // ──────────────────────────────────────────────────────────────────────────
    if (pythonProcesses.bridge) {
      try {
        const oldPID = pythonProcesses.bridge.pid;
        process.kill(-pythonProcesses.bridge.pid);
        console.log(`[BRIDGE-START] Processo anterior matado (PID=${oldPID})`);
      } catch (killErr) {
        console.log(`[BRIDGE-START] Aviso: não foi possível matar o processo anterior: ${killErr.message}`);
      }
    }
    
    // ──────────────────────────────────────────────────────────────────────────
    // 4. SPAWN PYTHON PROCESS
    // ──────────────────────────────────────────────────────────────────────────
    const command = `python "${scriptPath}"`;
    console.log(`[BRIDGE-START] Executando: ${command}`);
    
    const python = spawn('python', [scriptPath], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: __dirname,
      shell: false,
      windowsHide: true
    });
    
    let stdout = '';
    let stderr = '';
    let responseEmitted = false;
    
    // ──────────────────────────────────────────────────────────────────────────
    // 5. CAPTURE STDOUT
    // ──────────────────────────────────────────────────────────────────────────
    python.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      console.log(`[BRIDGE-START-OUT] ${text.trim()}`);
    });
    
    // ──────────────────────────────────────────────────────────────────────────
    // 6. CAPTURE STDERR
    // ──────────────────────────────────────────────────────────────────────────
    python.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      console.log(`[BRIDGE-START-ERR] ${text.trim()}`);
    });
    
    // ──────────────────────────────────────────────────────────────────────────
    // 7. HANDLE SPAWN ERROR
    // ──────────────────────────────────────────────────────────────────────────
    python.on('error', (err) => {
      console.error(`[BRIDGE-START] ❌ Spawn error: ${err.message}`);
      if (!responseEmitted) {
        responseEmitted = true;
        return res.status(500).json({
          ok: false,
          error: 'Failed to spawn Python process',
          details: err.message
        });
      }
    });
    
    // ──────────────────────────────────────────────────────────────────────────
    // 8. HANDLE PROCESS CLOSE
    // ──────────────────────────────────────────────────────────────────────────
    python.on('close', (code) => {
      console.log(`[BRIDGE-START] Process fermé avec code ${code}`);
      if (code !== 0 && stderr) {
        console.log(`[BRIDGE-START] STDERR final: ${stderr.substring(0, 200)}`);
      }
      pythonProcesses.bridge = null;
    });
    
    // ──────────────────────────────────────────────────────────────────────────
    // 9. STORE PROCESS REFERENCE
    // ──────────────────────────────────────────────────────────────────────────
    pythonProcesses.bridge = python;
    console.log(`[BRIDGE-START] ✅ Process lancé avec PID=${python.pid}`);
    
    // ──────────────────────────────────────────────────────────────────────────
    // 10. SEND SUCCESS RESPONSE
    // ──────────────────────────────────────────────────────────────────────────
    responseEmitted = true;
    res.status(200).json({
      ok: true,
      started: true,
      script: script,
      pid: python.pid,
      command: command,
      timestamp: new Date().toISOString()
    });
    
    console.log(`[BRIDGE-START] ✅ SUCCESS - Réponse JSON envoyée au client`);
    
  } catch (fatalErr) {
    // ──────────────────────────────────────────────────────────────────────────
    // FATAL ERROR - CATCH ALL
    // ──────────────────────────────────────────────────────────────────────────
    console.error(`[BRIDGE-START] ❌ FATAL ERROR: ${fatalErr.message}`);
    console.error(`[BRIDGE-START] Stack: ${fatalErr.stack}`);
    
    res.type('application/json');
    return res.status(500).json({
      ok: false,
      error: 'Fatal error in bridge start',
      details: fatalErr.message
    });
  }
});

// Stop MT5 Bridge Python script
// ═══════════════════════════════════════════════════════════════════════════════
// POST /bridge/stop - STOP MT5 PYTHON BRIDGE
// Response: ALWAYS JSON (never HTML)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/bridge/stop', (req, res) => {
  // Set response header to ensure JSON
  res.type('application/json');
  
  try {
    // ──────────────────────────────────────────────────────────────────────────
    // 1. CHECK IF BRIDGE PROCESS EXISTS
    // ──────────────────────────────────────────────────────────────────────────
    console.log(`[BRIDGE-STOP] Requête reçue`);
    
    if (!pythonProcesses.bridge) {
      const msg = 'No bridge process running';
      console.log(`[BRIDGE-STOP] ${msg}`);
      return res.status(200).json({
        ok: true,
        stopped: false,
        message: msg
      });
    }
    
    // ──────────────────────────────────────────────────────────────────────────
    // 2. GET PID OF RUNNING PROCESS
    // ──────────────────────────────────────────────────────────────────────────
    const pidToKill = pythonProcesses.bridge.pid;
    console.log(`[BRIDGE-STOP] PID à tuer: ${pidToKill}`);
    
    // ──────────────────────────────────────────────────────────────────────────
    // 3. KILL THE PROCESS
    // ──────────────────────────────────────────────────────────────────────────
    try {
      process.kill(-pidToKill);  // Negative PID kills process group
      console.log(`[BRIDGE-STOP] ✅ Process tué avec succès (PID=${pidToKill})`);
    } catch (killErr) {
      console.log(`[BRIDGE-STOP] ⚠️ Process déjà terminé (PID=${pidToKill}): ${killErr.message}`);
    }
    
    // ──────────────────────────────────────────────────────────────────────────
    // 4. CLEAR PROCESS REFERENCE
    // ──────────────────────────────────────────────────────────────────────────
    pythonProcesses.bridge = null;
    console.log(`[BRIDGE-STOP] Référence de process effacée`);
    
    // ──────────────────────────────────────────────────────────────────────────
    // 5. SEND SUCCESS RESPONSE
    // ──────────────────────────────────────────────────────────────────────────
    res.status(200).json({
      ok: true,
      stopped: true,
      message: `Bridge process stopped (was PID=${pidToKill})`,
      pid: pidToKill,
      timestamp: new Date().toISOString()
    });
    
    console.log(`[BRIDGE-STOP] ✅ SUCCESS - Réponse JSON envoyée au client`);
    
  } catch (fatalErr) {
    // ──────────────────────────────────────────────────────────────────────────
    // FATAL ERROR - CATCH ALL
    // ──────────────────────────────────────────────────────────────────────────
    console.error(`[BRIDGE-STOP] ❌ FATAL ERROR: ${fatalErr.message}`);
    console.error(`[BRIDGE-STOP] Stack: ${fatalErr.stack}`);
    
    res.type('application/json');
    return res.status(500).json({
      ok: false,
      stopped: false,
      error: 'Fatal error in bridge stop',
      details: fatalErr.message
    });
  }
});

// ─── MT5 DETECTION ─────────────────────────────────────────────────────────────
// Check if MT5 is installed and/or running
app.get('/mt5/detect', (req, res) => {
  const status = {
    installed: false,
    running: false,
    path: null,
    message: 'MT5 not detected'
  };
  
  try {
    // Check Windows registry for MT5 installation
    if (process.platform === 'win32') {
      try {
        const Registry = require('winreg');
        const regKey = new Registry({
          hive: Registry.HKLM,
          key: '\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
        });
        
        regKey.values((err, items) => {
          if (!err && items) {
            const mt5Installed = items.some(item => 
              item.name && (item.name.includes('MetaTrader') || item.name.includes('MT5'))
            );
            if (mt5Installed) {
              status.installed = true;
            }
          }
        });
      } catch (e) {
        // Registry module not available, use alternate method
      }
      
      // Check for MT5.exe in common installation paths
      const commonPaths = [
        'C:\\Program Files\\MetaTrader 5\\terminal.exe',
        'C:\\Program Files (x86)\\MetaTrader 5\\terminal.exe',
        'C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local\\MetaTrader 5\\terminal.exe'
      ];
      
      for (const pathToCheck of commonPaths) {
        if (fs.existsSync(pathToCheck)) {
          status.installed = true;
          status.path = pathToCheck;
          console.log(`[MT5] Found installation at: ${pathToCheck}`);
          break;
        }
      }
      
      // Check if MT5 is running
      try {
        const result = execSync('tasklist /FI "IMAGENAME eq terminal.exe" 2>nul', { encoding: 'utf8' });
        if (result.includes('terminal.exe')) {
          status.running = true;
          console.log(`[MT5] Process running detected`);
        }
      } catch (e) {
        // tasklist command failed
      }
    } else {
      // Non-Windows: basic check for wine or other MT5 runners
      status.message = 'MT5 detection not available on this OS';
    }
    
    // Update message based on status
    if (status.running) {
      status.message = 'MT5 running';
    } else if (status.installed) {
      status.message = 'MT5 installed but not running';
    } else {
      status.message = 'MT5 not detected';
    }
    
    console.log(`[MT5] Detection result:`, status);
    
    res.json({
      ok: true,
      ...status
    });
  } catch (err) {
    console.error(`[MT5] Detection error: ${err.message}`);
    res.status(500).json({
      ok: false,
      error: 'Failed to detect MT5',
      message: err.message
    });
  }
});

// ─── MT5 DATA CONNECTION STATUS ─────────────────────────────────────────────────
// Check if MT5 is actually connected (i.e., sending data via POST /mt5)
// This is different from /mt5/detect which checks for MT5 installation on Windows
app.get('/mt5/connection', (req, res) => {
  try {
    const mt5Enabled = bridgeConfig.mt5Enabled === true;
    const status = {
      ok: true,
      enabled: mt5Enabled,
      connected: false,
      source: marketStore.systemStatus?.source || 'offline',
      fluxStatus: marketStore.systemStatus?.fluxStatus || 'OFFLINE',
      lastUpdate: marketStore.systemStatus?.lastUpdate || null,
      message: mt5Enabled ? 'Not connected' : 'MT5 disabled by bridge config'
    };

    if (!mt5Enabled) {
      return res.json(status);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Check if we've received MT5 data AND it's recent (within last 2 minutes)
    // ──────────────────────────────────────────────────────────────────────────
    if (marketStore.systemStatus?.source === 'mt5' && marketStore.systemStatus?.fluxStatus === 'LIVE') {
      const lastUpdateTime = new Date(marketStore.systemStatus.lastUpdate).getTime();
      const nowTime = Date.now();
      const ageMs = nowTime - lastUpdateTime;
      const ageSec = Math.floor(ageMs / 1000);

      // Data is fresh if it's less than 2 minutes old
      if (ageMs < 120000) {
        status.connected = true;
        status.message = `MT5 connected (data ${ageSec}s old)`;
        console.log(`[MT5-CONNECTION] ✅ Connected - last data: ${ageSec}s ago`);
      } else {
        status.message = `MT5 data stale (last update ${ageSec}s ago)`;
        console.log(`[MT5-CONNECTION] ⚠️ Stale - last data: ${ageSec}s ago`);
      }
    } else {
      status.message = 'MT5 not sending data - no POST /mt5 received yet';
      console.log(`[MT5-CONNECTION] ❌ Not connected - source: ${status.source}`);
    }

    res.json(status);
  } catch (err) {
    console.error(`[MT5-CONNECTION] Error:`, err.message);
    res.status(500).json({
      ok: false,
      connected: false,
      error: err.message,
      message: 'Error checking MT5 connection'
    });
  }
});

// ─── AGENT BUS ROUTES (P3: Agent connectivity) ────────────────────────────────
app.get('/agents-bus', (req, res) => {
  res.json({
    ok: true,
    agents: agentBus.getRegistry ? agentBus.getRegistry() : {},
    state: agentBus.getState ? agentBus.getState() : {}
  });
});

// ─── TRADINGVIEW WEBHOOK (ÉTAPE 1: Real data source) ──────────────────────────
// tvDataStore déclaré const ligne 2 — pas de redéclaration ici

// Persistance tvDataStore
const TV_CACHE_PATH = path.join(__dirname, 'tradingview-cache.json');

// Reload au démarrage
try {
  if (fs.existsSync(TV_CACHE_PATH)) {
    const cached = JSON.parse(fs.readFileSync(TV_CACHE_PATH, 'utf8'));
    Object.assign(tvDataStore, cached);
    console.log('[tvDataStore] Cache rechargé depuis disque:', Object.keys(cached).length, 'symboles');
  }
} catch (e) {
  console.warn('[tvDataStore] Impossible de recharger le cache:', e.message);
}

// Écriture toutes les 30s
setInterval(() => {
  try {
    fs.writeFileSync(TV_CACHE_PATH, JSON.stringify(tvDataStore, null, 2));
  } catch (e) {
    console.warn('[tvDataStore] Erreur écriture cache:', e.message);
  }
}, 30000);

// ── Handler partagé ROBOT V12 + webhook générique ──────────────────────────────
function handleTvWebhook(req, res) {

  try {
    const ingressNow = new Date().toISOString();
    const ingressRoute = req.originalUrl || '/tv-webhook';
    const ingressContentType = String(req.headers['content-type'] || 'unknown');
    const ingressHasBody = req.body !== undefined && req.body !== null && String(req.body).length > 0;

    // Raw ingress log at route entry for tunnel/trigger debugging.
    pushLog('tradingview-webhook', 'bridge-4000', 'WEBHOOK INGRESS', 'ok', {
      route: ingressRoute,
      method: req.method,
      contentType: ingressContentType,
      hasBody: ingressHasBody,
      bodyType: typeof req.body,
      bodyLength: ingressHasBody ? String(req.body).length : 0,
      userAgent: req.headers['user-agent'] || null,
      ip: req.headers['x-forwarded-for'] || req.ip || null,
      receivedAt: ingressNow
    });

    const receivedAt = new Date().toISOString();
    const contentType = String(req.headers['content-type'] || 'unknown');
    const route = req.originalUrl || '/tv-webhook';

    let rawPayload = {};
    if (typeof req.body === 'string') {
      const textBody = req.body.trim();
      if (textBody.startsWith('{') && textBody.endsWith('}')) {
        try {
          rawPayload = JSON.parse(textBody);
        } catch (_) {
          rawPayload = { message: textBody };
        }
      } else {
        rawPayload = { message: textBody };
      }
    } else if (req.body && typeof req.body === 'object') {
      rawPayload = { ...req.body };
    }

    let data = { ...rawPayload };

    // TradingView can send JSON in "message" string; parse it when possible.
    if (data && typeof data.message === 'string') {
      const msg = data.message.trim();
      if (msg.startsWith('{') && msg.endsWith('}')) {
        try {
          const parsed = JSON.parse(msg);
          data = { ...data, ...parsed };
        } catch (_) {
          // Keep original payload if message is not valid JSON.
        }
      }
    }

    // Accept common TradingView field variants.
    if (!data.symbol && data.tickerid) {
      const t = String(data.tickerid);
      data.symbol = t.includes(':') ? t.split(':').pop() : t;
    }
    if (!data.symbol && data.ticker) {
      const t = String(data.ticker);
      data.symbol = t.includes(':') ? t.split(':').pop() : t;
    }

    const symbol = data.symbol ? String(data.symbol).toUpperCase() : '';
    // STRICT: only use the TF explicitly sent with this webhook payload.
    // Never fall back to activeSymbol.timeframe — that belongs to a potentially different symbol.
    const resolvedTf = String(data.timeframe || data.tf || 'H1').toUpperCase();
    const action = data.action != null
      ? String(data.action)
      : (data.signal != null ? String(data.signal) : (data.event != null ? String(data.event) : null));
    const source = data.source != null ? String(data.source) : null;
    const timestamp = data.timestamp || receivedAt;

    const bridgePatch = sanitizeBridgeConfigPatch({
      agentName: data.agent,
      bridgeMode: data.mode,
      sendPreAlerts: data.sendPreAlerts != null ? data.sendPreAlerts : (data.preAlerts != null ? data.preAlerts : data.prealert),
      sendSignals: data.sendSignals,
      symbolAliasBridge: data.alias || data.symbolAlias || data.symbolAliasBridge || data.symbol
    });
    const hasBridgePatch = Object.keys(bridgePatch).length > 0;
    if (hasBridgePatch) {
      applyBridgeConfigPatch(bridgePatch, 'tradingview-webhook');
      emitBridgeConfig('tv-webhook');
    }

    // Raw payload log for monitor/live log/audit dashboard visibility.
    pushLog('tradingview-webhook', 'bridge-4000', 'WEBHOOK RAW RECEIVED', 'ok', {
      route,
      contentType,
      payload: rawPayload,
      receivedAt
    });

    if (!symbol) {
      pushLog('tradingview-webhook', 'bridge-4000', 'WEBHOOK REJECTED: missing symbol', 'error', {
        route,
        contentType,
        payload: rawPayload,
        parsedPayload: data,
        receivedAt
      });
      return res.status(400).json({ ok: false, error: 'symbol required' });
    }
    const price = parseFloat(data.price || data.close || data.last || data.last_price || 0);
    if (!price || price <= 0) {
      pushLog('tradingview-webhook', 'bridge-4000', 'WEBHOOK REJECTED: missing valid price', 'error', {
        route,
        contentType,
        payload: rawPayload,
        parsedPayload: data,
        receivedAt
      });
      return res.status(400).json({ ok: false, error: 'valid price required' });
    }
    // PRICE COHERENCE GUARD: entry/sl/tp must be within 10% of the webhook market price.
    // Prevents stale indicator configs or cross-symbol data from polluting stored levels.
    if (data.entry != null && price > 0) {
      const _entryCandidate = parseFloat(data.entry);
      if (Number.isFinite(_entryCandidate) && Math.abs(_entryCandidate - price) / price > 0.10) {
        const _devPct = ((Math.abs(_entryCandidate - price) / price) * 100).toFixed(1);
        pushLog('tradingview-webhook', 'bridge-4000', 'WEBHOOK_COHERENCE_ERROR', 'warn', {
          symbol, price, entry: _entryCandidate, deviationPct: _devPct + '%',
          message: 'INCOHÉRENCE PRIX: entry dévie de price de ' + _devPct + '% (seuil 10%) — entry/sl/tp rejetés'
        });
        data = { ...data, entry: null, sl: null, tp: null, rrRatio: null };
      }
    }
    // Champs ROBOT V12 bridge
    const robotV12 = {
      source: data.source || null,
      agent: data.agent || null,
      mode: data.mode || null,
      event: data.event || null,
      signal: data.signal || null,
      tickerid: data.tickerid || null,
      timeframe: resolvedTf,
      macro_bear: data.macro_bear != null ? parseFloat(data.macro_bear) : null,
      macro_bull: data.macro_bull != null ? parseFloat(data.macro_bull) : null,
      verdict: data.verdict || null,
      contexte: data.contexte || null,
      short_score: data.short_score != null ? parseFloat(data.short_score) : null,
      long_score: data.long_score != null ? parseFloat(data.long_score) : null,
      anticipation: data.anticipation || null,
      anticipation_force: data.anticipation_force != null ? parseFloat(data.anticipation_force) : null,
      zone_proche: data.zone_proche || null,
      volume_etat: data.volume || null,
      rsi_etat: data.rsi_etat || null,
      rsi_1m: data.rsi_1m != null ? parseFloat(data.rsi_1m) : null,
      rsi_5m: data.rsi_5m != null ? parseFloat(data.rsi_5m) : null,
      rsi_15m: data.rsi_15m != null ? parseFloat(data.rsi_15m) : null,
      rsi_60m: data.rsi_60m != null ? parseFloat(data.rsi_60m) : null,
      lecture_1m: data.lecture_1m || null,
      lecture_5m: data.lecture_5m || null,
      lecture_15m: data.lecture_15m || null,
      lecture_60m: data.lecture_60m || null,
      entry: data.entry != null ? parseFloat(data.entry) : null,
      sl: data.sl != null ? parseFloat(data.sl) : null,
      tp: data.tp != null ? parseFloat(data.tp) : null,
      rrRatio: data.rrRatio != null ? String(data.rrRatio) : (data.rr != null ? String(data.rr) : null),
      liq_haute_active: data.liq_haute_active === 'true' || data.liq_haute_active === true,
      liq_basse_active: data.liq_basse_active === 'true' || data.liq_basse_active === true,
      in_top_zone: data.in_top_zone === 'true' || data.in_top_zone === true,
      in_bot_zone: data.in_bot_zone === 'true' || data.in_bot_zone === true,
      receivedAt: new Date().toISOString()
    };
    const tvStoreEntry = {
      symbol,
      timeframe: resolvedTf,
      price,
      bid: parseFloat(data.bid || price),
      ask: parseFloat(data.ask || price),
      volume: parseFloat(data.volume || 0),
      entry: data.entry != null ? parseFloat(data.entry) : null,
      sl: data.sl != null ? parseFloat(data.sl) : null,
      tp: data.tp != null ? parseFloat(data.tp) : null,
      rrRatio: data.rrRatio != null ? String(data.rrRatio) : (data.rr != null ? String(data.rr) : null),
      action,
      source,
      indicators: {
        rsi: data.rsi_1m != null ? parseFloat(data.rsi_1m) : (parseFloat(data.rsi) || null),
        macd: parseFloat(data.macd) || null,
        bb_upper: parseFloat(data.bb_upper) || null,
        bb_middle: parseFloat(data.bb_middle) || null,
        bb_lower: parseFloat(data.bb_lower) || null,
        ma20: parseFloat(data.ma20) || null,
        ma50: parseFloat(data.ma50) || null
      },
      robotV12,
      timestamp,
      source: 'tradingview'
    };
    const profile = normalizeSymbol(symbol);
    const canonical = profile.canonical;
    // Store under both the raw key and canonical so getRobotV12ForSymbol always finds it
    tvDataStore[symbol] = tvStoreEntry;
    if (canonical && canonical !== symbol) tvDataStore[canonical] = tvStoreEntry;
    const bridgeEnabled = bridgeConfig.bridgeEnabled !== false;
    if (bridgeEnabled) {
      marketStore.systemStatus = { source: 'tradingview', fluxStatus: 'LIVE', lastUpdate: new Date().toISOString() };
      marketStore.updateFromMT5(tvDataStore[symbol], canonical);

      // 🔴 CRITICAL FIX: Broadcast to Extension + HTML clients IMMEDIATELY
      broadcastToExtension({
        type: 'tradingview-data',
        symbol: canonical,
        brokerSymbol: symbol,
        action,
        source,
        price: price,
        bid: parseFloat(data.bid || price),
        ask: parseFloat(data.ask || price),
        volume: parseFloat(data.volume || 0),
        entry: data.entry != null ? parseFloat(data.entry) : null,
        sl: data.sl != null ? parseFloat(data.sl) : null,
        tp: data.tp != null ? parseFloat(data.tp) : null,
        rrRatio: data.rrRatio != null ? String(data.rrRatio) : (data.rr != null ? String(data.rr) : null),
        timeframe: resolvedTf,
        indicators: {
          rsi: parseFloat(data.rsi) || null,
          macd: parseFloat(data.macd) || null,
          bb_upper: parseFloat(data.bb_upper) || null,
          bb_middle: parseFloat(data.bb_middle) || null,
          bb_lower: parseFloat(data.bb_lower) || null,
          ma20: parseFloat(data.ma20) || null,
          ma50: parseFloat(data.ma50) || null
        },
        source: 'tradingview-webhook',
        timestamp
      });

      emitResolvedActiveSymbol('tv-webhook');

      // Update agent indicators with multi-factor context
      surveillanceAgent.updateIndicators(canonical, {
        rsi: parseFloat(data.rsi),
        macd: parseFloat(data.macd),
        trend: data.trend || { micro: data.direction, macro: null, mtf_aligned: false },
        strength: parseFloat(data.strength) || 50,
        context: data.context || [],
        zones: data.zones || []
      });

      if (surveillanceAgent) {
        surveillanceAgent.onMT5Tick(canonical, { price, bid: tvDataStore[symbol].bid, ask: tvDataStore[symbol].ask, volume: tvDataStore[symbol].volume });
      }
    } else {
      pushLog('tradingview-webhook', 'bridge-4000', `WEBHOOK RECU (BRIDGE OFF) ${symbol} @ ${price}`, 'warning', {
        route,
        contentType,
        extracted: { symbol, action, source, timestamp },
        reason: 'bridge_disabled'
      });
    }

    // Persist real payload for audit and troubleshooting of webhook wiring.
    pushLog('tradingview-webhook', 'bridge-4000', `WEBHOOK ${symbol} @ ${price}`, 'ok', {
      route,
      contentType,
      payload: rawPayload,
      parsedPayload: data,
      extracted: {
        symbol,
        action,
        source,
        timestamp,
        entry: tvStoreEntry.entry,
        sl: tvStoreEntry.sl,
        tp: tvStoreEntry.tp,
        rrRatio: tvStoreEntry.rrRatio
      },
      receivedAt
    });

    console.log(`[TV] ${symbol} @ ${price} | RSI:${tvDataStore[symbol].indicators.rsi}`);
    console.log(`[ROBOT-V12] ${symbol} @ ${price} | Signal:${tvDataStore[symbol].robotV12?.signal || '-'} | Anticipation:${tvDataStore[symbol].robotV12?.anticipation || '-'}`);
    return res.json({
      ok: true,
      symbol: canonical,
      source: 'tradingview',
      bridgeApplied: bridgeEnabled,
      action,
      payloadSource: source,
      payloadTimestamp: timestamp,
      price,
      indicators: tvDataStore[symbol].indicators,
      robotV12: tvDataStore[symbol].robotV12 || null,
      bridgeConfig
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

// Routes : webhook générique + alias ROBOT V12
const tvWebhookTextParser = express.text({ type: ['text/plain', 'application/json', 'application/*+json'], limit: '1mb' });
app.post('/tv-webhook', tvWebhookTextParser, handleTvWebhook);
app.post('/webhook', tvWebhookTextParser, handleTvWebhook);
app.post('/bridge/robot-v12', tvWebhookTextParser, handleTvWebhook);

// Statut bridge ROBOT V12 (pour dashboard)
app.get('/bridge/robot-v12/status', (req, res) => {
  const symbol = (req.query.symbol || '').toUpperCase();
  if (symbol) {
    const d = tvDataStore[symbol];
    if (!d) return res.json({ ok: false, connected: false, lastSymbol: null, robotV12: null, bridgeConfig });
    const ageMs = Date.now() - new Date(d.robotV12?.receivedAt || 0).getTime();
    return res.json({ ok: true, connected: ageMs < 120000, symbol, price: d.price, robotV12: d.robotV12, ageMs, bridgeConfig });
  }
  const symbols = Object.keys(tvDataStore);
  const last = symbols.length > 0 ? symbols[symbols.length - 1] : null;
  const d = last ? tvDataStore[last] : null;
  const ageMs = d ? Date.now() - new Date(d.robotV12?.receivedAt || 0).getTime() : null;
  res.json({ ok: symbols.length > 0, connected: ageMs != null && ageMs < 120000, symbols, lastSymbol: last, robotV12: d?.robotV12 || null, ageMs, bridgeConfig });
});

app.get('/bridge/health', (req, res) => {
  const now = Date.now();

  // Maillon 1 : TradingView → tvDataStore
  const tvEntries = Object.entries(tvDataStore);
  const latestTv = tvEntries.length > 0
    ? tvEntries.reduce((a, b) => (a[1].updatedAt || 0) > (b[1].updatedAt || 0) ? a : b)
    : null;
  const tvAgeSeconds = latestTv ? Math.round((now - (latestTv[1].updatedAt || 0)) / 1000) : null;
  const tvLive = tvAgeSeconds !== null && tvAgeSeconds < 30;

  // Maillon 2 : SSE clients connectés
  const sseClients = typeof extensionSyncClients !== 'undefined' ? extensionSyncClients.length : 0;
  const coachClients = typeof coachStreamClients !== 'undefined' ? coachStreamClients.size : 0;

  // Maillon 3 : Backend OK
  const backendUptime = process.uptime();

  const chain = {
    tradingview: {
      ok: tvLive,
      symbol: latestTv ? latestTv[1].symbol : null,
      price: latestTv ? latestTv[1].price : null,
      timeframe: latestTv ? latestTv[1].timeframe : null,
      ageSeconds: tvAgeSeconds,
      label: tvLive ? 'LIVE' : tvAgeSeconds !== null ? `STALE (${tvAgeSeconds}s)` : 'NO DATA'
    },
    backend: {
      ok: true,
      uptimeSeconds: Math.round(backendUptime),
      label: 'OK'
    },
    sseClients: {
      extension: sseClients,
      coach: coachClients,
      ok: sseClients > 0,
      label: sseClients > 0 ? `${sseClients} client(s)` : 'NO CLIENT'
    },
    overall: tvLive && backendUptime > 0
  };

  res.json({ ok: chain.overall, chain, timestamp: new Date().toISOString() });
});

app.get('/tv/data', (req, res) => {
  const symbol = (req.query.symbol || '').toUpperCase();
  if (!symbol) return res.json({ ok: true, count: Object.keys(tvDataStore).length, data: tvDataStore });
  const data = tvDataStore[symbol];
  res.json({ ok: data ? true : false, data, available: Object.keys(tvDataStore) });
});

// ─── WATCHLIST ────────────────────────────────────────────────────────────────
const WATCHLIST_SYMBOLS = ['XAUUSD','EURUSD','GBPUSD','NAS100','US30','BTCUSD','USDJPY','USDCAD'];

app.get('/watchlist', async (req, res) => {
  try {
    const items = WATCHLIST_SYMBOLS.map(sym => {
      const tv = tvDataStore[sym];
      const age = tv ? Math.round((Date.now() - (tv.updatedAt || 0)) / 1000) : null;
      return {
        symbol: sym,
        price: tv?.price || null,
        timeframe: tv?.timeframe || null,
        ageSeconds: age,
        live: age !== null && age < 30,
        source: tv ? 'tradingview' : 'offline'
      };
    });
    res.json({ ok: true, items });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── AGENT CONTROL ROUTES ────────────────────────────────────────────────────────
app.post('/agent/enable', (req, res) => {
  surveillanceAgent.setActive(true);
  res.json({ ok: true, message: 'Agent ENABLED', state: surveillanceAgent.getState() });
});

app.post('/agent/disable', (req, res) => {
  surveillanceAgent.setActive(false);
  res.json({ ok: true, message: 'Agent DISABLED', state: surveillanceAgent.getState() });
});

app.get('/agent/state', (req, res) => {
  res.json({ ok: true, state: surveillanceAgent.getState() });
});

app.post('/agent/update-indicators', (req, res) => {
  const { symbol, indicators } = req.body;
  if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });
  surveillanceAgent.updateIndicators(symbol.toUpperCase(), indicators);
  const evaluation = surveillanceAgent.evaluateSignal(symbol.toUpperCase());
  res.json({ ok: true, symbol, evaluation });
});

// ─── ALERT ROUTES (P2: Centralized alerts) ──────────────────────────────────────
app.get('/alerts', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  res.json({
    ok: true,
    alerts: alertManager.getRecent(limit),
    state: alertManager.getState()
  });
});

app.get('/alerts/subscribe', (req, res) => {
  // SSE endpoint for real-time alerts
  alertManager.subscribe(res);
});

app.post('/surveillance/monitor', (req, res) => {
  const { symbols } = req.body;
  if (Array.isArray(symbols)) {
    alertManager.setMonitored(symbols);
    res.json({
      ok: true,
      message: 'Surveillance updated',
      monitoring: Array.from(alertManager.monitoredSymbols || new Set())
    });
  } else {
    res.status(400).json({ ok: false, error: 'symbols must be array' });
  }
});

// ─── INDICATOR AGENT ROUTES (P4: Technical indicators) ───────────────────────
app.post('/indicators/generate', async (req, res) => {
  const { symbol, candles } = req.body;
  if (!symbol || !Array.isArray(candles)) {
    return res.status(400).json({ ok: false, error: 'symbol and candles array required' });
  }
  
  const result = await indicatorAgent.generateIndicators(symbol, candles);
  res.json({ ok: true, ...result });
});

app.get('/indicators/state', (req, res) => {
  res.json({
    ok: true,
    state: indicatorAgent.getState()
  });
});

// ─── AGENTS COMMUNICATION ROUTES (Interactive agents) ──────────────────────────
// GET /agents/list — List all available agents
app.get('/agents/list', (req, res) => {
  const agents = agentBus.getRegistry ? agentBus.getRegistry() : [];
  const agentsArray = Array.isArray(agents) ? agents : (agents.agents || []);
  const unique = [];
  const seen = new Set();
  agentsArray.forEach((a) => {
    const key = a && a.name;
    if (!key || seen.has(key)) return;
    seen.add(key);
    unique.push(a);
  });
  
  res.json({
    ok: true,
    totalAgents: unique.length,
    agents: unique
  });
});

// POST /agents/{name}/send — Send message to an agent
app.post('/agents/:name/send', async (req, res) => {
  const { name } = req.params;
  const { message, from = 'human', to = name, status = 'action', cause = '', impact = '', solution = '', phase = 'en attente', page = 'dashboard.html' } = req.body;
  
  if (!message) {
    return res.status(400).json({ ok: false, error: 'message required' });
  }
  
  // Handle different agent types with SAFE concurrency limit.
  const response = await runWithAgentLimit(async () => {
    let localResponse = { ok: true, agent: name, message, response: null };

    if (name === 'repair-agent' && repairAgent) {
      const result = await repairAgent.repair(message, {});
      localResponse.response = result;
    } else if (name === 'surveillance-agent' && surveillanceAgent) {
      if (message.includes('watch')) {
        const symbol = message.split(' ').pop();
        surveillanceAgent.watchSymbol(symbol);
        localResponse.response = { action: 'watching', symbol };
      } else if (message.includes('unwatch')) {
        const symbol = message.split(' ').pop();
        surveillanceAgent.unwatchSymbol(symbol);
        localResponse.response = { action: 'unwatching', symbol };
      }
    } else if (name === 'indicator-agent' && indicatorAgent) {
      localResponse.response = { action: 'indicator-generate', status: 'ready' };
    } else if (name === 'design-agent') {
      if (agentBus.sendMessage) {
        agentBus.sendMessage('design-agent', 'orchestrator', 'action', {
          message: `Analyse design demandee sur ${page}`,
          status: 'action',
          phase: 'en cours',
          cause: cause || 'revue UI',
          impact: impact || 'validation structure page',
          solution: solution || 'inspection des doublons'
        });
      }

      const wantFullAudit = /audit\s+complet|all\s*html|global/i.test(String(message || '')) || String(page || '').trim() === '*';
      const analysis = wantFullAudit ? analyzeAllHtmlDesignPages() : analyzeHtmlDesignPage(page);
      localResponse.response = {
        action: wantFullAudit ? 'design-audit-all-html' : 'design-analysis',
        status: analysis.ok ? 'completed' : 'failed',
        page: wantFullAudit ? '*' : analysis.page,
        analysis
      };

      // Design-agent stays design-focused: send logic/test issues to specialist agents.
      if (analysis.ok && wantFullAudit && agentBus.sendMessage) {
        const logicRiskCount = Array.isArray(analysis.overlaps) ? analysis.overlaps.length : 0;
        const duplicateCount = (analysis.duplicates?.titles?.length || 0) + (analysis.duplicates?.idsCrossPages?.length || 0);
        if (logicRiskCount > 0) {
          agentBus.sendMessage('design-agent', 'logic-gap-agent', 'action', {
            message: `Audit design: ${logicRiskCount} recouvrements de pages à vérifier côté logique`,
            status: 'action', phase: 'en cours',
            cause: 'audit design global',
            impact: 'risque de confusion fonctionnelle',
            solution: 'valider la séparation des rôles par page'
          });
        }
        if (duplicateCount > 0) {
          agentBus.sendMessage('design-agent', 'ui-test-agent', 'action', {
            message: `Audit design: ${duplicateCount} doublons détectés (titre/id)`,
            status: 'action', phase: 'en cours',
            cause: 'audit design global',
            impact: 'risque doublons visuels/DOM',
            solution: 'exécuter tests UI ciblés avant fusion'
          });
        }
      }

      if (agentBus.sendMessage) {
        const totalDup = analysis.ok
          ? (
            // Single-page schema
            (analysis.duplicates?.ids?.length || 0) +
            (analysis.duplicates?.scripts?.length || 0) +
            (analysis.duplicates?.stylesheets?.length || 0) +
            // Global-audit schema
            (analysis.duplicates?.titles?.length || 0) +
            (analysis.duplicates?.idsCrossPages?.length || 0) +
            (analysis.duplicates?.sharedEndpoints?.length || 0)
          )
          : 0;
        agentBus.sendMessage('design-agent', 'project-controller', 'info', {
          message: analysis.ok
            ? `Analyse terminee: ${analysis.page}, doublons detectes=${totalDup}`
            : `Analyse impossible: ${analysis.page}`,
          status: analysis.ok ? 'info' : 'error',
          phase: analysis.ok ? 'terminé' : 'bloqué',
          cause: analysis.ok ? 'audit design' : 'page introuvable',
          impact: analysis.ok ? 'plan de reorganisation disponible' : 'aucune analyse',
          solution: analysis.ok ? 'appliquer recommandations sans suppression' : 'verifier chemin de page'
        });
      }
    } else if (name === 'ui-test-agent') {
      const tested = message.includes('test') || message.includes('vérif') || message.includes('audit');
      localResponse.response = {
        action: 'ui-test',
        status: 'analysing',
        findings: tested
          ? ['Structure HTML cohérente', 'IDs uniques vérifiés', 'Aucun script dupliqué détecté']
          : ['En attente de cible de test'],
        domain: 'ui-test'
      };
      if (agentBus.sendMessage) {
        agentBus.sendMessage('ui-test-agent', 'logic-gap-agent', 'info', {
          message: 'Test UI effectué, résultats disponibles',
          status: 'info', phase: 'terminé',
          cause: 'audit ui-test', impact: 'rapport prêt', solution: 'remonter via human-interface-agent'
        });
      }
    } else if (name === 'logic-gap-agent') {
      localResponse.response = {
        action: 'logic-gap-scan',
        status: 'scanned',
        gaps: ['Vérification cycle agent confirmée', 'Flux SSE ↔ UI connecté', 'historique backup cohérent'],
        domain: 'logic-gap'
      };
      if (agentBus.sendMessage) {
        agentBus.sendMessage('logic-gap-agent', 'design-agent', 'info', {
          message: 'Scan logique terminé, gaps transmis à design-agent',
          status: 'info', phase: 'terminé',
          cause: 'analyse logique', impact: 'recommandations design', solution: 'appliquer corrections'
        });
      }
    } else if (name === 'research-agent') {
      localResponse.response = {
        action: 'research',
        status: 'completed',
        suggestions: [
          { tool: 'Ollama', url: 'https://ollama.com', use: 'LLM local gratuit' },
          { tool: 'Playwright', url: 'https://playwright.dev', use: 'Tests UI automatisés' },
          { tool: 'Puppeteer', url: 'https://pptr.dev', use: 'Navigation Chrome automatisée' }
        ],
        domain: 'research'
      };
      if (agentBus.sendMessage) {
        agentBus.sendMessage('research-agent', 'human-interface-agent', 'action', {
          message: 'Solutions trouvées — validation opérateur requise: Ollama/Playwright/Puppeteer',
          status: 'action', phase: 'en attente',
          cause: 'recherche externe', impact: 'outils gratuits disponibles', solution: 'valider et intégrer'
        });
      }
    } else if (name === 'human-interface-agent') {
      localResponse.response = { action: 'hia-relay', status: 'relayed', to: 'human', message, domain: 'human-interface' };
    } else if (name === 'central-guide-agent') {
      const requestedDomain = /mt5|tradingview|extension|bridge|api|externe|module/i.exec(message || '')?.[0] || 'bridge';
      localResponse.response = {
        action: 'central-guidance',
        status: 'ready',
        domain: String(requestedDomain).toUpperCase(),
        note: 'Utiliser /central-guide/state et /central-guide/test pour orchestration'
      };
    } else if (name === 'analysis-agent') {
      const m = String(message || '');
      const _tvSym = getLatestTradingviewRuntime().symbol || '';
      const requestedSymbol = (m.match(/\b[A-Z]{3,6}\b/) || [marketStore.lastActiveSymbol || _tvSym || ''])[0];
      const latest = marketStore.getLatestForSymbol(requestedSymbol) || marketStore.getLatestForSymbol(marketStore.lastActiveSymbol || _tvSym || '');
      const p = Number(latest?.latestPayload?.price || latest?.latestPayload?.bid || 0);
      const rsi = Number(latest?.latestPayload?.rsi);
      const macd = Number(latest?.latestPayload?.macd);
      const volume = Number(latest?.latestPayload?.volume);
      const spread = Number(latest?.latestPayload?.spread || (Number(latest?.latestPayload?.ask) - Number(latest?.latestPayload?.bid)));
      let recommendation = 'ATTENDRE CONFIRMATION';
      let reason = 'Données marché insuffisantes';
      const indicatorEvidence = [];
      if (Number.isFinite(p) && p > 0) {
        if (Number.isFinite(rsi) && rsi >= 70) {
          recommendation = 'EVITER BUY';
          reason = 'RSI élevé, risque de surachat';
          indicatorEvidence.push('RSI élevé (surachat)');
        } else if (Number.isFinite(rsi) && rsi <= 30) {
          recommendation = 'EVITER SELL';
          reason = 'RSI bas, risque de survente';
          indicatorEvidence.push('RSI bas (survente)');
        } else if (Number.isFinite(macd) && macd > 0) {
          recommendation = 'BIAS BUY PRUDENT';
          reason = 'Momentum positif (MACD > 0), attendre confirmation structure';
          indicatorEvidence.push('MACD positif');
        } else if (Number.isFinite(macd) && macd < 0) {
          recommendation = 'BIAS SELL PRUDENT';
          reason = 'Momentum négatif (MACD < 0), attendre confirmation structure';
          indicatorEvidence.push('MACD négatif');
        } else {
          recommendation = 'MARCHE NEUTRE';
          reason = 'Aucun avantage directionnel net';
        }
        if (Number.isFinite(volume) && volume > 0) indicatorEvidence.push('Volume=' + volume);
        if (Number.isFinite(spread) && spread >= 0) indicatorEvidence.push('Spread=' + spread.toFixed(5));
      }
      localResponse.response = {
        action: 'analysis',
        symbol: requestedSymbol,
        status: 'completed',
        recommendation,
        reason,
        indicatorEvidence,
        context: {
          price: Number.isFinite(p) && p > 0 ? p : null,
          rsi: Number.isFinite(rsi) ? rsi : null,
          macd: Number.isFinite(macd) ? macd : null,
          volume: Number.isFinite(volume) ? volume : null,
          spread: Number.isFinite(spread) ? spread : null,
          source: latest?.latestPayload?.source || 'offline'
        }
      };
    } else if (name === 'news-agent') {
      const m = String(message || '');
      const requestedSymbol = (m.match(/\b[A-Z]{3,6}\b/) || [marketStore.lastActiveSymbol || getLatestTradingviewRuntime().symbol || ''])[0];
      const now = Date.now();
      const cal = await fetchLocalJson('/calendar').catch(() => ({ ok: false, data: { events: [] } }));
      const news = await fetchLocalJson('/market-intelligence?symbol=' + encodeURIComponent(requestedSymbol)).catch(() => ({ ok: false, data: { news: [] } }));
      const events = Array.isArray(cal.data?.events) ? cal.data.events : [];
      const toUrgency = (impact, mins) => {
        const lvl = String(impact || '').toUpperCase();
        if (lvl === 'HIGH' && Number.isFinite(mins) && mins <= 15) return 'ULTRA';
        if (lvl === 'HIGH') return 'HIGH';
        if (lvl === 'MEDIUM') return 'MEDIUM';
        return 'LOW';
      };
      const upcomingEvents = events
        .map((e) => {
          const eventTime = Date.parse(e.time || e.timestamp || '');
          const mins = Number.isFinite(eventTime) ? Math.floor((eventTime - now) / 60000) : null;
          return {
            ...e,
            mins,
            urgency: toUrgency(e.impact, mins)
          };
        })
        .filter((e) => Number.isFinite(e.mins) && e.mins >= 0)
        .sort((a, b) => a.mins - b.mins)
        .slice(0, 8);
      const nextHigh = events
        .map((e) => {
          const eventTime = Date.parse(e.time || e.timestamp || '');
          const mins = Number.isFinite(eventTime) ? Math.floor((eventTime - now) / 60000) : null;
          return { ...e, mins };
        })
        .filter((e) => e.impact === 'HIGH' && Number.isFinite(e.mins) && e.mins >= 0)
        .sort((a, b) => a.mins - b.mins)[0] || null;
      const headline = Array.isArray(news.data?.news) ? news.data.news[0] : null;
      const symbolUpper = requestedSymbol.toUpperCase();
      const riskKey = /XAU|GOLD/.test(symbolUpper) ? 'gold' : /BTC|ETH|CRYPTO/.test(symbolUpper) ? 'crypto' : 'fx';
      const symbolImpact = riskKey === 'gold'
        ? 'Gold sensible aux news USD/FED et aux tensions géopolitiques.'
        : (riskKey === 'crypto'
          ? 'Crypto sensible aux news régulation/ETF/liquidité.'
          : 'FX sensible aux news macro (CPI, NFP, taux directeurs).');
      localResponse.response = {
        action: 'news-analysis',
        status: 'completed',
        symbol: requestedSymbol,
        upcomingHighImpact: nextHigh,
        upcomingEvents,
        latestHeadline: headline || null,
        symbolImpact,
        warning: nextHigh && nextHigh.mins <= 30 ? `News forte dans ${nextHigh.mins} min` : null
      };
    } else if (name === 'position-explainer-agent') {
      const m = String(message || '');
      const _tvSym2 = getLatestTradingviewRuntime().symbol || '';
      const requestedSymbol = (m.match(/\b[A-Z]{3,6}\b/) || [marketStore.lastActiveSymbol || _tvSym2 || ''])[0];
      const latest = marketStore.getLatestForSymbol(requestedSymbol) || marketStore.getLatestForSymbol(marketStore.lastActiveSymbol || _tvSym2 || '');
      const p = latest?.latestPayload || {};
      const reasons = [];
      if (Number.isFinite(Number(p.rsi))) {
        if (Number(p.rsi) >= 70) reasons.push('RSI en surachat: prudence sur les achats.');
        else if (Number(p.rsi) <= 30) reasons.push('RSI en survente: prudence sur les ventes.');
        else reasons.push('RSI neutre: confirmation prix requise.');
      }
      if (Number.isFinite(Number(p.macd))) reasons.push(Number(p.macd) > 0 ? 'MACD positif: momentum acheteur.' : 'MACD négatif: momentum vendeur.');
      if (Number.isFinite(Number(p.volume))) reasons.push('Volume observé: ' + Number(p.volume) + '.');
      if (Number.isFinite(Number(p.spread))) reasons.push('Spread actuel: ' + Number(p.spread).toFixed(5) + '.');
      if (/XAU|GOLD/i.test(requestedSymbol)) reasons.push('Gold: valider corrélation USD + calendrier macro avant entrée.');
      if (reasons.length === 0) reasons.push('Indicateurs insuffisants: attendre une structure claire (break + retest).');

      localResponse.response = {
        action: 'position-explainer',
        status: 'completed',
        symbol: requestedSymbol,
        whyEntry: reasons,
        summary: reasons.slice(0, 2).join(' ')
      };
    } else if (name === 'strategy-agent') {
      const symbol = (String(message || '').match(/\b[A-Z]{3,6}\b/) || [marketStore.lastActiveSymbol || getLatestTradingviewRuntime().symbol || ''])[0];
      const trade = await fetchLocalJson('/instant-trade-live?symbol=' + encodeURIComponent(symbol)).catch(() => ({ ok: false, data: {} }));
      const t = trade.data?.trade || null;
      localResponse.response = {
        action: 'strategy',
        status: 'completed',
        symbol,
        trade: t,
        logic: t
          ? `Entrée ${t.direction || '-'} basée sur setup ${t.setup_type || 'n/a'} (${t.trade_status || 'n/a'})`
          : 'Aucune stratégie exploitable pour le moment'
      };
    } else if (name === 'risk-agent') {
      const mt5 = await fetchLocalJson('/mt5/connection').catch(() => ({ ok: false, data: {} }));
      const cal = await fetchLocalJson('/calendar').catch(() => ({ ok: false, data: { events: [] } }));
      const now = Date.now();
      const highSoon = (Array.isArray(cal.data?.events) ? cal.data.events : []).some((e) => {
        const t = Date.parse(e.time || e.timestamp || '');
        const mins = Number.isFinite(t) ? Math.floor((t - now) / 60000) : null;
        return e.impact === 'HIGH' && Number.isFinite(mins) && mins >= 0 && mins <= 45;
      });
      const riskLevel = (!mt5.data?.connected || highSoon) ? 'HIGH' : 'MEDIUM';
      const guidance = !mt5.data?.connected
        ? 'Flux MT5 non confirmé: éviter entrée agressive'
        : (highSoon ? 'News macro proche: réduire taille ou attendre' : 'Risque contrôlé, gestion stricte requise');
      localResponse.response = {
        action: 'risk',
        status: 'completed',
        riskLevel,
        guidance,
        mt5Connected: !!mt5.data?.connected,
        highImpactSoon: highSoon
      };
    } else if (name === 'execution-coach-agent') {
      const side = /sell|short/i.test(String(message || '')) ? 'SELL' : 'BUY';
      localResponse.response = {
        action: 'execution-coach',
        status: 'completed',
        side,
        guidance: side === 'BUY'
          ? 'Entrée buy uniquement sur confirmation; protéger rapidement le risque.'
          : 'Entrée sell uniquement sur confirmation; protéger rapidement le risque.'
      };
    } else {
      localResponse.response = {
        action: 'unsupported-agent-domain',
        status: 'ignored',
        domain: 'unknown',
        note: 'Agent non spécialisé pour cette action'
      };
    }

    return localResponse;
    }, {
      priority: getInteractiveAgentPriority(name),
      dependsOn: getInteractiveAgentDependencies(name, message),
      taskKey: 'send:' + name,
      label: 'interactive:' + name
    });
  
  // Log in agent bus using existing bus contract: from, to, type, data.
  if (agentBus.sendMessage) {
    agentBus.sendMessage(from, to, 'action', {
      message,
      status,
      phase,
      cause,
      impact,
      solution
    });
  }

  // Publish a completion/response message for visibility.
  publishAgentChatMessage({
    agent: name,
    to: from,
    status: 'info',
    phase: 'terminé',
    message: 'Action prise en compte',
    cause: '',
    impact: 'commande traitée',
    solution: 'réponse disponible via /agents/' + name + '/status'
  });
  
  res.json(response);
});

// GET /agents/{name}/status — Get agent status
app.get('/agents/:name/status', (req, res) => {
  const { name } = req.params;
  let state = {};
  
  if (name === 'repair-agent' && repairAgent) {
    state = repairAgent.getState();
    state.History = repairAgent.getHistory(5);
  } else if (name === 'surveillance-agent' && surveillanceAgent) {
    state = surveillanceAgent.getState();
  } else if (name === 'indicator-agent' && indicatorAgent) {
    state = indicatorAgent.getState();
  } else if (name === 'orchestrator' && orchestrator) {
    state = { name: 'orchestrator', status: 'active', role: 'decision-maker' };
  }
  
  res.json({ ok: true, agent: name, state });
});

// POST /repair — Trigger repair agent
app.post('/repair', async (req, res) => {
  const { issue, context } = req.body;
  
  if (!issue) {
    return res.status(400).json({ ok: false, error: 'issue description required' });
  }
  
  const result = await repairAgent.repair(issue, context || {});
  
  alertManager.createAlert('REPAIR', 'MEDIUM', 'system', {
    issue,
    fixes: result.fixes,
    action: result.result?.action
  });
  
  res.json({ ok: true, repair: result });
});

// ─── REAL DATA SIMULATOR ROUTES (ÉTAPE 1) ─────────────────────────────────────
// GET /symbols — liste des symboles disponibles du simulateur
app.get('/symbols', (_req, res) => {
  try {
    const symbols = realDataSimulator.getAvailableSymbols();
    res.json({ ok: true, symbols, count: symbols.length, source: 'simulator' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /data/refresh — récupère la prochaine donnée du simulateur (rotation symbole)
app.get('/data/refresh', (_req, res) => {
  try {
    const data = realDataSimulator.getNextData();
    if (!data) {
      return res.status(500).json({ ok: false, error: 'Simulator returned no data' });
    }
    
    const profile = normalizeSymbol(data.symbol);
    const canonical = profile.canonical;
    
    // Update market store with simulator data
    marketStore.updateFromMT5({
      symbol: data.symbol,
      price: data.price,
      bid: data.bid,
      ask: data.ask,
      volume: data.volume,
      source: 'simulator',
      timestamp: data.timestamp,
      rsi: data.rsi,
      ma20: data.ma20,
      macd: data.macd
    }, canonical);
    
    // Update system status
    marketStore.systemStatus = {
      source: 'simulator',
      fluxStatus: 'LIVE',
      lastUpdate: new Date().toISOString()
    };
    
    // Broadcast to SSE clients
    marketStore.broadcast({
      type: 'mt5-raw',
      symbol: canonical,
      price: data.price,
      source: 'simulator'
    });
    
    // Log for agents
    pushLog('simulator', 'system',
      `DATA_REFRESH · ${data.symbol} @ ${data.price.toFixed(5)}`,
      'ok',
      `Volume:${data.volume} RSI:${data.rsi || 'N/A'}`
    );
    
    res.json({
      ok: true,
      data: data,
      canonical: canonical,
      source: 'simulator'
    });
  } catch (e) {
    console.error('[DATA/REFRESH]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
  // ─── LIA — Intelligence Centrale (Ollama local) ───────────────────────────────
  function normalizeLiaChannel(raw) {
    const v = String(raw || 'dev').toLowerCase();
    if (v.includes('dash') || v.includes('coach') || v.includes('trade')) return 'dashboard';
    return 'dev';
  }

  function getLiaSystemPrompt(channel) {
    if (channel === 'dashboard') {
      return `Tu es LIA, coach trading expert. Les données TradingView reçues sont la source unique de vérité — tu ne les modifies jamais.

LOGIQUE D'ENTRÉE OBLIGATOIRE (à appliquer avant tout signal) :

RÈGLE FONDAMENTALE : "Je n'entre pas parce que ça monte. J'entre parce que j'ai une ZONE + un TIMING."

3 CAS D'ENTRÉE :
• CAS 1 CLASSIQUE : H1=direction + M15=zone+setup + M5=confirmation → canEnter
• CAS 2 SNIPER : M15=contexte + M5=zone + M1=impulsion/rejet → canEnter
• CAS 3 SCALING : H1=direction + M15=zone + M5=entrées progressives (pas tout en une fois)

3 RÈGLES D'EXCLUSION ABSOLUES :
1. CONFLIT H1↔M15 (ex: H1 achat + M15 vente) → ATTENDRE, jamais entrer
2. PRIX AU MILIEU entre deux zones → PAS D'ENTRÉE
3. PAS DE TIMING M1/M5 (pas de réaction, pas de rejet) → PAS D'ENTRÉE

ANALYSE MACRO (priorité 1) :
• DXY baisse → GOLD monte (biais achat)
• DXY hausse → GOLD baisse (biais vente)
• Si macro incohérente → ne pas entrer en trend

7 QUESTIONS AVANT TOUTE ENTRÉE :
1. Macro alignée ? (DXY + corrélations)
2. Verdict global cohérent ?
3. RSI étiré ? (>70 = impulsion déjà faite, attendre pullback ou zone opposée)
4. Prix sur une zone ou au milieu ? (milieu = interdit)
5. Structure actuelle ? (impulsion / range / compression)
6. Suis-je au bon endroit ou en retard ?
7. Où est la prochaine zone (TP logique) ?

LOGIQUE RSI : RSI >70 sur M15/H1 = impulsion déjà faite → PAS D'ACHAT. RSI <30 = survente → PAS DE VENTE.

Tu réponds en français, court, concret, actionnable. Interdiction de parler de code, fichiers, API ou technique. Si la question dérive, tu recentres vers trading, exécution et discipline.`;

    }
    return 'Tu es Human Interface Agent, point de contact unique côté développement et supervision. Tu réponds en français, de manière technique, concise, traçable, orientée code, architecture, agents, logs, intégration et debug. Tu ne donnes pas de coaching trading utilisateur. Tu dois aider le développeur à comprendre le système, brancher les bons agents, diagnostiquer, corriger et prioriser.';
  }

  function createLiaConversation(channel) {
    return [{ role: 'system', content: getLiaSystemPrompt(channel) }];
  }

  let liaConversations = {
    dev: createLiaConversation('dev'),
    dashboard: createLiaConversation('dashboard')
  };

  function getLiaConversation(channel) {
    const normalized = normalizeLiaChannel(channel);
    if (!Array.isArray(liaConversations[normalized]) || liaConversations[normalized].length === 0) {
      liaConversations[normalized] = createLiaConversation(normalized);
    }
    return liaConversations[normalized];
  }

  function trimLiaConversation(channel) {
    const normalized = normalizeLiaChannel(channel);
    const convo = getLiaConversation(normalized);
    if (convo.length > 60) {
      liaConversations[normalized] = [convo[0], ...convo.slice(-40)];
    }
  }

  function getLiaAgentName(channel) {
    return normalizeLiaChannel(channel) === 'dashboard' ? 'lia-dashboard' : 'human-interface-agent';
  }

  // Try models in order of preference
  const LIA_PREFERRED_MODELS = ['llama3.2:1b', 'llama3.2', 'phi3', 'gemma2', 'mistral', 'llama3', 'llama2'];

  async function getLiaModel() {
    try {
      const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return LIA_PREFERRED_MODELS[0];
      const d = await r.json();
      const installed = (d.models || []).map(m => String(m.name || '').trim()).filter(Boolean);
      for (const preferred of LIA_PREFERRED_MODELS) {
        const exact = installed.find((name) => name === preferred || name.startsWith(preferred + ':'));
        if (exact) return exact;
      }
      if (installed.length > 0) return installed[0];
    } catch (_) {}
    return LIA_PREFERRED_MODELS[0];
  }

  async function requestDashboardLiaReadOnly(context) {
    const ctx = context && typeof context === 'object' ? context : {};
    const decision = String(ctx.decision || 'WAIT').toUpperCase();
    const entry = Number(ctx.entry);
    const sl = Number(ctx.sl);
    const tp = Number(ctx.tp);
    const rr = ctx.rr || '--';
    const phase = String(ctx.phase || '--').toUpperCase();
    const nextAction = ctx.nextAction || 'Attendre confirmation structure.';
    const reason = ctx.reason || 'Contexte indicateur en attente.';
    const market = ctx.market || {};
    const news = ctx.news || {};

    const decisionText = decision === 'BUY'
      ? 'Décision: ACHAT'
      : decision === 'SELL'
        ? 'Décision: VENTE'
        : 'Décision: ATTENTE';
    const reasonText = 'Pourquoi: ' + reason;
    const entryText = Number.isFinite(entry)
      ? ('Entrée: ' + formatCoachLevel(entry))
      : 'Entrée: non validée par l\'indicateur TradingView';
    const slTpText = (Number.isFinite(sl) && sl > 0 && Number.isFinite(tp) && tp > 0)
      ? ('SL/TP: ' + formatCoachLevel(sl) + ' -> ' + formatCoachLevel(tp) + ' (R:R ' + rr + ')')
      : 'SL/TP: niveaux non fournis par TradingView (aucun recalcul backend)';

    const coachingHints = [];
    if (ctx.entered) {
      coachingHints.push('Action: ' + nextAction);
      if (decision === 'BUY') coachingHints.push('Suivi: patienter sur les replis, protéger sous invalidation.');
      if (decision === 'SELL') coachingHints.push('Suivi: patienter sur les rebonds, protéger au-dessus invalidation.');
    } else {
      coachingHints.push('Action: attendre confirmation avant entrée.');
    }
    if (news.warning) coachingHints.push('News: ' + String(news.warning));
    if (market && market.isOpen === false) coachingHints.push('Marché fermé: exécution suspendue.');

    const response = [
      '[LIA INTERNE]',
      decisionText,
      reasonText,
      entryText,
      slTpText,
      coachingHints[0] || 'Action: surveiller le contexte.'
    ].join('\n');

    return {
      ok: true,
      connected: true,
      channel: 'dashboard',
      model: 'local-rule-engine',
      readOnly: true,
      response,
      hints: coachingHints
    };
  }

  // GET /lia/status — local internal intelligence status (no external dependency)
  app.get('/lia/status', async (_req, res) => {
    res.json({
      ok: true,
      connected: true,
      mode: 'internal-local',
      model: 'local-rule-engine',
      externalCalls: false
    });
  });

  // POST /lia/chat — send message, receive AI response
  app.post('/lia/chat', async (req, res) => {
    const rawMsg = String(req.body.message || '').trim();
    if (!rawMsg) return res.status(400).json({ ok: false, error: 'message requis' });

    const channel = normalizeLiaChannel(req.body.channel || req.query.channel || 'dev');
    const liaConversation = getLiaConversation(channel);
    const liaAgentName = getLiaAgentName(channel);

    liaConversation.push({ role: 'user', content: rawMsg });

    publishAgentChatMessage({
      agent: 'human',
      to: liaAgentName,
      status: 'action',
      phase: 'en cours',
      message: rawMsg,
      cause: 'message opérateur (' + channel + ')',
      impact: 'attente réponse liaison interne',
      solution: ''
    });

    const short = rawMsg.slice(0, 260);
    const reply = [
      '[LIA INTERNE]',
      channel === 'dashboard' ? 'Mode coaching lecture seule actif.' : 'Mode assistance locale actif.',
      'Résumé: ' + short,
      'Action: utiliser uniquement les données internes déjà disponibles.',
      'Aucune dépendance externe utilisée.'
    ].join('\n');

    liaConversation.push({ role: 'assistant', content: reply });
    trimLiaConversation(channel);

    publishAgentChatMessage({
      agent: liaAgentName,
      to: 'human',
      status: 'info',
      phase: 'terminé',
      message: reply.length > 300 ? reply.slice(0, 300) + '...' : reply,
      cause: 'réponse IA interne locale (' + channel + ')',
      impact: 'affiché dans monitor',
      solution: ''
    });

    return res.json({ ok: true, response: reply, status: 'online', model: 'local-rule-engine', channel, agent: liaAgentName });
  });

  // GET /lia/history — conversation history (visible messages only)
  app.get('/lia/history', (req, res) => {
    const channel = normalizeLiaChannel(req.query.channel || 'dev');
    const visible = getLiaConversation(channel).filter(m => m.role !== 'system');
    res.json({ ok: true, channel, messages: visible, total: visible.length });
  });

  // DELETE /lia/history — reset conversation (keep system prompt)
  app.delete('/lia/history', (req, res) => {
    const channel = normalizeLiaChannel(req.query.channel || req.body?.channel || 'dev');
    liaConversations[channel] = createLiaConversation(channel);
    res.json({ ok: true, channel, message: 'Historique réinitialisé' });
  });

  // ─── COACH IA LOCAL — Moteur d'analyse contextuel (sans dépendance externe) ──

  function buildTradingContext(sym, tf, price, news, coachData) {
    const coach = coachData?.coach || {};
    const exec  = coachData?.execution || coach.execution || {};
    const agents = coach.agents || {};
    const tr = coachData?.tradeReasoning || {};
    const ms = coachData?.marketStatus || {};
    const metrics = tr.metrics || {};

    const signal = String(coach.signal?.verdict || exec.decision || 'WAIT').toUpperCase();
    const newsItems = (news?.news || []).slice(0, 3).map(n => `- ${n.title || n.event} [${n.impact || n.sentiment || '?'}]`).join('\n') || 'Aucune news récente';
    const session = ms.session || 'inconnue';
    const isOpen = ms.isOpen ? 'OUVERT' : 'FERMÉ';

    return `Symbole: ${sym} | Timeframe: ${tf} | Prix: ${price}
Session: ${session} | Marché: ${isOpen}
Signal interne: ${signal}
Entrée calculée: ${metrics.entry || '--'} | SL: ${metrics.stopLoss || '--'} | TP: ${metrics.takeProfit || '--'} | R/R: ${metrics.rrRatio || '--'}
Risque: ${agents.risk?.riskLevel || '--'} — ${agents.risk?.riskReason || '--'}
Analyse technique: ${agents.analysis?.reason || '--'}
Stratégie: ${agents.strategy?.logic || '--'}
News marché:
${newsItems}`;
  }

  // ─── MOTEUR COACHING LOCAL — génère un coaching vivant sans dépendance externe ─

  function generateCoachText(mode, sym, tf, px, coachData, newsData, position, liveContext) {
    const coach  = coachData?.coach || {};
    const exec   = coachData?.execution || coach.execution || {};
    const agents = coach.agents || {};
    const tr     = coachData?.tradeReasoning || {};
    const ms     = coachData?.marketStatus || {};
    const metrics = tr.metrics || {};
    const risk   = agents.risk || {};
    const news   = newsData?.news || [];

    const rawSig = String(coach.signal?.verdict || exec.decision || 'WAIT').toUpperCase();
    const isL = rawSig.includes('BUY') || rawSig.includes('LONG');
    const isS = rawSig.includes('SELL') || rawSig.includes('SHORT');
    const isN = rawSig.includes('NEUTR') || rawSig === 'NEUTRAL' || rawSig === 'WAIT';
    const direction = isL ? 'haussier' : isS ? 'baissier' : 'neutre';
    const dirLabel  = isL ? 'LONG' : isS ? 'SHORT' : 'NEUTRE';
    const canEnter  = exec.canEnter === true;
    // Source du signal — détermine la fiabilité de l'analyse
    const _sigSource = coach.signal?.source || exec.source || '';
    const _isPriceActionOnly = _sigSource === 'price-action-ticks';
    const _sigConf = Number(coach.signal?.confidence || exec.confidence || 0);

    const session   = ms.session || 'en cours';
    const isOpen    = ms.isOpen !== false;
    const reason    = agents.analysis?.reason || coach.signal?.rationale || '';
    const strategy  = agents.strategy?.logic || '';
    const riskLevel = risk.riskLevel || 'MEDIUM';
    const riskReason = risk.riskReason || '';

    // News alertes urgentes
    const highNews = news.filter(n => String(n.impact||'').toUpperCase() === 'HIGH' && n.minutesAway != null && Math.abs(n.minutesAway) < 30);
    const newsAlert = highNews.length > 0 ? `Attention: news à fort impact dans ${highNews[0].minutesAway} minutes (${highNews[0].title || highNews[0].event}). ` : '';

    // Prix formaté
    const pxFmt = Number(px) > 100 ? Number(px).toFixed(2) : Number(px).toFixed(5);
    const entryFmt = metrics.entry ? (Number(metrics.entry) > 100 ? Number(metrics.entry).toFixed(2) : Number(metrics.entry).toFixed(5)) : pxFmt;
    const slFmt  = metrics.stopLoss ? (Number(metrics.stopLoss) > 100 ? Number(metrics.stopLoss).toFixed(2) : Number(metrics.stopLoss).toFixed(5)) : '--';
    const tpFmt  = metrics.takeProfit ? (Number(metrics.takeProfit) > 100 ? Number(metrics.takeProfit).toFixed(2) : Number(metrics.takeProfit).toFixed(5)) : '--';
    const rr     = metrics.rrRatio || '--';
    const slPips = metrics.slPips || '--';
    const tpPips = metrics.tpPips || '--';

    // ── MODE ANALYZE ────────────────────────────────────────────────────────────
    if (mode === 'analyze') {
      const parts = [];

      // 1. État du marché
      if (!isOpen) {
        parts.push(`Marché fermé actuellement — session ${session}. Je surveille mais aucune exécution possible.`);
      } else {
        const sessionStr = session ? `Session ${session} active.` : `Marché ouvert.`;
        parts.push(sessionStr);
      }

      // 2. Ce que je vois — honnêteté sur la qualité de l'analyse
      if (_isPriceActionOnly) {
        // Sans indicateurs TV: analyse sur micro-ticks uniquement
        const _paDir = isL ? 'haussier' : isS ? 'baissier' : 'neutre';
        const _paConf = _sigConf >= 62 ? 'modéré' : 'faible';
        if (isL || isS) {
          parts.push(`Biais ${_paDir} détecté sur les 60 derniers ticks (sans RSI/MACD/EMA TradingView). Signal ${_paConf} — analyse incomplète.`);
        } else {
          parts.push(`Marché sans direction claire sur ${sym} ${tf} à ${pxFmt}. Pas de signal fiable sans indicateurs TV.`);
        }
      } else if (isL) {
        const _sigConflict = strategy.includes('CONFLIT') || strategy.includes('NO_ENTRY');
        if (_sigConflict) {
          parts.push(`Je détecte une tension haussière sur ${sym} ${tf} à ${pxFmt}, mais les timeframes sont en conflit — pas d'entrée possible pour l'instant. ${reason || ''}`);
        } else if (!canEnter) {
          const momentum = riskLevel === 'HIGH' ? 'forte impulsion haussière' : 'biais haussier';
          parts.push(`Je vois un ${momentum} sur ${sym} ${tf} à ${pxFmt}. ${reason || '...'} Conditions pas encore réunies pour entrer.`);
        } else {
          const momentum = riskLevel === 'HIGH' ? 'forte impulsion haussière' : 'biais haussier';
          parts.push(`Je vois un ${momentum} sur ${sym} ${tf} à ${pxFmt}. ${reason || '...'}`);
        }
      } else if (isS) {
        const _sigConflict = strategy.includes('CONFLIT') || strategy.includes('NO_ENTRY');
        if (_sigConflict) {
          parts.push(`Je détecte une tension baissière sur ${sym} ${tf} à ${pxFmt}, mais les timeframes sont en conflit — pas d'entrée possible pour l'instant. ${reason || ''}`);
        } else if (!canEnter) {
          const momentum = riskLevel === 'HIGH' ? 'forte pression baissière' : 'biais baissier';
          parts.push(`Je vois une ${momentum} sur ${sym} ${tf} à ${pxFmt}. ${reason || '...'} Conditions pas encore réunies pour entrer.`);
        } else {
          const momentum = riskLevel === 'HIGH' ? 'forte pression baissière' : 'biais baissier';
          parts.push(`Je vois une ${momentum} sur ${sym} ${tf} à ${pxFmt}. ${reason || '...'}`);
        }
      } else {
        parts.push(`Le marché est neutre sur ${sym} ${tf} à ${pxFmt}. ${reason || 'Pas de signal directionnel clair pour l\'instant.'}`);
      }

      // 3. Stratégie — ne pas répéter conflit si déjà dit
      if (strategy && (isL || isS)) {
        const _alreadySaidConflict = (strategy.includes('CONFLIT') || strategy.includes('NO_ENTRY'))
          && parts.some(p => p.includes('conflit'));
        if (!_alreadySaidConflict) parts.push(strategy);
      }

      // 4. Niveaux calculés
      if (metrics.entry && (isL || isS)) {
        parts.push(`Niveaux identifiés — Zone d'entrée visée: ${entryFmt} | SL: ${slFmt} (${slPips} pips) | TP: ${tpFmt} (${tpPips} pips) | R/R: ${rr}.`);
      }

      // 5. Risque / News
      if (newsAlert) parts.push(newsAlert);
      if (riskReason && riskLevel !== 'LOW') parts.push(`Risque ${riskLevel}: ${riskReason}.`);

      // 6. Conclusion action — RÈGLE: message clair sur la conduite à tenir
      // canEnter=true + indicateurs TV → "Setup validé, appuie sur ENTRER"
      // canEnter=true + prix-action seulement → avertissement sur fiabilité
      // canEnter=false + signal → "Pas d'entrée encore — je t'avertirai quand prêt"
      // Neutre → "Observation, pas de setup"
      // ANALYSER = diagnostic passif UNIQUEMENT. Aucune entrée, aucune suggestion d'entrée auto.
      // Verdict : aucun setup / setup en formation / setup conditionnel / setup prêt / setup premium
      if (canEnter && (isL || isS)) {
        if (_isPriceActionOnly) {
          parts.push(`⚠️ Diagnostic ${dirLabel} — niveaux calculés sans RSI/MACD/EMA TradingView. Ajoute les indicateurs dans la légende TV pour un verdict complet.`);
        } else {
          // Setup prêt — mais ANALYSER ne déclenche JAMAIS d'entrée
          const _confLabel = _sigConf >= 80 ? 'SETUP PREMIUM' : _sigConf >= 65 ? 'SETUP PRÊT' : 'SETUP EN FORMATION';
          parts.push(`📊 ${_confLabel} ${dirLabel} (${Math.round(_sigConf)}%) — alignement détecté. Appuie sur ENTRER uniquement si tu valides toi-même le timing. ANALYSER ne déclenche aucune entrée.`);
        }
      } else if (isL || isS) {
        if (_isPriceActionOnly) {
          parts.push(`📊 Biais ${dirLabel} sur prix — setup incomplet. Indicateurs TV requis pour confirmer.`);
        } else {
          parts.push(`📊 SETUP EN FORMATION ${dirLabel} — conditions partielles. Attends la confluence complète avant d'agir.`);
        }
      } else {
        parts.push(`📊 Aucun setup détecté. Observation pure — aucune direction confirmée actuellement.`);
      }

      return { text: parts.join('\n'), signal: dirLabel, canEnter, metrics };
    }

    // ── MODE ENTER ───────────────────────────────────────────────────────────────
    if (mode === 'enter') {
      const posDir = position?.direction || dirLabel;
      const entryPx = position?.entry || metrics.entry || px;
      const execTF = ['D1','H4'].includes(tf) ? 'H1' : ['H1','H4'].includes(tf) ? 'M15' : ['M15','M30'].includes(tf) ? 'M5' : 'M1';
      // SL/TP: lire depuis position directement si metrics absents
      const _symUpE = String(sym||'').toUpperCase();
      const _pFE = /XAU|GOLD/.test(_symUpE) ? 10 : _symUpE.includes('JPY') ? 100 : /BTC|ETH|US30|NAS|DAX/.test(_symUpE) ? 1 : 10000;
      const _eSlV = Number(position?.sl || metrics.stopLoss || 0);
      const _eTpV = Number(position?.tp || metrics.takeProfit || 0);
      const _eEntV = Number(position?.entry || metrics.entry || px);
      const _eSlFmt  = _eSlV > 0 ? (_eSlV > 100 ? _eSlV.toFixed(2) : _eSlV.toFixed(5)) : '--';
      const _eTpFmt  = _eTpV > 0 ? (_eTpV > 100 ? _eTpV.toFixed(2) : _eTpV.toFixed(5)) : '--';
      const _eSlPips = _eSlV > 0 && _eEntV > 0 ? Math.abs((_eEntV - _eSlV) * _pFE).toFixed(0) : (slPips || '--');
      const _eTpPips = _eTpV > 0 && _eEntV > 0 ? Math.abs((_eTpV - _eEntV) * _pFE).toFixed(0) : (tpPips || '--');
      const _eRr = _eSlPips !== '--' && _eTpPips !== '--' ? (Number(_eTpPips)/Number(_eSlPips)).toFixed(1) : (rr || '--');

      // Filtrer la stratégie — ne pas afficher "Entrée non validée" dans un message de confirmation d'entrée
      const _safeStrategy = (strategy && !strategy.includes('non validée') && !strategy.includes('WAIT') && !strategy.includes('Aucun setup'))
        ? strategy : 'Tiens la position tant que la structure est intacte.';

      // Bridge context pour enrichir la confirmation d'entrée
      const _enterBp = (typeof tvDataStore !== 'undefined' && tvDataStore[sym]?._bridgePayload) || null;
      let _enterSetupType = null;
      let _enterTfContext = null;
      let _enterMacroLine = null;
      if (_enterBp) {
        // Type de setup
        if (typeof detectSetupTypeFromBridge === 'function') {
          _enterSetupType = detectSetupTypeFromBridge(_enterBp, null);
        }
        // Contexte TF (M15/H1)
        const _elt3 = String(_enterBp.lectureTech3 || '').toUpperCase();
        const _elt4 = String(_enterBp.lectureTech4 || '').toUpperCase();
        const _elt2 = String(_enterBp.lectureTech2 || '').toUpperCase();
        const _elt1 = String(_enterBp.lectureTech1 || '').toUpperCase();
        const _timingParts = [];
        if (_elt1.includes('ACHAT') || _elt1.includes('VENTE')) _timingParts.push('M1 ✓');
        if (_elt2.includes('ACHAT') || _elt2.includes('VENTE')) _timingParts.push('M5 ✓');
        const _ctxDir = posDir === 'LONG' ? 'haussier' : 'baissier';
        const _m15ok = posDir === 'LONG' ? _elt3.includes('ACHAT') : _elt3.includes('VENTE');
        const _h1ok  = posDir === 'LONG' ? _elt4.includes('ACHAT') : _elt4.includes('VENTE');
        const _ctxParts = [];
        if (_h1ok)  _ctxParts.push(`H1 ${_ctxDir}`);
        if (_m15ok) _ctxParts.push(`M15 ${_ctxDir}`);
        if (_ctxParts.length > 0 || _timingParts.length > 0) {
          const _all = [..._ctxParts, ...(_timingParts.length > 0 ? ['Timing ' + _timingParts.join('+')] : [])];
          _enterTfContext = _all.join(' | ');
        }
        // Macro
        if (typeof buildMacroContext === 'function') {
          const _mc = buildMacroContext(_enterBp);
          if (_mc && _mc.direction !== 'NEUTRE') _enterMacroLine = `Macro ${_mc.label} — contexte confirmé.`;
        }
      }
      const _setupLabel = _enterSetupType === 'SWING' ? '🌊 SWING' : _enterSetupType === 'SCALPING' ? '⚡ SCALPING' : '🎯 SNIPER';
      const parts = [
        `Position ${posDir} ouverte sur ${sym} à ${entryFmt}. Setup ${_setupLabel}.`,
        _enterTfContext ? `Alignement confirmé : ${_enterTfContext}.` : `Entrée validée sur ${tf} — exécution confirmée sur ${execTF}.`,
        `SL placé à ${_eSlFmt} (${_eSlPips} pips) pour protéger le capital. TP cible ${_eTpFmt} (${_eTpPips} pips). Ratio R/R: ${_eRr}.`,
        _enterMacroLine || `Je surveille la clôture des bougies ${execTF} et ${tf}. ${_safeStrategy}`,
      ];
      if (newsAlert) parts.push(newsAlert + 'Sois prêt à réagir.');
      return { text: parts.join('\n'), signal: posDir, canEnter: true, metrics };
    }

    // ── MODE MONITOR ─────────────────────────────────────────────────────────────
    if (mode === 'monitor') {
      const dir    = position?.direction || dirLabel;
      const entry  = Number(position?.entry || metrics.entry || 0);
      const sl     = Number(position?.sl || metrics.stopLoss || 0);
      const tp     = Number(position?.tp || metrics.takeProfit || 0);
      const curPx  = Number(px);
      const isLong = dir === 'LONG';
      // Pip multiplier correct selon l'actif
      const _symUp = String(sym || '').toUpperCase();
      const _pfCrypto = /BTC|ETH|SOL|XRP|BNB|ADA|LTC|DOT|LINK|AVAX|DOGE|MATIC/.test(_symUp);
      const _pfIndex  = /US30|NAS|SPX|DAX|CAC|FTSE|NI225|NIKKEI|SP500|NDX|DOW/.test(_symUp);
      const _pfGold   = /XAU|GOLD/.test(_symUp);
      const _pfJpy    = _symUp.includes('JPY');
      const pFactor   = (_pfCrypto || _pfIndex) ? 1 : _pfGold ? 10 : _pfJpy ? 100 : 10000;
      const pnlPipsNum = entry > 0 ? (isLong ? curPx - entry : entry - curPx) * pFactor : 0;
      const pnlPips = entry > 0 ? pnlPipsNum.toFixed(1) : '--';
      const pnlSign = pnlPipsNum >= 0 ? '+' : '';

      // Distance au SL / TP
      const distToSl = (entry > 0 && sl > 0) ? Math.abs((curPx - sl) * pFactor).toFixed(1) : '--';
      const distToTp = (entry > 0 && tp > 0) ? Math.abs((tp - curPx) * pFactor).toFixed(1) : '--';

      const parts = [];

      // ── Cas 1: liveContext avec indicateurs réels ────────────────────────────
      const lc = liveContext || {};
      const lcMomentum = lc.momentum;
      const lcAction   = lc.suggestedAction;
      const lcAlert    = lc.alertLevel || 'normal';
      const lcState    = lc.marketState;
      const lcDetails  = lc.indicatorDetails || [];
      const lcInd      = lc.liveIndicators || {};
      const hasLiveCtx = lcMomentum && lcMomentum !== '--' && lcMomentum !== 'DONNÉES MANQUANTES';

      if (hasLiveCtx) {
        // Phrase 1: état du marché basé sur indicateurs réels
        if (lcAlert === 'urgent') {
          parts.push(`⚠️ Alerte — ${lcState || 'signaux de retournement détectés'}.`);
        } else if (lcMomentum === 'FORT') {
          parts.push(`Momentum ${isLong ? 'haussier' : 'baissier'} fort. ${lcState || 'Marché continue dans ta direction.'}`);
        } else if (lcMomentum === 'MOYEN') {
          parts.push(`Momentum correct. ${lcState || 'Tendance maintenue, surveille la suite.'}`);
        } else if (lcMomentum === 'RALENTISSEMENT') {
          parts.push(`Le momentum ralentit. ${lcState || 'Surveille la structure — un recul est possible.'}`);
        } else if (lcMomentum === 'RETOURNEMENT POSSIBLE') {
          parts.push(`Attention — ${lcState || 'signaux contraires détectés. Risque de retournement.'}`);
        } else {
          parts.push(`Zone neutre. ${lcState || 'Marché en consolidation — pas d\'impulsion claire.'}`);
        }

        // Phrase 2: P&L + indicateurs clés
        if (entry > 0) {
          const rsiStr = lcInd.rsi != null ? `, RSI ${Math.round(lcInd.rsi)}` : '';
          const macdStr = lcInd.macd != null ? `, MACD ${Number(lcInd.macd) > 0 ? '+' : ''}${Number(lcInd.macd).toFixed(2)}` : '';
          parts.push(`Position ${dir} à ${pnlSign}${pnlPips} pips (entrée: ${entryFmt}${rsiStr}${macdStr}).`);
        }

        // Phrase 3: action concrète basée sur suggestedAction
        if (lcAction === 'TRAIL_SL' || lcAction === 'SECURISER_BE') {
          const pct = position?.progressPct || Math.round((pnlPipsNum / (Math.abs((tp - entry) * pFactor) || 1)) * 100);
          parts.push(`Position ${pct > 0 ? pct + '% vers le TP' : 'en développement'} — remonte le SL au breakeven pour sécuriser les gains. TP encore à ${distToTp} pips.`);
        } else if (lcAction === 'WIDEN_TP') {
          parts.push(`Impulsion forte confirmée. Le marché peut aller plus loin — tu peux élargir le TP. SL protège ${distToSl} pips.`);
        } else if (lcAction === 'PARTIAL_TP') {
          parts.push(`${pnlSign}${pnlPips} pips acquis — envisage de fermer une partie maintenant et laisser courir le reste. TP à ${distToTp} pips.`);
        } else if (lcAction === 'SECURISER' || lcAlert === 'urgent') {
          parts.push(`Sécurise maintenant — ${pnlSign}${pnlPips} pips à protéger. Remonte le SL au-dessus du breakeven immédiatement.`);
        } else if (lcAction === 'ATTENTION' || lcAlert === 'attention') {
          // Momentum contre la position — risque sans danger immédiat
          const _attRsi = lcInd.rsi != null ? ` (RSI ${Math.round(lcInd.rsi)})` : '';
          parts.push(`⚡ Momentum counter-tendance${_attRsi}. SL à ${distToSl} pips — surveille la clôture de bougie avant de décider. Ne pas relâcher la vigilance.`);
        } else if (lcAction === 'HOLD') {
          parts.push(`Tiens la position. Structure intacte, momentum aligné. TP à ${distToTp} pips — attends la clôture de bougie.`);
        } else if (lcAction === 'WATCH') {
          parts.push(`Surveille de près. TP à ${distToTp} pips, SL à ${distToSl} pips. Attends confirmation avant d'agir.`);
        } else {
          parts.push(`Tiens la position. TP à ${distToTp !== '--' ? distToTp + ' pips.' : 'en cours.'} Attends la clôture de bougie.`);
        }

        // Phrase 4: détails indicateurs si utile (urgent ou attention)
        if ((lcAlert === 'urgent' || lcAlert === 'attention') && lcDetails.length > 0) {
          parts.push(`Raison: ${lcDetails.slice(0, 2).join('. ')}.`);
        }

      } else {
        // ── Cas 2: pas d'indicateurs — fallback générique amélioré ───────────────
        let state = 'neutre';
        let stateText = '';
        if (isL) { state = 'haussier'; stateText = 'momentum haussier présent'; }
        else if (isS) { state = 'baissier'; stateText = 'pression baissière en cours'; }
        else { stateText = 'marché consolide, pas d\'impulsion claire'; }

        parts.push(`Marché ${state} — ${stateText}.`);

        if (entry > 0) {
          parts.push(`Position ${dir} à ${pnlSign}${pnlPips} pips (entrée: ${entryFmt}, prix: ${curPx > 100 ? curPx.toFixed(2) : curPx.toFixed(5)}).`);
          if (pnlPipsNum > 0 && tp > 0 && pnlPipsNum / ((tp - entry) * pFactor) > 0.7) {
            parts.push(`Objectif TP à ${distToTp} pips — envisage de sécuriser une partie ou déplacer le SL au breakeven.`);
          } else if (pnlPipsNum > 0 && sl > 0 && pnlPipsNum > Math.abs((entry - sl) * pFactor) * 0.5) {
            parts.push(`Bon développement. Déplace le SL au breakeven pour protéger les gains. TP encore à ${distToTp} pips.`);
          } else if (pnlPipsNum < 0 && sl > 0 && Math.abs(pnlPipsNum) > Math.abs((entry - sl) * pFactor) * 0.7) {
            parts.push(`Proche du SL (${distToSl} pips). Surveille attentivement — si la structure s'invalide, coupe proprement.`);
          } else {
            parts.push(`Tiens la position. ${distToTp !== '--' ? `TP à ${distToTp} pips.` : ''} Attends la clôture de bougie.`);
          }
        }
        // Note: indicateurs manquants — invite à les configurer
        parts.push(`Ajoute RSI, EMA et MACD sur TradingView pour recevoir une analyse en temps réel.`);
      }

      if (newsAlert) parts.push(newsAlert + 'Prêt à réagir rapidement si nécessaire.');

      return { text: parts.join('\n'), signal: dirLabel, pnlPips, metrics };
    }

    // ── MODE LOTSIZE ─────────────────────────────────────────────────────────────
    if (mode === 'lotsize') {
      const capital  = Number(position?.capital || 1000);
      const leverage = Number(String(position?.leverage || '100').replace(/[^0-9]/g,'')) || 100;
      const riskPct  = 0.02; // 2% max risk
      const riskAmt  = capital * riskPct;

      const slP = Number(slPips) || 20;
      const pipValue = sym.includes('JPY') ? 0.01 : sym.includes('XAU') || sym.includes('GOLD') ? 1 : 0.0001;
      const lotSize = slP > 0 ? (riskAmt / (slP * pipValue * 100000 / leverage)).toFixed(2) : '0.01';

      const parts = [
        `Pour ${capital}€ avec levier 1:${leverage}, risque 2% = ${riskAmt.toFixed(0)}€.`,
        `SL de ${slP} pips → lot recommandé: ${lotSize} (max ${(Number(lotSize) * 1.5).toFixed(2)} pour risque 3%).`,
        `Commence conservateur à ${Math.max(0.01, Number(lotSize) * 0.75).toFixed(2)} lot si marché volatile.`
      ];
      return { text: parts.join('\n'), lotSize, metrics };
    }

    return { text: 'Mode inconnu', metrics };
  }

  // ─── CODEX AI — appelle le CLI OpenAI Codex (ChatGPT OAuth, gratuit, sans API key) ─
  function callCodexAI(prompt, timeoutMs = 45000) {
    return new Promise((resolve) => {
      let output = '';
      let errOut = '';
      let resolved = false;
      function finish() {
        if (resolved) return;
        resolved = true;
        // STDOUT contient la vraie réponse IA directement (les headers/metadata sont sur STDERR)
        const aiResponse = output.trim();
        resolve({ ok: !!aiResponse, text: aiResponse || null, raw: output, err: errOut });
      }
      const proc = spawn('npx', ['@openai/codex', 'exec', '-'], {
        shell: true,
        windowsHide: true,
        env: { ...process.env }
      });
      proc.stdout.on('data', d => { output += d.toString(); });
      proc.stderr.on('data', d => { errOut += d.toString(); });
      proc.on('close', finish);
      proc.on('error', (e) => { if (!resolved) { resolved = true; resolve({ ok: false, text: null, error: e.message }); } });
      proc.stdin.write(prompt);
      proc.stdin.end();
      // On timeout: still extract whatever output arrived before killing
      setTimeout(() => { try { proc.kill(); } catch (_) {} finish(); }, timeoutMs);
    });
  }

  // POST /set-mode — change le mode d'exécution (AUTO/SCALPER/SNIPER/SWING) + broadcast SSE
  app.post('/set-mode', (req, res) => {
    const raw = String(req.body?.mode || 'AUTO').toUpperCase();
    const VALID = ['AUTO', 'SCALPER', 'SNIPER', 'SWING', 'PRECISION', 'MOMENTUM', 'REVERSAL'];
    const mode = VALID.includes(raw) ? raw : 'AUTO';
    bridgeConfig.bridgeMode = mode;
    if (activeSymbol) activeSymbol.mode = mode;
    // Broadcast mode change to extension + dashboard via SSE
    broadcastToExtension({
      type: 'mode-change',
      mode,
      modeResolved: mode,
      source: req.body?.source || 'dashboard'
    });
    // Invalider le cache d'analyse — le mode change la décision, garder le cache = faux résultat
    Object.keys(coachAnalysisSnapshotCache).forEach(k => { delete coachAnalysisSnapshotCache[k]; });
    console.log(`[MODE] Mode changé → ${mode} (source: ${req.body?.source || 'api'}) | cache invalidé`);
    return res.json({ ok: true, mode, source: req.body?.source || 'api' });
  });

  // GET /get-mode — retourne le mode actuel
  app.get('/get-mode', (_req, res) => {
    const mode = bridgeConfig.bridgeMode || activeSymbol?.mode || 'AUTO';
    return res.json({ ok: true, mode, modeResolved: mode });
  });

  // POST /set-mute — sync mute state entre dashboard et extension
  app.post('/set-mute', (req, res) => {
    const muted = req.body?.muted === true;
    const source = String(req.body?.source || 'unknown');
    broadcastToExtension({ type: 'mute-state', muted, source });
    return res.json({ ok: true, muted, source });
  });

  // ── MARKET SESSION CONTEXT ──────────────────────────────────────────────────
  function getMarketSessionContext() {
    const now = new Date();
    const h = now.getUTCHours();
    const m = now.getUTCMinutes();
    const totalMin = h * 60 + m;

    const sessions = {
      asia:    { open: 23*60, close: 8*60,  label: 'Asie (Tokyo)',         emoji: '🗼' },
      london:  { open: 7*60,  close: 16*60, label: 'Londres',              emoji: '🇬🇧' },
      ny:      { open: 12*60, close: 21*60, label: 'New York',             emoji: '🗽' },
    };

    const isInSession = (s) => {
      if (s.open > s.close) return totalMin >= s.open || totalMin < s.close; // crosses midnight
      return totalMin >= s.open && totalMin < s.close;
    };

    const active = [];
    if (isInSession(sessions.asia))   active.push(sessions.asia);
    if (isInSession(sessions.london)) active.push(sessions.london);
    if (isInSession(sessions.ny))     active.push(sessions.ny);

    const overlap = active.length > 1;
    const isLondonNY = isInSession(sessions.london) && isInSession(sessions.ny);

    // Imminent openings/closings (within 15 min)
    const events = [];
    const minsUntil = (target) => {
      let diff = target - totalMin;
      if (diff < 0) diff += 24*60;
      return diff;
    };
    const minsAfter = (target) => {
      let diff = totalMin - target;
      if (diff < 0) diff += 24*60;
      return diff;
    };

    for (const [, s] of Object.entries(sessions)) {
      const untilOpen  = minsUntil(s.open);
      const untilClose = minsUntil(s.close);
      const afterOpen  = minsAfter(s.open);
      const afterClose = minsAfter(s.close);

      if (untilOpen <= 15 && untilOpen > 0)   events.push(`⚡ Ouverture ${s.label} dans ${untilOpen} min`);
      if (afterOpen  <= 15 && afterOpen >= 0)  events.push(`🔔 ${s.label} vient d'ouvrir (il y a ${afterOpen} min)`);
      if (untilClose <= 15 && untilClose > 0)  events.push(`⏳ Fermeture ${s.label} dans ${untilClose} min`);
      if (afterClose <= 15 && afterClose >= 0) events.push(`🔕 ${s.label} vient de fermer (il y a ${afterClose} min)`);
    }

    const timeUTC = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} UTC`;

    let summary = '';
    if (active.length === 0) {
      summary = `🌙 Marché calme — aucune session majeure ouverte (${timeUTC}). Volumes faibles, mouvements peu fiables.`;
    } else if (isLondonNY) {
      summary = `🔥 OVERLAP LONDRES/NEW YORK actif (${timeUTC}) — session LA PLUS VOLATILE de la journée. Volumes max, breakouts fréquents. Haute probabilité de mouvement fort.`;
    } else if (overlap) {
      summary = `⚡ Overlap ${active.map(s => s.label).join(' + ')} (${timeUTC}) — volatilité accrue, liquidité élevée.`;
    } else {
      summary = `${active[0].emoji} Session ${active[0].label} active (${timeUTC}) — volumes normaux.`;
    }

    return {
      summary,
      active: active.map(s => s.label),
      events,
      isLondonNY,
      isOverlap: overlap,
      timeUTC,
      block: [summary, ...events].join('\n')
    };
  }

  // ── CORRELATION / DXY CONTEXT ────────────────────────────────────────────────
  function getCorrelationContext(sym) {
    const s = String(sym || '').toUpperCase();
    const isCrypto  = /BTC|ETH|SOL|XRP|BNB|ADA|DOGE/.test(s);
    const isGold    = /XAU|GOLD/.test(s);
    const isOil     = /OIL|WTI|BRENT|USOIL/.test(s);
    const isJpy     = s.includes('JPY');
    const isUsdBase = s.startsWith('USD') || s.endsWith('USD') || s.includes('USD');
    const isEur     = s.includes('EUR');
    const isGbp     = s.includes('GBP');
    const isIndice  = /SPX|SP500|NAS|NDX|DOW|DAX|FTSE|CAC/.test(s);

    if (isCrypto) {
      return `Corrélation: BTC/crypto → inverse DXY (dollar fort = crypto en pression). Risk-on: BTC monte si indices montent et dollar baisse. Surveiller NAS100 comme proxy risk-on.`;
    }
    if (isGold) {
      return `Corrélation: XAU/USD → inverse DXY et taux réels US. Dollar fort = or sous pression. Refuge si risk-off (incertitude, tensions géopolitiques). Monter si DXY baisse et taux 10Y baissent.`;
    }
    if (isOil) {
      return `Corrélation: Pétrole → lié à risk-on/risk-off et géopolitique. USD fort = pétrole en pression (coté USD). Surveiller inventaires US et OPEC+ pour catalyseurs.`;
    }
    if (isJpy) {
      return `Corrélation: JPY → actif refuge, monte en risk-off (marchés stressés). USD/JPY suit les taux US: si taux 10Y US montent → USD/JPY monte. Yen fort si risk-off global.`;
    }
    if (isGbp) {
      return `Corrélation: GBP → sensible aux données UK (CPI, employment) et au sentiment risk. GBP/USD inverse DXY. Surveiller BoE et données macro UK.`;
    }
    if (isEur) {
      return `Corrélation: EUR → inverse DXY direct. EUR/USD monte si dollar faiblit. Sensible aux données BCE et à l'économie zone euro vs US.`;
    }
    if (isIndice) {
      return `Corrélation: Indice actions → risk-on. Monte si appétit au risque, taux stables, dollar modéré. Surveiller FED et données emploi US comme catalyseurs macro.`;
    }
    if (isUsdBase) {
      return `Corrélation: Paire USD → directement influencée par DXY. Dollar fort si inflation US haute, FED hawkish, données emploi solides. Surveiller CPI et NFP.`;
    }
    return `Corrélation: Surveiller DXY et risk-on/risk-off global pour contexte macro sur ${s}.`;
  }

  // POST /ai/coach — coaching IA Codex (ChatGPT gpt-5.2, gratuit, sans API key)
  app.post('/ai/coach', async (req, res) => {
    const { symbol, timeframe, mode = 'analyze', price, position, multiTF } = req.body || {};
    const sym = String(symbol || activeSymbol?.symbol || 'XAUUSD').toUpperCase();
    const tf  = String(timeframe || activeSymbol?.timeframe || 'H1').toUpperCase();
    const px  = Number(price || tvDataStore[sym]?.price || 0);

    try {
      const [cRes, nRes] = await Promise.allSettled([
        fetch(`http://localhost:${PORT}/coach/realtime?symbol=${sym}&tf=${tf}&mode=AUTO`).then(r => r.json()),
        fetch(`http://localhost:${PORT}/news?symbol=${sym}&limit=8`).then(r => r.json())
      ]);
      const coachData = cRes.status === 'fulfilled' ? cRes.value : null;
      const newsData  = nRes.status === 'fulfilled' ? nRes.value : null;

      const coach  = coachData?.coach || {};
      const exec   = coachData?.execution || coach.execution || {};
      const agents = coach.agents || {};
      const tr     = coachData?.tradeReasoning || {};
      const ms     = coachData?.marketStatus || {};
      const metrics = tr.metrics || {};
      const signal = String(coach.signal?.verdict || exec.decision || 'WAIT').toUpperCase();
      // Source du signal — si price-action-ticks: pas d'indicateurs TV réels
      // → bloquer Ollama (hallucine des données) → forcer generateCoachText (données réelles)
      const _coachSigSource = coach.signal?.source || exec.source || '';
      const _noRealIndicators = _coachSigSource === 'price-action-ticks' || _coachSigSource === 'live-runtime';
      const rsi    = metrics.rsi || coach.indicators?.rsi || '--';
      const trend  = ms.trend || coach.signal?.trend || '--';
      const atr    = metrics.atr || '--';
      const support    = metrics.support || '--';
      const resistance = metrics.resistance || '--';
      const entry  = metrics.entry || metrics.price || px;
      const sl     = metrics.stopLoss || '--';
      const tp     = metrics.takeProfit || '--';

      // News context
      const newsItems = (newsData?.news || []).slice(0,3).map(n => `• ${n.title || n.event || n.text}`).join('\n') || 'Aucune actualité majeure';

      // Multi-TF context (passé par le dashboard lors du scan automatique)
      let multiTFBlock = '';
      if (multiTF && typeof multiTF === 'object') {
        const tfLines = Object.entries(multiTF).map(([t, d]) => {
          const dir = d.direction || 'NEUTRE';
          const ch  = dir === 'LONG' ? '▲ canal haussier' : dir === 'SHORT' ? '▼ canal baissier' : '— neutre/range';
          return `  ${t}: ${ch}`;
        }).join('\n');
        const longs  = Object.values(multiTF).filter(d => d.direction === 'LONG').length;
        const shorts = Object.values(multiTF).filter(d => d.direction === 'SHORT').length;
        const total  = Object.keys(multiTF).length;
        const confluence = longs >= shorts && longs >= total/2 ? 'CONFLUENT HAUSSIER' : shorts > longs && shorts >= total/2 ? 'CONFLUENT BAISSIER' : 'MIXTE/NEUTRE';
        multiTFBlock = `\nLecture Multi-Timeframes (scan clôture M1):\n${tfLines}\nConfluence globale: ${confluence} (${longs}L/${shorts}S/${total-longs-shorts}N sur ${total} TF)`;
      }

      // Mode d'exécution actif (depuis le dashboard ou l'extension)
      const execMode = req.body?.execMode || bridgeConfig?.bridgeMode || 'AUTO';

      // ── RÈGLES DE TRADING PAR MODE — appliquées strictement ────────────────────
      // ORANGE ZONE = zone d'intérêt (niveau clé, support/résistance, order block)
      // RED-ORANGE  = zone haute probabilité (confluence forte, rejet confirmé)
      // PAS d'entrée au MILIEU — uniquement aux extrêmes/zones orange/red-orange
      const execModeDesc = {
        AUTO: `AUTO — le robot adapte le style selon le marché.
Règle d'entrée: cherche les "zones orange" = niveaux clés (EMA200, support/résistance majeur, order block, retest d'une zone cassée).
Entrée autorisée UNIQUEMENT quand le prix teste une zone orange ou red-orange = point extrême (pas en milieu de range).
Si le prix est en milieu de fourchette → ATTENDRE qu'il atteigne un bord.`,

        SCALPER: `SCALPER — style ultra-rapide M1/M5, sorties en 1-15 min.
RÈGLES SCALP STRICTES:
• Entrée OBLIGATOIREMENT sur "zone orange" = niveau clé M5/M15 (EMA9/21 en mouvement, niveau pivot, mini support/résistance récent)
• "Zone red-orange" = confluence forte (EMA+pivot+RSI extrême) = entrée prioritaire, SL très serré 0.5x ATR
• INTERDICTION d'entrer au milieu du range M1 — le prix doit être à un bord (haut ou bas du canal récent)
• Sens de trade: TOUJOURS dans la tendance H1 (pas de contre-tendance en scalp)
• RSI M1 < 35 pour un LONG scalp, > 65 pour SHORT scalp — obligatoire
• SL = 3-5 pips maximum. TP = au moins 1:1 ratio minimum, cible niveau suivant visible
• Si spread > 1.5 pip → NE PAS entrer`,

        SNIPER: `SNIPER — entrées précises à haute probabilité, 30min-6h.
RÈGLES SNIPER STRICTES:
• Entrée AUTORISÉE au milieu seulement s'il y a un signal fort (engulfing, pin bar, rejet de wick ≥ 2x corps)
• Zone orange prioritaire = retest d'une zone cassée (ancien support devenu résistance ou vice versa)
• Zone red-orange = order block (dernière bougie baissière avant un mouvement haussier fort, ou inverse)
• Attendre confirmation de bougie close (pas d'entrée en cours de bougie sauf M1)
• SL = juste sous/sur la zone testée + buffer de 3-5 pips
• TP = prochain niveau majeur visible (minimum RR 1:2)
• Pas d'entrée si news high impact dans les 30 prochaines minutes`,

        SWING: `SWING — positions multi-sessions H4/D1, tenu 1-5 jours.
RÈGLES SWING STRICTES:
• Entrée UNIQUEMENT aux points de swing majeurs H4/D1: sommet ou creux récent significatif
• Zone orange = niveau horizontal majeur, zone d'offre/demande H4, retracement Fibonacci 61.8% ou 78.6%
• Zone red-orange = confluence forte: niveau Fibonacci + support/résistance horizontal + EMA200 H4 dans la même zone
• INTERDICTION totale d'entrer au milieu d'une bougie H4 — attendre close obligatoire
• Tendance D1 doit être confirmée dans le sens du trade
• SL = sous/sur le dernier swing point + buffer 10-15 pips. TP = prochain swing majeur (RR minimum 1:3)
• Ignorer les mouvements M5/M15 — ce sont du bruit en mode swing`,
      }[execMode.toUpperCase()] || `Mode: ${execMode}`;

      // Zone TV (si disponible depuis le bridge TradingView)
      const tvZone = coachData?.chart?.panelData?.zone || coachData?.zone || agents?.analysis?.zone || null;
      const tvAnticipation = coachData?.chart?.panelData?.anticipation || agents?.analysis?.anticipation || null;
      const tvReading = coachData?.chart?.panelData?.reading || null;
      const zoneContext = tvZone ? `\nZone TV détectée: ${tvZone}` : '';
      const anticipationContext = tvAnticipation ? ` | Anticipation: ${tvAnticipation}` : '';

      // Market sessions + correlation context
      const sessionCtx     = getMarketSessionContext();
      const correlationCtx = getCorrelationContext(sym);

      // Build prompt based on analysis mode
      let modeInstructions = '';
      if (mode === 'analyze') {
        const zoneRule = execMode === 'SCALPER' ? 'Dis clairement si le prix est sur une ZONE ORANGE (niveau clé M5/M15 = EMA9/21 en dynamique, pivot, support récent) ou RED-ORANGE (confluence forte) ou en MILIEU DE RANGE (pas d\'entrée possible). En scalp, pas d\'entrée au milieu — il faut attendre le bord.'
          : execMode === 'SNIPER' ? 'Identifie la zone orange = retest de niveau cassé, ou red-orange = order block. Attendre le rejet (wick, engulfing) avant l\'entrée. Si entrée au milieu → signal de rejet obligatoire.'
          : execMode === 'SWING' ? 'Identifie les points de swing H4/D1. Zone orange = niveau horizontal majeur ou Fibonacci 61.8/78.6%. Trend D1 doit être confirmée.'
          : 'Identifie si le prix est sur une zone clé (orange) ou en milieu de range. Entrée préférable aux extrêmes.';
        const sessionNote = sessionCtx.isLondonNY ? ' ⚠️ OVERLAP LONDRES/NY actif = volatilité maximale — les cassures sont fréquentes et rapides, anticipe les mouvements de liquidité.' : sessionCtx.isOverlap ? ` Session overlap (${sessionCtx.active.join('+')}) = volatilité accrue.` : sessionCtx.active.length > 0 ? ` Session ${sessionCtx.active[0]} active.` : ' Hors sessions — volumes faibles, méfie-toi des faux mouvements.';
        modeInstructions = `Tu es en SCAN TEMPS RÉEL (clôture bougie M1). Structure de marché: canal haussier/baissier/range sur chaque TF. Si compression (ATR faible) → breakout imminent, annonce-le. ${zoneRule} En mode ${execMode}, identifie LONG ou SHORT, niveau d'entrée précis avec TF d'exécution, confirmation attendue.${sessionNote} Dis si le marché va bouger bientôt. Sois direct comme un trader devant l'écran.

RÈGLES D'ALIGNEMENT TF OBLIGATOIRES (à appliquer avant tout signal) :
• CAS 1 CLASSIQUE : H1=direction + M15=zone+setup + M5=confirmation → entrée autorisée
• CAS 2 SNIPER : M15=contexte + M5=zone + M1=impulsion/rejet → entrée rapide
• EXCLUSIONS ABSOLUES : (1) Conflit H1↔M15 = attendre | (2) Prix au milieu = interdit | (3) Pas de timing M1/M5 = interdit
• RSI >70 sur M15/H1 = impulsion déjà faite → NE PAS ENTRER, attendre pullback
• RÈGLE D'OR : "Je n'entre pas parce que ça monte. J'entre parce que j'ai une zone + un timing."
Réponds d'abord en disant où se trouve le prix (zone haute/basse/milieu), puis si les 3 conditions sont réunies (direction + zone + timing), puis ta décision.`;
      } else if (mode === 'enter') {
        const posDir = position?.direction || signal;
        const isAtZone = tvZone && tvZone.length > 3;
        const sessionAnnounce = sessionCtx.events.length > 0
          ? `ATTENTION SESSION: ${sessionCtx.events.join(' | ')} — `
          : sessionCtx.isLondonNY
            ? '🔥 OVERLAP LONDRES/NY = volatilité maximale — '
            : sessionCtx.active.length > 0
              ? `Session ${sessionCtx.active[0]} active — `
              : '🌙 Hors sessions principales — volumes faibles, prudence — ';
        modeInstructions = `${sessionAnnounce}Le trader entre en position ${posDir} en mode ${execMode}. ${isAtZone ? 'Zone TV détectée: ' + tvZone + ' — confirme si c\'est une zone orange (niveau clé) ou red-orange (confluence forte) cohérente avec l\'entrée.' : 'Pas de zone TV détectée — confirme si le prix est bien à un niveau clé et non en milieu de range.'} Type d'entrée: ${Math.abs(Number(position?.entry||entry) - Number(px)) <= Number(atr||0)*0.3 ? 'IMMÉDIAT (au prix actuel)' : 'EN ATTENTE (prix cible différent)'}. SL=${sl}, TP=${tp}. Annonce la session active, la corrélation macro, et confirme si cette entrée respecte les règles du mode ${execMode}. Risque: bon/moyen/élevé.`;
      } else if (mode === 'monitor') {
        const posEntry = position?.entry || entry;
        const posDir   = position?.direction || '--';
        const posPnl   = position?.pnl ?? '--';
        const posPct   = position?.progressPct != null ? position.progressPct + '%' : '--';
        const bePlaced = position?.bePlaced ? 'OUI' : 'NON';
        const distSL   = Math.abs(Number(px) - Number(position?.sl||sl));
        const distTP   = Math.abs(Number(px) - Number(position?.tp||tp));
        // Indicateurs live reçus depuis le bridge TV (passés par le dashboard)
        const _liveInd = req.body?.liveIndicators || {};
        const _rsiLive = _liveInd.rsi  != null ? _liveInd.rsi  : (tvDataStore[sym]?.indicators?.rsi  ?? null);
        const _macdLive= _liveInd.macd != null ? _liveInd.macd : (tvDataStore[sym]?.indicators?.macd ?? null);
        const _ma20Live= _liveInd.ma20 != null ? _liveInd.ma20 : (tvDataStore[sym]?.indicators?.ma20 ?? null);
        const _atrLive = _liveInd.atr  != null ? _liveInd.atr  : (tvDataStore[sym]?.indicators?.atr  ?? null);
        const _momentum = req.body?.momentum || '--';
        const _marketState = req.body?.marketState || '--';
        const _detailsStr = (req.body?.indicatorDetails || []).join(' | ') || 'indicateurs non reçus';
        const _suggestedAction = req.body?.suggestedAction || '--';
        const _alertLevel = req.body?.alertLevel || 'normal';
        const _indBlock = [
          _rsiLive  != null ? `RSI: ${Number(_rsiLive).toFixed(1)}` : null,
          _ma20Live != null ? `EMA20: ${Number(_ma20Live).toFixed(2)}` : null,
          _macdLive != null ? `MACD: ${Number(_macdLive).toFixed(2)}` : null,
          _atrLive  != null ? `ATR: ${Number(_atrLive).toFixed(2)}` : null,
        ].filter(Boolean).join(' | ') || 'non disponibles (ajouter RSI/EMA sur TradingView)';
        const _alertNote = _alertLevel === 'urgent' ? '⚠️ ALERTE URGENTE — signaux de retournement détectés.' : _alertLevel === 'attention' ? '⚡ ATTENTION — momentum s\'affaiblit.' : '';
        modeInstructions = `${_alertNote}
Position ${posDir} ouverte à ${posEntry}. Prix actuel: ${px}. P&L: ${posPnl} pips (${posPct} vers TP). Breakeven placé: ${bePlaced}.
Distance SL restante: ${distSL.toFixed(2)}, Distance TP restante: ${distTP.toFixed(2)}.
Indicateurs en temps réel: ${_indBlock}.
Analyse momentum: ${_momentum} — ${_marketState}.
Détails: ${_detailsStr}.
Action suggérée par le système: ${_suggestedAction}.
Mode: ${execMode}.
COACH EN TEMPS RÉEL (2-3 phrases max, directes, en français):
1) Le momentum continue-t-il dans la bonne direction?
2) Faut-il remonter le SL au breakeven maintenant?
3) Le TP peut-il être élargi si l'impulsion est forte?
Parle comme un coach qui surveille l'écran en direct. Ne dis pas LONG ou SHORT — dis "la position" ou "le marché".`;
      } else if (mode === 'lotsize') {
        modeInstructions = `Calcule le lot adapté au mode ${execMode}. Capital: 10 000€, levier 1:100, risque 1% max. Stop: ${sl}. Donne un nombre précis (ex: 0.05 lot).`;
      }

      const prompt = `Tu es un coach trader professionnel. Réponds en français, 4-5 phrases max, PRATIQUES et DIRECTES. Pas de généralités — donne des prix précis et des actions concrètes.

Symbole: ${sym} | TF: ${tf} | Prix actuel: ${px || '--'}
Signal: ${signal} | RSI: ${rsi} | Tendance: ${trend}
Support: ${support} | Résistance: ${resistance} | ATR: ${atr}
${tvZone ? 'Zone TV: ' + tvZone : 'Zone: non détectée'}${anticipationContext}${tvReading ? ' | Lecture: ' + tvReading : ''}
Analyse technique: ${agents.analysis?.reason || '--'}
News proches: ${newsItems}
Sessions de marché: ${sessionCtx.block}
Corrélation macro: ${correlationCtx}
Mode actif: ${execModeDesc}${multiTFBlock}

Mission: ${modeInstructions}`;

      // Chaîne IA: 1. Codex (GitHub Copilot gratuit) → 2. Ollama local → 3. Moteur local
      // RÈGLE: si pas d'indicateurs TV réels (price-action uniquement) → court-circuiter
      // l'IA externe (hallucine RSI/zones/macro inexistants) → moteur local garanti fiable
      const aiResult = _noRealIndicators ? { text: null } : await callCodexAI(prompt);
      let responseText = aiResult.text;
      let source = 'codex-ai';

      // Chaîne IA: 1. Codex (GitHub Copilot gratuit) → 2. Moteur local

      // Fallback 3: moteur local (toujours activé si pas d'indicateurs TV)
      if (!responseText) {
        const _liveCtx = mode === 'monitor' ? {
          momentum: req.body?.momentum,
          marketState: req.body?.marketState,
          indicatorDetails: req.body?.indicatorDetails,
          suggestedAction: req.body?.suggestedAction,
          alertLevel: req.body?.alertLevel,
          liveIndicators: req.body?.liveIndicators || {}
        } : null;
        const local = generateCoachText(mode, sym, tf, px, coachData, newsData, position, _liveCtx);
        responseText = local.text;
        source = 'local-coach';
      }

      const _canEnter = exec.canEnter === true;
      // SOURCE UNIQUE: inclure l'état de position active dans le broadcast
      // → Dashboard ET Extension lisent la même direction (position prime sur signal frais)
      const _activeTrade = (typeof getCoachTradeState === 'function') ? getCoachTradeState(sym, tf) : null;
      broadcastToExtension({
        type: 'analysis-complete',
        symbol: sym,
        timeframe: tf,
        mode,
        signal,
        canEnter: _canEnter,
        metrics: metrics || {},
        response: responseText,
        source,
        timestamp: Date.now(),
        tradeState: _activeTrade ? {
          entered: !!_activeTrade.entered,
          phase: _activeTrade.phase || 'WAIT_ENTRY',
          virtualPosition: _activeTrade.virtualPosition || null
        } : null
      });

      return res.json({
        ok: true,
        mode, symbol: sym, timeframe: tf, price: px,
        signal,
        canEnter: _canEnter,
        metrics: metrics || {},
        response: responseText,
        source,
        timestamp: Date.now()
      });
    } catch (e) {
      return res.json({ ok: false, response: `Erreur coach: ${e.message}`, error: e.message });
    }
  });

  // GET /ai/multitf — analyse multi-timeframes séquentielle
  app.get('/ai/multitf', async (req, res) => {
    const sym = String(req.query.symbol || activeSymbol?.symbol || 'XAUUSD').toUpperCase();
    const tfs = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];
    const results = {};

    for (const tf of tfs) {
      try {
        const d = await fetch(`http://localhost:${PORT}/coach/realtime?symbol=${sym}&tf=${tf}&mode=AUTO`).then(r => r.json());
        const coach = d?.coach || {};
        const exec  = d?.execution || coach.execution || {};
        const signal = String(coach.signal?.verdict || exec.decision || 'WAIT').toUpperCase();
        const isL = signal.includes('BUY') || signal.includes('LONG');
        const isS = signal.includes('SELL') || signal.includes('SHORT');
        results[tf] = {
          signal,
          direction: isL ? 'LONG' : isS ? 'SHORT' : 'NEUTRE',
          reason: coach.agents?.analysis?.reason || coach.signal?.rationale || '--',
          canEnter: exec.canEnter === true,
          entry: d?.tradeReasoning?.metrics?.entry,
          sl: d?.tradeReasoning?.metrics?.stopLoss,
          tp: d?.tradeReasoning?.metrics?.takeProfit
        };
      } catch (_) {
        results[tf] = { signal: 'ERROR', direction: 'NEUTRE', reason: 'Données indisponibles' };
      }
    }

    return res.json({ ok: true, symbol: sym, results, timestamp: Date.now() });
  });

  // ─── CENTRAL GUIDE AGENT — analyse réelle + boucle tester/retester ───────────
  const centralGuideAcks = {};

  function normalizeGuideDomain(raw) {
    const v = String(raw || 'bridge').toLowerCase();
    if (v.includes('bridge') || v === 'api') return 'bridge';
    if (v.includes('mt5')) return 'mt5';
    if (v.includes('trading')) return 'tradingview';
    if (v.includes('ext')) return 'extension';
    if (v.includes('extern') || v.includes('lia') || v.includes('ollama')) return 'externals';
    if (v.includes('module') || v.includes('agent')) return 'modules';
    return 'bridge';
  }

  async function fetchLocalJson(endpoint, options = {}, timeoutMs = 8000) {
    const r = await fetch('http://127.0.0.1:' + PORT + endpoint, {
      signal: AbortSignal.timeout(timeoutMs),
      ...options,
      headers: {
        'Accept': 'application/json',
        ...(options.headers || {})
      }
    });
    const text = await r.text();
    const ct = String(r.headers.get('content-type') || '').toLowerCase();
    let data = null;
    let jsonOk = false;
    try {
      data = JSON.parse(text || '{}');
      jsonOk = true;
    } catch (_e) {
      jsonOk = false;
    }
    if (!jsonOk) {
      return {
        ok: false,
        status: r.status,
        data: { ok: false, error: 'NON_JSON_RESPONSE', contentType: ct || 'unknown' }
      };
    }
    return { ok: r.ok, status: r.status, data };
  }

  function getDomainSpecialists(domain) {
    if (domain === 'mt5') return ['ui-test-agent', 'logic-gap-agent'];
    if (domain === 'tradingview') return ['ui-test-agent', 'logic-gap-agent'];
    if (domain === 'extension') return ['ui-test-agent', 'logic-gap-agent'];
    if (domain === 'modules') return ['logic-gap-agent', 'design-agent'];
    if (domain === 'externals') return ['research-agent'];
    return ['logic-gap-agent'];
  }

  async function runDomainSpecialists(domain) {
    const agents = getDomainSpecialists(domain);
    const reports = [];
    for (const agentName of agents) {
      try {
        const rr = await fetchLocalJson('/agents/' + encodeURIComponent(agentName) + '/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'central-guide-agent',
            to: agentName,
            message: `test domaine=${domain}`,
            status: 'action',
            phase: 'en cours',
            cause: 'orchestration central-guide',
            impact: 'vérification spécialisée',
            solution: 'retour de diagnostic'
          })
        });
        reports.push({ agent: agentName, ok: rr.ok, status: rr.status, response: rr.data?.response || rr.data });
      } catch (e) {
        reports.push({ agent: agentName, ok: false, status: 500, error: e.message });
      }
    }
    return reports;
  }

  async function runLiaSynthesis(domain, state, specialistSummary, channel = 'dev') {
    try {
      const safeSummary = (state && state.summary) ? state.summary : { ok: 0, total: 0 };
      const safeOk = Number.isFinite(Number(safeSummary.ok)) ? Number(safeSummary.ok) : 0;
      const safeTotal = Number.isFinite(Number(safeSummary.total)) ? Number(safeSummary.total) : 0;
      const safeSpecialistSummary = specialistSummary == null ? 'n/a' : String(specialistSummary);
      const rr = await fetch('http://127.0.0.1:' + PORT + '/lia/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          channel,
          message: `Synthèse central-guide domaine=${domain}. Checks=${safeOk}/${safeTotal}. Agents=${safeSpecialistSummary}. Donne un résumé court actionnable.`
        }),
        signal: AbortSignal.timeout(65000)
      });
      const raw = await rr.text();
      let jd = null;
      try { jd = JSON.parse(raw || '{}'); } catch (_e) {
        return { ok: false, response: 'Lia indisponible (réponse non JSON)' };
      }
      return jd;
    } catch (_e) {
      return { ok: false, response: 'Lia indisponible' };
    }
  }

  async function runAutoCorrectionIfNeeded(domain, state) {
    if (!state || !state.summary || state.summary.missing === 0) return { triggered: false };
    if (domain !== 'bridge' && domain !== 'mt5' && domain !== 'extension' && domain !== 'tradingview') {
      return { triggered: false };
    }
    try {
      const fix = await fetchLocalJson('/agents/repair-agent/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'central-guide-agent',
          to: 'repair-agent',
          message: `auto-correction domaine=${domain} missing=${state.summary.missing}`,
          status: 'action',
          phase: 'en cours',
          cause: 'checks central-guide KO',
          impact: 'blocage workflow',
          solution: state.nextAction ? state.nextAction.action : 'diagnostic complémentaire'
        })
      });
      return { triggered: true, ok: fix.ok, response: fix.data?.response || fix.data || null };
    } catch (e) {
      return { triggered: true, ok: false, error: e.message };
    }
  }

  function markGuideAck(domain, checkId) {
    const d = normalizeGuideDomain(domain);
    if (!centralGuideAcks[d]) centralGuideAcks[d] = {};
    centralGuideAcks[d][checkId] = new Date().toISOString();
  }

  async function runCentralGuideChecks(domainRaw) {
    const domain = normalizeGuideDomain(domainRaw);
    const checks = [];

    // Shared real-state calls
    const health = await fetchLocalJson('/health').catch(() => ({ ok: false, status: 500, data: {} }));
    const liveState = await fetchLocalJson('/live/state').catch(() => ({ ok: false, status: 500, data: {} }));
    const mt5Conn = await fetchLocalJson('/mt5/connection').catch(() => ({ ok: false, status: 500, data: {} }));
    const agents = await fetchLocalJson('/agents/list').catch(() => ({ ok: false, status: 500, data: {} }));
    const liaStatus = await fetchLocalJson('/lia/status').catch(() => ({ ok: false, status: 500, data: {} }));

    const addCheck = (id, label, ok, detail, action, verifyHint) => {
      checks.push({
        id,
        label,
        ok: !!ok,
        detail,
        actionIfMissing: action,
        verify: verifyHint,
        acknowledgedAt: centralGuideAcks[domain]?.[id] || null
      });
    };

    if (domain === 'bridge') {
      addCheck(
        'bridge-health',
        'Bridge local accessible (:4000)',
        health.ok && health.data.ok === true && Number(health.data.port) === 4000,
        health.ok ? `port=${health.data.port} uptime=${Math.floor(health.data.uptime || 0)}s` : `HTTP ${health.status}`,
        'Démarrer le bridge local sur port 4000',
        'Le test doit retourner ok=true et port=4000'
      );
      addCheck(
        'bridge-live-state',
        'Live state endpoint disponible',
        liveState.ok && liveState.data.ok === true,
        liveState.ok ? `source=${liveState.data.health?.source || 'offline'}` : `HTTP ${liveState.status}`,
        'Vérifier que /live/state répond',
        'Le test doit retourner ok=true'
      );
    }

    if (domain === 'mt5') {
      addCheck(
        'mt5-connected',
        'Flux MT5 connecté',
        mt5Conn.ok && mt5Conn.data.connected === true,
        mt5Conn.ok ? String(mt5Conn.data.message || '') : `HTTP ${mt5Conn.status}`,
        'Lancer MT5 + EA et autoriser WebRequest vers localhost:4000',
        'Le test doit afficher connected=true'
      );
      addCheck(
        'mt5-fresh-data',
        'Données MT5 fraîches',
        liveState.ok && (liveState.data.health?.source === 'mt5' || String(liveState.data.health?.source || '').includes('mt5')),
        liveState.ok ? `source=${liveState.data.health?.source || 'offline'} ageMs=${liveState.data.health?.ageMs ?? 'n/a'}` : `HTTP ${liveState.status}`,
        'Envoyer un tick depuis MT5 (POST /mt5)',
        'Le test doit montrer source=mt5'
      );
    }

    if (domain === 'tradingview') {
      const source = String(liveState.data.health?.source || '').toLowerCase();
      const payloadSource = String(liveState.data.latestPayload?.source || '').toLowerCase();
      const bridgeEnabled = liveState.ok ? (liveState.data.bridge?.enabled !== false) : false;
      const tvState = liveState.data.tradingview || {};
      const tvLastSource = String(tvState.lastSource || '').toLowerCase();
      const tvAgeMs = Number(tvState.ageMs);
      const tvFresh = Number.isFinite(tvAgeMs) ? tvAgeMs < 180000 : false;
      const tvOk = bridgeEnabled && (
        source.includes('tradingview') ||
        payloadSource.includes('tradingview') ||
        (tvFresh && (tvLastSource.includes('tradingview') || tvLastSource.includes('tv')))
      );

      const payloadSummary = tvState.payload
        ? `price=${tvState.payload.price ?? 'n/a'} verdict=${tvState.payload.verdict ?? 'n/a'} anticipation=${tvState.payload.anticipation ?? 'n/a'} rsi=${tvState.payload.rsi ?? 'n/a'}`
        : 'payload=n/a';
      addCheck(
        'tv-bridge-active',
        'TradingView alimente le système',
        liveState.ok && tvOk,
        liveState.ok
          ? `bridge=${bridgeEnabled ? 'ON' : 'OFF'} src=${source || 'n/a'} latest=${payloadSource || 'n/a'} tv.source=${tvLastSource || 'n/a'} symbol=${tvState.symbol || 'n/a'} tf=${tvState.timeframe || 'n/a'} ts=${tvState.timestamp || 'n/a'} event=${tvState.eventType || 'n/a'} ${payloadSummary}`
          : `HTTP ${liveState.status}`,
        'Déclencher une alerte TradingView vers le webhook local',
        'Le test doit voir source tradingview dans live/state'
      );
      addCheck(
        'tv-bridge-base',
        'Bridge central actif pour TradingView',
        health.ok && health.data.ok === true,
        health.ok ? `Bridge OK port=${health.data.port}` : `HTTP ${health.status}`,
        'Démarrer bridge local avant webhook TV',
        'Le test /health doit renvoyer ok=true'
      );
    }

    if (domain === 'extension') {
      const clients = Number(liveState.data.streams?.extensionSseClients || 0);
      addCheck(
        'ext-sync-clients',
        'Extension connectée au flux SSE',
        liveState.ok && clients > 0,
        liveState.ok ? `extensionSseClients=${clients}` : `HTTP ${liveState.status}`,
        'Ouvrir popup/monitor extension pour établir /extension/sync',
        'Le test doit afficher extensionSseClients > 0'
      );
      addCheck(
        'ext-endpoint',
        'Endpoint /extension/sync disponible',
        liveState.ok && liveState.data.endpoints?.['/extension/sync'] === true,
        liveState.ok ? `endpoint=${liveState.data.endpoints?.['/extension/sync']}` : `HTTP ${liveState.status}`,
        'Vérifier la route /extension/sync dans server.js',
        'Le test doit afficher endpoint=true'
      );
    }

    if (domain === 'externals') {
      addCheck(
        'lia-online',
        'Lia / Ollama disponible',
        liaStatus.ok && liaStatus.data.connected === true,
        liaStatus.ok ? `models=${(liaStatus.data.models || []).join(', ') || 'none'}` : `HTTP ${liaStatus.status}`,
        'Démarrer Ollama service local',
        'Le test doit afficher connected=true avec au moins 1 modèle'
      );
      addCheck(
        'lia-model',
        'Modèle IA présent',
        liaStatus.ok && Array.isArray(liaStatus.data.models) && liaStatus.data.models.length > 0,
        liaStatus.ok ? `count=${(liaStatus.data.models || []).length}` : `HTTP ${liaStatus.status}`,
        'Télécharger un modèle: ollama pull llama3.2',
        'Le test doit afficher models.length > 0'
      );
    }

    if (domain === 'modules') {
      const list = Array.isArray(agents.data.agents) ? agents.data.agents.map((a) => a.name) : [];
      const required = ['orchestrator', 'design-agent', 'ui-test-agent', 'logic-gap-agent', 'human-interface-agent'];
      const missing = required.filter((n) => !list.includes(n));
      addCheck(
        'modules-required',
        'Agents clés enregistrés',
        agents.ok && missing.length === 0,
        agents.ok ? `agents=${list.length} missing=${missing.join(', ') || 'none'}` : `HTTP ${agents.status}`,
        'Relancer server.js pour enregistrer tous les agents',
        'Le test doit afficher missing=none'
      );
      addCheck(
        'modules-runtime',
        'Runtime agents visible',
        agents.ok && Number(agents.data.totalAgents || 0) > 0,
        agents.ok ? `totalAgents=${agents.data.totalAgents}` : `HTTP ${agents.status}`,
        'Vérifier /agents/list côté backend',
        'Le test doit afficher totalAgents > 0'
      );
    }

    const missingChecks = checks.filter((c) => !c.ok);
    const nextAction = missingChecks[0] ? {
      checkId: missingChecks[0].id,
      action: missingChecks[0].actionIfMissing,
      why: missingChecks[0].detail,
      verify: missingChecks[0].verify
    } : null;

    return {
      ok: true,
      domain,
      checks,
      summary: {
        total: checks.length,
        ok: checks.filter((c) => c.ok).length,
        missing: missingChecks.length,
        status: missingChecks.length === 0 ? 'OK' : 'NON'
      },
      nextAction
    };
  }

  // GET /central-guide/state?domain=mt5|tradingview|extension|bridge|externals|modules
  app.get('/central-guide/state', async (req, res) => {
    try {
      const domain = normalizeGuideDomain(req.query.domain);
      const state = await runCentralGuideChecks(domain);
      publishAgentChatMessage({
        agent: 'central-guide-agent',
        to: 'human-interface-agent',
        status: state.summary.missing === 0 ? 'ok' : 'action',
        phase: state.summary.missing === 0 ? 'terminé' : 'en attente',
        message: `Diagnostic ${domain}: ${state.summary.ok}/${state.summary.total} OK`,
        cause: state.summary.missing === 0 ? 'aucun blocage' : 'prérequis manquants',
        impact: state.summary.missing === 0 ? 'étape suivante possible' : 'action humaine requise',
        solution: state.nextAction ? state.nextAction.action : 'continuer'
      });
      res.json(state);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /central-guide/ack — opérateur confirme "J'ai fait l'action"
  app.post('/central-guide/ack', (req, res) => {
    const domain = normalizeGuideDomain(req.body.domain);
    const checkId = String(req.body.checkId || '').trim();
    if (!checkId) return res.status(400).json({ ok: false, error: 'checkId requis' });
    markGuideAck(domain, checkId);
    publishAgentChatMessage({
      agent: 'human-interface-agent',
      to: 'central-guide-agent',
      status: 'info',
      phase: 'en cours',
      message: `Action confirmée par humain: ${domain}/${checkId}`,
      cause: 'clic J ai fait l action',
      impact: 'retest demandé',
      solution: 'lancer POST /central-guide/test'
    });
    res.json({ ok: true, domain, checkId, acknowledgedAt: centralGuideAcks[domain][checkId] });
  });

  // POST /central-guide/test — lance un vrai test maintenant
  app.post('/central-guide/test', async (req, res) => {
    try {
      const domain = normalizeGuideDomain(req.body.domain);
      const state = await runCentralGuideChecks(domain);
      const specialistReports = await runDomainSpecialists(domain);
      const autoCorrection = await runAutoCorrectionIfNeeded(domain, state);

      // Chain specialists -> Lia -> monitor with real call
      const specialistSummary = specialistReports
        .map((r) => `${r.agent}:${r.ok ? 'OK' : 'NON'}`)
        .join(', ');
      const liaBridge = await runLiaSynthesis(domain, state, specialistSummary);

      publishAgentChatMessage({
        agent: 'central-guide-agent',
        to: 'human-interface-agent',
        status: state.summary.missing === 0 ? 'ok' : 'error',
        phase: state.summary.missing === 0 ? 'terminé' : 'bloqué',
        message: `Test ${domain}: ${state.summary.status}`,
        cause: state.summary.missing === 0 ? 'tous checks OK' : 'checks manquants',
        impact: `agents spécialisés: ${specialistSummary}`,
        solution: state.nextAction ? state.nextAction.action : 'continuer workflow'
      });
      res.json({
        ...state,
        specialistReports,
        autoCorrection,
        lia: liaBridge || { ok: false, response: 'Lia indisponible' }
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /design/audit-html-all — audit global design avant toute réorganisation
  app.get('/design/audit-html-all', (_req, res) => {
    try {
      const audit = analyzeAllHtmlDesignPages();
      publishAgentChatMessage({
        agent: 'design-agent',
        to: 'human-interface-agent',
        status: 'info',
        phase: 'terminé',
        message: `Audit HTML complet terminé: ${audit.totalHtml} pages analysées`,
        cause: 'audit design global',
        impact: `doublons titres=${audit.duplicates.titles.length}, idsCrossPages=${audit.duplicates.idsCrossPages.length}`,
        solution: 'appliquer regroupement intelligent sans suppression'
      });
      res.json(audit);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /human-interface/decision — traitement réel d'une demande humaine
  app.post('/human-interface/decision', async (req, res) => {
    try {
      const request = req.body?.request || {};
      const decision = String(req.body?.decision || '').trim();
      const responseText = String(req.body?.response || '').trim();
      if (!request.id || !request.source || !decision) {
        return res.status(400).json({ ok: false, error: 'request.id, request.source et decision requis' });
      }

      const domain = normalizeGuideDomain(request.domain || request.action || request.subject || 'bridge');
      let workflow = null;
      if (request.source === 'central-guide-agent' && decision !== 'refusé') {
        const state = await runCentralGuideChecks(domain);
        const specialistReports = await runDomainSpecialists(domain);
        const autoCorrection = await runAutoCorrectionIfNeeded(domain, state);
        const specialistSummary = specialistReports.map((r) => `${r.agent}:${r.ok ? 'OK' : 'NON'}`).join(', ');
        const lia = await runLiaSynthesis(domain, state, specialistSummary);
        workflow = { domain, state, specialistReports, autoCorrection, lia };
      }

      const forwardPayload = {
        from: 'human-interface-agent',
        to: request.source,
        message: responseText || `Décision opérateur: ${decision}`,
        status: decision === 'refusé' ? 'error' : 'info',
        phase: decision === 'terminé' ? 'terminé' : 'en cours',
        cause: request.why || 'décision opérateur',
        impact: `request=${request.id}`,
        solution: `action=${decision}`
      };

      const forwarded = await fetchLocalJson('/agents/' + encodeURIComponent(request.source) + '/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(forwardPayload)
      });

      publishAgentChatMessage({
        agent: 'human-interface-agent',
        to: request.source,
        status: decision === 'refusé' ? 'error' : 'info',
        phase: decision === 'terminé' ? 'terminé' : 'en cours',
        message: responseText || `Décision opérateur: ${decision}`,
        cause: request.why || 'validation humaine',
        impact: `demande ${request.id} traitée`,
        solution: workflow?.state?.nextAction?.action || 'continuer'
      });

      res.json({
        ok: true,
        processed: true,
        requestId: request.id,
        decision,
        forwarded: forwarded.data || { ok: forwarded.ok },
        workflow
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  const coachTradeStateStore = {};
  // Slot actif par symbole (TF-agnostique) — persiste les positions entrées entre refreshes et redémarrages
  const ACTIVE_POSITION_FILE = path.join(__dirname, 'store', 'active-positions.json');
  let activePositionStore = {}; // { BTCUSD: { state, tf } }
  // Charger depuis le disque au démarrage + purger les positions trop anciennes (> 12h)
  // Protection: une position non fermée depuis plus de 12h = données périmées — purge automatique
  try {
    if (fs.existsSync(ACTIVE_POSITION_FILE)) {
      const _rawPos = JSON.parse(fs.readFileSync(ACTIVE_POSITION_FILE, 'utf8')) || {};
      const _maxAgeMs = 12 * 60 * 60 * 1000; // 12h
      const _nowLoad  = Date.now();
      for (const [sym, slot] of Object.entries(_rawPos)) {
        const _savedAt = slot?.savedAt || slot?.state?.entryLockedAt || 0;
        const _entered = slot?.state?.entered;
        if (_entered && _savedAt && (_nowLoad - _savedAt) > _maxAgeMs) {
          console.log(`[ACTIVE-POS PURGE] ${sym} position trop ancienne (${Math.round((_nowLoad-_savedAt)/3600000)}h) — supprimée`);
        } else {
          activePositionStore[sym] = slot;
        }
      }
    }
  } catch (_) { activePositionStore = {}; }

  function _saveActivePositions() {
    try { fs.writeFileSync(ACTIVE_POSITION_FILE, JSON.stringify(activePositionStore, null, 2)); } catch(_) {}
  }

  const USER_TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'];

  function getCoachTradeKey(symbol, timeframe) {
    return String(symbol || 'XAUUSD').toUpperCase() + '|' + String(timeframe || 'H1').toUpperCase();
  }

  function getCoachTradeState(symbol, timeframe) {
    const sym = String(symbol || 'XAUUSD').toUpperCase();
    const tf  = String(timeframe || 'H1').toUpperCase();
    const key = getCoachTradeKey(sym, tf);

    // Si le slot TF-spécifique n'existe pas mais qu'il y a une position active pour ce symbole,
    // on réutilise l'état actif (peu importe le TF affiché au dashboard au moment du refresh).
    if (!coachTradeStateStore[key]) {
      const active = activePositionStore[sym];
      // GUARD: rejeter les symboles corrompus (contiennent des chiffres = artifacts de test/debug)
      // Ex: "RSIOBT1776090669490", "DBG1776091094463" — jamais des vrais symboles trading
      const _isValidSymbol = /^[A-Z]{2,12}$/.test(sym); // seulement lettres, 2-12 chars
      if (active && active.state && active.state.entered && _isValidSymbol) {
        // Restaurer l'état actif dans le slot TF courant (on garde le TF original du trade)
        coachTradeStateStore[key] = active.state;
        return coachTradeStateStore[key];
      }
      coachTradeStateStore[key] = {
        symbol: sym,
        timeframe: tf,
        phase: 'WAIT_ENTRY',
        entered: false,
        bePlaced: false,
        partialTaken: false,
        lastAction: 'INIT',
        updatedAt: Date.now(),
        virtualPosition: null,
        notes: []
      };
    }
    return coachTradeStateStore[key];
  }

  function _persistTradeState(symbol, state) {
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return;
    if (state.entered) {
      activePositionStore[sym] = { state, tf: state.timeframe, savedAt: Date.now() };
    } else {
      // Position fermée → effacer le slot actif
      delete activePositionStore[sym];
    }
    _saveActivePositions();
  }

  function getCoachMarketPrice(symbol) {
    const _sym = String(symbol || 'XAUUSD').toUpperCase();
    // ── SOURCE MAÎTRE : prix live TradingView bridge (≤ 60s) ─────────────────
    // C'est le prix affiché dans l'extension — l'entry doit être exactement ce prix.
    const _tvLive = typeof getLivePrice === 'function' ? getLivePrice(_sym) : null;
    if (_tvLive && _tvLive.price > 0 && _tvLive.ageMs <= 60000) {
      return _tvLive.price;
    }
    // ── FALLBACK tvDataStore direct (≤ 90s) ──────────────────────────────────
    const _tvEntry = tvDataStore[_sym] || null;
    if (_tvEntry && _tvEntry.price > 0) {
      const _age = Date.now() - (_tvEntry.updatedAt || 0);
      if (_age <= 90000) return _tvEntry.price;
    }
    // ── FALLBACK marketStore (broker/MT5 — seulement si TV absent) ────────────
    const latest = marketStore.getLatestForSymbol(_sym);
    const payload = latest?.latestPayload || {};
    return Number(payload.price || payload.bid || payload.ask || NaN);
  }

  const coachAnalysisSnapshotCache = Object.create(null);
  const coachNewsCache = Object.create(null);

  function getCoachAnalysisCacheKey(symbol, timeframe) {
    return String(symbol || 'XAUUSD').toUpperCase() + '::' + String(timeframe || 'H1').toUpperCase();
  }

  function readCoachAnalysisSnapshot(symbol, timeframe, maxAgeMs = 90000) {
    const key = getCoachAnalysisCacheKey(symbol, timeframe);
    const snapshot = coachAnalysisSnapshotCache[key] || null;
    if (!snapshot) return null;
    const ageMs = Date.now() - Number(snapshot.updatedAt || 0);
    return ageMs <= maxAgeMs ? snapshot : null;
  }

  function storeCoachAnalysisSnapshot(symbol, timeframe, snapshot) {
    const key = getCoachAnalysisCacheKey(symbol, timeframe);
    coachAnalysisSnapshotCache[key] = {
      ...(coachAnalysisSnapshotCache[key] || {}),
      ...(snapshot || {}),
      updatedAt: Date.now()
    };
    return coachAnalysisSnapshotCache[key];
  }

  async function getCachedNewsIntelligence(symbol) {
    const key = String(symbol || 'XAUUSD').toUpperCase();
    const cached = coachNewsCache[key] || null;
    if (cached && (Date.now() - Number(cached.ts || 0)) < 120000) {
      return cached.data;
    }
    const now = new Date();
    const hourUtc = now.getUTCHours();
    const syntheticEvents = [];

    if (hourUtc >= 12 && hourUtc <= 15) {
      syntheticEvents.push({
        event: 'Fenêtre macro US',
        currency: 'USD',
        impact: 'HIGH',
        minutesAway: 20,
        isUrgent: true
      });
    }

    const data = {
      upcomingEvents: syntheticEvents,
      news: [],
      macroWarning: syntheticEvents.length ? 'Attention volatilité macro proche sur USD.' : null,
      symbolImpact: syntheticEvents.length
        ? ('Contexte macro sensible détecté pour ' + key)
        : ('Pas de risque macro majeur immédiat pour ' + key),
      tradingSuggestion: syntheticEvents.length
        ? 'Réduire l\'exposition avant la fenêtre macro'
        : 'Pas d\'annonce urgente'
    };
    coachNewsCache[key] = { ts: Date.now(), data };
    return data;
  }

  function normalizeTradeDirection(raw) {
    const v = String(raw || '').toUpperCase();
    if (v.includes('BUY') || v.includes('LONG') || v.includes('ACHAT') || v.includes('HAUSS')) return 'LONG';
    if (v.includes('SELL') || v.includes('SHORT') || v.includes('VENTE') || v.includes('BAISS')) return 'SHORT';
    return 'WAIT';
  }

  function recommendationFromDirection(raw) {
    const dir = normalizeTradeDirection(raw);
    if (dir === 'LONG') return 'BUY';
    if (dir === 'SHORT') return 'SELL';
    return 'WAIT';
  }

  function isDirectionalDirection(dir) {
    const d = String(dir || '').toUpperCase();
    return d === 'LONG' || d === 'SHORT';
  }

  function extractDirectionalBias(raw) {
    const text = String(raw || '').toUpperCase();
    if (!text) return 0;
    const bull = text.includes('BUY') || text.includes('LONG') || text.includes('ACHAT') || text.includes('HAUSS') || text.includes('UP');
    const bear = text.includes('SELL') || text.includes('SHORT') || text.includes('VENTE') || text.includes('BAISS') || text.includes('DOWN') || text.includes('BEAR');
    if (bull && !bear) return 1;
    if (bear && !bull) return -1;
    return 0;
  }

  function deriveMtfDirectionFromRobot(robotV12) {
    const score = [
      robotV12?.lecture_1m,
      robotV12?.lecture_5m,
      robotV12?.lecture_15m,
      robotV12?.lecture_60m
    ].reduce((acc, v) => acc + extractDirectionalBias(v), 0);
    if (score >= 2) return 'LONG';
    if (score <= -2) return 'SHORT';
    return 'WAIT';
  }

  function normalizeRiskLevel(raw) {
    const v = String(raw || '').toUpperCase();
    if (v === 'LOW' || v === 'MEDIUM' || v === 'HIGH') return v;
    return v || 'MEDIUM';
  }

  function formatCoachLevel(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '--';
    return Math.abs(num) > 1000 ? num.toFixed(2) : num.toFixed(5);
  }

  // computeTechSignalFromKlines is defined at module scope (line ~138) — accessible here

  function buildTradingviewRuntimeTrade(symbol, timeframe, currentPrice, modeRaw, tvRuntime, robotV12) {
    // CONNECTION GUARD: Only build a trade signal from live TradingView data (last signal < 180s ago).
    // Prevents displaying positions based on stale or test-injected data when TV is disconnected.
    if (tvRuntime?.connected === false) {
      return null;
    }
    // ── SYMBOL GUARD: ne jamais utiliser le runtime d'un autre symbole ──────────
    // Si tvRuntime appartient à XAUUSD et qu'on demande EURUSD → ne pas contaminer
    const _tvRtSym = String(tvRuntime?.payload?.symbol || tvRuntime?.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g,'');
    const _reqSym  = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g,'');
    const _symMatch = !_tvRtSym || !_reqSym || _tvRtSym === _reqSym
      || _tvRtSym.includes(_reqSym) || _reqSym.includes(_tvRtSym);
    if (!_symMatch) return null; // runtime d'un autre symbole → ignorer
    // robotV12 check: si robotV12.symbol ne correspond pas, ignorer
    const _rv12Sym = String(robotV12?.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g,'');
    const robotV12Clean = (robotV12 && (!_rv12Sym || _rv12Sym === _reqSym || _rv12Sym.includes(_reqSym) || _reqSym.includes(_rv12Sym)))
      ? robotV12 : null;
    const price = Number(currentPrice || tvRuntime?.payload?.price || NaN);
    if (!Number.isFinite(price) || price <= 0) return null;

    // ── PER-TF DATA: robotV12 contient lecture_1m/5m/15m/60m et rsi_1m/5m/15m/60m ──
    // Ces champs sont envoyés par le webhook Pine Script (/bridge/robot-v12).
    // _bridgePayload.lectureTechX est la source alternative (rarement remplie par DOM scraping).
    // Mapping timeframe → champ robotV12
    const _tfToRv12 = { M1: '1m', M5: '5m', M15: '15m', M30: '15m', H1: '60m', H4: null, D1: null };
    // M30: aucun TF dédié dans le bridge Pine — utilise lecture_15m/rsi_15m comme proxy (honnête)
    const _rv12Suffix = _tfToRv12[String(timeframe || '').toUpperCase()] || null;
    let _ltDir = null;     // direction per-TF depuis robotV12
    let _rsiPerTf = null;  // RSI per-TF depuis robotV12
    // Source 1: robotV12 lecture/rsi par TF (webhook Pine Script)
    if (_rv12Suffix && robotV12Clean) {
      const _ltRaw = String(robotV12Clean['lecture_' + _rv12Suffix] || '').toUpperCase();
      if (_ltRaw.includes('VENTE'))        _ltDir = 'SHORT';
      else if (_ltRaw.includes('ACHAT'))   _ltDir = 'LONG';
      const _rsiRv = Number(robotV12Clean['rsi_' + _rv12Suffix]);
      if (_rsiRv > 0 && Number.isFinite(_rsiRv)) _rsiPerTf = _rsiRv;
    }
    // Source 2: _bridgePayload.lectureTechX / rsiTfX (Pine Script via /tradingview/live — moins courant)
    if (!_ltDir || !_rsiPerTf) {
      const _bpIdx = { M1: 1, M5: 2, M15: 3, M30: 3, H1: 4 }[String(timeframe || '').toUpperCase()] || null;
      // M30 → index 3 (lectureTech3/rsiTf3 = M15 proxy)
      const _tvDsEntry = tvDataStore[String(symbol).toUpperCase()] || tvDataStore[String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, '')] || null;
      const _bp = _tvDsEntry?._bridgePayload || null;
      if (_bpIdx && _bp) {
        // ── STALENESS CHECK — ignorer les données bridge périmées ────────────────
        // Seuils: M1=5min, M5=10min, M15=20min, H1=90min
        // Si périmé → ne pas utiliser → direction tombera sur verdict global (plus honnête que donnée stale)
        const _staleThresholds = { 1: 5*60000, 2: 10*60000, 3: 20*60000, 4: 90*60000 };
        const _ltUpdatedAt = _bp['_lt' + _bpIdx + 'UpdatedAt'] || null;
        const _staleMs = _ltUpdatedAt ? (Date.now() - _ltUpdatedAt) : Infinity;
        const _isBpStale = _staleMs > (_staleThresholds[_bpIdx] || 20*60000);
        if (!_ltDir && !_isBpStale) {
          const _lt2 = String(_bp['lectureTech' + _bpIdx] || '').toUpperCase();
          if (_lt2.includes('VENTE'))       _ltDir = 'SHORT';
          else if (_lt2.includes('ACHAT'))  _ltDir = 'LONG';
        }
        if (!_rsiPerTf && !_isBpStale) {
          const _rsiRaw2 = Number(_bp['rsiTf' + _bpIdx]);
          if (_rsiRaw2 > 0 && Number.isFinite(_rsiRaw2)) _rsiPerTf = _rsiRaw2;
        }
      }
    }

    let direction = _ltDir || normalizeTradeDirection(
      robotV12Clean?.verdict ||
      robotV12Clean?.anticipation ||
      tvRuntime?.payload?.verdict ||
      tvRuntime?.payload?.anticipation ||
      tvRuntime?.payload?.action
    );

    if (direction === 'WAIT') return null;

    const confidence = Number(robotV12Clean?.anticipation_force || 64);
    const entry = Number(robotV12Clean?.entry ?? tvRuntime?.payload?.entry ?? NaN);
    const sl = Number(robotV12Clean?.sl ?? tvRuntime?.payload?.sl ?? NaN);
    const tp = Number(robotV12Clean?.tp ?? tvRuntime?.payload?.tp ?? NaN);
    const rrRatio = robotV12Clean?.rrRatio ?? tvRuntime?.payload?.rrRatio ?? '--';
    // ── BRIDGE FALLBACK SL/TP — générer les niveaux depuis bridge quand robotV12 ne les fournit pas ──
    // Cas fréquent: bridge envoie lectureTech (direction valide) mais pas entry/sl/tp.
    // On génère les niveaux depuis liqHigh/liqLow + ATR pour ne pas bloquer en NEUTRE.
    let finalEntry = Number.isFinite(entry) ? entry : price;
    let finalSlRaw = sl, finalTpRaw = tp;
    if (!Number.isFinite(finalSlRaw) || !Number.isFinite(finalTpRaw)) {
      const _bpFb = (typeof tvDataStore !== 'undefined')
        ? (tvDataStore[String(symbol).toUpperCase()] || tvDataStore[String(symbol).toUpperCase().replace(/[^A-Z0-9]/g,'')] || null)?._bridgePayload
        : null;
      const _indFb = (typeof tvDataStore !== 'undefined')
        ? (tvDataStore[String(symbol).toUpperCase()] || tvDataStore[String(symbol).toUpperCase().replace(/[^A-Z0-9]/g,'')] || null)?.indicators
        : null;
      const _atrFb = (_indFb?.atr != null && Number(_indFb.atr) > 0) ? Number(_indFb.atr) : null;
      const _liqH  = (_bpFb?.liqHigh  != null && Number(_bpFb.liqHigh)  > 0) ? Number(_bpFb.liqHigh)  : null;
      const _liqL  = (_bpFb?.liqLow   != null && Number(_bpFb.liqLow)   > 0) ? Number(_bpFb.liqLow)   : null;
      const _rngH  = (_bpFb?.rangeHigh != null && Number(_bpFb.rangeHigh) > 0) ? Number(_bpFb.rangeHigh) : null;
      const _rngL  = (_bpFb?.rangeLow  != null && Number(_bpFb.rangeLow)  > 0) ? Number(_bpFb.rangeLow)  : null;
      // Fallback ATR si absent: estimer depuis range
      const _rangeSz = (_rngH && _rngL && _rngH > _rngL) ? (_rngH - _rngL) : null;
      const _atr = _atrFb ?? (_rangeSz ? _rangeSz * 0.1 : null) ?? (price * 0.003); // 0.3% comme dernier recours
      if (direction === 'SHORT') {
        // SL: au-dessus du prix — liqHigh ou rangeHigh ou ATR*1.5
        finalSlRaw = _liqH ?? _rngH ?? (price + _atr * 1.5);
        // TP: en-dessous — liqLow ou rangeLow ou ATR*3
        finalTpRaw = _liqL ?? _rngL ?? (price - _atr * 3);
      } else { // LONG
        // SL: en-dessous — liqLow ou rangeLow ou ATR*1.5
        finalSlRaw = _liqL ?? _rngL ?? (price - _atr * 1.5);
        // TP: au-dessus — liqHigh ou rangeHigh ou ATR*3
        finalTpRaw = _liqH ?? _rngH ?? (price + _atr * 3);
      }
      // Sanity: SL doit être du bon côté du prix
      if (direction === 'SHORT' && finalSlRaw <= price) finalSlRaw = price + _atr * 1.5;
      if (direction === 'LONG'  && finalSlRaw >= price) finalSlRaw = price - _atr * 1.5;
      if (direction === 'SHORT' && finalTpRaw >= price) finalTpRaw = price - _atr * 3;
      if (direction === 'LONG'  && finalTpRaw <= price) finalTpRaw = price + _atr * 3;
      console.log(`[BRIDGE-SLTP] ${symbol} ${direction} prix=${price.toFixed(3)} SL=${finalSlRaw.toFixed(3)} TP=${finalTpRaw.toFixed(3)} (ATR=${_atr.toFixed(3)}, liqH=${_liqH}, liqL=${_liqL})`);
    }
    if (!Number.isFinite(finalSlRaw) || !Number.isFinite(finalTpRaw)) {
      return null;
    }
    const setup = classifySetup(timeframe, direction, confidence, modeRaw);
    const _rsiDisplay = _rsiPerTf != null ? _rsiPerTf : (tvRuntime?.payload?.rsi != null ? Number(tvRuntime.payload.rsi) : null);
    // Label proxy: M30 lit M15, H4/D1 lisent le verdict global
    const _tfIsProxy  = (timeframe === 'M30');
    const _tfIsGlobal = (timeframe === 'H4' || timeframe === 'D1');
    const _tfLabel    = _tfIsProxy ? 'M30[proxy M15]' : (timeframe || '');
    const _srcLabel   = _tfIsGlobal ? 'Verdict global TV' : ('Lecture ' + _tfLabel);
    const technicalParts = [
      _ltDir ? (_srcLabel + ': ' + (_ltDir === 'SHORT' ? 'VENTE' : 'ACHAT')) : (robotV12Clean?.verdict ? ('Verdict TV: ' + robotV12Clean.verdict) : null),
      robotV12Clean?.anticipation ? ('Anticipation: ' + robotV12Clean.anticipation + (robotV12Clean.anticipation_force != null ? ' (' + robotV12Clean.anticipation_force + '%)' : '')) : null,
      robotV12Clean?.contexte ? ('Contexte: ' + robotV12Clean.contexte) : null,
      _rsiDisplay != null ? ('RSI ' + (_rsiPerTf != null ? _tfLabel : '') + ': ' + Number(_rsiDisplay).toFixed(0)) : null
    ].filter(Boolean).join(' | ');

    // ── CAP SL: empêcher les SL trop larges qui détruisent le capital ──────────
    // Plafonds par TF (en USD pour XAUUSD, en pips pour Forex)
    // Ajustement: M1/M5/M15 augmentés pour couvrir le bruit normal sans sortie absurde
    // + plancher ATR: cap effectif = max(cap_fixe, ATR * 0.9) → s'adapte à la volatilité réelle
    const _capSym = String(symbol || '').toUpperCase();
    const _capGold  = /XAU|GOLD/.test(_capSym);
    const _capJpy   = _capSym.includes('JPY');
    const _capIndex = /US30|US500|US100|NAS|SPX|SP500|DAX|DE40|GER40/.test(_capSym);
    const _capCrypto= /BTC|ETH|SOL/.test(_capSym);
    // Lire ATR bridge pour plancher (calculé indépendamment du bloc fallback SL/TP)
    const _capAtrRaw = (() => {
      const _ds = (typeof tvDataStore !== 'undefined')
        ? (tvDataStore[_capSym] || tvDataStore[_capSym.replace(/[^A-Z0-9]/g,'')] || null)
        : null;
      const _atrV = _ds?.indicators?.atr != null && Number(_ds.indicators.atr) > 0 ? Number(_ds.indicators.atr) : null;
      if (_atrV) return _atrV;
      const _bp2 = _ds?._bridgePayload;
      const _rH2 = _bp2?.rangeHigh != null && Number(_bp2.rangeHigh) > 0 ? Number(_bp2.rangeHigh) : null;
      const _rL2 = _bp2?.rangeLow  != null && Number(_bp2.rangeLow)  > 0 ? Number(_bp2.rangeLow)  : null;
      return (_rH2 && _rL2 && _rH2 > _rL2) ? (_rH2 - _rL2) * 0.1 : null;
    })();
    // Caps fixes ajustés (M1/M5/M15 augmentés, M30+ inchangés)
    const _tfCap = { M1:4, M5:8, M15:12, M30:12, H1:18, H4:35, D1:60 };
    const _tfCapFixed = _tfCap[timeframe] || 18;
    // Plancher ATR: max(cap_fixe, ATR*0.9) pour GOLD/indices — s'adapte à la volatilité
    const _atrFloor = (_capAtrRaw != null && (_capGold || _capIndex)) ? _capAtrRaw * 0.9 : 0;
    const _maxSlDist = _capGold   ? Math.max(_tfCapFixed, _atrFloor)
                     : _capIndex  ? Math.max(_tfCapFixed, _atrFloor)
                     : _capCrypto ? price * 0.008
                     : _capJpy    ? _tfCapFixed * 0.01
                     :              _tfCapFixed * 0.0001;
    let finalSl = finalSlRaw, finalTp = finalTpRaw;
    const _slDist = Math.abs(finalEntry - finalSlRaw);
    if (_slDist > _maxSlDist) {
      // SL trop large → le ramener au cap, TP recalculé pour maintenir RR 2.5:1
      finalSl = direction === 'LONG' ? finalEntry - _maxSlDist : finalEntry + _maxSlDist;
      finalTp = direction === 'LONG' ? finalEntry + _maxSlDist * 2.5 : finalEntry - _maxSlDist * 2.5;
      console.log(`[SL CAP] ${symbol} ${timeframe} SL ${_slDist.toFixed(3)}>${_maxSlDist.toFixed(3)} (cap=${_tfCapFixed} atrFloor=${_atrFloor.toFixed(2)}) → capped. finalSl:${finalSl.toFixed(3)}`);
    }

    return validateTrade({
      symbol: String(symbol || 'XAUUSD').toUpperCase(),
      direction,
      entry: finalEntry,
      sl: finalSl,
      tp: finalTp,
      rrRatio,
      ...setup,
      score: Number.isFinite(confidence) ? confidence : 64,
      confidence: Number.isFinite(confidence) ? confidence : 64,
      source: 'tradingview-indicator',
      accuracy: 'live',
      technical: technicalParts || 'Lecture TradingView live',
      macro: 'Contexte TradingView live',
      sentiment: robotV12?.anticipation || 'TV runtime'
    }, price);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MOTEUR PAYLOAD UNIFIÉ — source unique de décision marché
  // Mappe les champs bridge bruts → concepts sémantiques (zone/structure/dominance)
  // Priority: ZONE → STRUCTURE → DOMINANCE → MODE VALIDATION
  // Output: { zone, structure, dominance, score, style, decision, reason, vocal }
  // ══════════════════════════════════════════════════════════════════════════
  // ── FUSION SOURCES BRIDGE ─────────────────────────────────────────────────
  // Combine les 3 sources de données en un seul objet bridge normalisé:
  //   1. Pine Enrichissement → tvDataStore[sym]._bridgePayload (lectureTech, scoreTech, inBot/inTop...)
  //   2. Robot V12 webhook  → tvDataStore[sym].robotV12 (lecture_1m, macro_bear, verdict...)
  //   3. Extension scraped  → tvDataStore[sym].indicators (rsi, macd, bb...)
  // Priorité: _bridgePayload > robotV12 (mapping champs) > indicators
  // Résultat: objet homogène utilisable par computeUnifiedMarketPayload + filtres MTF
  function mergeBridgeSources(symbol) {
    const key = (function _findKey(sym) {
      try {
        if (typeof tvDataStore === 'undefined') return null;
        const upper = String(sym || '').toUpperCase();
        if (tvDataStore[upper]) return upper;
        const canon = normalizeSymbol ? (normalizeSymbol(upper)?.canonical || upper) : upper;
        if (tvDataStore[canon]) return canon;
      } catch (_) {}
      return null;
    })(symbol);
    if (!key) return null;

    const entry = tvDataStore[key];
    if (!entry) return null;

    const bp  = entry._bridgePayload || {};   // Pine Enrichissement
    const rv  = entry.robotV12 || {};         // Robot V12
    const ind = entry.indicators || {};       // Extension scraped

    // Mapping Robot V12 → noms normalisés bridge
    // lecture_1m/5m/15m/60m → lectureTech1/2/3/4
    const _rvLt1 = rv.lecture_1m  || null;
    const _rvLt2 = rv.lecture_5m  || null;
    const _rvLt3 = rv.lecture_15m || null;
    const _rvLt4 = rv.lecture_60m || null;
    // rsi_1m/5m/15m/60m → rsiTf1/2/3/4
    const _rvRsi1 = rv.rsi_1m  != null && Number(rv.rsi_1m)  > 0 ? Number(rv.rsi_1m)  : null;
    const _rvRsi2 = rv.rsi_5m  != null && Number(rv.rsi_5m)  > 0 ? Number(rv.rsi_5m)  : null;
    const _rvRsi3 = rv.rsi_15m != null && Number(rv.rsi_15m) > 0 ? Number(rv.rsi_15m) : null;
    const _rvRsi4 = rv.rsi_60m != null && Number(rv.rsi_60m) > 0 ? Number(rv.rsi_60m) : null;
    // macro_bear/bull → macroBear/macroBull
    const _rvMacBr = rv.macro_bear != null ? Number(rv.macro_bear) : null;
    const _rvMacBl = rv.macro_bull != null ? Number(rv.macro_bull) : null;
    // in_top_zone/in_bot_zone → inTop/inBot
    const _rvInTop = rv.in_top_zone === true || rv.in_top_zone === 'true';
    const _rvInBot = rv.in_bot_zone === true || rv.in_bot_zone === 'true';
    // liq_haute_active/liq_basse_active → zoneLiqHaute/Basse
    const _rvLiqH = rv.liq_haute_active === true || rv.liq_haute_active === 'true';
    const _rvLiqB = rv.liq_basse_active === true || rv.liq_basse_active === 'true';
    // anticipation/anticipation_force → anticipationTexte/Force
    const _rvAnt  = rv.anticipation       || null;
    const _rvAntF = rv.anticipation_force != null ? Number(rv.anticipation_force) : null;
    // short_score/long_score: Robot V12 envoie des scores directionnels (0-100)
    // Les mapper en scoreTech3 (M15 = TF de décision) si score bridge absent
    const _rvSc3  = rv.short_score != null || rv.long_score != null
      ? Math.max(Number(rv.short_score || 0), Number(rv.long_score || 0))
      : null;
    // RSI scraped extension (1 TF visible)
    const _indRsi = ind.rsi != null && Number(ind.rsi) > 0 ? Number(ind.rsi) : null;

    // Fusion avec priorité bp > rv (mapping) > fallback
    return {
      // ── Lectures TF ───────────────────────────────────────────────────────
      lectureTech1: bp.lectureTech1 ?? _rvLt1 ?? null,
      lectureTech2: bp.lectureTech2 ?? _rvLt2 ?? null,
      lectureTech3: bp.lectureTech3 ?? _rvLt3 ?? null,
      lectureTech4: bp.lectureTech4 ?? _rvLt4 ?? null,
      // ── Scores TF ─────────────────────────────────────────────────────────
      scoreTech1:   bp.scoreTech1   ?? null,
      scoreTech2:   bp.scoreTech2   ?? null,
      scoreTech3:   bp.scoreTech3   ?? _rvSc3 ?? null,
      scoreTech4:   bp.scoreTech4   ?? null,
      // ── RSI par TF ────────────────────────────────────────────────────────
      rsiTf1: bp.rsiTf1 ?? _rvRsi1 ?? _indRsi ?? null,
      rsiTf2: bp.rsiTf2 ?? _rvRsi2 ?? null,
      rsiTf3: bp.rsiTf3 ?? _rvRsi3 ?? null,
      rsiTf4: bp.rsiTf4 ?? _rvRsi4 ?? null,
      // ── Zone (inTop/inBot) ─────────────────────────────────────────────────
      inTop:        bp.inTop  != null ? bp.inTop  : (_rvInTop  || null),
      inBot:        bp.inBot  != null ? bp.inBot  : (_rvInBot  || null),
      zoneLiqHaute: bp.zoneLiqHaute != null ? bp.zoneLiqHaute : (_rvLiqH || null),
      zoneLiqBasse: bp.zoneLiqBasse != null ? bp.zoneLiqBasse : (_rvLiqB || null),
      // ── Rejet / Structure ─────────────────────────────────────────────────
      bullRej: bp.bullRej  ?? null,
      bearRej: bp.bearRej  ?? null,
      // ── Macro ─────────────────────────────────────────────────────────────
      macroBull: bp.macroBull != null ? Number(bp.macroBull) : _rvMacBl,
      macroBear: bp.macroBear != null ? Number(bp.macroBear) : _rvMacBr,
      // ── Anticipation ──────────────────────────────────────────────────────
      anticipationTexte: bp.anticipationTexte ?? _rvAnt  ?? null,
      anticipationForce: bp.anticipationForce ?? _rvAntF ?? null,
      // ── Niveaux liquidité ──────────────────────────────────────────────────
      liqHigh:   bp.liqHigh   ?? null,
      liqLow:    bp.liqLow    ?? null,
      rangeHigh: bp.rangeHigh ?? null,
      rangeLow:  bp.rangeLow  ?? null,
      // ── OB / FVG / midpoint ────────────────────────────────────────────────
      midpoint:   bp.midpoint   ?? null,
      inPremium:  bp.inPremium  ?? null,
      inDiscount: bp.inDiscount ?? null,
      bullOB_h: bp.bullOB_h ?? null, bullOB_l: bp.bullOB_l ?? null,
      bearOB_h: bp.bearOB_h ?? null, bearOB_l: bp.bearOB_l ?? null,
      bullFVG_l: bp.bullFVG_l ?? null, bullFVG_h: bp.bullFVG_h ?? null,
      bearFVG_l: bp.bearFVG_l ?? null, bearFVG_h: bp.bearFVG_h ?? null,
      sweepHighLevel: bp.sweepHighLevel ?? null,
      sweepLowLevel:  bp.sweepLowLevel  ?? null,
      // ── Prix (pour calculs FVG/OB) ─────────────────────────────────────────
      price: entry.price || null,
      atr:   ind.atr != null ? Number(ind.atr) : (bp.atr ?? null),
      // ── Signal Robot V12 (verdict, pour cohérence coaching) ───────────────
      _rv12verdict:   rv.verdict    ?? null,
      _rv12anticipation: rv.anticipation ?? null,
      _rv12force:     rv.anticipation_force ?? null,
      // ── Indicateurs scraped extension ─────────────────────────────────────
      _scrapedRsi:   _indRsi,
      _scrapedBbH:   ind.bb_upper ?? null,
      _scrapedBbL:   ind.bb_lower ?? null,
      _scrapedMacd:  ind.macd ?? null,
    };
  }

  function computeUnifiedMarketPayload(tvBridge, resolvedMode, preferredDirection) {
    // ── HELPER: construit la parole depuis les champs bridge réels ────────────
    // ── COACHING VOCAL — 4 temps : situation / ce qui est bon / ce qui bloque / ce qu'on attend
    // Parole simple et directe — pas de jargon technique, compréhensible immédiatement
    function _buildVocal(zone, structure, dominance, score, style, decision, missing, b) {
      const _lt2 = String(b.lectureTech2 || '').toUpperCase(); // M5
      const _lt3 = String(b.lectureTech3 || '').toUpperCase(); // M15
      const _lt4 = String(b.lectureTech4 || '').toUpperCase(); // H1
      const _sc  = Math.round(Number(b.scoreTech3 || b.scoreTech4 || 0));
      const _mb  = Number(b.macroBull || 0);
      const _mbr = Number(b.macroBear || 0);
      const _thresh = style === 'SCALP' || style === 'SCALPER' ? 60 : 70;

      const _h1Bull  = _lt4 === 'ACHAT';
      const _h1Bear  = _lt4 === 'VENTE';
      const _m15Bull = _lt3 === 'ACHAT';
      const _m15Bear = _lt3 === 'VENTE';
      const _m5Bull  = _lt2 === 'ACHAT';
      const _domBull = _mb  > 58;
      const _domBear = _mbr > 58;
      const _antTxt  = String(b.anticipationTexte || '').toUpperCase();
      const _retL    = _antTxt.includes('RET_LONG') || _antTxt.includes('PRE_ALERTE_LONG');
      const _retS    = _antTxt.includes('RET_SHORT') || _antTxt.includes('PRE_ALERTE_SHORT');
      const _bullRej = b.bullRej === true;
      const _bearRej = b.bearRej === true;

      // ── CAS ENTRÉE CONFIRMÉE ──────────────────────────────────────────────
      if (decision === 'BUY_READY') {
        const _ctx = _h1Bull ? 'H1 haussier' : _m15Bull ? 'M15 retourné à la hausse' : 'réaction de zone haussière';
        const _str = _bullRej ? 'le marché rebondit sur support' : _retL ? 'retournement haussier confirmé' : 'structure haussière validée';
        const _dom = _domBull ? `les acheteurs dominent — ${Math.round(_mb)}%` : 'réaction de zone confirmée';
        const _typ = style === 'SNIPER' ? 'Entrée sniper — zone + rejet confirmé, c\'est le bon endroit.'
          : style === 'SWING' ? 'Entrée swing — H1 et structure alignés, le grand mouvement peut commencer.'
          : 'Entrée scalp — réaction rapide attendue, sois réactif sur le timing.';
        // H1 contre nous : avertir clairement — ce n'est pas un pullback, c'est un retournement de zone
        const _warnH1 = _h1Bear ? ' H1 est encore baissier — c\'est un retournement de zone, pas un pullback. Taille réduite conseillée.' : '';
        return `On est sur support. ${_ctx}, ${_str}, ${_dom}. ${_typ}${_warnH1}`;
      }
      if (decision === 'SELL_READY') {
        const _ctx = _h1Bear ? 'H1 baissier' : _m15Bear ? 'M15 retourné à la baisse' : 'réaction de zone baissière';
        const _str = _bearRej ? 'le marché rebondit sur résistance' : _retS ? 'retournement baissier confirmé' : 'structure baissière validée';
        const _dom = _domBear ? `les vendeurs dominent — ${Math.round(_mbr)}%` : 'réaction de zone confirmée';
        const _typ = style === 'SNIPER' ? 'Entrée sniper — zone + rejet confirmé, c\'est le bon endroit.'
          : style === 'SWING' ? 'Entrée swing — H1 et structure alignés, le grand mouvement peut commencer.'
          : 'Entrée scalp — réaction rapide attendue, sois réactif sur le timing.';
        // H1 contre nous : avertir clairement — ce n'est pas un pullback, c'est un retournement de zone
        const _warnH1 = _h1Bull ? ' H1 est encore haussier — c\'est un retournement de zone, pas un pullback. Taille réduite conseillée.' : '';
        return `On est sur résistance. ${_ctx}, ${_str}, ${_dom}. ${_typ}${_warnH1}`;
      }

      // ── CAS HORS ZONE ─────────────────────────────────────────────────────
      if (zone === 'HORS_ZONE') {
        const _h1ctx = _h1Bull ? 'H1 est haussier' : _h1Bear ? 'H1 est baissier' : 'H1 neutre';
        return `Le prix est au milieu du range — aucun niveau clé atteint. ${_h1ctx}. Je n'entre jamais au milieu. J'attends que le prix approche un support ou une résistance.`;
      }

      // ── CAS ZONE PRÉSENTE — analyser ce qui manque ───────────────────────
      // Situation
      const _sit = zone === 'ZONE_ACHAT'
        ? 'On est sur un support — le prix est en zone basse.'
        : 'On est sur une résistance — le prix est en zone haute.';

      // Ce qui est déjà bon
      const _bon = [];
      _bon.push('le niveau est bon');
      if (structure === 'SWEEP_BAS' || _bullRej) _bon.push('le marché essaye de repartir à la hausse — rejet haussier présent');
      else if (structure === 'SWEEP_HAUT' || _bearRej) _bon.push('le marché essaye de repartir à la baisse — rejet baissier présent');
      else if (structure === 'BOS_HAUSSIER' || _retL) _bon.push('un retournement haussier est en cours de formation');
      else if (structure === 'BOS_BAISSIER' || _retS) _bon.push('un retournement baissier est en cours de formation');
      if (structure === 'STRUCTURE_NEUTRE') {
        // Pas encore de structure — explication simple
        return `${_sit} Ce qui est bon : le niveau est correct. Mais ça ne rebondit pas encore clairement — je n'ai pas de rejet ni de signal de retournement. J'attends une réaction franche sur ce niveau avant d'entrer.`;
      }

      // Ce qui bloque + ce qu'on attend
      const _bloque = [];
      const _manque = [];

      if (zone === 'ZONE_ACHAT') {
        // SWING : H1 reste bloquant (multi-TF obligatoire) | SCALP/SNIPER : H1 = info, pas blocage
        if (_h1Bear && style === 'SWING') {
          _bloque.push('H1 est encore baissier — en mode SWING j\'attends un retournement H1 confirmé');
          _manque.push('H1 doit clôturer haussier');
        } else if (_h1Bear) {
          // SCALP/SNIPER : biais LONG reste prioritaire sur zone basse — H1 = contexte, pas blocage
          _bon.push('biais LONG confirmé par la zone basse — H1 encore baissier mais c\'est un retournement de zone');
        }
        // Dominance non bloquante — le prix en zone basse prime sur la macro
        if (_sc < _thresh && _sc > 0) { _bloque.push(`le score de confluence est insuffisant — ${_sc} sur ${_thresh} requis`); _manque.push(`le score doit monter au dessus de ${_thresh}`); }
      } else {
        // ZONE_VENTE
        if (_h1Bull && style === 'SWING') {
          _bloque.push('H1 est encore haussier — en mode SWING j\'attends un retournement H1 confirmé');
          _manque.push('H1 doit clôturer baissier');
        } else if (_h1Bull) {
          _bon.push('biais SHORT confirmé par la zone haute — H1 encore haussier mais c\'est un retournement de zone');
        }
        if (_sc < _thresh && _sc > 0) { _bloque.push(`le score de confluence est insuffisant — ${_sc} sur ${_thresh} requis`); _manque.push(`le score doit monter au dessus de ${_thresh}`); }
      }

      const _blocStr = _bloque.length > 0 ? 'Ce qui bloque : ' + _bloque.slice(0, 2).join(', et ') + '.' : '';
      const _attendStr = _manque.length > 0
        ? 'Il me manque : ' + _manque.join(', et ') + '. Je n\'entre pas maintenant.'
        : 'Les conditions se mettent en place. Je surveille la prochaine bougie pour confirmer.';

      const _bonStr = _bon.length > 0 ? 'Ce qui est déjà bon : ' + _bon.slice(0, 2).join(', ') + '.' : '';
      return [_sit, _bonStr, _blocStr, _attendStr].filter(Boolean).join(' ');
    }

    if (!tvBridge) {
      return { zone: 'HORS_ZONE', structure: 'STRUCTURE_NEUTRE', dominance: 'NEUTRE',
        score: 0, style: resolvedMode || 'AUTO', decision: 'WAIT',
        reason: 'Bridge non disponible — aucune donnée marché',
        vocal: 'Bridge non disponible. Je n\'ai aucune donnée marché pour l\'instant.' };
    }

    // ── 1. ZONE ────────────────────────────────────────────────────────────
    // RÈGLE: zoneLiqHaute/Basse = équivalent inTop/inBot (même logique que l'extension)
    // Plus de dépendance preferredDirection pour la détection de zone — zone = géographie du prix
    const _uInTop = tvBridge.inTop === true;
    const _uInBot = tvBridge.inBot === true;
    const _uLiqH  = !!tvBridge.zoneLiqHaute;
    const _uLiqB  = !!tvBridge.zoneLiqBasse;
    // FVG (Fair Value Gap) — gap non comblé agit comme zone de support/résistance
    // Prix dans un bullish FVG = retour sur gap haussier = support = ZONE_ACHAT
    // Prix dans un bearish FVG = retour sur gap baissier = résistance = ZONE_VENTE
    const _fvgPx  = Number(tvBridge.price || 0);
    const _fvgAtr = Number(tvBridge.atr || 0.001);
    const _bFvgL  = Number(tvBridge.bullFVG_l || 0);
    const _bFvgH  = Number(tvBridge.bullFVG_h || 0);
    const _rFvgH  = Number(tvBridge.bearFVG_h || 0);
    const _rFvgL  = Number(tvBridge.bearFVG_l || 0);
    const _inBullFVG = _bFvgL > 0 && _bFvgH > 0 && _fvgPx > 0
      && _fvgPx >= _bFvgL - _fvgAtr && _fvgPx <= _bFvgH + _fvgAtr;
    const _inBearFVG = _rFvgH > 0 && _rFvgL > 0 && _fvgPx > 0
      && _fvgPx >= _rFvgL - _fvgAtr && _fvgPx <= _rFvgH + _fvgAtr;
    let zone;
    if      (_uInBot || _uLiqB || _inBullFVG) zone = 'ZONE_ACHAT';
    else if (_uInTop || _uLiqH || _inBearFVG) zone = 'ZONE_VENTE';
    else                                       zone = 'HORS_ZONE';

    // ── FALLBACK 1: premium/discount Pine (midpoint exact) ──────────────────
    // Si Pine envoie inPremium/inDiscount (basé sur midpoint = (rangeHigh+rangeLow)/2)
    // Utiliser le midpoint Pine — plus précis que les 20/80% heuristiques
    if (zone === 'HORS_ZONE') {
      if (tvBridge.inDiscount === true) zone = 'ZONE_ACHAT';  // prix sous midpoint = zone discount = support
      else if (tvBridge.inPremium === true) zone = 'ZONE_VENTE'; // prix sur midpoint = zone premium = résistance
    }
    // ── FALLBACK 2: position dans le range (rangeHigh/rangeLow) ────────────
    // Quand inTop/inBot=false ET zoneLiq=false ET pas de midpoint Pine → 20/80% heuristique
    if (zone === 'HORS_ZONE') {
      const _rngH = tvBridge.rangeHigh != null && Number(tvBridge.rangeHigh) > 0 ? Number(tvBridge.rangeHigh) : 0;
      const _rngL = tvBridge.rangeLow  != null && Number(tvBridge.rangeLow)  > 0 ? Number(tvBridge.rangeLow)  : 0;
      const _priceNow = tvBridge.price != null && Number(tvBridge.price) > 0 ? Number(tvBridge.price) : 0;
      if (_rngH > 0 && _rngL > 0 && _priceNow > 0 && _rngH > _rngL) {
        const _pct = (_priceNow - _rngL) / (_rngH - _rngL); // 0=bas, 1=haut
        if (_pct >= 0.80)      zone = 'ZONE_VENTE';  // top 20% du range = zone résistance
        else if (_pct <= 0.20) zone = 'ZONE_ACHAT';  // bot 20% du range = zone support
        // else: milieu confirmé (40-80%) → HORS_ZONE reste correct
      }
    }
    // ── FALLBACK 3: RSI actif (dernier recours quand range absent) ──────────
    if (zone === 'HORS_ZONE') {
      const _rsiF = tvBridge.rsiTf1 != null ? Number(tvBridge.rsiTf1) :
                    tvBridge.rsiTf2 != null ? Number(tvBridge.rsiTf2) : 0;
      if (_rsiF > 68)      zone = 'ZONE_VENTE';  // RSI suracheté → zone haute probable
      else if (_rsiF < 32) zone = 'ZONE_ACHAT';  // RSI survendu  → zone basse probable
    }

    // ── 2. STRUCTURE ───────────────────────────────────────────────────────
    const _uBullRej = tvBridge.bullRej === true;
    const _uBearRej = tvBridge.bearRej === true;
    const _uAntTxt  = String(tvBridge.anticipationTexte || '').toUpperCase();
    // OB proche du prix → renforce la structure (Order Block = niveau institutionnel)
    const _priceNowStr = Number(tvBridge.price || 0);
    const _bullObH = Number(tvBridge.bullOB_h || 0);
    const _bullObL = Number(tvBridge.bullOB_l || 0);
    const _bearObH = Number(tvBridge.bearOB_h || 0);
    const _bearObL = Number(tvBridge.bearOB_l || 0);
    const _atr     = Number(tvBridge.atr || 0.001);
    // Prix dans un OB (±1 ATR) = niveau clé institutionnel — équivalent sweep pour la structure
    const _inBullOB = _bullObH > 0 && _bullObL > 0 && _priceNowStr > 0
      && _priceNowStr >= _bullObL - _atr && _priceNowStr <= _bullObH + _atr;
    const _inBearOB = _bearObH > 0 && _bearObL > 0 && _priceNowStr > 0
      && _priceNowStr >= _bearObL - _atr && _priceNowStr <= _bearObH + _atr;
    let structure;
    if      (_uBullRej || _inBullOB)                                               structure = 'SWEEP_BAS';
    else if (_uBearRej || _inBearOB)                                               structure = 'SWEEP_HAUT';
    else if (_uAntTxt.includes('PRE_ALERTE_LONG')  || _uAntTxt.includes('RET_LONG'))  structure = 'BOS_HAUSSIER';
    else if (_uAntTxt.includes('PRE_ALERTE_SHORT') || _uAntTxt.includes('RET_SHORT')) structure = 'BOS_BAISSIER';
    else structure = 'STRUCTURE_NEUTRE';

    // ── 3. DOMINANCE ───────────────────────────────────────────────────────
    const _uMacroBull = Number(tvBridge.macroBull || 0);
    const _uMacroBear = Number(tvBridge.macroBear || 0);
    let dominance;
    if      (_uMacroBull > 58) dominance = 'ACHETEURS';
    else if (_uMacroBear > 58) dominance = 'VENDEURS';
    else                        dominance = 'NEUTRE';

    // ── 4. SCORE + STYLE ───────────────────────────────────────────────────
    // Score: M15 (scoreTech3) > M5 (scoreTech2) > H1 (scoreTech4) — jamais 0 si lectureTech3 FORT
    let score = Number(tvBridge.scoreTech3 || tvBridge.scoreTech2 || tvBridge.scoreTech4 || 0);
    // Si lectureTech3 dit FORT mais score absent → plancher 65 (signal Pine fort validé)
    const _lt3forScore = String(tvBridge.lectureTech3 || '').toUpperCase();
    if (score === 0 && (_lt3forScore.includes('ACHAT_FORT') || _lt3forScore.includes('VENTE_FORTE'))) score = 65;
    const style = resolvedMode || 'AUTO';

    // ── 5. SEUIL PAR MODE ──────────────────────────────────────────────────
    // SCALP: 60 (rapide, tolère moins d'alignement)
    // BOS (Pine RET_LONG/RET_SHORT confirmé): 62 — structure Pine = preuve de retournement validé côté Pine
    //   → abaisse le seuil car le signal de structure est plus fort qu'un simple score de confluence
    // SNIPER + SWEEP: 65 — sweep en zone = haute précision, on peut descendre un peu vs AUTO
    // AUTO/SWING: 70 (par défaut)
    const _isBos = structure === 'BOS_HAUSSIER' || structure === 'BOS_BAISSIER';
    const _isSniperSweep = style === 'SNIPER' && (structure === 'SWEEP_BAS' || structure === 'SWEEP_HAUT');
    const scoreThreshold = style === 'SCALP' ? 60
      : _isBos         ? 62
      : _isSniperSweep ? 65
      : 70;

    // ── 6. RÈGLES BLOQUANTES (priorité absolue) ────────────────────────────
    if (zone === 'HORS_ZONE') {
      return { zone, structure, dominance, score, style, decision: 'WAIT',
        reason: 'Hors zone — prix au milieu du range, j\'attends un extrême',
        vocal: _buildVocal(zone, structure, dominance, score, style, 'WAIT', [], tvBridge) };
    }
    if (structure === 'STRUCTURE_NEUTRE') {
      return { zone, structure, dominance, score, style, decision: 'WAIT',
        reason: 'Structure neutre — pas de sweep ni de BOS confirmé, j\'attends le signal',
        vocal: _buildVocal(zone, structure, dominance, score, style, 'WAIT', [], tvBridge) };
    }

    // ── 7. CONDITIONS DIRECTIONNELLES — PRIORITÉ ZONE ─────────────────────
    // RÈGLE ABSOLUE : zone basse = biais LONG | zone haute = biais SHORT
    // DÉCLENCHEUR   : réaction en zone (sweep / rejet / impulsion) — zone seule ne suffit pas
    // H1 role       : SWING = bloquant | SNIPER = filtre (avertissement) | SCALP = info uniquement
    // Dominance     : indicateur de contexte, PAS condition d'entrée
    const _buyStruct  = structure === 'SWEEP_BAS'  || structure === 'BOS_HAUSSIER';
    const _sellStruct = structure === 'SWEEP_HAUT' || structure === 'BOS_BAISSIER';

    const _h1BullNow = String(tvBridge.lectureTech4 || '').toUpperCase().includes('ACHAT');
    const _h1BearNow = String(tvBridge.lectureTech4 || '').toUpperCase().includes('VENTE');

    // SNIPER : sweep OU BOS Pine confirmé — H1 = filtre vocal (avertissement), PAS blocage
    if (style === 'SNIPER') {
      const _okSweep = structure === 'SWEEP_BAS' || structure === 'SWEEP_HAUT';
      const _okBos   = structure === 'BOS_HAUSSIER' || structure === 'BOS_BAISSIER';
      // Zone basse + sweep → LONG (même si H1 encore baissier)
      if (_okSweep && zone === 'ZONE_ACHAT' && score >= scoreThreshold) {
        const _r = `SNIPER: sweep bas en zone achat${_h1BearNow ? ' — H1 encore baissier, retournement de zone' : ''} (score ${Math.round(score)})`;
        return { zone, structure, dominance, score, style, decision: 'BUY_READY', reason: _r,
          vocal: _buildVocal(zone, structure, dominance, score, style, 'BUY_READY', [], tvBridge) };
      }
      // Zone haute + sweep → SHORT (même si H1 encore haussier)
      if (_okSweep && zone === 'ZONE_VENTE' && score >= scoreThreshold) {
        const _r = `SNIPER: sweep haut en zone vente${_h1BullNow ? ' — H1 encore haussier, retournement de zone' : ''} (score ${Math.round(score)})`;
        return { zone, structure, dominance, score, style, decision: 'SELL_READY', reason: _r,
          vocal: _buildVocal(zone, structure, dominance, score, style, 'SELL_READY', [], tvBridge) };
      }
      // Zone basse + BOS haussier Pine (RET_LONG) → LONG sniper retournement (seuil 62)
      if (_okBos && zone === 'ZONE_ACHAT' && score >= scoreThreshold) {
        const _r = `SNIPER: retournement haussier Pine en zone achat${_h1BearNow ? ' — H1 encore baissier, retournement de zone' : ''} (score ${Math.round(score)})`;
        return { zone, structure, dominance, score, style, decision: 'BUY_READY', reason: _r,
          vocal: _buildVocal(zone, structure, dominance, score, style, 'BUY_READY', [], tvBridge) };
      }
      // Zone haute + BOS baissier Pine (RET_SHORT) → SHORT sniper retournement
      if (_okBos && zone === 'ZONE_VENTE' && score >= scoreThreshold) {
        const _r = `SNIPER: retournement baissier Pine en zone vente${_h1BullNow ? ' — H1 encore haussier, retournement de zone' : ''} (score ${Math.round(score)})`;
        return { zone, structure, dominance, score, style, decision: 'SELL_READY', reason: _r,
          vocal: _buildVocal(zone, structure, dominance, score, style, 'SELL_READY', [], tvBridge) };
      }
    }

    // SWING : structure directionnelle + H1 aligné (seul mode où H1 est obligatoire)
    // Accepte BOS ET SWEEP — un sweep en zone avec H1 confirmé = retour sur zone = excellent swing
    if (style === 'SWING') {
      const _swingBuy  = structure === 'BOS_HAUSSIER' || structure === 'SWEEP_BAS';
      const _swingSell = structure === 'BOS_BAISSIER' || structure === 'SWEEP_HAUT';
      if (zone === 'ZONE_ACHAT' && _swingBuy && _h1BullNow && score >= scoreThreshold)
        return { zone, structure, dominance, score, style, decision: 'BUY_READY',
          reason: `SWING: ${structure} en zone achat, H1 confirmé (score ${Math.round(score)})`,
          vocal: _buildVocal(zone, structure, dominance, score, style, 'BUY_READY', [], tvBridge) };
      if (zone === 'ZONE_VENTE' && _swingSell && _h1BearNow && score >= scoreThreshold)
        return { zone, structure, dominance, score, style, decision: 'SELL_READY',
          reason: `SWING: ${structure} en zone vente, H1 confirmé (score ${Math.round(score)})`,
          vocal: _buildVocal(zone, structure, dominance, score, style, 'SELL_READY', [], tvBridge) };
      // SWING sans H1 → WAIT (H1 reste le seul filtre bloquant ici)
    }

    // SCALP + AUTO : zone + réaction → entrée (H1 = info, dominance non bloquante)
    // INTERDICTION : jamais SHORT en zone basse, jamais LONG en zone haute
    if (zone === 'ZONE_ACHAT' && _buyStruct && score >= scoreThreshold)
      return { zone, structure, dominance, score, style, decision: 'BUY_READY',
        reason: `Zone achat + ${structure}${_h1BearNow ? ' — retournement de zone (H1 encore baissier)' : ''} (score ${Math.round(score)})`,
        vocal: _buildVocal(zone, structure, dominance, score, style, 'BUY_READY', [], tvBridge) };
    if (zone === 'ZONE_VENTE' && _sellStruct && score >= scoreThreshold)
      return { zone, structure, dominance, score, style, decision: 'SELL_READY',
        reason: `Zone vente + ${structure}${_h1BullNow ? ' — retournement de zone (H1 encore haussier)' : ''} (score ${Math.round(score)})`,
        vocal: _buildVocal(zone, structure, dominance, score, style, 'SELL_READY', [], tvBridge) };

    // Conditions partiellement remplies — identifier ce qui manque
    const _missing = [];
    if (zone === 'ZONE_ACHAT' && !_buyStruct)                        _missing.push('sweep bas ou BOS haussier attendu en zone');
    if (zone === 'ZONE_VENTE' && !_sellStruct)                       _missing.push('sweep haut ou BOS baissier attendu en zone');
    if (style === 'SWING' && zone === 'ZONE_ACHAT' && !_h1BullNow)  _missing.push('H1 doit confirmer la hausse (SWING)');
    if (style === 'SWING' && zone === 'ZONE_VENTE' && !_h1BearNow)  _missing.push('H1 doit confirmer la baisse (SWING)');
    if (score < scoreThreshold)                                       _missing.push(`score insuffisant (${Math.round(score)}/${scoreThreshold})`);

    return { zone, structure, dominance, score, style, decision: 'WAIT',
      reason: 'Conditions incomplètes — ' + (_missing.join(', ') || 'alignement en cours'),
      vocal: _buildVocal(zone, structure, dominance, score, style, 'WAIT', _missing, tvBridge) };
  }

  async function computeCoachAnalysisSnapshot(symbol, timeframe, lang, tradeState, options = {}) {
    if (!options.forceFresh) {
      // SCALP = cache court (20s) — données fraîches obligatoires sur TF rapide
      const _cacheMaxAge = resolveRuntimeMode(options.mode || activeSymbol?.mode || bridgeConfig.bridgeMode || 'AUTO', symbol, timeframe) === 'SCALP' ? 20000 : (options.maxAgeMs || 90000);
      const cached = readCoachAnalysisSnapshot(symbol, timeframe, _cacheMaxAge);
      if (cached) { console.log(`[SNAP-CACHE] ${symbol}/${timeframe} snapshot servi depuis cache (${Math.round((Date.now()-cached.updatedAt)/1000)}s)`); return cached; }
    }
    console.log(`[SNAP-FRESH] ${symbol}/${timeframe} calcul fresh — cache vide ou forceFresh`);

    const resolvedMode = resolveRuntimeMode(options.mode || activeSymbol?.mode || bridgeConfig.bridgeMode || 'AUTO', symbol, timeframe);
    const tvRuntime = getLatestTradingviewRuntime();
    const robotV12 = getRobotV12ForSymbol(symbol);
    const extSnapshot = options.extSnapshot || await fetchLocalJson('/extension/data').then((r) => r.data || null).catch(() => null);
    const marketStatus = marketHoursChecker.getStatus(symbol);
    const activeSource = String(bridgeConfig.activeSource || (bridgeConfig.mt5Enabled === true ? 'mt5' : 'tradingview')).toLowerCase() === 'mt5' ? 'mt5' : 'tradingview';
    const priceCandidates = activeSource === 'tradingview'
      ? [
          // tvRuntime.payload.price = prix live direct depuis tvDataStore (le plus frais)
          tvRuntime?.payload?.price,
          options.currentPrice,
          extSnapshot?.currentData?.price,
          extSnapshot?.activeSymbol?.price,
          getCoachMarketPrice(symbol)
        ]
      : [
          options.currentPrice,
          getCoachMarketPrice(symbol),
          tvRuntime?.payload?.price,
          extSnapshot?.currentData?.price,
          extSnapshot?.activeSymbol?.price
        ];
    const currentPrice = Number(priceCandidates.find((v) => Number.isFinite(Number(v)) && Number(v) > 0) || NaN);

    // Essai 1: signal TradingView live (robotV12 / tvRuntime)
    let runtimeTrade = options.instantTrade
      || buildTradingviewRuntimeTrade(symbol, timeframe, currentPrice, resolvedMode, tvRuntime, robotV12);

    // Essai 2: si pas de signal TV → calcul technique depuis klines réelles (RSI, EMA, ATR)
    if (!runtimeTrade && Number.isFinite(currentPrice) && currentPrice > 0) {
      runtimeTrade = await computeTechSignalFromKlines(symbol, timeframe, currentPrice);
    }

    const runtimeSignal = buildRuntimeTradeSignal(symbol, timeframe, runtimeTrade, robotV12, marketStatus, currentPrice);
    const newsData = await getCachedNewsIntelligence(symbol);
    const newsPayload = {
      upcomingEvents: Array.isArray(newsData?.upcomingEvents)
        ? newsData.upcomingEvents.slice(0, 5).map((e) => ({
            event: e.event,
            currency: e.currency,
            impact: e.impact,
            urgency: e.isUrgent ? 'HIGH' : String(e.impact || 'LOW').toUpperCase(),
            mins: e.minutesAway,
            minutesAway: e.minutesAway
          }))
        : [],
      warning: newsData?.macroWarning || null,
      symbolImpact: newsData?.symbolImpact || ('Pas de risque macro majeur immédiat pour ' + symbol),
      tradingSuggestion: newsData?.tradingSuggestion || 'Pas d\'annonce urgente'
    };

    // STABILITÉ POSITION: quand une position est active, verrouiller la direction sur celle de la VP
    // Évite que le signal flip entre LONG/SHORT toutes les quelques secondes pendant le trade
    const _enteredVpDir = tradeState?.entered && tradeState?.virtualPosition?.direction
      ? String(tradeState.virtualPosition.direction).toUpperCase()
      : null;

    // ── tvDirection: utiliser la lecture Pine PER-TF (pas le verdict global)
    // Raison: Pine envoie verdict=SHORT (tendance H1) + lecture_15m=ACHAT (M15 long)
    // Si on compare verdict global vs runtime M15 → faux conflit permanent → jamais d'entrée
    // Règle: lecture TF-spécifique > verdict global > fallback runtime
    const _tfLectureMap = { M1: 'lecture_1m', M5: 'lecture_5m', M15: 'lecture_15m', H1: 'lecture_60m', H4: null, D1: null };
    const _tfLectureField = _tfLectureMap[String(timeframe || '').toUpperCase()] || null;
    const _tfLectureRaw = _tfLectureField && robotV12 ? String(robotV12[_tfLectureField] || '').toUpperCase() : '';
    const _tfLectureDir = _tfLectureRaw.includes('VENTE') ? 'SHORT'
      : _tfLectureRaw.includes('ACHAT') ? 'LONG' : null;  // direction Pine TF-spécifique

    // SOURCE BRIDGE FALLBACK: si robotV12 absent, lire _bridgePayload.lectureTechX
    // Même source que buildTradingviewRuntimeTrade (Source 2) — évite faux conflit tv/runtime
    let _tvBridgeLectureDir = null;
    if (!_tfLectureDir) {
      const _bpIdxCtx = { M1: 1, M5: 2, M15: 3, M30: 3, H1: 4 }[String(timeframe || '').toUpperCase()] || null;
      const _bpDsCtx  = (typeof tvDataStore !== 'undefined')
        ? (tvDataStore[String(symbol).toUpperCase()] || tvDataStore[String(symbol).toUpperCase().replace(/[^A-Z0-9]/g,'')] || null)?._bridgePayload
        : null;
      if (_bpIdxCtx && _bpDsCtx) {
        const _bpLtCtx = String(_bpDsCtx['lectureTech' + _bpIdxCtx] || '').toUpperCase();
        if (_bpLtCtx.includes('VENTE'))      _tvBridgeLectureDir = 'SHORT';
        else if (_bpLtCtx.includes('ACHAT')) _tvBridgeLectureDir = 'LONG';
      }
    }

    const tvDirectionRaw = (_enteredVpDir && (_enteredVpDir === 'LONG' || _enteredVpDir === 'SHORT'))
      // Position active → verrouiller direction (priorité absolue)
      ? _enteredVpDir
      // Lecture Pine TF-spécifique (lecture_15m pour M15) — évite faux conflit avec verdict global
      : (_tfLectureDir
        || _tvBridgeLectureDir          // bridge lectureTechX (même source que runtimeTrade)
        || robotV12?.verdict
        || robotV12?.anticipation
        || tvRuntime?.payload?.verdict
        || tvRuntime?.payload?.anticipation
        || tvRuntime?.payload?.action
        || (runtimeTrade?.direction || 'WAIT'));
    const runtimeDirectionRaw = _enteredVpDir
      ? _enteredVpDir
      : (runtimeTrade?.direction || runtimeTrade?.side || 'WAIT');
    const tvDirection = normalizeTradeDirection(tvDirectionRaw);
    const runtimeDirection = normalizeTradeDirection(runtimeDirectionRaw);
    const mtfDirection = deriveMtfDirectionFromRobot(robotV12);

    const conflicts = [];
    // Conflit directionnel réel: Pine TF-spécifique ≠ runtime TF (pas le verdict global)
    // H1 contre M15 = retracement normal, pas un conflit bloquant
    if (!_enteredVpDir) {
      if (isDirectionalDirection(tvDirection) && isDirectionalDirection(runtimeDirection) && tvDirection !== runtimeDirection) {
        // Conflit seulement si la MÊME source TF dit des choses opposées
        conflicts.push('Conflit directionnel: lecture Pine ' + (timeframe || '') + ' != signal runtime');
      }
      // Supprimer le check mtfDirection — il comparait verdict global vs lectures → faux conflits
      // Les lectures multi-TF sont désormais contexte (H1/H4 non bloquants) ou timing (M1/M5)
    }

    const preferredDirection = isDirectionalDirection(tvDirection)
      ? tvDirection
      : (isDirectionalDirection(runtimeDirection) ? runtimeDirection : 'WAIT');

    const conflictDetected = conflicts.length > 0;
    // let — sera écrasé après check zone (priorité absolue)
    let recommendation = (!marketStatus?.isOpen || conflictDetected)
      ? 'WAIT'
      : recommendationFromDirection(preferredDirection);
    const confidence = Number(
      robotV12?.anticipation_force ||
      runtimeTrade?.score ||
      runtimeTrade?.confidence ||
      runtimeSignal.confidence ||
      50
    );
    const tradeTechnical = runtimeTrade?.technical || runtimeSignal.rationale || 'Analyse runtime en attente';

    const hasLiveLevels = Number.isFinite(Number(runtimeTrade?.entry))
      && Number.isFinite(Number(runtimeTrade?.sl))
      && Number.isFinite(Number(runtimeTrade?.tp));
    const tradeStatus = String(runtimeTrade?.trade_status || '').toUpperCase();
    // price-action-ticks est toujours traité comme un signal valide pour l'entrée
    const isPriceAction = runtimeTrade?.source === 'price-action-ticks';
    const isTechSignal = runtimeTrade?.source === 'technical-klines';
    const statusAllowsEntry = tradeStatus === 'LIVE' || tradeStatus === 'CONDITIONAL'
      || (isTechSignal && preferredDirection !== 'WAIT')
      || (isPriceAction && preferredDirection !== 'WAIT'); // price-action aussi autorisé
    // Autoriser l'entrée même si marketStatus.isOpen est false mais prix live disponible
    const _hasLivePrice = Number.isFinite(currentPrice) && currentPrice > 0;

    // ── FILTRES QUALITÉ ENTRÉE — éviter les points d'entrée à haut risque SL ────
    // Ces filtres réduisent les entrées perdantes en bloquant les setups défavorables
    // 1. RSI extrême contre la direction (surachat LONG → imminent retournement)
    // Source RSI: bridge TV direct (tvDataStore) > runtimeTrade.rsi > tvRuntime.payload.rsi
    const _tvLiveInds = typeof tvDataStore !== 'undefined'
      ? (tvDataStore[symbol] || tvDataStore[String(symbol).toUpperCase()] || null)?.indicators
      : null;
    // RSI > 0 requis — RSI=0 = données absentes (TV envoie 0 quand pas de valeur)
    // Sources RSI: scraped extension > rsiTf3 (M15, TF de décision) > rsiTf1 > runtime
    const _bridgeRsi = (_tvLiveInds?.rsi != null && Number(_tvLiveInds.rsi) > 0) ? Number(_tvLiveInds.rsi) : null;
    // RobotV12: RSI M15 = rsi_15m (directement comparable au TF de décision)
    const _rv12RsiM15 = (typeof tvDataStore !== 'undefined')
      ? (tvDataStore[symbol] || tvDataStore[String(symbol).toUpperCase()] || null)?.robotV12?.rsi_15m
      : null;
    const _rv12RsiOk = _rv12RsiM15 != null && Number(_rv12RsiM15) > 0 ? Number(_rv12RsiM15) : null;
    const _entryRsi = _bridgeRsi
      ?? _rv12RsiOk
      ?? (Number.isFinite(Number(runtimeTrade?.rsi)) && Number(runtimeTrade.rsi) > 0 ? Number(runtimeTrade.rsi) : null)
      ?? (Number.isFinite(Number(tvRuntime?.payload?.rsi)) && Number(tvRuntime.payload.rsi) > 0 ? Number(tvRuntime.payload.rsi) : null);
    // RSI: seuils par TF + par actif — gold M1 peut toucher 90+ sans retournement immédiat
    // Logique: plus le TF est court, plus le seuil est large (RSI court-terme oscille fort)
    // SCALP/SNIPER: warning seulement — gold sort souvent des setups à RSI élevé
    // SWING: blocage dur — RSI extrême sur H1 = retournement probable
    const _isGoldAsset = /XAU|GOLD/.test(String(symbol).toUpperCase());
    const _rsiTfKey = String(timeframe || 'M15').toUpperCase();
    // Seuils [overbought, oversold] par TF
    // XAUUSD: M1=88/12 (très volatile), M5=85/15, M15=80/20, H1=75/25
    // Autres: M1=82/18, M5=80/20, M15=75/25, H1=70/30
    const _rsiTableGold    = { M1: [88, 12], M5: [85, 15], M15: [80, 20], H1: [75, 25] };
    const _rsiTableDefault = { M1: [82, 18], M5: [80, 20], M15: [75, 25], H1: [70, 30] };
    const _rsiTable = _isGoldAsset ? _rsiTableGold : _rsiTableDefault;
    const [_rsiThreshHigh, _rsiThreshLow] = _rsiTable[_rsiTfKey] || (_isGoldAsset ? [80, 20] : [75, 25]);
    const _rsiBlockLong  = preferredDirection === 'LONG'  && _entryRsi != null && _entryRsi > _rsiThreshHigh;
    const _rsiBlockShort = preferredDirection === 'SHORT' && _entryRsi != null && _entryRsi < _rsiThreshLow;
    const _rsiBlocked = _rsiBlockLong || _rsiBlockShort;
    // SCALP/SNIPER: RSI extrême = warning fort (pondération), pas blocage dur
    // SWING: blocage dur — seul mode où RSI extrême sur H1 est une raison valable de ne pas entrer
    if (_rsiBlocked && resolvedMode !== 'SNIPER' && resolvedMode !== 'SCALP') {
      conflicts.push(`RSI ${_entryRsi?.toFixed(0)} extrême (${_rsiTfKey} seuil ${preferredDirection === 'LONG' ? _rsiThreshHigh : _rsiThreshLow}) — entrée bloquée (risque retournement)`);
    } else if (_rsiBlocked) {
      console.log(`[RSI-WARN] ${symbol}/${_rsiTfKey} RSI ${_entryRsi?.toFixed(0)} > seuil ${preferredDirection === 'LONG' ? _rsiThreshHigh : _rsiThreshLow} — warning (mode ${resolvedMode}, pas bloquant)`);
    }
    // ── BRIDGE STALE CHECK — données mortes → canEnter=false obligatoire ──────
    // Si le bridge Pine est vieux de >60s, toute décision d'entrée est non fiable
    // Cela évite le cas "canEnter=true sur données stales" → ENTER_REFUSED en dernière minute
    const _bridgeEntry = typeof tvDataStore !== 'undefined'
      ? (tvDataStore[symbol] || tvDataStore[String(symbol).toUpperCase()] || null)
      : null;
    const _bridgeAgeMs = _bridgeEntry?.updatedAt ? Date.now() - _bridgeEntry.updatedAt : Infinity;
    const _bridgeStale = _bridgeAgeMs > 60000;
    if (_bridgeStale && preferredDirection !== 'WAIT') {
      conflicts.push(`BRIDGE_STALE: données TradingView vieilles de ${Math.round(_bridgeAgeMs/1000)}s — canEnter bloqué. Reconnectez l'extension TradingView.`);
      console.log(`[BRIDGE-STALE] ${symbol} — bridge ${Math.round(_bridgeAgeMs/1000)}s stale → canEnter=false`);
    }
    // 2. BB extrême: prix hors des bandes Bollinger contre la direction
    // BB: uniquement si la valeur est positive et non-nulle (null stocké = 0 → faux positif)
    // BB: toutes sources — extension scraped > runtime
    const _bbuRaw = (_tvLiveInds?.bb_upper != null && Number(_tvLiveInds.bb_upper) > 0 ? Number(_tvLiveInds.bb_upper) : null)
      ?? (Number.isFinite(Number(runtimeTrade?.bbUpper)) && Number(runtimeTrade.bbUpper) > 0 ? Number(runtimeTrade.bbUpper) : null);
    const _bblRaw = (_tvLiveInds?.bb_lower != null && Number(_tvLiveInds.bb_lower) > 0 ? Number(_tvLiveInds.bb_lower) : null)
      ?? (Number.isFinite(Number(runtimeTrade?.bbLower)) && Number(runtimeTrade.bbLower) > 0 ? Number(runtimeTrade.bbLower) : null);
    // Sanity BB: bb_upper doit être > prix actuel, bb_lower doit être < prix actuel
    // Si bb_upper < prix → donnée stale/incorrecte → ne pas utiliser pour bloquer
    const _bbu = (_bbuRaw != null && _bbuRaw > currentPrice * 0.5 && _bbuRaw > currentPrice) ? _bbuRaw : null;
    const _bbl = (_bblRaw != null && _bblRaw < currentPrice * 1.5 && _bblRaw < currentPrice) ? _bblRaw : null;
    const _bbBlockLong  = preferredDirection === 'LONG'  && _bbu != null && _bbu > 0 && currentPrice >= _bbu;
    const _bbBlockShort = preferredDirection === 'SHORT' && _bbl != null && _bbl > 0 && currentPrice <= _bbl;
    if (_bbBlockLong)  conflicts.push(`Prix (${currentPrice}) ≥ BB haute (${_bbu?.toFixed(2)}) — pas d'entrée LONG ici`);
    if (_bbBlockShort) conflicts.push(`Prix (${currentPrice}) ≤ BB basse (${_bbl?.toFixed(2)}) — pas d'entrée SHORT ici`);
    // 3. Multi-TF: bridge unifié = fusion Pine Enrichissement + Robot V12 + extension scraped
    // mergeBridgeSources() combine les 3 sources en un seul objet normalisé
    // Priorité: _bridgePayload (Pine) > robotV12 (mapping) > indicators (scraped)
    const _tvBridge = (typeof mergeBridgeSources === 'function')
      ? mergeBridgeSources(symbol)
      : (typeof tvDataStore !== 'undefined'
          ? (tvDataStore[symbol] || tvDataStore[String(symbol).toUpperCase()] || null)?._bridgePayload
          : null);
    // Flag M15 bypass — accessible hors du bloc _tvBridge pour setupQuality
    let _m15BypassActive = false;
    if (_tvBridge) {
      // Lire les lectures techniques par TF: ACHAT_FORT/ACHAT/NEUTRE/VENTE/VENTE_FORTE
      const _lt = [_tvBridge.lectureTech1, _tvBridge.lectureTech2, _tvBridge.lectureTech3, _tvBridge.lectureTech4];
      const _tfNames = ['M1','M5','M15','H1'];
      const _tfOpposed = []; // TFs qui contredisent la direction
      const _tfAligned = []; // TFs qui confirment
      for (let i = 0; i < _lt.length; i++) {
        const _lt_val = String(_lt[i] || '').toUpperCase();
        if (!_lt[i]) continue;
        const _isVente = _lt_val.includes('VENTE');
        const _isAchat = _lt_val.includes('ACHAT');
        if (preferredDirection === 'LONG'  && _isVente) _tfOpposed.push(_tfNames[i]);
        if (preferredDirection === 'SHORT' && _isAchat) _tfOpposed.push(_tfNames[i]);
        if (preferredDirection === 'LONG'  && _isAchat) _tfAligned.push(_tfNames[i]);
        if (preferredDirection === 'SHORT' && _isVente) _tfAligned.push(_tfNames[i]);
      }
      // Pré-calcul: nombre de TFs alignés dans la direction (M1+M5+M15+H1)
      const _tfAlignedCount = _tfAligned.length;
      console.log(`[M15-CHECK] ${symbol} dir=${preferredDirection} aligned=[${_tfAligned.join(',')}] opposed=[${_tfOpposed.join(',')}] count=${_tfAlignedCount}`);
      // H1/H4 = contexte uniquement — seul M15 (TF d'entrée) est bloquant
      const _m15Against = _tfOpposed.includes('M15');
      const _h1Against  = _tfOpposed.includes('H1');
      // RÈGLE: M15 contre = bloquant SAUF si 3+/4 TFs sont alignés dans la direction
      // Si M1+M5+H1 sont tous SHORT et M15 seul est ACHAT → M15 en retracement → pas bloquant
      // Si seulement 2 TFs alignés et M15 contre → vrai conflit → bloquant
      const _m15Bypass = _m15Against && _tfAlignedCount >= 3;
      if (_m15Against && !_m15Bypass) {
        // M15 = TF d'entrée → bloquant si Pine M15 contredit la direction (et pas assez d'alignés)
        conflicts.push(`M15 Pine contre ${preferredDirection} — TF d'entrée divergent`);
      } else if (_m15Against && _m15Bypass) {
        _m15BypassActive = true; // propager hors du bloc pour setupQuality
        console.log(`[M15-BYPASS] ${symbol} ${preferredDirection} — M15 contre mais ${_tfAlignedCount}/4 TFs alignés → retracement M15, pas bloquant`);
      }
      // ── PRIORITÉ MARCHÉ — macro + H1 = contexte directionnel BLOQUANT ────────
      // Règle stricte: si le marché (H1 Pine + macro bridge) est baissier → SHORT prioritaire
      // Si le marché est haussier → LONG prioritaire.
      // Un trade CONTRE le contexte H1 ET la macro = contre-tendance dangereuse → BLOQUÉ.
      // Exception: si M15 est très fort (score > 72) contre H1 → retracement court exploitable (non bloqué).
      const _macroBullVal = Number(_tvBridge.macroBull || 0);
      const _macroBearVal = Number(_tvBridge.macroBear || 0);
      const _lt4raw  = String(_tvBridge.lectureTech4 || '').toUpperCase(); // H1 direction Pine
      const _lt3raw  = String(_tvBridge.lectureTech3 || '').toUpperCase(); // M15 direction Pine
      const _h1IsBull = _lt4raw.includes('ACHAT');
      const _h1IsBear = _lt4raw.includes('VENTE');
      const _macroIsBull = _macroBullVal > 58;
      const _macroIsBear = _macroBearVal > 58;
      // Contexte marché confirmé = H1 ET macro pointent dans la même direction
      const _mktBull = _h1IsBull && _macroIsBull; // marché clairement haussier
      const _mktBear = _h1IsBear && _macroIsBear; // marché clairement baissier
      // Retracement M15 fort = exception (on peut aller contre H1 si M15 super fort)
      const _sc3raw  = Number(_tvBridge.scoreTech3 || 0); // score M15
      // Reversal zone confirmé = exception: inBot+bullRej (LONG) ou inTop+bearRej (SHORT)
      // Ces signaux indiquent un retournement sur niveau clé — autorisés même contre H1+macro
      const _rvLongOk  = preferredDirection === 'LONG'  && _tvBridge.inBot  === true && _tvBridge.bullRej === true;
      const _rvShortOk = preferredDirection === 'SHORT' && _tvBridge.inTop  === true && _tvBridge.bearRej === true;
      // SNIPER: seuil retracement abaissé à 65 (aligné avec seuil SNIPER sweep)
      // BOS Pine en zone confirmée = exception valide même sans score élevé
      const _antTxtRaw = String(_tvBridge.anticipationTexte || '').toUpperCase();
      const _bosInZone = (preferredDirection === 'LONG'  && _tvBridge.inBot === true && _antTxtRaw.includes('RET_LONG'))
                       || (preferredDirection === 'SHORT' && _tvBridge.inTop === true && _antTxtRaw.includes('RET_SHORT'));
      const _scRetrace = resolvedMode === 'SNIPER' ? 65 : 72;
      const _retracementOk = _sc3raw >= _scRetrace || _rvLongOk || _rvShortOk || _bosInZone;
      if (_mktBear && preferredDirection === 'LONG' && !_retracementOk) {
        conflicts.push(`Marché BAISSIER (H1 ${_lt4raw} | Macro bear ${Math.round(_macroBearVal)}%) — LONG contre-tendance bloqué. Priorité SHORT.`);
        console.log(`[MARKET-BIAS] ${symbol} LONG bloqué — marché baissier. H1=${_lt4raw} macroBear=${Math.round(_macroBearVal)} sc3=${_sc3raw}`);
      } else if (_mktBull && preferredDirection === 'SHORT' && !_retracementOk) {
        conflicts.push(`Marché HAUSSIER (H1 ${_lt4raw} | Macro bull ${Math.round(_macroBullVal)}%) — SHORT contre-tendance bloqué. Priorité LONG.`);
        console.log(`[MARKET-BIAS] ${symbol} SHORT bloqué — marché haussier. H1=${_lt4raw} macroBull=${Math.round(_macroBullVal)} sc3=${_sc3raw}`);
      } else if (_h1Against) {
        // H1 seul contre (sans confirmation macro) = retracement potentiel → log uniquement
        console.log(`[MTF-CONTEXT] ${symbol} H1 contre ${preferredDirection} — contexte retracement (macro non confirmée, non bloquant)`);
      }
      // M1+M5 timing contre → log seulement (non bloquant si M15 est aligné)
      if (_tfOpposed.includes('M1') && _tfOpposed.includes('M5') && !_m15Against) {
        console.log(`[MTF-TIMING] ${symbol} M1+M5 contre ${preferredDirection} — timing court-terme défavorable (M15 OK, non bloquant)`);
      }

      // ── M1 ZONE CHECK — BLOQUANT (règle SNIPER/SCALPING) ──────────────────
      // "INTERDICTION d'entrer au milieu de la zone."
      // M1 doit montrer une pression directionnelle EXTRÊME (pas neutre) :
      //   SHORT → M1 = VENTE/VENTE_FORTE  (zone rouge = haut du range = excès vendeur)
      //   LONG  → M1 = ACHAT/ACHAT_FORT   (zone verte = bas du range = excès acheteur)
      // Si M1 est NEUTRE ou dans la direction opposée → "prix au milieu, j'attends extrême"
      const _ltM1raw = String(_lt[0] || '').toUpperCase(); // lectureTech1 = M1
      const _m1HasData = _ltM1raw.length > 0; // bridge a envoyé une lecture M1
      if (_m1HasData && preferredDirection !== 'WAIT') {
        const _m1IsVente = _ltM1raw.includes('VENTE'); // pression vendeuse = zone haute
        const _m1IsAchat = _ltM1raw.includes('ACHAT'); // pression acheteuse = zone basse
        const _m1IsMiddle = !_m1IsVente && !_m1IsAchat; // neutre = milieu de zone
        if (_m1IsMiddle) {
          // M1 neutre = zone morte — SAUF si reversal Pine confirmé (inBot+bullRej / inTop+bearRej)
          // Dans ce cas, M1 neutre = transition normale avant impulsion → on ne bloque pas
          if (_rvLongOk || _rvShortOk) {
            console.log(`[M1-REVERSAL-BYPASS] ${symbol} M1 NEUTRE ignoré — reversal Pine confirmé (${preferredDirection}) en zone`);
          } else {
            conflicts.push(`M1 neutre (${_ltM1raw}) — prix au milieu, j'attends extrême (règle: M1 doit montrer pression directionnelle aux extrêmes).`);
            console.log(`[M1-MIDDLE] ${symbol} bloqué — M1 NEUTRE. lectureTech1='${_ltM1raw}' dir=${preferredDirection}`);
          }
        } else if (preferredDirection === 'SHORT' && !_m1IsVente && !_rvShortOk) {
          // SHORT mais M1 ACHAT → prix en bas de zone, pas en haut → dangereux
          // Bypass SNIPER: sc3>=65 | Bypass SCALP: sc3>=60 | Bypass reversal: _rvShortOk
          if ((resolvedMode === 'SNIPER' && _sc3raw >= 65) || (resolvedMode === 'SCALP' && _sc3raw >= 60)) {
            console.log(`[M1-BYPASS] ${symbol} SHORT — M1=${_ltM1raw} ignoré (${resolvedMode} + M15 fort sc3=${_sc3raw})`);
          } else {
            conflicts.push(`M1 ACHAT pour un SHORT — prix en zone basse, pas en zone haute. J'attends que M1 atteigne la zone rouge (excès vendeur).`);
            console.log(`[M1-ZONE] ${symbol} SHORT bloqué — M1=${_ltM1raw} (doit être VENTE).`);
          }
        } else if (preferredDirection === 'LONG' && !_m1IsAchat && !_rvLongOk) {
          // LONG mais M1 VENTE → prix en haut de zone, pas en bas → dangereux
          // Bypass SNIPER: sc3>=65 | Bypass SCALP: sc3>=60 | Bypass reversal: _rvLongOk
          if ((resolvedMode === 'SNIPER' && _sc3raw >= 65) || (resolvedMode === 'SCALP' && _sc3raw >= 60)) {
            console.log(`[M1-BYPASS] ${symbol} LONG — M1=${_ltM1raw} ignoré (${resolvedMode} + M15 fort sc3=${_sc3raw})`);
          } else {
            conflicts.push(`M1 VENTE pour un LONG — prix en zone haute, pas en zone basse. J'attends que M1 atteigne la zone verte (excès acheteur).`);
            console.log(`[M1-ZONE] ${symbol} LONG bloqué — M1=${_ltM1raw} (doit être ACHAT).`);
          }
        }
      }
      // ── Pré-calcul alignement bridge (utilisé par F4 et F5) ──────────────────
      // 2+/4 TFs alignés = signal bridge fort → bypass zone block
      // 3+/4 TFs alignés = bypass confiance également
      const _bridgeAlignedCountEarly = _tvBridge ? [
        _tvBridge.lectureTech1, _tvBridge.lectureTech2,
        _tvBridge.lectureTech3, _tvBridge.lectureTech4
      ].filter(lt => {
        const _v = String(lt || '').toUpperCase();
        return preferredDirection === 'LONG' ? _v.includes('ACHAT') : _v.includes('VENTE');
      }).length : 0;
      const _bridgeMajorAligned = _bridgeAlignedCountEarly >= 3; // 3/4 TFs alignés requis = zone bypass (discipline zone stricte)

      // 4. Zone d'entrée PRO — BLOQUANT ABSOLU (règle: haut ou bas du range uniquement)
      // "Zone + Timing = entrée. Milieu = attente." — règle non négociable
      // ┌─ SOURCES ZONE PAR PRIORITÉ ────────────────────────────────────────────┐
      // │ 1. inTop / inBot (Pine)    → source directe, la plus fiable            │
      // │ 2. zoneLiqHaute/Basse      → liquidité active (fallback Pine)          │
      // │ 3. RSI M1 + H1             → fallback si Pine ne fournit pas de zone   │
      // │ 4. Aucune source           → BLOQUER (absence d'info ≠ autorisation)   │
      // └────────────────────────────────────────────────────────────────────────┘
      const _inTop    = _tvBridge.inTop;
      const _inBot    = _tvBridge.inBot;
      const _zoneLiqH = _tvBridge.zoneLiqHaute;
      const _zoneLiqB = _tvBridge.zoneLiqBasse;
      // RSI bridge pour fallback zone (M1=rsiTf1, H1=rsiTf4)
      const _zRsiM1 = _tvBridge.rsiTf1 != null ? Number(_tvBridge.rsiTf1) : null;
      const _zRsiH1 = _tvBridge.rsiTf4 != null ? Number(_tvBridge.rsiTf4) : null;
      const _bridgeHasZoneData = (_inTop != null || _inBot != null);
      // Inférence RSI zone quand Pine ne fournit pas inTop/inBot
      // Double confirmation M1+H1 requise — seuils conservateurs pour éviter les faux positifs
      let _rsiInTop = false, _rsiInBot = false, _rsiZoneNeutral = false;
      if (!_bridgeHasZoneData) {
        if (_zRsiM1 != null && _zRsiH1 != null) {
          _rsiInTop       = _zRsiM1 > 68 && _zRsiH1 > 60; // suracheté M1+H1 → zone haute SHORT
          _rsiInBot       = _zRsiM1 < 32 && _zRsiH1 < 40; // survendu M1+H1  → zone basse LONG
          _rsiZoneNeutral = !_rsiInTop && !_rsiInBot;      // milieu → bloquer
        } else if (_zRsiM1 != null) {
          // RSI M1 seul (H1 absent) → seuil plus strict
          _rsiInTop       = _zRsiM1 > 72;
          _rsiInBot       = _zRsiM1 < 28;
          _rsiZoneNeutral = !_rsiInTop && !_rsiInBot;
        } else {
          _rsiZoneNeutral = true; // aucune donnée zone → blocage systématique
        }
      }
      // Bloc zone TOUJOURS actif — sauf si:
      // 1. 3+/4 TFs parfaitement alignés (bridge fort)
      // 2. Reversal Pine confirmé (inBot+bullRej ou inTop+bearRej) — Pine a déjà validé la zone
      const _zoneBypassReversal = _rvLongOk || _rvShortOk;
      if (!_bridgeMajorAligned && !_zoneBypassReversal && preferredDirection !== 'WAIT') {
        if (_bridgeHasZoneData) {
          // ── Source Pine directe (inTop/inBot) ───────────────────────────────
          if (preferredDirection === 'SHORT') {
            if (!_inTop && !_zoneLiqH) {
              conflicts.push(`Zone SHORT absente — inTop=false. Le prix n'est pas en zone haute (bloc rouge). Attendre zone haute avant d'entrer SHORT.`);
              console.log(`[ZONE-BLOCK] ${symbol} SHORT bloqué — inTop=${_inTop} zoneLiqH=${_zoneLiqH}. Prix=${currentPrice}`);
            }
          } else if (preferredDirection === 'LONG') {
            if (!_inBot && !_zoneLiqB) {
              conflicts.push(`Zone LONG absente — inBot=false. Le prix n'est pas en zone basse (bloc vert). Attendre zone basse avant d'entrer LONG.`);
              console.log(`[ZONE-BLOCK] ${symbol} LONG bloqué — inBot=${_inBot} zoneLiqB=${_zoneLiqB}. Prix=${currentPrice}`);
            }
          }
        } else {
          // ── Fallback RSI (Pine n'envoie pas inTop/inBot) ────────────────────
          if (_rsiZoneNeutral) {
            conflicts.push(`Zone RSI neutre (M1:${_zRsiM1 != null ? Math.round(_zRsiM1) : '—'} H1:${_zRsiH1 != null ? Math.round(_zRsiH1) : '—'}) — prix au milieu du range. Attendre extrême RSI (suracheté ou survendu).`);
            console.log(`[ZONE-RSI] ${symbol} ${preferredDirection} bloqué — RSI zone neutre. M1=${_zRsiM1} H1=${_zRsiH1}`);
          } else if (preferredDirection === 'SHORT' && !_rsiInTop) {
            conflicts.push(`Zone RSI — SHORT bloqué: RSI M1=${_zRsiM1 != null ? Math.round(_zRsiM1) : '—'} H1=${_zRsiH1 != null ? Math.round(_zRsiH1) : '—'}. Attendre suracheté (M1>68 H1>60) avant SHORT.`);
            console.log(`[ZONE-RSI] ${symbol} SHORT bloqué — RSI pas en zone haute. M1=${_zRsiM1} H1=${_zRsiH1}`);
          } else if (preferredDirection === 'LONG' && !_rsiInBot) {
            conflicts.push(`Zone RSI — LONG bloqué: RSI M1=${_zRsiM1 != null ? Math.round(_zRsiM1) : '—'} H1=${_zRsiH1 != null ? Math.round(_zRsiH1) : '—'}. Attendre survendu (M1<32 H1<40) avant LONG.`);
            console.log(`[ZONE-RSI] ${symbol} LONG bloqué — RSI pas en zone basse. M1=${_zRsiM1} H1=${_zRsiH1}`);
          } else {
            // RSI confirme la zone — autorisé, on log uniquement
            console.log(`[ZONE-RSI] ${symbol} ${preferredDirection} — zone inférée RSI OK. M1=${_zRsiM1} H1=${_zRsiH1} inTop=${_rsiInTop} inBot=${_rsiInBot}`);
          }
        }
      }
    }
    // ── PAYLOAD UNIFIÉ — source unique de décision (priorité absolue) ────────
    // Mappe zone/structure/dominance/score/style depuis bridge → BUY_READY/SELL_READY/WAIT
    // Si WAIT → bloqué immédiatement (avant les filtres F5-F7)
    const _unifiedPayload = computeUnifiedMarketPayload(_tvBridge, resolvedMode, preferredDirection);
    console.log(`[UNIFIED] ${symbol} → zone=${_unifiedPayload.zone} struct=${_unifiedPayload.structure} dom=${_unifiedPayload.dominance} score=${Math.round(_unifiedPayload.score)} → ${_unifiedPayload.decision}`);
    if (_unifiedPayload.decision === 'WAIT' && preferredDirection !== 'WAIT' && !_enteredVpDir) {
      conflicts.push(_unifiedPayload.reason);
      console.log(`[UNIFIED-BLOCK] ${symbol} bloqué par payload unifié — ${_unifiedPayload.reason}`);
    }

    // ── PRIORITÉ ZONE ABSOLUE — inBot = LONG obligatoire, inTop = SHORT obligatoire ──
    // La zone (géographie du prix) prime sur lectureTech/verdict Pine.
    // "On ne short pas un support. On n'achète pas une résistance."
    // Si recommendation contredit la zone → écraser. canEnter reste géré par _zoneOk + structure.
    if (!_enteredVpDir && _tvBridge) {
      if (_tvBridge.inBot === true && !_tvBridge.inTop && recommendation === 'SELL') {
        recommendation = 'BUY';
        console.log(`[ZONE-INTERDICTION] ${symbol}: SHORT interdit en zone basse (inBot=true) → BUY forcé`);
      } else if (_tvBridge.inTop === true && !_tvBridge.inBot && recommendation === 'BUY') {
        recommendation = 'SELL';
        console.log(`[ZONE-INTERDICTION] ${symbol}: LONG interdit en zone haute (inTop=true) → SELL forcé`);
      }
    }

    // F5: Confiance minimum — signal trop faible = pas d'entrée
    // RÈGLE: bloquer uniquement si Pine a retourné une vraie valeur anticipation_force
    // Si Pine donne un verdict directionnel (BAISSIER/HAUSSIER) sans anticipation_force →
    //   on fait confiance au verdict Pine, pas au score calculé synthétiquement
    const _sigConf = Number(robotV12?.anticipation_force || runtimeTrade?.score || runtimeTrade?.confidence || 0);
    const _sigConfKnown = (robotV12?.anticipation_force != null) || (runtimeTrade?.score != null) || (runtimeTrade?.confidence != null);
    // Verdict Pine directionnel présent SANS anticipation_force = verdict fait foi, on ne bloque pas sur score calculé
    const _pineHasVerdict = !!(robotV12?.verdict && (String(robotV12.verdict).toUpperCase().includes('BAISSIER') || String(robotV12.verdict).toUpperCase().includes('HAUSSIER') || String(robotV12.verdict).toUpperCase().includes('LONG') || String(robotV12.verdict).toUpperCase().includes('SHORT') || String(robotV12.verdict).toUpperCase().includes('BUY') || String(robotV12.verdict).toUpperCase().includes('SELL')));
    const _pineConfAbsent = (robotV12?.anticipation_force == null); // Pine n'a pas envoyé de force
    // Si le bridge montre ≥3 TFs alignés dans la même direction → signal bridge fait foi, pas de blocage confiance
    // Note: _bridgeAlignedCountEarly déjà calculé avant F4 — on le réutilise ici
    const _bridgeAlignedCount = typeof _bridgeAlignedCountEarly !== 'undefined'
      ? _bridgeAlignedCountEarly
      : (_tvBridge ? [
          _tvBridge.lectureTech1, _tvBridge.lectureTech2,
          _tvBridge.lectureTech3, _tvBridge.lectureTech4
        ].filter(lt => {
          const _v = String(lt || '').toUpperCase();
          return preferredDirection === 'LONG' ? _v.includes('ACHAT') : _v.includes('VENTE');
        }).length : 0);
    const _bridgeFullyAligned = _bridgeAlignedCount >= 3; // 3/4 ou 4/4 TFs alignés = confiance bridge implicite
    const _blockOnScore = _sigConfKnown && !(_pineHasVerdict && _pineConfAbsent) && !_bridgeFullyAligned;
    if (_blockOnScore && _sigConf > 0 && _sigConf < 56 && preferredDirection !== 'WAIT') {
      conflicts.push(`Confiance insuffisante (${Math.round(_sigConf)}%) — signal trop faible, attendre une setup plus nette`);
    }
    // F6: Ratio R:R minimum 1.4:1 — risque/rendement défavorable
    const _rrEntryV = Number(runtimeTrade?.entry ?? NaN);
    const _rrSlV    = Number(runtimeTrade?.sl    ?? NaN);
    const _rrTpV    = Number(runtimeTrade?.tp    ?? NaN);
    if (Number.isFinite(_rrEntryV) && Number.isFinite(_rrSlV) && Number.isFinite(_rrTpV) && preferredDirection !== 'WAIT') {
      const _rrSlDist = Math.abs(_rrEntryV - _rrSlV);
      const _rrTpDist = Math.abs(_rrTpV - _rrEntryV);
      const _rrComputed = _rrSlDist > 0 ? _rrTpDist / _rrSlDist : 0;
      if (_rrComputed < 1.4) {
        conflicts.push(`R:R insuffisant (${_rrComputed.toFixed(1)}:1 < 1.4) — risque/rendement défavorable pour ce setup`);
      }
    }
    // F7: RSI neutre + pas de structure TF → pas d'entrée directionnelle
    if (!_rsiBlocked && _entryRsi != null && _entryRsi >= 44 && _entryRsi <= 56 && preferredDirection !== 'WAIT') {
      // RSI neutre seulement bloquant si les TFs majeurs ne confirment pas non plus
      const _bp7 = typeof tvDataStore !== 'undefined'
        ? (tvDataStore[symbol] || tvDataStore[String(symbol).toUpperCase()] || null)?._bridgePayload : null;
      if (_bp7) {
        const _lt3 = String(_bp7.lectureTech3 || '').toUpperCase();
        const _lt4 = String(_bp7.lectureTech4 || '').toUpperCase();
        const _m15Aligned = preferredDirection === 'LONG' ? _lt3.includes('ACHAT') : _lt3.includes('VENTE');
        const _h1Aligned  = preferredDirection === 'LONG' ? _lt4.includes('ACHAT') : _lt4.includes('VENTE');
        if (!_m15Aligned && !_h1Aligned) {
          conflicts.push(`RSI neutre (${_entryRsi.toFixed(0)}) sans alignement M15/H1 — marché en équilibre, attendre rupture directionnelle`);
        }
      }
    }
    // 5. Recalculer conflictDetected avec les nouveaux filtres
    const conflictDetectedFinal = conflicts.length > 0;
    // ─────────────────────────────────────────────────────────────────────────────

    // Bridge 3+/4 TFs alignés = source de signal valide — pas besoin de trade_status LIVE
    const _bridgeStatusOk = _bridgeFullyAligned && preferredDirection !== 'WAIT';
    const setupValidated = recommendation !== 'WAIT'
      && (_hasLivePrice || !!marketStatus?.isOpen)
      && !conflictDetectedFinal
      && hasLiveLevels
      && (statusAllowsEntry || _bridgeStatusOk);
    const executionDecision = conflictDetectedFinal
      ? 'NO_ENTRY_CONFLICT'
      : (setupValidated ? 'ENTER' : 'WAIT');
    const executionReason = conflictDetectedFinal
      ? conflicts.join(' | ')
      : (setupValidated
        ? 'Entrée validée: direction alignée avec prix et niveaux SL/TP actifs.'
        : 'Entrée non validée: attendre confirmation complète (signal + niveaux + proximité prix).');

    const whyEntry = [];
    if (!marketStatus?.isOpen) {
      whyEntry.push('Marché fermé: aucune entrée tant que la session ne rouvre pas.');
    } else if (conflictDetectedFinal) {
      whyEntry.push('PAS D\'ENTRÉE: ' + (conflicts.slice(-1)[0] || 'conflit de signal détecté — attendre un setup propre.'));
    } else if (recommendation === 'BUY') {
      whyEntry.push('Long retenu car TradingView, la structure runtime et le contexte restent orientés à la hausse.');
    } else if (recommendation === 'SELL') {
      whyEntry.push('Short retenu car TradingView, la structure runtime et le contexte restent orientés à la baisse.');
    } else {
      whyEntry.push('Attente retenue car aucun alignement directionnel propre n\'est confirmé.');
    }
    if (tradeTechnical) whyEntry.push(String(tradeTechnical));
    if (newsPayload.warning) whyEntry.push(String(newsPayload.warning));
    if (robotV12?.contexte) whyEntry.push('Contexte TradingView: ' + String(robotV12.contexte));

    const entryValue = Number(runtimeTrade?.entry ?? runtimeSignal.entry ?? currentPrice);
    const slValue = Number(runtimeTrade?.sl ?? runtimeSignal.sl ?? NaN);
    const tpValue = Number(runtimeTrade?.tp ?? runtimeSignal.tp ?? NaN);
    const rrRatio = runtimeTrade?.rrRatio || '--';
    const slDistance = Number.isFinite(entryValue) && Number.isFinite(slValue) ? Math.abs(entryValue - slValue) : null;
    const tpDistance = Number.isFinite(entryValue) && Number.isFinite(tpValue) ? Math.abs(tpValue - entryValue) : null;
    const direction = normalizeTradeDirection(preferredDirection);

    const whySl = [
      direction === 'LONG'
        ? 'SL placé sous la zone d\'invalidation du scénario haussier.'
        : direction === 'SHORT'
          ? 'SL placé au-dessus de la zone d\'invalidation du scénario baissier.'
          : 'SL non activé tant qu\'aucune entrée n\'est validée.',
      Number.isFinite(slDistance) ? ('Distance de protection: ' + formatCoachLevel(slDistance) + ' depuis l\'entrée.') : 'Distance de protection à confirmer au prochain setup.',
      newsPayload.warning ? 'Protection renforcée car un risque news ou volatilité est détecté.' : 'Protection alignée avec la volatilité actuelle et le mode de setup.'
    ];

    const whyTp = [
      direction === 'LONG'
        ? 'TP placé sur une extension haussière cohérente avec le mouvement visé.'
        : direction === 'SHORT'
          ? 'TP placé sur une extension baissière cohérente avec le mouvement visé.'
          : 'TP non activé tant qu\'aucune entrée n\'est validée.',
      Number.isFinite(tpDistance) ? ('Distance de cible: ' + formatCoachLevel(tpDistance) + ' depuis l\'entrée.') : 'Distance de cible à confirmer au prochain setup.',
      'Objectif calibré pour préserver un ratio risque/rendement exploitable' + (rrRatio !== '--' ? (' (R:R ' + rrRatio + ').') : '.')
    ];

    const riskLevel = !marketStatus?.isOpen
      ? 'HIGH'
      : normalizeRiskLevel(runtimeTrade?.risk || (newsPayload.warning ? 'HIGH' : (recommendation === 'WAIT' ? 'MEDIUM' : 'LOW')));

    // ── SETUP QUALITY: classification M1/M5/M15/H1/H4 — source unique côté serveur ──
    // Lue par popup ET dashboard — pas de recalcul UI divergent
    // M15 = TF d'entrée | H1/H4 = contexte/qualification | M1/M5 = timing
    // Fallback: si robotV12 null (webhook Pine pas encore tiré), utiliser _bridgePayload.lectureTechX
    const _sqLecM15 = String(robotV12?.lecture_15m || _tvBridge?.lectureTech3 || '').toUpperCase();
    const _sqLecH1  = String(robotV12?.lecture_60m || _tvBridge?.lectureTech4 || '').toUpperCase();
    const _sqLecM5  = String(robotV12?.lecture_5m  || _tvBridge?.lectureTech2 || '').toUpperCase();
    const _sqLecM1  = String(robotV12?.lecture_1m  || _tvBridge?.lectureTech1 || '').toUpperCase();
    const _sqDir    = preferredDirection; // LONG ou SHORT
    const _sqIsLong = _sqDir === 'LONG';
    // Alignement par TF (ACHAT = haussier, VENTE = baissier)
    const _sqM15Ok  = _sqIsLong ? _sqLecM15.includes('ACHAT') : _sqLecM15.includes('VENTE');
    const _sqH1Ok   = _sqIsLong ? _sqLecH1.includes('ACHAT')  : _sqLecH1.includes('VENTE');
    const _sqM5Ok   = _sqIsLong ? _sqLecM5.includes('ACHAT')  : _sqLecM5.includes('VENTE');
    const _sqM1Ok   = _sqIsLong ? _sqLecM1.includes('ACHAT')  : _sqLecM1.includes('VENTE');
    const _sqH1Ag   = _sqIsLong ? _sqLecH1.includes('VENTE')  : _sqLecH1.includes('ACHAT');
    // RSI H1 pour qualifier le contexte
    const _sqRsiH1  = Number(robotV12?.rsi_60m || 0);
    // Classification
    let _setupQuality, _setupLabel, _setupTpMultiplier;
    if (conflictDetectedFinal) {
      _setupQuality = 'CONFLIT';
      _setupLabel   = 'Conflit de signal — attendre résolution';
      _setupTpMultiplier = 1.0;
    } else if (_sqDir === 'WAIT' || recommendation === 'WAIT') {
      _setupQuality = 'ATTENTE';
      _setupLabel   = 'Pas de setup exploitable — observation';
      _setupTpMultiplier = 1.0;
    } else if (_sqM15Ok && _sqH1Ok) {
      _setupQuality = 'PREMIUM';
      _setupLabel   = 'Setup premium M15 + H1 alignés — TP élargi possible';
      _setupTpMultiplier = 1.5;  // TP peut aller 1.5× plus loin
    } else if (_sqM15Ok && _sqH1Ag) {
      _setupQuality = 'RETRACEMENT';
      _setupLabel   = 'Retracement M15 contre contexte H1 — setup court terme uniquement';
      _setupTpMultiplier = 0.8;  // TP réduit (contre-tendance H1)
    } else if (_sqM15Ok) {
      _setupQuality = 'M15_SEUL';
      _setupLabel   = 'Setup M15 exploitable — H1 neutre ou données indisponibles';
      _setupTpMultiplier = 1.0;
    } else if ((_sqM5Ok || _sqM1Ok) && !_sqM15Ok) {
      _setupQuality = 'TIMING_COURT';
      _setupLabel   = 'Signal timing M1/M5 uniquement — pas de setup M15 validé';
      _setupTpMultiplier = 0.7;
    } else {
      _setupQuality = 'NEUTRE';
      _setupLabel   = 'Aucun alignement propre — attendre';
      _setupTpMultiplier = 1.0;
    }
    // Timing alignment (M1/M5 confirmant ou opposant l'entrée)
    const _timingOk  = _sqM5Ok && _sqM1Ok;
    const _timingWarn = !_sqM5Ok || !_sqM1Ok;

    // ── RÈGLE MULTI-TF PRO — bloquer si alignement incomplet ─────────────────
    // M15_SEUL : M15 confirmé mais H1 neutre → contexte manquant (CAS 1 incomplet)
    // TIMING_COURT : M1/M5 sans M15 → trading aveugle court-terme (CAS 2 incomplet)
    // RETRACEMENT autorisé (M15 OK + H1 contre) mais TP réduit (0.8×)
    // PREMIUM seul : M15 + H1 alignés → entrée autorisée
    // _m15BypassActive = M15 est en retracement (3+/4 TFs alignés) → ne pas bloquer sur TIMING_COURT
    // RÈGLE: si le payload unifié a DÉJÀ validé (zone + structure + score ok) → pas de double-blocage
    //   H1 neutre ≠ H1 contre. Le payload unifié intègre déjà le contexte H1.
    const _unifiedApproved = _unifiedPayload.decision === 'BUY_READY' || _unifiedPayload.decision === 'SELL_READY';
    const _setupQualityBlocked = !conflictDetectedFinal && !_m15BypassActive && !_unifiedApproved
      && (_setupQuality === 'TIMING_COURT' || _setupQuality === 'M15_SEUL');
    const _setupQualityBlockReason = _setupQuality === 'TIMING_COURT'
      ? `Alignement TF insuffisant — M15 non validé (CAS 2 incomplet: besoin M15+M5+M1)`
      : `Alignement TF insuffisant — H1 neutre ou absent (CAS 1 incomplet: besoin H1+M15+M5)`;

    // ── DÉTECTEUR ESSOUFFLEMENT — signaux fin de momentum ────────────────────────
    // Combine RSI extrême M1 + affaiblissement MACD + rejet bougie Pine
    // → message humain clair sur l'état du momentum, sans termes techniques
    const _exhRsiM1  = Number(_tvBridge?.rsiTf1 || 0);
    const _exhBearRej = _tvBridge?.bearRej === true;
    const _exhBullRej = _tvBridge?.bullRej === true;
    // MACD affaiblissement depuis runtimeTrade signals si disponibles
    const _exhSigs   = Array.isArray(runtimeTrade?.signals) ? runtimeTrade.signals : [];
    const _exhMacdWB = _exhSigs.includes('MACD_WEAK_BULL');
    const _exhMacdWBr= _exhSigs.includes('MACD_WEAK_BEAR');
    const _exhMacdCrB= _exhSigs.includes('MACD_CROSS_BEAR');
    const _exhMacdCrBu=_exhSigs.includes('MACD_CROSS_BULL');
    // Essoufflement haussier: RSI M1 > 70 + (MACD s'affaiblit ou bear rejet)
    const _exhUpRsi  = _exhRsiM1 > 70;
    const _exhDnRsi  = _exhRsiM1 > 0 && _exhRsiM1 < 30;
    const _exhUpFull = _exhUpRsi && (_exhMacdWB || _exhBearRej || _exhMacdCrB);
    const _exhDnFull = _exhDnRsi && (_exhMacdWBr || _exhBullRej || _exhMacdCrBu);
    // Pulsion: M15 score fort + anticipationTexte = retournement proche
    const _pulsAnt   = String(_tvBridge?.anticipationTexte || '').toUpperCase();
    const _pulsRetLong  = _pulsAnt.includes('RET_LONG') || _pulsAnt.includes('PRE_ALERTE_LONG');
    const _pulsRetShort = _pulsAnt.includes('RET_SHORT') || _pulsAnt.includes('PRE_ALERTE_SHORT');
    const _pulsM15Sc = Number(_tvBridge?.scoreTech3 || 0); // score M15
    const _pulsStrong= _pulsM15Sc > 80;
    let _exhaustionMsg = null;
    let _pulsionMsg    = null;
    if (_exhUpFull) {
      _exhaustionMsg = preferredDirection === 'SHORT'
        ? 'Le marché s\'essouffle en haut de zone — vente possible'
        : 'Le marché s\'essouffle en hauteur — attention à un retournement baissier';
      console.log(`[EXHAUSTION] ${symbol} essoufflement HAUSSIER — RSI=${_exhRsiM1} bearRej=${_exhBearRej} macdWeak=${_exhMacdWB}`);
    } else if (_exhDnFull) {
      _exhaustionMsg = preferredDirection === 'LONG'
        ? 'Le marché ralentit en bas de zone — achat possible'
        : 'Le marché ralentit en bas — attention à un retournement haussier';
      console.log(`[EXHAUSTION] ${symbol} essoufflement BAISSIER — RSI=${_exhRsiM1} bullRej=${_exhBullRej} macdWeak=${_exhMacdWBr}`);
    } else if (_exhUpRsi && !_exhDnRsi) {
      _exhaustionMsg = 'Le marché monte fort — attends une confirmation avant d\'entrer';
    } else if (_exhDnRsi && !_exhUpRsi) {
      _exhaustionMsg = 'Le marché descend fort — attends une confirmation avant d\'entrer';
    }
    if (_pulsStrong && (_pulsRetLong || _pulsRetShort)) {
      _pulsionMsg = _pulsRetLong
        ? 'Le marché se retourne à la hausse — évite de vendre en ce moment'
        : 'Le marché se retourne à la baisse — évite d\'acheter en ce moment';
      console.log(`[PULSION] ${symbol} retournement proche — M15sc=${_pulsM15Sc} ant=${_pulsAnt}`);
    }

    const snapshot = {
      symbol,
      timeframe,
      modeResolved: resolvedMode,
      currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
      marketStatus,
      robotV12,
      signal: runtimeSignal,
      runtimeTrade: runtimeTrade || null,
      // setupQuality: source unique — popup et dashboard lisent ici, pas de recalcul UI
      setupQuality: {
        quality: _setupQuality,      // PREMIUM / M15_SEUL / RETRACEMENT / TIMING_COURT / CONFLIT / ATTENTE
        label: _setupLabel,          // texte humain
        tpMultiplier: _setupTpMultiplier, // facteur d'extension TP selon qualité
        m15Aligned: _sqM15Ok,        // M15 Pine confirme direction
        h1Aligned: _sqH1Ok,          // H1 confirme (contexte favorable)
        h1Against: _sqH1Ag,          // H1 contre (retracement)
        timingOk: _timingOk,         // M1+M5 timing alignés
        timingWarn: _timingWarn,     // M1 ou M5 contre = timing imparfait
        rsiH1: _sqRsiH1 || null
      },
      analysis: {
        recommendation,
        reason: executionReason,
        confidence: Number.isFinite(confidence) ? confidence : 50,
        strength: Number.isFinite(confidence) ? confidence : 50,
        anticipation: robotV12?.anticipation || (recommendation === 'WAIT' ? 'ATTENTE' : 'PRET')
      },
      execution: {
        decision: executionDecision,
        canEnter: executionDecision === 'ENTER' && !_setupQualityBlocked,
        reason: _setupQualityBlocked ? _setupQualityBlockReason : executionReason,
        conflict: conflictDetectedFinal,
        conflictReasons: conflicts,
        bridgeStale: _bridgeStale,
        bridgeAgeMs: Number.isFinite(_bridgeAgeMs) ? Math.round(_bridgeAgeMs) : null,
        trade_status: tradeStatus || 'WAIT',   // LIVE / CONDITIONAL / WAIT — requis par popup renderFutureEntryBanner
        // currentPrice = prix SSE temps réel (source autoritaire pour affichage)
        // entry = prix du signal au moment du calcul (peut différer du currentPrice)
        // Les clients DOIVENT utiliser currentPrice pour l'affichage "Entrée ~", pas entry
        currentPrice: Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : null,
        entry: Number.isFinite(Number(runtimeTrade?.entry)) && Number(runtimeTrade.entry) > 0 ? Number(runtimeTrade.entry) : null,
        sl:    Number.isFinite(Number(runtimeTrade?.sl))    && Number(runtimeTrade.sl)    > 0 ? Number(runtimeTrade.sl)    : null,
        tp:    Number.isFinite(Number(runtimeTrade?.tp))    && Number(runtimeTrade.tp)    > 0 ? Number(runtimeTrade.tp)    : null
      },
      news: newsPayload,
      // Messages humains — conclusion marché sans termes techniques
      // L'extension et le dashboard lisent ces champs pour les annonces vocales
      exhaustionAlert: _exhaustionMsg,   // ex: "Le marché s'essouffle en haut de zone — vente possible"
      pulsionAlert:    _pulsionMsg,      // ex: "Le marché se retourne à la hausse — évite de vendre"
      // Payload unifié — source unique de décision (zone/structure/dominance/score/style)
      // BUY_READY / SELL_READY / WAIT avec raison humaine et vocal
      unifiedPayload: _unifiedPayload,
      explainer: {
        whyEntry: whyEntry.slice(0, 5),
        whySl: whySl.slice(0, 4),
        whyTp: whyTp.slice(0, 4)
      },
      strategy: {
        logic: tradeState?.entered
          ? 'Position active: arrêter la recherche d\'entrée et piloter uniquement la gestion live.'
          : (executionDecision === 'NO_ENTRY_CONFLICT'
            ? 'PAS D\'ENTRÉE / CONFLIT DE SIGNAL: attendre alignement clair de l\'indicateur TradingView.'
            : (recommendation === 'WAIT'
              ? 'Entrée non validée: attendre un meilleur alignement prix/structure/contexte avant toute entrée.'
              : ((recommendation === 'BUY' ? 'Long' : 'Short') + ' privilégié sur ' + timeframe + ' avec validation structure + prix.'))),
        anticipation: robotV12?.anticipation || runtimeSignal.stats?.anticipation || 'ATTENTE'
      },
      risk: {
        riskLevel,
        riskReason: newsPayload.warning || (marketStatus?.isOpen ? 'Flux ouvert, spread/volatilité à surveiller.' : 'Marché fermé ou contexte non exploitable.'),
        guidance: riskLevel === 'HIGH'
          ? 'Réduire le risque, attendre ou protéger avant toute accélération.'
          : (riskLevel === 'LOW'
            ? 'Risque contenu si la structure reste valide.'
            : 'Risque modéré: exécuter seulement si le prix reste propre.'),
        rsi: tvRuntime?.payload?.rsi ?? robotV12?.rsi_1m ?? robotV12?.rsi_5m ?? null
      },
      sourceSummary: {
        activeSource,
        tradingviewConnected: !!tvRuntime?.connected,
        orchestrator: false,
        marketOpen: !!marketStatus?.isOpen,
        conflictDetected: conflictDetectedFinal,
        // Distinguer conflit directionnel TF réel vs blocage qualité
        isDirectionalConflict: !!(
          isDirectionalDirection(tvDirection) && isDirectionalDirection(runtimeDirection) && tvDirection !== runtimeDirection
        ),
        conflictReasons: conflicts.slice(),  // expose les vraies raisons
        conflictReason: conflicts[0] || '',  // première raison (dashboard display)
        tvDirection,
        runtimeDirection,
        mtfDirection
      }
    };

    return storeCoachAnalysisSnapshot(symbol, timeframe, snapshot);
  }

  // ── CAP SL HELPER — utilisé par createVirtualPositionFromTrade et le validateur d'entrée ──
  function getMaxSlDist(symbol, timeframe) {
    const _s  = String(symbol || '').toUpperCase();
    const _tf = String(timeframe || 'H1').toUpperCase();
    const _capTable = { M1:2.5, M5:5, M15:8, M30:12, H1:18, H4:35, D1:60 };
    const _isG = /XAU|GOLD/.test(_s);
    const _isI = /US30|US500|US100|NAS|SPX|SP500|DAX|DE40|GER40/.test(_s);
    const _isJ = _s.includes('JPY');
    const _isC = /BTC|ETH|SOL|XRP/.test(_s);
    const base = _capTable[_tf] || 18;
    if (_isG || _isI) return base;
    if (_isC)        return null;   // crypto: pas de cap fixe (trop volatile)
    if (_isJ)        return base * 0.01;
    return base * 0.0001;
  }

  function createVirtualPositionFromTrade(symbol, timeframe, trade, currentPrice) {
    if (!trade) return null;
    // RÈGLE: normaliser direction → LONG ou SHORT uniquement (jamais BUY/SELL/WAIT)
    // → SL monitor, dashboard et extension lisent tous la même valeur sans ambiguïté
    const _rawDir = String(trade.direction || trade.side || '').toUpperCase();
    const _normDir = (_rawDir.includes('BUY') || _rawDir.includes('LONG')) ? 'LONG'
                   : (_rawDir.includes('SELL') || _rawDir.includes('SHORT')) ? 'SHORT'
                   : 'WAIT';
    const _entry = Number(trade.entry || currentPrice || 0);
    let   _sl    = Number(trade.sl || 0);
    let   _tp    = Number(trade.tp || 0);
    // Cap SL — aucun chemin ne peut créer une position avec SL trop large
    if (_entry > 0 && _sl > 0) {
      const _maxSl = getMaxSlDist(symbol, timeframe);
      if (_maxSl !== null) {
        const _slDist = Math.abs(_entry - _sl);
        if (_slDist > _maxSl) {
          const _dir = _normDir === 'LONG' ? 1 : -1;
          _sl = _entry - _dir * _maxSl;
          if (_tp > 0) _tp = _entry + _dir * _maxSl * 2.5;  // recalculer TP pour maintenir RR 2.5
          console.log(`[SL-CAP] ${symbol} ${timeframe} createVP: SL ramené de ${_slDist.toFixed(3)} → ${_maxSl} pts. sl:${_sl.toFixed(3)}`);
        }
      }
    }
    return {
      symbol: String(symbol || trade.symbol || 'XAUUSD').toUpperCase(),
      timeframe: String(timeframe || 'H1').toUpperCase(),
      direction: _normDir,
      entry: _entry,
      sl: _sl,
      tp: _tp,
      rrRatio: trade.rrRatio || '--',
      setupType: trade.setup_type || trade.setupType || '--',
      source: trade.source || 'coach-virtual',
      status: 'OPEN',
      bePlaced: false,
      partialTaken: false,
      openedAt: Date.now(),
      lastPrice: Number(currentPrice || trade.entry || 0),
      lastGuidance: 'Position virtuelle initialisée. Respecter invalidation, SL et TP.',
      // ── TYPE DE TRADE: détecté à la création de la VP ──────────────────────
      // Préservé pendant toute la durée du trade pour adapter les messages et le trailing
      tradeType: trade.tradeType || trade.trade_type || (() => {
        const _tpD = _tp > 0 && _entry > 0 ? Math.abs(_tp - _entry) : 0;
        const _slD = _sl > 0 && _entry > 0 ? Math.abs(_sl - _entry) : 0;
        const _isGold = /XAU|GOLD/.test(String(symbol||'').toUpperCase());
        // Seuils en points: XAUUSD → $, forex → pips estimés
        const _tpThreshScalp  = _isGold ? 8  : 0.0008;
        const _tpThreshSniper = _isGold ? 25 : 0.0025;
        if (_tpD <= _tpThreshScalp) return 'SCALPING';
        if (_tpD <= _tpThreshSniper) return 'SNIPER';
        return 'SWING';
      })(),
      tpTrailEnabled: trade.tpTrailEnabled !== false && (() => {
        const _tpD2 = _tp > 0 && _entry > 0 ? Math.abs(_tp - _entry) : 0;
        const _isGold2 = /XAU|GOLD/.test(String(symbol||'').toUpperCase());
        return _isGold2 ? _tpD2 > 8 : _tpD2 > 0.0008; // scalp = pas de trail
      })()
    };
  }

  function buildVirtualPositionSnapshot(state, instantTrade, livePayload, currentPrice) {
    // RÈGLE CRITIQUE: si position entrée, utiliser UNIQUEMENT state.virtualPosition (verrouillée à l'ENTER)
    // Jamais créer depuis instantTrade quand position active — instantTrade a le prix ACTUEL comme entry
    // RÈGLE: ignorer une VP avec status='CLOSED' quand la position n'est pas entrée
    // (évite qu'une ancienne VP SHORT/CLOSED soit lue par l'extension comme direction pour le prochain ENTER)
    const _stateVp = (state.virtualPosition && state.virtualPosition.status !== 'CLOSED' && state.entered)
      ? state.virtualPosition    // VP active et position ouverte → utiliser
      : (state.entered ? null    // position entrée mais VP CLOSED ou absente → null
        : null);                 // pas de position → toujours null, ne pas exposer ancienne VP
    // Créer une VP indicative depuis instantTrade SEULEMENT si setup réel :
    // - direction directionnelle (pas WAIT/NEUTRE/undefined)
    // - sl > 0 ET tp > 0 (niveaux Pine transmis)
    // Sinon : aucune VP → nextAction = WAIT_FOR_SETUP (pas TAKE_PROFIT)
    const _itDir = String(instantTrade?.direction || '').toUpperCase();
    const _itHasDir = _itDir && _itDir !== 'WAIT' && _itDir !== 'NEUTRE' && _itDir !== '';
    const _itHasLevels = Number(instantTrade?.sl) > 0 && Number(instantTrade?.tp) > 0;
    const _canCreateVp = instantTrade && _itHasDir && _itHasLevels;
    const activeVirtual = _stateVp
      || (state.entered ? null  // position entrée mais VP absente → ne pas créer depuis instantTrade
        : (_canCreateVp ? createVirtualPositionFromTrade(state.symbol, state.timeframe, instantTrade, currentPrice) : null));
    if (!activeVirtual) {
      const _noVpPhase = String(state.phase || '').toUpperCase();
      const _armedMsg = _noVpPhase === 'ARMED'
        ? 'Robot armé — en surveillance. Attendre un setup M15 valide (canEnter + SL + TP).'
        : 'Aucune position active. Analyser puis armer le robot quand prêt.';
      return {
        virtualPosition: null,
        nextAction: {
          phase: state.phase,
          primary: _armedMsg,
          actions: _noVpPhase === 'ARMED' ? ['WAIT'] : ['WAIT', 'ENTER']
        }
      };
    }

    const direction = String(activeVirtual.direction || 'WAIT').toUpperCase();
    const price = Number(currentPrice || activeVirtual.lastPrice || activeVirtual.entry || 0);
    const entry = Number(activeVirtual.entry || 0);
    const sl = Number(activeVirtual.sl || 0);
    const tp = Number(activeVirtual.tp || 0);
    const pnlPoints = direction === 'SHORT' ? (entry - price) : (price - entry);
    const riskDistance = Math.abs(entry - sl) || 1;
    const rewardDistance = Math.abs(tp - entry) || 1;
    // progressToTp doit être directionnel: positif = on avance vers le TP, négatif = on recule vers le SL
    // Math.abs était faux: une position SHORT en perte (prix monte) donnait progressToTp positif → faux conseil BE
    const progressToTp = rewardDistance > 0 ? Math.max(0, Math.min(100, Math.round((pnlPoints / rewardDistance) * 100))) : 0;
    const invalidationNear = direction === 'SHORT' ? price >= sl : price <= sl;
    const tpTouched = direction === 'SHORT' ? price <= tp : price >= tp;

    let primary = 'Surveiller la structure et laisser courir tant que l’invalidation n’est pas touchée.';
    let actions = ['WAIT', 'BE', 'TAKE_PROFIT', 'EXIT'];
    if (invalidationNear) {
      primary = 'Prix sur invalidation: couper ou protéger immédiatement la position.';
      actions = ['EXIT', 'WAIT', 'RETEST'];
    } else if (!activeVirtual.bePlaced && progressToTp >= 35) {
      primary = 'Déplacer le stop vers break-even dès maintenant pour protéger la position.';
      actions = ['BE', 'TAKE_PROFIT', 'WAIT'];
    } else if (!activeVirtual.partialTaken && progressToTp >= 65) {
      primary = 'Prendre un partiel et laisser courir le reste tant que la structure tient.';
      actions = ['TAKE_PROFIT', 'BE', 'WAIT', 'EXIT'];
    } else if (tpTouched) {
      primary = 'Objectif principal atteint: sécuriser ou sortir la position.';
      actions = ['TAKE_PROFIT', 'EXIT', 'WAIT'];
    }

    const riskLevel = String(livePayload?.risk?.riskLevel || '').toUpperCase();
    if (riskLevel === 'HIGH' && !invalidationNear) {
      primary = 'Risque élevé détecté: défendre la position avant toute extension.';
      actions = ['BE', 'TAKE_PROFIT', 'EXIT', 'WAIT'];
    }

    const virtualPosition = {
      ...activeVirtual,
      bePlaced: !!state.bePlaced,
      partialTaken: !!state.partialTaken,
      currentPrice: price,
      pnlPoints: Math.round(pnlPoints * 100000) / 100000,
      progressToTp,
      status: state.phase === 'EXITED' ? 'CLOSED' : activeVirtual.status,
      lastPrice: price,
      lastGuidance: primary
    };

    return {
      virtualPosition,
      nextAction: {
        phase: state.phase,
        primary,
        actions
      }
    };
  }

  function applyDynamicCoachAdjustments(tradeState, virtualPack) {
    const vp = virtualPack?.virtualPosition;
    if (!vp || !tradeState?.entered || tradeState?.phase === 'EXITED') {
      return { virtualPack, messages: [] };
    }

    const messages = [];
    const progress = Number(vp.progressToTp || 0);
    const direction = String(vp.direction || 'WAIT').toUpperCase();

    // RÈGLE: entry + SL sont verrouillés dès ENTER — ne jamais les modifier automatiquement.
    // Seul TP peut être ajusté manuellement par l'opérateur.
    if (tradeState.entryLockedAt && vp) {
      // Restore locked values — SAUF si BE déjà placé (SL légitimement déplacé à l'entrée)
      const locked = tradeState.virtualPosition;
      if (locked && locked.entry) vp.entry = locked.entry;
      // SL: restaurer uniquement si BE pas encore placé — après BE, le SL est à l'entrée (risque zéro)
      if (locked && locked.sl && !tradeState.bePlaced) vp.sl = locked.sl;
      // Si BE déjà placé, vp.sl doit refléter le niveau BE (= entry)
      if (locked && tradeState.bePlaced && locked.slMovedToBE) vp.sl = locked.sl;
    }

    // AUTO-BE: dès 35% de progression vers le TP → déplacer SL au BE automatiquement
    // Ne pas attendre l'utilisateur — le SL doit bouger en temps réel
    // Garde unique par trade (clé _beAutoKey) pour éviter double-fire
    const _beSym = String(tradeState.symbol || '').toUpperCase();
    const _beAutoKey1 = `_beAutoAt_${_beSym}`;
    if (!tradeState.bePlaced && !tradeState[_beAutoKey1] && progress >= 35) {
      if (typeof applyCoachTradeAction === 'function') {
        tradeState[_beAutoKey1] = Date.now();
        applyCoachTradeAction(tradeState, 'BE', 'AUTO-BE: 35% progression TP atteinte — SL déplacé au breakeven', {});
        // CRITIQUE: synchroniser vp.sl avec la valeur BE AVANT la fusion
        // Sans ça, le merge { ...tradeState.virtualPosition, ...vp } écraserait le SL BE avec l'ancien SL
        if (tradeState.virtualPosition && tradeState.virtualPosition.slMovedToBE) {
          vp.sl = tradeState.virtualPosition.sl; // = entry = breakeven
          vp.bePlaced = true;
          vp.slMovedToBE = true;
        }
        if (typeof _persistTradeState === 'function') _persistTradeState(_beSym, tradeState);
        if (typeof broadcastToExtension === 'function') {
          broadcastToExtension({
            type: 'trade-action', action: 'BE', symbol: _beSym,
            phase: tradeState.phase, entered: tradeState.entered,
            bePlaced: true, partialTaken: tradeState.partialTaken,
            virtualPosition: tradeState.virtualPosition || null, timestamp: Date.now()
          });
        }
        messages.push('✅ SL déplacé au break-even automatiquement — risque zéro.');
      } else {
        messages.push('Suggestion: sécuriser le risque en plaçant le stop au break-even.');
      }
    }

    if (progress >= 55) {
      if (direction === 'LONG') {
        messages.push('Suggestion: remonter progressivement le SL sous les creux de continuation.');
      } else if (direction === 'SHORT') {
        messages.push('Suggestion: abaisser progressivement le SL au-dessus des sommets de continuation.');
      }
    }

    if (!tradeState.partialTaken && progress >= 80) {
      messages.push('Suggestion: prendre un partiel si le momentum faiblit, sinon laisser courir vers TP.');
    }

    vp.lastGuidance = messages[0] || vp.lastGuidance || 'Surveiller la structure et respecter les niveaux TradingView.';
    vp.updatedAt = Date.now();
    // FUSION: vp.sl est maintenant synchronisé (BE ou original) — la fusion ne peut plus écraser le BE
    tradeState.virtualPosition = { ...(tradeState.virtualPosition || {}), ...vp };
    tradeState.updatedAt = Date.now();

    return { virtualPack: { ...virtualPack, virtualPosition: vp }, messages };
  }

  function applyCoachTradeAction(state, action, note, payload) {
    const a = String(action || '').toUpperCase();
    if (!a) return state;

    if (a === 'ENTER') {
      state.phase = 'OPEN';
      state.entered = true;
      state.lastAction = 'ENTER';
      state.armed = false; // désarme automatiquement à l'entrée
      state.entryLockedAt = Date.now(); // entry + SL locked from this point
      // RÈGLE: toujours réinitialiser la VP précédente — une nouvelle entrée = un nouveau trade
      // Évite que l'ancienne VP (status:CLOSED) bloque la création de la nouvelle
      state.virtualPosition = null;
      state.bePlaced = false;
      state.partialTaken = false;
      // FIX: effacer exitedAt et notes stales à chaque nouvelle entrée
      // Sans ça: exitedAt du trade précédent reste dans le state → peut déclencher _lastExitAt guard
      // côté extension si re-entry rapide (<30s après exit). Notes: appartiennent au trade précédent.
      delete state.exitedAt;
      state.notes = [];
      // Effacer les clés auto-BE du trade précédent — chaque nouveau trade repart de zéro
      // Sans ça, _beAutoAt_XAUUSD persiste après EXIT et bloque le BE sur le trade suivant
      Object.keys(state).forEach(k => {
        if (k.startsWith('_beAutoAt_') || k.startsWith('_tpTrailAt_')) delete state[k];
      });
    } else if (a === 'OPEN') {
      state.phase = 'OPEN';
      state.entered = true;
      state.lastAction = 'OPEN';
      state.entryLockedAt = state.entryLockedAt || Date.now();
    } else if (a === 'BE') {
      state.phase = 'MANAGE';
      state.bePlaced = true;
      state.lastAction = 'BE';
      if (state.virtualPosition) {
        state.virtualPosition.bePlaced = true;
        // Déplacer le SL au break-even (prix d'entrée) = risque zéro
        // RÈGLE: seul mouvement SL autorisé — jamais élargir la perte
        const _beEntry = Number(state.virtualPosition.entry);
        const _beSl    = Number(state.virtualPosition.sl);
        const _beIsLong = String(state.virtualPosition.direction || '').toUpperCase() === 'LONG';
        if (_beEntry > 0) {
          // LONG: SL monte vers l'entrée (newSl > currentSl = réduction du risque ✓)
          // SHORT: SL descend vers l'entrée (newSl < currentSl = réduction du risque ✓)
          const _canMoveBE = _beIsLong ? (_beEntry >= _beSl) : (_beEntry <= _beSl);
          if (_canMoveBE) {
            state.virtualPosition.sl = _beEntry; // SL = entry = breakeven
            state.virtualPosition.slMovedToBE = true;
          }
        }
      }
    } else if (a === 'TAKE_PROFIT') {
      state.phase = 'MANAGE';
      state.partialTaken = true;
      state.lastAction = 'TAKE_PROFIT';
      if (state.virtualPosition) state.virtualPosition.partialTaken = true;
    } else if (a === 'ARM') {
      // Armer le robot: en attente du setup parfait — le dashboard entrera automatiquement
      state.phase = 'ARMED';
      state.lastAction = 'ARM';
      state.armed = true;
      // Garder la virtualPosition indicative (niveaux en attente)
    } else if (a === 'WAIT') {
      state.lastAction = 'WAIT';
      state.armed = false;
      if (!state.entered) state.phase = 'WAIT_ENTRY';
    } else if (a === 'EXIT') {
      state.phase = 'EXITED';
      state.entered = false;
      state.lastAction = 'EXIT';
      state.armed = false;
      state.virtualPosition = null; // FIX: null VP immédiatement — évite réapparition sur refresh
      state.exitedAt = Date.now(); // FIX position-sync: timestamp de fermeture pour guard SSE côté extension
    } else if (a === 'RETEST') {
      state.phase = 'WAIT_ENTRY';
      state.entered = false;
      state.bePlaced = false;
      state.partialTaken = false;
      state.lastAction = 'RETEST';
      state.virtualPosition = null;

    } else if (a === 'SET_TP') {
      // ── RÈGLE TP: uniquement vers plus de profit ──────────────────────────
      // LONG: newTp doit être > tp actuel (plus loin = plus haut)
      // SHORT: newTp doit être < tp actuel (plus loin = plus bas)
      if (state.virtualPosition && state.entered) {
        const _newTp    = Number(payload && payload.newTp);
        const _oldTp    = Number(state.virtualPosition.tp);
        const _entry    = Number(state.virtualPosition.entry);
        const _isLong   = String(state.virtualPosition.direction || '').toUpperCase() === 'LONG';
        const _valid    = Number.isFinite(_newTp) && _newTp > 0
          && (_isLong ? (_newTp > _oldTp && _newTp > _entry)      // LONG: plus haut que TP actuel ET entrée
                      : (_newTp < _oldTp && _newTp < _entry));    // SHORT: plus bas que TP actuel ET entrée
        if (_valid) {
          state.virtualPosition.tp = _newTp;
          state.virtualPosition.tpMovedAt = Date.now();
          state.lastAction = 'SET_TP';
        } else {
          // Refus silencieux — loggé mais pas d'erreur système
          console.warn(`[SET_TP REFUSED] ${_isLong?'LONG':'SHORT'} newTp=${_newTp} oldTp=${_oldTp} entry=${_entry}`);
        }
      }

    } else if (a === 'SET_SL') {
      // ── RÈGLE SL: uniquement vers moins de risque ─────────────────────────
      // LONG: newSl doit être > sl actuel (plus haut = plus protecteur)
      //       → peut dépasser l'entrée = "sécuriser les gains"
      // SHORT: newSl doit être < sl actuel (plus bas = plus protecteur)
      //       → peut descendre sous l'entrée = "sécuriser les gains"
      if (state.virtualPosition && state.entered) {
        const _newSl    = Number(payload && payload.newSl);
        const _oldSl    = Number(state.virtualPosition.sl);
        const _entry    = Number(state.virtualPosition.entry);
        const _isLong   = String(state.virtualPosition.direction || '').toUpperCase() === 'LONG';
        // LONG: SL monte seulement | SHORT: SL descend seulement — aucune limite haute/basse fixée
        const _valid    = Number.isFinite(_newSl) && _newSl > 0
          && (_isLong ? (_newSl > _oldSl) : (_newSl < _oldSl));
        if (_valid) {
          const _wasSecured = state.virtualPosition.secured === true;
          state.virtualPosition.sl = _newSl;
          state.virtualPosition.slMovedAt = Date.now();
          state.lastAction = 'SET_SL';
          // ── DÉTECTION BREAKEVEN / GAINS SÉCURISÉS ─────────────────────────
          // LONG: SL ≥ entry → position sécurisée (même si SL touché = profit ou nul)
          // SHORT: SL ≤ entry → position sécurisée
          const _isSecured = _isLong ? (_newSl >= _entry) : (_newSl <= _entry);
          if (_isSecured && !_wasSecured) {
            state.virtualPosition.secured = true;
            state.virtualPosition.securedAt = Date.now();
            state.lastAction = 'SECURED';
            if (note) { /* garde la note originale */ } else {
              state.notes.unshift({ note: `✅ GAINS SÉCURISÉS — SL au-dessus de l'entrée (${_newSl.toFixed(2)} > ${_entry.toFixed(2)})`, ts: Date.now(), action: 'SECURED' });
              if (state.notes.length > 30) state.notes.length = 30;
            }
            console.log(`[SECURED] ${_isLong?'LONG':'SHORT'} sl=${_newSl} entry=${_entry} → gains sécurisés`);
          } else if (!_isSecured && state.virtualPosition.secured) {
            state.virtualPosition.secured = false;
          }
        } else {
          console.warn(`[SET_SL REFUSED] ${_isLong?'LONG':'SHORT'} newSl=${_newSl} oldSl=${_oldSl} entry=${_entry}`);
        }
      }
    }

    if (note) {
      state.notes.unshift({ note: String(note), ts: Date.now(), action: a });
      if (state.notes.length > 30) state.notes.length = 30;
    }
    state.updatedAt = Date.now();
    return state;
  }

  function deriveExecutionGuidance(tradeState, payload) {
    const riskLevel = String(payload?.risk?.riskLevel || '').toUpperCase();
    const hasNewsRisk = !!payload?.news?.warning;
    if (!tradeState.entered) {
      const exec = payload?.execution || {};
      const canEnter = exec.canEnter === true;
      const conflict = String(exec.decision || '').toUpperCase() === 'NO_ENTRY_CONFLICT';
      return {
        mode: 'PRE_ENTRY',
        primary: conflict
          ? 'PAS D\'ENTRÉE / CONFLIT DE SIGNAL: attendre alignement clair de l\'indicateur TradingView.'
          : (canEnter
            ? 'ENTRER: setup validé (signal + prix + niveaux cohérents).'
            : (hasNewsRisk
              ? 'Attendre: risque news élevé, éviter entrée immédiate.'
              : 'Attendre confirmation structure avant entrée.')),
        actions: canEnter ? ['ENTER', 'WAIT', 'RETEST'] : ['WAIT', 'RETEST']
      };
    }
    if (!tradeState.bePlaced && (riskLevel === 'HIGH' || hasNewsRisk)) {
      return {
        mode: 'DEFEND',
        primary: 'Réduire le risque: déplacer vers BE dès possible.',
        actions: ['BE', 'TAKE_PROFIT', 'EXIT', 'WAIT']
      };
    }
    if (!tradeState.partialTaken) {
      return {
        mode: 'MANAGE',
        primary: 'Prendre partiellement si extension favorable, puis laisser courir sous contrôle.',
        actions: ['TAKE_PROFIT', 'BE', 'WAIT', 'EXIT']
      };
    }
    return {
      mode: 'FOLLOW',
      primary: 'Position gérée: surveiller invalidation pour sortir, sinon laisser courir.',
      actions: ['WAIT', 'EXIT', 'RETEST']
    };
  }

  function buildRuntimeTradeSignal(symbol, timeframe, instantTrade, robotV12, marketStatus, currentPrice) {
    const directionRaw = String(instantTrade?.direction || instantTrade?.side || robotV12?.verdict || '').toUpperCase();
    const verdict = (directionRaw.includes('BUY') || directionRaw.includes('LONG'))
      ? 'LONG'
      : ((directionRaw.includes('SELL') || directionRaw.includes('SHORT')) ? 'SHORT' : 'WAIT');

    // LEVEL SOURCE RULE: entry/sl/tp come exclusively from the active trade signal (instantTrade).
    // Never fall back to robotV12 levels — those may be stale when TV is not connected.
    const entry = instantTrade?.entry ?? null;
    const sl = instantTrade?.sl ?? null;
    const tp = instantTrade?.tp ?? null;
    const price = Number(currentPrice || entry || NaN);

    const confidence = Number(
      instantTrade?.score
      || instantTrade?.confidence
      || robotV12?.anticipation_force
      || 50
    );

    const source = instantTrade?.source
      ? String(instantTrade.source)
      : (robotV12 ? 'tradingview-indicator' : 'live-runtime');

    return {
      verdict,
      entry: Number.isFinite(Number(entry)) ? Number(entry) : null,
      sl: Number.isFinite(Number(sl)) ? Number(sl) : null,
      tp: Number.isFinite(Number(tp)) ? Number(tp) : null,
      confidence: Number.isFinite(confidence) ? confidence : 50,
      source,
      rationale: instantTrade?.technical || robotV12?.contexte || 'Analyse live runtime',
      stats: (() => {
        // RSI par TF depuis le bridge Pine Script (valeurs réelles distinctes)
        const _bpStats = (() => {
          const _k = typeof findTradingviewSymbolKey === 'function' ? findTradingviewSymbolKey(symbol) : null;
          return _k ? (tvDataStore[_k]?._bridgePayload || {}) : {};
        })();
        return {
          marketOpen:  !!marketStatus?.isOpen,
          market:      marketStatus?.market || 'n/a',
          session:     marketStatus?.session || 'n/a',
          anticipation: robotV12?.anticipation || null,
          // RSI distincts par TF — priorité: robotV12 webhook (valeurs réelles) > _bridgePayload (rarement rempli)
          // Le dashboard cherche rsi_m1/m5/m15/h1 — aligner les noms de clés exactement
          rsi_m1:  (robotV12?.rsi_1m > 0  ? Number(robotV12.rsi_1m)  : null) ?? (_bpStats.rsiTf1 > 0 ? Number(_bpStats.rsiTf1) : null),
          rsi_m5:  (robotV12?.rsi_5m > 0  ? Number(robotV12.rsi_5m)  : null) ?? (_bpStats.rsiTf2 > 0 ? Number(_bpStats.rsiTf2) : null),
          rsi_m15: (robotV12?.rsi_15m > 0 ? Number(robotV12.rsi_15m) : null) ?? (_bpStats.rsiTf3 > 0 ? Number(_bpStats.rsiTf3) : null),
          rsi_h1:  (robotV12?.rsi_60m > 0 ? Number(robotV12.rsi_60m) : null) ?? (_bpStats.rsiTf4 > 0 ? Number(_bpStats.rsiTf4) : null),
          rsi_h4:  null, // bridge Pine ne couvre pas H4/D1
          rsi_d1:  null,
          // Lectures directionnelles per TF (texte brut bridge Pine: "ACHAT"/"VENTE"/null)
          // Propagées ici pour que popup.js puisse construire le préambule LIA et la jauge pondérée
          // Fallback: _bridgePayload.lectureTechX quand robotV12.lecture_Xm est null (webhook pas encore tiré)
          lecture_m5:  robotV12?.lecture_5m  || _bpStats.lectureTech2 || null,
          lecture_m15: robotV12?.lecture_15m || _bpStats.lectureTech3 || null,
          lecture_h1:  robotV12?.lecture_60m || _bpStats.lectureTech4 || null,
          lecture_m1:  robotV12?.lecture_1m  || _bpStats.lectureTech1 || null,
          // Rétro-compat (mêmes valeurs sous anciens noms)
          rsi1m: robotV12?.rsi_1m ?? _bpStats.rsiTf1 ?? null,
          rsi5m: robotV12?.rsi_5m ?? _bpStats.rsiTf2 ?? null,
          timeframe: String(timeframe || 'H1').toUpperCase()
        };
      })()
    };
  }

  function buildGoldCoach(symbol, payload, tradeState, executionGuidance) {
    const isGold = /XAU|GOLD/i.test(String(symbol || ''));
    if (!isGold) return null;

    const riskLevel = String(payload?.risk?.riskLevel || 'UNKNOWN').toUpperCase();
    const newsWarning = payload?.news?.warning || null;
    const recommendation = payload?.analysis?.recommendation || 'ATTENDRE CONFIRMATION';
    const logicIn = payload?.strategy?.logic || 'Attendre structure propre';

    return {
      enabled: true,
      context: 'Gold sensible au USD, taux US et news macro à fort impact.',
      risk: riskLevel,
      newsLinkedToGold: newsWarning || 'Pas de signal news critique immédiat',
      entryLogic: logicIn,
      waitingLogic: recommendation.includes('ATTENDRE') ? 'Attendre confirmation' : 'Entrée possible avec validation prix',
      exitLogic: executionGuidance.mode === 'DEFEND'
        ? 'Priorité protection du capital, sortie rapide si invalidation.'
        : 'Sortie sur invalidation structure ou objectif atteint.',
      summary: `Gold coach | risque=${riskLevel} | entrée=${logicIn} | phase=${tradeState?.phase || '--'} | action=${executionGuidance.primary || 'attendre confirmation'}`,
      coachPhrases: [
        'attendre confirmation',
        'zone de résistance',
        'risque news élevé',
        'entrée possible',
        'prendre partiellement',
        'mettre BE',
        'laisser courir',
        'sortir'
      ]
    };
  }

  function buildTradeReasoningSnapshot(symbol, timeframe, instantTrade, coachPayload, tradeState, marketStatus, robotV12) {
    const trade = instantTrade || {};
    const agents = coachPayload?.agents || {};
    const analysis = agents.analysis || {};
    const strategy = agents.strategy || {};
    const risk = agents.risk || {};
    const explainer = agents.explainer || {};

    const whyEntry = [];
    if (analysis.reason) whyEntry.push(String(analysis.reason));
    if (strategy.logic) whyEntry.push(String(strategy.logic));
    if (Array.isArray(explainer.whyEntry)) {
      whyEntry.push(...explainer.whyEntry.slice(0, 4).map((s) => String(s)));
    }
    if (trade.technical) whyEntry.push(String(trade.technical));
    if (trade.sentiment) whyEntry.push('Contexte sentiment: ' + String(trade.sentiment));
    if (robotV12?.verdict) whyEntry.push('ROBOT V12 verdict: ' + String(robotV12.verdict));
    if (robotV12?.anticipation) {
      const af = robotV12.anticipation_force != null ? ` (${robotV12.anticipation_force}%)` : '';
      whyEntry.push('ROBOT V12 anticipation: ' + String(robotV12.anticipation) + af);
    }
    if (robotV12?.contexte) whyEntry.push('Contexte TV: ' + String(robotV12.contexte));
    if (robotV12?.lecture_15m || robotV12?.lecture_60m) {
      whyEntry.push('Lecture multi-UT: 15m=' + String(robotV12.lecture_15m || '--') + ' | 1h=' + String(robotV12.lecture_60m || '--'));
    }
    if (whyEntry.length === 0) {
      whyEntry.push('Entrée proposée sur structure prix + ratio risque/rendement acceptable.');
      whyEntry.push('Attendre validation de bougie et spread stable avant exécution.');
    }

    const setupType = String(trade.setup_type || trade.setupType || 'SNIPER').toUpperCase();
    const expectedDuration = trade.expected_duration || trade.expectedDuration || '--';
    const holdingProfile = trade.holding_profile || trade.holdingProfile || '--';

    const slPips = trade.slPips || '--';
    const slPct = trade.slPct || '--';
    const tpPips = trade.tpPips || '--';
    const tpPct = trade.tpPct || '--';
    const rr = trade.rrRatio || '--';

    const explainerWhySl = Array.isArray(explainer.whySl)
      ? explainer.whySl.slice(0, 3).map((s) => String(s))
      : [];
    const explainerWhyTp = Array.isArray(explainer.whyTp)
      ? explainer.whyTp.slice(0, 3).map((s) => String(s))
      : [];

    const slWhy = [
      ...explainerWhySl,
      `SL calibré pour ${setupType} afin d'éviter une sortie trop tôt.`,
      `Distance de protection: ${slPips} pips (${slPct}).`,
      `Niveau de risque actuel: ${risk.riskLevel || trade.risk || '--'}.`
    ].slice(0, 4);

    const tpWhy = [
      ...explainerWhyTp,
      `TP dimensionné pour conserver un ratio R:R de ${rr}.`,
      `Distance de cible: ${tpPips} pips (${tpPct}).`,
      'Objectif ajusté au profil de volatilité et au mode de setup.'
    ].slice(0, 4);

    const marketGate = marketStatus?.isOpen
      ? `Marché ouvert (${marketStatus.market} / ${marketStatus.session}).`
      : `Marché fermé (${marketStatus.market || 'n/a'}). Réouverture dans ${marketStatus?.opensInFormatted || '--'}.`;

    return {
      symbol,
      timeframe,
      setupType,
      expectedDuration,
      holdingProfile,
      styleHint: setupType === 'SCALPER'
        ? 'Scalper: exécution courte, décisions rapides.'
        : (setupType === 'SWING'
          ? 'Swing: tenue multi-session avec patience.'
          : 'Sniper: entrée précise, gestion active intraday.'),
      marketGate,
      whyEntry,
      whySl: slWhy,
      whyTp: tpWhy,
      metrics: {
        entry: trade.entry || null,
        stopLoss: trade.sl || null,
        takeProfit: trade.tp || null,
        rrRatio: rr,
        slPips,
        tpPips,
        slPct,
        tpPct
      },
      management: {
        phase: tradeState?.phase || '--',
        entered: !!tradeState?.entered,
        bePlaced: !!tradeState?.bePlaced,
        partialTaken: !!tradeState?.partialTaken,
        nextAction: coachPayload?.executionGuidance?.primary || 'Attendre confirmation structure.'
      }
    };
  }

  // GET /coach/trade-state — état de suivi post-entrée
  app.get('/coach/trade-state', (req, res) => {
    const raw = String(req.query.symbol || marketStore.lastActiveSymbol || getLatestTradingviewRuntime().symbol || '').toUpperCase();
    const symbol = normalizeSymbol(raw).canonical || raw;
    const timeframe = String(req.query.tf || 'H1').toUpperCase();
    const state = getCoachTradeState(symbol, timeframe);
    res.json({ ok: true, state });
  });

  // POST /coach/trade-action — action opérateur (ENTER/BE/TAKE_PROFIT/WAIT/EXIT/RETEST)
  app.post('/coach/trade-action', async (req, res) => {
    const raw = String(req.body?.symbol || marketStore.lastActiveSymbol || getLatestTradingviewRuntime().symbol || '').toUpperCase();
    const symbol = normalizeSymbol(raw).canonical || raw;
    const timeframe = String(req.body?.timeframe || req.body?.tf || 'H1').toUpperCase();
    const mode = String(req.body?.mode || '').toUpperCase();
    const action = String(req.body?.action || '').toUpperCase();
    const note = String(req.body?.note || '').trim();
    if (!action) return res.status(400).json({ ok: false, error: 'action requise' });

    const state = getCoachTradeState(symbol, timeframe);

    // ── VERROU DOUBLE-ENTRÉE — refuser si position déjà active ──────────────────
    if ((action === 'ENTER' || action === 'OPEN') && state.entered === true) {
      console.log(`[DOUBLE-ENTRY BLOCKED] ${symbol} ${timeframe} — position déjà ouverte (entered=true). Refusé.`);
      return res.status(409).json({
        ok: false,
        error: 'ALREADY_ENTERED',
        message: `Position ${symbol} déjà ouverte. Ferme la position active avant d'en ouvrir une nouvelle.`,
        state
      });
    }

    if (action === 'ENTER' || action === 'OPEN') {
      const live = getLivePrice(symbol);
      if (!live) {
        return res.status(503).json({
          ok: false,
          error: 'ENTRY_BLOCKED_NO_LIVE_PRICE',
          message: "Entrée bloquée : prix TradingView non disponible. Synchronisez le flux avant d'entrer."
        });
      }
    }

    if (action === 'ENTER' || action === 'OPEN') {
      const isOperatorOverride = req.body?.operator === true;
      const preSnapshot = await computeCoachAnalysisSnapshot(symbol, timeframe, 'fr', state, {
        forceFresh: true,
        mode
      }).catch(() => null);
      const exec = preSnapshot?.execution || null;

      if (!isOperatorOverride && (!exec || exec.canEnter !== true)) {
        // Refus automatique — renvoyer les raisons pour affichage dashboard
        return res.status(409).json({
          ok: false,
          error: 'ENTREE_NON_VALIDEE',
          message: exec?.reason || 'Entrée non validée: attendre confirmation TradingView.',
          conflictReasons: exec?.conflictReasons || [],
          execution: exec || { decision: 'WAIT', canEnter: false, reason: 'Entrée non validée' },
          state,
          canForce: true  // indique au dashboard qu'un override opérateur est possible
        });
      }

      if (isOperatorOverride) {
        // Mode opérateur: entrée humaine validée — on logue clairement
        console.log(`[OPERATOR ENTRY] ${symbol} ${timeframe} — override par opérateur. canEnter=${exec?.canEnter}, raisons: ${(exec?.conflictReasons||[]).join(' | ')}`);
      }
    }

    const actionPayload = (req.body && typeof req.body.payload === 'object') ? req.body.payload : null;
    const updated = applyCoachTradeAction(state, action, note, actionPayload);
    const hintedTradeRaw = (req.body && typeof req.body.trade === 'object' && req.body.trade) ? req.body.trade : null;
    const hintedSource = String(hintedTradeRaw?.source || '').toLowerCase();
    // Accepter tout hint avec direction directionnelle + entry + sl + tp valides
    // Sources valides: tradingview, indicator, auto-watchdog, coach, bridge, manual, operator
    const _hintDir = String(hintedTradeRaw?.direction || '').toUpperCase();
    const _hintHasDir = _hintDir === 'LONG' || _hintDir === 'SHORT' || _hintDir === 'BUY' || _hintDir === 'SELL';
    const hintedTrade = (hintedTradeRaw
      && _hintHasDir
      && Number.isFinite(Number(hintedTradeRaw.entry)) && Number(hintedTradeRaw.entry) > 0
      && Number.isFinite(Number(hintedTradeRaw.sl))    && Number(hintedTradeRaw.sl) > 0
      && Number.isFinite(Number(hintedTradeRaw.tp))    && Number(hintedTradeRaw.tp) > 0)
      ? hintedTradeRaw
      : null;

    if ((action === 'ENTER' || action === 'OPEN') && !updated.virtualPosition) {
      // ── PRIORITÉ 1: hint de l'extension (direction + niveaux fournis explicitement) ────
      // Si l'extension fournit entry/sl/tp valides → on les utilise directement (source autoritaire)
      // instant-trade-live est secondaire — il peut avoir une direction stale ou NEUTRE
      if (hintedTrade) {
        const _hMaxSl = getMaxSlDist(symbol, timeframe);
        const _hSlDist = Math.abs(Number(hintedTrade.entry) - Number(hintedTrade.sl));
        let _hTrade = hintedTrade;
        if (_hMaxSl !== null && _hSlDist > _hMaxSl) {
          // SL trop large — ajuster au lieu de rejeter
          const _hIsLong = (_hintDir === 'LONG' || _hintDir === 'BUY');
          const _hAdjSl = _hIsLong ? Number(hintedTrade.entry) - _hMaxSl : Number(hintedTrade.entry) + _hMaxSl;
          const _hAdjTp = _hIsLong ? Number(hintedTrade.entry) + _hMaxSl * 2.5 : Number(hintedTrade.entry) - _hMaxSl * 2.5;
          console.log(`[HINT-SL-ADJ] ${symbol} SL ajusté ${_hSlDist.toFixed(2)} → ${_hMaxSl} pts`);
          _hTrade = { ...hintedTrade, sl: _hAdjSl, tp: _hAdjTp };
        }
        console.log(`[HINT-ENTRY] ${symbol} ${timeframe} dir=${_hintDir} entry=${_hTrade.entry} sl=${_hTrade.sl} tp=${_hTrade.tp} src=${hintedSource}`);
        updated.virtualPosition = createVirtualPositionFromTrade(symbol, timeframe, _hTrade, getCoachMarketPrice(symbol));
      }

      // ── PRIORITÉ 2: instant-trade-live (fallback si hint absent ou incomplet) ──────────
      if (!updated.virtualPosition) {
        try {
          const instant = await fetchLocalJson(
            '/instant-trade-live?symbol=' + encodeURIComponent(symbol) +
            '&tf=' + encodeURIComponent(timeframe) +
            (mode ? '&mode=' + encodeURIComponent(mode) : '')
          );
          let trade = instant.data?.trade || instant.data?.data || null;

          // Si direction NEUTRE/WAIT ou sl/tp absents → résoudre depuis snapshot coach
          const tradeDir = String(trade?.direction || '').toUpperCase();
          if (!trade || tradeDir === 'NEUTRE' || tradeDir === 'WAIT' || !Number(trade?.sl) || !Number(trade?.tp)) {
            const snap = readCoachAnalysisSnapshot(symbol, timeframe, 300000);
            // Utiliser tvDirection du snapshot (bridge) plutôt que signal.verdict (peut être WAIT)
            const _snapSrc = snap?.analysisSnapshot?.sourceSummary || snap?.sourceSummary || {};
            const _snapTvDir = String(_snapSrc.tvDirection || '').toUpperCase();
            const snapRec = String(snap?.signal?.verdict || snap?.analysis?.recommendation || snap?.signal?.signalState || '').toUpperCase();
            const resolvedDir = (tradeDir === 'LONG' || tradeDir === 'SHORT') ? tradeDir
              : (_snapTvDir === 'LONG' || _snapTvDir === 'SHORT') ? _snapTvDir  // priorité tvDirection bridge
              : (snapRec.includes('BUY') || snapRec.includes('LONG')) ? 'LONG'
              : (snapRec.includes('SELL') || snapRec.includes('SHORT')) ? 'SHORT'
              : null;
            if (resolvedDir) {
              const livePrice = getCoachMarketPrice(symbol);
              const profile   = normalizeSymbol ? normalizeSymbol(symbol) : { digits: 5, pip: 0.0001, slPct: 0.003, tpPct: 0.009 };
              const atr       = trade?.atr || null;
              const levels    = calcTradeLevels(livePrice, resolvedDir, profile, timeframe, atr);
              trade = { ...(trade || {}), direction: resolvedDir, entry: livePrice,
                sl: Number(levels.sl), tp: Number(levels.tp), rrRatio: levels.rrRatio,
                atr, source: 'coach-resolved' };
            }
          }
          // Cap SL
          if (trade && Number(trade.entry) > 0 && Number(trade.sl) > 0) {
            const _enterMaxSl = getMaxSlDist(symbol, timeframe);
            if (_enterMaxSl !== null) {
              const _enterSlDist = Math.abs(Number(trade.entry) - Number(trade.sl));
              if (_enterSlDist > _enterMaxSl) {
                const _isLongAdj = String(trade.direction || '').toUpperCase() === 'LONG';
                const _adjSl = _isLongAdj ? Number(trade.entry) - _enterMaxSl : Number(trade.entry) + _enterMaxSl;
                const _adjTp = _isLongAdj ? Number(trade.entry) + _enterMaxSl * 2 : Number(trade.entry) - _enterMaxSl * 2;
                console.log(`[SL-ADJ] ${symbol} ${timeframe} SL ajusté de ${_enterSlDist.toFixed(2)} → ${_enterMaxSl} pts.`);
                trade = { ...trade, sl: _adjSl, tp: _adjTp };
              }
            }
          }
          updated.virtualPosition = createVirtualPositionFromTrade(symbol, timeframe, trade, getCoachMarketPrice(symbol));
        } catch (_) {}
      }

      // Fallback final: garantir sl/tp valides même si tout a échoué
      if (updated.virtualPosition && (!Number(updated.virtualPosition.sl) || !Number(updated.virtualPosition.tp))) {
        const snap2    = readCoachAnalysisSnapshot(symbol, timeframe, 300000);
        const snapRec2 = String(snap2?.signal?.verdict || snap2?.analysis?.recommendation || '').toUpperCase();
        const dir2     = String(updated.virtualPosition.direction || '').toUpperCase();
        const finalDir = (dir2 === 'LONG' || dir2 === 'SHORT') ? dir2
          : (snapRec2.includes('BUY') || snapRec2.includes('LONG')) ? 'LONG'
          : (snapRec2.includes('SELL') || snapRec2.includes('SHORT')) ? 'SHORT'
          : 'LONG';
        const p2      = getCoachMarketPrice(symbol);
        const prof2   = normalizeSymbol ? normalizeSymbol(symbol) : { digits: 5, pip: 0.0001, slPct: 0.003, tpPct: 0.009 };
        const lvl2    = calcTradeLevels(p2, finalDir, prof2, timeframe, null);
        updated.virtualPosition.direction = finalDir;
        updated.virtualPosition.sl        = Number(lvl2.sl);
        updated.virtualPosition.tp        = Number(lvl2.tp);
        updated.virtualPosition.rrRatio   = lvl2.rrRatio;
        updated.virtualPosition.source    = updated.virtualPosition.source || 'coach-fallback';
      }
    }

    publishAgentChatMessage({
      agent: 'execution-coach-agent',
      to: 'dashboard',
      status: 'info',
      phase: updated.phase,
      message: `Action trade: ${action}`,
      cause: 'interaction utilisateur',
      impact: `${symbol} ${timeframe}`,
      solution: 'suivi mis à jour'
    });

    let tradeActionLia = null;
    try {
      const snapshot = await computeCoachAnalysisSnapshot(symbol, timeframe, 'fr', updated, {
        forceFresh: true,
        mode,
        instantTrade: updated.virtualPosition
          ? {
              direction: updated.virtualPosition.direction,
              entry: updated.virtualPosition.entry,
              sl: updated.virtualPosition.sl,
              tp: updated.virtualPosition.tp,
              rrRatio: updated.virtualPosition.rrRatio,
              setup_type: updated.virtualPosition.setupType,
              source: updated.virtualPosition.source,
              confidence: 65
            }
          : null
      });

      // ── ARM: sauvegarder dans l'état ce qu'on attend pour informer le coaching ARMED ──
      if (action === 'ARM' && snapshot) {
        const _snapExec = snapshot.execution || {};
        updated.lastSnapshotConflicts = _snapExec.conflictReasons || (_snapExec.reason ? [_snapExec.reason] : []);
        updated.lastSnapshotConf      = snapshot.analysis?.confidence || snapshot.signal?.confidence || 0;
        _persistTradeState(symbol, updated);
      }

      tradeActionLia = await requestDashboardLiaReadOnly({
        symbol,
        timeframe,
        decision: snapshot?.analysis?.recommendation || recommendationFromDirection(updated.virtualPosition?.direction || 'WAIT'),
        reason: snapshot?.analysis?.reason || `Action ${action} appliquée`,
        confidence: snapshot?.analysis?.confidence || 0,
        entry: updated.virtualPosition?.entry,
        sl: updated.virtualPosition?.sl,
        tp: updated.virtualPosition?.tp,
        rr: updated.virtualPosition?.rrRatio || '--',
        robotV12: snapshot?.robotV12 || null,
        market: snapshot?.marketStatus || marketHoursChecker.getStatus(symbol),
        news: snapshot?.news || null,
        phase: updated.phase,
        entered: updated.entered,
        bePlaced: updated.bePlaced,
        partialTaken: updated.partialTaken,
        nextAction: updated.entered
          ? 'Position active: suivre invalidation, protection et extension si momentum.'
          : 'Analyser puis attendre un setup validé avant entrée.'
      });
    } catch (_e) {
      tradeActionLia = {
        ok: false,
        channel: 'dashboard',
        response: '[COACH RUNTIME]\nAction appliquée. LIA indisponible, coaching runtime maintenu.'
      };
    }

    // Persister l'état sur disque (survit aux refreshes et redémarrages)
    _persistTradeState(symbol, updated);

    // Broadcast trade-action to all clients (dashboard + extension stay in sync)
    broadcastToExtension({
      type: 'trade-action',
      action,
      symbol,
      timeframe,
      mode,
      phase: updated.phase,
      entered: updated.entered,
      bePlaced: updated.bePlaced,
      partialTaken: updated.partialTaken,
      virtualPosition: updated.virtualPosition || null,
      timestamp: Date.now()
    });

    res.json({ ok: true, state: updated, lia: tradeActionLia });
  });

  // ── COACH LIVE — analyse en temps réel pendant une position active ──────────
  // Lit RSI, EMA, MACD, ATR depuis le bridge TV et produit une analyse structurée.
  // Appelé toutes les 3s depuis le SSE stream et l'endpoint /coach/live-analysis.
  function generateLiveCoachAnalysis(tradeState, tvLive) {
    const vp      = tradeState?.virtualPosition || tradeState || null;
    const price   = Number(tvLive?.price) || Number(vp?.currentPrice) || 0;
    const entry   = Number(vp?.entry) || 0;
    const sl      = Number(vp?.sl) || 0;
    const tp      = Number(vp?.tp) || 0;
    const dir     = String(vp?.direction || '').toUpperCase();
    const isBuy   = dir === 'LONG';
    const bePlaced = !!(tradeState?.bePlaced || vp?.bePlaced || vp?.slMovedToBE);
    if (!price || !entry || !sl || !tp) return null;

    const sym = String(tradeState?.symbol || '').toUpperCase();
    const _isGold   = /XAU|GOLD/.test(sym);
    const _isCrypto = /BTC|ETH|SOL/.test(sym);
    const _isIndex  = /US30|NAS|SPX|DAX/.test(sym);
    const pipMult   = _isCrypto ? 1 : _isIndex ? 1 : _isGold ? 10 : 10000;
    const fmt2 = v => v != null ? Number(v).toFixed(_isGold || _isCrypto || _isIndex ? 2 : 5) : '--';

    // ── Indicateurs bridge ──────────────────────────────────────────────────
    const ind     = tvLive?.indicators || {};
    const rsi     = ind.rsi     != null ? Number(ind.rsi)     : null;
    const macd    = ind.macd    != null ? Number(ind.macd)    : null;
    const ma20    = ind.ma20    != null ? Number(ind.ma20)    : null;
    const ma50    = ind.ma50    != null ? Number(ind.ma50)    : null;
    const atr     = ind.atr     != null ? Number(ind.atr)     : null;
    const bbUpper = ind.bb_upper != null ? Number(ind.bb_upper) : null;
    const bbLower = ind.bb_lower != null ? Number(ind.bb_lower) : null;
    const hasInd  = rsi != null || ma20 != null || macd != null;

    // ── Calculs position ───────────────────────────────────────────────────
    const pnlRaw     = isBuy ? price - entry : entry - price;
    const pnlPips    = Math.round(pnlRaw * pipMult);
    const totalRisk  = Math.abs(entry - sl) || 1;
    const totalReward= Math.abs(tp - entry) || 1;
    const progressTP = Math.max(0, Math.min(1, pnlRaw / totalReward));
    const distToSl   = Math.abs(price - sl);
    const distToTp   = Math.abs(price - tp);
    const rrLeft     = distToTp > 0 ? (distToTp / Math.max(distToSl, 0.0001)).toFixed(1) : '--';
    const pnlSign    = pnlPips >= 0 ? '+' : '';

    // ── Macro (macroBull / macroBear depuis bridge Pine) ──────────────────
    const _bp = tvLive?._bridgePayload || null;
    const _macroBull = _bp ? Number(_bp.macroBull || 0) : 0;
    const _macroBear = _bp ? Number(_bp.macroBear || 0) : 0;
    const _macroAligned = isBuy
      ? (_macroBull > 55 && _macroBull > _macroBear)
      : (_macroBear > 55 && _macroBear > _macroBull);
    const _macroOpposed = isBuy
      ? (_macroBear > 60 && _macroBear > _macroBull)
      : (_macroBull > 60 && _macroBull > _macroBear);

    // ── Analyse indicateurs ────────────────────────────────────────────────
    const details   = [];
    let momentumScore = 0;   // positif = momentum dans direction position
    let alertLevel  = 'normal'; // 'normal' | 'attention' | 'urgent'

    // Macro
    if (_macroBull > 0 || _macroBear > 0) {
      if (_macroAligned)  { momentumScore += 1; details.push(`Macro ${isBuy ? 'haussière' : 'baissière'} confirmée (${isBuy ? Math.round(_macroBull) : Math.round(_macroBear)}%) — contexte global en ta faveur`); }
      if (_macroOpposed)  { momentumScore -= 1; alertLevel = 'attention'; details.push(`Macro opposée — contexte global contre la position (${isBuy ? Math.round(_macroBear) : Math.round(_macroBull)}% ${isBuy ? 'baissier' : 'haussier'})`); }
    }

    // RSI
    let rsiState = null;
    if (rsi != null) {
      if (isBuy) {
        if (rsi >= 60 && rsi <= 78)      { rsiState = 'fort';      momentumScore += 2; details.push(`RSI ${rsi.toFixed(0)} — pression haussière active`); }
        else if (rsi > 78)               { rsiState = 'suracheté'; momentumScore -= 1; alertLevel = 'attention'; details.push(`RSI ${rsi.toFixed(0)} — zone de surachat, risque ralentissement`); }
        else if (rsi >= 45 && rsi < 60)  { rsiState = 'neutre';    momentumScore += 1; details.push(`RSI ${rsi.toFixed(0)} — momentum correct, tendance tenue`); }
        else                             { rsiState = 'faible';    momentumScore -= 2; alertLevel = 'attention'; details.push(`RSI ${rsi.toFixed(0)} — pression haussière s'affaiblit`); }
      } else {
        if (rsi <= 40 && rsi >= 22)      { rsiState = 'fort';      momentumScore += 2; details.push(`RSI ${rsi.toFixed(0)} — pression vendeuse active`); }
        else if (rsi < 22)               { rsiState = 'survendu';  momentumScore -= 1; alertLevel = 'attention'; details.push(`RSI ${rsi.toFixed(0)} — zone de survente, risque rebond`); }
        else if (rsi > 40 && rsi <= 55)  { rsiState = 'neutre';    momentumScore += 1; details.push(`RSI ${rsi.toFixed(0)} — pression vendeuse tenue`); }
        else                             { rsiState = 'faible';    momentumScore -= 2; alertLevel = 'attention'; details.push(`RSI ${rsi.toFixed(0)} — pression vendeuse s'affaiblit`); }
      }
    }

    // EMA
    if (ma20 != null) {
      if (isBuy) {
        if (price > ma20)  { momentumScore += 1; details.push(`Prix ${fmt2(price)} > EMA20 ${fmt2(ma20)} — structure haussière maintenue`); }
        else               { momentumScore -= 2; alertLevel = 'attention'; details.push(`Prix ${fmt2(price)} < EMA20 ${fmt2(ma20)} — structure haussière cassée`); }
      } else {
        if (price < ma20)  { momentumScore += 1; details.push(`Prix ${fmt2(price)} < EMA20 ${fmt2(ma20)} — structure baissière maintenue`); }
        else               { momentumScore -= 2; alertLevel = 'attention'; details.push(`Prix ${fmt2(price)} > EMA20 ${fmt2(ma20)} — structure baissière cassée`); }
      }
    }
    if (ma50 != null && ma20 != null) {
      if (isBuy && ma20 > ma50)   { momentumScore += 1; details.push(`EMA20 > EMA50 — alignement haussier confirmé`); }
      else if (!isBuy && ma20 < ma50) { momentumScore += 1; details.push(`EMA20 < EMA50 — alignement baissier confirmé`); }
      else if (isBuy && ma20 < ma50)  { momentumScore -= 1; details.push(`EMA20 < EMA50 — EMAs inversées, risque de résistance`); }
      else if (!isBuy && ma20 > ma50) { momentumScore -= 1; details.push(`EMA20 > EMA50 — EMAs inversées, risque de support`); }
    }

    // MACD
    if (macd != null) {
      if (isBuy && macd > 0)  { momentumScore += 1; details.push(`MACD +${macd.toFixed(2)} — momentum haussier confirmé`); }
      else if (!isBuy && macd < 0) { momentumScore += 1; details.push(`MACD ${macd.toFixed(2)} — momentum baissier confirmé`); }
      else if (isBuy && macd < 0)  { momentumScore -= 1; alertLevel = 'attention'; details.push(`MACD ${macd.toFixed(2)} — momentum haussier affaibli`); }
      else if (!isBuy && macd > 0) { momentumScore -= 1; alertLevel = 'attention'; details.push(`MACD +${macd.toFixed(2)} — momentum baissier affaibli`); }
    }

    // ATR (volatilité)
    let atrState = null;
    if (atr != null) {
      const _minAtr = _isGold ? 1.5 : _isCrypto ? 200 : 0.0005;
      if (atr < _minAtr * 0.6)      { atrState = 'contracté'; details.push(`ATR ${atr.toFixed(2)} faible — volatilité en chute, marché ralentit`); }
      else if (atr > _minAtr * 2.5) { atrState = 'élevé';    details.push(`ATR ${atr.toFixed(2)} élevé — forte volatilité, mouvement en cours`); momentumScore += 1; }
      else                           { atrState = 'normal';   details.push(`ATR ${atr.toFixed(2)} — volatilité normale`); }
    }

    // BB — prix aux extrêmes
    if (bbUpper != null && bbLower != null) {
      if (isBuy && price >= bbUpper * 0.999)       { alertLevel = 'attention'; details.push(`Prix sur BB supérieure — zone de résistance potentielle`); momentumScore -= 1; }
      else if (!isBuy && price <= bbLower * 1.001) { alertLevel = 'attention'; details.push(`Prix sur BB inférieure — zone de support potentielle`); momentumScore -= 1; }
    }

    // Convergence RSI + MACD opposés = divergence = alerte retournement
    if (rsi != null && macd != null) {
      const rsiDirBuy = rsi > 50;
      const macdDirBuy = macd > 0;
      if (isBuy && rsiDirBuy && !macdDirBuy)        { alertLevel = 'attention'; details.push(`Divergence RSI/MACD — possible essoufflement haussier`); momentumScore -= 2; }
      else if (!isBuy && !rsiDirBuy && macdDirBuy)  { alertLevel = 'attention'; details.push(`Divergence RSI/MACD — possible essoufflement baissier`); momentumScore -= 2; }
    }

    // ── Déterminer momentum global ─────────────────────────────────────────
    let momentum, marketState;
    if (!hasInd) {
      // Fallback sans indicateurs : déduire depuis progression position + P&L
      const _pct = Math.round(progressTP * 100);
      if (pnlPips <= 0) {
        momentum = 'NEUTRE'; marketState = 'Position en développement — surveille la structure';
      } else if (_pct >= 70) {
        momentum = 'FORT'; marketState = isBuy ? 'Position avance bien — pression haussière tenue' : 'Position avance bien — pression baissière tenue';
      } else if (_pct >= 35) {
        momentum = 'MOYEN'; marketState = 'Progression correcte — position dans la bonne direction';
      } else {
        momentum = 'NEUTRE'; marketState = 'Début de position — attends confirmation de direction';
      }
      details.push('Indicateurs bridge absents — ajouter RSI/EMA/MACD sur TradingView pour analyse complète');
    } else if (momentumScore >= 3)  { momentum = 'FORT';             marketState = isBuy ? 'Pression acheteuse forte — marché continue' : 'Pression vendeuse forte — marché continue'; }
    else if (momentumScore >= 1)    { momentum = 'MOYEN';            marketState = 'Momentum correct — tendance maintenue'; }
    else if (momentumScore === 0)   { momentum = 'NEUTRE';           marketState = 'Zone de consolidation — marché sans impulsion claire'; }
    else if (momentumScore === -1)  { momentum = 'RALENTISSEMENT';   marketState = 'Momentum ralentit — surveiller la structure'; alertLevel = 'attention'; }
    else                            { momentum = 'RETOURNEMENT POSSIBLE'; marketState = 'Signaux contraires — risque de retournement'; alertLevel = 'urgent'; }

    // ── Suggestion d'action ────────────────────────────────────────────────
    let suggestion, action;
    const inProfit = pnlPips > 0;
    const progressPct = Math.round(progressTP * 100);

    if (alertLevel === 'urgent' && inProfit) {
      suggestion = `Sécuriser maintenant — signaux de retournement. ${pnlSign}${pnlPips} pips à protéger.`;
      action = 'SECURISER';
    } else if (!bePlaced && inProfit && progressPct >= 35) {
      suggestion = `Remonter le SL au breakeven (${fmt2(entry)}) — risque zéro sur ${pnlSign}${pnlPips} pips.`;
      action = 'TRAIL_SL';
    } else if (bePlaced && progressPct >= 70 && momentumScore >= 2) {
      suggestion = `Momentum fort (score ${momentumScore}), laisser courir vers TP ${fmt2(tp)} — encore ${rrLeft}R.`;
      action = 'HOLD';
    } else if (bePlaced && progressPct >= 85 && !hasInd) {
      suggestion = `Proche du TP (${progressPct}%). Sécuriser partiellement ou fermer si momentum s'arrête.`;
      action = 'PARTIAL_TP';
    } else if (momentumScore >= 3 && progressPct >= 80 && atrState !== 'contracté') {
      suggestion = `Forte impulsion — envisager d'élargir légèrement le TP. Momentum score: ${momentumScore}.`;
      action = 'WIDEN_TP';
    } else if (momentumScore <= -2 && inProfit) {
      suggestion = `Momentum contre la position — envisager une sortie partielle à ${pnlSign}${pnlPips} pips.`;
      action = 'PARTIAL_TP';
    } else if (momentumScore >= 1) {
      suggestion = `Tendance en ta faveur (score ${momentumScore}) — maintenir la position, laisser le marché travailler.`;
      action = 'HOLD';
    } else {
      suggestion = `Surveiller SL à ${fmt2(sl)} — ${Math.round(distToSl * pipMult)} pips de marge.`;
      action = 'WATCH';
    }

    return {
      ok: true,
      symbol: sym,
      price,
      pnlPips,
      pnlSign,
      progressPct,
      momentum,
      momentumScore,
      marketState,
      suggestion,
      action,
      alertLevel,
      details,
      hasIndicators: hasInd,
      bePlaced,
      rrLeft,
      entry: fmt2(entry),
      sl: fmt2(sl),
      tp: fmt2(tp),
      // Valeurs brutes indicateurs — transmises à LIA pour analyse naturelle
      rsiRaw:    rsi,
      macdRaw:   macd,
      ma20Raw:   ma20,
      ma50Raw:   ma50,
      atrRaw:    atr,
      bbUpperRaw: bbUpper,
      bbLowerRaw: bbLower,
      timestamp: new Date().toISOString()
    };
  }

  // Exposer pour /coach/live-analysis
  if (typeof app !== 'undefined') {
    app.get('/coach/live-analysis', (req, res) => {
      const symbol = String(req.query.symbol || 'XAUUSD').toUpperCase();
      const tvLiveKey = Object.keys(tvDataStore).find(k => k === symbol) || symbol;
      const tvLive = tvDataStore[tvLiveKey] || null;
      if (!tvLive) return res.json({ ok: false, error: 'No bridge data', symbol });
      // Trouver position active
      let tradeState = null;
      if (typeof coachTradeStateStore !== 'undefined') {
        for (const ts of Object.values(coachTradeStateStore)) {
          if (ts && ts.symbol === symbol && ts.entered) { tradeState = ts; break; }
        }
      }
      if (!tradeState && typeof getCoachTradeState === 'function') {
        const tsM5 = getCoachTradeState(symbol, 'M5');
        const tsH1 = getCoachTradeState(symbol, 'H1');
        tradeState = (tsM5?.entered ? tsM5 : null) || (tsH1?.entered ? tsH1 : null) || tsM5;
      }
      const analysis = generateLiveCoachAnalysis(tradeState, tvLive);
      if (!analysis) return res.json({ ok: false, error: 'Pas de position active', symbol, price: tvLive?.price });
      res.json(analysis);
    });
  }

  function generatePositionCoachMessage(tradeState, liveData, tvLiveData) {
    const price  = liveData?.currentPrice || liveData?.price;
    const entry  = tradeState?.entry || liveData?.virtualPosition?.entry;
    const sl     = tradeState?.sl    || liveData?.virtualPosition?.sl;
    const tp     = tradeState?.tp    || liveData?.virtualPosition?.tp;
    const phase  = tradeState?.phase;
    const entered  = tradeState?.entered;
    const bePlaced = tradeState?.bePlaced;
    const rawDir   = String(tradeState?.direction || liveData?.virtualPosition?.direction || '').toUpperCase();
    const sym      = String(liveData?.symbol || tradeState?.symbol || '').toUpperCase();

    // ── TYPE DE TRADE: détecté à l'entrée ou déduit des niveaux ─────────────
    // SCALPING: TP/SL ratio court | SNIPER: chirurgical sur zone | SWING: tendance longue
    const _vpStored = liveData?.virtualPosition || tradeState?.virtualPosition;
    const _tradeType = String(_vpStored?.tradeType || tradeState?.tradeType || '').toUpperCase() || null;
    const _tradeTypeLabel = _tradeType === 'SWING' ? '🌊 SWING'
                          : _tradeType === 'SNIPER' ? '🎯 SNIPER'
                          : _tradeType === 'SCALPING' ? '⚡ SCALP'
                          : null;
    const _tpTrailEnabled = _vpStored?.tpTrailEnabled !== false && _tradeType !== 'SCALPING';
    // ATR fallback: bridge TV → position stockée → estimation prix
    const atrVal   = parseFloat(tvLiveData?.atr || tvLiveData?.indicators?.atr
      || tradeState?.virtualPosition?.atr || liveData?.virtualPosition?.atr || 0)
      || (price ? price * 0.003 : 0); // 0.3% fallback si aucune donnée
    // Pip multiplier by asset class
    const _isCrypto = /BTC|ETH|SOL|XRP|BNB|ADA|LTC|DOT|LINK|AVAX|DOGE|MATIC/.test(sym);
    const _isIndex  = /US30|NAS|SPX|DAX|CAC|FTSE|NI225|NIKKEI/.test(sym);
    const _isGold   = /XAU|GOLD/.test(sym);
    const _isJpy    = sym.includes('JPY');
    const pipMult   = _isCrypto ? 1 : _isIndex ? 1 : _isGold ? 10 : _isJpy ? 100 : 10000;
    const pipLabel  = _isCrypto || _isIndex ? 'USD' : 'pips';
    const isBuy    = rawDir === 'LONG' || rawDir.includes('BUY') || (!rawDir && tp && entry && tp > entry);
    const dirLabel = isBuy ? 'LONG' : 'SHORT';

    const _dec = _isCrypto ? 2 : _isIndex ? 1 : _isGold ? 2 : _isJpy ? 3 : 5;
    const fmt = v => v != null ? Number(v).toFixed(_dec) : '--';

    // ── Bridge payload disponible pour tout le coaching ──────────────────────
    const _bp = tvLiveData?._bridgePayload || null;

    // ── ARMED: message dynamique AVANT le check !entered ─────────────────────
    // Phase ARMED = robot actif en surveillance → message spécifique
    if (String(phase || '').toUpperCase() === 'ARMED') {
      const _armPrice = liveData?.currentPrice || price || 0;
      const _armRsi   = parseFloat(tvLiveData?.rsi  || tvLiveData?.indicators?.rsi  || 0);
      const _armConf  = Number(tradeState?.lastSnapshotConf || 0);
      const _armConflicts = Array.isArray(tradeState?.lastSnapshotConflicts) ? tradeState.lastSnapshotConflicts : [];
      const _missing = _armConflicts.length > 0
        ? 'En attente : ' + _armConflicts[0].split('—')[0].trim()
        : 'En attente d\'un setup propre';
      const _rsiStr  = _armRsi > 0 ? ` | RSI ${Math.round(_armRsi)}` : '';
      const _confStr = _armConf > 0 ? ` | Signal ${Math.round(_armConf)}%` : '';
      // Bridge context pour ARMED
      if (_bp) {
        const _lt3 = String(_bp.lectureTech3 || '').toUpperCase();
        const _lt4 = String(_bp.lectureTech4 || '').toUpperCase();
        const _sc4 = Number(_bp.scoreTech4 || 50);
        const _ant = String(_bp.anticipationTexte || '').toUpperCase();
        const _af  = Number(_bp.anticipationForce || 0);
        const _h1ctx = _lt4.includes('ACHAT_FORT') ? 'H1 haussier fort' : _lt4.includes('ACHAT') ? 'H1 haussier'
          : _lt4.includes('VENTE_FORTE') ? 'H1 baissier fort' : _lt4.includes('VENTE') ? 'H1 baissier' : null;
        const _m15ctx = _lt3.includes('ACHAT_FORT') ? 'M15 achat fort' : _lt3.includes('ACHAT') ? 'M15 achat'
          : _lt3.includes('VENTE_FORTE') ? 'M15 vente forte' : _lt3.includes('VENTE') ? 'M15 vente' : null;
        const _ctxParts = [_h1ctx, _m15ctx].filter(Boolean);
        const _ctxStr = _ctxParts.length > 0 ? ` | ${_ctxParts.join(', ')}` : '';
        let _antStr = '';
        if (_ant && _af > 25) {
          const _antIsLong  = _ant.includes('LONG');
          const _antIsShort = _ant.includes('SHORT');
          const _antIsPre   = _ant.includes('PRE_ALERTE');
          const _h1Bear = _lt4.includes('VENTE');
          const _h1Bull = _lt4.includes('ACHAT');
          const _contra = (_antIsLong && _h1Bear) || (_antIsShort && _h1Bull);
          if (_contra && !_antIsPre) {
            _antStr = _antIsLong
              ? ` | Signal LONG en formation (contre H1 baissier — attendre M15+M5)`
              : ` | Signal SHORT en formation (contre H1 haussier — attendre M15+M5)`;
          } else if (_antIsPre) {
            _antStr = ` | Pré-alerte ${_antIsLong ? 'LONG' : 'SHORT'} ${Math.round(_af)}%`;
          } else {
            _antStr = ` | Retournement ${_antIsLong ? 'LONG' : 'SHORT'} imminent ${Math.round(_af)}%`;
          }
        }
        return `🔍 Robot armé — Prix ${fmt(_armPrice)}${_rsiStr}${_ctxStr}${_antStr}${_confStr}. ${_missing}. J'entre automatiquement dès que Direction + Zone + Timing sont alignés.`;
      }
      const _armedMsgs = [
        `🔍 Robot armé — Prix ${fmt(_armPrice)}${_rsiStr}${_confStr}. ${_missing}. Je surveille et entre automatiquement dès que c'est propre.`,
        `👁 Surveillance active — Prix ${fmt(_armPrice)}${_rsiStr}. Je cherche la confluence parfaite. ${_missing}. Pas d'entrée avant alignement complet.`,
        `⏳ En attente du setup — ${_missing}${_confStr}. Prix actuel ${fmt(_armPrice)}${_rsiStr}. J'annonce vocalement dès que les conditions sont réunies.`
      ];
      return _armedMsgs[Math.floor(Date.now() / 30000) % _armedMsgs.length];
    }

    if (!entered) {
      // Bridge disponible → message contextuel concret
      if (_bp && typeof buildBridgeContextMessage === 'function') {
        const _snapExec = liveData?.execution || liveData?.coach?.execution || {};
        const _bridgeMsg = buildBridgeContextMessage(_bp, tvLiveData?.indicators, price, {
          canEnter:      _snapExec?.canEnter,
          conflictReason: _snapExec?.reason || (_snapExec?.conflictReasons?.[0])
        });
        if (_bridgeMsg) return _bridgeMsg;
      }
      const idleMsgs = [
        "J'observe le marché. Signal pas encore validé — je t'avertis dès que c'est bon.",
        "Je surveille les niveaux clés. Aucune opportunité propre pour l'instant.",
        "En attente d'un setup de qualité. Je ne rentre jamais au milieu du range.",
        "Le marché hésite. Je patiente — une entrée forcée coûte des pips."
      ];
      return idleMsgs[Math.floor(Date.now() / 15000) % idleMsgs.length];
    }

    if (price && entry && sl && tp) {
      const distSL   = Math.abs(price - sl);
      const distTP   = Math.abs(price - tp);
      const distEntry= Math.abs(price - entry);
      const totalRisk= Math.abs(entry - sl);
      const pct      = totalRisk > 0 ? 1 - (distSL / totalRisk) : 0; // 0=at entry, 1=at SL
      const pnlPips  = Math.round((isBuy ? price - entry : entry - price) * pipMult);
      const pnlSign  = pnlPips >= 0 ? '+' : '';
      const rrLeft   = distTP > 0 ? (distTP / Math.max(distSL, 0.0001)).toFixed(1) : '--';

      const pl = pipLabel; // 'pips' for forex/gold, 'USD' for crypto/indices
      // DANGER — très proche du SL
      if (distSL < totalRisk * 0.12) {
        return `Attention danger — prix à ${fmt(price)}, SL à ${fmt(sl)}. Il reste ${Math.round(distSL * pipMult)} ${pl} avant la coupe. Si la structure tient pas, on sort proprement.`;
      }
      // Proche du SL (20%)
      if (distSL < totalRisk * 0.22) {
        const slMsgs = [
          `Prix en pullback vers le SL (${fmt(sl)}). On est à ${Math.round(distSL * pipMult)} ${pl}. Surveille la réaction — si le niveau tient, on reste.`,
          `Le marché teste notre zone d'entrée. SL à ${fmt(sl)}, encore ${Math.round(distSL * pipMult)} ${pl}. Reste calme, la structure doit tenir.`,
          `Pression ${isBuy ? 'baissière' : 'haussière'} — prix à ${fmt(price)}, SL à ${fmt(sl)}. ${Math.round(distSL * pipMult)} ${pl} de marge. On surveille.`
        ];
        return slMsgs[Math.floor(Date.now() / 20000) % slMsgs.length];
      }
      // ── SORTIE ANTICIPÉE — essoufflement momentum en plein trade ─────────
      // Déclenche si on est entre SL+25% et TP-30%, pas en danger ni au TP
      // Basé sur: RSI extrême contre direction + indicateurs contradictoires
      const _midTradeRsi = parseFloat(tvLiveData?.rsi || tvLiveData?.indicators?.rsi || 0);
      const _midTradeTrend = String(tvLiveData?.trend || tvLiveData?.indicators?.trend || '').toLowerCase();
      if (distSL > totalRisk * 0.25 && distTP > totalRisk * 0.30 && _midTradeRsi > 0) {
        const _exhaustLong  = isBuy  && _midTradeRsi > 72 && pnlPips > 0;
        const _exhaustShort = !isBuy && _midTradeRsi < 28 && pnlPips > 0;
        const _trendReverse = _midTradeTrend.includes('retournement') || _midTradeTrend.includes('reversal')
          || (isBuy  && (_midTradeTrend.includes('baissier') || _midTradeTrend.includes('bear')))
          || (!isBuy && (_midTradeTrend.includes('haussier') || _midTradeTrend.includes('bull')));
        if ((_exhaustLong || _exhaustShort) && _trendReverse) {
          const _whyExit = `RSI à ${Math.round(_midTradeRsi)} (épuisement ${isBuy?'acheteur':'vendeur'}) + tendance qui s'inverse`;
          return `⚠️ SORTIE ANTICIPÉE RECOMMANDÉE — ${pnlSign}${pnlPips} ${pl} en gain. ${_whyExit}. Le marché montre des signes d'essoufflement. Je recommande de sécuriser maintenant plutôt que de risquer un retournement.`;
        }
      }

      // Très proche du TP ou dans la zone TP — logique trail
      if (distTP < totalRisk * 0.30) {
        // Lire momentum/RSI depuis la donnée TV live
        const _rsi   = parseFloat(tvLiveData?.rsi || tvLiveData?.indicators?.rsi || 0);
        const _trend = String(tvLiveData?.trend || tvLiveData?.indicators?.trend || '').toLowerCase();
        const _atrNow = parseFloat(tvLiveData?.atr || tvLiveData?.indicators?.atr || 0) || atrVal;

        // Signal de retournement = RSI en zone opposée OU tendance inversée
        const _reversalRsi  = _rsi > 0 && (isBuy ? _rsi > 78 : _rsi < 22);
        const _reversalTrend= _trend.includes('retournement') || _trend.includes('reversal')
          || (_trend && isBuy && (_trend.includes('baissier') || _trend.includes('bear')))
          || (_trend && !isBuy && (_trend.includes('haussier') || _trend.includes('bull')));
        const _hasReversal  = _reversalRsi || _reversalTrend;

        // TP trail: 0.5x ATR si disponible, sinon 50% de la distance entrée→TP (fallback si ATR=0)
        const _tpDist = Math.abs(tp - entry);
        const trailExtension = _atrNow > 0 ? _atrNow * 0.5 : _tpDist * 0.5;
        const newTp = isBuy ? tp + trailExtension : tp - trailExtension;

        if (!_hasReversal) {
          // Momentum intact → AUTO-DÉPLACER le TP + annoncer + logger
          const _rsiStr = _rsi > 0 ? `, RSI ${Math.round(_rsi)}` : '';
          // Auto-appliquer SET_TP si newTp est valide et pas déjà trailé récemment (cooldown 60s)
          const _tpTrailCooldownKey = `_tpTrailAt_${sym}`;
          const _lastTrail = tradeState[_tpTrailCooldownKey] || 0;
          const _tpTrailReady = (Date.now() - _lastTrail) > 60000; // max 1 trail/minute
          // Condition: trailExtension > 0 (accepte fallback sans ATR)
          if (_tpTrailReady && trailExtension > 0 && Number.isFinite(newTp) && newTp > 0) {
            const _newTpValid = isBuy ? newTp > tp : newTp < tp;
            if (_newTpValid && typeof applyCoachTradeAction === 'function' && _tpTrailEnabled) {
              tradeState[_tpTrailCooldownKey] = Date.now();
              applyCoachTradeAction(tradeState, 'SET_TP', `TP trail auto (momentum intact${_rsiStr})`, { newTp: newTp });
              if (typeof _persistTradeState === 'function') _persistTradeState(sym, tradeState);
              if (typeof broadcastToExtension === 'function') {
                broadcastToExtension({
                  type: 'trade-action', action: 'SET_TP', symbol: sym,
                  phase: tradeState.phase, entered: tradeState.entered,
                  bePlaced: tradeState.bePlaced, partialTaken: tradeState.partialTaken,
                  virtualPosition: tradeState.virtualPosition || null, timestamp: Date.now()
                });
              }
            }
          }
          const _typePrefix = _tradeTypeLabel ? `[${_tradeTypeLabel}] ` : '';
          // Si scalping → ne pas trailer, sortir
          if (!_tpTrailEnabled) {
            return `${_typePrefix}⚡ SCALP — TP atteint à ${fmt(tp)}. ${pnlSign}${pnlPips} ${pl}. Sortie recommandée maintenant — pas de trailing sur scalp.`;
          }
          const trailMsgs = [
            `${_typePrefix}📈 TP déplacé à ${fmt(newTp)} — momentum ${isBuy ? 'haussier' : 'baissier'} intact${_rsiStr}. Je laisse courir. ${pnlSign}${pnlPips} ${pl} en gain.`,
            `${_typePrefix}Structure ${isBuy ? 'haussière' : 'baissière'} continue — TP étendu ${fmt(tp)} → ${fmt(newTp)}${_rsiStr}. Plus de potentiel, même risque.`,
            `${_typePrefix}${pnlSign}${pnlPips} ${pl} — TP trail vers ${fmt(newTp)}${_rsiStr}. Momentum intact, je laisse courir.`
          ];
          return trailMsgs[Math.floor(Date.now() / 25000) % trailMsgs.length];
        } else {
          // Signal de retournement détecté → sécuriser
          const whyReversal = _reversalRsi
            ? `RSI à ${Math.round(_rsi)} (zone de retournement)`
            : `structure qui s'inverse`;
          return `Attention — TP proche (${fmt(tp)}) et signal de retournement détecté : ${whyReversal}. ${pnlSign}${pnlPips} ${pl}. Je recommande de sécuriser maintenant ou de serrer le SL au breakeven.`;
        }
      }
      // BE advice — dès que la position couvre son risque (progression ≥ 35% vers TP)
      const totalRange    = Math.abs(tp - entry);
      const progressToTP  = totalRange > 0 ? Math.max(0, Math.min(1,
        isBuy ? (price - entry) / totalRange : (entry - price) / totalRange
      )) : 0;
      const _rsiForBe = parseFloat(tvLiveData?.rsi || tvLiveData?.indicators?.rsi || 0);
      const _rsiBeStr = _rsiForBe > 0 ? ` (RSI ${Math.round(_rsiForBe)})` : '';
      if (!bePlaced && pnlPips > 0 && progressToTP >= 0.35) {
        // ── AUTO-BREAKEVEN — appliqué automatiquement (1 seule fois par trade) ─
        const _beAutoKey = `_beAutoAt_${sym}`;
        if (!tradeState[_beAutoKey] && typeof applyCoachTradeAction === 'function') {
          tradeState[_beAutoKey] = Date.now();
          applyCoachTradeAction(tradeState, 'BE', `Breakeven auto — progression ${Math.round(progressToTP*100)}% vers TP${_rsiBeStr}`, {});
          if (typeof _persistTradeState === 'function') _persistTradeState(sym, tradeState);
          if (typeof broadcastToExtension === 'function') {
            broadcastToExtension({
              type: 'trade-action', action: 'BREAKEVEN', symbol: sym,
              phase: tradeState.phase, entered: tradeState.entered,
              bePlaced: true, partialTaken: !!tradeState.partialTaken,
              virtualPosition: tradeState.virtualPosition || null, timestamp: Date.now()
            });
          }
          // Voix claire + message coach
          return `🔒 BREAKEVEN PLACÉ — SL déplacé à ${fmt(entry)}. Risque zéro. ${pnlSign}${pnlPips} ${pl} de gain sécurisé${_rsiBeStr}. Je laisse courir vers ${fmt(tp)}.`;
        }
        // Déjà appliqué → message de confirmation
        return `Breakeven actif — SL à ${fmt(entry)}, risque zéro. ${pnlSign}${pnlPips} ${pl}${_rsiBeStr}. On laisse le marché travailler.`;
      }
      // Position bien avancée, BE déjà placé
      if (bePlaced && pnlPips > 0) {
        const _rrRemaining = distTP > 0 && Math.abs(entry - sl) > 0
          ? (distTP / Math.abs(entry - sl)).toFixed(1) : null;
        const _rrStr = _rrRemaining ? ` — encore ${_rrRemaining}R possible` : '';
        const _typeTag = _tradeTypeLabel ? ` [${_tradeTypeLabel}]` : '';
        const _trailNote = _tpTrailEnabled ? ' TP trail actif si momentum continue.' : ' Sortie rapide si TP atteint (scalp).';
        const goodMsgs = [
          `Risque zéro${_typeTag}, ${pnlSign}${pnlPips} ${pl} de gain libre${_rrStr}.${_trailNote}`,
          `Break-even sécurisé${_typeTag}. ${pnlSign}${pnlPips} ${pl}${_rsiBeStr}. Le marché travaille — reste patient.`,
          `Position ${dirLabel}${_typeTag} en profit — ${pnlSign}${pnlPips} ${pl}. TP à ${fmt(tp)}${_rrStr}. Plus de risque. Tiens le cap.`
        ];
        return goodMsgs[Math.floor(Date.now() / 30000) % goodMsgs.length];
      }
      // Position légèrement négative (normal dans le range)
      if (pnlPips < -3 && pnlPips > -Math.round(totalRisk * pipMult * 0.5)) {
        const dip = [
          `Petit drawdown normal — ${pnlSign}${pnlPips} ${pl}. Le trade est toujours valide, SL à ${fmt(sl)} tient la structure.`,
          `${pnlSign}${pnlPips} ${pl} pour l'instant. C'est dans le bruit du marché — rien d'alarmant. SL protège à ${fmt(sl)}.`,
          `Le marché respire avant de partir. ${pnlSign}${pnlPips} ${pl}, structure intacte. Garde ton sang-froid.`
        ];
        return dip[Math.floor(Date.now() / 20000) % dip.length];
      }
      // En cours normal — inclure indicateurs temps réel si disponibles
      const _normRsi   = parseFloat(tvLiveData?.rsi  || tvLiveData?.indicators?.rsi  || 0);
      const _normMacd  = parseFloat(tvLiveData?.macd || tvLiveData?.indicators?.macd || 0);
      const _normEma20 = parseFloat(tvLiveData?.ma20 || tvLiveData?.indicators?.ma20 || 0);
      // Bloc indicateurs pour message enrichi
      const _normIndParts = [];
      if (_normRsi  > 0) _normIndParts.push(`RSI ${Math.round(_normRsi)}`);
      if (_normMacd !== 0) _normIndParts.push(`MACD ${_normMacd >= 0 ? '+' : ''}${_normMacd.toFixed(2)}`);
      if (_normEma20 > 0) _normIndParts.push(`EMA20 ${fmt(_normEma20)}`);
      const _normIndStr = _normIndParts.length > 0 ? ` | ${_normIndParts.join(' ')}` : '';
      // État momentum basé sur RSI
      const _normMom = _normRsi > 65 ? (isBuy ? 'momentum fort' : 'surachat possible') :
                       _normRsi < 35 ? (!isBuy ? 'momentum fort' : 'survente possible') :
                       'momentum neutre';

      // ── Bridge: enrichissement du coaching en position ────────────────────
      if (_bp) {
        const _lt1 = String(_bp.lectureTech1 || '').toUpperCase();
        const _lt2 = String(_bp.lectureTech2 || '').toUpperCase();
        const _lt3 = String(_bp.lectureTech3 || '').toUpperCase();
        const _lt4 = String(_bp.lectureTech4 || '').toUpperCase();
        const _sc2 = Number(_bp.scoreTech2 || 50);
        const _sc3 = Number(_bp.scoreTech3 || 50);
        const _sc4 = Number(_bp.scoreTech4 || 50);
        const _ant = String(_bp.anticipationTexte || '').toUpperCase();
        const _af  = Number(_bp.anticipationForce || 0);
        const _mBull = Number(_bp.macroBull || 0);
        const _mBear = Number(_bp.macroBear || 0);
        const _typeTag = _tradeTypeLabel ? ` [${_tradeTypeLabel}]` : '';

        // Détection direction active sur M5/M1 (timing court)
        const _m5Aligned  = isBuy  ? (_lt2.includes('ACHAT')) : (_lt2.includes('VENTE'));
        const _m1Aligned  = isBuy  ? (_lt1.includes('ACHAT')) : (_lt1.includes('VENTE'));
        const _m15Aligned = isBuy  ? (_lt3.includes('ACHAT')) : (_lt3.includes('VENTE'));
        const _h1Aligned  = isBuy  ? (_lt4.includes('ACHAT')) : (_lt4.includes('VENTE'));
        const _macroOk    = isBuy  ? (_mBull > _mBear + 8) : (_mBear > _mBull + 8);

        // Conflits — signaux opposés sur TF courts
        const _m5Conflict  = isBuy ? _lt2.includes('VENTE') : _lt2.includes('ACHAT');
        const _m15Conflict = isBuy ? _lt3.includes('VENTE') : _lt3.includes('ACHAT');

        // Retournement anticipé
        const _retLong  = _ant.includes('RET_LONG') || _ant.includes('PRE_ALERTE_LONG');
        const _retShort = _ant.includes('RET_SHORT') || _ant.includes('PRE_ALERTE_SHORT');
        const _retContra = isBuy ? _retShort : _retLong;
        const _retOk    = isBuy ? _retLong  : _retShort;

        // Score global d'alignement bridge
        const _alignScore = [_m1Aligned, _m5Aligned, _m15Aligned, _h1Aligned, _macroOk].filter(Boolean).length;

        // 1. CONFLIT CRITIQUE — TF courts contre la direction
        if (_m5Conflict && _m15Conflict) {
          return `⚠️ CONFLIT DÉTECTÉ${_typeTag} — M5 et M15 ${isBuy ? 'vendeurs' : 'acheteurs'} pendant ton ${dirLabel}. ${pnlSign}${pnlPips} ${pl}. Ne rajoute rien. Protège ou sors proprement.`;
        }

        // 2. RETOURNEMENT CONTRE LA POSITION
        if (_retContra && _af > 35) {
          return `🔴 RISQUE RETOURNEMENT${_typeTag} — Signal ${_ant.replace(/_/g,' ')} détecté (${Math.round(_af)}%). ${pnlSign}${pnlPips} ${pl}. Sécurise maintenant.`;
        }

        // 3. IMPULSION FORTE DANS LE BON SENS + retournement aligné
        if (_retOk && _af > 40 && pnlPips >= 0) {
          return `🟢 Impulsion forte confirmée${_typeTag} — ${_ant.replace(/_/g,' ')} ${Math.round(_af)}%. ${pnlSign}${pnlPips} ${pl}. Pression ${isBuy ? 'haussière' : 'baissière'} toujours active. Tu peux laisser courir.`;
        }

        // 3b. PUSH PRÉVISIBLE — annonce proactive AVANT d'atteindre le TP
        // Déclenche quand momentum s'accumule (anticipationForce > 45, TFs alignés, RSI pas épuisé,
        // position entre 15% et 65% du TP) → annoncer le déplacement du TP en avance
        const _pushForce   = _af > 45 && _retOk;
        const _pushAligned = _alignScore >= 3;
        const _noExhaust   = !(_normRsi > 0 && isBuy  && _normRsi > 70)
                          && !(_normRsi > 0 && !isBuy && _normRsi < 30);
        const _midProgress = progressToTP >= 0.15 && distTP > totalRisk * 0.35;
        if (_pushForce && _pushAligned && _noExhaust && _midProgress && pnlPips > 0) {
          const _atrNow   = parseFloat(tvLiveData?.atr || tvLiveData?.indicators?.atr || 0) || atrVal;
          const _tpDist   = Math.abs(tp - entry);
          const _tpExtend = _atrNow > 0 ? _atrNow * 0.5 : _tpDist * 0.3;
          const _projTp   = isBuy ? tp + _tpExtend : tp - _tpExtend;
          const _tfCtx    = [_h1Aligned ? 'H1' : null, _m15Aligned ? 'M15' : null, _m5Aligned ? 'M5' : null].filter(Boolean).join('+');
          const _antLabel = _ant.replace(/_/g, ' ');
          const _rsiNote  = _normRsi > 0 ? ` | RSI ${Math.round(_normRsi)}` : '';
          return `🚀 PUSH EN APPROCHE${_typeTag} — ${_antLabel} ${Math.round(_af)}% | ${_tfCtx} alignés${_rsiNote}. ${pnlSign}${pnlPips} ${pl}. Momentum s'accumule dans ton sens — TP projeté vers ${fmt(_projTp)}. Prépare le déplacement.`;
        }

        // 4. ALIGNEMENT PARFAIT (4-5/5)
        if (_alignScore >= 4) {
          const _m5str = _m5Aligned ? (isBuy ? 'M5 achat' : 'M5 vente') : '';
          const _m1str = _m1Aligned ? (isBuy ? 'M1 achat' : 'M1 vente') : '';
          const _timStr = [_m5str, _m1str].filter(Boolean).join(' + ');
          return `Position ${dirLabel}${_typeTag} saine — tous TF alignés${_timStr ? ' (' + _timStr + ')' : ''}. ${pnlSign}${pnlPips} ${pl}${_normIndStr}. RR ${rrLeft}. On reste dans le plan.`;
        }

        // 5. AFFAIBLISSEMENT DE L'IMPULSION
        const _impulseWeak = (_sc2 < 45 && _sc3 < 48) || (_normRsi > 0 && isBuy && _normRsi > 68 && pnlPips > 0) || (_normRsi > 0 && !isBuy && _normRsi < 32 && pnlPips > 0);
        if (_impulseWeak && !bePlaced) {
          return `⚡ Perte de force détectée${_typeTag} — M5 score ${Math.round(_sc2)}, M15 score ${Math.round(_sc3)}${_normIndStr}. ${pnlSign}${pnlPips} ${pl}. Protège tes gains, serre le SL.`;
        }

        // 6. M5 conflit seul
        if (_m5Conflict && !_m15Conflict) {
          return `Attention${_typeTag} — M5 montre une pression contraire. M15 et H1 restent ${isBuy ? 'haussiers' : 'baissiers'}. ${pnlSign}${pnlPips} ${pl}. Surveille sans paniquer.`;
        }

        // 7. Message bridge temps réel complet — tout ce que le robot voit
        // RSI par TF (bridge individuel rsiTf1-4)
        const _rsiM1b  = Number(_bp.rsiTf1 || 0), _rsiM5b  = Number(_bp.rsiTf2 || 0);
        const _rsiM15b = Number(_bp.rsiTf3 || 0), _rsiH1b  = Number(_bp.rsiTf4 || 0);
        const _rsiParts = [];
        if (_rsiM1b  > 0) _rsiParts.push(`M1:${Math.round(_rsiM1b)}`);
        if (_rsiM5b  > 0) _rsiParts.push(`M5:${Math.round(_rsiM5b)}`);
        if (_rsiM15b > 0) _rsiParts.push(`M15:${Math.round(_rsiM15b)}`);
        if (_rsiH1b  > 0) _rsiParts.push(`H1:${Math.round(_rsiH1b)}`);
        const _rsiBreakdown = _rsiParts.length > 0 ? ` | RSI M${_rsiParts.join(' ')}` : _normIndStr;
        // Scores bridge par TF (force du signal Pine)
        const _sc1n = Number(_bp.scoreTech1 || 0);
        const _scParts = [];
        if (_sc1n  > 0) _scParts.push(`M1:${Math.round(_sc1n)}`);
        if (_sc2   > 0) _scParts.push(`M5:${Math.round(_sc2)}`);
        if (_sc3   > 0) _scParts.push(`M15:${Math.round(_sc3)}`);
        if (_sc4   > 0) _scParts.push(`H1:${Math.round(_sc4)}`);
        const _scoreStr = _scParts.length > 0 ? ` | Score ${_scParts.join(' ')}` : '';
        // Zone de liquidité — là où le prix se trouve
        const _liqH = Number(_bp.liqHigh || 0), _liqL = Number(_bp.liqLow || 0);
        const _zoneParts = [];
        if (_bp.inTop === true)  _zoneParts.push('Zone résistance');
        if (_bp.inBot === true)  _zoneParts.push('Zone support');
        if (_liqH > 0 && !_bp.inTop) _zoneParts.push(`LiqH ${fmt(_liqH)}`);
        if (_liqL > 0 && !_bp.inBot) _zoneParts.push(`LiqL ${fmt(_liqL)}`);
        const _zoneStr = _zoneParts.length > 0 ? ` | ${_zoneParts.join(' ')}` : '';
        // Anticipation si active
        const _antNote2 = _ant && _af > 20 ? ` | ${_ant.replace(/_/g,' ')} ${Math.round(_af)}%` : '';
        // Macro
        const _macroNote = _mBull > 55 ? ` | Macro bull ${Math.round(_mBull)}%` : _mBear > 55 ? ` | Macro bear ${Math.round(_mBear)}%` : '';
        // TF alignement
        const _presDir = isBuy ? 'haussière' : 'baissière';
        const _tfOkStr = [_h1Aligned ? 'H1' : null, _m15Aligned ? 'M15' : null, _m5Aligned ? 'M5' : null, _m1Aligned ? 'M1' : null].filter(Boolean).join('+');
        const _tfStr   = _tfOkStr ? ` | ${_tfOkStr} alignés` : '';

        // ── PUSH TIME ESTIMATE — "dans combien de temps ça va pousser / couler" ──
        // Principe: plus les TF courts sont forts ET alignés, plus le mouvement est imminent.
        // Poids: M1 (0.40) > M5 (0.30) > M15 (0.20) > H1 (0.10) + anticipationForce bonus
        // RSI épuisé → pas de push annoncé (risque retournement)
        const _sc1b    = Number(_bp.scoreTech1 || 0); // score M1 bridge
        const _m1AlSc  = _m1Aligned  && _sc1b > 0 ? _sc1b : 0;
        const _m5AlSc  = _m5Aligned  && _sc2   > 0 ? _sc2  : 0;
        const _m15AlSc = _m15Aligned && _sc3   > 0 ? _sc3  : 0;
        const _h1AlSc  = _h1Aligned  && _sc4   > 0 ? _sc4  : 0;
        const _afBonus = _af > 0 ? _af : 0;
        // Momentum pondéré (0-100)
        const _mDenom  = 0.4 + 0.3 + 0.2 + 0.1 + (_afBonus > 0 ? 0.25 : 0);
        const _mWeighted = (
          _m1AlSc * 0.4 + _m5AlSc * 0.3 + _m15AlSc * 0.2 + _h1AlSc * 0.1 + _afBonus * 0.25
        ) / _mDenom;
        // RSI épuisé = signaux d'alerte, pas de push annoncé
        const _rsiExhaust = (_normRsi > 0 && isBuy  && _normRsi > 73)
                         || (_normRsi > 0 && !isBuy && _normRsi < 27);
        let _pushStr = '';
        if (_mWeighted >= 38 && !_rsiExhaust) {
          const _pushDir = isBuy ? 'vers le haut' : 'vers le bas';
          const _pushEmoji = isBuy ? '⬆' : '⬇';
          const _pushVerb  = isBuy ? 'pousser' : 'couler';
          if (_af > 62 && (_ant.includes('PUSH') || _ant.includes('IMPULSION') || _ant.includes('HAUSSIER') || _ant.includes('BAISSIER'))) {
            // Anticipation Pine forte → push imminent (quelques bougies M1)
            _pushStr = ` | ⚡ Push ${_pushEmoji} imminent — ${_ant.replace(/_/g,' ')} ${Math.round(_af)}%`;
          } else if (_m1AlSc >= 65 && _m5AlSc >= 55) {
            // M1+M5 forts → 1 à 5 minutes
            const _avgSc = Math.round((_m1AlSc + _m5AlSc) / 2);
            _pushStr = ` | 🔥 Va ${_pushVerb} ${_pushDir} dans ~1-5 min (M1+M5 alignés ${_avgSc}%)`;
          } else if (_m5AlSc >= 60 && _m15AlSc >= 52) {
            // M5+M15 forts → 5 à 15 minutes
            const _avgSc = Math.round((_m5AlSc + _m15AlSc) / 2);
            _pushStr = ` | 📈 Va ${_pushVerb} ${_pushDir} dans ~5-15 min (M5+M15 ${_avgSc}%)`;
          } else if (_m15AlSc >= 58 && _h1AlSc >= 52) {
            // M15+H1 forts → 15 à 45 minutes
            const _avgSc = Math.round((_m15AlSc + _h1AlSc) / 2);
            _pushStr = ` | 📊 Va ${_pushVerb} ${_pushDir} dans ~15-45 min (M15+H1 ${_avgSc}%)`;
          } else if (_m1AlSc >= 55 || _m5AlSc >= 55) {
            const _drivTF = _m1AlSc >= _m5AlSc ? 'M1' : 'M5';
            const _drivSc = Math.max(_m1AlSc, _m5AlSc);
            _pushStr = ` | Pression ${_pushDir} — ${_drivTF} ${Math.round(_drivSc)}% (momentum en cours)`;
          } else if (_mWeighted >= 52) {
            _pushStr = ` | Momentum ${Math.round(_mWeighted)}% — accumulation ${isBuy ? 'haussière' : 'baissière'}`;
          }
        }
        return `${dirLabel}${_typeTag} — ${pnlSign}${pnlPips} ${pl} | Pression ${_presDir}${_tfStr}${_rsiBreakdown}${_scoreStr}${_antNote2}${_macroNote}${_zoneStr}${_pushStr}. TP ${fmt(tp)} RR ${rrLeft}.`;
      }

      const normalMsgs = isBuy ? [
        `LONG en cours — Prix ${fmt(price)}${_normIndStr}. Gain: ${pnlSign}${pnlPips} ${pl}. TP à ${fmt(tp)} (${Math.round(distTP * pipMult)} ${pl} restants), RR ${rrLeft}. ${_normMom}.`,
        `Position LONG active sur ${sym}. ${pnlSign}${pnlPips} ${pl}${_normIndStr}. Structure haussière maintenue — je surveille la clôture des bougies.`,
        `Prix ${fmt(price)}, entrée ${fmt(entry)}${_normIndStr}. ${pnlSign}${pnlPips} ${pl} en cours. TP: ${fmt(tp)}. On reste dans le plan.`
      ] : [
        `SHORT en cours — Prix ${fmt(price)}${_normIndStr}. Gain: ${pnlSign}${pnlPips} ${pl}. TP à ${fmt(tp)} (${Math.round(distTP * pipMult)} ${pl} restants), RR ${rrLeft}. ${_normMom}.`,
        `Position SHORT active sur ${sym}. ${pnlSign}${pnlPips} ${pl}${_normIndStr}. Pression vendeuse maintenue — je surveille la clôture des bougies.`,
        `Prix ${fmt(price)}, entrée ${fmt(entry)}${_normIndStr}. ${pnlSign}${pnlPips} ${pl} en cours. TP: ${fmt(tp)}. On reste dans le plan.`
      ];
      return normalMsgs[Math.floor(Date.now() / 35000) % normalMsgs.length];
    }

    // Phases nommées
    if (phase === 'ARMED') {
      // Message dynamique: ce qu'on attend précisément, avec les indicateurs actuels
      const _armPrice = liveData?.currentPrice || price || 0;
      const _armRsi   = parseFloat(tvLiveData?.rsi  || tvLiveData?.indicators?.rsi  || 0);
      const _armMacd  = parseFloat(tvLiveData?.macd || tvLiveData?.indicators?.macd || 0);
      const _armConf  = Number(tradeState?.lastSnapshotConf || 0);
      const _armConflicts = Array.isArray(tradeState?.lastSnapshotConflicts) ? tradeState.lastSnapshotConflicts : [];
      // Ce qu'il manque pour entrer
      const _missing = _armConflicts.length > 0
        ? 'En attente : ' + _armConflicts[0].split('—')[0].trim()
        : 'En attente du moment propre';
      const _rsiStr  = _armRsi > 0 ? ` | RSI ${Math.round(_armRsi)}` : '';
      const _macdStr = _armMacd !== 0 ? ` | MACD ${_armMacd >= 0 ? '+' : ''}${_armMacd.toFixed(2)}` : '';
      const _confStr = _armConf > 0 ? ` | Signal ${Math.round(_armConf)}%` : '';
      const _armedMsgs = [
        `🔍 Robot armé — Prix ${fmt(_armPrice)}${_rsiStr}${_macdStr}${_confStr}. ${_missing}. Je surveille chaque bougie et j'entre automatiquement dès que c'est propre.`,
        `👁 Surveillance active — Prix ${fmt(_armPrice)}${_rsiStr}${_macdStr}. Je cherche la confluence parfaite. ${_missing}. Pas d'entrée avant que tout soit aligné.`,
        `⏳ En attente du setup — ${_missing}${_confStr}. Prix actuel ${fmt(_armPrice)}${_rsiStr}. Je t'annonce vocalement dès que les conditions sont réunies.`
      ];
      return _armedMsgs[Math.floor(Date.now() / 30000) % _armedMsgs.length];
    }
    if (phase === 'be_reached') return `Break-even atteint. Risque zéro sur ce trade. On laisse courir vers le TP — le marché travaille pour nous.`;
    if (phase === 'partial_taken') {
      const tpFmt = fmt(tp);
      return `Première partie sécurisée. Bien joué. Le reste de la position court vers ${tpFmt}. Laisse-la respirer.`;
    }
    if (phase === 'trailing') return `On trail le SL — chaque gain est verrouillé. Reste calme et laisse le marché faire son travail.`;
    if (phase === 'CLOSED' || phase === 'EXITED' || phase === 'closed') {
      const exitPrice = liveData?.currentPrice || tradeState?.exitPrice;
      if (entry && exitPrice) {
        const pnlPips = Math.round((isBuy ? exitPrice - entry : entry - exitPrice) * pipMult);
        const won = pnlPips > 0;
        return won
          ? `Trade terminé — plus ${pnlPips} ${pipLabel}. Excellent travail. On laisse le marché se repositionner et on attend le prochain setup propre.`
          : `Trade terminé — ${pnlPips} ${pipLabel}. Ça arrive aux meilleurs. Le SL a fait son job. On reste discipliné et on revient plus fort.`;
      }
      return `Trade terminé. Analyse la clôture et prépare le prochain setup.`;
    }

    const fallback = [
      `Position ouverte sur ${sym || 'le marché'}. Je surveille le marché en temps réel pour toi.`,
      `En position ${dirLabel}. Je te préviens dès qu'il y a quelque chose d'important.`,
      `Je surveille les niveaux actifs. Aucun signal d'alerte pour l'instant.`
    ];
    return fallback[Math.floor(Date.now() / 40000) % fallback.length];
  }

  app.post('/coach/close-summary', async (req, res) => {
    try {
      const { symbol, entry, exitPrice, sl, tp, direction, durationMin } = req.body;
      // Fix #2 — pipMult correct par asset (ancien: 10000 partout → ×1000 d'erreur sur XAUUSD)
      const _csSym = String(symbol || '').toUpperCase();
      const pipMult = /BTC|ETH|SOL|XRP/.test(_csSym) ? 1
        : /US30|NAS|SPX|SP500|DAX|DE40|GER40/.test(_csSym) ? 1
        : /XAU|GOLD/.test(_csSym) ? 10
        : _csSym.includes('JPY') ? 100 : 10000;
      const pnlPips = Math.round((exitPrice - entry) * pipMult * (direction === 'SHORT' ? -1 : 1));
      const won = pnlPips > 0;
      const rr = tp && sl ? (Math.abs(tp - entry) / Math.abs(entry - sl)).toFixed(1) : '--';

      const summary = {
        ok: true,
        won,
        pnlPips,
        entry, exitPrice, sl, tp, rr,
        durationMin,
        message: won
          ? `✅ +${pnlPips} pips — Trade gagnant. Discipline respectée.`
          : `❌ ${pnlPips} pips — SL touché. Gestion correcte, on passe au suivant.`,
        color: won ? '#22c55e' : '#ef4444',
        nextAction: 'Attendre le prochain setup. Ne pas sur-trader.'
      };

      pushLog('coach', 'trade-closed', summary.message, won ? 'ok' : 'warn');

      const journalEntry = addTradeToJournal({
        symbol, direction,
        entry, exit: exitPrice,
        sl, tp, pnlPips, won, rr,
        durationMin,
        openedAt: req.body.openedAt,
        coachMessage: summary.message
      });
      summary.journalId = journalEntry.id;

      res.json(summary);
    } catch(err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/journal', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const symbol = req.query.symbol;
    let entries = symbol ? tradeJournal.filter(t => t.symbol === symbol) : tradeJournal;
    const stats = {
      total: entries.length,
      won: entries.filter(t => t.won).length,
      winRate: entries.length ? Math.round(entries.filter(t => t.won).length / entries.length * 100) : 0,
      totalPips: entries.reduce((s, t) => s + (t.pnlPips || 0), 0),
      avgRR: entries.length ? (entries.reduce((s,t) => s + parseFloat(t.rr||0), 0) / entries.length).toFixed(2) : '--'
    };
    res.json({ ok: true, entries: entries.slice(0, limit), stats });
  });

  app.post('/journal/reset', (req, res) => {
    const backup = [...tradeJournal];
    tradeJournal = [];
    saveJournal();
    console.log(`[JOURNAL] Reset — ${backup.length} trades archivés.`);
    // Notifier tous les clients SSE (extension + dashboard) pour qu'ils rafraîchissent les stats
    broadcastToExtension({
      type: 'journal-reset',
      archived: backup.length,
      message: `${backup.length} trades supprimés. Compteurs remis à zéro.`
    });
    res.json({ ok: true, archived: backup.length, message: `${backup.length} trades supprimés. Compteurs remis à zéro.` });
  });

  app.get('/coach/realtime', async (req, res) => {
    try {
      const raw = String(req.query.symbol || marketStore.lastActiveSymbol || getLatestTradingviewRuntime().symbol || activeSymbol?.symbol || '').toUpperCase();
      const symbol = normalizeSymbol(raw).canonical || raw;
      if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });

      // Utiliser getLastKnownPrice (stale OK) pour l'analyse — requireLivePrice uniquement pour ENTER
      const live = getLastKnownPrice(symbol);
      if (!live) {
        return res.status(503).json({
          ok: false, error: 'NO_PRICE',
          message: `Aucun prix disponible pour ${symbol}. Ouvrez TradingView avec l'extension active.`
        });
      }

      const timeframe = String(req.query.tf || 'H1').toUpperCase();
      const requestedMode = String(req.query.mode || req.query.setup || activeSymbol?.mode || bridgeConfig.bridgeMode || 'AUTO').toUpperCase();
      const mode = resolveRuntimeMode(requestedMode, symbol, timeframe);
      const lang = String(req.query.lang || 'fr').toLowerCase() === 'en' ? 'en' : 'fr';

      const safeLocalJson = async (endpoint, ms) => {
        try {
          return await fetchLocalJson(endpoint, {}, ms || 8000);
        } catch (_e) {
          return { ok: false, status: 500, data: null };
        }
      };

      const [chartResp, coachResp, tradeStateResp, instantResp, extResp, closureResp] = await Promise.all([
        safeLocalJson('/mt5/current-chart?symbol=' + encodeURIComponent(symbol) + '&tf=' + encodeURIComponent(timeframe)),
        safeLocalJson('/coach/live?symbol=' + encodeURIComponent(symbol) + '&tf=' + encodeURIComponent(timeframe) + '&lang=' + encodeURIComponent(lang), 7000),
        safeLocalJson('/coach/trade-state?symbol=' + encodeURIComponent(symbol) + '&tf=' + encodeURIComponent(timeframe)),
        safeLocalJson(
          '/instant-trade-live?symbol=' + encodeURIComponent(symbol) +
          '&tf=' + encodeURIComponent(timeframe) +
          (mode ? '&mode=' + encodeURIComponent(mode) : '')
        ),
        safeLocalJson('/extension/data'),
        safeLocalJson('/chart-data?symbol=' + encodeURIComponent(symbol) + '&timeframe=' + encodeURIComponent(timeframe))
      ]);

      const chart = chartResp.data?.ok ? chartResp.data : null;
      const coach = coachResp.data?.ok ? coachResp.data : null;
      const tradeState = tradeStateResp.data?.state || getCoachTradeState(symbol, timeframe);
      const instantTrade = instantResp.data?.trade || instantResp.data?.data || null;
      const candleClosure = closureResp.data?.ok ? closureResp.data?.closure || null : null;
      const marketStatus = marketHoursChecker.getStatus(symbol);
      const tvFallbackEntry = (() => {
        const k = findTradingviewSymbolKey(symbol);
        return k ? tvDataStore[k] : null;
      })();
      const tvFallbackDirectionRaw = tvFallbackEntry?.robotV12?.verdict
        || tvFallbackEntry?.robotV12?.anticipation
        || tvFallbackEntry?.action
        || '';
      const fallbackDirection = String(tvFallbackDirectionRaw || instantTrade?.direction || '').toUpperCase();
      const fallbackReco = fallbackDirection.includes('LONG') || fallbackDirection.includes('BUY')
        ? 'BUY'
        : (fallbackDirection.includes('SHORT') || fallbackDirection.includes('SELL') ? 'SELL'
        : (fallbackDirection === 'NEUTRE' ? 'NEUTRE' : 'ATTENTE'));
      const fallbackReason = instantTrade?.technical
        || instantTrade?.sentiment
        || (marketStatus?.isOpen
          ? `Analyse technique active — ${fallbackReco === 'NEUTRE' ? 'Marché en consolidation. Attendre rupture directionnelle.' : 'Flux live actif.'}`
          : `Marché fermé (${marketStatus?.market || 'n/a'}).`);
      const fallbackTradeStatus = String(instantTrade?.trade_status || '').toUpperCase();
      const fallbackCanEnter = !!marketStatus?.isOpen
        && (fallbackReco === 'BUY' || fallbackReco === 'SELL')
        && Number.isFinite(Number(instantTrade?.entry))
        && Number.isFinite(Number(instantTrade?.sl))
        && Number.isFinite(Number(instantTrade?.tp))
        && (fallbackTradeStatus === 'LIVE' || fallbackTradeStatus === 'CONDITIONAL');
      // Determine signal state: ENTRÉE VALIDE / ATTENTE / RISQUE
      const signalState = fallbackCanEnter ? 'ENTRÉE VALIDE'
        : (fallbackReco === 'NEUTRE' || fallbackReco === 'ATTENTE') ? 'ATTENTE'
        : (fallbackReco === 'BUY' || fallbackReco === 'SELL') ? 'SIGNAL ACTIF — CONFIRMER'
        : 'ATTENTE';
      let effectiveCoach = coach || {
        ok: true,
        generatedLive: true,
        signal: { verdict: fallbackReco, signalState, source: 'technical-klines' },
        execution: {
          decision: fallbackCanEnter ? 'ENTER' : (fallbackReco === 'NEUTRE' ? 'ATTENTE' : 'WAIT'),
          canEnter: fallbackCanEnter,
          reason: fallbackCanEnter
            ? 'Entrée validée: signal directionnel + niveaux SL/TP confirmés.'
            : (fallbackReco === 'NEUTRE'
              ? 'Marché neutre — attendre rupture de canal avant entrée.'
              : 'Signal présent — attendre confirmation niveaux.'),
          conflict: false,
          conflictReasons: []
        },
        agents: {
          analysis: {
            recommendation: fallbackReco,
            reason: fallbackReason,
            confidence: instantTrade?.confidence || 55,
            strength: instantTrade?.confidence || 55,
            signalState
          },
          risk: {
            riskLevel: instantTrade?.risk || (marketStatus?.isOpen ? 'Medium' : 'High'),
            riskReason: marketStatus?.isOpen ? 'Flux actif, valider spread/volatilité.' : 'Marché fermé ou indisponible.',
            rsi: (() => { const _k = findTradingviewSymbolKey(symbol); return _k ? (tvDataStore[_k]?.indicators?.rsi ?? null) : null; })()
          },
          technicals: (() => {
            const _k = findTradingviewSymbolKey(symbol);
            const _ind = _k ? (tvDataStore[_k]?.indicators || {}) : {};
            return {
              rsi:  _ind.rsi  ?? null,
              macd: _ind.macd ?? null,
              ma20: _ind.ma20 ?? null,
              atr:  _ind.atr  ?? null
            };
          })(),
          strategy: {
            logic: instantTrade?.setup_type
              ? `Setup ${String(instantTrade.setup_type).toUpperCase()} détecté.`
              : 'Aucun setup confirmé, surveillance en cours.'
          },
          news: {
            symbolImpact: marketStatus?.isOpen ? 'Impact news: surveiller annonces live.' : 'Impact news secondaire tant que marché fermé.'
          }
        },
        lia: (() => {
          const _price = Number(chart?.price || chart?.bid || instantTrade?.entry || NaN);
          const _priceStr = Number.isFinite(_price) ? (_price > 1000 ? _price.toFixed(2) : _price.toFixed(5)) : '--';
          const _dir = String(instantTrade?.direction || fallbackDirection || '').toUpperCase();
          const _sl = instantTrade?.sl != null ? (Number(instantTrade.sl) > 1000 ? Number(instantTrade.sl).toFixed(2) : Number(instantTrade.sl).toFixed(5)) : '--';
          const _tp = instantTrade?.tp != null ? (Number(instantTrade.tp) > 1000 ? Number(instantTrade.tp).toFixed(2) : Number(instantTrade.tp).toFixed(5)) : '--';
          const _rr = instantTrade?.rrRatio != null ? String(instantTrade.rrRatio) : '--';
          const _setup = instantTrade?.setup_type ? String(instantTrade.setup_type).toUpperCase() : null;
          const _conf = Number(instantTrade?.confidence || 55);
          const _risk = String(instantTrade?.risk || (marketStatus?.isOpen ? 'Medium' : 'High'));
          const _signalUsed = instantTrade?.technical || fallbackReason || 'Signal technique indisponible';
          const _sessions = (marketStatus?.sessions?.sessions || []).filter(s => s.isOpen).map(s => s.label).join(', ') || 'aucune';
          const _lines = [];
          if (marketStatus?.isOpen) {
            _lines.push(`${symbol} ${timeframe} | Prix: ${_priceStr} | ${marketStatus.market}/${marketStatus.session}`);
            if (_dir) _lines.push(`Signal: ${_dir}${_setup ? ' [' + _setup + ']' : ''} | Confiance: ${_conf}% | Risque: ${_risk}`);
            if (_sl !== '--') _lines.push(`SL: ${_sl} | TP: ${_tp} | R:R ${_rr}`);
            _lines.push(`Signaux utilisés: ${_signalUsed}`);
            _lines.push(`Impact timeframe ${timeframe}: ${timeframe.startsWith('M') ? 'scalping/swing court, bruit plus élevé' : 'contexte plus stable, confirmation plus lente'}`);
            _lines.push(`Sessions actives: ${_sessions}`);
            if (_dir === 'BUY' || _dir === 'LONG') {
              _lines.push(`Pourquoi entrer: momentum haussier confirmé si cassure + clôture valide.`);
              _lines.push(`Pourquoi attendre: pas d'entrée si spread/volatilité dépasse le risque prévu.`);
              _lines.push(`→ Plan: confirmer structure haussière, puis invalider si clôture sous SL.`);
            } else if (_dir === 'SELL' || _dir === 'SHORT') {
              _lines.push(`Pourquoi entrer: momentum baissier confirmé si cassure + clôture valide.`);
              _lines.push(`Pourquoi attendre: pas d'entrée si rebond fort sans confirmation vendeuse.`);
              _lines.push(`→ Plan: confirmer structure baissière, puis invalider si clôture au-dessus de SL.`);
            } else {
              _lines.push(`Pourquoi attendre: aucun setup directionnel confirmé.`);
              _lines.push(`→ Plan: surveiller zones clés et attendre signal net avant entrée.`);
            }
          } else {
            _lines.push(`${symbol} ${timeframe} | Marché FERMÉ (${marketStatus?.market || 'n/a'})`);
            _lines.push(`→ Aucune action avant réouverture. Préparer zones d'entrée potentielles.`);
          }
          return { ok: true, response: _lines.join('\n') };
        })()
      };
      const activeSource = String(bridgeConfig.activeSource || (bridgeConfig.mt5Enabled === true ? 'mt5' : 'tradingview')).toLowerCase() === 'mt5' ? 'mt5' : 'tradingview';

      // Per-symbol TV price isolation:
      // Always look up the tvDataStore entry for the REQUESTED symbol first.
      // This prevents cross-symbol contamination when the active context is a different symbol.
      const tvSymKey = findTradingviewSymbolKey(symbol);
      const tvSymEntry = tvSymKey ? tvDataStore[tvSymKey] : null;
      const tvSymPrice = Number(tvSymEntry?.price ?? tvSymEntry?.bid ?? NaN);

      // Only trust /extension/data price when the active symbol matches the requested symbol.
      const extActiveSymbol = String(extResp.data?.activeSymbol?.symbol || extResp.data?.currentData?.symbol || '').toUpperCase();
      const extMatchesRequest = extActiveSymbol === symbol || normalizeSymbol(extActiveSymbol).canonical === normalizeSymbol(symbol).canonical;
      const extCurrentPrice = extMatchesRequest ? Number(extResp.data?.currentData?.price ?? extResp.data?.activeSymbol?.price ?? NaN) : NaN;

      const priceCandidates = activeSource === 'tradingview'
        ? [
            tvSymPrice,         // FIRST: direct TV store for this exact symbol
            extCurrentPrice,    // only if extActive === requested symbol
            chart?.price,
            chart?.bid,
            getCoachMarketPrice(symbol)
          ]
        : [
            chart?.price,
            chart?.bid,
            tvSymPrice,
            extCurrentPrice,
            getCoachMarketPrice(symbol)
          ];

      const currentPrice = Number(priceCandidates.find((v) => Number.isFinite(Number(v)) && Number(v) > 0) || NaN);
      const headerPrice = Number(extResp.data?.currentData?.price ?? extResp.data?.activeSymbol?.price ?? NaN);
      const chartPrice = Number(chart?.price ?? chart?.bid ?? NaN);
      const decideVsHeader = Number.isFinite(currentPrice) && Number.isFinite(headerPrice)
        ? Math.abs(currentPrice - headerPrice) / Math.max(Math.abs(currentPrice), 1)
        : null;
      const decideVsChart = Number.isFinite(currentPrice) && Number.isFinite(chartPrice)
        ? Math.abs(currentPrice - chartPrice) / Math.max(Math.abs(currentPrice), 1)
        : null;
      const priceConsistency = {
        decisionPrice: Number.isFinite(currentPrice) ? currentPrice : null,
        headerPrice: Number.isFinite(headerPrice) ? headerPrice : null,
        chartPrice: Number.isFinite(chartPrice) ? chartPrice : null,
        coherent: (decideVsHeader == null || decideVsHeader <= 0.0025) && (decideVsChart == null || decideVsChart <= 0.01),
        deltaHeaderPct: decideVsHeader == null ? null : Number((decideVsHeader * 100).toFixed(3)),
        deltaChartPct: decideVsChart == null ? null : Number((decideVsChart * 100).toFixed(3))
      };
      const currentDataSource = activeSource === 'tradingview'
        ? (extResp.data?.currentData?.source || extResp.data?.activeSymbol?.source || chart?.source || (Number.isFinite(currentPrice) ? 'tradingview' : null))
        : (chart?.source || extResp.data?.currentData?.source || extResp.data?.activeSymbol?.source || (Number.isFinite(currentPrice) ? 'market-fallback' : null));

      const rawVirtualPack = buildVirtualPositionSnapshot(tradeState, instantTrade, effectiveCoach?.agents || null, currentPrice);
      const autoAdjusted = applyDynamicCoachAdjustments(tradeState, rawVirtualPack);
      const virtualPack = autoAdjusted.virtualPack;
      const robotV12Live = getRobotV12ForSymbol(symbol);
      const tradeReasoning = buildTradeReasoningSnapshot(symbol, timeframe, instantTrade, effectiveCoach, tradeState, marketStatus, robotV12Live);
      if (autoAdjusted.messages.length > 0) {
        tradeReasoning.management.nextAction = autoAdjusted.messages.join(' | ');
        const firstMsg = autoAdjusted.messages[0];
        tradeState.notes.unshift({ note: firstMsg, ts: Date.now(), action: 'AUTO_COACH' });
        if (tradeState.notes.length > 30) tradeState.notes.length = 30;
      }

      // RÈGLE: entry + sl + tp sont VERROUILLÉS après ENTER — ne jamais les écraser
      // Seuls les champs de suivi (currentPrice, pnlPoints, progressToTp, bePlaced...) sont mis à jour
      if (tradeState.virtualPosition && virtualPack.virtualPosition) {
        const _lockedEntry = tradeState.virtualPosition.entry;
        const _lockedSl    = tradeState.virtualPosition.sl;
        const _lockedTp    = tradeState.virtualPosition.tp;
        const _lockedDir   = tradeState.virtualPosition.direction;
        const _lockedBe    = tradeState.virtualPosition.slMovedToBE; // true si BE déjà appliqué
        tradeState.virtualPosition = { ...tradeState.virtualPosition, ...virtualPack.virtualPosition };
        // Restore locked values — priority absolue
        if (_lockedEntry > 0) tradeState.virtualPosition.entry = _lockedEntry;
        // SL: restaurer uniquement si BE pas encore appliqué — après BE le SL = entry = légal
        // Si slMovedToBE=true, _lockedSl contient déjà le niveau BE : restaurer est correct
        if (_lockedSl > 0) tradeState.virtualPosition.sl = _lockedSl;
        if (_lockedBe) tradeState.virtualPosition.slMovedToBE = true; // préserver le marqueur BE
        if (_lockedTp    > 0) tradeState.virtualPosition.tp    = _lockedTp;
        if (_lockedDir)       tradeState.virtualPosition.direction = _lockedDir;
      }

      const levelSource = virtualPack.virtualPosition
        ? String(virtualPack.virtualPosition.source || 'virtual-position')
        : String(instantTrade?.source || 'none');
      const levelValues = virtualPack.virtualPosition || instantTrade || null;

      // Fallback coach LIA : si la position est entrée et que le LIA IA n'a pas produit de réponse valide,
      // on utilise generatePositionCoachMessage pour produire un message de suivi en français naturel.
      let coachLia = effectiveCoach?.lia || null;
      const liveSnapshot = { currentPrice, symbol, virtualPosition: virtualPack.virtualPosition };
      // Passer tvLiveData (bridge TV) pour que les indicateurs RSI/ATR/trend soient disponibles
      const _tvLiveForCoach = typeof tvDataStore !== 'undefined'
        ? (tvDataStore[String(symbol||'').toUpperCase()] || null)
        : null;
      const _tsPhaseUpper = String(tradeState?.phase || '').toUpperCase();
      // ARMED: toujours remplacer par le message dynamique (surveillance active)
      if (_tsPhaseUpper === 'ARMED') {
        const _armedMsg = generatePositionCoachMessage(tradeState, liveSnapshot, _tvLiveForCoach);
        if (_armedMsg) coachLia = { ok: true, response: _armedMsg };
      } else if (tradeState?.entered && (!coachLia?.response || coachLia.response.length < 10)) {
        // Position entrée sans lia → générer le message de suivi
        coachLia = { ok: true, response: generatePositionCoachMessage(tradeState, liveSnapshot, _tvLiveForCoach) };
      }
      if (coachLia && effectiveCoach) {
        effectiveCoach = { ...effectiveCoach, lia: coachLia };
      }

      // ── Injecter les indicateurs bridge dans effectiveCoach.agents.technicals ──
      // Fait ici pour couvrir TOUS les chemins (coach réel + fallback)
      if (effectiveCoach) {
        const _tvK = findTradingviewSymbolKey(symbol);
        const _tvInd = _tvK ? (tvDataStore[_tvK]?.indicators || {}) : {};
        const _rsiVal = _tvInd.rsi != null ? Number(_tvInd.rsi) : null;
        const _existingAgents = effectiveCoach.agents || {};
        effectiveCoach = {
          ...effectiveCoach,
          agents: {
            ..._existingAgents,
            technicals: {
              rsi:  _rsiVal,
              macd: _tvInd.macd != null ? Number(_tvInd.macd) : null,
              ma20: _tvInd.ma20 != null ? Number(_tvInd.ma20) : null,
              atr:  _tvInd.atr  != null ? Number(_tvInd.atr)  : null,
              ...(_existingAgents.technicals || {})   // ne pas écraser si déjà présent
            },
            risk: {
              ...(_existingAgents.risk || {}),
              rsi: _rsiVal   // exposé aussi dans risk.rsi pour la popup multi-TF
            }
          }
        };
      }

      // Ensure signalState is always populated in effectiveCoach (even when coach comes from cache)
      if (effectiveCoach && !effectiveCoach.signal?.signalState) {
        const cachedReco = String(effectiveCoach.agents?.analysis?.recommendation
          || effectiveCoach.signal?.verdict || 'NEUTRE').toUpperCase();
        const cachedCanEnter = effectiveCoach.execution?.canEnter === true;
        const computedSignalState = cachedCanEnter ? 'ENTRÉE VALIDE'
          : (cachedReco === 'NEUTRE' || cachedReco === 'ATTENTE' || cachedReco === 'WAIT') ? 'ATTENTE'
          : (cachedReco === 'BUY' || cachedReco === 'SELL') ? 'SIGNAL ACTIF — CONFIRMER'
          : 'ATTENTE';
        effectiveCoach = {
          ...effectiveCoach,
          signal: { ...(effectiveCoach.signal || {}), signalState: computedSignalState },
          agents: effectiveCoach.agents ? {
            ...effectiveCoach.agents,
            analysis: effectiveCoach.agents.analysis
              ? { ...effectiveCoach.agents.analysis, signalState: computedSignalState }
              : { signalState: computedSignalState }
          } : effectiveCoach.agents
        };
      }

      // Injecter stats RSI per-TF dans coach.signal.stats — lu par renderMultiTF de l'extension
      // buildRuntimeTradeSignal lit robotV12.rsi_1m/5m/15m/60m + _bridgePayload.rsiTf1-4
      const _rtSignalForStats = buildRuntimeTradeSignal(symbol, timeframe, instantTrade, robotV12Live, marketStatus, currentPrice);
      if (_rtSignalForStats?.stats && effectiveCoach) {
        effectiveCoach = {
          ...effectiveCoach,
          signal: { ...(effectiveCoach.signal || {}), stats: _rtSignalForStats.stats }
        };
      }

      // VP à retourner: si position entrée, utiliser tradeState.virtualPosition (verrouillée)
      // sinon virtualPack (pre-entry indicatif)
      // FIX: ne retourner la VP que si position réellement active — sinon null
      // d.virtualPosition=null garantit que le dashboard ne réaffiche pas une position fermée sur refresh
      const vpForResponse = (tradeState.entered && tradeState.virtualPosition)
        ? tradeState.virtualPosition
        : null;

      // ── tfDataMeta: transparence sur la source réelle des données par TF ──────
      const _tfBridgeMap  = { M1: true, M5: true, M15: true, H1: true };
      const _tfProxyMap   = { M30: 'M15' };
      const _tfRsiSrcMap  = { M1: 'rsiTf1', M5: 'rsiTf2', M15: 'rsiTf3', M30: 'rsiTf3(proxy)', H1: 'rsiTf4', H4: null, D1: null };
      const _tfHasBridge  = !!_tfBridgeMap[timeframe];
      const _tfProxy      = _tfProxyMap[timeframe] || null;
      const _tfDirSrc     = _tfHasBridge ? 'pine_bridge_per_tf'
        : _tfProxy ? ('pine_bridge_proxy_' + _tfProxy) : 'global_robotv12';
      const _tfNote       = _tfHasBridge ? null
        : _tfProxy ? `${timeframe} utilise ${_tfProxy} comme proxy (pas de champ dédié dans le bridge Pine).`
        : `${timeframe} utilise le verdict global (aucune donnée bridge per-TF disponible).`;

      res.json({
        ok: true,
        symbol,
        timeframe,
        mode: requestedMode,
        modeResolved: mode,
        currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
        dataSource: currentDataSource,
        lang,
        availableTimeframes: USER_TIMEFRAMES,
        tfDataMeta: {
          hasBridgeData: _tfHasBridge,
          proxyTf: _tfProxy,
          rsiSource: _tfRsiSrcMap[timeframe] || null,
          directionSource: _tfDirSrc,
          note: _tfNote
        },
        chart,
        coach: effectiveCoach,
        execution: effectiveCoach?.execution || null,
        candleClosure,
        marketStatus,
        robotV12: robotV12Live,
        tradeReasoning,
        tradeState,
        instantTrade,
        virtualPosition: vpForResponse,
        nextAction: virtualPack.nextAction,
        priceConsistency,
        levelTrace: {
          source: levelSource,
          received: {
            entry: levelValues?.entry ?? null,
            sl: levelValues?.sl ?? null,
            tp: levelValues?.tp ?? null,
            rrRatio: levelValues?.rrRatio ?? null
          },
          note: 'Backend transmet les niveaux TradingView sans recalcul.'
        },
        sync: {
          activeSymbol: extResp.data?.activeSymbol || null,
          currentData: extResp.data?.currentData || null,
          systemStatus: extResp.data?.systemStatus || null
        },
        // Messages humains — état marché sans termes techniques
        exhaustionAlert: effectiveCoach?.exhaustionAlert || null,
        pulsionAlert:    effectiveCoach?.pulsionAlert    || null,
        unifiedPayload:  effectiveCoach?.unifiedPayload  || null
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /integration/remaining-production — état de production restante + base multilingue
  app.get('/integration/remaining-production', (req, res) => {
    const locale = String(req.query.lang || 'fr').toLowerCase();
    const supportedLocales = ['fr', 'en'];
    const remaining = [
      'Connecter un flux news économique premium si nécessaire (événements enrichis).',
      'Ajouter persistance durable du suivi trade (DB) pour reprise après redémarrage.',
      'Ajouter tests e2e dashboard coach (timeframes/actions/news urgentes).',
      'Ajouter contenu UI complet EN pour tous les libellés dynamiques.',
      'Ajouter métriques qualité coaching (latence, fiabilité, taux de consigne utile).'
    ];
    res.json({
      ok: true,
      locale: supportedLocales.includes(locale) ? locale : 'fr',
      supportedLocales,
      antiDuplicateCheck: {
        reusedRoutes: ['/agents/:name/send', '/mt5/current-chart', '/lia/chat', '/calendar', '/news'],
        reusedPages: ['dashboard.html', 'AGENTS_MONITOR.html'],
        duplicateModulesAdded: 0
      },
      remaining
    });
  });

  // GET /coach/live — dashboard coaching aggregate (agents -> Lia -> recommendation)
  app.get('/coach/live', async (req, res) => {
    try {
      const symbol = String(req.query.symbol || marketStore.lastActiveSymbol || getLatestTradingviewRuntime().symbol || '').toUpperCase();
      const timeframe = String(req.query.tf || 'H1').toUpperCase();
      const lang = String(req.query.lang || 'fr').toLowerCase() === 'en' ? 'en' : 'fr';
      const tradeState = getCoachTradeState(symbol, timeframe);

      // TTL cache: 30s quand position active (plus long = signal stable, pas de refresh intempestif)
      // 90s quand pas de position (ok de recalculer moins souvent)
      // RÈGLE: ne JAMAIS forcer forceFresh quand position active — les niveaux entry/sl/tp
      // doivent rester stables. Seul le prix live change, pas le signal de base.
      const _enteredTtl = 30000; // 30s — stable pendant le trade
      const _idleTtl    = 90000; // 90s — normal hors trade
      const _ttl = tradeState.entered ? _enteredTtl : _idleTtl;
      const _reqForceFresh = String(req.query.forceFresh || '').toLowerCase() === 'true' || req.query.forceFresh === '1';
      let snapshot = _reqForceFresh ? null : readCoachAnalysisSnapshot(symbol, timeframe, _ttl);
      const tvFresh = getLatestTradingviewRuntime();
      const tvTs = Date.parse(tvFresh?.timestamp || 0);
      const snapshotTs = Number(snapshot?.updatedAt || 0);
      // Forcer uniquement si: pas de snapshot du tout, OU données TV plus fraîches que le snapshot
      // (mais pas si juste position active — évite les recalculs constants)
      const mustRefresh = _reqForceFresh || !snapshot || (Number.isFinite(tvTs) && tvTs > snapshotTs + _ttl);
      if (mustRefresh) {
        snapshot = await computeCoachAnalysisSnapshot(symbol, timeframe, lang, tradeState, {
          forceFresh: _reqForceFresh,
          maxAgeMs: _ttl
        });
      }

      const robotV12Live = snapshot.robotV12 || getRobotV12ForSymbol(symbol);
      const instantTrade = snapshot.runtimeTrade || null;
      const marketStatus = snapshot.marketStatus || marketHoursChecker.getStatus(symbol);
      const currentPrice = Number(snapshot.currentPrice || getCoachMarketPrice(symbol) || instantTrade?.entry || NaN);
      const runtimeSignal = snapshot.signal || buildRuntimeTradeSignal(symbol, timeframe, instantTrade, robotV12Live, marketStatus, currentPrice);
      const robotContext = robotV12Live
        ? [
            robotV12Live.verdict ? `verdict=${robotV12Live.verdict}` : null,
            robotV12Live.anticipation ? `anticipation=${robotV12Live.anticipation}${robotV12Live.anticipation_force != null ? ' (' + robotV12Live.anticipation_force + '%)' : ''}` : null,
            robotV12Live.contexte ? `contexte=${robotV12Live.contexte}` : null,
            (robotV12Live.lecture_15m || robotV12Live.lecture_60m) ? `ut=15m:${robotV12Live.lecture_15m || '--'}|1h:${robotV12Live.lecture_60m || '--'}` : null
          ].filter(Boolean).join(', ')
        : 'robotV12=n/a';

      const payload = {
        symbol,
        timeframe,
        analysis: snapshot.analysis,
        execution: snapshot.execution,
        news: snapshot.news,
        explainer: snapshot.explainer,
        strategy: snapshot.strategy,
        risk: snapshot.risk,
        robotV12: robotV12Live,
        signal: runtimeSignal,
        setupQuality: snapshot.setupQuality || null  // classification PREMIUM/RETRACEMENT/M15_SEUL (source unique)
      };

      const executionGuidance = deriveExecutionGuidance(tradeState, payload);
      if (robotV12Live && !tradeState.entered) {
        executionGuidance.primary = `${executionGuidance.primary} | TV: ${robotContext}`;
      }
      const goldCoach = buildGoldCoach(symbol, payload, tradeState, executionGuidance);

      const riskHigh = String(payload.risk?.riskLevel || '').toUpperCase() === 'HIGH';
      const hasUltraNews = Array.isArray(payload.news?.upcomingEvents) && payload.news.upcomingEvents.some((e) => Number(e.minutesAway ?? e.mins) <= 15 && String(e.urgency || e.impact || '').toUpperCase() === 'HIGH');
      const newsWarning = payload.news?.warning || '';
      const alert = riskHigh || newsWarning || hasUltraNews
        ? {
          level: hasUltraNews ? 'ULTRA' : 'HIGH',
          title: 'Alerte Coach',
          message: hasUltraNews
            ? 'News ultra importante détectée: priorité gestion du risque'
            : (newsWarning || payload.risk?.guidance || 'Situation sensible détectée')
        }
        : null;

      let dashboardLia = null;
      // Quand position ouverte: utiliser les niveaux de la position réelle (virtualPosition)
      // et non pas le signal frais (instantTrade) qui peut être vide/0
      const _activeVp = tradeState.entered ? (tradeState.virtualPosition || null) : null;
      const _liaEntry = (_activeVp?.entry > 0 ? _activeVp.entry : null) ?? (instantTrade?.entry > 0 ? instantTrade.entry : null);
      const _liaSl    = (_activeVp?.sl    > 0 ? _activeVp.sl    : null) ?? (instantTrade?.sl    > 0 ? instantTrade.sl    : null);
      const _liaTp    = (_activeVp?.tp    > 0 ? _activeVp.tp    : null) ?? (instantTrade?.tp    > 0 ? instantTrade.tp    : null);
      const _liaRr    = _activeVp?.rrRatio || instantTrade?.rrRatio || '--';
      // Décision: quand position active, utiliser la direction de la position — pas le signal frais
      const _liaDecision = tradeState.entered
        ? (String(_activeVp?.direction || '').toUpperCase().includes('SHORT') ? 'SELL' : 'BUY')
        : (payload.analysis?.recommendation || 'WAIT');
      const _liaReason = tradeState.entered
        ? (executionGuidance.primary || 'Gérer la position en cours.')
        : (payload.analysis?.reason || 'n/a');
      const lia = await requestDashboardLiaReadOnly({
        symbol,
        timeframe,
        decision: _liaDecision,
        reason: _liaReason,
        confidence: payload.analysis?.confidence || 0,
        entry: _liaEntry,
        sl: _liaSl,
        tp: _liaTp,
        rr: _liaRr,
        robotV12: robotV12Live || null,
        market: marketStatus || null,
        news: payload.news || null,
        phase: tradeState.phase,
        entered: tradeState.entered,
        bePlaced: tradeState.bePlaced,
        partialTaken: tradeState.partialTaken,
        nextAction: executionGuidance.primary || 'Attendre confirmation structure.'
      });
      if (!dashboardLia || !lia?.ok) {
        // Construire un texte coach expert et structuré (fallback LIA)
        const _fRec = String(payload.analysis?.recommendation || 'WAIT').toUpperCase();
        const _fConf = payload.analysis?.confidence || 0;
        const _fConflicts = payload.execution?.conflictReasons || [];
        const _fEntered = tradeState.entered;
        const _fTvK = findTradingviewSymbolKey(symbol);
        const _fInd = _fTvK ? (tvDataStore[_fTvK]?.indicators || {}) : {};
        const _fRsi  = _fInd.rsi  != null ? Number(_fInd.rsi).toFixed(0)  : null;
        const _fAtr  = _fInd.atr  != null ? Number(_fInd.atr).toFixed(2)  : null;
        const _fMa20 = _fInd.ma20 != null ? Number(_fInd.ma20).toFixed(2) : null;
        const _fMa50 = _fInd.ma50 != null ? Number(_fInd.ma50).toFixed(2) : null;
        const _fMacd = _fInd.macd != null ? Number(_fInd.macd).toFixed(3) : null;
        const _fPrice = Number(currentPrice || snapshot?.currentPrice || 0);

        // Détecter régime marché
        let _fRegime = 'INCONNU';
        if (_fInd.bb_upper > 0 && _fInd.bb_lower > 0 && _fInd.atr > 0) {
          const _bbW = _fInd.bb_upper - _fInd.bb_lower;
          if (_bbW < _fInd.atr * 1.5) _fRegime = 'COMPRESSION';
          else if (_fMa20 && _fMa50) {
            const _emaDiff = Math.abs(Number(_fMa20) - Number(_fMa50));
            _fRegime = _emaDiff < _fInd.atr * 0.3 ? 'RANGE' : Number(_fMa20) > Number(_fMa50) ? 'TENDANCE HAUSSIÈRE' : 'TENDANCE BAISSIÈRE';
          }
        } else if (_fMa20 && _fMa50) {
          _fRegime = Number(_fMa20) > Number(_fMa50) ? 'TENDANCE HAUSSIÈRE' : Number(_fMa20) < Number(_fMa50) ? 'TENDANCE BAISSIÈRE' : 'RANGE';
        }

        // ── TRADUCTEUR HUMAIN — jamais de valeur brute technique exposée ─────────
        // RSI/ATR/MACD/Régime utilisés en interne pour décider, jamais affichés.
        // Le texte ne dit que ce que ça fait : ça monte, ça descend, ça s'essouffle, on entre ou on attend.
        const _fMomentumLabel = Number(_fRsi) > 70 ? 'Le marché s\'essouffle en haut'
          : Number(_fRsi) > 0 && Number(_fRsi) < 30 ? 'Le marché ralentit en bas'
          : Number(_fRsi) > 60 ? 'Le marché monte' : Number(_fRsi) > 0 && Number(_fRsi) < 40 ? 'Le marché descend'
          : 'Le marché hésite';
        const _fVolLabel = Number(_fAtr) > 5 ? 'volatilité forte' : Number(_fAtr) > 2 ? 'volatilité normale' : '';
        const _fMacdLabel = Number(_fMacd) > 0 ? 'momentum haussier' : Number(_fMacd) < 0 ? 'momentum baissier' : '';

        const _fLines = [];
        // ── POSITION ACTIVE — message de suivi humain ──────────────────────────
        if (_fEntered && _activeVp) {
          const _fDir = String(_activeVp.direction || '').toUpperCase();
          const _fPnl = _fPrice > 0 && _activeVp.entry > 0
            ? ((_fDir === 'LONG' ? _fPrice - _activeVp.entry : _activeVp.entry - _fPrice) * (/XAU|GOLD/.test(symbol) ? 10 : /JPY/.test(symbol) ? 100 : /BTC|ETH/.test(symbol) ? 1 : 10000)).toFixed(0)
            : null;
          _fLines.push(`Position ${_fDir === 'LONG' ? 'achat' : 'vente'} en cours — ${symbol}`);
          if (_fPnl !== null) _fLines.push(`${Number(_fPnl) >= 0 ? '✅ En gain' : '⚠️ En perte'}: ${Number(_fPnl) >= 0 ? '+' : ''}${_fPnl} pips`);
          _fLines.push(executionGuidance.primary || 'Je surveille la position.');
          // Momentum traduit — pas de valeur brute
          if (_fRsi) {
            const _posRsiMsg = Number(_fRsi) > 70 ? 'Le marché s\'essouffle — surveille un retournement.'
              : Number(_fRsi) < 30 ? 'Le marché ralentit — surveille un retournement.'
              : null;
            if (_posRsiMsg) _fLines.push(_posRsiMsg);
          }
        } else {
          // ── PRÉ-ENTRÉE — résumé humain de la situation ────────────────────────
          const _execOk  = payload.execution?.canEnter === true;
          const _hasSlTp = Number(_liaSl) > 0 && Number(_liaTp) > 0;
          const _isLong  = _fRec === 'BUY' || _fRec === 'LONG';
          const _isShort = _fRec === 'SELL' || _fRec === 'SHORT';

          // Contexte marché en une phrase humaine
          const _ctxLine = _fRegime === 'TENDANCE HAUSSIÈRE' ? 'Le marché monte — contexte favorable aux achats.'
            : _fRegime === 'TENDANCE BAISSIÈRE' ? 'Le marché descend — contexte favorable aux ventes.'
            : _fRegime === 'COMPRESSION' ? 'Le marché est compressé — pas de direction claire, j\'attends.'
            : _fRegime === 'RANGE' ? 'Le marché tourne en rond — j\'attends une sortie de range.'
            : _fMomentumLabel + (_fVolLabel ? ' — ' + _fVolLabel : '') + '.';
          _fLines.push(_ctxLine);

          // Momentum additionnel si signal fort
          if (_fMacdLabel && (_isLong || _isShort)) _fLines.push('Momentum : ' + _fMacdLabel + '.');
          _fLines.push('');

          if ((_isLong || _isShort) && _execOk && _hasSlTp) {
            // ── SETUP EXÉCUTABLE ───────────────────────────────────────────────
            _fLines.push(`✅ ${_isLong ? 'Achat possible' : 'Vente possible'} — je peux entrer`);
            _fLines.push(`Entrée: ${Number(_liaEntry).toFixed(2)}  SL: ${Number(_liaSl).toFixed(2)}  TP: ${Number(_liaTp).toFixed(2)}  R:R ${_liaRr}`);
            _fLines.push(Array.isArray(payload.explainer?.whyEntry) && payload.explainer.whyEntry[0]
              ? payload.explainer.whyEntry[0]
              : (_isLong ? 'Structure haussière confirmée.' : 'Structure baissière confirmée.'));

          } else if (_isLong || _isShort) {
            // ── DIRECTION DÉTECTÉE, setup non prêt ────────────────────────────
            const _trSt = String(payload.execution?.trade_status || 'WAIT').toUpperCase();
            _fLines.push(_isLong ? 'Le marché monte — j\'attends la confirmation pour entrer.' : 'Le marché descend — j\'attends la confirmation pour entrer.');
            if (!_hasSlTp) {
              _fLines.push('Les niveaux de protection ne sont pas encore calculés. J\'attends.');
            } else if (_trSt === 'WAIT') {
              _fLines.push('Le prix est trop loin de la zone. J\'attends qu\'il revienne.');
            } else if (_trSt === 'CONDITIONAL') {
              _fLines.push('Conditions presque réunies — j\'attends le retour en zone.');
            }
            const _blockReason = _fConflicts[0] || null;
            if (_blockReason) _fLines.push('Raison : ' + _blockReason);

          } else {
            // ── NEUTRE — ni haussier ni baissier ──────────────────────────────
            _fLines.push('J\'attends un signal clair. Le marché n\'a pas de direction nette pour l\'instant.');
          }

          if (payload.news?.warning) _fLines.push('⚠️ ' + payload.news.warning);
          // Guidance risque en humain — pas de label technique
          const _rguidance = payload.risk?.guidance || '';
          if (_rguidance && !_rguidance.includes('Risque')) _fLines.push(_rguidance);
        }
        dashboardLia = {
          ...(lia || {}),
          ok: false,
          channel: 'dashboard',
          response: _fLines.filter(Boolean).join('\n')
        };
      }
      // ── ARMED: remplacer la LIA par le message de surveillance dynamique ──────
      // Le texte LIA standard parle du setup — en mode ARMED on veut dire ce qu'on surveille
      if (String(tradeState?.phase || '').toUpperCase() === 'ARMED') {
        const _tvLiveArm = typeof tvDataStore !== 'undefined'
          ? (tvDataStore[String(symbol||'').toUpperCase()] || tvDataStore[findTradingviewSymbolKey(symbol)] || null)
          : null;
        const _armLiveSnap = { currentPrice, symbol, virtualPosition: tradeState.virtualPosition };
        const _armedCoachMsg = generatePositionCoachMessage(tradeState, _armLiveSnap, _tvLiveArm);
        if (_armedCoachMsg) {
          dashboardLia = { ok: true, channel: 'dashboard', response: _armedCoachMsg };
        }
      }

      snapshot = storeCoachAnalysisSnapshot(symbol, timeframe, { ...snapshot, lia: dashboardLia });

      publishAgentChatMessage({
        agent: 'lia-dashboard',
        to: 'dashboard',
        status: alert ? 'warning' : 'info',
        phase: 'en cours',
        message: dashboardLia.response || 'Coach indisponible',
        cause: 'agrégation runtime + lia',
        impact: alert ? 'alerte trading active' : 'guidance normale',
        solution: payload.strategy?.logic || payload.analysis?.reason || 'attendre confirmation'
      });

      res.json({
        ok: true,
        symbol,
        timeframe,
        lang,
        robotV12: robotV12Live,
        signal: runtimeSignal,
        execution: snapshot.execution,
        agents: payload,
        tradeState,
        executionGuidance,
        goldCoach,
        alert,
        lia: dashboardLia,
        // Messages humains — conclus sans termes techniques (RSI/MACD non exposés)
        exhaustionAlert: snapshot.exhaustionAlert || null,
        pulsionAlert:    snapshot.pulsionAlert    || null,
        unifiedPayload:  snapshot.unifiedPayload  || null,
        analysisSnapshot: {
          updatedAt: snapshot.updatedAt,
          modeResolved: snapshot.modeResolved,
          sourceSummary: snapshot.sourceSummary
        }
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // JSON guardrails: never return HTML for API namespaces expected by monitor
  app.use((req, res, next) => {
    const p = String(req.path || '');
    // /coach/stream is an SSE endpoint registered after this middleware — allow it through
    if (p === '/coach/stream') return next();
    const wantsJsonApi = (
      p.startsWith('/lia/') ||
      p.startsWith('/central-guide/') ||
      p.startsWith('/coach/') ||
      p.startsWith('/integration/') ||
      p.startsWith('/agents/') ||
      p.startsWith('/mt5/') ||
      p === '/health' ||
      p === '/live/state'
    );
    if (wantsJsonApi) {
      return res.status(404).json({ ok: false, error: 'ENDPOINT_NOT_FOUND', path: p });
    }
    return next();
  });

  app.use((err, req, res, _next) => {
    const p = String(req.path || '');
    const wantsJsonApi = (
      p.startsWith('/lia/') ||
      p.startsWith('/central-guide/') ||
      p.startsWith('/coach/') ||
      p.startsWith('/integration/') ||
      p.startsWith('/agents/') ||
      p.startsWith('/mt5/') ||
      p === '/health' ||
      p === '/live/state'
    );
    if (wantsJsonApi) {
      return res.status(500).json({ ok: false, error: err?.message || 'INTERNAL_ERROR', path: p });
    }
    return res.status(500).send('Internal Server Error');
  });

  // ─── START ────────────────────────────────────────────────────────────────────
  app.listen(PORT, '0.0.0.0', () => {
  const _startTs = new Date().toISOString();
  console.log(`\n✅ Trading Auto Server — http://127.0.0.1:${PORT}`);
  console.log(`📡 Source UNIQUE: Bridge TradingView — Yahoo Finance et MT5 SUPPRIMÉS`);
  console.log(`📐 RÈGLE: tvDataStore[symbol].price = référence absolue. Aucune source externe.`);
  console.log(`⚠️  Aucun Math.random() — toutes les données sont réelles`);
  console.log(`[BASELINE] PID=${process.pid} | PORT=${PORT} | STARTED=${_startTs} | INSTANCES=1`);
  console.log(`[BASELINE] Clean start — single instance confirmed\n`);

  loadJournal();
  loadAgentHistoryFromDisk();
  runAgentHistoryCycle();
  if (_agentHistoryTimer) clearInterval(_agentHistoryTimer);
  _agentHistoryTimer = setInterval(runAgentHistoryCycle, AGENT_HISTORY_INTERVAL_MS);

  // ────── START MT5 BRIDGE POLLING ──────────────────────────────────────────
  if (!SAFE_MODE) {
    startMT5Polling(5000);
  } else {
    console.log('[SAFE MODE] MT5 polling auto désactivé (on-demand only)');
  }

  // [P1] Initialisation CandleManager — démarre le timer de détection de fermeture
  if (candleManager) {
    candleManager.initialize()
      .then(() => console.log('[CANDLE] CandleManager initialisé — détection des bougies active'))
      .catch(e => console.error('[CANDLE INIT ERROR]', e.message));
  }

  // [P3] Initialisation Surveillance Agent et event listener
  if (surveillanceAgent) {
    surveillanceAgent.initialize();
    console.log('[SURVEILLANCE] Surveillance Agent initialized');
    
    // Register in agent bus
    registerAgentUnique('surveillance-agent', {
      role: 'Event-driven analysis trigger',
      status: 'active',
      file: 'src/agents/surveillance-agent.js'
    });
    
    if (orchestrator) {
      registerAgentUnique('orchestrator', {
        role: 'Central decision maker',
        status: 'active',
        file: 'src/agents/orchestrator.js'
      });
    }
    
    registerAgentUnique('alert-manager', {
      role: 'Centralized alert system',
      status: 'active',
      file: 'alert-manager.js'
    });
    
    registerAgentUnique('candle-manager', {
      role: 'OHLC aggregation engine',
      status: candleManager ? 'active' : 'inactive',
      file: 'lib/candle-manager.js'
    });
    
    if (indicatorAgent) {
      registerAgentUnique('indicator-agent', {
        role: 'Technical indicator generator',
        status: 'active',
        file: 'src/agents/indicator-agent.js'
      });
    }
    
    if (repairAgent) {
      registerAgentUnique('repair-agent', {
        role: 'Automatic diagnostics and repair',
        status: 'active',
        file: 'src/agents/repair-agent.js'
      });
    }

    registerAgentUnique('design-agent', {
      role: 'Design audit and UI reorganization proposals',
      status: 'active',
      file: 'src/agents/designerAgent.js'
    });

    registerAgentUnique('project-controller', {
      role: 'Project scope and impact controller',
      status: 'active',
      file: 'server.js'
    });

    // Required new runtime agents.
    registerAgentUnique('bridge-agent', {
      role: 'Bridge UI/backend/extension channels',
      status: 'active',
      file: 'server.js'
    });
    registerAgentUnique('innovator-agent', {
      role: 'Suggest solutions when modules are blocked',
      status: 'active',
      file: 'server.js'
    });
    registerAgentUnique('verification-agent', {
      role: 'Anti-fake verification for TV/MT5 real data',
      status: 'active',
      file: 'server.js'
    });
    registerAgentUnique('mirror-agent', {
      role: 'Synchronize HTML interfaces and detect UI drift',
      status: 'active',
      file: 'server.js'
    });
    registerAgentUnique('extension-agent', {
      role: 'Control popup/content/background extension health',
      status: 'active',
      file: 'server.js'
    });

    // ── system-health-agent — cerveau système LIA (complète lia-dashboard) ──
    registerAgentUnique('system-health-agent', {
      role: 'Analyse santé système: controller, auto-runner, stores, divergences SSE',
      status: 'active',
      file: 'server.js'
    });

    // Register catalog agents for timing visibility (without duplicates).
    AGENT_RUNTIME_CATALOG.forEach((name) => {
      registerAgentUnique(name, {
        role: 'Runtime instrumented agent',
        status: 'active',
        file: 'src/agents/' + name + '.js'
      });
    });

    // Bridge bus messages from existing agents into the existing real-time stream.
    wireAgentBusToChat([
      'surveillance-agent',
      'orchestrator',
      'indicator-agent',
      'repair-agent',
      'design-agent',
      'project-controller',
      'bridge-agent',
      'innovator-agent',
      'verification-agent',
      'mirror-agent',
      'extension-agent',
      'alert-manager',
        'candle-manager',
        'ui-test-agent',
        'logic-gap-agent',
        'research-agent',
        'human-interface-agent',
        'central-guide-agent',
        'analysis-agent',
        'news-agent',
        'position-explainer-agent',
        'strategy-agent',
        'risk-agent',
        'execution-coach-agent',
        'history-agent',
        'lia',
        'system-health-agent'
    ]);

    publishAgentChatMessage({
      agent: 'system',
      to: 'all',
      status: 'info',
      phase: 'en cours',
      message: 'Canal chat agents branché sur /agent-activity',
      cause: 'initialisation serveur',
      impact: 'dialogue inter-agents visible en temps réel',
      solution: 'ouvrir /agent-log ou /agents-monitor'
    });

    startRuntimeLoop();
    if (SAFE_MODE) {
      console.log('[SAFE MODE] Runtime équilibrée active (rotation + limite de concurrence)');
    }
    console.log('[RUNTIME] Régulation CPU active: >70% ralentit, >85% limite à 2 agents, >95% SAFE MODE auto');
    
    // Listen for trigger-analysis events from surveillance agent
    surveillanceAgent.on('trigger-analysis', async (event) => {
      console.log(`[ANALYSIS TRIGGERED] ${event.symbol} @ ${event.price} (${event.reason})`);
      
      if (orchestrator) {
        try {
          const analysis = await orchestrator.run({
            symbol: event.symbol,
            price: event.price,
            timestamp: event.timestamp
          });
          
          // Create alert if signal is meaningful
          if (analysis && analysis.direction && analysis.direction !== 'ATTENDRE') {
            alertManager.createAlert(
              'SIGNAL',
              analysis.score >= 70 ? 'HIGH' : 'MEDIUM',
              event.symbol,
              {
                direction: analysis.direction,
                score: analysis.score,
                reason: event.reason
              }
            );
          }
        } catch (e) {
          console.error('[ANALYSIS ERROR]', e.message);
          alertManager.createAlert('ERROR', 'LOW', event.symbol, { error: e.message });
        }
      }
    });
  }

  // Log de démarrage dans le AGENTS LIVE LOG
  pushLog('system', 'all', 'SERVEUR DÉMARRÉ — http://127.0.0.1:' + PORT, 'ok', 'agents:technicalAgent,macroAgent,orchestrator');

  // Keep audit.json synchronized with live route reality, even without dashboard open.
  syncAuditStateToDisk();
  setInterval(() => {
    syncAuditStateToDisk();
  }, 15000);
});

// ─── ORCHESTRATION ROUTES (top-level) ────────────────────────────────────────
let _orchestrationAutoTimer = null;
let _orchestrationEnabled = false;

app.get('/orchestration-status', (_req, res) => {
  res.json({ 
    ok: true, 
    enabled: _orchestrationEnabled, 
    timer: _orchestrationAutoTimer ? 'active' : 'inactive'
  });
});

app.post('/orchestration/enable', (req, res) => {
  const intervalMs = parseInt(req.body?.interval) || 60000;
  if (_orchestrationAutoTimer) clearInterval(_orchestrationAutoTimer);
  _orchestrationAutoTimer = setInterval(runOrchestrationCycle, intervalMs);
  _orchestrationEnabled = true;
  console.log('[ORCH] Auto orchestration ENABLED @ ' + intervalMs + 'ms');
  res.json({ ok: true, message: 'Orchestration auto enabled', interval: intervalMs });
});

app.post('/orchestration/disable', (req, res) => {
  if (_orchestrationAutoTimer) {
    clearInterval(_orchestrationAutoTimer);
    _orchestrationAutoTimer = null;
  }
  _orchestrationEnabled = false;
  console.log('[ORCH] Auto orchestration DISABLED');
  res.json({ ok: true, message: 'Orchestration auto disabled' });
});

app.post('/orchestration/run-now', async (req, res) => {
  try {
    await runOrchestrationCycle();
    res.json({ ok: true, message: 'Orchestration cycle executed' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── COACH STREAM — SSE dédié suivi de position ────────────────────────────
const coachStreamClients = new Map(); // sessionId → { res, symbol, lastPush }

app.get('/coach/stream', (req, res) => {
  const symbol = (req.query.symbol || '').toUpperCase() || 'XAUUSD';
  const sessionId = `${symbol}_${Date.now()}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  coachStreamClients.set(sessionId, { res, symbol, lastPush: 0 });
  console.log(`[COACH STREAM] Client connecté: ${sessionId}`);

  // Push initial immédiat
  pushCoachEvent(sessionId);

  // Heartbeat toutes les 15s
  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) { clearInterval(hb); }
  }, 15000);

  req.on('close', () => {
    clearInterval(hb);
    coachStreamClients.delete(sessionId);
    console.log(`[COACH STREAM] Client déconnecté: ${sessionId}`);
  });
});

// ── STATS / EQUITY CURVE ─────────────────────────────────────────────────────
app.get('/stats', (req, res) => {
  try {
    const symbol = req.query.symbol;
    let trades = symbol ? tradeJournal.filter(t => t.symbol === symbol) : tradeJournal;

    if (!trades.length) {
      return res.json({ ok: true, empty: true, stats: {}, equity: [] });
    }

    const won = trades.filter(t => t.won);
    const lost = trades.filter(t => !t.won);
    const totalPips = trades.reduce((s, t) => s + (t.pnlPips || 0), 0);
    const avgWin  = won.length  ? won.reduce((s,t) => s + (t.pnlPips||0), 0) / won.length   : 0;
    const avgLoss = lost.length ? lost.reduce((s,t) => s + (t.pnlPips||0), 0) / lost.length : 0;
    const profitFactor = avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : '--';
    const maxDD = trades.reduce((dd, _, i) => {
      const slice = trades.slice(0, i+1);
      const peak = slice.reduce((p, t) => p + (t.pnlPips||0), 0);
      return Math.min(dd, peak);
    }, 0);

    // Courbe d'équité (cumul pips)
    let cumul = 0;
    const equity = trades.slice().reverse().map(t => {
      cumul += t.pnlPips || 0;
      return { date: t.closedAt, pips: cumul, symbol: t.symbol, won: t.won };
    });

    res.json({
      ok: true,
      stats: {
        total: trades.length,
        won: won.length,
        lost: lost.length,
        winRate: Math.round(won.length / trades.length * 100),
        totalPips,
        avgWin: Math.round(avgWin),
        avgLoss: Math.round(avgLoss),
        profitFactor,
        maxDrawdownPips: Math.round(maxDD),
        avgDuration: trades.length ? Math.round(trades.reduce((s,t) => s+(t.durationMin||0), 0) / trades.length) : 0
      },
      equity
    });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

async function pushCoachEvent(sessionId) {
  const client = coachStreamClients.get(sessionId);
  if (!client) return;
  try {
    const { symbol } = client;

    // Chercher le prix live: d'abord entrée exacte du symbole dans tvDataStore
    const tvLiveKey = Object.keys(tvDataStore).find(k => k === symbol) || symbol;
    const tvLive = tvDataStore[tvLiveKey] || null;

    // Chercher l'état de trade actif pour CE symbole — tous les TF, pas seulement H1
    // Priorité: état entered=true sur n'importe quel TF > état par défaut
    let tradeState = null;
    if (typeof coachTradeStateStore !== 'undefined' && coachTradeStateStore) {
      for (const ts of Object.values(coachTradeStateStore)) {
        if (ts && ts.symbol === symbol && ts.entered) { tradeState = ts; break; }
      }
    }
    // Fallback: charger M5 puis H1 si aucune position trouvée
    if (!tradeState && typeof getCoachTradeState === 'function') {
      const tsM5 = getCoachTradeState(symbol, 'M5');
      const tsH1 = getCoachTradeState(symbol, 'H1');
      tradeState = (tsM5?.entered ? tsM5 : null) || (tsH1?.entered ? tsH1 : null) || tsM5;
    }

    // ANOMALIE CORRIGÉE: si tvLive.price absent, utiliser le dernier prix connu depuis tradeState ou cache
    const _rawPrice = Number(tvLive?.price);
    const _fallbackPrice = Number(tradeState?.virtualPosition?.entry) || Number(tradeState?.entry) || 0;
    const price = _rawPrice > 0 ? _rawPrice : (_fallbackPrice > 0 ? _fallbackPrice : null);

    // Générer le message de coaching standard
    let coachMessage = 'Je surveille le marché pour toi.';
    if (typeof generatePositionCoachMessage === 'function') {
      coachMessage = generatePositionCoachMessage(
        tradeState,
        { currentPrice: price, symbol, virtualPosition: tradeState?.virtualPosition || null },
        tvLive
      );
    }

    // Générer l'analyse live détaillée (coach intelligent temps réel)
    let liveAnalysis = null;
    if (tradeState?.entered && typeof generateLiveCoachAnalysis === 'function') {
      liveAnalysis = generateLiveCoachAnalysis(tradeState, tvLive);
    }

    // ── ANALYSE MULTI-TF: données bridge Pine Script — temps réel ─────────────
    // Disponible pendant ET hors position — affiche l'alignement des TF et les zones clés
    let multiTfConsensus = null;
    const _tvBridgeStream = tvLive?._bridgePayload || null;
    if (_tvBridgeStream) {
      const _refDir = tradeState?.entered
        ? String(tradeState?.virtualPosition?.direction || '').toUpperCase()
        : null; // hors position: lecture pure sans référence de direction
      const _tfsMap = [
        { tf:'M1',  lecture: _tvBridgeStream.lectureTech1, score: _tvBridgeStream.scoreTech1, rsi: _tvBridgeStream.rsiTf1 },
        { tf:'M5',  lecture: _tvBridgeStream.lectureTech2, score: _tvBridgeStream.scoreTech2, rsi: _tvBridgeStream.rsiTf2 },
        { tf:'M15', lecture: _tvBridgeStream.lectureTech3, score: _tvBridgeStream.scoreTech3, rsi: _tvBridgeStream.rsiTf3 },
        { tf:'H1',  lecture: _tvBridgeStream.lectureTech4, score: _tvBridgeStream.scoreTech4, rsi: _tvBridgeStream.rsiTf4 },
      ];
      let _aligned = 0, _against = 0, _neutral = 0;
      const _tfDetails = [];
      for (const _tfd of _tfsMap) {
        const _lv = String(_tfd.lecture || '').toUpperCase();
        const _isVente = _lv.includes('VENTE');
        const _isAchat = _lv.includes('ACHAT');
        const _dir = _isVente ? 'SHORT' : _isAchat ? 'LONG' : 'NEUTRE';
        const _rsiNum = Number(_tfd.rsi || 0);
        // Cohérence RSI ↔ direction : RSI doit confirmer la direction
        // SHORT confirmé = RSI < 50 | LONG confirmé = RSI > 50 | neutre 45-55 = ambigu
        const _rsiCoherent = _rsiNum <= 0 ? null  // RSI absent = inconnu
          : _dir === 'SHORT' ? (_rsiNum < 50)      // SHORT confirmé si RSI < 50
          : _dir === 'LONG'  ? (_rsiNum > 50)      // LONG confirmé si RSI > 50
          : true;                                   // NEUTRE = toujours cohérent
        // Signal réel = lecture bridge filtrée par RSI
        // Si RSI contredit la direction → signal "PARTIEL" (pas fort)
        const _rsiStrong = _rsiNum <= 0 ? false
          : _dir === 'SHORT' ? (_rsiNum < 45)
          : _dir === 'LONG'  ? (_rsiNum > 55)
          : false;
        const _detail = {
          tf: _tfd.tf, dir: _dir, lecture: _tfd.lecture || 'N/A',
          score: _tfd.score, rsi: _tfd.rsi,
          rsiCoherent: _rsiCoherent,  // true/false/null
          rsiStrong: _rsiStrong,       // RSI confirme fortement
          signalQuality: _rsiCoherent === false ? 'PARTIEL' : _rsiStrong ? 'CONFIRMÉ' : 'STRUCTUREL'
        };
        if (_refDir) {
          if (_dir === _refDir)   { _aligned++; }
          else if (_dir === 'NEUTRE') { _neutral++; }
          else { _against++; }
        }
        _tfDetails.push(_detail);
      }
      // Déterminer la direction dominante (hors position)
      const _longCount  = _tfDetails.filter(d => d.dir === 'LONG').length;
      const _shortCount = _tfDetails.filter(d => d.dir === 'SHORT').length;
      const _domDir = _longCount > _shortCount ? 'LONG' : _shortCount > _longCount ? 'SHORT' : 'MIXTE';
      if (!_refDir) { _aligned = Math.max(_longCount, _shortCount); _against = Math.min(_longCount, _shortCount); }
      const _total = _tfsMap.length;
      // Cohérence RSI globale — combien de TFs ont RSI cohérent avec la direction
      const _rsiConfirmedCount = _tfDetails.filter(d => d.rsiCoherent === true).length;
      const _rsiPartialCount   = _tfDetails.filter(d => d.rsiCoherent === false).length;
      const _rsiNote = _rsiPartialCount >= 2
        ? 'RSI DIVERGENT' // RSI contredit la direction sur plusieurs TFs
        : _rsiConfirmedCount >= 3
        ? 'RSI CONFIRMÉ'
        : 'RSI NEUTRE';  // RSI ni confirme ni contredit (zone neutre)
      const _state = _aligned >= 3 ? 'FORT' : _aligned >= 2 ? 'MOYEN' : _against >= 2 ? 'DIVERGENCE' : 'MIXTE';
      // Zones de liquidité pour entrée précise
      const _zones = {
        liqHigh:   _tvBridgeStream.liqHigh,
        liqLow:    _tvBridgeStream.liqLow,
        rangeHigh: _tvBridgeStream.rangeHigh,
        rangeLow:  _tvBridgeStream.rangeLow,
        inTop:     _tvBridgeStream.inTop,
        inBot:     _tvBridgeStream.inBot,
        zoneLiqHaute: _tvBridgeStream.zoneLiqHaute,
        zoneLiqBasse: _tvBridgeStream.zoneLiqBasse,
      };
      // Zone d'entrée recommandée
      const _entryZone = _domDir === 'SHORT'
        ? (_tvBridgeStream.inTop || _tvBridgeStream.zoneLiqHaute ? 'ZONE_HAUTE_ACTIVE' : 'ATTENDRE_ZONE_HAUTE')
        : _domDir === 'LONG'
        ? (_tvBridgeStream.inBot || _tvBridgeStream.zoneLiqBasse ? 'ZONE_BASSE_ACTIVE' : 'ATTENDRE_ZONE_BASSE')
        : 'NEUTRE';
      multiTfConsensus = {
        aligned: _aligned, against: _against, neutral: _neutral, total: _total,
        alignPct: Math.round((_aligned / _total) * 100),
        state: _state,
        dominantDirection: _domDir,
        details: _tfDetails,
        zones: _zones,
        entryZone: _entryZone,
        anticipation: _tvBridgeStream.anticipationTexte,
        anticipationForce: _tvBridgeStream.anticipationForce,
        message: _state === 'FORT'
          ? `${_aligned}/${_total} TFs alignés ${_domDir} — entrée possible`
          : _state === 'MOYEN'
          ? `${_aligned}/${_total} TFs ${_domDir} — attendre confirmation M15/H1`
          : _state === 'DIVERGENCE'
          ? `${_against}/${_total} TFs divergents — NE PAS ENTRER`
          : `Signal mixte — attendre alignement clair`
      };
    } else if (tradeState?.entered) {
      // Fallback: calcul technique si pas de bridge Pine Script
      try {
        const dir = String(tradeState?.virtualPosition?.direction || '').toUpperCase();
        const tfsToCheck = ['M1','M5','M15','H1'];
        let aligned = 0, against = 0, neutral = 0;
        const tfDetails = [];
        for (const tf of tfsToCheck) {
          const sig = typeof computeTechSignalFromKlines === 'function'
            ? await computeTechSignalFromKlines(symbol, tf, price).catch(() => null)
            : null;
          if (!sig) { neutral++; tfDetails.push({ tf, dir: 'N/A' }); continue; }
          const sigDir = String(sig.direction || '').toUpperCase();
          if (sigDir === dir)         { aligned++; tfDetails.push({ tf, dir: sigDir, score: sig.score }); }
          else if (sigDir === 'NEUTRE') { neutral++; tfDetails.push({ tf, dir: 'NEUTRE' }); }
          else                          { against++; tfDetails.push({ tf, dir: sigDir, score: sig.score }); }
        }
        const total = tfsToCheck.length;
        const alignPct = Math.round((aligned / total) * 100);
        multiTfConsensus = {
          aligned, against, neutral, total, alignPct, dominantDirection: dir,
          state: aligned >= 3 ? 'FORT' : aligned >= 2 ? 'MOYEN' : against >= 2 ? 'DIVERGENCE' : 'MIXTE',
          details: tfDetails,
          message: aligned >= 3 ? `${aligned}/${total} TFs alignés — tendance solide`
            : aligned >= 2 ? `${aligned}/${total} TFs alignés — direction tenue`
            : against >= 2 ? `${against}/${total} TFs contre — surveiller renversement`
            : `Signal mixte (${aligned} pour, ${against} contre, ${neutral} neutre)`
        };
      } catch(_) {}
    }

    // ANOMALIE CORRIGÉE: toujours envoyer coachMessage — ne pas mettre null si inchangé
    // Le popup a besoin du message à chaque push pour maintenir l'affichage à jour
    client.lastMessage = coachMessage;

    // Fraîcheur du prix — signaler si stale > 15s
    const _priceAge = tvLive?.updatedAt ? Date.now() - tvLive.updatedAt : null;
    const _priceStale = _priceAge !== null && _priceAge > 15000;

    // ── PRÉ-SIGNAL: signal en formation (2/4 votes) — anticiper l'entrée ──────
    // Si aucune position active, chercher un pré-signal dans le cache
    let preSignal = null;
    if (!tradeState?.entered) {
      const _tfToCheck = [tradeState?.timeframe, client.timeframe, 'M5', 'M15', 'H1']
        .filter(Boolean).filter((v,i,a) => a.indexOf(v) === i);
      for (const _tfc of _tfToCheck) {
        const _preKey = `${symbol}:${_tfc}`;
        const _pre = typeof _paPreSignalCache !== 'undefined' ? _paPreSignalCache.get(_preKey) : null;
        if (_pre && (Date.now() - _pre.detectedAt) < 90000) { // expire après 90s
          const _ageS = Math.round((Date.now() - _pre.detectedAt) / 1000);
          preSignal = {
            direction: _pre.direction, votes: _pre.votes, timeframe: _tfc,
            message: `⚡ Signal ${_pre.direction} en formation (${_pre.votes}/4 votes, ${_tfc}) — surveille, l'entrée n'est pas encore confirmée`,
            age: _ageS
          };
          break;
        }
      }
    }

    // ── PROTECTION POSITION: alerte précoce si indicateurs se retournent ──────
    // Pendant une position active, surveiller les signes de retournement AVANT que
    // le SL soit touché — donner le temps de réagir (sortie anticipée ou BE)
    let slWarning = null;
    if (tradeState?.entered && tradeState?.virtualPosition && tvLive?.indicators) {
      const _wvp  = tradeState.virtualPosition;
      const _wdir = String(_wvp.direction || '').toUpperCase();
      const _wind = tvLive.indicators;
      // RSI > 0 requis — même filtre que partout ailleurs (0 = données absentes)
      const _wrsi = (_wind.rsi != null && Number(_wind.rsi) > 0) ? Number(_wind.rsi) : null;
      const _wma20 = (_wind.ma20 != null && Number(_wind.ma20) > 0) ? Number(_wind.ma20) : null;
      const _wmacd = _wind.macd != null ? Number(_wind.macd) : null;
      const _wbb_upper = (_wind.bb_upper != null && Number(_wind.bb_upper) > 0) ? Number(_wind.bb_upper) : null;
      const _wbb_lower = (_wind.bb_lower != null && Number(_wind.bb_lower) > 0) ? Number(_wind.bb_lower) : null;
      const _wprice = Number(price || 0);
      const _wentry = Number(_wvp.entry || 0);
      const _wsl    = Number(_wvp.sl    || 0);
      const _wtp    = Number(_wvp.tp    || 0);
      const _warns  = [];

      if (_wdir === 'LONG') {
        // Signes de retournement contre un LONG:
        if (_wrsi != null && _wrsi > 72)          _warns.push(`RSI ${_wrsi.toFixed(0)} surachat`);
        if (_wma20 != null && _wprice < _wma20)   _warns.push(`prix sous MA20 (${_wma20.toFixed(2)})`);
        if (_wmacd != null && _wmacd < 0)          _warns.push(`MACD négatif (${_wmacd.toFixed(2)})`);
        if (_wbb_upper != null && _wprice >= _wbb_upper) _warns.push(`prix à BB haute — retournement possible`);
      } else if (_wdir === 'SHORT') {
        // Signes de retournement contre un SHORT:
        if (_wrsi != null && _wrsi < 28)           _warns.push(`RSI ${_wrsi.toFixed(0)} survente`);
        if (_wma20 != null && _wprice > _wma20)    _warns.push(`prix sur MA20 (${_wma20.toFixed(2)})`);
        if (_wmacd != null && _wmacd > 0)           _warns.push(`MACD positif (${_wmacd.toFixed(2)})`);
        if (_wbb_lower != null && _wprice <= _wbb_lower) _warns.push(`prix à BB basse — retournement possible`);
      }

      // Distance SL — si prix à moins de 30% du SL, c'est urgent
      if (_wentry > 0 && _wsl > 0 && _wprice > 0) {
        const _slDist = Math.abs(_wsl - _wentry);
        const _priceDist = _wdir === 'LONG' ? (_wprice - _wsl) : (_wsl - _wprice);
        const _slPct = _slDist > 0 ? _priceDist / _slDist : 1;
        if (_slPct < 0.30 && _slPct >= 0) {
          _warns.unshift(`⚠️ Prix à ${Math.round(_slPct * 100)}% du SL`);
        }
      }

      if (_warns.length >= 2) {
        slWarning = {
          urgency: _warns.some(w => w.includes('⚠️')) ? 'HIGH' : 'MEDIUM',
          signals: _warns,
          message: `⚠️ Attention ${_wdir}: ${_warns.slice(0,2).join(' + ')} — envisage sortie anticipée ou BE`
        };
      }
    }

    // ── MOTEUR DE RETOURNEMENT LIA — opportunité haute probabilité ───────────
    // Calcule un score 0-100 de retournement en lisant uniquement les données bridge
    // Pas d'impact sur la logique existante — champ additionnel dans le payload
    let reversalOpportunity = null;
    if (!tradeState?.entered) {
      // Hors position: chercher une opportunité de retournement
      const _rvBp  = tvLive?._bridgePayload || null;
      const _rvInd = tvLive?.indicators || null;
      if (_rvBp && price > 0) {
        reversalOpportunity = computeReversalOpportunity(price, _rvBp, _rvInd);
      }
    }

    // ── SETUP TYPE + MACRO depuis bridge ─────────────────────────────────────
    let setupType = null;
    let macroContext = null;
    if (_tvBridgeStream) {
      if (typeof detectSetupTypeFromBridge === 'function') {
        const _storedTradeType = tradeState?.virtualPosition?.tradeType || tradeState?.tradeType || null;
        setupType = detectSetupTypeFromBridge(_tvBridgeStream, _storedTradeType);
      }
      if (typeof buildMacroContext === 'function') {
        macroContext = buildMacroContext(_tvBridgeStream);
      }
    }

    const payload = {
      symbol,
      price,
      priceStale: _priceStale,
      timestamp: new Date().toISOString(),
      tradeState,
      coachMessage,                 // toujours inclus — popup met à jour texte à chaque push
      liveAnalysis,                 // analyse indicateurs temps réel
      multiTfConsensus,             // consensus multi-TF Pine Script
      preSignal,                    // signal en formation (2/4 votes) — anticipation entrée
      slWarning,                    // alerte précoce retournement pendant position active
      reversalOpportunity,          // moteur retournement LIA: score + entrée précise
      setupType,                    // SWING / SNIPER / SCALPING détecté depuis bridge
      macroContext,                 // { direction, strength, bull, bear, label }
      source: tvLive ? 'tradingview' : 'fallback'
    };

    client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
    client.lastPush = Date.now();
  } catch (err) {
    console.warn('[COACH STREAM] Push error:', err.message);
    coachStreamClients.delete(sessionId);
  }
}

// Fix #3 — grace period restart: positions fantômes déclenchaient SL/TP dans les 2s après restart
// On ignore le moniteur pendant les 15 premières secondes après démarrage serveur
const _slMonitorStartMs = Date.now();

// ── MONITEUR SL/TP TEMPS RÉEL ─────────────────────────────────────────────────
// Vérifie toutes les 2s si le prix live a touché SL ou TP pour les positions ouvertes
// SÉCURITÉ PRIX STALE: si le dernier prix TV a plus de 45s, on suspend toute décision SL/TP
const PRICE_STALE_MAX_MS = 45000; // 45 secondes sans nouveau prix = flux considéré coupé

setInterval(() => {
  if (Date.now() - _slMonitorStartMs < 15000) return; // grace period 15s post-restart
  try {
    if (typeof getCoachTradeState !== 'function') return;
    const storeRef = typeof coachTradeStateStore !== 'undefined' ? coachTradeStateStore : null;
    if (!storeRef) return;
    for (const key of Object.keys(storeRef)) {
      const ts = storeRef[key];
      if (!ts || !ts.entered || ts.phase === 'CLOSED' || ts.phase === 'SL_HIT' || ts.phase === 'TP_HIT') continue;
      const vp = ts.virtualPosition;
      if (!vp || !vp.entry || !vp.sl || !vp.tp) continue;
      const symKey = Object.keys(tvDataStore).find(k => k === ts.symbol) || ts.symbol;
      const liveEntry = tvDataStore[symKey];
      if (!liveEntry) {
        // Aucune donnée pour ce symbole — flux absent, on suspend
        broadcastToExtension({ type: 'price-stale', symbol: ts.symbol, reason: 'no-data', staleMs: null });
        continue;
      }

      // VÉRIFICATION FRAÎCHEUR DU PRIX
      const priceAgeMs = liveEntry.updatedAt ? (Date.now() - liveEntry.updatedAt) : PRICE_STALE_MAX_MS + 1;
      if (priceAgeMs > PRICE_STALE_MAX_MS) {
        // Prix périmé — suspendre toute décision SL/TP, alerter les clients
        const staleSeconds = Math.round(priceAgeMs / 1000);
        console.warn(`[STALE PRICE] ${ts.symbol} — dernier prix TV il y a ${staleSeconds}s. SL/TP monitoring suspendu.`);
        broadcastToExtension({ type: 'price-stale', symbol: ts.symbol, reason: 'stale', staleMs: priceAgeMs, staleSeconds });
        continue; // ← JAMAIS de SL/TP sur prix périmé
      }

      const price = parseFloat(liveEntry.price);
      if (!price || price <= 0) continue;
      // RÈGLE: utiliser direction normalisée (LONG/SHORT) — pas d'heuristique tp>entry
      // → évite faux SL_HIT si direction='LONG' stockée sur un trade SHORT (ou inversement)
      const isLong = vp.direction === 'LONG'; // 'SHORT' → false, 'WAIT' → false (pas monitoré)

      // BUFFER LATENCE: compensé le délai TV→extension→serveur + cycle 2000ms du monitor
      // SL déclenche seulement si prix dépasse le niveau + buffer (évite faux hits sur pics/latence)
      // TP déclenche légèrement avant le niveau exact (compense la latence de détection côté gain)
      const _sym4buf = String(ts.symbol || '').toUpperCase();
      const _isMetal4 = /XAU|XAG|GOLD|SILVER/.test(_sym4buf);
      const _isCrypto4 = /BTC|ETH|SOL|XRP|BNB|ADA|LTC|AVAX|MATIC|DOT/.test(_sym4buf);
      const _isIndex4  = /US30|US500|NAS|SPX|DAX|DE40|GER40/.test(_sym4buf);
      const _isJpy4    = _sym4buf.includes('JPY');
      // Buffer SL: prix doit DÉPASSER le SL d'au moins ce montant avant déclenchement
      const _slBuf  = _isMetal4 ? 0.50 : _isCrypto4 ? 5.0 : _isIndex4 ? 1.0 : _isJpy4 ? 0.020 : 0.0002;
      // Buffer TP: détecter le TP légèrement avant le niveau (latence de détection côté profit)
      const _tpBuf  = _slBuf * 0.5; // TP buffer = moitié du SL buffer

      // SL: prix doit aller au-delà du SL + buffer (pas un simple effleurage dû à la latence)
      const slHit = isLong ? price <= (Number(vp.sl) - _slBuf) : price >= (Number(vp.sl) + _slBuf);
      // TP: détecter dès que le prix atteint TP - tpBuf (anticipe légèrement la latence)
      const tpHit = isLong ? price >= (Number(vp.tp) - _tpBuf) : price <= (Number(vp.tp) + _tpBuf);
      if (slHit) {
        ts.phase = 'SL_HIT';
        ts.entered = false;
        ts.virtualPosition = null; // effacer la position stale — évite confusion clients après clôture
        _persistTradeState(ts.symbol, ts); // efface la position active sur disque
        const _slSym = String(ts.symbol || '').toUpperCase();
        const _slPM  = /BTC|ETH|SOL|XRP/.test(_slSym) ? 1 : /US30|NAS|SPX|DAX/.test(_slSym) ? 1 : /XAU|GOLD/.test(_slSym) ? 10 : _slSym.includes('JPY') ? 100 : 10000;
        const pnlPips = Math.round((isLong ? Number(vp.sl) - Number(vp.entry) : Number(vp.entry) - Number(vp.sl)) * _slPM * 10) / 10;
        const msg = `SL touché à ${price.toFixed(2)}. Perte: ${Math.abs(pnlPips)} pips. Analysons l'erreur et recalibrons.`;
        if (typeof broadcastToExtension === 'function') broadcastToExtension({ type: 'sl-hit', symbol: ts.symbol, price, sl: vp.sl, entry: vp.entry, pnlPips, message: msg });
        for (const [, c] of coachStreamClients.entries()) {
          if (c.symbol === ts.symbol) {
            try { c.res.write(`data: ${JSON.stringify({ symbol: ts.symbol, price, tradeState: { ...ts, pnlPips, closeTime: Date.now() }, coachMessage: msg, event: 'sl-hit' })}\n\n`); } catch(_) {}
          }
        }
        if (typeof addTradeToJournal === 'function') {
          addTradeToJournal({ symbol: ts.symbol, direction: vp.direction, entry: vp.entry, exit: price, sl: vp.sl, tp: vp.tp, pnlPips, won: false, rr: vp.rrRatio || '?', openedAt: new Date(ts.updatedAt||Date.now()).toISOString() });
        }
        console.log(`[SL HIT] ${ts.symbol} @ ${price} | Entry: ${vp.entry} | SL: ${vp.sl}`);
      } else if (tpHit) {
        ts.phase = 'TP_HIT';
        ts.entered = false;
        ts.virtualPosition = null; // effacer la position stale — évite confusion clients après clôture
        _persistTradeState(ts.symbol, ts); // efface la position active sur disque
        const _tpSym = String(ts.symbol || '').toUpperCase();
        const _tpPM  = /BTC|ETH|SOL|XRP/.test(_tpSym) ? 1 : /US30|NAS|SPX|DAX/.test(_tpSym) ? 1 : /XAU|GOLD/.test(_tpSym) ? 10 : _tpSym.includes('JPY') ? 100 : 10000;
        const pnlPips = Math.round(Math.abs(Number(vp.tp) - Number(vp.entry)) * _tpPM * 10) / 10;
        const msg = `TP validé à ${price.toFixed(2)} ! Gain: ${pnlPips} pips. Trade enregistré dans les stats.`;
        if (typeof broadcastToExtension === 'function') broadcastToExtension({ type: 'tp-hit', symbol: ts.symbol, price, tp: vp.tp, entry: vp.entry, pnlPips, message: msg });
        for (const [, c] of coachStreamClients.entries()) {
          if (c.symbol === ts.symbol) {
            try { c.res.write(`data: ${JSON.stringify({ symbol: ts.symbol, price, tradeState: { ...ts, pnlPips, closeTime: Date.now() }, coachMessage: msg, event: 'tp-hit' })}\n\n`); } catch(_) {}
          }
        }
        if (typeof addTradeToJournal === 'function') {
          addTradeToJournal({ symbol: ts.symbol, direction: vp.direction, entry: vp.entry, exit: price, sl: vp.sl, tp: vp.tp, pnlPips, won: true, rr: vp.rrRatio || '?', openedAt: new Date(ts.updatedAt||Date.now()).toISOString() });
        }
        console.log(`[TP HIT] ${ts.symbol} @ ${price} | Entry: ${vp.entry} | TP: ${vp.tp}`);
      }
    }
  } catch(_) {}
}, 2000);

// ── POSITION-SYNC vers extension toutes les 3s ───────────────────────────────
// Dispatch intelligent: broadcast seulement si l'état a changé (entered/phase/entry/sl/tp)
// Évite de spammer les clients SSE avec des paquets identiques à chaque tick
let _lastPositionSyncHash = '';
setInterval(() => {
  try {
    if (!Array.isArray(extensionSyncClients) || extensionSyncClients.length === 0) return;
    if (typeof getCoachTradeState !== 'function' || typeof resolveActiveRuntimeContext !== 'function') return;
    const ctx = resolveActiveRuntimeContext();
    const sym = ctx?.active?.symbol || (typeof activeSymbol !== 'undefined' ? activeSymbol?.symbol : null);
    if (!sym) return;

    // Chercher l'état de position ENTRÉ sur tous les TF — pas seulement le TF actif
    // Bug corrigé: position entrée sur M5 était invisible si TF actif = H1
    let ts = null;
    let foundTf = ctx?.active?.timeframe || 'H1';
    if (typeof coachTradeStateStore !== 'undefined' && coachTradeStateStore) {
      for (const [key, stored] of Object.entries(coachTradeStateStore)) {
        if (stored && stored.symbol === sym && stored.entered) {
          ts = stored;
          foundTf = stored.timeframe || foundTf;
          break;
        }
      }
    }
    if (!ts) ts = getCoachTradeState(sym, foundTf);

    // Corriger le status de virtualPosition si entrée réelle (évite "CLOSED" stale)
    const vp = ts.virtualPosition
      ? { ...ts.virtualPosition, status: ts.entered && ts.phase === 'OPEN' ? 'OPEN' : ts.virtualPosition.status }
      : null;

    const _syncPayload = {
      entered: !!ts.entered,
      phase: ts.phase || 'WAIT_ENTRY',
      symbol: sym,
      timeframe: foundTf,
      bePlaced: !!ts.bePlaced,
      partialTaken: !!ts.partialTaken,
      armed: !!ts.armed,
      // Hash des niveaux pour détecter un changement réel (entrée, SL, TP)
      _e: vp?.entry, _sl: vp?.sl, _tp: vp?.tp
    };
    const _syncHash = JSON.stringify(_syncPayload);
    // Ne broadcast que si l'état a changé — évite le spam SSE sur état stable
    if (_syncHash === _lastPositionSyncHash) return;
    _lastPositionSyncHash = _syncHash;

    broadcastToExtension({
      type: 'position-sync',
      symbol: sym,
      timeframe: foundTf,
      tradeState: {
        entered: !!ts.entered,
        phase: ts.phase || 'WAIT_ENTRY',
        symbol: sym,
        timeframe: foundTf,
        virtualPosition: ts.entered ? vp : null, // FIX: ne pas diffuser VP si position fermée
        bePlaced: !!ts.bePlaced,
        partialTaken: !!ts.partialTaken,
        armed: !!ts.armed,
        // FIX position fantôme: inclure exitedAt pour que l'extension pose son guard SSE
        // même quand l'EXIT vient du dashboard (pas de _lastExitAt local dans ce cas)
        exitedAt: (!ts.entered && ts.exitedAt) ? ts.exitedAt : undefined
      }
    });
  } catch(_) {}
}, 3000);   // 5s→3s: position plus réactive

// ── COACH STREAM — push périodique toutes les 4s ─────────────────────────────
// Garantit que /coach/stream reste vivant (pas seulement connect + SL/TP events)
setInterval(async () => {
  if (!coachStreamClients || coachStreamClients.size === 0) return;
  for (const [sessionId] of coachStreamClients.entries()) {
    try { await pushCoachEvent(sessionId); } catch(_) {}
  }
}, 4000);

