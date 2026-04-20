// content.js v4.2 — TradingView Real Panel Scraper (Dynamic Symbol Detection)
// Lit le panneau réel du graphique TradingView et extrait les données brutes
'use strict';

(() => {
  // Log explicit injection
  console.log('[TV] injecté : content.js chargé dans TradingView');
  let isAlive = true;

  function cleanup() {
    console.log('[CONTENT] v4.2 cleanup');
    isAlive = false;
  }

  // MAP canonique synchronisée avec lib/symbol-normalizer.js (SA-C)
  const SYMBOL_MAP = {
    // Metals
    'XAUUSD.A': 'XAUUSD', 'GOLDMICRO': 'XAUUSD', 'GOLD': 'XAUUSD', 'XAU/USD': 'XAUUSD',
    'XAUUSD': 'XAUUSD', 'XAU': 'XAUUSD',
    'XAGUSD': 'XAGUSD', 'SILVER': 'XAGUSD', 'XAG/USD': 'XAGUSD', 'XAG': 'XAGUSD',
    // Indices
    'NAS100': 'NAS100', 'NDX': 'NAS100', 'NASDAQ': 'NAS100', 'US100': 'NAS100',
    'US500': 'US500', 'SPX': 'US500', 'SP500': 'US500', 'S&P500': 'US500',
    'US30': 'US30', 'DJI': 'US30', 'DOW': 'US30',
    'DE40': 'DE40', 'DAX': 'DE40', 'GER40': 'DE40',
    // Crypto
    'BTCUSD': 'BTCUSD', 'BTC/USD': 'BTCUSD', 'BTC-USD': 'BTCUSD', 'BITCOIN': 'BTCUSD',
    'ETHUSD': 'ETHUSD', 'ETH/USD': 'ETHUSD', 'ETH-USD': 'ETHUSD',
    // Forex (variantes communes avec séparateur)
    'EUR/USD': 'EURUSD', 'EURUSD': 'EURUSD',
    'GBP/USD': 'GBPUSD', 'GBPUSD': 'GBPUSD',
    'USD/JPY': 'USDJPY', 'USDJPY': 'USDJPY',
    'AUD/USD': 'AUDUSD', 'AUDUSD': 'AUDUSD',
    'USD/CAD': 'USDCAD', 'USDCAD': 'USDCAD',
    'USD/CHF': 'USDCHF', 'USDCHF': 'USDCHF',
    'NZD/USD': 'NZDUSD', 'NZDUSD': 'NZDUSD',
    'EUR/GBP': 'EURGBP', 'EURGBP': 'EURGBP',
    'EUR/JPY': 'EURJPY', 'EURJPY': 'EURJPY',
    'GBP/JPY': 'GBPJPY', 'GBPJPY': 'GBPJPY'
  };

  function normalizeSymbol(raw) {
    if (!raw) return null;
    // Lookup prioritaire dans la MAP canonique (synchronisé avec symbol-normalizer.js)
    const upper = String(raw).toUpperCase().trim().replace(/\s+/g, '');
    if (SYMBOL_MAP[upper]) return SYMBOL_MAP[upper];
    // Fallback : logique existante
    let value = upper;
    value = value.replace(/^[A-Z0-9_]+:/, '');
    value = value.replace(/[\s/._-]/g, '');
    if (!value || value === 'TRADINGVIEW') return null;
    return value;
  }

  function normalizeTimeframe(raw) {
    if (!raw) return null;
    const value = String(raw).trim().toUpperCase();
    const match = value.match(/^(MN1|W1|D1|H\d{1,2}|M\d{1,2})$/);
    return match ? match[1] : null;
  }

  // Convert TradingView numeric interval to standard TF code.
  // TV uses: 1→M1, 5→M5, 15→M15, 30→M30, 60→H1, 240→H4, D/1D→D1, W/1W→W1, M/1M→MN1
  function numericIntervalToTf(raw) {
    if (raw == null) return null;
    const s = String(raw).trim().toUpperCase();
    if (s === 'D' || s === '1D') return 'D1';
    if (s === 'W' || s === '1W') return 'W1';
    if (s === 'M' || s === '1M') return 'MN1';
    const n = parseInt(s, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n < 60)   return 'M' + n;           // 1→M1, 5→M5, 15→M15, 30→M30
    if (n < 1440) return 'H' + Math.round(n / 60);  // 60→H1, 120→H2, 240→H4
    return 'D1';
  }

  function parsePriceCandidate(raw) {
    if (raw == null) return null;

    let value = String(raw)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!value) return null;

    const matches = value.match(/-?\d[\d\s.,]*/g);
    if (!matches) return null;

    for (const match of matches) {
      let candidate = String(match).replace(/\s+/g, '');
      if (!candidate) continue;

      const hasComma = candidate.includes(',');
      const hasDot = candidate.includes('.');

      if (hasComma && hasDot) {
        if (candidate.lastIndexOf(',') > candidate.lastIndexOf('.')) {
          candidate = candidate.replace(/\./g, '').replace(',', '.');
        } else {
          candidate = candidate.replace(/,/g, '');
        }
      } else if (hasComma) {
        const parts = candidate.split(',');
        if (parts.length === 2 && parts[1].length > 0 && parts[1].length <= 5) {
          candidate = parts[0].replace(/\./g, '') + '.' + parts[1];
        } else {
          candidate = candidate.replace(/,/g, '');
        }
      } else if ((candidate.match(/\./g) || []).length > 1) {
        const parts = candidate.split('.');
        const decimals = parts.pop();
        candidate = parts.join('') + '.' + decimals;
      }

      candidate = candidate.replace(/[^\d.-]/g, '');
      const numeric = Number(candidate);
      if (Number.isFinite(numeric) && numeric > 0 && numeric < 1000000) {
        return numeric;
      }
    }

    return null;
  }

  // Détecte le symbole depuis le titre de la page
  function detectSymbolFromTitle() {
    const title = document.title || '';
    const patterns = [
      /^([^\-|—•]+)\s*[\-|—•]/,
      /\b([A-Z0-9:/.\-_]{2,24})\s*[\-|—•]\s*TRADINGVIEW\b/i,
      /\b([A-Z]{3,6}USD|XAUUSD|XAGUSD|BTCUSD|ETHUSD|US30|NAS100|SPX500|UK100|GER30|JP225|WTIUSD|UKOUSD)\b/i
    ];

    for (const pattern of patterns) {
      const match = title.match(pattern);
      if (match) {
        const symbol = normalizeSymbol(match[1]);
        if (symbol && symbol.length >= 3 && symbol.length <= 12) return symbol;
      }
    }
    return null;
  }

  // Détecte le symbole depuis l'URL (pathname et href)
  // Ex: /chart/XAUUSD → XAUUSD, ?symbol=BTCUSD → BTCUSD
  function detectSymbolFromLocation() {
    try {
      const pathname = window.location.pathname || '';
      const href = window.location.href || '';

      // Cherche dans le pathname: /chart/XAUUSD ou /symbols/NASDAQ-NAS100
      const pathMatch = pathname.match(/\/(?:chart|symbols|ideas)\/([A-Z0-9:.\-_\/]{2,24})/i);
      if (pathMatch) {
        const symbol = normalizeSymbol(pathMatch[1].split('/')[0]);
        if (symbol) return symbol;
      }

      // Cherche dans les query params: ?symbol=XAUUSD ou ?ticker=XAUUSD
      const url = new URL(href);
      const symbolParam = url.searchParams.get('symbol') || url.searchParams.get('ticker');
      if (symbolParam) {
        const symbol = normalizeSymbol(symbolParam);
        if (symbol) return symbol;
      }

      // Cherche un pattern symbole connu dans le href complet
      const hrefMatch = href.match(/[/=]([A-Z]{3,6}USD|XAUUSD|XAGUSD|BTCUSD|ETHUSD|US30|NAS100)[/&?#]?/i);
      if (hrefMatch) {
        const symbol = normalizeSymbol(hrefMatch[1]);
        if (symbol) return symbol;
      }
    } catch (_) {}

    return null;
  }

  // Détecte le symbole depuis les éléments DOM TradingView
  function detectSymbolFromDom() {
    // Sélecteurs ciblant les éléments portant le symbole dans l'interface TradingView
    const selectors = [
      '[data-symbol]',
      '[data-name="legend-source-item"] [data-symbol]',
      'button[id*="header-toolbar-symbol"]',
      '[class*="symbolTitle"][class*="main"]',
      '[data-field="symbol"]',
      // Existants en fallback
      '[class*="symbolTitle"]',
      '[class*="tickerHeadline"]',
      '[class*="ticker"]'
    ];

    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        const raw = node.getAttribute('data-symbol') || node.textContent;
        if (!raw) continue;
        const symbol = normalizeSymbol(raw.trim().split(/[\s,·\-|—]/)[0]);
        if (symbol && symbol.length >= 3 && symbol.length <= 12) return symbol;
      }
    }

    // Fallback: cherche dans le header h1/h2 un symbole connu
    const headers = document.querySelectorAll('h1, h2, [class*="header"]');
    for (const el of headers) {
      const text = el.textContent || '';
      const match = text.match(/\b([A-Z]{3,6}USD|XAUUSD|XAGUSD|BTCUSD|ETHUSD|US30|NAS100)\b/i);
      if (match) {
        const symbol = normalizeSymbol(match[1]);
        if (symbol) return symbol;
      }
    }

    return null;
  }

  function detectTimeframe() {
    const title = document.title || '';
    // 1. Standard format in title: "M15", "H1", "D1", etc.
    const titleMatch = title.match(/\b(MN1|W1|D1|H\d{1,2}|M\d{1,2})\b/i);
    if (titleMatch) return normalizeTimeframe(titleMatch[1]);

    // 2. TV URL interval param (?interval=15 means M15, ?interval=60 means H1)
    try {
      const url = new URL(window.location.href);
      const rawInterval = url.searchParams.get('interval') || url.searchParams.get('tf');
      if (rawInterval) {
        const tf = numericIntervalToTf(rawInterval) || normalizeTimeframe(rawInterval);
        if (tf) return tf;
      }
    } catch (_) {}

    // 3. TV title numeric form: "GOLD, 15 — TradingView" or "XAUUSD · 60 —"
    const numMatch = title.match(/[,·\s]+(\d+)\s*[—\-|]/);
    if (numMatch) {
      const tf = numericIntervalToTf(numMatch[1]);
      if (tf) return tf;
    }

    const selectors = [
      '[data-value][aria-checked="true"]',
      '[data-value][aria-selected="true"]',
      'button[data-value][aria-pressed="true"]',
      'button[data-value][class*="active"]'
    ];

    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const raw = node && node.getAttribute('data-value');
      const tf = normalizeTimeframe(raw) || numericIntervalToTf(raw);
      if (tf) return tf;
    }

    return null;
  }

  function detectPriceFromDom() {
    const selectors = [
      // Data attributes — plus stables que les class names
      '[data-last-price]',
      '[data-symbol-last]',
      '[data-field="last_price"]',
      '[data-field="close"]',
      // Aria — semi-stable
      '[aria-label*="price" i]',
      '[aria-label*="last" i]',
      // Existants (gardés en fallback)
      '[data-field-key="last"]',
      '[data-name="legend-source-item"] [class*="last"]',
      '[class*="lastPrice"]',
      '[class*="priceText"]',
      '[class*="priceWrapper"]',
      '[class*="last-"]',
      '[data-name="legend-source-item"]'
    ];

    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        const price = parsePriceCandidate(
          node.getAttribute('data-last-price') ||
          node.getAttribute('data-symbol-last') ||
          node.getAttribute('data-value') ||
          node.textContent
        );
        if (price) return price;
      }
    }

    return null;
  }

  function detectPriceFromTitle() {
    return parsePriceCandidate(document.title || '');
  }

  function detectLivePrice() {
    const price = detectPriceFromDom() || detectPriceFromTitle();
    if (price !== null && price < 0.5) return null; // rejette prix invalide (<0.5 = artefact du titre)
    return price;
  }

  // ── SCRAP THE REAL TRADINGVIEW PANEL ───────────────────────────────────
  // Extrait les données réellement disponibles dans le DOM natif TradingView
  // Tente de trouver le tickerid complet (ex: OANDA:XAUUSD) depuis le DOM
  // Utilisé par le serveur pour initialiser le widget TradingView avec le bon exchange
  function detectTickerid() {
    // data-symbol peut contenir "OANDA:XAUUSD" sur les éléments du chart header
    const selectors = ['[data-symbol]', '[data-name="legend-source-item"] [data-symbol]'];
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) {
        const raw = node.getAttribute('data-symbol') || '';
        if (raw.includes(':') && raw.length > 3) return raw.trim().toUpperCase();
      }
    }
    return null;
  }

  function scrapeRealPanel() {
    const data = {
      scrapedAt:  new Date().toISOString(),
      symbol:     detectSymbolFromTitle() || detectSymbolFromLocation() || detectSymbolFromDom(),
      timeframe:  detectTimeframe(),
      price:      detectLivePrice(),
      pageTitle:  document.title,
      pageUrl:    location.href,
      tickerid:   detectTickerid(),
      indicators: {},
      legend:     {}
    };

    // 1. Légende du chart (source la plus fiable)
    // [data-name="legend-source-item"] contient: nom indicateur + valeurs OHLC + prix courant
    const legendItems = document.querySelectorAll('[data-name="legend-source-item"]');
    const legendValues = [];
    legendItems.forEach((item, i) => {
      const text = (item.innerText || item.textContent || '').trim();
      if (!text) return;
      // Premier item = données de la bougie principale (OHLC)
      if (i === 0) {
        const nums = text.match(/[\d.,]+/g);
        if (nums && nums.length >= 4) {
          data.legend.raw = text;
          const prices = nums.map(n => parseFloat(n.replace(',','.'))).filter(n => n > 0);
          if (prices.length >= 4) {
            data.legend.open  = prices[0];
            data.legend.high  = prices[1];
            data.legend.low   = prices[2];
            data.legend.close = prices[3];
            // Utiliser close comme prix si detectLivePrice a échoué
            if (!data.price && prices[3] > 0.5) data.price = prices[3];
          }
        }
      } else {
        // Autres items = indicateurs (RSI, MACD, EMA, etc.)
        legendValues.push(text.slice(0, 100));
      }
    });
    if (legendValues.length) data.legend.indicators = legendValues;

    // 2. Indicateurs depuis la légende (RSI, MA, EMA, MACD)
    legendValues.forEach(txt => {
      const upper = txt.toUpperCase();
      const numMatch = txt.match(/[-\d.,]+/);
      const val = numMatch ? parseFloat(numMatch[0].replace(',','.')) : null;
      if (upper.includes('RSI') && val) data.indicators.rsi = val;
      else if ((upper.includes('EMA') || upper.includes('MA(')) && val) data.indicators.ma = val;
      else if (upper.includes('MACD') && val) data.indicators.macd = val;
      else if (upper.includes('ATR') && val) data.indicators.atr = val;
      else if (upper.includes('BB') && val) data.indicators.bb = val;
      else if (upper.includes('STOCH') && val) data.indicators.stoch = val;
      else if (upper.includes('VOL') && val) data.indicators.volume = val;
    });

    // 3. Ask/Bid si disponible (certaines vues TV affichent le spread)
    const askEl = document.querySelector('[class*="ask"], [data-field="ask"]');
    const bidEl = document.querySelector('[class*="bid"], [data-field="bid"]');
    if (askEl) data.ask = parsePriceCandidate(askEl.textContent);
    if (bidEl) data.bid = parsePriceCandidate(bidEl.textContent);

    // 4. Dernier prix de clôture visible dans le DOM (axe Y du chart)
    const priceScaleNums = document.querySelectorAll('[class*="priceAxis"] [class*="label"], [class*="price-axis"] span');
    if (priceScaleNums.length > 0) {
      const scaleVals = Array.from(priceScaleNums)
        .map(el => parsePriceCandidate(el.textContent))
        .filter(v => v && v > 0.5)
        .sort((a,b) => a-b);
      if (scaleVals.length) data.priceScaleRange = { min: scaleVals[0], max: scaleVals[scaleVals.length-1] };
    }

    return data;
  }

  window.addEventListener('pagehide', cleanup, { once: true });

  // ── MESSAGE LISTENER ───────────────────────────────────────────────────
  // Répond aux messages: SCRAP_PANEL, GET_CONTEXT, CAPTURE, PING
  chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
    if (!isAlive) return;

    try {
      if (req.type === 'SCRAP_PANEL') {
        const data = scrapeRealPanel();
        sendResponse({ ok: true, data });
        return;
      }

      if (req.type === 'CAPTURE' || req.type === 'GET_SCREENSHOT') {
        sendResponse({
          ok: true,
          url: location.href,
          title: document.title,
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (req.type === 'GET_CONTEXT') {
        sendResponse({
          url: location.href,
          title: document.title,
          hostname: location.hostname,
          symbol: detectSymbolFromTitle() || detectSymbolFromLocation() || detectSymbolFromDom(),
          timeframe: detectTimeframe(),
          price: detectLivePrice()
        });
        return;
      }

      if (req.type === 'PING') {
        sendResponse({ ok: true });
        return;
      }

      // TOGGLE_PANEL — affiche/masque un badge overlay sur le chart TV
      if (req.type === 'TOGGLE_PANEL') {
        let badge = document.getElementById('_adel_tv_badge');
        if (badge) {
          badge.remove();
          sendResponse({ ok: true, visible: false });
        } else {
          badge = document.createElement('div');
          badge.id = '_adel_tv_badge';
          badge.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99999;background:rgba(34,197,94,0.9);color:#fff;font-size:11px;font-weight:700;padding:4px 10px;border-radius:6px;pointer-events:none;letter-spacing:.5px';
          badge.textContent = '● ADEL LIVE';
          document.body.appendChild(badge);
          sendResponse({ ok: true, visible: true });
        }
        return;
      }

      if (req.type === 'SWITCH_TF') {
        const tfMap = { M1: '1', M5: '5', M15: '15', H1: '60', H4: '240', D1: '1D' };
        const target = tfMap[String(req.tf || '').toUpperCase()];
        if (!target) { sendResponse({ ok: false, reason: 'unknown_tf' }); return; }
        // Try data-value attribute (TradingView header toolbar)
        let btn = document.querySelector(`[data-value="${target}"]`);
        if (!btn) {
          // Fallback: match button text in interval toolbar
          const toolbar = document.querySelector('[data-name="header-toolbar-intervals"]');
          if (toolbar) {
            for (const b of toolbar.querySelectorAll('button,[role="button"]')) {
              if ((b.textContent || '').trim() === target) { btn = b; break; }
            }
          }
        }
        if (btn) {
          btn.click();
          sendResponse({ ok: true, tf: req.tf });
        } else {
          sendResponse({ ok: false, reason: 'btn_not_found', tf: req.tf });
        }
        return;
      }

      sendResponse({ ok: false });
    } catch (_) {
      sendResponse({ ok: false });
    }
  });

  console.log('[CONTENT] v4.2 ready — TradingView context only');
})();
