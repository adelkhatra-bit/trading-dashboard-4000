// background.js v3.2 — Service Worker (Architecture Complète - Clean)
// Centralise toute logique: parle au backend, cache l'état, distribue aux content/popup
'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// ✅  PROJET ADEL — Extension unique active — Trading Auto Analyzer
// Serveur : http://127.0.0.1:4000
// ══════════════════════════════════════════════════════════════════════════════

// ── SIGNATURE ADEL ────────────────────────────────────────────────────────────
// Identifiant unique injecté dans TOUTES les requêtes vers le serveur.
// Le serveur REFUSE toute requête /tradingview/live sans cette signature.
const ADEL_SIG = 'TRADING-AUTO-ANALYZER';
const ADEL_EXT_ID = 'bbdmldjileifgbmhgeodfjjodajogjip';
self.ADEL_ACTIVE = true;
function adelHeaders() {
  return { 'Content-Type': 'application/json', 'X-Adel-Source': ADEL_SIG };
}
console.log('[ADEL] Service worker actif — Trading Auto Analyzer', ADEL_EXT_ID);

// ── DÉDUPLICATION PRIX + TIMEFRAME ───────────────────────────────────────────
// Évite de poster des prix identiques chaque seconde au serveur.
// MAIS : si le timeframe change, on force un envoi immédiat même si le prix est identique.
const _tvLiveDedup = {};
function shouldPostLive(symbol, price, timeframe) {
  const key = String(symbol || '').toUpperCase();
  const tf  = String(timeframe || '').toUpperCase();
  const now = Date.now();
  const last = _tvLiveDedup[key];
  if (!last) { _tvLiveDedup[key] = { price, sentAt: now, tf }; return true; }
  const delta   = Math.abs(price - last.price) / Math.max(Math.abs(last.price), 1);
  const age     = now - last.sentAt;
  const tfChanged = tf && last.tf && tf !== last.tf; // TF changé → envoi forcé
  // Seuil aligné avec content.js: >0.001% OU >500ms OU TF changé
  if (tfChanged || delta > 0.00001 || age > 500) {
    _tvLiveDedup[key] = { price, sentAt: now, tf };
    return true;
  }
  return false;
}

const API = 'http://127.0.0.1:4000';  // TRADING AUTO EXCLUSIVE
const POLL_INTERVAL = 1500;  // Poll resserré pour limiter le drift backend/extension
const SCRAPE_INTERVAL = 1000; // Scrape TradingView DOM en quasi temps-réel
const FOREGROUND_ENFORCE_MS = 1200;
const STORAGE_KEY_BG_STATE = 'taa_bg_system_state_v1';

// ── GLOBAL STATE ──────────────────────────────────────────────────────────
let isFetching = false;  // Protection: évite les requêtes parallèles
let lastForegroundEnforceAt = 0;
let foregroundTimer = null;

let systemState = {
  backendReady: false,
  tvConnected: false,
  lastSnapshot: null,
  lastUpdate: null,
  activeSymbol: null,
  activeTimeframe: 'H1',
  activePrice: null,
  activeTradingViewTabId: null,
  selectedTimeframes: ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'],
  isArmed: false,
};

const PERSISTENT_POPUP_URL = chrome.runtime.getURL('popup.html?persistent=1');
let persistentPopupWindowId = null;
let _onClickedBusy = false; // Mutex: empêche double-clic / exécutions parallèles

async function hydratePersistentState() {
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY_BG_STATE]);
    const saved = stored && stored[STORAGE_KEY_BG_STATE];
    if (saved && typeof saved === 'object') {
      systemState = Object.assign({}, systemState, saved, {
        backendReady: false,
        tvConnected: false
      });
    }
  } catch (_) {}
}

function persistBackgroundState() {
  try {
    chrome.storage.local.set({
      [STORAGE_KEY_BG_STATE]: {
        lastSnapshot: systemState.lastSnapshot || null,
        lastUpdate: systemState.lastUpdate || null,
        activeSymbol: systemState.activeSymbol || null,
        activeTimeframe: systemState.activeTimeframe || 'H1',
        activePrice: systemState.activePrice || null,
        activeTradingViewTabId: systemState.activeTradingViewTabId || null,
        selectedTimeframes: Array.isArray(systemState.selectedTimeframes) ? systemState.selectedTimeframes : ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1']
      }
    }).catch(() => {});
  } catch (_) {}
}

function scheduleForegroundEnforce() {
  if (persistentPopupWindowId === null) return;
  const now = Date.now();
  if (now - lastForegroundEnforceAt < FOREGROUND_ENFORCE_MS) return;
  if (foregroundTimer) clearTimeout(foregroundTimer);
  foregroundTimer = setTimeout(async () => {
    try {
      const win = await chrome.windows.get(persistentPopupWindowId);
      if (!win || typeof win.id !== 'number') {
        persistentPopupWindowId = null;
        return;
      }
      const updatePatch = win.state === 'minimized'
        ? { state: 'normal', focused: true, drawAttention: false }
        : { focused: true, drawAttention: false };
      await chrome.windows.update(persistentPopupWindowId, updatePatch);
      lastForegroundEnforceAt = Date.now();
    } catch (_) {
      persistentPopupWindowId = null;
    }
  }, 160);
}

