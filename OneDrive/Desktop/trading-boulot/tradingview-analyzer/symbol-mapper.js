// symbol-mapper.js v2.0 — Mapping intelligent Bridge TV uniquement
var SymbolMapper = (function () {
  'use strict';

  var API = 'http://127.0.0.1:4000';
  var _mappings = {};
  var _candidates = [];

  function loadMappings(cb) {
    fetch(API + '/mapping/list', { signal: AbortSignal.timeout(3000) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.ok) { _mappings = d.mappings || {}; } if (cb) cb(_mappings); })
      .catch(function () { if (cb) cb(_mappings); });
  }

  function saveMapping(alias, tvSymbol, cb) {
    fetch(API + '/mapping/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userInput: alias, tvSymbol: tvSymbol }),
      signal: AbortSignal.timeout(3000)
    })
    .then(function (r) { return r.json(); })
    .then(function (d) { if (d.ok) _mappings[alias.toUpperCase()] = tvSymbol; if (cb) cb(d); })
    .catch(function (e) { if (cb) cb({ ok: false, error: e.message }); });
  }

  function resolve(alias) {
    if (!alias) return null;
    var k = alias.toUpperCase();
    if (_mappings[k]) return _mappings[k];
    var COMMON = { GOLD:'XAUUSD', SILVER:'XAGUSD', XAU:'XAUUSD', XAG:'XAGUSD',
                   BTC:'BTCUSD', ETH:'ETHUSD', OIL:'USOIL', NAS:'NAS100', DOW:'US30', SP500:'US500' };
    return COMMON[k] || k;
  }

  function search(query, price, cb) {
    fetch(API + '/mapping/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: query || '', price: price || null }),
      signal: AbortSignal.timeout(5000)
    })
    .then(function (r) { return r.json(); })
    .then(function (d) { _candidates = d.suggestions || []; if (cb) cb(_candidates, 'bridge'); })
    .catch(function () { if (cb) cb([], 'error'); });
  }

  function getBridgeStatus(cb) {
    fetch(API + '/health', { signal: AbortSignal.timeout(3000) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (cb) cb({ ok: d.ok, connected: !!d.ok }); })
      .catch(function (e) { if (cb) cb({ ok: false, connected: false, error: e.message }); });
  }

  function getPrice(symbol, cb) {
    fetch(API + '/tradingview/live?symbol=' + encodeURIComponent(symbol), { signal: AbortSignal.timeout(3000) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (cb) cb(d); })
      .catch(function (e) { if (cb) cb({ ok: false, error: e.message }); });
  }

  function getKlines(symbol, tf, count, cb) {
    var url = API + '/klines?symbol=' + encodeURIComponent(symbol) + '&tf=' + encodeURIComponent(tf || 'H1') + '&limit=' + (count || 200);
    fetch(url, { signal: AbortSignal.timeout(8000) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (cb) cb(d); })
      .catch(function (e) { if (cb) cb({ ok: false, error: e.message }); });
  }

  return {
    loadMappings: loadMappings,
    saveMapping:  saveMapping,
    resolve:      resolve,
    search:       search,
    getPrice:     getPrice,
    getKlines:    getKlines,
    getBridgeStatus: getBridgeStatus,
    getMappings:  function () { return _mappings; },
    getCandidates: function () { return _candidates; }
  };
})();
