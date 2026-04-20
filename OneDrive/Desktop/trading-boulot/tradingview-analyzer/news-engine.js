// news-engine.js v2.0 — News économiques, biais directionnel, score de confiance
var NewsEngine = (function () {
  'use strict';

  var _cache = null;
  var _cacheTs = 0;
  var TTL = 5 * 60 * 1000;

  var IMPACT_COL = { High: '#ef4444', Medium: '#f59e0b', Low: '#64748b' };

  // ── Mapping devise/pays → symboles affectés ──────────────────────────────────
  var ASSET_MAP = {
    USD:    ['XAUUSD','XAGUSD','NAS100','US30','US500','EURUSD','GBPUSD','USDJPY','USDCAD','USDCHF','NZDUSD','AUDUSD','BTCUSD'],
    EUR:    ['EURUSD','EURGBP','EURJPY'],
    GBP:    ['GBPUSD','GBPJPY','EURGBP'],
    JPY:    ['USDJPY','EURJPY','GBPJPY'],
    CAD:    ['USDCAD'],
    AUD:    ['AUDUSD'],
    NZD:    ['NZDUSD'],
    CHF:    ['USDCHF'],
    GOLD:   ['XAUUSD'],
    SILVER: ['XAGUSD'],
    CNY:    ['XAUUSD']
  };

  // Mots-clés titre → symbole (fallback quand country ne matche pas directement)
  var SYMBOL_KEYWORDS = {
    XAUUSD: ['gold','bullion','fed','federal reserve','inflation','cpi','pce','nfp','payroll','geopolit','ukraine','middle east','china','dollar','dxy','rate'],
    XAGUSD: ['silver','gold','fed','inflation','cpi'],
    NAS100: ['nasdaq','tech','fed','rate','gdp','employment','payroll'],
    US30:   ['dow','fed','rate','gdp','employment'],
    US500:  ['s&p','sp500','fed','rate','gdp','employment','payroll'],
    EURUSD: ['ecb','euro','europe','eurozone','german','france','inflation'],
    GBPUSD: ['boe','bank of england','uk','britain','sterling'],
    USDJPY: ['boj','bank of japan','japan','yen'],
    BTCUSD: ['crypto','bitcoin','btc','fed','rate','inflation']
  };

  // ── Parsing numérique (supprime %, k, K, m, M, b, B, virgules) ───────────────
  function parseNumeric(s) {
    if (!s) return null;
    var n = parseFloat(String(s).replace(/[%kKmMbB,\+]/g, ''));
    return isNaN(n) ? null : n;
  }

  // ── Inférence du biais directionnel à partir de forecast vs previous ─────────
  function inferBias(event) {
    var fc = parseNumeric(event.forecast);
    var pr = parseNumeric(event.previous);
    var ac = parseNumeric(event.actual);

    // Post-news : actual vs forecast
    if (ac !== null && fc !== null) {
      var surprise = ac - fc;
      if (Math.abs(surprise) < 0.01) {
        return { direction: 'NEUTRAL', magnitude: 20, confidence: 60 };
      }
      return {
        direction:  surprise > 0 ? 'BULLISH_USD' : 'BEARISH_USD',
        magnitude:  Math.min(100, Math.abs(surprise) * 10),
        confidence: 75
      };
    }

    // Pre-news : forecast vs previous
    if (fc !== null && pr !== null) {
      var delta = fc - pr;
      if (Math.abs(delta) < 0.01) {
        return { direction: 'NEUTRAL', magnitude: 15, confidence: 40 };
      }
      return {
        direction:  delta > 0 ? 'BULLISH_USD' : 'BEARISH_USD',
        magnitude:  Math.min(80, Math.abs(delta) * 10),
        confidence: 45
      };
    }

    return { direction: 'UNCERTAIN', magnitude: 10, confidence: 20 };
  }

  // ── Score d'impact en étoiles (1-5) ─────────────────────────────────────────
  function impactStars(event) {
    if (event.impact === 'High')   return 5;
    if (event.impact === 'Medium') return 3;
    return 1;
  }

  // ── Pertinence d'un événement pour un symbole donné ──────────────────────────
  function isRelevant(event, symbol) {
    if (!symbol) return true;

    // 1. Vérification via ASSET_MAP (pays de l'événement)
    var country = (event.country || '').toUpperCase();
    if (ASSET_MAP[country] && ASSET_MAP[country].indexOf(symbol) !== -1) {
      return true;
    }

    // 2. Vérification via mots-clés dans le titre
    var keywords = SYMBOL_KEYWORDS[symbol];
    if (keywords) {
      var title = (event.title || event.name || '').toLowerCase();
      for (var i = 0; i < keywords.length; i++) {
        if (title.indexOf(keywords[i]) !== -1) return true;
      }
    }

    return false;
  }

  // ── Parsing du timestamp ─────────────────────────────────────────────────────
  function parseTs(e) {
    // ForexFactory: date "04-01-2026", time "8:30am"
    try {
      if (!e.date) return null;
      // Try ISO first
      if (e.date.includes('T')) return new Date(e.date).getTime();
      // MM-DD-YYYY + time
      var parts = e.date.split('-');
      var timeStr = (e.time || '12:00am').replace(/[^0-9:apm]/gi, '');
      var dateStr = parts[0] + '/' + parts[1] + '/' + parts[2] + ' ' + timeStr;
      var d = new Date(dateStr);
      return isNaN(d) ? null : d.getTime();
    } catch (_) { return null; }
  }

  // ── Label temps lisible ──────────────────────────────────────────────────────
  function timeLabel(minsUntil) {
    if (minsUntil === null) return '';
    if (minsUntil < 0) return 'Il y a ' + Math.abs(minsUntil) + 'min';
    if (minsUntil < 1) return 'Maintenant';
    if (minsUntil < 60) return 'Dans ' + minsUntil + 'min';
    return 'Dans ' + Math.floor(minsUntil / 60) + 'h' + (minsUntil % 60 ? (minsUntil % 60) + 'm' : '');
  }

  // ── Fetch avec cache ─────────────────────────────────────────────────────────
  async function fetchNews() {
    var now = Date.now();
    if (_cache && (now - _cacheTs) < TTL) return _cache;
    try {
      var r = await fetch('http://127.0.0.1:4000/economic-events', { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        var d = await r.json();
        if (d.ok && d.events && d.events.length) {
          _cache = d.events;
          _cacheTs = now;
          return _cache;
        }
      }
    } catch (_) {}
    return _cache || [];
  }

  // ── API principale : événements filtrés par symbole ──────────────────────────
  async function getUpcoming(symbol) {
    var all = await fetchNews();
    var now = Date.now();
    return all
      .filter(function (e) {
        var ts = parseTs(e);
        if (!ts) return false;
        var diff = (ts - now) / 60000;
        if (diff <= -60 || diff >= 24 * 60) return false;
        // Filtrage par symbole
        return isRelevant(e, symbol);
      })
      .map(function (e) {
        var ts = parseTs(e);
        var minsUntil = ts ? Math.round((ts - now) / 60000) : null;
        return {
          title:     e.title || e.name || '?',
          country:   e.country || '?',
          impact:    e.impact || 'Low',
          time:      e.time || '',
          date:      e.date || '',
          forecast:  e.forecast || null,
          previous:  e.previous || null,
          actual:    e.actual   || null,
          minsUntil: minsUntil,
          timeLabel: timeLabel(minsUntil),
          stars:     impactStars(e),
          bias:      inferBias(e),
          isRecent:  minsUntil !== null && minsUntil < 0 && minsUntil > -60,
          isSoon:    minsUntil !== null && minsUntil >= 0 && minsUntil < 60
        };
      })
      .sort(function (a, b) {
        var da = a.minsUntil === null ? 9999 : a.minsUntil;
        var db = b.minsUntil === null ? 9999 : b.minsUntil;
        return da - db;
      })
      .slice(0, 10);
  }

  return {
    getUpcoming:  getUpcoming,
    inferBias:    inferBias,
    impactStars:  impactStars,
    isRelevant:   isRelevant,
    IMPACT_COL:   IMPACT_COL,
    ASSET_MAP:    ASSET_MAP,
    SYMBOL_KEYWORDS: SYMBOL_KEYWORDS
  };
})();