async function openPersistentPopupWindow() {
  if (persistentPopupWindowId !== null) {
    try {
      await chrome.windows.update(persistentPopupWindowId, { focused: true, drawAttention: true });
      return;
    } catch (_) {
      persistentPopupWindowId = null;
    }
  }

  const existingTabs = await chrome.tabs.query({ url: PERSISTENT_POPUP_URL });
  if (existingTabs.length > 0) {
    const existingTab = existingTabs[0];
    if (existingTab.windowId !== undefined) {
      persistentPopupWindowId = existingTab.windowId;
      await chrome.windows.update(existingTab.windowId, { focused: true, drawAttention: true });
      return;
    }
  }

  const createdWindow = await chrome.windows.create({
    url: PERSISTENT_POPUP_URL,
    type: 'popup',
    width: 460,
    height: 820,
    focused: true
  });

  persistentPopupWindowId = createdWindow && typeof createdWindow.id === 'number' ? createdWindow.id : null;
  scheduleForegroundEnforce();
}

function isTradingViewUrl(url) {
  return typeof url === 'string' && url.includes('tradingview.com');
}

function rememberTradingViewTab(tab) {
  if (tab && typeof tab.id === 'number' && isTradingViewUrl(tab.url)) {
    systemState.activeTradingViewTabId = tab.id;
  }
}

async function findTradingViewTab() {
  const tabs = await chrome.tabs.query({ url: 'https://*.tradingview.com/*' });
  if (!tabs.length) return null;

  const cached = tabs.find((tab) => tab.id === systemState.activeTradingViewTabId);
  const active = tabs.find((tab) => tab.active);
  const candidate = cached || active || tabs[0];
  rememberTradingViewTab(candidate);
  return candidate;
}

// ── RE-INJECT CONTENT SCRIPT si contexte invalide ────────────────────────
// Quand le content script est mort (extension rechargée, contexte invalide),
// on réinjecte automatiquement pour rétablir le flux live.
async function reInjectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    console.log('[BG] Content script ré-injecté dans tab', tabId);
  } catch (e) {
    console.log('[BG] Réinjection impossible:', e.message);
  }
}

