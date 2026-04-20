// market-session.js v2.0 — Sessions marché, horaires exacts, volatilité
var MarketSession = (function () {
  'use strict';

  // Sessions UTC [openH, openM, closeH, closeM] — VRAIES HEURES depuis Internet
  // Forex 24h/5 (dim 22h UTC → ven 22h UTC) / Métaux (GOLD) = même horaires forex
  var S = {
    'Sydney':    [21, 0,  6, 0],      // 21:00 dim-jeu → 06:00 UTC (8h Asia)
    'Tokyo':     [23, 0,  8, 0],      // 23:00-08:00 UTC (9h Asia) — NE FERME PAS
    'Londres':   [7,  0,  16, 0],     // 07:00-16:00 UTC (9h europé full hours)
    'Frankfurt': [7,  30, 16, 30],    // 07:30-16:30 UTC (9h DAX open+30min)
    'New York':  [13, 30, 22, 0]      // 13:30-22:00 UTC = 8:30-17:00 ET (equity cash)
  };

  // FOREX SESSIONS SUPERPOSÉES pour volatilité
  var FOREX_OVERLAPS = {
    'London-Frankfurt': [7, 0, 8, 0],    // Overlaps maximale
    'Tokyo-Sydney': [23, 0, 6, 0],       // Asian night (volatilité haute)
    'London-NewYork': [13, 30, 16, 0]    // NY preopen overlap (très volatile)
  };

  // US Equity Hours (special - WEEKDAYS ONLY - fermé weekends)
  var US_EQUITY = {
    'Pré-ouverture': [12, 0,  13, 30],   // 08:00-09:30 ET = 12:00-13:30 UTC (weekdays)
    'Ouverture Cash': [13, 30, 20, 0],   // 09:30-16:00 ET = 13:30-20:00 UTC (MAIN)
    'After-Hours': [20, 0,  21, 0]       // 16:00-17:00 ET = 20:00-21:00 UTC (court)
  };

  // Key events UTC [h, m, name]
  var KEY_EVENTS = [
    // Asian
    { h:21, m:0,  name: 'Sydney Ouverture' },
    { h:23, m:0,  name: 'Tokyo Ouverture' },
    // European  
    { h:7,  m:0,  name: 'Londres Ouverture' },
    { h:8,  m:0,  name: 'Frankfurt Ouverture' },
    // American
    { h:12, m:0,  name: 'Pré-Marché US' },
    { h:13, m:30, name: 'Cash US Ouverture (9:30 ET)' },
    { h:20, m:0,  name: 'Cash US Fermeture (16:00 ET)' },
    { h:20, m:30, name: 'After-Hours Début' },
    // Closes
    { h:6,  m:0,  name: 'Sydney Fermeture' },
    { h:8,  m:0,  name: 'Tokyo Fermeture' },
    { h:16, m:0,  name: 'Londres Fermeture' }
  ];

  function nowMin() {
    var d = new Date();
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }

  function toMin(h, m) {
    return h * 60 + m;
  }

  function active(oH, oM, cH, cM) {
    var t = nowMin();
    var open = toMin(oH, oM);
    var close = toMin(cH, cM);
    if (open > close) return t >= open || t < close;  // crosses midnight
    return t >= open && t < close;
  }

  function minsUntil(h, m) {
    var diff = toMin(h, m) - nowMin();
    if (diff < 0) diff += 1440;  // add 24h if passed
    return diff;
  }

  function fmt(mins) {
    if (mins < 1)  return 'maintenant';
    if (mins < 60) return mins + 'min';
    var h = Math.floor(mins / 60), r = mins % 60;
    return h + 'h' + (r ? r + 'm' : '');
  }

  function getSessions() {
    return Object.keys(S).map(function(name) {
      var o = S[name];
      var oH = o[0], oM = o[1], cH = o[2], cM = o[3];
      var on = active(oH, oM, cH, cM);
      var closeMin = on ? minsUntil(cH, cM) : null;
      var openMin = on ? null : minsUntil(oH, oM);
      
      return {
        name: name,
        open: on,
        closesIn: closeMin,
        opensIn: openMin,
        closesInFormatted: closeMin ? fmt(closeMin) : null,
        opensInFormatted: openMin ? fmt(openMin) : null
      };
    });
  }

  function getUSEquitySessions() {
    return Object.keys(US_EQUITY).map(function(name) {
      var o = US_EQUITY[name];
      var oH = o[0], oM = o[1], cH = o[2], cM = o[3];
      var on = active(oH, oM, cH, cM);
      var closeMin = on ? minsUntil(cH, cM) : null;
      var openMin = on ? null : minsUntil(oH, oM);
      
      return {
        name: name,
        open: on,
        closesIn: closeMin,
        opensIn: openMin,
        closesInStatus: on ? ('ferme ' + fmt(closeMin)) : null,
        opensInStatus: on ? null : ('ouvre ' + fmt(openMin))
      };
    });
  }

  function getUpcoming() {
    var now = nowMin();
    return KEY_EVENTS
      .map(function(e) {
        var m = minsUntil(e.h, e.m);
        return {
          name: e.name,
          minsUntil: m,
          label: fmt(m),
          isSoon: m >= 0 && m < 60,
          isRecent: m >= 1440 - 60 && m < 1440
        };
      })
      .filter(function(e) { return e.minsUntil >= 0 && e.minsUntil < 1440; })  // 24h window
      .sort(function(a, b) { return a.minsUntil - b.minsUntil; })
      .slice(0, 12);  // Top 12 upcoming
  }

  function getVolatility() {
    var t = nowMin();
    var inNY = t >= 780 && t < 1260;   // 13:00-21:00 UTC = 08:00-16:00 ET
    var inLondon = t >= 420 && t < 960;  // 07:00-16:00 UTC
    var overlap = t >= 780 && t < 960;  // 13:00-16:00 UTC = London/NY overlap
    
    if (overlap) return 'TRÈS FORTE';
    if (inNY) return 'FORTE';
    if (inLondon) return 'FORTE';
    return 'FAIBLE';
  }

  function isOverlap() {
    var t = nowMin();
    return t >= 780 && t < 960;  // 13:00-16:00 UTC
  }

  return {
    getSessions: getSessions,
    getUSEquitySessions: getUSEquitySessions,
    getUpcoming: getUpcoming,
    getVolatility: getVolatility,
    isOverlap: isOverlap,
    fmt: fmt,
    minsUntil: minsUntil
  };
})();
