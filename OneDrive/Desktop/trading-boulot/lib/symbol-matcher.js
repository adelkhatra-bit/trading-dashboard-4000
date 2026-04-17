// ─────────────────────────────────────────────────────────────────────────────
// symbol-matcher.js — Smart Symbol Mapping with Price Tolerance
// Purpose: Map TradingView symbols → Backend sources with price validation
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

/**
 * SYMBOL MAPPING DATABASE
 * For each canonical symbol, lists all possible variants and their data sources
 */
const SYMBOL_VARIANTS = {
  'XAUUSD': {
    canonical: 'XAUUSD',
    type: 'metal',
    primarySource: 'tradingview',
    variants: [
      'XAUUSD', 'XAU/USD', 'XAU.USD', 'XAU-USD',
      'GOLD', 'GOLD1', 'GOLDUSD',
      'XAUUSD.a', 'XAUUSD.b', 'XAUUSD.pro',
      'GOLDmicro', 'GOLDmini', 'GOLD_M',
      'XAUUSD.cash', 'XAUUSD.ecn', 'XAUUSDm',
    ],
    sources: [
      { name: 'tradingview', priority: 1, tolerance: 0.005 }
    ],
    expectedDecimals: 2,
    typicalRange: { min: 1800, max: 2200 }
  },
  'EURUSD': {
    canonical: 'EURUSD',
    type: 'forex',
    primarySource: 'tradingview',
    variants: [
      'EURUSD', 'EUR/USD', 'EUR.USD', 'EUR-USD',
      'EURUSD.a', 'EURUSD.b', 'EURUSD.pro',
      'EURUSDmicro', 'EURUSDmini',
    ],
    sources: [
      { name: 'tradingview', priority: 1, tolerance: 0.003 }
    ],
    expectedDecimals: 5,
    typicalRange: { min: 0.9, max: 1.1 }
  },
  'GBPUSD': {
    canonical: 'GBPUSD',
    type: 'forex',
    primarySource: 'tradingview',
    variants: [
      'GBPUSD', 'GBP/USD', 'GBP.USD', 'GBP-USD',
      'GBPUSD.a', 'GBPUSD.b',
      'GBPUSDmicro', 'GBPUSDmini',
    ],
    sources: [
      { name: 'tradingview', priority: 1, tolerance: 0.003 }
    ],
    expectedDecimals: 5,
    typicalRange: { min: 1.1, max: 1.4 }
  },
  'USDJPY': {
    canonical: 'USDJPY',
    type: 'forex',
    primarySource: 'tradingview',
    variants: [
      'USDJPY', 'USD/JPY', 'USD.JPY', 'USD-JPY',
      'USDJPY.a', 'USDJPY.b',
      'USDJPYmicro',
    ],
    sources: [
      { name: 'tradingview', priority: 1, tolerance: 0.004 }
    ],
    expectedDecimals: 3,
    typicalRange: { min: 100, max: 160 }
  },
  'BTCUSD': {
    canonical: 'BTCUSD',
    type: 'crypto',
    primarySource: 'tradingview',
    variants: [
      'BTCUSD', 'BTC/USD', 'BTC.USD', 'BTC-USD',
      'BTC', 'BTCUSD.a', 'BTCUSD.b',
      'BTCmicro', 'BTCmini',
    ],
    sources: [
      { name: 'tradingview', priority: 1, tolerance: 0.01 }
    ],
    expectedDecimals: 2,
    typicalRange: { min: 15000, max: 80000 }
  },
  'ETHUSD': {
    canonical: 'ETHUSD',
    type: 'crypto',
    primarySource: 'tradingview',
    variants: [
      'ETHUSD', 'ETH/USD', 'ETH.USD', 'ETH-USD',
      'ETH', 'ETHUSD.a', 'ETHUSD.b',
      'ETHmicro', 'ETHmini',
    ],
    sources: [
      { name: 'tradingview', priority: 1, tolerance: 0.015 }
    ],
    expectedDecimals: 2,
    typicalRange: { min: 800, max: 5000 }
  },
  'US500': {
    canonical: 'US500',
    type: 'index',
    primarySource: 'tradingview',
    variants: [
      'US500', 'SPX', 'SP500', 'S&P500', 'USA500',
      'US500.a', 'US500.b',
      'US500micro',
    ],
    sources: [
      { name: 'tradingview', priority: 1, tolerance: 0.005 }
    ],
    expectedDecimals: 1,
    typicalRange: { min: 3000, max: 5500 }
  },
  'NAS100': {
    canonical: 'NAS100',
    type: 'index',
    primarySource: 'tradingview',
    variants: [
      'NAS100', 'NASDAQ', 'NDX', 'US100',
      'NAS100.a', 'NAS100.b',
      'NAS100micro',
    ],
    sources: [
      { name: 'tradingview', priority: 1, tolerance: 0.005 }
    ],
    expectedDecimals: 1,
    typicalRange: { min: 8000, max: 20000 }
  }
};

