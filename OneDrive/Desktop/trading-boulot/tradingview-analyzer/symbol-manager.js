// symbol-manager.js v1.0 — Multi-Symbol Dynamic Management
'use strict';

const SymbolManager = {
  // ── Configuration ──────────────────────────────────────────────────────
  favorites: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDCAD', 'AUDUSD', 'NZDUSD', 'USDCNH'],
  defaultSymbol: 'XAUUSD',
  storageKey: 'activeSymbol',
  recentStorageKey: 'recentSymbols',
  
  // ── State ────────────────────────────────────────────────────────────
  currentSymbol: null,
  recentSymbols: [],
  listeners: [],
  
  // ── Initialize ───────────────────────────────────────────────────────
  init() {
    this.loadFromStorage();
    console.log('[SYMBOL_MGR] Initialized with:', this.currentSymbol);
  },
  
  // ── Load from Storage ──────────────────────────────────────────────────
  loadFromStorage() {
    try {
      chrome.storage.local.get([this.storageKey, this.recentStorageKey], (result) => {
        this.currentSymbol = result[this.storageKey] || this.defaultSymbol;
        this.recentSymbols = result[this.recentStorageKey] || [];
        console.log('[SYMBOL_MGR] Loaded from storage:', this.currentSymbol);
      });
    } catch (_) {
      this.currentSymbol = this.defaultSymbol;
      this.recentSymbols = [];
    }
  },
  
  // ── Set Current Symbol ───────────────────────────────────────────────
  setSymbol(symbol) {
    if (!symbol) return;
    
    symbol = symbol.toUpperCase().trim();
    
    // No change
    if (symbol === this.currentSymbol) return;
    
    // Validate symbol (basic check)
    if (!/^[A-Z0-9]{2,12}$/.test(symbol)) {
      console.error('[SYMBOL_MGR] Invalid symbol format:', symbol);
      return;
    }
    
    // Save to storage
    this.currentSymbol = symbol;
    try {
      chrome.storage.local.set({[this.storageKey]: symbol});
    } catch (_) {}
    
    // Add to recent
    this.addToRecent(symbol);
    
    // Notify listeners
    this.notifyListeners({symbol, changed: true});
    
    console.log('[SYMBOL_MGR] Symbol changed to:', symbol);
  },
  
  // ── Add to Recent ──────────────────────────────────────────────────────
  addToRecent(symbol) {
    // Remove duplicates
    this.recentSymbols = this.recentSymbols.filter(s => s !== symbol);
    
    // Add to front
    this.recentSymbols.unshift(symbol);
    
    // Keep last 10
    if (this.recentSymbols.length > 10) {
      this.recentSymbols = this.recentSymbols.slice(0, 10);
    }
    
    // Save
    try {
      chrome.storage.local.set({[this.recentStorageKey]: this.recentSymbols});
    } catch (_) {}
  },
  
  // ── Get Current Symbol ────────────────────────────────────────────────
  getSymbol() {
    return this.currentSymbol || this.defaultSymbol;
  },
  
  // ── Get Data Filename for Symbol ──────────────────────────────────────
  getDataFilename(symbol = null) {
    symbol = symbol || this.currentSymbol;
    return `tv_data_${symbol || 'XAUUSD'}.json`;
  },
  
  // ── Get All Available Symbols ────────────────────────────────────────
  getAllSymbols() {
    return [
      ...new Set([...this.favorites, ...this.recentSymbols])
    ];
  },
  
  // ── Add Listener ──────────────────────────────────────────────────────
  addListener(callback) {
    this.listeners.push(callback);
  },
  
  // ── Remove Listener ──────────────────────────────────────────────────
  removeListener(callback) {
    this.listeners = this.listeners.filter(l => l !== callback);
  },
  
  // ── Notify Listeners ──────────────────────────────────────────────────
  notifyListeners(change) {
    this.listeners.forEach(listener => {
      try {
        listener(change);
      } catch (e) {
        console.error('[SYMBOL_MGR] Listener error:', e);
      }
    });
    
    // Also dispatch custom event
    window.dispatchEvent(new CustomEvent('symbolChanged', {
      detail: change
    }));
  }
};

// Auto-init
SymbolManager.init();

// Export
window.SymbolManager = SymbolManager;