// ── SCRAP REAL TRADINGVIEW PANEL AND SEND TO SERVER ─────────────────────
async function scrapAndSendTradingView() {
  try {
    const tab = await findTradingViewTab();
    if (!tab || typeof tab.id !== 'number') return;

    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAP_PANEL' });
    } catch (e) {
      // Content script mort ou contexte invalide → réinjection
      if (e && e.message && (e.message.includes('Receiving end does not exist') || e.message.includes('context invalidated'))) {
        console.warn('[BG] Content script absent — réinjection en cours...');
        await reInjectContentScript(tab.id);
      }
      return;
    }
    if (!response || !response.ok || !response.data) {
      // Réponse "context_dead" = content script détruit, réinjection
      if (response && response.error === 'context_dead') {
        console.warn('[BG] Content script contexte mort — réinjection...');
        await reInjectContentScript(tab.id);
      }
      return;
    }

    const panelData = response.data;
    if (!panelData.symbol) {
      console.log('[BG] Scrap skipped: symbol not detected');
      return;
    }

    rememberTradingViewTab(tab);
    _lastSuccessfulScrap = Date.now(); // Watchdog: marquer bridge actif
    console.log('[BG] Panel scraped:', panelData.symbol, panelData.panelText);

    systemState.activeSymbol = panelData.symbol;
    systemState.activeTimeframe = panelData.timeframe || systemState.activeTimeframe;
    const parsedPanelPrice = Number(panelData.price);
    let resolvedPrice = Number.isFinite(parsedPanelPrice) && parsedPanelPrice > 0 ? parsedPanelPrice : null;

    systemState.activePrice = resolvedPrice;
    systemState.lastPanelData = panelData.panelText;
    systemState.lastUpdate = new Date().toISOString();
    persistBackgroundState();

    if (systemState.activePrice && systemState.activePrice > 0) {
      await fetch(API + '/extension/command', {
        method: 'POST',
        headers: adelHeaders(),
        body: JSON.stringify({
          command: 'set-symbol',
          _adel: ADEL_SIG,
          payload: {
            symbol: panelData.symbol,
            timeframe: panelData.timeframe || systemState.activeTimeframe,
            price: systemState.activePrice,
            mode: systemState.activeMode || undefined,
            source: 'tradingview-extension'
          }
        }),
        signal: AbortSignal.timeout(3000)
      }).catch((err) => {
        console.log('[ADEL] /extension/command ERROR:', err.message);
      });
    } else {
      console.log('[BG] Skipping /extension/command: no valid price yet');
      return;
    }

    // Correction : push live vers /tradingview/live (backend réel) — déduplication
    if (!shouldPostLive(panelData.symbol, systemState.activePrice, panelData.timeframe || systemState.activeTimeframe)) return;
    // Parser les indicateurs depuis panelText — source: bridge TV uniquement
    const _pt = panelData.panelText || {};
    const _parsedIndicators = {};
    // Helper parse numérique sécurisé
    function _pNum(str, min, max) {
      if (!str) return null;
      const m = String(str).replace(/\u2212/g, '-').match(/(-?[0-9]+\.?[0-9]*)/);
      if (!m) return null;
      const v = parseFloat(m[1]);
      if (!Number.isFinite(v)) return null;
      if (min != null && v < min) return null;
      if (max != null && v > max) return null;
      return v;
    }
    const _rsi = _pNum(_pt.rsi, 0.1, 100);       if (_rsi  != null) _parsedIndicators.rsi  = _rsi;
    // MACD: peut être négatif
    if (_pt.macd) {
      const _v = _pNum(_pt.macd, null, null);
      if (_v != null) _parsedIndicators.macd = _v;
    }
    // Mapper le RSI visible vers le champ per-TF correspondant
    // Permet au serveur de remplir robotV12.rsi_Xm sans attendre le SCAN_TF complet
    const _curTf = String(panelData.timeframe || systemState.activeTimeframe || 'H1').toUpperCase();
    const _rsiTfKeyMap = { M1:'rsi_1m', M5:'rsi_5m', M15:'rsi_15m', M30:'rsi_30m', H1:'rsi_60m', H4:'rsi_4h', D1:'rsi_60m' };
    const _rsiTfKey = _rsiTfKeyMap[_curTf] || null;
    const livePayload = {
      symbol:     panelData.symbol,
      timeframe:  panelData.timeframe || systemState.activeTimeframe,
      price:      systemState.activePrice,
      timestamp:  new Date().toISOString(),
      source:     'tradingview-extension',
      _adel:      ADEL_SIG,
      tickerid:   panelData.tickerid   || null,
      indicators: panelData.indicators || (Object.keys(_parsedIndicators).length ? _parsedIndicators : {}),
      legend:     panelData.legend     || {},
      ask:        panelData.ask        || null,
      bid:        panelData.bid        || null
    };
    // Injecter RSI visible dans le champ per-TF pour que robotV12 soit à jour sans SCAN_TF
    if (_rsiTfKey && _rsi != null) livePayload[_rsiTfKey] = _rsi;
    const tvResp = await fetch(API + '/tradingview/live', {
      method: 'POST',
      headers: adelHeaders(),
      body: JSON.stringify(livePayload),
      signal: AbortSignal.timeout(3000)
    });
    if (tvResp.ok) {
      console.log('[ADEL] /tradingview/live OK:', livePayload.symbol, livePayload.timeframe, livePayload.price);
    } else {
      console.warn('[ADEL] /tradingview/live ERROR:', livePayload.symbol);
    }
  } catch (err) {
    console.log('[TV PUSH][ERROR] Scrap/send error:', err.message);
  }
}
// ── SCAN MULTI-TF — rotation SWITCH_TF pour collecter RSI par UT ─────────
// Parcourt M1→M5→M15→H1 en cliquant les boutons TF sur TradingView.
// Collecte un RSI réel par UT puis poste un seul payload consolidé au serveur.
// Durée ~6s. Restore le TF original après scan.
let _scanTfRunning = false;
async function scanAllTimeframes() {
  if (_scanTfRunning) return;
  _scanTfRunning = true;
  const tab = await findTradingViewTab().catch(() => null);
  if (!tab || typeof tab.id !== 'number') { _scanTfRunning = false; return; }

  const originalTF = systemState.activeTimeframe || 'M1';
  const SCAN_TFS = ['M1', 'M5', 'M15', 'H1', 'H4'];
  const rsiByTf = {};

  for (const tf of SCAN_TFS) {
    try {
      // Switch TF on TradingView
      await chrome.tabs.sendMessage(tab.id, { type: 'SWITCH_TF', tf });
      // Wait for chart to reload indicators
      await new Promise(r => setTimeout(r, 1400));
      // Scrape RSI for this TF
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAP_PANEL' });
      if (resp && resp.ok && resp.data) {
        const rsi = resp.data.indicators?.rsi ?? resp.data.panelText?.rsi ?? null;
        if (rsi != null) rsiByTf[tf] = Number(rsi);
      }
    } catch (_) {}
  }

  // Restore TF: toujours M1 quand armé (watchdog doit voir M1), sinon TF original
  const restoreTF = systemState.isArmed ? 'M1' : originalTF;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'SWITCH_TF', tf: restoreTF });
  } catch (_) {}

  // Post dès qu'au moins 1 TF a du RSI — ou même sans RSI pour garder le bridge vivant
  const populated = Object.keys(rsiByTf).length;
  const sym = systemState.activeSymbol;
  const price = systemState.activePrice;
  if (sym && price) {
    await fetch(API + '/tradingview/live', {
      method: 'POST',
      headers: adelHeaders(),
      body: JSON.stringify({
        symbol:   sym,
        timeframe: originalTF,
        price,
        source:   'switch-tf-scan',
        _adel:    ADEL_SIG,
        rsi_1m:   rsiByTf.M1  ?? null,
        rsi_5m:   rsiByTf.M5  ?? null,
        rsi_15m:  rsiByTf.M15 ?? null,
        rsi_60m:  rsiByTf.H1  ?? null,
        rsi_4h:   rsiByTf.H4  ?? null,
        timestamp: new Date().toISOString()
      }),
      signal: AbortSignal.timeout(4000)
    }).catch(() => {});
    console.log('[ADEL] SCAN_TF envoyé (' + populated + ' TFs):', JSON.stringify(rsiByTf), '→ /tradingview/live');
  }
  _scanTfRunning = false;
}