/**
 * Find canonical symbol given any input
 * @param {string} input - Raw symbol from TradingView or broker
 * @returns {object} { found: bool, canonical: string, variant: string, type: string }
 */
function findCanonicalSymbol(input) {
  if (!input) return { found: false, canonical: null, error: 'Empty input' };
  
  const clean = input.toString().trim().toUpperCase();
  
  // Exact match in any variant
  for (const [canonical, data] of Object.entries(SYMBOL_VARIANTS)) {
    if (data.variants.some(v => v.toUpperCase() === clean)) {
      return { found: true, canonical, variant: input, type: data.type };
    }
  }

  // Fuzzy match (first 3+ chars, strip numbers/suffixes)
  const reduced = clean.replace(/[0-9._\-].*$/g, '');
  for (const [canonical, data] of Object.entries(SYMBOL_VARIANTS)) {
    if (data.variants.some(v => v.toUpperCase().startsWith(reduced))) {
      return { found: true, canonical, variant: input, type: data.type, fuzzyMatch: true };
    }
  }

  return { found: false, canonical: null, error: `Symbol "${input}" not recognized` };
}

/**
 * Check if price is within acceptable tolerance for a symbol
 * @param {number} tvPrice - Price from TradingView
 * @param {number} backendPrice - Price from backend (MT5/Yahoo)
 * @param {string} canonical - Canonical symbol
 * @returns {object} { ok: bool, tolerance: num, difference: num, status: string }
 */
function checkPriceTolerance(tvPrice, backendPrice, canonical) {
  if (!SYMBOL_VARIANTS[canonical]) {
    return { ok: false, error: `Unknown canonical symbol: ${canonical}` };
  }

  const config = SYMBOL_VARIANTS[canonical];
  const tolerance = config.sources[0].tolerance;  // Use MT5 tolerance (primary)
  
  const diff = Math.abs(tvPrice - backendPrice);
  const pctDiff = (diff / tvPrice) * 100;

  return {
    ok: pctDiff <= (tolerance * 100),
    tolerance: tolerance * 100,  // Convert to percentage
    difference: pctDiff.toFixed(3),
    tvPrice,
    backendPrice,
    status: pctDiff <= (tolerance * 100) ? 'OK' : 'DIVERGENCE',
    recommendation: pctDiff > (tolerance * 100) ? 'CHECK_SOURCES' : 'USE_DATA'
  };
}

/**
 * Find best matching source for a symbol
 * @param {string} canonical - Canonical symbol
 * @param {object} availablePrices - { tradingview: price }
 * @returns {object} { source: string, price: num, confidence: string }
 */
function selectBestSource(canonical, availablePrices) {
  if (!SYMBOL_VARIANTS[canonical]) {
    return { source: null, price: null, error: `Unknown symbol: ${canonical}` };
  }

  const config = SYMBOL_VARIANTS[canonical];
  const sources = config.sources;

  // Find first available source in priority order
  for (const source of sources) {
    if (availablePrices[source.name]) {
      return {
        source: source.name,
        price: availablePrices[source.name],
        priority: source.priority,
        confidence: source.priority === 1 ? 'primary' : source.priority === 2 ? 'secondary' : 'fallback',
        tolerance: source.tolerance
      };
    }
  }

  return { source: null, price: null, error: 'No sources available' };
}

