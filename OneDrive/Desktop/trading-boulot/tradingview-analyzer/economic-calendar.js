// economic-calendar.js — Agenda économique temps réel
// Récupère et analyse les événements économiques importants
var EconomicCalendar = (function () {
  'use strict';

  var _cache = null;
  var _cacheTTL = 5 * 60 * 1000;  // 5 min cache
  var _lastUpdate = 0;
  var _apiBase = 'http://127.0.0.1:4000';

  // Impact levels and colors
  var IMPACT = {
    'HIGH': { color: '#ef4444', label: 'High', FR: 'Haut' },
    'MEDIUM': { color: '#f59e0b', label: 'Medium', FR: 'Moyen' },
    'LOW': { color: '#64748b', label: 'Low', FR: 'Faible' }
  };

  // Asset mappings for events
  var ASSET_MAP = {
    'US': ['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USD', 'SPY', 'NAS100', 'USDJPY'],
    'EUR': ['EURUSD', 'EURGBP', 'EURJPY', 'EURCHF', 'EUR'],
    'GBP': ['GBPUSD', 'EURGBP', 'GBPJPY', 'GBP'],
    'JPY': ['USDJPY', 'EURJPY', 'GBPJPY', 'JPY'],
    'CHF': ['EURCHF', 'CHF'],
    'CAD': ['USDCAD', 'CAD'],
    'AUD': ['AUDUSD', 'AUDJPY', 'EURAUD', 'AUD'],
    'NZD': ['NZDUSD', 'NZDJPY', 'EURNZD', 'NZD'],
    'GOLD': ['XAUUSD', 'GOLD'],
    'SILVER': ['XAGUSD', 'SILVER'],
    'OIL': ['CRUDE', 'OIL', 'BRENT'],
    'CRYPTO': ['BTCUSD', 'ETHUSD', 'BTC', 'ETH'],
    'STOCKS': ['SPY', 'NAS100', 'DAX', 'FTSE']
  };

  function impactLevel(event) {
    if (!event) return 'LOW';
    var title = (event.title || '').toUpperCase();
    var importance = event.importance || event.impact || 'low';
    
    // High impact keywords
    if (importance.toUpperCase() === 'HIGH' ||
        title.includes('FED') || title.includes('ECB') ||
        title.includes('BOJ') || title.includes('FOMC') ||
        title.includes('GDP') || title.includes('NFP') ||
        title.includes('CPI') || title.includes('INFLATION') ||
        title.includes('INTEREST RATE')) {
      return 'HIGH';
    }
    
    if (importance.toUpperCase() === 'MEDIUM' ||
        title.includes('PMI') || title.includes('RETAIL') ||
        title.includes('UNEMPLOYMENT') || title.includes('WAGE')) {
      return 'MEDIUM';
    }
    
    return 'LOW';
  }

  function getAffectedAssets(event) {
    var title = (event.title || '').toUpperCase();
    var country = event.country || '';
    var affected = [];

    // Country mapping
    var countryMap = {
      'US': 'US', 'USA': 'US', 'UNITED STATES': 'US',
      'EUR': 'EUR', 'EU': 'EUR', 'EUROZONE': 'EUR',
      'UK': 'GBP', 'UNITED KINGDOM': 'GBP',
      'JPN': 'JPY', 'JAPAN': 'JPY',
      'CH': 'CHF', 'SWISS': 'CHF',
      'CA': 'CAD', 'CANADA': 'CAD',
      'AU': 'AUD', 'AUSTRALIA': 'AUD',
      'NZ': 'NZD', 'NEW ZEALAND': 'NZD'
    };

    // Detect country
    var key = null;
    for (var k in countryMap) {
      if (country.includes(k) || title.includes(k)) {
        key = countryMap[k];
        break;
      }
    }

    // Gold/Oil/Crypto events
    if (title.includes('GOLD') || title.includes('PRECIOUS')) affected.push('GOLD');
    if (title.includes('OIL') || title.includes('CRUDE') || title.includes('ENERGY')) affected.push('OIL');
    if (title.includes('BTC') || title.includes('CRYPTO') || title.includes('BITCOIN')) affected.push('CRYPTO');

    // Add country assets
    if (key && ASSET_MAP[key]) {
      affected = affected.concat(ASSET_MAP[key]);
    }

    return affected;
  }

  function inferBias(event, symbol) {
    var title = (event.title || '').toUpperCase();
    var result = '?';
    var forecast = event.forecast || null;
    var previous = event.previous || null;

    // Simple bias logic
    if (title.includes('CPI') || title.includes('INFLATION')) {
      result = forecast && forecast > previous ? 'UP bullish USD' : 'DOWN USD bearish';
    } else if (title.includes('NFP') || title.includes('EMPLOYMENT')) {
      result = forecast && forecast > previous ? 'UP bullish USD' : 'DOWN USD bearish';
    } else if (title.includes('GDP')) {
      result = forecast && forecast > previous ? 'Bullish' : 'Bearish';
    } else if (title.includes('FED') || title.includes('RATE')) {
      result = 'Volatility expected';
    }

    return result;
  }

  function fetchFromBackend() {
    return fetch(_apiBase + '/economic-events', {
      signal: AbortSignal.timeout(5000)
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok && d.events) {
        _cache = d.events;
        _lastUpdate = Date.now();
        return d.events;
      }
      return null;
    })
    .catch(function(err) {
      console.log('[CALENDAR] Fetch error:', err.message);
      return null;
    });
  }

  function getUpcoming(symbol, hoursAhead) {
    hoursAhead = hoursAhead || 48;
    var now = Date.now();
    var deadline = now + (hoursAhead * 60 * 60 * 1000);

    // Check cache
    if (_cache && (now - _lastUpdate) < _cacheTTL) {
      return Promise.resolve(processEvents(_cache, symbol, deadline));
    }

    // Fetch from backend
    return fetchFromBackend().then(function(events) {
      return processEvents(events || [], symbol, deadline);
    });
  }

  function processEvents(events, symbol, deadline) {
    if (!events || !Array.isArray(events)) return [];

    var now = Date.now();
    return events
      .map(function(e) {
        var eventTime = new Date(e.time || e.dateTime).getTime();
        var minsUntil = Math.round((eventTime - now) / 60000);
        var affected = getAffectedAssets(e);
        var isRelevant = !symbol || affected.some(function(a) {
          return symbol.includes(a);
        });

        return {
          title: e.title || e.event || 'Unknown',
          country: e.country || '',
          time: e.time || e.dateTime,
          minsUntil: minsUntil,
          deadline: eventTime,
          importance: impactLevel(e),
          impact: IMPACT[impactLevel(e)].FR,
          color: IMPACT[impactLevel(e)].color,
          forecast: e.forecast,
          previous: e.previous,
          actual: e.actual,
          bias: inferBias(e, symbol),
          affected: affected,
          isRelevant: isRelevant,
          timeLabel: formatTime(minsUntil),
          isSoon: minsUntil >= 0 && minsUntil < 60,
          isRecent: minsUntil >= 1440 - 60 && minsUntil < 1440,
          isPast: minsUntil < 0
        };
      })
      .filter(function(e) { return !e.isPast && e.deadline <= deadline; })
      .sort(function(a, b) { return a.minsUntil - b.minsUntil; });
  }

  function formatTime(mins) {
    if (mins < 0) return 'Passed';
    if (mins < 1) return 'Now';
    if (mins < 60) return mins + 'min';
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    return h + 'h' + (m ? m + 'm' : '');
  }

  // Manual cache update
  function refresh() {
    _lastUpdate = 0;
    return fetchFromBackend();
  }

  return {
    getUpcoming: getUpcoming,
    refresh: refresh,
    IMPACT: IMPACT,
    formatTime: formatTime
  };
})();