// ── POLL BACKEND STATE ────────────────────────────────────────────────────
async function pollBackendState() {
  // Protection 1 : skip si une requête est déjà en cours
  if (isFetching) return;

  // Protection 2 : skip si aucun onglet du tout (Chrome fermé / profil non chargé)
  try {
    const allTabs = await chrome.tabs.query({});
    if (allTabs.length === 0) return;
  } catch (_) {}

  isFetching = true;
  try {
    // GET /live/state + /extension/data pour miroir strict TradingView
    const healthResp = await fetch(API + '/live/state', {
      signal: AbortSignal.timeout(2000)
    });

    // 503 = bridge gate bloqué (bridge offline) ≠ serveur mort — traiter séparément
    if (healthResp.status === 503) {
      systemState.backendReady = true;  // serveur répond, bridge juste offline
      systemState.tvConnected = false;
      broadcastStateChange({ type: 'STATE_UPDATE', state: systemState });
      isFetching = false;
      return;
    }
    if (!healthResp.ok) throw new Error('Backend unreachable');

    const health = await healthResp.json();
    systemState.backendReady = health.ok;
    systemState.tvConnected = !!(health?.bridge?.tvConnected ?? health?.ok);

    const extResp = await fetch(API + '/extension/data', {
      signal: AbortSignal.timeout(2000)
    });
    if (extResp.ok) {
      const extData = await extResp.json();
      if (extData && extData.ok) {
        const active = extData.activeSymbol || {};
        const current = extData.currentData || {};
        systemState.activeSymbol = active.symbol || systemState.activeSymbol;
        systemState.activeTimeframe = active.timeframe || systemState.activeTimeframe;
        systemState.activePrice = current.price || active.price || systemState.activePrice;
        systemState.lastSnapshot = current;
        systemState.lastUpdate = new Date().toISOString();
        // Synchroniser tvMode depuis serveur — source de vérité
        if (extData.tvMode) systemState.tvMode = extData.tvMode;
        systemState.tvConnected = extData.bridgeLive === true;
        persistBackgroundState();
      }
    }
    
    // Broadcast à tous les clients
    broadcastStateChange({
      type: 'STATE_UPDATE',
      state: systemState
    });

    // ── CHECK SCAN FLAG — serveur popup ANALYSER → rotation TF TradingView ──
    try {
      const sym = systemState.activeSymbol || '';
      const flagResp = await fetch(API + '/extension/scan-flag' + (sym ? '?symbol=' + sym : ''), {
        signal: AbortSignal.timeout(1500)
      });
      if (flagResp.ok) {
        const flagData = await flagResp.json();
        if (flagData.scan) {
          console.log('[ADEL] Scan flag détecté — lancement rotation TF:', flagData.symbol);
          scanAllTimeframes().catch(() => {});
        }
      }
    } catch (_) {}

  } catch (err) {
    console.log('[BG] Poll error:', err.message);
    systemState.backendReady = false;
    systemState.tvConnected = false;
  } finally {
    isFetching = false;  // Libère le verrou dans tous les cas
  }
}

// ── BROADCAST STATE TO CONTENT & POPUP ────────────────────────────────────
async function broadcastStateChange(message) {
  try {
    const tabs = await chrome.tabs.query({});
    tabs.forEach(tab => {
      try {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      } catch (_) {}
    });
  } catch (_) {}
}

