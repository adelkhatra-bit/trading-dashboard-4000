// chart-module.js — Gère le graphique interne depuis flux TradingView/backend
// Source: /klines → candles → rendu canvas/lightweight-charts
'use strict';

const ChartModule = {
  
  _chart: null,
  _candleSeries: null,
  _currentSymbol: null,
  _currentTF: 'H1',
  _apiBase: 'http://127.0.0.1:4000',  // TRADING AUTO EXCLUSIVE
  _entryLine: null,
  _slLine: null,
  _tpLine: null,
  _livePriceLine: null,
  _lastRates: null,       // keep last loaded rates so live-update needs no full reload
  
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
      if (!data.ok) throw new Error(data.error || 'klines error');
      if (sourceRates.length === 0) {
        // Pas d'historique OHLCV — TradingView n'a pas encore envoyé de ticks
        // Afficher un message silencieux sans crasher
        this.showError('Graphique indisponible — Ouvrir TradingView pour alimenter le bridge');
        console.info('[CHART] Aucune donnée klines — bridge en attente de ticks Pine Script');
        return;
      }
      
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
        last.close = lp;
        if (lp > Number(last.high)) last.high = lp;
        if (lp < Number(last.low)) last.low = lp;
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
    try {
      if (this._entryLine) { this._candleSeries.removePriceLine(this._entryLine); this._entryLine = null; }
      if (this._slLine) { this._candleSeries.removePriceLine(this._slLine); this._slLine = null; }
      if (this._tpLine) { this._candleSeries.removePriceLine(this._tpLine); this._tpLine = null; }
      if (this._livePriceLine) { this._candleSeries.removePriceLine(this._livePriceLine); this._livePriceLine = null; }
    } catch (_) {}

    const entry = Number(levels && levels.entry);
    const sl = Number(levels && levels.sl);
    const tp = Number(levels && levels.tp);

    if (Number.isFinite(entry) && entry > 0) {
      this._entryLine = this._candleSeries.createPriceLine({
        price: entry,
        color: '#60a5fa',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'ENTRY'
      });
    }
    if (Number.isFinite(sl) && sl > 0) {
      this._slLine = this._candleSeries.createPriceLine({
        price: sl,
        color: '#ef4444',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'SL'
      });
    }
    if (Number.isFinite(tp) && tp > 0) {
      this._tpLine = this._candleSeries.createPriceLine({
        price: tp,
        color: '#22c55e',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'TP'
      });
    }

    const lp = Number(livePrice);
    if (Number.isFinite(lp) && lp > 0) {
      this._livePriceLine = this._candleSeries.createPriceLine({
        price: lp,
        color: '#f59e0b',
        lineWidth: 1,
        lineStyle: 0,
        axisLabelVisible: true,
        title: 'LIVE'
      });
    }
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
  
  // ── NO DATA HANDLER ───────────────────────────────────────────────
  showNoData: function(containerId) {
    const container = document.getElementById(containerId || 'chart-container');
    if (container) {
      container.innerHTML = '<div style="color:#f87171;font-weight:bold;padding:20px;">NO DATA</div>';
    }
    this._lastRates = null;
    this._currentSymbol = null;
    this._currentTF = null;
    this._candleSeries = null;
    this._chart = null;
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
