/**
 * dev-helper.js — Trading Auto — Système de Réparation Universel
 * Bouton flottant 🛠️ sur TOUTES les pages
 * 1 clic → contexte complet → coller à une IA ou un développeur → réparation immédiate
 */
(function () {
  'use strict';

  const ROOT   = 'C:\\Users\\97156\\OneDrive\\Desktop\\trading-auto';
  const SERVER = 'http://localhost:4000';

  // ══════════════════════════════════════════════════════════════
  //  BASE DE DONNÉES COMPLÈTE DU SYSTÈME
  // ══════════════════════════════════════════════════════════════

  const SYSTEM = {

    // ── CONTEXTE PAR URL ──────────────────────────────────────
    pages: {
      '/': {
        file: 'index.html', role: 'Menu principal — 8 cartes de navigation',
        safe: 'Ajouter cartes dans .cards-grid, modifier textes',
        danger: 'IDs: #server-status #api-status — ne pas renommer',
        deps: 'server.js (toutes routes), studioapp.js', tech: 'HTML pur + fetch :4000/health'
      },
      '/studio': {
        file: 'studio/index-simple.html', role: 'Studio trading — LW Charts v4.1.3 + signal + analyses',
        safe: 'Modifier styles CSS, ajouter panneaux dans .center-panel',
        danger: 'IDs critiques: chart-container, symbol-select, trade-direction, trade-score, trade-levels — NE PAS renommer',
        deps: 'studio/studioapp-simple.js, /klines /quote /instant-trade-live /match-symbol',
        tech: 'LightweightCharts 4.1.3, fetch :4000, AbortSignal.timeout(4000), circuit-breaker _serverOnline'
      },
      '/dashboard': {
        file: 'dashboard.html', role: 'Dashboard Bridge — visualisation données MT5',
        safe: 'Modifier cartes info, ajouter sections données',
        danger: 'Ne pas changer URL bridge ni logique refresh 5s',
        deps: 'server.js /health /mt5/latest', tech: 'fetch :4000, setInterval 5s'
      },
      '/popup': {
        file: 'popup.html', role: 'Popup extension version web (test)',
        safe: 'Modifier affichage résultats',
        danger: 'Ne pas confondre avec tradingview-analyzer/popup.html (version Chrome réelle)',
        deps: 'server.js /health /instant-trade-live /positions', tech: 'fetch :4000'
      },
      '/agent-log': {
        file: 'agent-log-page.html', role: '🌟 HUB CENTRAL — tableau de bord complet 8 onglets',
        safe: 'Ajouter onglets, enrichir tables fichiers, ajouter boutons Controls',
        danger: 'Ne pas modifier showTab() ni les IDs status bar: tasksCompleted, tasksInProgress, tasksPending, serverDot',
        deps: 'server.js /agent-bus /system-log /health /match-symbol', tech: 'fetch :4000, AbortSignal.timeout(3000), tabs dynamiques'
      },
      '/agents-monitor': {
        file: 'AGENTS_MONITOR.html', role: 'Moniteur agents live — statut 23 agents temps réel',
        safe: 'Ajouter cartes agent, modifier styles badges',
        danger: 'Ne pas modifier logique polling',
        deps: 'server.js /agent-status /agent-activity', tech: 'fetch :4000, polling'
      },
      '/extension-test': {
        file: 'EXTENSION_TEST.html', role: 'Tests extension — parseSymbol, TF, prix, background',
        safe: 'Ajouter cas de test', danger: 'Page test seulement',
        deps: 'tradingview-analyzer/background.js (logique copiée)', tech: 'Tests inline JS'
      },
      '/test-analysis': {
        file: 'test-analysis.html', role: 'Tests API — /instant-trade-live /agent-status /health',
        safe: 'Ajouter endpoints à tester', danger: 'Page test seulement',
        deps: 'server.js /instant-trade-live /agent-status /health', tech: 'fetch :4000, JSON display'
      }
    },

    // ── TOUS LES FICHIERS DU SYSTÈME ──────────────────────────
    files: {
      // === BACKEND ===
      backend: [
        {
          id: 'server',
          name: 'server.js',
          path: 'server.js',
          cat: 'Backend',
          role: 'Serveur Express principal — 60+ routes, SSE, orchestration, MT5 bridge proxy',
          deps_in: 'market-store.js, symbol-matcher.js, orchestrator.js',
          deps_out: 'Appelé par: tous les fichiers HTML et extension',
          functions: 'sendHTMLWithHelper(), checkMT5Bridge(), classifySetup(), validateTrade(), calcTradeLevels()',
          routes: 'GET / /studio /dashboard /popup /agent-log /agents-monitor | GET /health /state /stream | GET/POST /mt5/* | GET /quote /klines /instant-trade-live /match-symbol/:sym | POST /trade /zones | GET /agent-bus /system-log /tasks',
          critical: true,
          status: 'OK',
          fix: 'Redémarrer après modification: node server.js — Ne pas modifier routes existantes — Ajouter après ligne 1895'
        },
        {
          id: 'market-store',
          name: 'market-store.js',
          path: 'store/market-store.js',
          cat: 'Backend',
          role: 'Singleton données marché — source de vérité unique pour prix, SSE broadcast',
          deps_in: 'Aucun',
          deps_out: 'Utilisé par: server.js, tous les agents src/agents/',
          functions: 'updateFromMT5(), updateAnalysis(), addSSEClient(), broadcast(), getState(), getLatestForSymbol()',
          critical: true,
          status: 'OK',
          fix: 'CRITIQUE — Modifier casse le SSE stream /stream — Tester /state après modification'
        },
        {
          id: 'symbol-matcher',
          name: 'symbol-matcher.js',
          path: 'lib/symbol-matcher.js',
          cat: 'Backend',
          role: 'Moteur matching symboles — 50+ variantes TV↔MT5, validation prix ±0.5%',
          deps_in: 'Aucun',
          deps_out: 'server.js /match-symbol route, tradingview-analyzer/mapping-module.js',
          functions: 'findCanonicalSymbol(), matchSymbolWithPriceValidation(), getDisplayStatus()',
          critical: true,
          status: 'OK',
          fix: 'Tester /match-symbol/XAUUSD?price=2050 après modification'
        },
        {
          id: 'symbol-normalizer',
          name: 'symbol-normalizer.js',
          path: 'lib/symbol-normalizer.js',
          cat: 'Backend',
          role: 'Canonicalisation symboles — profiles digits/pip/SL%/TP% pour chaque asset',
          deps_in: 'Aucun',
          deps_out: 'server.js, tous les agents, studio',
          functions: 'normalizeSymbol(rawSymbol) → {canonical, type, digits, slPct, tpPct, pip}',
          critical: true,
          status: 'OK',
          fix: 'Chaque symbole a un profil — ne pas supprimer de profil existant'
        },
        {
          id: 'orchestrator',
          name: 'orchestrator.js',
          path: 'src/agents/orchestrator.js',
          cat: 'Agents',
          role: 'Coordinateur maître — dispatche vers 8+ agents, calcule finalScore, décision trade',
          deps_in: 'server.js POST /orchestration/run-now',
          deps_out: 'trading-core.js, timeframe-consensus.js, riskManager.js, macroAgent.js, newsAgent.js',
          functions: 'run(mt5Payload) → {direction, score, entry, sl, tp}',
          critical: true,
          status: 'OK',
          fix: 'Tester POST /orchestration/run-now après modification'
        },
        {
          id: 'broker-calc',
          name: 'broker-calculator.js',
          path: 'lib/broker-calculator.js',
          cat: 'Backend',
          role: 'Calculs position sizing — pip value, lot size, margin',
          deps_in: 'Aucun',
          deps_out: 'riskManager.js, server.js /trade route',
          functions: 'calcPipValue(), calcLotSize(), calcMargin()',
          critical: false,
          status: 'OK',
          fix: 'Vérifier calculs avec /broker-config/:broker'
        },
        {
          id: 'agent-worker',
          name: 'agent-worker.js',
          path: 'agent-worker.js',
          cat: 'Backend',
          role: 'Exécuteur de tâches — lit tasks.json, met à jour logs.json',
          deps_in: 'Aucun',
          deps_out: 'tasks.json, logs.json',
          functions: 'executeTask(), updateTask(), addLog()',
          critical: false,
          status: 'OK',
          fix: 'Vérifier tasks.json format si erreur — GET /tasks pour voir l\'état'
        }
      ],

      // === HTML ===
      html: [
        {
          id: 'index-html',
          name: 'index.html',
          path: 'index.html',
          cat: 'HTML',
          role: 'Menu principal — 8 cartes navigation + 8 contrôles rapides',
          url: '/',
          deps_in: 'server.js GET /',
          deps_out: '/studio /dashboard /popup /agent-log /agents-monitor',
          ids: 'server-status, api-status, .cards-grid',
          critical: false,
          status: 'OK',
          fix: 'Modifier cartes dans .cards-grid — vérifier href des boutons'
        },
        {
          id: 'studio-html',
          name: 'studio/index-simple.html',
          path: 'studio/index-simple.html',
          cat: 'HTML',
          role: 'Studio trading — graphique, signal, analyses',
          url: '/studio',
          deps_in: 'server.js GET /studio, studioapp-simple.js',
          deps_out: '/klines /quote /instant-trade-live /match-symbol',
          ids: 'chart-container, symbol-select, critical-price, trade-direction, trade-score, trade-rr, trade-levels, symbol-validation-panel, sync-badge, log-panel',
          critical: true,
          status: 'OK',
          fix: 'Si blanc: ouvrir console → vérifier erreur JS — API doit être :4000 — LW Charts CDN requis'
        },
        {
          id: 'studioapp-simple',
          name: 'studio/studioapp-simple.js',
          path: 'studio/studioapp-simple.js',
          cat: 'HTML',
          role: 'Logique studio légère — API :4000, AbortSignal, circuit-breaker, T006+T007',
          url: null,
          deps_in: 'studio/index-simple.html',
          deps_out: 'API :4000 /health /quote /klines /instant-trade-live /match-symbol/ /economic-events',
          ids: 'const API = "http://127.0.0.1:4000" — _serverOnline flag — loadInstantTrade() — validateSymbol()',
          critical: true,
          status: 'OK',
          fix: 'Si freeze: vérifier API port (doit être 4000) — vérifier AbortSignal.timeout() partout — pas de { timeout: } invalide'
        },
        {
          id: 'dashboard-html',
          name: 'dashboard.html',
          path: 'dashboard.html',
          cat: 'HTML',
          role: 'Dashboard Bridge — viewer données MT5',
          url: '/dashboard',
          deps_in: 'server.js GET /dashboard',
          deps_out: '/health /mt5/latest',
          ids: 'bridge-status, active-symbol, current-price, market-session',
          critical: false,
          status: 'OK',
          fix: 'Si Cannot GET: vérifier que server.js tourne — route /dashboard ajoutée dans server.js'
        },
        {
          id: 'popup-html',
          name: 'popup.html (web)',
          path: 'popup.html',
          cat: 'HTML',
          role: 'Popup extension version web (test/preview)',
          url: '/popup',
          deps_in: 'server.js GET /popup',
          deps_out: '/health /instant-trade-live /positions',
          ids: 'server-status-dot, symbol-selector, results-panel, positions-container',
          critical: false,
          status: 'OK',
          fix: 'NE PAS confondre avec tradingview-analyzer/popup.html (Chrome réel)'
        },
        {
          id: 'agent-log-html',
          name: 'agent-log-page.html',
          path: 'agent-log-page.html',
          cat: 'HTML',
          role: '🌟 HUB CENTRAL — 8 onglets, tous fichiers, toutes tâches',
          url: '/agent-log',
          deps_in: 'server.js GET /agent-log',
          deps_out: '/agent-bus /system-log /health /match-symbol',
          ids: 'tasksCompleted, tasksInProgress, tasksPending, serverDot, serverLabel, logsContainer, tab-* panels',
          critical: true,
          status: 'OK',
          fix: 'Si onglets cassés: vérifier showTab() function — si logs vides: vérifier fetch /agent-bus'
        },
        {
          id: 'agents-monitor-html',
          name: 'AGENTS_MONITOR.html',
          path: 'AGENTS_MONITOR.html',
          cat: 'HTML',
          role: 'Moniteur agents live — statut 23 agents en temps réel',
          url: '/agents-monitor',
          deps_in: 'server.js GET /agents-monitor',
          deps_out: '/agent-status /agent-activity',
          ids: 'agents-grid, health-status',
          critical: false,
          status: 'OK',
          fix: 'Si agents offline: vérifier /agent-status endpoint'
        }
      ],

      // === EXTENSION CHROME ===
      extension: [
        {
          id: 'ext-manifest',
          name: 'manifest.json',
          path: 'tradingview-analyzer/manifest.json',
          cat: 'Extension',
          role: 'Manifest MV3 — permissions, host_permissions, background SW',
          deps_in: 'Chrome extension loader',
          deps_out: 'background.js, popup.html, content.js',
          functions: 'permissions: storage tabs activeTab scripting | host: *.tradingview.com, 127.0.0.1:4000',
          critical: true,
          status: 'OK',
          fix: 'Si extension ne charge pas: vérifier web_accessible_resources — recharger chrome://extensions après modification'
        },
        {
          id: 'ext-popup-js',
          name: 'popup.js',
          path: 'tradingview-analyzer/popup.js',
          cat: 'Extension',
          role: 'Logique UI extension Chrome (1936L) — FICHIER PRINCIPAL de l\'extension',
          deps_in: 'tradingview-analyzer/popup.html (script tag)',
          deps_out: '13 modules: chart-module, mapping-module, symbol-mapper, symbol-manager, market-session, economic-calendar, news-engine, error-handler, ai-debugger, mt5-symbols',
          functions: 'setupPopup(), tab handlers, btn-analyze, btn-refresh, btn-search-mt5, loadInstantTrade(), renderChart()',
          critical: true,
          status: 'OK',
          fix: 'Modifier avec précaution — 1936 lignes — recharger extension Chrome après — tester sur TradingView.com'
        },
        {
          id: 'ext-background',
          name: 'background.js',
          path: 'tradingview-analyzer/background.js',
          cat: 'Extension',
          role: 'Service Worker MV3 (487L) — état centralisé, relay content↔popup, polling prix 5s',
          deps_in: 'Chrome Service Worker loader',
          deps_out: 'content.js (postMessage), popup.js (chrome.runtime.sendMessage)',
          functions: 'Poll /data toutes les 5s — relaye symbole détecté vers popup — cache prix de base',
          critical: true,
          status: 'OK',
          fix: 'Si popup ne reçoit pas de données: vérifier console Service Worker dans chrome://extensions > Inspect'
        },
        {
          id: 'ext-content',
          name: 'content.js',
          path: 'tradingview-analyzer/content.js',
          cat: 'Extension',
          role: 'Script contenu (58L) — screenshot + contexte DOM minimal',
          deps_in: 'manifest.json content_scripts, https://*.tradingview.com/*',
          deps_out: 'background.js (postMessage)',
          functions: 'Capture screenshot, extrait contexte visuel TradingView',
          critical: false,
          status: 'OK',
          fix: 'Si screenshot ne fonctionne pas: vérifier permissions activeTab dans manifest'
        },
        {
          id: 'ext-chart',
          name: 'chart-module.js',
          path: 'tradingview-analyzer/chart-module.js',
          cat: 'Extension',
          role: 'Module graphique extension — LightweightCharts, klines rendering (199L)',
          deps_in: 'popup.js',
          deps_out: '/klines endpoint, LightweightCharts lib',
          functions: 'ChartModule.init(), ChartModule.render(), ChartModule.update()',
          critical: false,
          status: 'OK',
          fix: 'Si graphique vide: vérifier /klines endpoint — vérifier LightweightCharts chargé'
        },
        {
          id: 'ext-mapping',
          name: 'mapping-module.js',
          path: 'tradingview-analyzer/mapping-module.js',
          cat: 'Extension',
          role: 'Module mapping symboles — POST /mapping/resolve, /mapping/save (131L)',
          deps_in: 'popup.js tab context',
          deps_out: '/mapping/resolve /mapping/save /mapping/list',
          functions: 'MappingModule.search(), MappingModule.save(), MappingModule.load()',
          critical: false,
          status: 'OK',
          fix: 'Si mapping ne sauvegarde pas: vérifier /mapping/save endpoint'
        },
        {
          id: 'ext-symbol-mgr',
          name: 'symbol-manager.js',
          path: 'tradingview-analyzer/symbol-manager.js',
          cat: 'Extension',
          role: 'Gestion état symbole actif dans extension (137L)',
          deps_in: 'popup.js',
          deps_out: 'background.js state',
          functions: 'SymbolManager.setActive(), SymbolManager.getActive(), SymbolManager.normalize()',
          critical: false,
          status: 'OK',
          fix: 'Si symbole ne se met pas à jour: vérifier SymbolManager.setActive() appelé'
        },
        {
          id: 'ext-market-session',
          name: 'market-session.js',
          path: 'tradingview-analyzer/market-session.js',
          cat: 'Extension',
          role: 'Sessions marché — London/NY/Tokyo horaires, volatilité (160L)',
          deps_in: 'popup.js tab market',
          deps_out: 'Aucun',
          functions: 'MarketSession.getCurrentSession(), MarketSession.getOverlaps(), MarketSession.getVolatilityWindow()',
          critical: false,
          status: 'OK',
          fix: 'Si sessions incorrectes: vérifier timezone offset dans calculs'
        }
      ],

      // === AGENTS ===
      agents: [
        { id: 'ag-trading-core', name: 'trading-core.js', path: 'src/agents/trading-core.js', cat: 'Agent', role: 'Analyse technique: RSI, EMA, FVG, BOS, liquidité', functions: 'analyze(mt5Data, profile)', status: 'OK' },
        { id: 'ag-tf-consensus', name: 'timeframe-consensus.js', path: 'src/agents/timeframe-consensus.js', cat: 'Agent', role: 'Consensus multi-TF hiérarchique D1→M1', functions: 'buildConsensus(multiTFPayload)', status: 'OK' },
        { id: 'ag-technical', name: 'technicalAgent.js', path: 'src/agents/technicalAgent.js', cat: 'Agent', role: 'EMA/RSI/ATR calculs multi-paires (278L)', functions: 'analyzeTechnical(), calcEMA(), calcRSI(), calcATR()', status: 'OK' },
        { id: 'ag-trade-logic', name: 'trade-logic.js', path: 'src/agents/trade-logic.js', cat: 'Agent', role: 'Explique POURQUOI entrer/attendre/éviter', functions: 'explain({direction, score, context})', status: 'OK' },
        { id: 'ag-market-state', name: 'market-state.js', path: 'src/agents/market-state.js', cat: 'Agent', role: 'Détecte si marché clean/choppy/dangerous', functions: 'assess({atr, spread, rsi, volume})', status: 'OK' },
        { id: 'ag-news-intel', name: 'news-intelligence.js', path: 'src/agents/news-intelligence.js', cat: 'Agent', role: 'Événements économiques, impact macro, sentiment', functions: 'analyze(symbol), getUpcomingEvents()', status: 'OK' },
        { id: 'ag-fear', name: 'fear-index.js', path: 'src/agents/fear-index.js', cat: 'Agent', role: 'Indice peur marché — VIX proxy (cache 5min)', functions: 'getFearIndex() async', status: 'OK' },
        { id: 'ag-risk', name: 'riskManager.js', path: 'src/agents/riskManager.js', cat: 'Agent', role: 'Sizing position, validation levier', functions: 'calculatePositionSize(), validateRisk()', status: 'OK' },
        { id: 'ag-setup', name: 'setupClassifier.js', path: 'src/agents/setupClassifier.js', cat: 'Agent', role: 'Classifie SCALPER/SNIPER/SWING avec reasoning', functions: 'classifySetup(trade, context)', status: 'OK' },
        { id: 'ag-validator', name: 'tradeValidator.js', path: 'src/agents/tradeValidator.js', cat: 'Agent', role: 'Valide LIVE/CONDITIONAL/WAIT (194L)', functions: 'validateTrade(trade, price), filterLiveTrades()', status: 'OK' },
        { id: 'ag-sync', name: 'syncManager.js', path: 'src/agents/syncManager.js', cat: 'Agent', role: 'Cohérence prix↔chart, qualité source', functions: 'syncAll(symbol, tf), validateTradeCoherence()', status: 'OK' },
        { id: 'ag-supervisor', name: 'supervisor.js', path: 'src/agents/supervisor.js', cat: 'Agent', role: 'Health check système, validation pre-action', functions: 'checkSystemHealth(), validateActionBefore(), validateTradeExecution()', status: 'OK' },
        { id: 'ag-chart-engine', name: 'chartEngine.js', path: 'src/agents/chartEngine.js', cat: 'Agent', role: 'Gestion bougies par TF, formatage chart TV', functions: 'getCandles(), completeCandle(), getChartDataForTV()', status: 'OK' },
        { id: 'ag-data-src', name: 'dataSourceManager.js', path: 'src/agents/dataSourceManager.js', cat: 'Agent', role: 'Abstraction bridge TradingView uniquement', functions: 'getPrice(symbol, source), getActiveSources(), getStatus()', status: 'OK' },
        { id: 'ag-strategy', name: 'strategyManager.js', path: 'src/agents/strategyManager.js', cat: 'Agent', role: 'Adapte trades pour INTRADAY/SWING/SCALPER', functions: 'adaptTrade(trade, strategy), recommendStrategy()', status: 'OK' },
        { id: 'ag-macro', name: 'macroAgent.js', path: 'src/agents/macroAgent.js', cat: 'Agent', role: 'Calendrier économique, impact macro', functions: 'getEconomicCalendar(), analyzeEconomicImpact()', status: 'OK' },
        { id: 'ag-coord', name: 'coordinator.js', path: 'src/agents/coordinator.js', cat: 'Agent', role: 'Cycle agents avec prix réel bridge TV uniquement', functions: 'runAgentCycle(priceMap, balance, riskPct)', status: 'OK' },
        { id: 'ag-state', name: 'stateManager.js', path: 'src/agents/stateManager.js', cat: 'Agent', role: 'Persistance état localStorage/fichier', functions: 'save(), get(), getAll(), reset(), export_state()', status: 'OK' },
        { id: 'ag-loop', name: 'continuous-loop.js', path: 'src/agents/continuous-loop.js', cat: 'Agent', role: 'Boucle continue DÉSACTIVÉE — déclencher via POST /orchestration/run-now', functions: 'startContinuousLoop(), stopContinuousLoop(), runImmediately()', status: 'OK' }
      ],

      // === MT5 BRIDGE ===
      bridge: [
        {
          id: 'mt5-bridge-py',
          name: 'mt5_bridge.py',
          path: 'mt5_bridge.py',
          cat: 'Bridge MT5',
          role: 'Bridge Python legacy (désactivé en mode 4000 unique)',
          deps_in: 'MetaTrader 5 terminal installé + EA actif',
          deps_out: 'Aucun en mode single-environment',
          functions: 'ensure_connected(), /health /data /symbol /price /klines /positions',
          critical: true,
          status: 'OFFLINE',
          fix: 'Bridge legacy désactivé: utiliser uniquement le serveur principal sur :4000'
        },
        {
          id: 'mt5-bridge-simple',
          name: 'mt5_bridge_simple.py',
          path: 'mt5_bridge_simple.py',
          cat: 'Bridge MT5',
          role: 'Bridge Python simplifié — version légère sans toutes les routes',
          deps_in: 'MetaTrader 5',
          deps_out: 'server.js',
          functions: 'Routes essentielles seulement',
          critical: false,
          status: 'OFFLINE',
          fix: 'Alternative légère à mt5_bridge.py — même commande de lancement'
        },
        {
          id: 'mt5-ea',
          name: 'Bridge_MT5_Studio.mq5',
          path: 'Bridge_MT5_Studio.mq5',
          cat: 'Bridge MT5',
          role: 'Expert Advisor MT5 — envoie données vers bridge Python via HTTP',
          deps_in: 'MetaTrader 5 terminal',
          deps_out: 'mt5_bridge.py (POST données)',
          functions: 'OnTick(), OnTimer() — envoie prix/OHLC/positions au bridge',
          critical: true,
          status: 'À installer',
          fix: 'Copier dans: MQL5/Experts/ → Compiler → Attacher sur chart XAUUSD'
        },
        {
          id: 'mt5-reqs',
          name: 'requirements-mt5.txt',
          path: 'requirements-mt5.txt',
          cat: 'Bridge MT5',
          role: 'Dépendances Python pour bridge MT5',
          deps_in: 'pip',
          deps_out: 'mt5_bridge.py',
          functions: 'MetaTrader5, Flask, requests, pandas',
          critical: false,
          status: 'OK',
          fix: 'Installer: pip install -r requirements-mt5.txt'
        }
      ],

      // === DATA JSON ===
      data: [
        {
          id: 'agent-bus-json',
          name: 'AGENT_BUS.json',
          path: 'AGENT_BUS.json',
          cat: 'Données',
          role: 'Bus coordination multi-IA — tâches Claude/Copilot, done/inProgress/pending',
          deps_in: 'Claude, Copilot (écriture)',
          deps_out: 'server.js GET /agent-bus → studio panel, agent-log-page.html',
          functions: 'Objet: {ok, version, roles: {claude, copilot}, tasks: {done[], inProgress[], pending[]}}',
          critical: false,
          status: 'OK',
          fix: 'Si /agent-bus retourne 500: vérifier JSON valide — jsonlint.com'
        },
        {
          id: 'system-log-json',
          name: 'SYSTEM_LOG.json',
          path: 'SYSTEM_LOG.json',
          cat: 'Données',
          role: 'Journal système — messages inter-IA, actions, timestamps',
          deps_in: 'server.js POST /system-log',
          deps_out: 'server.js GET /system-log → studio comm panel',
          functions: 'Tableau [{ts, from, to, action, status, detail}]',
          critical: false,
          status: 'OK',
          fix: 'Si vide: normal si pas de messages inter-IA — POST /system-log pour ajouter'
        },
        {
          id: 'tasks-json',
          name: 'tasks.json',
          path: 'tasks.json',
          cat: 'Données',
          role: 'File de tâches — instructions pour agent-worker.js',
          deps_in: 'Humain/IA (écriture)',
          deps_out: 'agent-worker.js (lecture), GET /tasks',
          functions: 'Tableau [{task_id, instruction, status, steps[], result}]',
          critical: false,
          status: 'OK',
          fix: 'Vérifier format JSON — GET /tasks pour voir l\'état'
        },
        {
          id: 'logs-json',
          name: 'logs.json',
          path: 'logs.json',
          cat: 'Données',
          role: 'Logs exécution — actions agents, erreurs, résultats',
          deps_in: 'agent-worker.js (écriture)',
          deps_out: 'GET /logs',
          functions: 'Tableau [{agent, action, status, detail, ts}]',
          critical: false,
          status: 'OK',
          fix: 'GET /logs pour voir — vider si trop gros'
        },
        {
          id: 'safe-mode-json',
          name: 'SAFE_MODE_CONFIG.json',
          path: 'SAFE_MODE_CONFIG.json',
          cat: 'Données',
          role: 'Config safe mode — pollings désactivés par défaut pour économiser CPU',
          deps_in: 'server.js (lecture au démarrage)',
          deps_out: 'Contrôle orchestration auto, analyzer auto',
          functions: 'Flags: autoOrchestration, autoAnalyzer, healthCheckPolling, safeMode',
          critical: false,
          status: 'OK',
          fix: 'Si orchestration ne démarre pas: vérifier autoOrchestration: true dans ce fichier'
        }
      ]
    },

    // ── ROUTES IMPORTANTES ────────────────────────────────────
    routes: [
      { path: '/health',                   method: 'GET',  desc: 'Santé serveur — ok, uptime, mt5Status, dataSource' },
      { path: '/studio',                   method: 'GET',  desc: 'Page studio trading' },
      { path: '/dashboard',                method: 'GET',  desc: 'Dashboard Bridge MT5' },
      { path: '/agent-log',                method: 'GET',  desc: 'Hub central — toutes les tâches' },
      { path: '/stream',                   method: 'GET',  desc: 'SSE stream — prix live, analyses en temps réel' },
      { path: '/state',                    method: 'GET',  desc: 'État complet système — market-store + agents' },
      { path: '/quote?symbol=XAUUSD',      method: 'GET',  desc: 'Prix live pour symbole' },
      { path: '/klines?symbol=XAUUSD&tf=H1&limit=80', method: 'GET', desc: 'Klines OHLC — 80 bougies' },
      { path: '/instant-trade-live?symbol=XAUUSD&mode=SNIPER', method: 'GET', desc: 'Signal trade live — direction, score, entry, sl, tp' },
      { path: '/match-symbol/XAUUSD?price=2050', method: 'GET', desc: 'Validation symbole — canonical, syncStatus, type' },
      { path: '/agent-bus',                method: 'GET',  desc: 'Tâches multi-IA — done/inProgress/pending' },
      { path: '/system-log',               method: 'GET',  desc: 'Journal messages inter-IA' },
      { path: '/active-symbol',            method: 'GET',  desc: 'Symbole actif depuis extension Chrome' },
      { path: '/active-symbol',            method: 'POST', desc: 'Mettre à jour symbole actif' },
      { path: '/orchestration/run-now',    method: 'POST', desc: 'Déclencher cycle orchestration' },
      { path: '/mt5/latest',               method: 'GET',  desc: 'Dernière donnée MT5 reçue' },
      { path: '/mapping/list',             method: 'GET',  desc: 'Mappings symboles sauvegardés' },
      { path: '/positions',                method: 'GET',  desc: 'Positions ouvertes MT5' },
      { path: '/news',                     method: 'GET',  desc: 'Feed news récent' },
      { path: '/calendar',                 method: 'GET',  desc: 'Calendrier économique' },
      { path: '/analyze?symbol=XAUUSD',    method: 'GET',  desc: 'Analyse technique complète' },
      { path: '/tasks',                    method: 'GET',  desc: 'File de tâches agent-worker' }
    ]
  };

  // ══════════════════════════════════════════════════════════════
  //  GÉNÉRATION PROMPT RÉPARATION
  // ══════════════════════════════════════════════════════════════

  function makeRepairPrompt(file, issue) {
    const f = file;
    const p = ROOT + '\\' + f.path.replace(/\//g, '\\');
    return [
      '# 🔧 DEMANDE DE RÉPARATION — Trading Auto',
      '',
      '## Projet',
      '**Trading Auto** — Plateforme Copy Trading MT5',
      '**Serveur**: http://localhost:4000',
      '**Stack**: Node.js Express + LightweightCharts + Chrome Extension MV3 + Python MT5 Bridge',
      '',
      '## Fichier concerné',
      '- **Nom**: `' + f.name + '`',
      '- **Chemin**: `' + p + '`',
      '- **Catégorie**: ' + f.cat,
      '- **Rôle**: ' + f.role,
      '',
      '## Ce qu\'il fait',
      (f.functions ? '- Fonctions: `' + f.functions + '`' : ''),
      (f.deps_in   ? '- Appelé par: ' + f.deps_in   : ''),
      (f.deps_out  ? '- Appelle: '    + f.deps_out   : ''),
      (f.ids       ? '- IDs DOM: '    + f.ids        : ''),
      (f.routes    ? '- Routes: '     + f.routes     : ''),
      '',
      '## Problème à résoudre',
      issue || '⚠️ [Décris le problème ici]',
      '',
      '## Instructions',
      '- ✅ Zones sûres: ' + (f.safe   || 'voir le code'),
      '- ❌ Ne pas toucher: ' + (f.danger || 'voir le code'),
      '- 🔧 Conseil: ' + (f.fix || 'voir le code'),
      '',
      '## Règles absolues du projet',
      '- ❌ Jamais Math.random() pour les prix — données réelles MT5 uniquement',
      '- ❌ Ne pas changer les routes API existantes dans server.js',
      '- ✅ Toutes les requêtes fetch → AbortSignal.timeout(4000)',
      '- ✅ Redémarrer node server.js après modification de server.js',
      '- ✅ Recharger chrome://extensions après modification de l\'extension',
    ].filter(Boolean).join('\n');
  }

  // ══════════════════════════════════════════════════════════════
  //  HELPER: COPIER
  // ══════════════════════════════════════════════════════════════

  let toastTimer = null;
  function copyAndToast(text, label) {
    navigator.clipboard.writeText(text).then(() => {
      const t = document.getElementById('dh-toast');
      if (t) {
        clearTimeout(toastTimer);
        t.textContent = '✅ ' + (label || 'Copié !');
        t.style.display = 'block';
        toastTimer = setTimeout(() => { t.style.display = 'none'; }, 2000);
      }
    }).catch(() => { /* clipboard unavailable */ });
  }

  // ══════════════════════════════════════════════════════════════
  //  RENDER
  // ══════════════════════════════════════════════════════════════

  const CSS = `
    #dh-btn{position:fixed;bottom:16px;right:16px;z-index:999998;width:46px;height:46px;border-radius:50%;background:linear-gradient(135deg,#0d1b2e,#1e40af);border:2px solid #3b82f6;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:0 4px 20px rgba(59,130,246,0.5);transition:transform .2s;user-select:none;}
    #dh-btn:hover{transform:scale(1.15);}
    #dh-wrap{position:fixed;bottom:70px;right:16px;z-index:999999;width:360px;max-height:80vh;overflow-y:auto;background:#0d1b2e;border:1px solid #1e40af;border-radius:12px;font-family:'Segoe UI',system-ui,sans-serif;font-size:12px;color:#e2e8f0;box-shadow:0 12px 40px rgba(0,0,0,.7);display:none;}
    #dh-wrap::-webkit-scrollbar{width:4px;}
    #dh-wrap::-webkit-scrollbar-thumb{background:#1e40af;border-radius:4px;}
    .dh-header{background:#0f2847;padding:11px 14px;border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:1;}
    .dh-title{font-weight:700;color:#60a5fa;font-size:13px;}
    .dh-close{cursor:pointer;color:#64748b;font-size:18px;line-height:1;padding:2px 6px;border-radius:4px;}
    .dh-close:hover{background:#1e3a5f;color:#e2e8f0;}
    .dh-tabs{display:flex;gap:4px;padding:8px 10px;background:#080f1e;border-bottom:1px solid #1e3a5f;}
    .dh-tab{padding:5px 10px;border-radius:5px;cursor:pointer;color:#64748b;font-size:11px;font-weight:600;border:1px solid transparent;}
    .dh-tab:hover{background:#1e3a5f;color:#e2e8f0;}
    .dh-tab.on{background:#1e40af;color:#fff;border-color:#3b82f6;}
    .dh-pane{padding:12px 14px;display:none;}
    .dh-pane.on{display:block;}
    .dh-block{background:#060e1a;border-radius:7px;padding:9px 11px;margin-bottom:8px;border-left:3px solid #1e40af;}
    .dh-block.green{border-left-color:#10b981;}
    .dh-block.red{border-left-color:#ef4444;}
    .dh-block.amber{border-left-color:#f59e0b;}
    .dh-label{color:#475569;font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;}
    .dh-val{color:#e2e8f0;font-size:11px;line-height:1.5;}
    .dh-mono{font-family:'Courier New',monospace;color:#60a5fa;font-size:10px;word-break:break-all;}
    .dh-row{display:flex;gap:5px;margin-bottom:6px;flex-wrap:wrap;}
    .dh-btn-sm{background:#0f2847;color:#60a5fa;border:1px solid #1e40af;padding:5px 9px;border-radius:5px;cursor:pointer;font-size:10px;font-weight:700;white-space:nowrap;}
    .dh-btn-sm:hover{background:#1e40af;color:#fff;}
    .dh-btn-sm.primary{background:#1e40af;color:#fff;}
    .dh-btn-sm.primary:hover{background:#2563eb;}
    .dh-btn-sm.green{background:#064e3b;color:#10b981;border-color:#10b981;}
    .dh-btn-sm.green:hover{background:#10b981;color:#fff;}
    .dh-btn-sm.red{background:#450a0a;color:#ef4444;border-color:#ef4444;}
    .dh-section{font-weight:700;color:#3b82f6;font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin:12px 0 7px;border-bottom:1px solid #1e3a5f;padding-bottom:4px;}
    .dh-file-row{display:flex;align-items:flex-start;gap:6px;padding:6px 8px;border-radius:6px;margin-bottom:4px;background:#060e1a;}
    .dh-file-row:hover{background:#0f2847;}
    .dh-file-name{color:#93c5fd;font-family:'Courier New',monospace;font-size:10px;font-weight:700;min-width:0;flex:1;}
    .dh-file-role{color:#64748b;font-size:10px;margin-top:2px;}
    .dh-status{padding:2px 6px;border-radius:8px;font-size:9px;font-weight:700;white-space:nowrap;}
    .dh-ok{background:rgba(16,185,129,.12);color:#10b981;}
    .dh-offline{background:rgba(239,68,68,.12);color:#ef4444;}
    .dh-info{background:rgba(59,130,246,.12);color:#60a5fa;}
    .dh-warn{background:rgba(245,158,11,.12);color:#f59e0b;}
    .dh-route-row{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:5px;margin-bottom:3px;background:#060e1a;}
    .dh-route-method{font-size:9px;font-weight:700;padding:2px 5px;border-radius:3px;background:#1e3a5f;color:#93c5fd;}
    .dh-route-path{font-family:monospace;font-size:10px;color:#60a5fa;}
    .dh-route-desc{color:#475569;font-size:9px;flex:1;}
    .dh-repair-area{width:100%;min-height:55px;background:#060e1a;border:1px solid #1e3a5f;border-radius:6px;color:#e2e8f0;font-family:'Segoe UI',sans-serif;font-size:11px;padding:8px;resize:vertical;box-sizing:border-box;}
    .dh-repair-area::placeholder{color:#334155;}
    #dh-toast{display:none;background:#10b981;color:#fff;padding:6px 12px;border-radius:7px;text-align:center;font-size:11px;font-weight:700;margin-top:8px;}
  `;

  function renderFileList(items, showRepair) {
    return items.map(f => `
      <div class="dh-file-row">
        <div style="flex:1;min-width:0;">
          <div class="dh-file-name">${f.name}</div>
          <div class="dh-file-role">${f.role}</div>
          <div class="dh-row" style="margin-top:5px;">
            <button class="dh-btn-sm" onclick="dhCopyPath('${f.path}')">📂 Chemin</button>
            <button class="dh-btn-sm primary" onclick="dhCopyRepair('${f.id}','')">🤖 Contexte IA</button>
            ${showRepair ? `<button class="dh-btn-sm red" onclick="dhOpenRepair('${f.id}')">🔧 Réparer</button>` : ''}
          </div>
        </div>
        <span class="dh-status ${f.status==='OK'?'dh-ok':f.status==='OFFLINE'?'dh-offline':f.status==='À installer'?'dh-warn':'dh-info'}">${f.status}</span>
      </div>
    `).join('');
  }

  function buildUI() {
    const path = window.location.pathname.replace(/\/$/, '') || '/';
    const page = SYSTEM.pages[path];

    return `
      <div class="dh-header">
        <span class="dh-title">🛠️ Trading Auto — Contexte &amp; Réparation</span>
        <span class="dh-close" onclick="document.getElementById('dh-wrap').style.display='none'">✕</span>
      </div>
      <div class="dh-tabs">
        <div class="dh-tab on"  onclick="dhTab(this,'dh-p0')">📍 Page</div>
        <div class="dh-tab"     onclick="dhTab(this,'dh-p1')">🗂️ Fichiers</div>
        <div class="dh-tab"     onclick="dhTab(this,'dh-p2')">🔗 Routes</div>
        <div class="dh-tab"     onclick="dhTab(this,'dh-p3')">🔧 Réparer</div>
      </div>

      <!-- PANE 0: PAGE ACTUELLE -->
      <div class="dh-pane on" id="dh-p0">
        ${page ? `
        <div class="dh-block"><div class="dh-label">Fichier</div><div class="dh-mono">${page.file}</div></div>
        <div class="dh-block green"><div class="dh-label">✅ Tu peux modifier</div><div class="dh-val">${page.safe}</div></div>
        <div class="dh-block red"><div class="dh-label">❌ Ne pas toucher</div><div class="dh-val">${page.danger}</div></div>
        <div class="dh-block amber"><div class="dh-label">Dépendances</div><div class="dh-mono">${page.deps}</div></div>
        <div class="dh-row">
          <button class="dh-btn-sm" onclick="dhCopyPath('${page.file}')">📂 Copier chemin</button>
          <button class="dh-btn-sm primary" onclick="dhCopyPageCtx()">🤖 Contexte IA</button>
          <button class="dh-btn-sm green" onclick="window.open('/agent-log','_blank')">🌐 Hub</button>
        </div>
        ` : `<div style="color:#475569;padding:20px;text-align:center;">Page non répertoriée<br><a href="/agent-log" style="color:#3b82f6;">→ Hub Central</a></div>`}
        <div id="dh-toast"></div>
      </div>

      <!-- PANE 1: TOUS LES FICHIERS PAR CATÉGORIE -->
      <div class="dh-pane" id="dh-p1">
        <div class="dh-section">⚙️ Backend</div>
        ${renderFileList(SYSTEM.files.backend, true)}
        <div class="dh-section">🖥️ HTML / Studio</div>
        ${renderFileList(SYSTEM.files.html, true)}
        <div class="dh-section">🧩 Extension Chrome</div>
        ${renderFileList(SYSTEM.files.extension, true)}
        <div class="dh-section">🤖 Agents (23)</div>
        ${renderFileList(SYSTEM.files.agents, false)}
        <div class="dh-section">🔌 Bridge MT5</div>
        ${renderFileList(SYSTEM.files.bridge, true)}
        <div class="dh-section">💾 Données JSON</div>
        ${renderFileList(SYSTEM.files.data, false)}
        <div id="dh-toast"></div>
      </div>

      <!-- PANE 2: ROUTES API -->
      <div class="dh-pane" id="dh-p2">
        <div class="dh-section">Routes API — :4000</div>
        ${SYSTEM.routes.map(r => `
          <div class="dh-route-row">
            <span class="dh-route-method">${r.method}</span>
            <span class="dh-route-path">${r.path.split('?')[0]}</span>
            <button class="dh-btn-sm" style="margin-left:auto;padding:2px 6px;font-size:9px;" onclick="dhTestRoute('${r.path}')">Test</button>
          </div>
          <div style="color:#475569;font-size:9px;padding:0 8px 4px 50px;">${r.desc}</div>
        `).join('')}
        <div id="dh-toast"></div>
      </div>

      <!-- PANE 3: RÉPARATION -->
      <div class="dh-pane" id="dh-p3">
        <div class="dh-block">
          <div class="dh-label">🔧 Mode Réparation</div>
          <div class="dh-val" style="margin-bottom:8px;">Sélectionne un fichier + décris le problème → copie le prompt pour IA</div>
          <select id="dh-repair-file" style="width:100%;background:#060e1a;color:#e2e8f0;border:1px solid #1e3a5f;border-radius:5px;padding:6px;font-size:11px;margin-bottom:8px;">
            <option value="">— Sélectionne le fichier à réparer —</option>
            ${[...SYSTEM.files.backend,...SYSTEM.files.html,...SYSTEM.files.extension,...SYSTEM.files.bridge,...SYSTEM.files.data].map(f =>
              `<option value="${f.id}">[${f.cat}] ${f.name}</option>`
            ).join('')}
          </select>
          <textarea id="dh-repair-issue" class="dh-repair-area" placeholder="Décris le problème... ex: 'Le graphique est blanc', 'Le prix ne se met pas à jour', 'Le bouton X ne répond pas'"></textarea>
          <div class="dh-row" style="margin-top:8px;">
            <button class="dh-btn-sm primary" onclick="dhGenerateRepair()">🤖 Générer prompt IA</button>
            <button class="dh-btn-sm green" onclick="dhCopyAllContext()">📋 Copier tout le contexte</button>
          </div>
          <div id="dh-repair-preview" style="display:none;margin-top:8px;background:#060e1a;border:1px solid #1e3a5f;border-radius:6px;padding:8px;font-family:monospace;font-size:9px;color:#64748b;max-height:120px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;"></div>
        </div>
        <div class="dh-block amber">
          <div class="dh-label">⚠️ Fichiers OFFLINE</div>
          ${[...SYSTEM.files.bridge, ...SYSTEM.files.backend].filter(f => f.status === 'OFFLINE').map(f => `
            <div style="margin-bottom:6px;">
              <div class="dh-mono">${f.name}</div>
              <div style="color:#f59e0b;font-size:10px;margin-top:2px;">${f.fix}</div>
              <button class="dh-btn-sm" style="margin-top:4px;" onclick="dhCopyText('${f.fix.replace(/'/g,"\\'")}')">📋 Copier cmd</button>
            </div>
          `).join('')}
        </div>
        <div id="dh-toast"></div>
      </div>
    `;
  }

  // ══════════════════════════════════════════════════════════════
  //  ACTIONS GLOBALES
  // ══════════════════════════════════════════════════════════════

  window.dhTab = function(el, paneId) {
    document.querySelectorAll('.dh-tab').forEach(t => t.classList.remove('on'));
    document.querySelectorAll('.dh-pane').forEach(p => p.classList.remove('on'));
    el.classList.add('on');
    document.getElementById(paneId).classList.add('on');
  };

  window.dhCopyPath = function(relPath) {
    const full = ROOT + '\\' + relPath.replace(/\//g, '\\');
    copyAndToast(full, 'Chemin copié !');
  };

  window.dhCopyText = function(text) {
    copyAndToast(text, 'Copié !');
  };

  window.dhCopyRepair = function(fileId, issue) {
    const allFiles = [
      ...SYSTEM.files.backend, ...SYSTEM.files.html,
      ...SYSTEM.files.extension, ...SYSTEM.files.agents,
      ...SYSTEM.files.bridge, ...SYSTEM.files.data
    ];
    const f = allFiles.find(x => x.id === fileId);
    if (!f) return;
    const repairText = makeRepairPrompt(f, issue || '');
    copyAndToast(repairText, 'Contexte IA copié !');
  };

  window.dhOpenRepair = function(fileId) {
    const allFiles = [
      ...SYSTEM.files.backend, ...SYSTEM.files.html,
      ...SYSTEM.files.extension, ...SYSTEM.files.agents,
      ...SYSTEM.files.bridge, ...SYSTEM.files.data
    ];
    const f = allFiles.find(x => x.id === fileId);
    if (!f) return;
    // Switch to repair tab
    document.querySelectorAll('.dh-tab').forEach(t => t.classList.remove('on'));
    document.querySelectorAll('.dh-pane').forEach(p => p.classList.remove('on'));
    const repairTab = document.querySelectorAll('.dh-tab')[3];
    if (repairTab) repairTab.classList.add('on');
    const repairPane = document.getElementById('dh-p3');
    if (repairPane) repairPane.classList.add('on');
    const sel = document.getElementById('dh-repair-file');
    if (sel) sel.value = fileId;
    const area = document.getElementById('dh-repair-issue');
    if (area) area.focus();
  };

  window.dhGenerateRepair = function() {
    const allFiles = [
      ...SYSTEM.files.backend, ...SYSTEM.files.html,
      ...SYSTEM.files.extension, ...SYSTEM.files.agents,
      ...SYSTEM.files.bridge, ...SYSTEM.files.data
    ];
    const fileId = document.getElementById('dh-repair-file')?.value;
    const issue  = document.getElementById('dh-repair-issue')?.value || '';
    if (!fileId) { alert('Sélectionne un fichier d\'abord'); return; }
    const f = allFiles.find(x => x.id === fileId);
    if (!f) return;
    const repairText = makeRepairPrompt(f, issue);
    const preview = document.getElementById('dh-repair-preview');
    if (preview) { preview.style.display = 'block'; preview.textContent = repairText; }
    copyAndToast(repairText, 'Prompt réparation copié !');
  };

  window.dhCopyAllContext = function() {
    const ctx = [
      '# CONTEXTE COMPLET — Trading Auto System',
      '## Serveur: http://localhost:4000',
      '## Stack: Node.js Express + LightweightCharts + Chrome Extension MV3 (single environment :4000)',
      '## Règles: ❌ No Math.random() for prices ✅ AbortSignal.timeout() on all fetch ✅ Real MT5 data only',
      '',
      '## Fichiers critiques:',
      '- server.js → ' + ROOT + '\\server.js (60+ routes, PORT 4000)',
      '- store/market-store.js → SSE singleton',
      '- lib/symbol-matcher.js → 50+ symbol variants',
      '- src/agents/orchestrator.js → master agent coordinator',
      '- studio/index-simple.html + studioapp-simple.js → trading studio',
      '- tradingview-analyzer/popup.js → Chrome extension (1936L)',
      '- AGENT_BUS.json → multi-AI task coordination',
      '',
      '## Routes essentielles:',
      SYSTEM.routes.slice(0, 10).map(r => r.method + ' ' + SERVER + r.path + ' → ' + r.desc).join('\n'),
      '',
      '## Page actuelle: ' + window.location.href,
    ].join('\n');
    copyAndToast(ctx, 'Contexte global copié !');
  };

  window.dhCopyPageCtx = function() {
    const path = window.location.pathname.replace(/\/$/, '') || '/';
    const page = SYSTEM.pages[path];
    if (!page) return;
    const text = [
      '# Page: ' + path + ' — ' + page.role,
      '📄 Fichier: ' + page.file,
      '📂 Chemin: ' + ROOT + '\\' + page.file.replace(/\//g, '\\'),
      '✅ Sûr: ' + page.safe,
      '❌ Danger: ' + page.danger,
      '🔗 Dépend de: ' + page.deps,
      '⚙️ Tech: ' + page.tech,
    ].join('\n');
    copyAndToast(text, 'Contexte page copié !');
  };

  window.dhTestRoute = function(route) {
    fetch(SERVER + route, { signal: AbortSignal.timeout(5000) })
      .then(r => r.json())
      .then(d => {
        const msg = JSON.stringify(d).slice(0, 200);
        copyAndToast(msg, 'Résultat copié !');
      })
      .catch(e => copyAndToast('❌ Erreur: ' + e.message, 'Erreur copiée'));
  };

  // ══════════════════════════════════════════════════════════════
  //  INJECTION DANS LA PAGE
  // ══════════════════════════════════════════════════════════════

  function init() {
    // CSS
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // Bouton flottant
    const btn = document.createElement('div');
    btn.id = 'dh-btn';
    btn.innerHTML = '🛠️';
    btn.title = 'Contexte & Réparation';
    btn.onclick = () => {
      const w = document.getElementById('dh-wrap');
      if (w) w.style.display = w.style.display === 'none' ? 'block' : 'none';
    };
    document.body.appendChild(btn);

    // Panneau
    const wrap = document.createElement('div');
    wrap.id = 'dh-wrap';
    wrap.innerHTML = buildUI();
    document.body.appendChild(wrap);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