// ── MESSAGE LISTENER (From popup / content) ────────────────────────────────
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  (async () => {
    try {
      // ─── TV_POST_LIVE — prix live depuis content.js ───────────────
      // Content.js envoie TV_POST_LIVE à chaque tick de prix TradingView.
      // On POST immédiatement vers /tradingview/live avec déduplication.
      if (msg && msg.type === 'TV_POST_LIVE' && msg.payload) {
        const payload = msg.payload;
        const px = parseFloat(payload.price);
        // Mise à jour immédiate de systemState pour sync popup symbole+TF
        if (payload.symbol) systemState.activeSymbol = String(payload.symbol).toUpperCase();
        if (payload.timeframe) systemState.activeTimeframe = String(payload.timeframe).toUpperCase();
        if (Number.isFinite(px) && px > 0) systemState.activePrice = px;
        if (payload.symbol && Number.isFinite(px) && px > 0 && shouldPostLive(payload.symbol, px, payload.timeframe)) {
          const signedPayload = Object.assign({}, payload, { _adel: ADEL_SIG });
          fetch('http://127.0.0.1:4000/tradingview/live', {
            method: 'POST',
            headers: adelHeaders(),
            body: JSON.stringify(signedPayload)
          }).catch(e => { console.log('[ADEL] TV_POST_LIVE ERROR:', e.message); });
        }
        sendResponse({ ok: true });
        return;
      }

      // ─── GET SYSTEM STATE ─────────────────────────────────────────
      if (msg.type === 'GET_STATE') {
        sendResponse({ ok: true, state: systemState });
        return;
      }

      // ─── GET ACTIVE CONTEXT (symbole + TF détectés) ───────────────
      if (msg.type === 'GET_ACTIVE_CONTEXT') {
        if (systemState.activeSymbol) {
          sendResponse({ ok: true, context: {
            symbol:    systemState.activeSymbol,
            timeframe: systemState.activeTimeframe,
            price:     systemState.activePrice
          }});
        } else {
          sendResponse({ ok: false });
        }
        return;
      }

      // ─── SET MODE (SCALPER / SNIPER / SWING) ──────────────────────
      if (msg.type === 'SET_MODE') {
        systemState.activeMode = msg.mode || 'SNIPER';
        persistBackgroundState();
        sendResponse({ ok: true, mode: systemState.activeMode });
        return;
      }
      
      // ─── CHANGE SYMBOL ────────────────────────────────────────────
      if (msg.type === 'SET_SYMBOL') {
        const sym = msg.symbol?.toUpperCase();
        if (!sym) { sendResponse({ ok: false }); return; }
        
        try {
          const resp = await fetch(API + '/extension/command', {
            method: 'POST',
            headers: adelHeaders(),
            body: JSON.stringify({
              command: 'set-symbol',
              _adel: ADEL_SIG,
              payload: {
                symbol: sym,
                timeframe: systemState.activeTimeframe || 'H1',
                price: systemState.activePrice || null
              }
            }),
            signal: AbortSignal.timeout(3000)
          });
          
          if (resp.ok) {
            const data = await resp.json();
            systemState.activeSymbol = sym;
            systemState.lastSnapshot = data;
            systemState.lastUpdate = new Date().toISOString();
            persistBackgroundState();
            
            broadcastStateChange({ type: 'SYMBOL_CHANGED', symbol: sym });
            sendResponse({ ok: true, data });
          } else {
            sendResponse({ ok: false, error: 'Symbol not found' });
          }
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        return;
      }
      
      // ─── CHANGE TIMEFRAME ─────────────────────────────────────────
      if (msg.type === 'SET_TIMEFRAME') {
        const tf = msg.timeframe;
        if (!tf) { sendResponse({ ok: false }); return; }
        
        systemState.activeTimeframe = tf;
        
        // Fetch chart data pour ce timeframe depuis le snapshot
        if (systemState.lastSnapshot) {
          broadcastStateChange({
            type: 'TIMEFRAME_CHANGED',
            timeframe: tf,
            snapshot: systemState.lastSnapshot
          });
        }
        
        sendResponse({ ok: true, timeframe: tf });
        return;
      }
      
      // ─── GET CHART DATA ──────────────────────────────────────────
      if (msg.type === 'GET_CHART') {
        try {
          const symbol = msg.symbol || systemState.activeSymbol;
          if (!symbol) { sendResponse({ ok: false, error: 'symbol required for GET_CHART' }); return; }
          const timeframe = msg.tf || systemState.activeTimeframe || 'H1';
          const resp = await fetch(
            API + `/klines?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(timeframe)}&limit=200`,
            { signal: AbortSignal.timeout(3000) }
          );
          
          if (resp.ok) {
            const data = await resp.json();
            if (data.ok && data.candles && data.candles.length > 0) {
              sendResponse({ ok: true, data: { rates: data.candles } });
            } else {
              sendResponse({ ok: false, error: 'No chart data available' });
            }
          } else {
            sendResponse({ ok: false, error: 'Chart data unavailable' });
          }
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        return;
      }
      
      // ─── RESOLVE SYMBOL DISABLED ────────────────────────────────────
      // All symbol data must come from real TradingView panel, not mapped database
      
      // ─── GET ECONOMIC EVENTS ─────────────────────────────────────
      if (msg.type === 'GET_ECONOMIC_EVENTS') {
        try {
          const resp = await fetch(API + '/economic-events', {
            signal: AbortSignal.timeout(3000)
          });
          
          const data = await resp.json();
          sendResponse({ ok: data.ok, events: data.events, error: data.error });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        return;
      }
      
      // ─── GET ASSET PRICE DISABLED ──────────────────────────────────
      // Prices must come from real TradingView panel only, never hardcoded
      
      // ─── SAVE MAPPING ────────────────────────────────────────────
      if (msg.type === 'SAVE_MAPPING') {
        const userInput = msg.userInput?.toUpperCase();
        const tvSymbol = (msg.tvSymbol || '').toUpperCase();

        if (!userInput || !tvSymbol) {
          sendResponse({ ok: false, error: 'Input and symbol required' });
          return;
        }

        // Save to chrome.storage.local
        try {
          const mapObj = {};
          mapObj['mapping_' + userInput] = {
            userInput: userInput,
            tvSymbol: tvSymbol,
            price: msg.price || null,
            savedAt: new Date().toISOString()
          };

          await chrome.storage.local.set(mapObj);
          console.log('[BG] Mapping saved locally:', userInput, '→', tvSymbol);
        } catch (storageErr) {
          console.log('[BG] Storage error:', storageErr.message);
        }

        // Also try to sync with server (for backup HTML)
        try {
          const resp = await fetch(API + '/studio/mapping-save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userInput: userInput,
              tvSymbol: tvSymbol,
              price: msg.price || null
            }),
            signal: AbortSignal.timeout(2000)
          });
          
          if (resp.ok) {
            const data = await resp.json();
            sendResponse({ ok: true, message: 'Mapping saved and synced', serverResp: data.ok });
          } else {
            // Server sync failed but local save succeeded
            sendResponse({ ok: true, message: 'Mapping saved locally (server sync failed)' });
          }
        } catch (err) {
          // Server unreachable but local save succeeded
          sendResponse({ ok: true, message: 'Mapping saved locally (' + err.message + ')' });
        }
        return;
      }
      
      // ─── CAPTURE SCREENSHOT ──────────────────────────────────────
      if (msg.type === 'CAPTURE_SCREENSHOT') {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab || !tab.windowId) {
            sendResponse({ ok: false, error: 'No active tab' });
            return;
          }
          
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
          sendResponse({ ok: true, screenshot: dataUrl });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        return;
      }
      
      // ─── GET AVAILABLE SYMBOLS ────────────────────────────────────
      if (msg.type === 'GET_SYMBOLS') {
        try {
          const resp = await fetch(API + '/extension/data', {
            signal: AbortSignal.timeout(3000)
          });
          const data = await resp.json();
          const symbols = data.ok && data.currentData?.symbol ? [data.currentData.symbol] : [];
          sendResponse({ ok: data.ok, symbols, error: data.error });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        return;
      }
      
      // ─── SCAN_TF — déclenché par ANALYSER pour collecter RSI multi-TF ──
      if (msg.type === 'SCAN_TF') {
        sendResponse({ ok: true, started: true });
        scanAllTimeframes().catch(() => {});
        return;
      }

      // ─── SET_ARMED — notifie background que le robot est armé/désarmé ──
      if (msg.type === 'SET_ARMED') {
        systemState.isArmed = !!msg.armed;
        sendResponse({ ok: true });
        return;
      }

      // ─── PING ────────────────────────────────────────────────────
      if (msg.type === 'PING') {
        sendResponse({ ok: true, pong: true });
        return;
      }
      
      // ─── SET BADGE (for alerts) ──────────────────────────────────
      if (msg.type === 'SET_BADGE') {
        try {
          const count = msg.count || 0;
          if (count > 0) {
            chrome.action.setBadgeText({ text: String(count) });
            chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });  // Red
          } else {
            chrome.action.setBadgeText({ text: '' });
          }
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        return;
      }
      
      sendResponse({ ok: false, error: 'Unknown message type' });
      
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  
  return true;  // Async response
});

