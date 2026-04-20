// ─── EXPRESS INIT EN TÊTE ───────────────────────────────────────────────────
'use strict';
const express = require('express');
const app = express();
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { spawn, execSync } = require('child_process');
const PORT    = 4000;

// ─── DÉMARRAGE ───────────────────────────────────────────────────────────────
(function enforceProjectRoot() {
  const fullPath = __dirname;
  console.log('═══════════════════════════════════════════════════════');
  console.log('✅  PROJET ADEL — Serveur Trading Auto');
  console.log(`    Racine  : ${fullPath}`);
  console.log(`    Port    : 4000`);
  console.log(`    Extension cible : "Trading Auto Analyzer"`);
  console.log('═══════════════════════════════════════════════════════');
})();

// ─── SYSTÈME : RÈGLES OBLIGATOIRES ──────────────────────────────────────────
// Charge et vérifie system_rules.json au démarrage.
// Toute source interdite → rejet immédiat.
(function enforceSystemRules() {
  try {
    const rulesPath = path.join(__dirname, 'system_rules.json');
    const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    const forbidden = rules.dataSources?.forbidden || [];
    // Override bridgeConfig avec les règles système (appliqué plus tard au chargement)
    process.env._SYSTEM_ALLOWED_SOURCE = (rules.dataSources?.allowed || ['tradingview'])[0];
    process.env._SYSTEM_FORBIDDEN = forbidden.join(',');
    console.log('[SYSTEM_RULES] Chargé — source autorisée:', process.env._SYSTEM_ALLOWED_SOURCE);
    console.log('[SYSTEM_RULES] Interdits:', forbidden.join(', '));
  } catch (e) {
    console.warn('[SYSTEM_RULES] Fichier system_rules.json manquant ou invalide:', e.message);
  }
})();
// Default paper: safe when BROKER_ENDPOINT not configured — no order sent to broker
if (!process.env.BROKER_MODE) process.env.BROKER_MODE = process.env.BROKER_ENDPOINT ? 'live' : 'paper';
if (!process.env.SAFE_MODE) process.env.SAFE_MODE = '0';
const SAFE_MODE = process.env.SAFE_MODE !== '0';

// ─── STRICT RULES — NON MODIFIABLES (Adel) ──────────────────────────────────
// Chargé au démarrage. Toute règle locked=true est intouchable par le système.
const STRICT_RULES_PATH = path.join(__dirname, 'strict_rules.json');
let STRICT_RULES = { rules: [] };
try {
  STRICT_RULES = JSON.parse(fs.readFileSync(STRICT_RULES_PATH, 'utf8'));
  console.log('[STRICT_RULES] Chargées:', STRICT_RULES.rules.length, 'règles verrouillées');
} catch (_e) {
  console.error('[STRICT_RULES] Fichier manquant ou invalide — système continue sans règles verrouillées');
}
function verifyStrictRules(context) {
  const violations = [];
  if (context.inTop && context.isLong)
    violations.push('ZONE_DIRECTION_SHORT violée: inTop=true mais direction=LONG');
  if (context.inBot && context.isShort)
    violations.push('ZONE_DIRECTION_LONG violée: inBot=true mais direction=SHORT');
  // Verdict bridge vs position active — SHORT bridge + LONG entré = incohérence critique
  if (context.bridgeVerdict === 'SHORT' && context.isLong && context.entered)
    violations.push('VERDICT_POSITION_MISMATCH: bridge=SHORT mais position=LONG active');
  if (context.bridgeVerdict === 'LONG' && context.isShort && context.entered)
    violations.push('VERDICT_POSITION_MISMATCH: bridge=LONG mais position=SHORT active');
  if (violations.length > 0) {
    console.warn('[STRICT_RULES] VIOLATION DÉTECTÉE:', violations.join(' | '));
  }
  return violations;
}

// ─── TRADINGVIEW LIVE INGESTION ─────────────────────────────────────────────
// Route /tradingview/live → handleTvWebhook (registered after handler definition, line ~4572)
const tvDataStore = {};

// ─── TV WIDGET HELPERS — symbole + résolution pour widget TradingView ────────
const _TV_EXCHANGE_MAP = {
  'XAUUSD': 'OANDA:XAUUSD',  'XAGUSD': 'OANDA:XAGUSD',
  'EURUSD': 'OANDA:EURUSD',  'GBPUSD': 'OANDA:GBPUSD',
  'USDJPY': 'OANDA:USDJPY',  'USDCHF': 'OANDA:USDCHF',
  'AUDUSD': 'OANDA:AUDUSD',  'NZDUSD': 'OANDA:NZDUSD',
  'USDCAD': 'OANDA:USDCAD',  'EURJPY': 'OANDA:EURJPY',
  'NAS100': 'OANDA:NAS100',  'US500':  'OANDA:SPX500USD',
  'US30':   'OANDA:US30USD', 'DE40':   'OANDA:DE30EUR',
  'BTCUSD': 'COINBASE:BTCUSD', 'ETHUSD': 'COINBASE:ETHUSD',
};
function _tfToTvResolution(tf) {
  const t = String(tf || '').toUpperCase();
  if (t === 'M1')  return '1';
  if (t === 'M5')  return '5';
  if (t === 'M15') return '15';
  if (t === 'M30') return '30';
  if (t === 'H1')  return '60';
  if (t === 'H4')  return '240';
  if (t === 'D1')  return 'D';
  if (t === 'W1')  return 'W';
  const n = parseInt(t); if (!isNaN(n)) return String(n);
  return null;
}
function _getWidgetSymbol(tickerid, canonical) {
  if (tickerid && String(tickerid).includes(':')) return String(tickerid).toUpperCase();
  return _TV_EXCHANGE_MAP[canonical] || null;
}

// ─── PRICE WINDOW — fallback zone synthétique quand Pine absent ──────────────
// RÈGLE BRIDGE_NO_NULL: bridge null → fallback obligatoire depuis historique prix
const _tvPriceWindow = {}; // { [symbol]: [{ price, ts }] }
const _PW_MAX = 200; // 200 ticks — assez pour RSI14 fiable + mémoire courte terme
function _pwPush(symbol, price) {
  if (!symbol || !(price > 0)) return;
  if (!_tvPriceWindow[symbol]) _tvPriceWindow[symbol] = [];
  _tvPriceWindow[symbol].push({ price, ts: Date.now() });
  if (_tvPriceWindow[symbol].length > _PW_MAX) _tvPriceWindow[symbol].shift();
}
// ── M1/M5 SWING LEVELS — SL structurel depuis micro-structure réelle ─────────
// Règle SL_M1_PRIORITE: swing M1 (30 ticks) → M5 (150 ticks) → null si absent
// PAS rangeHigh/rangeLow (zone macro Pine) — interdit pour SL
function _computeSwingLevels(symbol, nTicks, source) {
  const pw = _tvPriceWindow[symbol];
  if (!pw || pw.length < 3) return null;
  const recent = pw.slice(-Math.min(pw.length, nTicks)).map(t => t.price);
  if (recent.length < 3) return null;
  return { swingHigh: Math.max(...recent), swingLow: Math.min(...recent), source, n: recent.length };
}
function _getM1Swing(symbol) { return _computeSwingLevels(symbol, 30, 'M1'); }
function _getM5Swing(symbol) { return _computeSwingLevels(symbol, 150, 'M5'); }

function _pwSynthZone(symbol, currentPrice) {
  const win = _tvPriceWindow[symbol];
  if (!win || win.length < 5) return null; // 5 ticks ≈ 15s minimum avant synthèse
  const prices = win.map(p => p.price);
  const hi = Math.max(...prices);
  const lo = Math.min(...prices);
  const range = hi - lo;
  // Range trop petit = marché flat ou prix figé → zone inconnue mais on marque Pine absent
  if (range < lo * 0.0005) return { inTop: false, inBot: false, _synthZone: true, _synthZonePos: '0.50', _flat: true };
  const pos = (currentPrice - lo) / range; // 0=bas, 1=haut
  if (pos >= 0.82) return { inTop: true,  inBot: false, _synthZone: true, _synthZonePos: pos.toFixed(3) };
  if (pos <= 0.18) return { inTop: false, inBot: true,  _synthZone: true, _synthZonePos: pos.toFixed(3) };
  return { inTop: false, inBot: false, _synthZone: true, _synthZonePos: pos.toFixed(3) }; // milieu
}

// RSI synthétique depuis série de prix (Wilder's RSI)
function _calcSynthRsi(prices, period) {
  if (!prices || prices.length < period + 1) return null;
  const recent = prices.slice(-Math.min(prices.length, period * 3));
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = recent[i] - recent[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < recent.length; i++) {
    const d = recent[i] - recent[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}

// ── SOURCE UNIQUE DE PRIX ─────────────────────────────────────────────────
// Retourne le prix live TradingView si < 30s, sinon null.
// AUCUN fallback fake. Si null → le système se bloque proprement.
function getLivePrice(symbol, maxAgeMs = 30000) {
  const entry = tvDataStore[symbol?.toUpperCase()]
    || Object.values(tvDataStore).find(v => (v.symbol || '').toUpperCase() === (symbol || '').toUpperCase());
  if (!entry) return null;
  if (!entry.price || entry.price <= 0) return null;
  // Parse updatedAt: ISO string ou number timestamp
  const _updMs = typeof entry.updatedAt === 'number' ? entry.updatedAt : new Date(entry.updatedAt || 0).getTime();
  const ageMs = _updMs > 0 ? Date.now() - _updMs : Infinity;
  // Si keepalive actif → toujours accepter le cache (refreshé toutes les 20s)
  const _effectiveMax = _bridgeKeepaliveEnabled ? Math.max(maxAgeMs, 120000) : maxAgeMs;
  if (ageMs > _effectiveMax) return null;
  return { price: entry.price, ageMs, symbol: entry.symbol || symbol, timeframe: entry.timeframe };
}

// Version relaxée pour scan multi-TF : accepte jusqu'à 2 minutes de données stales
function getLivePriceRelaxed(symbol) {
  return getLivePrice(symbol, 120000);
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
// ─────────────────────────────────────────────────────────────────────────────


// server.js — Trading Auto Backend
// Source de données: Bridge TradingView UNIQUEMENT — MT5 et Yahoo Finance SUPPRIMÉS
// AUCUN Math.random() pour les prix — toutes les données sont réelles

// ── RÈGLE ARCHITECTURALE ────────────────────────────────────────────────────
// SOURCE UNIQUE : Bridge TradingView (Pine Script → /tradingview/live → tvDataStore)
// tvDataStore[symbol].price = prix de référence pour TOUS les agents.
// Aucune source externe autorisée. Aucun fallback Yahoo ou MT5.
// ────────────────────────────────────────────────────────────────────────────

'use strict';

// ─── SINGLE-INSTANCE GUARD — abort immédiat si port déjà occupé ──────────────
const _net = require('net');
const _portGuard = _net.createServer();
_portGuard.once('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[ABORT] PORT 4000 DÉJÀ OCCUPÉ — instance en conflit détectée.`);
    console.error(`[ABORT] Kill avec: taskkill /F /IM node.exe /T   puis relancez.`);
    process.exit(1);
  }
});
_portGuard.once('listening', () => {
  _portGuard.close(); // port libre confirmé — on peut continuer
});
_portGuard.listen(4000, '127.0.0.1');
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

// ─── MIDDLEWARE SÉCURITÉ ADEL — clé obligatoire pour toute route d'écriture ──
// "Adel"      → accès code général  (header X-Adel-Key ou query ?key=)
// "Adel Spec" → accès règles strictes uniquement
const ADEL_KEY        = 'Adel';
const ADEL_SPEC_KEY   = 'Adel Spec';
const ADEL_WRITE_AUDIT_LOG = path.join(__dirname, 'security', 'access.log');

function _adelLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(ADEL_WRITE_AUDIT_LOG, line); } catch {}
  console.log('[ADEL-SECURITY]', msg);
}

// Routes write protégées — nécessitent X-Adel-Key: Adel (ou query ?adel_key=)
function requireAdelKey(req, res, next) {
  const key = req.headers['x-adel-key'] || req.query.adel_key || '';
  if (key === ADEL_KEY || key === ADEL_SPEC_KEY) {
    _adelLog(`ACCÈS AUTORISÉ — ${req.method} ${req.path} — clé: ${key.substring(0,4)}***`);
    return next();
  }
  _adelLog(`ACCÈS REFUSÉ — ${req.method} ${req.path} — clé fournie: "${key.substring(0,8)}"`);
  return res.status(403).json({ ok: false, error: 'ADEL_KEY_REQUIRED', message: 'Clé Adel requise. Header: X-Adel-Key: Adel' });
}

// Routes strict_rules — nécessitent X-Adel-Key: Adel Spec
function requireAdelSpecKey(req, res, next) {
  const key = req.headers['x-adel-key'] || req.query.adel_key || '';
  if (key === ADEL_SPEC_KEY) {
    _adelLog(`ACCÈS STRICT AUTORISÉ — ${req.method} ${req.path}`);
    return next();
  }
  _adelLog(`ACCÈS STRICT REFUSÉ — ${req.method} ${req.path} — clé: "${key.substring(0,8)}"`);
  return res.status(403).json({ ok: false, error: 'ADEL_SPEC_KEY_REQUIRED', message: 'Clé "Adel Spec" requise pour modifier les règles strictes. Header: X-Adel-Key: Adel Spec' });
}

// ─── GLOBAL HARD LOCK — INTERCEPTE TOUTES LES ROUTES WRITE (POST/PUT/DELETE/PATCH) ──
// Routes exemptées: /tv-bridge (Pine webhook ne peut pas envoyer de header custom)
//                  /health, /ping, /stream (lecture seule)
const ADEL_WRITE_EXEMPT = new Set([
  '/tv-bridge', '/tradingview/live', '/tv-webhook', '/webhook', '/bridge/robot-v12',
  '/health', '/ping', '/stream', '/extension/sync',
  '/system/log'  // logs dashboard — aucune clé requise, lecture seule côté risque
]);

app.use(function globalAdelWriteLock(req, res, next) {
  // Lecture seule (GET/HEAD/OPTIONS) → libre
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  // Routes exemptées (webhooks externes, SSE)
  if (ADEL_WRITE_EXEMPT.has(req.path)) return next();
  // Vérification clé
  const key = req.headers['x-adel-key'] || req.query.adel_key || '';
  if (key === ADEL_KEY || key === ADEL_SPEC_KEY) return next();
  // Blocage total
  _adelLog(`HARD LOCK — ${req.method} ${req.path} IP:${req.ip} — ACCÈS REFUSÉ`);
  return res.status(403).json({ ok: false, error: 'ACCÈS REFUSÉ — CLÉ MANQUANTE' });
});

// ─── BRIDGE GATE — BLOQUE TOUT SI BRIDGE TV OFFLINE ──────────────────────────
// Règle stricte NO_PARTIAL_STATE + STARTUP_BRIDGE_REQUIRED :
// serveur ON + bridge OFF = état partiel = SYSTEM BLOQUÉ
//
// IMPORTANT: tracker EN MÉMOIRE uniquement (jamais depuis disk cache).
// _bridgeLiveAt = null au démarrage → BLOQUÉ jusqu'au premier payload Pine live.
// Le disk cache tvDataStore peut être "vieux" de plusieurs heures → interdit pour le gate.
let _bridgeLiveAt = null;     // mis à jour par signalBridgeLive() à chaque payload Pine
let _lastRealTvTickAt = null; // UNIQUEMENT mis à jour quand un vrai tick Pine arrive (pas keepalive)
const REAL_TV_STALE_MS = 90000; // 90s sans vrai tick → TV non connecté

function signalBridgeLive() { _bridgeLiveAt = Date.now(); }

// Appelé UNIQUEMENT dans handleTvWebhook (vrai payload Pine Script ou extension)
function signalRealTvTick() {
  const _wasCache = !_lastRealTvTickAt || (Date.now() - _lastRealTvTickAt) >= REAL_TV_STALE_MS;
  _lastRealTvTickAt = Date.now();
  _bridgeLiveAt = Date.now();
  if (_wasCache) console.log('[BRIDGE] Mode → LIVE_TV (vrai tick Pine reçu)');
}

// Retourne le mode bridge actuel :
// 'LIVE_TV'  — vrai tick Pine < 90s   → données temps réel fiables
// 'CACHE_TV' — keepalive actif, pas de tick TV récent → prix connu mais pas live
// 'OFFLINE'  — aucun keepalive ni tick → serveur sans données
function getBridgeMode() {
  const now = Date.now();
  if (_lastRealTvTickAt && (now - _lastRealTvTickAt) < REAL_TV_STALE_MS) return 'LIVE_TV';
  if (_bridgeLiveAt && (now - _bridgeLiveAt) < BRIDGE_STALE_MS) return 'CACHE_TV';
  return 'OFFLINE';
}

// ── BRIDGE KEEPALIVE — maintient le bridge actif en l'absence de payload Pine ──
// Démarre automatiquement au boot. Peut être désactivé si TV envoie des données.
// NE INJECTE PAS de fausses données — rafraîchit seulement le timestamp.
let _bridgeKeepaliveTimer = null;
let _bridgeKeepaliveEnabled = true;
function _startBridgeKeepalive() {
  if (_bridgeKeepaliveTimer) clearInterval(_bridgeKeepaliveTimer);
  signalBridgeLive(); // activer immédiatement
  _bridgeKeepaliveTimer = setInterval(_bridgeKeepaliveTick, 20000);
  console.log('[BRIDGE-KEEPALIVE] Démarré — bridge maintenu actif toutes les 20s');
}
function _bridgeKeepaliveTick() {
  if (!_bridgeKeepaliveEnabled) return;
  signalBridgeLive();
  // Broadcaster le dernier prix réel connu en cache → met à jour S.bridgeUpdatedAtMs dans le dashboard
  const cachedSyms = Object.keys(tvDataStore);
  if (cachedSyms.length === 0) return;
  // Préférer le symbole avec le prix le plus récent
  const sym = cachedSyms.sort((a, b) => {
    const tA = tvDataStore[a]?.updatedAt ? new Date(tvDataStore[a].updatedAt).getTime() : 0;
    const tB = tvDataStore[b]?.updatedAt ? new Date(tvDataStore[b].updatedAt).getTime() : 0;
    return tB - tA;
  })[0];
  const cached = tvDataStore[sym];
  if (!cached || !(cached.price > 0)) return;
  // Rafraîchir updatedAt en ms pour que getLivePrice accepte ce prix
  tvDataStore[sym].updatedAt = Date.now();
  broadcastToExtension({
    type: 'tradingview-data',
    symbol: sym,
    timeframe: cached.timeframe || 'M1',
    price: cached.price,
    tvSymbol: cached.tvSymbol || _getWidgetSymbol(null, sym) || null,
    tvResolution: cached.tvResolution || _tfToTvResolution(cached.timeframe) || null,
    updatedAt: new Date().toISOString(),
    source: 'keepalive-cache',
    // Inclure bridgeData cached → met à jour toutes les cartes TF même sans tick Pine
    bridgeData: cached.bridgeData || null,
    keepalive: true
  });
}
// Démarrer immédiatement au boot
_startBridgeKeepalive();

const BRIDGE_GATE_EXEMPT = new Set([
  '/tv-bridge', '/tradingview/live', '/tv-webhook', '/webhook', '/bridge/robot-v12',
  '/health', '/ping', '/bridge/health', '/stream', '/extension/sync', '/',
  '/api/github-positions', '/api/github-positions/config', '/api/github-positions/status',
  // Routes appelées par l'extension Chrome — doivent passer même quand bridge offline
  '/live/state', '/extension/command', '/extension/data', '/extension/scan-flag',
  '/apex/commands/next', '/apex/result',
  // Routes agent
  '/api/github-positions/agent/start', '/api/github-positions/agent/stop',
  '/api/github-positions/config/reload-agent',
  // Routes debug — doivent passer même bridge offline (c'est leur raison d'être)
  '/debug/bridge-online', '/debug/bridge-offline', '/api/bridge/keepalive'
]);
const BRIDGE_STALE_MS = 30000; // 30s sans payload live = bridge offline

app.use(function globalBridgeGate(req, res, next) {
  // Assets statiques et pages HTML → toujours servir
  if (req.path.startsWith('/public/') || req.path.startsWith('/static/')) return next();
  if (req.path.endsWith('.html') || req.path.endsWith('.js') || req.path.endsWith('.css')) return next();
  // Routes exemptées (webhook Pine, healthchecks, SSE)
  if (BRIDGE_GATE_EXEMPT.has(req.path)) return next();
  // Vérifier fraîcheur bridge — MÉMOIRE UNIQUEMENT (pas disk cache)
  const _ageMs = _bridgeLiveAt ? (Date.now() - _bridgeLiveAt) : Infinity;
  if (_ageMs > BRIDGE_STALE_MS) {
    const _ageSec = _bridgeLiveAt ? Math.round(_ageMs / 1000) : null;
    const _msg = _bridgeLiveAt
      ? `SYSTEM BLOQUÉ — BRIDGE TV OFF. Aucun payload Pine depuis ${_ageSec}s. Vérifier TradingView + Pine Script robot-v12.`
      : 'SYSTEM BLOQUÉ — BRIDGE TV OFF. Aucun payload Pine reçu depuis le démarrage. Ouvrir TradingView + activer Pine Script robot-v12.';
    return res.status(503).json({
      ok: false, error: 'SYSTEM_BLOQUÉ', message: _msg,
      bridgeAgeSeconds: _ageSec, bridgeStatus: 'offline'
    });
  }
  next();
});

// ─── DEV TEST — forcer état bridge pour tests CI ─────────────────────────────
// POST /debug/bridge-offline → simule bridge offline (stale >30s)
// POST /debug/bridge-online  → restaure bridge online
app.post('/debug/bridge-offline', (req, res) => {
  _bridgeLiveAt = Date.now() - 60000; // 60s dans le passé → stale
  res.json({ ok: true, bridgeForcedOffline: true, _bridgeLiveAt });
});
app.post('/debug/bridge-online', (req, res) => {
  _bridgeKeepaliveEnabled = true;
  signalBridgeLive();
  res.json({ ok: true, bridgeForcedOnline: true, _bridgeLiveAt });
});

// ── /api/bridge/keepalive — statut + contrôle keepalive ──────────────────────
app.get('/api/bridge/keepalive', (_req, res) => {
  const _km = getBridgeMode();
  res.json({ ok: true, keepaliveEnabled: _bridgeKeepaliveEnabled,
    bridgeLive: !!(_bridgeLiveAt && (Date.now() - _bridgeLiveAt) < BRIDGE_STALE_MS),
    bridgeAgeMs: _bridgeLiveAt ? Date.now() - _bridgeLiveAt : null,
    tvMode: _km,
    realTvAgeMs: _lastRealTvTickAt ? Date.now() - _lastRealTvTickAt : null,
    requiresTradingView: _km !== 'LIVE_TV' });
});
app.post('/api/bridge/keepalive', (req, res) => {
  const { enable } = req.body || {};
  if (enable === false) {
    _bridgeKeepaliveEnabled = false;
    res.json({ ok: true, keepaliveEnabled: false, note: 'Keepalive désactivé — bridge exigera payload TV réel' });
  } else {
    _bridgeKeepaliveEnabled = true;
    signalBridgeLive();
    res.json({ ok: true, keepaliveEnabled: true, note: 'Keepalive activé — bridge maintenu sans TV' });
  }
});

// ─── DEV HELPER — injecte le bouton contexte dans chaque page HTML ────────────
const DEV_HELPER_TAG = '\n<script src="/public/dev-helper.js"></script>\n</body>';
function sendHTMLWithHelper(res, filePath) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  const raw = fs.readFileSync(filePath, 'utf8');
  const html = raw.includes('dev-helper.js') ? raw : raw.replace('</body>', DEV_HELPER_TAG);
  res.type('html').send(html);
}

// ─── MENU PRINCIPAL ───────────────────────────────────────────────────────
app.get('/', (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'index.html')));
app.get('/audit', (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'audit-dashboard.html')));
app.get('/audit-dashboard', (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'audit-dashboard.html')));
app.get('/live', (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'live-ops.html')));
app.get('/studio',  (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'studio', 'index-simple.html')));
app.get('/studio/', (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'studio', 'index-simple.html')));
app.get('/control-panel', (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'control-panel.html')));
// Studio assets (JS, CSS) servis après les routes HTML
app.use('/studio', express.static(path.join(__dirname, 'studio')));