/**
 * Match TradingView symbol to backend symbol with price validation
 * @param {string} tvSymbol - Symbol detected from TradingView
 * @param {number} tvPrice - Price displayed in TradingView
 * @param {object} backendData - { tradingview: { symbol, price } }
 * @returns {object} Complete matching result with validation
 */
function matchSymbolWithPriceValidation(tvSymbol, tvPrice, backendData) {
  // Step 1: Identify canonical symbol from TradingView
  const canonicalMatch = findCanonicalSymbol(tvSymbol);
  if (!canonicalMatch.found) {
    return {
      ok: false,
      tvSymbol,
      error: canonicalMatch.error,
      timestamp: new Date().toISOString()
    };
  }

  const canonical = canonicalMatch.canonical;
  const config = SYMBOL_VARIANTS[canonical];

  // Step 2: Collect available prices — bridge TradingView uniquement
  const availablePrices = {};
  if (backendData.tradingview?.price) availablePrices.tradingview = backendData.tradingview.price;

  // Step 3: Price validation for each source
  const priceValidation = {};
  for (const [source, price] of Object.entries(availablePrices)) {
    const tolerance = config.sources.find(s => s.name === source)?.tolerance || 0.01;
    const pctDiff = Math.abs(price - tvPrice) / tvPrice * 100;
    priceValidation[source] = {
      price,
      pctDiff: pctDiff.toFixed(3),
      tolerance: (tolerance * 100).toFixed(2),
      valid: pctDiff <= (tolerance * 100)
    };
  }

  // Step 4: Select best source
  const selection = selectBestSource(canonical, availablePrices);

  return {
    ok: true,
    tvSymbol,
    tvPrice,
    canonical,
    type: config.type,
    detectedAsset: tvSymbol,
    selectedSymbol: canonical,
    selectedSource: selection.source,
    selectedPrice: selection.price,
    priceValidation,
    syncStatus: selection.source === 'mt5' && priceValidation.mt5?.valid ? 'SYNCHRONIZED' : 
                selection.source === 'tradingview' ? 'ALIGNED' : 'APPROXIMATED',
    recommendation: Object.values(priceValidation).some(v => v.valid) ? 'PROCEED' : 'VERIFY',
    timestamp: new Date().toISOString()
  };
}

/**
 * Get display status for studio UI
 * @param {object} matchResult - Result from matchSymbolWithPriceValidation
 * @returns {object} Formatted for display
 */
function getDisplayStatus(matchResult) {
  if (!matchResult.ok) {
    return {
      symbol: '❌',
      status: 'ERROR',
      message: matchResult.error,
      color: 'red'
    };
  }

  const sync = matchResult.syncStatus;
  const statusMap = {
    'SYNCHRONIZED': { color: 'green', icon: '✅', message: 'Real-time sync' },
    'ALIGNED': { color: 'blue', icon: '🔵', message: 'TradingView matched' },
    'APPROXIMATED': { color: 'yellow', icon: '⚠️', message: 'Alternative source' }
  };

  const status = statusMap[sync] || { color: 'gray', icon: '?', message: sync };

  return {
    symbol: matchResult.selectedSymbol,
    detected: matchResult.detectedAsset,
    source: matchResult.selectedSource,
    price: matchResult.selectedPrice.toFixed(matchResult.canonical.includes('JPY') ? 2 : 4),
    tvPrice: matchResult.tvPrice.toFixed(matchResult.canonical.includes('JPY') ? 2 : 4),
    status: sync,
    color: status.color,
    message: status.message,
    icon: status.icon,
    syncOk: sync === 'SYNCHRONIZED'
  };
}

module.exports = {
  SYMBOL_VARIANTS,
  findCanonicalSymbol,
  checkPriceTolerance,
  selectBestSource,
  matchSymbolWithPriceValidation,
  getDisplayStatus
};