// ── TAB MANAGEMENT ────────────────────────────────────────────────────────
// RÈGLE : 1 clic = 1 seule source d'affichage.
//   1. TradingView actif + overlay OK  → overlay seul (ferme popup si ouvert)
//   2. TradingView actif + overlay KO  → fenêtre persistante (fallback propre)
//   3. Hors TradingView               → fenêtre persistante
//   Mutex _onClickedBusy : double-clic ignoré jusqu'à fin du traitement
chrome.action.onClicked.addListener(async () => {
  if (_onClickedBusy) return; // double-clic → ignoré
  _onClickedBusy = true;
  try {
    const tvTab = await findTradingViewTab();

    if (tvTab && typeof tvTab.id === 'number') {
      // ── CAS 1 : onglet TradingView trouvé ────────────────────────────────
      let toggled = false;

      // Essai 1 — content script vivant → toggle direct
      try {
        const resp = await chrome.tabs.sendMessage(tvTab.id, { type: 'TOGGLE_PANEL' });
        toggled = !!(resp && resp.ok);
      } catch (_) { toggled = false; }

      // Essai 2 — content script mort → réinjecter + retenter
      if (!toggled) {
        await reInjectContentScript(tvTab.id);
        await new Promise(r => setTimeout(r, 500));
        try {
          const resp2 = await chrome.tabs.sendMessage(tvTab.id, { type: 'TOGGLE_PANEL' });
          toggled = !!(resp2 && resp2.ok);
        } catch (_2) { toggled = false; }
      }

      if (toggled) {
        // Overlay activé → fermer la fenêtre persistante si ouverte (évite doublon)
        if (persistentPopupWindowId !== null) {
          try { await chrome.windows.remove(persistentPopupWindowId); } catch (_) {}
          persistentPopupWindowId = null;
        }
        return; // overlay seul → terminé
      }

      // Overlay impossible (contenu TV non disponible) → fallback fenêtre persistante
      console.log('[BG] Overlay KO — fallback fenêtre persistante');
    }

    // ── CAS 2 & 3 : ouvrir fenêtre persistante ───────────────────────────
    await openPersistentPopupWindow();
  } catch (err) {
    console.log('[BG] Toggle panel error:', err.message);
    openPersistentPopupWindow().catch(() => {});
  } finally {
    _onClickedBusy = false;
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    rememberTradingViewTab(tab);
  } catch (_) {}
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && !isTradingViewUrl(changeInfo.url) && systemState.activeTradingViewTabId === tabId) {
    systemState.activeTradingViewTabId = null;
    return;
  }
  rememberTradingViewTab(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === systemState.activeTradingViewTabId) {
    systemState.activeTradingViewTabId = null;
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === persistentPopupWindowId) {
    persistentPopupWindowId = null;
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (persistentPopupWindowId === null) return;
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  if (windowId !== persistentPopupWindowId) {
    scheduleForegroundEnforce();
  }
});

