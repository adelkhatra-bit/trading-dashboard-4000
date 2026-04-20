// popup.js v4.1 — Trading Auto — PROJET ADEL ACTIF
// ADEL SIGNATURE: window.ADEL = true — extension identifiée, flux tracé de bout en bout
// COLOR SYSTEM (NON NEGOTIABLE):
//   ORANGE  #f97316 = pending / signal incertain / "va se passer"
//   VERT    #22c55e = confirmé LONG / achat / haussier / signal validé
//   ROUGE   #ef4444 = confirmé SHORT / vente / baissier / signal invalidé
//   JAUNE   #eab308 = WAIT / neutre / attention / news
//   GRIS    #64748b = neutre / pas de signal / inactif
//   BLANC   #f1f5f9 = texte principal
const COL_LONG    = '#22c55e';
const COL_SHORT   = '#ef4444';
const COL_PENDING = '#f97316';
const COL_WAIT    = '#eab308';
const COL_NEUTRAL = '#64748b';
const COL_TEXT    = '#f1f5f9';
'use strict';

const API = 'http://127.0.0.1:4000';
const TFS  = ['M1','M5','M15','M30','H1','H4','D1','W1'];
const MTFS = ['M1','M5','M15','H1','H4','D1'];
const POPUP_STATE_KEY = 'taa_popup_state_v2';

// ── ADEL SIGNATURE ────────────────────────────────────────────────────────────
window.ADEL = true;
window.ADEL_EXT_ID = 'bbdmldjileifgbmhgeodfjjodajogjip';
window.ADEL_VERSION = '2.0.0';
const ADEL_SIG = 'TRADING-AUTO-ANALYZER';
console.log('[ADEL] Popup actif — Trading Auto Analyzer', window.ADEL_VERSION, '|', window.ADEL_EXT_ID);

const state = {
  symbol:      'XAUUSD',
  timeframe:   'H1',
  tradeMode:   'AUTO',
  price:       null,
  sse:         null,
  live:        null,
  newsEvents:  [],
  tradeState:  null,
  persistent:  false,
  lastRec:     null,
  chartOpen:   false,
  userLocked:  false,   // true = user manually selected, no auto-override
  agentSessionActive: false,
  muted:       false,   // MUTE button state
  // ── SÉPARATION UT AFFICHÉE / UT ROBOT ─────────────────────────────────────
  // _analysisLockedTf : TF verrouillé après ANALYSER (robot l'utilise pour tout)
  //   Jamais écrasé par state.timeframe (ce que l'utilisateur regarde sur TV)
  //   Resetté uniquement sur WAIT / disarm / nouvelle analyse
  _analysisLockedTf: null,
  bridgeConfig: {
    agentName: 'orchestrator',
    bridgeSource: 'tradingview',
    activeSource: 'tradingview',
    bridgeMode: 'AUTO',
    bridgeEnabled: true,
    tradingviewEnabled: true,
    sendPreAlerts: true,
    sendSignals: true,
    symbolAliasBridge: ''
  },
  lastLiveCoachRefreshAt: 0,
  stats: { signals: 0, trades: 0, lastEvent: '--' },
  conn: { healthFails: 0, sseFails: 0, lastOkAt: 0 },
  beepCtx: null,
  alertedEntryKeys: {},
  _alertedKeys: {}
};

// ── ALERT SYSTEM ──────────────────────────────────────────────────────────────
const ALERT_SOUNDS = {
  PRE_ALERT:   { freq: 660,  count: 2, interval: 200 },  // 2 bips moyens = se préparer
  ENTRY_READY: { freq: 880,  count: 3, interval: 150 },  // 3 bips aigus = entrée validée
  NEAR_SL:     { freq: 440,  count: 2, interval: 200 },
  NEWS_HIGH:   { freq: 660,  count: 1, interval: 0   },
  BE_REACHED:  { freq: 523,  count: 1, interval: 0   },
  TP_REACHED:  { freq: 1047, count: 3, interval: 100 }
};

const ALERT_STYLES = {
  PRE_ALERT:   { bg: '#eab308', color: '#000' },  // jaune = se préparer
  ENTRY_READY: { bg: '#22c55e', color: '#000' },
  NEAR_SL:     { bg: '#ef4444', color: '#fff' },
  NEWS_HIGH:   { bg: '#f97316', color: '#fff' },
  BE_REACHED:  { bg: '#3b82f6', color: '#fff' },
  TP_REACHED:  { bg: '#22c55e', color: '#000' },
  SECURED:     { bg: '#22c55e', color: '#000' }   // vert = gains sécurisés
};

const ALERT_MESSAGES = {
  PRE_ALERT:   '🟡 PRE-ALERTE — SETUP EN FORMATION',
  ENTRY_READY: '⏳ SETUP EN PRÉPARATION — attente validation M1',
  NEAR_SL:     '⚠️ PROCHE DU SL — SURVEILLE',
  NEWS_HIGH:   '📰 NEWS IMPACT FORT',
  BE_REACHED:  '✅ BREAK-EVEN ATTEINT',
  TP_REACHED:  '🎯 TP ATTEINT — FÉLICITATIONS',
  SECURED:     '✅ GAINS SÉCURISÉS — SL AU-DESSUS DE L\'ENTRÉE'
};

// ── SPEECH (SpeechSynthesis) ──────────────────────────────────────────────────
// ─── VOIX — file d'attente pour ne jamais couper une phrase en cours ────────
var _speakQueue = [];
var _speakBusy  = false;
// ── GUARD EXIT — timestamp du dernier EXIT local (évite race condition SSE position-sync) ──
// Problème: position-sync SSE avec entered:true peut arriver après le retour HTTP EXIT
// si le broadcast SSE était déjà en vol. On ignore tout entered:true pendant 30s après EXIT.
var _lastExitAt = 0;

function _drainSpeakQueue() {
  // MUTE guard — si muet: vider la file et s'arrêter immédiatement
  if (state.muted) { _speakQueue = []; _speakBusy = false; return; }
  if (_speakBusy || _speakQueue.length === 0) return;
  var _txt = _speakQueue.shift();
  _speakBusy = true;
  try {
    var u = new SpeechSynthesisUtterance(_txt);
    u.lang = 'fr-FR'; u.rate = 1.05; u.pitch = 1.0; u.volume = 1.0;
    u.onend   = function() { _speakBusy = false; _drainSpeakQueue(); };
    u.onerror = function() { _speakBusy = false; _drainSpeakQueue(); };
    // Failsafe: si onend ne tire jamais (bug Chrome), débloquer après 12s max
    var _speakTimeout = setTimeout(function() {
      if (_speakBusy) { _speakBusy = false; _drainSpeakQueue(); }
    }, 12000);
    u.onend = function() { clearTimeout(_speakTimeout); _speakBusy = false; _drainSpeakQueue(); };
    u.onerror = function() { clearTimeout(_speakTimeout); _speakBusy = false; _drainSpeakQueue(); };
    window.speechSynthesis.speak(u);
  } catch(_) { _speakBusy = false; }
}

// Prononciation correcte des symboles de marché pour le TTS FR
function _prononcerSymbole(text) {
  return (text || '')
    .replace(/\bBTCUSDT\b/gi, 'Bitcoin')
    .replace(/\bBTCUSD\b/gi,  'Bitcoin')
    .replace(/\bBTC\b/gi,     'Bitcoin')
    .replace(/\bXAUUSD\b/gi,  'Gold')
    .replace(/\bGOLD\b/gi,    'Gold')
    .replace(/\bETHUSD\b/gi,  'Ethereum')
    .replace(/\bETH\b/gi,     'Ethereum')
    .replace(/\bEURUSD\b/gi,  'Euro Dollar')
    .replace(/\bGBPUSD\b/gi,  'Livre Dollar')
    .replace(/\bUSDJPY\b/gi,  'Dollar Yen')
    .replace(/\bUS500\b/gi,   'S&P cinq cents')
    .replace(/\bNAS100\b/gi,  'Nasdaq cent')
    .replace(/\bSOLUSD\b/gi,  'Solana');
}

function speak(text) {
  if (state.muted) return;
  try {
    if (!window.speechSynthesis) return;
    // Prononciation correcte des symboles AVANT le nettoyage
    text = _prononcerSymbole(text);
    // Nettoyer le texte avant TTS — les emojis/symboles/pipes sont lus de manière incohérente par le TTS FR
    text = (text || '')
      // Emojis unicode larges (flags, symbols, emoticons)
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
      // Emojis et symboles courants du bridge
      .replace(/[⚠️✅❌⭐🔴🟢🟡🔵⚡👁🔍⏳📍📰📊🚨🚀🔒]/gu, '')
      // Flèches et triangles (direction)
      .replace(/[▲▼◀▶→←↑↓]/g, '')
      // Séparateurs bridge — remplacer | par une pause naturelle
      .replace(/\s*\|\s*/g, '. ')
      // Notations RSI abrégées: "R65" → "RSI 65", "R:65" → "RSI 65"
      .replace(/\bR:(\d+)\b/g, 'RSI $1')
      .replace(/\bR(\d{2,3})\b/g, 'RSI $1')
      // Supprimer les parenthèses de pourcentage standalone: "(65%)" → ""
      .replace(/\(\d+%\)/g, '')
      // Nettoyer les espaces multiples et points doubles
      .replace(/\.\s*\./g, '.').replace(/\s{2,}/g, ' ').trim()
      // Supprimer les points de début/fin superflus
      .replace(/^[\s.]+|[\s.]+$/g, '').trim();
    if (!text) return;
    var _urgent = text && (text.startsWith('Attention') || text.includes('ALERTE') || text.includes('Stop loss'));
    if (_urgent) {
      // Alerte urgente → interrompre immédiatement et vider la file
      _speakQueue = [];
      _speakBusy  = false;
      window.speechSynthesis.cancel();
      _speakQueue.push(text);
      setTimeout(_drainSpeakQueue, 80); // léger délai après cancel
    } else {
      // Phrase normale → max 1 en attente (la plus récente remplace l'ancienne si pas encore jouée)
      if (_speakQueue.length >= 1) _speakQueue.splice(0, _speakQueue.length - 0); // vider si pile
      _speakQueue.push(text);
      _drainSpeakQueue();
    }
  } catch(_) {}
}

// ─── COACH TEXT — système de priorité pour éviter le scintillement ───────────
// Chaque source a une priorité. Une source de priorité inférieure ne peut pas
// écraser un message plus important pendant sa durée de vie (TTL).
// Priorités: 10=critique SL/TP, 8=danger/entrée, 6=phase BE/trail, 4=alerte,
//            2=info marché, 1=flux idle (messages généraux toutes les 4s)
var _ctPrio   = 0;          // priorité du message actuel
var _ctExpiry = 0;          // timestamp d'expiration du message actuel
var _ctLast   = '';         // dernier texte affiché (évite re-render inutile)

function setCoachText(txt, color, prio, ttlMs) {
  var _now = Date.now();
  var _p   = prio  || 0;
  var _ttl = ttlMs || 3000;
  // Bloquer si un message de priorité supérieure est encore actif
  if (_p < _ctPrio && _now < _ctExpiry) return;
  var el = document.getElementById('coachText');
  if (!el) return;
  // Ne pas re-rendre si texte identique (évite tout flash DOM)
  if (el.textContent === txt && (color == null || el.style.color === color)) {
    // Prolonger la durée si même message
    _ctExpiry = Math.max(_ctExpiry, _now + _ttl);
    return;
  }
  el.textContent = txt;
  if (color != null) el.style.color = color;
  _ctPrio   = _p;
  _ctExpiry = _now + _ttl;
  _ctLast   = txt;
}

function toggleNewsExt() {
  const body = document.getElementById('newsListBody');
  const icon = document.getElementById('newsExtIcon');
  if (!body) return;
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  if (icon) icon.classList.toggle('open', !isOpen);
}

function toggleMute() {
  state.muted = !state.muted;
  const btn = document.getElementById('btnMute');
  if (btn) {
    btn.textContent = state.muted ? '🔇 MUET' : '🔊 SON';
    btn.style.cssText = state.muted
      ? 'background:#374151;color:#94a3b8;'
      : 'background:#1e293b;color:#64748b;';
  }
  if (state.muted) {
    // Vider intégralement la file vocale ET annuler l'utterance en cours
    // (cancel() seul ne suffit pas — l'onerror relance _drainSpeakQueue sinon)
    _speakQueue = [];
    _speakBusy  = false;
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
      // Double cancel après 80ms — bug Chrome : un seul cancel parfois insuffisant
      setTimeout(function() { if (state.muted && window.speechSynthesis) window.speechSynthesis.cancel(); }, 80);
    }
  }
  // Sync mute avec dashboard via serveur
  fetchJson('/set-mute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ muted: state.muted, source: 'extension' })
  }).catch(function() {});
}

function triggerAlert(type, extra) {
  // Son — respecte le MUTE
  const s = ALERT_SOUNDS[type];
  if (s && !state.muted) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < s.count; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = s.freq;
        const t = ctx.currentTime + i * (s.interval / 1000 + 0.12);
        gain.gain.setValueAtTime(0.3, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        osc.start(t); osc.stop(t + 0.12);
      }
    } catch(_) {}
  }
  // Banner
  const banner = document.getElementById('alertBanner');
  const textEl = document.getElementById('alertText');
  if (!banner || !textEl) return;
  const st = ALERT_STYLES[type] || {};
  banner.style.background = st.bg || '#f97316';
  banner.style.color = st.color || '#fff';
  textEl.textContent = (ALERT_MESSAGES[type] || type) + (extra ? ' — ' + extra : '');
  banner.style.display = 'block';
  // Auto-hide après 6s sauf NEAR_SL
  if (type !== 'NEAR_SL') setTimeout(() => { if (banner) banner.style.display = 'none'; }, 6000);
}
// ─────────────────────────────────────────────────────────────────────────────

let saveStateTimer = null;

function loadPersistedState() {
  try {
    var raw = localStorage.getItem(POPUP_STATE_KEY);
    if (!raw) return;
    var saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return;
    if (saved.symbol) state.symbol = String(saved.symbol).toUpperCase();
    if (saved.timeframe && TFS.indexOf(String(saved.timeframe).toUpperCase()) >= 0) state.timeframe = String(saved.timeframe).toUpperCase();
    if (saved.tradeMode) state.tradeMode = String(saved.tradeMode).toUpperCase();
    if (Number.isFinite(Number(saved.price))) state.price = Number(saved.price);
    if (typeof saved.chartOpen === 'boolean') state.chartOpen = saved.chartOpen;
    if (typeof saved.userLocked === 'boolean') state.userLocked = saved.userLocked;
    if (typeof saved.agentSessionActive === 'boolean') state.agentSessionActive = saved.agentSessionActive;
    if (saved.stats && typeof saved.stats === 'object') state.stats = Object.assign({}, state.stats, saved.stats);
    if (saved.alertedEntryKeys && typeof saved.alertedEntryKeys === 'object') state.alertedEntryKeys = saved.alertedEntryKeys;
    // Ne restaurer le winner que s'il y a une position active — sinon le watchdog entre sans nouveau scan
    if (saved._mtfWinnerTf && TFS.indexOf(String(saved._mtfWinnerTf).toUpperCase()) >= 0
        && saved.tradeState && saved.tradeState.entered)
      state._mtfWinner = { tf: String(saved._mtfWinnerTf).toUpperCase() };
    // Restaurer la position active — source d'autorité immédiate avant le premier position-sync SSE
    if (saved.tradeState && typeof saved.tradeState === 'object' && saved.tradeState.entered) {
      state.tradeState = saved.tradeState;
    }
    // Restaurer l'état armé — le watchdog reprend sans que l'utilisateur clique ENTRER
    // Guard: ne pas restaurer armed si trop vieux (> 30min) — évite un armement fantôme
    var _armedAge = saved._armedAt ? (Date.now() - saved._armedAt) : Infinity;
    if (saved.armed === true && _armedAge < 30 * 60 * 1000
        && !(saved.tradeState && saved.tradeState.entered)) {
      state.armed = true;
      state._armedDirection = saved._armedDirection || null;
      state._armedAt        = saved._armedAt        || Date.now();
      state._lockedWdTf     = saved._lockedWdTf     || null;
      state._analysisLockedTf = saved._analysisLockedTf || null;
      // Le watchdog sera relancé par refreshAll → section "state.armed || _tsPhase === 'ARMED'"
    }
  } catch (_) {}
}

function savePersistedState() {
  try {
    localStorage.setItem(POPUP_STATE_KEY, JSON.stringify({
      symbol: state.symbol,
      timeframe: state.timeframe,
      tradeMode: state.tradeMode,
      price: state.price,
      chartOpen: !!state.chartOpen,
      userLocked: !!state.userLocked,
      agentSessionActive: !!state.agentSessionActive,
      stats: state.stats,
      alertedEntryKeys: state.alertedEntryKeys,
      // Persister le TF winner du scan — watchdog utilise le bon TF même après reload popup
      _mtfWinnerTf: (state._mtfWinner && state._mtfWinner.tf) ? state._mtfWinner.tf : null,
      // Persister l'état armé — robot reprend la surveillance après reload popup
      armed: !!state.armed,
      _armedDirection: state._armedDirection || null,
      _armedAt: state.armed && state._armedAt ? state._armedAt : null,
      _lockedWdTf: state._lockedWdTf || null,
      _analysisLockedTf: state._analysisLockedTf || null,
      // Persister l'état de position — permet de retrouver entry/sl/tp immédiatement au reload
      tradeState: (state.tradeState && state.tradeState.entered) ? {
        entered: true,
        phase: state.tradeState.phase || 'OPEN',
        direction: state.tradeState.direction || null,
        symbol: state.tradeState.symbol || state.symbol,
        virtualPosition: state.tradeState.virtualPosition
          ? {
              entry:    state.tradeState.virtualPosition.entry,
              sl:       state.tradeState.virtualPosition.sl,
              tp:       state.tradeState.virtualPosition.tp,
              direction: state.tradeState.virtualPosition.direction,
              symbol:   state.tradeState.virtualPosition.symbol,
              timeframe: state.tradeState.virtualPosition.timeframe
            }
          : null
      } : null
    }));
  } catch (_) {}
}

function scheduleSaveState() {
  try {
    if (saveStateTimer) clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(savePersistedState, 120);
  } catch (_) {}
}

function setConnStable(label, cls) {
  setConn(label, cls);
}

function markConnectionOk(label) {
  state.conn.healthFails = 0;
  state.conn.sseFails = 0;
  state.conn.lastOkAt = Date.now();
  setConnStable(label || 'ONLINE', 'ok');
}

function markConnectionTransientFail() {
  var now = Date.now();
  var graceMs = 20000;
  if ((now - Number(state.conn.lastOkAt || 0)) <= graceMs || state.conn.healthFails < 3 || state.conn.sseFails < 2) {
    setConnStable('RETRY', 'warn');
  } else {
    setConnStable('OFFLINE', 'bad');
  }
}

function ensureBeepContext() {
  try {
    if (!state.beepCtx) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      state.beepCtx = new Ctx();
    }
    if (state.beepCtx.state === 'suspended') {
      state.beepCtx.resume().catch(function() {});
    }
    return state.beepCtx;
  } catch (_) {
    return null;
  }
}

function playEntryBeepOnce(entryKey) {
  if (!entryKey || state.alertedEntryKeys[entryKey]) return;
  var ctx = ensureBeepContext();
  if (!ctx) return;
  try {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 980;
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    var now = ctx.currentTime;
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.start(now);
    osc.stop(now + 0.24);
    state.alertedEntryKeys[entryKey] = Date.now();
    scheduleSaveState();
    flowLog('ENTRY_BEEP_TRIGGERED', { entryKey: entryKey });
  } catch (_) {}
}

function checkEntryProximityAndBeep(live) {
  try {
    // Ne pas biper pour une entrée si position déjà ouverte
    if (state.tradeState && state.tradeState.entered) return;
    var vp = live && live.virtualPosition ? live.virtualPosition : null;
    var it = live && live.instantTrade ? live.instantTrade : null;
    var lvl = (vp && Number.isFinite(Number(vp.entry))) ? Number(vp.entry)
      : ((it && Number.isFinite(Number(it.entry))) ? Number(it.entry)
      : Number(live && live.levelTrace && live.levelTrace.received ? live.levelTrace.received.entry : NaN));
    var px = Number(state.price || (live && live.currentPrice) || NaN);
    if (!Number.isFinite(lvl) || !Number.isFinite(px) || lvl <= 0 || px <= 0) return;
    var proximity = Math.max(0.10, lvl * 0.0001);
    var diff = Math.abs(px - lvl);
    if (diff <= proximity) {
      var key = [state.symbol, state.timeframe, lvl.toFixed(5)].join('|');
      playEntryBeepOnce(key);
    }
  } catch (_) {}
}

// ── COACH STREAM SSE ─────────────────────────────────────────────────────────
let coachSse = null;

function connectCoachStream(symbol) {
  if (coachSse) { try { coachSse.close(); } catch (_) {} }
  coachSse = new EventSource(`${API}/coach/stream?symbol=${encodeURIComponent(symbol || state.symbol || 'XAUUSD')}`);
  coachSse.onmessage = function(e) {
    try {
      const d = JSON.parse(e.data);

      // ── SYNC ARM/DISARM depuis dashboard via relay serveur ───────────────────
      // Le serveur relaie trade-action ARM/DISARM vers /coach/stream (extension)
      // car extension écoute /coach/stream, pas /extension/sync
      if (d.type === 'trade-action' && d.source !== 'extension') {
        var _sseAction = String(d.action || '').toUpperCase();
        console.log('[SYNC] reçu via coachSse — source=' + (d.source||'?') + ' action=' + _sseAction + ' symbol=' + (d.symbol||'?'));
        if (_sseAction === 'ARM' && !state.armed && !(state.tradeState && state.tradeState.entered)) {
          console.log('[SYNC] ARM reçu dashboard → extension s\'arme');
          state.armed = true;
          state._armedAt = Date.now();
          state._lockedWdTf = d._lockedTf || d.timeframe || 'M15';
          var _btnSse = document.querySelector('[data-action="ENTER"]');
          if (_btnSse) { _btnSse.disabled = false; _btnSse.style.cssText = 'background:#d97706;color:#000;font-weight:700;font-size:11px;'; _btnSse.textContent = '🤖 LIA SURVEILLE — ANNULER'; }
          startEntryWatchdog();
        } else if (_sseAction === 'DISARM') {
          console.log('[SYNC] DISARM reçu dashboard → extension se désarme');
          if (typeof disarmRobot === 'function') disarmRobot('Désarmé par synchronisation dashboard.');
          else { stopEntryWatchdog(); state.armed = false; state._armedAt = null; state._armedDirection = null; state._lockedWdTf = null; }
        }
      }

      // ── ANOMALIE CORRIGÉE: coachMessage toujours présent ─────────────────────
      if (d.coachMessage !== undefined && d.coachMessage !== null) {
        const msg = d.coachMessage;
        const isAlert = msg.includes('SL') || msg.includes('Attention') || msg.includes('coupe') || msg.includes('danger');
        const isGood  = msg.includes('TP') || msg.includes('avance') || msg.includes('trail') || msg.includes('break-even') || msg.includes('gain');
        const _msgColor = isAlert ? '#fecaca' : isGood ? '#bbf7d0' : '#fdba74';
        // Flux SSE général → prio 1 (4s TTL) — ne pas écraser les alertes/phases actives
        // Sauf si le message est lui-même une alerte (prio 4) ou critique (prio 8)
        const _msgPrio = (isAlert && (msg.includes('DANGER') || msg.includes('SORTIE'))) ? 8
                       : isAlert ? 4
                       : 1;
        const _msgTtl  = _msgPrio >= 8 ? 12000 : _msgPrio >= 4 ? 6000 : 4000;
        const _ctEl = document.getElementById('coachText');
        if (_ctEl) _ctEl.style.background = ''; // réinitialiser le background
        setCoachText(msg, _msgColor, _msgPrio, _msgTtl);
        if (msg.includes('SL') && msg.includes('Attention')) triggerAlert('NEAR_SL');
        // ── VOIX TEMPS RÉEL ─────────────────────────────────────────────
        const _now = Date.now();
        const _isUrgent   = msg.includes('Attention') || msg.includes('SL') || msg.includes('danger') || msg.includes('coupe') || msg.includes('SORTIE') || msg.includes('CONFLIT') || msg.includes('RETOURNEMENT') || msg.includes('Sécurise') || msg.includes('Protège');
        const _isGoodNews = msg.includes('avance') || msg.includes('TP') || msg.includes('break-even') || msg.includes('gain') || msg.includes('trail');
        const _isIdle     = msg.includes("J'observe") || msg.includes('Je surveille') || msg.includes('Prépare-toi');
        var _lastSpoke = state._coachSseLastSpoke || 0;
        // _posAlreadyEntered doit être défini AVANT _wdArmedWaiting (ordre corrigé)
        var _posAlreadyEntered = !!(state.tradeState && state.tradeState.entered);
        // Si robot armé en attente d'entrée → silencer les messages SSE idle (le watchdog a son propre vocal)
        var _wdArmedWaiting = state.armed && !_posAlreadyEntered;
        // FIX CONTRADICTION VOCALE: quand armé + canEnter=false + message SSE dit "RETOURNEMENT"
        // → bloquer ce vocal car il contredit l'état réel (l'agent annonce un retournement mais n'entre pas)
        // Seules les urgences réelles (SL, danger, SORTIE, CONFLIT) passent toujours pendant l'armement.
        var _srvExecNow = (state.live && state.live.execution) || (state.live && state.live.coach && state.live.coach.execution) || {};
        var _canEnterNow = _srvExecNow.canEnter === true;
        var _isRetournementMsg = msg.includes('RETOURNEMENT') || msg.includes('retournement');
        var _isDangerReal = msg.includes('SL') || msg.includes('danger') || msg.includes('coupe') || msg.includes('SORTIE');
        // Urgence réelle = danger (SL/sortie) OU (retournement seulement si canEnter=true)
        var _isUrgentReal = _isDangerReal
          || msg.includes('CONFLIT')
          || msg.includes('Sécurise') || msg.includes('Protège')
          || msg.includes('Attention')
          || (_isRetournementMsg && _canEnterNow);  // retournement seulement si on peut entrer
        // FIX boucle vocale: hors position + hors armement, messages urgents ont 60s cooldown
        var _minGap = _wdArmedWaiting
          ? (_isUrgentReal ? 0 : 999999)   // armé: urgences réelles passent, retournement sans canEnter silencé
          : (_isUrgent ? 60000 : _isGoodNews ? 18000 : _isIdle ? 35000 : 25000);
        // Indicateurs bridge temps réel = messages enrichis avec RSI par TF, alignement, zone, anticipation
        // Ces messages DOIVENT être vocalisés pendant la position (toutes les 60s max)
        var _isBridgeUpdate = msg.includes('RSI M') || msg.includes('alignés') || msg.includes('Pression') || msg.includes('PUSH') || msg.includes('CONFLIT') || msg.includes('RETOURNEMENT');
        // En position: urgences = 30s min | bonnes nouvelles = 18s | bridge temps réel = 60s | idle = silencé
        // FIX boucle vocale en position: urgent=0 causait parole à chaque push (4s) si "RETOURNEMENT" dans msg.
        // Même les urgences doivent avoir un cooldown — 30s est suffisant pour alerter sans spammer.
        var _minGapFinal = _posAlreadyEntered
          ? (_isUrgent ? 30000 : _isGoodNews ? 18000 : _isBridgeUpdate ? 60000 : 999999)
          : _minGap;
        if (_now - _lastSpoke >= _minGapFinal && !state.muted) {
          if (_isUrgent || !window.speechSynthesis?.speaking) {
            if (_isUrgent && window.speechSynthesis?.speaking) window.speechSynthesis.cancel();
            state._coachSseLastSpoke = _now;
            speak(msg);
          }
        }
      }
      // ── INDICATEURS TEMPS RÉEL (liveAnalysis) ───────────────────────
      // ANOMALIE CORRIGÉE: liveAnalysis était envoyé mais jamais rendu dans le popup
      if (d.liveAnalysis) {
        var _la = d.liveAnalysis;
        var _indEl = document.getElementById('liveIndicators');
        if (_indEl) {
          var _parts = [];
          if (_la.rsiRaw != null && Number(_la.rsiRaw) > 0) {
            var _rsiV = Number(_la.rsiRaw);
            var _rsiLbl = _rsiV > 70 ? 'momentum étiré ↑' : _rsiV < 30 ? 'momentum étiré ↓' : _rsiV >= 55 ? 'momentum ↑' : _rsiV <= 45 ? 'momentum ↓' : '';
            if (_rsiLbl) _parts.push(_rsiLbl);
          }
          if (_la.macdRaw != null) _parts.push(Number(_la.macdRaw) >= 0 ? 'tendance ↑' : 'tendance ↓');
          // Afficher uniquement si contenu réel — masquer sinon pour ne pas polluer l'UI
          if (_parts.length > 0) {
            _indEl.textContent = _parts.join(' | ');
            _indEl.style.display = '';
          } else {
            _indEl.style.display = 'none';
          }
        }
        // ── VISION MARCHÉ dans le coach text — comment LIA voit le marché ────
        // prio 2 → ne s'affiche que si aucun message de phase/alerte n'est actif
        if (_la.marketState && _la.suggestion && state.tradeState && state.tradeState.entered) {
          var _laColor = (_la.momentum === 'FORT') ? '#22c55e'
            : (_la.momentum === 'RETOURNEMENT POSSIBLE') ? '#ef4444'
            : (_la.momentum === 'RALENTISSEMENT') ? '#f97316'
            : '#cbd5e1';
          setCoachText(_la.marketState + '\n' + _la.suggestion, _laColor, 2, 5000);
        }
        // Parler les indicateurs clés si position active et RSI en zone extrême
        if (_la.rsiRaw != null && Number(_la.rsiRaw) > 0 && !state.muted) {
          var _rsiVal = Number(_la.rsiRaw);
          var _rsiNow = Date.now();
          var _lastRsiSpeak = state._lastRsiSpeak || 0;
          if ((_rsiVal > 75 || _rsiVal < 25) && _rsiNow - _lastRsiSpeak > 90000 && !state.armed) {
            var _rsiRevDir = _rsiVal > 75 ? 'à la baisse' : 'à la hausse';
            speak((_rsiVal > 75 ? 'Le marché s\'essouffle en haut.' : 'Le marché s\'essouffle en bas.') + ' Surveille un retournement ' + _rsiRevDir + '.');
            state._lastRsiSpeak = _rsiNow;
          }
        }
      }
      // ── CONSENSUS MULTI-TF ───────────────────────────────────────────
      if (d.multiTfConsensus) {
        var _mtf = d.multiTfConsensus;
        var _mtfEl = document.getElementById('multiTFConsensus');
        if (_mtfEl) {
          var _mtfColor = _mtf.state === 'FORT' ? COL_LONG : _mtf.state === 'DIVERGENCE' ? COL_SHORT : COL_PENDING;
          // Construire l'affichage TF détaillé: M1|M5|M15|H1 avec couleur par direction
          var _tfHtml = '';
          if (_mtf.details && _mtf.details.length) {
            _tfHtml = '<span style="color:#64748b">TF: </span>';
            _mtf.details.forEach(function(det) {
              var _dc = det.dir === 'LONG' ? COL_LONG : det.dir === 'SHORT' ? COL_SHORT : '#94a3b8';
              var _dl = det.dir === 'LONG' ? '▲' : det.dir === 'SHORT' ? '▼' : '—';
              // RSI arrondi à 2pts — réduit le re-rendu sur chaque tick minuscule
              var _rsiRaw = det.rsi && Number(det.rsi) > 0 ? Number(det.rsi) : 0;
              var _rsiStr = _rsiRaw > 0 ? ' R' + (Math.round(_rsiRaw / 2) * 2) : '';
              _tfHtml += '<span style="color:' + _dc + ';font-weight:700;margin-right:6px">' + det.tf + _dl + _rsiStr + '</span>';
            });
          }
          // Zone d'entrée
          var _zHtml = '';
          if (_mtf.zones) {
            var _z = _mtf.zones;
            if (_mtf.entryZone === 'ZONE_HAUTE_ACTIVE') _zHtml = ' <span style="color:' + COL_SHORT + ';font-weight:700">● ZONE RÉSIST</span>';
            else if (_mtf.entryZone === 'ZONE_BASSE_ACTIVE') _zHtml = ' <span style="color:' + COL_LONG + ';font-weight:700">● ZONE SUPPORT</span>';
            else if (_mtf.entryZone === 'ATTENDRE_ZONE_HAUTE') _zHtml = ' <span style="color:#64748b">↑ attendre résist</span>';
            else if (_mtf.entryZone === 'ATTENDRE_ZONE_BASSE') _zHtml = ' <span style="color:#64748b">↓ attendre support</span>';
            // Niveaux liq
            if (_z.liqHigh && Number(_z.liqHigh) > 0) _zHtml += ' <span style="color:#ef4444;font-size:9px">H:' + Number(_z.liqHigh).toFixed(2) + '</span>';
            if (_z.liqLow  && Number(_z.liqLow)  > 0) _zHtml += ' <span style="color:#22c55e;font-size:9px">L:' + Number(_z.liqLow).toFixed(2) + '</span>';
          }
          // Anticipation Pine Script
          var _antHtml = '';
          if (_mtf.anticipation && _mtf.anticipation !== 'RAS') {
            var _antColor = _mtf.anticipation.includes('SHORT') ? COL_SHORT : COL_LONG;
            _antHtml = ' <span style="color:' + _antColor + ';font-size:9px">' + _mtf.anticipation.replace(/_/g,' ') + '</span>';
          }
          var _mtfContent = _tfHtml + _zHtml + _antHtml;
          // ── CACHE — ne mettre à jour le DOM que si le contenu change vraiment ──
          // Clé stable: directions + zones + anticipation (pas le RSI exact)
          var _mtfCacheKey = (_mtf.details || []).map(function(d) { return d.tf + d.dir; }).join('|')
            + '|' + (_mtf.entryZone || '') + '|' + (_mtf.anticipation || '') + '|' + (_mtf.message || '');
          if (state._mtfBarKey !== _mtfCacheKey) {
            state._mtfBarKey = _mtfCacheKey;
            _mtfEl.innerHTML = _mtfContent;
          }
          // Afficher uniquement si contenu réel
          _mtfEl.style.display = _mtfContent.trim() ? '' : 'none';
          // Message consensus en couleur — masqué si vide
          var _msgEl = document.getElementById('multiTFMessage');
          if (_msgEl) {
            var _msgTxt = _mtf.message || '';
            _msgEl.style.color = _mtfColor;
            _msgEl.textContent = _msgTxt;
            _msgEl.style.display = _msgTxt ? '' : 'none';
          }
        }
        // Alerter si divergence forte
        if (_mtf.state === 'DIVERGENCE' && !state.muted && !state.armed) {
          var _divNow = Date.now();
          var _lastDiv = state._lastDivSpeak || 0;
          if (_divNow - _lastDiv > 60000) {
            speak('Attention divergence multi-timeframe. ' + (_mtf.against || 0) + ' timeframes contre la position.');
            state._lastDivSpeak = _divNow;
          }
        }
        // ── DÉTECTION CHANGEMENT DE TENDANCE ─────────────────────────────────
        // Si la direction dominante flip (SHORT→LONG ou LONG→SHORT) → alerte vocale + coach
        var _newDom = _mtf.dominantDirection; // 'LONG', 'SHORT', 'MIXTE'
        var _oldDom = state._lastDomDir || null;
        if (_newDom && _newDom !== 'MIXTE' && _oldDom && _oldDom !== 'MIXTE' && _newDom !== _oldDom) {
          // Changement de tendance confirmé
          var _flipNow = Date.now();
          var _lastFlip = state._lastFlipSpeak || 0;
          if (_flipNow - _lastFlip > 90000) { // 90s cooldown pour éviter le spam
            var _flipLabel = _newDom === 'LONG' ? 'haussier' : 'baissier';
            var _flipIcon  = _newDom === 'LONG' ? '▲' : '▼';
            var _flipColor = _newDom === 'LONG' ? '#22c55e' : '#ef4444';
            // Pendant position active: adapter le message au contexte de gestion (pas "réévalue le setup")
            var _posE = state.tradeState && state.tradeState.entered;
            var _posDir2 = _posE ? String((state.tradeState.virtualPosition||{}).direction||'').toUpperCase() : '';
            var _posIsL2 = _posDir2.includes('LONG') || _posDir2.includes('BUY');
            var _flipMsg = _posE
              ? (_newDom !== (_posIsL2 ? 'LONG' : 'SHORT')
                ? ('⚠️ Le marché tourne ' + _flipLabel + ' — contraire à ta position ' + _posDir2 + '. Surveille ton SL.')
                : ('✅ Tendance ' + _flipLabel + ' confirmée — aligne avec ta position. Continue à tenir.'))
              : ('Attention — changement de tendance détecté. Le marché devient ' + _flipLabel + '. Réévalue le setup.');
            speak(_flipMsg);
            setCoachText(
              '🔄 CHANGEMENT DE TENDANCE — Marché ' + _flipIcon + ' ' + _newDom + '\nAncien biais: ' + _oldDom + ' → Nouveau: ' + _newDom + '.' + (_posE ? ' Surveille ton SL.' : ' Réévalue avant d\'agir.'),
              _flipColor, 6, 20000
            );
            state._lastFlipSpeak = _flipNow;
          }
        }
        if (_newDom && _newDom !== 'MIXTE') state._lastDomDir = _newDom;
      }
      // ── PRIX STALE ───────────────────────────────────────────────────
      if (d.priceStale) {
        var _staleEl = document.getElementById('priceStatus');
        if (_staleEl) { _staleEl.textContent = '⚠️ Prix stale'; _staleEl.style.color = '#f97316'; }
      } else if (d.price) {
        var _freshEl = document.getElementById('priceStatus');
        if (_freshEl && _freshEl.textContent.includes('stale')) { _freshEl.textContent = ''; }
      }
      // ── PRÉ-SIGNAL: signal en formation (2/4 votes) — anticiper l'entrée ──
      // Affiche une bannière d'alerte AVANT que le signal soit confirmé (3/4 votes)
      // → permet d'anticiper l'entrée plutôt que de réagir après coup
      var _preSignalEl = document.getElementById('preSignalBanner');
      // Guard conflit: ne pas afficher pré-signal si conflit Pine/indicateurs
      var _psConflict = !!(state.live && state.live.coach && state.live.coach.analysisSnapshot &&
        state.live.coach.analysisSnapshot.sourceSummary && state.live.coach.analysisSnapshot.sourceSummary.conflictDetected);
      if (d.preSignal && !d.tradeState?.entered && !_psConflict) {
        if (_preSignalEl) {
          _preSignalEl.style.display = 'block';
          _preSignalEl.textContent   = d.preSignal.message;
          var _psBg = d.preSignal.direction === 'LONG' ? '#052e16' : '#2a0a0a';
          var _psBd = d.preSignal.direction === 'LONG' ? '#22c55e' : '#ef4444';
          _preSignalEl.style.background   = _psBg;
          _preSignalEl.style.borderColor  = _psBd;
          _preSignalEl.style.color        = _psBd;
        }
        // Voix une fois par minute max — silencé si watchdog armé (il gère son propre vocal)
        var _psNow = Date.now();
        if (!state.armed && (!state._lastPreSignalSpeak || (_psNow - state._lastPreSignalSpeak) > 60000)) {
          speak(d.preSignal.direction + ' en formation — surveille l\'entrée');
          state._lastPreSignalSpeak = _psNow;
        }
      } else {
        if (_preSignalEl) _preSignalEl.style.display = 'none';
      }
      // ── ALERTE PRÉCOCE SL: retournement détecté avant que le SL soit touché ──
      // Quand 2+ indicateurs se retournent contre la position, alerter MAINTENANT
      // → l'utilisateur peut sortir proprement ou placer le BE avant la perte
      var _slWarnEl = document.getElementById('slWarningBanner');
      if (d.slWarning && d.tradeState?.entered) {
        if (_slWarnEl) {
          _slWarnEl.style.display = 'block';
          _slWarnEl.textContent   = d.slWarning.message;
          _slWarnEl.style.borderColor = d.slWarning.urgency === 'HIGH' ? '#ef4444' : '#f97316';
          _slWarnEl.style.color       = d.slWarning.urgency === 'HIGH' ? '#ef4444' : '#f97316';
        }
        // Voix urgente — toutes les 45s max pour ne pas spammer
        var _swNow = Date.now();
        var _swCooldown = d.slWarning.urgency === 'HIGH' ? 30000 : 45000;
        if (!state._lastSlWarnSpeak || (_swNow - state._lastSlWarnSpeak) > _swCooldown) {
          speak(d.slWarning.message.replace('⚠️ ', ''));
          state._lastSlWarnSpeak = _swNow;
        }
      } else {
        if (_slWarnEl) _slWarnEl.style.display = 'none';
      }
      // ── MOTEUR DE RETOURNEMENT LIA — affichage opportunité haute probabilité ──
      var _rvEl = document.getElementById('reversalBanner');
      // Conflit global — détecter depuis state.live ou depuis d
      var _rvConflict = !!(state.live && state.live.coach && state.live.coach.analysisSnapshot &&
        state.live.coach.analysisSnapshot.sourceSummary &&
        state.live.coach.analysisSnapshot.sourceSummary.conflictDetected);
      if (d.reversalOpportunity && !d.tradeState?.entered) {
        var _rv = d.reversalOpportunity;
        var _rvIsA = _rv.grade === 'A';
        var _rvIsB = _rv.grade === 'B';
        var _rvDir = _rv.direction;
        var _rvCol = _rvConflict ? '#f97316'
                   : _rvDir === 'LONG' ? '#22c55e' : '#ef4444';
        var _rvBg  = _rvConflict ? '#1a0f00'
                   : _rvDir === 'LONG' ? '#052e16' : '#2a0a0a';
        if (_rvEl && (_rvIsA || _rvIsB)) {
          _rvEl.style.display = 'block';
          var _rvPfx = _rvIsA ? '⚡ ' : '🟡 ';
          var _fmtRv = function(v){ return v > 100 ? Number(v).toFixed(2) : Number(v).toFixed(5); };

          // ── STATUT PRIX vs ZONE — affiché en tête de banner ─────────────────
          var _rvCurPx  = state.price > 0 ? state.price : 0;
          var _rvEntPx  = Number(_rv.entry) || 0;
          var _rvPxStat = ''; // texte statut
          var _rvPxCol  = _rvCol; // couleur statut (peut être différente de _rvCol)
          var _rvPxVoix = ''; // prefix voix
          if (_rvCurPx > 0 && _rvEntPx > 0) {
            var _rvDist = Math.abs(_rvCurPx - _rvEntPx);
            var _rvTolZ = _rvEntPx * 0.001; // 0.1% = EN ZONE
            var _rvTolA = _rvEntPx * 0.003; // 0.3% = EN APPROCHE
            var _rvDistFmt = _rvDist > 100 ? _rvDist.toFixed(2) : _rvDist.toFixed(1);
            if (_rvDir === 'SHORT') {
              // SHORT: zone résistance en HAUT — prix doit MONTER pour y arriver
              if (_rvCurPx < _rvEntPx - _rvTolA) {
                _rvPxStat = '⏳ À VENIR (+' + _rvDistFmt + 'pt)';
                _rvPxCol  = '#94a3b8'; // gris — pas encore actionnable
                _rvPxVoix = 'à venir — ';
              } else if (_rvCurPx < _rvEntPx - _rvTolZ) {
                _rvPxStat = '🔔 EN APPROCHE (+' + _rvDistFmt + 'pt)';
                _rvPxCol  = '#fbbf24'; // jaune — se préparer
                _rvPxVoix = 'en approche — ';
              } else if (_rvCurPx <= _rvEntPx + _rvTolZ) {
                _rvPxStat = '🎯 EN ZONE — LIA VÉRIFIE M1+M5+M15+H1';
                _rvPxCol  = '#f97316'; // orange vif — urgence
                _rvPxVoix = 'EN ZONE — ';
              } else {
                _rvPxStat = '⚠️ ZONE DÉPASSÉE (prix >' + _fmtRv(_rvEntPx) + ')';
                _rvPxCol  = '#64748b'; // gris sombre — trop tard ou piège
                _rvPxVoix = 'zone dépassée — ';
              }
            } else { // LONG
              // LONG: zone support en BAS — prix doit DESCENDRE pour y arriver
              if (_rvCurPx > _rvEntPx + _rvTolA) {
                _rvPxStat = '⏳ À VENIR (-' + _rvDistFmt + 'pt)';
                _rvPxCol  = '#94a3b8';
                _rvPxVoix = 'à venir — ';
              } else if (_rvCurPx > _rvEntPx + _rvTolZ) {
                _rvPxStat = '🔔 EN APPROCHE (-' + _rvDistFmt + 'pt)';
                _rvPxCol  = '#fbbf24';
                _rvPxVoix = 'en approche — ';
              } else if (_rvCurPx >= _rvEntPx - _rvTolZ) {
                _rvPxStat = '🎯 EN ZONE — LIA VÉRIFIE M1+M5+M15+H1';
                _rvPxCol  = '#f97316';
                _rvPxVoix = 'EN ZONE — ';
              } else {
                _rvPxStat = '⚠️ ZONE DÉPASSÉE (prix <' + _fmtRv(_rvEntPx) + ')';
                _rvPxCol  = '#64748b';
                _rvPxVoix = 'zone dépassée — ';
              }
            }
          }

          // ── RESET REFUS SUR ZONE DÉPASSÉE — permet reproposition au retour ──────
          // Si le prix était EN ZONE (passage réel), puis est DÉPASSÉE → le setup est
          // consommé ou raté. Quand le prix reviendra en zone, c'est une nouvelle entrée :
          // on efface le refus précédent pour que la proposition puisse réapparaître.
          if (_rvPxStat.includes('EN ZONE')) {
            state._rvWasInZone = true; // mémorise le passage en zone
          } else if (_rvPxStat.includes('DÉPASSÉE') && state._rvWasInZone) {
            state._rvWasInZone        = false;
            state._refusedProposalKey = null; // refus expiré — zone quittée puis revenue
            state._refusedProposalAt  = null;
          }

          // Ligne 1: signal + score
          var _rvTf = _rv.tf || _rv.timeframe || '';
          var _rvTfStr = _rvTf ? ' [' + _rvTf + ']' : '';
          var _rvRrRaw = Number(_rv.rr || 0);
          // Supprimer RR de la ligne 1 si le serveur l'inclut déjà (évite doublon avec ligne 2)
          var _rvMsg1 = (_rv.message || ('RETOURNEMENT ' + _rvDir + ' — ' + (_rv.score||'?') + '/100'));
          _rvMsg1 = _rvMsg1.replace(/\s*\|\s*RR[:=][\d.]+/i, ''); // retirer RR du message titre
          var _rvL1 = _rvPfx + _rvMsg1 + _rvTfStr;

          // ── CORRECTION NIVEAUX DIRECTIONNELS ─────────────────────────────────
          // Le serveur envoie parfois entry/tp inversés pour les RETOURNEMENTS:
          // Pour SHORT: entrée doit être > TP (prix descend de l'entrée vers le TP)
          // Pour LONG:  entrée doit être < TP (prix monte de l'entrée vers le TP)
          var _rvEntryRaw = Number(_rv.entry || 0);
          var _rvTpRaw    = Number(_rv.tp    || 0);
          var _rvSlRaw    = Number(_rv.sl    || 0);
          var _rvEntryDisp = _rvEntryRaw;
          var _rvTpDisp    = _rvTpRaw;
          // Détection swap: SHORT avec entry < tp OU LONG avec entry > tp
          var _rvSwapped = (_rvDir === 'SHORT' && _rvEntryRaw > 0 && _rvTpRaw > 0 && _rvEntryRaw < _rvTpRaw)
                        || (_rvDir === 'LONG'  && _rvEntryRaw > 0 && _rvTpRaw > 0 && _rvEntryRaw > _rvTpRaw);
          if (_rvSwapped) {
            _rvEntryDisp = _rvTpRaw;   // résistance = vraie entrée SHORT (ou support = vraie entrée LONG)
            _rvTpDisp    = _rvEntryRaw; // support = vrai TP SHORT (ou résistance = vrai TP LONG)
          }
          // R:R directionnel — utiliser la valeur serveur si cohérente, sinon recalculer
          var _rvRrDisplay = _rvRrRaw > 0 ? _rvRrRaw.toFixed(2) : '—';
          // Ligne 2: niveaux corrigés + RR serveur (source unique de vérité)
          var _rvL2 = 'Entrée: ' + _fmtRv(_rvEntryDisp) + '  SL:' + _fmtRv(_rvSlRaw) + '  TP:' + _fmtRv(_rvTpDisp) + '  RR:' + _rvRrDisplay + (_rvSwapped ? ' ⚡' : '');
          // Ligne 3: raisons (2 premières max)
          var _rvReasons = Array.isArray(_rv.reasons) ? _rv.reasons.slice(0,2).join(' | ') : String(_rv.reasons||'');
          // Ligne 4: état — EN ZONE = "vérification en cours" (sera mise à jour par checkRvTFAlignmentAndArm)
          //           Conflit = NE PAS ENTRER   |   Grade B = attendre confirmation
          var _rvIsEnZone = _rvPxStat.includes('EN ZONE');
          var _rvStatusLine = _rvConflict
            ? '⚠️ CONFLIT ACTIF — signal détecté, NE PAS ENTRER tant que TFs divergent'
            : _rvIsEnZone
              ? '🔍 EN ZONE — Validation M1+M5+M15+H1 en cours (score ' + (_rv.score||'?') + '/100 = signal fort)'
              : (_rvIsA ? '⏳ OPPORTUNITÉ — prix en approche de zone, LIA validera M1+M5+M15+H1 à l\'arrivée' : '⏳ Setup en formation — attendre confirmation M1+M5+M15+H1');

          // ── CACHE: ne re-rendre les lignes 1-3 que si le setup change ─────────
          var _rvCacheKey = _rvDir + '|' + (_rv.entry||0) + '|' + (_rv.sl||0) + '|' + (_rv.tp||0) + '|' + (_rv.score||0) + '|' + (_rv.grade||'');
          var _rvNeedFull = !state._rvBannerCache || state._rvBannerCache.key !== _rvCacheKey;

          if (_rvNeedFull) {
            // ── RENDU COMPLET — seulement quand nouveau setup détecté ────────────
            _rvEl.innerHTML =
              // ── Badge état prix — prominent, classe rv-px-status pour mise à jour partielle ──
              '<div class="rv-px-status" style="font-weight:900;font-size:13px;letter-spacing:.06em;margin-bottom:7px;padding:5px 10px;border-radius:6px;border-left:4px solid ' + _rvPxCol + ';background:rgba(0,0,0,0.4);color:' + _rvPxCol + '">' + (_rvPxStat || '—') + '</div>'
              // ── Ligne 1: signal — gelée après ce rendu ──
              + '<div style="font-weight:800;font-size:13px;color:' + _rvCol + ';letter-spacing:.01em;line-height:1.4">' + _rvL1 + '</div>'
              // ── Ligne 2: niveaux — gelée ──
              + '<div style="font-size:12px;margin-top:4px;font-family:\'Courier New\',monospace;font-weight:700;color:' + _rvCol + ';letter-spacing:.03em">' + _rvL2 + '</div>'
              // ── Ligne 3: raisons — gelée ──
              + (_rvReasons ? '<div style="font-size:11px;margin-top:3px;color:' + _rvCol + ';opacity:.9;font-weight:500">' + _rvReasons + '</div>' : '')
              // ── Ligne 4: statut LIA — classe rv-line4 pour mise à jour async ──
              + '<div class="rv-line4" style="font-size:11px;margin-top:5px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.2);font-weight:700;color:' + _rvCol + '">' + _rvStatusLine + '</div>';

            _rvEl.style.background = _rvBg;
            _rvEl.style.color      = _rvCol;
            state._rvBannerCache   = { key: _rvCacheKey };
          } else {
            // ── MISE À JOUR PARTIELLE — seulement le badge état prix ─────────────
            var _pxDiv = _rvEl.querySelector('.rv-px-status');
            if (_pxDiv) {
              _pxDiv.textContent        = _rvPxStat || '—';
              _pxDiv.style.color        = _rvPxCol;
              _pxDiv.style.borderLeft   = '4px solid ' + _rvPxCol;
            }
          }

          // Bordure du banner — toujours mise à jour selon proximité zone
          _rvEl.style.borderColor = _rvPxStat.includes('EN ZONE') ? '#f97316' : _rvCol;
          _rvEl.style.borderWidth = _rvPxStat.includes('EN ZONE') ? '3px' : (_rvIsA ? '2px' : '1px');
          // Restaurer le dernier résultat LIA — évite que le SSE efface l'analyse async
          if (state._rvLastResult && _rvIsEnZone) {
            var _l4 = _rvEl.querySelector('.rv-line4');
            if (_l4) { _l4.textContent = state._rvLastResult.text; _l4.style.color = state._rvLastResult.color; _l4.style.fontWeight = '900'; }
          }
        } else if (_rvEl) {
          _rvEl.style.display = 'none';
        }
        // Voix: grade A = annonce immédiate, grade B = toutes les 2min
        // Silencé si watchdog armé — le watchdog gère son propre vocal contextuel
        if ((_rvIsA || _rvIsB) && !state.armed) {
          var _rvCooldown = _rvIsA ? 45000 : 120000;
          var _rvNow = Date.now();
          var _rvIsEnZoneNow = _rvPxVoix === 'EN ZONE — ';
          // Urgence: EN ZONE = cooldown réduit à 15s
          if (_rvIsEnZoneNow) _rvCooldown = 15000;
          if (!state._lastRvSpeak || (_rvNow - state._lastRvSpeak) > _rvCooldown) {
            var _rvBd = state._lastBridgeData || null;
            var _rvBdM15 = _rvBd ? String(_rvBd.lectureTech3 || '').replace(/_/g,' ').toLowerCase() : '';
            var _rvBdH1  = _rvBd ? String(_rvBd.lectureTech4 || '').replace(/_/g,' ').toLowerCase() : '';
            var _rvBdM5  = _rvBd ? String(_rvBd.lectureTech2 || '').replace(/_/g,' ').toLowerCase() : '';
            var _rvBdM1  = _rvBd ? String(_rvBd.lectureTech1 || '').replace(/_/g,' ').toLowerCase() : '';
            var _rvBdCtx = (_rvBdM15 || _rvBdH1)
              ? ' M15 ' + (_rvBdM15 || 'en lecture') + ', H1 ' + (_rvBdH1 || 'en lecture') + '.'
              : '';
            var _rvVoice = _rvConflict
              ? 'Point de retournement ' + _rvDir + ' repéré, mais conflit actif sur les unités de temps. Ne pas entrer maintenant — attendre que le conflit se résolve.'
              : (_rvIsEnZoneNow
                  // EN ZONE: LIA annonce le point de retournement + contexte bridge + action
                  ? 'Attention — point de retournement ' + _rvDir + ' atteint. Score ' + (_rv.score||'?') + ' sur 100. Zone à ' + _fmtRv(_rv.entry) + ', stop à ' + _fmtRv(_rv.sl) + ', objectif ' + _fmtRv(_rv.tp) + '.' + _rvBdCtx + ' Je valide M1, M5, M15, H1 maintenant.'
                  : _rvPxVoix + 'point de retournement ' + _rvDir + ', score ' + (_rv.score||'?') + ' sur 100. Zone à ' + _fmtRv(_rv.entry) + '. Stop à ' + _fmtRv(_rv.sl) + '. Objectif ' + _fmtRv(_rv.tp) + '. R:R ' + (_rv.rr||'--') + '.' + (_rvBdCtx ? _rvBdCtx : ''));
            speak(_rvVoice);
            state._lastRvSpeak = _rvNow;
          }
          // ── AUTO-VÉRIFICATION TF — LIA vérifie M1+M5+M15+H1 lui-même quand EN ZONE ──
          // Déclenché à chaque tick EN ZONE (throttlé à 20s dans la fonction)
          // Si grade A, pas de conflit, pas de position déjà ouverte
          if (_rvIsEnZoneNow && _rvIsA && !_rvConflict && !(state.tradeState && state.tradeState.entered)) {
            // Passer les niveaux corrigés (swap détecté ci-dessus) pour un RR cohérent
            checkRvTFAlignmentAndArm(
              _rvDir,
              _rvEntryDisp,  // entrée réelle (corrigée si swap)
              _rvSlRaw,      // SL inchangé
              _rvTpDisp,     // TP réel (corrigé si swap)
              _fmtRv,
              _rvRrRaw       // RR serveur — source unique de vérité
            ).catch(function() {});
          }
        }
      } else if (_rvEl) {
        _rvEl.style.display = 'none';
        state._rvLastResult = null;      // plus de retournement actif → reset résultat LIA
        state._rvValidatedLevels = null; // niveaux LIA invalidés (zone quittée)
        state._rvBannerCache = null;     // reset cache — prochain setup = rendu complet
      }
      // Événements SL/TP depuis le serveur (moniteur temps réel)
      if (d.event === 'sl-hit') {
        triggerAlert('NEAR_SL', 'SL touché');
        speak(d.coachMessage || 'Stop loss touché. Analysons l\'erreur.');
        setCoachText(d.coachMessage || 'SL touché.', COL_SHORT, 10, 20000);
        // Effacer la position IMMÉDIATEMENT — sans attendre le prochain refresh
        state.tradeState = Object.assign({}, state.tradeState || {}, { entered: false, phase: 'EXITED', armed: false });
        state.armed = false;
        stopEntryWatchdog();
        clearTradeLevelsExt();
        renderPositionPanel(null, state.price); // masque le panel tout de suite
        // RESET COMPLET direction — invalide les niveaux stale de la position fermée
        // Sans ce reset: _rvValidatedLevels direction=LONG injected in next SHORT entry → direction bug
        state._rvValidatedLevels = null;
        state._wdEntryDir = null;
        state._wdEffectiveSl = 0;
        state._wdEffectiveTp = 0;
        state._armedDirection = null;
        state._mtfWinner = null;
        // Reset propre → prêt pour nouveau cycle
        setTimeout(function() {
          setCoachText('🔄 Reset complet — Nouveau cycle prêt.\nAnalyse le marché et clique ANALYSER quand tu vois un setup.', '#94a3b8', 3, 15000);
        }, 3000);
        setAgentSession(false, 'sl-hit');
      }
      if (d.event === 'tp-hit') {
        triggerAlert('TP_REACHED');
        // Capturer la direction AVANT d'effacer l'état
        const _tpDir = (state.tradeState && state.tradeState.virtualPosition && state.tradeState.virtualPosition.direction)
                    || (state.tradeState && state.tradeState.direction)
                    || null;
        speak(d.coachMessage || 'Take profit validé ! Félicitations.');
        setCoachText(d.coachMessage || 'TP atteint !', COL_LONG, 10, 20000);
        // Animation flash vert → masquer immédiatement après
        const _tpPanel = document.getElementById('positionPanel');
        if (_tpPanel) {
          _tpPanel.style.transition = 'background 0.3s';
          _tpPanel.style.background = '#052e16';
          setTimeout(() => { _tpPanel.style.background = ''; }, 1200);
        }
        // Effacer la position IMMÉDIATEMENT — sans attendre le prochain refresh
        state.tradeState = Object.assign({}, state.tradeState || {}, { entered: false, phase: 'EXITED', armed: false });
        state.armed = false;
        stopEntryWatchdog();
        clearTradeLevelsExt();
        setTimeout(() => renderPositionPanel(null, state.price), 1300); // après l'animation flash
        // RESET COMPLET direction — invalide les niveaux stale de la position fermée
        state._rvValidatedLevels = null;
        state._wdEntryDir = null;
        state._wdEffectiveSl = 0;
        state._wdEffectiveTp = 0;
        state._armedDirection = null;
        state._mtfWinner = null;
        // Reset propre → prêt pour nouveau cycle
        setTimeout(function() {
          setCoachText('✅ Trade gagnant terminé — Nouveau cycle prêt.\nClique ANALYSER pour chercher le prochain setup.', '#22c55e', 3, 20000);
        }, 4000);
        setAgentSession(false, 'tp-hit');
        // Annonce retournement — 1.5s après la fermeture
        setTimeout(() => {
          if (_tpDir === 'LONG') {
            speak('On est maintenant en zone de retournement SHORT. Le marché a atteint son objectif LONG. C\'est le bon endroit pour vendre. Potentiel retournement SHORT — surveille une réaction de rejet.');
            setCoachText('📍 ZONE DE RETOURNEMENT SHORT\nPotentiel SHORT | Vendre le haut', '#ef4444', 6, 20000);
          } else if (_tpDir === 'SHORT') {
            speak('On est maintenant en zone de retournement LONG. Le marché a atteint son objectif SHORT. C\'est le bon endroit pour acheter. Potentiel retournement LONG — surveille une réaction de rejet.');
            setCoachText('📍 ZONE DE RETOURNEMENT LONG\nPotentiel LONG | Acheter le bas', '#22c55e', 6, 20000);
          }
        }, 1500);
      }
      if (d.price) state.price = d.price;
      renderPositionPanel(state.live, state.price);
      // ALERT: BE_REACHED
      if (d.tradeState && d.tradeState.phase === 'be_reached') {
        const _beKey = [state.symbol, 'BE_REACHED'].join('|');
        if (!state._alertedKeys[_beKey]) {
          state._alertedKeys[_beKey] = true;
          triggerAlert('BE_REACHED');
        }
      }
      // ALERT: TP_REACHED — trade fermé avec PnL positif
      if (d.tradeState && d.tradeState.phase === 'closed') {
        const _pnl = Number(d.tradeState.pnlPips || d.tradeState.pnl || 0);
        if (_pnl > 0) {
          const _tpKey = [state.symbol, 'TP_REACHED', d.tradeState.closeTime || Date.now()].join('|');
          if (!state._alertedKeys[_tpKey]) {
            state._alertedKeys[_tpKey] = true;
            triggerAlert('TP_REACHED');
          }
        }
        // Reset BE key for next trade
        delete state._alertedKeys[[state.symbol, 'BE_REACHED'].join('|')];
        showTradeSummary(d.tradeState, d.price);
      }
    } catch (_) {}
  };
  coachSse.onerror = function() {
    setTimeout(() => {
      // Reconnecter si session active OU si position ouverte — le coach ne doit jamais lâcher pendant un trade
      if (state.agentSessionActive || (state.tradeState && state.tradeState.entered))
        connectCoachStream(symbol || state.symbol);
    }, 3000);
  };
  console.log('[COACH STREAM] Connecté pour', symbol);
}

function disconnectCoachStream() {
  if (coachSse) { try { coachSse.close(); } catch (_) {} coachSse = null; }
  console.log('[COACH STREAM] Déconnecté');
}

async function showTradeSummary(tradeState, price) {
  const pos = state.live?.virtualPosition || state.live?.instantTrade;
  if (!pos?.entry) return;
  try {
    const resp = await fetchJson('/coach/close-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: state.symbol,
        entry: pos.entry,
        exitPrice: price || state.price,
        sl: pos.sl, tp: pos.tp,
        direction: pos.direction || (pos.tp > pos.entry ? 'LONG' : 'SHORT'),
        durationMin: state._tradeStartAt ? Math.round((Date.now() - state._tradeStartAt) / 60000) : null
      })
    });
    if (resp.ok) {
      const el = document.getElementById('coachText');
      if (el) {
        el.style.color = resp.color;
        el.textContent = resp.message + '\n\n' + resp.nextAction;
      }
      if (typeof disconnectCoachStream === 'function') disconnectCoachStream();
    }
  } catch(_) {}
}
// ─────────────────────────────────────────────────────────────────────────────

async function setAgentSession(active, trigger) {
  if (active) {
    // Activate immediately — do not wait for orchestration server call
    state.agentSessionActive = true;
    scheduleSaveState();
    connectCoachStream(state.symbol);
    try {
      await fetchJson('/orchestration/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interval: 30000, trigger: trigger || 'manual' })
      });
    } catch (_) {}
    try {
      await fetchJson('/orchestration/run-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: trigger || 'manual' })
      });
    } catch (_) {}
    return;
  }
  // Deactivate
  state.agentSessionActive = false;
  disconnectCoachStream();
  scheduleSaveState();
  try {
    await fetchJson('/orchestration/disable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: trigger || 'manual' })
    });
  } catch (_) {}
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function setText(id, val) { var el = document.getElementById(id); if (!el) return; var v = val != null ? String(val) : '--'; if (el.textContent !== v) el.textContent = v; }

function isPersistent() {
  try { return new URLSearchParams(window.location.search).get('persistent') === '1'; }
  catch (_) { return false; }
}

function fmtPrice(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return Math.abs(n) > 1000 ? n.toFixed(2) : n.toFixed(5);
}

function fmtTime() { return new Date().toLocaleTimeString('fr'); }

function flowLog(message, data) {
  try {
    var payload = data || {};
    console.log('[EXT_FLOW]', message, payload);
  } catch (_) {}
}

async function fetchJson(path, options) {
  const opts = options || {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  // Injection automatique clé Adel sur toutes les routes write (POST/PUT/DELETE/PATCH)
  const _writeMethod = opts.method && !['GET','HEAD'].includes(opts.method.toUpperCase());
  const _adelHeaders = _writeMethod ? { 'X-Adel-Key': 'Adel' } : {};
  try {
    const r = await fetch(API + path, Object.assign({}, opts, {
      signal: ctrl.signal,
      headers: Object.assign({ Accept: 'application/json' }, _adelHeaders, opts.headers || {})
    }));
    const t = await r.text();
    let d = {};
    try { d = JSON.parse(t || '{}'); } catch (_) { throw new Error('Non-JSON'); }
    if (!r.ok) throw new Error(d.message || d.error || ('HTTP ' + r.status));
    return d;
  } finally { clearTimeout(timer); }
}

function getAgents(live) {
  return (live && (live.agents || (live.coach && live.coach.agents))) || {};
}

function getCoachPayload(live) {
  return (live && live.coach) ? live.coach : (live || {});
}

// ─── HEADER ───────────────────────────────────────────────────────────────────
function setConn(label, cls) {
  const el = $('conn');
  if (!el) return;
  el.textContent = label;
  el.className = cls + '-badge';
}

function applyBridgeConfig(cfg) {
  if (!cfg) return;
  state.bridgeConfig = Object.assign({}, state.bridgeConfig, cfg);
  state.bridgeConfig.activeSource = 'tradingview';
  var enabled = state.bridgeConfig.bridgeEnabled !== false;
  var bb = $('bridgeBadge');
  if (bb) {
    bb.textContent = enabled ? 'BRIDGE ON' : 'BRIDGE OFF';
    bb.className = 'bdg ' + (enabled ? 'ok' : 'bad');
    bb.title = 'Cliquez pour basculer ON/OFF';
    bb.style.cursor = 'pointer';
  }
  var bt = $('btnBridgeToggle');
  if (bt) {
    bt.textContent = enabled ? 'BRIDGE ACTIF' : 'BRIDGE OFF';
    bt.className = enabled ? 'btn-sub buy' : 'btn-sub sell';
    bt.title = enabled ? 'Cliquer pour désactiver le bridge' : 'Cliquer pour activer le bridge';
  }
  if (state.bridgeConfig.bridgeMode) {
    var bm = String(state.bridgeConfig.bridgeMode).toUpperCase();
    state.tradeMode = bm;
    var ms = $('modeSelect');
    if (ms && Array.from(ms.options).some(function(o) { return o.value === bm; })) ms.value = bm;
  }
  if (state.bridgeConfig.agentName) {
    var ha = $('headAgent');
    // NE PAS écraser le badge quand position active (position-sync gère le badge)
    var _haPos = state.tradeState && state.tradeState.entered;
    if (ha && !_haPos && ha.textContent.indexOf('AGENT ') !== 0) {
      ha.textContent = 'AGENT ' + String(state.bridgeConfig.agentName).toUpperCase();
    }
  }

  setSourceButtons();
}

function setSourceButtons() {
  var tvBtn = $('btnSourceTv');
  var tvOn = state.bridgeConfig.tradingviewEnabled !== false;
  if (tvBtn) {
    tvBtn.textContent = tvOn ? 'BRIDGE TV ON' : 'BRIDGE TV OFF';
    tvBtn.className = tvOn ? 'btn-sub buy' : 'btn-sub';
  }
}

async function setActiveSource(source) {
  var src = 'tradingview';
  await fetchJson('/extension/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'set-bridge-config',
      payload: src === 'tradingview'
        ? {
            activeSource: 'tradingview',
            tradingviewEnabled: true,
                    updatedBy: 'extension-popup-source'
          }
        : {
            activeSource: 'tradingview',
            tradingviewEnabled: false,
            updatedBy: 'extension-popup-source'
          }
    })
  });
}

function updateHeader() {
  const sym  = $('headSym');   if (sym  && sym.textContent  !== state.symbol)    sym.textContent  = state.symbol;
  const tf   = $('headTF');    if (tf   && tf.textContent   !== state.timeframe) tf.textContent   = state.timeframe;
  const mode = $('headMode');  if (mode && mode.textContent !== state.tradeMode) mode.textContent = state.tradeMode;
  const pr   = $('headPrice');
  if (pr) {
    // ── Fraîcheur du prix ─────────────────────────────────────────────────
    // Si le dernier tick prix est trop ancien, le signaler visuellement sur le prix
    // Seuils: >15s = jaune (attention), >40s = rouge (flux probablement coupé)
    var _tickAge = state._lastPriceTick ? Math.round((Date.now() - state._lastPriceTick) / 1000) : null;
    // Stale = plus aucun tick SSE depuis >40s (SSE mort, pas prix stable en marché lent)
    var _priceStale = _tickAge !== null && _tickAge > 40;
    var _priceWarn  = _tickAge !== null && _tickAge > 18 && !_priceStale;

    if (_priceStale) {
      pr.textContent = (state.price ? fmtPrice(state.price) : '') + ' ⚠️' + _tickAge + 's';
    } else if (_priceWarn) {
      pr.textContent = (state.price ? fmtPrice(state.price) : '') + ' ·' + _tickAge + 's';
    } else {
      pr.textContent = state.price ? fmtPrice(state.price) : '';
    }

    // Couleur prix — stale override toujours prioritaire sur direction
    if (_priceStale) {
      pr.style.color = COL_SHORT; // rouge = SSE mort
    } else if (_priceWarn) {
      pr.style.color = COL_WAIT; // jaune = flux ralenti
    } else {
      // Couleur selon état position (comportement habituel)
      var live = state.live || {};
      var vp = live.virtualPosition || live.coach && live.coach.virtualPosition || null;
      var it = live.instantTrade || null;
      var posDir = String((vp && vp.direction) || (it && it.direction) || '').toUpperCase();
      var phase  = String((vp && vp.status) || (live.tradeState && live.tradeState.phase) || '').toUpperCase();
      var isPending = phase.indexOf('PENDING') >= 0 || phase.indexOf('WAIT') >= 0;
      if (isPending) {
        pr.style.color = COL_PENDING;
      } else if (posDir.indexOf('BUY') >= 0 || posDir.indexOf('LONG') >= 0) {
        pr.style.color = COL_LONG;
      } else if (posDir.indexOf('SELL') >= 0 || posDir.indexOf('SHORT') >= 0) {
        pr.style.color = COL_SHORT;
      } else {
        pr.style.color = COL_TEXT;
      }
    }
  }
  // Highlight active TF card
  MTFS.forEach(function(tf) { var c = $('tfc-' + tf); if (c) c.classList.toggle('active', tf === state.timeframe); });
  scheduleSaveState();
}

function updateAgentStatus(live) {
  const el = $('headAgent');
  if (!el) return;
  var _prevText = el.textContent;
  const rec = String(
    (live && live.agents && live.agents.analysis && live.agents.analysis.recommendation) ||
    (live && live.analysis && live.analysis.recommendation) ||
    (live && live.signal && live.signal.verdict) ||
    ''
  ).toUpperCase();
  const isL = rec.indexOf('BUY') >= 0 || rec.indexOf('ACHAT') >= 0 || rec.indexOf('LONG') >= 0;
  const isS = rec.indexOf('SELL') >= 0 || rec.indexOf('VENTE') >= 0 || rec.indexOf('SHORT') >= 0;
  // Position active → badge direction position (stable — ne change pas tant que direction identique)
  if (state.tradeState && state.tradeState.entered) {
    const posDir = String((state.tradeState.virtualPosition && state.tradeState.virtualPosition.direction) || state.tradeState.direction || '').toUpperCase();
    const posL = posDir.includes('LONG') || posDir.includes('BUY');
    const posS = posDir.includes('SHORT') || posDir.includes('SELL');
    const _newTxt = posL ? 'POSITION LONG' : posS ? 'POSITION SHORT' : 'POSITION ACTIVE';
    if (_prevText === _newTxt) return; // aucun changement — évite le DOM thrash
    el.textContent = _newTxt;
    el.style.background = posL ? 'rgba(34,197,94,.25)' : posS ? 'rgba(239,68,68,.25)' : 'rgba(234,179,8,.2)';
    el.style.color = posL ? COL_LONG : posS ? COL_SHORT : '#fbbf24';
    el.style.borderColor = posL ? 'rgba(34,197,94,.5)' : posS ? 'rgba(239,68,68,.5)' : 'rgba(234,179,8,.4)';
    return;
  }
  // Robot armé → ne JAMAIS afficher ATTENTE
  if (state.armed) {
    if (isL) {
      el.textContent = '🤖 ARMÉ — ACHAT'; el.style.background = 'rgba(34,197,94,.18)'; el.style.color = COL_LONG; el.style.borderColor = 'rgba(34,197,94,.4)';
    } else if (isS) {
      el.textContent = '🤖 ARMÉ — VENTE'; el.style.background = 'rgba(239,68,68,.18)'; el.style.color = COL_SHORT; el.style.borderColor = 'rgba(239,68,68,.4)';
    } else {
      el.textContent = '🤖 ARMÉ — SURVEILLANCE'; el.style.background = 'rgba(217,119,6,.18)'; el.style.color = '#d97706'; el.style.borderColor = 'rgba(217,119,6,.4)';
    }
    return;
  }
  // Non armé — direction serveur
  if (isL) {
    el.textContent = 'AGENT ACHAT'; el.style.background = 'rgba(34,197,94,.2)'; el.style.color = COL_LONG; el.style.borderColor = 'rgba(34,197,94,.4)';
  } else if (isS) {
    el.textContent = 'AGENT VENTE'; el.style.background = 'rgba(239,68,68,.2)'; el.style.color = COL_SHORT; el.style.borderColor = 'rgba(239,68,68,.4)';
  } else {
    el.textContent = 'AGENT ATTENTE'; el.style.background = ''; el.style.color = COL_WAIT; el.style.borderColor = '';
  }
}

// ─── SIGNAL ───────────────────────────────────────────────────────────────────
function renderSignal(live) {
  // ── GUARD POSITION ACTIVE — ne JAMAIS écrire ATTENTE pendant un trade ──────
  if (state.tradeState && state.tradeState.entered) {
    var _sgVp  = state.tradeState.virtualPosition || {};
    var _sgDir = String(_sgVp.direction || state.tradeState.direction || '').toUpperCase();
    var _sgL   = _sgDir.includes('LONG') || _sgDir.includes('BUY');
    var _sgTxt = '🔒 ' + (_sgL ? 'LONG' : 'SHORT') + ' ACTIF';
    var _sgEl  = $('signalText');
    if (_sgEl && _sgEl.textContent !== _sgTxt) {
      _sgEl.textContent = _sgTxt;
      _sgEl.className   = 'signal ' + (_sgL ? 'buy' : 'sell');
      _sgEl.style.color = ''; _sgEl.style.borderColor = '';
    }
    var _fP = function(v) { return Number(v) > 0 ? (Number(v) > 100 ? Number(v).toFixed(2) : Number(v).toFixed(5)) : '--'; };
    var _anTxt = 'Entrée: ' + _fP(_sgVp.entry) + '  SL: ' + _fP(_sgVp.sl) + '  TP: ' + _fP(_sgVp.tp);
    var _anEl2 = $('analysisText');
    if (_anEl2 && _anEl2.textContent !== _anTxt) { _anEl2.textContent = _anTxt; _anEl2.style.color = '#94a3b8'; }
    return;
  }
  const agents = getAgents(live);
  const analysis = agents.analysis || {};  // LLM — pour rationale/reason uniquement
  const it = live && live.instantTrade || {};
  const coach = live && live.coach || {};
  // SOURCE UNIQUE: server déterministe (agents.analysis.recommendation)
  // /coach/live: agents.analysis — /coach/realtime: coach.agents.analysis (via getAgents)
  const _srvRec = (live && live.analysis)
    || (live && live.agents && live.agents.analysis)
    || (live && live.coach && live.coach.agents && live.coach.agents.analysis)
    || {};
  const _srvHasRec = !!_srvRec.recommendation;
  const rawRec = String(
    _srvRec.recommendation ||
    (live && live.signal && live.signal.verdict) ||      // /coach/live: signal à la racine
    (coach.signal && coach.signal.verdict) ||
    'ATTENTE'
  ).toUpperCase();
  // Si server dit WAIT (conflit/filtre actif) → pas de fallback instantTrade
  // Fallback instantTrade seulement si aucune recommendation serveur disponible
  const rec = (_srvHasRec && rawRec === 'WAIT')
    ? 'NEUTRE'  // server bloque → pas de PRE-ALERTE (même si instantTrade dit LONG)
    : (rawRec === '' || rawRec === 'UNDEFINED')
      ? String(it.direction || 'NEUTRE').toUpperCase()
      : rawRec;
  // stateLabel — 3 niveaux: ATTENTE → PRE-ALERTE (signal en formation) → ENTRÉE VALIDÉE
  // canEnter: /coach/live a execution à la racine; /coach/realtime met execution dans coach
  const canEnter = (live && live.execution && live.execution.canEnter === true)
    || (coach.execution && coach.execution.canEnter === true);
  const isDirectional = rec === 'LONG' || rec === 'BUY' || rec === 'SHORT' || rec === 'SELL';
  const _isArmed = !!(state && state.armed);
  const stateLabel = canEnter
    ? (_isArmed
        ? ((rec === 'LONG' || rec === 'BUY') ? '⚡ SIGNAL LONG — ROBOT ARMÉ' : '⚡ SIGNAL SHORT — ROBOT ARMÉ')
        : ((rec === 'LONG' || rec === 'BUY') ? '📡 SIGNAL LONG DÉTECTÉ' : '📡 SIGNAL SHORT DÉTECTÉ'))
    : isDirectional
      ? (rec === 'LONG' || rec === 'BUY') ? '🟡 SETUP LONG EN FORMATION' : '🟡 SETUP SHORT EN FORMATION'
      : 'ATTENTE';
  const reason = analysis.reason || (agents.risk && agents.risk.riskReason) || 'Analyse indisponible';
  const risk   = (agents.risk && agents.risk.riskLevel) || null;
  const logic  = (agents.strategy && agents.strategy.logic) || null;

  const sigEl = $('signalText');
  if (sigEl) {
    sigEl.textContent = stateLabel;
    // Couleur CSS directionnelle SEULEMENT si setup exécutable (canEnter + sl + tp)
    // Sinon neutre — évite rouge/vert trompeur quand canEnter=false
    var _sigExecSl = Number((live && live.execution && live.execution.sl) || (coach.execution && coach.execution.sl) || 0);
    var _sigExecTp = Number((live && live.execution && live.execution.tp) || (coach.execution && coach.execution.tp) || 0);
    var _sigExecutable = canEnter && _sigExecSl > 0 && _sigExecTp > 0;
    var _cfSnap2 = ((live && live.coach && live.coach.analysisSnapshot && live.coach.analysisSnapshot.sourceSummary) || (live && live.analysisSnapshot && live.analysisSnapshot.sourceSummary) || {});
    var _sigConflict    = !!_cfSnap2.conflictDetected;      // tout blocage (qualité, RSI, conf...)
    var _sigDirConflict = !!_cfSnap2.isDirectionalConflict; // vrai conflit TF Pine ≠ Runtime
    if (_sigDirConflict) {
      // Conflit directionnel réel: H1 SHORT vs M15 LONG (ou équivalent)
      sigEl.textContent = '⚠️ CONFLIT TF';
      sigEl.className = 'signal wait';
      sigEl.style.color = '#f97316';
      sigEl.style.borderColor = '#f97316';
    } else if (_sigConflict) {
      // Blocage qualité (confiance, RSI, BB...) — pas un vrai conflit directionnel
      sigEl.textContent = '⏸ ATTENTE';
      sigEl.className = 'signal wait';
      sigEl.style.color = '#eab308';
      sigEl.style.borderColor = '#eab308';
    } else if (_sigExecutable) {
      sigEl.style.color = '';
      sigEl.style.borderColor = '';
      if (rec.indexOf('BUY') >= 0 || rec.indexOf('ACHAT') >= 0 || rec.indexOf('LONG') >= 0)        sigEl.className = 'signal buy';
      else if (rec.indexOf('SELL') >= 0 || rec.indexOf('VENTE') >= 0 || rec.indexOf('SHORT') >= 0) sigEl.className = 'signal sell';
      else sigEl.className = 'signal wait';
    } else {
      // Direction détectée mais non exécutable → neutre, le texte stateLabel dit déjà PRE-ALERTE
      sigEl.style.color = '';
      sigEl.style.borderColor = '';
      sigEl.className = 'signal wait';
    }
  }

  const stEl = $('sigTime');
  if (stEl) stEl.textContent = fmtTime();

  const anEl = $('analysisText');
  if (anEl) {
    // Conflit affiché en tête de l'analysisText pour maximiser la visibilité
    var parts = [];
    if (_sigDirConflict) {
      parts.push('⚠️ CONFLIT TF: Pine(' + (_cfSnap2.tvDirection || '?') + ') ≠ Runtime(' + (_cfSnap2.runtimeDirection || 'WAIT') + ') — Attendre alignement');
    } else if (_sigConflict) {
      // Bloquer qualité — afficher la vraie raison, pas un faux conflit directionnel
      var _blockReason = (_cfSnap2.conflictReasons && _cfSnap2.conflictReasons[0]) || reason || 'Signal insuffisant — attendre';
      parts.push('⏸ ' + _blockReason);
    }
    if (!_sigDirConflict && !_sigConflict) parts.push(reason);
    if (risk)  parts.push('Risque: ' + risk);
    if (logic && !_sigConflict && !_sigDirConflict) parts.push(logic);
    anEl.textContent = parts.join(' — ');
    anEl.style.color = _sigDirConflict ? '#f97316' : _sigConflict ? '#eab308' : '';
  }

  if (rec !== 'ATTENTE' && rec !== state.lastRec) {
    state.stats.signals++;
    state.stats.lastEvent = rec + ' ' + fmtTime();
    state.lastRec = rec;
    renderStats();
  }
}

function renderBadges(health) {
  const wb = $('webhookBadge');
  const bb = $('bridgeBadge');
  if (wb) {
    const on = health && health.ok;
    wb.textContent = on ? 'WH ON' : 'WH OFF';
    wb.className = 'bdg ' + (on ? 'ok' : 'bad');
  }
  if (bb) {
    if (state.bridgeConfig.bridgeEnabled === false) {
      bb.textContent = 'BRIDGE OFF';
      bb.className = 'bdg bad';
    } else {
      const tvOn = health && health.ok;
      bb.textContent = tvOn ? 'TV' : 'OFF';
      bb.className = 'bdg ' + (tvOn ? 'ok' : 'bad');
    }
  }
  if (health && health.activeContext) {
    if (!state.price && health.activeContext.price) {
      state.price = health.activeContext.price;
      updateHeader();
    }
    if (health.activeContext.symbol) state.symbol = String(health.activeContext.symbol).toUpperCase();
  }
}

// ─── TRACKING FRAÎCHEUR TF — client-side, sans redémarrage serveur ───────────
// Quand Pine Script envoie lectureTech1/2/3/4 → on note la date de réception.
// Si trop longtemps sans mise à jour → donnée périmée → "MAJ EN COURS".
var _bridgeLtReceivedAt = { M1: null, M5: null, M15: null, H1: null };

// ─── BRIDGE LIVE TF CARDS — mise à jour temps réel depuis ticks SSE ──────────
// Appelé sur chaque tick tradingview-data (msg.bridgeData) — SANS appel API.
// Enrichit chaque carte TF avec lecture Pine, RSI, score et indicateur de zone M1.
// Règle SNIPER/SCALPING: M1 doit être à l'extrême (VENTE=haut / ACHAT=bas / NEUTRE=danger).
function renderTFCardsFromBridge(bd, currentPrice) {
  if (!bd) return;
  // SUPPRIMÉ: guard _analyzeAllInFlight — bloquait les mises à jour visuelles pendant l'analyse
  // Le bridge SSE doit toujours mettre à jour les cartes TF, même pendant analyzeAllTF

  // ── Mise à jour timestamps réception (client-side) ──────────────────────────
  // On utilise UNIQUEMENT les timestamps serveur (_ltNUpdatedAt) — envoyés depuis server.js
  // après redémarrage. Avant redémarrage : undefined → pas de staleness detection (data affichée telle quelle).
  var _now = Date.now();
  if (bd._lt1UpdatedAt) _bridgeLtReceivedAt.M1  = bd._lt1UpdatedAt;
  if (bd._lt2UpdatedAt) _bridgeLtReceivedAt.M5  = bd._lt2UpdatedAt;
  if (bd._lt3UpdatedAt) _bridgeLtReceivedAt.M15 = bd._lt3UpdatedAt;
  if (bd._lt4UpdatedAt) _bridgeLtReceivedAt.H1  = bd._lt4UpdatedAt;

  // Staleness thresholds per TF (ms)
  var _staleMs = { M1: 3*60000, M5: 8*60000, M15: 20*60000, H1: 90*60000 };
  function _isTfStale(tf) {
    var at = _bridgeLtReceivedAt[tf];
    if (!at) return false; // jamais reçu → on ne sait pas, ne pas bloquer
    return (_now - at) > (_staleMs[tf] || 20*60000);
  }
  // RSI-to-lecture fallback: quand Pine script absent, dériver direction depuis RSI seul
  function _rsiToLec(lec, rsi) {
    if (lec) return lec;
    var r = Number(rsi || 0);
    if (r <= 0 || r > 100) return '';
    if (r >= 60) return 'ACHAT_FORT';
    if (r >= 55) return 'ACHAT';
    if (r <= 40) return 'VENTE_FORTE';
    if (r <= 45) return 'VENTE';
    return 'NEUTRE';
  }
  // Si RSI synthétique (bridge ne renvoie pas de RSI par TF) → masquer RSI individuel
  var _synthRsi = bd._synthRsiUsed === true;
  var _mkRsi = function(rsiVal, lectureKey) {
    // RSI réel = bridge a envoyé une lecture Pine pour ce TF → lecture fiable
    var _hasRealLecture = !!lectureKey;
    return (_synthRsi && !_hasRealLecture) ? 0 : Number(rsiVal || 0);
  };
  var _tfMap = [
    { tf: 'M1',  lecture: _rsiToLec(String(bd.lectureTech1 || '').toUpperCase(), bd.rsiTf1), rsi: _mkRsi(bd.rsiTf1, bd.lectureTech1), score: Number(bd.scoreTech1 || 0), stale: _isTfStale('M1') },
    { tf: 'M5',  lecture: _rsiToLec(String(bd.lectureTech2 || '').toUpperCase(), bd.rsiTf2), rsi: _mkRsi(bd.rsiTf2, bd.lectureTech2), score: Number(bd.scoreTech2 || 0), stale: _isTfStale('M5') },
    { tf: 'M15', lecture: _rsiToLec(String(bd.lectureTech3 || '').toUpperCase(), bd.rsiTf3), rsi: _mkRsi(bd.rsiTf3, bd.lectureTech3), score: Number(bd.scoreTech3 || 0), stale: _isTfStale('M15') },
    { tf: 'H1',  lecture: _rsiToLec(String(bd.lectureTech4 || '').toUpperCase(), bd.rsiTf4), rsi: _mkRsi(bd.rsiTf4, bd.lectureTech4), score: Number(bd.scoreTech4 || 0), stale: _isTfStale('H1') },
    { tf: 'H4',  lecture: _rsiToLec('', bd.rsiTf5), rsi: Number(bd.rsiTf5 || 0), score: 0, stale: false }
  ];

  // Zone globale depuis bridge (blocs UNIQUEMENT — lignes orange exclues)
  var _inTop = bd.inTop === true || bd.zoneLiqHaute === true;
  var _inBot = bd.inBot === true || bd.zoneLiqBasse === true;
  var _liqH  = Number(bd.liqHigh || 0);
  var _liqL  = Number(bd.liqLow  || 0);

  // Direction de la position en cours (pour comparer avec chaque TF)
  var _posDir = '';
  if (state.tradeState && state.tradeState.entered && state.tradeState.virtualPosition) {
    _posDir = String(state.tradeState.virtualPosition.direction || '').toUpperCase();
  }
  var _posIsLong  = _posDir.includes('LONG') || _posDir.includes('BUY');
  var _posIsShort = _posDir.includes('SHORT');
  var _posActive  = _posIsLong || _posIsShort;

  _tfMap.forEach(function(item) {
    var sigEl = $('tfc-' + item.tf + '-t');
    var subEl = $('tfc-' + item.tf + '-s');
    var card  = $('tfc-' + item.tf);
    if (!sigEl) return;

    var _lec = item.lecture;
    var _rsi = item.rsi;
    var _sc  = item.score;
    if (!_lec && _rsi <= 0) return; // pas de données bridge pour ce TF — ne pas effacer

    var _isVente = _lec.includes('VENTE');
    var _isAchat = _lec.includes('ACHAT');
    var _isFort  = _lec.includes('FORT');
    var _dir     = _isVente ? 'SHORT' : _isAchat ? 'LONG' : 'NEUTRE';

    // Si données bridge périmées → ne PAS afficher une direction incorrecte
    if (item.stale) {
      _dir = 'NEUTRE';
      _isVente = false;
      _isAchat = false;
      _isFort  = false;
    }

    // Texte signal
    var _sigTxt = item.stale ? '~ MAJ EN COURS'
                : _dir === 'LONG' ? (_isFort ? '▲ FORT' : '▲ LONG')
                : _dir === 'SHORT' ? (_isFort ? '▼ FORT' : '▼ SHORT')
                : 'NEUTRE';
    var _sigCls = item.stale ? 'wait' : _dir === 'LONG' ? 'buy' : _dir === 'SHORT' ? 'sell' : 'wait';

    // Sous-label : RSI + score + zone indicator pour M1
    // RSI synthétique (bridge sans Pine multi-TF) → afficher "RSI N/A" au lieu de valeur identique
    var _rsiSynthFlag = _synthRsi && !item.lecture.replace('NEUTRE','').trim();
    var _rsiDisplay = _rsiSynthFlag ? 0 : _rsi; // masque le RSI synthétique dans le badge
    var _rsiTxt = _rsiSynthFlag ? 'RSI N/A' : (_rsiDisplay > 70 ? '↑ excès' : _rsiDisplay > 0 && _rsiDisplay < 30 ? '↓ survente' : _rsiDisplay >= 55 ? '↑' : _rsiDisplay > 0 && _rsiDisplay <= 45 ? '↓' : '');
    var _scTxt  = _sc  > 0 ? ' ' + Math.round(_sc) + '%' : '';
    var _zoneTxt = '';
    if (item.stale) {
      _zoneTxt = ''; // stale → pas d'indicateur de zone (direction inconnue)
    } else if (item.tf === 'M1') {
      // Zone indicator M1 — critique pour règle SNIPER/SCALPING
      if (_isVente) {
        _zoneTxt = ' 🔴 HAUT'; // zone haute = excès vendeur ✅ pour SHORT
      } else if (_isAchat) {
        _zoneTxt = ' 🟢 BAS';  // zone basse = excès acheteur ✅ pour LONG
      } else {
        _zoneTxt = ' ⚠ MID';   // milieu = INTERDIT entrée
      }
    } else if (item.tf === 'M5' || item.tf === 'M15' || item.tf === 'H1') {
      // Zone dérivée du RSI par TF — indépendant du TF où tourne le bridge Pine
      // RSI > 65 → prix en zone haute sur ce TF | RSI < 35 → prix en zone basse
      // Combiné avec inTop/inBot global Pine comme confirmation supplémentaire
      var _tfIsHigh = (_rsi > 0 && _rsi > 65) || _inTop;
      var _tfIsLow  = (_rsi > 0 && _rsi < 35) || _inBot;
      if (_tfIsHigh && _isVente)   _zoneTxt = ' zone-H';
      else if (_tfIsLow && _isAchat) _zoneTxt = ' zone-B';
      else if (_tfIsHigh)           _zoneTxt = ' ↑haut';  // RSI haut, direction neutre ou opposée
      else if (_tfIsLow)            _zoneTxt = ' ↓bas';   // RSI bas, direction neutre ou opposée
    }
    // Indicateur d'âge — montre depuis quand la donnée a été reçue (clôture barre Pine Script)
    // Ex: "3min" → barre fermée il y a 3 min, données de cette clôture
    var _ageTxt = '';
    var _ltAt = _bridgeLtReceivedAt[item.tf];
    if (_ltAt) {
      var _ageMin = Math.floor((_now - _ltAt) / 60000);
      var _ageSec = Math.floor((_now - _ltAt) / 1000);
      _ageTxt = _ageMin > 0 ? (' · ' + _ageMin + 'min') : (' · ' + _ageSec + 's');
    }
    var _staleTxt = item.stale ? ' ~' : '';
    var _subTxt = _rsiTxt + _scTxt + _zoneTxt + _ageTxt + _staleTxt;

    // Couleur carte — pendant position: croiser avec direction du trade
    var _cardBg, _cardBorder;
    if (_posActive) {
      // Pendant position: vert = aligné avec position, rouge = contre
      var _aligned = (_posIsLong && _dir === 'LONG') || (_posIsShort && _dir === 'SHORT');
      var _against = (_posIsLong && _dir === 'SHORT') || (_posIsShort && _dir === 'LONG');
      if (_aligned) {
        _cardBg = _posIsLong ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)';
        _cardBorder = _posIsLong ? COL_LONG : COL_SHORT;
      } else if (_against) {
        // TF contre la position — avertissement orange
        _cardBg = 'rgba(249,115,22,0.10)';
        _cardBorder = '#f97316';
      } else {
        _cardBg = 'rgba(100,116,139,0.07)';
        _cardBorder = '#334155';
      }
    } else {
      // Hors position: couleur zone-aware — même langage visuel que l'indicateur TradingView
      // H1 = contexte uniquement → couleur directionnelle atténuée (pas de décision)
      // M1/M5/M15 = ROUGE si SHORT en zone haute, VERT si LONG en zone basse,
      //             ORANGE si direction sans zone (info seulement), VIOLET si neutre/milieu
      if (item.tf === 'H1') {
        _cardBg     = _dir === 'LONG'  ? 'rgba(34,197,94,0.07)'
                    : _dir === 'SHORT' ? 'rgba(239,68,68,0.07)'
                    : 'rgba(100,116,139,0.06)';
        _cardBorder = _dir === 'LONG' ? COL_LONG : _dir === 'SHORT' ? COL_SHORT : '#475569';
      } else {
        // M1/M5/M15 — zone-aware
        // Pour M1: zone dérivée de la lecture (VENTE=zone haute, ACHAT=zone basse)
        var _isM1 = item.tf === 'M1';
        var _cardInTop = _inTop || (_isM1 && _dir === 'SHORT');
        var _cardInBot = _inBot || (_isM1 && _dir === 'LONG');
        var _shortInZone = _dir === 'SHORT' && _cardInTop;
        var _longInZone  = _dir === 'LONG'  && _cardInBot;
        if (_shortInZone) {
          // ROUGE — zone de résistance confirmée → SHORT valide
          _cardBg     = 'rgba(239,68,68,0.15)';
          _cardBorder = COL_SHORT;
        } else if (_longInZone) {
          // VERT — zone de support confirmée → LONG valide
          _cardBg     = 'rgba(34,197,94,0.15)';
          _cardBorder = COL_LONG;
        } else if (_dir !== 'NEUTRE') {
          // ORANGE — direction signalée mais prix hors zone → info, pas de signal d'entrée
          _cardBg     = 'rgba(249,115,22,0.09)';
          _cardBorder = '#f97316';
        } else {
          // VIOLET — neutre / milieu de range → entrée interdite
          _cardBg     = 'rgba(139,92,246,0.09)';
          _cardBorder = '#7c3aed';
        }
      }
    }

    // Anti-flicker: ne réécrire le DOM que si les valeurs ont changé
    var _cardKey = _sigTxt + '|' + _sigCls + '|' + (_subTxt||'') + '|' + _cardBg + '|' + _cardBorder;
    if (card && card._lastCardKey === _cardKey) return; // rien n'a changé → skip
    if (card) card._lastCardKey = _cardKey;
    if (sigEl.textContent !== _sigTxt) sigEl.textContent = _sigTxt;
    if (sigEl.className !== 'tfc-sig ' + _sigCls) sigEl.className = 'tfc-sig ' + _sigCls;
    if (_subTxt && subEl && subEl.textContent !== _subTxt) subEl.textContent = _subTxt;
    if (card) {
      if (card.style.background !== _cardBg) card.style.background = _cardBg;
      if (card.style.borderColor !== _cardBorder) card.style.borderColor = _cardBorder;
    }
  });

  // Mettre à jour consensus zone (M1 zone check résumé)
  var _m1Item = _tfMap[0];
  var _m1Lec  = _m1Item.lecture;
  var _m1Haut = _m1Lec.includes('VENTE');
  var _m1Bas  = _m1Lec.includes('ACHAT');
  var _m1Mid  = !_m1Haut && !_m1Bas && _m1Lec.length > 0;
  var _msgEl  = $('multiTFMessage');
  if (_msgEl && _m1Lec) {
    var _zoneMsg = _m1Haut ? 'M1 zone HAUTE — SHORT favorable' : _m1Bas ? 'M1 zone BASSE — LONG favorable' : '⚠ M1 au MILIEU — entrée interdite';
    var _zonCol  = _m1Haut ? COL_SHORT : _m1Bas ? COL_LONG : '#f97316';
    _msgEl.style.display = 'block';
    _msgEl.textContent   = _zoneMsg;
    _msgEl.style.color   = _zonCol;
  }

  // ── ZONE — données explicites Pine uniquement ────────────────────────────────
  // inTop/inBot doivent venir du bridge (indicateur Pine détecte les rectangles TV).
  // NE PAS inférer depuis M1 : M1 peut être directional même au milieu du range.
  // Si Pine ne les envoie pas → zone = non confirmée → entrée bloquée par guard E.
  // Ceci garantit que seules les vraies bandes rouges/vertes déclenchent une entrée.
  if (bd.inTop == null) bd.inTop = false;
  if (bd.inBot == null) bd.inBot = false;

  // Cache le bridge payload pour utilisation offline (renderMultiTF position mode)
  bd._ts = Date.now(); // timestamp pour le diagnostic de sync
  state._lastBridgeData = bd;
  state._lastBridgeDataAt = Date.now();

  // ── JAUGES — mise à jour temps réel sur chaque tick bridge SSE ───────────
  (function _updateGaugeFromBridge() {
    // RSI fallback: si lectureTech absent (Pine ne l'envoie pas), déduire la direction du RSI
    // rsi_1m/5m/15m/60m sont toujours envoyés par scanAllTimeframes() background.js
    // Quand Pine envoie long_score/short_score → RSI fallback supprimé (Pine fait autorité)
    var _hasPineScores = (Number(bd.long_score||0) > 20 || Number(bd.short_score||0) > 20);
    function _lecToRec(lec, rsi) {
      var l = String(lec || '').toUpperCase();
      if (l.includes('ACHAT')) return 'LONG';
      if (l.includes('VENTE')) return 'SELL';
      if (_hasPineScores) return 'WAIT'; // Pine scores présents → ne pas inférer depuis RSI
      var r = Number(rsi || 0);
      if (r >= 58) return 'LONG';
      if (r > 0 && r <= 42) return 'SELL';
      return 'WAIT';
    }
    function _isDirectional(lec, rsi) {
      var l = String(lec || '').toUpperCase();
      if (l && !l.includes('NEUTRE')) return true;
      if (_hasPineScores) return false; // Pine présent → seule lectureTech détermine la direction
      var r = Number(rsi || 0);
      return r >= 58 || (r > 0 && r <= 42);
    }
    function _rsiStr(score, rsi) {
      if (score && Number(score) > 0) return Number(score);
      var r = Number(rsi || 0);
      if (r > 70 || (r > 0 && r < 30)) return 80;
      if (r > 60 || (r > 0 && r < 40)) return 60;
      return 40;
    }
    var _snaps = [
      { tf: 'M1',  rec: _lecToRec(bd.lectureTech1, bd.rsiTf1), strength: _rsiStr(bd.scoreTech1, bd.rsiTf1), directional: _isDirectional(bd.lectureTech1, bd.rsiTf1) },
      { tf: 'M5',  rec: _lecToRec(bd.lectureTech2, bd.rsiTf2), strength: _rsiStr(bd.scoreTech2, bd.rsiTf2), directional: _isDirectional(bd.lectureTech2, bd.rsiTf2) },
      { tf: 'M15', rec: _lecToRec(bd.lectureTech3, bd.rsiTf3), strength: _rsiStr(bd.scoreTech3, bd.rsiTf3), directional: _isDirectional(bd.lectureTech3, bd.rsiTf3) },
      { tf: 'H1',  rec: _lecToRec(bd.lectureTech4, bd.rsiTf4), strength: _rsiStr(bd.scoreTech4, bd.rsiTf4), directional: _isDirectional(bd.lectureTech4, bd.rsiTf4) }
    ];
    // Injecter long_score/short_score Pine comme vote H1 de renforcement
    var _ls = Number(bd.long_score || 0), _ss = Number(bd.short_score || 0);
    if ((_ls > 0 || _ss > 0) && Math.abs(_ls - _ss) >= 10) {
      var _pineRec = _ls > _ss ? 'BUY' : 'SELL';
      var _pineStr = Math.min(100, Math.round(Math.max(_ls, _ss)));
      _snaps.push({ tf: 'H1', rec: _pineRec, strength: _pineStr, directional: true, _pineGlobal: true });
    }
    var _imm = state.armedMode === 'imminent' || state.armedMode === 'entering';
    applyGaugePulse(computeGaugePulse(_snaps), _imm);
  })();

  // ── BRIDGE INTELLIGENCE ROW — montre les signaux clés du bridge en temps réel ──
  // Zone, rejets (bullRej/bearRej), macro dominance, anticipation Pine → ce que l'agent voit
  (function _updateBridgeIntelRow() {
    var _bir = $('bridgeIntelRow');
    if (!_bir) return;
    var _zone  = bd.inBot === true ? 'ZONE_BASSE' : bd.inTop === true ? 'ZONE_HAUTE' : 'HORS_ZONE';
    var _zoneC = bd.inBot === true ? COL_LONG : bd.inTop === true ? COL_SHORT : '#64748b';
    var _bRej  = bd.bullRej === true ? '<span style="color:#22c55e">▲REJ</span>' : '';
    var _brRej = bd.bearRej === true ? '<span style="color:#ef4444">▼REJ</span>' : '';
    var _mB    = Number(bd.macroBull || 0);
    var _mBr   = Number(bd.macroBear || 0);
    var _macroStr = (_mB > 0 || _mBr > 0)
      ? (' DOM:' + (_mB > _mBr ? '<span style="color:#22c55e">BULL ' + Math.round(_mB) + '%</span>' : '<span style="color:#ef4444">BEAR ' + Math.round(_mBr) + '%</span>'))
      : '';
    var _ant   = String(bd.anticipationTexte || '').toUpperCase().replace(/_/g,' ');
    var _antStr = _ant && _ant !== 'RAS' && _ant.length > 1
      ? ' ANT:<span style="color:#f97316">' + _ant + '</span>'
      : '';
    var _midStr = bd.inPremium === true ? ' <span style="color:#ef4444">PREMIUM</span>'
                : bd.inDiscount === true ? ' <span style="color:#22c55e">DISCOUNT</span>'
                : '';
    var _liqH = Number(bd.liqHigh || 0);
    var _liqL = Number(bd.liqLow  || 0);
    var _liqStr = (_liqH > 0 || _liqL > 0)
      ? ' | LIQ:' + (_liqH > 0 ? '<span style="color:#ef4444">H:' + (_liqH > 100 ? _liqH.toFixed(2) : _liqH.toFixed(5)) + '</span>' : '')
        + (_liqL > 0 ? '<span style="color:#22c55e">L:' + (_liqL > 100 ? _liqL.toFixed(2) : _liqL.toFixed(5)) + '</span>' : '')
      : '';
    _bir.style.display = 'block';
    _bir.style.borderLeftColor = _zoneC;
    _bir.innerHTML = 'BRIDGE → <span style="color:' + _zoneC + ';font-weight:700">' + _zone + '</span>'
      + (_bRej || _brRej ? ' | ' + [_bRej, _brRej].filter(Boolean).join(' ') : '')
      + _macroStr + _antStr + _midStr + _liqStr;
  })();
}

// ─── MULTI-TF ─────────────────────────────────────────────────────────────────
var _renderMultiTFRunning = false; // guard anti-concurrence
async function renderMultiTF() {
  if (_renderMultiTFRunning) return; // évite double animation si appelé en parallèle
  // Guard: ne pas écraser les cartes si un scan analyzeAllTF est en cours
  if (typeof _analyzeAllInFlight !== 'undefined' && _analyzeAllInFlight) return;
  _renderMultiTFRunning = true;
  // Snapshot du symbole au moment du lancement — guard anti-stale
  // Si le symbole change pendant les appels API en vol, on abandonne les résultats obsolètes
  var _renderSym = state.symbol;

  if (!state.agentSessionActive) {
    MTFS.forEach(function(tf) {
      var sigEl = $(('tfc-' + tf + '-t').replace(/\s/g,''));
      var subEl = $(('tfc-' + tf + '-s').replace(/\s/g,''));
      if (!sigEl) return;
      sigEl.textContent = '--';
      sigEl.className = 'tfc-sig wait';
      if (subEl) subEl.textContent = 'Session OFF';
    });
    flowLog('MULTI_TF SKIPPED (SESSION OFF)', { symbol: state.symbol, mode: state.tradeMode });
    _renderMultiTFRunning = false; return;
  }

  // ── POSITION ACTIVE: afficher suivi au lieu de scan d'entrée ──────────────
  // Règle stricte: position active uniquement si entered + VP complète (entry + sl + tp)
  // + symbole de la position = symbole affiché (une position BTC ne doit pas bloquer GOLD)
  var _vpCheck = state.tradeState && state.tradeState.entered && state.tradeState.virtualPosition;
  var _posSym = _vpCheck ? String(state.tradeState.virtualPosition.symbol || state.tradeState.symbol || state.symbol).toUpperCase() : '';
  var _symMatchesPos = !_posSym || _posSym === state.symbol.toUpperCase();
  var _posActive = _vpCheck && _symMatchesPos &&
    Number(state.tradeState.virtualPosition.entry) > 0 &&
    Number(state.tradeState.virtualPosition.sl) > 0 &&
    Number(state.tradeState.virtualPosition.tp) > 0;
  if (_posActive) {
    var _posDir = String(state.tradeState.virtualPosition.direction || '').toUpperCase();
    var _posIsLong = _posDir.includes('LONG') || _posDir.includes('BUY');
    var _vp = state.tradeState.virtualPosition || state.tradeState;
    var _entry = _vp.entry;
    var _px = state.price || 0;
    var _pnlPips = 0;
    if (_px && _entry) {
      var _symUp = String(state.symbol || '').toUpperCase();
      var _mulCrypto = /BTC|ETH|SOL|XRP|BNB|ADA|LTC|DOT|LINK|AVAX|DOGE/.test(_symUp);
      var _mulIndex  = /US30|NAS|SPX|DAX|CAC|FTSE|NI225|NIKKEI|SP500|NDX|DOW/.test(_symUp);
      var _mul = (_mulCrypto || _mulIndex) ? 1 : _symUp.includes('JPY') ? 100 : /XAU|GOLD/.test(_symUp) ? 10 : 10000;
      _pnlPips = parseFloat((_posIsLong ? _px - _entry : _entry - _px).toFixed(6)) * _mul;
      _pnlPips = Math.round(_pnlPips * 10) / 10;
    }
    var _pnlSign = _pnlPips >= 0 ? '+' : '';
    var _phase = String(state.tradeState.phase || 'IN_TRADE').toUpperCase();
    var _beLabel = state.tradeState.bePlaced ? '🔒BE' : '';

    // Si bridge data disponible → afficher indicateurs individuels par TF
    // Sinon fallback sur affichage uniforme (direction + P&L)
    var _bd = state._lastBridgeData || null;
    if (_bd) {
      // Affichage per-TF depuis bridge (real-time)
      renderTFCardsFromBridge(_bd, _px);
      // Consensus: P&L global dans multiTFConsensus
      var _consEl = $('multiTFConsensus');
      if (_consEl) {
        _consEl.style.display = 'block';
        _consEl.textContent   = (_posIsLong ? '▲ LONG' : '▼ SHORT') + ' ' + _pnlSign + _pnlPips + 'pips | ' + _phase + (_beLabel ? ' ' + _beLabel : '');
        _consEl.style.color   = _pnlPips >= 0 ? '#22c55e' : '#ef4444';
        _consEl.style.fontWeight = '700';
      }
    } else {
      // Fallback: affichage uniforme direction + P&L sur toutes les cartes
      MTFS.forEach(function(tf) {
        var sigEl = $(('tfc-' + tf + '-t').replace(/\s/g,''));
        var subEl = $(('tfc-' + tf + '-s').replace(/\s/g,''));
        var card  = $('tfc-' + tf);
        if (!sigEl) return;
        sigEl.textContent = _posIsLong ? '▲ LONG' : '▼ SHORT';
        sigEl.className = 'tfc-sig ' + (_posIsLong ? 'buy' : 'sell');
        if (subEl) subEl.textContent = _pnlSign + _pnlPips + 'pips | ' + _phase + (_beLabel ? ' ' + _beLabel : '');
        if (card) {
          card.style.background = _posIsLong ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)';
          card.style.borderColor = _posIsLong ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)';
        }
      });
    }
    flowLog('MULTI_TF POSITION MODE', { symbol: state.symbol, dir: _posDir, pnlPips: _pnlPips, phase: _phase, bridgeAvail: !!_bd });
    _renderMultiTFRunning = false; return;
  }

  // ── Animation séquentielle — sweep visuel carte par carte (250ms d'écart) ─
  // L'agent "passe" sur chaque TF visuellement, comme s'il les contrôlait un à un
  var _sweepDone = new Set(); // TFs dont les données sont déjà arrivées
  MTFS.forEach(function(tf, idx) {
    var _c = $('tfc-' + tf); var _s = $('tfc-' + tf + '-t'); var _sub = $('tfc-' + tf + '-s');
    // Reset immédiat sans border glow (le sweep arrive ensuite)
    if (_c) _c.classList.remove('winner','winner-short','monitoring','scanning');
    if (_s) { _s.textContent = '⏳'; _s.className = 'tfc-sig scanning'; }
    if (_sub) _sub.textContent = 'scan…';
    // Déclencher le border glow en cascade — 250ms entre chaque carte
    setTimeout(function() {
      var _ci = $('tfc-' + tf);
      if (_ci && !_sweepDone.has(tf)) _ci.classList.add('scanning');
    }, idx * 250);
  });

  var promises = MTFS.map(function(tf) {
    return fetchJson('/coach/realtime?symbol=' + encodeURIComponent(state.symbol) +
      '&tf=' + encodeURIComponent(tf) + '&mode=' + encodeURIComponent(state.tradeMode) + '&lang=fr')
      .then(function(d) {
        // Mise à jour immédiate de la carte dès que ce TF répond (pas d'attente des autres)
        var _c2 = $('tfc-' + tf); var _s2 = $('tfc-' + tf + '-t'); var _sub2 = $('tfc-' + tf + '-s');
        _sweepDone.add(tf); // Marquer comme terminé pour stopper le sweep visuel
        if (_c2) _c2.classList.remove('scanning');
        // Guard no-data: H4/D1 utilisent un verdict global — pas de données réelles bridge
        var _meta2 = (d && d.tfDataMeta) || null;
        var _noData2 = _meta2 ? (_meta2.hasBridgeData === false && !_meta2.proxyTf) : (tf === 'H4' || tf === 'D1');
        if (_noData2) {
          if (_s2) { _s2.textContent = 'N/A'; _s2.className = 'tfc-sig wait'; }
          if (_sub2) _sub2.textContent = 'Non alimenté';
          if (_c2) { _c2.style.background = 'rgba(100,116,139,0.08)'; _c2.style.borderColor = '#334155'; }
          return { tf: tf, data: d, source: 'coach/realtime' };
        }
        var _agents2 = getAgents(d); var _ana2 = _agents2.analysis || {};
        var _it2 = d.instantTrade || null;
        var _rec2 = String(_ana2.recommendation || (_it2 && _it2.direction) || '').toUpperCase();
        var _dir2 = _rec2.includes('BUY')||_rec2.includes('LONG') ? 'LONG'
                  : _rec2.includes('SELL')||_rec2.includes('SHORT') ? 'SHORT' : 'NEUTRE';
        var _str2 = Number(_ana2.strength || _ana2.confidence || (_it2 && _it2.confidence) || 0);
        if (_s2) {
          _s2.textContent = _dir2 === 'LONG' ? '▲ LONG' : _dir2 === 'SHORT' ? '▼ SHORT' : 'NEUTRE';
          _s2.className = 'tfc-sig ' + (_dir2 === 'LONG' ? 'buy' : _dir2 === 'SHORT' ? 'sell' : 'neutre');
        }
        if (_sub2) _sub2.textContent = _str2 ? _str2 + '%' : '--';
        return { tf: tf, data: d, source: 'coach/realtime' };
      })
      .catch(function() {
        // Retour immédiat si erreur
        var _c3 = $('tfc-' + tf); var _s3 = $('tfc-' + tf + '-t');
        _sweepDone.add(tf);
        if (_c3) _c3.classList.remove('scanning');
        if (_s3) { _s3.textContent = '--'; _s3.className = 'tfc-sig wait'; }
        return fetchJson('/instant-trade-live?symbol=' + encodeURIComponent(state.symbol) + '&tf=' + encodeURIComponent(tf) + '&mode=' + encodeURIComponent(state.tradeMode))
          .then(function(d2) { return { tf: tf, data: d2, source: 'instant-trade-live' }; })
          .catch(function() { return { tf: tf, data: null, source: 'none' }; });
      });
  });
  var results = await Promise.all(promises);

  // Guard anti-stale : si le symbole a changé pendant les appels API, on abandonne
  // Évite d'afficher des données BTC sur des cartes GOLD (ou inversement)
  if (state.symbol !== _renderSym) {
    flowLog('MULTI_TF ABORTED (symbol changed)', { was: _renderSym, now: state.symbol });
    _renderMultiTFRunning = false; return;
  }

  results.forEach(function(item) {
    var tf   = item.tf;
    var data = item.data;
    var sigEl = $(('tfc-' + tf + '-t').replace(/\s/g,''));
    var subEl = $(('tfc-' + tf + '-s').replace(/\s/g,''));
    if (!sigEl) return;

    if (!data) {
      sigEl.textContent = 'ATTENTE';
      sigEl.className = 'tfc-sig wait';
      if (subEl) subEl.textContent = 'Flux KO';
      flowLog('MULTI_TF MAP', { tf: tf, source: item.source || 'none', status: 'no-data' });
      return;
    }

    var normalized = data.trade ? {
      ok: !!data.ok,
      coach: null,
      agents: {
        analysis: {
          recommendation: data.trade.direction || 'WAIT',
          strength: data.trade.score || data.trade.confidence || null
        },
        risk: {}
      }
    } : data;

    var agents   = getAgents(normalized);
    var analysis = agents.analysis || {};
    var rec  = String(analysis.recommendation || 'WAIT').toUpperCase();
    var label = 'NEUTRE'; var cls = 'wait';
    var cardBg = 'rgba(234,179,8,0.1)'; var cardBorder = COL_WAIT;
    if (rec.indexOf('BUY') >= 0 || rec.indexOf('ACHAT') >= 0 || rec.indexOf('LONG') >= 0) {
      label = 'ACHAT'; cls = 'buy';
      cardBg = 'rgba(34,197,94,0.1)'; cardBorder = COL_LONG;
    } else if (rec.indexOf('SELL') >= 0 || rec.indexOf('VENTE') >= 0 || rec.indexOf('SHORT') >= 0) {
      label = 'VENTE'; cls = 'sell';
      cardBg = 'rgba(239,68,68,0.1)'; cardBorder = COL_SHORT;
    }

    // Appliquer couleurs à la carte entière
    var card = $('tfc-' + tf);
    if (card) { card.style.background = cardBg; card.style.borderColor = cardBorder; }

    // RSI par TF — lire depuis stats.rsi_[tf] uniquement (valeur distincte par timeframe)
    // Pas de fallback sur agents.technicals.rsi : ce serait la même valeur pour tous les TF
    var _stats    = (normalized.coach && normalized.coach.signal && normalized.coach.signal.stats) || {};
    var _tfKey    = 'rsi_' + tf.toLowerCase(); // ex: 'rsi_m1', 'rsi_m15', 'rsi_h1'
    var _rsiPerTf = _stats[_tfKey];
    // tfDataMeta: flag serveur indiquant si ce TF a un flux bridge réel ou proxié
    var _tfMeta   = normalized.tfDataMeta || null;
    // H4/D1 : bridge Pine ne couvre pas ces TF → afficher N/A explicitement
    // Source: tfDataMeta.hasBridgeData=false ET proxyTf=null → aucune donnée honnête
    var _noData   = (_tfMeta ? (_tfMeta.hasBridgeData === false && !_tfMeta.proxyTf) : (tf === 'H4' || tf === 'D1'))
                  && _rsiPerTf == null;
    var _isProxy  = _tfMeta ? (!!_tfMeta.proxyTf) : false;
    var rsiNum    = (!_noData && _rsiPerTf != null) ? Number(_rsiPerTf) : null;
    var rsi       = (rsiNum != null && rsiNum > 0) ? rsiNum.toFixed(0) : '--';

    // H4/D1 sans données → card grisée + libellé N/A
    if (_noData) {
      sigEl.textContent = 'N/A';
      sigEl.className = 'tfc-sig wait';
      if (subEl) subEl.textContent = 'Non alimenté';
      if (card) { card.style.background = 'rgba(100,116,139,0.08)'; card.style.borderColor = '#334155'; }
      flowLog('MULTI_TF MAP', { tf: tf, source: item.source, recommendation: 'N/A', label: 'N/A', rsi: 'n/a', strength: null });
      return;
    }
    // M30 (proxy M15) : afficher label avec indication proxy dans le sub-label
    var _proxySuffix = _isProxy && _tfMeta.proxyTf ? ' [~' + _tfMeta.proxyTf + ']' : '';

    sigEl.textContent = label;
    sigEl.className = 'tfc-sig ' + cls;
    var _rsiSubLbl = rsiNum != null && rsiNum > 0 ? (rsiNum > 70 ? '↑ excès' : rsiNum < 30 ? '↓ survente' : rsiNum >= 55 ? '↑ haussier' : rsiNum <= 45 ? '↓ baissier' : 'neutre') : '—';
    if (subEl) subEl.textContent = _rsiSubLbl + _proxySuffix;
    flowLog('MULTI_TF MAP', {
      tf: tf,
      source: item.source || 'coach/realtime',
      recommendation: rec,
      label: label,
      rsi: rsi,
      proxy: _proxySuffix || null
    });
  });

  // ── INJECTION LECTURE BRIDGE (Pine) — priorité sur recommendation agent ──
  // lecture_m5/m15/h1 = direction textuelle directe du script Pine (plus fiable)
  // rsi_m1/m5/m15/h1  = RSI réel par TF depuis robotV12
  // On écrase seulement les cartes M5/M15/H1 quand lecture disponible et non vide.
  // Guard: utiliser uniquement si symbole toujours correct
  if (state.symbol === _renderSym) {
    var _ls = (state.live && state.live.coach && state.live.coach.signal && state.live.coach.signal.stats) || {};
    var _lecM1  = String(_ls.lecture_m1  || '').toUpperCase();
    var _lecM5  = String(_ls.lecture_m5  || '').toUpperCase();
    var _lecM15 = String(_ls.lecture_m15 || '').toUpperCase();
    var _lecH1  = String(_ls.lecture_h1  || '').toUpperCase();
    var _rsiM1  = Number(_ls.rsi_m1  || 0);
    var _rsiM5  = Number(_ls.rsi_m5  || 0);
    var _rsiM15 = Number(_ls.rsi_m15 || 0);
    var _rsiH1  = Number(_ls.rsi_h1  || 0);

    // Direction finale par TF (pour alignment summary)
    var _dir = { M1: 'NEUTRE', M5: 'NEUTRE', M15: 'NEUTRE', H1: 'NEUTRE', H4: 'N/A', D1: 'N/A' };

    // M1 — lecture bridge prioritaire, RSI en complément
    (function() {
      var _s1 = $('tfc-M1-t'); var _u1 = $('tfc-M1-s'); var _c1 = $('tfc-M1');
      var _rsiTxt1 = _rsiM1 > 70 ? ' ↑ excès' : _rsiM1 > 0 && _rsiM1 < 30 ? ' ↓ survente' : _rsiM1 >= 55 ? ' ↑' : _rsiM1 > 0 && _rsiM1 <= 45 ? ' ↓' : '';
      if (_lecM1.includes('ACHAT')) {
        _dir.M1 = 'LONG';
        if (_s1) { _s1.textContent = 'LONG'; _s1.className = 'tfc-sig buy'; }
        if (_u1) _u1.textContent = 'Bridge↑' + _rsiTxt1;
        if (_c1) { _c1.style.background = 'rgba(34,197,94,0.12)'; _c1.style.borderColor = COL_LONG; }
      } else if (_lecM1.includes('VENTE')) {
        _dir.M1 = 'SHORT';
        if (_s1) { _s1.textContent = 'SHORT'; _s1.className = 'tfc-sig sell'; }
        if (_u1) _u1.textContent = 'Bridge↓' + _rsiTxt1;
        if (_c1) { _c1.style.background = 'rgba(239,68,68,0.12)'; _c1.style.borderColor = COL_SHORT; }
      } else if (_rsiM1 > 0) {
        _dir.M1 = _rsiM1 >= 56 ? 'LONG' : _rsiM1 <= 44 ? 'SHORT' : 'NEUTRE';
        if (_s1) { _s1.textContent = _dir.M1; _s1.className = 'tfc-sig ' + (_dir.M1 === 'LONG' ? 'buy' : _dir.M1 === 'SHORT' ? 'sell' : 'wait'); }
        if (_u1) _u1.textContent = 'Momentum' + _rsiTxt1;
        if (_c1) { _c1.style.background = _dir.M1 === 'LONG' ? 'rgba(34,197,94,0.10)' : _dir.M1 === 'SHORT' ? 'rgba(239,68,68,0.10)' : 'rgba(234,179,8,0.07)'; _c1.style.borderColor = _dir.M1 === 'LONG' ? COL_LONG : _dir.M1 === 'SHORT' ? COL_SHORT : COL_WAIT; }
      }
    })();

    // M5 — lecture bridge prioritaire, RSI en complément
    (function() {
      var _s5 = $('tfc-M5-t'); var _u5 = $('tfc-M5-s'); var _c5 = $('tfc-M5');
      var _rsiTxt5 = _rsiM5 > 70 ? ' ↑ excès' : _rsiM5 > 0 && _rsiM5 < 30 ? ' ↓ survente' : _rsiM5 >= 55 ? ' ↑' : _rsiM5 > 0 && _rsiM5 <= 45 ? ' ↓' : '';
      if (_lecM5.includes('ACHAT')) {
        _dir.M5 = 'LONG';
        if (_s5) { _s5.textContent = 'LONG'; _s5.className = 'tfc-sig buy'; }
        if (_u5) _u5.textContent = 'Bridge↑' + _rsiTxt5;
        if (_c5) { _c5.style.background = 'rgba(34,197,94,0.12)'; _c5.style.borderColor = COL_LONG; }
      } else if (_lecM5.includes('VENTE')) {
        _dir.M5 = 'SHORT';
        if (_s5) { _s5.textContent = 'SHORT'; _s5.className = 'tfc-sig sell'; }
        if (_u5) _u5.textContent = 'Bridge↓' + _rsiTxt5;
        if (_c5) { _c5.style.background = 'rgba(239,68,68,0.12)'; _c5.style.borderColor = COL_SHORT; }
      } else if (_rsiM5 > 0) {
        _dir.M5 = _rsiM5 >= 55 ? 'LONG' : _rsiM5 <= 45 ? 'SHORT' : 'NEUTRE';
        if (_s5) { _s5.textContent = _dir.M5; _s5.className = 'tfc-sig ' + (_dir.M5 === 'LONG' ? 'buy' : _dir.M5 === 'SHORT' ? 'sell' : 'wait'); }
        if (_u5) _u5.textContent = 'Momentum' + _rsiTxt5;
        if (_c5) { _c5.style.background = _dir.M5 === 'LONG' ? 'rgba(34,197,94,0.08)' : _dir.M5 === 'SHORT' ? 'rgba(239,68,68,0.08)' : 'rgba(234,179,8,0.06)'; _c5.style.borderColor = _dir.M5 === 'LONG' ? COL_LONG : _dir.M5 === 'SHORT' ? COL_SHORT : COL_WAIT; }
      }
    })();

    // M15 — lecture bridge prioritaire + détection retrace
    (function() {
      var _s15 = $('tfc-M15-t'); var _u15 = $('tfc-M15-s'); var _c15 = $('tfc-M15');
      var _rsiTxt15 = _rsiM15 > 70 ? ' ↑ excès' : _rsiM15 > 0 && _rsiM15 < 30 ? ' ↓ survente' : _rsiM15 >= 55 ? ' ↑' : _rsiM15 > 0 && _rsiM15 <= 45 ? ' ↓' : '';
      if (_lecM15.includes('ACHAT')) {
        _dir.M15 = 'LONG';
        if (_s15) { _s15.textContent = 'LONG'; _s15.className = 'tfc-sig buy'; }
        if (_u15) _u15.textContent = 'Bridge↑' + _rsiTxt15;
        if (_c15) { _c15.style.background = 'rgba(34,197,94,0.12)'; _c15.style.borderColor = COL_LONG; }
      } else if (_lecM15.includes('VENTE')) {
        _dir.M15 = 'SHORT';
        if (_s15) { _s15.textContent = 'SHORT'; _s15.className = 'tfc-sig sell'; }
        if (_u15) _u15.textContent = 'Bridge↓' + _rsiTxt15;
        if (_c15) { _c15.style.background = 'rgba(239,68,68,0.12)'; _c15.style.borderColor = COL_SHORT; }
      } else if (_rsiM15 > 0) {
        _dir.M15 = _rsiM15 >= 55 ? 'LONG' : _rsiM15 <= 45 ? 'SHORT' : 'NEUTRE';
        if (_s15) { _s15.textContent = _dir.M15; _s15.className = 'tfc-sig ' + (_dir.M15 === 'LONG' ? 'buy' : _dir.M15 === 'SHORT' ? 'sell' : 'wait'); }
        if (_u15) _u15.textContent = 'Momentum' + _rsiTxt15;
        if (_c15) { _c15.style.background = _dir.M15 === 'LONG' ? 'rgba(34,197,94,0.08)' : _dir.M15 === 'SHORT' ? 'rgba(239,68,68,0.08)' : 'rgba(234,179,8,0.06)'; _c15.style.borderColor = _dir.M15 === 'LONG' ? COL_LONG : _dir.M15 === 'SHORT' ? COL_SHORT : COL_WAIT; }
      }
    })();

    // H1 — lecture bridge prioritaire + détection retrace dans M15
    (function() {
      var _sh1 = $('tfc-H1-t'); var _uh1 = $('tfc-H1-s'); var _ch1 = $('tfc-H1');
      var _rsiTxth1 = _rsiH1 > 70 ? ' ↑ excès' : _rsiH1 > 0 && _rsiH1 < 30 ? ' ↓ survente' : _rsiH1 >= 55 ? ' ↑' : _rsiH1 > 0 && _rsiH1 <= 45 ? ' ↓' : '';
      if (_lecH1.includes('ACHAT')) {
        _dir.H1 = 'LONG';
        if (_sh1) { _sh1.textContent = 'LONG'; _sh1.className = 'tfc-sig buy'; }
        if (_uh1) _uh1.textContent = 'Bridge↑' + _rsiTxth1;
        if (_ch1) { _ch1.style.background = 'rgba(34,197,94,0.12)'; _ch1.style.borderColor = COL_LONG; }
      } else if (_lecH1.includes('VENTE')) {
        _dir.H1 = 'SHORT';
        if (_sh1) { _sh1.textContent = 'SHORT'; _sh1.className = 'tfc-sig sell'; }
        if (_uh1) _uh1.textContent = 'Bridge↓' + _rsiTxth1;
        if (_ch1) { _ch1.style.background = 'rgba(239,68,68,0.12)'; _ch1.style.borderColor = COL_SHORT; }
      } else if (_rsiH1 > 0) {
        _dir.H1 = _rsiH1 >= 55 ? 'LONG' : _rsiH1 <= 45 ? 'SHORT' : 'NEUTRE';
        if (_sh1) { _sh1.textContent = _dir.H1; _sh1.className = 'tfc-sig ' + (_dir.H1 === 'LONG' ? 'buy' : _dir.H1 === 'SHORT' ? 'sell' : 'wait'); }
        if (_uh1) _uh1.textContent = 'Momentum' + _rsiTxth1;
        if (_ch1) { _ch1.style.background = _dir.H1 === 'LONG' ? 'rgba(34,197,94,0.08)' : _dir.H1 === 'SHORT' ? 'rgba(239,68,68,0.08)' : 'rgba(234,179,8,0.06)'; _ch1.style.borderColor = _dir.H1 === 'LONG' ? COL_LONG : _dir.H1 === 'SHORT' ? COL_SHORT : COL_WAIT; }
      }
    })();

    // ── Retrace badge sur M15 si M15 opposé à H1 ──────────────────────────
    (function() {
      var _u15r = $('tfc-M15-s');
      if (!_u15r) return;
      var _cur = _u15r.textContent;
      if (_dir.M15 === 'LONG' && _dir.H1 === 'SHORT') {
        if (_cur.indexOf('RETRACE') < 0) _u15r.textContent = _cur + ' ↑RETRACE';
      } else if (_dir.M15 === 'SHORT' && _dir.H1 === 'LONG') {
        if (_cur.indexOf('RETRACE') < 0) _u15r.textContent = _cur + ' ↓RETRACE';
      }
    })();

    // ── Alignment summary — source serveur setupQuality en priorité ──────────
    // setupQuality calculé côté serveur (source unique) — pas de recalcul UI divergent
    // Fallback sur calcul UI depuis bridge lectures si setupQuality absent
    var _cons = $('multiTFConsensus');
    var _msg  = $('multiTFMessage');
    var _sqSrv = (state.live && state.live.coach && state.live.coach.agents && state.live.coach.agents.setupQuality)
              || (state.live && state.live.coach && state.live.coach.setupQuality)
              || (state.live && state.live.setupQuality)
              || null;
    var _longTFs  = ['M1','M5','M15','H1'].filter(function(t) { return _dir[t] === 'LONG'; });
    var _shortTFs = ['M1','M5','M15','H1'].filter(function(t) { return _dir[t] === 'SHORT'; });
    var _consText = '', _consColor = '#94a3b8', _msgText = '';

    if (_sqSrv && _sqSrv.quality && _sqSrv.quality !== 'ATTENTE') {
      // Source serveur disponible — affichage synchronisé popup = dashboard = API
      var _sq = _sqSrv;
      // state.live = /coach/realtime; state.live.coach = /coach/live; agents.analysis = source déterministe
      var _isL = (state.live && state.live.coach && state.live.coach.agents && state.live.coach.agents.analysis && state.live.coach.agents.analysis.recommendation === 'BUY')
              || (state.live && state.live.coach && state.live.coach.signal && state.live.coach.signal.verdict === 'LONG');
      var _dirStr = _isL ? 'LONG' : 'SHORT';
      if (_sq.quality === 'PREMIUM') {
        _consText = (_isL ? '⬆' : '⬇') + ' PREMIUM ' + _dirStr + ' — M15+H1 alignés';
        _consColor = _isL ? COL_LONG : COL_SHORT;
        _msgText   = _sq.label;
      } else if (_sq.quality === 'M15_SEUL') {
        _consText = (_isL ? '↑' : '↓') + ' M15 SEUL — H1 neutre';
        _consColor = _isL ? '#86efac' : '#fca5a5';
        _msgText   = _sq.label;
      } else if (_sq.quality === 'RETRACEMENT') {
        _consText = (_isL ? '↑' : '↓') + ' RETRACE M15 ' + _dirStr + ' — contexte H1 adverse';
        _consColor = COL_PENDING;
        _msgText   = _sq.label;
      } else if (_sq.quality === 'TIMING_COURT') {
        _consText = 'M1/M5 signal — pas de setup M15 validé';
        _consColor = COL_WAIT;
        _msgText   = _sq.label;
      } else if (_sq.quality === 'CONFLIT') {
        _consText = '⚠ CONFLIT SIGNAL';
        _consColor = COL_WAIT;
        _msgText   = _sq.label;
      } else {
        _consText = '— ' + (_sq.label || 'Pas d\'alignement clair');
        _consColor = '#475569'; _msgText = '';
      }
    } else {
      // Fallback calcul UI depuis bridge lectures (quand server ne fournit pas setupQuality)
      // Guard conflit: si conflictDetected dans state.live → afficher CONFLIT au lieu de directionnel
      var _consConflict = !!(state.live && state.live.coach && state.live.coach.analysisSnapshot && state.live.coach.analysisSnapshot.sourceSummary && state.live.coach.analysisSnapshot.sourceSummary.conflictDetected)
                       || !!(state.live && state.live.analysisSnapshot && state.live.analysisSnapshot.sourceSummary && state.live.analysisSnapshot.sourceSummary.conflictDetected);
      if (_consConflict) {
        _consText = '⚠ CONFLIT SIGNAL — Attendre résolution';
        _consColor = '#f97316'; _msgText = 'Pine et indicateurs divergent — pas d\'entrée';
      } else if (_longTFs.length >= 3) {
        _consText = '⬆ PREMIUM LONG — ' + _longTFs.join('+');
        _consColor = COL_LONG; _msgText = 'Alignement fort — setup premium haussier';
      } else if (_shortTFs.length >= 3) {
        _consText = '⬇ PREMIUM SHORT — ' + _shortTFs.join('+');
        _consColor = COL_SHORT; _msgText = 'Alignement fort — setup premium baissier';
      } else if (_dir.M15 === 'LONG' && _dir.H1 === 'LONG') {
        _consText = '⬆ RENFORCÉ LONG — M15+H1';
        _consColor = '#4ade80'; _msgText = 'M15 et H1 alignés — setup renforcé';
      } else if (_dir.M15 === 'SHORT' && _dir.H1 === 'SHORT') {
        _consText = '⬇ RENFORCÉ SHORT — M15+H1';
        _consColor = '#f87171'; _msgText = 'M15 et H1 alignés — setup renforcé';
      } else if (_dir.M15 === 'LONG' && _dir.H1 === 'SHORT') {
        _consText = '↑ RETRACE M15 LONG (H1 baissier)';
        _consColor = COL_PENDING; _msgText = 'Retrace exploitable — M15 long dans contexte H1 baissier';
      } else if (_dir.M15 === 'SHORT' && _dir.H1 === 'LONG') {
        _consText = '↓ RETRACE M15 SHORT (H1 haussier)';
        _consColor = COL_PENDING; _msgText = 'Retrace exploitable — M15 short dans contexte H1 haussier';
      } else if (_dir.M15 === 'LONG') {
        _consText = '↑ M15 SEUL — H1 neutre';
        _consColor = '#86efac'; _msgText = 'Signal M15 sans confirmation H1';
      } else if (_dir.M15 === 'SHORT') {
        _consText = '↓ M15 SEUL — H1 neutre';
        _consColor = '#fca5a5'; _msgText = 'Signal M15 sans confirmation H1';
      } else {
        _consText = '— Pas d\'alignement clair';
        _consColor = '#475569'; _msgText = '';
      }
    }

    if (_cons) {
      _cons.style.display = _consText ? 'block' : 'none';
      _cons.textContent   = _consText;
      _cons.style.color   = _consColor;
      _cons.style.fontWeight = '700';
    }
    if (_msg) {
      _msg.style.display = _msgText ? 'block' : 'none';
      _msg.textContent   = _msgText;
    }
  }
  _renderMultiTFRunning = false; // libérer le verrou
}

// ─── DECISION AGENT ───────────────────────────────────────────────────────────
function renderDecision(live) {
  var agents   = getAgents(live);
  var analysis = agents.analysis || {};  // LLM — pour rationale/reason uniquement
  var execution = (live && live.execution) || (live && live.coach && live.coach.execution) || {};
  var priceConsistency = (live && live.priceConsistency) || {};
  var canEnter = execution.canEnter === true;
  var _posEntered = state.tradeState && state.tradeState.entered;
  // SOURCE UNIQUE DE DIRECTION: server déterministe (agents.analysis.recommendation)
  // Priorité: server logic > coach signal > instantTrade > ATTENTE
  // /coach/live: agents.analysis — /coach/realtime: coach.agents.analysis (via getAgents)
  var _srvAnalysis = (live && live.analysis)
    || (live && live.agents && live.agents.analysis)
    || (live && live.coach && live.coach.agents && live.coach.agents.analysis)
    || {};
  var _recDir = String(
    _srvAnalysis.recommendation ||
    (live && live.signal && live.signal.verdict) ||           // /coach/live: signal à la racine
    (live && live.coach && live.coach.signal && live.coach.signal.verdict) ||
    (live && live.instantTrade && live.instantTrade.direction) ||
    'ATTENTE'
  ).toUpperCase();
  if (_recDir === 'WAIT') _recDir = 'ATTENTE';  // normaliser WAIT → pas directionnel
  var _isDirectionalRec = _recDir === 'BUY' || _recDir === 'SELL' || _recDir === 'LONG' || _recDir === 'SHORT';

  // ── Détection conflit Pine vs signal serveur ────────────────────────────────
  // conflictDetected = Pine dit une direction, indicateurs serveur disent autre chose
  // Dans ce cas : NE PAS déclencher PRE-ALERTE (signal non fiable) — afficher le conflit
  var _snap = (live && live.coach && live.coach.analysisSnapshot && live.coach.analysisSnapshot.sourceSummary)
            || (live && live.analysisSnapshot && live.analysisSnapshot.sourceSummary) || {};
  var _conflictDetected = !!_snap.conflictDetected;
  var _tvDir = String(_snap.tvDirection || '').toUpperCase();
  var _rtDir = String(_snap.runtimeDirection || '').toUpperCase();

  // ALERT: PRE-ALERTE — signal directionnel en formation, pas encore prêt à entrer
  // Bloquée si conflit Pine/indicateurs (évite fausse alerte SHORT quand RSI dit LONG)
  if (!canEnter && _isDirectionalRec && !_posEntered && !_conflictDetected) {
    var _preKey = [state.symbol, state.timeframe, 'PRE_ALERT', _recDir].join('|');
    if (!state._alertedKeys[_preKey]) {
      state._alertedKeys[_preKey] = true;
      triggerAlert('PRE_ALERT');
      if (!state.muted) speak('Pré-alerte ' + (_recDir === 'BUY' || _recDir === 'LONG' ? 'LONG' : 'SHORT') + ' sur ' + state.symbol + '. Setup en formation, se préparer.');
    }
  } else if (!_isDirectionalRec || _conflictDetected) {
    // Reset PRE_ALERT key quand signal disparaît ou conflit détecté
    var _preKeyReset = [state.symbol, state.timeframe, 'PRE_ALERT', 'BUY'].join('|');
    var _preKeyReset2 = [state.symbol, state.timeframe, 'PRE_ALERT', 'SELL'].join('|');
    delete state._alertedKeys[_preKeyReset];
    delete state._alertedKeys[_preKeyReset2];
  }

  // ALERT: ENTRY_READY — toutes conditions validées, entrée autorisée
  if (canEnter && !_posEntered) {
    var _entryKey = [state.symbol, state.timeframe, 'ENTRY_READY'].join('|');
    if (!state._alertedKeys[_entryKey]) {
      state._alertedKeys[_entryKey] = true;
      triggerAlert('ENTRY_READY');
    }
  } else {
    // Reset key so next valid canEnter fires again
    var _entryKeyReset = [state.symbol, state.timeframe, 'ENTRY_READY'].join('|');
    delete state._alertedKeys[_entryKeyReset];
  }
  var execDecision = String(execution.decision || '').toUpperCase();
  // Niveaux d'exécution — nécessaires pour conditionner la couleur du verdict
  var _execSlV = Number(execution.sl || 0);
  var _execTpV = Number(execution.tp || 0);
  var _execTradeStatus = String(execution.trade_status || 'WAIT').toUpperCase();
  // Setup exécutable SEULEMENT si canEnter=true + sl>0 + tp>0
  var _isExecutable = canEnter && _execSlV > 0 && _execTpV > 0;
  // rec = direction affichée — source unique serveur déterministe
  // Si server dit WAIT → rec=NEUTRE (pas de couleur directionnelle sur le bouton)
  var _srvRecRaw = String(_srvAnalysis.recommendation || '').toUpperCase();
  var rec = (_srvRecRaw && _srvRecRaw !== 'WAIT')
    ? _srvRecRaw
    : String(
        (live && live.signal && live.signal.verdict) ||           // /coach/live: signal à la racine
        (live && live.coach && live.coach.signal && live.coach.signal.verdict) ||
        (live && live.instantTrade && live.instantTrade.direction) ||
        'NEUTRE'
      ).toUpperCase();
  var reason   = analysis.reason || execution.reason || (live && live.tradeReasoning && Array.isArray(live.tradeReasoning.whyEntry) && live.tradeReasoning.whyEntry[0]) || 'Pas de raison disponible';
  var risk     = (agents.risk && agents.risk.riskLevel) || '--';
  var anticip  = analysis.anticipation || (agents.strategy && agents.strategy.anticipation) || '--';
  var gate     = (live && live.tradeReasoning && live.tradeReasoning.marketGate) || null;
  var nextAct  = execution.reason || (live && live.nextAction && live.nextAction.primary) || reason;

  var enterBtn = document.querySelector('[data-action="ENTER"]');
  if (enterBtn) {
    var _blockEnter = _posEntered; // seul cas où ENTRER est désactivé: position déjà ouverte
    // RÈGLE: ENTRER = armer le robot → toujours cliquable sauf position déjà active
    // canEnter=false ne bloque plus le bouton (le watchdog gérera l'entrée quand prêt)
    enterBtn.disabled = _blockEnter;
    enterBtn.title = _blockEnter
      ? 'Position déjà ouverte — gérer la position en cours.'
      : (state.armed
        ? 'Robot armé — cliquer pour annuler la surveillance.'
        : (canEnter
          ? 'Signal validé — le robot entrera automatiquement en appuyant sur ENTRER.'
          : 'Cliquer pour armer le robot. Il entrera automatiquement quand les conditions sont réunies.'));
    // Si robot armé → ne pas écraser le style ⏸ ANNULER géré par le watchdog
    if (_blockEnter) {
      enterBtn.style.cssText = 'background:#475569;color:#94a3b8;font-weight:700;opacity:0.6;cursor:not-allowed;';
      enterBtn.textContent = '▶ ENTRER';
    } else if (state.armed) {
      // Robot armé: style géré par sendTradeAction/refreshAll — ne pas écraser
    } else if (canEnter && !_conflictDetected) {
      // Signal prêt ET pas de conflit — couleur directionnelle pour indiquer que le moment est bon
      if (rec.indexOf('BUY') >= 0 || rec.indexOf('ACHAT') >= 0 || rec.indexOf('LONG') >= 0) {
        enterBtn.style.cssText = 'background:#22c55e;color:#000;font-weight:700;';
      } else if (rec.indexOf('SELL') >= 0 || rec.indexOf('VENTE') >= 0 || rec.indexOf('SHORT') >= 0) {
        enterBtn.style.cssText = 'background:#ef4444;color:#fff;font-weight:700;';
      } else {
        enterBtn.style.cssText = '';
      }
      enterBtn.textContent = '▶ ENTRER';
    } else {
      // Signal pas encore validé — bouton actif mais neutre (orange doux)
      enterBtn.style.cssText = 'background:#1e293b;color:#94a3b8;font-weight:700;border:1px solid #f97316;';
      enterBtn.textContent = '▶ ENTRER';
    }
  }

  // EXIT — désactivé si pas de position active
  var exitBtn = document.querySelector('[data-action="EXIT"]');
  if (exitBtn) {
    exitBtn.disabled = !_posEntered;
    exitBtn.style.opacity = _posEntered ? '' : '0.4';
    exitBtn.style.cursor = _posEntered ? '' : 'not-allowed';
    exitBtn.title = !_posEntered ? 'Aucune position ouverte' : 'Fermer la position en cours';
  }

  // BE / BREAKEVEN — désactivé si pas de position active
  var beBtn = document.querySelector('[data-action="BE"]');
  if (beBtn) {
    beBtn.disabled = !_posEntered;
    beBtn.style.opacity = _posEntered ? '' : '0.4';
    beBtn.style.cursor = _posEntered ? '' : 'not-allowed';
    beBtn.title = !_posEntered ? 'Aucune position ouverte' : 'Déplacer SL au breakeven';
  }

  // Future entry scenario banner (visible avant ARM, masqué quand armé ou position active)
  var _febSig = (live && live.coach && live.coach.signal) || (live && live.signal) || {};
  renderFutureEntryBanner(execution, _febSig, _posEntered, rec);

  // TF basis: quelle UT pour entrée / contexte / TP — toujours visible si signal directionnel
  renderTfBasis(live);

  // Verdict — si conflit Pine/RSI, l'afficher clairement au lieu de SELL/BUY trompeur
  var vEl = $('dg-verdict');
  if (vEl) {
    if (_posEntered) {
      var _pvp = (state.tradeState && state.tradeState.virtualPosition) || {};
      var _pdir = String(_pvp.direction || state.tradeState.direction || '').toUpperCase();
      var _pIsLong = _pdir.includes('LONG') || _pdir.includes('BUY');
      vEl.textContent = _pIsLong ? '🔒 LONG' : '🔒 SHORT';
      vEl.className = 'verdict ' + (_pIsLong ? 'buy' : 'sell');
      vEl.title = 'Position active — mode gestion';
      vEl.style.color = '';
    } else if (_conflictDetected && _tvDir && _rtDir && _tvDir !== _rtDir) {
      vEl.textContent = 'CONFLIT';
      vEl.className = 'verdict wait';
      vEl.title = 'Pine:' + _tvDir + ' / Indicateurs:' + _rtDir + ' — attendre résolution';
    } else {
      // Couleur directionnelle SEULEMENT si setup exécutable (canEnter=true + sl>0 + tp>0)
      // Sinon: direction affichée mais neutre — évite fausse impression d'entrée possible
      var _isBuyRec  = rec.indexOf('BUY')  >= 0 || rec.indexOf('ACHAT') >= 0 || rec.indexOf('LONG')  >= 0;
      var _isSellRec = rec.indexOf('SELL') >= 0 || rec.indexOf('VENTE') >= 0 || rec.indexOf('SHORT') >= 0;
      if (_isExecutable && _isBuyRec) {
        vEl.textContent = rec;
        vEl.className = 'verdict buy';
        vEl.title = 'Setup LONG exécutable — canEnter validé';
      } else if (_isExecutable && _isSellRec) {
        vEl.textContent = rec;
        vEl.className = 'verdict sell';
        vEl.title = 'Setup SHORT exécutable — canEnter validé';
      } else if (_isBuyRec || _isSellRec) {
        // Direction détectée mais non exécutable → neutre + indicateur d'attente
        vEl.textContent = rec + ' ⏳';
        vEl.className = 'verdict wait';
        vEl.title = !canEnter
          ? 'Direction: ' + rec + ' — canEnter=false (' + _execTradeStatus + ')'
          : (!_execSlV || !_execTpV)
            ? 'Direction: ' + rec + ' — SL/TP non transmis par le bridge'
            : 'Direction: ' + rec + ' — setup non exécutable';
      } else if (state.armed) {
        vEl.textContent = '⏸ ARMÉ';
        vEl.className = 'verdict wait';
        vEl.style.color = '#f97316';
        vEl.title = 'Robot armé — surveillance active. Entrée automatique dès alignement directionnel.';
      } else {
        vEl.textContent = rec;
        vEl.className = 'verdict wait';
        vEl.style.color = '';
        vEl.title = '';
      }
    }
  }

  // Risk tag
  var rEl = $('dg-risk');
  if (rEl) {
    rEl.textContent = risk;
    var r = String(risk).toUpperCase();
    rEl.className = 'tag ' + (r === 'LOW' ? 'ok' : r === 'MEDIUM' ? 'warn' : r === 'HIGH' ? 'bad' : 'warn');
  }

  // Anticip tag
  var aEl = $('dg-anticip');
  if (aEl) {
    aEl.textContent = state.armed && anticip === '--' ? 'SURVEILLANCE' : (anticip !== '--' ? anticip : 'ATTENTE');
    aEl.className = 'tag ' + (state.armed && anticip === '--' ? 'warn' : 'blue');
  }

  // RAISON — très visible, avec explication conflit si détecté
  var rBox = $('dg-reason');
  if (rBox) {
    if (_conflictDetected && _tvDir && _rtDir && _tvDir !== _rtDir) {
      rBox.textContent = '⚠️ CONFLIT SIGNAL — Pine:' + _tvDir + ' / Indicateurs:' + (_rtDir === 'WAIT' ? 'NEUTRE' : _rtDir)
        + ' — Attendre résolution avant entrée';
      rBox.className = 'warn';
    } else if (gate) {
      rBox.textContent = '🚫 BLOCAGE : ' + gate;
      rBox.className = 'bad';
    } else if (state.armed && !_isDirectionalRec) {
      rBox.textContent = 'Robot armé — je surveille le marché en continu. J\'entrerai automatiquement dès qu\'un alignement directionnel clair apparaît.';
      rBox.className = '';
    } else {
      rBox.textContent = reason;
      var _rBuyRec  = rec.indexOf('BUY')  >= 0 || rec.indexOf('ACHAT') >= 0 || rec.indexOf('LONG')  >= 0;
      var _rSellRec = rec.indexOf('SELL') >= 0 || rec.indexOf('VENTE') >= 0 || rec.indexOf('SHORT') >= 0;
      if (_isExecutable && _rBuyRec)       rBox.className = 'buy';
      else if (_isExecutable && _rSellRec) rBox.className = 'sell';
      else                                 rBox.className = '';
    }
    rBox.id = 'dg-reason'; // keep id
  }

  // Prochaine action
  var naEl = $('dg-nextaction');
  if (naEl) {
    if (execDecision === 'NO_ENTRY_CONFLICT') naEl.textContent = 'Prochaine action : ATTENDRE — conflit de signal';
    else if (canEnter) naEl.textContent = 'Prochaine action : ARMER le robot (conditions réunies)';
    else naEl.textContent = 'Prochaine action : PATIENTER — signal pas encore confirmé';
    if (nextAct) naEl.textContent += ' | ' + nextAct;
    if (priceConsistency && typeof priceConsistency.coherent === 'boolean') {
      naEl.textContent += priceConsistency.coherent
        ? ' | Prix cohérent (décision/header/graph).'
        : ' | Incohérence prix détectée: attendre synchronisation.';
    }
  }
}

// ─── STATS ────────────────────────────────────────────────────────────────────
function renderStats() {
  var s = $('statSignals'); if (s) s.textContent = state.stats.signals;
  var t = $('statTrades');  if (t) t.textContent = state.stats.trades;
  var r = $('statRate');
  if (r) r.textContent = state.stats.signals > 0 ? Math.round(state.stats.trades / state.stats.signals * 100) + '%' : '--';
  var e = $('statLastEvent'); if (e) e.textContent = 'Dernier : ' + state.stats.lastEvent;
}

// ─── STATS SERVEUR (win/loss réels depuis /stats) ──────────────────────────────
async function refreshServerStats() {
  try {
    var r = await fetchJson('/stats');
    if (!r || !r.stats) return;
    var s = r.stats;
    // Mettre à jour les compteurs popup avec les vraies stats serveur
    var _won  = s.won  != null ? s.won  : '--';
    var _lost = s.lost != null ? s.lost : '--';
    var _rate = s.winRate != null ? s.winRate + '%' : '--';
    var _tot  = (s.total || 0);
    // Si les éléments statSignals/statTrades existent → afficher wins/losses
    var _sEl = $('statSignals'); if (_sEl) { _sEl.textContent = _won; _sEl.title = 'TP gagnants'; }
    var _tEl = $('statTrades');  if (_tEl) { _tEl.textContent = _lost; _tEl.title = 'SL perdants'; }
    var _rEl = $('statRate');    if (_rEl) { _rEl.textContent = _rate; _rEl.title = 'Winrate'; }
    var _eEl = $('statLastEvent');
    if (_eEl) _eEl.textContent = _tot + ' trades | ' + (state.stats.lastEvent ? 'Dernier: ' + state.stats.lastEvent : '');
    // Mettre à jour state.stats pour cohérence locale
    state.stats.signals = _won;
    state.stats.trades  = _lost;
  } catch(_) {}
}

// ─── DIAGNOSTIC (1 ligne) ───────────────────────────────────────────────────
function renderDiag(live) {
  var el = $('diagLine');
  if (!el) return;
  var reasoning = (live && live.tradeReasoning) || {};
  var market    = (live && live.marketStatus)   || {};
  var agents    = getAgents(live);

  if (reasoning.marketGate) {
    el.textContent = '🚫 ' + reasoning.marketGate;
    el.className = 'blocking';
    el.id = 'diagLine';
    return;
  }

  var parts = [];
  var sessions = market.sessions || {};
  if (Array.isArray(sessions.sessions)) {
    var open = sessions.sessions.filter(function(s) { return s.isOpen; }).map(function(s) { return s.label; });
    if (open.length) parts.push('Sessions: ' + open.join(', '));
  }
  var whyEntry = reasoning.whyEntry;
  if (Array.isArray(whyEntry) && whyEntry.length) {
    parts.push(whyEntry[0]);
  } else if (typeof whyEntry === 'string' && whyEntry) {
    parts.push(whyEntry);
  }
  var aReason = (agents.analysis && agents.analysis.reason) || '';
  if (!parts.length && aReason) parts.push(aReason);
  if (!parts.length) {
    parts.push(market.isOpen ? 'Marche ouvert' : (market.isOpen === false ? 'Marche ferme' : 'Attente donnees'));
  }

  // Position active → log de sync (source unique : state.tradeState.virtualPosition)
  if (state.tradeState && state.tradeState.entered) {
    var _svp = state.tradeState.virtualPosition || {};
    var _fmtD = function(v) { return Number(v) > 0 ? (Number(v) > 100 ? Number(v).toFixed(2) : Number(v).toFixed(5)) : '??'; };
    var _lvVP  = live && live.virtualPosition;
    var _srvSl = _lvVP ? Number(_lvVP.sl) : 0;
    var _locSl = Number(_svp.sl);
    var _slMatch = _srvSl > 0 && Math.abs(_srvSl - _locSl) < 0.01;
    var _syncIcon = _slMatch ? '✅' : '⚠️';
    var _diagParts = [
      _syncIcon + ' SYNC',
      'Ext: ' + _fmtD(_svp.entry) + '/' + _fmtD(_svp.sl) + '/' + _fmtD(_svp.tp),
      _srvSl > 0 ? 'Srv: SL=' + _fmtD(_srvSl) : 'Srv: pas de VP',
      'Brige: ' + (state._lastBridgeData ? ((Date.now() - (state._lastBridgeData._ts || 0) < 30000) ? 'OK' : 'stale') : 'hors ligne')
    ];
    el.textContent = _diagParts.join(' | ');
    el.className = _slMatch ? '' : 'blocking';
    el.id = 'diagLine';
    return;
  }
  el.textContent = parts.join(' — ');
  el.className = '';
  el.id = 'diagLine';
}

// ─── COACH ────────────────────────────────────────────────────────────────────
function renderCoach(live) {
  var el = $('coachText');
  if (!el) return;
  var payload = (live && live.coach) ? live.coach : live;
  var isLiveIa = !!(payload && payload.lia && payload.lia.ok);
  // Afficher la réponse LIA même si ok=false (règle engine local) — contenu toujours utile
  var txt = (payload && payload.lia && payload.lia.response) ||
            (live && live.lia_response) || 'Analyse en attente de données...';
  // Tag discret : IA LIVE = connexion serveur ok, Analyse = règle locale
  var tag = isLiveIa ? '🤖 IA LIVE' : '📊 Analyse';
  txt = tag + '\n' + txt;
  // ── DÉTECTION SETUP DÉPASSÉ ─────────────────────────────────────────────
  // Si position pas encore active et que le prix a déjà franchi le niveau d'entrée suggéré
  var _posNotEntered = !(state.tradeState && state.tradeState.entered);
  if (_posNotEntered && state.price > 0) {
    var _it = (live && live.instantTrade) || null;
    var _entryLvl = _it ? Number(_it.entry || 0) : 0;
    var _entryDir = _it ? String(_it.direction || '').toUpperCase() : '';
    var _setupPassed = _entryLvl > 0 && (
      (_entryDir === 'LONG'  && state.price > _entryLvl * 1.0003) ||
      (_entryDir === 'SHORT' && state.price < _entryLvl * 0.9997)
    );
    if (_setupPassed) {
      var _fmtE = _entryLvl > 100 ? _entryLvl.toFixed(2) : _entryLvl.toFixed(5);
      txt = '⚠️ SETUP DÉPASSÉ — Entrée ' + _entryDir + ' ' + _fmtE + ' déjà franchie\n' + txt;
    }
  }

  // ── Préambule LIA multi-TF ────────────────────────────────────────────────
  // Basé sur lecture_m15/h1 (texte Pine) + rsi_m15/h1 depuis coach.signal.stats
  // Construit uniquement si données réelles présentes — rien d'inventé
  var _liaStats  = (live && live.coach && live.coach.signal && live.coach.signal.stats) || {};
  var _liaLecM15 = String(_liaStats.lecture_m15 || '').toUpperCase();
  var _liaLecH1  = String(_liaStats.lecture_h1  || '').toUpperCase();
  var _liaRsiM15 = Number(_liaStats.rsi_m15 || 0);
  var _liaRsiH1  = Number(_liaStats.rsi_h1  || 0);
  // Analyse des directions Pine (source stricte — pas de RSI seul)
  var _liaSrcSnap = (live && live.coach && live.coach.analysisSnapshot && live.coach.analysisSnapshot.sourceSummary)
                 || (live && live.analysisSnapshot && live.analysisSnapshot.sourceSummary) || {};
  var _liaConflict = !!_liaSrcSnap.conflictDetected;
  var _liaM15Long  = _liaLecM15.includes('ACHAT');
  var _liaM15Short = _liaLecM15.includes('VENTE');
  var _liaH1Long   = _liaLecH1.includes('ACHAT');
  var _liaH1Short  = _liaLecH1.includes('VENTE');

  // ── DÉTECTION CONTRADICTION PRIX vs DIRECTION (seuil élevé pour éviter le flicker) ──
  // Seuil 0.5% sur historique 10 ticks (~80s) — évite les faux positifs sur bruit normal
  var _priceHist = state._priceHistory || [];
  var _priceTrend = 0; // +1 = montée, -1 = baisse, 0 = neutre
  if (_priceHist.length >= 5) {
    var _pOld = _priceHist[0];
    var _pNew = _priceHist[_priceHist.length - 1];
    if (_pOld > 0) {
      var _pChg = (_pNew - _pOld) / _pOld * 100;
      if (_pChg > 0.5) _priceTrend = 1;       // prix monte >0.5% — mouvement franc
      else if (_pChg < -0.5) _priceTrend = -1; // prix baisse >0.5% — mouvement franc
    }
  }
  // Contradiction: Pine SHORT + prix monte || Pine LONG + prix baisse (debounce 2 ticks)
  var _pineDir = (_liaM15Short && _liaH1Short) ? 'SHORT' : (_liaM15Long && _liaH1Long) ? 'LONG' : null;
  var _priceDirContradictsCur = _pineDir &&
    ((_pineDir === 'SHORT' && _priceTrend > 0) || (_pineDir === 'LONG' && _priceTrend < 0));
  // Debounce: seulement actif si vrai 2 appels consécutifs
  var _pdc2 = state._priceDirContraCount || 0;
  if (_priceDirContradictsCur) { _pdc2 = Math.min(_pdc2 + 1, 3); } else { _pdc2 = 0; }
  state._priceDirContraCount = _pdc2;
  var _priceDirContradicts = _priceDirContradictsCur && _pdc2 >= 2;

  // ── CACHE STABILISATION — éviter le flicker ──────────────────────────────────
  // Ne regénérer _liaLines que si les signaux STABLES changent (pas le prix tick à tick)
  var _rsiZone = (_liaRsiM15 > 70 || _liaRsiH1 > 70) ? 'H'
               : (_liaRsiM15 < 30 || _liaRsiH1 < 30) ? 'L' : 'N';
  var _liaCacheKey = (_liaConflict ? 'C' : 'O')
    + '|' + (_liaM15Long ? 'ML' : _liaM15Short ? 'MS' : 'MN')
    + '|' + (_liaH1Long  ? 'HL' : _liaH1Short  ? 'HS' : 'HN')
    + '|' + _rsiZone
    + '|' + (_priceDirContradicts ? 'PDC' : '');

  // ── Narrative LIA — expliquer POURQUOI (format trader pro) ────────────────
  var _liaLines = [];

  // Réutiliser le cache si les signaux stables n'ont pas changé
  if (state._liaLastKey === _liaCacheKey && state._liaLastLines && state._liaLastLines.length > 0) {
    _liaLines = state._liaLastLines;
  } else {
  // (bloc fermé après _liaLines = [...] avant la section News)
  var _liaLinesGenerate = true;
  state._liaLastKey = _liaCacheKey;

  if (_liaConflict) {
    // Conflit Pine/indicateurs → blocage explicite
    _liaLines.push('CONFLIT — Pine et indicateurs divergent. Je ne force pas.');
    _liaLines.push('Mieux vaut attendre la clarté plutôt que forcer une entrée.');
  } else if (_liaM15Long && _liaH1Long) {
    // Alignement complet LONG
    var _r15 = _liaRsiM15 > 70 ? ' en excès' : _liaRsiM15 > 0 && _liaRsiM15 < 30 ? ' en survente' : '';
    var _rH1 = _liaRsiH1 > 70 ? ' en excès' : _liaRsiH1 > 0 && _liaRsiH1 < 30 ? ' en survente' : '';
    // Détecter RSI étiré = impulsion déjà faite → attendre pullback (règle macro/zone)
    var _rsiEtire = _liaRsiM15 > 70 || _liaRsiH1 > 70;
    _liaLines.push('Contexte LONG — H1 haussier' + _rH1 + ' + M15 haussier' + _r15);
    // Contradiction: signal LONG mais prix baisse actuellement
    if (_priceDirContradicts) {
      _liaLines.push('⚠️ ATTENTION — Pine dit LONG mais le prix descend en ce moment.');
      _liaLines.push('Signal Pine peut être en retard (dernière bougie fermée). Lance ANALYSER pour confirmer.');
    }
    if (_rsiEtire) {
      _liaLines.push('Le marché s\'essouffle — impulsion déjà faite. Trop tard pour entrer maintenant.');
      _liaLines.push('Attendre: pullback vers zone ou retour au calme avant d\'entrer.');
    } else {
      _liaLines.push('Signal attendu: confirmation zone d\'entrée. Lance ANALYSER pour le setup complet.');
    }
  } else if (_liaM15Short && _liaH1Short) {
    // Alignement complet SHORT
    var _r15s = _liaRsiM15 > 70 ? ' en excès' : _liaRsiM15 > 0 && _liaRsiM15 < 30 ? ' en survente' : '';
    var _rH1s = _liaRsiH1 > 70 ? ' en excès' : _liaRsiH1 > 0 && _liaRsiH1 < 30 ? ' en survente' : '';
    var _rsiEtireS = _liaRsiM15 < 30 || _liaRsiH1 < 30;
    _liaLines.push('Contexte SHORT — H1 baissier' + _rH1s + ' + M15 baissier' + _r15s);
    // Contradiction: signal SHORT mais prix monte actuellement
    if (_priceDirContradicts) {
      _liaLines.push('⚠️ ATTENTION — Pine dit SHORT mais le prix monte en ce moment.');
      _liaLines.push('Signal Pine peut être en retard (dernière bougie fermée). Lance ANALYSER pour confirmer.');
    }
    if (_rsiEtireS) {
      _liaLines.push('Le marché s\'essouffle en bas — impulsion baissière déjà faite. Trop tard pour shorter.');
      _liaLines.push('Attendre: rebond vers zone ou retour au calme avant d\'entrer.');
    } else {
      _liaLines.push('Signal attendu: confirmation zone d\'entrée. Lance ANALYSER pour le setup complet.');
    }
  } else if (_liaM15Long && !_liaH1Long) {
    // M15 haussier mais H1 pas encore
    var _h1RsiLbl = _liaRsiH1 > 70 ? ' (en excès)' : _liaRsiH1 > 0 && _liaRsiH1 < 30 ? ' (en survente)' : '';
    var _h1State = _liaH1Short ? 'H1 baissier' + _h1RsiLbl : 'H1 neutre' + _h1RsiLbl;
    _liaLines.push('J\'attends — M15 haussier mais ' + _h1State + '.');
    _liaLines.push('Signal attendu: H1 confirme la hausse avant d\'entrer.');
  } else if (_liaM15Short && !_liaH1Short) {
    var _h1RsiLbls = _liaRsiH1 > 70 ? ' (en excès)' : _liaRsiH1 > 0 && _liaRsiH1 < 30 ? ' (en survente)' : '';
    var _h1States = _liaH1Long ? 'H1 haussier' + _h1RsiLbls : 'H1 neutre' + _h1RsiLbls;
    _liaLines.push('J\'attends — M15 baissier mais ' + _h1States + '.');
    _liaLines.push('Signal attendu: H1 confirme la baisse avant d\'entrer.');
  } else if (!_liaM15Long && !_liaM15Short && (_liaLecM15 || _liaLecH1)) {
    // M15 neutre
    var _m15Rsi = _liaRsiM15 > 70 ? ' (en excès)' : _liaRsiM15 > 0 && _liaRsiM15 < 30 ? ' (en survente)' : '';
    _liaLines.push('J\'attends — M15 neutre' + _m15Rsi + ', pas de signal Pine clair.');
    _liaLines.push('Ne rien faire fait partie du trading — attendre la confirmation.');
  } else if (_liaLecM15 || _liaLecH1) {
    _liaLines.push('Analyse en cours — données partielles.');
  } else {
    _liaLines.push('En attente du flux TradingView. Vérifie que le bridge est actif.');
  }
  // Sauvegarder dans le cache
  state._liaLastLines = _liaLines.slice();
  } // fin else (cache miss)

  // ── News live — toujours afficher avant le coach ──────────────────────────
  var _liveNewsCheck = checkNewsBlockEntry();
  var _liveNewsLine  = buildNewsCoachLine();
  if (_liveNewsCheck.blocked) {
    // News bloque — remplacer le message principal
    _liaLines = ['NEWS — NE PAS ENTRER', _liveNewsCheck.reason,
                 _liveNewsCheck.afterWait || 'Attends 5-15min après la réaction.'];
  } else if (_liveNewsCheck.warning) {
    _liaLines.unshift('Attention: ' + _liveNewsCheck.reason);
  }

  var _liveHeader = _liveNewsLine ? ('Calendrier:\n' + _liveNewsLine + '\n──') : '──';
  if (_liaLines.length > 0) {
    txt = _liveHeader + ' Analyse live ──\n' + _liaLines.join('\n') + '\n──────────────────\n' + txt;
  } else if (_liveNewsLine) {
    txt = 'Calendrier:\n' + _liveNewsLine + '\n──────────────────\n' + txt;
  }

  // ── FREEZE AFFICHAGE — évite le clignotement du texte à chaque tick SSE ────────
  // Le serveur régénère lia.response légèrement différemment à chaque tick.
  // On ne met à jour le DOM que si : clé signal changée | news urgentes | 20s écoulées
  var _coachNow   = Date.now();
  var _coachAge   = _coachNow - (state._coachLastRenderMs || 0);
  var _sigChanged = state._coachLastSigKey !== _liaCacheKey;
  var _newsBlock  = _liveNewsCheck.blocked || _liveNewsCheck.warning;
  var _firstRender = !state._coachLastRenderMs;
  var _doRender   = _firstRender || _sigChanged || _newsBlock || _coachAge > 20000;
  if (_doRender) {
    el.textContent = txt;
    state._coachLastRenderMs = _coachNow;
    state._coachLastSigKey   = _liaCacheKey;
  }

  // Couleur coach : source serveur déterministe — agents.analysis.recommendation (/coach/live)
  var _coachSrvRec = (live && live.agents && live.agents.analysis && live.agents.analysis.recommendation)
    || (live && live.analysis && live.analysis.recommendation)
    || (live && live.signal && live.signal.verdict)
    || '';
  var rec = String(_coachSrvRec).toUpperCase();
  var gate = String((live && live.tradeReasoning && live.tradeReasoning.marketGate) || '').toUpperCase();
  // Couleur coach — calculée uniquement si on vient de re-rendre le texte
  // (évite que la couleur clignote indépendamment du texte)
  if (_doRender) {
    var txtLow = txt.toLowerCase();
    var _coachExec = (live && live.execution) || (live && live.coach && live.coach.execution) || {};
    var _coachCanEnter = _coachExec.canEnter === true;
    var _coachSlV = Number(_coachExec.sl || 0);
    var _coachTpV = Number(_coachExec.tp || 0);
    var _coachExecutable = _coachCanEnter && _coachSlV > 0 && _coachTpV > 0;
    var _coachConflict = !!_liaSrcSnap.conflictDetected;
    if (txtLow.indexOf('setup dépassé') >= 0) {
      el.style.color = COL_WAIT;
      el.style.background = 'rgba(234,179,8,0.08)';
    } else if (txtLow.indexOf('break-even') >= 0 || txtLow.indexOf('breakeven') >= 0) {
      el.style.color = COL_PENDING;
      el.style.background = '';
    } else if (txtLow.indexOf('proche sl') >= 0 || txtLow.indexOf('near sl') >= 0) {
      el.style.color = COL_SHORT;
      el.style.background = 'rgba(239,68,68,0.1)';
    } else if (txtLow.indexOf('proche tp') >= 0 || txtLow.indexOf('near tp') >= 0) {
      el.style.color = COL_LONG;
      el.style.background = 'rgba(34,197,94,0.1)';
    } else if (_coachConflict) {
      el.style.color = '#f97316';
      el.style.background = '';
    } else if (gate.indexOf('FERM') >= 0 || gate.indexOf('BLOC') >= 0 || rec.indexOf('WAIT') >= 0 || rec.indexOf('ATTENTE') >= 0) {
      el.style.color = COL_WAIT;
      el.style.background = '';
    } else if (_coachExecutable) {
      if (rec.indexOf('SELL') >= 0 || rec.indexOf('SHORT') >= 0 || rec.indexOf('VENTE') >= 0) {
        el.style.color = COL_SHORT; el.style.background = '';
      } else if (rec.indexOf('BUY') >= 0 || rec.indexOf('LONG') >= 0 || rec.indexOf('ACHAT') >= 0) {
        el.style.color = COL_LONG; el.style.background = '';
      } else {
        el.style.color = '#cbd5e1'; el.style.background = '';
      }
    } else {
      el.style.color = '#94a3b8';
      el.style.background = '';
    }
  }
}

function renderBridgeOffState() {
  state.live = null;
  setConn('BRIDGE OFF', 'bad');
  var wb = $('webhookBadge');
  if (wb) { wb.textContent = 'OFF'; wb.className = 'bdg bad'; }
  var sig = $('signalText');
  if (sig) { sig.textContent = 'OFF'; sig.className = 'signal wait'; }
  var an = $('analysisText');
  if (an) an.textContent = 'Bridge desactive. Donnees live gelees.';
  setCoachText('Bridge desactive.\nCoach en pause jusqu\'a reactivation.', '#cbd5e1', 3, 10000);
  var next = $('dg-nextaction');
  if (next) next.textContent = 'Prochaine action : Reactiver bridge puis analyser';
  var enterBtn = document.querySelector('[data-action="ENTER"]');
  if (enterBtn) {
    enterBtn.disabled = true;
    enterBtn.title = 'Bridge inactif: entrée désactivée.';
  }
}

async function renderBridgeHealth() {
  try {
    const data = await fetchJson('/bridge/health');
    const dot = (id, ok, warn) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.background = ok ? '#22c55e' : (warn ? '#f97316' : '#ef4444');
      el.style.boxShadow = ok ? '0 0 4px #22c55e88' : 'none';
    };
    dot('bh-tv',  data.chain.tradingview.ok,  data.chain.tradingview.ageSeconds < 60);
    dot('bh-srv', data.chain.backend.ok,       false);
    dot('bh-sse', data.chain.sseClients.ok,    false);

    const lbl = document.getElementById('bh-label');
    if (lbl) {
      if (!data.chain.tradingview.ok) {
        lbl.style.color = '#ef4444';
        lbl.textContent = 'TV HORS LIGNE';
        // SÉCURITÉ: bridge offline + robot armé sans position → désarmer immédiatement
        if (state.armed && !(state.tradeState && state.tradeState.entered)) {
          console.warn('[ADEL] Bridge TV offline détecté par health poll → disarm auto');
          if (typeof disarmRobot === 'function') {
            disarmRobot('Bridge TV hors ligne — désarmement automatique sécurité.');
          }
        }
      } else {
        lbl.style.color = '#22c55e';
        lbl.textContent = `${data.chain.tradingview.symbol || '--'} · ${data.chain.tradingview.ageSeconds}s`;
      }
    }
  } catch(_) {
    ['bh-tv','bh-srv','bh-sse'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.background = '#ef4444';
    });
  }
}

function formatNewsEvent(e) {
  // Étoiles
  var stars = Math.min(5, Math.max(0, Number(e.stars) || 0));
  var starsHtml = '<span class="ns">' + '★'.repeat(stars) + '☆'.repeat(5 - stars) + '</span>';

  // Timing
  var mins = Number.isFinite(Number(e.minsUntil)) ? Number(e.minsUntil) : null;
  var timingHtml;
  if (mins === null) {
    timingHtml = '<span class="nt">--</span>';
  } else if (mins >= -5 && mins <= 5) {
    timingHtml = '<span class="nt nt-now">En cours</span>';
  } else if (mins > 0) {
    var h = Math.floor(mins / 60);
    timingHtml = h > 0
      ? '<span class="nt nt-soon">Dans ' + h + 'h' + (mins % 60 > 0 ? (mins % 60) + 'min' : '') + '</span>'
      : '<span class="nt nt-soon">Dans ' + mins + 'min</span>';
  } else {
    var absM = Math.abs(mins);
    var hP = Math.floor(absM / 60);
    timingHtml = hP > 0
      ? '<span class="nt nt-past">Il y a ' + hP + 'h' + (absM % 60 > 0 ? (absM % 60) + 'min' : '') + '</span>'
      : '<span class="nt nt-past">Il y a ' + absM + 'min</span>';
  }

  // Biais
  var bias = e.bias || {};
  var biasDir = String(bias.direction || 'UNCERTAIN').toUpperCase();
  var biasMap = {
    'BULLISH_USD': '📈 Haussier USD',
    'BEARISH_USD': '📉 Baissier USD',
    'NEUTRAL':     '➡️ Neutre',
    'UNCERTAIN':   '⚠️ Incertain'
  };
  var biasText = biasMap[biasDir] || '⚠️ Incertain';
  var biasCls = biasDir === 'BULLISH_USD' ? 'nb-bull' : biasDir === 'BEARISH_USD' ? 'nb-bear' : 'nb-neu';
  var biasHtml = '<span class="nb ' + biasCls + '">' + biasText + '</span>';

  // Actual vs Forecast
  var avfHtml = '';
  if (e.actual != null && e.actual !== '') {
    var isBetter = false, isWorse = false;
    var actualN = parseFloat(e.actual), forecastN = parseFloat(e.forecast);
    if (!isNaN(actualN) && !isNaN(forecastN)) {
      if (biasDir === 'BEARISH_USD') {
        isBetter = actualN < forecastN;
        isWorse  = actualN > forecastN;
      } else {
        isBetter = actualN > forecastN;
        isWorse  = actualN < forecastN;
      }
    }
    var avfCls = isBetter ? 'nav-good' : isWorse ? 'nav-bad' : '';
    var forecastStr = (e.forecast != null && e.forecast !== '') ? ' vs Prévu: ' + e.forecast : '';
    avfHtml = '<span class="nav ' + avfCls + '">Réel: ' + e.actual + forecastStr + '</span>';
  }

  var title = e.title || e.event || 'Événement';
  var country = e.country ? '<span class="nco">' + e.country + '</span>' : '';
  var time = e.time ? '<span class="ntime">' + e.time + '</span>' : '';

  return '<div class="ni">' +
    '<div class="ni-head">' + starsHtml + country + time + timingHtml + '</div>' +
    '<div class="ni-title"><strong>' + title + '</strong></div>' +
    '<div class="ni-foot">' + biasHtml + avfHtml + '</div>' +
  '</div>';
}

// ── ANTI-SPAM NEWS — re-fetch max toutes les 5min, re-render uniquement si contenu change ──
var _newsFetchLastAt  = 0;
var _newsFetchCache   = { events: [], headlines: [] };
var _newsRenderHash   = '';

async function renderNews(live) {
  var root = $('newsList');
  if (!root) return;

  // Tenter d'abord les événements depuis le payload realtime (agents.news)
  var agents = getAgents(live);
  var newsAgent = agents.news || {};
  var events = Array.isArray(newsAgent.upcomingEvents) ? newsAgent.upcomingEvents : [];
  var headlines = [];

  // Appeler /news?symbol= pour obtenir events + headlines — MAX UNE FOIS PAR 5 MIN
  var _nowNews = Date.now();
  var hasNewFormat = events.length > 0 && events[0] && (events[0].stars != null || events[0].bias != null);
  if (!hasNewFormat && (_nowNews - _newsFetchLastAt > 300000)) {
    _newsFetchLastAt = _nowNews;
    try {
      var data = await fetchJson('/news?symbol=' + encodeURIComponent(state.symbol));
      // /news peut retourner events dans data.events OU data.news (selon la version serveur)
      if (Array.isArray(data.events) && data.events.length > 0) {
        events = data.events;
      } else if (Array.isArray(data.news) && data.news.length > 0) {
        events = data.news;
      } else if (Array.isArray(data)) {
        events = data;
      }
      if (Array.isArray(data.headlines)) headlines = data.headlines;
    } catch (_) {}

    // Si /news ne donne pas d'événements avec timing → essayer /calendar (source plus fiable)
    if (events.length === 0 || !events.some(function(e){ return e.mins != null || e.minsUntil != null || e.minutesUntil != null; })) {
      try {
        var calData = await fetchJson('/calendar');
        if (Array.isArray(calData.events) && calData.events.length > 0) {
          events = calData.events; // format: {event, impact:"HIGH", mins:25}
        }
      } catch (_cal) {}
    }

    // Mettre en cache pour les prochains 5 min
    _newsFetchCache = { events: events.slice(), headlines: headlines.slice() };
  } else if (!hasNewFormat) {
    // Utiliser le cache — pas de re-fetch
    events   = _newsFetchCache.events.slice();
    headlines = _newsFetchCache.headlines.slice();
  }

  // Stocker pour le calcul du biais global
  state.newsEvents = events;

  // ANTI-DOUBLON RENDER — ne re-rendre que si le contenu a changé
  var _newHash = (events.slice(0,5).map(function(e){ return e.title||e.event||''; }).join('|'))
               + '|' + (headlines.slice(0,3).map(function(h){ return h.title||''; }).join('|'));
  if (_newHash === _newsRenderHash) return; // rien de nouveau → skip le render complet
  _newsRenderHash = _newHash;

  // ALERT: NEWS_HIGH — event avec impact fort dans les 30 prochaines minutes
  events.forEach(function(ev) {
    var stars = Number(ev.stars || ev.impact || 0);
    var mins  = Number.isFinite(Number(ev.minsUntil)) ? Number(ev.minsUntil)
                : (Number.isFinite(Number(ev.minutesUntil)) ? Number(ev.minutesUntil) : -1);
    if (stars >= 4 && mins >= 0 && mins <= 30) {
      var _newsKey = 'NEWS_HIGH|' + (ev.id || ev.title || '') + '|' + (ev.time || mins);
      if (!state._alertedKeys[_newsKey]) {
        state._alertedKeys[_newsKey] = true;
        triggerAlert('NEWS_HIGH', String(ev.title || '').slice(0, 30));
      }
    }
  });

  var html = events.slice(0, 5).map(formatNewsEvent);

  if (html.length === 0 && newsAgent.symbolImpact) {
    html.push('<div class="ni"><span class="nav">' + newsAgent.symbolImpact + '</span></div>');
  }

  root.innerHTML = html.join('') || '<div class="ni"><span class="nt">Aucun événement à venir</span></div>';

  // --- Headlines RSS live ---
  if (headlines.length > 0) {
    var hdEl = document.getElementById('headlinesList');
    if (!hdEl) {
      hdEl = document.createElement('div');
      hdEl.id = 'headlinesList';
      hdEl.style.cssText = 'margin-top:8px;border-top:1px solid #334155;padding-top:6px;';
      root.appendChild(hdEl);
    }
    hdEl.innerHTML = '<div style="font-size:10px;color:#64748b;margin-bottom:4px;text-transform:uppercase;letter-spacing:1px;">Headlines live</div>' +
      headlines.slice(0, 5).map(function(h) {
        var biasColor = h.bias === 'Bullish' ? COL_LONG : h.bias === 'Bearish' ? COL_SHORT : COL_WAIT;
        var age = h.ageMinutes < 60 ? h.ageMinutes + 'min' : Math.round(h.ageMinutes / 60) + 'h';
        return '<div style="margin-bottom:6px;padding:4px 6px;background:#1e293b;border-radius:4px;border-left:2px solid ' + biasColor + '">' +
          '<div style="font-size:11px;color:#e2e8f0;line-height:1.3">' + h.title + '</div>' +
          '<div style="font-size:10px;color:#64748b;margin-top:2px">' + h.source + ' · ' + age + ' · <span style="color:' + biasColor + '">' + h.bias + '</span></div>' +
        '</div>';
      }).join('');
  }

  // Mettre à jour le ticker avec toutes les headlines disponibles
  if (headlines.length > 0) {
    updateNewsTicker(headlines);
  }
}

// ─── NEWS TICKER ─────────────────────────────────────────────────────────────
function updateNewsTicker(headlines) {
  var inner = document.getElementById('tickerInner');
  if (!inner || !headlines || !headlines.length) return;
  var items = headlines.map(function(h) {
    var biasChar = h.bias === 'Bullish' ? '▲' : h.bias === 'Bearish' ? '▼' : '●';
    var biasColor = h.bias === 'Bullish' ? COL_LONG : h.bias === 'Bearish' ? COL_SHORT : COL_NEUTRAL;
    return '<span style="margin:0 24px"><span style="color:' + biasColor + '">' + biasChar + '</span> ' + h.title + ' <span style="color:#334155">[' + h.source + ' · ' + h.ageMinutes + 'min]</span></span>';
  }).join('');
  inner.innerHTML = items + items; // double pour boucle continue
  var duration = Math.max(20, headlines.length * 8);
  inner.style.animation = 'tickerScroll ' + duration + 's linear infinite';
}

// ─── MARKET SESSION BADGE ─────────────────────────────────────────────────────
function renderMarketSession(live) {
  var el = document.getElementById('marketSession');
  if (!el) return;
  var status = (live && live.marketStatus) || (live && live.market_status);
  if (!status) return;

  var isOpen = status.isOpen || status.market === 'open';

  // sessions = objet { sessions: [{key,label,isOpen}, ...], overlaps, ... }
  var _sessArr = (status.sessions && Array.isArray(status.sessions.sessions))
    ? status.sessions.sessions
    : (Array.isArray(status.sessions) ? status.sessions : []);
  var _openSess = _sessArr.filter(function(s){ return s.isOpen; });
  var session = status.session
    || (_openSess.length ? (_openSess[0].label || _openSess[0].key) : '')
    || '';

  if (!isOpen) {
    el.style.background = 'rgba(239,68,68,0.1)';
    el.style.color = '#ef4444';
    el.style.border = '1px solid rgba(239,68,68,0.3)';
    el.textContent = '⏸ FERMÉ';
    return;
  }

  var sessionColors = {
    'LONDON':   '#3b82f6',
    'NEW_YORK': '#f97316',
    'TOKYO':    '#eab308',
    'SYDNEY':   '#8b5cf6',
    'OVERLAP':  '#22c55e'
  };
  var key = Object.keys(sessionColors).find(function(k) { return String(session).toUpperCase().includes(k); }) || '';
  var color = sessionColors[key] || '#22c55e';

  // Chevauchement London+NY = session la plus active
  var _isOverlap = _openSess.length > 1;
  if (_isOverlap) { key = 'OVERLAP'; color = '#22c55e'; }

  var sessLabel = _isOverlap
    ? _openSess.map(function(s){ return s.label||s.key; }).join('+')
    : (key || String(session).substring(0,8) || 'OUVERT');

  el.style.background = color + '22';
  el.style.color = color;
  el.style.border = '1px solid ' + color + '44';
  el.textContent = '● ' + sessLabel;
}

// ─── MARKET BIAS ─────────────────────────────────────────────────────────────
// Jauge pondérée par TF réels : M15=0.60, H1=0.40
// Un seul TF disponible → strength max 60% (M15) ou 40% (H1), pas de saturation 100%
// Fallback sur votes agents si RSI per-TF non disponibles (robotV12 absent)
function computeMarketBias(live, newsEvents) {
  // ── SOURCE UNIQUE DE VÉRITÉ : sourceSummary Pine ──────────────────────────
  // Le conflit Pine/RSI est détecté serveur-side. Si conflit → CONFLIT (orange), jamais directionnel.
  // La jauge ne peut pas raconter une histoire différente du verdict serveur.
  var _biasSnap = (live && live.coach && live.coach.analysisSnapshot && live.coach.analysisSnapshot.sourceSummary)
               || (live && live.analysisSnapshot && live.analysisSnapshot.sourceSummary) || {};
  if (_biasSnap.conflictDetected) {
    return { label: 'CONFLIT', color: '#f97316', score: 0, strength: 0 };
  }

  var _bStats  = (live && live.coach && live.coach.signal && live.coach.signal.stats) || {};
  var _rM1     = Number(_bStats.rsi_m1  || 0);
  var _rM5     = Number(_bStats.rsi_m5  || 0);
  var _rM15    = Number(_bStats.rsi_m15 || 0);
  var _rH1     = Number(_bStats.rsi_h1  || 0);
  var _lecM1   = String(_bStats.lecture_m1  || '').toUpperCase();
  var _lecM5   = String(_bStats.lecture_m5  || '').toUpperCase();
  var _lecM15  = String(_bStats.lecture_m15 || '').toUpperCase();
  var _lecH1   = String(_bStats.lecture_h1  || '').toUpperCase();
  // Fallback M1/M5 depuis bridge live si pas dans stats
  var _bdFb = state && state._lastBridgeData;
  if (_bdFb) {
    if (!_lecM1  && _bdFb.lectureTech1) _lecM1  = String(_bdFb.lectureTech1).toUpperCase();
    if (!_lecM5  && _bdFb.lectureTech2) _lecM5  = String(_bdFb.lectureTech2).toUpperCase();
    if (!_lecM15 && _bdFb.lectureTech3) _lecM15 = String(_bdFb.lectureTech3).toUpperCase();
    if (!_lecH1  && _bdFb.lectureTech4) _lecH1  = String(_bdFb.lectureTech4).toUpperCase();
    if (!_rM1  && _bdFb.rsiTf1 > 0)  _rM1  = Number(_bdFb.rsiTf1);
    if (!_rM5  && _bdFb.rsiTf2 > 0)  _rM5  = Number(_bdFb.rsiTf2);
    if (!_rM15 && _bdFb.rsiTf3 > 0)  _rM15 = Number(_bdFb.rsiTf3);
    if (!_rH1  && _bdFb.rsiTf4 > 0)  _rH1  = Number(_bdFb.rsiTf4);
  }
  // Quand lecture Pine est null, utiliser tvDirection comme fallback direction M15
  // Évite le cas RSI=57 → HAUSSIER alors que Pine dit SHORT
  if (!_lecM15 && _biasSnap.tvDirection) {
    var _tvD = String(_biasSnap.tvDirection).toUpperCase();
    _lecM15 = (_tvD === 'LONG' || _tvD === 'BUY') ? 'ACHAT'
            : (_tvD === 'SHORT' || _tvD === 'SELL') ? 'VENTE' : '';
  }
  var hasTfRsi = _rM1 > 0 || _rM5 > 0 || _rM15 > 0 || _rH1 > 0;

  if (hasTfRsi) {
    // ── Voie principale : RSI pondéré par TF avec force proportionnelle ───
    // Poids: M1×0.10 M5×0.15 M15×0.45 H1×0.30 (total 1.0)
    // Force RSI proportionnelle à l'écart depuis 50 (seuil 55/45 requis pour voter)
    // RSI 52 → neutre (ne contribue pas), RSI 62 → 48%, RSI 75 → 100%
    // Lecture bridge (ACHAT/VENTE) → force maximale 1.0 (Pine confirme directement)
    function _biasRsiStr(rsi) {
      if (rsi >= 55) return Math.min(1, (rsi - 50) / 25);
      if (rsi <= 45) return Math.min(1, (50 - rsi) / 25);
      return 0; // zone neutre 45–55 = pas de vote
    }
    function _biasRsiDir(rsi) { return rsi >= 55 ? 1 : rsi <= 45 ? -1 : 0; }

    var tfScore  = 0;
    var tfWeight = 0; // poids uniquement des TF qui ont réellement voté (dir ≠ 0)
    var _tfVoteCount = 0; // nombre de TF qui ont voté (pour le cap)

    if (_rM1 > 0 || _lecM1) {
      var _dm1 = _lecM1.includes('ACHAT') ? 1 : _lecM1.includes('VENTE') ? -1 : (_rM1 > 0 ? _biasRsiDir(_rM1) : 0);
      if (_dm1 !== 0) {
        var _sm1 = (_lecM1.includes('ACHAT') || _lecM1.includes('VENTE')) ? 1.0 : _biasRsiStr(_rM1);
        tfScore  += _dm1 * _sm1 * 0.10;
        tfWeight += 0.10;
        _tfVoteCount++;
      }
    }
    if (_rM5 > 0 || _lecM5) {
      var _dm5 = _lecM5.includes('ACHAT') ? 1 : _lecM5.includes('VENTE') ? -1 : (_rM5 > 0 ? _biasRsiDir(_rM5) : 0);
      if (_dm5 !== 0) {
        var _sm5 = (_lecM5.includes('ACHAT') || _lecM5.includes('VENTE')) ? 1.0 : _biasRsiStr(_rM5);
        tfScore  += _dm5 * _sm5 * 0.15;
        tfWeight += 0.15;
        _tfVoteCount++;
      }
    }
    if (_rM15 > 0) {
      var _dm15 = _lecM15.includes('ACHAT') ? 1 : _lecM15.includes('VENTE') ? -1 : _biasRsiDir(_rM15);
      if (_dm15 !== 0) {
        var _sm15 = (_lecM15.includes('ACHAT') || _lecM15.includes('VENTE')) ? 1.0 : _biasRsiStr(_rM15);
        tfScore  += _dm15 * _sm15 * 0.45;
        tfWeight += 0.45;
        _tfVoteCount++;
      }
    }
    if (_rH1 > 0) {
      var _dh1 = _lecH1.includes('ACHAT') ? 1 : _lecH1.includes('VENTE') ? -1 : _biasRsiDir(_rH1);
      if (_dh1 !== 0) {
        var _sh1 = (_lecH1.includes('ACHAT') || _lecH1.includes('VENTE')) ? 1.0 : _biasRsiStr(_rH1);
        tfScore  += _dh1 * _sh1 * 0.30;
        tfWeight += 0.30;
        _tfVoteCount++;
      }
    }

    // Ajustement news minimal (±0.03 max par événement — ne fausse pas la force TF)
    if (Array.isArray(newsEvents)) {
      newsEvents.forEach(function(e) {
        var b = (e && e.bias && e.bias.direction) || (e && e.bias) || '';
        if (b.includes('BULLISH')) tfScore += 0.03;
        if (b.includes('BEARISH')) tfScore -= 0.03;
      });
    }

    // strength = force réelle sur les TFs ayant voté (M1+M5+M15+H1)
    // Cap: 100% uniquement si les 4 TFs ont voté dans la même direction
    // 3 TFs → max 92%, 2 TFs → max 80%, 1 TF → max 65%
    var _maxStr = _tfVoteCount >= 4 ? 100 : _tfVoteCount === 3 ? 92 : _tfVoteCount === 2 ? 80 : 65;
    var strength = tfWeight > 0
      ? Math.min(_maxStr, Math.round(Math.abs(tfScore) / tfWeight * 100))
      : 0;

    if (tfScore > 0.08)  return { label: 'HAUSSIER', color: '#22c55e', score: tfScore, strength: strength };
    if (tfScore < -0.08) return { label: 'BAISSIER', color: '#ef4444', score: tfScore, strength: strength };
    return { label: 'NEUTRE', color: '#eab308', score: 0, strength: strength };
  }

  // ── Fallback : votes agents si RSI per-TF non disponibles ────────────────
  var score = 0;
  var signals = 0;
  var decision = ((live && live.execution && live.execution.decision) ||
    (live && live.coach && live.coach.execution && live.coach.execution.decision) || '').toUpperCase();
  if (decision.includes('BUY') || decision.includes('LONG'))  { score += 2; signals++; }
  if (decision.includes('SELL') || decision.includes('SHORT')){ score -= 2; signals++; }
  var agents = (live && live.coach && live.coach.agents) || (live && live.agents) || {};
  for (var key in agents) {
    if (!Object.prototype.hasOwnProperty.call(agents, key)) continue;
    var agent = agents[key];
    var sig = ((agent && agent.signal) || (agent && agent.recommendation) || '').toUpperCase();
    if (sig.includes('BUY') || sig.includes('LONG'))  { score += 1; signals++; }
    if (sig.includes('SELL') || sig.includes('SHORT')){ score -= 1; signals++; }
  }
  if (Array.isArray(newsEvents)) {
    newsEvents.forEach(function(e) {
      var b = (e && e.bias && e.bias.direction) || (e && e.bias) || '';
      if (b.includes('BULLISH')) score += 0.5;
      if (b.includes('BEARISH')) score -= 0.5;
    });
  }
  if (signals === 0) return { label: 'NEUTRE', color: '#64748b', score: 0, strength: 0 };
  var newsLen  = Array.isArray(newsEvents) ? newsEvents.length : 0;
  var fbStr    = Math.min(80, Math.round(Math.abs(score) / (signals + newsLen * 0.5 || 1) * 100));
  if (score > 0.5)  return { label: 'HAUSSIER', color: '#22c55e', score: score, strength: fbStr };
  if (score < -0.5) return { label: 'BAISSIER', color: '#ef4444', score: score, strength: fbStr };
  return { label: 'NEUTRE', color: '#eab308', score: 0, strength: fbStr };
}

// ─── GAUGE PULSE MULTI-TF ─────────────────────────────────────────────────────
// Source: snapshots réels du scan ANALYSER (M1+M5+M15+H1 depuis bridge Pine)
// M30/H4/D1 exclus — pas de données bridge dédiées
// Poids: M1×0.10 M5×0.15 M15×0.40 H1×0.35
// Détecte: ACCELERATION (tous alignés fort) / SLOWDOWN (H1 directionnel, M1/M5 neutres)
//          REVERSAL_RISK (H1 et M1/M5 opposés) / COMPRESSION (aucun signal)
function computeGaugePulse(snapshots) {
  var _wts = { M1: 0.10, M5: 0.15, M15: 0.40, H1: 0.35 };
  var score = 0, weightUsed = 0;
  var votes = { M1: 0, M5: 0, M15: 0, H1: 0 };

  (snapshots || []).forEach(function(s) {
    var w = _wts[s.tf];
    if (!w) return; // M30/H4/D1 exclus — pas de flux bridge réel
    if (!s.directional || s.rec === 'N/A' || s.rec === 'WAIT') return;
    var dir = (s.rec.includes('BUY') || s.rec.includes('LONG')) ? 1 : -1;
    var str = Math.min(1, Math.max(0.5, (s.strength || 50) / 100));
    score      += dir * str * w;
    weightUsed += w;
    votes[s.tf] = dir;
  });

  var h1 = votes.H1, m15 = votes.M15, m5 = votes.M5, m1 = votes.M1;
  var activeDirs = [h1, m15, m5, m1].filter(function(v) { return v !== 0; });
  var strength = weightUsed > 0 ? Math.min(100, Math.round(Math.abs(score) / weightUsed * 100)) : 0;

  // ── Détection état marché ──────────────────────────────────────────────────
  var pulseState = 'NORMAL', stateLabel = '';
  if (activeDirs.length === 0 || (h1 === 0 && m15 === 0)) {
    // Aucun TF clé directionnel → compression / range
    pulseState = 'COMPRESSION'; stateLabel = 'Compression';
  } else if (h1 !== 0 && m5 !== 0 && h1 !== m5) {
    // M5 confirme ET contredit H1 → divergence structurée → retournement possible
    // RÈGLE: M1 seul ne suffit pas à déclencher REVERSAL_RISK (trop bruité — cause jauge folle)
    pulseState = 'REVERSAL_RISK';
    stateLabel = h1 > 0 ? 'Retournement baissier possible' : 'Retournement haussier possible';
  } else if (h1 !== 0 && m1 === 0 && m5 === 0) {
    // H1 directionnel mais M1/M5 neutres → momentum qui s'essouffle
    pulseState = 'SLOWDOWN'; stateLabel = 'Ralentissement';
  } else if (h1 === m15 && m15 === m1 && m1 !== 0 && strength >= 65) {
    // Tous alignés + force ≥ 65% → accélération
    pulseState = 'ACCELERATION';
    stateLabel = h1 > 0 ? 'Accélération haussière' : 'Accélération baissière';
  }

  // ── Label + couleur ────────────────────────────────────────────────────────
  var label, color;
  if (pulseState === 'COMPRESSION') {
    label = 'COMPRESSION'; color = '#64748b';
  } else if (pulseState === 'REVERSAL_RISK') {
    label = 'DIVERGENCE'; color = '#f97316';
  } else if (pulseState === 'SLOWDOWN') {
    label = score > 0 ? 'HAUSSIER' : 'BAISSIER'; color = '#eab308';
  } else if (pulseState === 'ACCELERATION') {
    label = score > 0 ? 'HAUSSIER' : 'BAISSIER'; color = score > 0 ? '#22c55e' : '#ef4444';
  } else {
    if (score > 0.08)      { label = 'HAUSSIER'; color = '#22c55e'; }
    else if (score < -0.08){ label = 'BAISSIER'; color = '#ef4444'; }
    else                   { label = 'NEUTRE';   color = '#eab308'; }
  }

  // Jauges LONG/SHORT séparées — poids haussier vs baissier
  var bullWeight = 0, bearWeight = 0;
  var activeTFs = [];
  (snapshots || []).forEach(function(s) {
    var w = _wts[s.tf];
    if (!w || !s.directional || s.rec === 'N/A' || s.rec === 'WAIT') return;
    var dir = (s.rec.includes('BUY') || s.rec.includes('LONG')) ? 1 : -1;
    if (dir > 0) bullWeight += w; else bearWeight += w;
    if (activeTFs.indexOf(s.tf) < 0) activeTFs.push(s.tf);
  });
  var totalW = bullWeight + bearWeight;
  var longPct  = totalW > 0 ? Math.round(bullWeight / totalW * 100) : 50;
  var shortPct = totalW > 0 ? Math.round(bearWeight / totalW * 100) : 50;
  // Anti 50/50 exact : quand un seul TF vote et totalW faible, éviter l'affichage trompeur 50/50
  // Si aucun TF directionnel → laisser 50/50 (honnête) — ne pas forcer une direction

  // Ordre canonique pour l'affichage TF
  var _tfOrder = ['M1','M5','M15','H1','H4'];
  activeTFs.sort(function(a, b) { return _tfOrder.indexOf(a) - _tfOrder.indexOf(b); });
  var tfAnnotation = activeTFs.length > 0 ? activeTFs.join('+') : '';

  // Aiguille: score [-1, +1] → position [5%, 95%] (rétro-compatibilité)
  var needlePos = Math.max(5, Math.min(95, Math.round(50 + score * 45)));
  return { label: label, color: color, score: score, strength: strength, pulseState: pulseState, stateLabel: stateLabel, needlePos: needlePos, longPct: longPct, shortPct: shortPct, tfAnnotation: tfAnnotation };
}

// ─── APPLY GAUGE PULSE → jauges LONG/SHORT séparées ─────────────────────────
function applyGaugePulse(pulse, entryImminent) {
  var gLong  = document.getElementById('gaugeLong');
  var gShort = document.getElementById('gaugeShort');
  var gLongP = document.getElementById('gaugeLongPct');
  var gShortP= document.getElementById('gaugeShortPct');
  var gLabel = document.getElementById('gaugeLabel');
  var gWrap  = document.getElementById('gaugeDualWrap');
  if (gLong)  gLong.style.width  = (pulse.longPct  || 0) + '%';
  if (gShort) gShort.style.width = (pulse.shortPct || 0) + '%';
  if (gLongP)  gLongP.textContent  = (pulse.longPct  || 0) + '%';
  if (gShortP) gShortP.textContent = (pulse.shortPct || 0) + '%';
  if (gLabel) {
    var _glBase = pulse.stateLabel ? pulse.label + ' \u00b7 ' + pulse.stateLabel : pulse.label;
    var txt = pulse.tfAnnotation ? _glBase + ' \u00b7 ' + pulse.tfAnnotation : _glBase;
    gLabel.textContent = txt;
    gLabel.style.color = pulse.color;
  }
  if (gWrap) {
    if (entryImminent) gWrap.classList.add('gauge-entry-soon');
    else               gWrap.classList.remove('gauge-entry-soon');
  }
}

// ─── BANNER ROBOT ARMÉ ────────────────────────────────────────────────────────
// mode: 'off' | 'watching' | 'approaching' | 'imminent' | 'entering'
// exec: { canEnter, reason, conflictReasons } | sig: { verdict, confidence }
function renderArmedBanner(mode, exec, sig) {
  var el = document.getElementById('armedBanner');
  if (!el) return;
  state.armedMode = mode || 'off'; // sync pour applyGaugePulse _imminent

  if (!mode || mode === 'off') {
    el.style.display = 'none';
    return;
  }

  var conf    = Number((sig && sig.confidence) || 0);
  var verdict = String((sig && sig.verdict) || '').toUpperCase();
  // DIRECTION VERROUILLÉE à l'armement — jamais depuis sig.verdict (volatile, change chaque poll)
  // sig.verdict est utilisé uniquement si la direction n'a pas encore été verrouillée
  var isLong  = state._armedDirection === 'LONG'
             || (!state._armedDirection && (verdict === 'BUY' || verdict === 'LONG'));
  var isShort = state._armedDirection === 'SHORT'
             || (!state._armedDirection && (verdict === 'SELL' || verdict === 'SHORT'));

  // COULEUR STABLE — basée sur la direction, identique pour tous modes surveillance
  // Seul 'entering' a une couleur renforcée (flash d'entrée)
  var _dirBg     = isLong ? 'rgba(34,197,94,0.10)'  : isShort ? 'rgba(239,68,68,0.10)'  : 'rgba(59,130,246,0.12)';
  var _dirBorder = isLong ? '#22c55e'                : isShort ? '#ef4444'                : '#3b82f6';
  var _dirColor  = isLong ? '#4ade80'                : isShort ? '#f87171'                : '#60a5fa';

  var text, bg, border, color;

  if (mode === 'entering') {
    text   = isShort ? '▼ ça va descendre — j\'entre maintenant' : '▲ ça va monter — j\'entre maintenant';
    bg     = isShort ? 'rgba(239,68,68,0.25)' : 'rgba(34,197,94,0.25)';
    border = isShort ? '#ef4444' : '#22c55e';
    color  = isShort ? '#ef4444' : '#22c55e';

  } else if (mode === 'imminent') {
    var _confImm = conf > 0 ? ' (' + Math.round(conf) + '%)' : '';
    var _immDir   = isShort ? '▼ SHORT' : '▲ LONG';
    // Format obligatoire: "À VENIR — SNIPER / SCALPING / SWING"
    var _immSetupRaw = (state._lastSetupTypeLabel || '').replace(/[🎯⚡📈🔥✅]/g,'').trim();
    var _immMode  = _immSetupRaw || (state._lockedSetupType || 'SNIPER').toUpperCase();
    text   = 'À VENIR — ' + _immMode + _confImm
           + '\n' + _immDir + ' | Setup validé — attente confirmation M1 avant entrée';
    bg = _dirBg; border = _dirBorder; color = _dirColor;

  } else if (mode === 'approaching') {
    var _confStr = conf > 0 ? ' (' + Math.round(conf) + '%)' : '';
    // Format obligatoire: "À VENIR — SNIPER / SCALPING / SWING" dès l'approche
    var _appSetupRaw = (state._lastSetupTypeLabel || '').replace(/[🎯⚡📈🔥✅]/g,'').trim();
    var _appMode  = _appSetupRaw || (state._lockedSetupType || 'SNIPER').toUpperCase();
    var _appDir   = isShort ? '▼ SHORT' : isLong ? '▲ LONG' : '';
    text   = 'À VENIR — ' + _appMode + _confStr
           + (_appDir ? '\n' + _appDir + ' — conditions en approche' : '\n⏳ conditions en approche');
    bg = _dirBg; border = _dirBorder; color = _dirColor;

  } else {
    // 'watching' — robot armé, marché pas encore propre
    // Lire données bridge TF en temps réel pour afficher contexte précis
    var _wCtx = (typeof _buildTfCtx === 'function') ? _buildTfCtx() : null;
    var _wReason = (exec && exec.reason)
      ? exec.reason.split('—')[0].trim()
      : 'Surveillance active — attendre le bon moment';
    var _wTfLine = _wCtx ? _wCtx.tfLine : '';
    var _wSetup  = _wCtx && _wCtx.setupTF ? 'Setup ciblé: ' + _wCtx.setupTF : '';
    // Comparaison prix actuel vs zone cible
    var _wCurPrice = state.price > 0 ? state.price : 0;
    var _wTargetEntry = _wCtx && _wCtx.entry > 0 ? _wCtx.entry : 0;
    var _wLevels = '';
    if (_wTargetEntry > 0) {
      var _wFmtFn = _wCtx.fmt;
      var _wDist  = _wCurPrice > 0 ? Math.abs(_wCurPrice - _wTargetEntry) : 0;
      var _wDistFmt = _wDist > 100 ? _wDist.toFixed(2) : _wDist > 0 ? _wDist.toFixed(1) : '?';
      // Lignes séparées pour lisibilité — prix actuel / zone cible / SL / TP / RR
      var _wRr = (_wCtx.sl > 0 && _wCtx.tp > 0)
        ? (Math.abs(_wCtx.tp - _wTargetEntry) / Math.abs(_wTargetEntry - _wCtx.sl)).toFixed(1)
        : null;
      _wLevels = (_wCurPrice > 0 ? 'Prix: ' + _wFmtFn(_wCurPrice) + '   →   Zone: ' + _wFmtFn(_wTargetEntry) + ' (' + _wDistFmt + 'pt)' : 'Zone: ' + _wFmtFn(_wTargetEntry))
        + (_wCtx.sl > 0 ? '\nSL: ' + _wFmtFn(_wCtx.sl) + (_wCtx.tp > 0 ? '   TP: ' + _wFmtFn(_wCtx.tp) : '') + (_wRr ? '   RR: 1:' + _wRr : '') : '');
    }
    // Blocage serveur — afficher la raison précise si disponible
    var _wSrvExec = (state.live && state.live.execution) || (state.live && state.live.coach && state.live.coach.execution) || {};
    var _wSrvBlock = (!_wSrvExec.canEnter && _wSrvExec.reason)
      ? '⛔ ' + _wSrvExec.reason.split('|')[0].trim().substring(0, 90)
      : '';
    // Données bridge brutes pour contexte zone
    var _wBd = state._lastBridgeData;
    var _wZoneTxt = '';
    if (_wBd) {
      var _wInBot  = _wBd.inBot === true  || _wBd.zoneLiqBasse === true;
      var _wInTop  = _wBd.inTop === true  || _wBd.zoneLiqHaute === true;
      _wZoneTxt = _wInBot
        ? 'Je surveille la zone de retournement LONG — setup acheteur en formation'
        : _wInTop
          ? 'Je surveille la zone de retournement SHORT — setup vendeur en formation'
          : 'Hors zone — j\'attends que le prix arrive en zone';
    }
    // Direction + setup type en titre
    var _wDirArrow = isLong ? '▲ LONG' : isShort ? '▼ SHORT' : '⏳';
    var _wSetupType = state._lastSetupTypeLabel || _wSetup || '';
    var _wDirLine = _wDirArrow + (_wSetupType ? ' | ' + _wSetupType : '') + ' — je surveille l\'entrée';
    var _wParts = [_wDirLine];
    if (_wZoneTxt) _wParts.push(_wZoneTxt);
    if (_wLevels)  _wParts.push(_wLevels);
    if (_wSrvBlock) _wParts.push(_wSrvBlock);
    // Recheck countdown — montre quand le prochain scan multi-TF a lieu
    var _wRecheck = state._wdRecheckTimes;
    if (_wRecheck) {
      _wParts.push('↺ Prochain scan → M5:' + _wRecheck.m5 + 'min  M15:' + _wRecheck.m15 + 'min');
    }
    text   = _wParts.join('\n');
    bg = _dirBg; border = _dirBorder; color = _dirColor;
  }

  el.style.display      = 'block';
  el.style.background   = bg;
  el.style.borderColor  = border;
  el.style.color        = color;
  el.style.whiteSpace   = 'pre-line';

  // ── JAUGE VISUELLE — uniquement pour approaching et imminent ────────────────
  // Couleur par palier : rouge(0-30) → orange(30-60) → jaune(60-80) → vert(80+)
  // Direction intégrée — animation CSS transition pour rendu fluide
  var _gaugeHtml = '';
  if (mode === 'approaching' || mode === 'imminent') {
    var _gPct      = Math.min(100, Math.max(0, conf));
    var _gColor    = _gPct < 30 ? '#ef4444' : _gPct < 60 ? '#f97316' : _gPct < 80 ? '#eab308' : '#22c55e';
    var _gDirColor = isLong ? '#22c55e' : isShort ? '#ef4444' : '#94a3b8';
    // Phrase de préparation selon % — rend le sens du % immédiatement lisible
    var _gReadiness = _gPct >= 99 ? 'validation finale'
      : _gPct >= 80 ? 'prêt à entrer'
      : _gPct >= 60 ? 'zone proche'
      : _gPct >= 30 ? 'en approche'
      : 'en attente';
    // Label complet : "▼ SETUP SHORT — 88% prêt à entrer"
    // Élimine l'ambiguïté : le % = maturité du SETUP, pas état du marché
    var _gSetupDir = isLong ? '▲ SETUP LONG' : isShort ? '▼ SETUP SHORT' : 'SETUP';
    var _gLabel    = _gSetupDir + ' — ' + Math.round(_gPct) + '% ' + _gReadiness;
    _gaugeHtml
      = '<div style="margin-top:6px;background:rgba(255,255,255,0.08);border-radius:3px;height:5px;overflow:hidden">'
      +   '<div style="width:' + _gPct + '%;height:100%;background:' + _gColor + ';border-radius:3px;transition:width 0.6s ease"></div>'
      + '</div>'
      + '<div style="margin-top:3px;font-size:10px;font-weight:700;color:' + _gDirColor + ';opacity:0.95">'
      +   _gLabel
      + '</div>';
  }

  // ── JAUGE RETOURNEMENT — countdown bougie M5 ─────────────────────────────
  // "Dans combien de temps dois-je attendre ?" — visible dès que le robot est armé.
  // Montre la progression de la bougie M5 courante + secondes avant prochaine clôture.
  // Vert = bougie fraîche (signal propre possible) / orange = milieu / vert = clôture imminente
  var _cgTfMs      = 5 * 60 * 1000; // M5 = TF d'entrée minimum
  var _cgElapsed   = Date.now() % _cgTfMs;
  var _cgRatio     = _cgElapsed / _cgTfMs;
  var _cgSecsLeft  = Math.ceil((_cgTfMs - _cgElapsed) / 1000);
  var _cgMinLeft   = Math.floor(_cgSecsLeft / 60);
  var _cgSecLeft   = _cgSecsLeft % 60;
  var _cgTimeStr   = _cgMinLeft > 0 ? _cgMinLeft + 'min ' + _cgSecLeft + 's' : _cgSecLeft + 's';
  var _cgFresh     = _cgRatio < 0.20;  // premiers 20% = bougie fraîche
  var _cgClose     = _cgRatio > 0.88;  // derniers 12% = clôture imminente
  var _cgBarColor  = (_cgFresh || _cgClose) ? '#22c55e' : '#f97316';
  var _cgLblText   = _cgFresh
    ? '🕐 Bougie M5 fraîche — clôture dans ' + _cgTimeStr
    : _cgClose
      ? '⏱ Clôture M5 dans ' + _cgTimeStr + ' — prêt à agir'
      : '⌛ Prochain signal M5 dans ~' + _cgTimeStr;
  var _candleGaugeHtml
    = '<div style="margin-top:6px;background:rgba(255,255,255,0.07);border-radius:3px;height:3px;overflow:hidden">'
    +   '<div style="width:' + Math.round(_cgRatio * 100) + '%;height:100%;background:' + _cgBarColor + ';border-radius:3px;transition:width 1s linear"></div>'
    + '</div>'
    + '<div style="margin-top:2px;font-size:9px;font-weight:600;color:' + _cgBarColor + ';opacity:0.9;letter-spacing:.03em">'
    +   _cgLblText
    + '</div>';

  // ── GUARD DOM — 2 niveaux pour stopper le flicker causé par les prix live ──
  // Niveau 1: clé STRUCTURELLE (mode / couleur / jauge / candle) → contrôle le innerHTML global
  //   Ne pas inclure `text` ici: text contient prix live qui changent à 800ms → flicker garanti
  // Niveau 2: clé TEXTE → mise à jour ciblée du span ._abd sans toucher la structure
  var _cgPctKey  = Math.round(_cgRatio * 20) * 5;   // 5% incrément
  var _cgSecKey  = Math.ceil(_cgSecsLeft / 5) * 5;  // 5s incrément
  var _confKey   = Math.round(conf / 5) * 5;         // 5pt incrément
  var _structKey = mode + '|' + _dirBorder + '|' + _confKey + '|' + _cgPctKey + '|' + _cgSecKey;
  // Toujours mettre à jour les styles via propriétés CSS (pas de repaint si valeur identique)
  el.style.display      = 'block';
  el.style.background   = bg;
  el.style.borderColor  = border;
  el.style.color        = color;
  el.style.whiteSpace   = 'pre-line';
  var _safeText = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  if (el._bannerKey === _structKey) {
    // Structure identique → mettre à jour uniquement le texte (span ._abd) sans reflow global
    var _abdEl = el.querySelector('._abd');
    if (_abdEl && _abdEl.innerHTML !== _safeText) _abdEl.innerHTML = _safeText;
    return;
  }
  el._bannerKey = _structKey;
  // Structure changée → reconstruire le innerHTML complet avec span texte dédié
  if (_gaugeHtml || _candleGaugeHtml) {
    el.innerHTML = '<span class="_abd">' + _safeText + '</span>' + _gaugeHtml + _candleGaugeHtml;
  } else {
    el.innerHTML = '<span class="_abd">' + _safeText + '</span>';
  }
}

// ─── FUTURE ENTRY BANNER ──────────────────────────────────────────────────────
// Visible AVANT que l'utilisateur arme le robot — donne le scénario en temps réel.
// Quand le robot est armé, ce banner est masqué (armedBanner prend le relais).
// Scénarios: entrée à venir / setup en approche / entrée imminente / entrée manquée / retour possible
function renderFutureEntryBanner(exec, sig, isEntered, rec) {
  var el = document.getElementById('futureEntryBanner');
  if (!el) return;

  // Masquer si position active
  if (isEntered) {
    el.style.display = 'none';
    var _pelHide = document.getElementById('preEntryLevels');
    if (_pelHide) _pelHide.style.display = 'none';
    return;
  }

  // Quand robot armé — afficher résumé direction + setup (armedBanner gère le détail en dessous)
  if (state.armed) {
    var _armIsLong  = isLong;
    var _armIsShort = isShort;
    if (!_armIsLong && !_armIsShort) {
      var _armLastRec = String(
        (state.live && state.live.analysis && state.live.analysis.recommendation) ||
        (state.live && state.live.recommendation) || ''
      ).toUpperCase();
      _armIsLong  = _armLastRec.includes('BUY') || _armLastRec.includes('LONG');
      _armIsShort = _armLastRec.includes('SELL') || _armLastRec.includes('SHORT');
    }
    var _armSetupLabel = state._lastSetupTypeLabel || '';
    var _armTf = String((exec && exec.bestTf) || state._lastSetupTF || '');
    if (_armIsLong || _armIsShort) {
      var _armDir    = _armIsLong ? 'LONG' : 'SHORT';
      var _armArrow  = _armIsLong ? '▲' : '▼';
      var _armCol    = _armIsLong ? '#22c55e' : '#ef4444';
      var _armBg     = _armIsLong ? 'rgba(34,197,94,0.09)' : 'rgba(239,68,68,0.09)';
      el.style.display     = 'block';
      el.style.background  = _armBg;
      el.style.borderColor = _armCol;
      el.style.color       = _armCol;
      el.style.whiteSpace  = 'pre-line';
      el.textContent = _armArrow + ' ROBOT ARMÉ — ' + _armDir
        + (_armSetupLabel ? ' | ' + _armSetupLabel : '')
        + (_armTf ? ' | ' + _armTf : '')
        + '\n⏳ En surveillance — entrée automatique dès que les conditions sont réunies';
    } else {
      el.style.display     = 'block';
      el.style.background  = 'rgba(59,130,246,0.08)';
      el.style.borderColor = '#3b82f6';
      el.style.color       = '#60a5fa';
      el.style.whiteSpace  = 'pre-line';
      el.textContent       = '🤖 ROBOT ARMÉ — En surveillance\n⏳ J\'attends les conditions optimales pour entrer';
    }
    return;
  }

  // ── GUARD CONFLIT : si Pine et indicateurs divergent, aucun affichage directionnel ───
  // Source unique: sourceSummary serveur (même source que renderDecision)
  var _febSnap = (state.live && state.live.coach && state.live.coach.analysisSnapshot && state.live.coach.analysisSnapshot.sourceSummary)
              || (state.live && state.live.analysisSnapshot && state.live.analysisSnapshot.sourceSummary) || {};
  var _febConflict = !!_febSnap.conflictDetected;
  if (_febConflict) {
    // Conflit détecté → banner neutre CONFLIT, pas de direction, pas de niveaux
    el.style.display    = 'block';
    el.style.background = 'rgba(249,115,22,0.10)';
    el.style.borderColor = '#f97316';
    el.style.color      = '#f97316';
    el.style.whiteSpace = 'pre-line';
    el.textContent      = '⚠️ CONFLIT SIGNAL — Pine:' + (String(_febSnap.tvDirection || '?')) + ' / Indicateurs:' + (String(_febSnap.runtimeDirection || 'NEUTRE')) + '\nAttendre la résolution avant tout armement';
    var _pelConflict = document.getElementById('preEntryLevels');
    if (_pelConflict) _pelConflict.style.display = 'none';
    return;
  }

  var canEnter    = exec && exec.canEnter === true;
  var conf        = Number((sig && sig.confidence) || 0);
  var verdict     = String((sig && sig.verdict) || (sig && sig.signalState) || rec || '').toUpperCase();
  var _recStr     = String(rec || '').toUpperCase();
  // Règle: si sig.verdict="WAIT" mais recommendation="SELL/BUY", utiliser rec pour isDirectional
  var isLong      = verdict.includes('BUY') || verdict.includes('LONG') || _recStr.includes('BUY') || _recStr.includes('LONG');
  var isShort     = verdict.includes('SELL') || verdict.includes('SHORT') || _recStr.includes('SELL') || _recStr.includes('SHORT');
  // Fallback RSI bridge: si pas de direction depuis serveur, utiliser bridge RSI M15+H1
  if (!isLong && !isShort && state._lastBridgeData) {
    var _febBd = state._lastBridgeData;
    var _febRsi3 = Number(_febBd.rsiTf3 || 0); // M15
    var _febRsi4 = Number(_febBd.rsiTf4 || 0); // H1
    var _febLt3  = String(_febBd.lectureTech3 || '').toUpperCase();
    var _febLt4  = String(_febBd.lectureTech4 || '').toUpperCase();
    var _febRsiDir = (_febRsi3 > 55 && _febRsi4 > 55) ? 'LONG'
                   : (_febRsi3 < 45 && _febRsi4 < 45) ? 'SHORT' : null;
    var _febLecDir = (_febLt3.includes('ACHAT') && _febLt4.includes('ACHAT')) ? 'LONG'
                   : (_febLt3.includes('VENTE') && _febLt4.includes('VENTE')) ? 'SHORT' : null;
    var _febFallback = _febLecDir || _febRsiDir;
    if (_febFallback === 'LONG')  { isLong  = true; conf = conf || 55; }
    if (_febFallback === 'SHORT') { isShort = true; conf = conf || 55; }
  }
  var isDirectional = isLong || isShort;
  // ── trade_status : qualificatif serveur du setup (LIVE / CONDITIONAL / WAIT)
  // SOURCE CORRECTE : exec.trade_status (snapshot serveur) — instantTrade n'a pas ce champ
  var _tradeStatus = String(
    (exec && exec.trade_status) ||
    (state.live && state.live.coach && state.live.coach.execution && state.live.coach.execution.trade_status) ||
    (state.live && state.live.execution && state.live.execution.trade_status) ||
    'WAIT'
  ).toUpperCase();

  // ── VALIDATION NIVEAUX : détecter les setups sans niveaux Pine réels ─────────
  // Aussi lire exec.entry/sl/tp (snapshot serveur) — plus fiable que instantTrade seul
  var _itLive      = (state.live && state.live.instantTrade) || {};
  var _execLive    = (state.live && state.live.coach && state.live.coach.execution) || (state.live && state.live.execution) || {};
  var _itSource    = String(_itLive.source || '').toLowerCase();
  // Prix de référence : state.price (SSE temps réel) prioritaire sur exec.entry (snapshot stale)
  // exec.entry = prix quand le signal a été calculé (peut être stale de plusieurs secondes)
  // state.price = prix SSE (<400ms) — toujours utiliser pour les calculs de distance SL/TP
  var _refPrice    = state.price > 0 ? state.price : Number(_execLive.entry || _itLive.entry || 0);
  var _entryV      = _refPrice; // base pour calcul distance — toujours prix réel
  var _slV         = Number(_execLive.sl     || _itLive.sl    || 0);
  var _tpV         = Number(_execLive.tp     || _itLive.tp    || 0);
  var _minDist     = _entryV * 0.0002; // seuil: 0.02% du prix (ex: 0.95pt sur XAUUSD à 4770)
  var _slTooClose  = _slV > 0 && Math.abs(_entryV - _slV) < _minDist;
  var _tpTooClose  = _tpV > 0 && Math.abs(_tpV   - _entryV) < _minDist;
  // Niveaux absents = SL ET TP nulls (Pine n'a pas transmis de setup complet)
  var _bothMissing = !_slV && !_tpV;
  var _missingLvls = canEnter && (!_slV || !_tpV); // canEnter=true mais niveaux incomplets
  var _noTvFlux    = _itSource === 'price-action-ticks'; // source de secours, pas TV réel
  var _setupUnreliable = _noTvFlux || _slTooClose || _tpTooClose || _missingLvls || _bothMissing;

  // ── Label qualité signal : TFs alignés (M15 / H1 / H4) ─────────────────
  // Basé sur les RSI multi-TF fournis par le bridge TV dans coach.signal.stats
  // Permet d'afficher "MULTI-TF — M15+H1" vs "M15 SEUL" vs "PREMIUM — M15+H1+H4"
  var _stats   = (state.live && state.live.coach && state.live.coach.signal && state.live.coach.signal.stats) || {};
  var _rsiM15  = Number(_stats.rsi_m15 || 0);
  var _rsiH1   = Number(_stats.rsi_h1  || 0);
  var _rsiH4   = Number(_stats.rsi_h4  || 0);
  var _aTFs    = [];
  if (_rsiM15 > 0) { var _m15Up = _rsiM15 > 50; if ((isLong && _m15Up) || (isShort && !_m15Up)) _aTFs.push('M15'); }
  if (_rsiH1  > 0) { var _h1Up  = _rsiH1  > 50; if ((isLong && _h1Up)  || (isShort && !_h1Up))  _aTFs.push('H1');  }
  if (_rsiH4  > 0) { var _h4Up  = _rsiH4  > 50; if ((isLong && _h4Up)  || (isShort && !_h4Up))  _aTFs.push('H4');  }
  var _qualLabel = _aTFs.length >= 3 ? 'PREMIUM — ' + _aTFs.join('+')
                 : _aTFs.length === 2 ? 'MULTI-TF — ' + _aTFs.join('+')
                 : _aTFs.length === 1 ? _aTFs[0] + ' SEUL'
                 : '';

  // ── Confiance enrichie multi-TF ────────────────────────────────────────
  // Base: conf mono M15 serveur. Bonus si TF supérieurs réellement alignés.
  // Lecture H1 textuelle (lecture_h1 = ACHAT/VENTE) compte en plus du RSI H1.
  // Plafond 95% — garde toujours une marge d'incertitude
  var _lecH1Str  = String(_stats.lecture_h1 || '').toUpperCase();
  var _h1Aligned = _rsiH1 > 0 && ((isLong && _rsiH1 > 50) || (isShort && _rsiH1 < 50));
  var _h4Aligned = _rsiH4 > 0 && ((isLong && _rsiH4 > 50) || (isShort && _rsiH4 < 50));
  var _lecH1Conf = (_lecH1Str.includes('ACHAT') && isLong) || (_lecH1Str.includes('VENTE') && isShort);
  var _confBonus = 0;
  if (_h1Aligned)   _confBonus += 8;  // RSI H1 dans le bon sens → +8%
  if (_lecH1Conf)   _confBonus += 4;  // Lecture H1 confirme textuellement → +4%
  if (_h4Aligned)   _confBonus += 7;  // RSI H4 aligné (rare, si disponible) → +7%
  var _confDisplay = Math.min(95, Math.round(conf + _confBonus));

  // ── Tracking "entrée manquée" ─────────────────────────────────────────────
  // Quand canEnter était true puis redescend → mémoriser pendant 5 min
  if (!state._entryScenario) state._entryScenario = { wasImminent: false, wasImminentAt: 0, sym: state.symbol };
  // Reset si changement de symbole
  if (state._entryScenario.sym !== state.symbol) {
    state._entryScenario = { wasImminent: false, wasImminentAt: 0, sym: state.symbol };
  }
  var sc = state._entryScenario;
  if (canEnter && isDirectional) {
    sc.wasImminent = true;
    sc.wasImminentAt = Date.now();
  }
  // Fenêtre de 5 minutes après que canEnter était true
  var elapsedSinceImminent = sc.wasImminent ? (Date.now() - sc.wasImminentAt) : Infinity;
  var inMissedWindow = sc.wasImminent && !canEnter && elapsedSinceImminent < 300000;

  var text, bg, border, color;

  if (!isDirectional && !inMissedWindow) {
    // Pas de signal directionnel en cours — masquer
    el.style.display = 'none';
    var _pelNo = document.getElementById('preEntryLevels');
    if (_pelNo) _pelNo.style.display = 'none';
    return;
  }

  if (_setupUnreliable) {
    // Pine n'a pas transmis de niveaux SL/TP valides — signal directionnel sans zone exploitable
    var _dirU = isLong ? '▲ LONG' : isShort ? '▼ SHORT' : '';
    var _reasonU = _noTvFlux
      ? 'Flux TV non actif pour ce symbole — attendre données Pine'
      : (_slTooClose || _tpTooClose)
        ? 'SL/TP trop proches du prix — niveaux non exploitables'
        : _bothMissing
          ? 'Signal Pine: direction ' + (isLong ? 'LONG' : isShort ? 'SHORT' : '--') + ' — SL/TP non encore transmis par le bridge'
          : 'SL ou TP manquant — setup incomplet';
    text   = '⏳ EN ATTENTE NIVEAUX' + (_dirU ? ' — ' + _dirU : '') + '\n' + _reasonU;
    bg     = 'rgba(100,116,139,0.12)';
    border = '#475569';
    color  = '#94a3b8';

  } else if (canEnter) {
    var _confLive = _confDisplay > 0 ? ' (' + _confDisplay + '%)' : '';
    text   = isShort
      ? '▼ ça va descendre — appuie sur ENTRER pour que j\'entre' + _confLive
      : '▲ ça va monter — appuie sur ENTRER pour que j\'entre' + _confLive;
    bg     = isShort ? 'rgba(239,68,68,0.20)' : 'rgba(34,197,94,0.20)';
    border = isShort ? '#ef4444' : '#22c55e';
    color  = isShort ? '#fca5a5' : '#86efac';

  } else if (inMissedWindow && conf < 45) {
    // ENTRÉE MANQUÉE — signal passé, zone dépassée
    text   = '❌ ENTRÉE MANQUÉE — setup non exécutable\nAttendre le prochain setup propre';
    bg     = 'rgba(100,116,139,0.18)';
    border = '#64748b';
    color  = '#cbd5e1';

  } else if (inMissedWindow && conf >= 45) {
    // RETOUR POSSIBLE — signal faiblit mais zone encore exploitable
    var _dirRet = isLong ? '▲ LONG' : isShort ? '▼ SHORT' : '';
    text   = '↩ RETOUR POSSIBLE' + (_dirRet ? ' — ' + _dirRet : '') + ' (' + Math.round(conf) + '%)\nSurveiller un retour en zone — non exécutable immédiatement';
    bg     = 'rgba(234,179,8,0.15)';
    border = '#d97706';
    color  = '#fde047';

  } else if (_tradeStatus === 'WAIT') {
    text   = isShort
      ? '▼ SHORT — j\'attends que le prix arrive en zone (' + _confDisplay + '%)'
      : '▲ LONG — j\'attends que le prix arrive en zone (' + _confDisplay + '%)';
    bg     = 'rgba(100,116,139,0.15)';
    border = '#475569';
    color  = '#94a3b8';

  } else if (_tradeStatus === 'CONDITIONAL') {
    text   = isShort
      ? '▼ ça va descendre — j\'attends le retour en zone (' + _confDisplay + '%)'
      : '▲ ça va monter — j\'attends le retour en zone (' + _confDisplay + '%)';
    bg     = 'rgba(234,179,8,0.12)';
    border = '#d97706';
    color  = '#fde047';

  } else {
    text   = isShort
      ? '▼ retournement baissier en cours (' + _confDisplay + '%) — je valide les dernières conditions'
      : isLong
        ? '▲ retournement haussier en cours (' + _confDisplay + '%) — je valide les dernières conditions'
        : '⏳ signal en cours de formation (' + _confDisplay + '%)';
    bg     = 'rgba(59,130,246,0.16)';
    border = '#3b82f6';
    color  = '#bfdbfe';
  }

  el.style.display    = 'block';
  el.style.background = bg;
  el.style.borderColor = border;
  el.style.color      = color;
  el.style.whiteSpace = 'pre-line';
  el.textContent      = text;

  // ── Niveaux pré-entrée (entry/SL/TP estimés avant déclenchement) ─────────────
  var pelEl = document.getElementById('preEntryLevels');
  if (pelEl) {
    // Source des niveaux: execution snapshot (serveur, priorité) > instantTrade > virtualPosition
    var _live = state.live || {};
    var _it   = _live.instantTrade || null;
    var _vp   = _live.virtualPosition || null;
    var _ex   = _execLive; // déjà lu plus haut — contient entry/sl/tp depuis snapshot serveur
    // Choisir la source avec les niveaux les plus complets (SL ET TP doivent être > 0)
    var _src  = (_ex  && Number(_ex.entry)  > 0 && Number(_ex.sl)  > 0 && Number(_ex.tp)  > 0) ? _ex
               : (_it  && Number(_it.entry)  > 0 && Number(_it.sl)  > 0 && Number(_it.tp)  > 0) ? _it
               : (_vp  && Number(_vp.entry)  > 0 && Number(_vp.sl)  > 0 && Number(_vp.tp)  > 0) ? _vp
               : null;
    // WAIT ou données insuffisantes → niveaux masqués
    if ((_tradeStatus === 'WAIT' && !canEnter && !inMissedWindow) || _setupUnreliable) {
      pelEl.style.display = 'none';
    } else if (isDirectional) {
      var _fmtPel = function(v) { return v > 100 ? Number(v).toFixed(2) : Number(v).toFixed(5); };
      pelEl.style.display     = 'block';
      pelEl.style.background  = bg;
      pelEl.style.borderColor = border;
      pelEl.style.color       = '#f1f5f9';
      pelEl.style.opacity     = _tradeStatus === 'CONDITIONAL' ? '0.80' : '1';
      var _pelDir = isLong ? '▲ LONG' : '▼ SHORT';
      // Préfixe explicite selon le statut réel
      var _pelPrefix = _tradeStatus === 'CONDITIONAL'
        ? '[CONDITIONNEL] '
        : (canEnter ? '[LIVE] ' : '');
      if (_src && (Number(_src.entry) > 0 || state.price > 0)) {
        // Prix d'entrée affiché = state.price (SSE temps réel) — jamais _src.entry qui peut être stale
        // _src.entry = prix au moment du signal (peut différer de plusieurs secondes/points)
        // state.price = prix SSE live (<400ms) — toujours cohérent avec ce que l'utilisateur voit sur TV
        var _entryPel = state.price > 0 ? state.price : Number(_src.entry);
        var _slPel    = _src ? (Number(_src.sl)  || 0) : 0;
        var _tpPel    = _src ? (Number(_src.tp)  || 0) : 0;
        var _hasSl = _slPel > 0;
        var _hasTp = _tpPel > 0;
        var _rr = (_hasSl && _hasTp && Math.abs(_tpPel - _entryPel) > 0 && Math.abs(_slPel - _entryPel) > 0)
                  ? (Math.abs(_tpPel - _entryPel) / Math.abs(_slPel - _entryPel)).toFixed(1)
                  : null;
        var _lineDir = _pelPrefix + _pelDir;
        var _lineEntry = 'Entrée   ' + _fmtPel(_entryPel);
        var _lineSl  = _hasSl ? 'SL         ' + _fmtPel(_slPel) : '';
        var _lineTp  = _hasTp ? 'TP         ' + _fmtPel(_tpPel) + (_rr ? '   (R:R ' + _rr + ')' : '') : '';
        pelEl.textContent = [_lineDir, _lineEntry, _lineSl, _lineTp].filter(Boolean).join('\n');
      } else {
        pelEl.textContent = _pelPrefix + _pelDir + '  — niveaux en cours de calcul';
      }
    } else {
      pelEl.style.display = 'none';
    }
  }
}

// ─── TF BASIS DISPLAY ─────────────────────────────────────────────────────────
// Affiche clairement: TF d'entrée / contexte / TP + alignement RSI par TF
// Règle de sécurité: conflit TF d'entrée ≠ TF contexte → canEnter déjà=false côté serveur,
// on affiche le conflit visuellement.
function renderTfBasis(live) {
  var el = document.getElementById('tfBasisRow');
  if (!el) return;

  var sig  = (live && live.coach && live.coach.signal) || (live && live.signal) || {};
  var exec = (live && live.coach && live.coach.execution) || (live && live.execution) || {};
  var agents = (live && live.coach && live.coach.agents) || (live && live.agents) || {};
  // Source serveur déterministe pour la direction
  // Priorité: agents.analysis.recommendation (déterministe) > sig.verdict (Pine brut) > vide
  // NE PAS utiliser sig.verdict="WAIT" comme direction — c'est un état Pine, pas une direction
  var _tfRec = String(
    (agents.analysis && agents.analysis.recommendation) ||
    (live && live.analysis && live.analysis.recommendation) || ''
  ).toUpperCase();
  var rec = (_tfRec && _tfRec !== 'WAIT') ? _tfRec : '';
  var stats = sig.stats || {};

  var isLong  = rec.includes('BUY') || rec.includes('LONG');
  var isShort = rec.includes('SELL') || rec.includes('SHORT');
  if (!isLong && !isShort) { el.style.display = 'none'; return; }

  // ── TF roles: entrée = TF sélectionné, contexte = TF supérieur, TP = contexte ──
  var tf = String(state.timeframe || 'M5').toUpperCase();
  var CTX = { 'M1':'M5','M5':'M15','M15':'H1','M30':'H1','H1':'H4','H4':'D1','D1':'W1' };
  var entryTf   = tf;
  var contextTf = CTX[tf] || tf;
  var tpTf      = contextTf; // TP calculé sur le TF de contexte

  // ── RSI per TF ───────────────────────────────────────────────────────────────
  var RSI_KEY = { 'M1':'rsi_m1','M5':'rsi_m5','M15':'rsi_m15','M30':'rsi_m15',
                  'H1':'rsi_h1','H4':'rsi_h4','D1':'rsi_d1' };
  var rsiEntry   = Number(stats[RSI_KEY[entryTf]]   || 0);
  var rsiContext = Number(stats[RSI_KEY[contextTf]] || 0);

  // ── Alignement RSI (seuils avec hysteresis ±3 pour éviter le flip) ──────────
  // RÈGLE: seul le TF de CONTEXTE peut signaler un conflit TF.
  // Seuils avec zone tampon ±3 pts → évite le flicker autour des valeurs limites
  function alignEntry(rsi) {
    if (!rsi || rsi < 1) return { sym: '?', col: '#475569' };
    if (isLong)  return rsi > 58 ? { sym: '✓', col: '#22c55e' } : rsi < 42 ? { sym: '~', col: '#94a3b8' } : { sym: '~', col: '#f97316' };
    return           rsi < 42 ? { sym: '✓', col: '#22c55e' } : rsi > 58 ? { sym: '~', col: '#94a3b8' } : { sym: '~', col: '#f97316' };
  }
  function alignContext(rsi) {
    if (!rsi || rsi < 1) return { sym: '?', col: '#475569' };
    if (isLong)  return rsi > 58 ? { sym: '✓', col: '#22c55e' }
                      : rsi < 30 ? { sym: '✗', col: '#ef4444' }
                      :            { sym: '~', col: '#f97316' };
    return       rsi < 42 ? { sym: '✓', col: '#22c55e' }
               : rsi > 70 ? { sym: '✗', col: '#ef4444' }
               :             { sym: '~', col: '#f97316' };
  }
  var aE = alignEntry(rsiEntry);
  var aC = alignContext(rsiContext);

  // ── Conflict: contexte contre le signal = TF mismatch ───────────────────────
  var tfConflict = aC.sym === '✗';

  // ── Build HTML ───────────────────────────────────────────────────────────────
  // RSI arrondi à 2pts pour réduire le changement visuel tick à tick
  var rsiEStr = rsiEntry   > 0 ? ' R' + (Math.round(rsiEntry   / 2) * 2) : '';
  var rsiCStr = rsiContext > 0 ? ' R' + (Math.round(rsiContext / 2) * 2) : '';

  // ── CACHE — ne re-rendre que si les signaux stables changent ─────────────────
  var _tfBasisKey = (isLong ? 'L' : 'S') + '|' + aE.sym + '|' + aC.sym + '|'
    + tfConflict + '|' + (exec.canEnter ? '1' : '0') + '|' + rsiEStr + rsiCStr;
  if (state._tfBasisLastKey === _tfBasisKey) { el.style.display = 'block'; return; }
  state._tfBasisLastKey = _tfBasisKey;

  var sep = '<span style="color:#1e293b;margin:0 5px">│</span>';
  var html = '';
  // Entrée
  html += '<span style="color:#475569">Entrée:</span>'
        + '<span style="color:#94a3b8;font-weight:700;margin:0 3px">' + entryTf + '</span>'
        + '<span style="color:' + aE.col + '">' + aE.sym + rsiEStr + '</span>';
  html += sep;
  // Contexte
  html += '<span style="color:#475569">Contexte:</span>'
        + '<span style="color:#94a3b8;font-weight:700;margin:0 3px">' + contextTf + '</span>'
        + '<span style="color:' + aC.col + '">' + aC.sym + rsiCStr + '</span>';
  if (tfConflict) html += '<span style="color:#ef4444;margin-left:4px;font-weight:700">⚠ conflit</span>';
  html += sep;
  // TP
  html += '<span style="color:#475569">TP:</span>'
        + '<span style="color:#94a3b8;font-weight:700;margin:0 3px">' + tpTf + '</span>';

  // Sécurité: si conflit TF → "pas d'entrée" déjà géré par canEnter=false
  // Afficher un indicateur global de statut
  var statusColor = tfConflict ? '#ef4444' : exec.canEnter ? '#22c55e' : '#f97316';
  var statusText  = tfConflict ? '✗ TF en conflit' : exec.canEnter ? '✓ alignés' : '⏳ en attente';
  html += '<span style="color:' + statusColor + ';margin-left:6px;font-weight:700">' + statusText + '</span>';

  // Couleur de la bordure gauche selon statut
  el.style.borderLeftColor = statusColor;
  el.style.display = 'block';
  el.innerHTML = html;
}

function renderBiasBanner(live, newsEvents) {
  var bias = computeMarketBias(live, newsEvents);
  var banner = document.getElementById('biasBanner');
  var label  = document.getElementById('biasLabel');
  var bar    = document.getElementById('biasBar');
  var pct    = document.getElementById('biasStrength');
  if (!banner) return;
  if (!bias.label || bias.label === '--' || !bias.strength || bias.strength === 0) {
    banner.style.display = 'none';
    return;
  }
  banner.style.display = 'flex';
  banner.style.borderLeft = '3px solid ' + bias.color;
  label.style.color = bias.color;
  label.textContent = bias.label;
  bar.style.width = bias.strength + '%';
  bar.style.background = bias.color;
  pct.textContent = bias.strength + '%';
  // ── JAUGES LONG/SHORT — mise à jour continue (refreshAll + tick SSE) ──
  // Priorité 1: bridge live (<15s) → Priorité 2: snapshots ANALYSER → Priorité 3: bias M15+H1
  var _bdGauge   = state._lastBridgeData;
  var _bdGaugeMs = state._lastBridgeDataAt ? (Date.now() - state._lastBridgeDataAt) : Infinity;
  var _imminent  = state.armedMode === 'imminent' || state.armedMode === 'entering';
  if (_bdGauge && _bdGaugeMs < 45000) {
    // Pine scores présents → RSI fallback supprimé dans la jauge (Pine fait autorité)
    var _gaugeHasPineScores = (Number(_bdGauge.long_score||0) > 20 || Number(_bdGauge.short_score||0) > 20);
    function _lecToRec(lec, rsi) {
      var l = String(lec || '').toUpperCase();
      if (l.includes('ACHAT')) return 'LONG';
      if (l.includes('VENTE')) return 'SELL';
      if (_gaugeHasPineScores) return 'WAIT'; // Pine scores présents → ne pas inférer depuis RSI
      var r = Number(rsi || 0);
      if (r >= 58) return 'LONG';
      if (r > 0 && r <= 42) return 'SELL';
      return 'WAIT';
    }
    function _isDir(lec, rsi) {
      var l = String(lec || '').toUpperCase();
      if (l && !l.includes('NEUTRE')) return true;
      if (_gaugeHasPineScores) return false; // Pine présent → seule lectureTech détermine
      var r = Number(rsi || 0);
      return r >= 58 || (r > 0 && r <= 42);
    }
    // Dériver la force depuis RSI quand scoreTech absent (Pine non actif)
    // Fort: RSI >70 ou <30 → 80 | Moyen: RSI >60 ou <40 → 60 | Faible/absent → 40
    function _rsiToStrength(score, rsi) {
      if (score && Number(score) > 0) return Number(score);
      var r = Number(rsi || 0);
      if (r > 70 || (r > 0 && r < 30)) return 80;
      if (r > 60 || (r > 0 && r < 40)) return 60;
      return 40;
    }
    var _bridgeSnaps = [
      { tf: 'M1',  rec: _lecToRec(_bdGauge.lectureTech1, _bdGauge.rsiTf1), strength: _rsiToStrength(_bdGauge.scoreTech1, _bdGauge.rsiTf1), directional: _isDir(_bdGauge.lectureTech1, _bdGauge.rsiTf1) },
      { tf: 'M5',  rec: _lecToRec(_bdGauge.lectureTech2, _bdGauge.rsiTf2), strength: _rsiToStrength(_bdGauge.scoreTech2, _bdGauge.rsiTf2), directional: _isDir(_bdGauge.lectureTech2, _bdGauge.rsiTf2) },
      { tf: 'M15', rec: _lecToRec(_bdGauge.lectureTech3, _bdGauge.rsiTf3), strength: _rsiToStrength(_bdGauge.scoreTech3, _bdGauge.rsiTf3), directional: _isDir(_bdGauge.lectureTech3, _bdGauge.rsiTf3) },
      { tf: 'H1',  rec: _lecToRec(_bdGauge.lectureTech4, _bdGauge.rsiTf4), strength: _rsiToStrength(_bdGauge.scoreTech4, _bdGauge.rsiTf4), directional: _isDir(_bdGauge.lectureTech4, _bdGauge.rsiTf4) }
    ];
    // long_score/short_score Pine → vote H1 de renforcement si différence significative
    var _bsLs = Number(_bdGauge.long_score || 0), _bsSs = Number(_bdGauge.short_score || 0);
    if ((_bsLs > 0 || _bsSs > 0) && Math.abs(_bsLs - _bsSs) >= 10) {
      _bridgeSnaps.push({ tf: 'H1', rec: _bsLs > _bsSs ? 'BUY' : 'SELL', strength: Math.min(100, Math.round(Math.max(_bsLs, _bsSs))), directional: true });
    }
    applyGaugePulse(computeGaugePulse(_bridgeSnaps), _imminent);
  } else if (state._lastSnapshots && state._lastSnapshots.length > 0) {
    applyGaugePulse(computeGaugePulse(state._lastSnapshots), _imminent);
  } else {
    // Fallback M15+H1 avant premier scan
    var _fbLong  = bias.label === 'HAUSSIER' ? 70 : bias.label === 'BAISSIER' ? 30 : 50;
    var _fbShort = 100 - _fbLong;
    applyGaugePulse({ label: bias.label + ' \u00b7 M15+H1', color: bias.label === 'CONFLIT' ? '#f97316' : bias.color, longPct: _fbLong, shortPct: _fbShort, stateLabel: '' }, false);
  }
}

// ─── MAIN REFRESH ────────────────────────────────────────────────────────────
async function refreshHealth() {
  try {
    flowLog('API REQUEST /health', { symbol: state.symbol, timeframe: state.timeframe });
    var h = await fetchJson('/health');
    flowLog('API RESPONSE /health', {
      ok: !!h.ok,
      bridgeStatus: h.bridgeStatus || null,
      activeContext: h.activeContext || null
    });
    renderBadges(h);
    markConnectionOk('ONLINE');
    return h;
  } catch (_) {
    state.conn.healthFails = Number(state.conn.healthFails || 0) + 1;
    flowLog('API ERROR /health', { symbol: state.symbol, timeframe: state.timeframe });
    renderBadges(null);
    markConnectionTransientFail();
    return null;
  }
}

async function loadRealtimePack() {
  var _requestStartedAt = Date.now(); // horodatage avant l'appel — pour détecter les ticks SSE reçus pendant l'attente
  var path = '/coach/realtime?symbol=' + encodeURIComponent(state.symbol) +
    '&tf=' + encodeURIComponent(state.timeframe) +
    '&mode=' + encodeURIComponent(state.tradeMode) + '&lang=fr';
  flowLog('API REQUEST /coach/realtime', {
    symbol: state.symbol,
    timeframe: state.timeframe,
    mode: state.tradeMode
  });
  var live = await fetchJson(path);
  flowLog('API RESPONSE /coach/realtime', {
    ok: !!live.ok,
    symbol: live.symbol || state.symbol,
    timeframe: live.timeframe || state.timeframe,
    hasCoach: !!live.coach,
    hasTradeState: !!live.tradeState,
    hasInstantTrade: !!live.instantTrade
  });
  state.live = live;
  if (Number.isFinite(Number(live.currentPrice)) && Number(live.currentPrice) > 0) {
    var _newLivePx = Number(live.currentPrice);
    // FIX DÉCALAGE: ne pas écraser un prix SSE plus récent reçu pendant l'appel API.
    // Si un tick SSE est arrivé PENDANT cet appel → state._lastPriceTick > _requestStartedAt
    // → le tick SSE est plus frais que la réponse API → garder le prix SSE, ignorer l'API.
    var _sseUpdatedDuringCall = state._lastPriceTick && state._lastPriceTick > _requestStartedAt;
    if (!_sseUpdatedDuringCall) {
      // Aucun tick SSE pendant l'appel → prix API est la meilleure donnée disponible
      if (_newLivePx !== state.price) state._lastPriceTick = Date.now();
      state.price = _newLivePx;
    }
    // Si SSE a mis à jour pendant l'appel → state.price est déjà plus récent, on ne touche pas
  }
  // SYNC TRADESTATE — resynchroniser depuis le serveur à chaque refresh:
  // Le serveur recalcule pnlPoints, progressToTp, bePlaced, phase en temps réel.
  // RÈGLE: entry/sl/tp/direction restent verrouillés localement (anti-dérive du graphique).
  if (live.tradeState && live.tradeState.entered) {
    var _prevVP = state.tradeState && state.tradeState.virtualPosition ? state.tradeState.virtualPosition : null;
    // GUARD: ne pas écraser si _executeAutoEntry vient de se terminer (<3s) — évite race condition API
    var _entryAge = state._entryJustFired ? (Date.now() - state._entryJustFired) : Infinity;
    if (_entryAge < 5000) { /* skip overwrite 5s — VP locale prime post-entrée */ }
    else state.tradeState = live.tradeState;
    // Restaurer les niveaux verrouillés si on les avait localement
    // RÈGLE: si le serveur retourne virtualPosition=null mais qu'on avait une position locale,
    // on réinjecte _prevVP pour éviter la disparition des SL/TP sur poll transitoire.
    if (_prevVP) {
      if (!state.tradeState.virtualPosition) state.tradeState.virtualPosition = {};
      if (Number(_prevVP.entry) > 0) state.tradeState.virtualPosition.entry = _prevVP.entry;
      if (Number(_prevVP.sl)    > 0) state.tradeState.virtualPosition.sl    = _prevVP.sl;
      if (Number(_prevVP.tp)    > 0) state.tradeState.virtualPosition.tp    = _prevVP.tp;
      if (_prevVP.direction)         state.tradeState.virtualPosition.direction = _prevVP.direction;
      if (_prevVP.symbol && !state.tradeState.virtualPosition.symbol) state.tradeState.virtualPosition.symbol = _prevVP.symbol;
    }
    scheduleSaveState();
  } else if (live.tradeState && !live.tradeState.entered && state.tradeState && state.tradeState.entered) {
    // GUARD: Ne pas effacer la position sur un poll API — le SSE (trade-action:EXIT / sl-hit / tp-hit / position-sync) fait autorité
    // CAUSE DU BUG: un changement de TF sur TradingView déclenche refreshAll() → /coach/realtime retourne
    //   entered:false transitoirement (délai de sync serveur sur le nouveau TF) → position effacée à tort
    // SOLUTION: ignorer entered:false venant de l'API. Les events SSE explicites corrigeront si besoin.
    // Exception: si position ouverte depuis plus de 10 minutes sans SSE (SSE mort), alors on sync.
    var _posAgeMs = state.tradeState.entryLockedAt ? (Date.now() - Number(state.tradeState.entryLockedAt)) : 0;
    var _sseFresh  = (Date.now() - (state._lastSseAt || 0)) < 15000; // SSE actif dans les 15s
    if (!_sseFresh && _posAgeMs > 600000) {
      // SSE mort depuis >15s ET position ouverte >10min → sync depuis API (filet de sécurité)
      state.tradeState = live.tradeState;
      scheduleSaveState();
    }
    // Sinon: ignorer — la prochaine position-sync SSE corrigera si la fermeture est réelle
  }
  if (live.mode) state.tradeMode = String(live.mode).toUpperCase();
  var payload = getCoachPayload(live);
  renderSignal(payload);
  renderDecision(payload);
  renderDiag(payload);
  renderCoach(payload);
  renderNews(payload);
  updateAgentStatus(payload);
  updateHeader();
  renderMarketSession(live);

  // Chart: only load if open
  if (state.chartOpen && typeof ChartModule !== 'undefined' && ChartModule && ChartModule.loadChart) {
    // SOURCE STRICTE: quand position entrée, UNIQUEMENT tradeState.virtualPosition (verrouillé à l'ENTER)
    // live.virtualPosition et instantTrade peuvent avoir entry = prix courant → ligne ENTRY dérive
    var _isEntered = state.tradeState && state.tradeState.entered;
    var _vpLocked = (_isEntered && state.tradeState.virtualPosition)
      ? state.tradeState.virtualPosition : null;
    // Hors position: utiliser live pour l'aperçu pre-entrée
    var vp = _vpLocked || (!_isEntered ? (live.virtualPosition || null) : null);
    var it = !_isEntered ? (live.instantTrade || null) : null;
    var levels = vp
      ? { entry: vp.entry, sl: vp.sl, tp: vp.tp }
      : (it ? { entry: it.entry, sl: it.sl, tp: it.tp } : null);
    if (levels) {
      flowLog('LEVELS DISPLAYED', {
        source: _vpLocked ? 'position-sync-locked' : ((live.levelTrace && live.levelTrace.source) || 'api'),
        displayed: { entry: levels.entry, sl: levels.sl, tp: levels.tp }
      });
    }
    ChartModule.loadChart(state.symbol, state.timeframe, levels, state.price);
  }
  checkEntryProximityAndBeep(live);
  renderBiasBanner(state.live, state.newsEvents);
  // renderPositionPanel depuis applyCoachData: throttlé 1.5s (tick SSE gère 1x/s)
  // Évite double-render quand tick SSE + coach stream arrivent quasi-simultanément
  if (!state.tradeState || !state.tradeState.entered || Date.now() - (state._lastPosRenderAt || 0) > 1500) {
    renderPositionPanel(state.live, state.price);
  }
  // Enrichir cartes TF depuis données bridge API (lecture_m1/m5/m15/h1 + rsi per TF)
  // Complémente la mise à jour SSE (temps réel) avec un refresh API toutes les 1.5s
  var _apiStats = live && live.coach && live.coach.signal && live.coach.signal.stats;
  if (_apiStats) {
    // Reconstruire un bridgeData depuis les stats API pour réutiliser renderTFCardsFromBridge
    var _apiBd = {
      lectureTech1: _apiStats.lecture_m1  || '', lectureTech2: _apiStats.lecture_m5  || '',
      lectureTech3: _apiStats.lecture_m15 || '', lectureTech4: _apiStats.lecture_h1  || '',
      rsiTf1: _apiStats.rsi_m1  || 0, rsiTf2: _apiStats.rsi_m5  || 0,
      rsiTf3: _apiStats.rsi_m15 || 0, rsiTf4: _apiStats.rsi_h1  || 0,
      rsiTf5: _apiStats.rsi_h4  || 0,
      scoreTech1: _apiStats.score_m1  || 0, scoreTech2: _apiStats.score_m5  || 0,
      scoreTech3: _apiStats.score_m15 || 0, scoreTech4: _apiStats.score_h1  || 0,
      inTop: _apiStats.inTop || false, inBot: _apiStats.inBot || false,
      liqHigh: _apiStats.liqHigh || 0, liqLow: _apiStats.liqLow || 0
    };
    // Utiliser si au moins une lecture ou RSI présent (données bridge réelles)
    var _hasAnyLec = _apiBd.lectureTech1 || _apiBd.lectureTech2 || _apiBd.lectureTech3 || _apiBd.lectureTech4;
    var _hasAnyRsi = (_apiBd.rsiTf1 > 0 || _apiBd.rsiTf2 > 0 || _apiBd.rsiTf3 > 0 || _apiBd.rsiTf4 > 0);
    if (_hasAnyLec || _hasAnyRsi) renderTFCardsFromBridge(_apiBd, state.price);
  }
  scheduleSaveState();
}

// ─── TV CHART (IFRAME EMBED) ──────────────────────────────────────────────────
var TV_SYMBOLS_EXT = {
  XAUUSD:'OANDA:XAUUSD', BTCUSD:'BITSTAMP:BTCUSD', BTCUSDT:'BINANCE:BTCUSDT',
  EURUSD:'FX:EURUSD', GBPUSD:'FX:GBPUSD', USDJPY:'FX:USDJPY', USDCHF:'FX:USDCHF',
  AUDUSD:'FX:AUDUSD', NZDUSD:'FX:NZDUSD', USDCAD:'FX:USDCAD',
  US30:'BLACKBULL:US30', NAS100:'NASDAQ:NDX', SP500:'SP:SPX',
  ETHUSD:'BITSTAMP:ETHUSD', ETHUSDT:'BINANCE:ETHUSDT'
};
var TV_TF_EXT = { M1:'1',M5:'5',M15:'15',M30:'30',H1:'60',H4:'240',D1:'D',W1:'W' };
var _tvChartSym = null, _tvChartTF = null;
var _extLevelCanvas = null;
var _extLevelData = { entry: null, sl: null, tp: null, direction: null, atr: null };

// Canvas overlay sur le graphique TV de l'extension — mêmes règles que le dashboard
function _getOrCreateExtLevelCanvas() {
  var container = document.getElementById('chart-container');
  if (!container) return null;
  if (_extLevelCanvas && container.contains(_extLevelCanvas)) return _extLevelCanvas;
  if (_extLevelCanvas) { try { _extLevelCanvas.remove(); } catch(_){} }
  var canvas = document.createElement('canvas');
  canvas.id = 'extLevelCanvas';
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:5;';
  container.style.position = 'relative';
  container.appendChild(canvas);
  _extLevelCanvas = canvas;
  return canvas;
}

function drawTradeLevelsExt(entry, sl, tp, direction, atr) {
  if (entry !== undefined) {
    _extLevelData = { entry: entry, sl: sl, tp: tp, direction: direction || 'LONG',
      atr: atr || (entry ? entry * 0.003 : null) };
  }
  // Quand LightweightCharts est actif (chartOpen=true), les lignes sont tracées précisément
  // via createPriceLine() → ne pas superposer le canvas (échelle différente = décalage)
  if (state.chartOpen) {
    // Effacer l'éventuel canvas résiduel et laisser LightweightCharts gérer
    var _old = document.getElementById('extLevelCanvas');
    if (_old) { try { _old.remove(); } catch(_){} _extLevelCanvas = null; }
    return;
  }
  var canvas = _getOrCreateExtLevelCanvas();
  if (!canvas) return;
  var container = document.getElementById('chart-container');
  var W = container ? container.offsetWidth  : 380;
  var H = container ? container.offsetHeight : 220;
  if (W < 10 || H < 10) return;
  canvas.width = W; canvas.height = H;
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  var E = _extLevelData.entry, SL = _extLevelData.sl, TP = _extLevelData.tp;
  if (!isFinite(E) || !isFinite(SL) || !isFinite(TP)) return;

  // Plage basée sur la distance SL-TP réelle — évite ATR×mult trop large
  var _slDistExt  = Math.abs(E - SL) || E * 0.001;
  var _tpDistExt  = Math.abs(TP - E) || E * 0.002;
  var _levelSpreadExt = Math.max(_slDistExt, _tpDistExt);
  var priceRange = _levelSpreadExt * 5;
  var _curPxExt = (state && state.price > 0) ? state.price : E;
  var all = [E, SL, TP, _curPxExt];
  var pMin = Math.min.apply(null, all) - _levelSpreadExt * 0.8;
  var pMax = Math.max.apply(null, all) + _levelSpreadExt * 0.8;
  var mTop = 35, mBot = 25;
  var chartH = H - mTop - mBot;
  var priceToY = function(p) { return mTop + chartH - ((p - pMin) / (pMax - pMin)) * chartH; };

  function drawLevel(price, color, label, dashed) {
    var y = Math.round(priceToY(price));
    if (y < mTop - 5 || y > H - mBot + 5) return;
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.85;
    if (dashed) ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W - 4, y); ctx.stroke();
    ctx.restore();
    var priceStr = price >= 100 ? price.toFixed(2) : price.toFixed(5);
    var txt = label + ' ' + priceStr;
    ctx.save();
    ctx.font = 'bold 9px monospace';
    var tw = ctx.measureText(txt).width + 8;
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = color;
    ctx.fillRect(W - tw - 2, y - 8, tw, 14);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'right';
    ctx.fillText(txt, W - 4, y + 3);
    ctx.restore();
  }

  // Prix actuel (state.price) — ligne fine bleue pointillée pour contexte visuel
  var atrVal = _extLevelData.atr || E * 0.003;
  var currentPxExt = (state && state.price && state.price > 0) ? state.price : null;
  if (currentPxExt && Math.abs(currentPxExt - E) > atrVal * 0.15) {
    var yPxE = Math.round(priceToY(currentPxExt));
    if (yPxE >= mTop - 5 && yPxE <= H - mBot + 5) {
      ctx.save();
      ctx.strokeStyle = '#93c5fd';
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([3, 6]);
      ctx.beginPath(); ctx.moveTo(0, yPxE); ctx.lineTo(W - 4, yPxE); ctx.stroke();
      ctx.restore();
      var pxStrE = currentPxExt >= 100 ? currentPxExt.toFixed(2) : currentPxExt.toFixed(5);
      var pxTxtE = 'PRIX ' + pxStrE;
      ctx.save();
      ctx.font = 'bold 9px monospace';
      var pxWE = ctx.measureText(pxTxtE).width + 8;
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = '#1e3a5f';
      ctx.fillRect(W - pxWE - 2, yPxE - 7, pxWE, 13);
      ctx.fillStyle = '#93c5fd'; ctx.textAlign = 'right';
      ctx.fillText(pxTxtE, W - 4, yPxE + 3);
      ctx.restore();
    }
  }

  // Label entrée : immédiat si prix ≈ entrée, en attente sinon
  var entryLabelExt = !currentPxExt || Math.abs(currentPxExt - E) <= atrVal * 0.3
    ? 'ENT' : 'ENT⏳';

  drawLevel(TP, '#22c55e', 'TP', false);
  drawLevel(E,  '#f97316', entryLabelExt, false);
  drawLevel(SL, '#ef4444', 'SL', true);
}

function clearTradeLevelsExt() {
  _extLevelData = { entry: null, sl: null, tp: null, direction: null, atr: null };
  var canvas = document.getElementById('extLevelCanvas');
  if (canvas) { var ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); }
}

function loadTVChart(symbol, tf) {
  var iframe = document.getElementById('tv-chart-iframe');
  if (!iframe) return;
  var tvSym = TV_SYMBOLS_EXT[String(symbol||'XAUUSD').toUpperCase()] || ('FX:' + symbol);
  var tvTF  = TV_TF_EXT[String(tf||'H1').toUpperCase()] || '60';
  if (tvSym === _tvChartSym && tvTF === _tvChartTF) return; // already loaded
  _tvChartSym = tvSym; _tvChartTF = tvTF;
  var url = 'https://www.tradingview.com/widgetembed/?symbol=' + encodeURIComponent(tvSym)
    + '&interval=' + tvTF
    + '&theme=dark&style=1&locale=fr&timezone=Europe%2FParis'
    + '&hide_side_toolbar=0&allow_symbol_change=0&hideideas=1&saveimage=0'
    + '&studies=RSI%40tv-basicstudies'
    + '&utm_source=trading-auto-ext&utm_medium=widget';
  iframe.src = url;
  var msg = document.getElementById('chart-msg');
  if (msg) msg.textContent = tvSym + ' | ' + (tf || 'H1') + ' | TradingView Live';
}
// ─────────────────────────────────────────────────────────────────────────────

async function loadMirrorSnapshot() {
  // Source unique : TradingView live
  var ext = await fetchJson('/extension/data');
  if (!ext.ok || !ext.activeSymbol || !ext.currentData || typeof ext.currentData.price !== 'number') {
    setConn('NO DATA', 'bad');
    // Garder le dernier prix connu — ne pas effacer state.price (évite l'affichage blanc)
    updateHeader();
    return;
  }
  if (ext && ext.bridgeConfig) applyBridgeConfig(ext.bridgeConfig);
  var active = ext.activeSymbol;
  state.symbol = String(active.symbol).toUpperCase();
  state.timeframe = String(active.timeframe).toUpperCase();
  if (active.mode) {
    var m = String(active.mode).toUpperCase();
    if (['AUTO','SCALPER','SNIPER','SWING','ANALYSE','ALERTE','EXECUTION_PREPAREE'].indexOf(m) >= 0) state.tradeMode = m;
  }
  state.price = Number(ext.currentData.price);
  var ss = $('symbolSelect');
  if (ss && Array.from(ss.options).some(function(o) { return o.value === state.symbol; })) ss.value = state.symbol;
  var ts = $('tfSelect'); if (ts) ts.value = state.timeframe;
  var ms = $('modeSelect'); if (ms) ms.value = state.tradeMode;
  updateHeader();
  scheduleSaveState();
}

var _analyzeAllInFlight = false; // guard anti-double-analyse

async function analyzeAllTimeframesAndPickSetup() {
  // Guard: évite deux scans simultanés (ex: clic rapide ou timer)
  if (_analyzeAllInFlight) return { winner: null, snapshots: [] };
  _analyzeAllInFlight = true;
  try {
  // ── HIÉRARCHIE PRO: "Je lis en haut, j'exécute en bas" ────────────────────
  // RÈGLE D'OR: toujours entrer sur petite UT, toujours lire les grandes AVANT
  // Chaque mode définit: context TF (lecture macro) + validation TF (setup) + entry TF (exécution)
  var _mode = String(state.tradeMode || 'AUTO').toUpperCase();

  // Context → Validation → Entry (hiérarchie stricte par mode)
  var _modeHierarchy = {
    // Swing M15: Context=H1, Setup=M15, Entry=M5
    SWING:   { context: ['H1','H4'], validation: ['M15'], entry: ['M5'], all: ['M5','M15','H1','H4'] },
    // Sniper: Context=M5 (direction locale), Validation=M1 (timing), M15/H1 informatifs uniquement
    // M15/H1 sont dans 'all' pour l'affichage mais NE bloquent PAS le setup SNIPER
    SNIPER:  { context: ['M5'], validation: ['M1'], entry: ['M1'], all: ['M1','M5','M15','H1'] },
    // Scalper: Context=M15, Setup=M5, Entry=M1
    SCALPER: { context: ['M15'], validation: ['M5'], entry: ['M1'], all: ['M1','M5','M15'] },
    // Auto: analyse complète, hiérarchie adaptative
    AUTO:    { context: ['H1','H4'], validation: ['M15'], entry: ['M5','M1'], all: ['M1','M5','M15','H1','H4','D1'] }
  };
  var _hier = _modeHierarchy[_mode] || _modeHierarchy.AUTO;
  var allTFs = _hier.all;
  const snapshots = [];

  // ── 1. BLINK TOUTES LES CARTES AVANT LE SCAN ──────────────────────────────
  // Toutes les cartes actives clignotent en orange — signal "je cherche"
  var _scanProgressEl = document.getElementById('tfScanProgress');
  var _scanLabelEl    = document.getElementById('tfScanLabel');
  var _scanCountEl    = document.getElementById('tfScanCount');
  var _scanBarEl      = document.getElementById('tfScanBar');
  if (_scanProgressEl) _scanProgressEl.style.display = 'block';
  if (_scanLabelEl)    _scanLabelEl.textContent = '🔍 Analyse ' + allTFs[0] + ' en cours...';
  if (_scanBarEl)      _scanBarEl.style.width = '0%';
  // Pas de speak ici — les speaks par TF (contexte+validation) suffiront
  // Reset toutes les cartes + affectation rôles visuels selon la hiérarchie du mode
  ['M1','M5','M15','H1','H4','D1'].forEach(function(tf) {
    var c = $('tfc-' + tf); var s = $('tfc-' + tf + '-t'); var sub = $('tfc-' + tf + '-s');
    var role = $('tfc-' + tf + '-role');
    c && c.classList.remove('winner','winner-short','context-role','validation-role','scanning','active');
    if (allTFs.indexOf(tf) >= 0) {
      // Carte active dans ce mode → blink orange
      c && c.classList.add('scanning');
      s && (s.textContent = '⏳'); s && (s.className = 'tfc-sig scanning');
      sub && (sub.textContent = 'scan...');
      // Afficher le rôle de la carte
      if (role) {
        var roleLabel = _hier.context.indexOf(tf) >= 0 ? 'CONTEXTE'
                      : _hier.validation.indexOf(tf) >= 0 ? 'SETUP'
                      : _hier.entry.indexOf(tf) >= 0 ? 'ENTRÉE' : '';
        role.textContent = roleLabel;
        role.style.color = _hier.context.indexOf(tf) >= 0 ? '#3b82f6'
                         : _hier.validation.indexOf(tf) >= 0 ? '#a855f7'
                         : _hier.entry.indexOf(tf) >= 0 ? '#22c55e' : '#475569';
      }
      // Style border selon le rôle
      if (_hier.context.indexOf(tf) >= 0) c && c.classList.add('context-role');
      else if (_hier.validation.indexOf(tf) >= 0) c && c.classList.add('validation-role');
    } else {
      // Carte inactive pour ce mode → griser
      s && (s.textContent = '--'); s && (s.className = 'tfc-sig wait');
      sub && (sub.textContent = 'hors mode');
      role && (role.textContent = '');
    }
  });

  // ── 2. SCAN SÉQUENTIEL AVEC MISE À JOUR CARTE PAR CARTE ───────────────────
  var _scanned = 0;
  var _scanExhaustionAlert = null; // capturé depuis le serveur pendant le scan
  var _scanPulsionAlert    = null;
  for (const tf of allTFs) {
    var card  = $('tfc-' + tf);
    var sigEl = $('tfc-' + tf + '-t');
    var subEl = $('tfc-' + tf + '-s');
    // Update progress bar + label par TF
    _scanned++;
    if (_scanCountEl) _scanCountEl.textContent = _scanned + '/' + allTFs.length;
    if (_scanBarEl)   _scanBarEl.style.width = Math.round((_scanned / allTFs.length) * 100) + '%';
    if (_scanLabelEl) _scanLabelEl.textContent = '🔍 Analyse ' + tf + ' (' + _scanned + '/' + allTFs.length + ')...';

    try {
      const r = await fetchJson('/coach/realtime?symbol=' + encodeURIComponent(state.symbol) +
        '&tf=' + encodeURIComponent(tf) + '&mode=' + encodeURIComponent(state.tradeMode) + '&lang=fr');
      const agents   = getAgents(r);
      const analysis = agents.analysis || {};
      const risk     = agents.risk || {};
      const it       = r.instantTrade || null;
      const vp       = r.virtualPosition || null;
      const lia      = (r.coach && r.coach.lia) || r.lia || null;
      // Capturer les alertes essoufflement/pulsion depuis le serveur (premier TF qui répond)
      if (r.exhaustionAlert && !_scanExhaustionAlert) _scanExhaustionAlert = r.exhaustionAlert;
      if (r.pulsionAlert    && !_scanPulsionAlert)    _scanPulsionAlert    = r.pulsionAlert;

      // Guard no-data: H4/D1 n'ont pas de données bridge réelles — verdict global uniquement
      const _scanMeta = r.tfDataMeta || null;
      const _scanNoData = _scanMeta
        ? (_scanMeta.hasBridgeData === false && !_scanMeta.proxyTf)
        : (tf === 'H4' || tf === 'D1');
      if (_scanNoData) {
        if (card) { card.classList.remove('scanning','context-role','validation-role'); card.style.background = 'rgba(100,116,139,0.08)'; card.style.borderColor = '#334155'; }
        if (sigEl) { sigEl.textContent = 'N/A'; sigEl.className = 'tfc-sig wait'; }
        if (subEl) subEl.textContent = 'Non alimenté';
        snapshots.push({ tf, rec: 'N/A', strength: 0, directional: false, reason: 'no-bridge-data', setupType: null, riskLevel: null, rsiVal: 0, entry: null, sl: null, tp: null, liaText: null });
        continue;
      }

      const _recRaw  = String(analysis.recommendation || '').toUpperCase();
      const rec      = (_recRaw && _recRaw !== 'WAIT') ? _recRaw : String((it && it.direction) || _recRaw || '').toUpperCase();
      const strength = Number(analysis.strength || analysis.confidence || (it && it.confidence) || 0);
      const reason   = analysis.reason || (it && (it.technical || it.sentiment)) || '';
      const directional = rec.includes('BUY') || rec.includes('LONG') || rec.includes('SELL') || rec.includes('SHORT');
      const setupType   = (it && it.setup_type) || null;
      const entry = Number((vp && vp.entry) || (it && it.entry) || NaN);
      const sl    = Number((vp && vp.sl)    || (it && it.sl)    || NaN);
      const tp    = Number((vp && vp.tp)    || (it && it.tp)    || NaN);
      const liaText = lia && lia.ok ? lia.response : null;
      const riskLevel = risk.riskLevel || null;
      const rsiVal    = Number((r.coach && r.coach.signal && r.coach.signal.stats && r.coach.signal.stats['rsi_'+tf.toLowerCase()]) || analysis.rsi || 0);

      // Update card: stop blink, show result
      if (card) {
        card.classList.remove('scanning','context-role','validation-role');
        // Rôle bordure selon hiérarchie
        if (_hier.context.indexOf(tf) >= 0) card.classList.add('context-role');
        else if (_hier.validation.indexOf(tf) >= 0) card.classList.add('validation-role');
      }
      if (sigEl) {
        var lbl = directional
          ? (rec.includes('BUY') || rec.includes('LONG') ? '▲ LONG' : '▼ SHORT')
          : 'NEUTRE';
        var cls = directional
          ? (rec.includes('BUY') || rec.includes('LONG') ? 'buy' : 'sell')
          : 'neutre';
        sigEl.textContent = lbl;
        sigEl.className = 'tfc-sig ' + cls;
      }
      if (subEl) {
        var subTxt = strength ? strength + '%' : '--';
        if (rsiVal > 0) subTxt += rsiVal > 70 ? ' ↑ excès' : rsiVal < 30 ? ' ↓ survente' : rsiVal >= 55 ? ' ↑' : rsiVal <= 45 ? ' ↓' : '';
        subEl.textContent = subTxt;
      }

      // Voix par TF — uniquement CONTEXTE et VALIDATION (pas les TF d'entrée M1/M5)
      // → limiter les speaks à 2 max pour éviter la surcharge vocale
      // → silencé si watchdog armé (il gère son propre vocal contextuel)
      var _isKeyTF = _hier.context.indexOf(tf) >= 0 || _hier.validation.indexOf(tf) >= 0;
      if (_isKeyTF && !state.armed) {
        if (directional) {
          var _scanDir = rec.includes('BUY') || rec.includes('LONG') ? 'monte' : 'descend';
          var _scanRole = _hier.context.indexOf(tf) >= 0 ? 'contexte macro' : 'setup confirmé';
          // Traduire la force en langage humain — pas de valeurs techniques
          var _scanForceLabel = strength >= 80 ? ', fort' : strength >= 60 ? ', modéré' : '';
          // RSI traduit en état marché — jamais la valeur brute
          var _scanRsiLabel = rsiVal > 70 ? ', marché en excès' : rsiVal > 0 && rsiVal < 30 ? ', marché en survente' : '';
          speak(tf + ' ' + _scanDir + ' — ' + _scanRole + _scanForceLabel + _scanRsiLabel + '.');
        } else if (_hier.validation.indexOf(tf) >= 0) {
          speak(tf + ' neutre — le marché hésite, j\'attends un signal clair.');
        }
      }

      snapshots.push({
        tf, rec, strength, directional, reason, setupType, riskLevel, rsiVal,
        entry: Number.isFinite(entry) ? entry : null,
        sl:    Number.isFinite(sl)    ? sl    : null,
        tp:    Number.isFinite(tp)    ? tp    : null,
        liaText
      });
    } catch (_) {
      if (card) { card.classList.remove('scanning','context-role','validation-role'); }
      if (sigEl) { sigEl.textContent = 'KO'; sigEl.className = 'tfc-sig wait'; }
      snapshots.push({ tf, rec: 'WAIT', strength: 0, directional: false, reason: 'no-data' });
    }
  }

  // ── 3. SÉLECTION WINNER — HIÉRARCHIE STRICTE PRO ──────────────────────────
  // RÈGLE: winner est valide SEULEMENT si:
  //   (a) au moins 1 context TF est directionnel (lecture macro OK)
  //   (b) au moins 1 validation TF est directionnel (setup confirmé)
  //   (c) les deux pointent dans la MÊME direction
  // Sans ça → PAS D'ENTRÉE (aucun setup retourné comme winner)
  var snap = {};
  snapshots.forEach(function(s) { snap[s.tf] = s; });

  var _contextSnaps = _hier.context.map(function(tf){ return snap[tf]; }).filter(Boolean);
  var _validSnaps   = _hier.validation.map(function(tf){ return snap[tf]; }).filter(Boolean);
  var _entrySnaps   = _hier.entry.map(function(tf){ return snap[tf]; }).filter(Boolean);

  var _contextDir = null;
  _contextSnaps.forEach(function(s) {
    if (!s.directional) return;
    var d = (s.rec.includes('BUY')||s.rec.includes('LONG')) ? 'LONG' : 'SHORT';
    if (!_contextDir) _contextDir = d;
    else if (_contextDir !== d) _contextDir = 'CONFLICT'; // context TFs disagree
  });

  var _validDir = null;
  _validSnaps.forEach(function(s) {
    if (!s.directional) return;
    var d = (s.rec.includes('BUY')||s.rec.includes('LONG')) ? 'LONG' : 'SHORT';
    if (!_validDir) _validDir = d;
  });

  // Winner candidate: validation TF (has levels, aligned with context)
  var winner = null;
  var _proValidated = false;

  if (_contextDir && _contextDir !== 'CONFLICT' && _validDir && _contextDir === _validDir) {
    // Context + Validation aligned → look for best entry TF
    _proValidated = true;
    var _bestEntry = _entrySnaps.find(function(s) {
      if (!s.directional) return false;
      var d = (s.rec.includes('BUY')||s.rec.includes('LONG')) ? 'LONG' : 'SHORT';
      return d === _contextDir;
    });
    // Prefer entry TF if it has levels, else use validation TF
    if (_bestEntry && (_bestEntry.entry || _bestEntry.sl)) {
      winner = _bestEntry;
    } else {
      // Use validation TF as winner
      winner = _validSnaps.find(function(s) {
        if (!s.directional) return false;
        var d = (s.rec.includes('BUY')||s.rec.includes('LONG')) ? 'LONG' : 'SHORT';
        return d === _contextDir;
      }) || null;
    }
  }

  // Fallback (AUTO mode uniquement): accepter si 3+ TFs s'accordent (pas 2 — trop permissif)
  // SCALPER/SNIPER/SWING: hiérarchie stricte obligatoire, pas de fallback
  if (!winner && _mode === 'AUTO') {
    var _autoDirectionals = snapshots.filter(function(s){ return s.directional; });
    _autoDirectionals.sort(function(a,b){ return (b.strength||0)-(a.strength||0); });
    if (_autoDirectionals.length >= 2) {
      var _autoDir0 = (_autoDirectionals[0].rec.includes('BUY')||_autoDirectionals[0].rec.includes('LONG')) ? 'LONG' : 'SHORT';
      var _autoAgree = _autoDirectionals.filter(function(s){
        var d = (s.rec.includes('BUY')||s.rec.includes('LONG')) ? 'LONG' : 'SHORT';
        return d === _autoDir0;
      });
      // Exiger 3 TFs minimum en AUTO — évite entrée sur M1+M5 sans contexte H1/M15
      if (_autoAgree.length >= 3) {
        winner = _autoDirectionals[0];
        _proValidated = true;
      }
    }
  }

  // Si toujours pas de winner → WAIT (pas d'entrée sur signal non validé)
  // Supprimé: fallback "top directionnel non validé" — trop risqué, cause de pertes
  if (!winner) {
    // Jamais utiliser state.timeframe (UT affichée) comme fallback — utiliser le TF d'analyse verrouillé
    winner = { tf: state._analysisLockedTf || 'M15', rec: 'WAIT', strength: 0, directional: false, reason: 'no-validated-setup' };
    _proValidated = false;
  }

  const hasSetup = winner.directional && _proValidated;

  // ── 3b. DÉTECTION TYPE DE SETUP (SNIPER / SCALP / SWING / STANDARD) ─────────
  // En mode AUTO: détecter automatiquement le type selon la structure des TFs alignés
  // En mode SNIPER/SCALP/SWING: le type est le mode lui-même
  var _detectedSetupType = 'STANDARD';
  if (hasSetup) {
    if (_mode === 'SNIPER' || _mode === 'SCALPER' || _mode === 'SWING') {
      _detectedSetupType = _mode === 'SCALPER' ? 'SCALP' : _mode;
    } else {
      // AUTO: détecter selon les TFs qui ont validé
      var _snapM1  = snap['M1']  || null;
      var _snapM5  = snap['M5']  || null;
      var _snapM15 = snap['M15'] || null;
      var _snapH1  = snap['H1']  || null;
      var _m1Strong2  = _snapM1  && _snapM1.directional  && (_snapM1.strength  || 0) >= 55;
      var _m5Valid2   = _snapM5  && _snapM5.directional;
      var _m15Valid2  = _snapM15 && _snapM15.directional;
      var _h1Strong2  = _snapH1  && _snapH1.directional  && (_snapH1.strength  || 0) >= 60;
      var _h1Weak2    = _snapH1  && _snapH1.directional  && (_snapH1.strength  || 0) < 60;
      // SNIPER: M1 fort + M5 + zone (sweep ou OB détecté) — entrée précise
      if (_m1Strong2 && _m5Valid2 && _m15Valid2) _detectedSetupType = 'SNIPER';
      // SWING: H1 fort + M15 — tendance de fond, laisser courir
      else if (_h1Strong2 && _m15Valid2) _detectedSetupType = 'SWING';
      // SCALP: M1+M5 alignés, H1 faible ou neutre — momentum court terme
      else if (_m1Strong2 && _m5Valid2 && !_h1Strong2) _detectedSetupType = 'SCALP';
      // Sinon : STANDARD (setup validé mais pas clairement catégorisé)
    }
  }

  // ── SNIPER AGRESSIF — détection quand setup classique échoue ─────────────────
  // Conditions: M1+M5 directionnels + alignés + M15 absent ou faiblement opposé
  // Ne remplace PAS le SNIPER normal — complément uniquement pour les ratés en zone
  if (!hasSetup && (_mode === 'SNIPER' || _mode === 'AUTO')) {
    var _saSnapM1  = snap['M1'];  var _saSnapM5  = snap['M5'];  var _saSnapM15 = snap['M15'];
    var _saM1Strong = _saSnapM1  && _saSnapM1.directional  && (_saSnapM1.strength  || 0) >= 55;
    var _saM5Valid  = _saSnapM5  && _saSnapM5.directional;
    if (_saM1Strong && _saM5Valid) {
      var _saM5Dir  = (_saSnapM5.rec.includes('BUY')||_saSnapM5.rec.includes('LONG')) ? 'LONG' : 'SHORT';
      var _saM1Dir  = (_saSnapM1.rec.includes('BUY')||_saSnapM1.rec.includes('LONG')) ? 'LONG' : 'SHORT';
      var _saM15Dir = _saSnapM15 && _saSnapM15.directional
        ? ((_saSnapM15.rec.includes('BUY')||_saSnapM15.rec.includes('LONG')) ? 'LONG' : 'SHORT') : null;
      var _saM15Str = _saSnapM15 ? (_saSnapM15.strength || 0) : 0;
      // M1 et M5 alignés + M15 pas fortement opposé (neutre OU même direction OU force < 70)
      var _saM15NotStrongOpp = !_saM15Dir || _saM15Dir === _saM5Dir || _saM15Str < 70;
      if (_saM1Dir === _saM5Dir && _saM15NotStrongOpp) {
        _detectedSetupType = 'SNIPER_AGRESSIF';
        // M5 devient le winner — l'entrée finale sera validée par watchdog (zone+rejet)
        if (_saSnapM5 && _saSnapM5.directional) {
          winner = _saSnapM5;
          _proValidated = true;
          // hasSetup reste false ici — le watchdog valide zone+rejet avant de proposer
          // On le met true uniquement pour afficher la proposition si bridge confirme
          // (le watchdog refuse d'entrer sans _zoneOk + _pulsionOk de toute façon)
          hasSetup = true;
        }
      }
    }
  }

  // Labels affichage
  var _setupTypeLabel = { SNIPER: '🎯 SNIPER', SCALP: '⚡ SCALP', SWING: '📈 SWING', STANDARD: '✅ STANDARD', SNIPER_AGRESSIF: '🔥 SNIPER AGRESSIF' }[_detectedSetupType] || '✅';
  var _setupTypeDesc  = {
    SNIPER: 'Zone clé + confirmation rapide M1/M5 — entrée précise',
    SCALP:  'Momentum M1+M5 — sortie rapide, contexte HTF neutre',
    SWING:  'H1+M15 alignés — laisser courir vers l\'objectif',
    STANDARD: 'Setup multi-TF validé',
    SNIPER_AGRESSIF: 'M1+M5 en zone+rejet — M15 toléré (non fortement opposé) — SL court'
  }[_detectedSetupType] || '';

  // Persister dans state pour réutilisation par _scanTick (re-affichage proposition)
  if (hasSetup) {
    state._lastDetectedSetupType = _detectedSetupType;
    state._lastSetupTypeLabel    = _setupTypeLabel;
    state._lastSetupTypeDesc     = _setupTypeDesc;
  } else {
    state._lastDetectedSetupType = null;
    state._lastSetupTypeLabel    = null;
    state._lastSetupTypeDesc     = null;
  }

  // ── 4. HIGHLIGHT WINNER CARD ───────────────────────────────────────────────
  if (hasSetup && winner.tf) {
    var _wCard = $('tfc-' + winner.tf);
    if (_wCard) {
      _wCard.classList.remove('scanning','context-role','validation-role');
      var _wIsL = winner.rec.includes('BUY') || winner.rec.includes('LONG');
      _wCard.classList.add(_wIsL ? 'winner' : 'winner-short');
      var _wRole = $('tfc-' + winner.tf + '-role');
      if (_wRole) {
        _wRole.textContent = '📡 SIGNAL';
        _wRole.style.color = _wIsL ? '#22c55e' : '#ef4444';
      }
    }
    // Annonce vocale: signal détecté — silencée si watchdog armé (évite doublon vocal)
    var _wDir = (winner.rec.includes('BUY')||winner.rec.includes('LONG')) ? 'LONG' : 'SHORT';
    if (!state.armed) {
      var _setupSpkRaw = _detectedSetupType !== 'STANDARD' ? _detectedSetupType : '';
      var _setupSpkClean = _setupSpkRaw.replace('SNIPER_AGRESSIF','SNIPER AGRESSIF').replace('SCALPING','SCALP');
      var _setupSpkType = _setupSpkClean ? 'Setup ' + _setupSpkClean + ' ' : '';
      speak(_setupSpkType + 'Signal ' + _wDir + ' détecté sur ' + winner.tf + '. ' + _setupTypeDesc + '. Proposition affichée — accepte ou refuse dans l\'interface.');
    }
    // TF TradingView laissé tel quel — l'utilisateur garde son affichage librement.
  } else {
    // Raison du blocage vocale — silencée si watchdog armé
    if (!state.armed) {
      if (!_contextDir) speak('Contexte non clair sur ' + (_hier.context[0]||'H1') + '. J\'attends un signal.');
      else if (!_validDir) speak('Setup non validé sur ' + (_hier.validation[0]||'M15') + '. Attendre.');
      else if (_contextDir !== _validDir) speak('Conflit: ' + _hier.context[0] + ' dit ' + _contextDir + ' mais ' + _hier.validation[0] + ' dit ' + _validDir + '. On attend.');
    }
  }

  // ── VOCAL ESSOUFFLEMENT / PULSION — message humain post-scan ─────────────
  // Annoncé après le winner pour ne pas couper l'annonce principale
  // Cooldown 120s pour éviter la répétition à chaque scan
  if (!state.muted && !state.armed) {
    var _exhNow = Date.now();
    var _exhLastSpoke = state._exhaustionLastSpoke || 0;
    if (_scanExhaustionAlert && (_exhNow - _exhLastSpoke > 120000)) {
      state._exhaustionLastSpoke = _exhNow;
      setTimeout(function() { speak(_scanExhaustionAlert); }, 2500); // délai après winner
    } else if (_scanPulsionAlert && (_exhNow - _exhLastSpoke > 120000)) {
      state._exhaustionLastSpoke = _exhNow;
      setTimeout(function() { speak(_scanPulsionAlert); }, 2500);
    }
  }

  // Finalize scan progress bar
  if (_scanProgressEl) {
    if (_scanBarEl) _scanBarEl.style.width = '100%';
    if (_scanBarEl) _scanBarEl.style.background = hasSetup ? '#22c55e' : '#94a3b8';
    if (_scanLabelEl) {
      var _ctxTf = _hier.context[0] || 'H1';
      var _valTf = _hier.validation[0] || 'M15';
      var _entTf = _hier.entry[0] || 'M5';
      var _modeLblScan = _mode === 'SCALPER' ? 'SCALP' : _mode;
      _scanLabelEl.textContent = hasSetup
        ? '📡 [' + _modeLblScan + '] SIGNAL ' + (winner.rec.includes('BUY')||winner.rec.includes('LONG')?'LONG':'SHORT') + ' — ' + winner.tf + ' | Ctx:' + _ctxTf + ' Setup:' + _valTf
        : (_contextDir && _validDir && _contextDir !== _validDir)
          ? '⚡ [' + _modeLblScan + '] CONFLIT — ' + _ctxTf + '(ctx)=' + _contextDir + ' vs ' + _valTf + '(setup)=' + _validDir + ' — TF BLOQUANT: ' + _valTf
          : '⏳ [' + _modeLblScan + '] PAS DE SETUP — Ctx:' + (_contextDir||'?') + ' Setup:' + (_validDir||'?') + ' — Patienter';
    }
    // Hide progress bar after 8s
    setTimeout(function(){ if (_scanProgressEl) _scanProgressEl.style.display = 'none'; }, 8000);
  }
  // NE PAS écraser state.timeframe — l'UT active reste celle choisie par l'utilisateur.
  // Le scanner identifie le meilleur setup mais ne change pas l'UT principale.
  // Synchro du TF courant vers le backend (pas le winner TF)
  fetchJson('/extension/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'set-symbol',
      payload: { symbol: state.symbol, timeframe: state.timeframe, mode: state.tradeMode, price: state.price, source: 'extension' }
    })
  }).catch(function() {});

  // Build analysisText summary — format PRO avec hiérarchie Context→Setup→Entrée
  var _ctxTfLabel  = _hier.context[0]    || 'H1';
  var _valTfLabel  = _hier.validation[0] || 'M15';
  var _entTfLabel  = _hier.entry[0]      || 'M5';
  var dirLabel = (winner.rec.includes('BUY') || winner.rec.includes('LONG'))   ? '▲ LONG'  :
                 (winner.rec.includes('SELL') || winner.rec.includes('SHORT'))  ? '▼ SHORT' : 'NEUTRE';
  var analysisMsg;
  if (hasSetup) {
    var _ctxSnap2 = snap[_ctxTfLabel];
    var _ctxDirLbl = _contextDir === 'LONG' ? '▲ LONG' : _contextDir === 'SHORT' ? '▼ SHORT' : 'NEUTRE';
    var _valSnap2 = snap[_valTfLabel];
    var _valDirLbl = _validDir === 'LONG' ? '▲ LONG' : _validDir === 'SHORT' ? '▼ SHORT' : 'NEUTRE';
    var _modeLbl = _mode === 'SCALPER' ? 'SCALP' : _mode; // "SCALPER" → "SCALP" pour cohérence affichage
    analysisMsg = _setupTypeLabel + ' [Mode ' + _modeLbl + '] — ' + dirLabel + ' sur ' + winner.tf
      + '\n' + _setupTypeDesc
      + '\nContexte ' + _ctxTfLabel + ': ' + _ctxDirLbl
      + ' | Setup ' + _valTfLabel + ': ' + _valDirLbl
      + ' | Entrée: ' + winner.tf
      + (winner.strength ? ' (' + winner.strength + '%)' : '')
      + '\n→ Setup validé — arme le robot pour exécution automatique';
  } else {
    // Expliquer clairement pourquoi pas d'entrée — afficher rôle de chaque TF
    var _modeLbl2 = _mode === 'SCALPER' ? 'SCALP' : _mode;
    // Résumé par TF avec rôle : M15(ctx)=LONG | M5(setup)=SHORT | M1(entrée)=SHORT
    var _tfRoleMap = {};
    _hier.context.forEach(function(tf){ _tfRoleMap[tf] = 'ctx'; });
    _hier.validation.forEach(function(tf){ _tfRoleMap[tf] = 'setup'; });
    _hier.entry.forEach(function(tf){ _tfRoleMap[tf] = 'entrée'; });
    var _snapSummaryLines = _hier.all.map(function(tf) {
      var s = snap[tf]; if (!s || s.rec === 'N/A' || s.rec === 'WAIT') return null;
      var dir = s.directional ? (s.rec.includes('BUY')||s.rec.includes('LONG') ? 'LONG' : 'SHORT') : 'neutre';
      return tf + '(' + (_tfRoleMap[tf]||'?') + ')=' + dir + (s.strength > 0 ? ' ' + Math.round(s.strength) + '%' : '');
    }).filter(Boolean).join(' | ');
    var _blockReason, _blockAdvice;
    if (!_contextDir) {
      _blockReason = _ctxTfLabel + '(ctx) neutre — contexte non établi';
      _blockAdvice = 'Attendre signal directionnel sur ' + _ctxTfLabel;
    } else if (!_validDir) {
      _blockReason = _valTfLabel + '(setup) neutre — pas de signal de validation';
      _blockAdvice = 'Attendre confirmation ' + _contextDir + ' sur ' + _valTfLabel;
    } else if (_contextDir !== _validDir) {
      _blockReason = '⚡ CONFLIT — ' + _ctxTfLabel + '(ctx)=' + _contextDir + ' vs ' + _valTfLabel + '(setup)=' + _validDir;
      _blockAdvice = 'TF BLOQUANT: ' + _valTfLabel + ' — aligner ' + _valTfLabel + ' sur ' + _ctxTfLabel + ' (' + _contextDir + ')';
    } else {
      _blockReason = 'Signal insuffisant';
      _blockAdvice = 'Attendre renforcement';
    }
    analysisMsg = '⏳ [Mode ' + _modeLbl2 + '] PAS DE SETUP — ' + _blockReason
      + '\n' + (_snapSummaryLines || ('Ctx:' + (_contextDir||'neutre') + ' Setup:' + (_validDir||'neutre')))
      + '\n→ ' + _blockAdvice;
  }
  var an = $('analysisText');
  if (an) { an.textContent = analysisMsg; an.style.whiteSpace = 'pre-line'; }

  // ── VERROUILLAGE TF ANALYSE — indépendant de l'UT affichée sur TradingView ──
  // Dès que le winner est identifié, on le fixe dans state._analysisLockedTf.
  // Ce TF ne changera plus tant qu'une nouvelle analyse n'est pas lancée ou que
  // le robot n'est pas réinitialisé (WAIT/disarm). state.timeframe (ce que
  // l'utilisateur voit sur TV) n'a AUCUN impact sur la logique robot après ce point.
  if (hasSetup && winner.tf) {
    state._analysisLockedTf = winner.tf;
  } else if (!state._analysisLockedTf) {
    // Pas de winner — garder un TF par défaut propre (jamais M1)
    state._analysisLockedTf = 'M15';
  }
  // Propager aussi sur _mtfWinner pour cohérence watchdog
  if (hasSetup) state._mtfWinner = winner;

  // ANALYSER → ARMER → exécution auto — plus de validation ACCEPTER/REFUSER
  _hideSetupProposal();

  // ── Résoudre conflit/canEnter ICI — avant le coach narrative (variables utilisées dessous)
  var _earlySnap = (state.live && state.live.coach && state.live.coach.analysisSnapshot && state.live.coach.analysisSnapshot.sourceSummary)
                || (state.live && state.live.analysisSnapshot && state.live.analysisSnapshot.sourceSummary) || {};
  var _earlyConflict  = !!_earlySnap.conflictDetected;
  var _earlyExec = (state.live && state.live.coach && state.live.coach.execution) || (state.live && state.live.execution) || {};
  var _earlyCanEnter  = _earlyExec.canEnter === true;

  // Build coach narrative (conversational French)
  var coachEl = $('coachText');
  var narrativeText = '';
  if (coachEl) {
    narrativeText = buildCoachNarrative(hasSetup ? winner.tf : null, snapshots);
    var rDir = _earlyConflict ? '#f97316'
      : _earlyCanEnter
        ? ((winner.rec.includes('BUY') || winner.rec.includes('LONG')) ? COL_LONG
          : (winner.rec.includes('SELL') || winner.rec.includes('SHORT')) ? COL_SHORT : COL_WAIT)
        : '#94a3b8';
    setCoachText(narrativeText, rDir, 3, 8000); // prio 3 — analyse ANALYSER, tient 8s
  }
  // Parler dès que l'analyse locale est prête (sans attendre l'IA)
  if (narrativeText && !state.muted) {
    var speakText = narrativeText.split(/[.!?\n]/)[0].trim();
    if (speakText.length > 5) speak(speakText);
  }

  flowLog('MTF ANALYSIS SUMMARY', {
    symbol: state.symbol,
    winner: winner,
    snapshots: snapshots.map(function(s) { return { tf: s.tf, rec: s.rec, strength: s.strength, directional: s.directional }; })
  });

  // ── GAUGE UPDATE — Multi-TF réel depuis snapshots scan (M1+M5+M15+H1 bridge Pine) ──
  state._lastSnapshots = snapshots.slice(); // Persiste pour renderBiasBanner (refresh continu)
  var _pulse = computeGaugePulse(snapshots);
  applyGaugePulse(_pulse, state.armedMode === 'imminent' || state.armedMode === 'entering');
  // Coach vocal — annonce seulement si l'état du marché change depuis le dernier scan
  var _prevPulse = state._lastGaugePulseState || null;
  state._lastGaugePulseState = _pulse.pulseState;
  if (_pulse.pulseState !== _prevPulse) {
    var _pulseVoice = _pulse.pulseState === 'ACCELERATION' ? _pulse.stateLabel + ' — tous les TF sont alignés.'
      : _pulse.pulseState === 'REVERSAL_RISK' ? _pulse.stateLabel + ' — H1 et court terme divergent.'
      : _pulse.pulseState === 'SLOWDOWN'      ? 'Ralentissement — momentum court terme s\'essouffle.'
      : _pulse.pulseState === 'COMPRESSION'   ? 'Marché en compression — pas de setup clair.'
      : null;
    if (_pulseVoice) speak(_pulseVoice);
  }

  // ── CODEX AI CALL ──
  try {
    var multiTFpayload = {};
    snapshots.forEach(function(s) {
      var dir = (s.rec.includes('BUY') || s.rec.includes('LONG')) ? 'LONG'
              : (s.rec.includes('SELL') || s.rec.includes('SHORT')) ? 'SHORT' : 'NEUTRE';
      multiTFpayload[s.tf] = { direction: dir, strength: s.strength };
    });
    var aiResp = await fetchJson('/ai/coach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'analyze',
        execMode: state.tradeMode,
        symbol: state.symbol,
        timeframe: winner.tf || state.timeframe,
        price: state.price || null,
        multiTF: multiTFpayload,
        lang: 'fr'
      })
    });
    var aiText = (aiResp && aiResp.ok && (aiResp.response || aiResp.text)) || null;
    if (aiText) {
      var ts = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      var _aiCol = _gaugeConflict ? '#f97316'
        : _gaugeCanEnter
          ? ((winner.rec.includes('BUY') || winner.rec.includes('LONG')) ? COL_LONG
            : (winner.rec.includes('SELL') || winner.rec.includes('SHORT')) ? COL_SHORT : '#94a3b8')
          : '#94a3b8';
      setCoachText('[' + ts + '] ' + aiText, _aiCol, 3, 10000);
      var an2 = $('analysisText');
      if (an2) an2.textContent = '[AI] ' + aiText.substring(0, 150) + (aiText.length > 150 ? '...' : '');
      // Speak first sentence
      var firstSentence = aiText.split(/[.!?\n]/)[0].trim();
      if (firstSentence) speak(firstSentence);
    }
  } catch (_) {
    // AI call failed — utiliser le texte LIA du meilleur TF s'il est disponible
    var _bestLia = winner && winner.liaText ? winner.liaText
      : (snapshots.filter(function(s){ return s.liaText; }).sort(function(a,b){ return (b.strength||0)-(a.strength||0); })[0] || {}).liaText;
    if (_bestLia) {
      var ts3 = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      var _liaCol = _gaugeConflict ? '#f97316'
        : _gaugeCanEnter
          ? ((winner.rec.includes('BUY') || winner.rec.includes('LONG')) ? COL_LONG
            : (winner.rec.includes('SELL') || winner.rec.includes('SHORT')) ? COL_SHORT : '#94a3b8')
          : '#94a3b8';
      setCoachText('[' + ts3 + '] ' + _bestLia, _liaCol, 3, 10000);
    }
  }

    return { winner: winner, snapshots: snapshots };
  } finally {
    _analyzeAllInFlight = false;
  }
}

// ─── SURVEILLANCE LIVE — analyse bridge temps réel en position ───────────────
// Lit state._lastBridgeData (mis à jour toutes les 2-3s) et construit
// une parole contextuelle à partir des champs réels du bridge.
// Pas de phrases par cœur — chaque mot vient d'une observation marché réelle.
function _speakLiveSurveillance(pnlPips, pnlR, phase, mode) {
  var _bd = state._lastBridgeData;
  if (!_bd) {
    speak('Je surveille. Aucune donnée bridge disponible pour l\'instant.');
    return;
  }

  var _vp   = (state.tradeState && state.tradeState.virtualPosition) || {};
  var _dir  = String(_vp.direction || '').toUpperCase();
  var _isLong = _dir.includes('LONG') || _dir.includes('BUY');
  var _m = String(mode || state.tradeMode || 'AUTO').toUpperCase();

  // ── Lire les TF directions réelles (bridge live) ──────────────────────
  var _lt1 = String(_bd.lectureTech1 || '').toUpperCase(); // M1 — timing seul
  var _lt2 = String(_bd.lectureTech2 || '').toUpperCase(); // M5 — décision
  var _lt3 = String(_bd.lectureTech3 || '').toUpperCase(); // M15 — validation
  var _lt4 = String(_bd.lectureTech4 || '').toUpperCase(); // H1 — contexte

  var _sc2 = Number(_bd.scoreTech2 || 0);
  var _sc3 = Number(_bd.scoreTech3 || 0);
  var _sc4 = Number(_bd.scoreTech4 || 0);

  var _macroBull = Number(_bd.macroBull || 0);
  var _macroBear = Number(_bd.macroBear || 0);
  var _inTop    = _bd.inTop === true;
  var _inBot    = _bd.inBot === true;
  var _bullRej  = _bd.bullRej === true;
  var _bearRej  = _bd.bearRej === true;
  var _antTxt   = String(_bd.anticipationTexte || '').toUpperCase();
  var _beStr    = phase >= 3 ? 'Stop au coût. ' : '';

  // ── Analyser l'alignement des TF vs direction de la position ─────────
  var _aligned  = []; // TF qui confirment
  var _opposed  = []; // TF qui s'opposent
  var _alerts   = []; // signaux de danger

  // H1 — contexte macro (le plus important en swing/sniper)
  if (_lt4 === 'ACHAT' && _isLong)       _aligned.push('H1 haussier');
  else if (_lt4 === 'VENTE' && !_isLong) _aligned.push('H1 baissier');
  else if (_lt4 === 'ACHAT' && !_isLong) _opposed.push('H1 tourne haussier');
  else if (_lt4 === 'VENTE' && _isLong)  _opposed.push('H1 tourne baissier');

  // SWING: si H1 opposé → alerte immédiate (tendance de fond en danger)
  if (_m === 'SWING' && _opposed.length > 0) {
    var _swingAlert = _opposed[0] + ' — la tendance de fond montre des signes de retournement. '
      + _beStr + 'Réévalue la position.';
    speak(_swingAlert);
    return;
  }

  // M15 — validation
  if (_lt3 === 'ACHAT' && _isLong)       _aligned.push('M15 confirme');
  else if (_lt3 === 'VENTE' && !_isLong) _aligned.push('M15 confirme');
  else if (_lt3 === 'ACHAT' && !_isLong) _opposed.push('M15 retourne haussier');
  else if (_lt3 === 'VENTE' && _isLong)  _opposed.push('M15 retourne baissier');

  // M5 — décision
  if (_lt2 === 'ACHAT' && _isLong)       _aligned.push('M5 pousse');
  else if (_lt2 === 'VENTE' && !_isLong) _aligned.push('M5 pousse');
  else if (_lt2)                         _opposed.push('M5 commence à faiblir');

  // ── Zone de danger — prix en zone opposée à la position ───────────────
  if (_isLong && _inTop)  _alerts.push('tu entres en zone de vente — résistance proche');
  if (!_isLong && _inBot) _alerts.push('tu entres en zone d\'achat — support proche');

  // ── Structure adverse ──────────────────────────────────────────────────
  if (_isLong && _bearRej)  _alerts.push('rejet baissier sur structure — pression vendeuse');
  if (!_isLong && _bullRej) _alerts.push('rejet haussier sur structure — pression acheteuse');

  // ── Anticipation Pine — retournement en préparation ───────────────────
  if (_isLong  && (_antTxt.includes('RET_SHORT')   || _antTxt.includes('PRE_ALERTE_SHORT')))
    _alerts.push('signal Pine : retournement baissier en préparation');
  if (!_isLong && (_antTxt.includes('RET_LONG')    || _antTxt.includes('PRE_ALERTE_LONG')))
    _alerts.push('signal Pine : retournement haussier en préparation');

  // ── Dominance ──────────────────────────────────────────────────────────
  var _domOK  = (_isLong && _macroBull > 58) || (!_isLong && _macroBear > 58);
  var _domKO  = (_isLong && _macroBear > 58) || (!_isLong && _macroBull > 58);
  if (_domOK) _aligned.push((_isLong ? 'acheteurs' : 'vendeurs') + ' dominants');
  if (_domKO) _alerts.push('dominance en train de basculer dans l\'autre sens');

  // ── Construire la parole selon la situation et le mode ────────────────
  var _sentence = '';
  var _hasAlert = _alerts.length > 0 || (_opposed.length >= 2);
  var _alignStr = _aligned.join(', ');

  if (_hasAlert) {
    // Situation de danger — parole différente par mode
    var _alertMsg = (_alerts[0] || _opposed[0]);
    if (_m === 'SCALP' || _m === 'SCALPER') {
      _sentence = _alertMsg + '. Scalp — si ça bloque, on sort immédiatement. ' + _beStr;
    } else if (_m === 'SNIPER') {
      _sentence = _alertMsg + '. Surveille la prochaine bougie. '
        + (_aligned.length > 0 ? _alignStr + ' — structure pas encore cassée. ' : '')
        + 'Ne bouge pas le SL sans raison solide.';
    } else { // SWING + AUTO
      _sentence = _alertMsg + '. '
        + (_aligned.length > 0 ? _alignStr + '. ' : '')
        + _beStr + 'Le swing a besoin de structure, pas de réaction au bruit.';
    }
  } else if (_aligned.length >= 2) {
    // Bonne situation — tout s'aligne
    var _pipsStr = pnlPips > 0 ? ' ' + pnlPips + ' pips. ' : ' ';
    if (_m === 'SCALP' || _m === 'SCALPER') {
      _sentence = _alignStr + '.' + _pipsStr
        + _beStr + 'Pulsion intacte — on tient jusqu\'au TP.';
    } else if (_m === 'SNIPER') {
      _sentence = _alignStr + '.' + _pipsStr
        + _beStr + 'On est bien placé — laisse le snipe se développer.';
    } else { // SWING + AUTO
      _sentence = _alignStr + '.' + _pipsStr
        + _beStr + 'La tendance de fond reste intacte — on laisse respirer.';
    }
  } else if (_aligned.length === 1) {
    // Alignement partiel — surveiller
    if (_m === 'SCALP' || _m === 'SCALPER') {
      _sentence = _aligned[0] + '. Alignement partiel — reste vigilant, scalp sans hésitation si ça bloque.';
    } else if (_m === 'SNIPER') {
      _sentence = _aligned[0] + '. Le marché digère. C\'est normal sur un snipe — laisse venir.';
    } else {
      _sentence = _aligned[0] + '. Moment de consolidation — le swing a besoin de temps.';
    }
  } else {
    // Aucun alignement lisible — bridge insuffisant ou neutre
    _sentence = 'Aucun signal TF clair pour l\'instant. Je continue à surveiller.';
  }

  if (_sentence && !state.muted) speak(_sentence);
}

// ─── POSITION PANEL ───────────────────────────────────────────────────────────────────────────
function renderPositionPanel(live, price) {
  const panel = document.getElementById('positionPanel');
  if (!panel) return;

  // SOURCE STRICTE: state.tradeState (verrouillé à l'ENTER, persisté en localStorage)
  // Jamais live?.tradeState ni live?.virtualPosition — prix courant utilisé comme entry → dérive
  const ts  = state.tradeState || null;
  const pos = (ts?.entered && ts?.virtualPosition) ? ts.virtualPosition : null;

  // Afficher le panel si entered ET VP a au minimum entry + sl (TP peut être 0 = "sans objectif fixé")
  if (!ts?.entered || !pos?.entry || !pos?.sl) {
    panel.style.display = 'none';
    clearTradeLevelsExt();
    // Effacer les labels DOM pour que _updateRecalage ne lise plus les valeurs stales
    var _setText = function(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
    _setText('posSlLbl', '');
    _setText('posEntryLbl', '');
    _setText('posTpLbl', '');
    return;
  }

  panel.style.display = 'block';
  const entry = parseFloat(pos.entry);
  const sl    = parseFloat(pos.sl);
  const tp    = parseFloat(pos.tp);
  const cur   = parseFloat(price || state.price || entry);
  // Direction depuis virtualPosition.direction — pas heuristique tp>entry (fragile + inversé si SHORT)
  var posRawDir = String(pos.direction || ts?.direction || '').toUpperCase();
  const isLong = posRawDir === 'LONG' || posRawDir.includes('BUY')
    || (!posRawDir && tp > entry); // heuristique uniquement si direction absent

  // Pip multiplier selon l'actif — CRITIQUE: ne jamais utiliser 10000 pour crypto/or/indices
  var _sym = String(state.symbol || '').toUpperCase();
  var _isCrypto = /BTC|ETH|SOL|XRP|BNB|ADA|DOGE|LTC|AVAX|MATIC|DOT|LINK/.test(_sym);
  var _isGold   = /XAU|GOLD/.test(_sym);
  var _isJpy    = _sym.includes('JPY');
  var _isIndex  = /SPX|SP500|NAS|NDX|DOW|DAX|FTSE|CAC|NIKKEI|US30|US500|US100/.test(_sym);
  var pipMult   = (_isCrypto || _isIndex) ? 1 : _isGold ? 10 : _isJpy ? 100 : 10000;
  var pipUnit   = (_isCrypto || _isIndex) ? 'USD' : 'pips';
  const pnlPips = parseFloat(((cur - entry) * pipMult * (isLong ? 1 : -1)).toFixed(_isCrypto || _isIndex ? 2 : 1));
  const distSl  = parseFloat((Math.abs(cur - sl) * pipMult).toFixed(_isCrypto || _isIndex ? 2 : 1));
  const distTp  = tp > 0 ? parseFloat((Math.abs(cur - tp) * pipMult).toFixed(_isCrypto || _isIndex ? 2 : 1)) : null;
  // Si TP=0: range = 2× distance SL (proxy 2R), affichage "sans TP fixé"
  const _slDist = Math.abs(entry - sl);
  const range   = tp > 0 ? Math.abs(tp - sl) : (_slDist * 2 || 1);
  const rr      = tp > 0 && _slDist > 0 ? (Math.abs(tp - entry) / _slDist).toFixed(1) : '∞';

  // Position du prix sur la barre (0% = SL danger, 100% = TP profit)
  // LONG : prix monte de SL→TP → (cur - sl) / range augmente ✓
  // SHORT: prix baisse de SL→TP → SL > tp, on inverse : (sl - cur) / range augmente ✓
  const pct = range > 0 ? Math.max(0, Math.min(100,
    (isLong ? (cur - sl) : (sl - cur)) / range * 100
  )) : 50;

  // RÈGLE: vert = gain, rouge = perte — MÊME logique LONG et SHORT
  // Couleur basée UNIQUEMENT sur le signe de pnlPips — jamais sur pct ni direction
  // LONG: prix monte → pnlPips > 0 → vert   |  prix descend → pnlPips < 0 → rouge
  // SHORT: prix descend → pnlPips > 0 → vert |  prix monte → pnlPips < 0 → rouge
  const pnlColor = pnlPips > 0 ? '#22c55e' : pnlPips < 0 ? '#ef4444' : '#f97316'; // 0 = orange (à l'entrée)
  const dotColor = pnlColor; // dot = même couleur que P&L — pas de seuil pct

  // ── STATUS BADGE ─────────────────────────────────────────────────────
  const _phase = String(ts?.phase || '').toUpperCase();
  const _bePlacedPos = pos.bePlaced || ts?.bePlaced || pos.secured;
  // GAINS SÉCURISÉS: SL ≥ entry pour LONG (ou SL ≤ entry pour SHORT) — lignes croisées sur le graphique
  const _isGainSecured = pos.secured === true
    || (isLong  && sl > 0 && entry > 0 && sl >= entry)
    || (!isLong && sl > 0 && entry > 0 && sl <= entry);
  var _statusLabel = 'ACTIF';
  var _statusStyle = 'background:rgba(249,115,22,0.15);color:#f97316;';
  if (_phase === 'ARMED') {
    _statusLabel = 'EN ATTENTE'; _statusStyle = 'background:rgba(234,179,8,0.15);color:#eab308;';
  } else if (_isGainSecured) {
    _statusLabel = '✅ SÉCURISÉ'; _statusStyle = 'background:rgba(34,197,94,0.25);color:#22c55e;border:1px solid rgba(34,197,94,0.4);';
  } else if (_bePlacedPos) {
    _statusLabel = 'SÉCURISÉ';  _statusStyle = 'background:rgba(34,197,94,0.15);color:#22c55e;';
  } else if (_phase === 'MANAGE') {
    _statusLabel = 'GÉRÉ';      _statusStyle = 'background:rgba(59,130,246,0.15);color:#3b82f6;';
  } else if (_phase === 'EXITED' || _phase === 'SL_HIT' || _phase === 'TP_HIT') {
    _statusLabel = 'SORTI';     _statusStyle = 'background:rgba(100,116,139,0.15);color:#64748b;';
  } else if (pnlPips > 0) {
    _statusLabel = 'PROFIT';    _statusStyle = 'background:rgba(34,197,94,0.15);color:#22c55e;';
  }
  var _statusEl = document.getElementById('posStatus');
  if (_statusEl) {
    if (_statusEl.textContent !== _statusLabel) _statusEl.textContent = _statusLabel;
    var _stCss = 'font-size:10px;font-weight:700;padding:2px 6px;border-radius:3px;letter-spacing:0.8px;' + _statusStyle;
    if (_statusEl.getAttribute('data-css') !== _stCss) { _statusEl.style.cssText = _stCss; _statusEl.setAttribute('data-css', _stCss); }
  }

  // ── Badge MODE (SNIPER/SWING/SCALP) — affiché sur le panel position ─────
  var _modeBadge = document.getElementById('posMode');
  if (_modeBadge) {
    var _rawMode = String(
      state._activeTradeMode ||
      pos.setupType || pos.setup_type ||
      ts?.setupType || ts?.tradeType || ''
    ).toUpperCase().replace('SNIPER_AGRESSIF', 'SNIPER+').replace('SCALPING', 'SCALP');
    if (_rawMode && _rawMode !== 'AUTO') {
      _modeBadge.textContent = _rawMode;
      var _modeBg = _rawMode.startsWith('SNIPER') ? 'rgba(168,85,247,0.2)'
                  : _rawMode === 'SWING'           ? 'rgba(59,130,246,0.2)'
                  : _rawMode === 'SCALP'           ? 'rgba(249,115,22,0.2)'
                  :                                  'rgba(100,116,139,0.15)';
      var _modeCol = _rawMode.startsWith('SNIPER') ? '#c084fc'
                   : _rawMode === 'SWING'           ? '#60a5fa'
                   : _rawMode === 'SCALP'           ? '#fb923c'
                   :                                  '#94a3b8';
      _modeBadge.style.cssText = 'font-size:10px;font-weight:800;padding:2px 8px;border-radius:3px;letter-spacing:1px;background:' + _modeBg + ';color:' + _modeCol + ';display:inline-block';
    } else {
      _modeBadge.style.display = 'none';
    }
  }

  // ── Badge TF source du setup ──────────────────────────────────────────
  var _tfBadge = document.getElementById('posSetupTf');
  if (_tfBadge) {
    var _stf = state._lastSetupTF || pos.setupTF || null;
    if (_stf) {
      _tfBadge.textContent = _stf;
      _tfBadge.style.display = 'inline-block';
    } else {
      _tfBadge.style.display = 'none';
    }
  }
  // ── Indicateurs TF au moment de l'entrée ─────────────────────────────
  var _indEl = document.getElementById('posEntryIndicators');
  if (_indEl) {
    var _indTxt = state._lastEntryIndicators || pos.entryIndicators || null;
    if (_indTxt) {
      _indEl.textContent = _indTxt;
      _indEl.style.display = 'block';
    } else {
      _indEl.style.display = 'none';
    }
  }

  setText('posDir',      isLong ? '▲ LONG' : '▼ SHORT');
  setText('posPnl',      (pnlPips >= 0 ? '+' : '') + pnlPips + ' ' + pipUnit);
  setText('posSlLbl',    'SL  ' + fmtPrice(sl));
  setText('posEntryLbl', 'Entrée  ' + fmtPrice(entry));
  setText('posTpLbl',    tp > 0 ? ('TP  ' + fmtPrice(tp)) : 'TP  trailing');
  setText('posDistSl',   '← SL  ' + distSl + ' ' + pipUnit);
  setText('posDistTp',   distTp != null ? (distTp + ' ' + pipUnit + '  TP →') : 'trailing →');
  setText('posRr',       'R:R  1:' + rr);

  var _dEl = document.getElementById('posDir');       if (_dEl && _dEl.style.color !== pnlColor) _dEl.style.color = pnlColor;
  var _pEl = document.getElementById('posPnl');       if (_pEl && _pEl.style.color !== pnlColor) _pEl.style.color = pnlColor;
  var _dotEl = document.getElementById('posPriceDot');
  if (_dotEl) {
    var _pctStr = pct + '%';
    if (_dotEl.style.left !== _pctStr)           _dotEl.style.left = _pctStr;
    if (_dotEl.style.background !== dotColor)    _dotEl.style.background = dotColor;
  }

  // Taille des zones SL/TP
  const slWidth = range > 0 ? Math.abs(entry - sl) / range * 100 : 33;
  const tpWidth = range > 0 ? Math.abs(tp - entry) / range * 100 : 33;
  var _slZone = document.getElementById('posSlZone'); if (_slZone) { var _slW = slWidth + '%'; if (_slZone.style.width !== _slW) _slZone.style.width = _slW; }
  var _tpZone = document.getElementById('posTpZone'); if (_tpZone) { var _tpW = tpWidth + '%'; if (_tpZone.style.width !== _tpW) _tpZone.style.width = _tpW; }

  // Redessiner les niveaux — uniquement si entry/sl/tp ont changé (anti-flicker canvas)
  if (Number.isFinite(entry) && Number.isFinite(sl) && Number.isFinite(tp)) {
    var _lvlKey = entry + '|' + sl + '|' + tp;
    if (_lvlKey !== state._lastDrawnLvlKey) {
      state._lastDrawnLvlKey = _lvlKey;
      const posDir = isLong ? 'LONG' : 'SHORT';
      drawTradeLevelsExt(entry, sl, tp, posDir, pos.atr || null);
    }
  }

  // ── COACHING EN TEMPS RÉEL — 5 PHASES PRO ─────────────────────────────────
  // RÈGLE: "Il accepte la perte au départ, sécurise dès que le marché donne raison, laisse les gains travailler"
  // Phase 1: Entrée → rien toucher (laisse respirer)
  // Phase 2: +1R atteint → SL au breakeven (perte impossible)
  // Phase 3: TP1 approche → TP partiel + laisser courir
  // Phase 4: Trail SL sous swing lows (LONG) / au-dessus swing highs (SHORT)
  // Phase 5: TP final ou signal retournement → sortie

  var _tsLockAt = ts?.entryLockedAt || state.tradeState?.entryLockedAt || 0;
  if (!state._posCoach
    || state._posCoach.sym !== state.symbol
    || Math.abs((state._posCoach.entry||0) - entry) > 0.5
    || (state._posCoach._lockAt || 0) !== _tsLockAt) {
    state._posCoach = { sym: state.symbol, entry: entry, phase: 1, _lockAt: _tsLockAt };
  }
  var _pc = state._posCoach;
  var _now = Date.now();

  // ── Calcul 1R ────────────────────────────────────────────────────────────
  // Risk = distance entry→SL en pips. 1R = avoir gagné autant que le risque initial.
  var _riskPips = parseFloat((Math.abs(entry - sl) * pipMult).toFixed(1));
  var _1Reached  = _riskPips > 0 && pnlPips >= _riskPips * 0.9;  // 90% de 1R → sécuriser
  var _2RReached  = _riskPips > 0 && pnlPips >= _riskPips * 1.9; // proche de 2R → trail TP

  // ── Phase courante ────────────────────────────────────────────────────────
  var bePlacedPos = pos.bePlaced || ts?.bePlaced || state.tradeState?.bePlaced;
  var _proPhase = bePlacedPos ? (_2RReached ? 4 : 3)  // BE placé: phase trail (3) ou 2R (4)
                : _1Reached  ? 2                        // 1R atteint: phase BE
                : 1;                                    // phase initiale: laisser respirer
  _pc.phase = _proPhase;

  // Mettre à jour le label de statut avec la phase PRO
  if (_statusEl) {
    var _phaseLabel = _proPhase === 4 ? '🔥 PHASE 4 — TRAIL'
                    : _proPhase === 3 ? '✅ PHASE 3 — BE PLACÉ'
                    : _proPhase === 2 ? '⚡ PHASE 2 — SÉCURISER'
                    : pnlPips < 0 ? '😤 PHASE 1 — TENIR'
                    : '📊 PHASE 1 — RESPIRER';
    var _phaseStyle = _proPhase >= 3 ? 'background:rgba(34,197,94,0.2);color:#22c55e;'
                    : _proPhase === 2 ? 'background:rgba(249,115,22,0.2);color:#f97316;'
                    : pnlPips < 0 ? 'background:rgba(239,68,68,0.12);color:#ef4444;'
                    : 'background:rgba(148,163,184,0.15);color:#94a3b8;';
    _statusEl.textContent = _phaseLabel;
    _statusEl.style.cssText = 'font-size:10px;font-weight:700;padding:2px 6px;border-radius:3px;letter-spacing:0.6px;' + _phaseStyle;
  }

  // ── Phase 1: Rien toucher — message rassurant ─────────────────────────────
  var beAdvExtEl = document.getElementById('posBeAdviceExt');
  if (_proPhase === 1 && !_pc.phase1Announced) {
    _pc.phase1Announced = true;
    if (beAdvExtEl) {
      beAdvExtEl.style.display = 'block';
      beAdvExtEl.innerHTML = '⏳ <strong>Phase 1</strong> — Laisse le marché respirer. Ne touche ni SL ni TP. '
        + 'Objectif: atteindre <span style="color:#f97316">+' + _riskPips.toFixed(1) + ' pips (1R)</span> pour sécuriser.';
      beAdvExtEl.style.background = 'rgba(100,116,139,0.1)';
      beAdvExtEl.style.borderColor = '#64748b';
      beAdvExtEl.style.color = '#94a3b8';
    }
  }

  // ── Phase 2: 1R atteint → AUTO-BE immédiat (pas d'attente manuelle) ─────────
  if (_proPhase === 2 && !bePlacedPos) {
    if (!_pc.beAutoSent) {
      _pc.beAutoSent = true;
      // AUTO: déclencher BE sans intervention utilisateur — le SL ne peut pas attendre
      // Guard anti-doublon partagé avec le handler SSE trade-action BREAKEVEN
      var _beSpkNow = Date.now();
      state['_beSpokenAt'] = _beSpkNow;
      speak('1R atteint. Je sécurise la position. Break-even activé — risque zéro à partir de maintenant.');
      setCoachText('⚡ AUTO-BE — SL déplacé à ' + fmtPrice(entry) + ' — risque zéro.', '#f97316', 8, 20000);
      // Appel direct — ne pas attendre le clic utilisateur
      (async function() {
        try {
          await fetchJson('/coach/trade-action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol: state.symbol, timeframe: state.timeframe, mode: state.tradeMode, action: 'BE' })
          });
          // Mettre à jour l'état local immédiatement
          if (state.tradeState) state.tradeState.bePlaced = true;
          scheduleSaveState();
        } catch (_beErr) {
          speak('Erreur déplacement SL automatique. Appuie sur BREAKEVEN maintenant.');
        }
      })();
    }
    if (beAdvExtEl) {
      beAdvExtEl.style.display = 'block';
      beAdvExtEl.style.background = 'rgba(249,115,22,0.1)';
      beAdvExtEl.style.borderColor = '#f97316';
      beAdvExtEl.style.color = '#f97316';
      beAdvExtEl.innerHTML = '⚡ <strong>Phase 2 — AUTO-BE</strong> : SL déplacé automatiquement à '
        + '<span style="color:#22c55e">' + fmtPrice(entry) + '</span> — risque zéro';
    }
  }

  // ── Phase 3: BE placé → laisser courir, trail SL ─────────────────────────
  if (_proPhase === 3 || (bePlacedPos && _proPhase < 4)) {
    var _inDrawdownAfterBE = bePlacedPos && pnlPips < 0;
    if (!_pc.phase3Announced && !_inDrawdownAfterBE) {
      _pc.phase3Announced = true;
      speak('Phase 3. Break-even placé — risque zéro. Laisse le marché travailler pour toi. '
        + 'Suis la structure: place le stop loss sous les derniers creux ' + (isLong ? '(swing lows)' : '(swing highs)') + '.');
    }
    if (beAdvExtEl) {
      beAdvExtEl.style.display = 'block';
      if (_inDrawdownAfterBE) {
        beAdvExtEl.style.background = 'rgba(249,115,22,0.1)';
        beAdvExtEl.style.borderColor = '#f97316';
        beAdvExtEl.style.color = '#f97316';
        beAdvExtEl.innerHTML = '⚠️ <strong>Phase 3 — REPLI TEMPORAIRE</strong> : SL au niveau d\'entrée ('
          + fmtPrice(entry) + '). Si SL touché = sortie à zéro, pas en perte. Position en respiration — normal.';
      } else {
        beAdvExtEl.style.background = 'rgba(34,197,94,0.1)';
        beAdvExtEl.style.borderColor = '#22c55e';
        beAdvExtEl.style.color = '#22c55e';
        beAdvExtEl.innerHTML = '✅ <strong>Phase 3 — BE SÉCURISÉ</strong> : Risque zéro. '
          + 'Trail SL sous les ' + (isLong ? 'creux' : 'sommets') + ' de structure. Laisse courir vers TP.';
      }
    }
  }

  // ── Phase 4: 2R atteint → trail agressif + TP extension ─────────────────
  var tpAdvExtEl = document.getElementById('posTpAdviceExt');
  if (_2RReached || pct > 75) {
    var tpExtension = Math.abs(tp - entry) * 0.5;
    var newTpTrail = isLong ? tp + tpExtension : tp - tpExtension;
    // Phase 4: afficher et FIGER — ne disparaît qu'en dessous de 60% pour éviter le scintillement
    _pc.phase4Shown = true;
    if (tpAdvExtEl) {
      tpAdvExtEl.style.display = 'block';
      // Ne re-renderer que si le contenu a changé (évite le flash)
      var _p4Html = '🔥 <strong>Phase 4 — Fort momentum</strong>: TP actuel '
        + fmtPrice(tp) + ' → extension suggérée <span style="color:#fb923c">' + fmtPrice(newTpTrail) + '</span>'
        + '<br>Seulement si l\'impulsion est forte. Sinon respecte le plan.';
      if (tpAdvExtEl.innerHTML !== _p4Html) tpAdvExtEl.innerHTML = _p4Html;
    }
    if (!_pc.tp80Advised && pct > 80) {
      _pc.tp80Advised = true;
      speak('Le momentum est fort avec ' + pnlPips + ' pips. Tu peux prendre une partie du profit maintenant'
        + ' et laisser le reste courir. Extension TP suggérée: ' + fmtPrice(newTpTrail) + '.');
      setCoachText('🔥 Trail TP → ' + fmtPrice(newTpTrail), '#f97316', 6, 30000); // prio 6 — tient 30s
    }
  } else {
    // Masquer Phase 4 seulement si on redescend nettement sous 60% (évite le flash à 74%↔76%)
    if (_pc.phase4Shown && pct < 60) { _pc.phase4Shown = false; }
    if (tpAdvExtEl && !_pc.phase4Shown) tpAdvExtEl.style.display = 'none';
    if (pct < 55) _pc.tp80Advised = false;
  }

  // ── Alerte SL approche — Phase 1 uniquement (ne pas paniquer) ────────────
  if (_proPhase === 1 && !_pc.slWarned && distSl > 0 && distSl < _riskPips * 0.25 && pnlPips < 0) {
    _pc.slWarned = true;
    var slMsg = 'Le prix approche du stop loss — il reste ' + distSl + ' ' + pipUnit + '.'
      + ' C\'est normal, le marché respire. Tu as défini ce risque à l\'entrée, accepte-le.'
      + ' Ne bouge pas le SL — laisse le plan se dérouler.';
    speak(slMsg);
    setCoachText('⚠️ SL: ' + slMsg, COL_SHORT, 8, 20000); // prio 8 — alerte SL tient 20s
  }

  // ── Analyse live du bridge — parole contextualisée par mode ────────────
  var _survMode = String(state.tradeMode || 'AUTO').toUpperCase();
  var _survInterval = _survMode === 'SCALP' || _survMode === 'SCALPER' ? 30000
    : _survMode === 'SWING' ? 120000 : 90000;
  if (pnlPips > 5 && (!_pc.lastMotivation || _now - _pc.lastMotivation > _survInterval)) {
    _pc.lastMotivation = _now;
    _speakLiveSurveillance(pnlPips, pnlR, _proPhase, _survMode);
  }

  // ── Reset partiel si le trade revient vers l'entrée ──────────────────────
  if (pnlPips < -(_riskPips * 0.2)) {
    _pc.beAdviced = false; _pc.phase3Announced = false; _pc.tp80Advised = false;
    if (pnlPips > -(_riskPips * 0.5)) _pc.slWarned = false; // reset warning si pas trop proche du SL
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── REVERSAL GUARD — suivi position live + anticipation retournement ─────────
// Source signal: computeGaugePulse(state._lastSnapshots) = données bridge réelles M1+M5+M15+H1
// Décision: si REVERSAL_RISK pendant position active →
//   - En profit  : serrer SL pour protéger (SET_SL vers prix actuel - buffer)
//   - En perte   : couper (EXIT) pour stopper la saignée
// Cooldown 5min — jamais deux actions auto en moins de 5 minutes
var _rrGuardLastAt     = 0;
var _rrGuardLastAction = null;
var _rrGuardSpokenAt   = 0;
var _trailLastAt       = 0;
// News guard en position — toutes les 2 min, action par news unique
var _newsPosLastAt  = 0;
var _newsPosActedOn = ''; // titre de la news sur laquelle on a déjà agi (évite doublons)
var _trailLastSl       = 0;

async function checkReversalRiskDuringPosition() {
  if (!state.tradeState || !state.tradeState.entered) return;

  // ── SOURCE LIVE : bridge complet (TF + zones + anticipation Pine) ────────
  // state._lastBridgeData mis à jour toutes les 2-3s — réaction immédiate en position.
  // 3 signaux lus en parallèle :
  //   1. lectureTech1-4 : direction M1/M5/M15/H1
  //   2. inTop/inBot + zoneLiq : prix arrivé en zone clé opposée à la position
  //   3. anticipationTexte : signal Pine Script anticipant un retournement
  var _pulse   = null;
  var _bd      = state._lastBridgeData;
  var _vp0     = (state.tradeState.virtualPosition) || {};
  var _dir0    = String(_vp0.direction || '').toUpperCase();
  var _isLong0 = _dir0.includes('LONG') || _dir0.includes('BUY');

  // ── ANTICIPATION ZONE + ESSOUFFLEMENT ────────────────────────────────────
  if (_bd) {
    var _antVp    = _vp0;
    var _antEntry = Number(_antVp.entry || 0);
    var _antSl    = Number(_antVp.sl    || 0);
    var _antTp    = Number(_antVp.tp    || 0);
    var _antPx    = Number(state.price  || 0);
    var _antRange = Math.abs(_antTp - _antEntry);
    var _antIsLg  = _dir0.includes('LONG') || _dir0.includes('BUY');
    if (_antRange > 0.01 && _antEntry > 0 && _antPx > 0) {
      var _antZoneAdv  = _antIsLg ? Number(_bd.liqHigh || 0) : Number(_bd.liqLow || 0);
      var _antDistZone = (_antZoneAdv > 0) ? Math.abs(_antPx - _antZoneAdv) : 0;
      var _antDistPct  = _antDistZone > 0 ? _antDistZone / _antRange : 1;
      var _antImpNow   = Number(_bd.impulseScoreTf1 || 0) + Number(_bd.impulseScoreTf2 || 0);
      if (!state._zoneAnticipHist) state._zoneAnticipHist = [];
      state._zoneAnticipHist.push(_antImpNow);
      if (state._zoneAnticipHist.length > 5) state._zoneAnticipHist.shift();
      var _antHist    = state._zoneAnticipHist;
      var _antMomDecl = _antHist.length >= 3 && (
        _antHist[_antHist.length-1] < _antHist[_antHist.length-2] &&
        _antHist[_antHist.length-2] < _antHist[_antHist.length-3]
      );
      var _antMomLow  = _antImpNow < 40;
      if (_antDistPct < 0.20 && _antMomDecl && !state._zoneAnticipShown) {
        if (!state._zoneAnticipAt || (Date.now() - state._zoneAnticipAt) > 90000) {
          state._zoneAnticipAt    = Date.now();
          state._zoneAnticipShown = true;
          var _antZoneLbl  = _antIsLg ? 'résistance' : 'support';
          var _antDistPips = (_antDistZone * (_bd.symbol && _bd.symbol.includes('JPY') ? 100 : 10000)).toFixed(0);
          speak('Zone ' + _antZoneLbl + ' proche — environ ' + _antDistPips + ' pips. La pulsion M1 et M5 commence à faiblir. Je me prépare à serrer le stop si le rejet se confirme sur cette zone.');
          setCoachText('🔶 ZONE ' + _antZoneLbl.toUpperCase() + ' PROCHE — ESSOUFFLEMENT\nDistance: ~' + _antDistPips + ' pips | M1+M5 impulse: ' + Math.round(_antImpNow) + '\nPulsion en train de faiblir. Je surveille le rejet.', '#f97316', 6, 12000);
        }
      } else if (_antDistPct < 0.10 && !_antMomDecl) {
        if (!state._zoneAnticipAt || (Date.now() - state._zoneAnticipAt) > 60000) {
          state._zoneAnticipAt = Date.now();
          var _antZoneLbl2 = _antIsLg ? 'résistance' : 'support';
          setCoachText('⚠️ ZONE ' + _antZoneLbl2.toUpperCase() + ' IMMINENTE\nPulsion encore active — mais zone très proche.\nSi rejet sur cette bougie, je serre immédiatement.', '#fbbf24', 5, 10000);
        }
      }
      if (_antDistPct > 0.35 && state._zoneAnticipShown) {
        state._zoneAnticipShown = false;
        state._zoneAnticipAt    = 0;
      }
      if (_antMomLow && _antMomDecl && !state._antMomLowAt) {
        state._antMomLowAt = Date.now();
        speak('La pulsion M1 et M5 est en train de s\'effondrer. Je reste en position mais je resserre ma vigilance. Si M15 tourne, j\'agis immédiatement.');
        setCoachText('📉 ESSOUFFLEMENT DÉTECTÉ\nM1+M5 impulse faible et en baisse — marché en perte de vitesse.\nSi structure casse, sortie immédiate.', '#f97316', 5, 10000);
      } else if (!_antMomLow && state._antMomLowAt) {
        state._antMomLowAt = null;
      }
    }
  }

  if (_bd) {
    // ── 1. Directions TF — hiérarchie pondérée ───────────────────────────
    // H1/M15 = contexte/filtre macro (poids fort)
    // M5     = confirmation du retournement (poids intermédiaire)
    // M1     = timing immédiat / alerte précoce (poids faible — pas suffisant seul)
    var _lecs = [
      String(_bd.lectureTech1 || '').toUpperCase(), // M1  — timing
      String(_bd.lectureTech2 || '').toUpperCase(), // M5  — confirmation
      String(_bd.lectureTech3 || '').toUpperCase(), // M15 — contexte principal
      String(_bd.lectureTech4 || '').toUpperCase()  // H1  — filtre macro
    ];
    var _tfNames   = ['M1', 'M5', 'M15', 'H1'];
    var _tfWeights = [0.5,  1.5,  2.0,   2.5];  // M1=timing, M5=confirm, M15=contexte, H1=macro
    var _scoreAgainst = 0, _scoreWith = 0;
    var _tfAgainst = [false, false, false, false]; // [M1, M5, M15, H1]
    var _tfAgainstNames = [];
    var _against = 0, _with = 0; // comptage simple (pour labels/score)

    _lecs.forEach(function(lec, idx) {
      if (!lec || lec.includes('NEUTRE') || lec.includes('NEUTRAL')) return;
      var _isBuy  = lec.includes('ACHAT') || lec.includes('BUY')  || lec.includes('LONG')  || lec.includes('HAUSSIER');
      var _isSell = lec.includes('VENTE') || lec.includes('SELL') || lec.includes('SHORT') || lec.includes('BAISSIER');
      if ((_isLong0 && _isSell) || (!_isLong0 && _isBuy)) {
        _scoreAgainst += _tfWeights[idx];
        _tfAgainst[idx] = true;
        _tfAgainstNames.push(_tfNames[idx]);
        _against++;
      }
      if ((_isLong0 && _isBuy) || (!_isLong0 && _isSell)) {
        _scoreWith += _tfWeights[idx];
        _with++;
      }
    });

    var _m1Against  = _tfAgainst[0];
    var _m5Against  = _tfAgainst[1];
    var _m15Against = _tfAgainst[2];
    var _h1Against  = _tfAgainst[3];

    // M1 seul = timing alerte précoce → vocal uniquement, JAMAIS d'action automatique
    var _m1OnlyAlert = _m1Against && !_m5Against && !_m15Against && !_h1Against;

    // ── 2. Zones de retournement (inTop/inBot + liquidité) ───────────────
    var _zoneAgainst = false;
    var _zoneLabel   = '';
    if (!_isLong0 && (_bd.inBot === true || _bd.zoneLiqBasse === true)) {
      _zoneAgainst = true;
      _zoneLabel   = _bd.zoneLiqBasse ? 'zone de liquidité basse' : 'zone de retournement LONG atteinte';
    } else if (_isLong0 && (_bd.inTop === true || _bd.zoneLiqHaute === true)) {
      _zoneAgainst = true;
      _zoneLabel   = _bd.zoneLiqHaute ? 'zone de liquidité haute' : 'zone de retournement SHORT atteinte';
    }

    // ── 3. Anticipation Pine Script ───────────────────────────────────────
    var _antAgainst = false;
    var _antLabel   = '';
    var _antTxt   = String(_bd.anticipationTexte  || '').toUpperCase();
    var _antForce = Number(_bd.anticipationForce  || 0);
    if (_antTxt && _antForce >= 60) {
      var _antBuy  = _antTxt.includes('LONG') || _antTxt.includes('ACHAT') || _antTxt.includes('BUY')  || _antTxt.includes('HAUSSE');
      var _antSell = _antTxt.includes('SHORT') || _antTxt.includes('VENTE') || _antTxt.includes('SELL') || _antTxt.includes('BAISSE');
      if (_isLong0  && _antSell) { _antAgainst = true; _antLabel = 'anticipation Pine SHORT (' + _antForce + '%)'; }
      if (!_isLong0 && _antBuy)  { _antAgainst = true; _antLabel = 'anticipation Pine LONG ('  + _antForce + '%)'; }
    }

    // ── Décision composite — hiérarchie TF ───────────────────────────────
    // REVERSAL_RISK déclenché si :
    //   • M5 confirme + (M1 OU M15 OU H1) → timing + confirmation
    //   • M15 + H1 contre + zone clé → contexte macro + zone sans M5
    //   • Zone clé + M5 ou M15/H1 contre → zone + contexte
    //   • Pine fort + M5 ou M15/H1 → signal Pine + contexte
    //   • Score pondéré ≥ 2.5 (ex: H1 seul = 2.5, M15+H1 = 4.5)
    // M1 seul contre → alerte vocale sans action (traité en amont via _m1OnlyAlert)
    var _isRisk = false;
    if (!_m1OnlyAlert) {
      if (_m5Against && (_m1Against || _m15Against || _h1Against)) _isRisk = true;
      if (_m15Against && _h1Against && _zoneAgainst)               _isRisk = true;
      if (_zoneAgainst && (_m5Against || _m15Against || _h1Against)) _isRisk = true;
      if (_antAgainst  && (_m5Against || _m15Against || _h1Against)) _isRisk = true;
      if (_scoreAgainst >= 2.5)                                      _isRisk = true;
    }

    var _reasons = [];
    if (_against  > 0)  _reasons.push(_tfAgainstNames.join('+') + ' contre');
    if (_zoneAgainst)   _reasons.push(_zoneLabel);
    if (_antAgainst)    _reasons.push(_antLabel);

    // Score pondéré pour la décision EXIT — passe dans _pulse pour que checkReversalRiskDuringPosition
    // puisse distinguer M1+M5 (score 2.0 = faible) de M5+M15 (3.5) ou M15+H1 (4.5 = fort)
    var _weightedScoreAgainst = _scoreAgainst + (_zoneAgainst ? 1.5 : 0) + (_antAgainst ? 1.0 : 0);
    _pulse = _isRisk
      ? { pulseState: 'REVERSAL_RISK',
          score: -(_against + (_zoneAgainst?1:0) + (_antAgainst?1:0)),
          weightedScore: _weightedScoreAgainst, // score pondéré pour décision EXIT
          stateLabel: 'RETOURNEMENT — ' + _reasons.join(' + '),
          m1Alert: false }
      : _m1OnlyAlert
      ? { pulseState: 'M1_ALERT',
          score: -0.5,
          stateLabel: 'Alerte timing M1 — j\'attends M5 confirmation',
          m1Alert: true }
      : { pulseState: _with >= 2 ? 'STRONG' : 'NEUTRAL',
          score: _scoreWith,
          stateLabel: 'Position alignée' };
  }

  // Fallback : snapshots ANALYSER si bridge indisponible (marché fermé, reconnexion)
  if (!_pulse) {
    if (!state._lastSnapshots || state._lastSnapshots.length === 0) return;
    _pulse = computeGaugePulse(state._lastSnapshots);
  }

  // M1 seul contre → alerte vocale précoce, pas d'action — on attend M5 pour confirmation
  if (_pulse.pulseState === 'M1_ALERT') {
    var _nowM1 = Date.now();
    if (_nowM1 - _rrGuardSpokenAt > 180000) { // vocal max 1 fois / 3 min
      _rrGuardSpokenAt = _nowM1;
      speak('Alerte timing sur M1. J\'attends la confirmation M5 avant d\'agir. Je surveille.');
      setCoachText('⏳ M1 alerte — attente M5 confirmation', '#fde68a', 2, 6000);
    }
    return; // pas d'action tant que M5 ne confirme pas
  }

  // ── ANNONCE POSITION STABLE — toutes les 2 min même sans risque ─────────
  // Donne un verdict complet: état TF + news en cours + statut position
  if (_pulse.pulseState !== 'REVERSAL_RISK') {
    var _nowStable = Date.now();
    if (_nowStable - _rrGuardSpokenAt > 120000) {
      _rrGuardSpokenAt = _nowStable;
      var _survDirS  = _isLong0 ? 'long' : 'short';
      var _pxNowS    = Number(state.price || 0);
      var _vpS       = (state.tradeState && state.tradeState.virtualPosition) || {};
      var _entryS    = Number(_vpS.entry || 0);
      var _pxStr0    = _pxNowS > 0 ? 'Prix actuel ' + (_pxNowS > 100 ? _pxNowS.toFixed(2) : _pxNowS.toFixed(5)) + '. ' : '';
      var _pnlS      = (_entryS > 0 && _pxNowS > 0) ? (_isLong0 ? _pxNowS - _entryS : _entryS - _pxNowS) : 0;
      var _pnlPct    = (_entryS > 0 && _pxNowS > 0) ? Math.abs(_pnlS / _entryS * 100).toFixed(2) : '0';
      var _pnlStrS   = _pnlS > 0.0001 ? 'Position en profit de ' + _pnlPct + '%. '
                     : _pnlS < -0.0001 ? 'Position en perte de ' + _pnlPct + '%. Je surveille. '
                     : 'Au breakeven. ';
      // Bilan news
      var _posNewsStr = '';
      var _posNewsChk = checkNewsBlockEntry();
      if (_posNewsChk.blocked) {
        _posNewsStr = _posNewsChk.reason.split('.')[0] + ' — entrée bloquée.';
      } else if (_posNewsChk.warning) {
        _posNewsStr = _posNewsChk.reason.split('.')[0] + '. ';
      } else {
        var _posEvts = Array.isArray(state.newsEvents) ? state.newsEvents : [];
        var _posNextEvt = null;
        for (var _pni = 0; _pni < _posEvts.length; _pni++) {
          var _pne = _posEvts[_pni];
          var _pneMins = Number.isFinite(Number(_pne.mins)) ? Number(_pne.mins)
                       : Number.isFinite(Number(_pne.minsUntil)) ? Number(_pne.minsUntil)
                       : Number.isFinite(Number(_pne.minutesUntil)) ? Number(_pne.minutesUntil)
                       : 9999;
          if (_pneMins >= -10 && _pneMins < 9999) { _posNextEvt = { ev: _pne, mins: _pneMins }; break; }
        }
        if (_posNextEvt) {
          var _pneName   = String(_posNextEvt.ev.title || _posNextEvt.ev.event || '').trim().substring(0, 40);
          var _pneImpRaw = String(_posNextEvt.ev.impact || '').toUpperCase();
          var _pneStars  = Number(_posNextEvt.ev.stars || 0);
          var _pneImpLbl = (_pneImpRaw === 'HIGH' || _pneStars >= 3) ? 'haute impact'
                         : (_pneImpRaw === 'MEDIUM' || _pneStars >= 2) ? 'impact moyen'
                         : 'faible impact';
          var _pneWhen   = _posNextEvt.mins <= 0 ? 'en cours' : _posNextEvt.mins < 60 ? 'dans ' + Math.round(_posNextEvt.mins) + ' min' : 'dans ' + Math.round(_posNextEvt.mins / 60) + 'h';
          _posNewsStr = _pneName + ' ' + _pneWhen + ', ' + _pneImpLbl + '. ';
        }
        // Pas de "agenda calme" inutile — silence si rien à signaler
      }
      // ── Lecture bridge live — pulsion + zone ──────────────────────────────
      var _bdStable = state._lastBridgeData;
      var _pulsStable = _bdStable && ((_isLong0 && _bdStable.bullRej === true) || (!_isLong0 && _bdStable.bearRej === true));
      var _zoneStable = _bdStable && (
        (_isLong0 && (_bdStable.inBot === true || _bdStable.zoneLiqBasse === true)) ||
        (!_isLong0 && (_bdStable.inTop === true || _bdStable.zoneLiqHaute === true))
      );
      var _zoneAdvStable = _bdStable && (
        (_isLong0  && (_bdStable.inTop === true  || _bdStable.zoneLiqHaute === true)) ||
        (!_isLong0 && (_bdStable.inBot === true  || _bdStable.zoneLiqBasse === true))
      );
      var _pulsMsg = _pulsStable
        ? 'Pulsion ' + (_isLong0 ? 'haussière' : 'baissière') + ' confirmée — le marché continue dans notre sens. '
        : '';
      var _zoneMsg = _zoneAdvStable && _pnlS > 0
        ? 'Zone de retournement détectée — j\'ai serré le stop pour protéger les gains. '
        : _zoneStable
        ? 'On est dans la zone de départ — setup actif. '
        : '';
      var _alignMsg = _pulse.pulseState === 'STRONG'
        ? 'Tous les TF alignés. Je laisse courir vers le TP.'
        : _pulsStable
        ? 'TF en ordre, pulsion active. Je garde la position.'
        : 'Certains TF hésitent. Je garde mais je surveille de près.';
      speak('Position ' + _survDirS + '. ' + _pxStr0 + _pnlStrS + _pulsMsg + _zoneMsg + (_posNewsStr ? _posNewsStr : '') + _alignMsg);
    }
    return;
  }

  var _now = Date.now();

  // Vocal de surveillance (max 1 fois / 2 min) — indépendant de l'action
  if (_now - _rrGuardSpokenAt > 120000) {
    _rrGuardSpokenAt = _now;
    var _survDir = _isLong0 ? 'long' : 'short';
    // Bilan news pour l'annonce retournement
    var _rvNewsStr = '';
    var _rvNewsChk = checkNewsBlockEntry();
    if (_rvNewsChk.blocked || _rvNewsChk.warning) {
      _rvNewsStr = ' ' + _rvNewsChk.reason.split('.')[0] + '.';
    } else {
      var _rvEvts = Array.isArray(state.newsEvents) ? state.newsEvents : [];
      for (var _rni = 0; _rni < _rvEvts.length; _rni++) {
        var _rne = _rvEvts[_rni];
        var _rneMins = Number.isFinite(Number(_rne.mins)) ? Number(_rne.mins)
                     : Number.isFinite(Number(_rne.minsUntil)) ? Number(_rne.minsUntil)
                     : 9999;
        if (_rneMins >= -10 && _rneMins < 9999) {
          var _rneName = String(_rne.title || _rne.event || '').trim().substring(0, 35);
          var _rneImp  = String(_rne.impact || '').toUpperCase();
          var _rneImpL = (_rneImp === 'HIGH') ? 'haute impact' : (_rneImp === 'MEDIUM') ? 'impact moyen' : 'faible impact';
          var _rneWhen = _rneMins <= 0 ? 'en cours' : _rneMins < 60 ? 'dans ' + Math.round(_rneMins) + ' min' : 'dans ' + Math.round(_rneMins / 60) + 'h';
          _rvNewsStr = ' Agenda: ' + _rneName + ' ' + _rneWhen + ', ' + _rneImpL + '.';
          break;
        }
      }
    }
    var _rvRiskParts = String(_pulse.stateLabel || '').replace('RETOURNEMENT — ', '').replace(' contre', ' contre la position');
    var _rvOppDir = _isLong0 ? 'SHORT' : 'LONG'; // direction du retournement possible
    speak('Attention. Ta position ' + _survDir + ' est sous pression. Signal de retournement ' + _rvOppDir + ' détecté : ' + _rvRiskParts + '.' + _rvNewsStr + ' Si M5 confirme, j\'agis.');
    setCoachText('⚠️ ' + _pulse.stateLabel, '#fdba74', 4, 8000);
  }

  // Cooldown adaptatif: 90s si zone adverse urgente en profit, 5min standard
  var _zoneUrgent = _pulse && _pulse.stateLabel
    && (_pulse.stateLabel.includes('zone') || _pulse.stateLabel.includes('liquidité'))
    && (_pulse.weightedScore || 0) >= 3.5;
  var _guardCooldown = _zoneUrgent ? 90000 : 300000;
  if (_now - _rrGuardLastAt < _guardCooldown) return;

  var _vp    = (state.tradeState && state.tradeState.virtualPosition) || {};
  var _entry = Number(_vp.entry || 0);
  var _sl    = Number(_vp.sl    || 0);
  var _dir   = String(_vp.direction || '').toUpperCase();
  var _px    = Number(state.price || 0);
  if (!_entry || !_sl || !_dir || !_px) return;

  var _isLong  = _dir === 'LONG';
  var _1r      = Math.abs(_entry - _sl);
  if (_1r < 0.01) return; // sanity check
  var _pnlPips = _isLong ? (_px - _entry) : (_entry - _px);

  if (_pnlPips <= -_1r * 0.3) {
    // Perte > 30% du R + divergence → EXIT défensif
    _rrGuardLastAt     = _now;
    _rrGuardLastAction = 'EXIT';
    var _exitRevDir = _isLong ? 'SHORT' : 'LONG';
    speak('Attention. Retournement ' + _exitRevDir + ' confirmé. La position est en perte. Je coupe maintenant pour limiter les dégâts. Sortie automatique.');
    setCoachText('⛔ SORTIE DÉFENSIVE', '#fca5a5', 8, 12000);
    try { await sendTradeAction('EXIT'); } catch (exitErr) {
      console.error('[EXIT DÉFENSIF ERROR]', exitErr);
      speak('Erreur sortie automatique. Coupe la position manuellement maintenant.');
      setCoachText('⚠️ ERREUR SORTIE — COUPER MANUELLEMENT', '#ef4444', 9, 15000);
    }

  } else if (_pnlPips > 0) {
    _rrGuardLastAt = _now;

    // ── Lecture bridge live pour filtres EXIT en profit ───────────────────
    var _bdLive2    = state._lastBridgeData;
    var _impTf3p    = _bdLive2 ? Number(_bdLive2.impulseScoreTf3 || 0) : 0; // M15 impulse
    // RÈGLE 3 — rejet requis : bearRej pour LONG (résistance), bullRej pour SHORT (support)
    var _hasRejp    = _bdLive2 ? (_isLong ? (_bdLive2.bearRej === true) : (_bdLive2.bullRej === true)) : false;
    // RÈGLE 5 — M15 ou H1 doit être contre avant EXIT
    var _m15A       = (typeof _m15Against !== 'undefined') ? !!_m15Against : false;
    var _h1A        = (typeof _h1Against  !== 'undefined') ? !!_h1Against  : false;
    var _m1A        = (typeof _m1Against  !== 'undefined') ? !!_m1Against  : false;
    var _m5A        = (typeof _m5Against  !== 'undefined') ? !!_m5Against  : false;
    var _tfNamesP   = (typeof _tfAgainstNames !== 'undefined' && _tfAgainstNames) ? _tfAgainstNames : [];
    var _m15orH1    = _m15A || _h1A;
    // RÈGLE 5 — M15 impulse faible = trend s'essouffle (< 40 = signal d'épuisement)
    var _impDroppingP = _impTf3p > 0 && _impTf3p < 40;

    var _isZoneRisk = !!(_pulse.stateLabel && (_pulse.stateLabel.includes('zone') || _pulse.stateLabel.includes('liquidité')));
    var _wScore     = _pulse.weightedScore !== undefined ? _pulse.weightedScore : Math.abs(_pulse.score || 0) * 1.5;

    // RÈGLE 4 — M1+M5 seuls contre = bruit court terme → JAMAIS EXIT, SL serré uniquement
    var _isM1M5Only = _m1A && _m5A && !_m15A && !_h1A;

    // RÈGLE 3+5 — EXIT SEULEMENT si toutes les conditions réunies :
    //   • weightedScore ≥ 3.5  (M5+M15=3.5 / M15+H1=4.5)
    //   • Zone réelle confirmée (inTop/inBot/zoneLiq)
    //   • Rejet candle confirmé (bearRej/bullRej selon sens)
    //   • M15 OU H1 dans le camp adverse
    //   • impulseScoreTf3 (M15) en chute (< 40) → tendance s'essouffle
    //   • PAS le cas M1+M5 seuls (règle 4)
    var _isStrongRisk = _wScore >= 3.5;
    var _canExitProfit = _isStrongRisk && _isZoneRisk && _hasRejp && _m15orH1 && _impDroppingP && !_isM1M5Only;

    if (_canExitProfit) {
      // EXIT en profit — toutes les conditions dures réunies
      _rrGuardLastAction = 'EXIT';
      var _exitLog = 'score=' + _wScore.toFixed(1) +
        ' TFs=[' + _tfNamesP.join('+') + ']' +
        ' zone=' + (_isZoneRisk ? (_pulse.stateLabel || '?') : 'non') +
        ' rejet=' + (_isLong ? 'bearRej' : 'bullRej') +
        ' impulseM15=' + _impTf3p +
        ' m15orH1=' + _m15orH1;
      flowLog('EXIT PROFIT — ' + _exitLog);
      var _profRevDir = _isLong ? 'SHORT' : 'LONG';
      speak('Retournement ' + _profRevDir + ' confirmé sur ' + _tfNamesP.join(' et ') + '. Zone atteinte, rejet candle présent, impulsion M15 en chute. Je coupe pour sécuriser les gains. Sortie maintenant.');
      setCoachText('🚨 SORTIE — RETOURNEMENT CONFIRMÉ\n' + _tfNamesP.join('+') + ' | score ' + _wScore.toFixed(1), '#fca5a5', 8, 15000);
      try { await sendTradeAction('EXIT'); } catch (exitProfErr) {
        console.error('[EXIT PROFIT ERROR]', exitProfErr);
        speak('Erreur sortie en profit. Coupe la position manuellement maintenant.');
        setCoachText('⚠️ ERREUR SORTIE — COUPER MANUELLEMENT', '#ef4444', 9, 15000);
      }
    } else {
      // Conditions EXIT non réunies → SL serré uniquement (RÈGLE 1 : trail SL, jamais forcer EXIT)
      _rrGuardLastAction = 'SET_SL';
      var _slReason = _isM1M5Only
        ? 'M1+M5 seuls contre (bruit court terme) — SL serré, pas de EXIT [règle 4]'
        : !_isStrongRisk
        ? 'score=' + _wScore.toFixed(1) + ' < 3.5 — SL serré, pas de EXIT'
        : !_isZoneRisk
        ? 'aucune zone confirmée — SL serré, pas de EXIT'
        : !_hasRejp
        ? 'pas de rejet (' + (_isLong ? 'bearRej' : 'bullRej') + ') — SL serré, attente rejet'
        : !_m15orH1
        ? 'M15/H1 pas encore contre — SL serré, attente confirmation multi-TF [règle 5]'
        : !_impDroppingP
        ? 'impulseM15=' + _impTf3p + ' pas en chute — pulsion encore présente, SL serré'
        : 'signal modéré — SL serré';
      var _buffer = _isZoneRisk ? Math.max(_1r * 0.10, 0.30) : Math.max(_1r * 0.30, 0.50);
      var _newSl  = _isLong ? (_px - _buffer) : (_px + _buffer);
      var _valid  = _isLong ? (_newSl > _sl) : (_newSl < _sl);
      if (!_valid) return; // SL déjà plus protecteur → ne pas rétrograder
      flowLog('SET_SL (reversal-guard) — ' + _slReason + ' | newSl=' + _newSl.toFixed(5));
      var _whyNoExit = _isM1M5Only ? 'M1 et M5 seuls, c\'est du bruit court terme — pas suffisant pour sortir.'
        : !_isStrongRisk ? 'score pondéré insuffisant (' + _wScore.toFixed(1) + '), j\'attends plus de TF.'
        : !_isZoneRisk   ? 'aucune zone clé confirmée — je ne sors pas sans zone.'
        : !_hasRejp      ? 'rejet candle pas encore confirmé — j\'attends la bougie.'
        : !_m15orH1      ? 'M15 et H1 pas encore contre — j\'attends la confirmation macro.'
        : !_impDroppingP ? 'pulsion M15 encore présente — le trend n\'est pas épuisé.'
        : 'signal modéré.';
      var _spkSet = _isZoneRisk
        ? 'Zone de retournement imminente. Je serre le stop au plus près. Je ne sors pas encore — ' + _whyNoExit
        : 'Signal de retournement partiel. Je resserre le stop pour sécuriser. Je reste en position — ' + _whyNoExit;
      speak(_spkSet);
      setCoachText((_isZoneRisk ? '⚠️ SL SERRÉ — ZONE' : '🔒 SL RESSERRÉ') + '\n' + _newSl.toFixed(5), '#fde68a', 6, 10000);
      try {
        await fetchJson('/coach/trade-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: state.symbol, timeframe: state.timeframe, mode: state.tradeMode,
            action: 'SET_SL', newSl: _newSl,
            trade: { direction: _dir, entry: _entry, sl: _sl, tp: Number(_vp.tp || 0), source: 'reversal-guard' }
          })
        });
        await refreshAll();
      } catch (_) {}
    }
  }
}

// ── TRAIL SL PROGRESSIF PENDANT POSITION ─────────────────────────────────────
// Déplace le SL automatiquement selon % du TP atteint :
//   30% TP → SL au Break-Even (0%)
//   50% TP → SL lock 30% du range
//   70% TP → SL lock 50% du range
//   85% TP → SL lock 70% du range
// Cooldown 60s entre deux déplacements. Vérifie que le nouveau SL est plus protecteur.
async function trailStopLossDuringPosition() {
  if (!state.tradeState || !state.tradeState.entered) return;
  var _nowT = Date.now();
  if (_nowT - _trailLastAt < 30000) return; // cooldown 30s — réactivité maximale TP

  var _vp    = (state.tradeState && state.tradeState.virtualPosition) || {};
  var _entry = Number(_vp.entry || 0);
  var _sl    = Number(_vp.sl    || 0);
  var _tp    = Number(_vp.tp    || 0);
  var _dir   = String(_vp.direction || '').toUpperCase();
  var _px    = Number(state.price || 0);
  if (!_entry || !_sl || !_dir || !_px) return;

  var _isLong = _dir === 'LONG';
  var _slDist = Math.abs(_entry - _sl);
  // Règle: si pas de TP → utiliser 2R comme range proxy. BE = entrée. Trail = % de 2R.
  var _range  = _tp > 0 ? Math.abs(_tp - _entry) : (_slDist * 2);
  if (_range < 0.01 || _slDist < 0.01) return;

  var _pnlPct = _isLong
    ? (_px - _entry) / _range
    : (_entry - _px) / _range;
  if (_pnlPct <= 0.30) return; // pas encore à 30% du TP → attendre

  // ── ZONE APPROACH — trail immédiat si approche zone de retournement en profit ──
  var _bdTrail = state._lastBridgeData;
  var _inZoneReverse = _bdTrail && (
    (_isLong  && (_bdTrail.inTop === true || _bdTrail.zoneLiqHaute === true)) ||
    (!_isLong && (_bdTrail.inBot === true || _bdTrail.zoneLiqBasse === true))
  );
  var _pulsionContinues = _bdTrail && (
    (_isLong  && _bdTrail.bullRej === true) ||
    (!_isLong && _bdTrail.bearRej === true)
  );
  if (_inZoneReverse && _pnlPct >= 0.40) {
    var _zoneLockPct = Math.min(0.85, Math.max(0.55, _pnlPct * 0.85));
    var _zoneNewSl   = _isLong ? (_entry + _zoneLockPct * _range) : (_entry - _zoneLockPct * _range);
    var _zoneValid   = _isLong ? (_zoneNewSl > _sl + 0.30) : (_zoneNewSl < _sl - 0.30);
    if (_zoneValid && Math.abs(_zoneNewSl - _trailLastSl) >= 0.30) {
      _trailLastAt  = _nowT;
      _trailLastSl  = _zoneNewSl;
      var _zoneLbl  = _isLong ? 'zone résistance' : 'zone support';
      flowLog('TRAIL SL ZONE-APPROACH — ' + _zoneLbl + ' | pnl=' + Math.round(_pnlPct*100) + '% | newSl=' + _zoneNewSl.toFixed(5));
      speak('On approche une ' + _zoneLbl + '. Je serre le stop pour protéger le profit. Si le marché rebondit à ce niveau, on ressort avec les gains.');
      setCoachText('🎯 ZONE ' + (_isLong ? 'RÉSISTANCE' : 'SUPPORT') + ' — SL serré\nSL → ' + _zoneNewSl.toFixed(5) + ' | profit protégé', '#86efac', 7, 10000);
      try {
        await fetchJson('/coach/trade-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: state.symbol, timeframe: state.timeframe, mode: state.tradeMode,
            action: 'SET_SL', newSl: _zoneNewSl,
            trade: { direction: _dir, entry: _entry, sl: _sl, tp: _tp, source: 'trail-zone-approach' }
          })
        });
      } catch (_) {}
      return;
    }
  }

  // Niveaux trail : si pulsion continue (bullRej/bearRej), on laisse plus de marge = max TP
  // Sans pulsion : trail normal. Avec pulsion : trail léger pour ne pas couper l'impulsion.
  var _pulsionNow = _bdTrail && ((_isLong && _bdTrail.bullRej === true) || (!_isLong && _bdTrail.bearRej === true));
  var _levels = _pulsionNow
    ? [ // Pulsion active — trail très léger pour maximiser le TP
        { atPct: 0.90, lockPct: 0.65, lbl: 'lock 65% (pulsion)' },
        { atPct: 0.70, lockPct: 0.45, lbl: 'lock 45% (pulsion)' },
        { atPct: 0.45, lockPct: 0.20, lbl: 'lock 20% (pulsion)' },
        { atPct: 0.30, lockPct: 0.00, lbl: 'Break-Even'         }
      ]
    : [ // Pas de pulsion — trail classique
        { atPct: 0.85, lockPct: 0.72, lbl: 'lock 72% TP' },
        { atPct: 0.70, lockPct: 0.55, lbl: 'lock 55% TP' },
        { atPct: 0.50, lockPct: 0.35, lbl: 'lock 35% TP' },
        { atPct: 0.30, lockPct: 0.00, lbl: 'Break-Even'  }
      ];

  var _targetLockPct = null;
  var _lbl = '';
  for (var i = 0; i < _levels.length; i++) {
    if (_pnlPct >= _levels[i].atPct) {
      _targetLockPct = _levels[i].lockPct;
      _lbl           = _levels[i].lbl;
      break;
    }
  }
  if (_targetLockPct === null) return;

  // SL cible
  var _newSl = _isLong
    ? (_entry + _targetLockPct * _range)
    : (_entry - _targetLockPct * _range);

  // Ne reculer le SL sous aucun prétexte — uniquement avancer
  var _isBetter = _isLong ? (_newSl > _sl + 0.50) : (_newSl < _sl - 0.50);
  if (!_isBetter) return;
  // Éviter de re-poster le même niveau si déjà traité
  if (Math.abs(_newSl - _trailLastSl) < 0.50) return;

  // ── RÈGLE 1b — Extension TP URGENTE à 90% + bullRej/bearRej (trailing TP) ─
  // Si TP presque atteint (≥90%) ET le marché pousse encore → étendre le TP
  // Logique "à l'infini" : on réinitialise le flag quand le pct retombe sous 70%
  // Cela crée un trailing TP : chaque fois que le marché atteint 90% du nouveau TP, on repousse encore
  var _bdT     = state._lastBridgeData;
  var _pulsionOkTrail = _bdT && ((_isLong && _bdT.bullRej === true) || (!_isLong && _bdT.bearRej === true));
  if (_pnlPct >= 0.90 && _pulsionOkTrail && !_pc.tpUrgentExtended) {
    _pc.tpUrgentExtended = true;
    // Extension 100% du range — laisse le marché doubler son mouvement
    var _urgExt   = _range * 1.0;
    var _newTpUrgent = _isLong ? (_tp + _urgExt) : (_tp - _urgExt);
    flowLog('EXTENSION TP URGENTE — momentum confirmé | pnlPct=' + Math.round(_pnlPct*100) + '% | bullRej=' + _bdT.bullRej + ' | newTp=' + _newTpUrgent.toFixed(5));
    speak('TP presque atteint et le momentum continue. Je repousse l\'objectif plus loin. On ne coupe pas une impulsion forte. Je surveille le trailing stop.');
    setCoachText('🚀 TP REPOUSSÉ — MOMENTUM FORT\nNouveau TP: ' + fmtPrice(_newTpUrgent) + ' | Laisse courir', '#22c55e', 8, 25000);
    try {
      await fetchJson('/coach/trade-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: state.symbol, timeframe: state.timeframe, mode: state.tradeMode,
          action: 'SET_TP', newTp: _newTpUrgent,
          trade: { direction: _dir, entry: _entry, sl: _sl, tp: _tp, source: 'trail-tp-urgent-90pct' }
        })
      });
    } catch (_) {}
    return; // ne pas faire le trail SL en même temps
  }
  // Reset du flag pour permettre une nouvelle extension si le pct redescend sous 70%
  if (_pnlPct < 0.70) { _pc.tpUrgentExtended = false; }

  // ── RÈGLE 2 — Extension TP si pulsion forte (≥65% + impulse TF ou bullRej) ─
  // Utilise lectureTech du bridge (champs réels envoyés par Pine) — impulseScore/marketPulseScore jamais envoyés
  var _lt3Trail = _bdT ? String(_bdT.lectureTech3 || '').toUpperCase() : ''; // M15
  var _lt4Trail = _bdT ? String(_bdT.lectureTech4 || '').toUpperCase() : ''; // H1
  var _sc3Trail = _bdT ? Number(_bdT.scoreTech3 || 0) : 0;
  var _sc4Trail = _bdT ? Number(_bdT.scoreTech4 || 0) : 0;
  var _m15AlignedTrail = (_lt3Trail.includes(_isLong ? 'ACHAT' : 'VENTE') || _lt3Trail.includes(_isLong ? 'BUY' : 'SELL')) && _sc3Trail >= 50;
  var _h1AlignedTrail  = (_lt4Trail.includes(_isLong ? 'ACHAT' : 'VENTE') || _lt4Trail.includes(_isLong ? 'BUY' : 'SELL')) && _sc4Trail >= 50;
  var _canExtendTp = ((_m15AlignedTrail || _h1AlignedTrail) && _pulsionOkTrail && _pnlPct >= 0.50)
                  || (_pulsionOkTrail && (_sc3Trail >= 55 || _sc4Trail >= 55) && _pnlPct >= 0.50);

  if (_canExtendTp) {
    // Extension TP : plus le score est fort, plus on étend — MAX TP
    var _bestScore = Math.max(_sc3Trail, _sc4Trail);
    var _extMult   = _bestScore >= 70 ? 1.00 : _bestScore >= 55 ? 0.75 : 0.50;
    var _tpExtension = _range * _extMult;
    var _newTp = _isLong ? (_tp + _tpExtension) : (_tp - _tpExtension);
    var _tpExtLog = 'lectureTech3=' + _lt3Trail + ' scoreTech3=' + _sc3Trail + ' lectureTech4=' + _lt4Trail + ' scoreTech4=' + _sc4Trail + ' pnl=' + Math.round(_pnlPct * 100) + '% | extension +' + _tpExtension.toFixed(5);
    flowLog('EXTENSION TP — pulsion forte — ' + _tpExtLog);
    speak('Pulsion forte détectée. Je n\'ai aucune raison de couper maintenant. J\'étends le TP pour laisser le mouvement courir. Je surveille le trailing stop.');
    setCoachText('🚀 TP ÉTENDU +' + Math.round(_extMult*100) + '% RANGE\nM15 sc=' + _sc3Trail + ' H1 sc=' + _sc4Trail + ' | pnl=' + Math.round(_pnlPct*100) + '%', '#86efac', 6, 10000);
    try {
      await fetchJson('/coach/trade-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: state.symbol, timeframe: state.timeframe, mode: state.tradeMode,
          action: 'SET_TP', newTp: _newTp,
          trade: { direction: _dir, entry: _entry, sl: _sl, tp: _tp, source: 'trail-tp-extension' }
        })
      });
    } catch (_) {}
    // On n'applique pas le trail SL en même temps pour éviter les conflits de refresh
    return;
  }

  _trailLastAt = _nowT;
  _trailLastSl = _newSl;

  var _pnlLbl = Math.round(_pnlPct * 100) + '% du TP';
  var _trailLog = 'newSl=' + _newSl.toFixed(5) + ' pnl=' + Math.round(_pnlPct * 100) + '% | ' + _lbl;
  flowLog('TRAIL SL — ' + _lbl + ' — ' + _trailLog);
  speak('Ta position est à ' + _pnlLbl + ' de l\'objectif. Je déplace le stop en ' + _lbl + ' pour verrouiller les gains. Si le marché repart contre toi, tu es protégé. Je continue à surveiller.');
  setCoachText('📈 TRAIL — ' + _lbl + ' | ' + _pnlLbl + '\nSL → ' + _newSl.toFixed(5), '#86efac', 5, 8000);

  try {
    await fetchJson('/coach/trade-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: state.symbol, timeframe: state.timeframe, mode: state.tradeMode,
        action: 'SET_SL', newSl: _newSl,
        trade: { direction: _dir, entry: _entry, sl: _sl, tp: _tp, source: 'trail-stop' }
      })
    });
    await refreshAll();
  } catch (_) {}
}

// ── NEWS GUARD EN POSITION — protection capital avant publication HIGH impact ──
// Toutes les 2 min. Action par news unique (évite doublons sur même publication).
// LONG : bearRej = rejet haussier qui s'essouffle → SL rapproché.
// SHORT : bullRej = rejet baissier qui s'essouffle → SL rapproché.
// 3 cas selon PnL : profit (>0.5R) → BE+buffer / neutre (±0.3R) → SL réduit / perte → vocal seul.
async function checkNewsImpactDuringPosition() {
  if (!state.tradeState || !state.tradeState.entered) return;
  var _nowNP = Date.now();
  if (_nowNP - _newsPosLastAt < 120000) return; // toutes les 2 min
  _newsPosLastAt = _nowNP;

  try {
    var _nr = await fetchJson('/market-news');
    var _evts = (_nr && Array.isArray(_nr.events)) ? _nr.events : [];
    var _nowH = new Date();
    var _highEvt = null;

    _evts.forEach(function(ev) {
      if (ev.impact !== 'High') return; // HIGH impact uniquement en position
      if (!ev.date || !ev.time) return;
      var _dp = ev.date.split('-'); // MM-DD-YYYY
      var _tp = ev.time.match(/(\d+):(\d+)(am|pm)/i);
      if (!_dp || _dp.length < 3 || !_tp) return;
      var _hh = parseInt(_tp[1],10) + (_tp[3].toLowerCase()==='pm' && _tp[1]!=='12' ? 12 : 0);
      var _evDate = new Date(parseInt(_dp[2],10), parseInt(_dp[0],10)-1, parseInt(_dp[1],10), _hh, parseInt(_tp[2],10), 0);
      var _minLeft = (_evDate - _nowH) / 60000;
      // Fenêtre : news dans les 15 prochaines minutes (ou publication depuis moins de 2 min)
      if (_minLeft >= -2 && _minLeft <= 15 && !_highEvt) {
        _highEvt = ev;
        _highEvt._minLeft = Math.round(_minLeft);
      }
    });

    // News passée ou aucune — réinitialiser flag si la news précédente est terminée
    if (!_highEvt) {
      if (_newsPosActedOn) {
        _newsPosActedOn = '';
        speak('La news est passée. Je surveille la réaction du marché avant tout ajustement.');
        setCoachText('📰 NEWS PASSÉE — Surveillance réaction marché\nJe ne touche pas au setup avant confirmation technique.', '#94a3b8', 3, 8000);
      }
      return;
    }

    // Déjà agi sur cette news — ne pas répéter l'action
    if (_newsPosActedOn === _highEvt.title) return;

    // ── Lecture position ──────────────────────────────────────────────────
    var _vpN   = (state.tradeState && state.tradeState.virtualPosition) || {};
    var _entN  = Number(_vpN.entry || 0);
    var _slN   = Number(_vpN.sl    || 0);
    var _tpN   = Number(_vpN.tp    || 0);
    var _dirN  = String(_vpN.direction || '').toUpperCase();
    var _pxN   = Number(state.price || 0);
    if (!_entN || !_slN || !_dirN || !_pxN) return;

    var _isLongN = _dirN === 'LONG';
    var _1rN     = Math.abs(_entN - _slN);
    if (_1rN < 0.01) return;
    var _pnlPipsN = _isLongN ? (_pxN - _entN) : (_entN - _pxN);
    var _pnlRN    = _pnlPipsN / _1rN; // en R (1.0 = 1R de profit)

    var _newsLbl = _highEvt.title + ' dans ' + _highEvt._minLeft + ' min';
    _newsPosActedOn = _highEvt.title; // marquer comme traité pour cette news
    flowLog('NEWS POSITION — ' + _newsLbl + ' | pnlR=' + _pnlRN.toFixed(2) + ' dir=' + _dirN);

    if (_pnlRN >= 0.5) {
      // ── EN PROFIT (>0.5R) → SL au BE + buffer pour sécuriser le gain ──────
      // LONG : SL au-dessus de l'entrée. SHORT : SL en-dessous de l'entrée.
      var _nBufP = Math.max(_1rN * 0.10, 0.30);
      var _newSlP = _isLongN ? (_entN + _nBufP) : (_entN - _nBufP);
      var _validP = _isLongN ? (_newSlP > _slN) : (_newSlP < _slN);
      if (!_validP) {
        // SL déjà mieux positionné qu'on ne ferait — juste vocal
        speak('News ' + _highEvt.title + ' dans ' + _highEvt._minLeft + ' minutes. SL déjà bien positionné. Gain protégé. Je ne touche plus rien avant la publication.');
        setCoachText('📰 NEWS PROCHE — GAIN PROTÉGÉ\n' + _newsLbl, '#fde68a', 7, 12000);
        return;
      }
      speak('News ' + _highEvt.title + ' dans ' + _highEvt._minLeft + ' minutes. News haute impact. Je sécurise maintenant. Stop déplacé au break-even plus. Ton gain est protégé avant publication.');
      setCoachText('📰 JE SÉCURISE — ' + _newsLbl + '\nSL → BE+ | gain protégé', '#fde68a', 7, 12000);
      flowLog('NEWS SECURISE (profit ' + _pnlRN.toFixed(2) + 'R) | newSl=' + _newSlP.toFixed(5));
      try {
        await fetchJson('/coach/trade-action', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: state.symbol, timeframe: state.timeframe, mode: state.tradeMode,
            action: 'SET_SL', newSl: _newSlP,
            trade: { direction: _dirN, entry: _entN, sl: _slN, tp: _tpN, source: 'news-guard' }})
        });
        await refreshAll();
      } catch(_) {}

    } else if (_pnlRN > -0.3) {
      // ── POSITION NEUTRE (entre -0.3R et +0.5R) → SL rapproché, réduire risque ──
      // LONG : SL 25% du range sous le prix. SHORT : SL 25% du range au-dessus.
      var _nBufN = Math.max(_1rN * 0.25, 0.50);
      var _newSlN = _isLongN ? (_pxN - _nBufN) : (_pxN + _nBufN);
      var _validN = _isLongN ? (_newSlN > _slN) : (_newSlN < _slN);
      if (!_validN) {
        speak('News ' + _highEvt.title + ' dans ' + _highEvt._minLeft + ' minutes. Je réduis le risque avant publication. Stop déjà proche, je surveille sans agir.');
        setCoachText('📰 RISQUE RÉDUIT — ' + _newsLbl + '\nSL déjà solide', '#fde68a', 6, 12000);
        return;
      }
      speak('News ' + _highEvt.title + ' dans ' + _highEvt._minLeft + ' minutes. News haute impact. Je réduis le risque maintenant. Je rapproche le stop. La position reste ouverte mais le risque est limité.');
      setCoachText('📰 JE RÉDUIS LE RISQUE — ' + _newsLbl + '\nSL resserré | position neutre', '#fde68a', 7, 12000);
      flowLog('NEWS REDUIT_RISQUE (neutre ' + _pnlRN.toFixed(2) + 'R) | newSl=' + _newSlN.toFixed(5));
      try {
        await fetchJson('/coach/trade-action', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: state.symbol, timeframe: state.timeframe, mode: state.tradeMode,
            action: 'SET_SL', newSl: _newSlN,
            trade: { direction: _dirN, entry: _entN, sl: _slN, tp: _tpN, source: 'news-guard' }})
        });
        await refreshAll();
      } catch(_) {}

    } else {
      // ── EN PERTE (< -0.3R) → vocal uniquement — pas de sortie sans signal technique ──
      // Sortir en perte sur news = pire timing. Le SL en place protège déjà le maximum.
      speak('News ' + _highEvt.title + ' dans ' + _highEvt._minLeft + ' minutes. La position est en perte. Je ne bouge pas le stop pour éviter une sortie précipitée sur la news. Le SL en place protège déjà le maximum. Je surveille la réaction du marché après publication.');
      setCoachText('📰 SURVEILLANCE — ' + _newsLbl + '\nPerte | SL en place | pas de sortie panique', '#fde68a', 6, 12000);
      flowLog('NEWS SURVEILLANCE (perte ' + _pnlRN.toFixed(2) + 'R) | SL conservé');
    }
  } catch(_) { /* news check non bloquant si offline */ }
}

// ── MONITEUR NEWS LIVE — breaking news + tweets X en temps réel ──────────────
// Scrute /news toutes les 3 min. Détecte : macroWarning urgent, headlines fraîches
// (stars=5 = <30min), tweets X/Nitter. Une annonce par événement (déduplication titre).
// Si breaking HIGH : suspend entrées 15 min + trigger sécurisation position si besoin.
var _liveNewsMonitor  = null;
var _liveNewsSeenKeys = []; // FIFO max 50 clés — déduplication
var _liveNewsLastFetch = 0;
var _liveNewsCacheData = null;
var _liveNewsSuspend   = false; // bloque entrées watchdog après breaking news
var _liveNewsSuspendAt = 0;
var _liveNewsImminentKey = null;   // clé de la news imminente (< 5 min) — pour verdict après
var _liveNewsImminentPrice = null; // prix au moment de l'imminence — pour comparer après
var _liveNewsImminentAt = 0;       // timestamp imminence — pour déclencher verdict

async function _fetchNewsWithCache() {
  var _nowFn = Date.now();
  if (_liveNewsCacheData && (_nowFn - _liveNewsLastFetch) < 180000) return _liveNewsCacheData; // cache 3 min
  try {
    var _sym = state.symbol || 'XAUUSD';
    var _r = await fetchJson('/news?symbol=' + encodeURIComponent(_sym));
    if (_r && _r.ok !== false) { _liveNewsCacheData = _r; _liveNewsLastFetch = _nowFn; }
    return _liveNewsCacheData;
  } catch(_) { return _liveNewsCacheData; }
}

function _newsTrackKey(key) {
  var _k = String(key || '').substring(0, 50).toLowerCase().replace(/\s+/g,' ');
  if (_liveNewsSeenKeys.indexOf(_k) !== -1) return false;
  _liveNewsSeenKeys.push(_k);
  if (_liveNewsSeenKeys.length > 50) _liveNewsSeenKeys.shift();
  return true;
}

async function _checkLiveNews() {
  try {
    var _data = await _fetchNewsWithCache();
    if (!_data) return;

    var _inPos   = !!(state.tradeState && state.tradeState.entered);
    var _isArmed = !!state.armed;
    var _nowN    = Date.now();
    var _pxNow   = state.price || null;

    // ── 0. CALENDRIER ÉCONOMIQUE — avant / après verdict ─────────────────────
    // Lire les événements du calendrier pour annoncer avant et juger après
    var _calEvents = Array.isArray(state.newsEvents) ? state.newsEvents : [];
    _calEvents.forEach(function(ev) {
      if (!ev || !ev.title) return;
      var _evMins   = Number.isFinite(Number(ev.mins))         ? Number(ev.mins)
                    : Number.isFinite(Number(ev.minsUntil))    ? Number(ev.minsUntil)
                    : Number.isFinite(Number(ev.minutesAway))  ? Number(ev.minutesAway)
                    : null;
      if (_evMins === null) return;
      var _evImp  = String(ev.impact || ev.importance || '').toUpperCase();
      var _evHigh = _evImp === 'HIGH' || _evImp === '3' || _evImp === 'RED';
      var _evKey  = String(ev.title || '').substring(0, 40).toLowerCase();

      // AVANT — annonce 15-30 min avant (haute importance uniquement)
      if (_evHigh && _evMins > 0 && _evMins <= 30 && _evMins > 5) {
        var _beforeKey = 'before30:' + _evKey;
        if (_newsTrackKey(_beforeKey)) {
          var _bSpk = ev.title + ' dans ' + Math.round(_evMins) + ' minutes. '
            + 'News à fort impact. '
            + (_inPos ? 'Je sécurise si nécessaire selon la réaction.'
              : _isArmed ? 'Je reste en surveillance, entrée possible seulement après stabilisation.'
              : 'Je ne rentre pas 5 minutes avant — j\'attends la réaction.');
          speak(_bSpk);
          setCoachText('📅 NEWS IMMINENTE — ' + ev.title + '\nDans ' + Math.round(_evMins) + ' min — impact FORT', '#f97316', 6, 15000);
          flowLog('NEWS BEFORE — ' + ev.title + ' dans ' + Math.round(_evMins) + 'min');
        }
      }

      // IMMINENTE — enregistrer prix de référence pour verdict
      if (_evHigh && _evMins > 0 && _evMins <= 5) {
        var _immKey = 'imm:' + _evKey;
        if (!_liveNewsImminentKey || _liveNewsImminentKey !== _immKey) {
          _liveNewsImminentKey   = _immKey;
          _liveNewsImminentPrice = _pxNow;
          _liveNewsImminentAt    = _nowN;
          if (_newsTrackKey('imm5:' + _evKey)) {
            speak(ev.title + ' dans moins de 5 minutes. '
              + (_inPos ? 'Je surveille ta position — prêt à sécuriser si forte réaction.'
                : 'Entrée bloquée. J\'attends la réaction avant toute décision.'));
            _liveNewsSuspend = true; _liveNewsSuspendAt = _nowN;
          }
        }
      }
    });

    // APRÈS — verdict basé sur le mouvement de prix (annoncé 2-10 min après l'événement)
    if (_liveNewsImminentKey && _liveNewsImminentPrice && _pxNow
        && (_nowN - _liveNewsImminentAt) > 120000   // 2 min après l'imminence
        && (_nowN - _liveNewsImminentAt) < 600000   // et < 10 min
        && _newsTrackKey('verdict:' + _liveNewsImminentKey)) {
      var _pxDelta = _pxNow - _liveNewsImminentPrice;
      var _pxPct   = Math.abs(_pxDelta / _liveNewsImminentPrice * 100);
      var _verdict = _pxPct < 0.05 ? 'neutre — le marché n\'a pas bougé'
        : _pxDelta > 0 ? 'haussier — le prix est monté après la publication'
        : 'baissier — le prix est descendu après la publication';
      speak('La news est sortie. Verdict : ' + _verdict + '. '
        + (_inPos ? 'Je surveille ta position.' : 'Je réévalue les conditions d\'entrée.'));
      setCoachText('📊 VERDICT NEWS\n' + _verdict.toUpperCase(), _pxDelta > 0 ? '#22c55e' : _pxDelta < 0 ? '#ef4444' : '#94a3b8', 6, 15000);
      _liveNewsImminentKey = null; // reset pour la prochaine news
    }

    // ── 1. MACRO WARNING — événement calendrier urgent ──────────────────────
    var _macroWarn = _data.macroWarning || null;
    var _tradeSugg = String(_data.tradingSuggestion || '');
    if (_macroWarn && _newsTrackKey('macro:' + _macroWarn)) {
      _liveNewsSuspend = true; _liveNewsSuspendAt = _nowN;
      var _mwTxt = _macroWarn.replace(/^⚠️\s*/,'');
      var _mwSpk = 'Alerte macro détectée. ' + _mwTxt + '. Impact probable fort.';
      _mwSpk += _inPos  ? ' Je surveille ta position et je sécurise si nécessaire.'
              : _isArmed ? ' Je suspends l\'entrée. J\'attends la réaction du marché.'
              :             ' Je surveille l\'impact avant toute action.';
      speak(_mwSpk);
      setCoachText('🚨 ALERTE MACRO\n' + _mwTxt.substring(0,60), '#ef4444', 8, 20000);
      flowLog('MACRO ALERT — ' + _mwTxt);
      if (_inPos) setTimeout(function(){ checkNewsImpactDuringPosition().catch(function(){}); }, 1500);
    }

    // ── 2. HEADLINES FRAÎCHES (stars=5 = publiées < 30 min) ─────────────────
    var _heads = Array.isArray(_data.headlines) ? _data.headlines : [];
    _heads.forEach(function(h) {
      if (!h || !h.title || h.stars < 5) return;
      if (!_newsTrackKey('hl:' + h.title)) return;

      var _isX      = !!(h.source && (h.source.includes('nitter') || h.source.includes('twitter') || h.source.includes('x.com')));
      var _srcLbl   = _isX ? 'annonce externe X' : (h.source || 'presse web');
      var _highImp  = h.bias !== 'Neutral';
      var _impLbl   = _highImp ? 'impact probable fort' : 'impact limité';

      var _hSpk = (_isX ? 'Annonce urgente détectée, source externe X. ' : 'News fraîche détectée, ')
        + h.title.substring(0,90) + '. ' + _impLbl + '. ';
      _hSpk += _inPos
        ? (_highImp ? 'Je sécurise. Volatilité attendue.' : 'Impact faible. Je laisse courir mais je reste vigilant.')
        : _isArmed
        ? (_highImp ? 'Je suspends l\'entrée. J\'attends la stabilisation du marché.' : 'Je reste en surveillance, entrée possible si conditions réunies.')
        : 'Je surveille l\'impact sur le marché.';

      if (_highImp) { _liveNewsSuspend = true; _liveNewsSuspendAt = _nowN; }
      speak(_hSpk);
      setCoachText((_isX ? '🐦 ' : '📰 ') + (_highImp ? 'BREAKING' : 'NEWS') + ' — ' + _srcLbl + '\n' + h.title.substring(0,55),
        _highImp ? '#ef4444' : '#fde68a', _highImp ? 7 : 4, _highImp ? 18000 : 10000);
      flowLog('LIVE NEWS — ' + h.title.substring(0,80) + ' | src=' + _srcLbl + ' impact=' + _impLbl + ' inPos=' + _inPos);
      if (_inPos && _highImp) setTimeout(function(){ checkNewsImpactDuringPosition().catch(function(){}); }, 2000);
    });

    // ── 3. TWEETS X/NITTER — annonces urgentes sources externes ─────────────
    var _liveItems = Array.isArray(_data.news) ? _data.news : [];
    _liveItems.forEach(function(n) {
      if (!n || !n.title) return;
      var _isXn = n.source && (String(n.source).toLowerCase().includes('nitter') || String(n.source).toLowerCase().includes('x/'));
      if (!_isXn) return; // tweets uniquement ici (headlines = section 2)
      if (!_newsTrackKey('x:' + n.title)) return;

      var _xBias   = n.sentiment || 'Neutral';
      var _xHigh   = _xBias !== 'Neutral';
      var _xImpLbl = _xHigh ? 'impact potentiel fort' : 'impact limité';

      var _xSpk = 'Annonce urgente détectée, source externe. ' + n.title.substring(0,90) + '. ' + _xImpLbl + '. ';
      _xSpk += _inPos
        ? (_xHigh ? 'Je sécurise. Volatilité attendue.' : 'Impact limité. Je laisse courir.')
        : _isArmed
        ? (_xHigh ? 'Pas d\'entrée immédiate. J\'attends stabilisation.' : 'Je continue la surveillance.')
        : 'Impact potentiel sur le marché. Je surveille.';

      if (_xHigh) { _liveNewsSuspend = true; _liveNewsSuspendAt = _nowN; }
      speak(_xSpk);
      setCoachText('🐦 TWEET/ANNONCE EXTERNE\n' + n.title.substring(0,55),
        _xHigh ? '#ef4444' : '#fde68a', _xHigh ? 7 : 4, 15000);
      flowLog('X/TWEET — ' + n.title.substring(0,80) + ' | bias=' + _xBias + ' inPos=' + _inPos);
      if (_inPos && _xHigh) setTimeout(function(){ checkNewsImpactDuringPosition().catch(function(){}); }, 2000);
    });

    // ── Auto-release suspend après 15 min ────────────────────────────────────
    if (_liveNewsSuspend && (_nowN - _liveNewsSuspendAt) > 900000) {
      _liveNewsSuspend = false;
      if (_isArmed || _inPos) {
        speak('La période de volatilité liée à la news est passée. Le marché s\'est stabilisé. Je reprends la surveillance normale.');
        flowLog('NEWS SUSPEND — released 15min');
      }
    }
  } catch(_) { /* non bloquant si offline */ }
}

function startLiveNewsMonitor() {
  if (_liveNewsMonitor) return; // déjà actif
  // Premier check après 10s (laisse le bridge s'initialiser)
  setTimeout(function() { _checkLiveNews().catch(function(){}); }, 10000);
  // Puis toutes les 90s (assez réactif pour les verdicts et avant-news)
  _liveNewsMonitor = setInterval(function() { _checkLiveNews().catch(function(){}); }, 90000);
}

function stopLiveNewsMonitor() {
  if (_liveNewsMonitor) { clearInterval(_liveNewsMonitor); _liveNewsMonitor = null; }
}

// ── CONTEXTE H4 PENDANT POSITION — vision large pour gestion TP/trail ────────
// H4 n'est JAMAIS utilisé pour entrer en position.
// En position uniquement : évaluer le potentiel restant, identifier zones larges.
// Cooldown 5 min — vocal + log à chaque changement significatif.
var _h4CheckLastAt = 0;

async function checkH4ContextDuringPosition() {
  if (!state.tradeState || !state.tradeState.entered) return;
  var _nowH4 = Date.now();
  if (_nowH4 - _h4CheckLastAt < 300000) return; // toutes les 5 min max

  var _vp4    = (state.tradeState && state.tradeState.virtualPosition) || {};
  var _dir4   = String(_vp4.direction || '').toUpperCase();
  var _isLong4 = _dir4 === 'LONG';

  // ── Lecture snapshot H4 (stocké par ANALYSER dans state._lastSnapshots) ──
  var _snaps = state._lastSnapshots || [];
  var _h4Snap = null;
  for (var i = 0; i < _snaps.length; i++) {
    if (_snaps[i] && _snaps[i].tf === 'H4') { _h4Snap = _snaps[i]; break; }
  }
  if (!_h4Snap || !_h4Snap.rec || _h4Snap.rec === 'WAIT' || _h4Snap.rec === 'N/A') {
    // Pas de données H4 disponibles (ANALYSER pas encore lancé ou H4 neutre)
    return;
  }

  _h4CheckLastAt = _nowH4;

  var _h4Rec   = String(_h4Snap.rec || '').toUpperCase();
  var _h4Str   = Number(_h4Snap.strength || 50);
  var _h4Rsi   = Number(_h4Snap.rsiRaw || 0);
  var _h4IsLong  = _h4Rec.includes('BUY')  || _h4Rec.includes('LONG');
  var _h4IsShort = _h4Rec.includes('SELL') || _h4Rec.includes('SHORT');

  // ── Zones bridge (proximité zone forte H4-compatible) ─────────────────
  var _bdH4   = state._lastBridgeData;
  var _inTopH4 = _bdH4 ? (_bdH4.inTop === true || _bdH4.zoneLiqHaute === true) : false;
  var _inBotH4 = _bdH4 ? (_bdH4.inBot === true || _bdH4.zoneLiqBasse  === true) : false;
  // Zone "adverse" à la position (résistance pour LONG, support pour SHORT)
  var _nearAdverseZone = (_isLong4 && _inTopH4) || (!_isLong4 && _inBotH4);

  // Zones de liquidité larges du snapshot H4
  var _h4LiqHigh = _h4Snap.zones ? Number(_h4Snap.zones.liqHigh || 0) : 0;
  var _h4LiqLow  = _h4Snap.zones ? Number(_h4Snap.zones.liqLow  || 0) : 0;
  var _px4 = Number(state.price || 0);
  var _h4ZoneNear = false;
  if (_px4 > 0) {
    var _distHigh = _h4LiqHigh > 0 ? Math.abs(_px4 - _h4LiqHigh) / _px4 : 1;
    var _distLow  = _h4LiqLow  > 0 ? Math.abs(_px4 - _h4LiqLow)  / _px4 : 1;
    // Zone H4 considérée "proche" si prix à moins de 0.5% de la liquidité adverse
    if (_isLong4  && _h4LiqHigh > 0 && _distHigh < 0.005) _h4ZoneNear = true;
    if (!_isLong4 && _h4LiqLow  > 0 && _distLow  < 0.005) _h4ZoneNear = true;
  }

  var _h4Aligned  = (_isLong4 && _h4IsLong)  || (!_isLong4 && _h4IsShort);
  var _h4Against  = (_isLong4 && _h4IsShort) || (!_isLong4 && _h4IsLong);

  var _h4Log = 'H4=' + _h4Rec + ' force=' + _h4Str + '%'
    + (_h4Rsi > 0 ? ' RSI=' + Math.round(_h4Rsi) : '')
    + (_h4LiqHigh > 0 ? ' liqH=' + _h4LiqHigh.toFixed(2) : '')
    + (_h4LiqLow  > 0 ? ' liqL=' + _h4LiqLow.toFixed(2)  : '')
    + ' zoneAdverse=' + _nearAdverseZone
    + ' liqProche=' + _h4ZoneNear;

  flowLog('H4 CONTEXT — ' + _h4Log);

  if (_h4Against || _h4ZoneNear || _nearAdverseZone) {
    var _h4WarnReason = _h4Against ? 'H4 se retourne (' + _h4Rec + ')' : _h4ZoneNear ? 'Liquidité H4 proche' : 'Zone H4 atteinte';
    var _h4WarnSpeak = _h4Against
      ? 'Vision large H4 dégradée. ' + _h4WarnReason + '. Je ne sors pas encore, mais je maintiens le trailing stop serré. Si M15 ou H1 confirment, je sécurise ou je sors.'
      : 'Attention. ' + _h4WarnReason + '. Une zone importante H4 approche. Je sécurise le trailing stop. Si M15 ou H1 confirment le retournement, je prépare la sortie.';
    speak(_h4WarnSpeak);
    setCoachText('⚠️ H4 — ' + _h4WarnReason + '\nTrail SL serré | attente M15/H1', '#fde68a', 5, 15000);
  } else if (_h4Aligned) {
    speak('H4 confirme la direction, force ' + _h4Str + '%. Le mouvement a encore du potentiel. Je laisse courir. Je gère uniquement le trailing stop. Pas de sortie précipitée.');
    setCoachText('📊 H4 CONFIRME | force ' + _h4Str + '%\nLaisser courir — trail SL uniquement', '#86efac', 3, 12000);
  }
}

var _refreshInFlight = false;
var _lastRefreshAt = 0;
// ─── PROCHAINE OPPORTUNITÉ — jauge "dans combien de temps le prochain setup" ─
// Lit le bridge + les récheck times du watchdog pour estimer l'ETA du prochain setup.
// Ne touche pas aux fonctions trading — lecture seule.
function renderNextOpportunity() {
  var _nOppBar  = document.getElementById('nextOppBar');
  var _nOppStat = document.getElementById('nextOppStatus');
  var _nOppEta  = document.getElementById('nextOppEta');
  var _nOppWrap = document.getElementById('nextOppWrap');
  if (!_nOppBar || !_nOppStat) return;

  // Masquer si position active (inutile quand déjà en trade)
  if (state.tradeState && state.tradeState.entered) {
    if (_nOppWrap) _nOppWrap.style.display = 'none';
    return;
  }
  if (_nOppWrap) _nOppWrap.style.display = '';

  var _bd  = state._lastBridgeData;
  var _rct = state._wdRecheckTimes || {}; // { m5, m15, h1 } — minutes to next recheck
  var _sym = state.symbol || 'XAUUSD';

  // ── SCORE DE MATURITÉ — combien de conditions sont déjà vertes ───────────
  // 0 = rien / 100 = setup imminent
  var _matScore = 0;

  // 1. Direction H1 lisible (+20)
  var _lt4 = String((_bd && _bd.lectureTech4) || '').toUpperCase();
  if (_lt4.includes('ACHAT') || _lt4.includes('VENTE')) _matScore += 20;

  // 2. M15 en setup direction (+20)
  var _lt3 = String((_bd && _bd.lectureTech3) || '').toUpperCase();
  var _isLongNow = _lt4.includes('ACHAT');
  var _m15SetNow = _isLongNow ? (_lt3.includes('ACHAT') && !_lt3.includes('NEUTRE')) : (_lt3.includes('VENTE') && !_lt3.includes('NEUTRE'));
  if (_m15SetNow) _matScore += 20;

  // 3. M5 confirmé (+15)
  var _lt2 = String((_bd && _bd.lectureTech2) || '').toUpperCase();
  var _m5ConfNow = _isLongNow ? (_lt2.includes('ACHAT') && !_lt2.includes('NEUTRE')) : (_lt2.includes('VENTE') && !_lt2.includes('NEUTRE'));
  if (_m5ConfNow) _matScore += 15;

  // 4. Zone atteinte inTop/inBot (+25)
  var _inBotNow2 = _bd && !!_bd.inBot;
  var _inTopNow2 = _bd && !!_bd.inTop;
  var _zoneNow   = _isLongNow ? _inBotNow2 : _inTopNow2;
  if (_zoneNow) _matScore += 25;

  // 5. Impulse M15 fort (+10)
  var _impM15now = Number((_bd && _bd.impulseScoreTf3) || 0);
  if (_impM15now > 55) _matScore += 10;

  // 6. RSI M15 pas au milieu (excès → retournement probable) (+10)
  var _rsiM15now = Number((_bd && _bd.rsiTf3) || 0);
  if (_rsiM15now > 68 || (_rsiM15now > 0 && _rsiM15now < 32)) _matScore += 10;

  _matScore = Math.min(99, _matScore);

  // ── GUARD MILIEU DU RANGE — RÈGLE FONDAMENTALE ──────────────────────────────
  // Si ni inTop ni inBot → le prix est au milieu → JAMAIS proposer un setup
  var _isMidRange = _bd && !_bd.inTop && !_bd.inBot && (_bLiqH > 0 && _bLiqL > 0);
  var _pxNowOpp   = Number(state.price || 0);
  if (_isMidRange && _pxNowOpp > 0 && _bLiqH > 0 && _bLiqL > 0) {
    var _midPct = (_pxNowOpp - _bLiqL) / (_bLiqH - _bLiqL);
    _isMidRange = _midPct > 0.25 && _midPct < 0.75; // vrai milieu = entre 25% et 75% du range
  }

  // ── MODE-AWARE CONDITIONS ────────────────────────────────────────────────────
  var _modeOpp = (state.tradeMode || 'AUTO').toUpperCase();
  // SWING nécessite H1 lisible
  if (_modeOpp === 'SWING' && !_lt4.includes('ACHAT') && !_lt4.includes('VENTE')) _matScore = Math.min(_matScore, 15);
  // SNIPER: M15 non bloquant — booster si M5+zone (sans M15)
  if ((_modeOpp === 'SNIPER' || _modeOpp === 'SNIPER_AGRESSIF') && _m5ConfNow && _zoneNow) _matScore = Math.min(99, _matScore + 15);
  // Milieu du range → bloquer tout setup
  if (_isMidRange) _matScore = Math.min(10, _matScore);

  // ── ETA ESTIMATION — basé sur le TF bloquant principal ────────────────────
  var _etaMinRaw = 0;
  var _etaLabel  = '';
  if (_isMidRange) {
    _etaLabel = 'Prix au milieu du range — j\'attends les extrêmes';
  } else if (_matScore >= 90) {
    _etaMinRaw = 0;
    _etaLabel  = 'IMMINENT';
  } else if (!_m15SetNow && !_m5ConfNow) {
    _etaMinRaw = Number(_rct.m15 || 15);
    _etaLabel  = (_modeOpp === 'SWING' ? 'H1+M15 requis' : 'M15+M5 requis') + ' — ' + _etaMinRaw + 'min';
  } else if (_m15SetNow && !_m5ConfNow) {
    _etaMinRaw = Number(_rct.m5 || 5);
    _etaLabel  = 'M5 requis — ' + _etaMinRaw + 'min';
  } else if (!_zoneNow && _m15SetNow && _m5ConfNow) {
    _etaLabel = 'Zone à atteindre — surveillance prix';
    _etaMinRaw = 0;
  } else if (_zoneNow && _m15SetNow && _m5ConfNow) {
    _etaMinRaw = 1;
    _etaLabel  = 'Pulsion M1 requise — < 1min';
  } else {
    _etaMinRaw = Number(_rct.h1 || 60);
    _etaLabel  = 'H1 requis — ' + _etaMinRaw + 'min';
  }

  // ── RENDU ─────────────────────────────────────────────────────────────────
  _nOppBar.style.width = _matScore + '%';
  // Couleur : vert si proche, bleu sinon
  _nOppBar.className = 'nopp-bar-fill' + (_matScore >= 80 ? ' close' : '');
  if (_nOppEta) _nOppEta.textContent = _etaMinRaw > 0 ? '~' + _etaMinRaw + 'min' : _matScore >= 90 ? 'maintenant' : '—';

  var _dirStr = !(_lt4.includes('ACHAT') || _lt4.includes('VENTE')) ? 'direction inconnue'
    : (_isLongNow ? 'LONG' : 'SHORT');
  if (_isMidRange) {
    _nOppStat.textContent = '⏸ MILIEU RANGE — on n\'entre jamais ici. J\'attends les extrêmes.';
    _nOppStat.style.color = '#475569';
    _nOppBar.style.width  = '5%';
    _nOppBar.className    = 'nopp-bar-fill';
    if (_nOppEta) _nOppEta.textContent = '—';
  } else if (_matScore < 20) {
    _nOppStat.textContent = '🔍 Pas de contexte clair — en veille (' + _modeOpp + ')';
    _nOppStat.style.color = '#475569';
  } else if (_matScore < 50) {
    _nOppStat.textContent = '📡 Contexte ' + _dirStr + ' en formation — ' + _etaLabel;
    _nOppStat.style.color = '#64748b';
  } else if (_matScore < 75) {
    _nOppStat.textContent = '🟡 Approche ' + _dirStr + ' (' + _modeOpp + ') — ' + _etaLabel;
    _nOppStat.style.color = '#d97706';
  } else if (_matScore < 90) {
    _nOppStat.textContent = '🟢 PROCHE — ' + _dirStr + ' validé. ' + _etaLabel;
    _nOppStat.style.color = '#22c55e';
  } else {
    _nOppStat.textContent = '⚡ IMMINENT ' + _dirStr + ' — cliquez ANALYSER maintenant';
    _nOppStat.style.color = '#f97316';
  }
}

async function refreshAll() {
  // Guard: éviter les appels concurrents (multiple SSE events ou timer+SSE en même temps)
  if (_refreshInFlight) return;
  // Guard: limiter à 1 refresh max toutes les 2s pour éviter le flickering
  var _now = Date.now();
  if (_now - _lastRefreshAt < 2000) return;
  _refreshInFlight = true;
  _lastRefreshAt = _now;
  try {
  if (state.bridgeConfig.bridgeEnabled === false) {
    renderBridgeOffState();
    return;
  }

  // SÉCURITÉ BRIDGE — désarmer si bridge stale > 30s et pas de position active
  // refreshAll est appelé toutes les 2-3s — ce guard couvre le cas watchdog non actif
  var _raBridgeAgeMs = state._lastBridgeDataAt ? (Date.now() - state._lastBridgeDataAt) : Infinity;
  if (_raBridgeAgeMs > 30000 && state.armed && !(state.tradeState && state.tradeState.entered)) {
    if (typeof disarmRobot === 'function') {
      disarmRobot('Bridge TV coupé — désarmement sécurité (refreshAll).');
    }
  }

  if (!state.agentSessionActive) {
    // Si une position est active (auto-watchdog ou reload), on ne bloque pas — on doit
    // afficher le panel position et rester connecté au coach quoi qu'il arrive
    var _hasActivePosition = !!(state.tradeState && state.tradeState.entered);
    if (!_hasActivePosition) {
      try {
        await loadMirrorSnapshot();
        setConn('ONLINE', 'ok');
      } catch (_) {
        setConn('RETRY', 'warn');
        flowLog('MIRROR SNAPSHOT RETRY', { symbol: state.symbol, timeframe: state.timeframe });
      }

      var sig = $('signalText'); if (sig) { sig.textContent = 'ATTENTE'; sig.className = 'signal wait'; }
      var an = $('analysisText'); if (an) an.textContent = 'Session agent inactive. Cliquez ANALYSER pour lancer une analyse réelle.';
      setCoachText('Coach inactif. Cliquez ENTRER après validation pour activer le suivi live.', '#cbd5e1', 1, 6000);
      var next = $('dg-nextaction'); if (next) next.textContent = 'Prochaine action : ANALYSER';
      // RÈGLE: ENTRER n'est bloqué que si position ARM/ACTIVE — pas sur simple inactivité session
      // Ne pas forcer disabled ici — renderDecision gérera l'état selon la position réelle
      return;
    }
    // Position active → forcer agentSessionActive=true pour que le reste du flow s'exécute
    state.agentSessionActive = true;
    scheduleSaveState();
  }

  try {
    await loadRealtimePack();
    setConn('ONLINE', 'ok');
  } catch (e) {
    state.conn.healthFails = Number(state.conn.healthFails || 0) + 1;
    markConnectionTransientFail();
    flowLog('API RETRY /coach/realtime', {
      symbol: state.symbol,
      timeframe: state.timeframe,
      mode: state.tradeMode,
      error: e && e.message ? e.message : 'unknown'
    });
  }
  renderBiasBanner(state.live, state.newsEvents);
  renderPositionPanel(state.live, state.price);

  // ── SYNC BANNER ARMÉ + BOUTON ENTRER ─────────────────────────────────────
  var _tsPhase = String((state.tradeState && state.tradeState.phase) || '').toUpperCase();
  var _eb = document.querySelector('[data-action="ENTER"]');
  var _febEl = document.getElementById('futureEntryBanner');
  if (state.tradeState && state.tradeState.entered) {
    // Position active — désarmer si watchdog encore en cours
    if (_entryWatchdog) { stopEntryWatchdog(); state.armed = false; }
    renderArmedBanner('off', {}, {});
    if (_febEl) _febEl.style.display = 'none'; // masqué quand position active
    if (_eb && !_eb.disabled) { _eb.style.cssText = ''; _eb.textContent = '▶ ENTRER'; }
    // ── COACH STREAM GUARD — ne jamais lâcher le coach pendant un trade ──────
    if (!coachSse || coachSse.readyState === EventSource.CLOSED) {
      connectCoachStream(state.symbol);
    }
    checkReversalRiskDuringPosition().catch(function(){});
    trailStopLossDuringPosition().catch(function(){});
    checkH4ContextDuringPosition().catch(function(){});
    checkNewsImpactDuringPosition().catch(function(){});
    startLiveNewsMonitor();
  } else if (state.armed || _tsPhase === 'ARMED') {
    _hideSetupProposal();
    // futureEntryBanner géré par renderFutureEntryBanner (direction/setup affiché quand armé)
    if (_eb) { _eb.style.cssText = 'background:#d97706;color:#000;font-weight:700;font-size:11px;'; _eb.textContent = '🤖 LIA SURVEILLE — ANNULER'; }
    if (!_entryWatchdog) { startEntryWatchdog(); }
  } else {
    renderArmedBanner('off', {}, {});
    if (_eb && !_eb.disabled && (_eb.textContent.includes('ANNULER') || _eb.textContent.includes('SURVEILLE'))) {
      _eb.style.cssText = ''; _eb.textContent = '▶ ENTRER';
    }
  }
  renderBridgeHealth();
  renderNextOpportunity();
  } catch(_rfErr) { /* erreur silencieuse — ne pas casser l'UI */ }
  finally { _refreshInFlight = false; }
}

// ─── COACH NARRATIVE ──────────────────────────────────────────────────────────
// buildCoachNarrative — narrative LIA "expliquer POURQUOI" après ANALYSER
// Chaque message = Contexte (pourquoi) + Action (quoi) + Condition (quand)
// snapshots = array of { tf, rec, strength, directional, reason, riskLevel, entry, sl, tp }
function buildCoachNarrative(bestTf, snapshots) {
  var lines = [];
  var ts = snapshots || [];

  var _modeNow = String(state.tradeMode || 'AUTO').toUpperCase();
  var _modeTFMap = {
    SCALPER: { tfs: 'M1·M5·M15', desc: 'Rapide — spread critique' },
    SNIPER:  { tfs: 'M5·M15·H1', desc: 'Timing précis' },
    SWING:   { tfs: 'M15·H1·H4', desc: 'Mouvements larges' },
    AUTO:    { tfs: 'M1→D1', desc: 'Toutes unités de temps' }
  };
  var _modeInfo = _modeTFMap[_modeNow] || _modeTFMap.AUTO;

  var longTFs  = ts.filter(function(s){ return s.rec.includes('BUY') || s.rec.includes('LONG'); });
  var shortTFs = ts.filter(function(s){ return s.rec.includes('SELL') || s.rec.includes('SHORT'); });
  var neutTFs  = ts.filter(function(s){ return !s.directional; });
  var total = ts.length || 1;

  var _liveSnap = (state.live && state.live.coach && state.live.coach.analysisSnapshot) || {};
  var _srcSum   = _liveSnap.sourceSummary || {};
  var _bStats   = (state.live && state.live.coach && state.live.coach.signal && state.live.coach.signal.stats) || {};
  var _rsiM15   = Number(_bStats.rsi_m15 || 0);
  var _rsiH1    = Number(_bStats.rsi_h1  || 0);
  var _force    = Number(_bStats.force || _bStats.strength || 0);
  var _hasConflict = !!_srcSum.conflictDetected;

  var winner = bestTf ? ts.find(function(s){ return s.tf === bestTf; }) : null;
  var _hasWinner = !!(winner && winner.directional);

  var fmtLvl = function(v) { return v > 1000 ? Number(v).toFixed(2) : Number(v).toFixed(5); };

  // ─── CONTEXTE MARCHÉ PRO (7 étapes) ───────────────────────────────────────
  var _priceHist = state._priceHistory || [];
  var _mktCtx = analyzeMarketContext(ts, _bStats, _priceHist);
  // Ajouter le bloc contexte en haut du message
  var _ctxIcons = {
    COMPRESSION: '📦', IMPULSE: '💥', RETOURNEMENT: '🔁', TRAP: '⚠️',
    HAUSSIER: '📈', BAISSIER: '📉', CONFLIT: '⚡', NEUTRE: '⏸️'
  };
  var _ctxKey = _mktCtx.context.split('_')[0];
  var _ctxIcon = _ctxIcons[_ctxKey] || '🔍';
  lines.push(_ctxIcon + ' CONTEXTE: ' + _mktCtx.context.replace('_',' '));
  _mktCtx.labels.forEach(function(l) { lines.push('  ' + l); });
  lines.push('');

  // Si winner trouvé, arrêter la surveillance continue
  if (_hasWinner) stopContinuousScan();

  // ─── NEWS CHECK — filtre obligatoire avant toute entrée ───────────────────
  var _newsCheck = checkNewsBlockEntry();
  var _newsLine = buildNewsCoachLine();
  if (_newsLine) {
    lines.push('Calendrier: ' + _newsLine);
    lines.push('');
  }
  // Si news bloque — afficher AVANT le verdict et bloquer l'entrée
  if (_newsCheck.blocked) {
    lines.push('NEWS — ENTREE BLOQUEE');
    lines.push(_newsCheck.reason);
    lines.push(_newsCheck.afterWait || 'Attends la réaction puis entre proprement.');
    lines.push('');
    lines.push('Règle pro: les news créent le mouvement, la structure donne la direction.');
    lines.push('[Mode ' + _modeNow + ' | ' + _modeInfo.tfs + ']');
    // Vocaliser le blocage
    if (!state.muted) speak(_newsCheck.reason.split('.')[0] + '. Ne pas entrer maintenant.');
    return lines.join('\n');
  }
  if (_newsCheck.warning) {
    lines.push('Attention news: ' + _newsCheck.reason);
    lines.push('');
  }

  // ─── CAS 1: CONFLIT — blocage explicite ────────────────────────────────────
  if (_hasConflict) {
    lines.push('CONFLIT — je ne force pas.');
    lines.push('');
    var _cL = longTFs.map(function(s){ return s.tf; }).join(', ');
    var _cS = shortTFs.map(function(s){ return s.tf; }).join(', ');
    if (_cL && _cS) {
      lines.push(_cL + ' en LONG vs ' + _cS + ' en SHORT — non résolu.');
    }
    lines.push('Signal attendu: résolution franche sur H1 ou cassure M15.');
    lines.push('');
    lines.push('Un vrai trader attend la clarté. Patienter > forcer.');
    lines.push('');
    lines.push('[Mode ' + _modeNow + ' | ' + _modeInfo.tfs + ']');
    return lines.join('\n');
  }

  // ─── CAS 2: SETUP VALIDÉ — expliquer POURQUOI on entre ────────────────────
  if (_hasWinner) {
    var winDir = (winner.rec.includes('BUY') || winner.rec.includes('LONG')) ? 'LONG' : 'SHORT';
    var conf = winner.strength ? winner.strength + '%' : '--';

    // ── VÉRIFICATION SERVEUR — canEnter est la source de vérité pour l'entrée réelle ──
    // Si le serveur bloque (zone absente, structure neutre, RSI, R:R...) → ne pas dire "J'entre"
    // C'est la cause principale de la contradiction vocal/action.
    var _srvExec = (state.live && state.live.execution) || (state.live && state.live.coach && state.live.coach.execution) || {};
    var _srvCanEnter = _srvExec.canEnter === true;
    var _srvBlockReason = _srvExec.reason || '';
    var _srvConflicts = (_liveSnap.sourceSummary && _liveSnap.sourceSummary.conflictReasons) || [];
    var _mainSrvBlock = _srvConflicts.length > 0
      ? _srvConflicts[0].split('—')[0].trim().substring(0, 100)
      : (_srvBlockReason.split('|')[0].trim().substring(0, 100));

    // Signal TF trouvé mais serveur bloque → afficher le blocage EXACTEMENT, pas "J'entre"
    if (!_srvCanEnter && _mainSrvBlock) {
      lines.push('Setup ' + winDir + ' détecté sur ' + winner.tf + ' — ENTRÉE BLOQUÉE:');
      lines.push('');
      lines.push('⛔ ' + _mainSrvBlock);
      if (_srvConflicts.length > 1) {
        lines.push('+ ' + (_srvConflicts.length - 1) + ' condition(s) supplémentaire(s)');
      }
      lines.push('');
      var _bdNow = state._lastBridgeData;
      if (_bdNow) {
        var _zoneStr = _bdNow.inBot === true ? 'Zone BASSE' : _bdNow.inTop === true ? 'Zone HAUTE' : 'Hors zone (milieu)';
        var _structStr = _bdNow.bullRej ? 'rejet haussier' : _bdNow.bearRej ? 'rejet baissier' : _bdNow.anticipationTexte && _bdNow.anticipationTexte !== 'RAS' ? _bdNow.anticipationTexte.replace('_', ' ') : 'structure neutre';
        lines.push('Bridge: ' + _zoneStr + ' | ' + _structStr);
      }
      if (winner.entry) {
        lines.push('Niveaux: E ' + fmtLvl(winner.entry)
          + (winner.sl ? '  SL ' + fmtLvl(winner.sl) : '')
          + (winner.tp ? '  TP ' + fmtLvl(winner.tp) : ''));
      }
      lines.push('[Mode ' + _modeNow + ' — attente condition serveur]');
      return lines.join('\n');
    }

    lines.push('J\'entre ' + winDir + ' sur ' + winner.tf + ' parce que:');
    lines.push('');

    // Contexte (H1/H4) — pourquoi la direction est claire macro
    var _ctxL = longTFs.filter(function(s){ return s.tf==='H1'||s.tf==='H4'; });
    var _ctxS = shortTFs.filter(function(s){ return s.tf==='H1'||s.tf==='H4'; });
    if (winDir === 'LONG' && _ctxL.length > 0) {
      var _h1MomL = _rsiH1 > 70 ? ' — en excès' : _rsiH1 > 0 && _rsiH1 < 30 ? ' — en survente' : '';
      lines.push('• Contexte ' + _ctxL.map(function(s){return s.tf;}).join('/') + ' haussier' + _h1MomL);
    } else if (winDir === 'SHORT' && _ctxS.length > 0) {
      var _h1MomS = _rsiH1 > 70 ? ' — en excès' : _rsiH1 > 0 && _rsiH1 < 30 ? ' — en survente' : '';
      lines.push('• Contexte ' + _ctxS.map(function(s){return s.tf;}).join('/') + ' baissier' + _h1MomS);
    }

    // Validation (M15) — pourquoi la structure confirme
    var _valM15 = ts.find(function(s){ return s.tf === 'M15'; });
    if (_valM15 && _valM15.directional) {
      var _v15dir = (_valM15.rec.includes('BUY')||_valM15.rec.includes('LONG')) ? 'aligné haussier' : 'aligné baissier';
      var _m15Mom = _rsiM15 > 70 ? ' — en excès' : _rsiM15 > 0 && _rsiM15 < 30 ? ' — en survente' : '';
      lines.push('• M15 ' + _v15dir + _m15Mom);
    }

    // Entrée TF — pourquoi ce TF précis
    lines.push('• TF d\'entrée ' + winner.tf + ' — confiance ' + conf);

    // Momentum M15 — context haussier/baissier sans valeur brute
    if (_rsiM15 > 0) {
      var _rsiOk = winDir === 'LONG' ? _rsiM15 < 70 : _rsiM15 > 30;
      var _rsiTxt = winDir === 'LONG'
        ? (_rsiM15 < 70 ? 'momentum favorable' : 'momentum étiré — attention')
        : (_rsiM15 > 30 ? 'momentum favorable' : 'momentum étiré — attention');
      lines.push('• Momentum M15 — ' + _rsiTxt + (_rsiOk ? ' ✓' : ' ⚠️'));
    }

    // Force — pourquoi l'impulsion est suffisante
    if (_force > 0) {
      lines.push('• Force ' + Math.round(_force) + '% — '
        + (_force >= 55 ? 'impulsion suffisante ✓' : 'signal faible — surveiller ⚠️'));
    }

    // Niveaux précis
    if (winner.entry) {
      lines.push('');
      lines.push('Entrée: ' + fmtLvl(winner.entry)
        + (winner.sl ? '   SL: ' + fmtLvl(winner.sl) : '')
        + (winner.tp ? '   TP: ' + fmtLvl(winner.tp) : ''));
      if (winner.sl && winner.tp) {
        var _rrRaw = Math.abs(winner.tp - winner.entry) / Math.abs(winner.entry - winner.sl);
        if (_rrRaw > 0) lines.push('R:R = 1:' + _rrRaw.toFixed(1));
      }
    }

    lines.push('');
    lines.push(state.armed
      ? '→ Robot armé — surveillance active. J\'entre automatiquement au bon moment.'
      : '→ Appuie sur ENTRER si tu es disponible.');
    lines.push('[Mode ' + _modeNow + ' | ' + _modeInfo.tfs + ']');
    return lines.join('\n');
  }

  // ─── CAS 3: ATTENTE — expliquer POURQUOI on n'entre pas ───────────────────
  var _blockReason = '';
  var _waitCond = '';

  if (neutTFs.length === total) {
    _blockReason = 'aucun TF directionnel — range/consolidation';
    _waitCond = 'bougie de cassure franche sur M15 ou H1';
  } else if (longTFs.length > 0 && shortTFs.length > 0) {
    _blockReason = longTFs.map(function(s){return s.tf;}).join('+') + ' (LONG) vs '
      + shortTFs.map(function(s){return s.tf;}).join('+') + ' (SHORT)';
    _waitCond = 'alignement H1 et M15 dans la même direction';
  } else {
    // Alignement partiel — contexte ok mais entrée pas encore confirmée
    var _pendDir = longTFs.length > shortTFs.length ? 'haussier' : 'baissier';
    _blockReason = 'contexte ' + _pendDir + ' mais TF d\'entrée pas encore aligné';
    _waitCond = 'confirmation ' + _pendDir + ' sur TF d\'entrée';
  }

  lines.push('J\'attends — ' + _blockReason + '.');
  lines.push('');

  if (longTFs.length > 0) {
    lines.push('Déjà alignés LONG: ' + longTFs.map(function(s){return s.tf;}).join(', '));
  } else if (shortTFs.length > 0) {
    lines.push('Déjà alignés SHORT: ' + shortTFs.map(function(s){return s.tf;}).join(', '));
  }
  if (neutTFs.length > 0) {
    lines.push('En attente / neutres: ' + neutTFs.map(function(s){return s.tf;}).join(', '));
  }

  // Raison du meilleur candidat refusé
  var _bestCandidate = ts.slice().sort(function(a,b){ return (b.strength||0)-(a.strength||0); })[0];
  if (_bestCandidate && _bestCandidate.reason && _bestCandidate.reason !== 'no-data') {
    var _refReason = String(_bestCandidate.reason).split('|')[0].trim().substring(0, 90);
    if (_refReason.length > 5) lines.push('Blocage sur ' + _bestCandidate.tf + ': ' + _refReason);
  }

  lines.push('');
  lines.push('Signal attendu: ' + _waitCond + '.');

  // Risque
  var _highRisk = ts.filter(function(s){ return (s.riskLevel||'').toUpperCase() === 'HIGH'; });
  if (_highRisk.length > 0) {
    lines.push('');
    lines.push('Risque élevé sur ' + _highRisk.map(function(s){return s.tf;}).join('/') + ' — news/volatilité. Réduire la taille si entrée.');
  } else {
    lines.push('');
    lines.push('Ne rien faire fait partie du trading. Patienter = discipline.');
  }

  lines.push('[Mode ' + _modeNow + ' | ' + _modeInfo.tfs + ']');
  return lines.join('\n');
}

// ─── SURVEILLANCE CONTINUE — après ANALYSER ───────────────────────────────────
// Toutes les 2 minutes : parle pour confirmer que la recherche est active
// Animation subtile sur toutes les cartes TF (monitoring = pulse bleu)
var _continuousScanActive = false;
var _continuousScanInterval = null;
var _continuousScanCount = 0;

function startContinuousScan() {
  if (_continuousScanActive) return; // déjà actif
  _continuousScanActive = true;
  _continuousScanCount = 0;

  // Animation monitoring sur toutes les cartes TF non-gagnantes
  (typeof MTFS !== 'undefined' ? MTFS : ['M1','M5','M15','H1','H4','D1']).forEach(function(tf) {
    var card = $('tfc-' + tf);
    if (card && !card.classList.contains('winner') && !card.classList.contains('winner-short')) {
      card.classList.add('monitoring');
    }
  });

  // ── COACHING VOCAL LIVE — lecture bridge en 4 temps : situation / ce qui est bon / ce qui bloque / ce que j'attends
  // Langage simple et direct — le robot parle comme un trader PRO qui explique à voix haute
  function _buildContinuousScanVocal() {
    var _bd = state._lastBridgeData;
    var _sym = state.symbol || '';
    var _mode = String(state.tradeMode || 'AUTO').toUpperCase();

    // Bridge absent — attendre
    if (!_bd) return 'Je surveille ' + _sym + '. En attente du bridge TradingView.';

    // ── MODE PRICE-ACTION SEUL — aucun indicateur Pine/RSI ───────────────────
    var _hasIndicatorData = !!(
      String(_bd.lectureTech1||'').trim() || String(_bd.lectureTech2||'').trim() ||
      Number(_bd.rsiTf1||0) > 0 || Number(_bd.rsiTf2||0) > 0 || Number(_bd.rsiTf3||0) > 0
    );
    if (!_hasIndicatorData) {
      var _px = state.price > 0 ? (state.price > 100 ? state.price.toFixed(2) : state.price.toFixed(5)) : '?';
      var _rsiLive = Number(_bd.indicators && _bd.indicators.rsi || 0);
      if (_rsiLive <= 0) {
        return 'Je surveille ' + _sym + ' à ' + _px + '. L\'indicateur RSI n\'est pas encore visible sur le chart. Ajoute le RSI dans TradingView pour que j\'analyse la direction. Je surveille le momentum de prix en attendant.';
      }
      var _dir = _rsiLive >= 58 ? 'haussier' : _rsiLive <= 42 ? 'baissier' : 'neutre';
      return 'Je surveille ' + _sym + ' à ' + _px + '. RSI chart à ' + Math.round(_rsiLive) + ' — momentum ' + _dir + '. J\'attends la confirmation multi-timeframe pour armer l\'entrée.';
    }

    var _lt2 = String(_bd.lectureTech2 || '').toUpperCase(); // M5
    var _lt3 = String(_bd.lectureTech3 || '').toUpperCase(); // M15
    var _lt4 = String(_bd.lectureTech4 || '').toUpperCase(); // H1
    var _inTop     = _bd.inTop === true;
    var _inBot     = _bd.inBot === true;
    var _liqH      = _bd.zoneLiqHaute === true;
    var _liqB      = _bd.zoneLiqBasse === true;
    var _bullRej   = _bd.bullRej === true;
    var _bearRej   = _bd.bearRej === true;
    var _macroBull = Number(_bd.macroBull || 0);
    var _macroBear = Number(_bd.macroBear || 0);
    var _sc3       = Number(_bd.scoreTech3 || 0);
    var _sc4       = Number(_bd.scoreTech4 || 0);
    var _score     = Math.round(_sc3 || _sc4 || 0);
    var _longScore = Number(_bd.long_score  || 0);
    var _shortScore= Number(_bd.short_score || 0);
    var _pineDir   = (_longScore > _shortScore + 10) ? 'LONG' : (_shortScore > _longScore + 10) ? 'SHORT' : '';
    var _pineForce = _pineDir ? Math.round(Math.max(_longScore, _shortScore)) : 0;
    var _antTxt    = String(_bd.anticipationTexte || '').toUpperCase();
    var _thresh    = _mode === 'SCALP' || _mode === 'SCALPER' ? 60 : 70;

    // ── Drapeaux logiques ──────────────────────────────────────────────────
    var _isZone      = _inTop || _inBot || _liqH || _liqB;
    var _hasStruct   = _bullRej || _bearRej || _antTxt.includes('RET_') || _antTxt.includes('ALERTE');
    var _domBull     = _macroBull > 58;
    var _domBear     = _macroBear > 58;
    var _hasDom      = _domBull || _domBear;
    var _hasScore    = _score >= _thresh;
    var _h1Bull      = _lt4 === 'ACHAT';
    var _h1Bear      = _lt4 === 'VENTE';
    var _m15Bull     = _lt3 === 'ACHAT';
    var _m15Bear     = _lt3 === 'VENTE';
    var _m5Bull      = _lt2 === 'ACHAT';
    var _retLong     = _antTxt.includes('RET_LONG');
    var _retShort    = _antTxt.includes('RET_SHORT');
    var _preLong     = _antTxt.includes('PRE_ALERTE_LONG');
    var _preShort    = _antTxt.includes('PRE_ALERTE_SHORT');

    // ─── BLOC 1 : SITUATION — où est le prix en ce moment ─────────────────
    var _sit;
    if (_inBot || _liqB)      _sit = 'On est sur un support — le prix est en zone basse.';
    else if (_inTop || _liqH) _sit = 'On est sur une résistance — le prix est en zone haute.';
    else                      _sit = 'Le prix est au milieu du range — pas encore sur un niveau clé.';

    // ─── BLOC 2 : CE QUI EST DÉJÀ BON ────────────────────────────────────
    var _bon = [];
    if (_isZone)    _bon.push('le niveau est bon');
    if (_pineDir === 'LONG')  _bon.push('Pine confirme LONG avec ' + _pineForce + '% de force (' + Math.round(_longScore) + '/' + Math.round(_shortScore) + ')');
    if (_pineDir === 'SHORT') _bon.push('Pine confirme SHORT avec ' + _pineForce + '% de force (' + Math.round(_shortScore) + '/' + Math.round(_longScore) + ')');
    if (_bullRej)   _bon.push('le marché essaye de repartir à la hausse — rejet haussier présent');
    if (_bearRej)   _bon.push('le marché essaye de repartir à la baisse — rejet baissier présent');
    if (_retLong)   _bon.push('un retournement haussier est en cours de formation');
    if (_retShort)  _bon.push('un retournement baissier est en cours de formation');
    if (_preLong)   _bon.push('le Pine Script anticipe un mouvement LONG');
    if (_preShort)  _bon.push('le Pine Script anticipe un mouvement SHORT');
    if (_m15Bull && _inBot) _bon.push('M15 commence à monter');
    if (_m15Bear && _inTop) _bon.push('M15 commence à descendre');
    if (_domBull)   _bon.push('les acheteurs commencent à dominer — ' + Math.round(_macroBull) + '%');
    if (_domBear && (_inTop || _bearRej)) _bon.push('les vendeurs dominent — ' + Math.round(_macroBear) + '%');
    if (_hasScore)  _bon.push('le score de confluence est suffisant — ' + _score + ' sur ' + _thresh);

    // ─── BLOC 3 : CE QUI BLOQUE ──────────────────────────────────────────
    var _bloque = [];

    // Conflit zone vs setup attendu
    if (_inBot && _h1Bear)  _bloque.push('H1 est encore baissier — la tendance de fond reste vendeuse');
    if (_inTop && _h1Bull)  _bloque.push('H1 est encore haussier — la tendance de fond reste acheteuse');
    if (_inBot && _m15Bear) _bloque.push('M15 descend encore — pas encore retourné');
    if (_inTop && _m15Bull) _bloque.push('M15 monte encore — pas encore retourné');

    // Dominance contre le setup
    if (_inBot && _domBear && !_domBull) _bloque.push('la dominance reste vendeuse — ' + Math.round(_macroBear) + '% vendeurs');
    if (_inTop && _domBull && !_domBear) _bloque.push('la dominance reste acheteuse — ' + Math.round(_macroBull) + '% acheteurs');
    if (!_hasDom)                         _bloque.push('la dominance n\'est pas tranchée — marché sans conviction');

    // Score
    if (!_hasScore && _score > 0)  _bloque.push('le score est insuffisant — ' + _score + ' sur ' + _thresh + ' requis');
    if (!_isZone)                  _bloque.push('le prix n\'est pas encore sur un niveau clé');
    if (!_hasStruct)               _bloque.push('pas encore de rejet ni de signal de structure');

    // ─── BLOC 4 : CE QUE J'ATTENDS ────────────────────────────────────────
    var _attend;
    var _manque = [];

    if (!_isZone) {
      _attend = 'J\'attends que le prix atteigne un extrême de range. Pour l\'instant il n\'y a rien à faire.';
    } else if (!_hasStruct) {
      _attend = 'La zone est bonne. J\'attends un rejet clair ou un signal de retournement avant d\'entrer.';
    } else {
      // Zone + structure OK — lister ce qui manque encore
      if (_inBot) {
        if (_h1Bear)     _manque.push('H1 doit clôturer haussier');
        if (!_domBull)   _manque.push('les acheteurs doivent prendre le dessus');
        if (!_hasScore)  _manque.push('le score doit monter au dessus de ' + _thresh);
      } else if (_inTop) {
        if (_h1Bull)     _manque.push('H1 doit clôturer baissier');
        if (!_domBear)   _manque.push('les vendeurs doivent prendre le dessus');
        if (!_hasScore)  _manque.push('le score doit monter au dessus de ' + _thresh);
      }

      if (_manque.length === 0) {
        _attend = 'Toutes les conditions sont réunies. Je surveille la prochaine bougie pour confirmer.';
      } else {
        _attend = 'Il me manque encore : ' + _manque.join(', et ') + '. Je n\'entre pas maintenant.';
      }
    }

    // ─── ASSEMBLAGE FINAL ─────────────────────────────────────────────────
    var _parts = [_sit];
    if (_bon.length > 0)    _parts.push('Ce qui est déjà bon : ' + _bon.slice(0, 3).join(', ') + '.');
    if (_bloque.length > 0) _parts.push('Ce qui bloque : ' + _bloque.slice(0, 2).join(', et ') + '.');
    _parts.push(_attend);
    return _parts.join(' ');
  }

  // ── Auto-setTimeout adaptatif — ajuste le délai selon l'état (position vs attente) ──
  // Pendant position: 30s (détection rapide retournement)
  // Sans position: 2min (économise ressources)
  async function _scanTick() {
    if (!_continuousScanActive) return; // arrêté par stopContinuousScan
    _continuousScanCount++;
    // Double guard: ignorer entered:true dans les 30s après un EXIT local (race condition SSE)
    var _inPos = !!(state.tradeState && state.tradeState.entered)
      && (Date.now() - _lastExitAt > 30000);
    var _mktClosed = !!(state._lastMarketStatus && state._lastMarketStatus.isOpen === false);

    // ── SESSION MARCHÉ — détection à chaque tick (annonce si changement) ──────
    try { _announceSessionChange(); } catch (_) {}

    if (!_mktClosed) {
      if (_inPos) {
        // ── Position active — coaching intelligent toutes les 45s ──────────────
        try {
          await renderMultiTF(); // mise à jour cartes TF en temps réel
          runPositionCoaching(); // feedback coach structuré (TF + momentum + zone + RSI + P&L)
        } catch (_) {}
      } else {
        // ── Pas de position → surveillance active + parole ────────────────────
        // Si watchdog armé, il gère son vocal — on ne double pas
        if (!state.armed) {
          speak(_buildContinuousScanVocal());
        }
        renderMultiTF().catch(function(){});
        // Proposition supprimée — ANALYSER → ARMER → exécution auto
      }
    }

    // Reprogrammer : 45s en position (coaching riche), 2min sinon
    // Utiliser _inPos (déjà corrigé du guard race condition) pour le délai
    if (_continuousScanActive) {
      var _nextDelay = _inPos ? 45 * 1000 : 2 * 60 * 1000;
      _continuousScanInterval = setTimeout(_scanTick, _nextDelay);
    }
  }

  // Premier tick après 20s — agent actif immédiatement après ANALYSER
  // Puis cycles à 2min pour ne pas saturer
  _continuousScanInterval = setTimeout(_scanTick, 20 * 1000);
}

function stopContinuousScan() {
  _continuousScanActive = false;
  // Utiliser clearTimeout (compatibilité setInterval/setTimeout — les deux fonctionnent)
  if (_continuousScanInterval) { clearTimeout(_continuousScanInterval); clearInterval(_continuousScanInterval); _continuousScanInterval = null; }
  (typeof MTFS !== 'undefined' ? MTFS : ['M1','M5','M15','H1','H4','D1']).forEach(function(tf) {
    var card = $('tfc-' + tf);
    if (card) card.classList.remove('monitoring');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── MODULE 1 : CONSCIENCE SESSIONS MARCHÉ ────────────────────────────────────
// Détecte en temps réel : Londres / New York / Overlap / Tokyo / Off-hours
// Annonce vocalement les ouvertures et transitions de session
// ═══════════════════════════════════════════════════════════════════════════════

var _mktSessionLast     = null;  // dernière session détectée
var _mktSessionSpokenAt = 0;     // timestamp dernière annonce session

function detectMarketSession() {
  var now    = new Date();
  var utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  // Créneaux UTC : London 08:00-17:00 | New York 13:00-22:00 | Tokyo 00:00-09:00
  var londonOpen = utcMin >= 480  && utcMin < 1020;   // 08h-17h UTC
  var nyOpen     = utcMin >= 780  && utcMin < 1320;   // 13h-22h UTC
  var tokyoOpen  = utcMin < 540   || utcMin >= 1380;  // 00h-09h + 23h-24h UTC
  if (londonOpen && nyOpen) return { id:'OVERLAP',  label:'Overlap Londres / New York', emoji:'🔥', color:'#f97316', strength:'FORTE — liquidité maximale' };
  if (londonOpen)           return { id:'LONDON',   label:'Session Londres',            emoji:'🇬🇧', color:'#3b82f6', strength:'ACTIVE — banques européennes' };
  if (nyOpen)               return { id:'NEW_YORK', label:'Session New York',           emoji:'🗽', color:'#a855f7', strength:'ACTIVE — flux US' };
  if (tokyoOpen)            return { id:'TOKYO',    label:'Session Tokyo/Asie',         emoji:'🌏', color:'#06b6d4', strength:'LÉGÈRE — ranges fréquents' };
  return { id:'OFF', label:'Hors session principale', emoji:'💤', color:'#64748b', strength:'FAIBLE — peu de volume' };
}

function _announceSessionChange() {
  var sess = detectMarketSession();
  var _now = Date.now();
  // Annoncer uniquement si : session différente ET au moins 4 min depuis la dernière annonce
  if (sess.id !== _mktSessionLast && _now - _mktSessionSpokenAt > 240000) {
    _mktSessionLast     = sess.id;
    _mktSessionSpokenAt = _now;
    var _vocal = '';
    if (sess.id === 'OVERLAP') {
      _vocal = 'Overlap Londres New York actif — phase la plus liquide du marché. Volatilité maximale. Les grandes banques européennes et américaines sont simultanément en activité. C\'est le meilleur moment pour les setups directionnels.';
    } else if (sess.id === 'LONDON') {
      _vocal = 'Ouverture Londres — début de la session européenne. Augmentation de volatilité attendue. Les banques européennes entrent sur le marché. Les faux mouvements de Tokyo peuvent être effacés ici.';
    } else if (sess.id === 'NEW_YORK') {
      _vocal = 'Ouverture New York — flux US entrant. Session américaine active. Possible reprise ou extension du mouvement initié à Londres. Surveille les données économiques américaines.';
    } else if (sess.id === 'TOKYO') {
      _vocal = 'Session Tokyo active — marché asiatique. Volatilité réduite sur les paires européennes. Favorable aux ranges. Attends Londres pour les setups directionnels.';
    } else {
      _vocal = ''; // Hors session — pas d\'annonce
    }
    if (_vocal && !state.muted) {
      speak(_vocal);
      setCoachText(sess.emoji + ' ' + sess.label + ' — ' + sess.strength + '\n' + _vocal.split('.')[0] + '.', sess.color, 2, 18000);
    }
  }
  // Mise à jour badge session (#marketSession déjà dans le HTML)
  var _sEl = document.getElementById('marketSession');
  if (_sEl) {
    _sEl.textContent = sess.emoji + ' ' + sess.label;
    _sEl.style.color  = sess.color;
    _sEl.style.background = sess.id === 'OVERLAP'  ? 'rgba(249,115,22,0.15)'
                          : sess.id === 'LONDON'   ? 'rgba(59,130,246,0.12)'
                          : sess.id === 'NEW_YORK' ? 'rgba(168,85,247,0.12)'
                          : sess.id === 'TOKYO'    ? 'rgba(6,182,212,0.12)'
                          : 'rgba(100,116,139,0.1)';
    _sEl.title = sess.strength;
  }
  return sess;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── MODULE 2 : COACHING INTELLIGENT EN POSITION ──────────────────────────────
// Analyse M1+M5+M15+H1 depuis le bridge live toutes les 45s quand en position.
// Génère un message coach structuré : état TF + momentum + zone + RSI + P&L.
// Mode purement "observation + feedback" — aucun impact sur la logique d'entrée.
// ═══════════════════════════════════════════════════════════════════════════════

var _posCoachCycle = 0; // compteur rotatif pour varier les formulations

function runPositionCoaching() {
  // Guard : uniquement si position active (+ protection race condition EXIT)
  if (!state.tradeState || !state.tradeState.entered) return;
  if (Date.now() - _lastExitAt < 30000) return; // EXIT récent — pas de coaching position
  var _bd  = state._lastBridgeData;
  if (!_bd) return;

  // Source position : live SSE (priorité — SL/TP peuvent avoir bougé BE/trail)
  // Fallback : tradeState.virtualPosition (état local)
  var _livVp  = (state.live && state.live.virtualPosition && state.live.virtualPosition.status === 'OPEN')
                ? state.live.virtualPosition : null;
  var _statVp = state.tradeState.virtualPosition || {};
  var _vp     = _livVp || _statVp; // préférer la source SSE la plus fraîche

  var _dir    = String(_vp.direction || _statVp.direction || '').toUpperCase();
  var _isLong = _dir.includes('LONG') || _dir.includes('BUY');
  // Entrée : toujours depuis state.tradeState (valeur fixée à l'exécution)
  var _entry  = Number(_statVp.entry || _vp.entry || 0);
  // SL/TP : depuis live si dispo (peut avoir changé via BE/trail), sinon statVp
  var _sl     = Number((_livVp && _livVp.sl) || _statVp.sl || 0);
  var _tp     = Number((_livVp && _livVp.tp) || _statVp.tp || 0);
  var _px     = Number(state.price || 0);

  // Guard : si pas de direction claire → sortir silencieusement
  if (!_dir || _dir === 'WAIT') return;

  // ── Directions TF (bridge live) ──────────────────────────────────────────
  var _lt1 = String(_bd.lectureTech1 || '').toUpperCase(); // M1
  var _lt2 = String(_bd.lectureTech2 || '').toUpperCase(); // M5
  var _lt3 = String(_bd.lectureTech3 || '').toUpperCase(); // M15
  var _lt4 = String(_bd.lectureTech4 || '').toUpperCase(); // H1
  function _isOk(lt) { return _isLong ? (lt.includes('ACHAT') || lt.includes('BUY') || lt.includes('LONG'))
                                      : (lt.includes('VENTE') || lt.includes('SELL') || lt.includes('SHORT')); }
  var _m1ok  = _isOk(_lt1);
  var _m5ok  = _isOk(_lt2);
  var _m15ok = _isOk(_lt3);
  var _h1ok  = _isOk(_lt4);
  var _aligned = [_m1ok, _m5ok, _m15ok, _h1ok].filter(Boolean).length;

  // ── Momentum (rejet) ──────────────────────────────────────────────────────
  var _momentumOk = _isLong ? (_bd.bullRej === true) : (_bd.bearRej === true);

  // ── Zones ─────────────────────────────────────────────────────────────────
  var _inTop  = _bd.inTop === true || _bd.zoneLiqHaute === true;
  var _inBot  = _bd.inBot === true || _bd.zoneLiqBasse === true;
  var _nearTp = _isLong ? _inTop : _inBot;
  var _nearSl = _isLong ? _inBot : _inTop;

  // ── RSI ───────────────────────────────────────────────────────────────────
  var _rsiM15 = Number(_bd.rsiTf3 || 0);
  var _rsiH1  = Number(_bd.rsiTf4 || 0);

  // ── P&L en R ──────────────────────────────────────────────────────────────
  var _pnlPips = (_entry > 0 && _px > 0) ? (_isLong ? _px - _entry : _entry - _px) : 0;
  var _risk    = (_entry > 0 && _sl > 0)  ? Math.abs(_entry - _sl) : 0;
  var _pnlR    = (_risk > 0)              ? _pnlPips / _risk : 0;

  var _fmt = function(v) { return v > 100 ? Number(v).toFixed(2) : Number(v).toFixed(5); };
  var _pxStr = _px > 0 ? _fmt(_px) : '';

  // ── Synthèse TF pour affichage ─────────────────────────────────────────────
  var _tfLine = 'M1:' + (_m1ok?'✅':'❌') + ' M5:' + (_m5ok?'✅':'❌') +
                ' M15:' + (_m15ok?'✅':'❌') + ' H1:' + (_h1ok?'✅':'❌') +
                ' | Mom:' + (_momentumOk?'✅':'⏳');

  // ── Session marché ────────────────────────────────────────────────────────
  var _sess = detectMarketSession();

  // ── Génération message coach selon état d'alignement ──────────────────────
  var _spkParts = [];
  var _coachHeader = '';
  var _coachColor  = '#22c55e';
  _posCoachCycle++;
  var _cyc = _posCoachCycle % 8; // 8 formulations rotatives — plus de variété

  if (_aligned === 4) {
    // Alignement parfait → 8 variantes descriptives du travail effectué
    _coachColor = '#22c55e';
    var _dir4lbl = _isLong ? 'haussière' : 'baissière';
    var _posVariants = [
      'Je vérifie M1, M5, M15, H1 — les 4 unités de temps sont alignées dans le sens du trade. Structure intacte. Momentum confirmé.',
      'Analyse en cours — M1 M5 M15 H1 confirment tous la direction ' + _dir4lbl + '. Le marché respecte le scénario.',
      'Contexte toujours cohérent. Les 4 timeframes valident la position. Rien à signaler — je reste en surveillance.',
      'Vérification complète — tout est aligné. Pression ' + (_isLong ? 'acheteuse' : 'vendeuse') + ' confirmée sur tous les TF.',
      'Je contrôle la structure ' + _dir4lbl + ' sur M1, M5, M15 et H1. Scénario toujours valide — rien à faire.',
      'Scénario respecté. M15 et H1 confirment le contexte macro. M5 et M1 confirment le timing. La position est propre.',
      'Momentum ' + (_isLong ? 'haussier' : 'baissier') + ' confirmé sur toutes les unités de temps. Je surveille la structure jusqu\'au TP.',
      'Je vérifie les unités de temps — structure ' + _dir4lbl + ' intacte. Le marché suit le plan prévu.'
    ];
    _spkParts.push(_posVariants[_cyc]);
    _coachHeader = '✅ 4/4 TF alignés — scénario valide';

  } else if (_aligned === 3) {
    _coachColor = '#a3e635';
    var _miss = [!_m1ok&&'M1', !_m5ok&&'M5', !_m15ok&&'M15', !_h1ok&&'H1'].filter(Boolean).join('+');
    var _htfOk = _m15ok && _h1ok;
    var _pos3Variants = [
      'Je surveille M1 M5 M15 H1 — 3 sur 4 alignés. ' + _miss + ' légèrement divergent' + (_htfOk ? ', mais les grandes unités de temps restent favorables. Le trade est sain.' : '. Je surveille la prochaine bougie.'),
      'Légère divergence sur ' + _miss + (_htfOk ? ', mais H1 et M15 restent dans le sens du trade. Structure respectée — je continue à surveiller.' : '. HTF à surveiller — garde un œil sur la prochaine bougie.'),
      'Vérification en cours — ' + _miss + ' montre un léger écart. Pas d\'alerte pour l\'instant. ' + (_htfOk ? 'Macro favorable.' : 'Je surveille.'),
      'Scénario toujours valide avec 3 TF alignés. ' + _miss + ' divergent légèrement — normal en cours de trade.'
    ];
    _spkParts.push(_pos3Variants[_cyc % 4]);
    _coachHeader = '🟡 3/4 TF — ' + _miss + ' faible, HTF ' + (_htfOk ? 'OK' : 'à surveiller');

  } else if (_aligned === 2) {
    _coachColor = '#f97316';
    var _against = [!_m1ok&&'M1', !_m5ok&&'M5', !_m15ok&&'M15', !_h1ok&&'H1'].filter(Boolean);
    var _h1Against = !_h1ok;
    var _pos2Variants = [
      'Attention — je surveille une possible faiblesse sur ' + _against.join(' et ') + '. ' +
        (_h1Against ? 'H1 commence à diverger — surveille attentivement.' : 'H1 reste aligné — divergence encore mineure. Je surveille la prochaine bougie.'),
      'Je vérifie les unités de temps — divergence détectée sur ' + _against.join(' et ') + '. ' +
        (_h1Against ? 'Le contexte macro s\'affaiblit. Reste vigilant.' : 'H1 tient encore — je surveille la structure.'),
      'Légère divergence ' + _against.join('+') + ' — je suis attentif. ' +
        (_h1Against ? 'H1 diverge, ce qui est un signal à surveiller de près.' : 'Pas d\'alerte majeure pour l\'instant.'),
      'Vérification en cours — 2 TF dans le sens du trade, ' + _against.join('+') + ' divergent. ' +
        (_h1Against ? 'Pense à surveiller ta sortie si H1 continue de diverger.' : 'Je continue à surveiller.')
    ];
    _spkParts.push(_pos2Variants[_cyc % 4]);
    _coachHeader = '⚠️ 2/4 TF — Divergence ' + _against.join('+');

  } else {
    _coachColor = '#ef4444';
    var _pos1Variants = [
      'Contexte en train de se retourner. Seulement ' + _aligned + ' unité' + (_aligned > 1 ? 's' : '') + ' de temps dans le sens du trade. Le scénario s\'affaiblit — vérifie si tu dois gérer la sortie.',
      'Je vérifie les unités de temps — ' + _aligned + ' TF seulement dans le bon sens. La structure se dégrade. Prépare-toi à gérer la sortie.',
      'Alerte — scénario en difficulté. Je lis M1 M5 M15 H1 et seulement ' + _aligned + ' confirme encore la direction. Ne force pas — surveille de près.'
    ];
    _spkParts.push(_pos1Variants[_cyc % 3]);
    _coachHeader = '🔴 ' + _aligned + '/4 TF — Scénario en difficulté';
  }

  // ── Contexte P&L ──────────────────────────────────────────────────────────
  if (_pnlR >= 2) {
    _spkParts.push('Position à ' + _pnlR.toFixed(1) + ' R de profit. Pense à sécuriser une partie.');
  } else if (_pnlR >= 1) {
    _spkParts.push('Position à ' + _pnlR.toFixed(1) + ' R — breakeven déjà sécurisé si ce n\'est pas fait.');
  } else if (_pnlR > 0) {
    _spkParts.push('Position légèrement positive.');
  } else if (_pnlR < -0.3) {
    _spkParts.push('Position en légère perte — le scénario a encore sa chance si la structure tient.');
  }

  // ── MACRO — H1 + H4 + D1 + macroBull/Bear (temps réel) ──────────────────
  // H1 : bridge live (lectureTech4 + scoreTech4 + rsiTf4)
  // H4/D1 : state._lastSnapshots (dernier scan ANALYSER — meilleure donnée dispo)
  var _macBull   = Number(_bd.macroBull  || 0);
  var _macBear   = Number(_bd.macroBear  || 0);
  var _scoreH1   = Number(_bd.scoreTech4 || 0);
  var _antTxt    = String(_bd.anticipationTexte || '').replace(/_/g,' ');
  var _antForce  = Number(_bd.anticipationForce || 0);

  // Lire H4 + D1 depuis les snapshots ANALYSER (non bridge mais meilleure info dispo)
  var _snaps     = Array.isArray(state._lastSnapshots) ? state._lastSnapshots : [];
  var _snapH4    = _snaps.find(function(s){ return s.tf === 'H4'; }) || null;
  var _snapD1    = _snaps.find(function(s){ return s.tf === 'D1'; }) || null;
  function _snapDir(s) {
    if (!s || !s.directional) return 'neutre';
    return (s.rec.includes('BUY') || s.rec.includes('LONG')) ? 'haussier' : 'baissier';
  }
  var _h4Dir  = _snapDir(_snapH4);
  var _d1Dir  = _snapDir(_snapD1);
  var _h1Dir  = _h1ok ? (_isLong ? 'haussier' : 'baissier') : 'neutre/adverse';

  // Verdict macro : favorable si H1 OK + (H4 ou D1 dans le même sens)
  var _h4Ok   = _snapH4 && _snapH4.directional
    ? ((_isLong && (_snapH4.rec.includes('BUY')||_snapH4.rec.includes('LONG')))
    || (!_isLong && (_snapH4.rec.includes('SELL')||_snapH4.rec.includes('SHORT')))) : null; // null = pas de données
  var _d1Ok   = _snapD1 && _snapD1.directional
    ? ((_isLong && (_snapD1.rec.includes('BUY')||_snapD1.rec.includes('LONG')))
    || (!_isLong && (_snapD1.rec.includes('SELL')||_snapD1.rec.includes('SHORT')))) : null;

  var _macroFavorable = _h1ok && (_h4Ok !== false); // H1 OK + H4 pas contre = macro OK
  var _macroConflict  = _h1ok === false && (_h4Ok === false || _d1Ok === false); // H1 + grande UT contre

  // Construire la phrase macro
  var _macroParts = [];
  _macroParts.push('H1 ' + _h1Dir + (_scoreH1 > 0 ? ' (' + Math.round(_scoreH1) + '%)' : ''));
  if (_h4Ok !== null) _macroParts.push('H4 ' + _h4Dir);
  if (_d1Ok !== null) _macroParts.push('D1 ' + _d1Dir);
  if (_macBull > 0 || _macBear > 0) {
    var _macScore = _isLong ? _macBull : _macBear;
    var _macAdv   = _isLong ? _macBear : _macBull;
    if (_macScore > 0) _macroParts.push('score macro favorable ' + Math.round(_macScore) + '%');
    if (_macAdv > _macScore) _macroParts.push('pression adverse ' + Math.round(_macAdv) + '%');
  }
  if (_antTxt && _antForce >= 55) {
    _macroParts.push('anticipation Pine: ' + _antTxt + ' ' + Math.round(_antForce) + '%');
  }

  var _macroLine   = _macroParts.join(' | ');
  var _macroVerdict = _macroConflict  ? '🔴 Macro adverse'
                    : _macroFavorable ? '✅ Macro favorable'
                    : '🟡 Macro neutre';

  var _macroSpk = 'Contexte macro — ' + _macroLine + '. '
    + (_macroFavorable ? 'La tendance de fond soutient le trade.' : '')
    + (_macroConflict  ? 'Attention: les grandes unités de temps divergent. Reste vigilant sur la tenue de la structure.' : '')
    + (!_macroFavorable && !_macroConflict ? 'Macro neutre — le trade repose sur M5 et M15.' : '');

  _spkParts.push(_macroSpk);

  // Ligne macro dans le coach text
  var _macroCoachLine = _macroVerdict + ' — ' + _macroLine;

  // ── RSI contexte ──────────────────────────────────────────────────────────
  if (_rsiM15 > 0) {
    if (_isLong  && _rsiM15 > 73) _spkParts.push('M15 en excès haussier — surveille un essoufflement.');
    if (!_isLong && _rsiM15 < 27) _spkParts.push('M15 en survente — possible rebond technique, reste vigilant.');
    if (_rsiH1 > 0) {
      if (_isLong  && _rsiH1 > 75) _spkParts.push('H1 aussi en excès — risque d\'essoufflement macro.');
      if (!_isLong && _rsiH1 < 25) _spkParts.push('H1 en survente — surveille un rebond macro.');
    }
  }

  // ── Zone proche ───────────────────────────────────────────────────────────
  if (_nearTp && _tp > 0) {
    _spkParts.push('Prix approche la zone objectif ' + _fmt(_tp) + ' — prépare-toi à gérer le TP.');
  }

  // ── Session marché ────────────────────────────────────────────────────────
  if (_sess.id !== 'OFF') {
    _spkParts.push(_sess.emoji + ' ' + _sess.label + ' en cours — ' + _sess.strength + '.');
  }

  // ── NEWS en live — toujours annoncer l'agenda pendant une position ─────────
  // En position, les news peuvent retourner le marché → obligation d'informer
  var _posNewsLine = '';
  var _posNewsBilan = '';
  (function() {
    var _allEvts = Array.isArray(state.newsEvents) ? state.newsEvents : [];
    var _nowPosMs = Date.now();
    // Chercher la prochaine news (ou en cours)
    var _nextEvt = null;
    for (var _pi = 0; _pi < _allEvts.length; _pi++) {
      var _pe = _allEvts[_pi];
      var _peMins = Number.isFinite(Number(_pe.mins)) ? Number(_pe.mins)
                  : Number.isFinite(Number(_pe.minsUntil)) ? Number(_pe.minsUntil)
                  : Number.isFinite(Number(_pe.minutesUntil)) ? Number(_pe.minutesUntil)
                  : Number.isFinite(Number(_pe.minutesAway)) ? Number(_pe.minutesAway)
                  : 9999;
      if (_peMins >= -15 && _peMins < 9999) { _nextEvt = { ev: _pe, mins: _peMins }; break; }
    }
    if (_nextEvt) {
      var _peName   = String(_nextEvt.ev.title || _nextEvt.ev.event || _nextEvt.ev.name || 'News').trim();
      var _peImpRaw = String(_nextEvt.ev.impact || '').toUpperCase();
      var _peStars  = Number(_nextEvt.ev.stars || 0);
      var _peImpLbl = (_peImpRaw === 'HIGH' || _peStars >= 4) ? 'HAUTE IMPACT'
                    : (_peImpRaw === 'MEDIUM' || _peStars >= 2) ? 'impact moyen'
                    : 'faible impact';
      var _peIsHigh = _peImpRaw === 'HIGH' || _peStars >= 4;
      if (_nextEvt.mins <= 5) {
        // Imminente ou en cours
        _posNewsBilan = '🚨 ' + _peName + ' — news ' + _peImpLbl + ' IMMINENTE. Surveille la volatilité.';
        _spkParts.push('Attention. News imminente en cours: ' + _peName + ', ' + _peImpLbl + '. Surveille la volatilité et protège ta position.');
      } else if (_nextEvt.mins <= 30) {
        // Prochaine news proche — toujours mentionner
        var _peWhen = 'dans ' + Math.round(_nextEvt.mins) + ' minutes';
        _posNewsBilan = (_peIsHigh ? '⚠️ ' : '📅 ') + _peName + ' ' + _peWhen + ' — ' + _peImpLbl + '.';
        if (_peIsHigh) {
          _spkParts.push('Agenda: ' + _peName + ' ' + _peWhen + ', ' + _peImpLbl + '. Décide si tu gardes la position ou sécurises avant l\'annonce.');
        } else {
          _spkParts.push('Agenda: ' + _peName + ' ' + _peWhen + ', ' + _peImpLbl + '.');
        }
      } else {
        // News plus lointaine — mentionner sans alarme
        var _peWhen2 = _nextEvt.mins < 120 ? 'dans ' + Math.round(_nextEvt.mins) + ' min' : 'dans ' + Math.round(_nextEvt.mins / 60) + 'h';
        _posNewsBilan = '📅 ' + _peName + ' ' + _peWhen2 + ' — ' + _peImpLbl + '.';
        _spkParts.push('Prochain événement agenda: ' + _peName + ' ' + _peWhen2 + ', ' + _peImpLbl + '.');
      }
    } else {
      _posNewsBilan = '📅 Agenda calme — pas d\'annonce haute impact prévue.';
      // Pas besoin d'annoncer vocalement si agenda calme (pas informatif)
    }
    _posNewsLine = _posNewsBilan;
  })();

  // ── Assemblage final ──────────────────────────────────────────────────────
  var _spkFinal = _spkParts.join(' ');
  var _coachFull = _coachHeader + '\n'
    + _tfLine + '\n'
    + _macroCoachLine + '\n'          // ligne macro : H1 | H4 | D1 | verdict
    + _spkParts[0];                   // message principal
  if (_pxStr) _coachFull += '\nPrix: ' + _pxStr
    + (_pnlR !== 0 ? ' | P&L: ' + (_pnlR >= 0 ? '+' : '') + _pnlR.toFixed(2) + ' R' : '');
  if (_sess.id !== 'OFF') _coachFull += '\n' + _sess.emoji + ' ' + _sess.label;
  if (_posNewsLine)       _coachFull += '\n' + _posNewsLine; // toujours afficher l'agenda

  setCoachText(_coachFull, _coachColor, 4, 30000);
  if (!state.muted) speak(_spkFinal);
}

// ─── NEWS BLOCK — vérification avant toute entrée ─────────────────────────────
// Règles pro: ❌ pas d'entrée 15min avant une news ★★★+
//             ❌ pas d'entrée pendant (premier mouvement = piège)
//             ✅ attendre 5-15min après la news puis entrer sur vraie direction
var HIGH_IMPACT_KEYWORDS = ['NFP', 'CPI', 'FOMC', 'PPI', 'GDP', 'Fed', 'Interest Rate',
  'Non-Farm', 'Inflation', 'Employment', 'Central Bank', 'Rate Decision',
  'Taux', 'Emploi', 'BCE', 'FED', 'Banque Centrale'];

function checkNewsBlockEntry() {
  var events = Array.isArray(state.newsEvents) ? state.newsEvents : [];
  if (events.length === 0) return { blocked: false };

  // Convertir impact string → score numérique (format /calendar)
  function _impactScore(ev) {
    if (ev.stars != null) return Number(ev.stars) || 0;
    var imp = String(ev.impact || '').toUpperCase();
    if (imp === 'HIGH')   return 4;
    if (imp === 'MEDIUM') return 2;
    if (imp === 'LOW')    return 1;
    return Number(ev.impact) || 0;
  }

  // Chercher la news haute impact la plus proche
  var _blocking = null;
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    var stars = _impactScore(ev);
    // Lire le champ minutes — plusieurs noms possibles selon la source (/calendar=mins, /news=minsUntil/minutesUntil/minutesAway)
    var mins  = Number.isFinite(Number(ev.mins))        ? Number(ev.mins)
              : Number.isFinite(Number(ev.minsUntil))   ? Number(ev.minsUntil)
              : Number.isFinite(Number(ev.minutesUntil)) ? Number(ev.minutesUntil)
              : Number.isFinite(Number(ev.minutesAway))  ? Number(ev.minutesAway)
              : 999;
    var _title = String(ev.title || ev.event || '').toUpperCase();

    // Détecter news ★★★+ OU mots-clés ultra-important (NFP/CPI/FOMC)
    var _isUltra = HIGH_IMPACT_KEYWORDS.some(function(kw) {
      return _title.includes(kw.toUpperCase());
    });
    var _isHigh = stars >= 3 || (stars >= 2 && _isUltra);

    if (_isHigh) {
      if (mins >= -5 && mins <= 15) {
        // News imminente ou en cours (fenêtre -5min à +15min)
        _blocking = { ev: ev, mins: mins, isUltra: _isUltra, phase: mins < 0 ? 'EN_COURS' : mins <= 5 ? 'IMMINENT' : 'PROCHE' };
        break;
      } else if (mins > 15 && mins <= 30) {
        // News dans 15-30min → warning mais pas blocage total
        if (!_blocking) _blocking = { ev: ev, mins: mins, isUltra: _isUltra, phase: 'WARNING', soft: true };
      }
    }
  }

  if (!_blocking) return { blocked: false };

  var _name = String(_blocking.ev.title || _blocking.ev.event || 'News').trim();
  var _stars = _blocking.ev.stars || _blocking.ev.impact || '★★★';

  if (_blocking.soft) {
    // Avertissement — pas de blocage dur
    return {
      blocked: false,
      warning: true,
      reason: 'News dans ' + _blocking.mins + 'min: ' + _name + ' (' + _stars + '★). Évite d\'entrer juste avant.',
      phase: 'WARNING',
      name: _name,
      minsUntil: _blocking.mins
    };
  }

  // Blocage dur
  var _phaseMsg = _blocking.phase === 'EN_COURS'
    ? 'News en cours — attends 5 à 15min après la réaction initiale.'
    : _blocking.phase === 'IMMINENT'
    ? 'News dans ' + Math.abs(_blocking.mins) + 'min — trop proche, risque de spike/piège.'
    : 'News dans ' + _blocking.mins + 'min — pas d\'entrée avant la publication.';

  return {
    blocked: true,
    reason: _phaseMsg + ' (' + _name + ')',
    phase: _blocking.phase,
    name: _name,
    minsUntil: _blocking.mins,
    afterWait: 'Attends la réaction, lis la direction réelle, entre proprement après.'
  };
}

// Résumé news pour le coach — ce qui va impacter le marché bientôt
function buildNewsCoachLine() {
  var events = Array.isArray(state.newsEvents) ? state.newsEvents : [];
  if (events.length === 0) return '';
  var lines = [];
  for (var i = 0; i < Math.min(events.length, 3); i++) {
    var ev = events[i];
    var _impRaw = String(ev.impact || '').toUpperCase();
    var stars = ev.stars != null ? Number(ev.stars) || 0
              : _impRaw === 'HIGH' ? 4 : _impRaw === 'MEDIUM' ? 2 : _impRaw === 'LOW' ? 1 : Number(ev.impact) || 0;
    var mins  = Number.isFinite(Number(ev.mins))         ? Number(ev.mins)
              : Number.isFinite(Number(ev.minsUntil))    ? Number(ev.minsUntil)
              : Number.isFinite(Number(ev.minutesUntil)) ? Number(ev.minutesUntil)
              : Number.isFinite(Number(ev.minutesAway))  ? Number(ev.minutesAway)
              : null;
    if (mins === null || mins < -15) continue;
    var _name = String(ev.title || ev.event || '').trim().substring(0, 35);
    var _starsStr = stars >= 3 ? '★★★' : stars >= 2 ? '★★' : '★';
    var _when = mins <= 0 ? 'EN COURS' : mins < 60 ? 'dans ' + mins + 'min' : 'dans ' + Math.round(mins / 60) + 'h';
    var _urgent = (stars >= 3 && mins >= 0 && mins <= 30);
    lines.push((_urgent ? '🔴' : '🟡') + ' ' + _starsStr + ' ' + _name + ' — ' + _when);
  }
  return lines.length > 0 ? lines.join('\n') : '';
}

// ─── ANALYSE CONTEXTE MARCHÉ PRO — 7 étapes ───────────────────────────────────
// Logique : je ne trade pas un signal, je trade un CONTEXTE validé
// Input: snapshots[] + stats (ATR, force, RSI) + price history
// Output: { context, labels[], blockEntry, message }
function analyzeMarketContext(snapshots, stats, priceHistory) {
  var ts = snapshots || [];
  var _stats = stats || {};
  var _prices = Array.isArray(priceHistory) ? priceHistory : [];

  var longTFs  = ts.filter(function(s){ return s.rec.includes('BUY')||s.rec.includes('LONG'); });
  var shortTFs = ts.filter(function(s){ return s.rec.includes('SELL')||s.rec.includes('SHORT'); });
  var neutTFs  = ts.filter(function(s){ return !s.directional; });
  var total = ts.length || 1;

  var _atr   = Number(_stats.atr || 0);
  var _force = Number(_stats.force || _stats.strength || 0);
  var _rsiM15 = Number(_stats.rsi_m15 || 0);

  // ── Calcul pulsion prix (variation des 5 derniers prix connus) ──────────────
  var _pulsePct = 0;
  if (_prices.length >= 2) {
    var _oldest = _prices[0];
    var _newest = _prices[_prices.length - 1];
    _pulsePct = _oldest > 0 ? Math.abs(_newest - _oldest) / _oldest * 100 : 0;
  }

  var labels = [];
  var blockEntry = false;
  var context = 'NEUTRE';

  // ── 1. STRUCTURE MARCHÉ ──────────────────────────────────────────────────
  // HH/HL = haussier, LH/LL = baissier, conflit = casse possible
  if (longTFs.length >= shortTFs.length + 2) {
    context = 'HAUSSIER';
    labels.push('Structure HH/HL — tendance haussière');
  } else if (shortTFs.length >= longTFs.length + 2) {
    context = 'BAISSIER';
    labels.push('Structure LH/LL — tendance baissière');
  } else if (longTFs.length > 0 && shortTFs.length > 0) {
    context = 'CONFLIT';
    labels.push('Structure mixte — casse de structure possible');
  }

  // ── 2. LIQUIDITÉ ─────────────────────────────────────────────────────────
  // Double top/bottom = TFs à égalité ou inversion récente
  var _prevDir = state._mktCtxLastDir || context;
  var _dirFlipped = _prevDir !== 'NEUTRE' && context !== 'NEUTRE' && context !== _prevDir;
  state._mktCtxLastDir = context;
  if (_dirFlipped) {
    labels.push('Liquidité détectée — inversion de structure (retournement possible)');
  } else if (longTFs.length > 0 && shortTFs.length > 0) {
    labels.push('Liquidité en jeu — égalité de forces, marché va chercher les stops');
  }

  // ── 3. COMPRESSION ────────────────────────────────────────────────────────
  // Compression = neutres >= 4, ATR faible, force faible
  var _isCompressed = neutTFs.length >= 4
    || (_force > 0 && _force < 35)
    || (_atr > 0 && _atr < 5) // ATR en pips — < 5 pips = très compressé
    || (neutTFs.length === total);
  if (_isCompressed) {
    context = 'COMPRESSION';
    labels.push('Compression detectee — range serre, ATR faible. Aucune entree.');
    blockEntry = true;
  }

  // ── 4. IMPULSION / EXPLOSION ──────────────────────────────────────────────
  // Explosion = cassure forte, pulsion > 0.15%, force > 65%
  var _isImpulse = _pulsePct > 0.15 || (_force >= 65 && !_isCompressed);
  if (_isImpulse && !_isCompressed) {
    context = context === 'NEUTRE' ? 'IMPULSE' : context + '_IMPULSE';
    labels.push('Explosion en cours — cassure forte (' + _pulsePct.toFixed(2) + '%). Entree possible en momentum.');
  } else if (_force > 0 && _force < 50 && !_isCompressed) {
    labels.push('Impulsion faible — verifier la cassure avant d\'entrer');
  }

  // ── 5. PIÈGE (TRAP) ───────────────────────────────────────────────────────
  // Trap = direction précédente forte + retournement soudain
  var _hasTrap = _dirFlipped && _pulsePct > 0.08;
  if (_hasTrap) {
    context = 'TRAP';
    labels.push('Piege detecte — faux breakout + rejet. Preparer retournement.');
  }

  // ── 6. RETOURNEMENT ───────────────────────────────────────────────────────
  // Retournement validé = zone (H1 fort) + piège + structure cassée
  var _h1Aligned = ts.find(function(s){ return s.tf==='H1' && s.directional; });
  var _m15Signal = ts.find(function(s){ return s.tf==='M15' && s.directional; });
  var _isReversal = _hasTrap && _h1Aligned && _m15Signal
    && _h1Aligned.rec.replace('BUY','LONG').replace('SELL','SHORT') !==
       _m15Signal.rec.replace('BUY','LONG').replace('SELL','SHORT');
  if (_isReversal) {
    context = 'RETOURNEMENT';
    labels.push('Retournement valide — zone H1 + piege + cassure structure. Signal fort.');
    blockEntry = false; // retournement validé = on peut entrer
  }

  // ── 7. FILTRE FINAL ───────────────────────────────────────────────────────
  // Blocage total si conflit non résolu ou compression
  if (context === 'CONFLIT' || context === 'COMPRESSION') {
    blockEntry = true;
    labels.push('Filtre final : entree bloquee — pas de contexte valide.');
  } else if (!blockEntry && labels.length > 0) {
    labels.push('Filtre final : conditions acceptables — verifier SL et TP avant d\'entrer.');
  }

  return { context: context, labels: labels, blockEntry: blockEntry, pulsePct: _pulsePct };
}

// ─── ENTRY BIP ────────────────────────────────────────────────────────────────
// ─── AUTO SWITCH TF — quand winner TF trouvé ──────────────────────────────────
// 1. Bascule le TF actif dans l'extension + dashboard
// 2. Focus le tab TradingView et change l'intervalle
async function focusAndSwitchTVTimeframe(tf, dir) {
  if (!tf) return;
  // 1. Mettre à jour le TF dans l'extension (même logique que clic sur carte TF)
  state.timeframe = tf;
  scheduleSaveState();
  // Mettre en surbrillance la carte TF dans le sélecteur
  document.querySelectorAll('.tfc[data-tfc]').forEach(function(c) {
    c.classList.toggle('active', c.getAttribute('data-tfc') === tf);
  });

  // 2. Propager au serveur via /extension/command — dashboard se sync via SSE active-symbol
  try {
    await fetchJson('/extension/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'set-symbol',
        payload: { symbol: state.symbol, timeframe: tf, source: 'tradingview-extension' }
      })
    });
  } catch (_) {}

  // 3. Switch TF via content script — sans vol de focus (l'onglet TV reste en arrière-plan)
  // sendMessage fonctionne sur les onglets non-actifs : pas besoin d'activer tab/window
  try {
    var tvTabs = await chrome.tabs.query({ url: 'https://*.tradingview.com/*' });
    if (tvTabs.length === 0) return;
    var tvTab = tvTabs.find(function(t){ return t.active; }) || tvTabs[0];
    // PAS de chrome.tabs.update / chrome.windows.update → évite le saut de graphique
    chrome.tabs.sendMessage(tvTab.id, { type: 'SWITCH_TF', tf: tf }, function(resp) {
      if (chrome.runtime.lastError) return; // tab not ready — acceptable
    });
  } catch (_) {}
}

function playEntryBip() {
  if (state.muted) return;
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.15, 0.3].forEach(function(delay) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.3, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.12);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.15);
    });
  } catch(_) {}
}

// ─── MARKET OPEN ALERT ────────────────────────────────────────────────────────
// Tri-tone montant (C4→E4→G4) pour signaler l'ouverture du marché
function playMarketOpenBip() {
  if (state.muted) return;
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    [[261,0],[329,0.22],[392,0.44]].forEach(function(pair) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = pair[0];
      gain.gain.setValueAtTime(0.28, ctx.currentTime + pair[1]);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + pair[1] + 0.35);
      osc.start(ctx.currentTime + pair[1]);
      osc.stop(ctx.currentTime + pair[1] + 0.4);
    });
  } catch(_) {}
}

var _marketOpenWatcher = null;
function startMarketOpenWatcher() {
  if (_marketOpenWatcher) return; // already running
  var _mowEl = $('analysisText');
  if (_mowEl) _mowEl.textContent = '⏸ MARCHÉ FERMÉ — Surveillance active. Bip à l\'ouverture.';
  _marketOpenWatcher = setInterval(async function() {
    try {
      var r = await fetchJson('/extension/data');
      var ms = (r && r.currentData && r.currentData.marketStatus)
            || (r && r.marketStatus)
            || (state.live && state.live.marketStatus) || {};
      if (ms.isOpen === true) {
        clearInterval(_marketOpenWatcher);
        _marketOpenWatcher = null;
        playMarketOpenBip();
        speak('Le marché vient d\'ouvrir. Vous pouvez maintenant analyser et prendre des positions.');
        var _el2 = $('analysisText');
        if (_el2) _el2.textContent = '✅ MARCHÉ OUVERT — Prêt à analyser. Appuie sur ANALYSER.';
        refreshAll();
      }
    } catch(_) {}
  }, 30000); // check every 30s
}

// ─── WATCHDOG ENTRÉE AUTOMATIQUE ──────────────────────────────────────────────
// Déclenché après que l'utilisateur appuie sur ENTRER (= "je suis prêt").
// Surveille /coach/realtime toutes les 3s. Dès que canEnter=true, exécute l'entrée.
var _entryWatchdog = null;
var _entryWatchdogAttempts = 0;
var _WATCHDOG_MAX_ATTEMPTS = 200; // ~10 min à 3s/tick
// Confirmations consécutives — exige 3 ticks (9s) avant entrée (anti-lag Pine renforcé).
var _wdBridgeConfirmCount = 0;
// Stabilité zone — zone doit être vraie sur 2 ticks consécutifs AVANT d'entrer dans les gardes.
// Pine peut garder inBot/inTop=true pendant toute la durée d'une bougie même si prix sorti.
// Ce compteur est indépendant de _wdBridgeConfirmCount.
var _wdZoneStableCount = 0; // incrémente si zoneOk=true, reset si zoneOk=false
var _wdZoneWasOk = false;  // détecte transition false→true pour déclencher SCAN_TF une seule fois
// ── DÉTECTEUR CONTRADICTION ZONE/DIRECTION ──────────────────────────────────
var _wdZoneContraCount  = 0;     // ticks consécutifs de contradiction zone/direction
var _wdZoneContraLastAt = 0;     // timestamp dernier recalcul (cooldown 5min)
var _wdZoneContraActive = false; // recalcul async en cours — évite double déclenchement
// Vocal cadencé pendant l'attente — max 1 fois toutes les 30s, message varié
var _wdLastSpeakAt = 0;
var _wdLastSpeakState = '';
var _wdTotalSpeaks = 0; // compteur global — s'incrémente à chaque speak, garantit la rotation vraie
// News check — toutes les 10 min pendant le watchdog
var _wdNewsLastAt = 0;
var _wdNewsAlert  = null; // { label, impact, minutesLeft } ou null si RAS
// Annonce M1 — à chaque clôture de bougie M1 (chaque minute clock)
var _wdLastM1CandleId = 0; // floor(Date.now()/60000) — change à chaque clôture M1
// Anti-spam vocal — parle uniquement quand la condition bloquante change
var _wdLastBlockingKey = ''; // ex: 'ZONE', 'M5', 'M1', 'PULSION', 'OK'

// ── DÉTECTEUR ZONE PAR UT — vocal immédiat "M1 zone de retournement LONG" ─────
// Chaque UT a son propre tracker → quand inTop_M1 ou inBot_M1 change → vocal exact
// Labels OBLIGATOIRES : "zone de retournement SHORT" (inTop) / "zone de retournement LONG" (inBot)
var _wdPerTfZone = {
  M1: null, M5: null, M15: null, H1: null, H4: null
}; // null = inconnu, 'SHORT' = inTop, 'LONG' = inBot, 'NONE' = hors zone

// ── FRÉQUENCE DYNAMIQUE WATCHDOG ──────────────────────────────────────────────
// Normal (hors zone): 3000ms | Proche zone (<1%): 1500ms | Zone active: 800ms
// Le watchdog accélère dès que le prix approche d'un niveau clé → pas de tick raté
function _getWatchdogInterval() {
  var _bd = state._lastBridgeData;
  if (!_bd) return 3000;
  // Zone active (inTop/inBot = prix dedans) → scan maximal
  if (_bd.inTop === true || _bd.inBot === true) return 700;
  // Calcul proximité depuis liqHigh/liqLow (niveaux Pine)
  var _px  = Number(state.price || 0);
  var _lH  = Number(_bd.liqHigh || 0);
  var _lL  = Number(_bd.liqLow  || 0);
  if (_px > 0) {
    var _distH = _lH > 0 ? Math.abs(_px - _lH) / _px : 1;
    var _distL = _lL > 0 ? Math.abs(_px - _lL) / _px : 1;
    var _minDist = Math.min(_distH, _distL);
    if (_minDist < 0.001) return 700;  // < 0.1% = dans la zone → M1 priorité
    if (_minDist < 0.003) return 1000; // < 0.3% = bord de zone → scan M1+M5
    if (_minDist < 0.007) return 1500; // < 0.7% = approche → M5+M15 renforcé
    if (_minDist < 0.015) return 2500; // < 1.5% = surveillance accrue
  }
  return 3500; // loin → rythme normal
}

// Annonce vocale une seule fois par approche de zone (évite spam)
var _wdZoneApproachSpokenAt = 0;
function _checkZoneApproachVocal() {
  var _bd = state._lastBridgeData;
  if (!_bd || state.muted) return;
  var _px  = Number(state.price || 0);
  var _lH  = Number(_bd.liqHigh || 0);
  var _lL  = Number(_bd.liqLow  || 0);
  if (_px <= 0) return;
  var _distH = _lH > 0 ? Math.abs(_px - _lH) / _px : 1;
  var _distL = _lL > 0 ? Math.abs(_px - _lL) / _px : 1;
  var _minDist = Math.min(_distH, _distL);
  var _now = Date.now();
  // Vocal "approche zone" si entre 0.3% et 0.8%, max 1 fois toutes les 90s
  if (_minDist >= 0.003 && _minDist < 0.008 && _now - _wdZoneApproachSpokenAt > 90000) {
    _wdZoneApproachSpokenAt = _now;
    var _pxFmt = _px > 100 ? _px.toFixed(2) : _px.toFixed(5);
    var _nearZone = _distH < _distL ? 'zone haute' : 'zone basse';
    var _distPct = (_minDist * 100).toFixed(2);
    speak('Prix s\'approche de la ' + _nearZone + ' à ' + _distPct + ' pour cent. Je renforce le scan M5 et M15. J\'attends le signal de rejet.');
  }
}

function startEntryWatchdog() {
  stopEntryWatchdog();
  _entryWatchdogAttempts = 0;
  var _wdStartedAt = Date.now(); // repère temporel — expiry basé sur durée réelle (pas nb ticks)
  startLiveNewsMonitor(); // démarre le moniteur news live dès l'armement
  // ── SURVEILLANCE VOCALE — coach parle en continu pendant l'armement ───────
  if (!_continuousScanActive) startContinuousScan();

  // ── BOUCLE DYNAMIQUE — setTimeout récursif pour fréquence adaptative ──────
  var _wdStep = async function() {
    if (!_entryWatchdog) return; // watchdog arrêté → sort
    _entryWatchdogAttempts++;
    // Arrêter seulement si position entrée — jamais timeout tant qu'armé
    if (state.tradeState && state.tradeState.entered) { stopEntryWatchdog(); return; }

    // ── SÉCURITÉ BRIDGE — bridge > 30s sans données → désarmer immédiatement ──
    // Sans source de vérité live, toute direction/zone est stale → interdit de surveiller
    var _wdBridgeAgeMs = state._lastBridgeDataAt ? (Date.now() - state._lastBridgeDataAt) : Infinity;
    if (_wdBridgeAgeMs > 30000) {
      var _wdBridgeAgeSec = Math.round(_wdBridgeAgeMs / 1000);
      console.warn('[ADEL] WATCHDOG — bridge offline depuis', _wdBridgeAgeSec, 's → désarmement automatique');
      setCoachText(
        '⚠️ DÉSARMÉ — BRIDGE TV COUPÉ\n' +
        'Aucune donnée depuis ' + _wdBridgeAgeSec + 's — données non fiables.\n' +
        'Je ne peux pas surveiller sans source live.\n' +
        'Reconnecte TradingView pour réarmer.',
        '#ef4444', 9, 20000
      );
      speak('Bridge TradingView coupé. Désarmement automatique. Je ne surveille plus tant que les données ne sont pas rétablies. Reconnecte Pine Script.');
      await disarmRobot('Bridge TV coupé — désarmement sécurité.');
      return;
    }

    // ── MISSED ENTRY REVERSAL DETECTION ─────────────────────────────────────
    // Si le prix a dépassé la zone d'entrée de plus de 1.5x le SL prévu → setup raté
    // → Le marché a renversé → chercher le trade INVERSE (SHORT raté → chercher LONG)
    // Cooldown 3min pour éviter les boucles
    var _merdNow = Date.now();
    if (!state._missedEntryLastAt) state._missedEntryLastAt = 0;
    var _rvValMerd = state._rvValidatedLevels || null;
    var _armedDirMerd = state._armedDirection; // 'LONG' ou 'SHORT'
    if (_armedDirMerd && _rvValMerd && _rvValMerd.entry > 0 && state.price > 0
        && (_merdNow - state._missedEntryLastAt > 3 * 60 * 1000)) {
      var _merdEntry = Number(_rvValMerd.entry || 0);
      var _merdSl    = Number(_rvValMerd.sl    || 0);
      var _merdSlDist = _merdSl > 0 ? Math.abs(_merdEntry - _merdSl) : 0;
      var _merdMovedPast = (_armedDirMerd === 'LONG')
        ? (state.price < _merdEntry - _merdSlDist * 1.5) // LONG raté: prix tombé sous SL
        : (state.price > _merdEntry + _merdSlDist * 1.5); // SHORT raté: prix monté au-dessus
      if (_merdSlDist > 0 && _merdMovedPast) {
        state._missedEntryLastAt = _merdNow;
        var _merdRevDir = _armedDirMerd === 'LONG' ? 'SHORT' : 'LONG';
        console.log('[ADEL] MISSED ENTRY DETECTED — setup', _armedDirMerd, 'raté, prix a bougé. Cherche reversal', _merdRevDir);
        speak('Setup ' + _armedDirMerd + ' raté. Le marché a renversé. Je recalcule pour un ' + _merdRevDir + '. Attends mon analyse.');
        setCoachText('🔄 SETUP RATÉ — RECALCUL REVERSAL\nSetup ' + _armedDirMerd + ' manqué. Prix sorti de la zone.\nJe cherche maintenant un setup ' + _merdRevDir + ' sur le retournement.', '#f97316', 8, 10000);
        // Désarmer proprement puis relancer l'analyse après 3s
        stopEntryWatchdog();
        state.armed = false; state._armedAt = null; state._armedDirection = null;
        setTimeout(async function() {
          try {
            var _merdMtf = await analyzeAllTimeframesAndPickSetup();
            var _merdRec = (_merdMtf && _merdMtf.winner) ? String(_merdMtf.winner.rec || '').toUpperCase() : '';
            var _merdHasSetup = _merdRec.includes('BUY') || _merdRec.includes('LONG') || _merdRec.includes('SELL') || _merdRec.includes('SHORT');
            if (_merdHasSetup && !state.armed) {
              state._wdInitSpoken = false;
              await sendTradeAction('ENTER');
            }
          } catch(_) {}
        }, 3000);
        return;
      }
    }
    // Relancer le compteur toutes les 10min au lieu de désarmer — agent actif en continu
    if (Date.now() - _wdStartedAt > 10 * 60 * 1000) {
      _wdStartedAt = Date.now(); // reset compteur → repart pour 10min supplémentaires
      speak('Je continue de surveiller ' + (state.symbol || '') + '. Toujours en attente des conditions optimales.');
      console.log('[ADEL] WATCHDOG RELANCÉ — surveillance continue');
    }
    try {
      // ── GARDE ANTI-ENTRÉE IMMÉDIATE ──────────────────────────────────────────
      // Le watchdog ne peut pas entrer pendant les 8 premières secondes après armement.
      // Cela évite d'utiliser un canEnter=true stale du serveur et donne le temps
      // de lire les données bridge fraîches.
      var _armedDuration = Date.now() - (state._armedAt || 0);
      if (_armedDuration < 8000) {
        var _wdInitBd = state._lastBridgeData;
        var _wdInitM1  = _wdInitBd ? String(_wdInitBd.lectureTech1 || '').toUpperCase() : '';
        var _wdInitM5  = _wdInitBd ? String(_wdInitBd.lectureTech2 || '').toUpperCase() : '';
        var _wdInitM15 = _wdInitBd ? String(_wdInitBd.lectureTech3 || '').toUpperCase() : '';
        var _wdInitH1  = _wdInitBd ? String(_wdInitBd.lectureTech4 || '').toUpperCase() : '';
        var _wdInitZone = _wdInitBd ? ((_wdInitBd.inTop || _wdInitBd.inBot) ? 'Zone active' : 'Hors zone') : 'Données bridge en attente';
        var _wdInitStr = _wdInitBd
          ? 'M1: ' + (_wdInitM1 || '?') + ' | M5: ' + (_wdInitM5 || '?') + ' | M15: ' + (_wdInitM15 || '?') + ' | H1: ' + (_wdInitH1 || '?')
          : 'Bridge en attente...';
        setCoachText('🤖 ROBOT ARMÉ — Initialisation analyse multi-TF\n' + _wdInitStr + '\n' + _wdInitZone + ' — lecture en cours. Patiente 8s.', '#d97706', 5, 5000);
        if (_armedDuration < 2000 && !state._wdInitSpoken) {
          state._wdInitSpoken = true;
          speak('Système armé. J\'analyse maintenant M1, M5, M15 et H1. Je vérifie la zone, la pulsion et l\'alignement des timeframes. Je te dis ce qui bloque dans quelques secondes.');
        }
        return; // laisser passer 2-3 ticks avant toute décision
      }
      state._wdInitSpoken = false;

      // ── TF D'ANALYSE : JAMAIS M1 POUR LE SETUP ───────────────────────────────
      // M1 = timing d'exécution uniquement. Le setup doit être validé sur M5 minimum.
      // Hiérarchie : winner ANALYSER (M5/M15/H1) → state.timeframe (si ≥M5) → M5 par défaut
      // TF VERROUILLÉ À L'ARMEMENT — indépendant de la vue TradingView
      // state._lockedWdTf = fixé au moment de ENTRER, jamais mis à jour ensuite.
      // L'utilisateur peut changer de TF sur TradingView sans impacter l'analyse.
      var _wdTfRaw = state._lockedWdTf
        || ((state._mtfWinner && state._mtfWinner.tf) ? state._mtfWinner.tf : 'M15');
      var _wdTf = (_wdTfRaw === 'M1') ? 'M5' : _wdTfRaw; // M1 non valide → M5 min

      var cr = await fetchJson('/coach/realtime?symbol=' + encodeURIComponent(state.symbol) +
        '&tf=' + encodeURIComponent(_wdTf) + '&mode=' + encodeURIComponent(state.tradeMode) + '&lang=fr');
      var exec = (cr && cr.coach && cr.coach.execution) || (cr && cr.execution) || {};
      var sig  = (cr && cr.coach && cr.coach.signal)    || (cr && cr.signal)    || {};
      var conf = Number(sig.confidence || 0);

      // GUARD CONFLIT: si Pine/indicateurs en conflit → jamais d'entrée
      var _wdConflict = !!(exec.conflict) || !!(
        (cr && cr.coach && cr.coach.analysisSnapshot && cr.coach.analysisSnapshot.sourceSummary && cr.coach.analysisSnapshot.sourceSummary.conflictDetected) ||
        (cr && cr.analysisSnapshot && cr.analysisSnapshot.sourceSummary && cr.analysisSnapshot.sourceSummary.conflictDetected)
      );
      var _wdSl = Number(exec.sl || 0);
      var _wdTp = Number(exec.tp || 0);
      var _wdDir = String(
        state._wdOverrideDir ||   // override détecteur contradiction zone/direction
        ((cr&&cr.coach&&cr.coach.agents&&cr.coach.agents.analysis&&cr.coach.agents.analysis.recommendation) ||
         (cr&&cr.agents&&cr.agents.analysis&&cr.agents.analysis.recommendation) || '')
      ).toUpperCase();
      var _wdDirOk = _wdDir && _wdDir !== 'WAIT' && _wdDir !== 'NEUTRE' && _wdDir !== 'NEUTRAL';

      var _rvVal = state._rvValidatedLevels || null;
      var _effectiveSl  = _wdSl > 0 ? _wdSl  : (_rvVal && _rvVal.sl  > 0 ? _rvVal.sl  : 0);
      var _effectiveTp  = _wdTp > 0 ? _wdTp  : (_rvVal && _rvVal.tp  > 0 ? _rvVal.tp  : 0);
      // ── CAP SL — limites par type d'actif ET par mode ──────────────────────────
      // GOLD: SCALPER=25 USD | SNIPER=45 USD | SWING=80 USD
      // Crypto: 1.5% (SCALPER) → 3.0% (SWING) | Forex: 0.3% → 0.8%
      if (_effectiveSl > 0 && state.price > 0) {
        var _symUpCap = String(state.symbol || '').toUpperCase();
        var _isGoldCap   = /XAUUSD|GOLD/.test(_symUpCap);
        var _isCryptoCap = /BTC|ETH|SOL|XRP|BNB|ADA|LTC|AVAX|DOGE/.test(_symUpCap);
        var _isIndexCap  = /US30|NAS|SPX|DAX|CAC|FTSE|SP500|NDX|DOW/.test(_symUpCap);
        var _capModeRaw  = String(state.tradeMode || state._activeTradeMode || 'SNIPER').toUpperCase();
        var _isSwingCap  = _capModeRaw === 'SWING';
        var _isScalperCap= _capModeRaw === 'SCALPER' || _capModeRaw === 'SCALP' || _capModeRaw === 'SCALPING';
        var _maxSlDist;
        if (_isGoldCap) {
          _maxSlDist = _isSwingCap ? 80 : _isScalperCap ? 25 : 45; // SWING:80 | SNIPER:45 | SCALPER:25
        } else if (_isCryptoCap || _isIndexCap) {
          _maxSlDist = state.price * (_isSwingCap ? 0.030 : _isScalperCap ? 0.012 : 0.018);
        } else {
          _maxSlDist = state.price * (_isSwingCap ? 0.008 : _isScalperCap ? 0.003 : 0.005);
        }
        var _slDist = Math.abs(_effectiveSl - state.price);
        if (_slDist > _maxSlDist && _maxSlDist > 0) {
          var _slIsBelow = _effectiveSl < state.price;
          _effectiveSl = _slIsBelow ? state.price - _maxSlDist : state.price + _maxSlDist;
          if (_effectiveTp === 0 || Math.abs(_effectiveTp - state.price) < _maxSlDist * 2.0)
            _effectiveTp = _slIsBelow ? state.price + _maxSlDist * 2.0 : state.price - _maxSlDist * 2.0;
          if (_isGoldCap) console.log('[ADEL] SL CAP GOLD mode=' + _capModeRaw + ' max=' + _maxSlDist + ' USD — SL:', _effectiveSl.toFixed(2), '| TP:', _effectiveTp.toFixed(2));
        }
      }
      // ── FALLBACK 1 — niveaux Pine robotV12 (bougie fermée, cohérents avec prix ±3%) ──
      // Priorité sur liqHigh/liqLow car Pine calcule SL/TP sur structure réelle
      var _rv12 = cr ? (cr.robotV12 || null) : null;
      if ((_effectiveSl === 0 || _effectiveTp === 0) && _rv12 && state.price > 0) {
        var _rv12Sl = Number(_rv12.sl || 0);
        var _rv12Tp = Number(_rv12.tp || 0);
        var _rv12PxRef = Number(_rv12.entry || state.price);
        if (_rv12Sl > 0 && _rv12Tp > 0 && Math.abs(_rv12PxRef - state.price) / state.price < 0.03) {
          if (_effectiveSl === 0) _effectiveSl = _rv12Sl;
          if (_effectiveTp === 0) _effectiveTp = _rv12Tp;
        }
      }
      // ── FALLBACK 2 — zones Pine liqHigh/liqLow (dernier recours si robotV12 absent) ──
      if ((_effectiveSl === 0 || _effectiveTp === 0) && state.price > 0) {
        var _bdFbLvl    = state._lastBridgeData;
        var _liqHFb     = _bdFbLvl ? Number(_bdFbLvl.liqHigh || 0) : 0;
        var _liqLFb     = _bdFbLvl ? Number(_bdFbLvl.liqLow  || 0) : 0;
        var _fbDirIsLong = _wdDir.includes('LONG') || _wdDir.includes('BUY');
        if (_liqHFb > 0 && _liqLFb > 0 && _liqHFb > _liqLFb) {
          var _pxFb    = state.price;
          var _pxBuf   = _pxFb * 0.001;
          var _slFbV   = _fbDirIsLong ? (_liqLFb - _pxBuf) : (_liqHFb + _pxBuf);
          var _tpFbV   = _fbDirIsLong ?  _liqHFb            :  _liqLFb;
          var _slDistFb = Math.abs(_pxFb - _slFbV);
          var _tpDistFb = Math.abs(_pxFb - _tpFbV);
          var _slSide   = _fbDirIsLong ? (_slFbV < _pxFb) : (_slFbV > _pxFb);
          var _tpSide   = _fbDirIsLong ? (_tpFbV > _pxFb) : (_tpFbV < _pxFb);
          if (_slDistFb > 0 && _tpDistFb >= _slDistFb * 1.2 && _slSide && _tpSide) {
            if (_effectiveSl === 0) _effectiveSl = _slFbV;
            if (_effectiveTp === 0) _effectiveTp = _tpFbV;
          }
        }
      }
      // ── CAP SL FINAL — appliqué après tous les fallbacks (robotV12 + liqHigh/liqLow) ──
      // Nécessaire car les fallbacks ci-dessus peuvent injecter un SL qui dépasse la limite
      if (_effectiveSl > 0 && state.price > 0) {
        var _symUpCap2   = String(state.symbol || '').toUpperCase();
        var _isGoldCap2  = /XAUUSD|GOLD/.test(_symUpCap2);
        var _isCryptoCap2= /BTC|ETH|SOL|XRP|BNB|ADA|LTC|AVAX|DOGE/.test(_symUpCap2);
        var _isIdxCap2   = /US30|NAS|SPX|DAX|CAC|FTSE|SP500|NDX|DOW/.test(_symUpCap2);
        var _capModeRaw2  = String(state.tradeMode || state._activeTradeMode || 'SNIPER').toUpperCase();
        var _isSwingCap2  = _capModeRaw2 === 'SWING';
        var _isScalerCap2 = _capModeRaw2 === 'SCALPER' || _capModeRaw2 === 'SCALP' || _capModeRaw2 === 'SCALPING';
        var _maxSlDist2  = _isGoldCap2 ? (_isSwingCap2 ? 80 : _isScalerCap2 ? 25 : 45)
                         : (_isCryptoCap2 || _isIdxCap2) ? state.price * (_isSwingCap2 ? 0.030 : _isScalerCap2 ? 0.012 : 0.018)
                         : state.price * (_isSwingCap2 ? 0.008 : _isScalerCap2 ? 0.003 : 0.005);
        var _slDist2     = Math.abs(_effectiveSl - state.price);
        if (_slDist2 > _maxSlDist2) {
          var _slBelow2  = _effectiveSl < state.price;
          _effectiveSl   = _slBelow2 ? state.price - _maxSlDist2 : state.price + _maxSlDist2;
          if (_effectiveTp === 0 || Math.abs(_effectiveTp - state.price) < _maxSlDist2 * 2.0)
            _effectiveTp = _slBelow2 ? state.price + _maxSlDist2 * 2.0 : state.price - _maxSlDist2 * 2.0;
        }
      }

      // ── LECTURE BRIDGE LIVE — source de vérité TF ──────────────────────────
      var _bdLive = state._lastBridgeData || null;
      // Fallback RSI quand Pine ne transmet pas lectureTech via webhook (_ltUpdatedAt=null)
      // Sans ça: _lt2='', _m5Conf=false → watchdog bloque pour toujours même avec RSI=62
      function _wdLecFromRsi(r) { r=Number(r||0); if(r<=0||r>100) return ''; if(r>=60) return 'ACHAT_FORT'; if(r>=55) return 'ACHAT'; if(r<=40) return 'VENTE_FORTE'; if(r<=45) return 'VENTE'; return 'NEUTRE'; }
      function _wdLec(lt, ts, rsi) { if(ts) return String(lt||'').toUpperCase(); var _r=_wdLecFromRsi(rsi); return _r||String(lt||'').toUpperCase(); }
      var _lt1 = _bdLive ? _wdLec(_bdLive.lectureTech1, _bdLive._lt1UpdatedAt, _bdLive.rsiTf1) : ''; // M1
      var _lt2 = _bdLive ? _wdLec(_bdLive.lectureTech2, _bdLive._lt2UpdatedAt, _bdLive.rsiTf2) : ''; // M5
      var _lt3 = _bdLive ? _wdLec(_bdLive.lectureTech3, _bdLive._lt3UpdatedAt, _bdLive.rsiTf3) : ''; // M15
      var _lt4 = _bdLive ? _wdLec(_bdLive.lectureTech4, _bdLive._lt4UpdatedAt, _bdLive.rsiTf4) : ''; // H1
      var _wdIsLong2  = _wdDir.includes('BUY') || _wdDir.includes('LONG');
      var _wdIsShort2 = _wdDir.includes('SELL') || _wdDir.includes('SHORT');
      // GUARD: si serveur retourne WAIT → fallback direction depuis sources disponibles
      if (!_wdIsLong2 && !_wdIsShort2) {
        var _bdFb = state._lastBridgeData;
        // Priorité 1 — Pine verdict/anticipation (analyse multi-bar, plus fiable que RSI seul)
        var _pineVerdict = String(
          (_bdFb && (_bdFb.anticipation || _bdFb.verdict)) ||
          (cr && cr.robotV12 ? (cr.robotV12.anticipation || cr.robotV12.verdict) : '') || ''
        ).toUpperCase();
        if (_pineVerdict.includes('LONG') || _pineVerdict.includes('ACHAT') || _pineVerdict.includes('BUY') || _pineVerdict.includes('HAUSSE')) {
          _wdDir = 'LONG'; _wdIsLong2 = true; _wdIsShort2 = false; _wdDirOk = true;
        } else if (_pineVerdict.includes('SHORT') || _pineVerdict.includes('VENTE') || _pineVerdict.includes('SELL') || _pineVerdict.includes('BAISSE')) {
          _wdDir = 'SHORT'; _wdIsLong2 = false; _wdIsShort2 = true; _wdDirOk = true;
        } else {
          // Priorité 2 — RSI bridge (fallback quand Pine n'a pas de verdict directionnel)
          var _rsiFb = _bdFb ? Number(_bdFb.rsiTf1 || _bdFb.rsiTf2 || _bdFb.rsiTf3 || 0) : 0;
          if (_rsiFb <= 0 && _bdFb && _bdFb.indicators) _rsiFb = Number(_bdFb.indicators.rsi || 0);
          if (_rsiFb >= 58) {
            _wdDir = 'LONG'; _wdIsLong2 = true; _wdIsShort2 = false; _wdDirOk = true;
          } else if (_rsiFb <= 42) {
            _wdDir = 'SHORT'; _wdIsLong2 = false; _wdIsShort2 = true; _wdDirOk = true;
          } else {
            // Ni Pine ni RSI directionnels → attendre signal clair
            setCoachText('⏳ MARCHÉ NEUTRE — RSI ' + (_rsiFb > 0 ? Math.round(_rsiFb) : '?') + '\nJ\'attends un signal Pine ou RSI directionnel (>58 ou <42).\nJe rescanne dans 3s.', '#64748b', 3, 4000);
            return;
          }
        }
      }
      // _effectiveDirOk ici — après fallback RSI direction (qui peut modifier _wdDirOk)
      var _effectiveDirOk = _wdDirOk;
      // ══════════════════════════════════════════════════════════════════════
      // LOGIQUE D'ENTRÉE — H1=filtre | M15=setup | M5=confirmation | M1=timing
      // BLOCS rouge/vert = décision. Lignes orange = information uniquement.
      // ══════════════════════════════════════════════════════════════════════
      var _bd = _bdLive;
      var _userModeIsSniper = (state.tradeMode || '').toUpperCase() === 'SNIPER';

      // Direction: serveur fait autorité — bridge M5 est informatif uniquement
      var _isLong  = _wdIsLong2;
      var _isShort = _wdIsShort2;

      // 1. FILTRE H1 — contexte macro
      // SWING/SCALP/AUTO: bloque si H1 fortement contraire
      // SNIPER: H1 est informatif — bloque seulement si macro en run extrême (>80%)
      var _macBull = _bd ? Number(_bd.macroBull || 0) : 0;
      var _macBear = _bd ? Number(_bd.macroBear || 0) : 0;
      var _h1IsStrongBull = _lt4 === 'ACHAT_FORT';
      var _h1IsStrongBear = _lt4 === 'VENTE_FORTE';
      var _ctxOk;
      if (_userModeIsSniper) {
        // SNIPER: autorise contre-tendance — bloque seulement macro extrême (>80 vs <20)
        var _macroExtremeBull = _macBull > 80 && _macBear < 20;
        var _macroExtremeBear = _macBear > 80 && _macBull < 20;
        _ctxOk = _isLong ? !_macroExtremeBear : !_macroExtremeBull;
      } else {
        _ctxOk = _isLong
          ? ((_macBull >= _macBear) || !_h1IsStrongBear)
          : ((_macBear >= _macBull) || !_h1IsStrongBull);
      }

      // 2. SETUP M15 — obligatoire (VENTE/VENTE_FORTE pour SHORT, ACHAT/ACHAT_FORT pour LONG)
      var _m15Setup = _isLong
        ? (_lt3.includes('ACHAT') && !_lt3.includes('NEUTRE'))
        : (_lt3.includes('VENTE') && !_lt3.includes('NEUTRE'));

      // 3. CONFIRMATION M5 — obligatoire (même règle que M15)
      var _m5Conf = _isLong
        ? (_lt2.includes('ACHAT') && !_lt2.includes('NEUTRE'))
        : (_lt2.includes('VENTE') && !_lt2.includes('NEUTRE'));

      // 4. TIMING M1 — aide uniquement, jamais seul déclencheur
      var _m1Timing = _isLong ? _lt1.includes('ACHAT') : _lt1.includes('VENTE');

      // ── SNIPER AGRESSIF — bypass M15 si M1+M5+zone+rejet et M15 pas fortement opposé ──
      // M15 fortement opposé = VENTE_FORTE (pour LONG) ou ACHAT_FORT (pour SHORT)
      var _lt3IsStrongOpp = _isLong ? (_lt3 === 'VENTE_FORTE') : (_lt3 === 'ACHAT_FORT');
      var _sniperAgressif = !_m15Setup && _m5Conf && _m1Timing && !_lt3IsStrongOpp && _ctxOk;

      // 5. ZONE BLOC — inTop/inBot strict + zoneLiqHaute/Basse comme renfort
      var _inTopNow  = _bd ? (_bd.inTop === true) : false;
      var _inBotNow  = _bd ? (_bd.inBot  === true) : false;
      // zoneLiq: Pine envoie ces champs quand le prix est dans la zone de liquidité (même si pas encore à rangeLow/rangeHigh)
      var _liqBotNow = _bd ? (_bd.zoneLiqBasse === true) : false;
      var _liqTopNow = _bd ? (_bd.zoneLiqHaute === true) : false;
      // zone active = inBot/inTop strict OU zoneLiq (approche confirmée par Pine)
      var _zoneLongActive  = _inBotNow || _liqBotNow;
      var _zoneShortActive = _inTopNow || _liqTopNow;
      var _isSynthZone = _bd && _bd._synthZone === true;

      // ── RÈGLE NON MODIFIABLE — zone de retournement = direction forcée ──────
      // inBot=true (zone de retournement LONG) → LONG uniquement, aucune exception
      // inTop=true (zone de retournement SHORT) → SHORT uniquement, aucune exception
      // Cette règle surcharge la direction serveur. Bridge zone = autorité absolue.
      if (_zoneLongActive && !_zoneShortActive) {
        if (_wdDir !== 'LONG') {
          _wdDir = 'LONG';
          state._wdOverrideDir = 'LONG';
          _wdIsLong2 = true; _wdIsShort2 = false; _wdDirOk = true;
          if (Date.now() - _wdLastSpeakAt > 8000) {
            var _zLongLabel = _inBotNow ? 'Zone de retournement LONG détectée.' : 'Zone de liquidité LONG atteinte.';
            speak(_zLongLabel + ' Je passe en mode LONG uniquement. Je cherche les confirmations de timeframes pour entrer en achat.');
            _wdLastSpeakAt = Date.now();
          }
        }
        _isLong = true; _isShort = false;
      } else if (_zoneShortActive && !_zoneLongActive) {
        if (_wdDir !== 'SHORT') {
          _wdDir = 'SHORT';
          state._wdOverrideDir = 'SHORT';
          _wdIsLong2 = false; _wdIsShort2 = true; _wdDirOk = true;
          if (Date.now() - _wdLastSpeakAt > 8000) {
            var _zShortLabel = _inTopNow ? 'Zone de retournement SHORT détectée.' : 'Zone de liquidité SHORT atteinte.';
            speak(_zShortLabel + ' Je passe en mode SHORT uniquement. Je cherche les confirmations de timeframes pour entrer en vente.');
            _wdLastSpeakAt = Date.now();
          }
        }
        _isLong = false; _isShort = true;
      } else if (!_zoneLongActive && !_zoneShortActive) {
        // Hors zone — libérer l'override collé d'une zone précédente
        // Évite que SHORT reste bloqué quand le prix revient vers zone LONG
        if (state._wdOverrideDir) {
          state._wdOverrideDir = null;
          // Ne pas parler — juste libérer silencieusement pour permettre recalcul RSI/Pine
        }
      }
      // Recalcul filtrages direction-dépendants après forçage zone
      if (_userModeIsSniper) {
        _ctxOk = _isLong ? !(_macBear > 80 && _macBull < 20) : !(_macBull > 80 && _macBear < 20);
      } else {
        _ctxOk = _isLong
          ? ((_macBull >= _macBear) || !_h1IsStrongBear)
          : ((_macBear >= _macBull) || !_h1IsStrongBull);
      }
      _m15Setup = _isLong
        ? (_lt3.includes('ACHAT') && !_lt3.includes('NEUTRE'))
        : (_lt3.includes('VENTE') && !_lt3.includes('NEUTRE'));
      _m5Conf = _isLong
        ? (_lt2.includes('ACHAT') && !_lt2.includes('NEUTRE'))
        : (_lt2.includes('VENTE') && !_lt2.includes('NEUTRE'));
      _m1Timing = _isLong ? _lt1.includes('ACHAT') : _lt1.includes('VENTE');
      _lt3IsStrongOpp = _isLong ? (_lt3 === 'VENTE_FORTE') : (_lt3 === 'ACHAT_FORT');
      _sniperAgressif = !_m15Setup && _m5Conf && _m1Timing && !_lt3IsStrongOpp && _ctxOk;

      var _zoneOk   = _isLong ? (_inBotNow && !_inTopNow) : _isShort ? (_inTopNow && !_inBotNow) : false;

      // ── LABELS BRIDGE EXACTS — à utiliser dans TOUS les vocaux (pas d'interprétation) ──
      // inTop = true → "zone de retournement SHORT"
      // inBot = true → "zone de retournement LONG"
      // liqHigh (valeur) → "zone de liquidité haute"
      // liqLow  (valeur) → "zone de liquidité basse"
      var _bdZoneLabel = _inTopNow ? 'zone de retournement SHORT'
                       : _inBotNow ? 'zone de retournement LONG'
                       : 'hors zone';
      // Zone synthétique (Pine absent) — marquer visuellement mais ne pas bloquer
      var _synthZoneSuffix = _isSynthZone ? ' [SYNTH]' : '';
      var _bdZoneAtteinte = _inTopNow ? 'Zone de retournement SHORT atteinte.'
                          : _inBotNow ? 'Zone de retournement LONG atteinte.'
                          : '';
      var _bdZoneTarget = _isLong ? 'zone de retournement LONG' : 'zone de retournement SHORT';
      var _bdLiqHLabel  = 'zone de liquidité haute';
      var _bdLiqLLabel  = 'zone de liquidité basse';

      // ── DÉTECTEUR ZONE PAR UT — dérivé depuis bridge existant sans Pine per-TF ──
      // Règle : zone globale (inTop/inBot) + lectureTech confirmant dans le même sens
      //   inTop=true + lectureTech inclut 'VENTE' → "zone de retournement SHORT" sur ce TF
      //   inBot=true + lectureTech inclut 'ACHAT' → "zone de retournement LONG" sur ce TF
      // Si Pine envoie inTop_M1 etc. → priorité absolue (champ Pine > dérivation)
      // H4 : lectureTech5 si disponible, sinon 'NONE'
      if (_bd && !state.muted) {
        var _lt5 = String(_bd.lectureTech5 || '').toUpperCase();
        var _perTfDefs = [
          { tf: 'M1',
            inTop: (_bd.inTop_M1  === true) || (_inTopNow && (_lt1.includes('VENTE'))),
            inBot: (_bd.inBot_M1  === true) || (_inBotNow && (_lt1.includes('ACHAT'))) },
          { tf: 'M5',
            inTop: (_bd.inTop_M5  === true) || (_inTopNow && (_lt2.includes('VENTE'))),
            inBot: (_bd.inBot_M5  === true) || (_inBotNow && (_lt2.includes('ACHAT'))) },
          { tf: 'M15',
            inTop: (_bd.inTop_M15 === true) || (_inTopNow && (_lt3.includes('VENTE'))),
            inBot: (_bd.inBot_M15 === true) || (_inBotNow && (_lt3.includes('ACHAT'))) },
          { tf: 'H1',
            inTop: (_bd.inTop_H1  === true) || (_inTopNow && (_lt4.includes('VENTE'))),
            inBot: (_bd.inBot_H1  === true) || (_inBotNow && (_lt4.includes('ACHAT'))) },
          { tf: 'H4',
            inTop: (_bd.inTop_H4  === true) || (_inTopNow && _lt5.length > 0 && _lt5.includes('VENTE')),
            inBot: (_bd.inBot_H4  === true) || (_inBotNow && _lt5.length > 0 && _lt5.includes('ACHAT')) },
        ];
        var _perTfNewZones = [];
        for (var _ptfi = 0; _ptfi < _perTfDefs.length; _ptfi++) {
          var _ptf = _perTfDefs[_ptfi];
          var _ptfZone = _ptf.inTop ? 'SHORT' : _ptf.inBot ? 'LONG' : 'NONE';
          var _ptfPrev = _wdPerTfZone[_ptf.tf];
          if (_ptfPrev !== _ptfZone) {
            _wdPerTfZone[_ptf.tf] = _ptfZone;
            // Vocal uniquement sur transition vers une zone (pas sur sortie de zone)
            if (_ptfZone !== 'NONE') {
              var _ptfLabel = _ptf.tf + ' zone de retournement ' + _ptfZone;
              _perTfNewZones.push(_ptfLabel);
            }
          }
        }
        // Si de nouvelles zones détectées → vocal groupé immédiat (hors cooldown normal)
        if (_perTfNewZones.length > 0 && (Date.now() - _wdLastSpeakAt > 4000)) {
          var _ptfSpeak = _perTfNewZones.join(', ') + '. ';
          _ptfSpeak += _perTfNewZones.length > 1 ? 'Zones multiples confirmées. J\'analyse.' : 'Zone confirmée. J\'analyse.';
          speak(_ptfSpeak);
          _wdLastSpeakAt = Date.now();
        }
      }

      // 6. PULSION/REJET — bearRej (SHORT) ou bullRej (LONG)
      var _bearRejNow = _bd && _bd.bearRej === true;
      var _bullRejNow = _bd && _bd.bullRej === true;
      var _pulsionOk  = _isLong ? _bullRejNow : _bearRejNow;

      // 7. RSI GUARD — marché déjà épuisé
      var _rsiM15v    = _bd ? Number(_bd.rsiTf3 || 0) : 0;
      var _rsiDrained = (_isShort && _rsiM15v > 0 && _rsiM15v < 30)
                     || (_isLong  && _rsiM15v > 0 && _rsiM15v > 70);

      // Alias display (pour _tfStatusLine et banner)
      var _m1ok2  = _m1Timing;
      var _m5ok2  = _m5Conf;
      var _m15ok2 = _m15Setup;
      var _h1ok2  = _isLong ? _lt4.includes('ACHAT') : _lt4.includes('VENTE');

      // SNIPER: M15/H1 = informatifs seulement (ℹ pas ❌)
      var _m15disp = _userModeIsSniper ? (_m15ok2?'✅':'ℹ') : (_m15ok2?'✅':'❌');
      var _h1disp  = _userModeIsSniper ? (_h1ok2?'✅':'ℹ') : (_h1ok2?'✅':'❌');
      var _tfStatusLine = 'M1:' + (_m1ok2?'✅':'❌') + ' M5:' + (_m5ok2?'✅':'❌') +
                          ' M15:' + _m15disp + (_userModeIsSniper&&!_m15ok2?' (info)':'') +
                          ' H1:' + _h1disp  + (_userModeIsSniper&&!_h1ok2?' (info)':'') +
                          ' | Bloc:' + (_zoneOk?'✅':'❌') + ' Puls:' + (_pulsionOk?'✅':'⏳');

      var _serverSaysEnter = exec.canEnter === true;
      var _isAutoMode = (state.tradeMode || 'AUTO').toUpperCase() === 'AUTO';
      // RÈGLE AUTO_MODE_SELECT: en mode AUTO, détecter le bon scénario tôt pour le bypass
      // Priorité: SNIPER_AGRESSIF > SWING > SCALPING > SNIPER
      var _autoEarlyMode = _sniperAgressif ? 'SNIPER_AGRESSIF'
        : (_h1ok2 && _m15Setup) ? 'SWING'
        : (_m5Conf && _m15Setup) ? 'SCALPING'
        : (_m5Conf && _m1Timing) ? 'SNIPER'
        : 'ATTENTE';
      // Annoncer le mode AUTO sélectionné si changé
      if (_isAutoMode && _autoEarlyMode !== 'ATTENTE' && _autoEarlyMode !== state._lastAutoDetectedMode) {
        state._lastAutoDetectedMode = _autoEarlyMode;
        var _modeAnnonceName = _autoEarlyMode === 'SNIPER_AGRESSIF' ? 'SNIPER AGRESSIF'
          : _autoEarlyMode === 'SCALPING' ? 'SCALP'
          : _autoEarlyMode;
        var _modeReason = _autoEarlyMode === 'SWING' ? 'H1 et M15 alignés — structure longue détectée.'
          : _autoEarlyMode === 'SCALPING' ? 'M5 et M15 alignés, H1 neutre — scalp structuré.'
          : _autoEarlyMode === 'SNIPER_AGRESSIF' ? 'Zone + M5 + M1 + rejet, M15 toléré — entrée chirurgicale rapide.'
          : 'Zone + M5 + M1 confirmés — entrée précise.';
        if (Date.now() - _wdLastSpeakAt > 5000) {
          speak('Mode AUTO: ' + _modeAnnonceName + ' validé. ' + _modeReason);
          _wdLastSpeakAt = Date.now();
        }
      }
      // RÈGLE SNIPER_SCALP_LOCAL_BYPASS (étendue à AUTO):
      // Zone (stable 2+ ticks) + M5 + M1 + contexte = bypass canEnter serveur autorisé
      // En AUTO, bypass activé si mode détecté est SNIPER/SCALP/SWING avec conditions complètes
      var _autoCondBase = _zoneOk && _wdZoneStableCount >= 2 && _m1Timing && _ctxOk;
      var _autoBypassOk = _isAutoMode && _autoCondBase && (
        ((_autoEarlyMode === 'SNIPER' || _autoEarlyMode === 'SNIPER_AGRESSIF') && _m5Conf) ||
        (_autoEarlyMode === 'SCALPING' && _m5Conf && _m15Setup) ||
        (_autoEarlyMode === 'SWING' && _m5Conf && _m15Setup && _h1ok2)
      );
      var _modeAllowsBypass = _userModeIsSniper || (state.tradeMode || '').toUpperCase() === 'SCALP' || _autoBypassOk;
      var _sniperBridgeOk = _modeAllowsBypass && _zoneOk && _wdZoneStableCount >= 2 && _m5Conf && _m1Timing && _pulsionOkOrAbsent && _ctxOk;
      // Conflit bloquant: bypass AUTO si zone+M5+pulsion confirmés (même logique que SNIPER)
      var _conflictBlocking = _wdConflict && !(_userModeIsSniper && _m5Conf && _zoneOk && _pulsionOk) && !_autoBypassOk;
      // ── GARDE ZONE — _zoneOk devient bloquant quand le bridge a des données zone ─
      // Si bridge fournit inTop/inBot (non-null) → la zone DOIT être correcte avant d'entrer.
      // Si bridge n'a pas de données zone → le serveur a déjà validé via RSI fallback → on lui fait confiance.
      // Résultat: SHORT en zone basse = IMPOSSIBLE. LONG en zone haute = IMPOSSIBLE.
      var _bridgeHasZoneInfo = _bd && (_bd.inTop != null || _bd.inBot != null);
      var _hasBridgeTfData  = _bdLive && (_bdLive._lt2UpdatedAt != null || _bdLive.rsiTf2 != null || _bdLive._lt3UpdatedAt != null || _bdLive.rsiTf3 != null);
      var _bridgeHasPulsionInfo = _bd && (_bd.bullRej !== null && _bd.bullRej !== undefined || _bd.bearRej !== null && _bd.bearRej !== undefined);
      // Si Pine n'envoie pas d'info pulsion → pas de blocage sur pulsion (guard F le gère aussi)
      var _pulsionOkOrAbsent = _pulsionOk || !_bridgeHasPulsionInfo;
      // ZONE GUARD — RÈGLE PRO ABSOLUE: jamais au milieu du range
      // Si bridge a des données inTop/inBot → zone doit être correcte
      // Si bridge n'a PAS inTop/inBot → utiliser RSI M15 RÉEL comme proxy de zone:
      //   RSI M15 < 35 = survente = zone basse (favorable LONG)
      //   RSI M15 > 65 = excès haussier = zone haute (favorable SHORT)
      //   RSI M15 35-65 = MILIEU DU RANGE → BLOQUER L'ENTRÉE
      // SYNC FIX #4: si RSI synthétique (_synthRsiUsed=true) → zone inconnue → bloquer
      // RSI synth = momentum (EMA fast/slow) — NE représente PAS une zone de prix Pine.
      // Utiliser RSI synth comme zone créerait contradiction: synth 18 = SELL (momentum)
      // mais zone fallback: 18<35 = "zone basse favorable LONG" → entrée LONG hors zone réelle.
      var _synthRsiActive = _bd && !!_bd._synthRsiUsed;
      var _rsiM15forZone = _bd ? Number(_bd.rsiTf3 || 0) : 0;
      var _rsiZoneFallback = (!_synthRsiActive && _rsiM15forZone > 0)
        ? ((_isLong  && _rsiM15forZone < 38) || (_isShort && _rsiM15forZone > 62))
        : false; // RSI synth ou absent = zone inconnue = bloquer
      // ANTI-LAG PINE: inBot/inTop Pine peut rester true plusieurs bougies par lag.
      // Si RSI M15 réel contredit la zone Pine → artefact Pine → invalider la zone.
      // LONG+inBot: RSI doit être < 55 (si RSI=64.7 et inBot=true → lag → bloquer)
      // SHORT+inTop: RSI doit être > 45 (si RSI=35 et inTop=true → lag → bloquer)
      var _pineLagBot = _inBotNow && _rsiM15forZone > 55 && _rsiM15forZone > 0;
      var _pineLagTop = _inTopNow && _rsiM15forZone < 45 && _rsiM15forZone > 0;
      var _pineLagDetected = (_isLong && _pineLagBot) || (_isShort && _pineLagTop);
      var _zoneOkAntiLag = _zoneOk && !_pineLagDetected;
      var _zoneGuard = _bridgeHasZoneInfo ? _zoneOkAntiLag : _rsiZoneFallback;
      // _sniperBridgeOk = bypass local pour SNIPER/SCALP quand zone+TF+rejet confirmés
      var _canEnterFinal = (_serverSaysEnter || _sniperBridgeOk) && _wdDirOk && _zoneGuard; // zone bloquante même sans inTop/inBot
      var _dirLabel = _isLong ? 'LONG' : 'SHORT';

      // ── DÉTECTEUR CONTRADICTION ZONE/DIRECTION ────────────────────────────────
      // Quand la zone contredit la direction figée depuis 4 ticks (≈12-16s)
      // ET qu'aucune entrée n'est possible → recalcul automatique sens + type setup.
      var _zoneContra = _bridgeHasZoneInfo && !_canEnterFinal && !_wdZoneContraActive && (
        (_isShort && _zoneLongActive && !_zoneShortActive) ||
        (_isLong  && _zoneShortActive && !_zoneLongActive)
      );
      if (_zoneContra) { _wdZoneContraCount++; } else { if (!_zoneContra && _wdZoneContraCount > 0 && !_wdZoneContraActive) _wdZoneContraCount = 0; }

      if (_wdZoneContraCount >= 4 && !_wdZoneContraActive) {
        var _nowContra = Date.now();
        if ((_nowContra - _wdZoneContraLastAt) > 5 * 60 * 1000) {
          _wdZoneContraLastAt = _nowContra;
          _wdZoneContraCount  = 0;
          _wdZoneContraActive = true;
          var _contraOldDir   = _isLong ? 'LONG' : 'SHORT';
          var _contraOldType  = (state._lockedSetupType || 'SWING').toUpperCase();
          var _contraZoneLbl  = _inBotNow ? 'basse' : 'haute';
          speak('Contradiction zone direction détectée. Ancien scénario : ' + _contraOldType + ' ' + _contraOldDir
            + '. Zone ' + _contraZoneLbl + ' active depuis plusieurs secondes, sens contraire. Je recalcule maintenant.');
          setCoachText('🔄 RECALCUL — CONTRADICTION ZONE/' + _contraOldDir
            + '\nAncien : ' + _contraOldType + ' ' + _contraOldDir
            + ' | Zone ' + _contraZoneLbl.toUpperCase() + ' active\nNouveau sens en évaluation...', '#f97316', 7, 8000);
          (async function(_cOldDir, _cOldType, _cInBot, _cInTop) {
            try {
              var _mtfR = await analyzeAllTimeframesAndPickSetup();
              var _newRec     = _mtfR && _mtfR.winner ? String(_mtfR.winner.rec || '').toUpperCase() : '';
              var _newIsLong  = _newRec.includes('LONG') || _newRec.includes('BUY');
              var _newIsShort = _newRec.includes('SHORT') || _newRec.includes('SELL');
              var _bdR  = state._lastBridgeData;
              var _lt2r = _bdR ? String(_bdR.lectureTech2||'').toUpperCase() : '';
              var _lt3r = _bdR ? String(_bdR.lectureTech3||'').toUpperCase() : '';
              var _lt4r = _bdR ? String(_bdR.lectureTech4||'').toUpperCase() : '';
              var _newM5ok  = _newIsLong ? _lt2r.includes('ACHAT') : _lt2r.includes('VENTE');
              var _newM15ok = _newIsLong ? _lt3r.includes('ACHAT') : _lt3r.includes('VENTE');
              var _newH1ok  = _newIsLong ? _lt4r.includes('ACHAT') : _lt4r.includes('VENTE');
              var _newDirLabel  = _newIsLong ? 'LONG' : _newIsShort ? 'SHORT' : 'NEUTRE';
              var _newZoneMatch = (_newIsLong && _cInBot) || (_newIsShort && _cInTop);
              var _newType, _newTypeReason, _newTypeBlocking;
              if (!_newIsLong && !_newIsShort) {
                _newType = null; _newTypeReason = 'direction incertaine — serveur dit NEUTRE';
                _newTypeBlocking = 'aucun setup propre, je bloque';
              } else if (_newM5ok && _newH1ok && _newM15ok) {
                _newType = 'SWING'; _newTypeReason = 'H1 + M15 + M5 alignés ' + (_newIsLong?'haussiers':'baissiers');
                _newTypeBlocking = _newZoneMatch ? 'j\'attends confirmation M1 à la clôture' : 'zone pas encore en accord';
              } else if (_newM5ok && _newM15ok && !_newH1ok) {
                _newType = 'SCALP'; _newTypeReason = 'M5 + M15 alignés, H1 neutre ou contraire';
                _newTypeBlocking = _newZoneMatch ? 'scalp possible si M1 confirme à la clôture' : 'zone pas encore en accord';
              } else if (_newM5ok && !_newM15ok) {
                _newType = 'SNIPER'; _newTypeReason = 'M5 seul confirmé — entrée chirurgicale';
                _newTypeBlocking = _newZoneMatch ? 'sniper envisageable — j\'attends rejet M1 en zone' : 'zone hors sens';
              } else {
                _newType = null; _newTypeReason = 'M5 non confirmé';
                _newTypeBlocking = 'aucun setup valide actuellement';
              }
              var _confLevel = (_newM15ok && _newH1ok) ? 'élevée' : _newM15ok ? 'modérée' : 'faible';
              var _postSpeak = 'Recalcul terminé. Ancien scénario : ' + _cOldType + ' ' + _cOldDir + '. ';
              if (!_newType) {
                _postSpeak += 'Nouveau : aucun setup propre — ' + _newTypeReason + '. Je reste en surveillance sans entrée.';
                state._wdOverrideDir = null;
              } else {
                _postSpeak += 'Nouveau scénario : ' + _newType + ' ' + _newDirLabel + '. ' + _newTypeReason + '. ';
                _postSpeak += _newTypeBlocking + '. ';
                _postSpeak += 'Confiance : ' + _confLevel + '. ';
                _postSpeak += _newZoneMatch
                  ? 'Zone et sens alignés.'
                  : 'Zone pas encore confirmée dans ce sens. Je surveille.';
                state._wdOverrideDir   = _newDirLabel;
                state._lockedSetupType = _newType;
                _wdBridgeConfirmCount  = 0;
                _wdZoneStableCount     = 0;
                _wdZoneWasOk           = false;
              }
              speak(_postSpeak);
              setCoachText(
                '🔄 RECALCUL TERMINÉ\n'
                + 'Ancien : ' + _cOldType + ' ' + _cOldDir + '\n'
                + 'Nouveau : ' + (_newType ? _newType + ' ' + _newDirLabel : 'AUCUN SETUP PROPRE') + '\n'
                + (_newTypeReason ? _newTypeReason + '\n' : '')
                + '⏳ ' + (_newTypeBlocking || ''),
                _newType ? (_newIsLong ? '#22c55e' : '#ef4444') : '#64748b', 8, 15000
              );
            } catch(_e) {
              speak('Erreur lors du recalcul. Je continue la surveillance. Relance ANALYSER si le problème persiste.');
            } finally {
              _wdZoneContraActive = false;
            }
          })(_contraOldDir, _contraOldType, _inBotNow, _inTopNow);
        }
      }

      // ── STABILITÉ ZONE — compteur indépendant de _wdBridgeConfirmCount ───────
      // Pine peut garder inBot/inTop=true pendant toute la durée d'une bougie (5min sur M5)
      // même si le prix est sorti de la zone. Ce compteur exige 2 ticks (6s) de zone stable
      // AVANT de permettre aux gardes d'entrée de s'évaluer.
      // Reset immédiat si zone disparaît → redémarre à 0.
      if (_bridgeHasZoneInfo) {
        if (_zoneOk) {
          _wdZoneStableCount++;
          if (!_wdZoneWasOk) {
            // Transition hors-zone → dans-zone : scan multi-TF + vocal per-TF
            _wdZoneWasOk = true;
            chrome.runtime.sendMessage({ type: 'SCAN_TF' }).catch(function(){});
            // Vocal per-TF — expliquer ce que chaque UT montre au moment de l'entrée en zone
            (function() {
              // Zone par UT : Pine per-TF en priorité, sinon dérivé (zone globale + lecture TF)
              // Règle de dérivation : inTop + VENTE = zone de retournement SHORT
              //                       inBot + ACHAT = zone de retournement LONG
              function _deriveTfZone(pinTop, pinBot, lt) {
                if (pinTop === true) return 'zone de retournement SHORT';
                if (pinBot === true) return 'zone de retournement LONG';
                if (_inTopNow && lt.includes('VENTE')) return 'zone de retournement SHORT';
                if (_inBotNow && lt.includes('ACHAT')) return 'zone de retournement LONG';
                return '';
              }
              var _lt5z = String(_bd.lectureTech5 || '').toUpperCase();
              var _z1lbl = _deriveTfZone(_bd.inTop_M1,  _bd.inBot_M1,  _lt1);
              var _z2lbl = _deriveTfZone(_bd.inTop_M5,  _bd.inBot_M5,  _lt2);
              var _z3lbl = _deriveTfZone(_bd.inTop_M15, _bd.inBot_M15, _lt3);
              var _z4lbl = _deriveTfZone(_bd.inTop_H1,  _bd.inBot_H1,  _lt4);
              var _z5lbl = _deriveTfZone(_bd.inTop_H4,  _bd.inBot_H4,  _lt5z);
              // Exact zone level + distance
              var _zLvl = _isLong ? Number(_bd.liqLow || 0) : Number(_bd.liqHigh || 0);
              var _zPxNow = Number(state.price || 0);
              var _zDistPts = (_zLvl > 0 && _zPxNow > 0) ? Math.abs(_zPxNow - _zLvl) : 0;
              var _zDistPct = (_zPxNow > 0 && _zDistPts > 0) ? (_zDistPts / _zPxNow * 100) : 0;
              var _zFmt = function(p) { return p > 100 ? p.toFixed(2) : p.toFixed(5); };
              var _zLvlStr = _zLvl > 0 ? ' au niveau ' + _zFmt(_zLvl) : '';
              var _zDistStr = _zDistPts > 0 ? ' — ' + _zFmt(_zDistPts) + ' pts (' + _zDistPct.toFixed(2) + '%)' : '';
              // Mode depuis TF alignés (SWING/SCALP/SNIPER)
              var _zM5ok  = _lt2 && ((_isLong && _lt2.includes('ACHAT')) || (!_isLong && _lt2.includes('VENTE')));
              var _zM15ok = _lt3 && ((_isLong && _lt3.includes('ACHAT')) || (!_isLong && _lt3.includes('VENTE')));
              var _zH1ok  = _lt4 && ((_isLong && _lt4.includes('ACHAT')) || (!_isLong && _lt4.includes('VENTE')));
              var _zModeStr = (_zH1ok && _zM15ok && _zM5ok) ? 'SWING'
                : (_zM15ok && _zM5ok) ? 'SCALP'
                : _zM5ok ? 'SNIPER'
                : 'surveillance';
              // Lecture direction TF
              function _ltSpk(lt, rsi) {
                if (!lt) return rsi > 0 ? 'RSI ' + Math.round(rsi) : 'en attente';
                if (lt.includes('ACHAT_FORT'))  return 'achat fort';
                if (lt.includes('ACHAT'))        return 'achat';
                if (lt.includes('VENTE_FORTE')) return 'vente forte';
                if (lt.includes('VENTE'))        return 'vente';
                if (lt.includes('NEUTRE'))       return 'neutre';
                return lt.replace(/_/g,' ').toLowerCase();
              }
              function _tfLine(name, dir, zone) {
                return zone ? name + ' ' + zone + ' ' + dir : name + ' ' + dir;
              }
              var _r1z = Number(_bd.rsiTf1 || 0), _r2z = Number(_bd.rsiTf2 || 0);
              var _r3z = Number(_bd.rsiTf3 || 0), _r4z = Number(_bd.rsiTf4 || 0), _r5z = Number(_bd.rsiTf5 || 0);
              var _zSpeak = _bdZoneAtteinte + _zLvlStr + _zDistStr + ' Mode ' + _zModeStr + '. ';
              _zSpeak += _tfLine('M1',  _ltSpk(_lt1,  _r1z),  _z1lbl) + '. ';
              _zSpeak += _tfLine('M5',  _ltSpk(_lt2,  _r2z),  _z2lbl) + '. ';
              _zSpeak += _tfLine('M15', _ltSpk(_lt3,  _r3z),  _z3lbl) + '. ';
              _zSpeak += _tfLine('H1',  _ltSpk(_lt4,  _r4z),  _z4lbl) + '. ';
              if (_lt5z) _zSpeak += _tfLine('H4', _ltSpk(_lt5z, _r5z), _z5lbl) + '. ';
              _zSpeak += 'Je reviens sur M1 et j\'attends un rejet ' + (_isLong ? 'LONG' : 'SHORT') + ' pour confirmer l\'entrée.';
              speak(_zSpeak);
              _wdLastSpeakAt = Date.now();
            })();
          }
        } else {
          _wdZoneStableCount = 0;
          _wdZoneWasOk = false;
        }
      }

      var _tpDistEst = _effectiveTp > 0 && _effectiveSl > 0
        ? Math.abs(_effectiveTp - (state.price || _effectiveSl)) : 0;
      var _entryTypePre = 'SNIPER';
      if (_h1ok2 && _m15ok2 && _tpDistEst > 25) _entryTypePre = 'SWING';
      else if (_tpDistEst < 8 && !_h1ok2)        _entryTypePre = 'SCALPING';

      // ── TIMING — estimation minutes jusqu'à prochaine clôture TF ────────────
      var _wdNowD  = new Date();
      var _wdMin   = _wdNowD.getMinutes();
      var _wdSec   = _wdNowD.getSeconds();
      var _m5Left  = Math.max(1, Math.ceil(((5  - (_wdMin % 5))  * 60 - _wdSec) / 60));
      var _m15Left = Math.max(1, Math.ceil(((15 - (_wdMin % 15)) * 60 - _wdSec) / 60));
      var _m5Str   = _m5Left  <= 1 ? 'moins d\'une minute' : 'environ ' + _m5Left  + ' min';
      var _m15Str  = _m15Left <= 1 ? 'moins d\'une minute' : 'environ ' + _m15Left + ' min';

      // ── NARRATION MARCHÉ — bridge → langage amateur (amateur suit LIA en live) ─
      var _bridgeCtxSpeak = '';
      if (_bd) {
        var _bImpM5v   = Number(_bd.impulseScoreTf2 || 0); // M5 impulse
        var _bImpM15v  = Number(_bd.impulseScoreTf3 || 0); // M15 impulse
        var _bRsiM15n  = Number(_bd.rsiTf3 || 0);
        var _bRsiH1n   = Number(_bd.rsiTf4 || 0);
        var _bAnticRaw = String(_bd.anticipationTexte || '').toUpperCase().replace(/_/g, ' ').trim();
        // Compression vs momentum
        var _bMktSentence = '';
        var _bImpAvg = (_bImpM5v + _bImpM15v) / 2;
        if (_bImpAvg > 0 && _bImpAvg < 30) {
          _bMktSentence = 'Le marché compresse — pas encore d\'impulsion.';
        } else if (_bImpM15v > 65 && _bImpM5v > 65) {
          _bMktSentence = 'Forte impulsion M5+M15 — le momentum est bien là.';
        } else if (_bImpM15v > 50) {
          _bMktSentence = 'Momentum M15 présent — le mouvement prend de la vitesse.';
        }
        // RSI exhaustion → human language, never raw numbers
        var _bExhSentence = '';
        if (_bRsiM15n > 72) {
          _bExhSentence = 'Les acheteurs s\'essoufflent — RSI M15 en excès.';
        } else if (_bRsiM15n > 0 && _bRsiM15n < 28) {
          _bExhSentence = 'Les vendeurs sont à bout — RSI M15 en survente.';
        } else if (_bRsiH1n > 70) {
          _bExhSentence = 'La tendance de fond ralentit — RSI H1 étiré.';
        } else if (_bRsiH1n > 0 && _bRsiH1n < 30) {
          _bExhSentence = 'La tendance baissière est en bout de course — RSI H1 bas.';
        }
        // Pine anticipation → direction naturelle
        var _bAntSentence = '';
        if (_bAnticRaw && _bAnticRaw !== 'RAS' && _bAnticRaw.length > 2) {
          if (_bAnticRaw.includes('SHORT') || _bAnticRaw.includes('VENTE') || _bAnticRaw.includes('BEAR')) {
            _bAntSentence = 'Pine anticipe un retournement baissier.';
          } else if (_bAnticRaw.includes('LONG') || _bAnticRaw.includes('ACHAT') || _bAnticRaw.includes('BULL')) {
            _bAntSentence = 'Pine anticipe un mouvement haussier.';
          }
        }
        // Zone proximity (uses _distToZone already computed below — set to 0 first tick)
        // _distToZone is computed after _bd block, so use liqHigh/liqLow directly here
        var _bLiqH = Number(_bd.liqHigh || 0);
        var _bLiqL = Number(_bd.liqLow  || 0);
        var _bPxNow = Number(state.price || 0);
        var _bZoneSentence = '';
        if (!_zoneOk && _bPxNow > 0) {
          var _bTarget = _isLong ? _bLiqL : _bLiqH;
          if (_bTarget > 0) {
            var _bDist = Math.abs(_bPxNow - _bTarget) / _bPxNow * 100;
            if (_bDist < 0.3) {
              _bZoneSentence = 'Le prix est tout près de la ' + _bdZoneTarget + ' — attention, c\'est imminent.';
            } else if (_bDist < 0.8) {
              _bZoneSentence = 'Le prix s\'approche de la ' + _bdZoneTarget + '.';
            }
          }
        }
        // Assemble max 2 phrases pour rester vocal (< 8 secondes)
        var _bNarrParts = [_bMktSentence, _bExhSentence, _bAntSentence, _bZoneSentence].filter(function(s) { return s.length > 0; });
        if (_bNarrParts.length > 0) _bridgeCtxSpeak = ' ' + _bNarrParts.slice(0, 2).join(' ');
      }

      // ── LECTURE STRUCTURELLE — OB / FVG / Sweep / Range depuis bridge ────────
      // Ces champs arrivent maintenant via server.js (corrigé 2026-04-19).
      // Utilisés pour nommer précisément les obstacles : "résistance OB à 3285", "FVG à combler entre 3270 et 3275"
      var _bdStr = _bd || null;
      function _fmtS(p) { return (p > 0) ? (p > 100 ? p.toFixed(2) : p.toFixed(5)) : ''; }
      // Order Blocks
      var _bullOBh = _bdStr ? Number(_bdStr.bullOB_h || 0) : 0;
      var _bullOBl = _bdStr ? Number(_bdStr.bullOB_l || 0) : 0;
      var _bearOBh = _bdStr ? Number(_bdStr.bearOB_h || 0) : 0;
      var _bearOBl = _bdStr ? Number(_bdStr.bearOB_l || 0) : 0;
      // FVG
      var _bullFVGh = _bdStr ? Number(_bdStr.bullFVG_h || 0) : 0;
      var _bullFVGl = _bdStr ? Number(_bdStr.bullFVG_l || 0) : 0;
      var _bearFVGh = _bdStr ? Number(_bdStr.bearFVG_h || 0) : 0;
      var _bearFVGl = _bdStr ? Number(_bdStr.bearFVG_l || 0) : 0;
      // Sweep
      var _sweepH = _bdStr ? Number(_bdStr.sweepHighLevel || 0) : 0;
      var _sweepL = _bdStr ? Number(_bdStr.sweepLowLevel  || 0) : 0;
      // Range
      var _rangeH  = _bdStr ? Number(_bdStr.rangeHigh || 0) : 0;
      var _rangeL  = _bdStr ? Number(_bdStr.rangeLow  || 0) : 0;
      var _midPt   = _bdStr ? Number(_bdStr.midpoint  || 0) : 0;
      var _pxLive  = Number(state.price || 0);
      var _inPrem  = _bdStr && !!_bdStr.inPremium;
      var _inDisc  = _bdStr && !!_bdStr.inDiscount;
      var _picVol  = _bdStr && !!_bdStr.picVolume;
      var _rsiEtat = _bdStr ? String(_bdStr.rsiEtatTexte || '') : '';
      // Obstacle LONG : résistance OB baissier au-dessus / FVG baissier / liquidité haute
      // Obstacle SHORT : support OB haussier en dessous / FVG haussier / liquidité basse
      function _buildStructureReading() {
        var parts = [];
        var _px = _pxLive;
        // Zone range
        if (_rangeH > 0 && _rangeL > 0) {
          var _rangePos = _inPrem ? 'en zone premium (haut du range)'
            : _inDisc ? 'en zone discount (bas du range)'
            : 'au milieu du range — zone neutre';
          parts.push('Prix ' + _rangePos + '.');
        }
        // Liquidity
        if (_isLong) {
          if (_sweepL > 0) parts.push('Liquidité basse à ' + _fmtS(_sweepL) + ' — support potentiel.');
          if (_sweepH > 0 && _px > 0 && _sweepH > _px) parts.push('Liquidité haute à ' + _fmtS(_sweepH) + ' — résistance au-dessus.');
        } else {
          if (_sweepH > 0) parts.push('Liquidité haute à ' + _fmtS(_sweepH) + ' — résistance potentielle.');
          if (_sweepL > 0 && _px > 0 && _sweepL < _px) parts.push('Liquidité basse à ' + _fmtS(_sweepL) + ' — support en dessous.');
        }
        // Order Blocks
        if (_isLong) {
          if (_bullOBh > 0 && _bullOBl > 0) parts.push('Order Block haussier entre ' + _fmtS(_bullOBl) + ' et ' + _fmtS(_bullOBh) + ' — zone de rebond.');
          if (_bearOBh > 0 && _px > 0 && _bearOBh > _px) parts.push('Order Block baissier à ' + _fmtS(_bearOBl) + '-' + _fmtS(_bearOBh) + ' — résistance au-dessus.');
        } else {
          if (_bearOBh > 0 && _bearOBl > 0) parts.push('Order Block baissier entre ' + _fmtS(_bearOBl) + ' et ' + _fmtS(_bearOBh) + ' — zone de pression.');
          if (_bullOBh > 0 && _px > 0 && _bullOBh < _px) parts.push('Order Block haussier à ' + _fmtS(_bullOBl) + '-' + _fmtS(_bullOBh) + ' — support en dessous.');
        }
        // FVG
        if (_isLong && _bullFVGh > 0 && _bullFVGl > 0) {
          var _fvgDist = _px > 0 ? Math.abs(_px - _bullFVGl) / _px * 100 : 0;
          parts.push('FVG haussier entre ' + _fmtS(_bullFVGl) + ' et ' + _fmtS(_bullFVGh) + (_fvgDist < 0.5 ? ' — très proche, aimant prix.' : '.'));
        }
        if (!_isLong && _bearFVGh > 0 && _bearFVGl > 0) {
          var _fvgDist2 = _px > 0 ? Math.abs(_px - _bearFVGh) / _px * 100 : 0;
          parts.push('FVG baissier entre ' + _fmtS(_bearFVGl) + ' et ' + _fmtS(_bearFVGh) + (_fvgDist2 < 0.5 ? ' — très proche, risque attraction.' : '.'));
        }
        // Volume spike
        if (_picVol) parts.push('Pic de volume détecté — forte activité institutionnelle.');
        // RSI état Pine
        if (_rsiEtat === 'RSI_FAIBLIT') parts.push('RSI qui faiblit — essoufflement de la tendance.');
        else if (_rsiEtat === 'RSI_REPART') parts.push('RSI qui repart — momentum en reconstruction.');
        return parts;
      }
      var _structParts = _buildStructureReading();

      // ── ROTATION — 3 variantes pour éviter la répétition à chaque tick ───
      var _wdCyc = _entryWatchdogAttempts % 3;

      // ── VOCAL — parle uniquement si état change OU 3min dans même état ──────
      // Évite la boucle vocale : même état = silence. Changement d'état = annonce immédiate.
      var _wdNowMs   = Date.now();
      // Hash d'état vocal — EXCLUT pulsionOk (bullRej/bearRej instable: flip toutes les secondes sur bougie ouverte).
      // Inclure pulsionOk causait _wdStateChanged=true toutes les 30s → boucle vocale.
      // La pulsion est vérifiée comme garde d'entrée (guard F) mais ne doit pas déclencher la parole.
      var _wdStateNow = (_isLong ? 'L' : 'S') + '|' + (_ctxOk?'1':'0') + '|' + (_m5Conf?'1':'0') + '|' + (_m15Setup?'1':'0') + '|' + (_zoneOk?'1':'0');
      var _wdStateChanged = _wdStateNow !== _wdLastSpeakState;
      var _wdShouldSpeak = _wdStateChanged
        ? (_wdNowMs - _wdLastSpeakAt > 20000)  // état changé → 20s min
        : (_wdNowMs - _wdLastSpeakAt > 35000);  // même état → parole max toutes les 35s

      // ── COMPTEUR CLÔTURES M1 — base fréquence recheck par mode ────────────────
      // SCALP:  M5 toutes les 5 clôtures M1 | M15 toutes les 15 | H1 toutes les 60
      // SNIPER: M5 toutes les 3 clôtures M1 | M15 toutes les 15 | H1 fixe
      // SWING:  M15 toutes les 15 | H1 toutes les 60 | H4 toutes les 240
      var _m1CntNow = Date.now();
      var _m1CntElapsed = Math.floor((_m1CntNow - (state._wdM1LastAt || _m1CntNow)) / 60000);
      if (_m1CntElapsed > 0) {
        state._wdM1CloseCnt = (state._wdM1CloseCnt || 0) + _m1CntElapsed;
        state._wdM1LastAt = _m1CntNow;
      }
      if (!state._wdM1LastAt) state._wdM1LastAt = _m1CntNow;
      var _m1Cnt = state._wdM1CloseCnt || 0;
      var _modeCnt = (state.tradeMode || 'AUTO').toUpperCase();
      var _m5Every  = (_modeCnt === 'SNIPER') ? 3  : (_modeCnt === 'SWING') ? 15 : 5;
      var _m15Every = 15;
      var _h1Every  = 60;
      var _nextM5In  = _m1Cnt > 0 ? (_m5Every  - (_m1Cnt % _m5Every)  || _m5Every)  : _m5Every;
      var _nextM15In = _m1Cnt > 0 ? (_m15Every - (_m1Cnt % _m15Every) || _m15Every) : _m15Every;
      var _nextH1In  = _m1Cnt > 0 ? (_h1Every  - (_m1Cnt % _h1Every)  || _h1Every)  : _h1Every;
      // Déclencher SCAN_TF au background quand on atteint un jalon de recheck
      if (_m1CntElapsed > 0 && _m1Cnt > 0) {
        var _isM5Recheck  = (_m1Cnt % _m5Every  === 0);
        var _isM15Recheck = (_m1Cnt % _m15Every === 0);
        if (_isM5Recheck || _isM15Recheck) {
          chrome.runtime.sendMessage({ type: 'SCAN_TF' }).catch(function() {});
        }
      }

      // ── CONDITION BLOQUANTE — coaching précis + anti-spam vocal ──────────────
      // Priorité: zone → zone stable → M5 → M15 → M1 → pulsion → H1
      // La première condition false = LE blocage principal affiché.
      var _wdBlockingKey = !_zoneOk ? 'ZONE'
        : (_wdZoneStableCount < 2) ? 'ZONE_STABLE'
        : !_m5Conf ? 'M5'
        : (!_m15Setup && !_userModeIsSniper) ? 'M15'
        : !_m1Timing ? 'M1'
        : !_pulsionOk ? 'PULSION'
        : !_ctxOk ? 'H1'
        : 'OK';
      var _wdBlockingChanged = _wdBlockingKey !== _wdLastBlockingKey;
      // Parle immédiatement quand le blocage change — indépendamment du délai habituel
      _wdShouldSpeak = _wdShouldSpeak || _wdBlockingChanged;

      // ── TYPE PROBABLE — basé sur ce qui est DÉJÀ aligné (pas ce qui manque) ─
      // SWING: 4 TFs. SCALP: M5+M15+zone. SNIPER: M5+M1+zone.
      // Jamais affiché si zone absente ou M5 absent — trop tôt.
      var _probableType = (_zoneOk && _m5Conf && _m15Setup && _h1ok2) ? 'SWING'
        : (_zoneOk && _m5Conf && _m15Setup) ? 'SCALP'
        : (_zoneOk && _m5Conf && _m1Timing) ? 'SNIPER'
        : '';

      // ── TIMING UTILE — lié au TF bloquant uniquement (pas horloge globale) ──
      // Zone/pulsion → pas de timing horloge (dépend du prix, pas du temps).
      var _m1SecsLeft = 60 - _wdNowD.getSeconds();
      var _blockingTimingStr = _wdBlockingKey === 'M1' ? ' (' + _m1SecsLeft + 's)'
        : _wdBlockingKey === 'M5' ? ' (' + _m5Str + ')'
        : _wdBlockingKey === 'M15' ? ' (' + _m15Str + ')'
        : '';
      var _blockingLabel = _wdBlockingKey === 'ZONE' ? 'zone ' + (_isLong ? '(inBot)' : '(inTop)') + _synthZoneSuffix
        : _wdBlockingKey === 'ZONE_STABLE' ? 'zone stable (' + _wdZoneStableCount + '/2 ticks)' + _synthZoneSuffix
        : _wdBlockingKey === 'M5' ? 'M5' + _blockingTimingStr
        : _wdBlockingKey === 'M15' ? 'M15' + _blockingTimingStr
        : _wdBlockingKey === 'M1' ? 'M1' + _blockingTimingStr
        : _wdBlockingKey === 'PULSION' ? 'pulsion ' + (_isLong ? 'LONG' : 'SHORT')
        : _wdBlockingKey === 'H1' ? 'H1 (contexte macro)'
        : 'conditions finales';

      // ── COACHING LINE — format structuré : type + direction + blocage unique ─
      // Direction TOUJOURS explicite. Une seule direction. Une seule condition bloquante.
      // "Potentiel SCALP SHORT — j'attends M1 (40s)"
      var _coachingLine = _probableType
        ? '\n→ Potentiel ' + _probableType + ' ' + _dirLabel + ' — j\'attends ' + _blockingLabel
        : _zoneOk
          ? '\n→ ' + _bdZoneLabel + ' active ' + _dirLabel + ' — j\'attends confirmation TF'
          : '\n→ Hors zone ' + _dirLabel + ' — j\'attends la ' + _bdZoneTarget;

      // ── ANNONCE CLÔTURE M1 — seulement si état change OU toutes les 5 min ──────
      // Évite la boucle : si rien ne change, l'agent se tait entre les bilans.
      var _m1CandleIdNow = Math.floor(_wdNowMs / 60000);
      // Tracker de clôture M1 — enregistre la bougie sur laquelle le signal est apparu
      if (_m1Timing) {
        if (!state._m1TimingConfirmedCandleId) state._m1TimingConfirmedCandleId = _m1CandleIdNow;
      } else {
        state._m1TimingConfirmedCandleId = null;
      }
      var _m1StateChanged = _wdStateNow !== _wdLastSpeakState;
      var _m1SilentFor5 = (_wdNowMs - _wdLastSpeakAt) > 300000; // 5 min de silence
      if (_m1CandleIdNow !== _wdLastM1CandleId && _wdLastM1CandleId !== 0 && (_m1StateChanged || _m1SilentFor5)) {
        _wdLastM1CandleId = _m1CandleIdNow;
        // ── Construction bilan vocal M1 ──
        var _m1H = _wdNowD.getHours(), _m1M = _wdNowD.getMinutes();
        var _m1Time = (_m1H < 10 ? '0' : '') + _m1H + 'h' + (_m1M < 10 ? '0' : '') + _m1M;
        // Statut TF
        var _m1TfBilan = 'M1 ' + (_m1Timing ? 'OK' : 'neutre') + ', M5 ' + (_m5Conf ? 'confirmé' : 'neutre') + ', M15 ' + (_m15Setup ? 'setup' : 'neutre') + ', H1 ' + (_h1ok2 ? 'aligné' : 'neutre') + '.';
        // Statut zone
        var _m1ZoneBilan = _zoneOk
          ? ('Je suis en ' + _bdZoneLabel + '.')
          : ('Hors zone — j\'attends la ' + _bdZoneTarget + (_targetZoneStr || '') + '.');
        // Statut pulsion
        var _m1PulsBilan = _pulsionOk
          ? 'Rejet ' + (_isLong ? 'LONG' : 'SHORT') + ' détecté.'
          : 'J\'attends le rejet ' + (_isLong ? 'LONG' : 'SHORT') + ' pour entrer.';
        // Momentum — traduit en langage humain (pas de valeur RSI brute)
        var _m1RsiBilan = _rsiM15v > 70 ? 'Le marché s\'essouffle en haut — surveille un retournement baissier.'
          : _rsiM15v > 0 && _rsiM15v < 30 ? 'Le marché ralentit en bas — surveille un retournement haussier.'
          : _rsiM15v > 0 ? 'Momentum neutre — pas d\'excès détecté.'
          : '';
        // News — toujours annoncer l'état agenda même si calme
        var _m1NewsBilan = '';
        if (_wdNewsAlert) {
          // Alerte déjà identifiée par la boucle toutes les 10min
          var _wdaImpLbl = String(_wdNewsAlert.impact || '').toUpperCase() === 'HIGH' ? 'haute impact' : 'impact moyen';
          _m1NewsBilan = _wdNewsAlert.minutesLeft <= 5
            ? 'Attention: ' + _wdNewsAlert.label + ' — news ' + _wdaImpLbl + ' imminente, entrée bloquée.'
            : _wdNewsAlert.label + ' dans ' + _wdNewsAlert.minutesLeft + ' min, ' + _wdaImpLbl + ' — je surveille.';
        } else {
          var _m1NewsCheck = checkNewsBlockEntry();
          if (_m1NewsCheck.blocked) {
            _m1NewsBilan = _m1NewsCheck.reason.split('.')[0] + ' — entrée bloquée.';
          } else if (_m1NewsCheck.warning) {
            _m1NewsBilan = _m1NewsCheck.reason.split('.')[0] + '.';
          } else {
            // Aucune news bloquante — trouver le prochain événement dans l'agenda
            var _m1AllEvts = Array.isArray(state.newsEvents) ? state.newsEvents : [];
            var _m1NextEvt = null;
            for (var _ni = 0; _ni < _m1AllEvts.length; _ni++) {
              var _ne = _m1AllEvts[_ni];
              var _neMins = Number.isFinite(Number(_ne.mins))         ? Number(_ne.mins)
                          : Number.isFinite(Number(_ne.minsUntil))    ? Number(_ne.minsUntil)
                          : Number.isFinite(Number(_ne.minutesUntil)) ? Number(_ne.minutesUntil)
                          : Number.isFinite(Number(_ne.minutesAway))  ? Number(_ne.minutesAway)
                          : 9999;
              if (_neMins >= -10 && _neMins < 9999) { _m1NextEvt = { ev: _ne, mins: _neMins }; break; }
            }
            if (_m1NextEvt) {
              var _neName   = String(_m1NextEvt.ev.title || _m1NextEvt.ev.event || '').trim().substring(0, 45);
              var _neImpRaw = String(_m1NextEvt.ev.impact || '').toUpperCase();
              var _neStars  = Number(_m1NextEvt.ev.stars || 0);
              var _neImpLbl = (_neImpRaw === 'HIGH' || _neStars >= 3) ? 'haute impact'
                            : (_neImpRaw === 'MEDIUM' || _neStars >= 2) ? 'impact moyen'
                            : 'faible impact';
              var _neWhen   = _m1NextEvt.mins <= 0    ? 'en cours maintenant'
                            : _m1NextEvt.mins < 60    ? 'dans ' + Math.round(_m1NextEvt.mins) + ' min'
                            : 'dans ' + Math.round(_m1NextEvt.mins / 60) + 'h';
              _m1NewsBilan  = 'Agenda: ' + _neName + ' ' + _neWhen + ', ' + _neImpLbl + '.';
            } else {
              _m1NewsBilan = 'Agenda économique calme — pas d\'annonce haute impact prévue.';
            }
          }
        }
        // Prochain événement attendu
        var _m1NextAction = _canEnterFinal
          ? 'Validation finale en cours.'
          : _zoneOk && _m15Setup && _m5Conf && !_pulsionOk
            ? 'J\'attends le rejet sur la bougie ' + _wdTf + ' pour entrer.'
            : _m15Setup && _m5Conf && !_zoneOk
              ? 'J\'attends que le prix touche la zone' + (_targetZoneStr || '') + '.'
              : 'J\'attends l\'alignement M5+M15 en direction ' + _dirLabel + '.';
        // ── LECTURE STRUCTURELLE PAR TF — coach pro complet ─────────────────
        // Format: TF + zone (haute/basse/milieu) + obstacle + point d'entrée + mode + manque
        var _m1TfDetail = '';
        var _bdB = _bd || null;
        if (_bdB) {
          var _ltM1 = String(_bdB.lectureTech1 || '').toUpperCase();
          var _ltM5 = String(_bdB.lectureTech2 || '').toUpperCase();
          var _ltM15= String(_bdB.lectureTech3 || '').toUpperCase();
          var _ltH1 = String(_bdB.lectureTech4 || '').toUpperCase();
          var _ltH4 = String(_bdB.lectureTech5 || '').toUpperCase();
          var _rM1  = Math.round(Number(_bdB.rsiTf1 || 0));
          var _rM5  = Math.round(Number(_bdB.rsiTf2 || 0));
          var _rM15r= Math.round(Number(_bdB.rsiTf3 || 0));
          var _rH1  = Math.round(Number(_bdB.rsiTf4 || 0));
          var _rH4  = Math.round(Number(_bdB.rsiTf5 || 0));
          function _readDir(lt, rsi) {
            if (lt.includes('ACHAT_FORT')) return 'achat fort' + (rsi > 0 ? ' RSI ' + rsi : '');
            if (lt.includes('ACHAT'))      return 'achat' + (rsi > 0 ? ' RSI ' + rsi : '');
            if (lt.includes('VENTE_FORT')) return 'vente forte' + (rsi > 0 ? ' RSI ' + rsi : '');
            if (lt.includes('VENTE'))      return 'vente' + (rsi > 0 ? ' RSI ' + rsi : '');
            if (lt.includes('NEUTRE'))     return 'neutre' + (rsi > 0 ? ' RSI ' + rsi : '');
            return rsi > 0 ? 'RSI ' + rsi : 'données en attente';
          }
          // Lecture zone per-TF : inTop_M1 / inBot_M1 disponibles si Pine mis à jour
          // Sinon (null / false par défaut) → "zone inconnue" — jamais de valeur inventée
          function _readZone(inTopVal, inBotVal, hasPineTfZone) {
            if (!hasPineTfZone) return ''; // Pine pas encore mis à jour — pas de label zone
            return inTopVal ? 'zone haute' : inBotVal ? 'zone basse' : 'milieu du range';
          }
          var _hasPerTf = (_bdB.inTop_M5 === true || _bdB.inBot_M5 === true
                         || _bdB.inTop_M1 === true || _bdB.inBot_M1 === true
                         || _bdB.inTop_M15 === true || _bdB.inBot_M15 === true
                         || _bdB.inTop_H1 === true || _bdB.inBot_H1 === true);
          // Zone par TF — enrichie si Pine envoie les champs per-TF
          var _zM1  = _readZone(_bdB.inTop_M1  === true, _bdB.inBot_M1  === true, _hasPerTf);
          var _zM5  = _readZone(_bdB.inTop_M5  === true, _bdB.inBot_M5  === true, _hasPerTf);
          var _zM15 = _readZone(_bdB.inTop_M15 === true, _bdB.inBot_M15 === true, _hasPerTf);
          var _zH1  = _readZone(_bdB.inTop_H1  === true, _bdB.inBot_H1  === true, _hasPerTf);
          var _zH4  = _readZone(_bdB.inTop_H4  === true, _bdB.inBot_H4  === true, _hasPerTf && !!_ltH4);
          // Formater une ligne TF : direction + zone
          function _tfLine(name, dir, zone) {
            var s = name + ' : ' + dir;
            if (zone) s += ', ' + zone;
            return s;
          }
          var _m1Read  = _readDir(_ltM1,  _rM1);
          var _m5Read  = _readDir(_ltM5,  _rM5);
          var _m15Read = _readDir(_ltM15, _rM15r);
          var _h1Read  = _readDir(_ltH1,  _rH1);
          var _h4Read  = _ltH4 ? _readDir(_ltH4, _rH4) : '';
          // Zone globale (TF du chart Pine) — contexte actuel
          var _zoneNow = _bdZoneLabel; // label exact bridge
          // Obstacle principal (depuis bridge — TF chart)
          var _obstacleStr = '';
          if (_isLong) {
            if (_bearOBh > 0 && _pxLive > 0 && _bearOBh > _pxLive) _obstacleStr = 'Order Block baissier à ' + _fmtS(_bearOBh) + ' bloque la hausse.';
            else if (_sweepH > 0 && _pxLive > 0 && _sweepH > _pxLive) _obstacleStr = 'Liquidité haute à ' + _fmtS(_sweepH) + ' — résistance à franchir.';
            else if (_bearFVGh > 0 && _pxLive > 0 && _bearFVGh > _pxLive) _obstacleStr = 'FVG baissier à ' + _fmtS(_bearFVGl) + '-' + _fmtS(_bearFVGh) + ' — obstacle potentiel.';
          } else {
            if (_bullOBl > 0 && _pxLive > 0 && _bullOBl < _pxLive) _obstacleStr = 'Order Block haussier à ' + _fmtS(_bullOBl) + ' bloque la baisse.';
            else if (_sweepL > 0 && _pxLive > 0 && _sweepL < _pxLive) _obstacleStr = 'Liquidité basse à ' + _fmtS(_sweepL) + ' — support à casser.';
            else if (_bullFVGl > 0 && _pxLive > 0 && _bullFVGl < _pxLive) _obstacleStr = 'FVG haussier à ' + _fmtS(_bullFVGl) + '-' + _fmtS(_bullFVGh) + ' — aimant vers le bas.';
          }
          // Point d'entrée visé
          var _entryVisee = '';
          var _liqTarget = _isLong ? _liqLow : _liqHigh;
          if (_liqTarget > 0) _entryVisee = 'Point d\'entrée visé : ' + _fmtS(_liqTarget) + '.';
          // Mode détecté
          var _modeDetected = _probableType ? 'Scénario probable : ' + _probableType + '.' : '';
          // Ce qui manque
          var _manqueStr = _wdBlockingKey === 'ZONE' ? 'Il me manque : le prix dans la zone rectangle.'
            : _wdBlockingKey === 'M5' ? 'Il me manque : confirmation M5 (' + _m5Str + ').'
            : _wdBlockingKey === 'M15' ? 'Il me manque : validation M15 (' + _m15Str + ').'
            : _wdBlockingKey === 'M1' ? 'Il me manque : timing M1 — prochaine bougie dans ' + _m1SecsLeft + 's.'
            : _wdBlockingKey === 'PULSION' ? 'Il me manque : rejet ' + (_isLong ? 'haussier' : 'baissier') + ' confirmé.'
            : _wdBlockingKey === 'H1' ? 'Il me manque : H1 neutre ou favorable.'
            : '';
          // Assemblage ligne par TF avec zone si disponible
          var _tfLines = [
            _tfLine('M1',  _m1Read,  _zM1),
            _tfLine('M5',  _m5Read,  _zM5),
            _tfLine('M15', _m15Read, _zM15),
            _tfLine('H1',  _h1Read,  _zH1)
          ];
          if (_h4Read) _tfLines.push(_tfLine('H4', _h4Read, _zH4));
          _m1TfDetail = _tfLines.join(' | ') + '. '
            + 'Zone : ' + _zoneNow + '. '
            + (_obstacleStr ? _obstacleStr + ' ' : '')
            + (_entryVisee ? _entryVisee + ' ' : '')
            + (_modeDetected ? _modeDetected + ' ' : '')
            + (_manqueStr ? _manqueStr : '');
        }
        // Assemblage phrase finale
        var _m1Phrase = _m1Time + ' — LIA en place. Direction ' + _dirLabel + '. '
          + _m1TfBilan + ' '
          + _m1ZoneBilan + ' '
          + _m1PulsBilan + ' '
          + (_m1TfDetail ? _m1TfDetail + ' ' : '')
          + (_m1RsiBilan ? _m1RsiBilan + ' ' : '')
          + (_m1NewsBilan ? _m1NewsBilan + ' ' : '')
          + _m1NextAction
          + (_bridgeCtxSpeak || '');
        _wdLastSpeakAt = _wdNowMs; _wdLastSpeakState = _wdStateNow; // reset cadence + état
        speak(_m1Phrase);
      } else if (_wdLastM1CandleId === 0) {
        // Premier tick — initialiser sans parler
        _wdLastM1CandleId = _m1CandleIdNow;
      }

      // Infos contexte pour enrichir les messages
      var _zoneProxLbl = _bdZoneTarget; // label exact bridge : "zone de retournement LONG/SHORT"
      var _pulsLbl     = _isLong ? 'bullRej — clôture haussière sur wick bas' : 'bearRej — clôture baissière sous wick haut';
      var _dirWord     = _isLong ? 'haussière' : 'baissière';
      var _rsiM15disp  = _rsiM15v > 70 ? ' M15 en excès haussier.' : _rsiM15v > 0 && _rsiM15v < 30 ? ' M15 en survente.' : _rsiM15v >= 55 ? ' M15 monte.' : _rsiM15v > 0 && _rsiM15v <= 45 ? ' M15 descend.' : '';

      // ── NIVEAUX PRÉCIS — depuis bridge + SL/TP serveur ────────────────────
      var _pxNow    = Number(state.price || 0);
      var _liqHigh  = _bd ? Number(_bd.liqHigh || 0) : 0;
      var _liqLow   = _bd ? Number(_bd.liqLow  || 0) : 0;
      // Formater selon la précision du marché (Forex 5 décimales, indices 2)
      function _fmtPx(p) { return p <= 0 ? '' : (p > 100 ? p.toFixed(2) : p.toFixed(5)); }
      // Niveau cible : la zone que le prix doit atteindre
      var _targetZonePx = _isLong ? _liqLow : _liqHigh; // LONG attend le low (support), SHORT le high (résistance)
      var _targetZoneStr = _targetZonePx > 0 ? ' → niveau ' + _fmtPx(_targetZonePx) : '';
      // Niveau TP/SL pour contexte
      var _tpStr = _effectiveTp > 0 ? ' Objectif: ' + _fmtPx(_effectiveTp) + '.' : '';
      var _slStr = _effectiveSl > 0 ? ' SL: ' + _fmtPx(_effectiveSl) + '.' : '';
      // Prix actuel formaté
      var _pxStr = _pxNow > 0 ? ' Prix actuel: ' + _fmtPx(_pxNow) + '.' : '';
      // Proximité de la zone (en %)
      var _distToZone = (_targetZonePx > 0 && _pxNow > 0)
        ? Math.abs(_pxNow - _targetZonePx) / _pxNow * 100 : 0;
      var _zoneProxStr = _distToZone > 0 && _distToZone < 2
        ? ' (à ' + _distToZone.toFixed(2) + '% de la zone)' : '';

      // ── CONFIDENCE RÉEL — progression basée sur conditions actuelles ──────────
      // 0-30%: loin / 30-60%: approche / 60-80%: zone proche / 80-100%: imminente
      var _wdTfBase = (_m5ok2 && _m15ok2) ? 35 : (_m15ok2 || _m5ok2) ? 20 : 0;
      if (_h1ok2) _wdTfBase = Math.min(50, _wdTfBase + 10);
      if (_m1ok2) _wdTfBase = Math.min(52, _wdTfBase + 2);
      var _wdProxBonus = _zoneOk ? 30
        : (_distToZone > 0 && _distToZone < 0.5) ? 20
        : (_distToZone > 0 && _distToZone < 1.0) ? 10
        : (_distToZone > 0 && _distToZone < 2.0) ? 3 : 0;
      var _wdPulsBonus = _pulsionOk ? 15 : 0;
      var _wdRealConf  = _canEnterFinal ? 99 : Math.min(98, _wdTfBase + _wdProxBonus + _wdPulsBonus);

      // ── NEWS CHECK — toutes les 10 min, vocal si news imminente ─────────────
      if (_wdNowMs - _wdNewsLastAt > 600000) {
        _wdNewsLastAt = _wdNowMs;
        (async function() {
          try {
            var _nr = await fetchJson('/market-news');
            var _evts = (_nr && Array.isArray(_nr.events)) ? _nr.events : [];
            var _nowH = new Date();
            var _imminentEvt = null;
            var _warnEvt = null;
            _evts.forEach(function(ev) {
              if (!ev.date || !ev.time) return;
              // Parse date "MM-DD-YYYY" + time "H:MMam/pm" → local Date
              var _dp = ev.date.split('-'); // [MM, DD, YYYY]
              var _tp = ev.time.match(/(\d+):(\d+)(am|pm)/i);
              if (!_dp || _dp.length < 3 || !_tp) return;
              var _hh = parseInt(_tp[1],10) + (_tp[3].toLowerCase()==='pm' && _tp[1]!=='12' ? 12 : 0);
              var _mm = parseInt(_tp[2],10);
              var _evDate = new Date(parseInt(_dp[2],10), parseInt(_dp[0],10)-1, parseInt(_dp[1],10), _hh, _mm, 0);
              var _minLeft = (_evDate - _nowH) / 60000;
              if (_minLeft >= -5 && _minLeft <= 5)  { _imminentEvt = ev; _imminentEvt._minLeft = Math.round(_minLeft); }
              else if (_minLeft > 5 && _minLeft <= 30 && !_warnEvt) { _warnEvt = ev; _warnEvt._minLeft = Math.round(_minLeft); }
            });
            if (_imminentEvt) {
              _wdNewsAlert = { label: _imminentEvt.title, impact: _imminentEvt.impact, minutesLeft: _imminentEvt._minLeft };
              _wdLastSpeakAt = Date.now(); // consomme le slot vocal pour éviter doublon
              speak('Attention. ' + _imminentEvt.title + '. News ' + (_imminentEvt.impact==='High'?'haute':'moyenne') + ' impact imminente. Je bloque toute entrée. Attends la réaction du marché avant de prendre position.');
              setCoachText('🚨 NEWS — ' + _imminentEvt.title + '\nEntrée bloquée ±5 min', '#ef4444', 9, 15000);
            } else if (_warnEvt) {
              _wdNewsAlert = { label: _warnEvt.title, impact: _warnEvt.impact, minutesLeft: _warnEvt._minLeft };
              var _wSpk = 'J\'ai consulté l\'agenda. ' + _warnEvt.title + ' dans ' + _warnEvt._minLeft + ' minutes. Impact ' + (_warnEvt.impact==='High'?'élevé':'moyen') + '. Je continue à surveiller mais je serai plus strict sur l\'entrée. Je t\'avertis si ça bloque.';
              _wdLastSpeakAt = Date.now(); // consomme le slot vocal
              speak(_wSpk);
              flowLog('NEWS WARNING — ' + _warnEvt.title + ' dans ' + _warnEvt._minLeft + 'min impact=' + _warnEvt.impact);
            } else {
              if (_wdNewsAlert) {
                _wdNewsAlert = null;
                _wdLastSpeakAt = Date.now();
                speak('Agenda économique vérifié. Aucune news impactante dans la prochaine demi-heure. Je reprends la surveillance normale.');
              }
              // Pas de speak sur le "RAS" silencieux — pas d'info utile pour l'utilisateur
              flowLog('NEWS CHECK — RAS');
            }
          } catch(_) { /* news non bloquante si offline */ }
        })();
      }

      // Bloquer entrée si news imminente (minutesLeft entre -5 et +5)
      if (_wdNewsAlert && Math.abs(_wdNewsAlert.minutesLeft) <= 5) {
        renderArmedBanner('watching', exec, sig);
        setCoachText('🚨 NEWS — ' + _wdNewsAlert.label + '\nEntrée bloquée | attente réaction marché', '#ef4444', 9, 5000);
        return;
      }
      // Bloquer entrée si breaking news live détectée (suspend 15 min)
      if (_liveNewsSuspend) {
        renderArmedBanner('watching', exec, sig);
        setCoachText('⚠️ BREAKING NEWS — ENTRÉE SUSPENDUE\nJ\'attends la stabilisation du marché.', '#f97316', 8, 5000);
        return;
      }

      // ── INTENTION — coaching structuré : type probable + direction + blocage ──
      // Remplace l'ancienne logique ad-hoc par la coaching line calculée plus haut.
      // Format: "→ Potentiel [TYPE] [DIR] — j'attends [BLOCAGE] ([TIMING si TF])"
      var _intentionStr = _coachingLine;

      // ── BANNIÈRE PROGRESSIVE — état exact du setup (H1→M15→M5→M1→Zone→Pulsion) ──
      var _wdMode;
      // ── ÉTAT WATCHDOG — label dynamique pour bannière + vocal ───────────────
      var _wdStateLabel = '';

      if (_conflictBlocking) {
        _wdMode = 'watching'; _wdBridgeConfirmCount = 0;
        _wdStateLabel = 'Signal présent — j\'attends que les indicateurs s\'alignent';
        var _conflMsg = [
          'je surveille — ' + _dirLabel + ' possible mais les indicateurs divergent encore\n' + _tfStatusLine + '\nDès que c\'est aligné, j\'entre.',
          'retournement ' + _dirLabel + ' en formation — j\'attends la confirmation\n' + _tfStatusLine + '\nJe rescanne toutes les 3s.',
          'signal ' + _dirLabel + ' détecté — pas encore aligné sur tous les TF\n' + _tfStatusLine + '\nJe surveille et j\'entre dès que c\'est propre.'
        ][_wdCyc];
        setCoachText(_conflMsg, '#f97316', 5, 6000);
        if (_wdShouldSpeak) {
          _wdLastSpeakAt = _wdNowMs; _wdLastSpeakState = _wdStateNow;
          speak(['Signal ' + (_isLong ? 'LONG' : 'SHORT') + ' présent mais les indicateurs ne sont pas encore tous alignés. J\'attends la convergence avant d\'entrer.',
                 'Retournement ' + (_isLong ? 'LONG' : 'SHORT') + ' en formation. Je surveille. Dès que c\'est propre, j\'entre.',
                 'Je vois un signal ' + (_isLong ? 'long' : 'short') + ' mais je ne rentre pas tant que ce n\'est pas confirmé.'][_wdTotalSpeaks++ % 3]);
        }

      } else if (!_bd) {
        _wdMode = 'watching'; _wdBridgeConfirmCount = 0;
        _wdStateLabel = 'BRIDGE HORS LIGNE : Vérifier TradingView';
        setCoachText('⏳ BRIDGE INDISPONIBLE — données TF absentes.\nRevérifie que TradingView est ouvert et l\'indicateur actif.', '#64748b', 4, 6000);
        if (_wdShouldSpeak) {
          _wdLastSpeakAt = _wdNowMs; _wdLastSpeakState = _wdStateNow;
          speak(['Données de marché indisponibles. Je ne peux pas analyser sans flux live. Vérifie que TradingView est ouvert.',
                 'Je ne reçois plus les données en temps réel. Analyse suspendue jusqu\'à reconnexion.',
                 'Flux marché coupé. Je reprends la surveillance dès que la connexion revient.'][_wdTotalSpeaks++ % 3]);
        }

      } else if (!_ctxOk) {
        _wdMode = 'watching'; _wdBridgeConfirmCount = 0;
        _wdStateLabel = 'H1 BLOQUANT : Contexte macro défavorable ' + _dirLabel;
        var _h1BlkMsg = [
          '🔴 H1 BLOQUANT — ' + _dirLabel + '\n' + _tfStatusLine + '\n' +
            (_isLong ? 'H1 fortement vendeur — contexte macro adverse au LONG.' : 'H1 fortement haussier — contexte macro adverse au SHORT.') +
            '\nJ\'attends que H1 redevienne neutre ou favorable avant toute entrée.' + _rsiM15disp,
          '🔴 CONTEXTE H1 DÉFAVORABLE\n' + _tfStatusLine + '\n' +
            'Le filtre macro ne passe pas pour un ' + _dirLabel + ' ici.' +
            '\nDès que H1 se neutralise ou s\'aligne, je réévalue immédiatement.',
          '🔴 H1 BLOQUE L\'ENTRÉE\n' + _tfStatusLine + '\n' +
            'Je surveille H1.' +
            (_isLong ? ' Un passage de VENTE_FORTE à neutre ou haussier validera le contexte.' : ' Un passage de ACHAT_FORT à neutre ou baissier validera le contexte.') +
            '\nJe rescanne toutes les 3s.'
        ][_wdCyc];
        setCoachText(_h1BlkMsg, '#ef4444', 5, 6000);
        if (_wdShouldSpeak) {
          _wdLastSpeakAt = _wdNowMs; _wdLastSpeakState = _wdStateNow;
          speak(['H1 bloque l\'entrée. Le contexte macro est défavorable pour un ' + _dirLabel + '. J\'attends que H1 se neutralise.',
                 'Filtre macro H1 actif. Je ne prends pas de position contre le trend de fond. Je patiente.',
                 'H1 fortement contre le ' + _dirLabel + '. Je surveille en silence jusqu\'au changement de contexte.'][_wdTotalSpeaks++ % 3]);
        }

      // News warning suffix (si news entre 5-30 min)
      var _newsSuffix = (_wdNewsAlert && _wdNewsAlert.minutesLeft > 5)
        ? '\n⚠️ News dans ' + _wdNewsAlert.minutesLeft + 'min : ' + _wdNewsAlert.label + ' (' + _wdNewsAlert.impact + ')' : '';

      } else if (!_m15Setup && !_m5Conf) {
        _wdMode = 'watching'; _wdBridgeConfirmCount = 0;
        // TFs requis selon le mode sélectionné
        var _waitTfStr = _userModeIsSniper ? 'M5 + M1'
            : (_userMode === 'SWING') ? 'M15 + H1'
            : 'M5 + M15'; // SCALP / AUTO
        var _waitTfDetail = _userModeIsSniper ? 'M5 (direction) et M1 (timing)'
            : (_userMode === 'SWING') ? 'M15 (setup) et H1 (contexte macro)'
            : 'M5 (confirmation) et M15 (validation)';
        _wdStateLabel = 'EN VEILLE ' + _dirLabel + ' : J\'attends ' + _waitTfStr + ' en zone';
        var _noSetupMsg = [
          '🔍 EN VEILLE — ' + _dirLabel + '\n' + _tfStatusLine +
            '\nJ\'attends ' + _waitTfDetail + ' côté ' + _dirWord + '.' +
            '\nAucune entrée sans ces conditions. Prochain check dans 3s.' + _rsiM15disp + _pxStr + _newsSuffix,
          '🔍 PAS DE SETUP — ' + _dirLabel + '\n' + _tfStatusLine +
            '\nSignal ' + _dirWord + ' pas encore visible sur ' + _waitTfStr + '.' +
            (_targetZoneStr ? '\nZone cible :' + _targetZoneStr + _zoneProxStr + '.' : '') +
            '\nJe rescanne toutes les 3s.' + _newsSuffix,
          '🔍 ATTENTE SIGNAL ' + _waitTfStr + ' — ' + _dirLabel + '\n' + _tfStatusLine +
            '\nConditions requises : ' + _waitTfDetail + ' + prix en zone rectangle.' +
            (_pxStr ? '\n' + _pxStr : '') +
            '\nJe n\'entre jamais au milieu du range. Je patiente.' + _newsSuffix
        ][_wdCyc];
        setCoachText(_noSetupMsg, '#64748b', 3, 5000);
        if (_wdShouldSpeak) {
          _wdLastSpeakAt = _wdNowMs; _wdLastSpeakState = _wdStateNow;
          var _vMidPct2 = (_liqHigh > 0 && _liqLow > 0 && _pxNow > 0)
            ? (_pxNow - _liqLow) / (_liqHigh - _liqLow) : -1;
          if (_vMidPct2 >= 0.25 && _vMidPct2 <= 0.75 && _liqHigh > 0 && _liqLow > 0) {
            var _vFmt2 = function(p) { return p > 100 ? p.toFixed(2) : p.toFixed(5); };
            var _vDH2 = Math.abs(_pxNow - _liqHigh), _vDL2 = Math.abs(_pxNow - _liqLow);
            var _vDHPct2 = (_vDH2 / _pxNow * 100).toFixed(2), _vDLPct2 = (_vDL2 / _pxNow * 100).toFixed(2);
            var _vTgt2  = _isLong ? 'liquidité basse à ' + _vFmt2(_liqLow) + ' (' + _vDLPct2 + '% distance)' : 'liquidité haute à ' + _vFmt2(_liqHigh) + ' (' + _vDHPct2 + '% distance)';
            speak('Prix au milieu du range — aucune entrée. Liquidité haute : ' + _vFmt2(_liqHigh) + ' (' + _vFmt2(_vDH2) + ' pts, ' + _vDHPct2 + '%). Liquidité basse : ' + _vFmt2(_liqLow) + ' (' + _vFmt2(_vDL2) + ' pts, ' + _vDLPct2 + '%). J\'attends la ' + _vTgt2 + ' avant toute analyse d\'entrée.');
          } else {
            speak(['Pas encore de setup. J\'attends ' + _waitTfDetail + ' pour un signal ' + _dirWord + '.' + (_targetZoneStr ? ' Zone cible :' + _targetZoneStr + '.' : '') + _bridgeCtxSpeak,
                   _waitTfStr + ' encore neutres côté ' + _dirWord + '. Aucun signal confirmé. Je continue d\'analyser.' + _bridgeCtxSpeak,
                   'Setup ' + _dirWord + ' pas encore visible.' + (_targetZoneStr ? ' Je surveille le niveau' + _targetZoneStr + '.' : ' J\'attends ' + _waitTfStr + ' alignés en zone.') + _bridgeCtxSpeak][_wdTotalSpeaks++ % 3]);
          }
        }

      } else if (_m15Setup && !_m5Conf) {
        _wdMode = 'approaching'; _wdBridgeConfirmCount = 0;
        // SWING : M15+H1 = setup, M5 = timing → message différent si H1 aussi confirmé
        var _swingH1Ok = _userMode === 'SWING' && _h1ok2;
        var _m15WaitLabel = _swingH1Ok
          ? 'SWING — M15+H1 ok, j\'attends M5 timing (' + _m5Str + ')'
          : 'APPROCHE ' + _dirLabel + ' : M15 ok, clôture M5 dans ' + _m5Str;
        _wdStateLabel = _m15WaitLabel + (_intentionStr || '');
        var _m15OkMsg = _swingH1Ok ? [
          '🔵 SWING — M15+H1 ' + _dirLabel + ' | ATTENTE M5\n' + _tfStatusLine +
            '\nH1 et M15 confirment la tendance ' + _dirWord + '. Mode SWING.' +
            '\nJ\'attends M5 comme timing d\'entrée (' + _m5Str + ').' +
            (_targetZoneStr ? '\nZone cible :' + _targetZoneStr + '.' : '') +
            _intentionStr + _newsSuffix,
          '🔵 SWING H1+M15 ALIGNÉS — TIMING M5\n' + _tfStatusLine +
            '\nContexte long validé. M5 est le dernier verrou (' + _m5Str + ').' +
            (_targetZoneStr ? '\nPrix surveille le niveau' + _targetZoneStr + '.' : '') +
            _intentionStr + _newsSuffix,
          '🔵 SWING — H1+M15 ok | Attente M5\n' + _tfStatusLine +
            '\nSetup SWING complet sur H1 et M15. Timing M5 manquant.' +
            '\nProchaine clôture M5 dans ' + _m5Str + '.' + _rsiM15disp +
            _intentionStr + _newsSuffix
        ][_wdCyc] : [
          '🟡 M15 EN SETUP ' + _dirLabel + ' — ATTENTE M5\n' + _tfStatusLine +
            '\nJ\'attends la prochaine clôture M5 (' + _m5Str + ').' +
            '\nSi M5 clôture ' + _dirWord + ', j\'évalue la zone.' + _rsiM15disp +
            (_targetZoneStr ? ' Zone cible :' + _targetZoneStr + '.' : '') +
            _intentionStr + _newsSuffix,
          '🟡 M15 POSITIONNÉ ' + _dirLabel + ' — M5 PAS ENCORE\n' + _tfStatusLine +
            '\nM15 en setup. M5 encore hésitant.' +
            '\nDès que M5 confirme (' + _m5Str + '), je passe en phase zone.' +
            (_tpStr ? ' ' + _tpStr : '') + _intentionStr + _newsSuffix,
          '🟡 ATTENTE CONFIRMATION M5\n' + _tfStatusLine +
            '\nM15 validé côté ' + _dirWord + '. M5 pas encore aligné.' +
            '\nUne clôture M5 propre ' + _dirWord + ' (' + _m5Str + ') et on évalue la zone.' +
            (_targetZoneStr ? ' Zone attendue :' + _targetZoneStr + _zoneProxStr + '.' : '') +
            _intentionStr + _newsSuffix
        ][_wdCyc];
        setCoachText(_m15OkMsg, _swingH1Ok ? '#3b82f6' : '#d97706', 4, 5000);
        if (_wdShouldSpeak) {
          _wdLastSpeakAt = _wdNowMs; _wdLastSpeakState = _wdStateNow;
          if (_swingH1Ok) {
            speak(['Mode SWING. H1 et M15 confirment la direction ' + _dirWord + '. J\'attends M5 pour le timing d\'entrée (' + _m5Str + ').' + (_targetZoneStr ? ' Zone cible :' + _targetZoneStr + '.' : ''),
                   'SWING actif. H1 et M15 alignés ' + _dirWord + '. Dès que M5 donne le timing (' + _m5Str + '), j\'entre avec le prix en zone.',
                   'H1 et M15 ok en mode SWING. M5 est le dernier verrou. Prochaine clôture dans ' + _m5Str + '.'][_wdTotalSpeaks++ % 3]);
          } else {
            speak(['M15 en setup ' + _dirLabel + '. J\'attends la clôture M5, ' + _m5Str + '. Si M5 confirme, j\'évalue la zone immédiatement.' + (_targetZoneStr ? ' Zone cible :' + _targetZoneStr + '.' : ''),
                   'M15 positionné ' + _dirWord + '. M5 pas encore aligné. Dès que M5 clôture proprement (' + _m5Str + '), le setup est complet.',
                   'Un seul TF valide : M15. Il me faut M5 aussi avant d\'agir (' + _m5Str + ').' + (_targetZoneStr ? ' Niveau à surveiller :' + _targetZoneStr + '.' : '')][_wdTotalSpeaks++ % 3]);
          }
        }

      } else if (!_m15Setup && _m5Conf) {
        _wdBridgeConfirmCount = 0;
        if (_userModeIsSniper) {
          // SNIPER: M15 informatif uniquement — M5 confirmé = conditions en approche
          // Prochaine étape: prix en zone rectangle + M1 timing
          _wdMode = 'approaching';
          _wdStateLabel = 'SNIPER — M5 ' + _dirLabel + ' | Zone + M1 requis (' + _m1Str + ')';
          var _sniperM5Msg = [
            '⚡ SNIPER — M5 ' + _dirLabel + '\n' + _tfStatusLine +
              '\nM5 confirme la direction. Mode SNIPER : M15 informatif seulement.' +
              '\nJ\'attends le prix en zone rectangle et M1 aligné (' + _m1Str + ').' +
              (_pxStr ? '\n' + _pxStr : '') + _intentionStr + _newsSuffix,
            '⚡ SNIPER M5 ACTIF — ZONE + M1\n' + _tfStatusLine +
              '\nM5 dans le sens ' + _dirWord + '. Conditions SNIPER : zone + M1 timing.' +
              (_targetZoneStr ? '\nZone cible :' + _targetZoneStr + '.' : '\nPrix en approche de zone.') +
              _intentionStr + _newsSuffix,
            '⚡ MODE SNIPER — M5 VALIDÉ\n' + _tfStatusLine +
              '\nM5 ok. Il me faut le prix dans la bande et M1 aligné (' + _m1Str + ').' +
              _rsiM15disp + _newsSuffix
          ][_wdCyc];
          setCoachText(_sniperM5Msg, '#a855f7', 5, 5000);
          if (_wdShouldSpeak) {
            _wdLastSpeakAt = _wdNowMs; _wdLastSpeakState = _wdStateNow;
            speak(['Mode SNIPER. M5 confirme le ' + _dirLabel + '. M15 informatif, non bloquant. J\'attends le prix en zone et M1 aligné.' + (_targetZoneStr ? ' Zone cible :' + _targetZoneStr + '.' : ''),
                   'SNIPER actif. M5 dans le bon sens ' + _dirWord + '. Dès que le prix touche la bande et que M1 confirme, j\'entre.',
                   'M5 validé en mode SNIPER. Je cherche le prix dans la bande ' + (_isLong ? 'verte' : 'rouge') + ' avec un timing M1 propre.'][_wdTotalSpeaks++ % 3]);
          }
        } else {
          // SCALP / SWING / AUTO : M15 requis pour valider le contexte
          _wdMode = 'approaching';
          _wdStateLabel = 'APPROCHE ' + _dirLabel + ' : M5 ok, clôture M15 dans ' + _m15Str + (_intentionStr || '');
          var _m5OkMsg = [
            '🟡 M5 CONFIRMÉ ' + _dirLabel + ' — ATTENTE M15\n' + _tfStatusLine +
              '\nM5 confirme la direction. M15 pas encore en setup.' +
              '\nJ\'attends la clôture M15 (' + _m15Str + ') pour valider le contexte.' +
              (_pxStr ? '\n' + _pxStr : '') + _intentionStr + _newsSuffix,
            '🟡 M5 BON — M15 MANQUE\n' + _tfStatusLine +
              '\nM5 dans le sens ' + _dirWord + '. M15 pas encore aligné.' +
              '\nJ\'attends le setup M15 (' + _m15Str + ').' +
              (_targetZoneStr ? ' Zone cible :' + _targetZoneStr + '.' : '') +
              _intentionStr + _newsSuffix,
            '🟡 ATTENTE SETUP M15\n' + _tfStatusLine +
              '\nM5 confirme. M15 encore neutre — il valide le contexte.' +
              '\nProchaine clôture M15 dans ' + _m15Str + '.' + _rsiM15disp +
              _intentionStr + _newsSuffix
          ][_wdCyc];
          setCoachText(_m5OkMsg, '#d97706', 4, 5000);
          if (_wdShouldSpeak) {
            _wdLastSpeakAt = _wdNowMs; _wdLastSpeakState = _wdStateNow;
            speak(['M5 confirme le ' + _dirLabel + '. M15 pas encore validé. J\'attends le setup M15, ' + _m15Str + '. Si M15 valide, je passe en phase zone.',
                   'M5 dans le bon sens ' + _dirWord + '. M15 encore neutre. J\'attends les deux avant d\'agir (' + _m15Str + ').',
                   'M5 bon, M15 manque. Prochaine clôture M15 dans ' + _m15Str + '.' + (_targetZoneStr ? ' Dès qu\'il confirme, j\'évalue la zone à' + _targetZoneStr + '.' : '')][_wdTotalSpeaks++ % 3]);
          }
        }

      } else if (_m15Setup && _m5Conf && !_zoneOk) {
        _wdMode = 'approaching'; _wdBridgeConfirmCount = 0;
        _wdStateLabel = 'ZONE À ATTEINDRE' + (_targetZoneStr ? _targetZoneStr + _zoneProxStr : '') + ' | ' + _dirLabel + (_intentionStr || '');
        var _noZoneMsg = [
          '🟠 M15+M5 ALIGNÉS — HORS ZONE\n' + _tfStatusLine +
            '\nDirection ' + _dirWord + ' confirmée. Prix pas encore dans la ' + _zoneProxLbl + '.' +
            (_targetZoneStr ? '\nJe surveille le niveau' + _targetZoneStr + _zoneProxStr + '.' : '') +
            _intentionStr + _newsSuffix,
          '🟠 SETUP VALIDÉ — ATTENTE ZONE\n' + _tfStatusLine +
            '\nM5+M15 parfaits. Jamais au milieu du range.' +
            (_targetZoneStr ? '\nPrix doit atteindre' + _targetZoneStr + _zoneProxStr + '.' : '\nJ\'attends la ' + _zoneProxLbl + '.') +
            (_pxStr ? '\n' + _pxStr : '') + _intentionStr + _newsSuffix,
          '🟠 HORS BLOC — ' + _dirLabel + '\n' + _tfStatusLine +
            '\nDirection claire. Zone pas encore atteinte.' +
            (_targetZoneStr ? '\nNiveau surveillé :' + _targetZoneStr + _zoneProxStr + '.' : '') +
            '\nDès que le prix touche le bloc, je vérifie la pulsion.' +
            _intentionStr + _newsSuffix
        ][_wdCyc];
        setCoachText(_noZoneMsg, '#d97706', 5, 5000);
        var _zoneSpeak = _targetZoneStr
          ? 'Je surveille le niveau' + _targetZoneStr + '. Si le prix touche la zone, je prépare un ' + _dirLabel + '.'
          : 'Direction confirmée sur M5 et M15. Si le prix atteint la ' + _zoneProxLbl + ', je prépare un ' + _dirLabel + '.';
        if (_wdShouldSpeak) {
          _wdLastSpeakAt = _wdNowMs; _wdLastSpeakState = _wdStateNow;
          // Mid-range detection: price between 25% and 75% of liqLow→liqHigh range
          var _wdMidPct = (_liqHigh > 0 && _liqLow > 0 && _pxNow > 0)
            ? (_pxNow - _liqLow) / (_liqHigh - _liqLow) : -1;
          var _wdIsMid  = (_wdMidPct >= 0.25 && _wdMidPct <= 0.75);
          if (_wdIsMid && _liqHigh > 0 && _liqLow > 0) {
            var _wdFmtP = function(p) { return p > 100 ? p.toFixed(2) : p.toFixed(5); };
            var _wdDistH = Math.abs(_pxNow - _liqHigh);
            var _wdDistL = Math.abs(_pxNow - _liqLow);
            var _wdDHPct = (_wdDistH / _pxNow * 100).toFixed(2);
            var _wdDLPct = (_wdDistL / _pxNow * 100).toFixed(2);
            var _wdTgtZone = _isLong ? 'liquidité basse' : 'liquidité haute';
            var _wdTgtLvl  = _isLong ? _wdFmtP(_liqLow) : _wdFmtP(_liqHigh);
            var _wdTgtDist = _isLong
              ? _wdFmtP(_wdDistL) + ' pts (' + _wdDLPct + '%)'
              : _wdFmtP(_wdDistH) + ' pts (' + _wdDHPct + '%)';
            var _wdMidMode = (_h1ok2 && _m15Setup) ? 'SWING' : _m15Setup ? 'SCALP' : 'SNIPER';
            var _wdMidSpeak = 'Prix au milieu du range — aucune entrée autorisée. ';
            _wdMidSpeak += 'Liquidité haute : ' + _wdFmtP(_liqHigh) + ', distance ' + _wdFmtP(_wdDistH) + ' pts (' + _wdDHPct + '%). ';
            _wdMidSpeak += 'Liquidité basse : ' + _wdFmtP(_liqLow)  + ', distance ' + _wdFmtP(_wdDistL) + ' pts (' + _wdDLPct + '%). ';
            _wdMidSpeak += 'J\'attends la ' + _wdTgtZone + ' à ' + _wdTgtLvl + ', soit ' + _wdTgtDist + '. ';
            _wdMidSpeak += 'Mode ' + _wdMidMode + ' s\'activera dès que le prix atteint ce niveau.';
            speak(_wdMidSpeak);
          } else {
            speak(['Direction ' + _dirWord + ' confirmée sur M5 et M15. ' + _zoneSpeak + _bridgeCtxSpeak,
                   'M5 et M15 alignés ' + _dirWord + '.' + (_targetZoneStr ? ' Zone à atteindre :' + _targetZoneStr + _zoneProxStr + '.' : ' Prix hors zone pour l\'instant.') + ' Je ne touche jamais au milieu du range.' + _bridgeCtxSpeak,
                   'Setup validé côté direction. Le prix n\'est pas encore dans le bloc.' + (_targetZoneStr ? ' Niveau :' + _targetZoneStr + '.' : '') + ' Dès que la zone est touchée, je vérifie la pulsion.' + _bridgeCtxSpeak][_wdTotalSpeaks++ % 3]);
          }
        }

      } else if (_m15Setup && _m5Conf && _zoneOk && !_pulsionOk) {
        _wdMode = 'approaching';
        _wdStateLabel = 'ZONE TOUCHÉE ' + _dirLabel + ' : Attente pulsion ' + (_isLong ? 'haussière' : 'baissière') + (_intentionStr || '');
        var _noPulsMsg = [
          '🟢 DANS LE BLOC — ATTENTE PULSION ' + _dirLabel + '\n' + _tfStatusLine +
            '\nZone atteinte' + (_targetZoneStr ? ' (' + _fmtPx(_targetZonePx) + ')' : '') + ', M5+M15 alignés.' +
            '\nIl me manque la pulsion : ' + _pulsLbl + '.' +
            (_tpStr ? '\n' + _tpStr + (_slStr ? ' ' + _slStr : '') : '') +
            _intentionStr + _newsSuffix,
          '🟢 PRESQUE — PULSION MANQUANTE\n' + _tfStatusLine +
            '\nTout validé sauf la confirmation candle.' +
            (_pxStr ? '\n' + _pxStr : '') +
            '\nSi la prochaine bougie clôture fort ' + _dirWord + ', j\'entre avec toi.' +
            _intentionStr + _newsSuffix,
          '🟢 BLOC ATTEINT — PATIENCE\n' + _tfStatusLine +
            '\nOn est dans la zone' + (_targetZoneStr ? ' → ' + _fmtPx(_targetZonePx) : '') + ', direction claire.' +
            '\nEncore 1 à 2 bougies. Dès que ' + _pulsLbl.split('—')[0].trim() + ' se confirme, j\'entre.' +
            _intentionStr + _newsSuffix
        ][_wdCyc];
        setCoachText(_noPulsMsg, '#16a34a', 6, 5000);
        var _zoneVocPfx = _bdZoneAtteinte ? _bdZoneAtteinte + ' ' : '';
        var _pulsSpeak = _zoneVocPfx + 'On est dans le bloc' + (_targetZoneStr ? ' au niveau ' + _fmtPx(_targetZonePx) : '') + '. Si rejet ' + (_isLong ? 'haussier' : 'baissier') + ' confirmé sur cette bougie, j\'entre en ' + _dirLabel + '.';
        if (_wdShouldSpeak) {
          _wdLastSpeakAt = _wdNowMs; _wdLastSpeakState = _wdStateNow;
          speak([_pulsSpeak + _bridgeCtxSpeak,
                 'Zone atteinte. Tout est en place sauf la confirmation candle. J\'attends le rejet ' + (_isLong ? 'haussier' : 'baissier') + ' avant d\'agir.' + _bridgeCtxSpeak,
                 'Dans le bloc' + (_targetZoneStr ? ' au niveau ' + _fmtPx(_targetZonePx) : '') + '. Direction claire.' + (_isLong ? ' Je veux voir une clôture haussière avec wick bas pour entrer.' : ' Je veux voir une clôture baissière avec wick haut pour entrer.') + _bridgeCtxSpeak][_wdTotalSpeaks++ % 3]);
        }

      } else if (_canEnterFinal && (_m15Setup || _sniperAgressif || _userModeIsSniper) && _m5Conf && _zoneOk && _effectiveSl > 0 && _effectiveTp > 0) {
        _wdMode = 'imminent';
        _wdStateLabel = _sniperBridgeOk && !_m15Setup
          ? ('🎯 SNIPER ' + _dirLabel + ' — M5+Zone+Rejet ok — attente validation M1')
          : _sniperAgressif && !_m15Setup
            ? ('🔥 SNIPER AGRESSIF ' + _dirLabel + ' — M5+Zone+Rejet ok — attente M1')
            : ('⏳ SETUP EN PRÉPARATION ' + _dirLabel + ' — validation M1 en attente');
        // ── VOCAL MODE-SPÉCIFIQUE — annonce humaine selon le type de setup ─────
        // Déclenché sur entrée dans le bloc imminent (état changé) pour ne pas spammer
        if (_wdShouldSpeak) {
          var _modeVocalBase;
          if (_userModeIsSniper && _zoneOk) {
            var _zoneDir = _isLong ? 'basse' : 'haute';
            // SNIPER: zone + exhaustion = contexte complet
            var _exhCtx = _scanExhaustionAlert
              ? ' ' + _scanExhaustionAlert + '.'
              : (' ' + _bdZoneAtteinte + ' Retournement ' + (_isLong ? 'haussier' : 'baissier') + ' en formation.');
            _modeVocalBase = 'Mode SNIPER.' + _exhCtx + ' Entrée imminente si M1 confirme.';
          } else if (_userMode === 'SWING' && _m15Setup && _h1ok2) {
            _modeVocalBase = 'Setup SWING en place sur ' + _dirLabel + '. M15 et H1 alignés. Le marché ' + (_isLong ? 'monte' : 'descend') + ' sur structure. Attends la confirmation — entrée prête.';
          } else if (_userMode === 'SCALP' || (!_h1ok2 && _m5Conf && _m15Setup)) {
            _modeVocalBase = 'Impulsion courte ' + (_isLong ? 'haussière' : 'baissière') + ' — scalp ' + _dirLabel + ' possible. Zone OK, M5 confirme. Entrée en attente de validation serveur.';
          } else {
            _modeVocalBase = 'Setup ' + _dirLabel + ' validé. Le marché ' + (_isLong ? 'monte' : 'descend') + ' — entrée prête. Je peux entrer.';
          }
          _wdLastSpeakAt = _wdNowMs; _wdLastSpeakState = _wdStateNow;
          speak(_modeVocalBase + _bridgeCtxSpeak);
        }
      } else {
        // Seuils asymétriques: évite toggle autour de 50 (watching↔approaching)
        var _prevDisplayMode = state._wdLastDisplayMode || 'watching';
        var _confThreshUp   = 55; // watching → approaching : conf doit dépasser 55
        var _confThreshDown = 40; // approaching → watching : conf doit descendre sous 40
        _wdMode = (_prevDisplayMode === 'approaching')
          ? (conf > _confThreshDown ? 'approaching' : 'watching')
          : (conf > _confThreshUp   ? 'approaching' : 'watching');
        // Identifier le garde local qui bloque (même si serveur dit canEnter=true)
        var _localGuard = !_ctxOk
          ? 'H1 fortement contraire — contexte macro bloquant'
          : (!_m15Setup && !_m5Conf)
            ? 'M15(setup) + M5(conf) non confirmés — attendre signal ' + _dirLabel
            : !_m15Setup
              ? 'M15(setup) non confirmé — attendre ' + _dirLabel + ' sur M15'
              : !_m5Conf
                ? 'M5(confirmation) non confirmée — attendre ' + _dirLabel + ' sur M5'
                : !_zoneOk
                  ? (_isLong ? 'Attente zone basse (inBot requis)' : 'Attente zone haute (inTop requis)')
                  : (!_effectiveSl || !_effectiveTp)
                    ? 'SL/TP en cours de chargement depuis bridge'
                    : 'Conditions en cours d\'alignement';
        _wdStateLabel = _canEnterFinal
          ? ('⚡ SERVER OK ' + _dirLabel + ' | LOCAL BLOQUÉ: ' + _localGuard)
          : ('SURVEILLANCE ' + _dirLabel + ' — ' + _localGuard);
        // ── STATUS PAR TF — affiché en surveillance active ──────────────────────
        var _wdH1Stat  = _lt4 ? (_lt4.includes('ACHAT') ? '🟢 LONG' : _lt4.includes('VENTE') ? '🔴 SHORT' : '🟡 NEUTRE') : '⬜ attente';
        var _wdM15Stat = _lt3 ? (_m15Setup ? ('✅ setup ' + _dirLabel)    : ('⏳ neutre — ' + _lt3.toLowerCase().replace(/_/g,' '))) : '⬜ attente';
        var _wdM5Stat  = _lt2 ? (_m5Conf   ? ('✅ confirmé ' + _dirLabel) : ('⏳ ' + _lt2.toLowerCase().replace(/_/g,' '))) : '⬜ attente';
        var _wdM1Stat  = _lt1 ? (_m1Timing ? ('✅ timing ok — validation passée') : ('⏳ ' + _lt1.toLowerCase().replace(/_/g,' ') + ' — attend alignement')) : '⬜ attente';
        var _wdRecheckLine = 'Recheck → M5:' + _nextM5In + 'min  M15:' + _nextM15In + 'min  H1:' + _nextH1In + 'min';
        state._wdRecheckTimes = { m5: _nextM5In, m15: _nextM15In, h1: _nextH1In }; // persiste pour renderArmedBanner + nextOpp
        try { renderNextOpportunity(); } catch(_) {}
        var _wdSetupTag = _probableType ? (' | ' + _probableType) : '';
        var _defColor = _canEnterFinal ? '#f97316' : '#64748b';
        var _defMsg = _canEnterFinal
          ? [
              '⚡ SERVEUR OK ' + _dirLabel + _wdSetupTag + ' — GARDE LOCAL ACTIF\nH1:  ' + _wdH1Stat + '\nM15: ' + _wdM15Stat + '\nM5:  ' + _wdM5Stat + '\nM1:  ' + _wdM1Stat + '\n⛔ Blocage local: ' + _localGuard,
              '⚡ SERVER ' + _dirLabel + ' — LOCAL BLOQUÉ\n' + _tfStatusLine + '\n⛔ ' + _localGuard + '\n' + _wdRecheckLine,
              '⚡ SIGNAL ' + _dirLabel + ' SERVEUR OK\n' + _tfStatusLine + '\nEntrée locale bloquée: ' + _localGuard + '.'
            ][_wdCyc]
          : [
              '🤖 SURVEILLANCE ' + _dirLabel + _wdSetupTag + '\nH1:  ' + _wdH1Stat + ' (contexte)\nM15: ' + _wdM15Stat + ' (setup)\nM5:  ' + _wdM5Stat + ' (filtre)\nM1:  ' + _wdM1Stat + ' ← validation finale\n⛔ ' + _localGuard,
              '🤖 EN ATTENTE — ' + _dirLabel + _wdSetupTag + '\n' + _tfStatusLine + '\n⛔ Blocage: ' + _localGuard + '\n' + _wdRecheckLine,
              '🤖 ANALYSE CONTINUE — ' + _dirLabel + '\nH1:  ' + _wdH1Stat + '\nM15: ' + _wdM15Stat + '\nM5:  ' + _wdM5Stat + '\nM1:  ' + _wdM1Stat + '\n' + _wdRecheckLine + _rsiM15disp
            ][_wdCyc];
        setCoachText(_defMsg, _defColor, 3, 5000);
        if (_wdShouldSpeak && _entryWatchdogAttempts > 3) {
          _wdLastSpeakAt = _wdNowMs; _wdLastSpeakState = _wdStateNow;
          var _localSpk = _canEnterFinal
            ? 'Serveur valide ' + (_isLong ? 'long' : 'short') + ' mais je bloque localement. ' + _localGuard + '. J\'attends que ce garde soit passé avant d\'entrer.' + _bridgeCtxSpeak
            : ['Je surveille les conditions pour le ' + _dirLabel + '. ' + _localGuard + '.' + _bridgeCtxSpeak,
               'Conditions pas encore réunies. ' + _localGuard + '. Chaque clôture est analysée.' + _bridgeCtxSpeak,
               'Analyse continue. ' + _localGuard + '. Dès que résolu, j\'agis.' + _bridgeCtxSpeak][_wdTotalSpeaks++ % 3];
          speak(_localSpk);
        }
      }
      // ── HYSTERÈSE MODE VISUEL — stoppe l'oscillation UI orange↔vert ──────────
      // Upgrade (watching→approaching→imminent) : immédiat.
      // Downgrade : 2 ticks consécutifs requis — 1 tick instable ne change pas la couleur.
      {
        var _modeRank = { watching: 0, approaching: 1, imminent: 2 };
        var _rawRank  = _modeRank[_wdMode]                    || 0;
        var _prevRank = _modeRank[state._wdLastDisplayMode]   || 0;
        if (_rawRank < _prevRank) {
          state._wdHoldTicks = (state._wdHoldTicks || 0) + 1;
          if (state._wdHoldTicks < 2) _wdMode = state._wdLastDisplayMode; // maintient 1 tick
          else                         state._wdHoldTicks = 0;
        } else {
          state._wdHoldTicks = 0;
        }
        state._wdLastDisplayMode = _wdMode;
      }
      renderArmedBanner(_wdMode,
        Object.assign({}, exec, { reason: _wdStateLabel }),
        Object.assign({}, sig, { confidence: _wdRealConf }));

      if (_canEnterFinal && !_conflictBlocking && _effectiveSl > 0 && _effectiveTp > 0 && _effectiveDirOk) {
        // ═══════════════════════════════════════════════════════════════════════
        // ENTRÉE PROTÉGÉE — gardes obligatoires (A→I)
        // Variables calculées en haut du tick — pas de double-lecture bridge
        // ═══════════════════════════════════════════════════════════════════════

        // A. BRIDGE — source de vérité TF (déjà null-checked dans banner, double-sécurité)
        if (!_bd) {
          setCoachText('⏳ BRIDGE MANQUANT — impossible de valider les TF.\nJe revérifie dans 3s.', '#64748b', 3, 5000);
          return;
        }

        // A0. ZONE STABLE — exige 2 ticks consécutifs de zone valide avant d'évaluer quoi que ce soit.
        // FIX lag Pine: inBot/inTop peut rester true pendant toute une bougie même si prix sorti.
        // 2 ticks = 6s de zone stable = confirmation que la zone est réelle, pas un artefact Pine.
        if (_bridgeHasZoneInfo && _wdZoneStableCount < 2) {
          setCoachText('⏳ ATTENTE ZONE STABLE — ' + _wdZoneStableCount + '/2 ticks confirmés\n' + _tfStatusLine +
            '\nZone détectée mais pas encore stable. ' + (_isLong ? 'Support (inBot)' : 'Résistance (inTop)') + ' en cours de confirmation.'+
            '\nJamais entrer sur la première détection — attente confirmation Pine (6s).', '#d97706', 6, 4000);
          return;
        }

        // A2. R:R MINIMUM — jamais entrer si risque/récompense < 1:1
        // Un setup valide techniquement mais avec R:R < 1 est un mauvais trade.
        var _rrPx    = state.price > 0 ? state.price : (_effectiveSl > 0 && _effectiveTp > 0 ? (_effectiveSl + _effectiveTp) / 2 : 0);
        var _rrRisk  = _rrPx > 0 && _effectiveSl > 0 ? Math.abs(_rrPx - _effectiveSl) : 0;
        var _rrReward = _rrPx > 0 && _effectiveTp > 0 ? Math.abs(_effectiveTp - _rrPx) : 0;
        var _rrCalc  = (_rrRisk > 0 && _rrReward > 0) ? _rrReward / _rrRisk : 0;
        if (_rrCalc > 0 && _rrCalc < 1.0) {
          _wdBridgeConfirmCount = 0;
          var _rrCalcStr = _rrCalc.toFixed(2);
          setCoachText(
            '⛔ R:R INSUFFISANT — 1:' + _rrCalcStr + '\n' + _tfStatusLine +
            '\nMinimum requis: 1:1 (TP doit être au moins égal au SL).' +
            '\nTP: ' + (_rrPx > 100 ? _effectiveTp.toFixed(2) : _effectiveTp.toFixed(5)) +
            ' | SL: ' + (_rrPx > 100 ? _effectiveSl.toFixed(2) : _effectiveSl.toFixed(5)) +
            '\nJ\'attends un setup avec un rapport risque/récompense correct.',
            '#ef4444', 8, 8000
          );
          if (_wdShouldSpeak) {
            _wdLastSpeakAt = _wdNowMs; _wdLastSpeakState = _wdStateNow;
            speak('R:R insuffisant: 1 pour ' + _rrCalcStr + '. Minimum requis 1 pour 1. Ce trade n\'est pas rentable. J\'attends un meilleur setup.');
          }
          return;
        }

        // B. CONTEXTE H1 — filtre macro (bloque si H1 fortement contraire)
        if (!_ctxOk) {
          _wdBridgeConfirmCount = 0;
          setCoachText('🔴 H1 BLOQUANT — entrée annulée\n' + _tfStatusLine + '\n' +
            (_isLong ? 'H1 fortement vendeur → LONG défavorable.' : 'H1 fortement haussier → SHORT défavorable.') +
            '\nEntrée impossible sans contexte macro favorable.', '#ef4444', 5, 6000);
          return;
        }

        // C+D. SETUP M15 + CONFIRMATION M5
        // SNIPER mode: M15 NON requis — M5+M1+zone+pulsion suffisent (contre-tendance autorisée)
        // AUTO/SCALP/SWING: M15 TOUJOURS requis — _sniperAgressif ne bypass M15 qu'en mode SNIPER
        // FIX: _sniperAgressif bypassait M15 même en AUTO → entrée pendant M15 contraire → corrigé
        var _m15Required = !_userModeIsSniper;
        if (_hasBridgeTfData && (!_m5Conf || (!_m15Setup && _m15Required))) {
          var _missGuard = [!_m5Conf?'M5':'', (!_m15Setup&&_m15Required)?'M15':''].filter(Boolean).join('+');
          var _m15note = _userModeIsSniper ? ' (SNIPER: M15 informatif, non bloquant)' : '';
          setCoachText('⏳ ATTENTE ' + _missGuard + ' — ' + _tfStatusLine +
            '\nM5 obligatoire.' + _m15note, '#d97706', 4, 5000);
          _wdBridgeConfirmCount = 0;
          return;
        }

        // E. ZONE BLOC — inTop/inBot OU RSI fallback (jamais au milieu du range)
        // LONG → inBot=true (RSI<55) OU RSI M15 < 38. SHORT → inTop=true (RSI>45) OU RSI M15 > 62.
        if (!_zoneGuard) {
          _wdBridgeConfirmCount = 0;
          if (_bridgeHasZoneInfo && _pineLagDetected) {
            // Zone Pine détectée mais RSI contredit → lag Pine
            var _lagRsiVal = Math.round(_rsiM15forZone);
            setCoachText('🚫 LAG PINE DÉTECTÉ — ENTRÉE BLOQUÉE\n' + _tfStatusLine + '\n' +
              (_isLong ? 'Pine dit inBot=true mais RSI M15=' + _lagRsiVal + ' (>55) — zone Pine périmée.' : 'Pine dit inTop=true mais RSI M15=' + _lagRsiVal + ' (<45) — zone Pine périmée.') +
              '\nAnti-lag: j\'attends que RSI et zone Pine soient cohérents.', '#f97316', 6, 6000);
          } else if (_bridgeHasZoneInfo) {
            // Bridge a des données zone mais pas dans la bonne zone
            setCoachText('🚫 HORS BLOC — ENTRÉE INTERDITE\n' + _tfStatusLine + '\n' +
              (_isLong ? 'LONG: attends inBot=true (bloc vert support).' : 'SHORT: attends inTop=true (bloc rouge résistance).') +
              '\nJamais au milieu — ligne orange = NON.', '#f97316', 5, 5000);
          } else {
            // Bridge n'a pas inTop/inBot — RSI proxy dit milieu du range
            var _rsiLabel = _rsiM15forZone > 0 ? ('RSI M15: ' + Math.round(_rsiM15forZone)) : 'RSI M15 inconnu';
            setCoachText('🚫 MILIEU DU RANGE — INTERDIT\n' + _tfStatusLine + '\n' +
              _rsiLabel + ' (neutre 38-62 = milieu = JAMAIS entrée).\n' +
              (_isLong ? 'Attends RSI M15 < 38 (zone basse) pour LONG.' : 'Attends RSI M15 > 62 (zone haute) pour SHORT.') +
              '\nRègle PRO: Zone + Timing = entrée. Milieu = attente.', '#f97316', 5, 6000);
          }
          if (_wdShouldSpeak) {
            _wdLastSpeakAt = _wdNowMs; _wdLastSpeakState = _wdStateNow;
            speak(_pineLagDetected
              ? (_isLong ? 'Lag Pine détecté. Pine dit zone basse mais RSI est à ' + Math.round(_rsiM15forZone) + '. Zone périmée. J\'attends la cohérence.' : 'Lag Pine détecté. Pine dit zone haute mais RSI est à ' + Math.round(_rsiM15forZone) + '. Zone périmée. J\'attends la cohérence.')
              : _bridgeHasZoneInfo
                ? 'Hors bloc. ' + (_isLong ? 'J\'attends le support.' : 'J\'attends la résistance.') + ' Jamais au milieu.'
                : 'Milieu du range. ' + (_rsiM15forZone > 0 ? 'RSI à ' + Math.round(_rsiM15forZone) + ', neutre.' : 'RSI non disponible.') + ' J\'attends une zone extrême.');
          }
          return;
        }

        // F. PULSION — bearRej (SHORT) ou bullRej (LONG) obligatoire si Pine envoie ces signaux
        if (_bridgeHasPulsionInfo && !_pulsionOk) {
          _wdBridgeConfirmCount = 0;
          setCoachText('🟢 BLOC ATTEINT — ATTENTE PULSION ' + _dirLabel + '\n' + _tfStatusLine + '\n' +
            (_isLong ? 'bullRej attendu — clôture haussière au-dessus du wick bas.' : 'bearRej attendu — clôture baissière sous le wick haut.') +
            '\nBloc validé. J\'attends la bougie de confirmation.', '#16a34a', 6, 5000);
          return;
        }

        // F2. ANTI-IMPULSE — jamais entrer pendant une forte impulsion M1 CONTRAIRE à la direction
        // Si M1 = ACHAT_FORT pendant un SHORT → marché en pleine montée → attendre retournement réel
        // Si M1 = VENTE_FORTE pendant un LONG → marché en pleine descente → attendre rebond réel
        // Exception: _lt1 absent (bridge silencieux sur M1) → pas de blocage hard
        var _m1AgainstDir = _lt1 && (
          (_isShort && _lt1 === 'ACHAT_FORT') ||
          (_isLong  && _lt1 === 'VENTE_FORTE')
        );
        if (_m1AgainstDir) {
          _wdBridgeConfirmCount = 0;
          setCoachText('⚡ IMPULSE M1 CONTRAIRE — ENTRÉE BLOQUÉE\n' + _tfStatusLine + '\n' +
            (_isShort
              ? 'M1 en ACHAT_FORT — pulsion haussière forte en cours. Pas de SHORT pendant un impulse montant.'
              : 'M1 en VENTE_FORTE — pulsion baissière forte en cours. Pas de LONG pendant un impulse descendant.') +
            '\nJ\'attends que l\'impulsion se retourne avant d\'entrer.', '#f97316', 7, 5000);
          if (_wdShouldSpeak) {
            _wdLastSpeakAt = _wdNowMs; _wdLastSpeakState = _wdStateNow;
            speak(_isShort
              ? 'M1 montre une forte pulsion haussière. Je ne rentre pas en SHORT pendant un mouvement montant. J\'attends le retournement réel.'
              : 'M1 montre une forte pulsion baissière. Je ne rentre pas en LONG pendant un mouvement descendant. J\'attends le retournement réel.');
          }
          return;
        }

        // G. RSI DRAIN — ne jamais entrer quand le marché est déjà épuisé en direction adverse
        if (_rsiDrained) {
          _wdBridgeConfirmCount = 0;
          var _rsiVal = _rsiM15v.toFixed(0);
          setCoachText('⚠️ MARCHÉ ÉPUISÉ — ENTRÉE BLOQUÉE\n' + _tfStatusLine + '\n' +
            (_isShort ? 'M15 en survente — rebond possible contre SHORT. J\'attends le calme.' : 'M15 en excès haussier — retournement possible contre LONG. J\'attends le calme.') +
            '\nEntrée reportée jusqu\'au retour en zone neutre.', '#f97316', 6, 6000);
          return;
        }

        // H. ANTI-LAG PINE — seulement si Pine envoie zone/pulsion (sinon: pas de lag possible)
        if (_bridgeHasZoneInfo || _bridgeHasPulsionInfo) {
          var _m1IsStrongNow = _lt1 && (_isLong ? _lt1 === 'ACHAT_FORT' : _lt1 === 'VENTE_FORTE');
          var _wdConfirmThreshold = (_wdZoneStableCount >= 4 && _m1IsStrongNow) ? 1
            : (_wdZoneStableCount >= 4) ? 2
            : 3;
          _wdBridgeConfirmCount++;
          if (_wdBridgeConfirmCount < _wdConfirmThreshold) {
            setCoachText('✅ TOUS GARDES PASSÉS — Confirmation ' + _wdBridgeConfirmCount + '/' + _wdConfirmThreshold + '\n' + _tfStatusLine +
              '\nAnti-lag: j\'attends encore ' + (_wdConfirmThreshold - _wdBridgeConfirmCount) + ' tick(s).' +
              (_wdConfirmThreshold < 3 ? '\n(zone stable ' + _wdZoneStableCount + ' ticks' + (_m1IsStrongNow ? ' + M1 fort' : '') + ' → seuil réduit)' : ''), '#22c55e', 7, 4000);
            return;
          }
        }

        // H2. M1 TIMING — micro-confirmation obligatoire avant toute entrée (tous modes)
        // M1 = timing chirurgical. Évite d'entrer trop tôt ou trop tard sur le setup HTF.
        // SWING, SCALP, SNIPER → validation reste sur TF supérieurs, MAIS M1 confirme le timing.
        // Exception: si M1 data absent (bridge silencieux sur M1) → on passe, pas de blocage hard.
        if (_lt1 && !_m1Timing) {
          _wdBridgeConfirmCount = 0;
          var _m1WaitMsg = _isLong
            ? 'M1 pas encore haussier. Je veux voir une impulsion M1 ACHAT avant d\'entrer. Attente du timing M1.'
            : 'M1 pas encore baissier. Je veux voir une impulsion M1 VENTE avant d\'entrer. Attente du timing M1.';
          setCoachText('⏳ ATTENTE TIMING M1 — ' + _tfStatusLine +
            '\n' + _m1WaitMsg +
            '\nToutes autres conditions validées — juste le timing M1 manque.', '#d97706', 6, 5000);
          if (_wdShouldSpeak) {
            _wdLastSpeakAt = _wdNowMs; _wdLastSpeakState = _wdStateNow;
            speak('Setup validé sur ' + _wdTf + '. J\'attends la micro-confirmation M1 avant d\'entrer. Timing chirurgical.');
          }
          return;
        }

        // H3. M1 CANDLE CLOSE — attendre la clôture de la bougie M1 qui a montré le signal
        // Un signal M1 sur bougie ouverte n'est pas confirmé (peut être annulé avant clôture).
        // Règle: si on est encore sur la même bougie que celle qui a d'abord montré _m1Timing → attendre.
        if (_lt1 && _m1Timing && state._m1TimingConfirmedCandleId !== null
            && _m1CandleIdNow <= state._m1TimingConfirmedCandleId) {
          var _m1CloseSecsLeft = Math.ceil(((state._m1TimingConfirmedCandleId + 1) * 60000 - _wdNowMs) / 1000);
          _wdBridgeConfirmCount = 0;
          var _m1CloseMsg = _m1CloseSecsLeft <= 15
            ? '⏱ CLÔTURE M1 IMMINENTE — ' + Math.max(0, _m1CloseSecsLeft) + 's\n' + _tfStatusLine +
              '\nSignal M1 présent — j\'entre dès que la bougie clôture.'
            : '⏳ ATTENTE CLÔTURE M1 — ' + _m1CloseSecsLeft + 's restants\n' + _tfStatusLine +
              '\nSignal détecté sur bougie en cours — attente confirmation clôture M1.\nJamais en mid-candle.';
          setCoachText(_m1CloseMsg, _m1CloseSecsLeft <= 15 ? '#22c55e' : '#d97706', 7, 3000);
          if (_wdShouldSpeak && _m1CloseSecsLeft <= 15 && _m1CloseSecsLeft > 0) {
            _wdLastSpeakAt = _wdNowMs; _wdLastSpeakState = _wdStateNow;
            speak('Clôture M1 dans ' + _m1CloseSecsLeft + ' secondes. Je prépare l\'entrée.');
          }
          return;
        }

        // I. CANDLE-STATE — seulement si Pine envoie bullRej/bearRej (lag mid-candle possible)
        // Sans Pine pulsion: bridge donne signal confirmed → pas besoin de filtrer par position bougie
        if (_bridgeHasPulsionInfo) {
          var _tfMinI      = _wdTf === 'H1' ? 60 : _wdTf === 'M15' ? 15 : 5;
          var _tfMsI       = _tfMinI * 60 * 1000;
          var _candleElI   = Date.now() % _tfMsI;
          var _candleRatI  = _candleElI / _tfMsI;
          if (_candleRatI > 0.20 && _candleRatI < 0.90) {
            var _secsLeftI = Math.ceil((_tfMsI - _candleElI) / 1000);
            var _secsElI   = Math.floor(_candleElI / 1000);
            var _midMsg    = _secsLeftI <= 30
              ? '⏱ CLÔTURE ' + _wdTf + ' IMMINENTE — ' + _secsLeftI + 's\n' + _tfStatusLine +
                '\nJ\'entre dès que la bougie clôture proprement. Signal confirmé en fin de bougie.'
              : '⏳ MILIEU BOUGIE ' + _wdTf + ' — ENTRÉE BLOQUÉE\n' + _tfStatusLine +
                '\nBougie ouverte depuis ' + _secsElI + 's / Clôture dans ~' + _secsLeftI + 's.' +
                '\nJamais en milieu de bougie — j\'attends la clôture pour signal confirmé.';
            setCoachText(_midMsg, _secsLeftI <= 30 ? '#22c55e' : '#d97706', 7, 3000);
            _wdBridgeConfirmCount = 0;
            return;
          }
        }

        // ── DÉTECTION MODE — AUTO sélectionne par TFs alignés ───────────────
        // SWING   : H1+M15 alignés (M5 = timing)
        // SCALP   : M5+M15 alignés, H1 neutre (M1 = timing)
        // SNIPER  : M1+M5 alignés (M15 toléré mais non bloquant)
        // AUTO    : robot applique la règle prioritaire ci-dessus
        var _userMode = (state.tradeMode || 'AUTO').toUpperCase();
        var _activeMode;
        if (_userMode === 'SCALPING' || _userMode === 'SCALPER') {
          _activeMode = 'SCALPING'; // SCALPER et SCALPING → même mode
        } else if (_userMode === 'SNIPER') {
          _activeMode = 'SNIPER';
        } else if (_userMode === 'SWING') {
          _activeMode = 'SWING';
        } else if (state._lockedSetupType) {
          // VERROU — type verrouillé depuis ANALYSER (clic ENTRER) — pas de re-détection mid-session
          // Empêche SNIPER→SWING→SCALP selon les TFs live entre armement et entrée
          var _lk = state._lockedSetupType.toUpperCase();
          _activeMode = (_lk === 'SCALP' || _lk === 'SCALPING') ? 'SCALPING'
                      : (_lk === 'SWING')           ? 'SWING'
                      : (_lk === 'SNIPER_AGRESSIF') ? 'SNIPER_AGRESSIF'
                      : 'SNIPER'; // SNIPER + STANDARD → SNIPER par défaut
        } else {
          // AUTO — sélection par TFs alignés (règles métier) — uniquement si pas de verrou
          // Priorité: SWING (H1+M15) > SCALP (M5+M15) > SNIPER (M1+M5)
          if (_sniperAgressif) {
            _activeMode = 'SNIPER_AGRESSIF'; // M5+M1+zone+rejet, M15 toléré
          } else if (_h1ok2 && _m15Setup) {
            _activeMode = 'SWING';      // H1+M15 alignés → structure longue (M5 pour timing)
          } else if (_m5Conf && _m15Setup) {
            _activeMode = 'SCALPING';   // M5+M15 alignés, H1 neutre → scalp structuré (M1 timing)
          } else if (_m5Conf && _m1Timing) {
            _activeMode = 'SNIPER';     // M1+M5 alignés → entrée chirurgicale
          } else {
            _activeMode = 'SNIPER';     // défaut — entrée précise quand zone+pulsion
          }
        }

        // ── ANALYSE PRÉ-ENTRÉE ────────────────────────────────────────────────
        var _sc1 = Number(_bd.scoreTech1 || 0);
        var _sc2 = Number(_bd.scoreTech2 || 0);
        var _sc3 = Number(_bd.scoreTech3 || 0);
        var _sc4 = Number(_bd.scoreTech4 || 0);
        var _forceGlobal = Math.round((_sc1*0.10) + (_sc2*0.15) + (_sc3*0.45) + (_sc4*0.30));
        var _forceLabel = _forceGlobal >= 75 ? 'très forte' : _forceGlobal >= 55 ? 'forte' : _forceGlobal >= 35 ? 'modérée' : 'faible';

        var _tfValidated = [];
        if (_m1Timing) _tfValidated.push('M1');
        if (_m5Conf)   _tfValidated.push('M5');
        if (_m15Setup) _tfValidated.push('M15');
        else if (_userModeIsSniper && _m5Conf) _tfValidated.push('M15(info)'); // M15 affiché info
        if (_h1ok2)    _tfValidated.push('H1');
        else if (_userModeIsSniper) _tfValidated.push('H1(info)');             // H1 affiché info
        var _tfStr = _tfValidated.join('+');

        var _zoneLabel = _bdZoneLabel; // label exact bridge
        var _pxLabel   = state.price > 0 ? (state.price > 100 ? state.price.toFixed(2) : state.price.toFixed(5)) : '';

        var _rsiH1 = Number(_bd.rsiTf4 || 0);
        var _rsiWarning = '';
        if (_isLong  && ((_rsiM15v > 72 && _rsiM15v > 0) || (_rsiH1 > 72 && _rsiH1 > 0))) {
          _rsiWarning = ' RSI étiré — surveille l\'essoufflement haussier.';
        } else if (_isShort && ((_rsiM15v < 28 && _rsiM15v > 0) || (_rsiH1 < 28 && _rsiH1 > 0))) {
          _rsiWarning = ' RSI en survente — surveille le rebond.';
        }

        var _ant = String(_bd.anticipationTexte || '').replace(/_/g,' ');
        var _af  = Number(_bd.anticipationForce || 0);
        var _antNote = _ant && _af > 50 ? ' Anticipation: ' + _ant + ' ' + Math.round(_af) + '%.' : '';

        // Descriptions vocales par mode — claires et cohérentes avec les règles
        var _modeVocal = _activeMode === 'SWING'           ? 'Mode swing. H1 et M15 alignés ' + _dirWord + '. M5 confirme le timing. Je laisse courir avec SL large.' :
                         _activeMode === 'SCALPING'         ? 'Mode scalp. M5 et M15 alignés ' + _dirWord + '. M1 pour le timing. Sortie rapide, break-even après un R.' :
                         _activeMode === 'SNIPER_AGRESSIF'  ? 'Mode sniper agressif. M5 et M1 en zone avec rejet confirmé. M15 toléré, non fortement opposé. SL court.' :
                                                              'Mode sniper. M5 et M1 alignés. Zone propre avec pulsion confirmée. Précision maximale.';

        // ── Annonce vocale PRO AVANT entrée — ce que l'agent a VU dans le bridge ──
        // Chaque phrase explique POURQUOI on entre, pas juste "j'entre"
        var _preEntrySpeak = 'Je rentre en ' + (_isLong ? 'LONG' : 'SHORT') + ' sur ' + (state.symbol || '') + '. Mode ' + (_activeMode === 'SNIPER_AGRESSIF' ? 'SNIPER AGRESSIF' : _activeMode) + ' validé. ';
        // Ce que le bridge montre sur chaque UT
        var _bdSpk = state._lastBridgeData || null;
        if (_bdSpk) {
          var _l1spk = String(_bdSpk.lectureTech1 || '').replace(/_/g,' ').toLowerCase();
          var _l2spk = String(_bdSpk.lectureTech2 || '').replace(/_/g,' ').toLowerCase();
          var _l3spk = String(_bdSpk.lectureTech3 || '').replace(/_/g,' ').toLowerCase();
          var _l4spk = String(_bdSpk.lectureTech4 || '').replace(/_/g,' ').toLowerCase();
          var _rsiM15spk = Number(_bdSpk.rsiTf3 || 0);
          var _rsiH1spk  = Number(_bdSpk.rsiTf4 || 0);
          if (_l4spk) _preEntrySpeak += 'H1: ' + _l4spk + (_rsiH1spk > 0 ? ', RSI ' + Math.round(_rsiH1spk) : '') + '. ';
          if (_l3spk) _preEntrySpeak += 'M15: ' + _l3spk + (_rsiM15spk > 0 ? ', RSI ' + Math.round(_rsiM15spk) : '') + '. ';
          if (_l2spk) _preEntrySpeak += 'M5: ' + _l2spk + '. ';
          if (_l1spk) _preEntrySpeak += 'M1: ' + _l1spk + '. ';
          var _zSpk = _bdSpk.inTop ? 'zone de retournement SHORT atteinte' : _bdSpk.inBot ? 'zone de retournement LONG atteinte' : (_rsiZoneFallback ? ('RSI ' + Math.round(_rsiM15forZone) + ' confirme la zone') : '');
          if (_zSpk) _preEntrySpeak += _zSpk + '. ';
        }
        // TFs validés
        _preEntrySpeak += _tfStr + ' validés. Force ' + _forceLabel + (_forceGlobal > 0 ? ' ' + _forceGlobal + '%' : '') + '. ';
        if (_pxLabel)    _preEntrySpeak += 'Entrée à ' + _pxLabel + '. ';
        var _slFmtSpk = _effectiveSl > 0 ? (_effectiveSl > 100 ? _effectiveSl.toFixed(2) : _effectiveSl.toFixed(5)) : null;
        var _tpFmtSpk = _effectiveTp > 0 ? (_effectiveTp > 100 ? _effectiveTp.toFixed(2) : _effectiveTp.toFixed(5)) : null;
        if (_slFmtSpk) _preEntrySpeak += 'Stop: ' + _slFmtSpk + '. ';
        if (_tpFmtSpk) _preEntrySpeak += 'Objectif: ' + _tpFmtSpk + '. ';
        if (_antNote)    _preEntrySpeak += _antNote + ' ';
        if (_rsiWarning) _preEntrySpeak += _rsiWarning + ' ';
        _preEntrySpeak += 'J\'entre maintenant. Surveillance active jusqu\'au TP ou sortie manuelle.';

        // GARDE DIRECTION — vérifier cohérence watchdog vs recommandation principale serveur
        // Si watchdog dit LONG mais recommendation globale dit SELL (ou vice versa) → conflit → bloquer
        var _mainRecEntry = String(
          (cr && cr.coach && cr.coach.agents && cr.coach.agents.analysis && cr.coach.agents.analysis.recommendation) ||
          (cr && cr.agents && cr.agents.analysis && cr.agents.analysis.recommendation) ||
          (cr && cr.coach && cr.coach.signal && cr.coach.signal.verdict) ||
          (cr && cr.signal && cr.signal.verdict) || ''
        ).toUpperCase();
        var _mainRecIsLong  = _mainRecEntry.includes('LONG') || _mainRecEntry.includes('BUY');
        var _mainRecIsShort = _mainRecEntry.includes('SELL') || _mainRecEntry.includes('SHORT');
        if (_mainRecIsLong || _mainRecIsShort) {
          if (_isLong && _mainRecIsShort) {
            speak('Conflit détecté — je vois un signal LONG local mais la recommandation globale dit SHORT. Entrée annulée. Je continue à surveiller.');
            setCoachText('⚠️ CONFLIT DIRECTION — ENTRÉE ANNULÉE\nWatchdog: LONG | Recommandation: SHORT\nJamais entrer sur signal contradictoire.', '#f97316', 6, 8000);
            startEntryWatchdog();
            return;
          }
          if (_isShort && _mainRecIsLong) {
            speak('Conflit détecté — je vois un signal SHORT local mais la recommandation globale dit LONG. Entrée annulée. Je continue à surveiller.');
            setCoachText('⚠️ CONFLIT DIRECTION — ENTRÉE ANNULÉE\nWatchdog: SHORT | Recommandation: LONG\nJamais entrer sur signal contradictoire.', '#f97316', 6, 8000);
            startEntryWatchdog();
            return;
          }
        }

        // J. VERDICT LIA — garde final obligatoire avant toute exécution
        // Si le moteur technique local dit SHORT → jamais entrer LONG (et vice versa)
        // Si le moteur dit WAIT → marché pas clair → attendre même si sniperBridgeOk
        // Règle absolue: LIA prioritaire sur watchdog — watchdog détecte, LIA valide.
        var _teVerdict = _bd ? String(_bd.verdict || '').toUpperCase() : '';
        var _liaContraLong  = _isLong  && (_teVerdict === 'SHORT' || _teVerdict === 'WAIT');
        var _liaContraShort = _isShort && (_teVerdict === 'LONG'  || _teVerdict === 'WAIT');
        if (_liaContraLong || _liaContraShort) {
          _wdBridgeConfirmCount = 0;
          var _liaVerdictLabel = _teVerdict === 'WAIT' ? 'marché non tranché' : 'direction opposée';
          var _liaBlockMsg = '🔴 LIA BLOQUE — VERDICT: ' + (_teVerdict || '—') + '\n' + _tfStatusLine +
            '\nWatchdog: ' + _dirLabel + ' | Moteur LIA: ' + (_teVerdict || 'WAIT') + ' (' + _liaVerdictLabel + ')' +
            '\nRègle: LIA prioritaire. Entrée ' + _dirLabel + ' refusée.' +
            '\nJ\'attends que le moteur technique confirme la direction.';
          setCoachText(_liaBlockMsg, '#ef4444', 8, 8000);
          if (_wdShouldSpeak) {
            _wdLastSpeakAt = _wdNowMs; _wdLastSpeakState = _wdStateNow;
            speak('LIA bloque. Verdict moteur: ' + (_teVerdict === 'WAIT' ? 'marché pas tranché' : _teVerdict) + '. Watchdog voulait entrer en ' + (_isLong ? 'LONG' : 'SHORT') + ' — LIA dit non. J\'attends la confirmation du moteur.');
          }
          return;
        }

        stopEntryWatchdog();
        speak(_preEntrySpeak);
        setCoachText(
          '🤖 ENTRÉE VALIDÉE — ' + (_isLong ? '▲ LONG' : '▼ SHORT') + ' ' + (state.symbol || '') + '\n' +
          'Mode: ' + (_activeMode === 'SNIPER_AGRESSIF' ? '🔥 SNIPER AGRESSIF' : _activeMode) + ' | Force: ' + (_forceGlobal > 0 ? _forceGlobal + '%' : _forceLabel) + '\n' +
          'M1:' + (_m1Timing?'✅':'—') + '  M5:' + (_m5Conf?'✅':'—') + '  M15:' + (_m15Setup?'✅':(_sniperAgressif?'⚡':'—')) + '  H1:' + (_h1ok2?'✅':'—') + '  Zone:' + (_zoneGuard?'✅':'—') + '\n' +
          'LIA: ' + (_teVerdict || '—') + ' ✅  Anti-lag: ✅\n' +
          (_pxLabel ? 'Entrée: ' + _pxLabel : '') +
          (_slFmtSpk ? '  SL: ' + _slFmtSpk : '') +
          (_tpFmtSpk ? '  TP: ' + _tpFmtSpk : '') +
          (_rsiWarning ? '\n⚠️' + _rsiWarning : ''),
          _isLong ? '#22c55e' : '#ef4444', 9, 12000
        );
        renderArmedBanner('entering', exec, sig);

        // Injection SL/TP si manquants sur exec — _executeAutoEntry les utilisera
        var _injectSrc = (_rvVal && _rvVal.sl > 0 && _rvVal.tp > 0) ? _rvVal : null;
        if (_injectSrc) {
          if (!cr.coach) cr.coach = {};
          if (!cr.coach.execution) cr.coach.execution = {};
          if (!cr.coach.execution.sl || cr.coach.execution.sl === 0) cr.coach.execution.sl = _injectSrc.sl;
          if (!cr.coach.execution.tp || cr.coach.execution.tp === 0) cr.coach.execution.tp = _injectSrc.tp;
          if (!cr.coach.agents) cr.coach.agents = {};
          if (!cr.coach.agents.analysis) cr.coach.agents.analysis = {};
          if (!cr.coach.agents.analysis.recommendation && _injectSrc.direction) {
            cr.coach.agents.analysis.recommendation = _injectSrc.direction;
          }
        }
        // Stocker le mode actif pour la gestion de position
        state._activeTradeMode = _activeMode;
        // Watchdog a validé toutes les gardes → entrée autorisée, bypass conflit serveur
        state._operatorOverride = true;
        // LATENCE — stocker SL/TP pré-calculés sur state → _executeAutoEntry les utilise
        // immédiatement sans attendre /instant-trade-live (évite 300-600ms de latence)
        state._wdEffectiveSl  = _effectiveSl > 0 ? _effectiveSl : 0;
        state._wdEffectiveTp  = _effectiveTp > 0 ? _effectiveTp : 0;
        state._wdEntryDir     = _isLong ? 'LONG' : 'SHORT';
        state._wdEntryPrice   = state.price > 0 ? state.price : 0;
        // Pause 2.5s — laisse l'utilisateur entendre l'annonce complète avant entrée
        await new Promise(function(r){ setTimeout(r, 2500); });
        await _executeAutoEntry(cr);
      } else if (_conflictBlocking && exec.canEnter === true) {
        setCoachText('ça va ' + (_isLong ? 'monter' : 'descendre') + ' — j\'attends l\'alignement final avant d\'entrer', '#f97316', 5, 8000);
      }
      // Mémoriser le blocage de ce tick — évite répétition vocale sur même blocage
      if (typeof _wdBlockingKey !== 'undefined') _wdLastBlockingKey = _wdBlockingKey;
    } catch(_) {
      // Ignorer les erreurs réseau passagères — le watchdog continue
    }
    // Planifier le prochain tick avec fréquence adaptée à la proximité de zone
    // Guard: si stopEntryWatchdog() a été appelé pendant l'await → _entryWatchdog = null → sortir
    if (_entryWatchdog !== null) {
      _checkZoneApproachVocal(); // annonce approche zone si applicable (throttled 90s)
      var _nextDelay = _getWatchdogInterval();
      _entryWatchdog = setTimeout(_wdStep, _nextDelay);
    }
  };

  // ── HEARTBEAT VOCAL — observations bridge toutes les 20s quand armé ──────────
  // Complémente le watchdog (qui parle sur les décisions) avec des lectures légères du marché
  var _hbLastAt = Date.now();
  var _hbCount  = 0;
  var _hbInterval = setInterval(function() {
    if (!state.armed || state.muted) { clearInterval(_hbInterval); return; }
    if (state.tradeState && state.tradeState.entered) return; // position active → watchdog gère
    var _hbNow = Date.now();
    if (_hbNow - _wdLastSpeakAt < 18000) return; // watchdog vient de parler → skip
    if (_hbNow - _hbLastAt < 18000) return;
    _hbLastAt = _hbNow;
    _hbCount++;
    var _bd = state._lastBridgeData;
    if (!_bd) { speak('Bridge en attente. Ouvre TradingView pour que j\'analyse.'); return; }
    var _lt2 = String(_bd.lectureTech2 || '').toUpperCase();
    var _lt3 = String(_bd.lectureTech3 || '').toUpperCase();
    var _lt4 = String(_bd.lectureTech4 || '').toUpperCase();
    var _rsi3 = Number(_bd.rsiTf3 || 0);
    var _inTop = _bd.inTop === true, _inBot = _bd.inBot === true;
    var _bullRej = _bd.bullRej === true, _bearRej = _bd.bearRej === true;
    var _mBull = Number(_bd.macroBull || 0), _mBear = Number(_bd.macroBear || 0);
    var _sym = state.symbol || 'le marché';
    // Construire observation 1 phrase selon contexte
    var _obs;
    if (_inBot && _bullRej) {
      _obs = 'Zone de retournement LONG atteinte avec rejet haussier confirmé. Setup LONG en cours de formation.';
    } else if (_inTop && _bearRej) {
      _obs = 'Zone de retournement SHORT atteinte avec rejet baissier confirmé. Setup SHORT en cours de formation.';
    } else if (_inBot) {
      _obs = 'Prix en zone de retournement LONG. J\'attends un rejet haussier pour confirmer l\'entrée.';
    } else if (_inTop) {
      _obs = 'Prix en zone de retournement SHORT. J\'attends un rejet baissier pour confirmer l\'entrée.';
    } else if (_lt3.includes('ACHAT') && _lt4.includes('ACHAT')) {
      _obs = _rsi3 > 70 ? 'M15 et H1 haussiers mais RSI M15 en excès. Je surveille un point d\'entrée propre.' : 'M15 et H1 alignés haussiers. J\'attends la zone de retournement LONG pour entrer.';
    } else if (_lt3.includes('VENTE') && _lt4.includes('VENTE')) {
      _obs = _rsi3 < 30 ? 'M15 et H1 baissiers mais RSI M15 en survente. Je surveille un point d\'entrée propre.' : 'M15 et H1 alignés baissiers. J\'attends la zone de retournement SHORT pour entrer.';
    } else if (_mBull > 60) {
      _obs = 'Dominance acheteur à ' + Math.round(_mBull) + '%. Je surveille la zone de retournement LONG.';
    } else if (_mBear > 60) {
      _obs = 'Dominance vendeur à ' + Math.round(_mBear) + '%. Je surveille la zone de retournement SHORT.';
    } else {
      // Mid-range dynamic: speak exact distances to each extreme
      var _hbLiqH = Number(_bd.liqHigh || 0), _hbLiqL = Number(_bd.liqLow || 0);
      var _hbPx   = Number(state.price || 0);
      var _hbMidPct = (_hbLiqH > 0 && _hbLiqL > 0 && _hbPx > 0)
        ? (_hbPx - _hbLiqL) / (_hbLiqH - _hbLiqL) : -1;
      if (_hbMidPct >= 0.25 && _hbMidPct <= 0.75 && _hbLiqH > 0 && _hbLiqL > 0) {
        var _hbFmt  = function(p) { return p > 100 ? p.toFixed(2) : p.toFixed(5); };
        var _hbDH   = Math.abs(_hbPx - _hbLiqH), _hbDL = Math.abs(_hbPx - _hbLiqL);
        var _hbDHPct = (_hbDH / _hbPx * 100).toFixed(2), _hbDLPct = (_hbDL / _hbPx * 100).toFixed(2);
        _obs = 'Prix au milieu du range — aucune entrée autorisée. '
          + 'Liquidité haute à ' + _hbFmt(_hbLiqH) + ', distance ' + _hbFmt(_hbDH) + ' pts (' + _hbDHPct + '%). '
          + 'Liquidité basse à ' + _hbFmt(_hbLiqL) + ', distance ' + _hbFmt(_hbDL) + ' pts (' + _hbDLPct + '%). '
          + 'Je ne touche pas au milieu — j\'attends les extrêmes.';
      } else {
        var _phrases = [
          'Pas encore sur un niveau clé. J\'attends que le prix atteigne une zone extrême.',
          'Je ne lis pas les données bridge — niveau de zone non confirmé. Patience.',
          'Je surveille ' + _sym + '. Aucun setup valide pour l\'instant — patience.',
        ];
        _obs = _phrases[_hbCount % _phrases.length];
      }
    }
    speak(_obs);
    _wdLastSpeakAt = _hbNow; // sync avec le chrono watchdog pour éviter double-parole
  }, 20000);

  // Stocker référence pour nettoyage au désarmement
  state._hbInterval = _hbInterval;

  // Premier tick dans 3s (laisser l'initialisation 8s se dérouler normalement)
  _entryWatchdog = setTimeout(_wdStep, 3000);
}

function stopEntryWatchdog() {
  if (_entryWatchdog) { clearTimeout(_entryWatchdog); _entryWatchdog = null; }
  if (state._hbInterval) { clearInterval(state._hbInterval); state._hbInterval = null; }
  state._m1TimingConfirmedCandleId = null; // reset M1 close tracking à chaque arrêt watchdog
}

async function disarmRobot(reason) {
  stopEntryWatchdog();
  state.armed = false;
  chrome.runtime.sendMessage({ type: 'SET_ARMED', armed: false }).catch(function() {});
  // ── BROADCAST DISARM → dashboard se synchronise immédiatement ───────
  fetchJson('/extension/command', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ command:'broadcast', payload:{ type:'trade-action', action:'DISARM', source:'extension', symbol:state.symbol, timestamp:Date.now() }}) }).catch(function(){});
  state._armedDirection = null;   // libérer la direction verrouillée
  state._wdLastDisplayMode = null; // reset hysterèse mode
  state._wdHoldTicks = 0;
  state._lockedWdTf = null;       // libérer le verrou watchdog
  state._analysisLockedTf = null; // libérer le verrou analyse — prochaine analyse repartira proprement
  state._lockedSetupType = null;  // libérer le verrou type (SNIPER/SWING/SCALP)
  _wdLastM1CandleId = 0;          // reset annonce M1
  _wdZoneStableCount     = 0;     // reset stabilité zone
  _wdZoneWasOk           = false; // reset détecteur transition zone
  _wdZoneContraCount     = 0;     // reset détecteur contradiction
  _wdZoneContraActive    = false; // reset guard async contradiction
  state._wdOverrideDir   = null;  // libérer override direction
  _wdBridgeConfirmCount  = 0;     // reset confirmations
  _wdLastBlockingKey     = '';    // reset anti-spam vocal blocage
  _wdPerTfZone = { M1: null, M5: null, M15: null, H1: null, H4: null }; // reset zones per-TF
  state._refusedProposalKey = null;  // reset refus — nouvelle session = nouvelles propositions
  state._currentProposalKey = null;
  _hideSetupProposal();
  renderArmedBanner('off', {}, {});
  // Laisser le futureEntryBanner reprendre son rôle (sera re-rendu au prochain renderDecision)
  // Remettre le bouton ENTRER
  var _eb = document.querySelector('[data-action="ENTER"]');
  if (_eb) { _eb.disabled = false; _eb.style.cssText = ''; _eb.textContent = '▶ ENTRER'; }
  // Informer le serveur (WAIT = désarmer)
  try {
    await fetchJson('/coach/trade-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: state.symbol, timeframe: state.timeframe, mode: state.tradeMode, action: 'WAIT' })
    });
  } catch(_) {}
  var ct = $('coachText');
  if (ct) { ct.textContent = reason || 'Robot désarmé — en attente du prochain setup.'; ct.style.color = '#94a3b8'; ct.style.background = ''; }
  var nx = $('dg-nextaction');
  if (nx) nx.textContent = 'Prochaine action : attendre le prochain signal propre.';
}

async function _executeAutoEntry(freshData) {
  // Entrée automatique déclenchée par le watchdog.
  // freshData = réponse fraîche du watchdog (/coach/realtime) — priorité sur state.live (peut être stale 8s)
  try {
    var liveHint = freshData || state.live || {};
    // Mise à jour de state.live avec les données fraîches — cohérence globale
    if (freshData) state.live = freshData;
    var _rawVp = liveHint.virtualPosition || {};
    var _vpIsActive = _rawVp && _rawVp.status === 'OPEN' && Number(_rawVp.sl) > 0 && Number(_rawVp.tp) > 0;
    var vpHint = _vpIsActive ? _rawVp : {};
    var itHint = liveHint.instantTrade || {};
    var metricsHint = (liveHint.tradeReasoning && liveHint.tradeReasoning.metrics) || {};
    var execHint = (liveHint.coach && liveHint.coach.execution) || liveHint.execution || {};
    // Direction: source unique = agents.analysis (déterministe serveur)
    var _agentsDir = ((liveHint.agents || (liveHint.coach && liveHint.coach.agents) || {}).analysis || {}).recommendation || '';
    var tradeHint = {
      // LATENCE — priorité aux niveaux pré-calculés du watchdog (0 latence réseau)
      // _wdEffectiveSl/_effectiveTp = bridge data de ce tick exact → précision maximale
      direction: state._wdEntryDir || _agentsDir || itHint.direction || vpHint.direction || 'WAIT',
      entry: (state._wdEntryPrice > 0 ? state._wdEntryPrice : null)
             || (state.price > 0 ? state.price : null)
             || itHint.entry || vpHint.entry || metricsHint.entry,
      sl:    (state._wdEffectiveSl > 0 ? state._wdEffectiveSl : null)
             || execHint.sl || itHint.sl || vpHint.sl || metricsHint.stopLoss || null,
      tp:    (state._wdEffectiveTp > 0 ? state._wdEffectiveTp : null)
             || execHint.tp || itHint.tp || vpHint.tp || metricsHint.takeProfit || null,
      setup_type: itHint.setup_type || state._activeTradeMode || state.tradeMode,
      rrRatio: itHint.rrRatio || metricsHint.rrRatio || '--',
      source: 'auto-watchdog'
    };
    // Nettoyer après utilisation — évite que les valeurs stale influencent le prochain ENTER
    state._wdEffectiveSl = 0; state._wdEffectiveTp = 0;
    state._wdEntryDir = null; state._wdEntryPrice = 0;
    // RÈGLE: ne jamais entrer avec direction WAIT/NEUTRE ou sans SL/TP
    var _tDir = String(tradeHint.direction || '').toUpperCase();
    if (_tDir === 'WAIT' || _tDir === 'NEUTRE' || !_tDir) {
      speak('Direction non déterminée — entrée annulée. Je continue à surveiller.');
      renderArmedBanner('watching', {}, {});
      startEntryWatchdog();
      return;
    }
    if (!tradeHint.sl || !tradeHint.tp) {
      speak('Niveaux SL/TP absents — entrée annulée. Je continue à surveiller.');
      renderArmedBanner('watching', {}, {});
      startEntryWatchdog();
      return;
    }
    // TF winner du scan — jamais state.timeframe (UT affichée sur TV)
    var _entryTf = (state._mtfWinner && state._mtfWinner.tf) ? state._mtfWinner.tf
                 : state._analysisLockedTf || state._lockedWdTf || 'M15';
    // operator: true si entrée via ACCEPTER (user a validé manuellement) — bypass re-check serveur canEnter
    var _isOperatorEntry = !!state._operatorOverride;
    state._operatorOverride = false; // consommer une seule fois
    var d = await fetchJson('/coach/trade-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: state.symbol, timeframe: _entryTf, mode: state.tradeMode, action: 'ENTER', trade: tradeHint, operator: _isOperatorEntry })
    });
    if (!d || d.ok === false) {
      // Serveur a refusé — pas de panique, on continue à surveiller
      var _refusedMsg = d?.message || d?.error || 'Signal invalide au moment de l\'entrée.';
      speak('Entrée annulée: ' + _refusedMsg.split('.')[0] + '. Je continue à surveiller.');
      renderArmedBanner('watching', {}, {});
      // Redémarrer le watchdog — peut-être dans quelques secondes ça passera
      startEntryWatchdog();
      return;
    }
    // SUCCÈS — position prise
    state.tradeState = d.state || state.tradeState;
    // Si serveur n'a pas créé de VP (instant-trade-live indisponible), utiliser tradeHint local
    if (state.tradeState && state.tradeState.entered && !state.tradeState.virtualPosition
        && tradeHint.entry && tradeHint.sl && tradeHint.tp) {
      state.tradeState.virtualPosition = {
        direction: tradeHint.direction,
        entry: tradeHint.entry,
        sl: tradeHint.sl,
        tp: tradeHint.tp,
        rrRatio: tradeHint.rrRatio || '--',
        source: tradeHint.source
      };
    }
    state.armed = false;
    state._tradeStartAt = Date.now();
    state._entryJustFired = Date.now(); // guard: empêche refreshAll/tick d'écraser la VP dans les 5s
    state._rvValidatedLevels = null; // nettoyage après entrée réussie
    scheduleSaveState(); // sauvegarder immédiatement la VP avant que refreshAll puisse l'écraser

    // TF TradingView laissé tel quel à l'entrée — l'utilisateur garde son affichage.

    // ── Déterminer le TF source du setup ─────────────────────────────────
    var _entrySq = (liveHint.coach && liveHint.coach.agents && liveHint.coach.agents.setupQuality)
                || liveHint.setupQuality || null;
    var _entryLs = (liveHint.coach && liveHint.coach.signal && liveHint.coach.signal.stats)
                || (liveHint.signal && liveHint.signal.stats) || {};
    var _setupTF = (_entrySq && _entrySq.quality === 'PREMIUM')    ? 'M15+H1'
                : (_entrySq && _entrySq.quality === 'M15_SEUL')    ? 'M15'
                : (_entrySq && _entrySq.quality === 'RETRACEMENT') ? 'M15↩H1'
                : (String(_entryLs.lecture_m15||'').toUpperCase().includes('ACHAT') || String(_entryLs.lecture_m15||'').toUpperCase().includes('VENTE')) ? 'M15'
                : (String(_entryLs.lecture_h1 ||'').toUpperCase().includes('ACHAT') || String(_entryLs.lecture_h1 ||'').toUpperCase().includes('VENTE')) ? 'H1'
                : (String(_entryLs.lecture_m5 ||'').toUpperCase().includes('ACHAT') || String(_entryLs.lecture_m5 ||'').toUpperCase().includes('VENTE')) ? 'M5'
                : state._analysisLockedTf || state._lockedWdTf || 'M15';
    // Sauvegarder pour renderPositionPanel
    state._lastSetupTF = _setupTF;
    // Indicateurs clés au moment de l'entrée (snapshot pour audit)
    var _rsiM15Snap = Number(_entryLs.rsi_m15 || 0);
    var _rsiH1Snap  = Number(_entryLs.rsi_h1  || 0);
    var _atrSnap    = Number(_entryLs.atr      || 0);
    var _entryIndicLine = 'Setup: ' + _setupTF;
    if (_rsiM15Snap > 0) _entryIndicLine += ' | M15 ' + (_rsiM15Snap > 70 ? '↑ excès' : _rsiM15Snap < 30 ? '↓ survente' : _rsiM15Snap >= 55 ? '↑' : '↓');
    if (_rsiH1Snap  > 0) _entryIndicLine += ' | H1 '  + (_rsiH1Snap  > 70 ? '↑ excès' : _rsiH1Snap  < 30 ? '↓ survente' : _rsiH1Snap  >= 55 ? '↑' : '↓');
    if (_atrSnap    > 0) _entryIndicLine += ' | ' + (_atrSnap > 0 ? 'marché actif' : '');
    if (_entrySq && _entrySq.label) _entryIndicLine += '\n' + _entrySq.label;
    state._lastEntryIndicators = _entryIndicLine;

    // Réinitialiser le scénario future entrée (position ouverte → banner disparaît)
    state._entryScenario = { wasImminent: false, wasImminentAt: 0, sym: state.symbol };
    renderArmedBanner('off', {}, {});
    var _feb = document.getElementById('futureEntryBanner'); if (_feb) _feb.style.display = 'none';
    playEntryBip();

    var enterDir = String((d.state && d.state.virtualPosition && d.state.virtualPosition.direction) || tradeHint.direction || '').toUpperCase();
    var _isEntLong = enterDir === 'LONG' || enterDir === 'BUY';

    // ── BANNIÈRE FLASH D'ENTRÉE — très visible, ne disparaît pas avant confirmation ─────
    var _entVP = (d.state && d.state.virtualPosition) ? d.state.virtualPosition : tradeHint;
    var _fmt2 = function(v){ return v > 100 ? Number(v).toFixed(2) : Number(v).toFixed(5); };
    var _flashEl = document.getElementById('entryFlashBanner');
    // Afficher le banner dès que entered=true, même si VP incomplète (vpPending)
    var _enteredOk = !!(d.state && d.state.entered);
    if (_flashEl && _enteredOk) {
      var _flashDir   = _isEntLong ? '▲ LONG' : '▼ SHORT';
      var _flashColor = _isEntLong ? '#22c55e' : '#ef4444';
      var _flashBg    = _isEntLong ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)';
      var _flashMode  = String(state._activeTradeMode || 'AUTO').replace('SNIPER_AGRESSIF','SNIPER AGRESSIF').replace('SCALPING','SCALP');
      _flashEl.style.display     = 'block';
      _flashEl.style.borderColor = _flashColor;
      _flashEl.style.background  = _flashBg;
      _flashEl.style.color       = _flashColor;
      _flashEl.innerHTML = '✅ ENTRÉE EXÉCUTÉE — ' + _flashDir + ' — MODE: ' + _flashMode + ' | ' + _setupTF
        + '<br><span style="font-size:12px;font-weight:600;color:#f1f5f9">'
        + 'Entrée: <b>' + (_entVP && _entVP.entry ? _fmt2(_entVP.entry) : '--') + '</b>'
        + ' &nbsp;|&nbsp; SL: <b style="color:#fca5a5">' + (_entVP && _entVP.sl ? _fmt2(_entVP.sl) : '--') + '</b>'
        + ' &nbsp;|&nbsp; TP: <b style="color:#86efac">' + (_entVP && _entVP.tp ? _fmt2(_entVP.tp) : '--') + '</b>'
        + '</span>';
      // Banner reste visible TANT QUE la position est ouverte — pas de timeout fixe
      // Masqué par le handler position-sync quand entered=false (voir ligne ~5170)
    }

    // ── VOIX CLAIRE : ENTRÉE EXÉCUTÉE — MODE + DIRECTION + NIVEAUX ──────────
    var _ent = _entVP ? _fmt2(_entVP.entry || 0) : '--';
    var _sl  = _entVP && _entVP.sl  ? _fmt2(_entVP.sl)  : '--';
    var _tp  = _entVP && _entVP.tp  ? _fmt2(_entVP.tp)  : '--';
    var _entMode2 = String(state._activeTradeMode || 'AUTO')
      .replace('SNIPER_AGRESSIF','SNIPER AGRESSIF')
      .replace('SCALPING','SCALP'); // normalisation: toujours "SCALP" à la voix
    var enterVoice = 'Entrée exécutée. Mode ' + _entMode2 + '. Direction ' + (_isEntLong ? 'LONG' : 'SHORT')
      + ' sur ' + _setupTF + '. Prix d\'entrée: ' + _ent + '. Stop: ' + _sl + '. Objectif: ' + _tp + '. Tu peux faire comme moi.';
    speak(enterVoice);

    // ── COACH TEXT — TRÈS CLAIR : POSITION OUVERTE ───────────────────────────
    if (_entVP && _entVP.entry) {
      var _entBg = _isEntLong ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)';
      var _ctEnt = $('coachText'); if (_ctEnt) _ctEnt.style.background = _entBg;
      var _ctMode = String(state._activeTradeMode || 'AUTO').replace('SNIPER_AGRESSIF','SNIPER AGRESSIF').replace('SCALPING','SCALP');
      setCoachText(
        '✅ ENTRÉE EXÉCUTÉE — ' + (_isEntLong ? '▲ LONG' : '▼ SHORT') + ' — MODE: ' + _ctMode
        + '\nEntrée: ' + _fmt2(_entVP.entry)
        + ' | SL: ' + (_entVP.sl ? _fmt2(_entVP.sl) : '--')
        + ' | TP: ' + (_entVP.tp ? _fmt2(_entVP.tp) : '--')
        + '\nLIA surveille le prix en temps réel — SL et TP fixés.'
        + '\n' + _entryIndicLine,
        _isEntLong ? COL_LONG : COL_SHORT, 9, 30000
      );
    }
    stopContinuousScan(); // position ouverte — arrêter la surveillance continue
    // Afficher le panel position immédiatement (avant refreshAll)
    renderPositionPanel(state.live, state.price);
    await setAgentSession(true, 'enter');
    state.stats.trades++;
    state.stats.lastEvent = 'AUTO-ENTER ' + fmtTime();
    renderStats();
    await refreshAll();
    renderMultiTF().catch(function(){});
    // Afficher les niveaux
    var freshVP = d.state && d.state.virtualPosition ? d.state.virtualPosition : null;
    if (freshVP && freshVP.entry && freshVP.sl && freshVP.tp) {
      var resolvedDir = String(freshVP.direction || '').toUpperCase();
      resolvedDir = (resolvedDir.includes('LONG') || resolvedDir.includes('BUY')) ? 'LONG' : 'SHORT';
      drawTradeLevelsExt(freshVP.entry, freshVP.sl, freshVP.tp, resolvedDir, null);
    }
    // Message coach post-entrée
    var eb = document.querySelector('[data-action="ENTER"]');
    if (eb) { eb.disabled = false; eb.style.cssText = ''; eb.textContent = '▶ ENTRER'; }
  } catch(e) {
    speak('Erreur lors de l\'entrée automatique. Je continue à surveiller.');
    renderArmedBanner('watching', {}, {});
    startEntryWatchdog(); // relancer le watchdog en cas d'erreur réseau
  }
}

// ─── TRADE ACTIONS ────────────────────────────────────────────────────────────
// ── HELPER: contexte bridge multi-TF pour explications boutons ─────────────
// Lit state.live en temps réel et retourne un résumé TF court + niveaux
function _buildTfCtx() {
  var ls = (state.live && state.live.coach && state.live.coach.signal && state.live.coach.signal.stats)
        || (state.live && state.live.signal && state.live.signal.stats) || {};
  var exec = (state.live && state.live.execution) || (state.live && state.live.coach && state.live.coach.execution) || {};
  var it   = (state.live && state.live.instantTrade) || {};
  var vp   = (state.tradeState && state.tradeState.virtualPosition) || null;

  // Directions par TF depuis bridge Pine
  var lM5  = String(ls.lecture_m5  || '').toUpperCase();
  var lM15 = String(ls.lecture_m15 || '').toUpperCase();
  var lH1  = String(ls.lecture_h1  || '').toUpperCase();
  var rM15 = Number(ls.rsi_m15 || 0);
  var rH1  = Number(ls.rsi_h1  || 0);
  // ATR: depuis signal stats OU currentData.indicators (path alternatif bridge)
  var _atrRaw = Number(ls.atr || 0);
  if (!_atrRaw) _atrRaw = Number((state.live && state.live.currentData && state.live.currentData.indicators && state.live.currentData.indicators.atr) || state._lastAtr || 0);
  if (_atrRaw > 0) state._lastAtr = _atrRaw; // cache pour prochains appels
  var atr = _atrRaw;

  var dirM5  = lM5.includes('ACHAT')  ? 'LONG' : lM5.includes('VENTE')  ? 'SHORT' : (rM15 >= 56 ? 'LONG' : rM15 <= 44 ? 'SHORT' : '--');
  var dirM15 = lM15.includes('ACHAT') ? 'LONG' : lM15.includes('VENTE') ? 'SHORT' : (rM15 >= 55 ? 'LONG' : rM15 <= 45 ? 'SHORT' : '--');
  var dirH1  = lH1.includes('ACHAT')  ? 'LONG' : lH1.includes('VENTE')  ? 'SHORT' : (rH1 >= 55  ? 'LONG' : rH1 <= 45  ? 'SHORT' : '--');

  // Résumé TF court: "M5:LONG M15:-- H1:LONG"
  var tfLine = 'M5:' + dirM5 + ' M15:' + dirM15 + ' H1:' + dirH1;
  if (rM15 > 0) tfLine += ' M15' + (rM15 > 70 ? ' ↑excès' : rM15 < 30 ? ' ↓survente' : rM15 >= 55 ? ' ↑' : ' ↓');
  if (rH1  > 0) tfLine += ' H1'  + (rH1  > 70 ? ' ↑excès' : rH1  < 30 ? ' ↓survente' : rH1  >= 55 ? ' ↑' : ' ↓');

  // Niveaux: priorité VP active > instantTrade > execution
  var entry = Number(vp && vp.entry) || Number(it.entry) || Number(exec.entry) || 0;
  var sl    = Number(vp && vp.sl)    || Number(it.sl)    || Number(exec.sl)    || 0;
  var tp    = Number(vp && vp.tp)    || Number(it.tp)    || Number(exec.tp)    || 0;
  var dir   = String((vp && vp.direction) || it.direction || exec.direction || '').toUpperCase();
  var isXau = /XAU|GOLD/.test(String(state.symbol || '').toUpperCase());
  var fmt   = function(v) { return v > 0 ? (v > 100 ? Number(v).toFixed(2) : Number(v).toFixed(5)) : '--'; };

  // P&L courant si en position
  var pnl = null;
  if (entry > 0 && state.price > 0) {
    var mul = isXau ? 10 : /JPY/.test(state.symbol||'') ? 100 : 10000;
    var raw = (dir === 'LONG' || dir === 'BUY') ? state.price - entry : entry - state.price;
    pnl = Math.round(raw * mul * 10) / 10;
  }

  // TF dominant du setup (depuis setupQuality serveur si dispo)
  var sq = (state.live && state.live.coach && state.live.coach.agents && state.live.coach.agents.setupQuality)
        || (state.live && state.live.setupQuality) || null;
  var setupTF = (sq && sq.quality === 'PREMIUM') ? 'M15+H1'
              : (sq && sq.quality === 'M15_SEUL') ? 'M15'
              : (sq && sq.quality === 'RETRACEMENT') ? 'M15 retrace'
              : lM15.includes('ACHAT') || lM15.includes('VENTE') ? 'M15'
              : lH1.includes('ACHAT')  || lH1.includes('VENTE')  ? 'H1'
              : lM5.includes('ACHAT')  || lM5.includes('VENTE')  ? 'M5' : null;

  return { tfLine, dirM5, dirM15, dirH1, rM15, rH1, atr, entry, sl, tp, dir, pnl, fmt, isXau, setupTF, sq };
}

async function sendTradeAction(action) {
  var upperAction = String(action || '').toUpperCase();

  // ── GARDE DOUBLE-PRESS EXIT — désactiver immédiatement pour éviter les doubles-clics ──
  // Le bouton est réactivé seulement en cas d'erreur serveur. En cas de succès, il reste
  // désactivé (position fermée = bouton inutile jusqu'au prochain trade).
  var _exitBtnG = upperAction === 'EXIT' ? document.querySelector('[data-action="EXIT"]') : null;
  if (_exitBtnG) {
    if (_exitBtnG.disabled) return; // déjà en cours — ignorer le double-clic
    _exitBtnG.disabled  = true;
    _exitBtnG.style.opacity = '0.5';
    _exitBtnG.textContent   = '⏳ Sortie...';
  }

  // ── ENTRER = ARMER LE ROBOT (pas d'entrée immédiate) ─────────────────────
  // L'utilisateur signale "je suis prêt". Le robot surveille et entre seul quand c'est propre.
  if (upperAction === 'ENTER' || upperAction === 'OPEN') {
    var _enterBtn2 = document.querySelector('[data-action="ENTER"]');

    // Débloquer le moteur Chrome speech synthesis sans toucher au MUTE de l'utilisateur
    // Règle: MUTE est contrôlé uniquement par le bouton MUET — jamais forcé par ARM/ANALYSER
    if (!state.muted) {
      try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch(_) {}
      _speakBusy = false; _speakQueue = [];
    }

    // Si déjà armé → annuler (toggle)
    if (state.armed) {
      speak('Robot désarmé. Surveillance annulée.');
      await disarmRobot('Surveillance annulée. Appuie sur ENTRER quand tu es prêt.');
      return;
    }
    // ── NEWS CHECK avant armement ─────────────────────────────────────────────
    var _armNewsCheck = checkNewsBlockEntry();
    if (_armNewsCheck.blocked) {
      speak(_armNewsCheck.reason.split('.')[0] + '. Je ne peux pas armer maintenant.');
      setCoachText('NEWS — ENTREE BLOQUÉE\n\n' + _armNewsCheck.reason + '\n\n' + (_armNewsCheck.afterWait || 'Attends après la réaction.'), '#f97316', 7, 30000);
      return;
    }
    if (_armNewsCheck.warning) {
      speak('Attention: ' + _armNewsCheck.reason.split('.')[0] + '. Je surveille mais tu es prévenu.');
    }
    // Contexte bridge TF pour l'annonce d'armement
    var _armCtx = _buildTfCtx();
    var _armTfMsg = _armCtx.setupTF
      ? 'Setup détecté sur ' + _armCtx.setupTF + ' — '
      : 'Surveillance ' + (_armCtx.dirM15 !== '--' ? 'M15 ' + _armCtx.dirM15 : 'multi-TF') + ' — ';
    var _armLevels = _armCtx.entry > 0
      ? 'Zone ~' + _armCtx.fmt(_armCtx.entry) + (_armCtx.sl > 0 ? ' SL:' + _armCtx.fmt(_armCtx.sl) : '') + (_armCtx.tp > 0 ? ' TP:' + _armCtx.fmt(_armCtx.tp) : '')
      : 'niveaux en attente';
    // Armer le robot
    console.log('[ADEL] ✅ state.armed = true — robot armé');
    state.armed = true;
    state._armedAt = Date.now(); // timestamp armement — garde anti-entrée immédiate
    chrome.runtime.sendMessage({ type: 'SET_ARMED', armed: true }).catch(function() {});
    // ── BROADCAST ARM → dashboard se synchronise immédiatement ──────────
    fetchJson('/extension/command', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ command:'broadcast', payload:{
        type:'trade-action', action:'ARM', source:'extension',
        symbol: state.symbol, timeframe: state._lockedWdTf || 'M15',
        _lockedTf: state._lockedWdTf || 'M15',
        timestamp: Date.now()
      }}) }).catch(function(){});
    // VERROU TYPE SETUP — verrouillé depuis ANALYSER, jamais re-détecté en cours de session
    // Évite que le watchdog change de SNIPER→SWING→SCALP selon les TFs live
    state._lockedSetupType = state._lastDetectedSetupType || null;
    // Annonce vocale enrichie — prix + contexte marché + direction + niveaux + instructions
    var _armBd     = state._lastBridgeData || null;
    var _armPx     = state.price > 0 ? (state.price > 100 ? state.price.toFixed(2) : state.price.toFixed(5)) : null;
    var _armSym    = state.symbol || '';
    var _armDir    = _armCtx.dirM15 !== '--' ? _armCtx.dirM15 : (_armCtx.dirH1 !== '--' ? _armCtx.dirH1 : '');
    var _armDirLbl = _armDir.includes('LONG') || _armDir.includes('BUY') ? 'LONG haussier' : _armDir.includes('SHORT') || _armDir.includes('SELL') ? 'SHORT baissier' : '';
    // VERROU DIRECTION — fixé une seule fois à l'armement, JAMAIS mis à jour depuis verdict serveur volatile
    // Raison: sig.verdict change à chaque poll /coach/realtime → oscillation couleur banner
    var _armDirIsLong  = _armDirLbl.includes('LONG') || _armDirLbl.includes('BUY')  || _armDir.includes('LONG') || _armDir.includes('BUY');
    var _armDirIsShort = _armDirLbl.includes('SHORT') || _armDirLbl.includes('SELL') || _armDir.includes('SHORT') || _armDir.includes('SELL');
    state._armedDirection = _armDirIsLong ? 'LONG' : _armDirIsShort ? 'SHORT' : null;
    if (_enterBtn2) {
      _enterBtn2.disabled = false;
      _enterBtn2.style.cssText = 'background:#d97706;color:#000;font-weight:700;font-size:11px;';
      _enterBtn2.textContent = '🤖 LIA SURVEILLE — ANNULER';
    }
    var _armZone   = _armBd ? (!!_armBd.inTop ? 'zone haute' : !!_armBd.inBot ? 'zone basse' : '') : '';
    var _armRsiM15 = _armBd ? Number(_armBd.rsiTf3 || 0) : 0;
    var _armRsiH1  = _armBd ? Number(_armBd.rsiTf4 || 0) : 0;
    // Construction phrase vocale
    var _armSpeak = 'Robot armé. ';
    if (_armPx)     _armSpeak += _armSym + ' à ' + _armPx + '. ';
    if (_armDirLbl) _armSpeak += 'Direction: ' + _armDirLbl + '. ';
    if (_armZone)   _armSpeak += 'Prix en ' + _armZone + '. ';
    if (_armRsiM15 > 70) _armSpeak += 'M15 en excès — surveille un essoufflement. ';
    else if (_armRsiM15 > 0 && _armRsiM15 < 30) _armSpeak += 'M15 en survente — surveille un rebond. ';
    if (_armCtx.entry > 0) _armSpeak += 'Zone cible: ' + _armCtx.fmt(_armCtx.entry) + '. ';
    if (_armCtx.sl > 0)    _armSpeak += 'Stop: ' + _armCtx.fmt(_armCtx.sl) + '. ';
    if (_armCtx.tp > 0)    _armSpeak += 'Objectif: ' + _armCtx.fmt(_armCtx.tp) + '. ';
    _armSpeak += 'Je surveille les conditions en continu — rythme adapté à la proximité de zone. J\'entre seul quand c\'est propre. Tu n\'as rien à faire.';
    speak(_armSpeak);
    var _armCurPx = state.price > 0 ? state.price : 0;
    var _armTargetPx = _armCtx.entry > 0 ? _armCtx.entry : 0;
    var _armPxLine = _armCurPx > 0 && _armTargetPx > 0
      ? 'Prix: ' + _armCtx.fmt(_armCurPx) + '  →  Zone: ' + _armCtx.fmt(_armTargetPx) + ' (' + Math.abs(_armCurPx - _armTargetPx).toFixed(2) + 'pt)'
      : _armLevels;
    setCoachText(
      '🤖 ÉTAPE 1/3 — ROBOT ARMÉ, VÉRIFICATION EN COURS\n' + _armPxLine
      + (_armCtx.sl > 0 ? ' | SL: ' + _armCtx.fmt(_armCtx.sl) : '')
      + (_armCtx.tp > 0 ? ' | TP: ' + _armCtx.fmt(_armCtx.tp) : '')
      + '\nSurveillance continue — accélère près de la zone (≤1s). Tu n\'as rien à faire.',
      '#d97706', 5, 30000
    );
    // Informer le serveur du mode ARMED
    try {
      var armResp = await fetchJson('/coach/trade-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: state.symbol, timeframe: state._analysisLockedTf || state._mtfWinner && state._mtfWinner.tf || 'M15', mode: state.tradeMode, action: 'ARM' })
      });
      if (armResp && armResp.state) state.tradeState = armResp.state;
    } catch(armErr) {
      console.error('[ARM ERROR]', armErr);
      setCoachText('⚠️ Erreur ARM — serveur inaccessible. Vérifie que le serveur tourne sur port 4000.', '#ef4444', 4, 8000);
    }
    // Banner armé avec contexte TF réel
    var _armExec = (state.live && state.live.execution) || (state.live && state.live.coach && state.live.coach.execution) || {};
    var _armSig  = (state.live && state.live.coach && state.live.coach.signal) || (state.live && state.live.signal) || {};
    renderArmedBanner('watching', _armExec, _armSig);
    var _nxtArm = $('dg-nextaction');
    if (_nxtArm) _nxtArm.textContent = '🎯 Robot armé — ' + _armTfMsg + _armLevels;

    // ── VERROU TF — calculé UNE SEULE FOIS ici, jamais recalculé depuis state.timeframe ──
    // L'utilisateur peut changer de TF sur TradingView librement — ça n'impacte PAS l'agent.
    // Priorité: winner ANALYSER > M15 par défaut. Jamais M1.
    var _validWdTfs = ['M5', 'M15', 'H1', 'H4'];
    // RÈGLE: jamais utiliser state.timeframe (UT affichée sur TV) comme source du verrou.
    // Priorité: winner ANALYSER → _analysisLockedTf → M15 par défaut.
    var _rawLockTf  = (state._mtfWinner && state._mtfWinner.tf) ? state._mtfWinner.tf
                    : (state._analysisLockedTf || 'M15');
    state._lockedWdTf = _validWdTfs.indexOf(_rawLockTf) >= 0 ? _rawLockTf : 'M15';
    // Reset du compteur M1 pour repartir proprement
    _wdLastM1CandleId = 0;

    startEntryWatchdog();
    return;
  }

  // ── EXPLICATION VOCALE AVEC DONNÉES BRIDGE RÉELLES ────────────────────
  var _bCtx = _buildTfCtx();
  var _tfSummary = _bCtx.tfLine;

  // BE — calcul distance depuis l'entrée en pts réels
  var _beExplain = 'Breakeven. Je déplace le stop loss au prix d\'entrée pour sécuriser sans perte.';
  if (_bCtx.entry > 0) {
    var _beDist = _bCtx.pnl != null ? Math.abs(_bCtx.pnl) : null;
    var _beMsg = 'SL → ' + _bCtx.fmt(_bCtx.entry);
    if (_beDist != null) _beMsg += ' — ' + (_bCtx.pnl >= 0 ? '+' : '') + _bCtx.pnl + 'pt protégés';
    _beExplain = 'Breakeven activé. ' + _beMsg + '. ' + _tfSummary;
  }

  // EXIT — P&L + direction bridge
  var _exitExplain = 'Sortie de position. Je ferme le trade et calcule le résultat.';
  if (_bCtx.entry > 0) {
    var _exitPnl = _bCtx.pnl != null ? (_bCtx.pnl >= 0 ? '+' + _bCtx.pnl : String(_bCtx.pnl)) + 'pt' : '--';
    _exitExplain = 'Fermeture ' + (_bCtx.dir || 'position') + ' — P&L: ' + _exitPnl + ' | ' + _tfSummary;
  }

  // WAIT — montrer ce qui bloque par TF
  var _waitParts = [];
  if (_bCtx.dirM15 === '--') _waitParts.push('M15 neutre' + (_bCtx.rM15 > 70 ? ' (en excès)' : _bCtx.rM15 > 0 && _bCtx.rM15 < 30 ? ' (en survente)' : ''));
  if (_bCtx.dirH1  === '--') _waitParts.push('H1 neutre'  + (_bCtx.rH1  > 70 ? ' (en excès)' : _bCtx.rH1  > 0 && _bCtx.rH1  < 30 ? ' (en survente)' : ''));
  if (_bCtx.dirM15 !== '--' && _bCtx.dirH1 !== '--' && _bCtx.dirM15 !== _bCtx.dirH1) _waitParts.push('M15 vs H1 conflit');
  var _waitExplain = 'Mode attente. ' + (_waitParts.length ? _waitParts.join(' | ') + ' — attendre alignment' : _tfSummary + ' — pas de setup propre');

  var _btnExplain = {
    EXIT:        _exitExplain,
    BE:          _beExplain,
    WAIT:        _waitExplain,
    RETEST:      'Retest. J\'annule la position actuelle et attends un nouveau setup. ' + _tfSummary,
    ARM:         'Robot armé. Je vais entrer automatiquement au prochain setup validé.',
    TAKE_PROFIT: 'Take profit partiel. Je sécurise une partie des gains. ' + (_bCtx.pnl != null ? 'P&L actuel: +' + _bCtx.pnl + 'pt' : '')
  };
  if (_btnExplain[upperAction]) speak(_btnExplain[upperAction]);

  var _enterBtn = null; // plus utilisé pour ENTER (géré ci-dessus)
  // FIX race condition EXIT: bloquer position-sync entered:true AVANT le fetchJson
  // (des SSEs arrivent pendant l'attente réseau et peuvent restaurer une position fermée)
  if (upperAction === 'EXIT' || upperAction === 'RETEST') _lastExitAt = Date.now();
  try {

    var nextEl = $('dg-nextaction');
    if (nextEl) nextEl.textContent = 'Action en cours : ' + upperAction;
    flowLog('API REQUEST /coach/trade-action', {
      action: upperAction,
      symbol: state.symbol,
      timeframe: state.timeframe,
      mode: state.tradeMode
    });

    var liveHint = state.live || {};
    // RÈGLE CRITIQUE: n'utiliser vpHint que si la position est ACTIVE (status=OPEN ou entrée en cours)
    // Une VP avec status=CLOSED = ancienne position → son direction ne doit PAS contaminer le prochain ENTER
    var _rawVp = liveHint.virtualPosition || {};
    var _vpIsActive = _rawVp && _rawVp.status === 'OPEN';
    var vpHint = _vpIsActive ? _rawVp : {}; // ignorer VP CLOSED/EXITED pour le hint
    var itHint = liveHint.instantTrade || {};
    var metricsHint = (liveHint.tradeReasoning && liveHint.tradeReasoning.metrics) || {};
    // Direction: instantTrade d'abord (signal live propre), puis VP active si dispo
    // JAMAIS utiliser direction d'une VP CLOSED comme base pour un nouveau ENTER
    var tradeHint = {
      direction: itHint.direction || vpHint.direction || 'WAIT',
      entry: itHint.entry != null ? itHint.entry : (vpHint.entry != null ? vpHint.entry : metricsHint.entry),
      sl: itHint.sl != null ? itHint.sl : (vpHint.sl != null ? vpHint.sl : metricsHint.stopLoss),
      tp: itHint.tp != null ? itHint.tp : (vpHint.tp != null ? vpHint.tp : metricsHint.takeProfit),
      setup_type: itHint.setup_type || (liveHint.tradeReasoning && liveHint.tradeReasoning.setupType) || state.tradeMode,
      rrRatio: itHint.rrRatio || metricsHint.rrRatio || '--',
      source: 'tradingview-indicator-mirror'
    };

    var d = await fetchJson('/coach/trade-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: state.symbol, timeframe: state._analysisLockedTf || state._lockedWdTf || 'M15', mode: state.tradeMode, action: action, trade: tradeHint })
    });
    flowLog('API RESPONSE /coach/trade-action', {
      ok: !!d.ok,
      action: String(action || '').toUpperCase(),
      phase: d.state && d.state.phase,
      entered: d.state && d.state.entered
    });

    // ── VÉRIFICATION CRITIQUE: le serveur a-t-il accepté l'action? ──────────────
    // RÈGLE: ne jamais exécuter le chemin "succès" si le serveur a refusé (d.ok === false)
    // Avant ce fix: la voix disait "Position prise" même sur un refus 409 du serveur
    if (d && d.ok === false) {
      var _srvErrMsg = d.message || d.error || 'Action non validée par le serveur';
      var _nxtErrEl = $('dg-nextaction');
      if (_nxtErrEl) _nxtErrEl.textContent = _srvErrMsg;
      var _cchErrEl = $('coachText');
      if (_cchErrEl) {
        _cchErrEl.textContent = '[COACH]\n' + _srvErrMsg + '\nAttends la prochaine confirmation pour entrer.';
        _cchErrEl.style.color = '#f97316';
        _cchErrEl.style.background = 'rgba(249,115,22,0.1)';
      }
      if (_enterBtn) { _enterBtn.disabled = false; _enterBtn.style.cssText = ''; _enterBtn.textContent = 'ENTRER'; }
      // Réactiver EXIT si le serveur a refusé (ex: position déjà fermée)
      if (_exitBtnG) { _exitBtnG.disabled = false; _exitBtnG.style.opacity = ''; _exitBtnG.textContent = '■ SORTIR'; }
      if (upperAction === 'ENTER' || upperAction === 'OPEN') {
        speak('Entrée non validée. ' + _srvErrMsg.split('.')[0] + '.');
      }
      return; // IMPORTANT: ne pas continuer vers le chemin succès
    }

    // Mise à jour état seulement après succès confirmé par le serveur
    state.tradeState = d.state || state.tradeState;
    if (upperAction === 'EXIT' || upperAction === 'RETEST') {
      _lastExitAt = Date.now(); // FIX race condition: bloquer position-sync entered:true pendant 30s
      stopEntryWatchdog();
      state.armed = false;
      state._lockedWdTf     = null;  // libérer verrou TF
      state._lockedSetupType = null;  // libérer verrou type (SNIPER/SWING/SCALP)
      _wdLastM1CandleId = 0;
      _wdZoneStableCount    = 0;     // reset stabilité zone
      _wdZoneWasOk          = false;
      _wdZoneContraCount    = 0;     // reset contradiction
      _wdZoneContraActive   = false;
      state._wdOverrideDir  = null;  // libérer override direction
      _wdBridgeConfirmCount = 0;     // reset confirmations
      state.tradeState  = d.state || { entered: false, armed: false };
      // FIX reload: effacer le winner stale + sauvegarder IMMÉDIATEMENT en localStorage
      // (sans timer de 120ms — si le popup se ferme avant, l'ancienne position reviendrait au reload)
      state._mtfWinner     = null;  // effacer winner pour que le watchdog ne se réarme pas
      state._pendingProposalEntry = null; // effacer proposition pendante
      state._currentProposalKey   = null;
      try { savePersistedState(); } catch(_sv) {}
      // FIX: couper immédiatement le vocal — sinon l'agent continue à parler après la fermeture
      try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch(_e) {}
      _speakQueue = []; _speakBusy = false;
      renderArmedBanner('off', {}, {});
      clearTradeLevelsExt();
      // Vider les bannières position immédiatement — sans attendre SSE
      var _flBanner = $('entryFlashBanner'); if (_flBanner) _flBanner.style.display = 'none';
      var _slBanner = $('slWarningBanner');  if (_slBanner) _slBanner.style.display = 'none';
      var _revBanner = $('reversalBanner');  if (_revBanner) _revBanner.style.display = 'none';
      var _preSignal = $('preSignalBanner'); if (_preSignal) _preSignal.style.display = 'none';
      // Forcer l'état des boutons immédiatement
      var _exitBtnPost = document.querySelector('[data-action="EXIT"]');
      var _beBtn       = document.querySelector('[data-action="BE"]');
      if (_exitBtnPost) { _exitBtnPost.disabled = true; _exitBtnPost.style.opacity = '0.4'; _exitBtnPost.style.cursor = 'not-allowed'; _exitBtnPost.textContent = '■ SORTIR'; }
      if (_beBtn)       { _beBtn.disabled = true; _beBtn.style.opacity = '0.4'; _beBtn.style.cursor = 'not-allowed'; }
      // Bouton ENTRER redevient disponible immédiatement
      var _enterBtnEx = document.querySelector('[data-action="ENTER"]');
      if (_enterBtnEx) { _enterBtnEx.disabled = false; _enterBtnEx.style.cssText = ''; _enterBtnEx.textContent = '▶ ENTRER'; }
      await setAgentSession(false, 'exit');
      // Notifier le serveur → broadcast SSE → dashboard se met à jour automatiquement
      try {
        fetchJson('/coach/trade-action', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: state.symbol, timeframe: state.timeframe, mode: state.tradeMode, action: 'WAIT' })
        }).catch(function(){});
      } catch(_) {}
      if (upperAction === 'EXIT') showTradeSummary(d.state, state.price);
    }
    state.stats.trades++;
    state.stats.lastEvent = action + ' ' + fmtTime();
    renderStats();
    await refreshAll();
    if (nextEl) nextEl.textContent = 'Action appliquée : ' + upperAction;
  } catch (e) {
    setConn('KO', 'bad');
    var errEl = $('dg-nextaction');
    var _errMsg = e && e.message ? e.message : 'inconnue';
    if (errEl) errEl.textContent = _errMsg;
    // Afficher aussi dans le coach si SL trop large
    if (_errMsg && _errMsg.length > 20) setCoachText(_errMsg, '#ef4444', 5, 8000);
    // Réactiver le bouton EXIT en cas d'erreur réseau — ne pas le laisser bloqué
    if (_exitBtnG) { _exitBtnG.disabled = false; _exitBtnG.style.opacity = ''; _exitBtnG.style.cursor = ''; _exitBtnG.textContent = '■ SORTIR'; }
    flowLog('API ERROR /coach/trade-action', {
      action: String(action || '').toUpperCase(),
      error: e && e.message ? e.message : 'unknown'
    });
  }
}

// ─── SYMBOL LIST ─────────────────────────────────────────────────────────────
function markLiveSymbols(symbols) {
  var symSelect = $('symbolSelect');
  if (!symSelect) return;
  var unique = [];
  (Array.isArray(symbols) ? symbols : []).forEach(function(s) {
    var u = String(s || '').toUpperCase();
    if (u && unique.indexOf(u) < 0) unique.push(u);
  });
  Array.from(symSelect.options).forEach(function(opt) {
    var isLive = unique.indexOf(opt.value) >= 0;
    var base = opt.textContent.replace(/^● /, '');
    opt.textContent = isLive ? '● ' + base : base;
    opt.style.color = isLive ? '#22c55e' : '';
    opt.style.fontWeight = isLive ? '800' : '';
  });
  unique.forEach(function(sym) {
    var existing = Array.from(symSelect.options).map(function(o) { return o.value; });
    if (existing.indexOf(sym) < 0) {
      var o = document.createElement('option');
      o.value = sym; o.textContent = '● ' + sym;
      o.style.color = '#22c55e'; o.style.fontWeight = '800';
      symSelect.appendChild(o);
    }
  });
}

async function loadLiveSymbols() {
  try {
    var d = await fetchJson('/extension/data');
    var symbols = Array.isArray(d.symbols) ? d.symbols.map(function(s) { return s.symbol; }) : [];
    markLiveSymbols(symbols);
  } catch (_) {}
}

// ─── SSE ──────────────────────────────────────────────────────────────────────
function handleSync(msg) {
  if (!msg || typeof msg !== 'object') return;

  // ── POSITION-SYNC / INITIAL-SYNC : source unique de l'état de position ─────────────────────
  // Le serveur envoie l'état autoritatif de la position (entered=true/false + virtualPosition).
  // L'extension aligne son état dessus → fin des états périmés (Extension=SHORT / Dashboard=LONG).
  if (msg.type === 'position-sync' || (msg.type === 'initial-sync' && msg.tradeState !== undefined)) {
    var _syncTs = msg.tradeState || null;
    // Fix stale localStorage: initial-sync retourne tradeState=null → le serveur n'a pas de position
    // Si on avait une position locale ET le serveur confirme qu'il n'en a pas → effacer immédiatement
    if (msg.type === 'initial-sync' && msg.tradeState === null && state.tradeState && state.tradeState.entered) {
      state.tradeState = null;
      scheduleSaveState();
      clearTradeLevelsExt();
      var _stalePanel = document.getElementById('positionPanel');
      if (_stalePanel) _stalePanel.style.display = 'none';
    }
    if (_syncTs && _syncTs.entered === false) {
      // GUARD SYMBOLE: ignorer si la sync concerne un AUTRE symbole que la position locale
      // Bug: _globalCoachTradeCache._latest peut être pour XAUUSD alors qu'on a BTCUSD en position
      // Route sl-hit / tp-hit embarqués dans position-sync (moniteur serveur)
      if (msg.event === 'sl-hit' || msg.event === 'tp-hit') {
        var _hitSlExt = msg.event === 'sl-hit';
        var _hitMsgExt = msg.coachMessage || (_hitSlExt ? 'Stop loss touché.' : 'Take profit atteint !');
        speak(_hitMsgExt);
        triggerAlert(_hitSlExt ? 'NEAR_SL' : 'TP_REACHED', null);
        setCoachText((_hitSlExt ? '🔴 SL TOUCHÉ — ' : '🟢 TP ATTEINT — ') + _hitMsgExt, _hitSlExt ? COL_SHORT : COL_LONG, 10, 20000);
        state.tradeState = Object.assign({}, state.tradeState || {}, { entered: false, phase: _hitSlExt ? 'SL_HIT' : 'TP_HIT', armed: false });
        state.armed = false; stopEntryWatchdog(); clearTradeLevelsExt();
        renderPositionPanel(null, state.price);
        if (msg.price) state.price = msg.price;
        scheduleSaveState(); setAgentSession(false, msg.event);
        return;
      }
      var _syncSym    = String(_syncTs.symbol || '').toUpperCase();
      var _myPosSym   = String((state.tradeState && state.tradeState.symbol) || state.symbol || '').toUpperCase();
      var _symbolMismatch = _syncSym && _myPosSym && _syncSym !== _myPosSym;
      // Serveur : aucune position active → effacer UNIQUEMENT si l'extension avait une position réelle
      // (ne pas couper une session d'analyse active : agentSessionActive peut être true sans position)
      var _hadPosition = state.tradeState && state.tradeState.entered;
      if (_hadPosition && _symbolMismatch) { /* ignore — sync pour un autre symbole */ }
      else if (_hadPosition) {
        // EXIT MANUEL (pas sl-hit/tp-hit) → désarmer complètement le watchdog
        // RÈGLE: EXIT manuel = l'utilisateur a décidé de sortir. Ne jamais re-entrer automatiquement.
        // Sans ce reset: le watchdog armé continue à chercher des entrées → re-entre hors zone sans demande.
        stopEntryWatchdog();
        state.armed = false;
        state._armedAt = null;
        state._armedDirection = null;
        state._lockedWdTf = null;
        state.agentSessionActive = false;
        state.tradeState = null;
        scheduleSaveState();
        clearTradeLevelsExt();
        var _panel = document.getElementById('positionPanel');
        if (_panel) _panel.style.display = 'none';
        var _flashBanner = document.getElementById('entryFlashBanner');
        if (_flashBanner) _flashBanner.style.display = 'none';
        // Reset bouton ENTRER → état par défaut (watchdog arrêté)
        var _enterBtnRst = document.querySelector('[data-action="ENTER"]');
        if (_enterBtnRst) {
          _enterBtnRst.disabled = false;
          _enterBtnRst.style.cssText = 'background:#1e293b;color:#94a3b8;font-weight:700;border:1px solid #f97316;';
          _enterBtnRst.textContent = '▶ ENTRER';
        }
        updateAgentStatus(state.live);
        // Remettre le bouton ANALYSER en idle
        var _btnAn = document.getElementById('btnAnalyzeNow');
        if (_btnAn) setAnalyserState(_btnAn, 'idle');
        // Vocal: confirmer que le robot est désarmé après fermeture manuelle
        setTimeout(function() {
          setCoachText('✅ Position fermée — Robot désarmé.\nClique ANALYSER pour chercher le prochain setup.', '#94a3b8', 3, 10000);
        }, 500);
      } else {
        // Pas de position → juste nettoyer tradeState stale sans tuer la session analyse
        state.tradeState = null;
      }
    } else if (_syncTs && _syncTs.entered) {
      // GUARD: ignorer position-sync entered:true dans les 30s après un EXIT local
      // Évite la race condition SSE-in-flight : le broadcast parti avant EXIT arrive après la réponse HTTP
      if (Date.now() - _lastExitAt < 30000) return;
      // Serveur : position active (avec ou sans VP) → s'assurer que l'extension a le bon état
      // Note: même sans virtualPosition, on met à jour l'état entered pour que renderPositionPanel
      // puisse afficher le panel (il affiche "ACTIF" si entered=true, VP peut manquer temporairement)
      if (!_syncTs.virtualPosition && state.tradeState && state.tradeState.virtualPosition) {
        // Garder la VP locale si le serveur n'en a pas encore (transition ENTER → VP création async)
        _syncTs.virtualPosition = state.tradeState.virtualPosition;
      }
      var _wasEntered = state.tradeState && state.tradeState.entered; // était-il déjà entré ?
      var _vp = _syncTs.virtualPosition || null;
      var _vpDir = _vp ? String(_vp.direction || '').toUpperCase() : '';
      // Règle SL: ne JAMAIS permettre à position-sync de rétrograder le SL déjà monté
      // (protection contre écrasement du SL sécurisé par une réponse API périmée)
      if (_vp && state.tradeState && state.tradeState.entered && state.tradeState.virtualPosition) {
        var _prevSl  = Number(state.tradeState.virtualPosition.sl);
        var _newSl   = Number(_vp.sl);
        var _prevDir = String(state.tradeState.virtualPosition.direction || '').toUpperCase();
        if (_prevDir === 'LONG'  && _newSl < _prevSl) _vp.sl = state.tradeState.virtualPosition.sl;
        if (_prevDir === 'SHORT' && _newSl > _prevSl) _vp.sl = state.tradeState.virtualPosition.sl;
      }
      state.tradeState = _syncTs;
      state.agentSessionActive = true;
      scheduleSaveState(); // persister immédiatement la position mise à jour
      // Badge headAgent: POSITION LONG/SHORT uniquement si VP complète (entry+sl+tp)
      var _vpComplete = _vp && Number(_vp.entry) > 0 && Number(_vp.sl) > 0 && Number(_vp.tp) > 0;
      var _ha2 = $('headAgent');
      var _posIsL = _vpDir === 'LONG';
      if (_ha2 && _vpComplete) {
        _ha2.textContent = _posIsL ? 'POSITION LONG' : 'POSITION SHORT';
        _ha2.style.background = _posIsL ? 'rgba(34,197,94,.2)' : 'rgba(239,68,68,.2)';
        _ha2.style.color = _posIsL ? COL_LONG : COL_SHORT;
        _ha2.style.borderColor = _posIsL ? 'rgba(34,197,94,.4)' : 'rgba(239,68,68,.4)';
      }
      // Chart reste fermé par défaut — l'utilisateur l'ouvre manuellement via toggleChart
      // Mettre à jour immédiatement les niveaux sur le graphique LightweightCharts
      // position-sync = source d'AUTORITÉ SERVEUR → entry du serveur prime toujours sur le cache local.
      // Si l'entry serveur diffère du cache _lastLevels (localStorage stale), on reset d'abord.
      var _e = _vp ? Number(_vp.entry) : NaN;
      var _sl = _vp ? Number(_vp.sl) : NaN;
      var _tp = _vp ? Number(_vp.tp) : NaN;
      if (isFinite(_e) && isFinite(_sl) && isFinite(_tp) && _e > 0) {
        if (state.chartOpen && typeof ChartModule !== 'undefined' && ChartModule) {
          // Détecter si l'entry serveur diffère du prix gelé dans le graphique (tolérance 0.05)
          var _lockedEntry = ChartModule._lastLevels ? Number(ChartModule._lastLevels.entry) : NaN;
          if (!isFinite(_lockedEntry) || Math.abs(_lockedEntry - _e) > 0.05) {
            // Serveur a une entry différente → reset le gel pour accepter le vrai prix serveur
            if (typeof ChartModule.resetLevels === 'function') ChartModule.resetLevels();
          }
          if (typeof ChartModule.applyTradeLevels === 'function') {
            ChartModule.applyTradeLevels({ entry: _e, sl: _sl, tp: _tp, direction: _vpDir }, state.price);
          }
        }
        drawTradeLevelsExt(_e, _sl, _tp, _vpDir, (_vp && _vp.atr) || null);
      }
      renderPositionPanel(state.live, state.price);
      // ── DÉTECTION GAINS SÉCURISÉS (SL passe au-dessus de l'entry pour LONG) ──
      var _prevSecured = _wasEntered && state.tradeState && state.tradeState.virtualPosition
        ? !!(state.tradeState.virtualPosition.secured) : false;
      // Détecter depuis les montants: LONG = sl < entry normalement, secured = sl >= entry
      var _nowSecured = _vp && (_vp.secured === true
        || (_vpDir === 'LONG' && _sl >= _e && _sl > 0 && _e > 0)
        || (_vpDir === 'SHORT' && _sl <= _e && _sl > 0 && _e > 0));
      if (_wasEntered && _nowSecured && !_prevSecured) {
        var _slFmt = _sl > 100 ? Number(_sl).toFixed(2) : Number(_sl).toFixed(5);
        speak('Gains sécurisés ! Le stop loss est maintenant au-dessus de l\'entrée. Position protégée.');
        setCoachText('✅ GAINS SÉCURISÉS — SL au-dessus de l\'entrée. Position protégée. SL: ' + _slFmt, '#22c55e', 7, 15000);
        triggerAlert('SECURED', null);
      }
      // NOUVELLE ENTRÉE ROBOT : annoncer que l'utilisateur peut rentrer maintenant
      if (!_wasEntered && _vp) {
        var _dirLbl = _posIsL ? 'acheteuse' : 'vendeuse';
        var _entryFmt = _vp.entry > 100 ? Number(_vp.entry).toFixed(2) : Number(_vp.entry).toFixed(5);
        var _slFmt2 = _vp.sl > 100 ? Number(_vp.sl).toFixed(2) : _vp.sl ? Number(_vp.sl).toFixed(5) : '--';
        var _tpFmt2 = _vp.tp > 100 ? Number(_vp.tp).toFixed(2) : _vp.tp ? Number(_vp.tp).toFixed(5) : '--';
        speak('Signal ' + (_posIsL ? 'LONG' : 'SHORT') + ' actif sur ' + state.symbol + '. Zone d\'entrée à ' + _entryFmt + '. Patiente — laisse le marché venir à toi.');
        setCoachText(
          '📡 SIGNAL ' + (_posIsL ? '▲ LONG' : '▼ SHORT') + ' À VENIR\nZone cible: ' + _entryFmt + ' | SL: ' + _slFmt2 + ' | TP: ' + _tpFmt2 + '\nPatiente — le robot surveille l\'entrée.',
          _posIsL ? COL_LONG : COL_SHORT, 9, 15000
        );
        // Afficher le panel position immédiatement (sans attendre le prochain refreshAll)
        setTimeout(function() { refreshAll(); renderPositionPanel(state.live, state.price); }, 300);
      }
    }
    if (msg.type === 'position-sync') return; // initial-sync continue pour le reste
  }

  // ── TRADE-ACTION SSE — mise à jour immédiate position sur ENTER/EXIT/SET_TP/BREAKEVEN ──
  // Quand une action trade est faite (extension ou dashboard), le serveur broadcast cet event.
  // On réutilise la logique position-sync pour aligner l'état.
  if (msg.type === 'trade-action') {
    var _taState = { entered: msg.entered, phase: msg.phase, bePlaced: msg.bePlaced,
                     partialTaken: msg.partialTaken, virtualPosition: msg.virtualPosition || null,
                     symbol: msg.symbol, timeframe: msg.timeframe };
    handleSync(Object.assign({}, msg, { type: 'position-sync', tradeState: _taState }));
    var _taAction = String(msg.action || '').toUpperCase();
    var _taVp     = msg.virtualPosition || null;
    if ((_taAction === 'ENTER' || _taAction === 'OPEN') && _taVp
        && Number(_taVp.entry) > 0 && Number(_taVp.sl) > 0 && Number(_taVp.tp) > 0) {
      state.agentSessionActive = true;
      var _taIsLong = String(_taVp.direction || '').toUpperCase().includes('LONG')
                   || String(_taVp.direction || '').toUpperCase().includes('BUY');
      var _taEntryBg = _taIsLong ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)';
      var _taCtEl = $('coachText'); if (_taCtEl) _taCtEl.style.background = _taEntryBg;
      setCoachText('🚀 ROBOT ENTRÉ ' + (_taIsLong ? '▲ LONG' : '▼ SHORT') +
        '\nEntrée : ' + fmt(_taVp.entry) + '  SL : ' + fmt(_taVp.sl) + '  TP : ' + fmt(_taVp.tp),
        _taIsLong ? COL_LONG : COL_SHORT, 9, 15000);
      setTimeout(function() { refreshAll(); }, 300);
    } else if ((_taAction === 'ENTER' || _taAction === 'OPEN') && msg.vpPending) {
      // vpPending: position confirmée côté serveur mais virtualPosition pas encore complète
      // Afficher "en attente" — le position-sync (5s) fournira les niveaux complets
      state.agentSessionActive = true;
      setCoachText('⏳ ENTRÉE CONFIRMÉE — niveaux en calcul...\nPosition visible dans 5s.',
        '#f59e0b', 7, 8000);
      setTimeout(function() { refreshAll(); }, 5500);
    } else if (_taAction === 'ARM' && msg.source !== 'extension') {
      // ── SYNC ARM depuis dashboard — appliqué ici dans handleSync ──────────────
      // C'est ici que l'event arrive via /extension/sync (state.sse).
      // AVANT ce fix: aucun case ARM → tombait dans le vide silencieusement.
      console.log('[SYNC] [EXT] RECEIVE ARM — source=' + (msg.source||'?') + ' symbol=' + (msg.symbol||'?') + ' ut=' + (msg.timeframe||'?'));
      if (state.tradeState && state.tradeState.entered) {
        console.log('[SYNC] [EXT] BLOCK ARM reason=position_active');
      } else if (state.armed) {
        console.log('[SYNC] [EXT] BLOCK ARM reason=already_armed → forcer resync visuel uniquement');
        var _btnArmUpd = document.querySelector('[data-action="ENTER"]');
        if (_btnArmUpd) { _btnArmUpd.disabled = false; _btnArmUpd.style.cssText = 'background:#d97706;color:#000;font-weight:700;font-size:11px;'; _btnArmUpd.textContent = '🤖 LIA SURVEILLE — ANNULER'; }
      } else {
        console.log('[SYNC] [EXT] APPLY ARM');
        state.armed = true;
        state._armedAt = msg.timestamp || Date.now();
        state._armedDirection = null;
        state._lockedWdTf = msg._lockedTf || msg.timeframe || 'M15';
        var _btnArm = document.querySelector('[data-action="ENTER"]');
        if (_btnArm) { _btnArm.disabled = false; _btnArm.style.cssText = 'background:#d97706;color:#000;font-weight:700;font-size:11px;'; _btnArm.textContent = '🤖 LIA SURVEILLE — ANNULER'; }
        if (!state.muted) speak('Robot armé depuis le dashboard. Je surveille ' + (msg.symbol || state.symbol) + ' en temps réel.');
        startEntryWatchdog();
      }
    } else if (_taAction === 'DISARM' && msg.source !== 'extension') {
      // ── SYNC DISARM depuis dashboard ──────────────────────────────────────────
      console.log('[SYNC] [EXT] RECEIVE DISARM — source=' + (msg.source||'?'));
      if (state.armed || _entryWatchdog) {
        console.log('[SYNC] [EXT] APPLY DISARM');
        disarmRobot('Désarmé par synchronisation dashboard.');
      }
    } else if (_taAction === 'EXIT') {
      // Robot désarmé via handleSync — ne pas re-parler de "surveillance continue"
      setCoachText('✅ Position fermée — Robot désarmé.\nClique ANALYSER pour chercher le prochain setup.', '#94a3b8', 8, 10000);
      state.agentSessionActive = false;
      clearTradeLevelsExt();
    } else if (_taAction === 'BREAKEVEN' || _taAction === 'BE') {
      setCoachText('🔒 Breakeven activé — risque zéro.', '#22c55e', 6, 15000);
      var _taBeKey = '_beSpokenAt';
      var _taNow = Date.now();
      if (!state[_taBeKey] || (_taNow - state[_taBeKey]) > 10000) {
        state[_taBeKey] = _taNow;
        if (!state.muted) speak('Je sécurise la position. Break-even activé — risque zéro.');
      }
    }
    return;
  }

  if (msg.type === 'bridge-config') {
    applyBridgeConfig(msg.bridgeConfig || msg);
    updateHeader();
    return;
  }
  // Dashboard → Extension mode sync
  if (msg.type === 'mode-change' && msg.mode) {
    var nm = String(msg.mode).toUpperCase();
    if (['AUTO','SCALPER','SNIPER','SWING','ANALYSE','ALERTE','EXECUTION_PREPAREE'].indexOf(nm) >= 0) {
      state.tradeMode = nm;
      var ms2 = $('modeSelect');
      if (ms2 && Array.from(ms2.options).some(function(o) { return o.value === nm; })) ms2.value = nm;
      updateHeader();
    }
    return;
  }

  // analysis-running: dashboard lancé → loading state dans extension (et vice-versa)
  if (msg.type === 'analysis-running' && msg.source !== 'extension') {
    var an = $('analysisText');
    if (an) { an.textContent = '🔍 ANALYSE EN COURS (' + (msg.symbol || state.symbol) + ' ' + (msg.timeframe || state.timeframe) + ')...'; }
    var btnA = document.getElementById('btnAnalyzeNow');
    if (btnA) setAnalyserState(btnA, 'analyzing');
    // Auto-reset après 18s si l'analyse ne réussit pas
    setTimeout(function() {
      var _btnAR = document.getElementById('btnAnalyzeNow');
      if (_btnAR) { try { setAnalyserState(_btnAR, 'wait'); } catch(_) {} }
      var _anEl = $('analysisText');
      if (_anEl && _anEl.textContent.includes('ANALYSE EN COURS')) _anEl.textContent = '—';
    }, 18000);
    return;
  }

  // analysis-complete: résultat d'analyse reçu depuis le serveur (déclenché par Dashboard ANALYSER)
  // → mettre à jour l'extension avec exactement les mêmes données que le Dashboard
  if (msg.type === 'analysis-complete') {
    var sig = String(msg.signal || 'WAIT').toUpperCase();
    var isL = sig.indexOf('LONG') >= 0 || sig.indexOf('BUY') >= 0;
    var isS = sig.indexOf('SHORT') >= 0 || sig.indexOf('SELL') >= 0;
    var metrics = msg.metrics || {};

    // SOURCE UNIQUE: si position active, la direction de la position prime sur le signal frais
    // → évite Dashboard=LONG / Extension=SHORT / Agent=BUY pour un même trade
    var posActive = msg.tradeState && msg.tradeState.entered && msg.tradeState.virtualPosition;
    if (posActive) {
      var _pd = String(msg.tradeState.virtualPosition.direction || '').toUpperCase();
      isL = _pd === 'LONG' || _pd.indexOf('BUY') >= 0;
      isS = _pd === 'SHORT' || _pd.indexOf('SELL') >= 0;
    }

    // 1. Mettre à jour le texte d'analyse
    var anEl = $('analysisText');
    if (anEl && msg.response) { anEl.textContent = msg.response; }

    // 2. Mettre à jour le signal (coachText + agent status)
    var _coachMsg = msg.response || sig;
    if (_coachMsg) {
      // SORTIE ANTICIPÉE — alerte prio 7, fond orange
      var _isEarlyExit = _coachMsg.includes('SORTIE ANTICIPÉE');
      if (_isEarlyExit) {
        var _ctEE = $('coachText'); if (_ctEE) _ctEE.style.background = 'rgba(249,115,22,0.12)';
        setCoachText(_coachMsg, COL_PENDING, 7, 15000);
        var _earlyExitKey = [state.symbol, state.timeframe, 'EARLY_EXIT'].join('|');
        if (!state._alertedKeys[_earlyExitKey]) {
          state._alertedKeys[_earlyExitKey] = true;
          if (!state.muted) speak('Attention, sortie anticipée recommandée. Le marché montre des signes d\'essoufflement.');
        }
      } else {
        var _ctNorm = $('coachText'); if (_ctNorm) _ctNorm.style.background = '';
        delete state._alertedKeys[[state.symbol, state.timeframe, 'EARLY_EXIT'].join('|')];
        var _normColor = isL ? COL_LONG : isS ? COL_SHORT : COL_WAIT;
        setCoachText(_coachMsg, _normColor, 2, 5000); // prio 2 — coach stream général
      }
    }

    // 3. Mettre à jour l'état du bouton ANALYSER — inactif si position déjà ouverte
    if (!posActive) {
      var btnAnalyze = document.getElementById('btnAnalyzeNow');
      if (btnAnalyze) {
        setAnalyserState(btnAnalyze, isL ? 'buy' : isS ? 'sell' : 'idle');
      }

      // 4. Mettre à jour l'état entrer si setup validé (seulement hors position active)
      if (msg.canEnter) {
        state.analysisReady = true;
        state.lastSignal = sig;
      } else {
        state.analysisReady = false;
      }

      // 5. Tracer les niveaux frais seulement si pas de position active
      if (metrics.entry && (metrics.stopLoss || metrics.sl) && (metrics.takeProfit || metrics.tp)) {
        var entryV = Number(metrics.entry);
        var slV    = Number(metrics.stopLoss || metrics.sl);
        var tpV    = Number(metrics.takeProfit || metrics.tp);
        var dir    = isL ? 'LONG' : isS ? 'SHORT' : null;
        if (dir && entryV > 0 && slV > 0 && tpV > 0) {
          drawTradeLevelsExt(entryV, slV, tpV, dir, metrics.atr || null);
        }
      }
    }

    // 6. headAgent badge — via updateAgentStatus (respecte state.armed)
    updateAgentStatus(state.live);
    return;
  }

  // price-stale: prix TV périmé — monitoring SL/TP suspendu côté serveur
  if (msg.type === 'price-stale') {
    var _stSym = String(msg.symbol || state.symbol).toUpperCase();
    var _stSec = msg.staleSeconds ? msg.staleSeconds + 's' : '?s';
    var _stRsn = msg.reason === 'no-data' ? 'aucune donnée' : 'stale ' + _stSec;
    var _stDiag = $('diagLine');
    // Guard: n'afficher le message coach que si le stale concerne le symbole actuellement affiché.
    // Un stale BTCUSD ne doit pas polluer le coach quand l'utilisateur est sur XAUUSD.
    if (_stSym === state.symbol.toUpperCase()) {
      var _stEl = $('coachText');
      if (_stEl) {
        _stEl.textContent = '⚠️ FLUX COUPÉ — ' + _stSym + ' (' + _stRsn + ')\nSurveillance SL/TP suspendue. Reconnectez TradingView.';
        _stEl.style.color = '#f59e0b';
        _stEl.style.background = 'rgba(245,158,11,0.08)';
      }
      if (_stDiag) { _stDiag.textContent = '⚠️ PRIX PÉRIMÉ — SL/TP monitoring suspendu (' + _stRsn + ')'; _stDiag.style.color = '#f59e0b'; }
    }
    // Stale sur un autre symbole → silencieux, ne pas polluer l'affichage GOLD
    return;
  }

  // mute-state: sync MUTE depuis dashboard
  if (msg.type === 'mute-state' && msg.source !== 'extension') {
    state.muted = msg.muted === true;
    var muteBtn = $('btnMute');
    if (muteBtn) muteBtn.textContent = state.muted ? '🔇 MUET' : '🔊 SON';
    if (state.muted && window.speechSynthesis) window.speechSynthesis.cancel();
    return;
  }
  // Sync reset stats — le serveur a effacé le journal, recharger les compteurs côté extension
  if (msg.type === 'journal-reset') {
    state.stats.trades   = 0;
    state.stats.signals  = 0;
    state.stats.lastEvent = 'Reset ' + fmtTime();
    renderStats();
    var _sEl = document.getElementById('statSignals'); if (_sEl) _sEl.textContent = '0';
    var _tEl = document.getElementById('statTrades');  if (_tEl) _tEl.textContent = '0';
    var _rEl = document.getElementById('statRate');    if (_rEl) _rEl.textContent = '--';
    loadJournalStats().catch(function(){});
    return;
  }
  // Symbol is lockable by user; timeframe/mode remain shared and always synced.
  var isInitial = msg.type === 'initial-sync';
  var isActiveSymbol = msg.type === 'active-symbol';
  var _msgSrc = String(msg.source || (msg.activeSymbol && msg.activeSymbol.source) || '').toLowerCase();
  var fromTradingviewRuntime = _msgSrc === 'tradingview' || _msgSrc === 'tradingview-extension'
    || String(msg.resolvedBy || (msg.activeSymbol && msg.activeSymbol.resolvedBy) || '').toLowerCase() === 'tv-runtime-fresh';
  if (fromTradingviewRuntime && isActiveSymbol) state.userLocked = false;
  var canUpdateSymbol = isInitial || (isActiveSymbol && (!state.userLocked || fromTradingviewRuntime));
  var shouldSyncContext = isInitial || isActiveSymbol;

  if (shouldSyncContext) {
    // TV est MAÎTRE pour symbole ET timeframe sur les événements active-symbol.
    // NE PAS mettre à jour le TF sur les ticks prix (tradingview-data) — ça rechargerait l'iframe.
    // METTRE À JOUR le TF sur active-symbol (changement réel de symbole/TF sur TV) et initial-sync.
    var isTickOnly = msg.type === 'tradingview-data' || msg.type === 'tv-data';
    if (canUpdateSymbol && msg.symbol) state.symbol = String(msg.symbol).toUpperCase();
    if (!isTickOnly && msg.timeframe && TFS.indexOf(String(msg.timeframe).toUpperCase()) >= 0) {
      var newTfCmd = String(msg.timeframe).toUpperCase();
      if (newTfCmd !== state.timeframe) {
        state.timeframe = newTfCmd;
        var _ts2 = $('tfSelect');
        if (_ts2 && Array.from(_ts2.options).some(function(o){ return o.value === newTfCmd; })) _ts2.value = newTfCmd;
        if (state.chartOpen) loadTVChart(state.symbol, state.timeframe);
      }
    }
    if (msg.mode) state.tradeMode = String(msg.mode).toUpperCase();
    if (Number.isFinite(Number(msg.price))) state.price = Number(msg.price);
    if (msg.activeSymbol) {
      var as = msg.activeSymbol;
      if (canUpdateSymbol && as.symbol) state.symbol = String(as.symbol).toUpperCase();
      // TV est maître pour le TF sur les events active-symbol (pas les ticks prix)
      // isTickOnly déjà défini plus haut — ici on autorise TV à mettre à jour le TF
      if (!isTickOnly && as.timeframe && TFS.indexOf(String(as.timeframe).toUpperCase()) >= 0) {
        var asTf = String(as.timeframe).toUpperCase();
        if (asTf !== state.timeframe) {
          state.timeframe = asTf;
          var _ts3 = $('tfSelect');
          if (_ts3 && Array.from(_ts3.options).some(function(o){ return o.value === asTf; })) _ts3.value = asTf;
          if (state.chartOpen) loadTVChart(state.symbol, state.timeframe);
        }
      }
      if (as.mode) state.tradeMode = String(as.mode).toUpperCase();
      if (Number.isFinite(Number(as.price))) state.price = Number(as.price);
    }
    if (msg.bridgeConfig) applyBridgeConfig(msg.bridgeConfig);
    var ss = $('symbolSelect');
    if (ss && Array.from(ss.options).some(function(o) { return o.value === state.symbol; })) ss.value = state.symbol;
    var ts = $('tfSelect');    if (ts) ts.value = state.timeframe;
    var ms = $('modeSelect');
    if (ms && Array.from(ms.options).some(function(o) { return o.value === state.tradeMode; })) ms.value = state.tradeMode;
    updateHeader();
    scheduleSaveState();
    // Sync TradingView chart iframe avec nouveau symbole/TF — seulement si chart ouvert
    if (state.chartOpen) loadTVChart(state.symbol, state.timeframe);
  } else if (msg.type === 'tv-data' || msg.type === 'tradingview-data') {
    // Price-only tick from TV webhook — only apply if symbol matches current state
    var tickSym = String(msg.symbol || '').toUpperCase();
    var activeSrc = 'tradingview';
    var symbolMatches = !tickSym || tickSym === state.symbol;
    // Détection changement symbole sur tick price — si active-symbol n'est pas encore arrivé,
    // mettre à jour le symbole immédiatement pour éviter une désynchronisation
    var _hasActivePos = state.tradeState && state.tradeState.entered;
    if (tickSym && tickSym !== state.symbol && msg.type === 'tradingview-data' && !state.userLocked && !_hasActivePos) {
      state.symbol = tickSym;
      var _ssTick = $('symbolSelect');
      if (_ssTick && Array.from(_ssTick.options).some(function(o) { return o.value === tickSym; })) _ssTick.value = tickSym;
      updateHeader();
      scheduleSaveState();
      if (state.agentSessionActive) {
        // Vider les cartes immédiatement — évite d'afficher les valeurs de l'ancien symbole
        MTFS.forEach(function(tf) {
          var _sig = $(('tfc-' + tf + '-t').replace(/\s/g,''));
          var _sub = $(('tfc-' + tf + '-s').replace(/\s/g,''));
          var _crd = $('tfc-' + tf);
          if (_sig) { _sig.textContent = '...'; _sig.className = 'tfc-sig wait'; }
          if (_sub) _sub.textContent = 'Chargement...';
          if (_crd) { _crd.style.background = ''; _crd.style.borderColor = ''; }
        });
        renderMultiTF().catch(function(){});
        disconnectCoachStream();
        connectCoachStream(tickSym);
      }
      symbolMatches = true; // traiter ce tick comme valide pour le nouveau symbole
    }
    if (symbolMatches) {
      var _newPx = Number.isFinite(Number(msg.price)) ? Number(msg.price)
                  : Number.isFinite(Number(msg.bid)) ? Number(msg.bid) : null;
      var _tickSym2 = String(state.symbol || '').toUpperCase();
      var _isGold   = /XAU|GOLD/.test(_tickSym2);
      if (_newPx !== null) {
        state._lastPriceTick = Date.now();
        state.price = _newPx;
        updateHeader();
        // Historique des 10 derniers prix — utilisé par analyzeMarketContext (compression/impulsion)
        if (!state._priceHistory) state._priceHistory = [];
        state._priceHistory.push(_newPx);
        if (state._priceHistory.length > 10) state._priceHistory.shift();
        // SOURCE UNIQUE: synchroniser l'état de position depuis le serveur (inclus dans le tick)
        // Le popup ne recalcule plus — il affiche ce que le serveur dit
        if (msg.tradeState) {
          var _srvTs = msg.tradeState;
          // Guard post-entrée: ne pas écraser dans les 5s après _executeAutoEntry (VP en transit)
          var _tickEntryAge = state._entryJustFired ? (Date.now() - state._entryJustFired) : Infinity;
          var _tickSkip = _tickEntryAge < 5000;
          if (!_tickSkip) {
            if (_srvTs.entered || !state.tradeState || !state.tradeState.entered) {
              var _prevTickVP = state.tradeState && state.tradeState.virtualPosition ? state.tradeState.virtualPosition : null;
              state.tradeState = _srvTs;
              // Préserver VP locale si le tick n'en apporte pas (transitoire)
              if (_prevTickVP && (!state.tradeState.virtualPosition || !Number(state.tradeState.virtualPosition.sl))) {
                state.tradeState.virtualPosition = _prevTickVP;
              }
            }
          }
        }
        // Mise à jour marché fermé/ouvert
        if (msg.marketStatus) {
          state._lastMarketStatus = msg.marketStatus;
        }
        // ── MISE À JOUR POSITION — throttlée pour éviter le flickering ──────
        // renderPositionPanel (canvas + DOM complet) : max 1x/s
        // P&L texte seul : chaque tick (instantané)
        if (state.tradeState && state.tradeState.entered && state.tradeState.virtualPosition) {
          var _vpTick = state.tradeState.virtualPosition;
          // P&L texte uniquement — instantané, pas de canvas
          var _isLongTick = String(_vpTick.direction || '').toUpperCase() === 'LONG';
          var _pnlTickRaw = (_isLongTick ? _newPx - Number(_vpTick.entry) : Number(_vpTick.entry) - _newPx);
          var _pnlTickPips = Math.round(_pnlTickRaw * (_isGold ? 10 : 1) * 10) / 10;
          var _pnlEl2 = document.getElementById('posPnl');
          if (_pnlEl2) {
            _pnlEl2.textContent = (_pnlTickPips >= 0 ? '+' : '') + _pnlTickPips + (_isGold ? ' pts' : ' pips');
            _pnlEl2.style.color = _pnlTickPips > 0 ? '#22c55e' : _pnlTickPips < 0 ? '#ef4444' : '#f97316';
          }
          // renderPositionPanel complet : 1x/sec max (anti-flickering)
          var _renderNow = Date.now();
          if (_renderNow - (state._lastPosRenderAt || 0) > 900) {
            state._lastPosRenderAt = _renderNow;
            renderPositionPanel(state.live, _newPx);
          }
          if (state.chartOpen && typeof ChartModule !== 'undefined' && ChartModule && ChartModule.loadChart) {
            var _ts2 = state.tradeState;
            var _vp2 = _ts2.virtualPosition;
            var _lvl2 = (_vp2 && _vp2.entry) ? { entry: _vp2.entry, sl: _vp2.sl, tp: _vp2.tp } : null;
            ChartModule.loadChart(state.symbol, state.timeframe, _lvl2, _newPx);
          }
        }
        // ── MISE À JOUR TEMPS RÉEL DES CARTES TF DEPUIS BRIDGE ───────────────
        // Chaque tick bridge contient lectureTech1-4 + rsiTf1-4 + scoreTech1-4
        // → mise à jour instantanée de chaque carte TF (direction + RSI + zone M1)
        // Fonctionne pendant ET hors position — sans appel API
        if (msg.bridgeData) {
          renderTFCardsFromBridge(msg.bridgeData, _newPx);
        }
      }
      // NE PAS modifier state.timeframe depuis les ticks SSE
    }
    // Bot-alive visual: show live data arriving
    showLiveFlux(msg);
    checkEntryProximityAndBeep(state.live || {});
  } else if (msg.type === 'price-update') {
    var tickSym = String(msg.symbol || '').toUpperCase();
    var symbolMatch = !tickSym || tickSym === (state.symbol || '').toUpperCase();
    if (symbolMatch) {
      var newPrice = Number(msg.price);
      if (Number.isFinite(newPrice) && newPrice > 1) { // guard > 1 pour éviter prix "1" du titre
        state.price = newPrice;
      }
      var newTf = String(msg.timeframe || '').toUpperCase();
      if (newTf && TFS.indexOf(newTf) >= 0) {
        state.timeframe = newTf;
        var tfSel = document.getElementById('tfSelect');
        if (tfSel) tfSel.value = state.timeframe;
      }
      if (tickSym && tickSym !== (state.symbol || '').toUpperCase() && !state.userLocked) {
        state.symbol = tickSym;
      }
      updateHeader();
    }
    if (typeof showLiveFlux === 'function') showLiveFlux(msg);
  }
}

function showLiveFlux(msg) {
  var sym   = msg.symbol || state.symbol;
  var px    = msg.price || msg.bid || null;
  var rsiRaw = msg.indicators && msg.indicators.rsi;
  var _rsiRawV = Number(rsiRaw);
  var _rsiMom = (Number.isFinite(_rsiRawV) && _rsiRawV > 0) ? (_rsiRawV > 70 ? ' ↑excès' : _rsiRawV < 30 ? ' ↓survente' : _rsiRawV >= 55 ? ' ↑' : _rsiRawV <= 45 ? ' ↓' : '') : '';
  var pxStr = px ? ' @ ' + fmtPrice(px) : '';
  var src   = 'TV';
  markConnectionOk(src + ' LIVE \u26a1');
  // Update webhook badge with last received symbol
  var wb = $('webhookBadge');
  if (wb) { wb.textContent = sym + pxStr + _rsiMom; wb.className = 'bdg ok'; }
  flowLog('SSE DATA RECEIVED', {
    type: msg.type || null,
    symbol: sym,
    timeframe: msg.timeframe || null,
    price: px || null,
    source: src
  });

  // Keep coach/decision truly live without flooding API.
  var now = Date.now();
  if (state.bridgeConfig.bridgeEnabled !== false && state.agentSessionActive && (now - state.lastLiveCoachRefreshAt) >= 1500) {
    state.lastLiveCoachRefreshAt = now;
    loadRealtimePack().catch(function() {});
  }
}

function connectSSE() {
  if (state.sse) { try { state.sse.close(); } catch (_) {} state.sse = null; }
  var es = new EventSource(API + '/extension/sync');
  state.sse = es;
  es.onopen = function() { markConnectionOk('ONLINE'); };
  es.onmessage = function(ev) {
    try {
      var msg = JSON.parse(ev.data || '{}');
      if (msg.type && msg.type !== 'heartbeat') state._lastSseAt = Date.now(); // tracker fraîcheur SSE
      var _prevSymBeforeSync = state.symbol;
      handleSync(msg);
      // Full refresh uniquement sur changements structurels (symbole/config)
      // trade-action → mise à jour légère du panel position seulement (évite flickering)
      if (msg.type === 'trade-action') {
        renderPositionPanel(state.live, state.price);
        return;
      }
      var needsRefresh = ['initial-sync', 'active-symbol', 'bridge-config'];
      if (needsRefresh.indexOf(msg.type) >= 0) {
        refreshAll();
        // Multi-TF: refresh sur initial-sync ET sur active-symbol si symbole a changé
        var _symChanged = state.symbol !== _prevSymBeforeSync;
        if (_symChanged && state.agentSessionActive) {
          // Vider immédiatement les cartes pour éviter d'afficher les valeurs du symbole précédent
          MTFS.forEach(function(tf) {
            var _sig = $(('tfc-' + tf + '-t').replace(/\s/g,''));
            var _sub = $(('tfc-' + tf + '-s').replace(/\s/g,''));
            var _crd = $('tfc-' + tf);
            if (_sig) { _sig.textContent = '...'; _sig.className = 'tfc-sig wait'; }
            if (_sub) _sub.textContent = 'Chargement...';
            if (_crd) { _crd.style.background = ''; _crd.style.borderColor = ''; }
          });
        }
        if (state.agentSessionActive && (msg.type === 'initial-sync' || _symChanged)) {
          renderMultiTF().catch(function(){});
        }
        // Coach stream: reconnecter au nouveau symbole si changement de symbole
        if (_symChanged && state.agentSessionActive) {
          disconnectCoachStream();
          connectCoachStream(state.symbol);
        }
      }
    } catch (_) {}
  };
  es.onerror = function() {
    if (state.sse !== es) return; // déjà remplacé par une nouvelle connexion — ignorer
    state.sse = null; // marquer comme mort AVANT de fermer pour éviter double onerror
    state.conn.sseFails = Number(state.conn.sseFails || 0) + 1;
    markConnectionTransientFail();
    try { es.close(); } catch (_) {}
    setTimeout(function() {
      connectSSE();
      // Après reconnexion: refresh immédiat depuis API pour récupérer l'état serveur actuel
      // (pas d'initial-sync automatique après reconnexion SSE)
      setTimeout(function() { if (state.agentSessionActive) refreshAll().catch(function(){}); }, 800);
    }, 3000);
  };
}

// ─── PERSISTENT WINDOW ───────────────────────────────────────────────────────
function openWindow() {
  try {
    var url = chrome.runtime.getURL('popup.html?persistent=1');
    chrome.windows.create({ url: url, type: 'popup', width: 460, height: 820, focused: true });
    window.close();
  } catch (_) {
    window.open(window.location.href + '?persistent=1', '_blank', 'width=460,height=820');
  }
}

// ─── PROPOSITION SETUP — SUPPRIMÉE (ANALYSER → ARMER → exécution auto) ──────
// Scénario: ANALYSER = lecture | ARMER = autorisation permanente | setup = exécution auto
// Plus de validation manuelle intermédiaire. L'utilisateur coupe s'il ne veut pas la position.
var _propLastSpeakAt = 0;
function _showSetupProposal() { /* supprimé — ANALYSER → ARMER → auto */ }

function _hideSetupProposal() {
  var _propEl = document.getElementById('setupProposalBanner');
  if (_propEl) _propEl.style.display = 'none';
  state._currentProposalKey = null;
}

// ─── AUTO-VÉRIFICATION TF QUAND RETOURNEMENT EN ZONE ─────────────────────────
// Quand la zone de retournement est atteinte, LIA fetch M15+H1 lui-même
// et décide si les conditions sont réunies pour armer+entrer.
// L'utilisateur ne doit PAS avoir à vérifier manuellement.
var _rvAlignCheckAt = 0;

async function checkRvTFAlignmentAndArm(rvDir, rvEntry, rvSl, rvTp, fmtFn, rvRrServer) {
  // Throttle: 1 vérification toutes les 20s max — évite les flood API
  var _now = Date.now();
  if (_now - _rvAlignCheckAt < 20000) return;
  _rvAlignCheckAt = _now;

  // Garde: ne pas vérifier si position déjà ouverte
  if (state.tradeState && state.tradeState.entered) return;
  // Auto-activer la session si EN ZONE même sans ANALYSER — LIA doit pouvoir agir
  if (!state.agentSessionActive) {
    state.agentSessionActive = true;
    connectCoachStream(state.symbol);
    scheduleSaveState();
  }

  var _rvEl = document.getElementById('reversalBanner');
  var _sym  = state.symbol;
  var _mode = state.tradeMode;
  var _isShort = rvDir === 'SHORT';
  var _expected = _isShort ? 'SHORT' : 'LONG';

  // ── ÉTAPE 1: Animer les cartes M1+M5+M15+H1 — CAS 1 + timing M1 ──
  // M1=impulsion/trigger | M5=timing | M15=setup | H1=contexte direction
  var _checkTFs = ['M1', 'M5', 'M15', 'H1'];
  _checkTFs.forEach(function(tf) {
    var _c = $('tfc-' + tf); var _s = $('tfc-' + tf + '-t'); var _sub = $('tfc-' + tf + '-s');
    if (_c) _c.classList.add('scanning');
    if (_s) { _s.textContent = '🔍'; _s.className = 'tfc-sig scanning'; }
    if (_sub) _sub.textContent = 'LIA vérifie...';
  });

  // ── ÉTAPE 2: Afficher "vérification en cours" dans le banner ──
  var _sl4 = _rvEl ? _rvEl.querySelector('.rv-line4') : null;
  if (_sl4) { _sl4.textContent = '🔍 LIA vérifie M1+M5+M15+H1...'; _sl4.style.color = '#94a3b8'; }

  var _sl0 = _rvEl ? _rvEl.querySelector('.rv-px-status') : null;

  var _m1Dir = 'NEUTRE', _m1Str = 0;
  var _m5Dir = 'NEUTRE', _m5Str = 0;
  var _m15Dir = 'NEUTRE', _m15Str = 0;
  var _h1Dir = 'NEUTRE', _h1Str = 0;
  try {
    // Fetch M1 + M5 + M15 + H1 en parallèle
    // M1=impulsion (trigger exact) | M5=timing (confirmation) | M15=setup | H1=direction macro
    var _results = await Promise.all([
      fetchJson('/coach/realtime?symbol=' + encodeURIComponent(_sym) + '&tf=M1&mode='  + encodeURIComponent(_mode) + '&lang=fr'),
      fetchJson('/coach/realtime?symbol=' + encodeURIComponent(_sym) + '&tf=M5&mode='  + encodeURIComponent(_mode) + '&lang=fr'),
      fetchJson('/coach/realtime?symbol=' + encodeURIComponent(_sym) + '&tf=M15&mode=' + encodeURIComponent(_mode) + '&lang=fr'),
      fetchJson('/coach/realtime?symbol=' + encodeURIComponent(_sym) + '&tf=H1&mode='  + encodeURIComponent(_mode) + '&lang=fr')
    ]);
    var _getDir = function(r) {
      var ag = getAgents(r); var an = ag.analysis || {};
      var it = r.instantTrade || null;
      var rec = String(an.recommendation || (it && it.direction) || '').toUpperCase();
      return rec.includes('BUY') || rec.includes('LONG') ? 'LONG'
           : rec.includes('SELL') || rec.includes('SHORT') ? 'SHORT' : 'NEUTRE';
    };
    var _getStr = function(r) {
      var ag = getAgents(r); var an = ag.analysis || {};
      return Number(an.strength || an.confidence || 0);
    };
    _m1Dir  = _getDir(_results[0]); _m1Str  = _getStr(_results[0]);
    _m5Dir  = _getDir(_results[1]); _m5Str  = _getStr(_results[1]);
    _m15Dir = _getDir(_results[2]); _m15Str = _getStr(_results[2]);
    _h1Dir  = _getDir(_results[3]); _h1Str  = _getStr(_results[3]);
    // Correction forces: /coach/realtime retourne souvent la même force globale pour tous les TFs
    // On préfère scoreTech1/2/3/4 du bridge live — données réellement individualisées par TF
    var _bd4rv = state._lastBridgeData;
    if (_bd4rv) {
      if (Number(_bd4rv.scoreTech1) > 0) _m1Str  = Number(_bd4rv.scoreTech1);
      if (Number(_bd4rv.scoreTech2) > 0) _m5Str  = Number(_bd4rv.scoreTech2);
      if (Number(_bd4rv.scoreTech3) > 0) _m15Str = Number(_bd4rv.scoreTech3);
      if (Number(_bd4rv.scoreTech4) > 0) _h1Str  = Number(_bd4rv.scoreTech4);
    }
  } catch (_) {
    _checkTFs.forEach(function(tf) {
      var _c = $('tfc-' + tf); if (_c) _c.classList.remove('scanning');
    });
    if (_sl4) { _sl4.textContent = '⚠️ Erreur vérification — réessai au prochain tick'; _sl4.style.color = '#f97316'; }
    return;
  }

  var _m1Ok  = _m1Dir  === _expected;
  var _m5Ok  = _m5Dir  === _expected;
  var _m15Ok = _m15Dir === _expected;
  var _h1Ok  = _h1Dir  === _expected;

  // M1 contredit explicitement → BLOCAGE (signal d'alerte structure inversée sur trigger TF)
  var _m1Conflict = _m1Dir !== 'NEUTRE' && _m1Dir !== _expected;

  // CAS 1 PRO COMPLET: M1 (trigger) + M5 (timing) + M15 (setup) + H1 (direction) — les 4 requis
  // M1 neutre accepté si M5+M15+H1 valident tous (M1 en attente = OK)
  // M1 contredisant = BLOCAGE absolu
  var _allOk = _m5Ok && _m15Ok && _h1Ok && (_m1Ok || _m1Dir === 'NEUTRE') && !_m1Conflict;
  var _threeOk = (_m5Ok && _m15Ok && _h1Ok) && !_m1Conflict; // 3 grands TF ok, M1 pas encore
  var _twoOk  = ((_m5Ok && _m15Ok) || (_m5Ok && _h1Ok) || (_m15Ok && _h1Ok)) && !_m1Conflict;
  var _oneOk  = (_m1Ok || _m5Ok || _m15Ok || _h1Ok) && !_m1Conflict;

  var _strFmt = function(d, str) {
    var arrow = d === 'LONG' ? '▲' : d === 'SHORT' ? '▼' : '—';
    var label = d === 'LONG' ? 'L' : d === 'SHORT' ? 'S' : 'N';
    return arrow + label + (str > 0 ? str + '%' : '');
  };
  var _m1Fmt  = _strFmt(_m1Dir, _m1Str);
  var _m5Fmt  = _strFmt(_m5Dir, _m5Str);
  var _m15Fmt = _strFmt(_m15Dir, _m15Str);
  var _h1Fmt  = _strFmt(_h1Dir, _h1Str);

  // ── ÉTAPE 3: Mettre à jour toutes les cartes avec résultats ──
  var _dirMap = { M1: _m1Dir, M5: _m5Dir, M15: _m15Dir, H1: _h1Dir };
  var _okMap  = { M1: _m1Ok,  M5: _m5Ok,  M15: _m15Ok,  H1: _h1Ok  };
  var _strMap = { M1: _m1Str, M5: _m5Str, M15: _m15Str, H1: _h1Str };
  _checkTFs.forEach(function(tf) {
    var _dirNow = _dirMap[tf]; var _okNow = _okMap[tf]; var _strNow = _strMap[tf];
    var _c = $('tfc-' + tf); var _s = $('tfc-' + tf + '-t'); var _sub = $('tfc-' + tf + '-s');
    if (_c) {
      _c.classList.remove('scanning');
      // M1 contredisant → rouge vif même si les autres sont OK
      var _borderCol = (_dirMap['M1'] !== 'NEUTRE' && _m1Conflict && tf === 'M1')
        ? 'rgba(239,68,68,1.0)'  // conflit M1 = rouge vif
        : _okNow ? (_isShort ? 'rgba(239,68,68,0.8)' : 'rgba(34,197,94,0.8)')
        : 'rgba(100,116,139,0.4)';
      _c.style.borderColor = _borderCol;
    }
    if (_s) {
      _s.textContent = _dirNow === 'LONG' ? '▲ LONG' : _dirNow === 'SHORT' ? '▼ SHORT' : 'NEUTRE';
      _s.className = 'tfc-sig ' + (_dirNow === 'LONG' ? 'buy' : _dirNow === 'SHORT' ? 'sell' : 'neutre');
    }
    if (_sub) {
      var _subTxt = _okNow ? '✅ ' : (_m1Conflict && tf === 'M1' ? '🚫 CONFLIT' : '❌ ');
      _subTxt += _strNow > 0 ? _strNow + '%' : (_dirNow !== 'NEUTRE' ? _dirNow : 'neutre');
      _sub.textContent = _subTxt;
    }
  });

  // ── R:R — calcul directionnel cohérent ───────────────────────────────────
  // Priorité: RR serveur (rvRrServer) — source unique de vérité (il connaît le vrai contexte)
  // Fallback: calcul local directionnel depuis niveaux corrigés
  var _rvRisk   = rvEntry > 0 && rvSl > 0 ? Math.abs(rvEntry - rvSl) : 0;
  // Reward directionnel: SHORT→ entry-tp, LONG→ tp-entry (évite valeur négative si niveaux corrects)
  var _rvReward = 0;
  if (rvEntry > 0 && rvTp > 0) {
    var _rvRewardRaw = _isShort ? (rvEntry - rvTp) : (rvTp - rvEntry);
    _rvReward = _rvRewardRaw > 0 ? _rvRewardRaw : Math.abs(rvTp - rvEntry); // fallback abs si encore inversé
  }
  var _rvRRCalcLocal = (_rvRisk > 0 && _rvReward > 0) ? _rvReward / _rvRisk : 0;
  // Utiliser RR serveur si fourni et cohérent, sinon calcul local
  var _rvRRCalc = (rvRrServer && rvRrServer > 0) ? Number(rvRrServer) : _rvRRCalcLocal;
  var _rvRRStr  = _rvRRCalc > 0 ? _rvRRCalc.toFixed(2) : '—';
  var _rrBad    = _rvRRCalc > 0 && _rvRRCalc < 1.0; // R:R < 1:1 = setup non rentable, bloquer

  // ── ÉTAPE 4: Ligne banner avec résumé force de chaque TF ──
  var _tfLine = 'M1 ' + _m1Fmt + '  M5 ' + _m5Fmt + '  M15 ' + _m15Fmt + '  H1 ' + _h1Fmt;
  if (_sl4) {
    if (_m1Conflict) {
      _sl4.textContent = '🚫 M1 CONTREDIT — ' + _tfLine + ' — ENTRÉE BLOQUÉE';
      _sl4.style.color = '#ef4444'; _sl4.style.fontWeight = '900';
    } else if (_allOk && _rrBad) {
      // TF alignés MAIS R:R insuffisant → bloquer et expliquer clairement
      _sl4.textContent = '⛔ ' + _tfLine + ' — R:R 1:' + _rvRRStr + ' INSUFFISANT — setup rejeté';
      _sl4.style.color = '#ef4444'; _sl4.style.fontWeight = '900';
    } else if (_allOk) {
      _sl4.textContent = '✅ ' + _tfLine + ' — VALIDÉ — ROBOT ENTRE';
      _sl4.style.color = _isShort ? '#ef4444' : '#22c55e'; _sl4.style.fontWeight = '900';
    } else if (_threeOk) {
      _sl4.textContent = '🟡 3/4 TF OK — ' + _tfLine + ' — J\'attends M1 (' + _expected + ')';
      _sl4.style.color = '#fbbf24'; _sl4.style.fontWeight = '700';
    } else if (_twoOk) {
      _sl4.textContent = '🟠 2/4 TF — ' + _tfLine + ' — Pas prêt';
      _sl4.style.color = '#f97316'; _sl4.style.fontWeight = '700';
    } else {
      _sl4.textContent = '❌ ' + _tfLine + ' — Structure pas retournée';
      _sl4.style.color = '#64748b'; _sl4.style.fontWeight = '700';
    }
  }

  // Persister le résultat
  state._rvLastResult = _m1Conflict
    ? { text: '🚫 M1 CONTREDIT — ENTRÉE BLOQUÉE | ' + _tfLine, color: '#ef4444' }
    : (_allOk && _rrBad)
    ? { text: '⛔ R:R 1:' + _rvRRStr + ' insuffisant — TF alignés mais setup rejeté | ' + _tfLine, color: '#ef4444' }
    : _allOk
    ? { text: '✅ ' + _tfLine + ' — VALIDÉ — ROBOT ENTRE', color: _isShort ? '#ef4444' : '#22c55e' }
    : _threeOk
    ? { text: '🟡 M5+M15+H1 OK — J\'attends M1 impulsion | ' + _tfLine, color: '#fbbf24' }
    : { text: '❌ Structure incomplète — ' + _tfLine, color: '#64748b' };

  // ── ÉTAPE 5: Voix + action ──
  if (_m1Conflict) {
    speak('Attention. M1 ' + _m1Dir + ' contredit la direction ' + _expected + '. Entrée bloquée. Je revérifie dans 20 secondes.');
    setCoachText(
      '🚫 CONFLIT M1 — ENTRÉE BLOQUÉE\n' + _tfLine +
      '\nM1 va à contre-sens — attendre que M1 confirme la direction ' + _expected + '.',
      '#ef4444', 8, 20000
    );
  } else if (_allOk && _rrBad) {
    // TF alignés mais R:R trop faible → annoncer le blocage clairement
    speak('Attention. Les 4 unités de temps sont alignées ' + (_isShort ? 'SHORT' : 'LONG') + ', mais le rapport risque-récompense est insuffisant: 1 pour ' + _rvRRStr + '. Minimum requis 1 pour 1. Je n\'entre pas. J\'attends un meilleur placement de stop ou d\'objectif.');
    setCoachText(
      '⛔ R:R INSUFFISANT — 1:' + _rvRRStr + '\n' + _tfLine +
      '\nTF alignés (' + _expected + ') mais setup rejeté — TP trop proche du SL.' +
      '\nMinimum requis: 1:1 (récompense ≥ risque).',
      '#ef4444', 8, 20000
    );
  } else if (_allOk) {
    var _m1Qual = _m1Dir === _expected ? 'M1 confirme l\'impulsion.' : 'M1 neutre — structure solide sur M5, M15, H1.';
    // Annonce vocale enrichie — détaille chaque TF + zone + contexte bridge
    var _bdRv = state._lastBridgeData || null;
    var _rsiM1rnd  = _bdRv && _bdRv.rsiTf1 > 0  ? Math.round(_bdRv.rsiTf1)  : (_m1Str > 0  ? Math.round(_m1Str)  : 0);
    var _rsiM5rnd  = _bdRv && _bdRv.rsiTf2 > 0  ? Math.round(_bdRv.rsiTf2)  : (_m5Str > 0  ? Math.round(_m5Str)  : 0);
    var _rsiM15rnd = _bdRv && _bdRv.rsiTf3 > 0  ? Math.round(_bdRv.rsiTf3)  : (_m15Str > 0 ? Math.round(_m15Str) : 0);
    var _rsiH1rnd  = _bdRv && _bdRv.rsiTf4 > 0  ? Math.round(_bdRv.rsiTf4)  : (_h1Str > 0  ? Math.round(_h1Str)  : 0);
    var _pxRv = state.price > 0 ? (state.price > 100 ? state.price.toFixed(2) : state.price.toFixed(5)) : '';
    var _inTopRv = _bdRv && _bdRv.inTop, _inBotRv = _bdRv && _bdRv.inBot;
    var _zoneVoix = _inTopRv ? 'Prix en zone haute — zone de retournement SHORT.' : _inBotRv ? 'Prix en zone basse — zone de retournement LONG.' : '';
    var _spkRv = (_pxRv ? 'Prix ' + _pxRv + '. ' : '') + _zoneVoix + ' ';
    _spkRv += 'M1 ' + (_m1Dir === _expected ? 'confirme l\'impulsion' : 'neutre, structure suffisante') + '. ';
    _spkRv += 'M5 ' + (_m5Dir === 'SHORT' ? 'baissier' : 'haussier') + (_rsiM5rnd > 0 ? ', RSI ' + _rsiM5rnd : '') + '. ';
    _spkRv += 'M15 ' + (_m15Dir === 'SHORT' ? 'baissier' : 'haussier') + (_rsiM15rnd > 0 ? ', RSI ' + _rsiM15rnd : '') + '. ';
    _spkRv += 'H1 ' + (_h1Dir === 'SHORT' ? 'baissier' : 'haussier') + (_rsiH1rnd > 0 ? ', RSI ' + _rsiH1rnd : '') + '. ';
    _spkRv += 'Point de retournement validé. Le robot arme l\'entrée maintenant.';
    speak(_spkRv);
    setCoachText(
      '✅ RETOURNEMENT VALIDÉ — M1+M5+M15+H1 ' + (_isShort ? '▼ SHORT' : '▲ LONG') +
      '\n' + _tfLine +
      '\nZone: ' + fmtFn(rvEntry) + '  SL: ' + fmtFn(rvSl) + '  TP: ' + fmtFn(rvTp) +
      '\nRobot armé — entrée automatique en cours.',
      _isShort ? COL_SHORT : COL_LONG, 9, 30000
    );
    // Sauvegarder les niveaux validés — SL ×1.5 pour absorber mèches de zone
    var _rvEntryN = Number(rvEntry) || 0;
    var _rvSlN    = Number(rvSl)    || 0;
    var _rvTpN    = Number(rvTp)    || 0;
    var _slDist   = _rvEntryN > 0 && _rvSlN > 0 ? Math.abs(_rvSlN - _rvEntryN) : 0;
    var _tpDistN  = _rvEntryN > 0 && _rvTpN > 0  ? Math.abs(_rvTpN - _rvEntryN)  : 0;
    var _adjustedSl = _rvSlN;
    if (_slDist > 0) {
      var _minDist = _slDist * 1.5;
      _adjustedSl = _isShort ? (_rvEntryN + _minDist) : (_rvEntryN - _minDist);
    }

    // ── DÉTECTION TYPE DE TRADE — force du marché + distance TP ──────────────
    // SCALPING  : TP < 8pts  | H1 neutre | M1 fort  → entrée rapide/sortie rapide
    // SNIPER    : TP 8-25pts | M15 setup confirmé   → précision chirurgicale
    // SWING     : TP > 25pts | H1 directionnel fort → laisser courir
    var _tradeType = 'SNIPER'; // défaut: précision sur zone
    var _h1Strong  = _h1Str >= 60;
    var _m15Strong = _m15Str >= 55;
    var _m1Strong  = _m1Str >= 50 && _m1Dir === _expected;
    if (_tpDistN > 25 && _h1Strong) {
      _tradeType = 'SWING';
    } else if (_tpDistN < 8 || (_m1Strong && !_h1Strong)) {
      _tradeType = 'SCALPING';
    } else {
      _tradeType = 'SNIPER';
    }

    // Force globale: moyenne pondérée H1(40%) + M15(30%) + M5(20%) + M1(10%)
    var _globalForce = Math.round(
      (_h1Str * 0.40) + (_m15Str * 0.30) + (_m5Str * 0.20) + (_m1Str * 0.10)
    );
    var _forceLabel = _globalForce >= 75 ? '🔥 TRÈS FORTE'
                    : _globalForce >= 55 ? '✅ FORTE'
                    : _globalForce >= 35 ? '🟡 MODÉRÉE'
                    : '⚠️ FAIBLE';
    var _typeLabel  = _tradeType === 'SWING' ? '🌊 SWING — laisser courir'
                    : _tradeType === 'SNIPER' ? '🎯 SNIPER — précision zone'
                    : '⚡ SCALPING — sortie rapide';

    // Annoncer le type + force + trailing TP si swing/sniper
    var _trailAnnonce = _tradeType !== 'SCALPING'
      ? 'TP déplacé automatiquement si momentum reste intact.'
      : 'Sortie rapide recommandée — pas de trailing sur scalp.';
    speak('Type de trade: ' + _tradeType.toLowerCase() + '. Force globale ' + _globalForce + ' pourcent. ' + _trailAnnonce);

    state._rvValidatedLevels = {
      entry:      _rvEntryN,
      sl:         _adjustedSl || _rvSlN,
      tp:         _rvTpN,
      direction:  _isShort ? 'SELL' : 'BUY',
      tradeType:  _tradeType,
      globalForce: _globalForce,
      tpTrailEnabled: _tradeType !== 'SCALPING' // scalping = pas de trailing
    };

    // Mettre à jour le coach text avec le type + force
    setCoachText(
      '✅ RETOURNEMENT VALIDÉ — M1+M5+M15+H1 ' + (_isShort ? '▼ SHORT' : '▲ LONG') +
      '\n' + _tfLine +
      '\n' + _typeLabel + '  |  Force: ' + _forceLabel + ' (' + _globalForce + '%)' +
      '\nZone: ' + fmtFn(rvEntry) + '  SL: ' + fmtFn(_adjustedSl || _rvSlN) + '  TP: ' + fmtFn(rvTp) +
      '\n' + _trailAnnonce,
      _isShort ? COL_SHORT : COL_LONG, 9, 30000
    );

    // RÈGLE PRO: l'agent NE S'ARME JAMAIS seul — uniquement quand l'utilisateur appuie ENTRER.
    // Ici on annonce seulement que les conditions sont réunies. L'utilisateur décide.
    // (l'auto-armement ici contournait la décision humaine et causait des entrées non voulues)
  } else if (_threeOk) {
    // Enrichi: dire quel TF manque + RSI M1 pour anticiper le timing
    var _bd3 = state._lastBridgeData || null;
    var _rsiM1_3 = _bd3 && _bd3.rsiTf1 > 0 ? Math.round(_bd3.rsiTf1) : 0;
    var _m1RsiStr3 = _rsiM1_3 > 70 ? ' Momentum M1 en excès — il peut ralentir.' : _rsiM1_3 > 0 && _rsiM1_3 < 30 ? ' Momentum M1 en survente — rebond possible.' : _rsiM1_3 >= 55 ? ' M1 monte — attends l\'impulsion.' : _rsiM1_3 > 0 && _rsiM1_3 <= 45 ? ' M1 descend — attends l\'impulsion.' : '';
    var _pxStr3 = state.price > 0 ? ' Prix: ' + (state.price > 100 ? state.price.toFixed(2) : state.price.toFixed(5)) + '.' : '';
    var _inTopStr3 = _bd3 && _bd3.inTop ? ' Prix en zone haute.' : _bd3 && _bd3.inBot ? ' Prix en zone basse.' : '';
    speak('M5, M15 et H1 confirment le retournement ' + _expected.toLowerCase() + '.' + _pxStr3 + _inTopStr3 + _m1RsiStr3 + ' J\'attends que M1 montre l\'impulsion — point de retournement pas encore déclenché sur M1. Je revérifie dans 20 secondes.');
    setCoachText(
      '🟡 3/4 TF CONFIRMÉS — J\'ATTENDS M1\n' + _tfLine +
      '\nM5+M15+H1 alignés ' + _expected + '. M1 pas encore impulsé.' +
      (_rsiM1_3 > 0 ? '\n' + (_rsiM1_3 > 70 ? 'M1 en excès — attendre un retrait.' : _rsiM1_3 < 30 ? 'M1 en survente — attendre un rebond.' : 'M1 neutre — attendre la pression directionnelle.') : '') +
      '\nEntrée dès que M1 confirme la direction sur le point de retournement.',
      '#d97706', 7, 20000
    );
  } else if (_twoOk) {
    var _pxStr2 = state.price > 0 ? 'Prix: ' + (state.price > 100 ? state.price.toFixed(2) : state.price.toFixed(5)) + '. ' : '';
    speak(_pxStr2 + 'Deux TF sur quatre seulement. Le point de retournement n\'est pas encore confirmé. J\'attends que la structure s\'aligne. Je patiente.');
    setCoachText(
      '🟠 2/4 TF — STRUCTURE INCOMPLÈTE\n' + _tfLine +
      '\nBesoin: M1+M5+M15+H1 tous ' + _expected + '.\nPas d\'entrée — attendre confirmation du point de retournement.',
      '#f97316', 6, 20000
    );
  } else {
    speak('Aucun TF ne confirme le retournement pour l\'instant. Je continue à surveiller le point de retournement.');
    setCoachText(
      '❌ STRUCTURE PAS CONFIRMÉE\n' + _tfLine +
      '\nM1+M5+M15+H1 requis pour valider le point de retournement.\nEntrée bloquée — je revérifie automatiquement.',
      '#64748b', 6, 20000
    );
  }
}

// ─── ANALYSER BUTTON STATES ────────────────────────────────────────────────────
function setAnalyserState(btn, state_) {
  if (!btn) return;
  btn.classList.remove('analyzing');
  btn.disabled = false;
  switch (state_) {
    case 'idle':
      btn.style.cssText = 'background:linear-gradient(135deg,#1d4ed8,#2563eb);color:#fff;font-weight:800;';
      btn.textContent = 'ANALYSER';
      break;
    case 'analyzing':
      btn.classList.add('analyzing');
      btn.style.cssText = 'color:#fff;';
      btn.textContent = 'ANALYSE EN COURS...';
      btn.disabled = true;
      break;
    case 'buy':
      btn.style.cssText = 'background:#22c55e;color:#000;font-weight:700;';
      btn.textContent = '\u25b2 SIGNAL LONG';
      setTimeout(function() { setAnalyserState(btn, 'idle'); }, 5000);
      break;
    case 'sell':
      btn.style.cssText = 'background:#ef4444;color:#fff;font-weight:700;';
      btn.textContent = '\u25bc SIGNAL SHORT';
      setTimeout(function() { setAnalyserState(btn, 'idle'); }, 5000);
      break;
    case 'wait':
      btn.style.cssText = 'background:#eab308;color:#000;font-weight:700;';
      btn.textContent = '\u23f8 ON ATTEND';
      setTimeout(function() { setAnalyserState(btn, 'idle'); }, 5000);
      break;
    case 'error':
      btn.style.cssText = 'background:linear-gradient(135deg,#1d4ed8,#2563eb);color:#fff;font-weight:800;';
      btn.textContent = 'ANALYSER';
      break;
  }
}

// ─── BIND ─────────────────────────────────────────────────────────────────────
function bindAll() {
  var ss = $('symbolSelect');
  var ts = $('tfSelect');
  var ms = $('modeSelect');

  if (ss) ss.addEventListener('change', function() {
    state.symbol = ss.value || 'XAUUSD';
    state.userLocked = true;
    // Vider state.live immédiatement — évite que l'ancien symbole (ex: BTC) pollue Gold
    state.live = null;
    state.price = null;
    state._lastPriceTick = null;
    fetchJson('/extension/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'set-symbol',
        payload: { symbol: state.symbol, timeframe: state.timeframe, mode: state.tradeMode, price: state.price }
      })
    }).catch(function() {});
    if (state.chartOpen) loadTVChart(state.symbol, state.timeframe);
    // Reconnect coach stream au nouveau symbole — évite que le coach parle de l'ancien actif
    if (state.agentSessionActive) {
      disconnectCoachStream();
      connectCoachStream(state.symbol);
    }
    refreshAll();
    renderMultiTF();
    scheduleSaveState();
  });
  if (ts) ts.addEventListener('change', function() {
    var tf = String(ts.value || 'H1').toUpperCase();
    state.timeframe = TFS.indexOf(tf) >= 0 ? tf : 'H1';
    fetchJson('/extension/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'set-symbol',
        payload: { symbol: state.symbol, timeframe: state.timeframe, mode: state.tradeMode, price: state.price }
      })
    }).catch(function() {});
    if (state.chartOpen) loadTVChart(state.symbol, state.timeframe);
    refreshAll();
    renderMultiTF();
    scheduleSaveState();
  });
  if (ms) ms.addEventListener('change', function() {
    var m = String(ms.value || 'AUTO').toUpperCase();
    state.tradeMode = ['AUTO','SCALPER','SNIPER','SWING','ANALYSE','ALERTE','EXECUTION_PREPAREE'].indexOf(m) >= 0 ? m : 'AUTO';
    // ── Annonce vocale du mode sélectionné ───────────────────────────────
    var _modeVocal = {
      'AUTO':    'Mode auto activé. Je vais m\'adapter au marché et proposer du scalp, du sniper ou du swing selon le setup.',
      'SCALPER': 'Mode scalp activé. Je cherche uniquement des entrées rapides et réactives sur M1 et M5.',
      'SNIPER':  'Mode sniper activé. Je cherche uniquement des entrées précises en zone extrême sur M5 et M15.',
      'SWING':   'Mode swing activé. Je cherche uniquement des setups sur logique de fond H1 et H4.'
    }[state.tradeMode];
    if (_modeVocal && !state.muted) speak(_modeVocal);
    fetchJson('/extension/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'set-bridge-config',
        payload: { bridgeMode: state.tradeMode, updatedBy: 'extension-popup' }
      })
    }).catch(function() {});
    // Also sync mode to server (syncs with dashboard)
    fetchJson('/set-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: state.tradeMode, source: 'extension' })
    }).catch(function() {});
    refreshAll();
    scheduleSaveState();
  });

  var bd = $('btnDetach');
  if (bd) {
    if (!state.persistent) {
      bd.addEventListener('click', openWindow);
    } else {
      bd.hidden = true;
    }
  }

  var ftv = $('focusTradingViewBtn');
  if (ftv) ftv.addEventListener('click', async function() {
    try {
      var tabs = await chrome.tabs.query({ url: 'https://*.tradingview.com/*' });
      var t = tabs.find(function(x) { return x.active; }) || tabs[0];
      if (!t || typeof t.id !== 'number') return;
      await chrome.tabs.update(t.id, { active: true });
      if (typeof t.windowId === 'number') await chrome.windows.update(t.windowId, { focused: true });
    } catch (_) {}
  });

  var cw = $('closeWindowBtn');
  if (cw) cw.addEventListener('click', function() { window.close(); });

  var tc = $('toggleChart');
  if (tc) tc.addEventListener('click', function() {
    state.chartOpen = !state.chartOpen;
    var cb = $('chartBody');
    if (cb) cb.classList.toggle('hidden', !state.chartOpen);
    tc.innerHTML = state.chartOpen
      ? '&#128200; GRAPHIQUE &#9660;'
      : '&#128200; GRAPHIQUE &#9654;';
    if (state.chartOpen) {
      // Charger le widget TV iframe uniquement à l'ouverture (lazy load)
      _tvChartSym = null; _tvChartTF = null; // force reload
      loadTVChart(state.symbol, state.timeframe);
    }
    scheduleSaveState();
  });

  // Multi-TF cards — click switches TF
  document.querySelectorAll('.tfc[data-tfc]').forEach(function(card) {
    card.addEventListener('click', function() {
      var tf = card.getAttribute('data-tfc');
      if (TFS.indexOf(tf) >= 0) {
        var _prevTf = state.timeframe;
        state.timeframe = tf;
        var ts2 = $('tfSelect'); if (ts2) ts2.value = tf;
        // LOG: [EXT] TF=M15 → sync bridge
        console.log('[EXT] TF=' + tf + ' (était ' + _prevTf + ') → sync server + bridge');
        // Invalider les données bridge du TF précédent — forcer rechargement frais
        if (_prevTf !== tf) {
          state._lastBridgeData = null;
          state._lastBridgeDataAt = null;
        }
        fetchJson('/extension/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command: 'set-symbol',
            payload: { symbol: state.symbol, timeframe: state.timeframe, mode: state.tradeMode, price: state.price }
          })
        }).then(function() {
          console.log('[EXT] TF=' + tf + ' → [SERVER] TF=' + tf + ' OK → attente données bridge');
        }).catch(function() {
          console.warn('[EXT] TF=' + tf + ' → [SERVER] ERREUR sync');
        });
        // Vocal immédiat — ce qu'on voit sur ce TF
        (function() {
          var _bd = state._lastBridgeData;
          var _tfLabels = { M1:'M1 — 1 minute', M5:'M5 — 5 minutes', M15:'M15 — 15 minutes', H1:'H1 — 1 heure', H4:'H4 — 4 heures', D1:'D1 — journalier' };
          var _tfLbl = _tfLabels[tf] || tf;
          var _rsiMap = { M1:'rsiTf1', M5:'rsiTf2', M15:'rsiTf3', H1:'rsiTf4' };
          var _rsiKey = _rsiMap[tf];
          var _rsiVal = _bd && _rsiKey ? Number(_bd[_rsiKey] || 0) : 0;
          var _ltMap  = { M1:'lectureTech1', M5:'lectureTech2', M15:'lectureTech3', H1:'lectureTech4' };
          var _ltKey  = _ltMap[tf];
          var _lt = _bd && _ltKey ? String(_bd[_ltKey] || '').replace(/_/g,' ').toLowerCase() : '';
          var _px = state.price > 0 ? (state.price > 100 ? state.price.toFixed(2) : state.price.toFixed(5)) : null;
          var _spk = 'Changement vers ' + _tfLbl + '. ';
          if (_px) _spk += 'Prix: ' + _px + '. ';
          if (_rsiVal > 0) _spk += 'RSI ' + tf + ': ' + Math.round(_rsiVal) + '. ';
          if (_lt) _spk += 'Signal: ' + _lt + '. ';
          // Ce qui bloque / ce qu'on attend sur ce TF
          if (_bd) {
            var _inTop = !!_bd.inTop, _inBot = !!_bd.inBot;
            if (!_inTop && !_inBot) _spk += 'Prix hors zone — j\'attends une zone d\'entrée.';
            else if (_inTop) _spk += 'Zone haute détectée — surveille un signal short.';
            else if (_inBot) _spk += 'Zone basse détectée — surveille un signal long.';
          } else {
            _spk += 'Données bridge en cours de chargement.';
          }
          speak(_spk);
          setCoachText('📊 ' + tf + ' SÉLECTIONNÉ\n' + (_lt ? 'Signal: ' + _lt.toUpperCase() : 'Chargement données...') + (_rsiVal > 0 ? ' | RSI: ' + Math.round(_rsiVal) : ''), '#94a3b8', 3, 5000);
        })();
        updateHeader();
        refreshAll().then(function() {
          // Log post-refresh: vérifier RSI reçu depuis bridge
          var _bd2 = state._lastBridgeData;
          var _rsiMap2 = { M1:'rsiTf1', M5:'rsiTf2', M15:'rsiTf3', H1:'rsiTf4' };
          var _rsiKey2 = _rsiMap2[tf];
          var _rsiVal2 = _bd2 && _rsiKey2 ? Number(_bd2[_rsiKey2] || 0) : 0;
          var _rsiFromBridge = _bd2 ? !!_bd2._rsiFromBridge : false;
          if (_rsiVal2 > 0) {
            console.log('[BRIDGE] TF=' + tf + ' RSI=' + Math.round(_rsiVal2) + (_rsiFromBridge ? ' (réel Pine)' : ' (conservé)') + ' ✅');
          } else {
            console.error('[ERROR] RSI TV manquant sur TF=' + tf + ' — vérifie que Pine Script est actif sur TradingView');
          }
        }).catch(function(){});
        scheduleSaveState();
      }
    });
  });

  // Trade action buttons (ENTRER, SORTIR, BREAKEVEN, PATIENTER)
  document.querySelectorAll('[data-action]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var a = btn.getAttribute('data-action');
      if (a) sendTradeAction(a);
    });
  });

  // MUTE button — addEventListener obligatoire (CSP Manifest V3 bloque onclick= inline)
  var muteBtn = document.getElementById('btnMute');
  if (muteBtn) {
    muteBtn.addEventListener('click', function() {
      toggleMute();
      // Après toggle: parler seulement si on vient de réactiver la voix
      setTimeout(function() {
        if (!state.muted) speak('Voix activée. Je parlerai à chaque signal, clôture de bougie, et conseil.');
      }, 100);
    });
  }

  // Alert banner dismiss — CSP interdit onclick inline
  var alertBanner = document.getElementById('alertBanner');
  if (alertBanner) {
    alertBanner.addEventListener('click', function() { alertBanner.style.display = 'none'; });
  }

  // ANALYSE button: now in HTML directly (full-width above acts-grid). Bind the handler here.
  var acts = document.querySelector('.acts-grid');
  {
    var b = document.getElementById('btnAnalyzeNow') || (function() {
      // Fallback: créer si manquant (compatibilité ancien HTML)
      var _b = document.createElement('button');
      _b.id = 'btnAnalyzeNow'; _b.className = 'btn-sub';
      if (acts) acts.appendChild(_b);
      return _b;
    })();
    setAnalyserState(b, 'idle');
    b.addEventListener('click', async function() {
      console.log('[ADEL] ANALYSER cliqué — début flow analyse');
      console.log('[ADEL] state.armed=', state.armed, '| state._bgAlive=', state._bgAlive);
      // LOG OBLIGATOIRE: position lue à l'instant du clic
      var _logTs = state.tradeState || null;
      var _logVp = _logTs && _logTs.virtualPosition || null;
      console.log('[ADEL] position lue:', _logTs ? { entered: _logTs.entered, direction: _logVp && _logVp.direction, entry: _logVp && _logVp.entry, sl: _logVp && _logVp.sl, tp: _logVp && _logVp.tp, phase: _logTs.phase } : 'aucune');
      // ── MARKET CLOSED GUARD ──────────────────────────────────────────────────
      // Si marché fermé → afficher message, lancer watcher, ne pas analyser
      // Lire depuis state.live (SSE) OU depuis /extension/data (polled)
      var _mktStatus = (state.live && state.live.marketStatus)
                    || (state._lastMarketStatus) || {};
      if (_mktStatus.isOpen === false) {
        var _anMkt = $('analysisText');
        if (_anMkt) _anMkt.textContent = '⏸ MARCHÉ FERMÉ — Aucune position possible. Alerte sonore à l\'ouverture.';
        speak('Le marché est fermé. Impossible d\'analyser ou d\'entrer en position. Je vous préviendrai dès l\'ouverture du marché.');
        startMarketOpenWatcher();
        setAnalyserState(b, 'wait');
        return;
      }
      // Si watcher en cours et marché maintenant ouvert → le stopper
      if (_marketOpenWatcher && _mktStatus.isOpen === true) {
        clearInterval(_marketOpenWatcher);
        _marketOpenWatcher = null;
      }
      // ── FIN MARKET CLOSED GUARD ──────────────────────────────────────────────

      // ── GUARD POSITION ACTIVE → MODE GESTION (jamais WAIT pendant un trade) ──
      if (state.tradeState && state.tradeState.entered) {
        try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch(_) {}
        _speakBusy = false; _speakQueue = [];
        var _gVp  = state.tradeState.virtualPosition || {};
        var _gDir = String(_gVp.direction || state.tradeState.direction || '').toUpperCase();
        var _gL   = _gDir.includes('LONG') || _gDir.includes('BUY');
        var _gFmt = function(v) { return Number(v) > 0 ? (Number(v) > 100 ? Number(v).toFixed(2) : Number(v).toFixed(5)) : '--'; };
        var _gPx  = state.price > 0 ? (state.price > 100 ? state.price.toFixed(2) : state.price.toFixed(5)) : '--';
        var _gPnl = (_gVp.entry && state.price) ? ((_gL ? state.price - Number(_gVp.entry) : Number(_gVp.entry) - state.price)).toFixed(2) : null;
        var _gMsg = 'Position ' + (_gL ? 'LONG' : 'SHORT') + ' active sur ' + (state.symbol || '') + '. '
          + 'Entrée: ' + _gFmt(_gVp.entry) + '. Stop: ' + _gFmt(_gVp.sl) + '. Objectif: ' + _gFmt(_gVp.tp) + '. '
          + 'Prix actuel: ' + _gPx + '. '
          + (_gPnl !== null ? (Number(_gPnl) >= 0 ? 'Profit: +' : 'Perte: ') + _gPnl + '. ' : '')
          + (state.tradeState.bePlaced ? 'Breakeven placé — risque zéro. ' : '')
          + 'Mode gestion actif — surveille le SL, le TP, et la structure.';
        speak(_gMsg);
        // Bouton permanent (pas de setTimeout→idle comme setAnalyserState 'buy'/'sell')
        b.disabled = false;
        b.style.cssText = _gL ? 'background:#22c55e;color:#000;font-weight:700;' : 'background:#ef4444;color:#fff;font-weight:700;';
        b.textContent = '\uD83D\uDD12 ' + (_gL ? 'LONG ACTIF' : 'SHORT ACTIF');
        setCoachText(
          '🔒 POSITION ' + (_gL ? 'LONG' : 'SHORT') + ' ACTIVE\n'
          + 'Entrée: ' + _gFmt(_gVp.entry) + '  SL: ' + _gFmt(_gVp.sl) + '  TP: ' + _gFmt(_gVp.tp) + '\n'
          + 'Mode GESTION — pas d\'analyse possible pendant un trade.\nSortir avec le bouton SORTIE ANTICIPÉE.',
          _gL ? '#22c55e' : '#ef4444', 8, 15000
        );
        console.log('[ADEL] ANALYSER → position active — mode GESTION activé (pas d\'analyse)');
        return;
      }
      // ── FIN GUARD POSITION ACTIVE ──────────────────────────────────────────

      // Reset moteur vocal — Chrome peut rester bloqué si onend n'a pas tiré
      // Libère _speakBusy pour que le speak suivant parte immédiatement
      try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch(_) {}
      _speakBusy = false; _speakQueue = [];

      // ── FIX ANALYSER BUG — reset état armé stale avant toute nouvelle analyse ──
      // RÈGLE: cliquer ANALYSER = nouveau cycle propre. Jamais bloquer sur state.armed stale.
      // On stoppe le watchdog précédent et on remet armed=false pour que auto-ARM
      // puisse s'exécuter correctement sans toggle (toggle = "already armed → disarm").
      if (state.armed && !(state.tradeState && state.tradeState.entered)) {
        console.log('[ADEL] ANALYSER — reset stale ARM state pour nouveau cycle');
        // SYNC FIX #1: broadcast DISARM avant reset — dashboard se désarme immédiatement
        // Sans ça: dashboard garde S.armed=true stale → ignore le prochain ARM broadcast
        fetchJson('/extension/command', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ command:'broadcast', payload:{ type:'trade-action', action:'DISARM', source:'extension', symbol:state.symbol, timestamp:Date.now() }}) }).catch(function(){});
        stopEntryWatchdog();
        state.armed = false;
        state._armedAt = null;
        state._armedDirection = null;
        state._lockedWdTf = null;
      }

      // Reset verrou TF analyse — nouvelle analyse repart proprement
      // Ne pas garder l'ancien _analysisLockedTf d'une analyse précédente
      state._analysisLockedTf = null;

      // ── ARM IMMÉDIAT — avant analyse ──────────────────────────────────────
      // ARM dès le clic ANALYSER, sans attendre analyzeAllTimeframesAndPickSetup.
      // Raison: l'analyse peut prendre 3-8s ou échouer silencieusement → ARM jamais atteint.
      // Le watchdog gate l'entrée réelle (TF alignés, bridge live, timing).
      if (!(state.tradeState && state.tradeState.entered) && !state.armed) {
        state._wdInitSpoken = false;
        sendTradeAction('ENTER').catch(function(e){ console.error('[ARM-IMMEDIAT ERROR]', e); });
      }

      // Explication vocale du bouton ANALYSER — enrichie avec contexte bridge live
      (function() {
        var _bdNow = state._lastBridgeData || null;
        var _pxNow = state.price > 0 ? (state.price > 100 ? state.price.toFixed(2) : state.price.toFixed(5)) : null;
        var _symNow = state.symbol || '';
        var _spkCtx = '';
        if (_bdNow) {
          var _l1 = String(_bdNow.lectureTech1 || '').replace(/_/g,' ').toLowerCase();
          var _l2 = String(_bdNow.lectureTech2 || '').replace(/_/g,' ').toLowerCase();
          var _l3 = String(_bdNow.lectureTech3 || '').replace(/_/g,' ').toLowerCase();
          var _l4 = String(_bdNow.lectureTech4 || '').replace(/_/g,' ').toLowerCase();
          var _sc1 = Number(_bdNow.scoreTech1 || 0);
          var _sc2 = Number(_bdNow.scoreTech2 || 0);
          var _sc3 = Number(_bdNow.scoreTech3 || 0);
          var _sc4 = Number(_bdNow.scoreTech4 || 0);
          var _inTop = !!_bdNow.inTop, _inBot = !!_bdNow.inBot;
          var _zoneStr = _inTop ? 'Prix en zone haute.' : _inBot ? 'Prix en zone basse.' : '';
          var _tfParts = [];
          if (_l1) _tfParts.push('M1 ' + _l1 + (_sc1 > 0 ? ' ' + Math.round(_sc1) + '%' : ''));
          if (_l2) _tfParts.push('M5 ' + _l2 + (_sc2 > 0 ? ' ' + Math.round(_sc2) + '%' : ''));
          if (_l3) _tfParts.push('M15 ' + _l3 + (_sc3 > 0 ? ' ' + Math.round(_sc3) + '%' : ''));
          if (_l4) _tfParts.push('H1 ' + _l4 + (_sc4 > 0 ? ' ' + Math.round(_sc4) + '%' : ''));
          if (_pxNow) _spkCtx += 'Prix ' + _symNow + ': ' + _pxNow + '. ';
          if (_tfParts.length > 0) _spkCtx += _tfParts.join(', ') + '. ';
          if (_zoneStr) _spkCtx += _zoneStr + ' ';
        } else if (_pxNow) {
          _spkCtx = 'Prix actuel ' + _pxNow + '. ';
        }
        speak(_spkCtx + 'Je lance l\'analyse complète — je vérifie M1, M5, M15, H1 et je cherche le meilleur setup. Attends le verdict.');
      })();

      // B5 FIX: always freshen state from TV/backend before analysing.
      // Clears userLocked so analysis always runs on the live TV context.
      state.userLocked = false;
      try {
        var freshExt = await fetchJson('/extension/data');
        console.log('[ADEL] /extension/data reçu:', JSON.stringify(freshExt && {activeSymbol: freshExt.activeSymbol, currentData: freshExt.currentData && {symbol: freshExt.currentData.symbol, price: freshExt.currentData.price, rsi: freshExt.currentData.rsi}}));
        var freshActive = (freshExt && freshExt.activeSymbol) || {};
        if (freshActive.symbol) state.symbol = String(freshActive.symbol).toUpperCase();
        if (freshActive.timeframe && TFS.indexOf(String(freshActive.timeframe).toUpperCase()) >= 0)
          state.timeframe = String(freshActive.timeframe).toUpperCase();
        var freshPrice = Number(freshActive.price);
        if (!Number.isFinite(freshPrice) || freshPrice <= 0) {
          var cd = (freshExt && freshExt.currentData) || {};
          var cdSym = String(cd.symbol || '').toUpperCase();
          var stSym = String(state.symbol || '').toUpperCase();
          var cdSymNorm = cdSym.replace(/[\/-]/g, '');
          var stSymNorm = stSym.replace(/[\/-]/g, '');
          if (cdSym && stSym && (cdSym === stSym || cdSymNorm === stSymNorm)) {
            var cdPrice = Number(cd.price);
            if (Number.isFinite(cdPrice) && cdPrice > 0) freshPrice = cdPrice;
          }
        }
        if (Number.isFinite(freshPrice) && freshPrice > 0) state.price = freshPrice;
        else state.price = null;
        // Capture market status from fresh /extension/data — second check (authoritative)
        if (freshExt && freshExt.marketStatus) {
          state._lastMarketStatus = freshExt.marketStatus;
          if (freshExt.marketStatus.isOpen === false) {
            setAnalyserState(b, 'wait');
            var _anMkt2 = $('analysisText');
            if (_anMkt2) _anMkt2.textContent = '⏸ MARCHÉ FERMÉ — Aucune position possible. Alerte sonore à l\'ouverture.';
            speak('Le marché est fermé. Je vous préviendrai dès l\'ouverture.');
            startMarketOpenWatcher();
            return;
          }
          if (_marketOpenWatcher && freshExt.marketStatus.isOpen === true) {
            clearInterval(_marketOpenWatcher); _marketOpenWatcher = null;
          }
        }
        if (freshExt && freshExt.bridgeConfig) applyBridgeConfig(freshExt.bridgeConfig);
        if (freshActive.mode) {
          var _fm = String(freshActive.mode).toUpperCase();
          if (['AUTO','SCALPER','SNIPER','SWING','ANALYSE','ALERTE','EXECUTION_PREPAREE'].indexOf(_fm) >= 0) state.tradeMode = _fm;
        }
        var _fss = $('symbolSelect'); if (_fss && Array.from(_fss.options).some(function(o){return o.value===state.symbol;})) _fss.value = state.symbol;
        var _fts = $('tfSelect'); if (_fts) _fts.value = state.timeframe;
        updateHeader();
      } catch(_) {}
      flowLog('ANALYSE TRIGGERED', {
        symbol: state.symbol,
        timeframe: state.timeframe,
        mode: state.tradeMode
      });
      setConn('ANALYSE...', 'warn');
      var an = $('analysisText'); if (an) an.textContent = 'ANALYSE EN COURS...';
      // Bouton en cours d'analyse → orange pulsing
      setAnalyserState(b, 'analyzing');
      try {
        // Nouveau cycle → reset tradeState si session inactive ET aucune position ouverte.
        // RÈGLE ABSOLUE: si state.tradeState.entered === true → position réelle ouverte
        // → jamais écraser, même si agentSessionActive est false (ex: reload page).
        if (!state.agentSessionActive && state.tradeState && !state.tradeState.entered) {
          state.tradeState = null;
        }
        await setAgentSession(true, 'analyze');
        var resp = await fetchJson('/extension/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'analyze', payload: { symbol: state.symbol, timeframe: state.timeframe, mode: state.tradeMode } })
        });
        // ── NEWS CHECK avant analyse ───────────────────────────────────────
        await renderNews(); // s'assurer que state.newsEvents est à jour
        var _preNewsCheck = checkNewsBlockEntry();
        if (_preNewsCheck.blocked) {
          var an0 = $('analysisText');
          if (an0) { an0.textContent = 'NEWS — BLOQUÉ: ' + _preNewsCheck.reason; an0.style.whiteSpace = 'pre-line'; }
          var ct0 = $('coachText');
          if (ct0) {
            ct0.textContent = 'NEWS — NE PAS ENTRER\n\n' + _preNewsCheck.reason
              + '\n\n' + (_preNewsCheck.afterWait || 'Attends la réaction puis entre proprement.')
              + '\n\nRègle: les news créent le mouvement, la structure donne la direction.';
            ct0.style.color = '#f97316';
          }
          speak(_preNewsCheck.reason.split('.')[0] + '. Blocage news actif.');
          setAnalyserState(b, 'wait');
          return; // ne pas lancer l'analyse
        }
        if (_preNewsCheck.warning) {
          speak('Attention: ' + _preNewsCheck.reason.split('.')[0] + '. Je surveille quand même.');
        }
        // ARM visuel léger pendant l'analyse (state.armed reste FALSE — sendTradeAction le met à true)
        // Ceci évite que sendTradeAction pense qu'on est déjà armé et désarme au lieu d'armer.
        if (!(state.tradeState && state.tradeState.entered)) {
          var _armBtnImm = document.querySelector('[data-action="ENTER"]');
          if (_armBtnImm) {
            _armBtnImm.disabled = false;
            _armBtnImm.style.cssText = 'background:#78350f;color:#fbbf24;font-weight:700;font-size:11px;opacity:0.7;';
            _armBtnImm.textContent = '⏳ ANALYSE...';
          }
          setCoachText('🔍 ANALYSE EN COURS — M1 → M5 → M15 → H1\nJe cherche le meilleur setup. Résultat dans quelques secondes.', '#94a3b8', 4, 8000);
        }

        // ── TRACE: log clic ANALYSER extension → visible dans dashboard test log ──
        var _traceTs = Date.now();
        console.log('[CLICK][EXT] ANALYSER symbol=' + state.symbol + ' ut=' + state.timeframe + ' ts=' + _traceTs);
        fetchJson('/extension/command', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ command:'broadcast', payload:{ type:'ext-trace', event:'ANALYSER_CLICK', symbol:state.symbol, ut:state.timeframe, ts:_traceTs, source:'extension' } }) }).catch(function(){});

        // ── BROADCAST ANALYSIS-RUNNING → dashboard voit le loading state ──
        fetchJson('/extension/command', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ command:'broadcast', payload:{ type:'analysis-running', source:'extension', symbol:state.symbol, timeframe:state.timeframe } }) }).catch(function(){});

        stopContinuousScan();
        startLiveNewsMonitor();

        // ── SCAN_TF — demande au background de collecter RSI réel par UT ──
        // Lance la rotation SWITCH_TF en arrière-plan (~6s).
        // analyzeAllTimeframesAndPickSetup s'exécute en parallèle avec les données disponibles,
        // puis un second refreshAll intègre les RSI réels dès qu'ils arrivent.
        try {
          await chrome.runtime.sendMessage({ type: 'SCAN_TF' });
        } catch (_scanErr) {}

        // ── ANIMATION SCAN TF — progression visuelle + narration par TF ─────
        // Anime chaque carte M1→M5→M15→H1→H4→D1 avec scanning badge + voix
        (function _animateTFScan() {
          var _bd0 = state._lastBridgeData || null;
          // H4/D1 exclus de l'animation scan — pas de données bridge réelles, ne pas laisser
          // en état "🔍 Analyse..." après que analyzeAllTimeframesAndPickSetup les a mis N/A
          var _scanTFs = ['M1','M5','M15','H1'];
          var _scanIdx = 0;
          var _tfLabels = { M1:'M1 — clôtures 1 min',M5:'M5 — bougies 5 min',M15:'M15 — setup moyen terme',H1:'H1 — direction macro' };
          var _scanInterval = setInterval(function() {
            if (_scanIdx >= _scanTFs.length) { clearInterval(_scanInterval); return; }
            var _tf = _scanTFs[_scanIdx];
            var _card = $('tfc-' + _tf);
            var _sigEl = $('tfc-' + _tf + '-t');
            var _subEl = $('tfc-' + _tf + '-s');
            // Retirer scanning du TF précédent
            if (_scanIdx > 0) {
              var _prevTf = _scanTFs[_scanIdx - 1];
              var _prevCard = $('tfc-' + _prevTf);
              if (_prevCard) _prevCard.classList.remove('scanning');
            }
            if (_card) _card.classList.add('scanning');
            if (_sigEl) { _sigEl.textContent = '🔍'; _sigEl.className = 'tfc-sig scanning'; }
            if (_subEl) { _subEl.textContent = 'Analyse...'; }
            // Mettre à jour analysisText avec TF en cours
            var _anEl = $('analysisText');
            if (_anEl) _anEl.textContent = '🔍 Scan ' + _tf + ' — ' + (_tfLabels[_tf] || _tf);
            _scanIdx++;
          }, 420); // ~420ms par TF → ~1.7s total pour 4 TFs (M1/M5/M15/H1)
        })();

        var mtf = await analyzeAllTimeframesAndPickSetup();
        flowLog('ANALYSE RESPONSE RECEIVED', {
          ok: !!resp.ok,
          message: resp.message || null,
          analysisTriggered: resp.analysisTriggered === true,
          selectedTimeframe: mtf && mtf.winner ? mtf.winner.tf : state.timeframe,
          selectedRecommendation: mtf && mtf.winner ? mtf.winner.rec : null
        });
        await refreshAll();
        // NE PAS appeler renderMultiTF ici — analyzeAllTimeframesAndPickSetup
        // a déjà mis les cartes à jour carte par carte avec le winner mis en évidence.
        // Un renderMultiTF ici écraserait immédiatement l'état winner (instabilité visuelle).

        // Après ~7s le scan SWITCH_TF est terminé → rafraîchir les cartes avec les vrais RSI par UT
        setTimeout(function() {
          try { refreshAll().catch(function(){}); } catch(_) {}
        }, 7500);

        // LOG OBLIGATOIRE: message agent après analyse
        var _agentMsg = (mtf && mtf.winner && mtf.winner.rec) || 'WAIT';
        console.log('[ADEL] message agent:', _agentMsg, '| TF:', mtf && mtf.winner && mtf.winner.tf, '| force:', mtf && mtf.winner && mtf.winner.strength);
        state.stats.lastEvent = 'ANALYSE ' + fmtTime();
        renderStats();
        var connLabel = (mtf && mtf.winner && mtf.winner.directional)
          ? 'MTF ' + mtf.winner.tf + ' OK'
          : 'ANALYSE OK';
        setConn(connLabel, 'ok');
        // Couleur bouton selon résultat (4 états visuels distincts)
        var winRec = (mtf && mtf.winner && mtf.winner.rec) || '';
        if (winRec.includes('BUY') || winRec.includes('LONG')) {
          setAnalyserState(b, 'buy');
        } else if (winRec.includes('SELL') || winRec.includes('SHORT')) {
          setAnalyserState(b, 'sell');
        } else {
          setAnalyserState(b, 'wait');
        }
        // ── AUTO-ARM — ANALYSER = armer le robot immédiatement ──────────────
        // RÈGLE: si state.armed=true mais pas de watchdog actif (_entryWatchdog=null)
        // → état stale (session précédente) → forcer reset pour permettre l'ARM.
        var _alreadyEntered = !!(state.tradeState && state.tradeState.entered);
        var _wdAlive = (_entryWatchdog !== null && state.armed);
        // Note: stale armed state already reset at top of ANALYSER click handler
        // Auto-ARM si setup directionnel — serveur OU bridge Pine (double chance de détecter)
        var _hasValidSetup = winRec.includes('BUY') || winRec.includes('LONG') || winRec.includes('ACHAT')
                          || winRec.includes('SELL') || winRec.includes('SHORT') || winRec.includes('VENTE');
        // Fallback bridge: si serveur dit WAIT mais Pine a un verdict directionnel → ARM quand même
        if (!_hasValidSetup) {
          var _bdArmFb = state._lastBridgeData || null;
          var _bdVerd  = _bdArmFb ? String(_bdArmFb.verdict || _bdArmFb.anticipation || '').toUpperCase() : '';
          var _lt3Arm  = _bdArmFb ? String(_bdArmFb.lectureTech3 || '').toUpperCase() : ''; // M15
          var _lt4Arm  = _bdArmFb ? String(_bdArmFb.lectureTech4 || '').toUpperCase() : ''; // H1
          var _verdDir = (_bdVerd.includes('LONG') || _bdVerd.includes('ACHAT') || _bdVerd.includes('BUY') ||
                         _bdVerd.includes('SHORT') || _bdVerd.includes('VENTE') || _bdVerd.includes('SELL'));
          var _m15Dir  = (_lt3Arm.includes('ACHAT') || _lt3Arm.includes('VENTE') || _lt3Arm.includes('BUY') || _lt3Arm.includes('SELL'));
          var _h1Dir   = (_lt4Arm.includes('ACHAT') || _lt4Arm.includes('VENTE') || _lt4Arm.includes('BUY') || _lt4Arm.includes('SELL'));
          // M15 OU H1 suffit (pas besoin des deux) — règle assouplie pour ARM rapide
          var _bdDirOk = _verdDir && (_m15Dir || _h1Dir);
          if (_bdDirOk) _hasValidSetup = true; // bridge M15 ou H1 aligné + verdict Pine → ARM autorisé
        }
        // Dernier fallback: si au moins 1 TF du scan local est directionnel → ARM (watchdog gate l'entrée réelle)
        if (!_hasValidSetup && mtf && mtf.snapshots) {
          var _anyDirectional = mtf.snapshots.some(function(s){ return s.directional && s.rec !== 'WAIT' && s.rec !== 'N/A'; });
          if (_anyDirectional) {
            _hasValidSetup = true;
            console.log('[ADEL] ARM fallback snapshots — >=1 TF directionnel → ARM autorisé, watchdog validera avant entrée');
          }
        }
        // ── GARDE SL RISQUE — règle obligatoire: SL% entre 0.05% et 1.5% du prix ──
        // CORRECTION: la règle 50-100 USDT s'applique au risque total (taille × distance),
        // pas à la distance prix brute (608 pour BTCUSD ≠ 608 USDT de risque réel).
        // On utilise SL% au lieu: garantit un SL ni trop serré (<0.05%) ni trop large (>1.5%).
        var _slGuardOk = true;
        var _slRiskPct = 0;
        if (mtf && mtf.winner && mtf.winner.entry > 0 && mtf.winner.sl > 0) {
          var _slDist = Math.abs(mtf.winner.entry - mtf.winner.sl);
          _slRiskPct  = (_slDist / mtf.winner.entry) * 100;
          if (_slRiskPct < 0.05 || _slRiskPct > 1.5) {
            _slGuardOk = false;
            setCoachText('⛔ SL HORS RÈGLE — ENTRÉE BLOQUÉE\nSL distance: ' + _slRiskPct.toFixed(2) + '% du prix\nRègle: SL entre 0.05% et 1.5%.\nAttends un setup avec SL dans la zone autorisée.', '#ef4444', 8, 15000);
            speak('Stop loss hors règle. Distance de ' + _slRiskPct.toFixed(1) + ' pourcent. Je bloque l\'entrée.');
            console.log('[EXT] BLOCK ARM reason=SL_hors_regle pct=' + _slRiskPct.toFixed(2) + '%');
          }
        }
        // RÈGLE: ANALYSER = armer automatiquement, toujours — watchdog gate l'entrée réelle
        // _hasValidSetup sert à choisir le message vocal, pas à bloquer l'ARM
        // Dashboard: même règle — si pas de direction → ARM en mode veille avec avertissement
        var _bridgeAgeMs = state._lastBridgeDataAt ? (Date.now() - state._lastBridgeDataAt) : Infinity;
        var _bridgeOffline = _bridgeAgeMs > 120000; // bridge hors ligne si > 2 minutes sans données
        console.log('[EXT] CLICK ANALYSER → ARM check — entered=', _alreadyEntered, '| armed=', state.armed, '| setup=', _hasValidSetup, '| slGuard=', _slGuardOk, '| slPct=', _slRiskPct.toFixed(2) + '%', '| winRec=', winRec, '| bridgeOffline=', _bridgeOffline);
        if (!_alreadyEntered && !state.armed) {
          try {
            console.log('[EXT] CLICK ANALYSER → SEND ARM symbol=' + state.symbol + ' ut=' + (mtf&&mtf.winner&&mtf.winner.tf||state.timeframe) + ' setup=' + _hasValidSetup);
            state._wdInitSpoken = false;
            await sendTradeAction('ENTER');
            // Message post-ARM selon contexte: direction claire ou mode veille
            if (!_hasValidSetup) {
              var _armWarnBridge = _bridgeOffline
                ? '⚠️ Bridge TV hors ligne — robot armé en mode veille.\nPas de données RSI réelles.\nReconnecte TradingView Pine Script pour activer les données fraîches.\nJ\'entre dès qu\'un signal clair apparaît.'
                : '⏳ ROBOT ARMÉ — Signal en attente\nAucun TF directionnel clair actuellement.\nSurveillance continue — j\'entre quand le marché se positionne.';
              setCoachText(_armWarnBridge, '#64748b', 4, 15000);
              if (_bridgeOffline) speak('Robot armé en mode veille. Bridge TradingView hors ligne. Reconnecte Pine Script pour avoir des données fraîches.');
              else speak('Robot armé. Signal encore neutre. Je surveille et j\'entre dès que le marché choisit une direction.');
            }
          } catch (_armErr) { console.error('[ANALYSER AUTO-ARM ERROR]', _armErr); }
        } else if (_alreadyEntered) {
          console.log('[EXT] BLOCK ARM reason=position_active');
        } else if (state.armed) {
          console.log('[EXT] BLOCK ARM reason=already_armed');
        }

        // ── VERDICT FINAL — annonce vocale riche avec synthèse complète ──────
        var voiceText = '';
        var _winTf  = (mtf && mtf.winner && mtf.winner.tf) ? mtf.winner.tf : state.timeframe;
        var _winEnt = (mtf && mtf.winner && mtf.winner.entry) ? Number(mtf.winner.entry) : 0;
        var _winSl  = (mtf && mtf.winner && mtf.winner.sl)    ? Number(mtf.winner.sl)    : 0;
        var _winTp  = (mtf && mtf.winner && mtf.winner.tp)    ? Number(mtf.winner.tp)    : 0;
        var _winStr = (mtf && mtf.winner && mtf.winner.strength) ? Number(mtf.winner.strength) : 0;
        var _fmtV   = function(v){ return v > 100 ? Number(v).toFixed(2) : Number(v).toFixed(5); };
        // Synthèse TFs depuis snapshots
        var _snaps = (mtf && mtf.snapshots) || [];
        var _validTFs = _snaps.filter(function(s){ return s.directional && s.rec !== 'WAIT' && s.rec !== 'N/A'; });
        var _validTFNames = _validTFs.map(function(s){ return s.tf; });
        var _validCount = _validTFNames.length;
        // Lecture bridge post-analyse
        var _bdPost = state._lastBridgeData || null;
        var _rsiM15p = _bdPost ? Number(_bdPost.rsiTf3 || 0) : 0;
        var _rsiH1p  = _bdPost ? Number(_bdPost.rsiTf4 || 0) : 0;
        var _inTopP  = _bdPost && _bdPost.inTop, _inBotP = _bdPost && _bdPost.inBot;
        var _zoneP   = _inTopP ? 'zone haute' : _inBotP ? 'zone basse' : '';
        var _antP    = _bdPost ? String(_bdPost.anticipationTexte || '').replace(/_/g,' ') : '';
        var _afP     = _bdPost ? Number(_bdPost.anticipationForce || 0) : 0;
        // Force globale
        var _sc1p = _bdPost ? Number(_bdPost.scoreTech1||0) : 0;
        var _sc2p = _bdPost ? Number(_bdPost.scoreTech2||0) : 0;
        var _sc3p = _bdPost ? Number(_bdPost.scoreTech3||0) : 0;
        var _sc4p = _bdPost ? Number(_bdPost.scoreTech4||0) : 0;
        var _forceGlob = Math.round((_sc1p*0.10)+(_sc2p*0.15)+(_sc3p*0.45)+(_sc4p*0.30)) || _winStr;
        var _forceLbl = _forceGlob >= 75 ? 'très forte' : _forceGlob >= 55 ? 'forte' : _forceGlob >= 35 ? 'modérée' : 'insuffisante';
        // Type d'entrée
        var _tpDist2 = _winTp > 0 && _winEnt > 0 ? Math.abs(_winTp - _winEnt) : 0;
        var _entType2 = (_tpDist2 > 25 && _validTFNames.indexOf('H1') >= 0) ? 'SWING'
                      : (_tpDist2 < 8 || (_validTFNames.length < 3)) ? 'SCALPING'
                      : 'SNIPER';
        var _levVoice = _winEnt > 0
          ? 'Entrée: ' + _fmtV(_winEnt) + (_winSl > 0 ? '. Stop: ' + _fmtV(_winSl) : '') + (_winTp > 0 ? '. Objectif: ' + _fmtV(_winTp) : '') + '.'
          : '';
        if (winRec.includes('BUY') || winRec.includes('LONG')) {
          voiceText = 'Analyse terminée — ' + state.symbol + '. ';
          voiceText += 'J\'ai scanné ' + _validCount + ' unités de temps: ' + (_validTFNames.join(', ') || _winTf) + ' tous alignés en hausse. ';
          voiceText += 'Force du marché: ' + _forceLbl + (_forceGlob > 0 ? ', ' + _forceGlob + '%' : '') + '. ';
          voiceText += 'Type d\'entrée: ' + _entType2.toLowerCase() + '. ';
          if (_zoneP) voiceText += 'Prix en ' + _zoneP + '. ';
          if (_rsiM15p > 70) voiceText += 'M15 en excès haussier — prudence. ';
          voiceText += _levVoice + ' ';
          if (_antP && _afP > 50) voiceText += 'Anticipation: ' + _antP + ' ' + Math.round(_afP) + '%. ';
          voiceText += 'Setup LONG validé sur ' + _winTf + '. ' + (state.armed ? 'Robot armé — j\'entre automatiquement au bon moment.' : 'Appuie sur ENTRER si tu es prêt.') + ' Analyse terminée.';
        } else if (winRec.includes('SELL') || winRec.includes('SHORT')) {
          voiceText = 'Analyse terminée — ' + state.symbol + '. ';
          voiceText += 'J\'ai scanné ' + _validCount + ' unités de temps: ' + (_validTFNames.join(', ') || _winTf) + ' tous alignés en baisse. ';
          voiceText += 'Force du marché: ' + _forceLbl + (_forceGlob > 0 ? ', ' + _forceGlob + '%' : '') + '. ';
          voiceText += 'Type d\'entrée: ' + _entType2.toLowerCase() + '. ';
          if (_zoneP) voiceText += 'Prix en ' + _zoneP + '. ';
          if (_rsiM15p < 30 && _rsiM15p > 0) voiceText += 'M15 en survente — prudence sur le timing. ';
          voiceText += _levVoice + ' ';
          if (_antP && _afP > 50) voiceText += 'Anticipation: ' + _antP + ' ' + Math.round(_afP) + '%. ';
          voiceText += 'Setup SHORT validé sur ' + _winTf + '. ' + (state.armed ? 'Robot armé — j\'entre automatiquement au bon moment.' : 'Appuie sur ENTRER si tu es prêt.') + ' Analyse terminée.';
        } else {
          // Aucun setup — expliquer quel TF bloque + estimation temporelle + type probable
          var _anCtx = _buildTfCtx();
          var _bdWait = state._lastBridgeData || null;
          var _wtInTop = _bdWait && (_bdWait.inTop === true || _bdWait.zoneLiqHaute === true);
          var _wtInBot = _bdWait && (_bdWait.inBot === true || _bdWait.zoneLiqBasse === true);
          var _wtZone  = _wtInTop || _wtInBot;
          var _wtBullR = _bdWait && _bdWait.bullRej === true;
          var _wtBearR = _bdWait && _bdWait.bearRej === true;
          var _wtStruct = _wtBullR || _wtBearR;
          var _wtH1    = _anCtx.dirH1  !== '--' && _anCtx.dirH1 !== null;
          var _wtM15   = _anCtx.dirM15 !== '--' && _anCtx.dirM15 !== null;
          var _wtConflict = _wtH1 && _wtM15 && _anCtx.dirM15 !== _anCtx.dirH1;

          // Estimer le type de setup probable et le délai
          var _wtSetupType, _wtDelay;
          if (!_wtZone && _wtH1) {
            _wtSetupType = 'swing'; _wtDelay = '2 à 4 heures';
          } else if (_wtZone && !_wtStruct) {
            _wtSetupType = 'sniper'; _wtDelay = '20 à 45 minutes';
          } else if (_wtZone && _wtStruct && !_wtM15) {
            _wtSetupType = 'scalp'; _wtDelay = '10 à 20 minutes';
          } else if (_wtConflict) {
            _wtSetupType = null; _wtDelay = null;
          } else {
            _wtSetupType = null; _wtDelay = null;
          }

          var _blockMsg = _wtConflict
            ? 'M15 et H1 en conflit de direction — je ne peux pas entrer dans ces conditions'
            : !_wtH1 ? 'H1 neutre — pas de direction macro confirmée'
            : !_wtM15 ? 'M15 pas encore aligné avec H1'
            : !_wtZone ? 'le prix est au milieu du range — aucun niveau clé atteint'
            : !_wtStruct ? 'zone atteinte mais pas encore de rejet ou de signal de structure'
            : 'pas de confluence suffisante sur les unités de temps';

          voiceText = 'Analyse terminée sur ' + state.symbol + '. ' + _blockMsg + '. ';
          if (_wtSetupType && _wtDelay) {
            voiceText += 'D\'après les conditions actuelles, un setup ' + _wtSetupType + ' pourrait se former dans environ ' + _wtDelay + '. ';
          } else if (_wtConflict) {
            voiceText += 'Conflit H1 vs M15 — je ne peux pas estimer de timing. Attends la résolution. ';
          } else {
            voiceText += 'Difficile d\'estimer un timing précis pour l\'instant. ';
          }
          // Si robot vient d'être armé → ne pas dire "Je stoppe" — dire surveillance active
          if (state.armed) {
            voiceText += 'Robot armé — je surveille en continu. Je t\'annonce dès que les conditions sont réunies.';
          } else {
            voiceText += 'Je surveille. Rappuie sur Analyser pour un nouveau scan ou appuie sur ENTRER pour armer le robot manuellement.';
          }
        }
        speak(voiceText);

        // ── SIGNAL BANNER — affichage immédiat après ANALYSER avec setup trouvé ──
        // Montre Entry/SL/TP directement sans attendre la prochaine mise à jour SSE
        var _sbFeb = document.getElementById('futureEntryBanner');
        var _sbPel = document.getElementById('preEntryLevels');
        // Banner affiché si setup directionnel et pas en position — toujours visible après ANALYSER
        if (_sbFeb && _sbPel && mtf && mtf.winner && mtf.winner.directional && !_alreadyEntered) {
          var _sbW   = mtf.winner;
          var _sbRec = String(_sbW.rec || '').toUpperCase();
          var _sbIsL = _sbRec.includes('BUY') || _sbRec.includes('LONG');
          var _sbDir = _sbIsL ? 'LONG' : 'SHORT';
          var _sbCol = _sbIsL ? '#22c55e' : '#ef4444';
          var _sbBg  = _sbIsL ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)';
          var _sbEnt = _winEnt > 0 ? _fmtV(_winEnt) : '~' + (_fmtV(state.price || 0));
          var _sbSl  = _winSl  > 0 ? _fmtV(_winSl)  : '--';
          var _sbTp  = _winTp  > 0 ? _fmtV(_winTp)  : '--';
          var _sbStr = _sbW.strength ? ' — ' + _sbW.strength + '%' : '';
          // Mode + TF explanation
          var _sbModeLabel = {
            SCALPER: 'Scalp rapide', SNIPER: 'Sniper précis', SWING: 'Swing large', AUTO: 'Analyse complète'
          }[String(state.tradeMode||'AUTO').toUpperCase()] || 'Analyse complète';
          // Show futureEntryBanner — texte = ARMÉ automatiquement
          _sbFeb.style.display = 'block';
          _sbFeb.style.background = _sbBg;
          _sbFeb.style.borderColor = _sbCol;
          _sbFeb.style.color = _sbCol;
          var _sbArrow = _sbIsL ? '▲' : '▼';
          _sbFeb.textContent = _sbArrow + ' ROBOT ARMÉ — ' + _sbDir + _sbStr + ' | ' + _sbW.tf + ' | Mode ' + _sbModeLabel
            + '\nEn surveillance — entrée automatique dès que les conditions sont réunies';
          _sbFeb.style.whiteSpace = 'pre-line';
          // Show preEntryLevels with Entry/SL/TP
          _sbPel.style.display = 'block';
          _sbPel.style.borderColor = _sbCol;
          _sbPel.style.borderLeft = '3px solid ' + _sbCol;
          var _sbRr = (_winSl > 0 && _winTp > 0 && _winEnt > 0)
            ? (Math.abs(_winTp - _winEnt) / Math.abs(_winEnt - _winSl)).toFixed(1)
            : '--';
          _sbPel.innerHTML = '📍 Entrée ~' + _sbEnt + '   🛑 SL: ' + _sbSl + '   🎯 TP: ' + _sbTp
            + '\n📊 R:R = 1:' + _sbRr + '   |   TF: ' + _sbW.tf
            + (_sbW.reason ? '\n💡 ' + String(_sbW.reason).split('|')[0].trim().substring(0,80) : '');
          _sbPel.style.whiteSpace = 'pre-line';
          // Cache winner for watchdog auto-entry
          state._mtfWinner = _sbW;
        }

        // analysisText already set by analyzeAllTimeframesAndPickSetup; only fallback if still blank
        var an2 = $('analysisText');
        if (an2 && !an2.textContent) an2.textContent = 'Analyse reçue. Mise à jour UI terminée.';
      } catch (_) {
        setAnalyserState(b, 'error');
        setConn('ANALYSE KO', 'bad');
        var an3 = $('analysisText'); if (an3) an3.textContent = 'Échec analyse. Vérifier flux backend.';
        flowLog('ANALYSE ERROR', {
          symbol: state.symbol,
          timeframe: state.timeframe,
          mode: state.tradeMode
        });
      }
    });
  }

  // btnSourceTv (TRADINGVIEW ON) masqué — TradingView est toujours la source, bouton inutile
  // Source unique: Bridge TV uniquement
  // btnBridgeToggle (BRIDGE ACTIF) masqué — bridge toujours actif, bouton inutile

  // Bridge ON/OFF toggle using existing badge (no design refactor).
  var bridgeBadge = $('bridgeBadge');
  if (bridgeBadge) {
    bridgeBadge.addEventListener('click', async function() {
      var next = state.bridgeConfig.bridgeEnabled === false;
      try {
        await fetchJson('/extension/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'set-bridge-config', payload: { bridgeEnabled: next, updatedBy: 'extension-popup' } })
        });
      } catch (_) {}
    });
  }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function bootstrapSymbolFromExtension() {
  // 1. Essayer le background de l'extension (symbole détecté depuis TradingView DOM)
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      const ctx = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'GET_ACTIVE_CONTEXT' }, (resp) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(resp);
        });
      });
      if (ctx?.ok && ctx.context?.symbol) {
        state.symbol = ctx.context.symbol;
        if (ctx.context.timeframe) state.timeframe = ctx.context.timeframe;
        if (ctx.context.price) state.price = ctx.context.price;
        console.log('[BOOT] Symbole depuis TradingView extension:', state.symbol);
        return true;
      }
    }
  } catch (_) {}

  // 2. Fallback localStorage (déjà géré par loadPersistedState, rien à faire)
  // 3. Fallback XAUUSD reste en dernier recours
  console.log('[BOOT] Aucun contexte TradingView live — fallback localStorage/XAUUSD');
  return false;
}

// ── BACKGROUND SERVICE WORKER HEALTH CHECK ───────────────────────────────────
// Vérifie si background.js est actif. Si mort → badge rouge + message coach.
// Un background mort = pas de bridge TV = DECISION AGENT WAIT permanent.
async function checkBackgroundAlive() {
  return new Promise(function(resolve) {
    var _done = false;
    var _timer = setTimeout(function() {
      if (!_done) { _done = true; resolve(false); }
    }, 1200);
    try {
      chrome.runtime.sendMessage({ type: 'PING' }, function(resp) {
        clearTimeout(_timer);
        if (!_done) {
          _done = true;
          var err = chrome.runtime.lastError;
          resolve(!err && resp && resp.ok === true);
        }
      });
    } catch(_) {
      clearTimeout(_timer);
      if (!_done) { _done = true; resolve(false); }
    }
  });
}

function _showBgStatus(alive) {
  var dotExt = document.getElementById('dot-ext');
  var lbl = document.getElementById('bh-label');
  if (dotExt) {
    dotExt.style.background = alive ? '#22c55e' : '#ef4444';
    dotExt.style.boxShadow = alive ? '0 0 4px #22c55e88' : '0 0 4px #ef444488';
    dotExt.title = alive ? 'Background actif' : 'Background MORT — recharger extension';
  }
  if (!alive && lbl) {
    lbl.style.color = '#ef4444';
    lbl.textContent = 'BG MORT';
  }
  if (!alive) {
    var ct = document.getElementById('coachText');
    if (ct && (!ct.textContent || ct.textContent.length < 30)) {
      ct.style.color = '#ef4444';
      ct.textContent = '⚠️ SERVICE WORKER INACTIF\n\nL\'extension n\'est pas chargée correctement.\n\n1. Ouvre chrome://extensions\n2. Recharge "Trading Auto Analyzer" (bouton ↻)\n3. Dossier source : trading-boulot/tradingview-analyzer/\n\nSans background.js actif → aucun bridge TV → ANALYSER = WAIT permanent.';
    }
    setConn('BG MORT', 'bad');
    console.error('[ADEL] background.js service worker mort — bridge TV inactif. Recharger depuis trading-boulot/tradingview-analyzer/');
  } else {
    console.log('[ADEL] background.js actif ✓');
  }
}

async function boot() {
  loadPersistedState();
  await bootstrapSymbolFromExtension();
  updateHeader();
  state.persistent = isPersistent();
  if (state.persistent) {
    document.body.classList.add('win');
    var wa = $('windowActions'); if (wa) wa.hidden = false;
    var bd = $('btnDetach');     if (bd) bd.hidden = true;
  }

  // Vérifier background.js dès le boot — c'est le prérequis de tout
  var _bgAlive = await checkBackgroundAlive();
  _showBgStatus(_bgAlive);
  state._bgAlive = _bgAlive;

  bindAll();

  // Load initial state from extension data
  try {
    var d = await fetchJson('/extension/data');
    var ext = d.activeSymbol || {};
    applyBridgeConfig(d.bridgeConfig || null);
    if (ext.symbol) state.symbol = String(ext.symbol).toUpperCase();
    if (ext.timeframe && TFS.indexOf(String(ext.timeframe).toUpperCase()) >= 0)
      state.timeframe = String(ext.timeframe).toUpperCase();
    if (ext.mode) {
      var m = String(ext.mode).toUpperCase();
      state.tradeMode = ['AUTO','SCALPER','SNIPER','SWING','ANALYSE','ALERTE','EXECUTION_PREPAREE'].indexOf(m) >= 0 ? m : 'AUTO';
    }
    var _cd = d.currentData || {};
    var _cand = Number(_cd.price);
    if (!Number.isFinite(_cand) || _cand <= 0) _cand = Number(ext.price);
    if (Number.isFinite(_cand) && _cand > 0) state.price = _cand;
    else state.price = null;
  } catch (_) {}

  // ── RÉCUPÉRATION POSITION ACTIVE AU BOOT — SOURCE SERVEUR ────────────────
  // Scan tous les TFs pour trouver une position active — évite le biais TF unique
  try {
    var _sym = state.symbol || 'XAUUSD';
    var _bootTFs = ['M1','M5','M15','H1','H4','D1'];
    var _foundBoot = null;
    for (var _bti = 0; _bti < _bootTFs.length && !_foundBoot; _bti++) {
      try {
        var _bResp = await fetchJson('/coach/trade-state?symbol=' + encodeURIComponent(_sym) + '&tf=' + encodeURIComponent(_bootTFs[_bti]));
        if (_bResp && _bResp.ok && _bResp.state && _bResp.state.entered) _foundBoot = _bResp.state;
      } catch(_) {}
    }
    if (_foundBoot && _foundBoot.virtualPosition) {
      var _bvp = _foundBoot.virtualPosition;
      // Écrire directement state.tradeState depuis le serveur — zero localStorage lag
      state.tradeState = _foundBoot;
      state.agentSessionActive = true;
      if (typeof ChartModule !== 'undefined' && ChartModule && typeof ChartModule.resetLevels === 'function') {
        ChartModule.resetLevels();
      }
      scheduleSaveState();
      console.log('[BOOT] Position active chargée depuis serveur: entry=' + _bvp.entry + ' sl=' + _bvp.sl + ' tp=' + _bvp.tp);
    } else if (!_foundBoot) {
      // Aucune position active sur aucun TF → effacer le localStorage potentiellement stale
      if (state.tradeState && state.tradeState.entered) {
        console.log('[BOOT] Serveur: aucune position active — nettoyage localStorage stale');
        state.tradeState = null;
        state.agentSessionActive = false;
        scheduleSaveState();
      }
    }
  } catch (_bootErr) {
    console.warn('[BOOT] Impossible de récupérer position serveur:', _bootErr && _bootErr.message);
  }

  // Sync selects
  var ss = $('symbolSelect');
  if (ss && Array.from(ss.options).some(function(o) { return o.value === state.symbol; })) ss.value = state.symbol;
  var ts = $('tfSelect'); if (ts) ts.value = state.timeframe;
  var ms = $('modeSelect'); if (ms) ms.value = state.tradeMode;

  updateHeader();

  // Graphique TV : chargé à la demande (lazy) — le chart est fermé par défaut
  // loadTVChart appelé uniquement quand l'utilisateur ouvre le panneau GRAPHIQUE
  if (state.chartOpen) {
    loadTVChart(state.symbol, state.timeframe);
  }

  // Start in manual mode: orchestration only on ANALYSE/ENTER session.
  fetchJson('/orchestration/disable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trigger: 'boot-manual' })
  }).catch(function() {});

  // ── ADEL IDENTITY STAMP ──────────────────────────────────────────────────
  // Affiche l'identité ADEL dans le header dès le boot pour confirmation visuelle
  (function _stampAdel() {
    try {
      var _titleEl = document.querySelector('.header-title') || document.querySelector('h1') || document.getElementById('headerTitle');
      if (_titleEl && !_titleEl.dataset.adelStamped) {
        _titleEl.dataset.adelStamped = '1';
        _titleEl.title = 'ADEL ACTIVE — ' + window.ADEL_EXT_ID;
      }
      // Badge ADEL dans la zone connexion si aucun badge existant
      var _connEl = document.getElementById('conn');
      if (_connEl) {
        _connEl.title = 'ADEL: ' + window.ADEL_EXT_ID;
      }
      console.log('[ADEL] Stamp boot — ID:', window.ADEL_EXT_ID, '| version:', window.ADEL_VERSION);
      // Vérifier état ADEL côté serveur
      fetch(API + '/adel/status', { signal: AbortSignal.timeout(2000) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d && d.adel) console.log('[ADEL] Serveur confirmé: ADEL CONNECTED — symbol:', d.symbol, '| connected:', d.connected);
          else console.warn('[ADEL] Serveur: réponse inattendue', d);
        })
        .catch(function() {});
    } catch(_) {}
  })();

  // Connect SSE first (real-time updates)
  connectSSE();

  // First load
  await refreshHealth();
  await refreshAll();
  loadLiveSymbols();
  renderMultiTF();

  await loadJournalStats();

  // ── RÉCUPÉRATION POSITION ACTIVE AU REDÉMARRAGE ─────────────────────────
  // Si une position est déjà active sur le serveur (persistée dans active-positions.json),
  // reconnecter le coach stream et annoncer la reprise automatique
  try {
    var _bootLive = state.live || {};
    var _bootTs = _bootLive.tradeState || null;
    if (_bootTs && _bootTs.entered && !(_bootTs.phase === 'EXITED' || _bootTs.phase === 'CLOSED')) {
      var _bVp = _bootTs.virtualPosition || _bootLive.virtualPosition || {};
      var _bDir = String(_bVp.direction || _bootTs.direction || '').toUpperCase();
      // Activer l'agent session et reconnecter le coach stream
      state.agentSessionActive = true;
      connectCoachStream(state.symbol);
      // Afficher le panel position
      renderPositionPanel(_bootLive, state.price);
      // Démarrer scan continu toutes les 30s pour surveiller retournements en temps réel
      if (!_continuousScanActive) startContinuousScan();
      // Annonce vocale
      var _bMsg = 'Attention, une position ' + (_bDir === 'LONG' ? 'acheteuse' : _bDir === 'SHORT' ? 'vendeuse' : '') + ' est déjà active sur ' + state.symbol
        + (_bVp.entry ? ' depuis ' + fmtPrice(_bVp.entry) : '')
        + '. Je reprends le coaching automatique. Aucune nouvelle position ne sera prise.';
      speak(_bMsg);
      setCoachText('[REPRISE] ' + _bMsg, _bDir === 'LONG' ? COL_LONG : _bDir === 'SHORT' ? COL_SHORT : COL_PENDING, 8, 15000);
      flowLog('BOOT POSITION RECOVERY', {
        symbol: state.symbol, direction: _bDir,
        entry: _bVp.entry, sl: _bVp.sl, tp: _bVp.tp, phase: _bootTs.phase
      });
    }
  } catch (_bootErr) {}

  // ── BRIDGE STALENESS WATCHDOG ─────────────────────────────────────────────
  // Détecte quand le flux TradingView est coupé (updatedAt > 35s) et alerte l'utilisateur
  var _bridgeStaleAlerted = false;
  var _bridgeStaleLastBip = 0;
  setInterval(async function() {
    try {
      var r = await fetchJson('/extension/data');
      var _updatedAt = (r && r.currentData && r.currentData.updatedAt) ? new Date(r.currentData.updatedAt).getTime() : 0;
      var _ageMs = _updatedAt > 0 ? (Date.now() - _updatedAt) : Infinity;
      var _isStale = _ageMs > 35000 || (r && r.stale === true) || (r && r.systemStatus && r.systemStatus.fluxStatus === 'STALE');
      var _alertEl = document.getElementById('bridgeStaleAlert');
      var _ageEl   = document.getElementById('bridgeStaleAge');
      var _bbEl    = document.getElementById('bridgeBadge');
      if (_isStale) {
        // Afficher alert
        if (_alertEl) _alertEl.style.display = 'block';
        if (_ageEl)   _ageEl.textContent = ' (>' + Math.round(_ageMs / 1000) + 's sans mise à jour)';
        if (_bbEl)    { _bbEl.textContent = '⚡ TV STALE'; _bbEl.style.background = 'rgba(239,68,68,.2)'; _bbEl.style.color = '#ef4444'; }
        // Voix + bip toutes les 60s max
        var _now = Date.now();
        if (!_bridgeStaleAlerted || (_now - _bridgeStaleLastBip) > 60000) {
          _bridgeStaleAlerted = true;
          _bridgeStaleLastBip = _now;
          speak('Attention: le flux TradingView est coupé. Les prix ne sont plus fiables. Ouvrez TradingView.');
        }
      } else {
        // Bridge OK — nettoyer l'alerte
        if (_alertEl) _alertEl.style.display = 'none';
        if (_bbEl && _bridgeStaleAlerted) {
          _bbEl.textContent = '● TV LIVE'; _bbEl.style.background = 'rgba(34,197,94,.1)'; _bbEl.style.color = '#22c55e';
          speak('TradingView reconnecté. Flux prix rétabli.');
        }
        _bridgeStaleAlerted = false;
      }
    } catch(_) {}
  }, 10000); // check every 10s

  // ── INTERVALLES OPTIMISÉS ─────────────────────────────────────────────────
  setInterval(refreshAll,          8000);
  setInterval(renderMultiTF,     90000);
  setInterval(refreshHealth,      15000);
  setInterval(loadLiveSymbols,    30000);
  setInterval(loadJournalStats,   90000);
  setInterval(refreshServerStats, 60000);
  setInterval(renderBridgeHealth,  5000);
  refreshServerStats();
  setInterval(function() {
    if (!state.agentSessionActive) return;
    var _sseAge = Date.now() - (state._lastSseAt || 0);
    if (_sseAge > 5000) { loadRealtimePack().catch(function(){}); }
  }, 3000);
}

async function loadJournalStats() {
  try {
    const data = await fetchJson(`/journal?symbol=${state.symbol}&limit=100`);
    if (!data.ok) return;
    const s = data.stats;
    const el = document.getElementById('journalStats');
    if (!el) return;
    el.innerHTML = `<span style="color:#64748b;font-size:10px">
      ${s.total} trades ·
      <span style="color:${s.winRate >= 50 ? '#22c55e' : '#ef4444'}">${s.winRate}% win</span> ·
      <span style="color:${s.totalPips >= 0 ? '#22c55e' : '#ef4444'}">${s.totalPips >= 0 ? '+' : ''}${s.totalPips} pips</span>
    </span>`;
  } catch(_) {}
}

async function resetJournalStats() {
  if (!confirm('Remettre les stats à zéro ?')) return;
  try {
    const r = await fetchJson('/journal/reset', { method: 'POST' });
    if (r && r.ok) {
      await loadJournalStats();
      var _sEl = document.getElementById('statSignals'); if (_sEl) _sEl.textContent = '0';
      var _tEl = document.getElementById('statTrades');  if (_tEl) _tEl.textContent = '0';
      var _rEl = document.getElementById('statRate');    if (_rEl) _rEl.textContent = '--';
    }
  } catch(_) {}
}

window.addEventListener('load', function() {
  boot().catch(function() {});
  // newsListHeader: handler inline supprimé du HTML (CSP) — rebranché ici
  var _nlh = document.getElementById('newsListHeader');
  if (_nlh) _nlh.addEventListener('click', function() { toggleNewsExt(); });
  // Reset stats — inline onclick interdit par CSP Chrome extensions
  var _btnReset = document.getElementById('btnResetStats');
  if (_btnReset) _btnReset.addEventListener('click', function() { resetJournalStats(); });

  // ── MODULE RECALAGE — lecture localStorage, affichage sous le prix ──────
  // Isolé totalement : aucune interaction avec la logique robot/bridge.
  (function _recalageExt() {
    var RC_KEY = 'recalage_v1';
    var _rowEl  = document.getElementById('recalage-ext-row');
    function _fmtPrice(v) {
      if (!v || isNaN(v)) return '—';
      return v > 100 ? v.toFixed(2) : v.toFixed(5);
    }
    function _updateRecalage() {
      try {
        var d = JSON.parse(localStorage.getItem(RC_KEY) || '{}');
        var active = !!(d.enabled && d.platform && d.ecart !== undefined);
        // ── Barre prix live (header) ──────────────────────────────────────────
        if (!_rowEl) return;
        if (!active) {
          _rowEl.style.display = 'none';
          var _extRow = document.getElementById('posExtPlatRow');
          if (_extRow) _extRow.style.display = 'none';
          return;
        }
        _rowEl.style.display = 'flex';
        var tvLive = (state && state.price && parseFloat(state.price) > 0)
          ? parseFloat(state.price) : 0;
        var ecart = parseFloat(d.ecart) || 0;
        var platCalc = tvLive > 0 ? tvLive + ecart : 0;
        var tvEl   = document.getElementById('recalage-ext-tv');
        var platEl = document.getElementById('recalage-ext-plat');
        var nameEl = document.getElementById('recalage-ext-name');
        var _rcName = d.platform || '';
        var _rcTv   = tvLive > 0 ? _fmtPrice(tvLive) : '—';
        var _rcPlat = platCalc > 0 ? _fmtPrice(platCalc) : '—';
        if (nameEl && nameEl.textContent !== _rcName) nameEl.textContent = _rcName;
        if (tvEl   && tvEl.textContent   !== _rcTv)   tvEl.textContent   = _rcTv;
        if (platEl && platEl.textContent !== _rcPlat)  platEl.textContent = _rcPlat;
        // ── Pills plateforme sous SL/Entry/TP ────────────────────────────────
        var _platRow = document.getElementById('posExtPlatRow');
        var _slPlatEl    = document.getElementById('posSlPlatExt');
        var _entryPlatEl = document.getElementById('posEntryPlatExt');
        var _tpPlatEl    = document.getElementById('posTpPlatExt');
        // Lire les valeurs TV depuis les labels existants
        function _parseLabel(id, prefix) {
          var el = document.getElementById(id);
          if (!el) return 0;
          return parseFloat(el.textContent.replace(prefix,'').replace(/[^\d.]/g,'')) || 0;
        }
        var _slV    = _parseLabel('posSlLbl',    'SL ');
        var _entryV = _parseLabel('posEntryLbl', 'Entry ');
        var _tpV    = _parseLabel('posTpLbl',    'TP ');
        var _hasLvl = _slV > 0 || _entryV > 0 || _tpV > 0;
        if (_platRow) _platRow.style.display = (_hasLvl && ecart !== 0) ? 'flex' : 'none';
        if (_hasLvl && ecart !== 0) {
          var _pn = (d.platform || '').substring(0,6);
          var _slTxt    = _slV    > 0 ? _pn + ' ' + _fmtPrice(_slV    + ecart) : '--';
          var _entryTxt = _entryV > 0 ? _pn + ' ' + _fmtPrice(_entryV + ecart) : '--';
          var _tpTxt    = _tpV    > 0 ? _pn + ' ' + _fmtPrice(_tpV    + ecart) : '--';
          if (_slPlatEl    && _slPlatEl.textContent    !== _slTxt)    _slPlatEl.textContent    = _slTxt;
          if (_entryPlatEl && _entryPlatEl.textContent !== _entryTxt) _entryPlatEl.textContent = _entryTxt;
          if (_tpPlatEl    && _tpPlatEl.textContent    !== _tpTxt)    _tpPlatEl.textContent    = _tpTxt;
        }
      } catch(_) {}
    }
    _updateRecalage();
    setInterval(_updateRecalage, 250); // sync rapide — DOM seul, pas de réseau
  })();
});
