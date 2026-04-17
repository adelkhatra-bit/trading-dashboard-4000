// coordinator.js — Coordinateur d'agents avec données réelles
// Récupère les prix live depuis le bridge TradingView uniquement
// AUCUN Math.random()

'use strict';

const macroAgent     = require('./macroAgent');
const technicalAgent = require('./technicalAgent');
const riskManager    = require('./riskManager');

// ─── Symboles surveillés ─────────────────────────────────────────────────────

const PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'XAU/USD', 'BTC/USD'];

// ─── Construit la priceMap depuis le bridge TradingView ──────────────────────

async function buildPriceMap() {
  const priceMap = {};

  // 1. Essayer marketStore (données MT5 live)
  try {
    const marketStore = require('../../store/market-store');
    const snapshot = marketStore.getSnapshot ? marketStore.getSnapshot() : null;
    if (snapshot && snapshot.symbols) {
      for (const [sym, data] of Object.entries(snapshot.symbols)) {
        if (data && data.latestPayload && data.latestPayload.price) {
          // Chercher quel pair correspond
          const canonical = sym.toUpperCase();
          for (const pair of PAIRS) {
            const pairNorm = pair.replace('/', '').toUpperCase();
            if (canonical === pairNorm || canonical === pairNorm.replace('XAU', 'GOLD')) {
              priceMap[pair] = data.latestPayload;  // objet complet avec rsi, ema20, ema50, atr
            }
          }
        }
      }
    }
  } catch (_) { /* market store non disponible */ }

  // 2. Yahoo Finance supprimé — les paires manquantes restent vides (bridge TV requis)
  // Aucune source externe autorisée. Si priceMap vide, le cycle attend le bridge TradingView.

  return priceMap;
}

// ─── Cycle d'agents complet ───────────────────────────────────────────────────

async function runAgentCycle(externalPriceMap, accountBalance, riskPercent) {
  if (!accountBalance) accountBalance = 100000;
  if (!riskPercent) riskPercent = 1;

  const timestamp = new Date().toISOString();

  // 1. Prix réels (MT5 + Yahoo)
  const priceMap = externalPriceMap && Object.keys(externalPriceMap).length > 0
    ? externalPriceMap
    : await buildPriceMap();

  // 2. Analyse macro (calendrier économique)
  const calendar      = await macroAgent.getEconomicCalendar();
  const macroAnalysis = await macroAgent.analyzeEconomicImpact(calendar);

  // 3. Analyse technique — utilise les vraies données MT5 si disponibles
  const technicalAnalyses = await technicalAgent.analyzeMultiPair(PAIRS, priceMap);

  // 4. Score global
  const techScoreAvg = technicalAnalyses.reduce(function(sum, t) { return sum + (t.score || 0); }, 0)
    / Math.max(1, technicalAnalyses.length);

  const overallScore = Math.round((macroAnalysis.score * 0.4) + (techScoreAvg * 0.6));
  let masterDecision = 'HOLD';
  if (overallScore >= 65) masterDecision = 'LONG';
  if (overallScore <= 35) masterDecision = 'SHORT';

  // 5. Meilleure opportunité (score technique le plus élevé avec un prix réel)
  const withPrice = technicalAnalyses.filter(function(t) { return t.price && parseFloat(t.price) > 0; });
  const sorted    = withPrice.sort(function(a, b) { return b.score - a.score; });
  const bestTech  = sorted[0] || technicalAnalyses[0];

  const entryPrice  = bestTech ? parseFloat(bestTech.price) : 0;
  const isLong      = bestTech && bestTech.signal === 'LONG';
  const stopPrice   = entryPrice > 0 ? entryPrice * (isLong ? 0.998 : 1.002) : 0;

  const positionSize = entryPrice > 0
    ? riskManager.calculatePositionSize({ accountBalance: accountBalance, riskPercent: riskPercent, entryPrice: entryPrice, stopPrice: stopPrice })
    : { quantity: 0, riskAmount: 0 };

  const riskValidation = entryPrice > 0
    ? riskManager.validateRisk({ quantity: positionSize.quantity, entryPrice: entryPrice, accountBalance: accountBalance })
    : { exposure: '0', leverage: '0', valid: false };

  // 6. Source des prix
  const dataSource = Object.values(priceMap).some(function(v) { return v && typeof v === 'object' && v.source === 'mt5-live'; })
    ? 'mt5-live' : (Object.keys(priceMap).length > 0 ? 'tradingview-bridge' : 'offline');

  return {
    timestamp: timestamp,
    masterDecision: masterDecision,
    overallScore: overallScore,
    dataSource: dataSource,
    pairsAnalyzed: PAIRS.length,
    pricesLive: Object.keys(priceMap).length,
    macroAgent: macroAnalysis,
    technicalAgents: technicalAnalyses,
    bestOpportunity: bestTech ? {
      symbol:     bestTech.symbol,
      signal:     bestTech.signal,
      price:      bestTech.price,
      quantity:   positionSize.quantity,
      riskAmount: positionSize.riskAmount,
      exposure:   riskValidation.exposure,
      leverage:   riskValidation.leverage,
      valid:      riskValidation.valid
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