// ── INJECTION INITIALE — réinstalle content.js dans tous les tabs TV ouverts ──
// Critique : quand l'extension est rechargée, les content scripts existants deviennent
// orphelins (contexte invalidé). On réinjecte le nouveau content.js immédiatement
// pour rétablir le flux live sans que l'utilisateur ait besoin de recharger TV.
async function injectContentScriptInAllTvTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://*.tradingview.com/*' });
    for (const tab of tabs) {
      if (!tab.id || tab.id < 0) continue;
      try {
        // Test si content script répond — s'il répond OK, pas besoin de réinjecter
        const pong = await Promise.race([
          chrome.tabs.sendMessage(tab.id, { type: 'PING' }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 500))
        ]);
        if (pong && pong.ok) {
          console.log('[BG] Content script actif dans tab', tab.id, '— pas de réinjection nécessaire');
          continue;
        }
      } catch (_) {
        // Pas de réponse ou contexte mort → réinjecter
      }
      await reInjectContentScript(tab.id);
    }
  } catch (e) {
    console.log('[BG] injectContentScriptInAllTvTabs error:', e.message);
  }
}

// ── AUTO-RECONNECT WATCHDOG — rétablit le bridge sans intervention de l'utilisateur ──
// Problème: si le scrape n'envoie pas de prix depuis >35s, le bridge est "coupé".
// Solution: toutes les 30s, vérifier si un tab TV est ouvert et le contenu script actif.
//           Si le script est mort → réinjecter. Si pas de tab → ouvrir TradingView.
let _lastSuccessfulScrap = Date.now();
let _watchdogRunning = false;

async function watchdogReconnect() {
  if (_watchdogRunning) return;
  _watchdogRunning = true;
  try {
    const staleMs = Date.now() - _lastSuccessfulScrap;
    if (staleMs < 35000) { _watchdogRunning = false; return; } // bridge OK
    console.warn('[WATCHDOG] Bridge coupé depuis', Math.round(staleMs/1000) + 's — tentative reconnexion');
    // 1. Chercher tab TradingView ouvert
    const tvTabs = await chrome.tabs.query({ url: 'https://*.tradingview.com/*' });
    if (tvTabs.length === 0) {
      // Aucun tab TV → ouvrir TradingView dans un nouvel onglet
      console.log('[WATCHDOG] Aucun tab TradingView — ouverture automatique');
      chrome.tabs.create({ url: 'https://www.tradingview.com/chart/', active: false });
      _watchdogRunning = false; return;
    }
    // 2. Tab trouvé — vérifier si content script actif
    for (const tab of tvTabs) {
      if (!tab.id || tab.id < 0) continue;
      try {
        const pong = await Promise.race([
          chrome.tabs.sendMessage(tab.id, { type: 'PING' }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('to')), 800))
        ]);
        if (pong && pong.ok) {
          // Content script OK — forcer un scrap immédiat
          console.log('[WATCHDOG] Content script actif — forçage scrap');
          scrapAndSendTradingView().catch(() => {});
          _watchdogRunning = false; return;
        }
      } catch (_) {}
      // Content script mort → réinjecter
      console.warn('[WATCHDOG] Réinjection content.js dans tab', tab.id);
      await reInjectContentScript(tab.id);
    }
  } catch (e) {
    console.warn('[WATCHDOG] Erreur:', e.message);
  }
  _watchdogRunning = false;
}

// ── AUTO SCAN ADAPTATIF — M1/M5/M15/H1 en permanence ────────────────────
// Logique trader PRO :
//   PHASE 1 : H1 + M15 → contexte  (scan 15min)
//   PHASE 2 : M15 + M5 → zone      (scan 5min si approche)
//   PHASE 3 : M1       → entrée    (scan 60s si dans la zone)
let _autoScanLastAt = 0;

