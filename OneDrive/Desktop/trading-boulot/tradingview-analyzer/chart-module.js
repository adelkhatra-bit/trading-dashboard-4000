// chart-module.js — Gère le graphique interne depuis flux TradingView/backend
// Source: /klines → candles → rendu canvas/lightweight-charts
'use strict';

const ChartModule = {
  
  _chart: null,
  _candleSeries: null,
  _currentSymbol: null,
  _currentTF: 'H1',
  _apiBase: 'http://127.0.0.1:4001',  // TRADING AUTO EXCLUSIVE
  _entryLine: null,
  _slLine: null,
  _tpLine: null,
  _livePriceLine: null,
  _lastRates: null,       // keep last loaded rates so live-update needs no full reload
  _lastLevels: null,      // cache last valid entry/sl/tp — never cleared when position active
  
  // ── INIT CHART ──────────────────────────────────────────────────────────
  init: function(containerId) {
    const container = document.getElementById(containerId);
    if (!container) {
      console.error('[CHART] Container not found:', containerId);
      return false;
    }
    
    console.log('[CHART] v1.0 init');
    return true;
  },
  
  // ── LOAD CHART DATA FROM BACKEND KLINES ───────────────────────────────
  loadChart: async function(symbol, timeframe, levels, livePrice) {
    if (!symbol) return;
    
    const tf = timeframe || 'H1';
    const sameContext = (symbol === this._currentSymbol && tf === this._currentTF && this._candleSeries && this._lastRates);

    // ── FAST PATH: same symbol+TF → only update last candle + price lines ──
    // This preserves the user's pan/zoom position (no fitContent).
    if (sameContext) {
      const lp = Number(livePrice);
      if (Number.isFinite(lp) && lp > 0 && this._lastRates.length > 0) {
        const orig = this._lastRates[this._lastRates.length - 1];
        const updated = {
          time:  orig.time,
          open:  orig.open,
          high:  lp > orig.high ? lp : orig.high,
          low:   lp < orig.low  ? lp : orig.low,
          close: lp
        };
        try { this._candleSeries.update(updated); } catch (_) {}
      }
      this.applyTradeLevels(levels || null, Number(livePrice));
      return;
    }

    // ── FULL RELOAD: new symbol or new TF ─────────────────────────────────
    this._currentSymbol = symbol;
    this._currentTF = tf;
    this._lastRates = null;
    this._lastLevels = null;   // reset cached levels on symbol/TF change
    
    console.log(`[CHART] Loading ${symbol} ${this._currentTF} from /klines...`);
    
    try {
      const resp = await fetch(`${this._apiBase}/klines?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(this._currentTF)}&limit=200`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      
      const data = await resp.json();
      const sourceRates = Array.isArray(data?.candles) ? data.candles : [];
      if (!data.ok || sourceRates.length === 0) throw new Error(data.error || 'No chart data');
      
      const rates = sourceRates.map((k) => ({
        time: typeof k.time === 'string'
          ? Math.floor(new Date(k.time).getTime() / 1000)
          : Math.floor((Number(k.time) > 1e12 ? Number(k.time) : Number(k.time) * 1000) / 1000),
        open: parseFloat(k.open),
        high: parseFloat(k.high),
        low: parseFloat(k.low),
        close: parseFloat(k.close)
      })).sort((a, b) => a.time - b.time);

      const lp = Number(livePrice);
      if (Number.isFinite(lp) && lp > 0 && rates.length > 0) {
        const last = rates[rates.length - 1];
        const lastClose = Number(last.close);

        // ── PRICE OFFSET CORRECTION ──────────────────────────────────────────
        // Bridge TV price history may have slight offset vs live price.
        // If offset < 1.5%, shift candles to align with live TV price.
        if (lastClose > 0) {
          const offset = lp - lastClose;
          const offsetPct = Math.abs(offset / lp);
          if (offsetPct > 0 && offsetPct < 0.015) {
            rates.forEach(r => {
              r.open  = r.open  + offset;
              r.high  = r.high  + offset;
              r.low   = r.low   + offset;
              r.close = r.close + offset;
            });
            console.log(`[CHART] Price offset correction: ${offset > 0 ? '+' : ''}${offset.toFixed(3)} (${(offsetPct*100).toFixed(2)}%) bridge TV align`);
          }
        }

        // Anchor last candle close to exact live TV price
        last.close = lp;
        if (lp > Number(last.high)) last.high = lp;
        if (lp < Number(last.low))  last.low  = lp;
      }

      this.renderChart({ rates: rates, symbol: symbol, klines: rates.length });
      this._lastRates = rates;   // save for fast-path live updates
      this.applyTradeLevels(levels || null, lp);
      console.log(`[CHART] ${symbol} ${this._currentTF} loaded (${rates.length} candles)`);
    } catch (err) {
      console.error('[CHART] Load error:', err.message);
      this.showError(`Erreur graphique: ${err.message}`);
    }
  },
  
  // ── RENDER CHART ────────────────────────────────────────────────────        
  renderChart: function(data) {
    const container = document.getElementById('chart-container');
    const message = document.getElementById('chart-msg');
    if (!container) return;
    if (message) message.style.display = 'none';
    
    // Try lightweight-charts first
    if (typeof LightweightCharts !== 'undefined' && data.rates && data.rates.length > 0) {
      this.renderLightweightChart(container, data);
    } else if (data.rates && data.rates.length > 0) {
      this.renderCanvasChart(container, data);
    } else {
      this.showError('Pas de données bougies');
    }
  },
  
  // ── LIGHTWEIGHT CHARTS RENDERER ──────────────────────────────────────
  renderLightweightChart: function(container, data) {
    // Clear previous
    if (this._chart) {
      try { this._chart.remove(); } catch (_) {}
      this._chart = null;
      this._candleSeries = null;
      // Nullifier les refs de lignes — elles appartiennent à l'ancienne série (invalide)
      this._entryLine = null;
      this._slLine = null;
      this._tpLine = null;
      this._livePriceLine = null;
    }
    
    // Remove old DOM
    container.querySelectorAll('canvas, div.tv-lightweight-charts').forEach(el => el.remove());
    
    const h = container.clientHeight || 380;
    const w = container.clientWidth || 600;
    
    this._chart = LightweightCharts.createChart(container, {
      width: w, height: h,
      layout: { 
        background: { color: '#0a0f1e' }, 
        textColor: '#94a3b8' 
      },
      grid: { 
        vertLines: { color: '#0d1526' }, 
        horzLines: { color: '#0d1526' } 
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#1e3a5f' },
      timeScale: { borderColor: '#1e3a5f', timeVisible: true }
    });
    
    this._candleSeries = this._chart.addCandlestickSeries({
      upColor: '#10b981', downColor: '#ef4444',
      borderUpColor: '#10b981', borderDownColor: '#ef4444',
      wickUpColor: '#10b981', wickDownColor: '#ef4444'
    });
    
    if (data.rates && data.rates.length > 0) {
      this._candleSeries.setData(data.rates);
      this._chart.timeScale().fitContent();
    }
  },

  applyTradeLevels: function(levels, livePrice) {
    if (!this._candleSeries) return;

    // ── CACHE AVEC ENTRY VERROUILLÉE ────────────────────────────────────────
    // L'entry est verrouillée au premier appel (prix d'exécution réel).
    // SL et TP peuvent évoluer (trailing SL, ajustement TP), entry ne bouge jamais.
    // _lastLevels est remis à null uniquement lors d'un reload complet (changement sym/TF).
    if (levels && Number(levels.entry) > 0) {
      if (!this._lastLevels) {
        // Premier appel : verrouiller entry + sl + tp + direction
        // La direction est mémorisée UNE FOIS pour que la détection "sécurisé"
        // fonctionne même quand le SL franchit l'entry (le SL < entry ne tient plus)
        const _firstSl  = Number(levels.sl);
        const _firstEnt = Number(levels.entry);
        const _dir = levels.direction
          ? String(levels.direction).toUpperCase()
          : (_firstSl > 0 && _firstSl < _firstEnt ? 'LONG' : 'SHORT');
        this._lastLevels = {
          entry:    _firstEnt,
          sl:       _firstSl,
          tp:       Number(levels.tp),
          isLong:   _dir === 'LONG'  // mémorisé définitivement dès la 1ère lock
        };
      } else {
        // Entry gelée — sl/tp peuvent être mis à jour, direction immuable
        if (Number(levels.sl) > 0) this._lastLevels.sl = Number(levels.sl);
        if (Number(levels.tp) > 0) this._lastLevels.tp = Number(levels.tp);
      }
    }

    const eL    = this._lastLevels;
    const entry = eL ? Number(eL.entry) : NaN;
    const sl    = eL ? Number(eL.sl)    : NaN;
    const tp    = eL ? Number(eL.tp)    : NaN;
    const lp    = Number(livePrice);

    // ── LIGNES ENTRY / SL / TP : créer une fois, mettre à jour via applyOptions ──
    // → Zéro suppression/recréation parasite → ligne ENTRY immobile entre les ticks SSE
    try {
      // ── DÉTECTION GAINS SÉCURISÉS ─────────────────────────────────────────
      // LONG: SL ≥ entry → ligne ENTRY passe en vert (gains garantis)
      // SHORT: SL ≤ entry → idem
      // _isLong est verrouillé à la création de la position (ne change pas quand SL dépasse entry)
      const _isLongPos = eL && eL.isLong !== undefined
        ? eL.isLong
        : (sl > 0 && entry > 0 && sl < entry);
      const _secured = entry > 0 && sl > 0
        && (_isLongPos ? sl >= entry : sl <= entry);
      const _entryColor = _secured ? '#22c55e' : '#f97316';  // vert si sécurisé, orange sinon
      const _entryTitle = _secured ? 'ENTRY ✅' : 'ENTRY';

      // ENTRY — ligne fixe, jamais supprimée tant que position active
      if (Number.isFinite(entry) && entry > 0) {
        if (!this._entryLine) {
          this._entryLine = this._candleSeries.createPriceLine({
            price: entry, color: _entryColor, lineWidth: 3, lineStyle: 0,
            axisLabelVisible: true, title: _entryTitle
          });
        } else {
          this._entryLine.applyOptions({ price: entry, color: _entryColor, title: _entryTitle });
        }
      } else if (this._entryLine) {
        this._candleSeries.removePriceLine(this._entryLine); this._entryLine = null;
      }

      // SL — rouge fixe, mis à jour via applyOptions
      if (Number.isFinite(sl) && sl > 0) {
        if (!this._slLine) {
          this._slLine = this._candleSeries.createPriceLine({
            price: sl, color: '#ef4444', lineWidth: 2, lineStyle: 2,
            axisLabelVisible: true, title: 'SL'
          });
        } else {
          this._slLine.applyOptions({ price: sl });
        }
      } else if (this._slLine) {
        this._candleSeries.removePriceLine(this._slLine); this._slLine = null;
      }

      // TP
      if (Number.isFinite(tp) && tp > 0) {
        if (!this._tpLine) {
          this._tpLine = this._candleSeries.createPriceLine({
            price: tp, color: '#22c55e', lineWidth: 2, lineStyle: 2,
            axisLabelVisible: true, title: 'TP'
          });
        } else {
          this._tpLine.applyOptions({ price: tp });
        }
      } else if (this._tpLine) {
        this._candleSeries.removePriceLine(this._tpLine); this._tpLine = null;
      }

      // LIVE — prix change à chaque tick : supprimer/recréer uniquement celui-ci
      if (this._livePriceLine) {
        this._candleSeries.removePriceLine(this._livePriceLine);
        this._livePriceLine = null;
      }
      if (Number.isFinite(lp) && lp > 0) {
        this._livePriceLine = this._candleSeries.createPriceLine({
          price: lp, color: '#f59e0b', lineWidth: 1, lineStyle: 0,
          axisLabelVisible: true, title: 'LIVE'
        });
      }
    } catch (_) {}
  },
  
  // ── CANVAS FALLBACK RENDERER ──────────────────────────────────────────
  renderCanvasChart: function(container, data) {
    // Clear old
    container.querySelectorAll('canvas').forEach(el => el.remove());
    
    if (!data.rates || data.rates.length === 0) return;
    
    const canvas = document.createElement('canvas');
    canvas.width = container.clientWidth || 600;
    canvas.height = container.clientHeight || 380;
    container.appendChild(canvas);
    
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const n = Math.min(data.rates.length, 500);
    const slice = data.rates.slice(-n);
    
    let minP = Infinity, maxP = -Infinity;
    slice.forEach(b => {
      minP = Math.min(minP, b.low || 0);
      maxP = Math.max(maxP, b.high || 0);
    });
    
    const range = maxP - minP || 1;
    const pad = 40, bw = (W - pad * 2) / n;
    
    // Background
    ctx.fillStyle = '#0a0f1e';
    ctx.fillRect(0, 0, W, H);
    
    // Draw candles
    slice.forEach((b, i) => {
      const x = pad + i * bw;
      const up = b.close >= b.open;
      
      const yO = H - pad - ((b.open - minP) / range) * (H - pad * 2);
      const yC = H - pad - ((b.close - minP) / range) * (H - pad * 2);
      const yH = H - pad - ((b.high - minP) / range) * (H - pad * 2);
      const yL = H - pad - ((b.low - minP) / range) * (H - pad * 2);
      
      // Wick
      ctx.strokeStyle = up ? '#10b981' : '#ef4444';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + bw / 2, yH);
      ctx.lineTo(x + bw / 2, yL);
      ctx.stroke();
      
      // Body
      ctx.fillStyle = up ? '#10b981' : '#ef4444';
      ctx.fillRect(x + bw * 0.1, Math.min(yO, yC), bw * 0.8, Math.abs(yC - yO) || 1);
    });
    
    // Info text
    ctx.fillStyle = '#64748b';
    ctx.font = '12px monospace';
    ctx.fillText(`${this._currentSymbol} ${this._currentTF}`, pad, 20);
    ctx.fillText(`Min: ${minP.toFixed(5)} | Max: ${maxP.toFixed(5)}`, pad, H - 10);
  },
  
  // ── SHOW ERROR ──────────────────────────────────────────────────────
  showError: function(msg) {
    const el = document.getElementById('chart-msg');
    if (el) {
      el.textContent = msg;
      el.style.display = 'block';
    }
  },
  
  // ── RESET LEVELS (autorité serveur) ────────────────────────────────
  // Appelé par position-sync quand le serveur envoie une entry différente du cache local.
  // Efface _lastLevels pour que le prochain applyTradeLevels reprenne le prix serveur.
  resetLevels: function() {
    this._lastLevels = null;
  },

  // ── GET CURRENT STATE ──────────────────────────────────────────────
  getCurrentState: function() {
    return {
      symbol: this._currentSymbol,
      timeframe: this._currentTF,
      chartReady: this._chart !== null || this._candleSeries !== null
    };
  }
};