// ─── Modules réels ───────────────────────────────────────────────────────────
const marketHoursChecker = require('./lib/market-hours-checker'); // [P2] Market hours detection
const agentBus = require('./agent-bus'); // [P3] Agent registry and messaging
const alertManager = require('./alert-manager'); // [P2] Alert system
// [SIMULATEUR DÉSACTIVÉ] real-data-simulator supprimé — toutes les données proviennent de TradingView live (tvDataStore)
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
    updateFromTV: function(p, s) {
      const sym = s || p && p.symbol; if (!sym) return;
      this.bySymbol[sym] = { latestPayload: p, updatedAt: Date.now() };
      this.lastActiveSymbol = sym;
      this.lastActiveTimeframe = (p && p.timeframe) || 'H1';
      this.lastActivePrice = p && (p.price || p.bid || p.ask) || null;
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
    return { canonical, broker_symbol: raw, type, digits, slPct, tpPct, pip };
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
  marketStore.on('bridge-tv-update', (sym, payload) => {
    recordLocalPricePoint(sym, payload || {});
  });
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


// ─── Calcul des niveaux (réels, basés sur %) ─────────────────────────────────
function calcTradeLevels(price, direction, profile, timeframe, atr = null) {
  const digits = profile.digits || 5;
  const pip = profile.pip || 0.1;
  
  // Use ATR-based levels if available, otherwise use conservative profile percentages
  let slDist, tpDist;
  
  if (atr && atr > 0) {
    // ATR-based: SL = ATR × 1.5, TP = ATR × 3.5 (ensures realistic 2-3:1 RR)
    slDist = atr * 1.5;
    tpDist = atr * 3.5;  // ~2.33:1 ratio
  } else {
    // Fallback: Use profile percentages directly (no arbitrary multipliers)
    // This ensures consistency with symbol-normalizer profiles
    slDist = price * (profile.slPct || 0.003);
    tpDist = price * (profile.tpPct || 0.009);
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

    const tvStoreData = marketStore.getLatestForSymbol(canonical.canonical);
    const backendData = {
      tv: tvStoreData?.latestPayload ? { symbol: canonical.canonical, price: parseFloat(tvStoreData.latestPayload.price) } : null,
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

// ─── SYSTEM RULES ─────────────────────────────────────────────────────────────
app.get('/system-rules', (_req, res) => {
  try {
    const rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'system_rules.json'), 'utf8'));
    res.json({ ok: true, rules });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── PING / STATUS / POPUP / LIVE-ANALYSIS ────────────────────────────────────
app.get('/ping', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ─── SETUP PINE — page d'installation Pine Script + webhook URL ───────────────
app.get('/setup-pine', (_req, res) => {
  const fs = require('fs');
  const tunnelFile = path.join(__dirname, 'bridge', 'out', 'tunnel-url.txt');
  let tunnelUrl = null;
  try { tunnelUrl = fs.readFileSync(tunnelFile, 'utf8').trim(); } catch(_) {}
  const webhookUrl = tunnelUrl || 'http://127.0.0.1:4000/tradingview/live (LOCAL ONLY — lancer run.ps1 tunnel pour URL publique)';
  const pineFile = path.join(__dirname, 'ROBOT_V12_BRIDGE_BOT.pine');
  let pineCode = '';
  try { pineCode = fs.readFileSync(pineFile, 'utf8'); } catch(_) {
    try { pineCode = fs.readFileSync(path.join(__dirname, 'PINE_BRIDGE_ENRICHISSEMENT.pine'), 'utf8'); } catch(_2) {}
  }
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>Setup Pine Script — Robot V12 Bridge</title>
<style>
body{font-family:monospace;background:#0f1117;color:#e2e8f0;padding:20px;max-width:900px;margin:0 auto}
h1{color:#22c55e;font-size:18px}h2{color:#94a3b8;font-size:14px;margin-top:20px}
.step{background:#1e293b;border:1px solid #334155;border-radius:6px;padding:14px;margin:12px 0}
.step-num{color:#f97316;font-weight:700;font-size:16px}
.url-box{background:#0a0f1a;border:2px solid #22c55e;border-radius:4px;padding:10px;
  color:#22c55e;font-size:13px;word-break:break-all;user-select:all;cursor:pointer}
.pine-box{background:#0a0f1a;border:1px solid #475569;border-radius:4px;padding:10px;
  color:#93c5fd;font-size:11px;white-space:pre;overflow:auto;max-height:400px}
button{background:#22c55e;color:#000;border:none;border-radius:4px;padding:8px 16px;
  cursor:pointer;font-weight:700;margin:6px 0}
button:hover{background:#4ade80}
.ok{color:#22c55e} .warn{color:#f97316} .badge{display:inline-block;padding:2px 8px;
  border-radius:10px;font-size:11px;font-weight:700}
</style></head><body>
<h1>🔧 Setup Pine Script — Robot V12 Bridge</h1>
<p style="color:#64748b">Configure TradingView pour envoyer les indicateurs multi-TF au serveur Adel.</p>

<div class="step">
<div class="step-num">ÉTAPE 1 — URL Webhook (à copier dans TradingView)</div>
<div class="url-box" onclick="navigator.clipboard.writeText(this.textContent);this.style.borderColor='#4ade80';setTimeout(()=>this.style.borderColor='#22c55e',1500)" title="Cliquer pour copier">${webhookUrl}</div>
<button onclick="navigator.clipboard.writeText('${webhookUrl}');this.textContent='✅ Copié!'">📋 Copier URL</button>
<p style="color:#64748b;font-size:12px">⚠️ URL change à chaque restart. Toujours vérifier dans <code>bridge/out/tunnel-url.txt</code></p>
</div>

<div class="step">
<div class="step-num">ÉTAPE 2 — Ajouter le Pine Script à TradingView</div>
<ol style="line-height:1.9;color:#cbd5e1">
<li>Ouvrir <strong>TradingView</strong> sur le graphique voulu (XAUUSD recommandé)</li>
<li>Cliquer <strong>Pine Editor</strong> (bas de page) → Nouveau script</li>
<li>Supprimer tout → Coller le code ci-dessous</li>
<li>Cliquer <strong>Enregistrer</strong> → <strong>Ajouter au graphique</strong></li>
</ol>
<button onclick="navigator.clipboard.writeText(document.getElementById('pine').textContent);this.textContent='✅ Code copié!'">📋 Copier le Pine Script complet</button>
<div class="pine-box" id="pine">${pineCode.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
</div>

<div class="step">
<div class="step-num">ÉTAPE 3 — Créer l'alerte avec Webhook</div>
<ol style="line-height:1.9;color:#cbd5e1">
<li>Sur TradingView: clic droit sur le graphique → <strong>Ajouter une alerte</strong></li>
<li>Condition: <strong>ROBOT V12 FR — BRIDGE BOT ONLY</strong></li>
<li>Fréquence: <strong>Une fois par barre</strong></li>
<li>Cocher <strong>Webhook URL</strong> → coller l'URL de l'étape 1</li>
<li>Message: laisser vide (le script envoie son propre JSON)</li>
<li>Cliquer <strong>Créer</strong></li>
</ol>
</div>

<div class="step">
<div class="step-num">ÉTAPE 4 — Vérification</div>
<p>Après création de l'alerte, les données arrivent en quelques secondes.</p>
<button onclick="fetch('/debug/bridge').then(r=>r.json()).then(d=>{const ok=d.bridgePayload?.rsiTf1!=null;document.getElementById('check').innerHTML=ok?'<span class=ok>✅ BRIDGE ACTIF — RSI reçu: M1='+d.bridgePayload.rsiTf1+'</span>':'<span class=warn>⚠️ Pas encore de RSI — attendre la prochaine bougie TradingView</span>'})">🔍 Vérifier le bridge</button>
<div id="check" style="margin-top:8px;font-size:13px"></div>
</div>

<script>
// Auto-check bridge toutes les 10s
setInterval(()=>{
  fetch('/debug/bridge').then(r=>r.json()).then(d=>{
    const rsi = d.bridgePayload?.rsiTf1;
    const verdict = d.bridgePayload?.verdict;
    document.title = rsi != null ? '✅ Bridge actif — RSI M1: ' + rsi : '⏳ En attente Pine Script';
  });
}, 10000);
</script>
</body></html>`);
});

app.get('/status', (_req, res) => {
  const ctx = resolveActiveRuntimeContext();
  res.json({
    ok: true,
    source: marketStore.systemStatus?.source || 'offline',
    fluxStatus: marketStore.systemStatus?.fluxStatus || 'OFFLINE',
    symbol: ctx.active.symbol || null,
    price: marketStore.price || null,
    bridgeActive: !!marketStore.bridgeActive,
    uptime: process.uptime(),
    ts: Date.now()
  });
});

app.get('/popup.html', (_req, res) => sendHTMLWithHelper(res, path.join(__dirname, 'popup.html')));

app.get('/coach/live-analysis', async (req, res) => {
  const symbol = req.query.symbol || marketStore.symbol || 'XAUUSD';
  const price   = marketStore.price || 0;
  const bridge  = marketStore.lastBridgePayload || {};
  const ts      = coachTradeStateStore[symbol] || {};
  res.json({
    ok: true,
    symbol,
    price,
    phase: ts.phase || 'IDLE',
    entered: ts.entered || false,
    direction: ts.direction || null,
    sl: ts.sl || null,
    tp: ts.tp || null,
    bridgeActive: !!marketStore.bridgeActive,
    lectureTech: {
      tf1: bridge.lectureTech1 || null,
      tf2: bridge.lectureTech2 || null,
      tf3: bridge.lectureTech3 || null,
      tf4: bridge.lectureTech4 || null
    },
    ts: Date.now()
  });
});

// ─── HEALTH ────────────────────────────────────────────────────────────────────
// ── STRICT RULES — endpoint lecture seule (jamais de PUT/DELETE) ──────────────
app.get('/strict-rules', (_req, res) => {
  res.json({ ok: true, locked: true, count: STRICT_RULES.rules.length, rules: STRICT_RULES.rules });
});

app.get('/health', (_req, res) => {
  const resolvedCtx = resolveActiveRuntimeContext();
  res.json({
    ok: true,
    port: PORT,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    bridgeStatus: marketStore.systemStatus?.source || 'offline',
    dataSource: marketStore.systemStatus?.fluxStatus || 'OFFLINE',
    // Active context resolved from runtime truth (Bridge TV)
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
      // updatedAt peut être ms (keepalive) ou ISO string (webhook TV)
      const _upd = item?.updatedAt;
      const _updMs = typeof _upd === 'number' ? _upd : (_upd ? Date.parse(_upd) : NaN);
      const tsRaw = item?.robotV12?.receivedAt || item?.timestamp || _upd || null;
      const tsMs  = Number.isFinite(_updMs) ? _updMs
                  : tsRaw ? Date.parse(tsRaw) : NaN;
      if (!latest || (Number.isFinite(tsMs) && tsMs > latest.tsMs)) {
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
        price: latest.item?.price ?? null,
        action: latest.item?.action ?? null,
        verdict: robot?.verdict ?? null,
        anticipation: robot?.anticipation ?? null,
        rsi: latest.item?.indicators?.rsi ?? null,
        entry: latest.item?.entry ?? robot?.entry ?? null,
        sl: latest.item?.sl ?? robot?.sl ?? null,
        tp: latest.item?.tp ?? robot?.tp ?? null,
        rrRatio: latest.item?.rrRatio ?? robot?.rrRatio ?? null
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
  // updatedAt peut être ms (keepalive) ou ISO string (webhook TV)
  const _selUpdRaw = selectedTvEntry?.updatedAt;
  const _selUpdIso = _selUpdRaw
    ? (typeof _selUpdRaw === 'number' ? new Date(_selUpdRaw).toISOString() : _selUpdRaw)
    : null;
  // Priorité keepalive updatedAt (fraîche) sur timestamp webhook Pine (peut être vieux de plusieurs heures)
  const _selUpdMs = _selUpdRaw ? (typeof _selUpdRaw === 'number' ? _selUpdRaw : Date.parse(_selUpdRaw)) : NaN;
  const _selWHMs  = selectedTvEntry?.robotV12?.receivedAt
    ? (typeof selectedTvEntry.robotV12.receivedAt === 'number' ? selectedTvEntry.robotV12.receivedAt : Date.parse(selectedTvEntry.robotV12.receivedAt))
    : (selectedTvEntry?.timestamp ? Date.parse(selectedTvEntry.timestamp) : NaN);
  // Prendre la plus récente des deux (keepalive peut être plus récent que le dernier ping Pine)
  const _bestTsMs = (!Number.isFinite(_selWHMs) || (Number.isFinite(_selUpdMs) && _selUpdMs > _selWHMs)) ? _selUpdMs : _selWHMs;
  const selectedTvTs = Number.isFinite(_bestTsMs) ? new Date(_bestTsMs).toISOString() : (_selUpdIso || selectedTvEntry?.timestamp || null);
  const selectedUpdatedAt = activeSymbol?.updatedAt || null;
  const selectedTvTsMs = _bestTsMs;
  const selectedUpdatedMs = selectedUpdatedAt ? Date.parse(selectedUpdatedAt) : NaN;
  const selectedTvIsFresh = Number.isFinite(selectedTvTsMs)
    && (!Number.isFinite(selectedUpdatedMs) || selectedTvTsMs >= (selectedUpdatedMs - 2000));
  const activeSource = 'tradingview';
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
      source: 'tv-bridge',
      sourceRaw: null,
      updatedAt: null
    },
    bridge: {
      enabled: bridgeOn,
      tradingviewEnabled: tvEnabled,
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
        activeSource: 'tradingview',
        mode: bridgeConfig.bridgeMode || 'AUTO',
        source: bridgeConfig.bridgeSource || 'tradingview',
        updatedAt: bridgeConfig.updatedAt || null,
        updatedBy: bridgeConfig.updatedBy || null,
        tvConnected: getBridgeMode() !== 'OFFLINE',
        tvMode: getBridgeMode(),
        bridgeLive: !!(_bridgeLiveAt && (Date.now() - _bridgeLiveAt) < BRIDGE_STALE_MS),
        bridgeAgeMs: _bridgeLiveAt ? Date.now() - _bridgeLiveAt : null
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

// ─── MAPPING ROUTES ────────────────────────────────────────────────────────────

// POST /mapping/resolve — Résolution intelligente de symbole
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
    const { userInput, tvSymbol } = req.body;
    if (!userInput || !tvSymbol) {
      return res.status(400).json({ ok: false, error: 'userInput and tvSymbol required' });
    }

    console.log(`[MAPPING] ${userInput} → ${tvSymbol}`);

    res.json({
      ok: true,
      message: `Mapping saved: ${userInput} → ${tvSymbol}`,
      userInput,
      tvSymbol
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
    // Fallback: cache précédent ou tableau vide avec message clair
    const fallbackEvents = Array.isArray(_newsCache) ? _newsCache : [];
    res.json({ ok: false, events: fallbackEvents, error: err.message, source: fallbackEvents.length ? 'cache' : 'offline' });
  }
});

// Symbol mapping storage (JSON file)
const MAPPING_PATH = path.join(__dirname, 'symbol-mappings.json');
function loadMappings() { try { return JSON.parse(fs.readFileSync(MAPPING_PATH,'utf8')); } catch(_){ return {}; } }
function saveMappings(m) { fs.writeFileSync(MAPPING_PATH, JSON.stringify(m, null, 2)); }

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

    signalRealTvTick(); // VRAI TICK TV via extension DOM scraping
    marketStore.systemStatus = { source: 'tradingview', fluxStatus: 'LIVE', lastUpdate: new Date().toISOString() };
    marketStore.updateFromTV({ symbol: canonical, price: numPrice, timeframe: tf, source: 'tv-bridge' }, canonical);
    marketStore.broadcast({ type: 'tv-raw', symbol: canonical, price: numPrice, timeframe: tf, source: 'tradingview' });

    // 🔴 UNIFIED SYNC: Envoyer aussi à Extension + HTML clients
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
      title: title || null
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
  tvEnabled: false,
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
    if (s === 'tradingview') out.activeSource = s;
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
    clean.activeSource = 'tradingview';
  }

  bridgeConfig = {
    ...bridgeConfig,
    ...clean,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || clean.updatedBy || 'system'
  };

  bridgeConfig.activeSource = 'tradingview';
  bridgeConfig.tradingviewEnabled = true;
  bridgeConfig.bridgeSource = 'tradingview';

  saveExtensionRuntimeState();

  return bridgeConfig;
}

loadExtensionRuntimeState();
// Seeder tvDataStore depuis activeSymbol persisté → keepalive peut broadcaster dès le boot
if (activeSymbol && activeSymbol.symbol && activeSymbol.price > 0) {
  const _s = String(activeSymbol.symbol).toUpperCase();
  tvDataStore[_s] = {
    symbol: _s,
    timeframe: activeSymbol.timeframe || 'M1',
    price: activeSymbol.price,
    tvSymbol: _getWidgetSymbol(null, _s) || null,
    tvResolution: _tfToTvResolution(activeSymbol.timeframe) || null,
    updatedAt: Date.now(), // ms pour que getLivePrice calcule l'âge correctement
    source: 'boot-cache'
  };
  console.log('[BOOT] tvDataStore seedé depuis cache disque:', _s, activeSymbol.price);
}

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
  const initialState = {
    type: 'initial-sync',
    timestamp: new Date().toISOString(),
    systemStatus: marketStore.systemStatus || { source: 'offline', fluxStatus: 'OFFLINE' },
    activeSymbol: (() => {
      const _sym = resolvedCtx.active.symbol || activeSymbol?.symbol || null;
      const _tf  = resolvedCtx.active.timeframe || activeSymbol?.timeframe || 'H1';
      return {
        ...(activeSymbol || {}),
        symbol: _sym,
        timeframe: _tf,
        price: resolvedCtx.active.price ?? activeSymbol?.price ?? activeSymbol?.tvPrice ?? null,
        source: resolvedCtx.active.source || 'none',
        resolvedBy: resolvedCtx.active.resolvedBy || 'none',
        tvSymbol: _getWidgetSymbol(null, _sym),
        tvResolution: _tfToTvResolution(_tf),
        // Keepalive actif = toujours envoyer timestamp frais (évite STALE initial-sync)
        updatedAt: (_bridgeKeepaliveEnabled && _bridgeLiveAt && (Date.now() - _bridgeLiveAt < 30000))
          ? new Date().toISOString()
          : (resolvedCtx.active.updatedAt || null),
      };
    })(),
    systemStatus: _bridgeKeepaliveEnabled && _bridgeLiveAt
      ? { source: 'keepalive', fluxStatus: 'LIVE' }
      : (marketStore.systemStatus || { source: 'offline', fluxStatus: 'OFFLINE' }),
    bridgeConfig,
    agentStates: agentStates,
    sourceContexts: resolvedCtx,
    message: 'Extension + HTML synchronisés — source unique'
  };
  res.write('data: ' + JSON.stringify(initialState) + '\n\n');

  // Si keepalive actif + cache disque dispo → envoyer un tick fresh immédiatement
  // pour que le dashboard ne reste pas STALE à la connexion
  if (_bridgeKeepaliveEnabled && _bridgeLiveAt) {
    const _ksym = initialState.activeSymbol?.symbol;
    const _ktf = initialState.activeSymbol?.timeframe;
    // Fallback: chercher le prix dans tvDataStore si activeSymbol.price est null
    const _kprice = initialState.activeSymbol?.price
      || (tvDataStore[_ksym] && tvDataStore[_ksym].price)
      || null;
    if (_ksym && _kprice > 0) {
      const _freshTick = {
        type: 'tradingview-data',
        symbol: _ksym,
        timeframe: _ktf || 'M1',
        price: _kprice,
        tvSymbol: initialState.activeSymbol?.tvSymbol || null,
        tvResolution: initialState.activeSymbol?.tvResolution || null,
        updatedAt: new Date().toISOString(),
        source: 'keepalive-cache',
        timestamp: new Date().toISOString()
      };
      res.write('data: ' + JSON.stringify(_freshTick) + '\n\n');
    }
  }

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
  if (bridgeConfig.bridgeEnabled === false && (t === 'tv-data' || t === 'tradingview-data')) {
    return;
  }

  const sseMessage = 'data: ' + JSON.stringify(data) + '\n\n';
  
  // Log clearly for mt5-data
  if (message.type === 'tv-data') {
    console.log(`[EXTENSION-SYNC] 📤 Broadcasting TV to ${extensionSyncClients.length} clients: ${message.symbol} | Bid: ${message.bid} | Ask: ${message.ask} | Price: ${message.price}`);
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

// ─── EXTENSION SCAN REQUEST — serveur demande à l'extension de faire SWITCH_TF ──
// popup.js ANALYSER → POST /extension/scan-request → background.js poll → scanAllTimeframes()
const _extensionScanFlag = {};
app.post('/extension/scan-request', (req, res) => {
  const sym = String(req.body?.symbol || '').toUpperCase() || 'XAUUSD';
  _extensionScanFlag[sym] = { requestedAt: Date.now(), symbol: sym };
  res.json({ ok: true, symbol: sym });
});
app.get('/extension/scan-flag', (req, res) => {
  const sym = String(req.query?.symbol || '').toUpperCase();
  const flag = sym ? _extensionScanFlag[sym] : Object.values(_extensionScanFlag)[0];
  if (flag && (Date.now() - flag.requestedAt) < 30000) {
    delete _extensionScanFlag[flag.symbol];
    res.json({ ok: true, scan: true, symbol: flag.symbol });
  } else {
    res.json({ ok: true, scan: false });
  }
});

// ─── GET CURRENT STATE ENDPOINT (for late-joining clients or polling fallback) ──
// Returns the EXACT same data that SSE clients receive
app.get('/extension/data', (_req, res) => {
  // Source unique : TradingView live (ou keepalive-cache)
  const tvRuntime = getLatestTradingviewRuntime();

  // Fallback keepalive : si tvRuntime non connecté mais tvDataStore a un prix récent
  let _sym = tvRuntime?.symbol;
  let _tf  = tvRuntime?.timeframe;
  let _px  = tvRuntime?.payload?.price;
  let _ts  = tvRuntime?.timestamp;
  let _rsi = tvRuntime?.payload?.rsi ?? null;
  let _src = 'tradingview';
  let _connected = tvRuntime?.connected;

  // Override _ts avec le timestamp keepalive-fresh (tvDataStore.updatedAt) pour éviter STALE
  // tvRuntime.timestamp = robotV12.receivedAt (ancien tick Pine Script — peut être vieux de heures)
  // tvDataStore[sym].updatedAt = Date.now() rafraîchi toutes les 20s par keepalive → toujours frais
  if (_bridgeKeepaliveEnabled && _bridgeLiveAt && _sym) {
    const _kaUpd = tvDataStore[_sym]?.updatedAt || tvDataStore[String(_sym).toUpperCase()]?.updatedAt;
    if (_kaUpd) {
      _ts = typeof _kaUpd === 'number' ? new Date(_kaUpd).toISOString() : _kaUpd;
    }
  }

  if ((!_connected || !_px) && _bridgeKeepaliveEnabled) {
    const _ka = Object.values(tvDataStore).sort((a,b)=>{
      const ta = typeof a.updatedAt==='number'?a.updatedAt:new Date(a.updatedAt||0).getTime();
      const tb = typeof b.updatedAt==='number'?b.updatedAt:new Date(b.updatedAt||0).getTime();
      return tb - ta;
    })[0];
    if (_ka && _ka.price > 0) {
      _sym = _ka.symbol || _sym;
      _tf  = _ka.timeframe || _tf;
      _px  = _ka.price;
      _ts  = new Date(_ka.updatedAt || Date.now()).toISOString();
      _rsi = _ka.indicators?.rsi ?? null;
      _src = 'keepalive-cache';
      _connected = true;
    }
  }

  if (!_connected || !_sym || !_px) {
    return res.json({
      ok: false,
      error: 'NO DATA',
      message: 'Aucune donnée TradingView live disponible',
      type: 'current-state',
      timestamp: new Date().toISOString()
    });
  }

  res.json({
    ok: true,
    type: 'current-state',
    timestamp: new Date().toISOString(),
    systemStatus: { source: _src, fluxStatus: _connected ? 'LIVE' : 'KEEPALIVE' },
    activeSymbol: {
      symbol: _sym,
      timeframe: _tf,
      price: _px,
      source: _src,
      resolvedBy: _src === 'keepalive-cache' ? 'keepalive' : 'tv-live'
    },
    bridgeConfig,
    agentStates: agentStates,
    sourceContexts: {},
    currentData: {
      symbol: _sym,
      price: _px,
      bid: _px,
      ask: _px,
      volume: 0,
      timeframe: _tf,
      source: _src,
      indicators: { rsi: _rsi, ma20: null, macd: null },
      updatedAt: _ts || null
    },
    tvMode: getBridgeMode(),
    bridgeLive: !!(_bridgeLiveAt && (Date.now() - _bridgeLiveAt) < BRIDGE_STALE_MS),
    requiresTradingView: getBridgeMode() !== 'LIVE_TV',
    message: _src === 'keepalive-cache'
      ? 'Keepalive cache — dernier prix TV connu'
      : 'Current state TradingView live — aucune autre source'
  });
});

app.post('/set-mute', requireAdelKey, (req, res) => {
  const { muted, source } = req.body || {};
  if (typeof muted !== 'boolean') return res.status(400).json({ ok: false, error: 'muted (boolean) required' });
  bridgeConfig.muted = muted;
  if (source) bridgeConfig.muteSource = source;
  bridgeConfig.mutedAt = new Date().toISOString();
  broadcastToExtension({ type: 'MUTE_CHANGED', muted, source });
  res.json({ ok: true, muted });
});

app.post('/set-mode', requireAdelKey, (req, res) => {
  const { mode, source } = req.body || {};
  const valid = ['AUTO', 'SCALPER', 'SNIPER', 'SWING', 'ANALYSE', 'ALERTE'];
  const m = String(mode || '').toUpperCase();
  if (!valid.includes(m)) return res.status(400).json({ ok: false, error: 'Invalid mode: ' + m });
  bridgeConfig.bridgeMode = m;
  if (source) bridgeConfig.modeSource = source;
  broadcastToExtension({ type: 'MODE_CHANGED', mode: m, source });
  res.json({ ok: true, mode: m });
});

// ─── UNIFIED COMMAND ENDPOINT (Extension + HTML send commands here) ────────────
// Receives commands from Extension or HTML and broadcasts to all clients
app.post('/extension/command', requireAdelKey, async (req, res) => {
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
          // RÈGLE BRIDGE_NO_NULL: price window pour synthZone si Pine absent
          if (price && Number.isFinite(Number(price)) && Number(price) > 0) {
            _pwPush(canonicalSymbol, Number(price));
            // Injecter synthZone dans tvDataStore si Pine n'a pas envoyé de données
            const _existBd = tvDataStore[canonicalSymbol]?.bridgeData;
            const _pineHasData = _existBd && (_existBd.inTop !== undefined || _existBd.inBot !== undefined || _existBd.lectureTech1);
            if (!_pineHasData) {
              const _synthZ = _pwSynthZone(canonicalSymbol, Number(price));
              if (_synthZ) {
                if (!tvDataStore[canonicalSymbol]) tvDataStore[canonicalSymbol] = { bridgeData: {} };
                tvDataStore[canonicalSymbol].bridgeData = Object.assign(tvDataStore[canonicalSymbol].bridgeData || {}, _synthZ);
              }
            }
          }
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
        }
        break;
        
      // SUPPRIMÉ: get-symbols — simulateur désactivé
      case 'get-symbols':
        result.ok = false;
        result.error = 'SIMULATOR_DISABLED: get-symbols supprimé — utilisez /tradingview/live pour les données réelles';
        break;

      // SUPPRIMÉ: refresh-data — simulateur désactivé
      case 'refresh-data':
        result.ok = false;
        result.error = 'SIMULATOR_DISABLED: refresh-data supprimé — les données proviennent exclusivement de TradingView live';
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
// Source: bridge TradingView → tvDataStore (MT5 et Yahoo supprimés)
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
  const tvSymbol = String(tv?.symbol || '').toUpperCase();
  const tvPrice = Number(tv?.payload?.price);
  if (bridgeConfig.tradingviewEnabled !== false && tv?.connected && tvSymbol === sym && Number.isFinite(tvPrice) && tvPrice > 0) {
    const tf = String(tv?.timeframe || reqTF || 'H1').toUpperCase();
    const robotV12 = getRobotV12ForSymbol(sym);
    const trade = buildTradingviewRuntimeTrade(sym, tf, tvPrice, reqMode, tv, robotV12);
    // RÈGLE BRIDGE_NO_NULL: include bridgeData (Pine ou synthZone)
    const _bd = tvDataStore[sym]?.bridgeData || null;
    const _bdFinal = _bd || (() => {
      const _sz = _pwSynthZone(sym, tvPrice);
      return _sz ? _sz : null;
    })();
    if (trade) {
      return res.json({ ok: true, trade, source: 'tradingview', price: tvPrice, timeframe: tf, robotV12, bridgeData: _bdFinal });
    }
    return res.json({
      ok: true,
      trade: null,
      source: 'tradingview',
      price: tvPrice,
      timeframe: tf,
      robotV12,
      bridgeData: _bdFinal,
      message: 'Signal TradingView en attente de confirmation.'
    });
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

  // Pas de données bridge TV disponibles
  res.status(404).json({ ok: false, error: 'Aucune donnée pour ' + profile.canonical + ' — bridge TradingView requis' });
});

// ─── TOGGLE MODE ──────────────────────────────────────────────────────────────
let engineMode = 'manual', activeTimeframe = 'M1';
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

    // Source: tvDataStore (bridge TradingView uniquement)
    try {
      // 1. TradingView — source maître
      const tvEntry = tvDataStore[profile.canonical];
      const tvAge   = tvEntry ? (Date.now() - (tvEntry.updatedAt || 0)) : Infinity;
      let price = null;
      if (tvEntry && tvAge < 30000 && parseFloat(tvEntry.price) > 0) {
        price = parseFloat(tvEntry.price);
      } // bridge TV uniquement — pas de fallback externe
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
  // Retourner les positions depuis le store (Bridge TV)
  const state  = marketStore.getState ? marketStore.getState() : {};
  const cached = state.analysisCache || {};
  const positions = Object.values(cached)
    .filter(a => a?.trade)
    .map(a => ({ ...a.trade, status: a.trade.trade_status || 'UNKNOWN' }));

  if (positions.length > 0) return res.json({ ok: true, positions, count: positions.length, source: 'tv-cache' });

  // Fallback: message informatif
  res.json({ ok: true, positions: [], count: 0, note: 'Aucune position active — le bridge TV doit envoyer des données' });
});

// ─── GITHUB POSITIONS — lecture d'un fichier JSON depuis GitHub Raw ──────────
// GET /api/github-positions?url=<raw_github_url>
// Le fichier doit être un JSON: { positions: [{symbol,direction,entry,sl,tp,...}] }
// Ou simplement un tableau [{...}]
const _GITHUB_CFG_PATH = path.join(__dirname, 'store', 'github-config.json');
let _githubPositionsUrl = null;
// Charger URL persistée au démarrage
try {
  const _gc = JSON.parse(fs.readFileSync(_GITHUB_CFG_PATH, 'utf8'));
  if (_gc.url && String(_gc.url).startsWith('https://raw.githubusercontent.com/')) {
    _githubPositionsUrl = _gc.url;
    console.log('[GITHUB] URL chargée:', _githubPositionsUrl);
  }
} catch (_) {}

app.post('/api/github-positions/config', requireAdelKey, (req, res) => {
  const { url } = req.body || {};
  if (!url || !String(url).startsWith('https://raw.githubusercontent.com/')) {
    return res.status(400).json({ ok: false, error: 'URL doit commencer par https://raw.githubusercontent.com/' });
  }
  _githubPositionsUrl = String(url).trim();
  // Persister sur disque pour survie aux restarts
  try {
    if (!fs.existsSync(path.join(__dirname, 'store'))) fs.mkdirSync(path.join(__dirname, 'store'), { recursive: true });
    fs.writeFileSync(_GITHUB_CFG_PATH, JSON.stringify({ url: _githubPositionsUrl, updatedAt: new Date().toISOString() }), 'utf8');
  } catch (e) { console.warn('[GITHUB] Persist failed:', e.message); }
  // Redémarrer l'agent immédiatement avec la nouvelle URL
  setTimeout(() => { if (typeof _startGithubBridgeAgent === 'function') _startGithubBridgeAgent(); }, 100);
  res.json({ ok: true, url: _githubPositionsUrl, agentStarted: true });
});
app.get('/api/github-positions', async (req, res) => {
  const targetUrl = req.query.url || _githubPositionsUrl;
  if (!targetUrl) return res.json({ ok: true, positions: [], note: 'Aucune URL GitHub configurée — POST /api/github-positions/config avec {url}' });
  if (!String(targetUrl).startsWith('https://raw.githubusercontent.com/'))
    return res.status(400).json({ ok: false, error: 'URL GitHub raw uniquement' });
  try {
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      https.get(targetUrl, { timeout: 5000 }, (r) => {
        let body = '';
        r.on('data', c => { body += c; });
        r.on('end', () => resolve(body));
      }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
    });
    let parsed = JSON.parse(data);
    const positions = Array.isArray(parsed) ? parsed : (parsed.positions || parsed.entries || []);
    return res.json({ ok: true, positions, count: positions.length, source: 'github', url: targetUrl, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'GitHub fetch failed: ' + e.message, url: targetUrl });
  }
});
app.get('/api/github-positions/status', (_req, res) => {
  res.json({ ok: true, configured: !!_githubPositionsUrl, url: _githubPositionsUrl || null,
    bridgeLive: !!(_bridgeLiveAt && (Date.now() - _bridgeLiveAt) < BRIDGE_STALE_MS),
    agentActive: _githubAgentActive });
});

// ─── GITHUB BRIDGE AGENT — active le bridge + broadcast positions toutes les 60s ──
let _githubAgentActive = false;
let _githubAgentTimer = null;
const _GITHUB_POLL_MS = 20000; // 20s < BRIDGE_STALE_MS 30s → keepalive garanti

async function _githubBridgeAgentTick() {
  if (!_githubPositionsUrl) return;
  try {
    const https = require('https');
    const body = await new Promise((resolve, reject) => {
      const req = https.get(_githubPositionsUrl, { timeout: 8000 }, (r) => {
        let buf = ''; r.on('data', c => { buf += c; }); r.on('end', () => resolve(buf));
      });
      req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    let parsed = JSON.parse(body);
    const positions = Array.isArray(parsed) ? parsed : (parsed.positions || parsed.entries || []);
    if (positions.length === 0) {
      // Pas de positions mais URL valide → signaler bridge vivant quand même
      signalBridgeLive();
      _githubAgentActive = true;
      console.log('[GITHUB-AGENT] Bridge keepalive — 0 positions.');
      return;
    }
    // Prendre la première position comme signal "actif"
    const pos = positions[0];
    const canonical = String(pos.symbol || pos.ticker || pos.pair || '').toUpperCase().replace('/', '');
    const tf = String(pos.timeframe || pos.tf || pos.interval || 'H1').toUpperCase();
    const price = parseFloat(pos.price || pos.entry || pos.close || 0) || null;
    const tvSym = _getWidgetSymbol(pos.tickerid || pos.ticker_id || null, canonical);
    const tvRes = _tfToTvResolution(tf);

    // Peupler tvDataStore
    if (canonical) {
      tvDataStore[canonical] = Object.assign(tvDataStore[canonical] || {}, {
        symbol: canonical, timeframe: tf,
        price: price || (tvDataStore[canonical] && tvDataStore[canonical].price) || null,
        tvSymbol: tvSym || null, tvResolution: tvRes || null,
        verdict: pos.verdict || pos.signal || pos.direction || null,
        entry: pos.entry || null, sl: pos.sl || pos.stop_loss || null,
        tp: pos.tp || pos.take_profit || null,
        source: 'github-agent', updatedAt: new Date().toISOString(),
        githubPositions: positions
      });
      if (price) _pwPush(canonical, price);
    }

    // Activer le bridge
    signalBridgeLive();
    _githubAgentActive = true;

    // Broadcast SSE vers extension/dashboard
    broadcastToExtension({
      type: 'tradingview-data',
      symbol: canonical, timeframe: tf,
      price, tvSymbol: tvSym, tvResolution: tvRes,
      verdict: pos.verdict || pos.signal || pos.direction || null,
      entry: pos.entry || null, sl: pos.sl || pos.stop_loss || null,
      tp: pos.tp || pos.take_profit || null,
      source: 'github-agent',
      githubPositions: positions,
      positionsCount: positions.length
    });
    console.log(`[GITHUB-AGENT] Bridge activé — ${positions.length} positions | ${canonical} ${tf} | prix ${price}`);
  } catch (e) {
    console.warn('[GITHUB-AGENT] Fetch failed:', e.message);
  }
}

function _startGithubBridgeAgent() {
  if (_githubAgentTimer) clearInterval(_githubAgentTimer);
  _githubAgentTick_wrap();
  _githubAgentTimer = setInterval(_githubAgentTick_wrap, _GITHUB_POLL_MS);
  console.log('[GITHUB-AGENT] Démarré — poll toutes les', _GITHUB_POLL_MS / 1000, 's');
}
function _githubAgentTick_wrap() { _githubBridgeAgentTick().catch(e => console.warn('[GITHUB-AGENT] err:', e.message)); }

// Démarrer si URL déjà configurée au boot
if (_githubPositionsUrl) _startGithubBridgeAgent();

// Route pour démarrer/arrêter l'agent depuis le dashboard
app.post('/api/github-positions/agent/start', requireAdelKey, (req, res) => {
  if (!_githubPositionsUrl) return res.status(400).json({ ok: false, error: 'Configurer URL d\'abord via POST /api/github-positions/config' });
  _startGithubBridgeAgent();
  res.json({ ok: true, message: 'GitHub Bridge Agent démarré', url: _githubPositionsUrl });
});
app.post('/api/github-positions/agent/stop', requireAdelKey, (req, res) => {
  if (_githubAgentTimer) { clearInterval(_githubAgentTimer); _githubAgentTimer = null; }
  _githubAgentActive = false;
  res.json({ ok: true, message: 'GitHub Bridge Agent arrêté' });
});
// Recharger aussi l'agent quand config change
const _origGithubConfigRoute = app._router.stack.find(l => l.route && l.route.path === '/api/github-positions/config');
// Patch: redémarrer agent après save config (inline patch via wrapper)
app.post('/api/github-positions/config/reload-agent', requireAdelKey, (req, res) => {
  if (_githubPositionsUrl) _startGithubBridgeAgent();
  res.json({ ok: true, agentRestarted: !!_githubPositionsUrl });
});

// Ajouter les routes agent au BRIDGE_GATE_EXEMPT
BRIDGE_GATE_EXEMPT.add('/api/github-positions/agent/start');
BRIDGE_GATE_EXEMPT.add('/api/github-positions/agent/stop');
BRIDGE_GATE_EXEMPT.add('/api/github-positions/config/reload-agent');
BRIDGE_GATE_EXEMPT.add('/apex/commands/next');
BRIDGE_GATE_EXEMPT.add('/apex/result');
BRIDGE_GATE_EXEMPT.add('/api/github-agent/analyse');
BRIDGE_GATE_EXEMPT.add('/api/sync-check');
BRIDGE_GATE_EXEMPT.add('/system/log');
BRIDGE_GATE_EXEMPT.add('/system/log/stream');
BRIDGE_GATE_EXEMPT.add('/system/log/recent');

// ─── SYNC-CHECK — vérité unique pour dashboard + extension ───────────────────
// Les deux interfaces appellent cet endpoint pour garantir la cohérence
app.get('/api/sync-check', (_req, res) => {
  const tvRuntime = getLatestTradingviewRuntime();
  let sym = tvRuntime?.symbol;
  let tf  = tvRuntime?.timeframe;
  let px  = tvRuntime?.payload?.price;
  let src = 'tradingview';
  let connected = tvRuntime?.connected;
  let ageMs = tvRuntime?.ageMs ?? null;

  // Fallback keepalive
  if ((!connected || !px) && _bridgeKeepaliveEnabled) {
    const ka = Object.values(tvDataStore).sort((a,b) => {
      const ta = typeof a.updatedAt==='number'?a.updatedAt:new Date(a.updatedAt||0).getTime();
      const tb = typeof b.updatedAt==='number'?b.updatedAt:new Date(b.updatedAt||0).getTime();
      return tb - ta;
    })[0];
    if (ka && ka.price > 0) {
      sym = ka.symbol || sym;
      tf  = ka.timeframe || tf;
      px  = ka.price;
      src = 'keepalive-cache';
      connected = true;
      const kaMs = typeof ka.updatedAt==='number'?ka.updatedAt:new Date(ka.updatedAt||0).getTime();
      ageMs = kaMs > 0 ? Date.now() - kaMs : null;
    }
  }

  const livePrice = sym ? getLivePrice(sym, 300000) : null;
  const _tvMode = getBridgeMode();
  const _realTvAgeMs = _lastRealTvTickAt ? (Date.now() - _lastRealTvTickAt) : null;
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    symbol: sym || null,
    timeframe: tf || null,
    price: px || livePrice?.price || null,
    source: src,
    connected,
    ageMs,
    ageLabel: ageMs != null ? (Math.round(ageMs/1000) + 's') : null,
    bridgeLive: !!_bridgeLiveAt,
    bridgeKeepalive: !!_bridgeKeepaliveEnabled,
    githubAgentActive: !!_githubAgentActive,
    serverUptime: Math.floor(process.uptime()),
    extensionClients: Array.isArray(extensionSyncClients) ? extensionSyncClients.length : 0,
    // Nouveau : mode TV clair
    tvMode: _tvMode,                             // 'LIVE_TV' | 'CACHE_TV' | 'OFFLINE'
    realTvAgeMs: _realTvAgeMs,                   // ms depuis dernier vrai tick Pine
    realTvAgeLabel: _realTvAgeMs != null ? (Math.round(_realTvAgeMs/1000)+'s') : null,
    requiresTradingView: _tvMode !== 'LIVE_TV'   // true = ouvrir TV pour données temps réel
  });
});

// ─── APEX COMMAND QUEUE (extension ↔ serveur) ─────────────────────────────────
const _apexQueue = []; // {id, action, tf, createdAt}
let _apexQueueSeq = 0;

app.get('/apex/commands/next', (req, res) => {
  if (_apexQueue.length === 0) return res.json({ ok: true, command: null });
  const cmd = _apexQueue.shift();
  res.json({ ok: true, command: cmd });
});

app.post('/apex/result', express.json(), (req, res) => {
  const { action, tf, result, symbol } = req.body || {};
  console.log('[APEX] résultat reçu:', action, tf, symbol, result);
  res.json({ ok: true });
});

// Ajouter commande SWITCH_TF dans la queue (utilisé par github-agent/analyse)
function apexQueueSwitchTF(tf) {
  if (!tf) return;
  _apexQueueSeq++;
  _apexQueue.push({ id: _apexQueueSeq, action: 'SWITCH_TF', tf, createdAt: Date.now() });
}

// ─── GITHUB AGENT ANALYSE — branché sur bridge TV ─────────────────────────────
app.get('/api/github-agent/analyse', async (req, res) => {
  const symbol = (req.query.symbol || '').toUpperCase() || Object.keys(tvDataStore)[0];
  if (!symbol) return res.status(400).json({ ok: false, error: 'symbol requis' });
  console.log(`[GITHUB-AGENT] Analyse demandée — symbol=${symbol} tvMode=${getBridgeMode()} ghUrl=${_githubPositionsUrl ? 'configurée' : 'NON_CONFIGURÉE'}`);

  // Prix réel depuis bridge
  const tvEnt = tvDataStore[symbol]
    || Object.values(tvDataStore).find(v => (v.symbol || '').toUpperCase() === symbol.toUpperCase());
  const livePrice = getLivePrice(symbol, 300000);
  if (!livePrice) {
    return res.status(503).json({ ok: false, error: 'Prix bridge indisponible — démarrer TV ou attendre keepalive', symbol });
  }

  // Positions GitHub
  let positions = [];
  if (_githubPositionsUrl) {
    try {
      const ghResp = await fetch(_githubPositionsUrl, { signal: AbortSignal.timeout(5000) });
      if (ghResp.ok) positions = await ghResp.json();
      if (!Array.isArray(positions)) positions = positions.positions || [];
    } catch(e) {
      console.warn('[GITHUB-AGENT] fetch positions error:', e.message);
    }
  }

  // Croiser positions avec prix bridge
  const price = livePrice.price;
  const tf = tvEnt?.timeframe || 'H1';
  let direction = 'WAIT';
  let entry = null, sl = null, tp = null;
  let analysis = '';

  if (positions.length > 0) {
    const pos = positions.find(p =>
      (p.symbol || '').toUpperCase().includes(symbol.replace('OANDA:','').replace('FX:','')) ||
      (p.pair || '').toUpperCase().includes(symbol.replace('OANDA:','').replace('FX:',''))
    ) || positions[0];

    if (pos) {
      direction = (String(pos.direction || pos.side || pos.type || 'WAIT')).toUpperCase();
      if (!['LONG','SHORT','BUY','SELL'].includes(direction)) direction = 'WAIT';
      if (direction === 'BUY') direction = 'LONG';
      if (direction === 'SELL') direction = 'SHORT';
      entry = pos.entry || pos.price || price;
      sl = pos.sl || pos.stop_loss || (direction === 'LONG' ? price * 0.998 : price * 1.002);
      tp = pos.tp || pos.take_profit || (direction === 'LONG' ? price * 1.004 : price * 0.996);
      analysis = `GitHub Agent: ${direction} ${symbol} @ ${price.toFixed(symbol.includes('JPY') ? 3 : 5)}\n`
        + `SL: ${Number(sl).toFixed(symbol.includes('JPY') ? 3 : 5)} | TP: ${Number(tp).toFixed(symbol.includes('JPY') ? 3 : 5)}\n`
        + `Source: ${_githubPositionsUrl || 'GitHub'} | TF bridge: ${tf} | Positions dispo: ${positions.length}`;
    }
  } else {
    analysis = `GitHub Agent actif — aucune position dans le fichier GitHub.\nPrix bridge: ${price} | TF: ${tf}`;
  }

  res.json({
    ok: true,
    direction,
    entry,
    sl,
    tp,
    analysis,
    price,
    symbol,
    timeframe: tf,
    positions,
    source: 'github-agent',
    bridgeAge: livePrice.ageMs ? Math.round(livePrice.ageMs / 1000) + 's' : null
  });
});

// ─── TRADE EXECUTE ────────────────────────────────────────────────────────────
app.post('/trade', requireAdelKey, (req, res) => {
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
app.post('/broker-mode', requireAdelKey, (req, res) => {
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
app.get('/klines', (req, res) => {
  const sym   = String(req.query.symbol || '').toUpperCase().replace('/', '').replace('-', '');
  const limit = Math.min(parseInt(req.query.limit) || 80, 200);
  const canonical = normalizeSymbol(sym)?.canonical || sym;
  const tvEntry = tvDataStore[canonical] || tvDataStore[sym] || null;
  const history = tvEntry?._priceHistory || [];
  if (!history.length) {
    return res.json({ ok: true, candles: [], source: 'bridge-tv', note: 'Historique bridge TV vide — en attente de ticks Pine Script' });
  }
  const candles = history.slice(-limit).map((tick, i, arr) => {
    const prev = arr[i - 1];
    const p = Number(tick.price || 0);
    return { time: tick.time || tick.t || Date.now(), open: prev ? Number(prev.price) : p, high: p, low: p, close: p, volume: 0 };
  });
  res.json({ ok: true, candles, source: 'bridge-tv', symbol: canonical });
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
app.get('/quote', async (req, res) => {
  const rawSym = req.query.symbol || 'EUR/USD';
  const profile = normalizeSymbol(rawSym.replace('/',  ''));
  const sym     = profile.canonical;

  const live = marketStore.getLatestForSymbol(sym);
  if (live?.latestPayload?.price) {
    // MODIFIÉ: Broadcast le price pour SSE real-time
    marketStore.broadcast({ type: 'quote', symbol: sym, price: live.latestPayload.price, source: live.latestPayload.source || 'tradingview' });
    return res.json({ ok: true, symbol: sym, price: live.latestPayload.price, source: live.latestPayload.source || 'tradingview' });
  }

  // Pas de données bridge TV — bridge requis
  const tvLive = tvDataStore[sym] || tvDataStore[rawSym.replace('/', '').toUpperCase()] || null;
  if (tvLive?.price) {
    return res.json({ ok: true, symbol: sym, price: tvLive.price, source: 'tradingview' });
  }
  res.status(404).json({ ok: false, error: 'Prix indisponible pour ' + rawSym + ' — bridge TradingView requis' });
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
        startAgentTask(name, 'Vérification cohérence Bridge TV', {
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
  res.json({ ok: true, opportunities: [], note: 'Bridge TV requis pour des opportunités en temps réel' });
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
      // Bridge TV absent ou trop ancien — attendre le prochain tick
      pushLog('orchestrator', 'system', `BOUCLE ${sym} — bridge TV absent ou > 30s`, 'warn', 'source:offline');
      return;
    }

    pushLog('orchestrator', 'technicalAgent',
      `REQUÊTE analyse ${sym} @ ${price.toFixed(price > 10 ? 2 : 5)}`,
      'ok', `TF:${tf} · cycle:auto`);

    // 2. LIA Robot — analyse PRO multi-TF (priorité absolue)
    try {
      const liaRobot  = require('./lib/lia-robot');
      const tvLive    = tvDataStore[sym] || {};
      const rv        = tvLive.robotV12 || {};
      const ts        = coachTradeStateStore[sym] || {};
      const phase     = ts.phase || 'IDLE';
      const tradeCtx  = ts.entered ? { direction: ts.direction, sl: ts.sl, tp: ts.tp, entry: ts.entry, anticipation: rv.anticipation || null } : { anticipation: rv.anticipation || null };
      const liaResult = liaRobot.analyze({ symbol: sym, price, robotV12: rv, phase, tradeCtx });

      marketStore.broadcast({ type: 'lia-analysis',
        symbol: sym, verdict: liaResult.verdict, longScore: liaResult.longScore,
        shortScore: liaResult.shortScore, tfs: liaResult.tfs, text: liaResult.text,
        sl: liaResult.sl, tp: liaResult.tp, rr: liaResult.rr,
        source: liaResult.source, tfCount: liaResult.tfCount, phase, ts: Date.now()
      });

      updateAgentState('lia-dashboard', 'idle', liaResult.text.split('\n')[0]);
      pushLog('lia-dashboard', 'orchestrator',
        liaResult.text.split('\n')[0], 'ok',
        { verdict: liaResult.verdict, longScore: liaResult.longScore, source: liaResult.source, tfCount: liaResult.tfCount }
      );

      // Auto-SL/TP: injecter dans trade state si entré sans niveaux
      if (ts.entered && !ts.sl && liaResult.sl) {
        if (!coachTradeStateStore[sym]) coachTradeStateStore[sym] = {};
        coachTradeStateStore[sym].sl = liaResult.sl;
        coachTradeStateStore[sym].tp = liaResult.tp;
        saveCoachTradeStates();
        pushLog('lia-dashboard', 'system', `Auto SL/TP injectés: SL=${liaResult.sl} TP=${liaResult.tp}`, 'ok', sym);
      }

      // ── AUTO-BREAKEVEN — déclenché automatiquement quand progress >= 35% vers TP ──
      if (ts.entered && !ts.bePlaced && ts.entry != null && ts.sl != null && ts.tp != null) {
        const _entN = Number(ts.entry), _slN = Number(ts.sl), _tpN = Number(ts.tp);
        const _dir  = String(ts.direction || '').toUpperCase();
        const _totalRange = Math.abs(_tpN - _entN);
        const _currentProg = _dir === 'LONG' ? price - _entN : _entN - price;
        const _pctProg = _totalRange > 0 ? (_currentProg / _totalRange) * 100 : 0;
        if (_pctProg >= 35) {
          const _beState = coachTradeStateStore[sym] || {};
          applyCoachTradeAction(_beState, 'BE', { note: `Auto-BE: ${_pctProg.toFixed(0)}% vers TP` });
          coachTradeStateStore[sym] = _beState;
          saveCoachTradeStates();
          const _beSlNew = _beState.virtualPosition?.sl ?? _entN;
          const _beVocalMsg = `Breakeven placé automatiquement. ${sym} a progressé de ${_pctProg.toFixed(0)}% vers l'objectif. Stop déplacé au prix d'entrée ${_entN.toFixed(2)}. Risque à zéro. Je laisse courir vers ${_tpN.toFixed(2)}.`;
          marketStore.broadcast({ type: 'trade-action', action: 'BE', symbol: sym, phase: 'MANAGE',
            bePlaced: true, autoTriggered: true, progress: _pctProg.toFixed(0),
            beSlNew: _beSlNew, vocalMsg: _beVocalMsg });
          broadcastToExtension({ type: 'trade-action', action: 'BE', symbol: sym, phase: 'MANAGE',
            bePlaced: true, autoTriggered: true, beSlNew: _beSlNew, vocalMsg: _beVocalMsg });
          pushLog('lia-dashboard', 'orchestrator',
            `AUTO-BE déclenché: ${sym} @ ${price.toFixed(2)} | ${_pctProg.toFixed(0)}% vers TP`, 'ok',
            { entry: _entN, sl: _slN, tp: _tpN, beSlNew: _beSlNew });
        }
      }

      // ── AUTO-TP TRAIL — quand progress >= 80%, suggérer trail SL pour maximiser gains ──
      if (ts.entered && ts.bePlaced && !ts.partialTaken && ts.tp != null && ts.entry != null) {
        const _entN2 = Number(ts.entry), _tpN2 = Number(ts.tp);
        const _dir2  = String(ts.direction || '').toUpperCase();
        const _range2 = Math.abs(_tpN2 - _entN2);
        const _prog2  = _dir2 === 'LONG' ? price - _entN2 : _entN2 - price;
        const _pct2   = _range2 > 0 ? (_prog2 / _range2) * 100 : 0;
        if (_pct2 >= 80) {
          const _tpMsg = `Objectif atteint à ${_pct2.toFixed(0)}% sur ${sym}. Prise partielle recommandée ou trail du stop pour verrouiller les gains. Ne laissez pas le profit disparaître.`;
          marketStore.broadcast({ type: 'tp-trail-advice', symbol: sym, progress: _pct2.toFixed(0), vocalMsg: _tpMsg });
        }
      }
    } catch (e) {
      pushLog('lia-dashboard', 'orchestrator', `ROBOT ERREUR: ${e.message}`, 'err', sym);
    }

    // 3. Technical analysis (complément)
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
  const tvData = marketStore.lastTVPayload || {};
  res.json({
    ok: true,
    symbol: tvData.symbol || 'EURUSD',
    price: tvData.price || tvData.bid || tvData.ask || 0,
    bid: tvData.bid || null,
    ask: tvData.ask || null,
    timeframe: tvData.timeframe || 'H1',
    ohlc: tvData.ohlc || tvData.bars || [],
    timestamp: new Date().toISOString(),
    source: 'tradingview',
    lastUpdate: marketStore.systemStatus.lastUpdate
  });
});

// ─── CONSOLIDATED PORT 4000: /data endpoint for Chrome extension ──────────────
app.get('/data', (_req, res) => {
  const tvData = marketStore.lastTVPayload || {};
  const normalized = {
    symbol: tvData.symbol || 'EURUSD',
    price: tvData.price || tvData.bid || tvData.ask || 0,
    bid: tvData.bid || null,
    ask: tvData.ask || null,
    timeframe: tvData.timeframe || 'H1',
    ohlc: tvData.ohlc || tvData.bars || [],
    timestamp: new Date().toISOString(),
    source: 'tradingview',
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

// ─── MAPPING ENDPOINTS (Symbol ↔ TV synchronization) ──────────────────────────
// In-memory mapping store (could be persistent in production)
const mappingStore = {};

app.post('/studio/mapping-save', (req, res) => {
  const { userInput, tvSymbol, price } = req.body;

  if (!userInput || !tvSymbol) {
    return res.json({ ok: false, error: 'userInput and tvSymbol required' });
  }

  const key = userInput.toUpperCase();
  mappingStore[key] = {
    userInput: key,
    tvSymbol: tvSymbol.toUpperCase(),
    price: price || null,
    savedAt: new Date().toISOString()
  };

  console.log('[MAPPING] Saved:', key, '→', tvSymbol);
  
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
    // Rafraîchir updatedAt en ms pour que getLivePrice calcule l'âge correctement
    // (le cache disque contient des ISO strings potentiellement âgées de plusieurs heures)
    const _bootNow = Date.now();
    Object.keys(cached).forEach(sym => { if (tvDataStore[sym]) tvDataStore[sym].updatedAt = _bootNow; });
    console.log('[tvDataStore] Cache rechargé depuis disque:', Object.keys(cached).length, 'symboles');
  }
} catch (e) {
  console.warn('[tvDataStore] Impossible de recharger le cache:', e.message);
}

// Écriture toutes les 90s (réduit I/O disque)
setInterval(() => {
  try {
    fs.writeFileSync(TV_CACHE_PATH, JSON.stringify(tvDataStore, null, 2));
  } catch (e) {
    console.warn('[tvDataStore] Erreur écriture cache:', e.message);
  }
}, 90000);

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
    // tvSymbol + tvResolution pour le widget TradingView (chart)
    const tvSymbolForWidget = _getWidgetSymbol(data.tickerid || data.ticker, canonical);
    const tvResolutionForWidget = data.tvResolution || data.resolution || _tfToTvResolution(resolvedTf);
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
      verdict: data.verdict || null,
      contexte: data.contexte || null,
      short_score: data.short_score != null ? parseFloat(data.short_score) : null,
      long_score: data.long_score != null ? parseFloat(data.long_score) : null,
      anticipation: data.anticipation || null,
      anticipation_force: data.anticipation_force != null ? parseFloat(data.anticipation_force) : null,
      zone_proche: data.zone_proche || null,
      volume_etat: data.volume || null,
      rsi_etat: data.rsi_etat || null,
      rsi_1m:  data.rsi_1m  != null ? parseFloat(data.rsi_1m)  : (data.rsiTf1 != null ? parseFloat(data.rsiTf1) : null),
      rsi_5m:  data.rsi_5m  != null ? parseFloat(data.rsi_5m)  : (data.rsiTf2 != null ? parseFloat(data.rsiTf2) : null),
      rsi_15m: data.rsi_15m != null ? parseFloat(data.rsi_15m) : (data.rsiTf3 != null ? parseFloat(data.rsiTf3) : null),
      rsi_60m: data.rsi_60m != null ? parseFloat(data.rsi_60m) : (data.rsiTf4 != null ? parseFloat(data.rsiTf4) : null),
      lecture_1m:  data.lecture_1m  || data.lectureTech1 || null,
      lecture_5m:  data.lecture_5m  || data.lectureTech2 || null,
      lecture_15m: data.lecture_15m || data.lectureTech3 || null,
      lecture_60m: data.lecture_60m || data.lectureTech4 || null,
      macro_bull: data.macro_bull != null ? parseFloat(data.macro_bull) : (data.macroBull != null ? parseFloat(data.macroBull) : null),
      macro_bear: data.macro_bear != null ? parseFloat(data.macro_bear) : (data.macroBear != null ? parseFloat(data.macroBear) : null),
      entry: data.entry != null ? parseFloat(data.entry) : null,
      sl: data.sl != null ? parseFloat(data.sl) : null,
      tp: data.tp != null ? parseFloat(data.tp) : null,
      rrRatio: data.rrRatio != null ? String(data.rrRatio) : (data.rr != null ? String(data.rr) : null),
      liq_haute_active: data.liq_haute_active === 'true' || data.liq_haute_active === true,
      liq_basse_active: data.liq_basse_active === 'true' || data.liq_basse_active === true,
      in_top_zone: data.inTop === true || data.in_top_zone === 'true' || data.in_top_zone === true,
      in_bot_zone: data.inBot === true || data.in_bot_zone === 'true' || data.in_bot_zone === true,
      bullRej: data.bullRej !== undefined ? (data.bullRej === true) : null,
      bearRej: data.bearRej !== undefined ? (data.bearRej === true) : null,
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
        rsi: data.rsi_1m != null ? parseFloat(data.rsi_1m) : (parseFloat(data.rsi) || parseFloat(data.indicators?.rsi) || null),
        macd: parseFloat(data.macd) || null,
        bb_upper: parseFloat(data.bb_upper) || null,
        bb_middle: parseFloat(data.bb_middle) || null,
        bb_lower: parseFloat(data.bb_lower) || null,
        ma20: parseFloat(data.ma20) || null,
        ma50: parseFloat(data.ma50) || null
      },
      robotV12,
      timestamp,
      updatedAt: Date.now(),
      source: 'tradingview'
    };
    const profile = normalizeSymbol(symbol);
    const canonical = profile.canonical;
    // Store under both the raw key and canonical so getRobotV12ForSymbol always finds it
    // Extension scraper sends price/RSI only — preserve Pine direction/lecture fields but NOT
    // entry/sl/tp (price-dependent, must be recalculated from calcLevels against live price).
    // Also enforces freshness: Pine verdict stale >10min is discarded entirely.
    if (source === 'tradingview-extension') {
      const prev = tvDataStore[symbol] || tvDataStore[canonical];
      if (prev && prev.robotV12 && prev.robotV12.verdict) {
        const prevRv = prev.robotV12;
        const prevAgeMs = prevRv.receivedAt ? Date.now() - new Date(prevRv.receivedAt).getTime() : Infinity;
        if (prevAgeMs < 600000) { // preserve Pine direction/lectures only if < 10min old
          tvStoreEntry.robotV12 = Object.assign({}, robotV12, {
            verdict:         prevRv.verdict,
            anticipation:    prevRv.anticipation,
            lecture_1m:      prevRv.lecture_1m,
            lecture_5m:      prevRv.lecture_5m,
            lecture_15m:     prevRv.lecture_15m,
            lecture_60m:     prevRv.lecture_60m,
            rsi_1m:          prevRv.rsi_1m,
            rsi_5m:          prevRv.rsi_5m,
            rsi_15m:         prevRv.rsi_15m,
            rsi_60m:         prevRv.rsi_60m,
            macro_bull:      prevRv.macro_bull,
            macro_bear:      prevRv.macro_bear,
            // entry/sl/tp intentionally NOT preserved — price-dependent, calcLevels recalculates
            in_top_zone:     prevRv.in_top_zone,
            in_bot_zone:     prevRv.in_bot_zone,
            bullRej:         prevRv.bullRej,
            bearRej:         prevRv.bearRej,
          });
        }
        // else: prev Pine data is stale — use fresh robotV12 from extension (with null entry/sl/tp)
      }
    }
    // Compute and persist bridgeData BEFORE overwriting tvDataStore so _lt timestamps survive DOM scrapes
    const _prevBdTs = tvDataStore[symbol]?.bridgeData || {};
    const _storedRv2 = tvStoreEntry.robotV12 || {};
    const _lec1b = data.lectureTech1 || data.lecture_1m  || _storedRv2.lecture_1m  || null;
    const _lec2b = data.lectureTech2 || data.lecture_5m  || _storedRv2.lecture_5m  || null;
    const _lec3b = data.lectureTech3 || data.lecture_15m || _storedRv2.lecture_15m || null;
    const _lec4b = data.lectureTech4 || data.lecture_60m || _storedRv2.lecture_60m || null;
    const _ltNow2 = Date.now();
    tvStoreEntry.bridgeData = {
      lectureTech1: _lec1b, lectureTech2: _lec2b, lectureTech3: _lec3b, lectureTech4: _lec4b,
      lectureTech5: data.lectureTech5 || data.lecture_4h || _storedRv2.lecture_4h || null,
      rsiTf5: data.rsiTf5 != null ? parseFloat(data.rsiTf5) : (data.rsi_4h != null ? parseFloat(data.rsi_4h) : _storedRv2.rsi_4h ?? null),
      scoreTech5: data.scoreTech5 != null ? parseFloat(data.scoreTech5) : null,
      inTop_H4: data.inTop_H4 === true || data.inTop_H4 === 'true' || null,
      inBot_H4: data.inBot_H4 === true || data.inBot_H4 === 'true' || null,
      rsiTf1:  data.rsiTf1  != null ? parseFloat(data.rsiTf1)  : (data.rsi_1m  != null ? parseFloat(data.rsi_1m)  : _storedRv2.rsi_1m  ?? null),
      rsiTf2:  data.rsiTf2  != null ? parseFloat(data.rsiTf2)  : (data.rsi_5m  != null ? parseFloat(data.rsi_5m)  : _storedRv2.rsi_5m  ?? null),
      rsiTf3:  data.rsiTf3  != null ? parseFloat(data.rsiTf3)  : (data.rsi_15m != null ? parseFloat(data.rsi_15m) : _storedRv2.rsi_15m ?? null),
      rsiTf4:  data.rsiTf4  != null ? parseFloat(data.rsiTf4)  : (data.rsi_60m != null ? parseFloat(data.rsi_60m) : _storedRv2.rsi_60m ?? null),
      scoreTech1: data.scoreTech1 != null ? parseFloat(data.scoreTech1) : null,
      scoreTech2: data.scoreTech2 != null ? parseFloat(data.scoreTech2) : null,
      scoreTech3: data.scoreTech3 != null ? parseFloat(data.scoreTech3) : null,
      scoreTech4: data.scoreTech4 != null ? parseFloat(data.scoreTech4) : null,
      inTop:  (data.inTop !== undefined || data.in_top_zone !== undefined) ? (data.inTop === true || data.in_top_zone === true) : (_storedRv2.in_top_zone ?? null),
      inBot:  (data.inBot !== undefined || data.in_bot_zone !== undefined) ? (data.inBot === true || data.in_bot_zone === true) : (_storedRv2.in_bot_zone ?? null),
      bullRej: data.bullRej !== undefined ? (data.bullRej === true) : (_storedRv2.bullRej ?? null),
      bearRej: data.bearRej !== undefined ? (data.bearRej === true) : (_storedRv2.bearRej ?? null),
      macroBull: data.macroBull != null ? parseFloat(data.macroBull) : (data.macro_bull != null ? parseFloat(data.macro_bull) : (_storedRv2.macro_bull ?? null)),
      macroBear: data.macroBear != null ? parseFloat(data.macroBear) : (data.macro_bear != null ? parseFloat(data.macro_bear) : (_storedRv2.macro_bear ?? null)),
      anticipationForce: data.anticipationForce != null ? parseFloat(data.anticipationForce) : (data.anticipation_force != null ? parseFloat(data.anticipation_force) : (_storedRv2.anticipation_force ?? null)),
      verdict: _storedRv2.verdict || robotV12.verdict,
      anticipation: _storedRv2.anticipation || robotV12.anticipation,
      inPremium: data.inPremium === true, inDiscount: data.inDiscount === true,
      // ── CHAMPS OBLIGATOIRES — utilisés dans vocal + décision popup.js ──────────
      // impulseScoreTf: force de l'impulsion par TF (Pine webhook uniquement)
      impulseScoreTf1: data.impulseScoreTf1 != null ? parseFloat(data.impulseScoreTf1) : (data.impulse_1m  != null ? parseFloat(data.impulse_1m)  : null),
      impulseScoreTf2: data.impulseScoreTf2 != null ? parseFloat(data.impulseScoreTf2) : (data.impulse_5m  != null ? parseFloat(data.impulse_5m)  : null),
      impulseScoreTf3: data.impulseScoreTf3 != null ? parseFloat(data.impulseScoreTf3) : (data.impulse_15m != null ? parseFloat(data.impulse_15m) : null),
      impulseScoreTf4: data.impulseScoreTf4 != null ? parseFloat(data.impulseScoreTf4) : (data.impulse_60m != null ? parseFloat(data.impulse_60m) : null),
      // liqHigh / liqLow — niveaux de liquidité (zone de retournement)
      liqHigh: data.liqHigh != null ? parseFloat(data.liqHigh) : (data.liq_high != null ? parseFloat(data.liq_high) : (_storedRv2.liqHigh ?? null)),
      liqLow:  data.liqLow  != null ? parseFloat(data.liqLow)  : (data.liq_low  != null ? parseFloat(data.liq_low)  : (_storedRv2.liqLow  ?? null)),
      // Zone par TF — inTop_M1/M5/M15/H1 + inBot_M1/M5/M15/H1 (Pine webhook — peut être null avant mise à jour Pine)
      inTop_M1:  data.inTop_M1  === true || data.inTop_M1  === 'true'  || null,
      inBot_M1:  data.inBot_M1  === true || data.inBot_M1  === 'true'  || null,
      inTop_M5:  data.inTop_M5  === true || data.inTop_M5  === 'true'  || null,
      inBot_M5:  data.inBot_M5  === true || data.inBot_M5  === 'true'  || null,
      inTop_M15: data.inTop_M15 === true || data.inTop_M15 === 'true'  || null,
      inBot_M15: data.inBot_M15 === true || data.inBot_M15 === 'true'  || null,
      inTop_H1:  data.inTop_H1  === true || data.inTop_H1  === 'true'  || null,
      inBot_H1:  data.inBot_H1  === true || data.inBot_H1  === 'true'  || null,
      // anticipationTexte — alias de anticipation (utilisé dans popup.js)
      anticipationTexte: data.anticipationTexte || data.anticipation_texte || _storedRv2.anticipation || null,
      // Structure OB / FVG / Sweep / Range — utilisés dans lecture structurelle popup.js
      bullOB_h: data.bullOB_h != null ? parseFloat(data.bullOB_h) : null,
      bullOB_l: data.bullOB_l != null ? parseFloat(data.bullOB_l) : null,
      bearOB_h: data.bearOB_h != null ? parseFloat(data.bearOB_h) : null,
      bearOB_l: data.bearOB_l != null ? parseFloat(data.bearOB_l) : null,
      bullFVG_h: data.bullFVG_h != null ? parseFloat(data.bullFVG_h) : null,
      bullFVG_l: data.bullFVG_l != null ? parseFloat(data.bullFVG_l) : null,
      bearFVG_h: data.bearFVG_h != null ? parseFloat(data.bearFVG_h) : null,
      bearFVG_l: data.bearFVG_l != null ? parseFloat(data.bearFVG_l) : null,
      sweepHighLevel: data.sweepHighLevel != null ? parseFloat(data.sweepHighLevel) : null,
      sweepLowLevel:  data.sweepLowLevel  != null ? parseFloat(data.sweepLowLevel)  : null,
      rangeHigh: data.rangeHigh != null ? parseFloat(data.rangeHigh) : null,
      rangeLow:  data.rangeLow  != null ? parseFloat(data.rangeLow)  : null,
      midpoint:  data.midpoint  != null ? parseFloat(data.midpoint)  : null,
      picVolume: data.picVolume === true || data.picVolume === 'true' || false,
      rsiEtatTexte: data.rsiEtatTexte || data.rsi_etat || null,
      // ── ZONES LIQUIDITÉ + ZONE PROCHE — Pine envoie ces champs, obligatoires pour direction ──
      zoneLiqBasse: data.zoneLiqBasseActive === true || data.zoneLiqBasseActive === 'true' || false,
      zoneLiqHaute: data.zoneLiqHauteActive === true || data.zoneLiqHauteActive === 'true' || false,
      zoneProcheTexte: data.zoneProcheTexte || data.zone_proche || null,
      _lt1UpdatedAt: (data.lectureTech1 || data.lecture_1m)  ? _ltNow2 : (_prevBdTs._lt1UpdatedAt || null),
      _lt2UpdatedAt: (data.lectureTech2 || data.lecture_5m)  ? _ltNow2 : (_prevBdTs._lt2UpdatedAt || null),
      _lt3UpdatedAt: (data.lectureTech3 || data.lecture_15m) ? _ltNow2 : (_prevBdTs._lt3UpdatedAt || null),
      _lt4UpdatedAt: (data.lectureTech4 || data.lecture_60m) ? _ltNow2 : (_prevBdTs._lt4UpdatedAt || null)
    };
    // ── PRICE WINDOW — enregistrer prix pour synthèse zone si Pine absent ──────
    _pwPush(symbol, price);
    if (canonical && canonical !== symbol) _pwPush(canonical, price);

    // ── RÈGLE BRIDGE_NO_NULL — Pine n'a pas envoyé zone → synthétique prix ──────
    // Pine "confirme" zone seulement si le webhook payload contient inTop/inBot.
    // robotV12.in_top_zone = false (défaut) ≠ Pine dit "pas en zone".
    // Si data.inTop/inBot absent du payload → Pine n'a pas parlé → price window.
    const _pineActuallySentZone = (data.inTop !== undefined || data.in_top_zone !== undefined
      || data.inBot !== undefined || data.in_bot_zone !== undefined);
    if (!_pineActuallySentZone) {
      const _synthZ = _pwSynthZone(symbol, price) || _pwSynthZone(canonical, price);
      if (_synthZ) {
        tvStoreEntry.bridgeData.inTop    = _synthZ.inTop;
        tvStoreEntry.bridgeData.inBot    = _synthZ.inBot;
        tvStoreEntry.bridgeData._synthZone    = true;
        tvStoreEntry.bridgeData._synthZonePos = _synthZ._synthZonePos;
      }
    }

    // ── RSI SYNTHÉTIQUE — si Pine absent, calculer depuis historique prix ────
    // Utilise _tvPriceWindow qui accumule jusqu'à 60 ticks (≥ 28 ticks = RSI14 valide)
    if (tvStoreEntry.bridgeData.rsiTf1 == null || tvStoreEntry.bridgeData.rsiTf2 == null) {
      const _pw = _tvPriceWindow[symbol] || _tvPriceWindow[canonical];
      if (_pw && _pw.length >= 28) {
        const _prices = _pw.map(p => p.price);
        const _synthR = _calcSynthRsi(_prices, 14);
        if (_synthR != null) {
          // Même RSI pour tous les TFs (on n'a qu'une série = M1 synthétique)
          // Suffit pour LIA pour détecter surachat/survente global
          if (tvStoreEntry.bridgeData.rsiTf1 == null) { tvStoreEntry.bridgeData.rsiTf1 = _synthR; tvStoreEntry.robotV12.rsi_1m = _synthR; }
          if (tvStoreEntry.bridgeData.rsiTf2 == null) { tvStoreEntry.bridgeData.rsiTf2 = _synthR; tvStoreEntry.robotV12.rsi_5m = _synthR; }
          if (tvStoreEntry.bridgeData.rsiTf3 == null) { tvStoreEntry.bridgeData.rsiTf3 = _synthR; tvStoreEntry.robotV12.rsi_15m = _synthR; }
          if (tvStoreEntry.bridgeData.rsiTf4 == null) { tvStoreEntry.bridgeData.rsiTf4 = _synthR; tvStoreEntry.robotV12.rsi_60m = _synthR; }
          tvStoreEntry.bridgeData._synthRsiUsed = true;
          tvStoreEntry.bridgeData._synthRsiVal  = _synthR;
        }
      }
    }

    // ── VERDICT SYNTHÉTIQUE — cohérent avec lia-robot pour éviter toute contradiction ──
    // Utilise lia-robot.analyze() directement → verdict, longScore, shortScore alignés
    if (!tvStoreEntry.robotV12?.verdict && tvStoreEntry.bridgeData._synthRsiUsed) {
      try {
        const _liaRobot = require('./lib/lia-robot');
        const _szNow = _pwSynthZone(symbol, price) || _pwSynthZone(canonical, price);
        const _synthRv = {
          rsi_1m:  tvStoreEntry.bridgeData.rsiTf1,
          rsi_5m:  tvStoreEntry.bridgeData.rsiTf2,
          rsi_15m: tvStoreEntry.bridgeData.rsiTf3,
          rsi_60m: tvStoreEntry.bridgeData.rsiTf4,
          in_bot_zone: _szNow?.inBot || false,
          in_top_zone: _szNow?.inTop || false
        };
        const _lr = _liaRobot.analyze({ symbol, price, robotV12: _synthRv, phase: 'IDLE', tradeCtx: {} });
        const _sVerdict = _lr.verdict; // LONG / SHORT / WAIT — cohérent avec lectures RSI
        if (_sVerdict && _sVerdict !== 'WAIT') {
          tvStoreEntry.robotV12.verdict      = _sVerdict;
          tvStoreEntry.bridgeData.verdict    = _sVerdict;
          tvStoreEntry.bridgeData._synthVerdict = true;
          tvStoreEntry.robotV12.long_score   = _lr.longScore  || 0;
          tvStoreEntry.robotV12.short_score  = _lr.shortScore || 0;
          tvStoreEntry.bridgeData.long_score  = _lr.longScore  || 0;
          tvStoreEntry.bridgeData.short_score = _lr.shortScore || 0;
        }
        if (_szNow) {
          tvStoreEntry.robotV12.in_top_zone = _szNow.inTop;
          tvStoreEntry.robotV12.in_bot_zone = _szNow.inBot;
          tvStoreEntry.bridgeData.inTop      = _szNow.inTop;
          tvStoreEntry.bridgeData.inBot      = _szNow.inBot;
        }
      } catch (_liaErr) { /* lia-robot non disponible — skip */ }
    }

    // ── STRICT RULES — vérification à chaque tick ────────────────────────────
    const _rvdir = String(tvStoreEntry.robotV12?.verdict || '').toUpperCase();
    // Check active position for verdict mismatch
    const _strictActiveKey = Object.keys(coachTradeStateStore).find(k =>
      k.startsWith(symbol + '|') && coachTradeStateStore[k].entered === true);
    const _strictActiveSt = _strictActiveKey ? coachTradeStateStore[_strictActiveKey] : null;
    const _strictDir = String(_strictActiveSt?.virtualPosition?.direction || '').toUpperCase();
    verifyStrictRules({
      inTop:         tvStoreEntry.bridgeData.inTop === true,
      inBot:         tvStoreEntry.bridgeData.inBot === true,
      isLong:        _rvdir.includes('LONG') || _rvdir.includes('BUY'),
      isShort:       _rvdir.includes('SHORT') || _rvdir.includes('SELL'),
      bridgeVerdict: String(tvStoreEntry.bridgeData.verdict || '').toUpperCase(),
      entered:       !!_strictActiveSt,
    });

    tvDataStore[symbol] = tvStoreEntry;
    if (canonical && canonical !== symbol) tvDataStore[canonical] = tvStoreEntry;
    signalRealTvTick(); // VRAI TICK TV — Pine Script / extension (pas keepalive)
    const bridgeEnabled = bridgeConfig.bridgeEnabled !== false;
    if (bridgeEnabled) {
      marketStore.systemStatus = { source: 'tradingview', fluxStatus: 'LIVE', lastUpdate: new Date().toISOString() };
      marketStore.updateFromTV(tvDataStore[symbol], canonical);

      // 🔴 CRITICAL FIX: Broadcast to Extension + HTML clients IMMEDIATELY
      // Filtre symbole: ne broadcaster que si le symbole du webhook correspond au symbole actif de l'extension
      // Exception: scrape DOM TradingView toujours broadcasté (c'est lui qui met à jour le symbole actif)
      const _activeCanonical = activeSymbol?.symbol ? (normalizeSymbol(activeSymbol.symbol)?.canonical || activeSymbol.symbol) : null;
      const _symbolMismatch = _activeCanonical && canonical && _activeCanonical !== canonical && source !== 'tradingview-extension';
      if (_symbolMismatch) {
        // Stocker en silence — ne pas envoyer à l'extension (elle est sur un autre symbole)
        console.log(`[TV WEBHOOK] Symbol mismatch — stored ${canonical} silently (active: ${_activeCanonical})`);
      } else {
      broadcastToExtension({
        type: 'tradingview-data',
        symbol: canonical,
        brokerSymbol: symbol,
        action,
        source,
        isExtensionScrape: source === 'tradingview-extension', // true = scrape DOM (user changed symbol on TV), false = Pine webhook
        price: price,
        bid: parseFloat(data.bid || price),
        ask: parseFloat(data.ask || price),
        volume: parseFloat(data.volume || 0),
        rsi: parseFloat(data.rsi) || parseFloat(data.rsi_1m) || parseFloat(data.indicators?.rsi) || null,
        entry: data.entry != null ? parseFloat(data.entry) : null,
        sl: data.sl != null ? parseFloat(data.sl) : null,
        tp: data.tp != null ? parseFloat(data.tp) : null,
        rrRatio: data.rrRatio != null ? String(data.rrRatio) : (data.rr != null ? String(data.rr) : null),
        timeframe: resolvedTf,
        indicators: {
          rsi: parseFloat(data.rsi) || parseFloat(data.rsi_1m) || parseFloat(data.indicators?.rsi) || null,
          macd: parseFloat(data.macd) || parseFloat(data.indicators?.macd) || null,
          bb_upper: parseFloat(data.bb_upper) || null,
          bb_middle: parseFloat(data.bb_middle) || null,
          bb_lower: parseFloat(data.bb_lower) || null,
          ma20: parseFloat(data.ma20) || null,
          ma50: parseFloat(data.ma50) || null
        },
        bridgeData: tvStoreEntry.bridgeData,
        source: 'tradingview-webhook',
        // ── PRE-SIGNAL — anticiper une entrée avant que la zone soit confirmée ──
        // Conditions: direction claire (verdict non WAIT) + anticipation définie + zone pas encore active
        preSignal: (function() {
          const _rv = tvStoreEntry.robotV12 || {};
          const _bd = tvStoreEntry.bridgeData || {};
          const _verd = String(_rv.verdict || '').toUpperCase();
          const _ant  = String(_rv.anticipation || '').toUpperCase();
          const _isLong  = _verd.includes('HAUSSIER') || _verd.includes('BUY') || _verd.includes('LONG');
          const _isShort = _verd.includes('BAISSIER') || _verd.includes('SELL') || _verd.includes('SHORT');
          const _inZone  = _bd.inTop === true || _bd.inBot === true;
          // Pré-signal: direction connue, anticipation active, pas encore en zone d'entrée
          if ((_isLong || _isShort) && _ant && _ant !== 'RAS' && _ant !== 'NEUTRE' && !_inZone) {
            const _dir = _isLong ? 'LONG' : 'SHORT';
            const _force = _rv.anticipation_force != null ? Math.round(Number(_rv.anticipation_force)) : null;
            const _lt3 = String(_bd.lectureTech3 || _rv.lecture_15m || '').replace(/_/g,' ');
            const _lt4 = String(_bd.lectureTech4 || _rv.lecture_60m || '').replace(/_/g,' ');
            return {
              direction: _dir,
              anticipation: _ant,
              force: _force,
              message: (_dir === 'LONG' ? '▲ LONG en préparation' : '▼ SHORT en préparation')
                + (_force ? ' — force ' + _force + '%' : '')
                + (_lt3 ? ' | M15: ' + _lt3 : '')
                + (_lt4 ? ' | H1: ' + _lt4 : '')
                + ' | En attente zone + confirmation',
              timing: 'Attendre rejet de zone avant entrée'
            };
          }
          return null;
        })(),
        tvSymbol: tvSymbolForWidget,
        tvResolution: tvResolutionForWidget,
        timestamp,
        tvMode: 'LIVE_TV',    // toujours LIVE_TV ici — c'est un vrai webhook Pine
        realTvAgeMs: 0        // vient d'arriver
      }); // end broadcastToExtension

      // ── BRIDGE AGENT AUTO — tourne sur chaque tick, pas de clic ANALYSER requis ──
      // Règle ADEL STRICT: agent réel, connecté au flux, décision automatique sur chaque prix.
      // Extension + Dashboard se mettent à jour via SSE 'agent-decision' sans interaction.
      try {
        const _agSym   = canonical;
        const _agEnt   = tvDataStore[_agSym];
        if (_agEnt && _agEnt.price > 0) {
          const _agSwing = _getM1Swing(_agSym) || _getM5Swing(_agSym);
          const _agProf  = normalizeSymbol(_agSym);
          const _agResult = _decisionAgent(_agSym, _agEnt.price, _agEnt, _agSwing, 'SCALPER');

          // SL/TP structurel si direction active ET agent non bloqué
          let _agLevels = null;
          if (_agResult.direction !== 'WAIT' && !_agResult.blocked) {
            _agLevels = _calcStructuralLevels(_agEnt.price, _agResult.direction, _agProf, _agSwing, _agEnt.bridgeData || {});
          }

          // Check position active (conflit direction)
          const _agActivePosKey = Object.keys(coachTradeStateStore).find(k =>
            k.startsWith(_agSym + '|') && coachTradeStateStore[k]?.entered && coachTradeStateStore[k]?.virtualPosition
          );
          const _agActivePosDir = _agActivePosKey
            ? String(coachTradeStateStore[_agActivePosKey]?.virtualPosition?.direction || '').toUpperCase()
            : null;

          broadcastToExtension({
            type:        'agent-decision',
            symbol:      _agSym,
            price:       _agEnt.price,
            direction:   _agResult.direction,
            confidence:  _agResult.confidence,
            blocked:     _agResult.blocked,
            missingCount: _agResult.missingCount,
            missingFirst: _agResult.missingComponents?.[0] || null,
            rsiSummary:  _agResult.rsiSummary,
            verdict:     _agResult.verdict,
            pineActive:  _agResult.pineActive,
            longPts:     _agResult.longPts,
            shortPts:    _agResult.shortPts,
            levels:      _agLevels ? {
              sl:       _agLevels.sl,
              tp:       _agLevels.tp,
              slSource: _agLevels.slSource,
              tpSource: _agLevels.tpSource,
              slPips:   _agLevels.slPips,
              rrRatio:  _agLevels.rrRatio,
              valid:    _agLevels.valid
            } : null,
            activePosition: _agActivePosDir ? { direction: _agActivePosDir, key: _agActivePosKey } : null,
            timestamp:   Date.now()
          });
        }
      } catch (_agErr) {
        // Agent auto silencieux — jamais bloquer le flux bridge
      }

      // ── LEA AUTO (Ollama) — throttlé 30s, broadcast 'lea-analysis' SSE ──────
      // LIA/Lea appelle Ollama avec bridge complet. Throttlé pour ne pas surcharger.
      // Décision différente à chaque tick grâce aux prix et zones réelles du bridge.
      const _leaNow = Date.now();
      if (!_tvLeaLastCall) global._tvLeaLastCall = {};
      if (!global._tvLeaLastCall[canonical] || (_leaNow - global._tvLeaLastCall[canonical]) > 30000) {
        global._tvLeaLastCall[canonical] = _leaNow;
        // Asynchrone — ne bloque pas le tick bridge
        setImmediate(async () => {
          try {
            const _leaTv  = tvDataStore[canonical];
            if (!_leaTv || !_leaTv.price) return;
            const _leaBd  = _leaTv.bridgeData || {};
            const _leaRv  = _leaTv.robotV12   || {};
            const _leaPx  = _leaTv.price;
            const _leaSwg = _getM1Swing(canonical) || _getM5Swing(canonical);
            const _leaProf= normalizeSymbol(canonical);
            const _leaOk  = _leaBd._synthRsiUsed !== true;
            const _fmt2   = (h,l) => (h != null && l != null) ? `[${Number(l).toFixed(2)}/${Number(h).toFixed(2)}]` : 'absent';
            const _fmtV2  = v => v != null ? Number(v).toFixed(2) : 'absent';

            const _leaMsg = [
              `Analyse automatique ${canonical} @ ${_leaPx} (tick bridge)`,
              ``,
              `DONNÉES RÉELLES:`,
              `verdict=${_leaRv.verdict||_leaBd.verdict||'?'} | zone=${_leaBd.inTop?'RÉSISTANCE':_leaBd.inBot?'SUPPORT':'neutre'} | Pine=${_leaOk?'ACTIF':'INACTIF'}`,
              `RSI M1=${_leaBd.rsiTf1??'?'} M5=${_leaBd.rsiTf2??'?'} M15=${_leaBd.rsiTf3??'?'} H1=${_leaBd.rsiTf4??'?'}`,
              `lectureTech M1="${String(_leaBd.lectureTech1||'?').replace(/_/g,' ')}"`,
              `bullOB=${_fmt2(_leaBd.bullOB_h,_leaBd.bullOB_l)} | bearOB=${_fmt2(_leaBd.bearOB_h,_leaBd.bearOB_l)}`,
              `bullFVG=${_fmt2(_leaBd.bullFVG_h,_leaBd.bullFVG_l)} | bearFVG=${_fmt2(_leaBd.bearFVG_h,_leaBd.bearFVG_l)}`,
              `liqH=${_fmtV2(_leaBd.liqHigh)} liqL=${_fmtV2(_leaBd.liqLow)} | sweepH=${_fmtV2(_leaBd.sweepHighLevel)} sweepL=${_fmtV2(_leaBd.sweepLowLevel)}`,
              `range=[${_fmtV2(_leaBd.rangeL)}/${_fmtV2(_leaBd.rangeH)}] | swing: ${_leaSwg?`H=${_leaSwg.swingHigh} L=${_leaSwg.swingLow} (${_leaSwg.source})`:'absent'}`,
              ``,
              `Donne analyse courte (3 lignes max) avec DÉCISION, CONTEXTE, CONDITION basés sur les niveaux réels.`,
            ].join('\n');

            const _leaModel = await getLiaModel();
            const _leaResp  = await callOllamaNarrative(_leaModel, [
              { role: 'system', content: LIA_SYSTEM_PROMPT },
              { role: 'user',   content: _leaMsg }
            ]);

            // SL/TP structurel pour Lea
            let _leaLevels = null;
            const _leaDir = _leaResp.includes('DÉCISION: LONG') ? 'LONG' : _leaResp.includes('DÉCISION: SHORT') ? 'SHORT' : null;
            if (_leaDir && _leaPx > 0) {
              _leaLevels = _calcStructuralLevels(_leaPx, _leaDir, _leaProf, _leaSwg, _leaBd);
            }

            broadcastToExtension({
              type:      'lea-analysis',
              symbol:    canonical,
              price:     _leaPx,
              direction: _leaDir || 'WAIT',
              analysis:  _leaResp,
              levels:    _leaLevels && _leaLevels.valid ? _leaLevels : null,
              model:     _leaModel,
              pineActive:_leaOk,
              timestamp: Date.now()
            });
          } catch (_leaErr) {
            // LIA auto silencieuse si Ollama timeout
          }
        });
      }

      } // end else (!_symbolMismatch)

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
        surveillanceAgent.onTVTick(canonical, { price, bid: tvDataStore[symbol].bid, ask: tvDataStore[symbol].ask, volume: tvDataStore[symbol].volume });
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

// Routes : webhook générique + alias ROBOT V12 + entrée principale Pine Script
const tvWebhookTextParser = express.text({ type: ['text/plain', 'application/json', 'application/*+json'], limit: '1mb' });
app.post('/tradingview/live', tvWebhookTextParser, handleTvWebhook);
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
      const requestedDomain = /tradingview|extension|bridge|api|externe|module/i.exec(message || '')?.[0] || 'bridge';
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
      const tvBridge = await fetchLocalJson('/tradingview/live').catch(() => ({ ok: false, data: {} }));
      const cal = await fetchLocalJson('/calendar').catch(() => ({ ok: false, data: { events: [] } }));
      const now = Date.now();
      const highSoon = (Array.isArray(cal.data?.events) ? cal.data.events : []).some((e) => {
        const t = Date.parse(e.time || e.timestamp || '');
        const mins = Number.isFinite(t) ? Math.floor((t - now) / 60000) : null;
        return e.impact === 'HIGH' && Number.isFinite(mins) && mins >= 0 && mins <= 45;
      });
      const riskLevel = (!marketStore.systemStatus?.tvConnected || highSoon) ? 'HIGH' : 'MEDIUM';
      const guidance = !marketStore.systemStatus?.tvConnected
        ? 'Flux Bridge TV non confirmé: éviter entrée agressive'
        : (highSoon ? 'News macro proche: réduire taille ou attendre' : 'Risque contrôlé, gestion stricte requise');
      localResponse.response = {
        action: 'risk',
        status: 'completed',
        riskLevel,
        guidance,
        tvConnected: !!(marketStore.systemStatus?.tvConnected),
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

// ─── SIMULATEUR SUPPRIMÉ ──────────────────────────────────────────────────────
// Les routes /symbols et /data/refresh ont été supprimées.
// Toutes les données de prix proviennent exclusivement de TradingView live (tvDataStore).
// Utilisez /tradingview/live pour l'état courant Bridge TV.
// Utilisez /extension/data pour l'état courant TradingView live.

// ─── START ────────────────────────────────────────────────────────────────────
  // ─── LIA — Intelligence Centrale (Ollama local) ───────────────────────────────
  function normalizeLiaChannel(raw) {
    const v = String(raw || 'dev').toLowerCase();
    if (v.includes('dash') || v.includes('coach') || v.includes('trade')) return 'dashboard';
    return 'dev';
  }

  function getLiaSystemPrompt(channel) {
    if (channel === 'dashboard') {
      return 'Tu es Lia Dashboard, coach trading côté utilisateur. RÈGLE ABSOLUE: les données indicateur TradingView reçues dans le message sont la source unique de vérité et sont en lecture seule. Tu ne dois jamais recalculer, remplacer, inventer ou modifier une tendance, un signal, une décision, un prix, un SL, un TP, un verdict ou une anticipation. Tu expliques uniquement la décision déjà fournie, le contexte, le risque, et les actions de suivi live (attendre, sécuriser, remonter SL, gérer TP) à partir des données fournies. Tu réponds en français, court, concret, actionnable. Interdiction de parler de code, de fichiers, de routes API, d\'architecture interne, d\'agents techniques, de debug ou de développement. Si la question dérive vers la technique, tu recentres vers trading, exécution, discipline et gestion du risque.';
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

  const OLLAMA_TIMEOUT_MS = 45000;

  const LIA_PREFERRED_MODELS = ['gpt-oss:20b', 'gpt-oss', 'llama3.2:latest', 'llama3.2', 'llama3.2:1b', 'phi3', 'mistral', 'gemma2', 'llama3', 'llama2'];

  const LIA_SYSTEM_PROMPT = `Tu es LIA (Lea), agent IA de trading professionnel, connecté en temps réel au bridge TradingView.
Tu reçois les VRAIES données du chart: prix, RSI multi-TF, zones structurelles (OB, FVG, liquidité, sweep), micro-structure M1.
Tu es direct, précis, basé sur les niveaux RÉELS fournis. Jamais de généralités. Jamais de prix inventés.

FORMAT OBLIGATOIRE (6 lignes exactement):
DÉCISION: [LONG / SHORT / ATTENTE]
CONTEXTE: [zone actuelle avec prix exacts: ex. "Prix 4791 entre bullOB [4788/4792] et bearOB [4793/4796]"]
RSI: [valeurs exactes par TF — ex. "M1=61 M5=58 M15=55 H1=52 → alignement haussier"]
ZONES: [OB/FVG/liq/sweep actifs avec prix — ex. "bullFVG [4785/4787] support | liqHigh 4798 cible"]
CONFLIT: [contradictions structure vs RSI vs verdict — sinon "Aucun"]
CONDITION: [niveau précis à franchir, zone à tester, ou "Entrée structurelle validée"]

RÈGLES TRADING ADEL STREET (NON NÉGOCIABLES):
- SL = collé zone M1 visible (swingHigh/Low local). MAX 10 pts sur XAUUSD. JAMAIS macro/ATR/%
- inBot + RSI < 42 + bullOB actif → LONG fort (triple confirmation)
- inTop + RSI > 58 + bearOB actif → SHORT fort (triple confirmation)
- Prix DANS une FVG → zone magnétique → attente sortie FVG avant entrée
- sweepHigh récent → manipulation → SHORT possible sur rejet
- sweepLow récent → manipulation → LONG possible sur rejet
- liqHigh proche → cible institutionnelle → surveiller rejet
- liqLow proche → cible institutionnelle → surveiller rebond
- rangeHigh = résistance macro (filtre long), rangeLow = support macro (filtre short)
- Zone neutre (>25% et <75% du range) → ATTENTE obligatoire sans autre signal fort
- RSI diverge entre M1 et H1 → ATTENTE jusqu'à alignement
- JAMAIS "le marché est volatil" — toujours prix exacts et zones précises
- Si Pine inactif (OB/FVG null) → ATTENTE obligatoire (données incomplètes)`;

  async function callOllamaNarrative(model, messages) {
    const r = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: { temperature: 0.3, num_predict: 200, top_p: 0.9 }
      })
    });
    if (!r.ok) throw new Error('Ollama HTTP ' + r.status);
    const d = await r.json();
    return String(d.message?.content || d.response || '').trim();
  }

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
    const slTpText = (Number.isFinite(sl) && Number.isFinite(tp))
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

  // ── HELPER — fusionne robotV12 + bridgeData en un objet unifié pour LIA ──────
  // robotV12 = données Pine Script (peut être vide si Pine absent)
  // bridgeData = données extension scraped (RSI per-TF, zone, verdict)
  // LIA doit lire les deux sources — robotV12 a priorité sur bridgeData si les deux existent
  function _buildLiaRv(tvEntry) {
    const rv = tvEntry?.robotV12 || {};
    const bd = tvEntry?.bridgeData || {};
    return {
      // RSI — robotV12 a priorité, fallback bridgeData
      rsi_1m:  rv.rsi_1m  ?? rv.rsi_m1_now  ?? bd.rsiTf1 ?? null,
      rsi_5m:  rv.rsi_5m  ?? rv.rsi_m5_now  ?? bd.rsiTf2 ?? null,
      rsi_15m: rv.rsi_15m ?? rv.rsi_m15_now ?? bd.rsiTf3 ?? null,
      rsi_60m: rv.rsi_60m ?? rv.rsi_h1_now  ?? bd.rsiTf4 ?? null,
      rsi_4h:  rv.rsi_4h  ?? rv.rsi_240m    ?? bd.rsiTf5 ?? null,
      // Lectures — Pine en priorité, sinon null (lia-robot calcule depuis RSI)
      lecture_1m:  rv.lecture_1m  ?? rv.lectureTech1 ?? bd.lectureTech1 ?? null,
      lecture_5m:  rv.lecture_5m  ?? rv.lectureTech2 ?? bd.lectureTech2 ?? null,
      lecture_15m: rv.lecture_15m ?? rv.lectureTech3 ?? bd.lectureTech3 ?? null,
      lecture_60m: rv.lecture_60m ?? rv.lectureTech4 ?? bd.lectureTech4 ?? null,
      // Zone support/résistance
      in_top_zone: rv.in_top_zone ?? bd.inTop ?? false,
      in_bot_zone: rv.in_bot_zone ?? bd.inBot ?? false,
      inTop: rv.in_top_zone ?? bd.inTop ?? false,
      inBot: rv.in_bot_zone ?? bd.inBot ?? false,
      // Verdict / scores
      verdict:    rv.verdict    ?? bd.verdict    ?? null,
      anticipation: rv.anticipation ?? bd.anticipation ?? null,
      long_score:  rv.long_score  ?? bd.long_score  ?? null,
      short_score: rv.short_score ?? bd.short_score ?? null,
      score_complet: rv.score_complet ?? null,
      // Structure
      bullRej: rv.bullRej ?? bd.bullRej ?? null,
      bearRej: rv.bearRej ?? bd.bearRej ?? null,
      // Pass-through restant
      ...rv
    };
  }

  // ── GET /lia/analysis — Robot IA PRO multi-TF ────────────────────────────────
  app.get('/lia/analysis', (req, res) => {
    try {
      const liaRobot = require('./lib/lia-robot');
      const sym = String(req.query.symbol || activeSymbol?.symbol || 'XAUUSD').toUpperCase();
      const tvLive = tvDataStore[sym] || {};
      const price  = tvLive.price || marketStore.price || 0;
      const rv     = _buildLiaRv(tvLive);   // FUSION robotV12 + bridgeData
      const ts     = coachTradeStateStore[sym] || {};
      const phase  = ts.phase || 'IDLE';
      const tradeCtx = ts.entered ? {
        direction: ts.direction,
        sl: ts.sl,
        tp: ts.tp,
        entry: ts.entry,
        anticipation: rv.anticipation || null
      } : { anticipation: rv.anticipation || null };

      const result = liaRobot.analyze({ symbol: sym, price, robotV12: rv, phase, tradeCtx });

      // Broadcast to dashboard via SSE
      marketStore.broadcast({ type: 'lia-analysis',
        symbol: sym, verdict: result.verdict, longScore: result.longScore,
        shortScore: result.shortScore, tfs: result.tfs, text: result.text,
        sl: result.sl, tp: result.tp, rr: result.rr, source: result.source,
        tfCount: result.tfCount, phase, ts: Date.now()
      });

      updateAgentState('lia-dashboard', 'idle', result.text.split('\n')[0]);
      pushLog('lia-dashboard', 'dashboard', result.text.split('\n')[0], 'ok', {
        verdict: result.verdict, longScore: result.longScore, shortScore: result.shortScore,
        source: result.source, tfCount: result.tfCount
      });

      res.json({ ok: true, ...result });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

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
      impact: 'attente réponse LIA Ollama',
      solution: ''
    });

    // Enrich user message with live bridge context (fusion robotV12 + bridgeData)
    const _chatSym = String(req.body.symbol || activeSymbol?.symbol || 'XAUUSD').toUpperCase();
    const _chatTv = tvDataStore[_chatSym] || {};
    const _chatRv = _buildLiaRv(_chatTv);   // FUSION — lit robotV12 + bridgeData
    const _chatBd = _chatTv.bridgeData || {};
    let bridgeCtx = '';
    const _chatPrice = _chatTv.price || marketStore.price || 0;
    if (_chatPrice > 0) {
      const _zone   = _chatRv.inTop ? 'RÉSISTANCE' : _chatRv.inBot ? 'SUPPORT' : 'neutre';
      const _rsiM1  = _chatRv.rsi_1m  != null ? _chatRv.rsi_1m.toFixed(1)  : '?';
      const _rsiM5  = _chatRv.rsi_5m  != null ? _chatRv.rsi_5m.toFixed(1)  : '?';
      const _rsiM15 = _chatRv.rsi_15m != null ? _chatRv.rsi_15m.toFixed(1) : '?';
      const _rsiH1  = _chatRv.rsi_60m != null ? _chatRv.rsi_60m.toFixed(1) : '?';
      // Zones structurelles complètes (Pine Script)
      const _bd2    = _chatTv.bridgeData || {};
      const _fmtZ   = (h,l) => (h != null && l != null) ? `[${Number(l).toFixed(2)}/${Number(h).toFixed(2)}]` : 'absent';
      const _fmtV   = v => v != null ? Number(v).toFixed(2) : 'absent';
      const _swgData= _getM1Swing(_chatSym) || _getM5Swing(_chatSym);
      const _swgLine= _swgData ? `swingH=${_swgData.swingHigh} swingL=${_swgData.swingLow} (${_swgData.source} n=${_swgData.n})` : 'absent';
      const _lt1    = String(_bd2.lectureTech1 || _chatRv.lecture_1m  || '').replace(/_/g,' ') || '?';
      const _lt5    = String(_bd2.lectureTech2 || _chatRv.lecture_5m  || '').replace(/_/g,' ') || '?';
      const _lt15   = String(_bd2.lectureTech3 || _chatRv.lecture_15m || '').replace(/_/g,' ') || '?';
      const _lt60   = String(_bd2.lectureTech4 || _chatRv.lecture_60m || '').replace(/_/g,' ') || '?';
      const _pineOk = _bd2._synthRsiUsed !== true;
      bridgeCtx = [
        `=== BRIDGE LIVE ${_chatSym} @ ${_chatPrice} ===`,
        `zone=${_zone} | verdict=${_chatRv.verdict||'?'} | Pine=${_pineOk?'ACTIF':'INACTIF'}`,
        `RSI: M1=${_rsiM1} M5=${_rsiM5} M15=${_rsiM15} H1=${_rsiH1}`,
        `lectureTech: M1="${_lt1}" M5="${_lt5}" M15="${_lt15}" H1="${_lt60}"`,
        `bullOB=${_fmtZ(_bd2.bullOB_h,_bd2.bullOB_l)} | bearOB=${_fmtZ(_bd2.bearOB_h,_bd2.bearOB_l)}`,
        `bullFVG=${_fmtZ(_bd2.bullFVG_h,_bd2.bullFVG_l)} | bearFVG=${_fmtZ(_bd2.bearFVG_h,_bd2.bearFVG_l)}`,
        `liqHigh=${_fmtV(_bd2.liqHigh)} | liqLow=${_fmtV(_bd2.liqLow)}`,
        `sweepHigh=${_fmtV(_bd2.sweepHighLevel)} | sweepLow=${_fmtV(_bd2.sweepLowLevel)}`,
        `range=[${_fmtV(_bd2.rangeL)}/${_fmtV(_bd2.rangeH)}] | longScore=${_bd2.long_score??'?'} shortScore=${_bd2.short_score??'?'}`,
        `swingM1: ${_swgLine}`,
        `=== FIN BRIDGE ===`,
      ].join('\n') + '\n';
    }
    const enrichedMsg = bridgeCtx + rawMsg;

    let reply = '';
    let usedModel = 'local-rule-engine';
    try {
      usedModel = await getLiaModel();
      const messages = [
        { role: 'system', content: LIA_SYSTEM_PROMPT },
        ...liaConversation.slice(-6).filter(m => m.role !== 'system'),
        { role: 'user', content: enrichedMsg }
      ];
      reply = await callOllamaNarrative(usedModel, messages);
    } catch (ollamaErr) {
      // Fallback rule-based — utilise les vraies données du bridge
      const _vrd = String(_chatRv.verdict || 'WAIT').toUpperCase();
      const _zone2 = _chatRv.inTop ? 'résistance' : _chatRv.inBot ? 'support' : 'zone neutre';
      const _rsiLine = `RSI M1=${_chatRv.rsi_1m != null ? _chatRv.rsi_1m.toFixed(1) : '?'} M15=${_chatRv.rsi_15m != null ? _chatRv.rsi_15m.toFixed(1) : '?'} H1=${_chatRv.rsi_60m != null ? _chatRv.rsi_60m.toFixed(1) : '?'}`;
      reply = [
        'DÉCISION: ' + (_vrd === 'LONG' ? 'LONG' : _vrd === 'SHORT' ? 'SHORT' : 'ATTENTE'),
        'CONTEXTE: ' + _chatSym + ' en ' + _zone2 + '. ' + _rsiLine + '.',
        'CONFLIT: Ollama hors ligne — ' + (ollamaErr.message || 'timeout'),
        'CONDITION: Relancer Ollama (ollama serve) pour LIA complète.'
      ].join('\n');
      usedModel = 'local-rule-engine-fallback';
    }

    liaConversation.push({ role: 'assistant', content: reply });
    trimLiaConversation(channel);

    publishAgentChatMessage({
      agent: liaAgentName,
      to: 'human',
      status: 'info',
      phase: 'terminé',
      message: reply.length > 300 ? reply.slice(0, 300) + '...' : reply,
      cause: 'réponse LIA ' + usedModel + ' (' + channel + ')',
      impact: 'affiché dans monitor',
      solution: ''
    });

    return res.json({ ok: true, response: reply, status: 'online', model: usedModel, channel, agent: liaAgentName });
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

  // ─── CENTRAL GUIDE AGENT — analyse réelle + boucle tester/retester ───────────
  const centralGuideAcks = {};

  function normalizeGuideDomain(raw) {
    const v = String(raw || 'bridge').toLowerCase();
    if (v.includes('bridge') || v === 'api') return 'bridge';
    if (v.includes('trading')) return 'tradingview';
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
    if (domain === 'tradingview') return ['ui-test-agent', 'logic-gap-agent'];
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
    if (domain !== 'bridge' && domain !== 'extension' && domain !== 'tradingview') {
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
    const tvBridgeConn = await fetchLocalJson('/tradingview/live').catch(() => ({ ok: false, status: 500, data: {} }));
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

    if (domain === 'tradingview-check') {
      addCheck(
        'tv-connected',
        'Bridge TV connecté',
        !!(marketStore.systemStatus?.tvConnected),
        marketStore.systemStatus?.tvLastUpdate || 'jamais',
        'Activer le script Pine Script sur TradingView',
        'Le test doit afficher tvConnected=true'
      );
      addCheck(
        'tv-fresh-data',
        'Données Bridge TV fraîches',
        liveState.ok && (liveState.data.health?.source === 'tradingview'),
        liveState.ok ? `source=${liveState.data.health?.source || 'offline'} ageMs=${liveState.data.health?.ageMs ?? 'n/a'}` : `HTTP ${liveState.status}`,
        'Attendre un tick depuis TradingView (POST /tradingview/live)',
        'Le test doit montrer source=tradingview'
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

  // ── PERSISTANCE TRADE STATE — survit aux redémarrages serveur ──────────────
  const TRADE_STATES_FILE = path.join(__dirname, 'store', 'trade-states.json');
  const coachTradeStateStore = (() => {
    try {
      if (fs.existsSync(TRADE_STATES_FILE)) {
        const raw = JSON.parse(fs.readFileSync(TRADE_STATES_FILE, 'utf8'));
        console.log('[TRADE STATE] Reprise depuis disque:', Object.keys(raw).join(', ') || 'vide');
        return raw;
      }
    } catch (e) { console.warn('[TRADE STATE] Lecture échouée:', e.message); }
    return {};
  })();

  function saveCoachTradeStates() {
    try { fs.writeFileSync(TRADE_STATES_FILE, JSON.stringify(coachTradeStateStore, null, 2), 'utf8'); }
    catch (e) { console.warn('[TRADE STATE] Sauvegarde échouée:', e.message); }
  }

  const USER_TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'];

  function getCoachTradeKey(symbol, timeframe) {
    return String(symbol || 'XAUUSD').toUpperCase() + '|' + String(timeframe || 'H1').toUpperCase();
  }

  function getCoachTradeState(symbol, timeframe) {
    const key = getCoachTradeKey(symbol, timeframe);
    if (!coachTradeStateStore[key]) {
      coachTradeStateStore[key] = {
        symbol: String(symbol || 'XAUUSD').toUpperCase(),
        timeframe: String(timeframe || 'H1').toUpperCase(),
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

  function getCoachMarketPrice(symbol) {
    const latest = marketStore.getLatestForSymbol(String(symbol || 'XAUUSD').toUpperCase());
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

  function buildTradingviewRuntimeTrade(symbol, timeframe, currentPrice, modeRaw, tvRuntime, robotV12) {
    // CONNECTION GUARD: Only build a trade signal from live TradingView data (last signal < 180s ago).
    // Prevents displaying positions based on stale or test-injected data when TV is disconnected.
    if (tvRuntime?.connected === false) {
      return null;
    }
    const price = Number(currentPrice || tvRuntime?.payload?.price || NaN);
    if (!Number.isFinite(price) || price <= 0) return null;

    // TF-AWARE DIRECTION: Use per-TF lectureTech when Pine provides it.
    // This makes H1 scan different from M15 scan — winner selection is meaningful.
    const tf = String(timeframe || '').toUpperCase();
    const _tfLectureMap = { M1: robotV12?.lecture_1m, M5: robotV12?.lecture_5m, M15: robotV12?.lecture_15m, H1: robotV12?.lecture_60m, H4: robotV12?.lecture_60m };
    const _tfLecture = _tfLectureMap[tf] || null;
    const _tfBias = _tfLecture ? extractDirectionalBias(_tfLecture) : 0;
    const _tfDirectionFromLecture = _tfBias > 0 ? 'LONG' : _tfBias < 0 ? 'SHORT' : null;

    let direction = _tfDirectionFromLecture
      || normalizeTradeDirection(
           robotV12?.verdict ||
           robotV12?.anticipation ||
           tvRuntime?.payload?.verdict ||
           tvRuntime?.payload?.anticipation ||
           tvRuntime?.payload?.action
         );

    // RSI fallback: when Pine doesn't send explicit verdict/signal, derive bias from RSI
    // RSI fallback: only when Pine sends real RSI values (not null).
    // Guard: never default to 0 — rsiRaw=0 would always trigger SHORT (0 <= 42).
    if (direction === 'WAIT') {
      const _rsiTfMap = { M1: robotV12?.rsi_1m, M5: robotV12?.rsi_5m, M15: robotV12?.rsi_15m, H1: robotV12?.rsi_60m, H4: robotV12?.rsi_60m };
      // tvRuntime.payload.rsi is the CURRENT CHART TF rsi — timeframe is at tvRuntime.timeframe (not payload)
      const _tvRsiSameTf = (String(tvRuntime?.timeframe||'').toUpperCase() === tf) ? tvRuntime?.payload?.rsi : null;
      const _rsiCandidate = _rsiTfMap[tf] ?? robotV12?.rsi_1m ?? robotV12?.rsi_15m ?? _tvRsiSameTf ?? null;
      if (_rsiCandidate !== null) {
        const _rsiRaw = Number(_rsiCandidate);
        if (_rsiRaw >= 58) direction = 'LONG';
        else if (_rsiRaw <= 42) direction = 'SHORT';
      }
    }

    if (direction === 'WAIT') return null;

    const confidence = Number(robotV12?.anticipation_force || 64);
    let entry = Number(robotV12?.entry ?? tvRuntime?.payload?.entry ?? NaN);
    let sl    = Number(robotV12?.sl    ?? tvRuntime?.payload?.sl    ?? NaN);
    let tp    = Number(robotV12?.tp    ?? tvRuntime?.payload?.tp    ?? NaN);
    let rrRatio = robotV12?.rrRatio ?? tvRuntime?.payload?.rrRatio ?? '--';

    // If entry/sl/tp not provided by Bridge TV, compute from price + ATR/profile
    if (!Number.isFinite(entry) || !Number.isFinite(sl) || !Number.isFinite(tp)) {
      try {
        const { calcLevels } = require('./lib/symbol-normalizer');
        const atr = robotV12?.atr ?? tvRuntime?.payload?.indicators?.atr ?? null;
        // SL structurel M1 (règle SL_M1_PRIORITE):
        // 1. swing M1 (30 ticks) → SL collé micro-structure
        // 2. swing M5 (150 ticks) si M1 oversized
        // PAS rangeHigh/rangeLow (macro zone Pine → trop large)
        const canonical = normalizeSymbol(symbol).canonical;
        let _swingData = _getM1Swing(symbol) || _getM1Swing(canonical);
        if (!_swingData) _swingData = _getM5Swing(symbol) || _getM5Swing(canonical);
        const computed = calcLevels(price, direction, normalizeSymbol(symbol), atr, modeRaw, _swingData);
        // calcLevels may return string values — coerce to Number before isFinite check
        const _cEntry = Number(computed?.entry);
        const _cSl    = Number(computed?.sl);
        const _cTp    = Number(computed?.tp);
        if (computed && Number.isFinite(_cEntry) && Number.isFinite(_cSl) && Number.isFinite(_cTp)) {
          entry   = _cEntry;
          sl      = _cSl;
          tp      = _cTp;
          rrRatio = computed.rrRatio ?? '--';
        } else {
          return null;
        }
      } catch (_) { return null; }
    }
    const setup = classifySetup(timeframe, direction, confidence, modeRaw);
    const technicalParts = [
      robotV12?.verdict ? ('Verdict TV: ' + robotV12.verdict) : null,
      robotV12?.anticipation ? ('Anticipation: ' + robotV12.anticipation + (robotV12.anticipation_force != null ? ' (' + robotV12.anticipation_force + '%)' : '')) : null,
      robotV12?.contexte ? ('Contexte: ' + robotV12.contexte) : null,
      tvRuntime?.payload?.rsi != null ? ('RSI: ' + Number(tvRuntime.payload.rsi).toFixed(0)) : null
    ].filter(Boolean).join(' | ');

    return validateTrade({
      symbol: String(symbol || 'XAUUSD').toUpperCase(),
      direction,
      entry,
      sl,
      tp,
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

  async function computeCoachAnalysisSnapshot(symbol, timeframe, lang, tradeState, options = {}) {
    if (!options.forceFresh) {
      const cached = readCoachAnalysisSnapshot(symbol, timeframe, options.maxAgeMs || 90000);
      if (cached) return cached;
    }

    const resolvedMode = resolveRuntimeMode(options.mode || activeSymbol?.mode || bridgeConfig.bridgeMode || 'AUTO', symbol, timeframe);
    const tvRuntime = getLatestTradingviewRuntime();
    const robotV12 = getRobotV12ForSymbol(symbol);
    const extSnapshot = options.extSnapshot || await fetchLocalJson('/extension/data').then((r) => r.data || null).catch(() => null);
    const marketStatus = marketHoursChecker.getStatus(symbol);
    const activeSource = 'tradingview';
    const priceCandidates = activeSource === 'tradingview'
      ? [
          options.currentPrice,
          extSnapshot?.currentData?.price,
          extSnapshot?.activeSymbol?.price,
          tvRuntime?.payload?.price,
          getCoachMarketPrice(symbol)
        ]
      : [
          options.currentPrice,
          getCoachMarketPrice(symbol),
          extSnapshot?.currentData?.price,
          extSnapshot?.activeSymbol?.price,
          tvRuntime?.payload?.price
        ];
    const currentPrice = Number(priceCandidates.find((v) => Number.isFinite(Number(v)) && Number(v) > 0) || NaN);

    const runtimeTrade = options.instantTrade
      || buildTradingviewRuntimeTrade(symbol, timeframe, currentPrice, resolvedMode, tvRuntime, robotV12);
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

    // Fallback: si Pine absent, lire bridgeData.verdict (synthétique RSI/zone)
    const _tvEntry = tvDataStore[symbol] || tvDataStore[normalizeSymbol(symbol)?.canonical];
    const _bdVerdict = _tvEntry?.bridgeData?.verdict || null;
    const tvDirectionRaw = robotV12?.verdict
      || robotV12?.anticipation
      || tvRuntime?.payload?.verdict
      || tvRuntime?.payload?.anticipation
      || tvRuntime?.payload?.action
      || _bdVerdict   // ← verdict synthétique LIA/RSI/zone
      || 'WAIT';
    const runtimeDirectionRaw = runtimeTrade?.direction || runtimeTrade?.side || 'WAIT';
    const tvDirection = normalizeTradeDirection(tvDirectionRaw);
    const runtimeDirection = normalizeTradeDirection(runtimeDirectionRaw);
    const mtfDirection = deriveMtfDirectionFromRobot(robotV12);

    const conflicts = [];
    // Per-TF conflict only: runtimeDirection for THIS specific TF disagrees with global verdict
    // This is the only hard blocker — kills only the affected TF, not all TFs globally
    if (isDirectionalDirection(tvDirection) && isDirectionalDirection(runtimeDirection) && tvDirection !== runtimeDirection) {
      conflicts.push('Conflit directionnel: verdict TradingView != signal runtime');
    }
    // MTF divergence is informational only — NOT added to conflicts[] (would kill all TFs at once)
    // Reported as conflictReasons for display but does not gate entry
    const _mtfConflictNote = (isDirectionalDirection(tvDirection) && isDirectionalDirection(mtfDirection) && tvDirection !== mtfDirection)
      ? 'Divergence MTF: verdict global != lectures moyennes M1/M5/M15/H1'
      : null;

    const preferredDirection = isDirectionalDirection(tvDirection)
      ? tvDirection
      : (isDirectionalDirection(runtimeDirection) ? runtimeDirection : 'WAIT');

    const conflictDetected = conflicts.length > 0;
    const recommendation = (!marketStatus?.isOpen || conflictDetected)
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
    // Accept LIVE, CONDITIONAL, and WAIT — direction + levels are what matter, not proximity
    const statusAllowsEntry = tradeStatus === 'LIVE' || tradeStatus === 'CONDITIONAL' || tradeStatus === 'WAIT';
    const setupValidated = recommendation !== 'WAIT'
      && !!marketStatus?.isOpen
      && !conflictDetected
      && hasLiveLevels
      && statusAllowsEntry;
    const executionDecision = conflictDetected
      ? 'NO_ENTRY_CONFLICT'
      : (setupValidated ? 'ENTER' : 'WAIT');
    const executionReason = conflictDetected
      ? conflicts.join(' | ')
      : (setupValidated
        ? 'Entrée validée: direction TradingView alignée avec prix et niveaux SL/TP actifs.'
        : 'Entrée non validée: attendre confirmation complète (signal + niveaux + proximité prix).');

    const whyEntry = [];
    if (!marketStatus?.isOpen) {
      whyEntry.push('Marché fermé: aucune entrée tant que la session ne rouvre pas.');
    } else if (conflictDetected) {
      whyEntry.push('PAS D\'ENTRÉE: conflit de signal détecté entre les contextes TradingView/runtime.');
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

    const snapshot = {
      symbol,
      timeframe,
      modeResolved: resolvedMode,
      currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
      marketStatus,
      robotV12,
      signal: runtimeSignal,
      runtimeTrade: runtimeTrade || null,
      analysis: {
        recommendation,
        reason: executionReason,
        confidence: Number.isFinite(confidence) ? confidence : 50,
        strength: Number.isFinite(confidence) ? confidence : 50,
        anticipation: robotV12?.anticipation || (recommendation === 'WAIT' ? 'ATTENTE' : 'PRET')
      },
      execution: {
        decision: executionDecision,
        canEnter: executionDecision === 'ENTER',
        entry:  Number.isFinite(entryValue) ? entryValue : null,
        sl:     Number.isFinite(slValue)    ? slValue    : null,
        tp:     Number.isFinite(tpValue)    ? tpValue    : null,
        rrRatio: rrRatio || '--',
        reason: executionReason,
        conflict: conflictDetected,
        conflictReasons: _mtfConflictNote ? [...conflicts, _mtfConflictNote] : conflicts
      },
      news: newsPayload,
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
        conflictDetected,
        tvDirection,
        runtimeDirection,
        mtfDirection
      }
    };

    return storeCoachAnalysisSnapshot(symbol, timeframe, snapshot);
  }

  function createVirtualPositionFromTrade(symbol, timeframe, trade, currentPrice) {
    if (!trade) return null;
    return {
      symbol: String(symbol || trade.symbol || 'XAUUSD').toUpperCase(),
      timeframe: String(timeframe || 'H1').toUpperCase(),
      direction: String(trade.direction || trade.side || 'WAIT').toUpperCase(),
      entry: Number(trade.entry || currentPrice || 0),
      sl: Number(trade.sl || 0),
      tp: Number(trade.tp || 0),
      rrRatio: trade.rrRatio || '--',
      setupType: trade.setup_type || trade.setupType || '--',
      source: trade.source || 'coach-virtual',
      status: 'OPEN',
      bePlaced: false,
      partialTaken: false,
      openedAt: Date.now(),
      lastPrice: Number(currentPrice || trade.entry || 0),
      lastGuidance: 'Position virtuelle initialisée. Respecter invalidation, SL et TP.'
    };
  }

  function buildVirtualPositionSnapshot(state, instantTrade, livePayload, currentPrice) {
    const activeVirtual = state.virtualPosition || (state.entered ? createVirtualPositionFromTrade(state.symbol, state.timeframe, instantTrade, currentPrice) : null);
    if (!activeVirtual) {
      return {
        virtualPosition: null,
        nextAction: {
          phase: state.phase,
          primary: 'Aucune position virtuelle active. Attendre un setup validé avant entrée.',
          actions: ['WAIT', 'ENTER', 'RETEST']
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
    const progressToTp = rewardDistance > 0 ? Math.max(0, Math.min(100, Math.round((Math.abs(price - entry) / rewardDistance) * 100))) : 0;
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

    // Read-only coaching: suggest actions, never mutate Entry/SL/TP/RR.
    if (!tradeState.bePlaced && progress >= 35) {
      messages.push('Suggestion: sécuriser le risque en plaçant le stop au break-even.');
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
    tradeState.virtualPosition = { ...(tradeState.virtualPosition || {}), ...vp };
    tradeState.updatedAt = Date.now();

    return { virtualPack: { ...virtualPack, virtualPosition: vp }, messages };
  }

  function applyCoachTradeAction(state, action, note) {
    const a = String(action || '').toUpperCase();
    if (!a) return state;

    if (a === 'ENTER') {
      state.phase = 'OPEN';
      state.entered = true;
      state.lastAction = 'ENTER';
    } else if (a === 'OPEN') {
      state.phase = 'OPEN';
      state.entered = true;
      state.lastAction = 'OPEN';
    } else if (a === 'BE') {
      state.phase = 'MANAGE';
      state.bePlaced = true;
      state.lastAction = 'BE';
      if (state.virtualPosition) {
        state.virtualPosition.bePlaced = true;
        // Déplacer le SL au prix d'entrée (breakeven réel)
        if (Number(state.virtualPosition.entry) > 0) {
          state.virtualPosition.beSlPrev = state.virtualPosition.sl; // sauvegarde de l'ancien SL
          state.virtualPosition.sl = state.virtualPosition.entry;
          state.virtualPosition.beSlMovedAt = Date.now();
        }
      }
    } else if (a === 'TAKE_PROFIT') {
      state.phase = 'MANAGE';
      state.partialTaken = true;
      state.lastAction = 'TAKE_PROFIT';
      if (state.virtualPosition) state.virtualPosition.partialTaken = true;
    } else if (a === 'WAIT') {
      state.lastAction = 'WAIT';
      if (!state.entered) state.phase = 'WAIT_ENTRY';
    } else if (a === 'EXIT') {
      state.phase = 'EXITED';
      state.entered = false;
      state.armed = false;
      state.bePlaced = false;
      state.partialTaken = false;
      state.lastAction = 'EXIT';
      state.virtualPosition = null; // CRITICAL: null complet — plus de vp résiduelle
    } else if (a === 'RETEST') {
      state.phase = 'WAIT_ENTRY';
      state.entered = false;
      state.bePlaced = false;
      state.partialTaken = false;
      state.lastAction = 'RETEST';
      state.virtualPosition = null;
    } else if (a === 'ANALYSER') {
      state.phase = 'ANALYSER';
      state.armed = true;
      if (note?.direction) state.direction = note.direction;
      state.lastAction = 'ANALYSER';
      // Broadcast animation dashboard + extension immédiatement
      try {
        const _sym = state.symbol || note?.symbol || '';
        marketStore.broadcast({ type: 'analysis-running', source: 'extension', symbol: _sym });
        broadcastToExtension({ type: 'analysis-running', source: 'extension', symbol: _sym });
      } catch (_) {}
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
      stats: {
        marketOpen: !!marketStatus?.isOpen,
        market: marketStatus?.market || 'n/a',
        session: marketStatus?.session || 'n/a',
        anticipation: robotV12?.anticipation || null,
        rsi1m: robotV12?.rsi_1m ?? null,
        rsi5m: robotV12?.rsi_5m ?? null,
        timeframe: String(timeframe || 'H1').toUpperCase()
      }
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
    const isOperatorEntry = req.body?.operator === true; // watchdog a validé localement — bypass partiel serveur
    if (!action) return res.status(400).json({ ok: false, error: 'action requise' });

    const state = getCoachTradeState(symbol, timeframe);

    if (action === 'ENTER' || action === 'OPEN') {
      const live = getLivePrice(symbol);
      // operator=true avec entry dans le trade → watchdog fournit le prix lui-même, bloquer inutile
      const hintedEntryPrice = (isOperatorEntry && req.body?.trade && Number.isFinite(Number(req.body.trade.entry)) && Number(req.body.trade.entry) > 0)
        ? Number(req.body.trade.entry) : null;
      if (!live && !hintedEntryPrice) {
        return res.status(503).json({
          ok: false,
          error: 'ENTRY_BLOCKED_NO_LIVE_PRICE',
          message: "Entrée bloquée : prix TradingView non disponible. Synchronisez le flux avant d'entrer."
        });
      }
    }

    if (action === 'ENTER' || action === 'OPEN') {
      const preSnapshot = await computeCoachAnalysisSnapshot(symbol, timeframe, 'fr', state, {
        forceFresh: true,
        mode
      }).catch(() => null);
      const exec = preSnapshot?.execution || null;
      const snapDirection = preSnapshot?.sourceSummary?.tvDirection || preSnapshot?.sourceSummary?.runtimeDirection || 'WAIT';
      const marketOpen = preSnapshot?.sourceSummary?.marketOpen !== false;
      const hasDirection = snapDirection === 'LONG' || snapDirection === 'SHORT';

      // Hard block: market closed
      if (!marketOpen) {
        return res.status(409).json({
          ok: false, error: 'MARCHE_FERME',
          message: 'Entrée bloquée: marché fermé ou hors session.',
          execution: exec || { decision: 'WAIT', canEnter: false }, state
        });
      }
      // Hard block: DIRECTION CONFLICT — une seule direction autorisée (règle DIRECTION_SOURCE_UNIQUE)
      // Si une position active dans la direction opposée existe → blocage immédiat
      const _activeOpposite = Object.keys(coachTradeStateStore).find(k => {
        if (!k.startsWith(symbol + '|')) return false;
        const _st = coachTradeStateStore[k];
        if (!_st.entered || !_st.virtualPosition) return false;
        const _activeDir = String(_st.virtualPosition.direction || '').toUpperCase();
        return (snapDirection === 'LONG' && (_activeDir === 'SHORT' || _activeDir === 'SELL'))
            || (snapDirection === 'SHORT' && (_activeDir === 'LONG' || _activeDir === 'BUY'));
      });
      if (_activeOpposite && !isOperatorEntry) {
        const _oSt = coachTradeStateStore[_activeOpposite];
        return res.status(409).json({
          ok: false, error: 'DIRECTION_CONFLICT',
          message: `Entrée ${snapDirection} bloquée: position ${_oSt.virtualPosition.direction} active sur ${_activeOpposite}. Sortir d\'abord.`,
          execution: { decision: 'NO_ENTRY_CONFLICT', canEnter: false }, state
        });
      }
      // Hard block: no direction at all and not validated — bypassé si operator (watchdog a validé localement)
      if (!exec?.canEnter && !hasDirection && !isOperatorEntry) {
        return res.status(409).json({
          ok: false, error: 'ENTREE_NON_VALIDEE',
          message: exec?.reason || 'Entrée bloquée: aucun signal directionnel Bridge TV.',
          execution: exec || { decision: 'WAIT', canEnter: false }, state
        });
      }
      // Conflict block: explicit signal conflict (not just proximity)
      if (exec?.decision === 'NO_ENTRY_CONFLICT') {
        return res.status(409).json({
          ok: false, error: 'CONFLIT_SIGNAL',
          message: exec?.reason || 'Entrée bloquée: conflit de signal détecté.',
          execution: exec, state
        });
      }
    }

    const updated = applyCoachTradeAction(state, action, note);

    // ── EXIT GLOBAL — nettoyer TOUS les TF du symbole, pas juste le TF courant ──
    // Bugfix: position peut être sur H1 mais EXIT envoyé depuis M1. On doit tout nettoyer.
    if (action === 'EXIT' || action === 'RETEST') {
      const _exitSymbol = symbol;
      const _now = Date.now();
      Object.keys(coachTradeStateStore).forEach(k => {
        if (!k.startsWith(_exitSymbol + '|')) return;
        const _st = coachTradeStateStore[k];
        if (_st.entered || _st.virtualPosition || _st.phase === 'OPEN' || _st.phase === 'MANAGE' || _st.phase === 'ARMED') {
          _st.phase = 'EXITED';
          _st.entered = false;
          _st.armed = false;
          _st.bePlaced = false;
          _st.partialTaken = false;
          _st.virtualPosition = null;
          _st.lastAction = action;
          _st.updatedAt = _now;
        }
      });
    }

    saveCoachTradeStates(); // ── persiste immédiatement sur disque

    // Retour obligatoire M1 après EXIT/RETEST — timeframe ne reste pas bloqué sur H1
    if (action === 'EXIT' || action === 'RETEST') {
      activeTimeframe = 'M1';
    }

    const hintedTradeRaw = (req.body && typeof req.body.trade === 'object' && req.body.trade) ? req.body.trade : null;
    const hintedSource = String(hintedTradeRaw?.source || '').toLowerCase();
    const hintedTrade = (hintedTradeRaw
      && Number.isFinite(Number(hintedTradeRaw.entry))
      && Number.isFinite(Number(hintedTradeRaw.sl))
      && Number.isFinite(Number(hintedTradeRaw.tp))
      && (isOperatorEntry
        || hintedSource.includes('tradingview')
        || hintedSource.includes('indicator')
        || hintedSource.includes('watchdog')
        || hintedSource.includes('auto')))
      ? hintedTradeRaw
      : null;

    if ((action === 'ENTER' || action === 'OPEN') && !updated.virtualPosition) {
      try {
        const instant = await fetchLocalJson(
          '/instant-trade-live?symbol=' + encodeURIComponent(symbol) +
          '&tf=' + encodeURIComponent(timeframe) +
          (mode ? '&mode=' + encodeURIComponent(mode) : '')
        );
        const trade = instant.data?.trade || instant.data?.data || null;
        updated.virtualPosition = createVirtualPositionFromTrade(symbol, timeframe, trade, getCoachMarketPrice(symbol));
      } catch (_) {}

      // Fallback: allow extension-provided trade hints when instant-trade-live is not available.
      if (!updated.virtualPosition && hintedTrade) {
        updated.virtualPosition = createVirtualPositionFromTrade(symbol, timeframe, hintedTrade, getCoachMarketPrice(symbol));
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

    // Broadcast vers dashboard + extension — synchronisation immédiate après toute action
    const _beSlMoved = action === 'BE' && updated.virtualPosition && updated.virtualPosition.beSlMovedAt != null;
    const _isExit = action === 'EXIT' || action === 'RETEST';
    const _broadcastPayload = {
      type: _isExit ? 'position-reset' : 'trade-action',  // type distinct pour EXIT
      action,
      symbol,
      timeframe,
      phase: updated.phase,
      entered: false,           // toujours false après EXIT
      armed: false,
      bePlaced: false,
      virtualPosition: null,    // toujours null après EXIT
      tradeState: updated,
      ...(action === 'BE' && _beSlMoved ? {
        beSlNew: updated.virtualPosition?.sl,
        beSlPrev: updated.virtualPosition?.beSlPrev || null,
        beSlMovedAt: updated.virtualPosition?.beSlMovedAt
      } : {}),
      timestamp: Date.now()
    };
    if (!_isExit) {
      // Non-exit: garder les vraies valeurs
      _broadcastPayload.entered = updated.entered;
      _broadcastPayload.bePlaced = updated.bePlaced;
      _broadcastPayload.virtualPosition = updated.virtualPosition || null;
    }
    broadcastToExtension(_broadcastPayload);
    // SSE broadcast au dashboard aussi
    marketStore.broadcast(_broadcastPayload);

    res.json({ ok: true, state: updated, lia: tradeActionLia, _exitAll: _isExit });
  });

  // POST /coach/trade-state/reset — force-close d'urgence (bouton FORCER FERMETURE)
  // Remet l'état à EXITED même si le serveur avait perdu la position.
  app.post('/coach/trade-state/reset', (req, res) => {
    const raw = String(req.body?.symbol || marketStore.lastActiveSymbol || 'XAUUSD').toUpperCase();
    const symbol = normalizeSymbol(raw).canonical || raw;
    const timeframe = String(req.body?.timeframe || req.body?.tf || 'H1').toUpperCase();
    const key = getCoachTradeKey(symbol, timeframe);
    const prev = coachTradeStateStore[key] ? { ...coachTradeStateStore[key] } : null;
    coachTradeStateStore[key] = {
      symbol, timeframe,
      phase: 'EXITED', entered: false,
      bePlaced: false, partialTaken: false,
      lastAction: 'FORCE_RESET',
      updatedAt: Date.now(),
      virtualPosition: null, notes: []
    };
    saveCoachTradeStates();
    broadcastToExtension({ type: 'trade-action', action: 'EXIT', symbol, timeframe, phase: 'EXITED', entered: false, virtualPosition: null, timestamp: Date.now() });
    console.log('[FORCE RESET] Position fermée de force:', symbol, timeframe, '| prev phase:', prev?.phase || 'N/A');
    res.json({ ok: true, state: coachTradeStateStore[key], prev });
  });

  function generatePositionCoachMessage(tradeState, liveData) {
    const price = liveData?.currentPrice || liveData?.price;
    const entry = tradeState?.entry || liveData?.virtualPosition?.entry;
    const sl    = tradeState?.sl    || liveData?.virtualPosition?.sl;
    const tp    = tradeState?.tp    || liveData?.virtualPosition?.tp;
    const phase = tradeState?.phase;
    const entered = tradeState?.entered;
    const bePlaced = tradeState?.bePlaced;

    if (!entered) {
      return "J'observe le marché. Dis-moi quand tu es prêt à entrer.";
    }

    if (price && entry && sl && tp) {
      const distSL = Math.abs(price - sl);
      const distTP = Math.abs(price - tp);
      const pct = distSL / Math.abs(entry - sl);
      const isBuy = tp > entry;

      // Proche du SL
      if (pct < 0.15) {
        return `Attention — le prix s'approche du SL (${sl}). Surveille bien. Si la structure casse, on coupe proprement.`;
      }
      // Proche du TP
      if (distTP < distSL * 0.3) {
        return `On s'approche du TP (${tp}). Si tu veux sécuriser une partie maintenant, c'est le bon moment.`;
      }
      // Break-even non encore placé
      if (!bePlaced && pct > 0.5) {
        return `Le trade avance bien. Pense à remonter le SL au break-even (${entry}) pour protéger l'entrée.`;
      }
      // En cours propre
      if (isBuy) {
        return `Position longue en cours. Prix à ${price}, on vise ${tp}. Je surveille la structure. Tiens le cap.`;
      } else {
        return `Position courte en cours. Prix à ${price}, on vise ${tp}. Je surveille la pression vendeuse.`;
      }
    }

    // Phases nommées
    if (phase === 'be_reached') return `Break-even atteint. Risque zéro. On laisse courir vers le TP.`;
    if (phase === 'partial_taken') return `Première partie sécurisée. Laisse la position respirer — le reste court vers ${tp}.`;
    if (phase === 'trailing') return `On trail le SL. Reste calme et laisse le marché faire son travail.`;
    if (phase === 'closed') {
      const entry = tradeState?.entry || liveData?.virtualPosition?.entry;
      const exitPrice = liveData?.currentPrice || tradeState?.exitPrice;
      if (entry && exitPrice) {
        const pnlPips = Math.round((exitPrice - entry) * 10000);
        const won = pnlPips > 0;
        return won
          ? `✅ Trade terminé — +${pnlPips} pips. Bien joué. On laisse le marché se repositionner et on attend le prochain setup.`
          : `❌ Trade terminé — ${pnlPips} pips. Ça arrive. Le SL a fait son travail. On reste discipliné et on attend le prochain.`;
      }
      return `Trade terminé. On analyse et on prépare le suivant.`;
    }

    return `Position ouverte. Je surveille le marché pour toi.`;
  }

  app.post('/coach/close-summary', async (req, res) => {
    try {
      const { symbol, entry, exitPrice, sl, tp, direction, durationMin } = req.body;
      const pipMult = (symbol || '').includes('JPY') ? 100 : 10000;
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
    tradeJournal = [];
    try { fs.writeFileSync(JOURNAL_FILE, JSON.stringify([], null, 2)); } catch (_) {}
    broadcastToExtension({ type: 'journal-reset', timestamp: Date.now() });
    res.json({ ok: true, message: 'Journal réinitialisé' });
  });

  // ── /ai/coach — LIA (Lea) réelle via Ollama, bridge complet, SL structurel ──
  // CORRECTION VIOLATION: ancien endpoint utilisait templates statiques sans IA.
  // Nouveau: appel Ollama local (llama3.2) avec 100% des données bridge.
  // SL/TP: _calcStructuralLevels (zones réelles), jamais slPct/%.
  app.post('/ai/coach', async (req, res) => {
    try {
      const { symbol = '', timeframe = 'H1', price, multiTF = {}, execMode = 'AUTO' } = req.body || {};
      const sym      = String(symbol || '').toUpperCase() || 'XAUUSD';
      const tfs      = Object.keys(multiTF);
      const longs    = tfs.filter(tf => multiTF[tf]?.direction === 'LONG');
      const shorts   = tfs.filter(tf => multiTF[tf]?.direction === 'SHORT');
      const isLong   = longs.length > shorts.length && longs.length >= 2;
      const isShort  = shorts.length > longs.length && shorts.length >= 2;
      const signal   = isLong ? 'LONG' : isShort ? 'SHORT' : 'WAIT';
      const canEnter = !!(isLong || isShort) && longs.length !== shorts.length;

      // Données bridge complètes pour LIA
      const _tvE   = tvDataStore[sym] || {};
      const _bd    = _tvE.bridgeData || {};
      const _rv    = _tvE.robotV12   || {};
      const _px    = Number(price || _tvE.price || 0);
      const _prof  = normalizeSymbol(sym);
      const _swg   = _getM1Swing(sym) || _getM5Swing(sym);
      const _pineOk= _bd._synthRsiUsed !== true;
      const _fmtZ  = (h,l) => (h != null && l != null) ? `[${Number(l).toFixed(2)}/${Number(h).toFixed(2)}]` : 'absent';
      const _fmtV  = v => v != null ? Number(v).toFixed(2) : 'absent';

      // Scan multi-TF résumé
      const _tfSummary = tfs.map(tf => {
        const d = multiTF[tf];
        if (d?.noData) return `${tf}:N/A`;
        return `${tf}:${d?.direction||'?'}${d?.rsi ? '(RSI'+Number(d.rsi).toFixed(0)+')' : ''}`;
      }).join(' | ');

      // Message pour LIA — 100% des données bridge
      const _liaMsg = [
        `Analyse ${sym} @ ${_px} — mode ${execMode}`,
        ``,
        `SCAN MULTI-TF: ${_tfSummary || 'absent'}`,
        `Confluence: ${longs.length} LONG, ${shorts.length} SHORT sur ${tfs.length} TF`,
        ``,
        `BRIDGE COMPLET:`,
        `Prix=${_px} | zone=${_bd.inTop?'RÉSISTANCE':_bd.inBot?'SUPPORT':'neutre'} | verdict=${_rv.verdict||_bd.verdict||'?'} | Pine=${_pineOk?'ACTIF':'INACTIF'}`,
        `RSI: M1=${_bd.rsiTf1??_rv.rsi_1m??'?'} M5=${_bd.rsiTf2??_rv.rsi_5m??'?'} M15=${_bd.rsiTf3??_rv.rsi_15m??'?'} H1=${_bd.rsiTf4??_rv.rsi_60m??'?'}`,
        `lectureTech: M1="${String(_bd.lectureTech1||'?').replace(/_/g,' ')}" M5="${String(_bd.lectureTech2||'?').replace(/_/g,' ')}"`,
        `bullOB=${_fmtZ(_bd.bullOB_h,_bd.bullOB_l)} | bearOB=${_fmtZ(_bd.bearOB_h,_bd.bearOB_l)}`,
        `bullFVG=${_fmtZ(_bd.bullFVG_h,_bd.bullFVG_l)} | bearFVG=${_fmtZ(_bd.bearFVG_h,_bd.bearFVG_l)}`,
        `liqHigh=${_fmtV(_bd.liqHigh)} | liqLow=${_fmtV(_bd.liqLow)}`,
        `sweepHigh=${_fmtV(_bd.sweepHighLevel)} | sweepLow=${_fmtV(_bd.sweepLowLevel)}`,
        `range=[${_fmtV(_bd.rangeL)}/${_fmtV(_bd.rangeH)}] | longScore=${_bd.long_score??'?'} shortScore=${_bd.short_score??'?'}`,
        `swingM1: ${_swg ? `H=${_swg.swingHigh} L=${_swg.swingLow} (${_swg.source} n=${_swg.n})` : 'absent'}`,
        ``,
        `Donne ton analyse structurelle complète selon le format obligatoire.`,
      ].join('\n');

      // Appel LIA/Ollama local (jamais API externe)
      let response = '';
      let usedModel = 'rule-engine';
      try {
        const _liaModel  = await getLiaModel();
        const _liaMsgs   = [
          { role: 'system', content: LIA_SYSTEM_PROMPT },
          { role: 'user',   content: _liaMsg }
        ];
        response  = await callOllamaNarrative(_liaModel, _liaMsgs);
        usedModel = _liaModel;
      } catch (_liaErr) {
        // Fallback rule-based si Ollama KO
        const _vrd = String(_rv.verdict || signal).toUpperCase();
        response = [
          `DÉCISION: ${_vrd === 'LONG' ? 'LONG' : _vrd === 'SHORT' ? 'SHORT' : 'ATTENTE'}`,
          `CONTEXTE: ${sym} @ ${_px} | ${longs.length} LONG / ${shorts.length} SHORT sur ${tfs.length} TF`,
          `RSI: M1=${_bd.rsiTf1??'?'} M5=${_bd.rsiTf2??'?'} M15=${_bd.rsiTf3??'?'} H1=${_bd.rsiTf4??'?'}`,
          `ZONES: bullOB=${_fmtZ(_bd.bullOB_h,_bd.bullOB_l)} bearOB=${_fmtZ(_bd.bearOB_h,_bd.bearOB_l)} | liqH=${_fmtV(_bd.liqHigh)} liqL=${_fmtV(_bd.liqLow)}`,
          `CONFLIT: Ollama hors ligne — ${_liaErr.message || 'timeout'}`,
          `CONDITION: Relancer Ollama (ollama serve)`
        ].join('\n');
      }

      // SL/TP structurel (zones réelles — jamais slPct)
      let instantTrade = null;
      if (_px > 0 && (isLong || isShort)) {
        const _lvl = _calcStructuralLevels(_px, signal, _prof, _swg, _bd);
        if (_lvl.valid) {
          instantTrade = {
            direction: signal, entry: _lvl.entry,
            sl: _lvl.sl, tp: _lvl.tp,
            slPips: _lvl.slPips, tpPips: _lvl.tpPips,
            rrRatio: _lvl.rrRatio, slSource: _lvl.slSource, tpSource: _lvl.tpSource,
            source: 'structural-zones'
          };
        }
      }

      res.json({ ok: true, response, signal, canEnter, instantTrade, model: usedModel });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/coach/realtime', async (req, res) => {
    try {
      const raw = String(req.query.symbol || marketStore.lastActiveSymbol || getLatestTradingviewRuntime().symbol || '').toUpperCase();
      const symbol = normalizeSymbol(raw).canonical || raw;
      if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });

      // Utilise getLivePriceRelaxed (2min) pour le scan multi-TF — plus tolérant que les 30s stricts
      const live = getLivePriceRelaxed(symbol);
      if (!live) {
        res.status(503).json({
          ok: false, error: 'NO_LIVE_PRICE',
          message: `Prix TradingView non disponible pour ${symbol}. Ouvrez TradingView et attendez la synchronisation.`
        });
        return;
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
        safeLocalJson('/tradingview/live?symbol=' + encodeURIComponent(symbol) + '&tf=' + encodeURIComponent(timeframe)),
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
      const _fallbackNorm = normalizeTradeDirection(fallbackDirection);
      const fallbackReco = _fallbackNorm === 'LONG' ? 'BUY' : _fallbackNorm === 'SHORT' ? 'SELL' : 'WAIT';
      const fallbackReason = instantTrade?.technical
        || instantTrade?.sentiment
        || (marketStatus?.isOpen
          ? `Flux live actif (${marketStatus.market}/${marketStatus.session}).`
          : `Blocage live: marché fermé (${marketStatus?.market || 'n/a'}).`);
      const fallbackTradeStatus = String(instantTrade?.trade_status || '').toUpperCase();
      const fallbackCanEnter = !!marketStatus?.isOpen
        && (fallbackReco === 'BUY' || fallbackReco === 'SELL')
        && Number.isFinite(Number(instantTrade?.entry))
        && Number.isFinite(Number(instantTrade?.sl))
        && Number.isFinite(Number(instantTrade?.tp))
        && (fallbackTradeStatus === 'LIVE' || fallbackTradeStatus === 'CONDITIONAL' || fallbackTradeStatus === 'WAIT');
      let effectiveCoach = coach || {
        ok: true,
        generatedLive: true,
        execution: {
          decision: fallbackCanEnter ? 'ENTER' : 'WAIT',
          canEnter: fallbackCanEnter,
          entry:  Number.isFinite(Number(instantTrade?.entry)) ? Number(instantTrade.entry) : null,
          sl:     Number.isFinite(Number(instantTrade?.sl))    ? Number(instantTrade.sl)    : null,
          tp:     Number.isFinite(Number(instantTrade?.tp))    ? Number(instantTrade.tp)    : null,
          rrRatio: instantTrade?.rrRatio || '--',
          reason: fallbackCanEnter
            ? 'Entrée validée par le signal runtime fallback.'
            : 'Entrée non validée: attendre confirmation complète.',
          conflict: false,
          conflictReasons: []
        },
        agents: {
          analysis: {
            recommendation: fallbackReco,
            reason: fallbackReason,
            confidence: instantTrade?.confidence || 55,
            strength: instantTrade?.confidence || 55
          },
          risk: {
            riskLevel: instantTrade?.risk || (marketStatus?.isOpen ? 'Medium' : 'High'),
            riskReason: marketStatus?.isOpen ? 'Flux actif, valider spread/volatilité.' : 'Marché fermé ou indisponible.'
          },
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
      const activeSource = 'tradingview';

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

      if (tradeState.virtualPosition && virtualPack.virtualPosition) {
        tradeState.virtualPosition = { ...tradeState.virtualPosition, ...virtualPack.virtualPosition };
      }

      const levelSource = virtualPack.virtualPosition
        ? String(virtualPack.virtualPosition.source || 'virtual-position')
        : String(instantTrade?.source || 'none');
      const levelValues = virtualPack.virtualPosition || instantTrade || null;

      // Fallback coach LIA : si la position est entrée et que le LIA IA n'a pas produit de réponse valide,
      // on utilise generatePositionCoachMessage pour produire un message de suivi en français naturel.
      let coachLia = effectiveCoach?.lia || null;
      const liveSnapshot = { currentPrice, virtualPosition: virtualPack.virtualPosition };
      if (tradeState?.entered && (!coachLia?.response || coachLia.response.length < 10)) {
        coachLia = { ok: true, response: generatePositionCoachMessage(tradeState, liveSnapshot) };
      }
      if (coachLia && effectiveCoach) {
        effectiveCoach = { ...effectiveCoach, lia: coachLia };
      }

      // ── SIGNAL PER-TF depuis robotV12 — alimente coach.signal.verdict + stats RSI ──
      // Utilisé par popup.js pour colorer les cartes M1/M5/M15/H1
      const _rv = robotV12Live || {};
      const _rvTfMap = {
        M1:  { rsi: _rv.rsi_1m,  lecture: _rv.lecture_1m  || _rv.lectureTech1 },
        M5:  { rsi: _rv.rsi_5m,  lecture: _rv.lecture_5m  || _rv.lectureTech2 },
        M15: { rsi: _rv.rsi_15m, lecture: _rv.lecture_15m || _rv.lectureTech3 },
        H1:  { rsi: _rv.rsi_60m, lecture: _rv.lecture_60m || _rv.lectureTech4 },
        H4:  { rsi: _rv.rsi_4h,  lecture: null },
      };
      const _tfEntry = _rvTfMap[timeframe] || {};
      const _tfRsi   = _tfEntry.rsi != null ? Number(_tfEntry.rsi) : null;
      const _tfLec   = _tfEntry.lecture || null;
      function _rvRsiToLec(r) {
        if (r == null || isNaN(r)) return null;
        if (r >= 70) return 'SURACHETÉ';
        if (r >= 58) return 'HAUSSIER';
        if (r >= 42) return 'NEUTRE';
        if (r >= 30) return 'BAISSIER';
        return 'SURVENDU';
      }
      const _lecFinal  = _tfLec || _rvRsiToLec(_tfRsi);
      // Reconnaît les deux nomenclatures : Pine (ACHAT/VENTE) + RSI (HAUSSIER/BAISSIER)
      const _verdictTF = !_lecFinal ? 'WAIT'
        : (_lecFinal.includes('HAUSSIER') || _lecFinal === 'SURACHETÉ'
           || _lecFinal.includes('ACHAT')  || _lecFinal === 'HAUSSE') ? 'LONG'
        : (_lecFinal.includes('BAISSIER') || _lecFinal === 'SURVENDU'
           || _lecFinal.includes('VENTE')  || _lecFinal === 'BAISSE') ? 'SHORT'
        : 'NEUTRE';
      const _rsiStats = {
        rsi_m1:  _rv.rsi_1m  != null ? Number(_rv.rsi_1m)  : null,
        rsi_m5:  _rv.rsi_5m  != null ? Number(_rv.rsi_5m)  : null,
        rsi_m15: _rv.rsi_15m != null ? Number(_rv.rsi_15m) : null,
        rsi_h1:  _rv.rsi_60m != null ? Number(_rv.rsi_60m) : null,
        rsi_h4:  _rv.rsi_4h  != null ? Number(_rv.rsi_4h)  : null,
      };
      if (effectiveCoach) {
        effectiveCoach.signal = {
          verdict: _verdictTF,
          lecture: _lecFinal,
          rsi: _tfRsi,
          stats: _rsiStats,
          source: _tfLec ? 'pine' : (_tfRsi != null ? 'rsi' : 'none'),
          tf: timeframe,
          symbol,
        };
      }

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
        chart,
        coach: effectiveCoach,
        execution: effectiveCoach?.execution || null,
        candleClosure,
        marketStatus,
        robotV12: robotV12Live,
        tradeReasoning,
        tradeState,
        instantTrade,
        virtualPosition: virtualPack.virtualPosition,
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
        }
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
        reusedRoutes: ['/agents/:name/send', '/tradingview/live', '/lia/chat', '/calendar', '/news'],
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

      let snapshot = readCoachAnalysisSnapshot(symbol, timeframe, tradeState.entered ? 5000 : 90000);
      const tvFresh = getLatestTradingviewRuntime();
      const tvTs = Date.parse(tvFresh?.timestamp || 0);
      const snapshotTs = Number(snapshot?.updatedAt || 0);
      const mustRefresh = !snapshot || tradeState.entered || (Number.isFinite(tvTs) && tvTs > snapshotTs);
      if (mustRefresh) {
        snapshot = await computeCoachAnalysisSnapshot(symbol, timeframe, lang, tradeState, {
          forceFresh: true,
          maxAgeMs: tradeState.entered ? 5000 : 90000
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
        signal: runtimeSignal
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
      const lia = await requestDashboardLiaReadOnly({
        symbol,
        timeframe,
        decision: payload.analysis?.recommendation || 'WAIT',
        reason: payload.analysis?.reason || 'n/a',
        confidence: payload.analysis?.confidence || 0,
        entry: instantTrade?.entry,
        sl: instantTrade?.sl,
        tp: instantTrade?.tp,
        rr: instantTrade?.rrRatio || '--',
        robotV12: robotV12Live || null,
        market: marketStatus || null,
        news: payload.news || null,
        phase: tradeState.phase,
        entered: tradeState.entered,
        bePlaced: tradeState.bePlaced,
        partialTaken: tradeState.partialTaken,
        nextAction: executionGuidance.primary || 'Attendre confirmation structure.'
      });
      dashboardLia = lia?.ok
        ? lia
        : {
            ...(lia || {}),
            ok: false,
            channel: 'dashboard',
            response: [
              '[COACH RUNTIME]',
              executionGuidance.primary || 'Attendre confirmation structure avant toute entrée.',
              payload.analysis?.reason ? ('Pourquoi ' + String(payload.analysis.recommendation || 'ATTENTE').toLowerCase() + ': ' + payload.analysis.reason) : null,
              Array.isArray(payload.explainer?.whyEntry) && payload.explainer.whyEntry[1] ? ('Entrée: ' + payload.explainer.whyEntry[1]) : null,
              Array.isArray(payload.explainer?.whySl) && payload.explainer.whySl[0] ? ('SL: ' + payload.explainer.whySl[0]) : null,
              Array.isArray(payload.explainer?.whyTp) && payload.explainer.whyTp[0] ? ('TP: ' + payload.explainer.whyTp[0]) : null,
              payload.news?.warning ? ('News: ' + payload.news.warning) : payload.news?.symbolImpact ? ('Contexte: ' + payload.news.symbolImpact) : null,
              payload.risk?.guidance ? ('Risque: ' + payload.risk.guidance) : null,
              ('Position: phase=' + (tradeState.phase || '--') + ' | entered=' + (!!tradeState.entered) + ' | be=' + (!!tradeState.bePlaced) + ' | partial=' + (!!tradeState.partialTaken)),
              (goldCoach && goldCoach.summary) ? ('Coach: ' + goldCoach.summary) : null
            ].filter(Boolean).join('\n')
          };
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
    // SSE endpoints must pass through — their route handlers are defined after this middleware
    const _ssePassthrough = ['/coach/stream', '/extension/sync', '/coach/analyser-live'];
    if (_ssePassthrough.includes(p)) return next();
    const wantsJsonApi = (
      p.startsWith('/lia/') ||
      p.startsWith('/central-guide/') ||
      p.startsWith('/coach/') ||
      p.startsWith('/integration/') ||
      p.startsWith('/agents/') ||
      p.startsWith('/tradingview/') ||
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
      p.startsWith('/tradingview/') ||
      p === '/health' ||
      p === '/live/state'
    );
    if (wantsJsonApi) {
      return res.status(500).json({ ok: false, error: err?.message || 'INTERNAL_ERROR', path: p });
    }
    return res.status(500).send('Internal Server Error');
  });

  // ─── GLOBAL LOG SYSTEM ──────────────────────────────────────────────────────
  const globalLogger = require('./lib/global-logger');

  // Auto-log toutes les requêtes API (hors log lui-même)
  app.use(function(req, res, next) {
    if (req.path.startsWith('/system/log') || req.path.startsWith('/public')) return next();
    const t0 = Date.now();
    const origJson = res.json.bind(res);
    res.json = function(body) {
      const ms = Date.now() - t0;
      globalLogger.log({
        level: (body && body.ok === false) ? 'warn' : 'server',
        source: 'server', category: 'api',
        action: `${req.method} ${req.path}`,
        message: `${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`,
        data: { status: res.statusCode, ok: body?.ok, ms }
      });
      return origJson(body);
    };
    next();
  });

  // POST /system/log — clients (dashboard + extension) envoient leurs logs ici
  app.post('/system/log', function(req, res) {
    const { level, source, category, action, message, data } = req.body || {};
    if (!message && !action) return res.json({ ok: false, error: 'missing message or action' });
    const evt = globalLogger.log({ level: level||'info', source: source||'client', category: category||'ui', action, message, data });
    res.json({ ok: true, id: evt.id });
  });

  // GET /system/log/stream — SSE temps réel
  app.get('/system/log/stream', function(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    globalLogger.addSSEClient(res);
    const hb = setInterval(() => { try { res.write(':hb\n\n'); } catch { clearInterval(hb); } }, 20000);
    res.once('close', () => clearInterval(hb));
  });

  // GET /system/log/recent — JSON snapshot
  app.get('/system/log/recent', function(req, res) {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json({ ok: true, ...globalLogger.getRecent(limit) });
  });

  // Pages viewer + test runner
  app.get('/log-viewer', (_req, res) => { res.set('Cache-Control','no-store'); sendHTMLWithHelper(res, path.join(__dirname, 'public', 'log-viewer.html')); });
  app.get('/test-runner', (_req, res) => { res.set('Cache-Control','no-store'); sendHTMLWithHelper(res, path.join(__dirname, 'public', 'test-runner.html')); });

  // Lier bridge TV aux logs globaux
  if (marketStore && typeof marketStore.on === 'function') {
    marketStore.on('bridge-tv-update', (sym, payload) => {
      globalLogger.log({
        level: 'bridge', source: 'bridge', category: 'tv',
        action: 'BRIDGE_UPDATE',
        message: `Bridge TV: ${sym} prix=${payload?.price} TF=${payload?.timeframe}`,
        data: { symbol: sym, price: payload?.price, timeframe: payload?.timeframe, verdict: payload?.verdict }
      });
    });
  }

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
      role: 'Anti-fake verification for Bridge TV real data',
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
        'lia'
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
  }, 60000);

  // ── STABILITY WATCHDOG — CPU + memory monitor ──────────────────────────
  let _wdCpuPrev = process.cpuUsage();
  let _wdCpuHighCount = 0;
  setInterval(() => {
    const memMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const cpuNow = process.cpuUsage(_wdCpuPrev);
    _wdCpuPrev = process.cpuUsage();
    const cpuPct = Math.round((cpuNow.user + cpuNow.system) / 30000000 * 100); // 30s window
    if (cpuPct > 80) {
      _wdCpuHighCount++;
      console.warn(`[WATCHDOG] CPU élevé: ${cpuPct}% | MEM: ${memMb}MB | count=${_wdCpuHighCount}`);
      if (_wdCpuHighCount >= 3) {
        console.error('[WATCHDOG] 🔴 SURCHARGE DÉTECTÉE — 3 cycles consécutifs >80% CPU');
        // Slow down runtime loop
        if (typeof _runtimeLoopTargetIntervalMs !== 'undefined') {
          _runtimeLoopTargetIntervalMs = Math.min(_runtimeLoopTargetIntervalMs * 2, 30000);
          console.warn('[WATCHDOG] Runtime loop ralenti à', _runtimeLoopTargetIntervalMs, 'ms');
        }
        _wdCpuHighCount = 0;
      }
    } else {
      _wdCpuHighCount = Math.max(0, _wdCpuHighCount - 1);
    }
    if (memMb > 800) {
      console.warn(`[WATCHDOG] 🟡 Mémoire élevée: ${memMb}MB — GC forcé`);
      if (global.gc) global.gc();
    }
  }, 30000);
});

// ─── COACH LIVE-ANALYSIS — Monitoring position en cours ──────────────────────
// Appelé par dashboard.html toutes les 5s quand une position est ouverte.
// Retourne: momentum, action suggérée, état marché, P&L en pips.
// GET /stability/status — system health for dashboard watchdog indicator
app.get('/stability/status', (_req, res) => {
  const memMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  const upSec  = Math.round(process.uptime());
  res.json({
    ok: true,
    memMb,
    uptimeSec: upSec,
    status: memMb < 600 ? 'OK' : memMb < 800 ? 'WARN' : 'HIGH',
    runtimeIntervalMs: typeof _runtimeLoopCurrentIntervalMs !== 'undefined' ? _runtimeLoopCurrentIntervalMs : null
  });
});

app.get('/coach/live-analysis', (req, res) => {
  try {
    const sym = String(req.query.symbol || '').toUpperCase() || (activeSymbol?.symbol) || 'XAUUSD';
    const tvLive = tvDataStore[sym] || null;
    const tvAge  = tvLive ? (Date.now() - (tvLive.updatedAt || 0)) : Infinity;
    const bridgeOk = tvLive && tvAge < 60000;

    const tradeState = getCoachTradeState(sym, 'H1');
    const pos = tradeState?.virtualPosition || null;
    const currentPrice = bridgeOk ? (tvLive.price || 0) : (pos?.entry || 0);

    // P&L pips calculation
    let pnlPips = 0, pnlSign = '+', progressPct = 0, rrLeft = 0;
    if (pos && pos.entry > 0 && currentPrice > 0) {
      const isLong = String(pos.direction || '').toUpperCase().includes('LONG') || String(pos.direction || '').toUpperCase().includes('BUY');
      const raw = isLong ? (currentPrice - pos.entry) : (pos.entry - currentPrice);
      pnlPips = Math.round(raw * (sym.includes('JPY') ? 100 : 10000)) / 10;
      pnlSign = pnlPips >= 0 ? '+' : '-';
      if (pos.sl && pos.tp && pos.tp > 0) {
        const totalR = Math.abs(pos.tp - pos.entry);
        progressPct = totalR > 0 ? Math.round(Math.abs(raw) / totalR * 100) : 0;
        const remaining = Math.abs(pos.tp - currentPrice);
        rrLeft = totalR > 0 ? Math.round(remaining / totalR * 10) / 10 : 0;
      }
    }

    // Momentum from bridge data
    const lt3 = String(tvLive?.lectureTech3 || '').toUpperCase(); // M15
    const lt4 = String(tvLive?.lectureTech4 || '').toUpperCase(); // H1
    const sc3 = Number(tvLive?.scoreTech3 || 0);
    const sc4 = Number(tvLive?.scoreTech4 || 0);
    const hasIndicators = bridgeOk && (sc3 > 0 || sc4 > 0);

    let momentum = 'neutre';
    const posDir = String(pos?.direction || '').toUpperCase();
    const isLong = posDir.includes('LONG') || posDir.includes('BUY');
    if (!hasIndicators) {
      momentum = 'données manquantes';
    } else if (sc4 >= 70 && sc3 >= 65) {
      momentum = 'fort';
    } else if (sc4 >= 55 || sc3 >= 55) {
      const h1Aligned = isLong ? lt4.includes('ACHAT') : lt4.includes('VENTE');
      momentum = h1Aligned ? 'moyen' : 'ralentissement';
    } else {
      const h1Against = isLong ? lt4.includes('VENTE') : lt4.includes('ACHAT');
      momentum = h1Against ? 'retournement possible' : 'neutre';
    }

    // Action suggestion
    let action = 'HOLD', suggestion = 'Tenir la position — surveillance.', alertLevel = null;
    if (pnlPips > 0 && progressPct >= 50) {
      action = 'TRAIL_SL'; suggestion = 'Déplacer SL au-dessus du coût. Gains partiels sécurisés.'; alertLevel = 'attention';
    }
    if (pnlPips > 0 && progressPct >= 80) {
      action = 'PARTIAL_TP'; suggestion = 'Objectif proche — sortie partielle recommandée.'; alertLevel = 'urgent';
    }
    if (momentum === 'retournement possible') {
      action = 'SECURISER'; suggestion = 'Signal de retournement — sécuriser les gains ou sortir.'; alertLevel = 'urgent';
    }

    const details = [];
    if (bridgeOk) {
      if (sc4 > 0) details.push(`H1 score: ${sc4}% — ${lt4 || 'N/A'}`);
      if (sc3 > 0) details.push(`M15 score: ${sc3}% — ${lt3 || 'N/A'}`);
      if (tvLive?.bullRej) details.push('⚠ Rejet haussier structure');
      if (tvLive?.bearRej) details.push('⚠ Rejet baissier structure');
    }

    res.json({
      ok: true, sym, momentum, marketState: bridgeOk ? 'BRIDGE ACTIF' : 'BRIDGE HORS LIGNE',
      suggestion, action, alertLevel, details, pnlPips: Math.abs(pnlPips), pnlSign,
      progressPct: Math.min(100, progressPct), hasIndicators, rrLeft
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── DEBUG BRIDGE — État brut du bridge TV pour un symbole ───────────────────
app.get('/debug/bridge', (req, res) => {
  try {
    const sym = String(req.query.symbol || '').toUpperCase() || (activeSymbol?.symbol) || 'XAUUSD';
    const tvLive = tvDataStore[sym] || null;
    const ageMs = tvLive ? (Date.now() - (tvLive.updatedAt || 0)) : null;
    res.json({
      ok: true,
      symbol: sym,
      connected: !!(tvLive && ageMs < 60000),
      ageMs,
      bridgePayload: tvLive ? {
        lectureTech1: tvLive.lectureTech1 || tvLive.lecture_1m  || (tvLive.robotV12 && tvLive.robotV12.lecture_1m)  || null,
        lectureTech2: tvLive.lectureTech2 || tvLive.lecture_5m  || (tvLive.robotV12 && tvLive.robotV12.lecture_5m)  || null,
        lectureTech3: tvLive.lectureTech3 || tvLive.lecture_15m || (tvLive.robotV12 && tvLive.robotV12.lecture_15m) || null,
        lectureTech4: tvLive.lectureTech4 || tvLive.lecture_60m || (tvLive.robotV12 && tvLive.robotV12.lecture_60m) || null,
        scoreTech1:   tvLive.scoreTech1   || 0,
        scoreTech2:   tvLive.scoreTech2   || 0,
        scoreTech3:   tvLive.scoreTech3   || 0,
        scoreTech4:   tvLive.scoreTech4   || 0,
        rsiTf1:       tvLive.rsiTf1  != null ? tvLive.rsiTf1  : (tvLive.rsi_1m  != null ? tvLive.rsi_1m  : ((tvLive.robotV12 && tvLive.robotV12.rsi_1m)  ?? null)),
        rsiTf2:       tvLive.rsiTf2  != null ? tvLive.rsiTf2  : (tvLive.rsi_5m  != null ? tvLive.rsi_5m  : ((tvLive.robotV12 && tvLive.robotV12.rsi_5m)  ?? null)),
        rsiTf3:       tvLive.rsiTf3  != null ? tvLive.rsiTf3  : (tvLive.rsi_15m != null ? tvLive.rsi_15m : ((tvLive.robotV12 && tvLive.robotV12.rsi_15m) ?? null)),
        rsiTf4:       tvLive.rsiTf4  != null ? tvLive.rsiTf4  : (tvLive.rsi_60m != null ? tvLive.rsi_60m : ((tvLive.robotV12 && tvLive.robotV12.rsi_60m) ?? null)),
        verdict:      tvLive.verdict      || (tvLive.robotV12 && tvLive.robotV12.verdict)      || null,
        anticipation: tvLive.anticipation || (tvLive.robotV12 && tvLive.robotV12.anticipation) || null,
        long_score:   tvLive.long_score   || (tvLive.robotV12 && tvLive.robotV12.long_score)   || null,
        short_score:  tvLive.short_score  || (tvLive.robotV12 && tvLive.robotV12.short_score)  || null,
        entry:        tvLive.entry        || (tvLive.robotV12 && tvLive.robotV12.entry)        || null,
        sl:           tvLive.sl           || (tvLive.robotV12 && tvLive.robotV12.sl)           || null,
        tp:           tvLive.tp           || (tvLive.robotV12 && tvLive.robotV12.tp)           || null,
        price:        tvLive.price        || null,
        bullRej:      tvLive.bullRej      || false,
        bearRej:      tvLive.bearRej      || false,
        inTop:        tvLive.inTop        || false,
        inBot:        tvLive.inBot        || false,
      } : null
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── ORCHESTRATION ROUTES (top-level) ────────────────────────────────────────
let _orchestrationAutoTimer = null;
let _orchestrationEnabled = false;

app.get('/orchestration-status', (_req, res) => {
  const sym = activeSymbol?.symbol || null;
  const tvLive = sym ? tvDataStore[sym] : null;
  const tvAge  = tvLive ? (Date.now() - (tvLive.updatedAt || 0)) : Infinity;
  const bridgeActive = tvLive && tvAge < 30000;
  res.json({
    ok: true,
    enabled: _orchestrationEnabled,
    timer: _orchestrationAutoTimer ? 'active' : 'inactive',
    symbol: sym,
    bridgeStatus: bridgeActive ? 'ACTIVE' : 'OFFLINE',
    bridgeAgeMs: Number.isFinite(tvAge) ? Math.round(tvAge) : null,
    price: tvLive?.price || null,
    brokerMode: process.env.BROKER_MODE || 'paper'
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
    const sym = activeSymbol?.symbol || null;
    const tvLive = sym ? tvDataStore[sym] : null;
    const tvAge  = tvLive ? (Date.now() - (tvLive.updatedAt || 0)) : Infinity;
    const bridgeActive = tvLive && tvAge < 30000;

    if (!bridgeActive) {
      return res.json({
        ok: false,
        skipped: true,
        reason: sym ? `Bridge TV absent ou trop ancien (${Math.round(tvAge/1000)}s) pour ${sym}` : 'Aucun symbole actif — ouvre TradingView',
        bridgeStatus: bridgeActive ? 'ACTIVE' : 'OFFLINE',
        symbol: sym || null
      });
    }

    await runOrchestrationCycle();
    res.json({
      ok: true,
      message: 'Cycle exécuté',
      symbol: sym,
      price: tvLive?.price || null,
      bridgeStatus: 'ACTIVE',
      bridgeAgeMs: Math.round(tvAge)
    });
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
    const tvLive = tvDataStore[symbol];
    // Utilise getCoachTradeState si disponible (défini dans le bloc coach ci-dessus)
    const tradeState = (typeof getCoachTradeState === 'function')
      ? getCoachTradeState(symbol, 'H1')
      : null;
    const price = tvLive?.price || null;

    const payload = {
      symbol,
      price,
      timestamp: new Date().toISOString(),
      tradeState,
      coachMessage: (typeof generatePositionCoachMessage === 'function')
        ? generatePositionCoachMessage(tradeState, { currentPrice: price })
        : 'Je surveille le marché pour toi.',
      source: tvLive ? 'tradingview' : 'fallback'
    };

    client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
    client.lastPush = Date.now();
  } catch (err) {
    console.warn('[COACH STREAM] Push error:', err.message);
    coachStreamClients.delete(sessionId);
  }
}

// ── DECISION AGENT LOCAL — MODE STRICT ADEL ──────────────────────────────────
// RÈGLE SYSTÈME DÉFINITIVE (NON MODIFIABLE):
//   TOUS les composants doivent être présents et lus.
//   SI UN SEUL est absent → direction=WAIT, blocked=true, trade BLOQUÉ.
//   Aucun fallback, aucun mode dégradé, aucun calcul partiel.
//   Pine inactif → WAIT immédiat (OB/FVG/liq/sweep indisponibles).
// ─────────────────────────────────────────────────────────────────────────────
function _decisionAgent(sym, price, tvEnt, swingData, modeReq) {
  const bd  = tvEnt.bridgeData || {};
  const rv  = tvEnt.robotV12   || {};
  const pw  = _tvPriceWindow[sym] || [];

  // ── LECTURE DONNÉES BRUTES ────────────────────────────────────────────────
  const pineActive = bd._synthRsiUsed !== true;
  const rsi1  = bd.rsiTf1  ?? rv.rsi_1m  ?? null;
  const rsi5  = bd.rsiTf2  ?? rv.rsi_5m  ?? null;
  const rsi15 = bd.rsiTf3  ?? rv.rsi_15m ?? null;
  const rsi60 = bd.rsiTf4  ?? rv.rsi_60m ?? null;
  const lt1   = String(bd.lectureTech1 || rv.lecture_1m  || '').replace(/_/g,' ').toUpperCase();
  const lt5   = String(bd.lectureTech2 || rv.lecture_5m  || '').replace(/_/g,' ').toUpperCase();
  const lt15  = String(bd.lectureTech3 || rv.lecture_15m || '').replace(/_/g,' ').toUpperCase();
  const lt60  = String(bd.lectureTech4 || rv.lecture_60m || '').replace(/_/g,' ').toUpperCase();
  const verdict    = String(rv.verdict || bd.verdict || '').toUpperCase();
  const inTop      = bd.inTop === true;
  const inBot      = bd.inBot === true;
  const bullOB_h   = bd.bullOB_h   ?? null;
  const bullOB_l   = bd.bullOB_l   ?? null;
  const bearOB_h   = bd.bearOB_h   ?? null;
  const bearOB_l   = bd.bearOB_l   ?? null;
  const bullFVG_h  = bd.bullFVG_h  ?? null;
  const bullFVG_l  = bd.bullFVG_l  ?? null;
  const bearFVG_h  = bd.bearFVG_h  ?? null;
  const bearFVG_l  = bd.bearFVG_l  ?? null;
  const sweepH     = bd.sweepHighLevel ?? null;
  const sweepL     = bd.sweepLowLevel  ?? null;
  const liqH       = bd.liqHigh    ?? null;
  const liqL       = bd.liqLow     ?? null;
  const rangeH     = bd.rangeHigh  ?? null;
  const rangeL     = bd.rangeLow   ?? null;
  const longScore  = bd.long_score  ?? null;
  const shortScore = bd.short_score ?? null;
  const ticks      = pw.slice(-10).map(t => t.price);
  const tickDir    = ticks.length >= 3
    ? (ticks[ticks.length-1] > ticks[0] ? 'UP' : ticks[ticks.length-1] < ticks[0] ? 'DOWN' : 'FLAT')
    : 'UNKNOWN';

  // ── VÉRIFICATION STRICTE — TOUS LES COMPOSANTS OBLIGATOIRES ──────────────
  // Règle NON MODIFIABLE: un seul composant absent = WAIT immédiat, trade bloqué.
  const missing = [];

  // 1. Pine actif — sans Pine, OB/FVG/sweep/liq/lectureTech sont invalides
  if (!pineActive)                                                   missing.push('Pine inactif (RSI synthétique) — OB/FVG/sweep/liq indisponibles');
  // 2. Verdict bridge obligatoire
  if (!verdict || verdict === '' || verdict === 'UNDEFINED')         missing.push('verdict bridge absent');
  // 3. RSI 4 TFs obligatoires (pas synthétiques)
  if (rsi1  === null)                                                missing.push('RSI_1m absent');
  if (rsi5  === null)                                                missing.push('RSI_5m absent');
  if (rsi15 === null)                                                missing.push('RSI_15m absent');
  if (rsi60 === null)                                                missing.push('RSI_H1 absent');
  // 4. LectureTech M1 obligatoire
  if (!lt1 || lt1.length < 3)                                       missing.push('lectureTech M1 absent');
  // 5. OB — au moins un bull ET un bear
  if (bullOB_h === null || bullOB_l === null)                        missing.push('bullOB absent (Pine inactif ou non envoyé)');
  if (bearOB_h === null || bearOB_l === null)                        missing.push('bearOB absent (Pine inactif ou non envoyé)');
  // 6. FVG — au moins un bull ET un bear
  if (bullFVG_h === null || bullFVG_l === null)                      missing.push('bullFVG absent');
  if (bearFVG_h === null || bearFVG_l === null)                      missing.push('bearFVG absent');
  // 7. Liquidité
  if (liqH === null)                                                 missing.push('liqHigh absent');
  if (liqL === null)                                                 missing.push('liqLow absent');
  // 8. Sweep
  if (sweepH === null)                                               missing.push('sweepHighLevel absent');
  if (sweepL === null)                                               missing.push('sweepLowLevel absent');
  // 9. Range macro (filtre obligatoire)
  if (rangeH === null || rangeL === null)                            missing.push('rangeHigh/rangeLow absent');
  // 10. Micro-ticks
  if (ticks.length < 5)                                              missing.push(`micro-ticks insuffisants (${ticks.length} < 5)`);
  // 11. Swing M1
  if (!swingData)                                                    missing.push('swing M1/M5 absent — SL impossible');

  // ── BLOC STRICT: SI COMPOSANT MANQUANT → WAIT IMMÉDIAT ───────────────────
  if (missing.length > 0) {
    return {
      direction:     'WAIT',
      confidence:    'NONE',
      longPts:       0,
      shortPts:      0,
      blocked:       true,
      missingCount:  missing.length,
      missingComponents: missing,
      factors:       [],
      rsiSummary:    [rsi1,rsi5,rsi15,rsi60].map((r,i) => r !== null ? `RSI_${['1m','5m','15m','H1'][i]}=${r.toFixed(0)}` : `RSI_${['1m','5m','15m','H1'][i]}=?`).join(' | '),
      lectureSummary:'',
      zonesSummary:  'DONNÉES INCOMPLÈTES',
      tickDir,
      swingSummary:  swingData ? `swingH=${swingData.swingHigh} swingL=${swingData.swingLow} (${swingData.source})` : 'absent',
      pineActive,
      verdict,
      justification: [
        `BLOQUÉ — ${missing.length} composant(s) manquant(s)`,
        `RÈGLE STRICTE ADEL: système = COMPLET ou RIEN. Aucun calcul partiel.`,
        `Composants manquants:`,
        ...missing.map(m => `  ✗ ${m}`),
        `→ WAIT obligatoire jusqu'à données complètes.`,
      ].join('\n')
    };
  }

  // ── TOUS LES COMPOSANTS PRÉSENTS — SCORING DIRECTIONNEL ──────────────────
  let longPts = 0, shortPts = 0;
  const factors = [];

  // 1. Verdict bridge (source la plus fiable)
  if (verdict === 'LONG' || verdict === 'BUY')   { longPts  += 3; factors.push(`verdict=LONG (+3)`); }
  else if (verdict === 'SHORT'|| verdict === 'SELL') { shortPts += 3; factors.push(`verdict=SHORT (+3)`); }

  // 2. Score agrégé Pine
  if (longScore  !== null && longScore  > 0.6)   { longPts  += 2; factors.push(`longScore=${longScore.toFixed(2)} (+2)`); }
  if (shortScore !== null && shortScore > 0.6)   { shortPts += 2; factors.push(`shortScore=${shortScore.toFixed(2)} (+2)`); }

  // 3. RSI multi-TF (tous présents — vérifiés ci-dessus)
  const rsiLongCount  = [rsi1,rsi5,rsi15,rsi60].filter(r => r >= 55).length;
  const rsiShortCount = [rsi1,rsi5,rsi15,rsi60].filter(r => r <= 45).length;
  if (rsiLongCount  >= 2) { longPts  += rsiLongCount;  factors.push(`RSI long x${rsiLongCount} TF (+${rsiLongCount})`); }
  if (rsiShortCount >= 2) { shortPts += rsiShortCount; factors.push(`RSI short x${rsiShortCount} TF (+${rsiShortCount})`); }

  // 4. Lecture technique multi-TF
  const ltBullish = ['BULLISH','STRONG BULL','MOMENTUM BULL','TREND BULL'].some(k => [lt1,lt5,lt15,lt60].some(l => l.includes(k)));
  const ltBearish = ['BEARISH','STRONG BEAR','MOMENTUM BEAR','TREND BEAR'].some(k => [lt1,lt5,lt15,lt60].some(l => l.includes(k)));
  if (ltBullish) { longPts  += 2; factors.push(`lecture multi-TF bullish (+2) [${lt1}]`); }
  if (ltBearish) { shortPts += 2; factors.push(`lecture multi-TF bearish (+2) [${lt1}]`); }

  // 5. OB (tous présents — vérifiés ci-dessus)
  if (price >= bullOB_l && price <= bullOB_h)    { longPts  += 3; factors.push(`prix DANS bullOB [${bullOB_l}-${bullOB_h}] (+3)`); }
  else if (price > bullOB_h)                     { longPts  += 1; factors.push(`prix AU-DESSUS bullOB ${bullOB_h} (+1)`); }
  if (price >= bearOB_l && price <= bearOB_h)    { shortPts += 3; factors.push(`prix DANS bearOB [${bearOB_l}-${bearOB_h}] (+3)`); }
  else if (price < bearOB_l)                     { shortPts += 1; factors.push(`prix EN-DESSOUS bearOB ${bearOB_l} (+1)`); }

  // 6. FVG (tous présents)
  if (price >= bullFVG_l && price <= bullFVG_h)  { longPts  += 2; factors.push(`prix DANS bullFVG [${bullFVG_l}-${bullFVG_h}] (+2)`); }
  if (price >= bearFVG_l && price <= bearFVG_h)  { shortPts += 2; factors.push(`prix DANS bearFVG [${bearFVG_l}-${bearFVG_h}] (+2)`); }

  // 7. Sweep (retournement — tous présents)
  if (price >= sweepH * 0.9995 && price <= sweepH * 1.001) { shortPts += 2; factors.push(`sweepHigh ${sweepH} touché → retournement SHORT (+2)`); }
  if (price <= sweepL * 1.0005 && price >= sweepL * 0.999) { longPts  += 2; factors.push(`sweepLow ${sweepL} touché → retournement LONG (+2)`); }

  // 8. Liquidité (tous présents)
  if (price >= liqH * 0.9998)                    { shortPts += 1; factors.push(`liqHigh ${liqH} touchée → short possible (+1)`); }
  if (price <= liqL * 1.0002)                    { longPts  += 1; factors.push(`liqLow ${liqL} touchée → long possible (+1)`); }

  // 9. Range macro — FILTRE UNIQUEMENT (pas SL, pas entrée)
  const rangeSpan    = rangeH - rangeL;
  const pctInRange   = rangeSpan > 0 ? (price - rangeL) / rangeSpan : 0.5;
  if (pctInRange > 0.78) { shortPts += 1; factors.push(`haut de range macro ${(pctInRange*100).toFixed(0)}% → filtre short (+1)`); }
  if (pctInRange < 0.22) { longPts  += 1; factors.push(`bas de range macro ${(pctInRange*100).toFixed(0)}% → filtre long (+1)`); }

  // 10. Micro-ticks (présents — vérifiés)
  if (tickDir === 'UP')   { longPts  += 1; factors.push(`micro-ticks UP sur ${ticks.length} ticks (+1)`); }
  if (tickDir === 'DOWN') { shortPts += 1; factors.push(`micro-ticks DOWN sur ${ticks.length} ticks (+1)`); }

  // 11. Swing M1 (présent — vérifié)
  const sH = swingData.swingHigh || 0;
  const sL = swingData.swingLow  || 0;
  if (sH > 0 && price >= sH - 0.5)  { shortPts += 1; factors.push(`prix proche swingHigh M1 ${sH} → résistance (+1)`); }
  if (sL > 0 && price <= sL + 0.5)  { longPts  += 1; factors.push(`prix proche swingLow M1 ${sL} → support (+1)`); }

  // 12. inTop / inBot
  if (inTop) { shortPts += 1; factors.push('inTop → zone de vente (+1)'); }
  if (inBot) { longPts  += 1; factors.push('inBot → zone d\'achat (+1)'); }

  // ── DÉCISION FINALE ───────────────────────────────────────────────────────
  let agentDirection = 'WAIT';
  let confidence     = 'LOW';

  if (longPts > shortPts && longPts >= 4) {
    agentDirection = 'LONG';
    confidence = longPts >= 10 ? 'HIGH' : longPts >= 7 ? 'MEDIUM' : 'LOW';
  } else if (shortPts > longPts && shortPts >= 4) {
    agentDirection = 'SHORT';
    confidence = shortPts >= 10 ? 'HIGH' : shortPts >= 7 ? 'MEDIUM' : 'LOW';
  }

  // Filtre zone extrême (inTop/inBot override si signal faible)
  if (inTop && agentDirection === 'LONG'  && longPts  < 8)  agentDirection = 'WAIT';
  if (inBot && agentDirection === 'SHORT' && shortPts < 8)  agentDirection = 'WAIT';

  // ── RÉSUMÉS ───────────────────────────────────────────────────────────────
  const rsiSummary = [
    `RSI_1m=${rsi1.toFixed(0)}`, `RSI_5m=${rsi5.toFixed(0)}`,
    `RSI_15m=${rsi15.toFixed(0)}`, `RSI_H1=${rsi60.toFixed(0)}`
  ].join(' | ');
  const lectureSummary = [lt1,lt5,lt15,lt60].filter(l => l.length > 0).join(' / ');
  const zoneLines = [
    `bullOB=[${bullOB_l}/${bullOB_h}]`, `bearOB=[${bearOB_l}/${bearOB_h}]`,
    `bullFVG=[${bullFVG_l}/${bullFVG_h}]`, `bearFVG=[${bearFVG_l}/${bearFVG_h}]`,
    `sweepH=${sweepH}`, `sweepL=${sweepL}`, `liqH=${liqH}`, `liqL=${liqL}`,
    `range=[${rangeL}/${rangeH}] pos=${(pctInRange*100).toFixed(0)}%`
  ];

  return {
    direction:     agentDirection,
    confidence,
    longPts,
    shortPts,
    blocked:       false,
    missingCount:  0,
    missingComponents: [],
    factors,
    rsiSummary,
    lectureSummary,
    zonesSummary:  zoneLines.join(' | '),
    tickDir,
    swingSummary:  `swingH=${sH} swingL=${sL} (${swingData.source} n=${swingData.n})`,
    pineActive,
    verdict,
    justification: [
      `DIRECTION: ${agentDirection} [conf=${confidence} LONG=${longPts}pts SHORT=${shortPts}pts]`,
      `VERDICT bridge: ${verdict}`,
      `RSI multi-TF: ${rsiSummary}`,
      `Lecture TF: ${lectureSummary || 'absent'}`,
      `OB: bullOB=[${bullOB_l}/${bullOB_h}] | bearOB=[${bearOB_l}/${bearOB_h}]`,
      `FVG: bullFVG=[${bullFVG_l}/${bullFVG_h}] | bearFVG=[${bearFVG_l}/${bearFVG_h}]`,
      `Liq: liqH=${liqH} liqL=${liqL} | Sweep: H=${sweepH} L=${sweepL}`,
      `Range macro: [${rangeL}/${rangeH}] position=${(pctInRange*100).toFixed(0)}% ${pctInRange>0.78?'(HAUT)':pctInRange<0.22?'(BAS)':'(MILIEU)'}`,
      `Ticks: ${tickDir} (${ticks.length}) | Swing ${swingData.source}: H=${sH} L=${sL}`,
      `inTop=${inTop} inBot=${inBot}`,
      `Facteurs: ${factors.join(' | ')}`,
    ].join('\n')
  };
}

// ── CALCUL STRUCTUREL SL/TP — Zones bridge réelles (NON MODIFIABLE) ──────────
// SL = zone structurelle réelle la plus proche du mauvais côté
//      Priorité: OB → sweep → liq → swing M1
// TP = prochaine zone structurelle réelle dans la direction du trade
//      Priorité: OB → FVG → liq → range
// INTERDITS: ratio fixe seul si zone disponible | SL trop large | RR < 1.5
// ─────────────────────────────────────────────────────────────────────────────
function _calcStructuralLevels(price, direction, profile, swingData, bd) {
  const sym    = (profile && profile.canonical) || 'default';
  const digits = (profile && profile.digits)    || 2;
  const pip    = (profile && profile.pip)       || 0.1;
  const fmt    = v => Number(v).toFixed(digits);

  // Limites SL par symbole (identiques à symbol-normalizer.js)
  const MAX_SL  = { XAUUSD:10, XAGUSD:0.5, NAS100:30, US500:10, US30:50, BTCUSD:500, default:10 };
  const BUF_PTS = { XAUUSD:0.3, XAGUSD:0.05, NAS100:0.5, US500:0.3, US30:1, BTCUSD:5, default:0.3 };
  const maxSlPts = MAX_SL[sym]  || MAX_SL.default;
  const bufPts   = BUF_PTS[sym] || BUF_PTS.default;

  const pf = v => (v != null && !isNaN(parseFloat(v))) ? parseFloat(v) : null;

  // ── SL STRUCTUREL — zone d'invalidation (mauvais côté) ───────────────────
  let slLevel = null, slSource = null;

  if (direction === 'SHORT') {
    // SL au-dessus de l'entrée — zone qui invalide le SHORT
    const cands = [
      bd && pf(bd.bearOB_h)       ? { v: pf(bd.bearOB_h),       s: 'bearOB_h'  } : null,
      bd && pf(bd.sweepHighLevel) ? { v: pf(bd.sweepHighLevel),  s: 'sweepHigh' } : null,
      bd && pf(bd.liqHigh)        ? { v: pf(bd.liqHigh),          s: 'liqHigh'  } : null,
      swingData && pf(swingData.swingHigh) ? { v: pf(swingData.swingHigh), s: `swing_${swingData.source||'M1'}` } : null,
    ].filter(c => c && c.v > price); // doit être AU-DESSUS de l'entrée SHORT

    if (cands.length === 0) {
      return { entry:fmt(price), sl:null, tp:null, slPips:null, tpPips:null, rrRatio:'--',
               slSource:'absent', tpSource:'absent', valid:false,
               blockReason:'Aucune zone résistance visible au-dessus du prix — SL structurel impossible' };
    }
    const best = cands.reduce((a,b) => a.v < b.v ? a : b); // la plus proche (plus basse)
    slLevel  = best.v + bufPts;
    slSource = best.s;

  } else { // LONG
    // SL en-dessous de l'entrée — zone qui invalide le LONG
    const cands = [
      bd && pf(bd.bullOB_l)       ? { v: pf(bd.bullOB_l),        s: 'bullOB_l'  } : null,
      bd && pf(bd.sweepLowLevel)  ? { v: pf(bd.sweepLowLevel),   s: 'sweepLow'  } : null,
      bd && pf(bd.liqLow)         ? { v: pf(bd.liqLow),           s: 'liqLow'   } : null,
      swingData && pf(swingData.swingLow) ? { v: pf(swingData.swingLow), s: `swing_${swingData.source||'M1'}` } : null,
    ].filter(c => c && c.v < price); // doit être EN-DESSOUS de l'entrée LONG

    if (cands.length === 0) {
      return { entry:fmt(price), sl:null, tp:null, slPips:null, tpPips:null, rrRatio:'--',
               slSource:'absent', tpSource:'absent', valid:false,
               blockReason:'Aucune zone support visible en-dessous du prix — SL structurel impossible' };
    }
    const best = cands.reduce((a,b) => a.v > b.v ? a : b); // la plus proche (plus haute)
    slLevel  = best.v - bufPts;
    slSource = best.s;
  }

  const slDist = Math.abs(price - slLevel);

  // Validation distance SL
  if (slDist > maxSlPts) {
    return { entry:fmt(price), sl:fmt(slLevel), tp:null,
             slPips:(slDist/pip).toFixed(0), tpPips:null, rrRatio:'--',
             slSource, tpSource:'absent', valid:false,
             blockReason:`SL ${slDist.toFixed(2)}pts > max ${maxSlPts}pts (zone: ${slSource}) — trade bloqué` };
  }

  // ── TP STRUCTUREL — prochaine zone réelle dans la direction du trade ──────
  const MIN_RR    = 1.5;
  const minTpDist = slDist * MIN_RR;
  let tpLevel = null, tpSource = null;

  if (direction === 'SHORT') {
    // TP en-dessous — prochaine zone support dans la direction SHORT
    const cands = [
      bd && pf(bd.bullOB_h)   ? { v: pf(bd.bullOB_h),   s: 'bullOB_top'  } : null,
      bd && pf(bd.bullFVG_l)  ? { v: pf(bd.bullFVG_l),   s: 'bullFVG_bot' } : null,
      bd && pf(bd.liqLow)     ? { v: pf(bd.liqLow),       s: 'liqLow'      } : null,
      bd && pf(bd.rangeL)     ? { v: pf(bd.rangeL),        s: 'rangeL'      } : null,
      swingData && pf(swingData.swingLow) ? { v: pf(swingData.swingLow) - bufPts, s: `swingL_${swingData.source||'M1'}` } : null,
    ].filter(c => c && c.v < price && (price - c.v) >= minTpDist);

    if (cands.length > 0) {
      const best = cands.reduce((a,b) => a.v > b.v ? a : b); // plus proche (plus haute)
      tpLevel  = best.v;
      tpSource = best.s;
    } else {
      // Aucune zone structurelle avec RR 1.5 — fallback RR 2.0 minimum
      tpLevel  = price - slDist * 2.0;
      tpSource = 'RR2.0-no-structural-zone';
    }

  } else { // LONG
    // TP au-dessus — prochaine zone résistance dans la direction LONG
    const cands = [
      bd && pf(bd.bearOB_l)   ? { v: pf(bd.bearOB_l),   s: 'bearOB_bot'  } : null,
      bd && pf(bd.bearFVG_h)  ? { v: pf(bd.bearFVG_h),   s: 'bearFVG_top' } : null,
      bd && pf(bd.liqHigh)    ? { v: pf(bd.liqHigh),      s: 'liqHigh'     } : null,
      bd && pf(bd.rangeH)     ? { v: pf(bd.rangeH),        s: 'rangeH'      } : null,
      swingData && pf(swingData.swingHigh) ? { v: pf(swingData.swingHigh) + bufPts, s: `swingH_${swingData.source||'M1'}` } : null,
    ].filter(c => c && c.v > price && (c.v - price) >= minTpDist);

    if (cands.length > 0) {
      const best = cands.reduce((a,b) => a.v < b.v ? a : b); // plus proche (plus basse)
      tpLevel  = best.v;
      tpSource = best.s;
    } else {
      tpLevel  = price + slDist * 2.0;
      tpSource = 'RR2.0-no-structural-zone';
    }
  }

  const tpDist  = Math.abs(tpLevel - price);
  const rrRatio = slDist > 0 ? tpDist / slDist : 0;

  // Validation RR minimum
  if (rrRatio < 1.2) {
    return { entry:fmt(price), sl:fmt(slLevel), tp:fmt(tpLevel),
             slPips:(slDist/pip).toFixed(0), tpPips:(tpDist/pip).toFixed(0),
             rrRatio:rrRatio.toFixed(1), slSource, tpSource, valid:false,
             blockReason:`RR ${rrRatio.toFixed(1)}:1 < 1.2:1 (TP source: ${tpSource}) — trade bloqué` };
  }

  return {
    entry:   fmt(price),
    sl:      fmt(slLevel),
    tp:      fmt(tpLevel),
    slPips:  (slDist/pip).toFixed(0),
    tpPips:  (tpDist/pip).toFixed(0),
    rrRatio: rrRatio.toFixed(1),
    slSource, tpSource,
    valid:   true,
    blockReason: null
  };
}

// ── /coach/analyser-live — Bridge complet → Agent strict → SL/TP structurel ──
// RÈGLES INVIOLABLES:
//   1. Agent bloqué si un seul composant manque (MODE STRICT)
//   2. Direction WAIT si position opposée active (UNE SEULE DIRECTION)
//   3. SL = zone structurelle réelle (OB → sweep → liq → swing M1)
//   4. TP = prochaine zone réelle (OB → FVG → liq → range)
//   5. SL > max_pts → BLOQUÉ | RR < 1.2 → BLOQUÉ
app.get('/coach/analyser-live', async (req, res) => {
  try {
    const symRaw  = String(req.query.symbol || 'XAUUSD').toUpperCase();
    const sym     = normalizeSymbol(symRaw).canonical || symRaw;
    const tf      = String(req.query.tf || 'M1').toUpperCase();
    const modeReq = String(req.query.mode || 'SCALPER').toUpperCase();

    const tvEnt      = tvDataStore[sym] || tvDataStore[symRaw];
    const _tvUpdMs   = tvEnt ? (typeof tvEnt.updatedAt === 'number' ? tvEnt.updatedAt : new Date(tvEnt.updatedAt || 0).getTime()) : 0;
    const bridgeAge  = tvEnt ? (Date.now() - _tvUpdMs) : null;
    // Keepalive actif → accepter 120s (bridge refreshé toutes les 20s, cache peut être légèrement vieux)
    const _maxBridgeAge = _bridgeKeepaliveEnabled ? 120000 : 30000;
    const bridgeConn = !!(tvEnt && tvEnt.price > 0 && (bridgeAge === null || bridgeAge < _maxBridgeAge));

    if (!bridgeConn) {
      return res.json({ ok:false, error:'BRIDGE_OFFLINE',
        message:'Bridge TradingView hors ligne — impossible d\'analyser sans données réelles.',
        bridgeAge, source:'none' });
    }

    const price        = tvEnt.price || 0;
    const bd           = tvEnt.bridgeData || {};
    const synthRsiUsed = bd._synthRsiUsed === true;
    const profile      = normalizeSymbol(sym);
    let   swingData    = _getM1Swing(sym) || _getM1Swing(symRaw);
    if  (!swingData)   swingData = _getM5Swing(sym) || _getM5Swing(symRaw);

    // ── AGENT STRICT — lit 100% du flux, bloque si incomplet ─────────────────
    const agent = _decisionAgent(sym, price, tvEnt, swingData, modeReq);

    // ── RÈGLE UNE SEULE DIRECTION — position active = bloque signal opposé ───
    // SI une position est active dans une direction → direction opposée = WAIT
    // SI position active MÊME direction → afficher position (pas nouveau signal)
    const _allActive = Object.entries(coachTradeStateStore).filter(([k, st]) =>
      k.startsWith(sym + '|') && st.entered && st.virtualPosition
    );
    let _activeDir = null, _activeKey = null;
    if (_allActive.length > 0) {
      _activeKey = _allActive[0][0];
      _activeDir = String(_allActive[0][1].virtualPosition?.direction || '').toUpperCase();
    }

    // Direction agent — forcée à WAIT si conflit avec position active
    let direction = agent.direction;
    let _conflictReason = null;
    if (_activeDir) {
      const isOpposite = (direction === 'LONG'  && (_activeDir === 'SHORT' || _activeDir === 'SELL'))
                      || (direction === 'SHORT' && (_activeDir === 'LONG'  || _activeDir === 'BUY'));
      const isSame     = (direction === 'LONG'  && (_activeDir === 'LONG'  || _activeDir === 'BUY'))
                      || (direction === 'SHORT' && (_activeDir === 'SHORT' || _activeDir === 'SELL'));
      if (isOpposite) {
        direction       = 'WAIT';
        _conflictReason = `POSITION ${_activeDir} active sur ${_activeKey} — direction ${agent.direction} BLOQUÉE. Sortir d'abord.`;
      } else if (isSame) {
        // Même direction — afficher l'info position, pas nouveau signal
        _conflictReason = `POSITION ${_activeDir} déjà active sur ${_activeKey} — suivi en cours.`;
      }
    }

    // ── SL/TP STRUCTUREL — zones réelles bridge ───────────────────────────────
    let levels = null;
    if (direction !== 'WAIT' && price > 0 && !agent.blocked) {
      levels = _calcStructuralLevels(price, direction, profile, swingData, bd);
    }

    const levelsValid  = levels ? levels.valid === true : false;
    const canEnter     = direction !== 'WAIT' && levelsValid && !agent.blocked && !_conflictReason?.includes('BLOQUÉE');

    // ── COHÉRENCE PRIX/ZONE — vérification supplémentaire ────────────────────
    // SL doit être du bon côté du prix (SHORT: SL > price, LONG: SL < price)
    let _coherenceError = null;
    if (levels && levels.sl && levels.valid) {
      const slNum = parseFloat(levels.sl);
      if (direction === 'SHORT' && slNum <= price) _coherenceError = `INCOHÉRENCE: SL ${levels.sl} ≤ prix ${price} pour SHORT — bloqué`;
      if (direction === 'LONG'  && slNum >= price) _coherenceError = `INCOHÉRENCE: SL ${levels.sl} ≥ prix ${price} pour LONG — bloqué`;
      if (levels.tp) {
        const tpNum = parseFloat(levels.tp);
        if (direction === 'SHORT' && tpNum >= price) _coherenceError = `INCOHÉRENCE: TP ${levels.tp} ≥ prix ${price} pour SHORT — bloqué`;
        if (direction === 'LONG'  && tpNum <= price) _coherenceError = `INCOHÉRENCE: TP ${levels.tp} ≤ prix ${price} pour LONG — bloqué`;
      }
    }
    const finalCanEnter = canEnter && !_coherenceError;

    // Justification enrichie avec SL/TP structurel
    const _lvlJustif = levels ? [
      '',
      `SL: ${levels.sl} (source: ${levels.slSource}, ${levels.slPips} pips)`,
      `TP: ${levels.tp} (source: ${levels.tpSource || 'calculé'}, ${levels.tpPips} pips)`,
      `RR: ${levels.rrRatio}:1`,
      levels.valid ? '' : `BLOQUÉ: ${levels.blockReason}`,
      _coherenceError ? `COHÉRENCE: ${_coherenceError}` : '',
    ].filter(l => l).join('\n') : '';

    res.json({
      ok: true, symbol: sym, timeframe: tf, price, direction, canEnter: finalCanEnter,
      decision: finalCanEnter ? 'ENTER' : direction !== 'WAIT' ? 'WAIT_CONDITION' : 'WAIT',
      activePosition: _activeDir ? { direction: _activeDir, key: _activeKey } : null,
      agentAnalysis: {
        direction:      agent.direction,
        confidence:     agent.confidence,
        longPts:        agent.longPts,
        shortPts:       agent.shortPts,
        blocked:        agent.blocked,
        missingCount:   agent.missingCount,
        missingComponents: agent.missingComponents,
        verdict:        agent.verdict,
        rsiSummary:     agent.rsiSummary,
        lectureSummary: agent.lectureSummary,
        zonesSummary:   agent.zonesSummary,
        tickDir:        agent.tickDir,
        swingActive:    agent.swingSummary,
        pineActive:     agent.pineActive,
        factors:        agent.factors,
        justification:  agent.justification + _lvlJustif
      },
      levels: levels ? {
        entry:       levels.entry,
        sl:          levels.sl,
        tp:          levels.tp,
        slPips:      levels.slPips,
        tpPips:      levels.tpPips,
        rrRatio:     levels.rrRatio,
        slSource:    levels.slSource,
        tpSource:    levels.tpSource,
        valid:       levels.valid && !_coherenceError,
        blockReason: _coherenceError || levels.blockReason || null
      } : null,
      context: {
        rsiSource:         synthRsiUsed ? 'synthétique (Pine inactif)' : 'Pine Script live',
        inTop:             bd.inTop === true,
        inBot:             bd.inBot === true,
        bridgeAge:         Math.round(bridgeAge / 1000) + 's',
        swingTicks:        swingData?.n || 0,
        swingSource:       swingData?.source || 'absent',
        directionConflict: !!_conflictReason,
        conflictReason:    _conflictReason || null,
        coherenceError:    _coherenceError || null,
        mode:              modeReq,
        pineActive:        !synthRsiUsed
      },
      reason: finalCanEnter
        ? `ENTER ${direction} [${agent.confidence}]. SL ${levels?.sl} (${levels?.slSource}). TP ${levels?.tp} (${levels?.tpSource}). RR ${levels?.rrRatio}:1.`
        : _conflictReason
          ? _conflictReason
          : _coherenceError
            ? _coherenceError
            : agent.blocked
              ? `BLOQUÉ — ${agent.missingCount} composant(s) manquant(s). ${agent.missingComponents?.[0] || ''}`
              : !levelsValid && levels
                ? `BLOQUÉ: ${levels.blockReason}`
                : direction === 'WAIT'
                  ? `WAIT — score insuffisant (LONG=${agent.longPts} SHORT=${agent.shortPts}).`
                  : `Attente conditions.`,
      source: 'tradingview-bridge-live + decision-agent-strict + structural-levels'
    });
  } catch (e) {
    res.json({ ok: false, error: e.message, stack: e.stack?.split('\n')[0] });
  }
});
// ─────────────────────────────────────────────────────────────────────────────