function _getAutoScanDelayMs() {
  const snap = systemState.lastSnapshot || {};
  // En zone (support/résistance/liquidité) → scan M1 chaque minute
  const inZone = !!(snap.inBot || snap.inTop || snap.zoneLiqHaute || snap.zoneLiqBasse
                   || snap.bullRej || snap.bearRej);
  if (inZone) return 60 * 1000;
  // Approche zone : dominance directionnelle > 50%
  const approaching = (Number(snap.macroBull || 0) > 50 || Number(snap.macroBear || 0) > 50
                      || Number(snap.scoreTech3 || snap.scoreTech4 || 0) >= 50);
  if (approaching) return 5 * 60 * 1000;
  // Hors zone : re-check H1+M15 toutes les 15min
  return 15 * 60 * 1000;
}

function tickAutoScan() {
  const delay = _getAutoScanDelayMs();
  if (Date.now() - _autoScanLastAt < delay) return;
  if (!systemState.activeSymbol || !systemState.activePrice) return;
  _autoScanLastAt = Date.now();
  console.log('[ADEL] AUTO SCAN TF — délai', Math.round(delay / 60000) + 'min | symbole:', systemState.activeSymbol);
  scanAllTimeframes().catch(() => {});
}

// ── START POLLING ────────────────────────────────────────────────────────
function startPolling() {
  console.log('[BG] v3.2 polling started');

  injectContentScriptInAllTvTabs().catch(() => {});

  // Exécution immédiate au démarrage
  pollBackendState();
  scrapAndSendTradingView();

  // setInterval pour les cycles intra-seconde (tant que le SW est vivant)
  setInterval(pollBackendState, POLL_INTERVAL);
  setInterval(scrapAndSendTradingView, SCRAPE_INTERVAL);

  // APEX command poll — via alarm uniquement (évite doublon setInterval + alarm)
  // Implémenté dans chrome.alarms.onAlarm.addListener sous 'apex-poll'

  // Auto-scan adaptatif — vérifie toutes les 30s si un scan est dû
  setInterval(tickAutoScan, 30 * 1000);
  // Premier scan au démarrage après 8s (laisser le scrape initial s'établir)
  setTimeout(function() {
    if (systemState.activeSymbol && systemState.activePrice) {
      console.log('[ADEL] AUTO SCAN INIT — premier scan M1/M5/M15/H1');
      _autoScanLastAt = Date.now();
      scanAllTimeframes().catch(() => {});
    }
  }, 8000);

  // ── ALARMS MV3 — persistent même si le service worker est tué par Chrome ──
  chrome.alarms.create('scrape-tv',    { periodInMinutes: 1 });
  chrome.alarms.create('watchdog',     { periodInMinutes: 1 });
  chrome.alarms.create('poll-backend', { periodInMinutes: 1 });
  chrome.alarms.create('auto-scan-tf', { periodInMinutes: 1 });
  chrome.alarms.create('apex-poll',    { periodInMinutes: 1 }); // APEX commandes serveur → extension
}

// ── ALARM LISTENER — réveille le service worker et exécute les tâches ─────
chrome.alarms.onAlarm.addListener(function(alarm) {
  if (alarm.name === 'scrape-tv') {
    scrapAndSendTradingView().catch(() => {});
    const _ageMs = Date.now() - _lastSuccessfulScrap;
    if (_ageMs > 60000) {
      findTradingViewTab().then(tab => {
        if (tab && tab.id) reInjectContentScript(tab.id).catch(() => {});
      }).catch(() => {});
    }
  }
  if (alarm.name === 'watchdog') {
    watchdogReconnect().catch(() => {});
  }
  if (alarm.name === 'poll-backend') {
    pollBackendState().catch(() => {});
  }
  if (alarm.name === 'auto-scan-tf') {
    tickAutoScan();
  }
  if (alarm.name === 'apex-poll') {
    // Exécute les commandes SWITCH_TF envoyées par le serveur via /apex/commands/next
    (async () => {
      try {
        const r = await fetch(API + '/apex/commands/next', { signal: AbortSignal.timeout(3000) });
        if (!r.ok) return;
        let d; try { d = await r.json(); } catch(_) { return; }
        if (!d || !d.command) return;
        const cmd = d.command;
        if (cmd.action === 'SWITCH_TF') {
          const tabId = systemState.activeTradingViewTabId;
          if (!tabId) return;
          try {
            const result = await chrome.tabs.sendMessage(tabId, { type: 'SWITCH_TF', tf: cmd.tf });
            await fetch(API + '/apex/result', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'SWITCH_TF', tf: cmd.tf, result, symbol: systemState.activeSymbol })
            }).catch(() => {});
          } catch(_) {}
        }
      } catch(_) {}
    })();
  }
});

// ── INIT ──────────────────────────────────────────────────────────────────
console.log('[BG] v3.2 init — Bridge TV Architecture + Alarms');
hydratePersistentState().finally(startPolling);
