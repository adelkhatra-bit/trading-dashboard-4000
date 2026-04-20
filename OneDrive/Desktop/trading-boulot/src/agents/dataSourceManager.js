/**
 * Agent: Data Source Manager
 * Règle absolue: Bridge TradingView UNIQUEMENT
 * Source unique: /tradingview/live → tvDataStore → updateFromTV()
 * Aucun fallback externe autorisé.
 */

const SOURCES = {
  TRADINGVIEW: 'tradingview',
  NONE: 'none'
};

const tvPriceCache = {};

function normalizeSymbol(symbol) {
  if (!symbol) return null;
  if (symbol.includes('/')) return symbol;
  if (symbol.toUpperCase() === 'GOLD' || symbol.toUpperCase() === 'XAUUSD') return 'XAU/USD';
  if (symbol.toUpperCase() === 'SILVER' || symbol.toUpperCase() === 'XAGUSD') return 'XAG/USD';
  if (symbol.toUpperCase() === 'BTCUSD') return 'BTC/USD';
  if (symbol.toUpperCase() === 'ETHUSD') return 'ETH/USD';
  if (symbol.length === 6) return `${symbol.substring(0, 3)}/${symbol.substring(3)}`;
  return symbol;
}

async function getPrice(symbol) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return { valid: false, error: 'Symbol invalide', source: SOURCES.NONE };
  return await getPriceFromTradingView(normalized);
}

async function getPriceFromTradingView(symbol) {
  // Prix viennent de tvDataStore via getLatestTradingviewRuntime() dans server.js
  return {
    valid: false,
    error: `Bridge TV: en attente flux live tvDataStore pour ${symbol}`,
    source: SOURCES.TRADINGVIEW
  };
}

function isValidSource(source) {
  return Object.values(SOURCES).includes(source);
}

function getActiveSources() {
  return [
    { name: 'TradingView Bridge', priority: 1, status: 'active', endpoint: '/tradingview/live' }
  ];
}

function getStatus() {
  return {
    active: true,
    primarySource: SOURCES.TRADINGVIEW,
    message: 'Data Source Manager — Bridge TradingView uniquement'
  };
}

module.exports = {
  getPrice,
  getPriceFromTradingView,
  normalizeSymbol,
  isValidSource,
  getActiveSources,
  getStatus,
  SOURCES
};
