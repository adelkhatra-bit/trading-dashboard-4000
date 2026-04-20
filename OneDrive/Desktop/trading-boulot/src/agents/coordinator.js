// coordinator.js — Coordinateur d'agents Bridge TradingView
// Source unique: tvDataStore via /tradingview/live
// AUCUN Math.random()

'use strict';

const macroAgent     = require('./macroAgent');
const technicalAgent = require('./technicalAgent');
const riskManager    = require('./riskManager');

const PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'XAU/USD', 'BTC/USD'];

async function buildPriceMap() {
  const priceMap = {};
  try {
    const marketStore = require('../../store/market-store');
    const snapshot = marketStore.getSnapshot ? marketStore.getSnapshot() : null;
    if (snapshot && snapshot.symbols) {
      for (const [sym, data] of Object.entries(snapshot.symbols)) {
        if (data && data.latestPayload && data.latestPayload.price) {
          const canonical = sym.toUpperCase();
          for (const pair of PAIRS) {
            const pairNorm = pair.replace('/', '').toUpperCase();
            if (canonical === pairNorm || canonical === pairNorm.replace('XAU', 'GOLD')) {
              priceMap[pair] = data.latestPayload;
            }
          }
        }
      }
    }
  } catch (_) {}
  return priceMap;
}

async function runAgentCycle(externalPriceMap, accountBalance, riskPercent) {
  if (!accountBalance) accountBalance = 100000;
  if (!riskPercent) riskPercent = 1;

  const timestamp = new Date().toISOString();
  const priceMap  = externalPriceMap && Object.keys(externalPriceMap).length > 0
    ? externalPriceMap : await buildPriceMap();

  const calendar      = await macroAgent.getEconomicCalendar();
  const macroAnalysis = await macroAgent.analyzeEconomicImpact(calendar);
  const technicalAnalyses = await technicalAgent.analyzeMultiPair(PAIRS, priceMap);

  const techScoreAvg = technicalAnalyses.reduce((sum, t) => sum + (t.score || 0), 0)
    / Math.max(1, technicalAnalyses.length);
  const overallScore = Math.round((macroAnalysis.score * 0.4) + (techScoreAvg * 0.6));
  let masterDecision = 'HOLD';
  if (overallScore >= 65) masterDecision = 'LONG';
  if (overallScore <= 35) masterDecision = 'SHORT';

  const withPrice = technicalAnalyses.filter(t => t.price && parseFloat(t.price) > 0);
  const bestTech  = withPrice.sort((a, b) => b.score - a.score)[0] || technicalAnalyses[0];

  const entryPrice  = bestTech ? parseFloat(bestTech.price) : 0;
  const isLong      = bestTech && bestTech.signal === 'LONG';
  const stopPrice   = entryPrice > 0 ? entryPrice * (isLong ? 0.998 : 1.002) : 0;

  const positionSize = entryPrice > 0
    ? riskManager.calculatePositionSize({ accountBalance, riskPercent, entryPrice, stopPrice })
    : { quantity: 0, riskAmount: 0 };
  const riskValidation = entryPrice > 0
    ? riskManager.validateRisk({ quantity: positionSize.quantity, entryPrice, accountBalance })
    : { exposure: '0', leverage: '0', valid: false };

  const dataSource = Object.keys(priceMap).length > 0 ? 'tradingview-bridge' : 'offline';

  return {
    timestamp, masterDecision, overallScore, dataSource,
    pairsAnalyzed: PAIRS.length, pricesLive: Object.keys(priceMap).length,
    macroAgent: macroAnalysis, technicalAgents: technicalAnalyses,
    bestOpportunity: bestTech ? {
      symbol: bestTech.symbol, signal: bestTech.signal, price: bestTech.price,
      quantity: positionSize.quantity, riskAmount: positionSize.riskAmount,
      exposure: riskValidation.exposure, leverage: riskValidation.leverage, valid: riskValidation.valid
    } : { quantity: 0, riskAmount: 0, exposure: '0', leverage: '0', valid: false },
    nextMacroEvent: calendar[0] || null,
    recommendations: [
      'Confiance globale: ' + overallScore + '%',
      'Source données: ' + dataSource,
      'Risque macro: ' + macroAnalysis.riskLevel,
      bestTech ? 'Meilleur: ' + bestTech.symbol + ' (' + bestTech.signal + ') @ ' + bestTech.price : 'Aucune opportunité',
      positionSize.quantity > 0
        ? 'Taille suggérée: ' + positionSize.quantity + ' (exposition ' + riskValidation.exposure + ')'
        : 'Aucune position recommandée',
      riskValidation.warning ? ('⚠️ ' + riskValidation.warning) : '✅ Risque dans les limites'
    ]
  };
}

module.exports = { runAgentCycle };
